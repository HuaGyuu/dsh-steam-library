/**
 * dsh-steam-library — Client half.
 *
 * One sidebar entry (`sidebar.panellist` icon + keyed `main` panel) and one
 * Settings page. All data comes from the Host routes `/steam-library/*`; no
 * Steam request is made from the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-steam-library',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    const PANEL_ID = 'steam-library'
    const SETTINGS_ID = 'steam-library'

    // ---- Fetchers ----------------------------------------------------------
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (body !== null && body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      return body ?? {}
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload ?? {}
    }

    // ---- Formatting --------------------------------------------------------
    function fmtHours(minutes) {
      const hours = (Number(minutes) || 0) / 60
      if (hours === 0) return '0'
      if (hours < 1) return String(Math.round(hours * 10) / 10)
      if (hours < 100) return String(Math.round(hours * 10) / 10)
      return String(Math.round(hours))
    }

    function fmtDate(ms) {
      if (ms === null || ms === undefined || ms <= 0) return '—'
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function fmtDateTime(seconds) {
      if (seconds === null || seconds === undefined) return '—'
      return fmtDate(seconds * 1000)
    }

    function pct(unlocked, total) {
      if (!total) return 0
      return Math.round((unlocked / total) * 1000) / 10
    }

    // ---- Layout defaults ---------------------------------------------------
    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      padding: '24px',
      height: '100%',
      boxSizing: 'border-box',
      overflowY: 'auto',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
    }
    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '12px',
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: '16px',
    }
    const subtitleStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' }
    const buttonStyle = (primary) => ({
      border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
      background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
      color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
      borderRadius: '8px',
      padding: '6px 12px',
      fontSize: '13px',
      cursor: 'pointer',
    })
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      outline: 'none',
    }
    const inputStyle2 = { ...inputStyle }

    function Badge({ children, tone }) {
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-secondary)'
      return h('span', {
        style: {
          fontSize: '12px',
          color,
          border: `1px solid ${color}`,
          borderRadius: '999px',
          padding: '1px 8px',
          whiteSpace: 'nowrap',
        },
      }, children)
    }

    function Progress({ unlocked, total }) {
      const value = pct(unlocked, total)
      return h('div', {
        style: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden', flex: 1 },
        role: 'progressbar',
        'aria-valuenow': value,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
      }, h('div', {
        style: {
          height: '100%',
          width: `${value}%`,
          background: 'var(--dsw-alias-brand-primary)',
          borderRadius: '999px',
          transition: 'width 160ms ease',
        },
      }))
    }

    // ---- Main panel --------------------------------------------------------
    function SteamPanel() {
      const [state, setState] = useState({ status: 'loading', library: null, error: null })
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState('playtime')
      const [onlyPlayed, setOnlyPlayed] = useState(false)
      const [selected, setSelected] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)

      const load = useCallback(async () => {
        setState((prev) => ({ ...prev, status: 'loading', error: null }))
        try {
          const payload = await getJson(`/steam-library/library?top=20&lang=schinese`)
          setState({ status: 'ready', library: payload.library, error: null })
        } catch (error) {
          setState({ status: 'error', library: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const library = state.library
      const games = useMemo(() => {
        if (library === null) return []
        const needle = query.trim().toLowerCase()
        const list = library.games.filter((game) =>
          (onlyPlayed ? game.playtimeMinutes > 0 : true)
          && (needle === '' || game.name.toLowerCase().includes(needle)),
        )
        const sorted = [...list]
        if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
        else if (sort === 'recent') sorted.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
        else sorted.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)
        return sorted
      }, [library, query, sort, onlyPlayed])

      if (state.status === 'loading' && library === null) {
        return h('div', { style: { ...pageStyle, alignItems: 'center', justifyContent: 'center' } },
          h('div', { style: subtitleStyle }, '正在从 Steam 拉取游戏库…'))
      }

      if (state.status === 'error' && library === null) {
        const message = String(state.error ?? '')
        return h('div', { style: { ...pageStyle, alignItems: 'center', justifyContent: 'center' } },
          h('div', { style: { ...cardStyle, maxWidth: '520px', textAlign: 'center' } },
            h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' } }, '无法读取 Steam 游戏库'),
            h('div', { style: subtitleStyle }, message),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '16px' } },
              h('button', { type: 'button', style: buttonStyle(false), onClick: () => setSettingsOpen(true) }, '账号设置'),
              h('button', { type: 'button', style: buttonStyle(true), onClick: () => { void load() } }, '重试'))),
          settingsOpen ? h(SettingsDialog, { onClose: () => setSettingsOpen(false), onSaved: () => { void load() } }) : null)
      }

      const summary = library.summary
      const profile = library.profile ?? {}
      const achievementDetails = (library.achievements ?? []).filter((detail) => detail.available)
      const totalHours = Math.round(summary.totalMinutes / 6) / 10

      return h('div', { style: pageStyle },
        // Header
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
          profile.avatar !== null && profile.avatar !== undefined
            ? h('img', { src: profile.avatar, alt: '', width: 52, height: 52, style: { borderRadius: '50%' } })
            : h('div', { style: { width: 52, height: 52, borderRadius: '50%', background: 'var(--dsw-alias-bg-layer-2)' } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', { style: { fontSize: '18px', fontWeight: 600 } }, profile.name || 'Steam 游戏库'),
            h('div', { style: subtitleStyle }, `SteamID64 ${library.steamid}`)),
          h('div', { style: { flex: 1 } }),
          library.cached ? h(Badge, { children: '缓存' }) : null,
          h('button', {
            type: 'button',
            style: { ...buttonStyle(false), display: 'inline-flex', alignItems: 'center', gap: '6px' },
            onClick: () => setSettingsOpen(true),
            title: 'Steam 账号设置',
            'aria-label': 'Steam 账号设置',
          }, h(GearIcon), '设置'),
          h('button', {
            type: 'button',
            style: buttonStyle(false),
            onClick: () => { void load() },
            disabled: state.status === 'loading',
          }, state.status === 'loading' ? '刷新中…' : '刷新'))

        // Summary cards
        , h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' } },
          [
            ['拥有游戏', String(summary.owned)],
            ['玩过的游戏', String(summary.played)],
            ['总时长', `${totalHours} 小时`],
            ['最近两周有记录', String(summary.recent.length)],
          ].map(([label, value]) => h('div', { key: label, style: cardStyle },
            h('div', { style: subtitleStyle }, label),
            h('div', { style: { fontSize: '20px', fontWeight: 600, marginTop: '4px' } }, value))))

        // Recently played
        , summary.recent.length > 0
          ? h('div', { style: cardStyle },
            h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '10px' } }, '最近两周在玩'),
            h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
              summary.recent.map((game) => h('button', {
                key: game.appid,
                type: 'button',
                onClick: () => setSelected(game.appid),
                style: {
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
                  borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                },
              },
              game.icon ? h('img', { src: game.icon, alt: '', width: 24, height: 24, style: { borderRadius: '4px' } }) : null,
              h('span', { style: { fontSize: '13px' } }, game.name),
              h('span', { style: subtitleStyle }, `${fmtHours(game.playtime2WeeksMinutes)} 小时`)))))
          : null

        // Achievement overview
        , achievementDetails.length > 0
          ? h('div', { style: cardStyle },
            h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '10px' } }, '成就进度（时长最高的游戏）'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              achievementDetails.map((detail) => {
                const game = library.games.find((entry) => entry.appid === detail.appid)
                return h('div', { key: detail.appid, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                  h('span', { style: { minWidth: '0', flex: '0 1 240px', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    game?.name ?? detail.gameName ?? String(detail.appid)),
                  h(Progress, { unlocked: detail.unlocked, total: detail.total }),
                  h('span', { style: { ...subtitleStyle, whiteSpace: 'nowrap' } },
                    `${detail.unlocked}/${detail.total} · ${pct(detail.unlocked, detail.total)}%`),
                  h('button', { type: 'button', style: { ...buttonStyle(false), padding: '2px 8px' }, onClick: () => setSelected(detail.appid) }, '详情'))
              })))
          : null

        // Library list
        , h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' } },
            h('div', { style: { fontSize: '14px', fontWeight: 600, marginRight: 'auto' } }, `全部游戏（${games.length}）`),
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: '搜索游戏名…',
              'aria-label': '搜索游戏名',
              style: { ...inputStyle2, width: '200px' },
            }),
            h('select', {
              value: sort,
              onChange: (event) => setSort(event.target.value),
              'aria-label': '排序',
              style: { ...inputStyle2, width: 'auto' },
            },
            h('option', { value: 'playtime' }, '按时长'),
            h('option', { value: 'name' }, '按名称'),
            h('option', { value: 'recent' }, '按最近游玩')),
             h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', ...subtitleStyle, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: onlyPlayed, onChange: (event) => setOnlyPlayed(event.target.checked) }),
              '只看玩过的')),
          games.length === 0
            ? h('div', { style: subtitleStyle }, '没有匹配的游戏。')
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              games.map((game) => h('button', {
                key: game.appid,
                type: 'button',
                onClick: () => setSelected(game.appid),
                style: {
                  display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 6px',
                  background: 'transparent', border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', textAlign: 'left', width: '100%',
                },
              },
              game.icon
                ? h('img', { src: game.icon, alt: '', width: 32, height: 32, style: { borderRadius: '6px', flex: '0 0 auto' } })
                : h('div', { style: { width: 32, height: 32, borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)', flex: '0 0 auto' } }),
              h('div', { style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' } },
                h('span', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, game.name),
                h('span', { style: { ...subtitleStyle, fontSize: '12px' } }, `最近游玩 ${fmtDate(game.lastPlayed)}`)),
              game.playtime2WeeksMinutes > 0 ? h(Badge, { children: `近两周 ${fmtHours(game.playtime2WeeksMinutes)}h` }) : null,
              game.achievements !== undefined
                ? h('span', { style: { ...subtitleStyle, fontSize: '12px', whiteSpace: 'nowrap', minWidth: '88px', textAlign: 'right' } },
                  game.achievements.available ? `${game.achievements.unlocked}/${game.achievements.total} 成就` : '无成就数据')
                : null,
              h('span', { style: { fontSize: '14px', fontWeight: 600, minWidth: '72px', textAlign: 'right' } }, `${fmtHours(game.playtimeMinutes)} h`))))
        )

        , selected === null ? null : h(AchievementDialog, {
          appid: selected,
          title: library.games.find((game) => game.appid === selected)?.name ?? '',
          onClose: () => setSelected(null),
        })

        , settingsOpen ? h(SettingsDialog, { onClose: () => setSettingsOpen(false), onSaved: () => { void load() } }) : null)
    }

    function GearIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.8 }),
      h('path', {
        d: 'M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2.1-1.2l-.3-2.5h-4l-.3 2.5a7.3 7.3 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2.1 1.2l.3 2.5h4l.3-2.5a7.3 7.3 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
      }))
    }

    function AchievementDialog({ appid, title, onClose }) {
      const [state, setState] = useState({ status: 'loading', detail: null, error: null })
      const dialogRef = useRef(null)

      useEffect(() => {
        let cancelled = false
        setState({ status: 'loading', detail: null, error: null })
        getJson(`/steam-library/achievements?appid=${encodeURIComponent(appid)}`)
          .then((payload) => {
            if (!cancelled) setState({ status: 'ready', detail: payload.detail, error: null })
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'error', detail: null, error: error instanceof Error ? error.message : String(error) })
          })
        return () => { cancelled = true }
      }, [appid])

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        dialogRef.current?.focus?.()
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const detail = state.detail
      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
        },
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', {
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': `成就：${title}`,
        tabIndex: -1,
        style: {
          width: 'min(680px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          borderRadius: '14px', border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.25)', outline: 'none',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('div', { style: { fontSize: '15px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title || detail?.gameName || `App ${appid}`),
          detail !== null
            ? h('div', { style: subtitleStyle }, `已解锁 ${detail.unlocked}/${detail.total} · ${pct(detail.unlocked, detail.total)}%`)
            : null),
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', style: buttonStyle(false), onClick: onClose, 'aria-label': '关闭' }, '关闭')),
      h('div', { style: { overflowY: 'auto', padding: '8px 16px 16px' } },
        state.status === 'loading' ? h('div', { style: subtitleStyle }, '正在读取成就…') : null,
        state.status === 'error' ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' } }, state.error) : null,
        state.status === 'ready' && detail.achievements.length === 0
          ? h('div', { style: subtitleStyle }, '这款游戏没有可读取的成就数据（Steam 未公开或游戏没有成就）。')
          : null,
        state.status === 'ready'
          ? detail.achievements.map((entry) => h('div', {
            key: entry.apiName,
            style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', opacity: entry.achieved ? 1 : 0.55 },
          },
          h('span', {
            style: {
              width: 18, height: 18, borderRadius: '50%', flex: '0 0 auto', marginTop: '2px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px',
              background: entry.achieved ? 'var(--dsw-alias-state-success-primary)' : 'transparent',
              border: entry.achieved ? 'none' : '1px solid var(--dsw-alias-border-l2)',
              color: '#fff',
            },
          }, entry.achieved ? '✓' : ''),
          h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
            h('span', { style: { fontSize: '13px', fontWeight: 500 } }, entry.name || entry.apiName),
            entry.description !== '' ? h('span', { style: { ...subtitleStyle, fontSize: '12px' } }, entry.description) : null),
          h('span', { style: { ...subtitleStyle, fontSize: '12px', whiteSpace: 'nowrap' } },
            entry.achieved ? fmtDateTime(entry.unlockTime) : '未解锁')))
          : null)))
    }

    // ---- Sidebar icon ------------------------------------------------------
    function SteamIcon({ size }) {
      const edge = typeof size === 'number' ? size : 20
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 10, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('circle', { cx: 9, cy: 15, r: 2.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M7 13.6 L11.2 8.6 M11.6 8.2 h4.6 M11.6 8.2 v3.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    // ---- Settings page -----------------------------------------------------
    // ---- Settings form (shared by the settings page and the panel dialog) --
    function SettingsForm({ onSaved }) {
      const [config, setConfig] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [steamId, setSteamId] = useState('')
      const [bypassTls, setBypassTls] = useState(false)
      const [status, setStatus] = useState({ kind: 'idle', message: '' })

      useEffect(() => {
        let cancelled = false
        getJson('/steam-library/config')
          .then((payload) => {
            if (cancelled) return
            setConfig(payload.config)
            setSteamId(payload.config?.steamId ?? '')
            setBypassTls(payload.config?.bypassTlsCheck === true)
          })
          .catch((error) => {
            if (!cancelled) setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          })
        return () => { cancelled = true }
      }, [])

      const save = async () => {
        setStatus({ kind: 'saving', message: '保存中…' })
        try {
          const patch = { steamId, bypassTlsCheck: bypassTls }
          // An empty key field means "keep the stored key".
          if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
          const payload = await postJson('/steam-library/config', { patch })
          setConfig(payload.config)
          setApiKey('')
          setStatus({
            kind: 'saved',
            message: payload.config?.configured ? '已保存。' : '已保存，但 API Key 或 SteamID64 仍为空。',
          })
          if (typeof onSaved === 'function') onSaved(payload.config)
        } catch (error) {
          setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }

      const clearKey = async () => {
        setStatus({ kind: 'saving', message: '清除中…' })
        try {
          const payload = await postJson('/steam-library/config', { patch: { apiKey: '' } })
          setConfig(payload.config)
          setStatus({ kind: 'saved', message: '已清除 API Key。' })
        } catch (error) {
          setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }

      const rowStyle = { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }
      const labelStyle = { fontSize: '13px', fontWeight: 500 }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        h('div', { style: rowStyle },
          h('label', { style: labelStyle, htmlFor: 'steam-library-apikey' }, 'Steam Web API Key'),
          h('input', {
            id: 'steam-library-apikey',
            type: 'password',
            style: inputStyle,
            value: apiKey,
            placeholder: config?.hasApiKey ? `已保存 ${config.apiKeyHint}，留空则不修改` : '在 https://steamcommunity.com/dev/apikey 申请',
            onChange: (event) => setApiKey(event.target.value),
            autoComplete: 'off',
            spellCheck: false,
          }),
          config?.hasApiKey ? h('div', { style: subtitleStyle }, `当前已保存：${config.apiKeyHint}`) : null),
        h('div', { style: rowStyle },
          h('label', { style: labelStyle, htmlFor: 'steam-library-steamid' }, 'SteamID64 或个人主页链接'),
          h('input', {
            id: 'steam-library-steamid',
            style: inputStyle,
            value: steamId,
            placeholder: '7656119xxxxxxxxxx',
            onChange: (event) => setSteamId(event.target.value),
            autoComplete: 'off',
            spellCheck: false,
          }),
          h('div', { style: subtitleStyle }, '只支持 17 位 SteamID64 或 steamcommunity.com 主页链接；隐私设置里「游戏详情」需要设为公开。')),
        h('label', {
          style: { display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', fontSize: '13px' },
        },
        h('input', {
          type: 'checkbox',
          checked: bypassTls,
          onChange: (event) => setBypassTls(event.target.checked),
          style: { marginTop: '2px' },
        }),
        h('span', null,
          h('span', { style: { fontWeight: 500 } }, '忽略 Steam 证书校验'),
          h('span', { style: { ...subtitleStyle, display: 'block' } },
            '仅当本机无法验证 Steam 证书（例如网络做了 TLS 拦截）时再打开。开启后只对本插件发往 Steam 的请求跳过校验。'))),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            style: buttonStyle(true),
            onClick: () => { void save() },
            disabled: status.kind === 'saving',
          }, status.kind === 'saving' ? '保存中…' : '保存'),
          config?.hasApiKey ? h('button', { type: 'button', style: buttonStyle(false), onClick: () => { void clearKey() } }, '清除 API Key') : null,
          status.message !== '' ? h('span', {
            style: {
              fontSize: '12px',
              color: status.kind === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : status.kind === 'saved'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-label-secondary)',
            },
          }, status.message) : null))
    }

    function SettingsSection() {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 24px' } },
        h('div', { style: subtitleStyle },
          '这里填写的值保存在本插件的配置行（profile 的 cordis.patch.yml → steam-library）里；API Key 以掩码显示，留空保存表示保持不变。'),
        h(SettingsForm, {}),
        // Environment fallback: the Host reads these when the fields are empty.
        h('div', { style: { ...cardStyle, padding: '12px' } },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '环境变量兜底（可选）'),
          h('div', { style: subtitleStyle },
            '未在设置里填写时，Host 会读取 Harness 进程的环境变量 STEAM_API_KEY 与 STEAM_USER_ID。这里填写的值优先。')))
    }

    function SettingsDialog({ onClose, onSaved }) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
        },
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Steam 设置',
        style: {
          width: 'min(520px, 92vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          borderRadius: '14px', border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.25)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, 'Steam 账号设置'),
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', style: buttonStyle(false), onClick: onClose, 'aria-label': '关闭' }, '关闭')),
      h('div', { style: { overflowY: 'auto', padding: '16px' } },
        h(SettingsForm, {
          onSaved: (nextConfig) => {
            if (typeof onSaved === 'function') onSaved(nextConfig)
            onClose()
          },
        }))))
    }


    return {
      name: 'dsh-steam-library',
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID }, SteamPanel)
          let stopIcon
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => 'Steam',
            }, SteamIcon)
          } catch (error) {
            stopIcon?.()
            stopMain()
            throw error
          }
          return () => {
            stopIcon?.()
            stopMain()
          }
        }))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SETTINGS_ID,
          order: 35,
          label: () => 'Steam 游戏库',
        }, SettingsSection))
      },
    }
  },
})
