/**
 * dsh-steam-library — Host half.
 *
 * Owns the Steam Web API access shared by the sidebar panel and the
 * `get_my_steam_games` agent tool:
 *
 *  - configuration (API key + SteamID64) lives in this bundle's own row and is
 *    edited through the `configEditor` service, never by rewriting files;
 *  - HTTP routes under `/steam-library/*` serve the panel over the Web GUI;
 *  - `ctx.tools.register` exposes the same data to the model.
 *
 * Every operation is implemented once on `SteamLibrary` and called from both
 * entry points.
 */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

export const name = 'steam-library'
export const inject = ['webServer', 'tools']

const BASE = 'https://api.steampowered.com'
const ICON_BASE = 'https://media.steampowered.com/steamcommunity/public/images/apps'
const REQUEST_TIMEOUT_MS = 20000
const ACHIEVEMENT_CONCURRENCY = 6
const ACHIEVEMENT_TOP_LIMIT = 30
const CACHE_TTL_MS = 10 * 60 * 1000

/** Thrown for conditions the user can fix (missing key, private profile). */
class SteamError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize a pasted API key / Steam ID. */
function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Turn a SteamID64, a profile link or a bare vanity name into a SteamID64.
 * Accepts `7656119…`, `steamcommunity.com/profiles/<id64>`, `/id/<vanity>`.
 */
async function resolveSteamId(input, apiKey, signal) {
  const raw = cleanValue(input)
  if (raw === '') throw new SteamError('missing-steamid', '尚未设置 Steam ID。')
  if (/^\d{17}$/.test(raw)) return raw
  const profile = /steamcommunity\.com\/profiles\/(\d{17})/.exec(raw)
  if (profile !== null) return profile[1]
  const vanityMatch = /steamcommunity\.com\/id\/([^/?#\s]+)/.exec(raw)
  const vanity = vanityMatch !== null ? vanityMatch[1] : /^[A-Za-z0-9_-]{2,64}$/.test(raw) ? raw : ''
  if (vanity === '') {
    throw new SteamError('invalid-steamid', `无法识别的 Steam ID：${raw}。请填写 SteamID64 或个人主页链接。`)
  }
  const data = await getJson(
    `${BASE}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanity)}`,
    signal,
  )
  const steamid = data.response?.steamid
  if (data.response?.success !== 1 || typeof steamid !== 'string') {
    throw new SteamError('unknown-vanity', `找不到自定义网址为 “${vanity}” 的 Steam 用户。`)
  }
  return steamid
}

/** Appended to TLS failures the Harness process cannot verify by itself. */
const TLS_HINT = '（本机进程无法验证 Steam 的证书链，多半是网络做了 TLS 拦截。可在「设置 → Steam 游戏库」打开「忽略证书校验」（仅对本插件的 Steam 请求生效），或用 NODE_OPTIONS=--use-system-ca 启动 Harness。）'

/** Hosts this plugin talks to; the TLS bypass never applies to anything else. */
const STEAM_HOSTS = new Set(['api.steampowered.com', 'media.steampowered.com', 'store.steampowered.com', 'steamcommunity.com'])

/** The verifying agent for normal traffic, and the opted-in bypass agent. */
const verifyAgent = new HttpsAgent()
const bypassAgent = new HttpsAgent({ rejectUnauthorized: false })

/** Set by SteamLibrary on each apply and by every config save. */
let tlsBypassEnabled = false
function tlsBypassAllowed() {
  return tlsBypassEnabled
}
function syncTlsBypass(enabled) {
  tlsBypassEnabled = enabled === true
}

/** One GET returning status and body text; the agent decides certificate trust. */
function rawGet(url, agent, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const request = httpsRequest(url, { method: 'GET', agent, headers: { accept: 'application/json' }, signal }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => finish(resolve, { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', (error) => finish(reject, error))
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('request timed out')))
    request.on('error', (error) => finish(reject, error))
    request.end()
  })
}

function isTlsFailure(error) {
  const code = String(error?.code ?? '')
  const message = errorMessage(error)
  return /CERT|SSL|TLS|EPROTO|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code)
    || /certificate|self.signed|unable to verify/i.test(message)
}

async function getJson(url, signal) {
  const host = new URL(url).hostname
  let result
  try {
    result = await rawGet(url, verifyAgent, signal)
  } catch (error) {
    if (isTlsFailure(error) && tlsBypassAllowed() && STEAM_HOSTS.has(host)) {
      // Opt-in, Steam-host-only retry that trusts the otherwise-unverifiable
      // chain. The verifying agent still handles every other request.
      try {
        result = await rawGet(url, bypassAgent, signal)
      } catch (retryError) {
        throw new SteamError('network', `无法连接 Steam：${errorMessage(retryError)}`)
      }
    } else {
      const tls = isTlsFailure(error)
      throw new SteamError('network', `无法连接 Steam：${errorMessage(error)}${tls ? TLS_HINT : ''}`)
    }
  }
  if (result.status < 200 || result.status >= 300) {
    throw new SteamError('http', `Steam 接口返回 HTTP ${result.status}`)
  }
  try {
    return JSON.parse(result.text)
  } catch {
    throw new SteamError('bad-json', 'Steam 接口返回了无法解析的内容。')
  }
}

/** Run `worker` over `items` with at most `limit` promises in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

function iconUrl(appid, hash) {
  return typeof hash === 'string' && hash !== '' ? `${ICON_BASE}/${appid}/${hash}.jpg` : null
}

/** Per-app achievement detail; apps Steam has no stats for report `available: false`. */
async function fetchAchievements(appid, apiKey, steamid, language, signal) {
  try {
    const data = await getJson(
      `${BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamid}&appid=${appid}&l=${encodeURIComponent(language)}`,
      signal,
    )
    const list = data.playerstats?.achievements
    if (!Array.isArray(list)) return { appid, available: false, achievements: [] }
    const achievements = list.map((entry) => ({
      apiName: String(entry.apiname ?? ''),
      name: String(entry.name ?? entry.apiname ?? ''),
      description: String(entry.description ?? ''),
      achieved: entry.achieved === 1,
      unlockTime: typeof entry.unlocktime === 'number' && entry.unlocktime > 0 ? entry.unlocktime : null,
    }))
    return {
      appid,
      gameName: typeof data.playerstats?.gameName === 'string' ? data.playerstats.gameName : undefined,
      available: true,
      total: achievements.length,
      unlocked: achievements.filter((entry) => entry.achieved).length,
      achievements: achievements.sort((a, b) => (b.unlockTime ?? 0) - (a.unlockTime ?? 0)),
    }
  } catch (error) {
    return { appid, available: false, error: errorMessage(error), achievements: [] }
  }
}

/** The single implementation of every Steam read. */
class SteamLibrary {
  #ctx
  #cache = new Map()

  constructor(ctx) {
    this.#ctx = ctx
  }

  getConfig() {
    const config = this.#ctx.fiber?.entry?.options?.config ?? {}
    // Settings win; the Harness process environment is only a fallback.
    const apiKey = cleanValue(config.apiKey) || cleanValue(process.env.STEAM_API_KEY)
    const steamId = cleanValue(config.steamId) || cleanValue(process.env.STEAM_USER_ID)
    return { apiKey, steamId, bypassTlsCheck: config.bypassTlsCheck === true }
  }

  /** Persist a partial config through the profile's config editor. */
  async saveConfig(patch) {
    const entry = this.#ctx.fiber?.entry
    const editor = this.#ctx.get('configEditor')
    if (entry === undefined || editor === undefined) {
      throw new SteamError('no-editor', '当前 profile 无法保存插件配置。')
    }
    const next = {}
    if (patch.apiKey !== undefined) next.apiKey = cleanValue(patch.apiKey)
    if (patch.steamId !== undefined) next.steamId = cleanValue(patch.steamId)
    if (patch.bypassTlsCheck !== undefined) next.bypassTlsCheck = patch.bypassTlsCheck === true
    await editor.edit(entry, (current) => ({ ...current, ...next }))
    this.clearCache()
    syncTlsBypass(this.getConfig().bypassTlsCheck)
    return this.view()
  }

  /** Settings-page view: the key is reduced to a masked hint. */
  view() {
    const config = this.#ctx.fiber?.entry?.options?.config ?? {}
    const savedApiKey = cleanValue(config.apiKey)
    const savedSteamId = cleanValue(config.steamId)
    const envApiKey = cleanValue(process.env.STEAM_API_KEY)
    const envSteamId = cleanValue(process.env.STEAM_USER_ID)
    return {
      hasApiKey: savedApiKey !== '',
      apiKeyHint: savedApiKey === '' ? '' : `${savedApiKey.slice(0, 4)}…${savedApiKey.slice(-4)}`,
      steamId: savedSteamId,
      envApiKey: envApiKey !== '',
      envSteamId: envSteamId !== '',
      bypassTlsCheck: config.bypassTlsCheck === true,
      configured: (savedApiKey !== '' || envApiKey !== '') && (savedSteamId !== '' || envSteamId !== ''),
    }
  }

  /** Called once per apply so the request path knows the current opt-in. */
  syncTls() {
    syncTlsBypass(this.getConfig().bypassTlsCheck)
  }

  async #fetchProfile(apiKey, steamid, signal) {
    const data = await getJson(
      `${BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamid}`,
      signal,
    )
    const player = data.response?.players?.[0]
    if (player === undefined) throw new SteamError('unknown-player', 'Steam 查不到这个账号。')
    return {
      steamid: String(player.steamid ?? steamid),
      name: String(player.personaname ?? ''),
      avatar: typeof player.avatarfull === 'string' ? player.avatarfull : null,
      profileUrl: typeof player.profileurl === 'string' ? player.profileurl : null,
    }
  }

  /** Owned games, profile, recent play and achievement progress. */
  async getLibrary({ top = ACHIEVEMENT_TOP_LIMIT, language = 'schinese' } = {}, signal) {
    const { apiKey, steamId } = this.getConfig()
    if (apiKey === '') throw new SteamError('missing-key', '尚未设置 Steam Web API Key。')
    const steamid = await resolveSteamId(steamId, apiKey, signal)

    const cacheKey = `${steamid}|${language}|${top}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.value, cached: true }

    const owned = await getJson(
      `${BASE}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamid}&include_appinfo=1&include_extended_appinfo=1`,
      signal,
    )
    const rawGames = owned.response?.games
    if (!Array.isArray(rawGames)) {
      throw new SteamError(
        'private-profile',
        'Steam 没有返回游戏列表：请把「游戏详情」在个人资料隐私设置里设为公开，并确认该账号拥有游戏。',
      )
    }

    const games = rawGames.map((game) => ({
      appid: Number(game.appid),
      name: String(game.name ?? `App ${game.appid}`),
      playtimeMinutes: Number(game.playtime_forever ?? 0),
      playtime2WeeksMinutes: Number(game.playtime_2weeks ?? 0),
      lastPlayed: Number(game.rtime_last_played ?? 0) > 0 ? Number(game.rtime_last_played) * 1000 : null,
      icon: iconUrl(game.appid, game.img_icon_url),
      hasStats: game.has_community_visible_stats === true,
    })).sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)

    const played = games.filter((game) => game.playtimeMinutes > 0)
    const totalMinutes = games.reduce((sum, game) => sum + game.playtimeMinutes, 0)

    const [profile, recent] = await Promise.all([
      this.#fetchProfile(apiKey, steamid, signal).catch((error) => ({ error: errorMessage(error) })),
      getJson(
        `${BASE}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamid}&count=5`,
        signal,
      )
        .then((data) => (Array.isArray(data.response?.games) ? data.response.games : []))
        .catch(() => []),
    ])

    const cap = Math.max(0, Math.min(Number(top) || 0, ACHIEVEMENT_TOP_LIMIT))
    const targets = played.filter((game) => game.hasStats).slice(0, cap)
    const details = await mapLimit(targets, ACHIEVEMENT_CONCURRENCY, (game) =>
      fetchAchievements(game.appid, apiKey, steamid, language, signal),
    )
    const byApp = new Map(details.map((detail) => [detail.appid, detail]))
    for (const game of games) {
      const detail = byApp.get(game.appid)
      if (detail === undefined) continue
      game.achievements = {
        available: detail.available === true,
        total: detail.total ?? 0,
        unlocked: detail.unlocked ?? 0,
        error: detail.error,
      }
    }

    const value = {
      steamid,
      profile,
      games,
      summary: {
        owned: games.length,
        played: played.length,
        totalMinutes,
        achievementGames: details.filter((detail) => detail.available === true).length,
        recent: recent.map((game) => ({
          appid: Number(game.appid),
          name: String(game.name ?? `App ${game.appid}`),
          playtime2WeeksMinutes: Number(game.playtime_2weeks ?? 0),
          icon: iconUrl(game.appid, game.img_icon_url),
        })),
      },
      achievements: details,
      fetchedAt: Date.now(),
      cached: false,
    }
    this.#cache.set(cacheKey, { at: Date.now(), value })
    return value
  }

  /** Model-facing result: compact, bounded, without icon URLs. */
  async toolResult(args = {}) {
    const sortBy = args.sort_by ?? 'playtime'
    const limit = Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 200))
    const library = await this.getLibrary({
      top: Number(args.achievement_games ?? 5),
      language: args.language ?? 'schinese',
    })
    const sorted = [...library.games]
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sortBy === 'recent') sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    else if (sortBy === 'achievements') sorted.sort((a, b) => (b.achievements?.unlocked ?? 0) - (a.achievements?.unlocked ?? 0))
    else sorted.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)

    const gameNames = new Map(library.games.map((game) => [game.appid, game.name]))
    return {
      steamid: library.steamid,
      player: library.profile,
      summary: {
        owned: library.summary.owned,
        played: library.summary.played,
        total_hours: Math.round(library.summary.totalMinutes / 6) / 10,
        recently_played: library.summary.recent.map((game) => ({
          name: game.name,
          two_weeks_hours: Math.round(game.playtime2WeeksMinutes / 6) / 10,
        })),
      },
      games: sorted.slice(0, limit).map((game) => ({
        name: game.name,
        appid: game.appid,
        playtime_hours: Math.round(game.playtimeMinutes / 6) / 10,
        recent_playtime_hours: Math.round(game.playtime2WeeksMinutes / 6) / 10,
        last_played: game.lastPlayed === null ? null : new Date(game.lastPlayed).toISOString(),
        achievements: game.achievements === undefined
          ? null
          : { unlocked: game.achievements.unlocked, total: game.achievements.total, available: game.achievements.available },
      })),
      achievement_details: library.achievements.filter((detail) => detail.available).map((detail) => ({
        game: gameNames.get(detail.appid) ?? detail.gameName ?? '',
        total: detail.total,
        unlocked: detail.unlocked,
        recent_unlocks: detail.achievements
          .filter((entry) => entry.achieved && entry.unlockTime !== null)
          .slice(0, 5)
          .map((entry) => ({ name: entry.name, at: new Date(entry.unlockTime * 1000).toISOString() })),
      })),
      limits: {
        returned: Math.min(limit, sorted.length),
        total_games: sorted.length,
        note: 'Use limit and sort_by to change the list. Achievement details only cover the most played games that expose stats.',
      },
    }
  }

  /** One game's full achievement list for the panel's detail dialog. */
  async getAchievements(appid) {
    const { apiKey, steamId } = this.getConfig()
    if (apiKey === '') throw new SteamError('missing-key', '尚未设置 Steam Web API Key。')
    const steamid = await resolveSteamId(steamId, apiKey)
    const detail = await fetchAchievements(Number(appid), apiKey, steamid, 'schinese')
    if (detail.error !== undefined) throw new SteamError('achievements', detail.error)
    return detail
  }

  clearCache() {
    this.#cache.clear()
  }
}

function sendJson(response, status, body) {
  response.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end?.(JSON.stringify(body))
}

/** Treat every method other than POST as a read. */
function isPost(request) {
  return String(request.method ?? '').toUpperCase() === 'POST'
}

/** Read a bounded request body; `stream` covers both request shapes. */
async function readText(stream, limit = 1_000_000) {
  const source = stream?.[Symbol.asyncIterator] !== undefined ? stream : stream?.req
  const chunks = []
  let size = 0
  if (source !== undefined && source !== null) {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) break
      chunks.push(buffer)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function failureStatus(error) {
  if (error instanceof SteamError) {
    if (error.code === 'missing-steamid' || error.code === 'invalid-steamid' || error.code === 'private-profile') return 400
    if (error.code === 'missing-key' || error.code === 'no-editor') return 409
  }
  return 502
}

export function apply(ctx) {
  const library = new SteamLibrary(ctx)
  library.syncTls()
  ctx.effect(() => () => library.clearCache(), 'steam-library: cache')

  // ---- HTTP routes used by the sidebar panel ------------------------------
  const route = (path, handler) => ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path, handler }),
    `steam-library: route ${path}`,
  )

  route('/steam-library/config', async (request, response) => {
    try {
      if (isPost(request)) {
        const text = await readText(request)
        let body = {}
        try {
          const parsed = JSON.parse(text === '' ? '{}' : text)
          if (typeof parsed === 'object' && parsed !== null) body = parsed
        } catch {
          // A malformed body becomes an empty patch, which changes nothing.
        }
        const patch = typeof body.patch === 'object' && body.patch !== null ? body.patch : body
        sendJson(response, 200, { ok: true, config: await library.saveConfig(patch) })
        return
      }
      sendJson(response, 200, { ok: true, config: library.view() })
    } catch (error) {
      sendJson(response, failureStatus(error), { ok: false, error: errorMessage(error), code: error.code })
    }
  })

  route('/steam-library/library', async (request, response) => {
    try {
      const url = new URL(String(request.url ?? '/'), 'http://localhost')
      const requested = Number(url.searchParams.get('top') ?? ACHIEVEMENT_TOP_LIMIT)
      const libraryData = await library.getLibrary({
        top: Number.isFinite(requested) ? requested : ACHIEVEMENT_TOP_LIMIT,
        language: url.searchParams.get('lang') ?? 'schinese',
      })
      sendJson(response, 200, { ok: true, library: libraryData })
    } catch (error) {
      sendJson(response, failureStatus(error), { ok: false, error: errorMessage(error), code: error.code })
    }
  })

  route('/steam-library/achievements', async (request, response) => {
    try {
      const url = new URL(String(request.url ?? '/'), 'http://localhost')
      const appid = url.searchParams.get('appid')
      if (appid === null || !/^\d+$/.test(appid)) {
        sendJson(response, 400, { ok: false, error: '缺少有效的 appid 参数。' })
        return
      }
      sendJson(response, 200, { ok: true, detail: await library.getAchievements(appid) })
    } catch (error) {
      sendJson(response, failureStatus(error), { ok: false, error: errorMessage(error), code: error.code })
    }
  })

  // ---- Model tool ---------------------------------------------------------
  ctx.effect(() => ctx.tools.register({
    name: 'get_my_steam_games',
    description:
      'Read the Steam library configured for this user: owned games with playtime, the player profile, recently played games, and achievement progress for the most-played games. Use it when the user asks what games they own, how long they played a game, or which achievements they unlocked. The Steam Web API key and SteamID64 are configured in the Steam library plugin settings.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sort_by: {
          type: 'string',
          enum: ['playtime', 'name', 'recent', 'achievements'],
          description: 'Order of the returned games; playtime (default) lists the most played first.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of games to return (default 50).',
        },
        achievement_games: {
          type: 'integer',
          minimum: 0,
          maximum: ACHIEVEMENT_TOP_LIMIT,
          description: 'How many of the most played games get achievement details (default 5).',
        },
        language: {
          type: 'string',
          description: 'Steam language for achievement names, such as schinese or english (default schinese).',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args) {
      return await library.toolResult(args ?? {})
    },
  }), 'steam-library: tool')
}
