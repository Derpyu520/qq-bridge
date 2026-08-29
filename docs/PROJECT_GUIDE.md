# DSH QQ 桥接（qq-bridge）项目说明书

> 让 DeepSeek Harness（DSH）的 agent 以“仿真群友”身份接入 QQ 群/私聊。
> 本文是面向公开仓库的精简版说明；本地开发历史、个人配置与运行状态不会包含在仓库中。

---

## 1. 项目是什么

`qq-bridge` 是一个独立的 Node.js 进程，做三件事：

1. **连接 QQ**：通过 SnowLuma（OneBot v11 WebSocket）收发 QQ 群/私聊消息。
2. **连接 DSH**：通过 DSH Web API（默认 `127.0.0.1:3080`）创建会话、投递 prompt、接收事件流。
3. **扮演群友**：在仿真模式下，用“观望/活跃/试探/退场”状态机决定何时说话、何时沉默、怎么分多条消息发，并注入人格角色（如小鲸鱼）。

它不是简单的“QQ 消息转发器”，而是一个带**社交策略层**的桥。

---

## 2. 架构总览

```
┌─────────────┐   OneBot WS   ┌──────────────────────┐   HTTP/WS   ┌──────────────────┐
│  SnowLuma   │◄─────────────►│      qq-bridge       │◄───────────►│   DSH Harness    │
│  (QQ 网关)  │               │   src/bridge.js      │             │  (agent 会话)    │
└─────────────┘               │   src/dsh-client.js  │             └──────────────────┘
                              │   src/mcp-*.js       │
                              └──────────────────────┘
                                      │ 控制台
                                      ▼
                              public/console.html (127.0.0.1:3100)
```

| 层 | 文件 | 职责 |
|---|---|---|
| 内核 | `src/bridge.js` | 主程序：QQ 消息接入、社交状态机、DSH 投递、发送链、控制台 API、安全审计 |
| 内核 | `src/dsh-client.js` | DSH 协议客户端：RPC + WebSocket 事件流 + turn 收集 |
| 内核 | `src/mcp-snowluma-safe.js` | 给 DSH agent 用的安全 QQ 工具（只读 + 白名单发送） |
| 内核 | `src/mcp-host-server.js` | 给 DSH agent 用的 SnowLuma 进程管理（默认禁用启停） |
| 内核 | `src/slang-learner.js` | 群聊黑话/网络用语学习：存储、候选提取、研究调度、注入 |
| 内核 | `src/mcp-web-search-safe.js` | 给 DSH agent 用的只读 Web Search MCP（查网络用语/梗） |
| 外核 | `public/console.html` | 本地控制台：状态、参数、手动切换、重置 |
| 外核 | `config.json` | 运行配置（白名单、QQ/DSH 地址、社交参数）；**不入库** |
| 外核 | `roles/*.md` | 人格卡（如 `小鲸鱼.md`） |
| 外核 | `state/*` | 运行时状态（会话映射、模式、日志）；**不入库** |
| 外核 | `start.bat` / `restart.bat` | 守护启动 / 一键重启 |
| 外核 | `scripts/*` | 测试/辅助脚本 |

---

## 3. 目录结构（公开仓库）

```
qq-bridge/
├── src/
│   ├── bridge.js               # 主程序（核心）
│   ├── dsh-client.js           # DSH API 客户端
│   ├── mcp-snowluma-safe.js    # 安全 MCP（QQ 读/发工具）
│   ├── mcp-host-server.js      # MCP（SnowLuma 进程管理，默认禁用启停）
│   ├── mcp-web-search-safe.js  # 安全 MCP（只读 Web Search/Fetch）
│   ├── slang-learner.js        # 黑话/网络用语学习模块
│   ├── md-to-plain.js          # Markdown 转纯文本
│   ├── safe-fetch.js           # SSRF 防护的 HTTP(S) 抓取
│   └── self-test.js            # DSH 侧自检
├── public/
│   └── console.html            # 控制台单页（含黑话/记忆/表情管理）
├── roles/
│   ├── 小鲸鱼.md               # 当前人格卡
│   ├── 傲娇助手.md
│   └── README.md
├── docs/
│   ├── PROJECT_GUIDE.md        # 本文档（公开版）
│   └── DSH_SETUP.md            # DSH 端安装说明（另一台设备）
├── dsh/
│   └── agent-presets/          # qq-chat / qq-chat-v2 的 DSH preset 模板
├── plugins/
│   └── qq-mode-console/        # DSH 设置页 qq-mode 卡片插件
├── assets/
│   ├── deepseek娘.png          # AI 自我形象图（qq_get_self_image）
│   └── project-intro.mp4       # 项目介绍视频（README 可查看）
├── scripts/                    # 通用测试/辅助脚本（含 setup-dsh.mjs）
├── config.example.json         # 配置模板（占位符，不含真实凭据）
├── package.json
├── README.md
└── README.en.md
```

> `config.json`、`state/`、`node_modules/`、本地开发/计划/调研文档以及一次性本地脚本均不在公开仓库中。

---

## 4. 核心数据流

### 4.1 一条 QQ 消息的完整旅程

```
QQ 消息
  │
  ▼
bot.onGroupMessage / onPrivateMessage (bridge.js)
  │
  ▼
handleIncoming(kind, id, event)
  ├─ 白名单/模式检查（modeAllowed / allowed）
  ├─ 管理命令拦截（/reset /role /silent 等，仅 owner）
  ├─ 挂起审批/提问优先处理（pending）
  ├─ 社交模式分支（仿真模式）：
  │     ├─ 观望期：按触发条件决定是否进活跃
  │     ├─ 活跃期：私聊即时投递；群聊等轮询批量检测
  │     └─ 冷场/试探
  └─ 非社交模式：直接投递给 DSH
  │
  ▼
ensureSession(key)  →  DSH session（工作区“QQ 聊天”）
  │
  ▼
api.sessions.prompt({ mode: 'queue' })
  │
  ▼
DSH 事件流（api.events.mux → /api/remote.mux + session/follow + $events）→ pumpMux()
  ├─ turn collector 收集模型输出
  ├─ 安全审计（SENSITIVE_RE）
  ├─ 社交模式：planSocialTimeline 分条 → sendBurstToQQ
  └─ 非社交模式：sendToQQ 直接发
```

- 群聊里的 `@` 段会解析成群名片/昵称（带缓存），解析失败时回退为 QQ 号。
- 引用/回复段会解析成被引用人的群名片/昵称 + 原文，注入 prompt。
- 一代仿真模式（`reserved`）下，模型可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送。
- 一代仿真模式（`reserved`）的分条方式为“按空格分句”：AI 用空格表示下一条消息，桥接按空格拆条；`reserved2` 不适用，分条请用 `qq_send_message` 数组。

### 4.2 DSH 事件流 / turn 收集

- `dsh-client.js` 通过 `/api/remote.mux` WebSocket 保持长连接；对每个需要接收的会话显式 `session/follow`，并自动打开 `$events` 流接收提问/审批等 Remote Event。
- `createTurnCollector` 按 `assistant/message` 累加文本，`turn/end` 时产出完整结果。
- 摘要投喂会产生“静默 turn”：结果不发给 QQ，只作为记忆。

### 4.3 黑话学习 / 网络用语迭代

```
群聊消息 → bridge 滚动窗口（slangWindows）
  → 攒够 extractMinMessages 条 → DSH 学习会话提取候选
  → 写入 state/slang.json（candidate，count+1，保留证据）
  → 达到 inferenceThresholds 时 → DSH 学习会话联网搜索确认
  → 生成 meaning/usage/example → 仍为 candidate
  → 控制台「黑话管理」人工确认/拒绝
  → confirmed 词条 → 注入 QQ agent 的【群聊黑话表】
```

- 学习会话与 QQ 会话隔离：学习输出不会发 QQ。
- 只有人工确认的词条才会进入聊天上下文。

---

## 5. 内核详解

### 5.1 bridge.js（主程序）

| 模块 | 说明 |
|---|---|
| `loadConfig` | 读取 `config.json`，fail-fast；提供社交参数默认值 |
| `allowed` / `modeAllowed` | 白名单 + 模式准入（closed-agent 仅 owner 私聊） |
| `acquireLock` / `releaseLock` | 单实例锁（原子 `fs.openSync('wx')` + stale 检测） |
| `ensureSession` | 创建/复用 DSH 会话，带 `sessionEpoch` 防止 reset 竞态 |
| `social` | 社交引擎状态（states / recentMessages / pendingSummaries / silentContext / silentTurns / pendingTimers） |
| `socialLoopTick` | 每 5 秒扫描状态机：主动开话题、活跃检测、冷场、试探 |
| `buildBatchPrompt` | 活跃期投递文本（只贴新消息 + 之前沉默的消息） |
| `planSocialTimeline` | 按空格分句拆条（AI 用空格控制；单条 500 字安全上限） |
| `sendBurstToQQ` | 分条发送：随机间隔/长间隔，最后一条不 sleep |
| `pumpMux` | DSH 事件流消费：收集、审计、发送 |
| `startConsoleServer` | 本地控制台 HTTP 服务 + API |
| `flushSummaries` | 观望期未参与消息 → 摘要投喂（静默 turn） |

### 5.2 社交状态机

```
        观望 idle
        │   ▲
  触发进活跃 │   │ 冷场/试探无回应 / 退场完成
        ▼   │
       active ──冷场──► probing
        │                │
        └──新消息────────┘
        │
        └──活跃超时──► exiting ──退场发言完成──► idle
```

- **观望**：只记录消息到 `recentMessages` 和 `pendingSummaries`；触发条件包括被 @/关键词/提问、普通消息小概率、群长期静默后小概率主动开话题。
- **活跃**：每 `activeCheckMinMs~MaxMs` 检测一次新消息；私聊即时投递，群聊按批量检测。
- **退场（exiting）**：活跃超时后的过渡状态，等待 AI 的收尾发言发出。
- **冷场**：`idleWindowMs` 内无新消息 → 大概率回观望，小概率进试探。
- **试探**：AI 主动说一句，`idleRetryWaitMs` 内无人回应则回观望。

### 5.3 分条发送 / 错落感

`planSocialTimeline(text, cfg)` 返回 `{ main: string[], followUp: null }`：

1. 分句权交给 AI：AI 用空格表示“这里要分成下一条消息”。
2. 不想分条就不用空格。
3. 空格两侧只要有一侧是中文，就会被当作分条信号。
4. 单条消息只做 `maxReplyChars`（默认 500 字）安全硬拆。
5. `sendBurstToQQ` 按随机间隔发送，有概率用长间隔；最后一条后不 sleep。

### 5.4 MCP 工具

`mcp-snowluma-safe.js` 给 DSH agent 暴露：

| 工具 | 说明 | 白名单 |
|---|---|---|
| `qq_status` | 登录状态 | 无 |
| `qq_list_groups` | 群列表 | 只返回白名单群 |
| `qq_get_group_members` | 群成员 | 群号必须白名单 |
| `qq_get_group_history` | 群历史 | 群号必须白名单 |
| `qq_send_group_message` | 发群消息；可选 `replyToMessageId` | allow+deny+allowAllWhenEmpty，纯文本段防 CQ 码 |
| `qq_reply` | 专用“引用/回复”工具 | 同上 |
| `qq_send_private_message` | 发私聊；可选 `replyToMessageId` | 同上 |

二代仿真模式（`reserved2`）还有：

- 状态/消息：`qq_get_prompt`、`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_message_detail`、`qq_get_active_members`、`qq_social_state`
- 发送/互动：`qq_send_message`、`qq_send_burst`、`qq_send_poke`、`qq_send_sticker`
- 等待/收尾：`qq_wait_for_messages`、`qq_mark_read`、`qq_set_wake_config`
- 记忆/黑话/表情：`qq_memory_*`、`qq_slang_query`、`qq_slang_submit`、`qq_list_stickers`、`qq_get_sticker_image`、`qq_sticker_note`、`qq_collect_sticker`
- 形象：`qq_get_self_image`

`mcp-host-server.js`：

- `snowluma_status`：只读探活。
- `start_snowluma` / `stop_snowluma`：默认禁用，需 `config.json` 设置 `snowluma.allowProcessControl: true`，且仅在 `closed-agent` 模式下可用。

`mcp-web-search-safe.js`：

- `web_search(query)`：只读搜索。
- `web_fetch(url)`：只读抓取 HTTP(S) 网页正文，带内网/本机地址 SSRF 拦截。

---

## 6. 配置全解

> 仓库不包含真实 `config.json`，请参考 `config.example.json` 创建自己的配置。以下字段均以占位符/默认值说明。

| 字段 | 说明 |
|---|---|
| `dsh.baseUrl` | DSH Web API，默认 `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token；新版 DSH 用它换取 Cookie。留空时自动从 DSH guard 日志发现，401 后自动重新发现 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段；当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` / `httpUrl` | OneBot WebSocket / HTTP API 地址；`httpUrl` 不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot 鉴权 token，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（进程管理用，默认禁用） |
| `ownerQQ` | 管理员 QQ（最高权限，可在控制台「白名单 / 管理员」设置） |
| `agentPreset` | 聊天模式用的 DSH agent preset |
| `workspaceTitle` | DSH 工作区名 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组） |
| `deny.private` / `deny.groups` | 黑名单 |
| `allowAllWhenEmpty` | 白名单为空时是否放行（fail-closed，默认 false） |
| `sendDelayMs` | 非社交模式每条消息间隔 |
| `consolePort` | 控制台端口，默认 3100 |
| `consoleToken` | 控制台鉴权 token；空=启动时自动生成并保存到 `state/console-token` |
| `security.interceptNotify` | 回复被安全拦截时是否在群里发提示 |

社交参数（控制台可调）包括：触发概率、活跃检测间隔、回复延迟、活跃时长、冷场窗口、试探概率、沉默概率、上下文窗口、单条长度上限、分条间隔、主动开话题参数等。

黑话学习参数包括：`slang.enabled`、`extractMinMessages`、`extractCooldownMs`、`inferenceThresholds`、`injectMax`、`learnerPreset`、`workspaceTitle`、`autoResearch`。

二代仿真参数包括：`socialV2.enabled`、`tools.*` 开关、`wake.*`、`send.*`、`wait.*`、`sticker.*`、`proactive.*`、`feedback.*`、`context.*`。

---

## 7. 安全机制

1. **白名单**：`allowed()` 统一 allow/deny/allowAllWhenEmpty；MCP 工具同语义。
2. **纯文本发送**：MCP send 用纯文本消息段，禁止 CQ 码注入。
3. **敏感审计**：`SENSITIVE_RE` 拦截路径/凭据；agent 回复、错误文本、审批/提问理由、MCP send 都会过。
4. **管理命令**：`/` 命令仅 owner（ownerQQ 可在控制台设置）。
5. **审批**：非 owner 不能通过审批；超时/覆盖会给 DSH 回执。
6. **进程控制**：`start/stop_snowluma` 默认禁用；即使开启，也仅允许在 `closed-agent` 模式下调用。
7. **配置 fail-closed**：config.json 损坏直接退出；白名单默认不放行。
8. **控制台鉴权**：可配 `consoleToken`；未配置时自动生成强 token。
9. **只读联网搜索**：`mcp-web-search-safe.js` 只暴露 `web_search` / `web_fetch`，带 SSRF 防护。
10. **黑话人工确认**：自动提取/联网研究的黑话默认 candidate，只有控制台确认后才注入聊天上下文。
11. **日志脱敏**：日志统一经过 `redactSensitiveText`，不记录路径/凭据等敏感原文。
12. **二代会话隔离**：每个二代会话生成独立 agent token，MCP 状态/发送工具必须携带 token。

---

## 8. 启动 / 运行

- `start.bat`：守护启动（自动拉起、崩溃重启）。
- `restart.bat`：停止旧 bridge 进程并重新拉起。
- 控制台：`http://127.0.0.1:3100`（模式、人格、社交参数、白名单/管理员、黑话管理、控制台访问令牌、会话/挂起/日志）。
- 模式：`state/mode.json` 或 DSH settings 的 `qq-mode`；运行 `scripts/setup-dsh.mjs` 的全新环境默认 `reserved2`。

### 常用调试/测试脚本

| 脚本 | 用途 |
|---|---|
| `scripts/test-console.mjs` | 控制台 API 自检 |
| `scripts/test-mcp-safe.mjs` | MCP 安全工具自检 |
| `scripts/test-mcp-host.mjs` | MCP 进程管理自检 |
| `scripts/test-mcp-web-search.mjs` | Web Search / Fetch MCP 自检（含内网拦截） |
| `scripts/test-onebot-connection.mjs` | OneBot 连接自检 |
| `scripts/send-test-group.mjs` | 向指定名称的群发测试消息 |
| `scripts/check-onebot-status.mjs` | 网关状态 |
| `npm run self-test` | DSH 侧链路自检（不依赖 QQ） |

---

## 9. 开发 / 改进指南

### 常用验证

```bash
node --check src/bridge.js
node --check src/dsh-client.js
node --check src/mcp-snowluma-safe.js
node --check src/mcp-web-search-safe.js
node --check src/slang-learner.js
```

控制台 HTML 内联脚本语法校验：

```bash
node -e "const fs=require('fs');const vm=require('vm');const h=fs.readFileSync('public/console.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new vm.Script(m[1]);console.log('OK')"
```

### 重启

```bash
restart.bat
```

---

## 10. 常见问题

### Q：活跃期回复不及时？

- 群聊走轮询：`activeCheck` 10~30 秒 + `activeReplyDelay` 2~8 秒。
- 调小这两个参数；私聊已改为即时投递。

### Q：为什么有的消息没回？

- 普通闲聊可能被 `skipProbability` 沉默（但会进 `silentContext`，下次投递模型能看到）。
- 直接提问/@/私聊不会沉默。

### Q：为什么拆条有时不拆？

- 现在分句权在 AI：AI 没用空格分隔就不会拆条。
- 单条超过 `maxReplyChars`（默认 500）会安全硬拆。

### Q：MCP 工具改了不生效？

- MCP 由 DSH 拉起，修改 `src/mcp-*.js` 后需要**重启 DSH 进程本身**（不是只重启 qq-bridge），或让 DSH 重连 MCP。
- 修改 DSH preset 或 `cordis.patch.yml` 后，同样需要重启 DSH。

### Q：黑话提取/联网研究没生效？

- 确认 `slang.enabled` 为 true、DSH 在线、某会话消息已攒够 `extractMinMessages` 条。
- 联网研究需要 DSH 学习会话能使用 `web_search` 工具。
- 黑话候选不会自动转正，需到控制台「黑话管理」人工确认。

---

*公开版文档，不包含本地开发历史与个人配置。*
