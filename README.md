# dsh-steam-library

一个 [DeepSeek Harness](https://github.com/HuaGyuu)（DSH）插件：在左侧栏加入 **Steam 游戏库** 面板，读取 Steam Web API，展示拥有的游戏、游玩时长、最近游玩与成就进度；同时为模型提供 `get_my_steam_games` 工具。

> Steam Web API Key 与 SteamID64 都在插件自己的设置里填写，不存在于代码或仓库中。

## 功能

- **左侧栏入口**：点击「Steam」图标打开主面板。
- **主面板**
  - 玩家头像、昵称、SteamID64
  - 拥有游戏数 / 玩过的游戏数 / 总时长 / 最近两周有记录的游戏数
  - 最近两周在玩
  - 成就进度条（游玩时长最高的若干款游戏）
  - 全部游戏列表：搜索、按时长 / 名称 / 最近游玩排序、只看玩过的
  - 点任意游戏查看完整成就列表（已解锁 / 未解锁、解锁时间）
- **面板右上角「设置」**：弹窗填写 API Key 与 SteamID64（或个人主页链接），保存后立即刷新数据；「设置 → Steam 游戏库」页面同样可用。
- **模型工具 `get_my_steam_games`**：参数 `sort_by` / `limit` / `achievement_games` / `language`，返回游戏时长、最近游玩、成就进度与近期解锁。

## 安装

插件是一个 DSH bundle（`package.json` 中声明 `dsh.bundle.patch`）。在 DSH 里安装：

```text
plugin_manager install_bundle  target=D:\data\dsh-plugs\dsh-steam-library
```

安装后刷新页面，左侧栏出现 Steam 图标。

## 配置

两种方式，任选其一：

1. **界面**（推荐）：打开 Steam 面板 → 右上角「设置」；或「设置 → Steam 游戏库」。
   - `Steam Web API Key`：在 <https://steamcommunity.com/dev/apikey> 申请。
   - `SteamID64`：17 位数字，或 `steamcommunity.com/profiles/<id64>`、`steamcommunity.com/id/<vanity>` 链接。
2. **环境变量兜底**：`STEAM_API_KEY`、`STEAM_USER_ID`（界面里填写的值优先）。

> Steam 隐私设置中「游戏详情」需要设为 **公开**，否则接口不会返回游戏列表。

界面里保存的配置写入该插件在 profile 的配置行（`cordis.patch.yml` → `steam-library`），API Key 在界面上只显示掩码。

## 关于证书

部分网络会对 Steam 做 TLS 拦截，导致 Node 报 `unable to verify the first certificate`。插件设置里有一个 **「忽略 Steam 证书校验」** 开关：

- 仅对本插件发往 Steam 域名的请求跳过校验，其它请求仍正常验证；
- 默认关闭，只有在你确认本机无法验证 Steam 证书时才需要打开；
- 替代方案：用 `NODE_OPTIONS=--use-system-ca` 启动 Harness。

## 结构

```text
dsh-steam-library/
├── package.json        # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # 插入 steam-library 行（apiKey/steamId/bypassTlsCheck）
├── index.js            # Host：Steam 读取、/steam-library/* 路由、get_my_steam_games 工具
├── client.js           # Client：侧栏图标、主面板、设置弹窗与设置页
├── locale/{zh,en}.json # 插件标题与描述
└── icon.svg            # 插件图标
```

Host 侧 `SteamLibrary` 是唯一的数据实现，路由与工具都调用它；HTTP 路由：

| 路由 | 作用 |
| --- | --- |
| `GET /steam-library/config` | 读取配置（Key 掩码） |
| `POST /steam-library/config` | 保存配置（`{ patch: { apiKey, steamId, bypassTlsCheck } }`） |
| `GET /steam-library/library?top=&lang=` | 游戏库、最近游玩、成就进度 |
| `GET /steam-library/achievements?appid=` | 单款游戏的完整成就 |

数据在 Host 侧缓存 10 分钟。

## 许可

未声明许可证。