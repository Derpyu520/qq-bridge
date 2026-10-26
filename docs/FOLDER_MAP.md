# 仓库目录地图（FOLDER_MAP）

> 一眼看清每个目录/文件的职责、`scripts/` 的命名约定、哪些是运行时产物不能提交。
> 文档索引见 [README.md](README.md)。

---

## 一、顶层布局

```
qq-bridge/
├─ README.md / README.en.md      # 项目说明（中文为准）
├─ RULES.md                      # QQ 会话的权限边界与安全承诺
├─ LICENSE                       # MIT（SnowLuma 原生组件另有其许可，见 LICENSE 正文）
├─ config.example.json           # 配置模板（全部占位符；真实 config.json 不入库）
├─ package.json / package-lock.json
├─ start.bat                     # Windows 启动：node src/bridge.js
├─ start-auto.bat                # 先同步 DSH 端口，再 start.bat
├─ restart.bat / restart-dsh.bat # 只重启桥接 / 连 DSH 一起重启（MCP 工具变更后需要）
├─ _snowluma-catalog.json        # SnowLuma 能力目录（文档用途）
│
├─ src/                          # 桥接内核
├─ dsh/agent-presets/            # DSH agent preset 模板（qq-chat / qq-chat-v2 / qq-chat-v3）
├─ plugins/                      # 两个 DSH 插件（模式设置、preset 打包）
├─ public/console.html           # 本地控制台（单文件，无构建步骤）
├─ roles/                        # 人格卡（Markdown，文件名 = 角色名）
├─ skills/qq-persona-card/       # 写人格卡的 DSH skill
├─ docs/                         # 全部文档（索引见 docs/README.md）
├─ scripts/                      # 测试、探针、运维脚本
├─ assets/                       # 头像候选（会被 qq_list_assets / 控制台读取）
├─ media/                        # 发给 QQ 的图片（不入库）
├─ audio/                        # 语音库（不入库）
└─ state/                        # 运行时状态（不入库，含会话、令牌、记忆）
```

## 二、`src/` 里每个文件的职责

| 文件 | 职责 |
| --- | --- |
| `bridge.js` | 主程序：HTTP/控制台、白名单与模式、两代仿真引擎、唤醒调度、发送队列、限额、审计 |
| `core/session-router.mjs` | 按会话解析 mode / preset / model 的路由模块；当前未被 `bridge.js` 引用（会话树只实现了 owner 私聊的只读 `/branches`、`/summary`） |
| `dsh-client.js` | DSH Web API 客户端：Cookie 鉴权、斜杠 RPC、`remote.mux` 事件流 |
| `dsh-endpoint.js` | DSH 端口发现与自愈（桌面版重启后端口会变） |
| `mcp-snowluma-safe.js` | QQ 动作 MCP server：工具 schema、白名单、权限闸门、管理员动作队列 |
| `mcp-host-server.js` | 只读探活 MCP server（`snowluma_status`），不启停 SnowLuma |
| `mcp-web-search-safe.js` | 联网搜索 MCP server（DSH 同源搜索，Bing 兜底） |
| `role-card.js` | 人格卡解析：行为合同、按模式筛小节、注入预算与指纹 |
| `sticker-lib.js` | 收藏表情：清单、人格匹配、发送频率档位 |
| `qq-social-profile.mjs` | QQ 资料/头像/空间：白名单字段、SSRF-safe 抓取、HTML → 文本 |
| `admin-ops.mjs` | 管理员动作队列：确认卡、撤销、审计 |
| `bot-perms.mjs` | 「不开放 / 仅应要求 / 人设自主」三档权限的归一化 |
| `quota.js` | 滑动窗口限额（每分钟 / 每小时 / 每 2 小时 / 每日），0 = 不限 |
| `media-normalize.js` | 图片归一化（尺寸、格式、体积） |
| `md-to-plain.js` | Markdown → QQ 纯文本 |
| `preset-prompt.js` | 读取/改写 agent preset 的 `persona.prefix` |
| `v2-wait.js` / `v2-wait` 相关 | `qq_wait_for_messages` 的等待与静默计算 |
| `voice-core.js` / `send-voice-lib.js` | 语音发送：格式校验、音量、ffmpeg |
| `snowluma-conn.js` / `snowluma-egress.js` | SnowLuma 连接与出站地址校验 |
| `token-ledger.js` / `model-prices.js` | token 账本与价格表 |
| `safe-fetch.js` / `sensitive.js` | 出站抓取护栏 / 敏感信息拦截 |
| `self-test.js` | 不需要 QQ 的 DSH 侧自测 |

> 各模块的 `*.test.mjs` 与源码同目录，属于离线单测。

## 三、`scripts/` 命名约定

| 前缀 | 含义 | 会不会联网/需要真号 |
| --- | --- | --- |
| `test-*.mjs` | 离线回归/单测，CI 与本地都应能直接跑 | 不联网（个别用假 HTTP 服务器） |
| `verify-*.mjs` | 「适配某版 DSH」的逐项验收 | 需要本机 DSH |
| `probe-*.mjs` | 手工探针：打印真实响应，用来排障 | 需要 SnowLuma / DSH |
| `check-*.mjs` | 只读检查（人格串台、OneBot 状态） | 视情况 |
| `setup-dsh.mjs` | 把 preset / MCP 配置写进 DSH | 改本机 DSH 配置 |
| `patch-snowluma-sdk.mjs` | `postinstall` 修补 SDK 的 ESM 打包问题 | 只改 `node_modules` |
| `build-agent-preset-patches.mjs` | 从 `dsh/agent-presets/` 生成插件用的 patch | 不联网 |
| `privacy-scan.mjs` | 开源前隐私扫描（离线、只读） | 不联网 |
| `diagnose-acl.mjs` / `harden-state-acl.mjs` | `state/` 目录 ACL 诊断与收紧 | 本机文件系统 |
| `sync-dsh-port.mjs` | 启动前把 `dsh.baseUrl` 同步成当前端口 | 本机 |
| `console-ui-fixture.mjs` | 生成控制台 UI 夹具 | 不联网 |

新增脚本时按上面前缀命名；需要真号/真群的脚本请在文件头写清「手工运行，不要进 CI」。

## 四、不能提交的东西

`state/`、`config.json`、`audio/`、`media/` 下的实际文件、`node_modules/`、`*.log`、
`scripts/privacy-rules.json`（含你本机真实号码的扫描规则）都在 `.gitignore` 里。
提交前跑一遍 `npm run privacy-scan`。
