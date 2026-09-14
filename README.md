# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 📘 详细内外核说明书见 **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**（架构、数据流、配置全解、调试与改进指南）。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](assets/project-intro.mp4)

> 视频文件位于 `assets/project-intro.mp4`，可直接下载观看。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：复用官方 `@deepseek-ai/dsh-host-apiproxy` 的 `AbstractApiClient` 与 zod schema，桥接进程实现 Node 传输层（fetch unary + WebSocket 下行事件流）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：`snowluma_status`（默认只读探活）；`start_snowluma` / `stop_snowluma` 需显式开启 `snowluma.allowProcessControl: true` 且仅在 `closed-agent` 模式可用
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset（`~/.dsh/.agent-presets/qq-chat/agent.cordis.yml`），`reserved2` 使用 `qq-chat-v2`（`~/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml`）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ router-standard 完整工具，可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - **QQ 指令**：群友/管理员可在 QQ 里直接发 `/指令` `/状态` `/机器人` `/调机器人` 等，桥接本地响应，不进模型、不花 token（详见下文「QQ 指令」）
  - **机器人互认**：能识别群里其他 QQ 机器人（SnowLuma `is_robot`），在消息里标记、在提示词里告知 AI，并可用 `qq_call_bot` 代你调用它们的指令（详见下文「机器人互认」）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

### QQ 指令（桥接本地执行，不进模型、不花 token）

群友/管理员可以直接在 QQ 里发指令，桥接**本地**回应：不进 DSH、不消耗 token，也不会污染未读/唤醒状态。

| 指令 | 别名 | 说明 | 权限 |
| --- | --- | --- | --- |
| `/指令` | `/帮助` `/菜单` `/?` `/h` | 显示指令列表 | 所有人 |
| `/状态` | `/status` | 运行模式/角色/唤醒/未读（管理员多一行模型与白名单） | 所有人 |
| `/ping` | `/在吗` `/存活` | 探活 | 所有人 |
| `/机器人` | `/bots` `/机器人列表` | 列出本群识别到的其他 QQ 机器人（带 `刷新` 强制重拉） | 所有人 |
| `/我是谁` | `/whoami` `/身份` | 查看自己的 QQ 号与权限 | 所有人 |
| `/潜水 [分钟]` | `/sleep` `/睡` | 让机器人潜水（默认 60 分钟） | 管理员 |
| `/唤醒` | `/wake` `/起来` | 回到活跃（任何消息都唤醒） | 管理员 |
| `/暂停` `/继续` | `/pause` `/resume` | 暂停/恢复 AI 回复（消息仍入库） | 管理员 |
| `/重置` | `/reset` `/new` `/重开` | 重置本会话上下文 | 管理员 |
| `/模型 [名称]` | `/model` | 查看/切换本会话模型（`/模型 reset` 恢复默认） | 管理员 |
| `/角色 [名称\|off]` | `/role` | 查看/切换/清除角色扮演 | 管理员 |
| `/静默` `/活跃` | `/silent` `/quiet` `/active` `/speak` | 进入静默/恢复正常回复 | 管理员 |
| `/调机器人 <名字> <指令>` | `/call` `/呼叫机器人` | 让机器人代你去调用群里其他机器人的指令 | 管理员 |

要点：

- 支持 `/` 与全角 `／` 前缀，也支持 `@小鲸鱼 /状态` 这种先 @ 再跟指令的写法。
- **不认识的 `/xxx` 不会被抢占**：管理员发的原样转给 DSH（DSH 自有斜杠命令仍可用），群友发的当普通聊天走 AI——不会再出现「随便发个 `/xxx` 就被回一句仅管理员可用」的刷屏。
- 群里群友用指令的门槛由 `commands.groupMode` 控制：`always`（默认）/ `mention`（必须 @ 或引用机器人）/ `owner`（只认管理员）。
- 限频按「会话 + 发送者」，不同人互不影响（`commands.cooldownMs`，默认 2 秒）。

### 机器人互认（和群里别的机器人打交道）

OneBot v11 的消息事件里**没有**机器人标识，但 SnowLuma 的 `get_group_member_list` 会返回 `is_robot`。桥接据此建立「本群哪些 QQ 是机器人」的名册并缓存（默认 10 分钟，落盘 `state/bots.json`）：

- 其他机器人的消息会在未读/最近消息里带 `isBot: true`，发送者名字也会标成「某某（机器人）」，AI 能分清「另一个程序」和真人。
- 唤醒提示里会注入本群机器人名单与互动建议；`bots.wakeOnBotMessages: false` 可让机器人消息不再单独唤醒 AI（只保留「@我/引用我」）。
- AI 用 `qq_list_group_bots` 查名单，用 `qq_call_bot` 以你的身份在群里发「@那个机器人 + 指令」去调用它的功能（签到/点歌/查询…），有每小时次数上限。
- `qq_get_group_members` 现在也会返回 `is_robot` 字段。
- 网关不提供 `is_robot` 时自动退化为昵称关键词启发式，并在结果里标 `authoritative: false`，别太当真。

### 引用回复

- `qq_reply` / `qq_send_group_message` 支持可选 `atUserId`：引用某人并同时 @ 他（引用 + @ 可以同一条发出）。
- `qq_send_burst` 现在也支持 `replyToMessageId` 与 `atUserId`（只作用于第一条，后续条保持纯文本，不重复打扰）。
- 发送成功后响应会回传 `quoted: { sender, text, userId }`，模型能确认自己引用了谁。

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（供 agent 自动启动/停止） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |
| `commands.enabled` | 是否启用 QQ 指令，默认 `true` |
| `commands.groupMode` | 群里群友用指令的门槛：`always`（默认）/ `mention`（须 @ 或引用）/ `owner` |
| `commands.prefixes` | 指令前缀，默认 `["/", "／"]` |
| `commands.cooldownMs` | 同一人在同一会话里的指令限频，默认 `2000` |
| `commands.defaultSleepMinutes` | `/潜水` 不带分钟数时的默认时长，默认 `60` |
| `bots.enabled` | 是否启用群内机器人识别，默认 `true` |
| `bots.autoDetect` | 是否用 `get_group_member_list` 的 `is_robot` 自动识别，默认 `true` |
| `bots.refreshMs` | 机器人名册缓存时长，默认 `600000` |
| `bots.wakeOnBotMessages` | 其他机器人的消息是否唤醒 AI，默认 `true`；`false` 时只保留「@我/引用我」 |
| `bots.known` | 手工登记的机器人：`[{"qq":123456,"name":"签到机器人"}]`（任何群里都认） |
| `bots.maxCallPerHour` | `qq_call_bot` 每小时调用上限，默认 `10` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（另一台设备 / 新环境）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖，可手动在 DSH 设置页的 `qq-mode` 卡片切换。

详细步骤见 **[docs/DSH_SETUP.md](docs/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 5 步，DSH 和桥接都已就绪，缺的只是 SnowLuma 本体：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

3. **首次引导（WebUI）**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）

4. **填写桥接配置**（`config.json`）
   ```json
   "snowluma": {
     "wsUrl": "ws://127.0.0.1:3001",
     "httpUrl": "http://127.0.0.1:3000",
     "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
   }
   ```
   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。
   建议顺手把 `allow.private` / `allow.groups` 白名单填上。

5. **启动桥接**
   ```bash
   cd qq-bridge
   npm start          # 或双击 start.bat
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 不需要动桥接**：桥接会自动检测 DSH 恢复（每 5 秒探活），DSH 重启期间收到的 QQ 消息会**入队缓存**（最多 50 条/会话），恢复后自动补投，不会丢
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `~/.dsh/.agent-presets/qq-chat*/` 或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```
```

## 自测（不需要 SnowLuma / QQ）

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  docs/
    PROJECT_GUIDE.md    # 公开版项目说明书
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 设置页 qq-mode 卡片插件
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 4000 字自动分段
- QQ 图片/语音/视频会转成 `[图片]` 等占位文本给 agent
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
