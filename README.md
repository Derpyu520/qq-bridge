# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引见 **[docs/README.md](docs/README.md)**；目录与脚本命名见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
> 🔒 权限边界与安全承诺见 **[RULES.md](RULES.md)**；相对上游改了什么见 **[docs/CHANGES.md](docs/CHANGES.md)**。

把 QQ 群和私聊接进 DeepSeek Harness（DSH），让 AI 以一个**具体的人**的身份长期待在群里：
有自己的人设、记得住群友、看得懂气氛，会潜水、会接梗，也能被你从私聊里远程指挥。

它不是「问一句答一句」的客服机器人，而是一个会用工具的群成员。

> **版本**：`v0.3.0`，适配 DSH 0.2.1-rc.2；二代 `reserved2` 完整保留，可随时切回。
> 历史版本与逐条改动见上游 [releases](https://github.com/Derpyu520/qq-bridge/releases)；
> 0.2.0 / 0.2.1 的适配细节见 [DSH_020](docs/guides/DSH_020_ADAPTATION.md) 与 [DSH_021](docs/guides/DSH_021_ADAPTATION.md)。

---

## 相比原来的 qq-bridge，这一版多了什么

以[上游 `Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge) 的 `main` 为基线逐项对比：
**55 个文件修改、49 个新增、0 个删除**（文件级清单与核对方法见 [docs/CHANGES.md](docs/CHANGES.md)）。

| 维度 | 原来的 qq-bridge | 这一版 |
| --- | --- | --- |
| **会话独立人格** | 一张角色卡全局生效 | **默认人格 + 按群/私聊例外**；换人格清旧摘要与最近消息；群友改不了 |
| **管理员私聊跨会话指令** | 开控制台，或进到那个群里操作 | `/branches` 看所有群、`/summary` 看摘要、`/mute` 静音、`/card` 改名片 … |
| 管理员动作 | 零散工具，没有确认流程 | 改群名片/群名/头像、QQ 资料/头像、发说说；**确认卡 + 审计 + 撤销 + 冷却**，三档权限 |
| 限额 | 每分钟 / 每小时 | 分钟 / 小时 / **2 小时 / 每日** + **跨会话全局**，超限 429 或延后 |
| 记忆 | 群友印象只有标签和次数 | **人物卡**：事实/边界/置信度 + 熟悉度档位，只注入相关的几个人 |
| 主动 | 全局概率 | **会话级概率调整** + 冷场/被无视打分 |
| 表情 | 列表 + 发送 | 人格匹配、五档频率、收藏/删除、动图抽帧 |
| 多模态 | 基础图片 | **OCR、文档（PDF/DOCX/XLSX）、语音转写与发送**、拍一拍/点赞/签到/分享卡片 |
| 资料/空间 | 无 | QQ 资料与头像、空间读写（白名单字段 + SSRF + 配额） |
| **三代仿真** | 二代 `reserved2` | 新增**三代 `reserved3`** + `qq-chat-v3` preset + 独立配置档 |
| 工程 | 单文件为主 | 抽出 8 个可单独测试的模块；回归从 27 KB 扩到 74 KB（R1–R43） |

除了这些功能，还修了一批看不见的东西：发送失败不再假 429、换人格不再串台、
切人格/解除静音后主动检查不再丢排程、DSH 重启后端口自动跟随、
隐私扫描的数字规则（原来会把 QQ 号当噪音吞掉）等。

---

## 功能一览

### 1. 每个会话一个独立人格

同一个机器人，可以在 A 群是傲娇助手、在 B 群是小鲸鱼、私聊里又是一个人。

- **默认人格 + 按会话例外**：控制台「人格与角色」页点选即可；保存进 `state/current-role.json` 的 `byKey`。
- **群友改不了**：在群里说「进入角色扮演：XX」会被直接拒绝，只有管理员（`ownerQQ`）能改。
- **换人格会清上下文**：旧人格的摘要、最近消息、未读、记忆、人物卡互动片段一起清掉并退役旧 DSH 会话，
  避免新人格接着旧人格的话往下说（这是「人设不稳」最常见的原因）。
- **行为合同**：人格卡里的 `## 行为合同` 会被解析成「默认长度 / 被@ / 主动 / 对 owner、熟人、新人怎么说话」，
  比正文口号更硬，三代下优先级高于仿真提示词。
- **会话初始提示词**：可以给某个群/私聊预写一段「这个群聊什么、什么氛围、有什么忌讳」，AI 在**第一次唤醒**时收到一次，
  之后不再重复；群友看不到、也改不了。
- 自带两张示例卡：[傲娇助手](roles/傲娇助手.md)（极简）与 [小鲸鱼](roles/小鲸鱼.md)（完整）。
  写卡可参考 [roles/README.md](roles/README.md) 和 [人格卡 skill](skills/qq-persona-card/SKILL.md)。

### 2. 管理员私聊：一个窗口指挥所有群

这些命令由**桥接直接执行，不进模型**，所以群友看不到、也改不了。全部只有 `ownerQQ` 能用。

| 命令 | 作用 |
| --- | --- |
| `/branches` | 看所有群/私聊最近活跃、未读、唤醒状态（最多 15 行） |
| `/summary <群名或群号> [小时]` | 看某个群最近在聊什么（不用切过去） |
| `/mute [群号]` / `/unmute [群号]` | 让某个群（或全部白名单群）闭嘴/恢复；静音时连发送都会被拦 |
| `/card [群号] <名片>` | 改机器人在某个群的名片；`/card -` 清空 |
| `/nick <昵称>` / `/sign <签名>` / `/avatar <图片>` | 改 QQ 账号资料（仅私聊；`/card` 例外，可在群里改本群名片） |
| `/role <角色>` / `/role off` | 切人格 / 停止扮演 |
| `/reset`、`/status` | 重置该会话上下文、看当前状态 |

AI 遇到需要你拍板的事（提问、工具审批）会发到你的私聊，回一句「通过」/「拒绝」就行；
`/model` 这类 DSH 自己的斜杠命令也会原样转给 DSH 执行。群友发的 `/` 命令一律拒绝。

除了命令，AI 也能主动跨会话：

- **`qq_delegate`**：让另一个白名单会话用**它自己的人设**去说一句（不是串台代发）；异步投递。
- **`qq_send_message`** 指定别的会话 key：跨会话代发，受 `botPerms.crossSessionSend` 权限约束。
- 权限三档：`none`（不开放）/ `request`（仅应要求，其他人要求会在 owner 私聊弹确认卡）/ `persona`（人设自主，可被驳回）。

### 3. 群聊里像真人

- **分条**：一句话一条消息，说完想补再冒一条，不把三句塞进一个气泡。
- **节奏**：首条有 0.6~3 秒延迟，私聊可显示「正在输入」；按字数、时段、对方是不是 owner 调整。
- **判断**：`@` 分 summon（点名/提问/引用自己）、social（普通 @）、mass（@全体或一次 @ 多人）；
  `mass` 不唤醒。唤醒包会算一个 0~1 的**回复压力分**，给出「高/中/低 + 建议条数」，允许 0 条。
- **追问会被强制提升**：对方说「你怎么不回」「第二个问题呢」时，压力直接拉到高，防止装死。
- **潜水与唤醒**：AI 自己设置下一次唤醒条件（@、名字、关键词、提问、拍一拍、概率、指定群友），
  也能「睡前提观察 5 分钟」确认没人找它再潜水。
- **私聊合批 1.5 秒、群聊 8 秒**：连续几条消息合成一次上下文，避免一条一条醒来。
- **冷场会主动开口**（可关）：按概率和「被无视」程度决定要不要自己起话题。
- **引用链**：能判断「他在回谁」，不会把群友之间互相引用的吐槽当成对自己说的。

### 4. 记得住人

- **人物卡**：按 QQ 号存称呼、关系档位、熟悉度、事实（带置信度）、雷区边界、互动片段、上次对话。
- **只注入相关的人**：唤醒时不会把几十个人塞进提示词，只挑最近出现的最多 5 人，按 owner/熟人/常客/新人给语气建议。
- **轻量记忆**：进行中的话题（24 小时过期）、想说但还没说的话、对群友的印象。
- **摘要**：6 小时窗口的规则摘要 + 异步 LLM 摘要；会话重置后下一次会带「上次聊到哪」的 recap。
- **可审计**：每次唤醒/发送都写 `state/decisions.jsonl`（压力、预算、动作），能分清「选择不回」和「没被唤醒」。

### 5. 表情包不是摆设

- **收集**：看到别人发的有意思的图，可以收藏进自己的 QQ 表情库并写备注。
- **使用**：按人格挑图（备注里有角色名/别名就优先），`useCount` 低的新图也能被看见。
- **频率**：控制台五档——不发表情 / 少量 / 适中 / 较多 / **完全根据人设来**；档位同时作为硬上限。
- **清理**：能删自己收藏的表情（不可恢复），默认「仅应要求」+ 每分钟/小时/天上限，删完回读确认。
- **动图**：GIF 会自动抽帧拼图交给多模态模型看。

### 6. 不止文字

| 能力 | 说明 |
| --- | --- |
| 图片 / 动图 | 走 QQ CDN 直链，失败按 `emoji_id` 推地址兜底；SSRF 防护；自动压缩到模型能吃的大小 |
| 发图 | `qq_send_image` 只认 `media/` 下的文件名，拒绝路径/URL/base64 |
| 语音 | **收**到的语音默认只显示占位，AI 可调用 `qq_transcribe_voice` 转写（需网关支持）；**发**语音用 `audio/` 里的文件（默认关闭） |
| OCR | 图片里的文字直接读出来 |
| 文档 | 聊天里的 txt / md / PDF 文字层 / DOCX / XLSX（默认关闭，历史文件还要单独开权限） |
| 消息操作 | 引用回复、合并转发、搜索历史、撤回自己刚发的、撤回改口（`qq_revise_message`） |
| 社交动作 | 拍一拍；点赞、群签到、图文分享卡片默认关闭，管理员单独开 |
| QQ 资料 | 看某个人的公开资料与头像（只能看本会话/本群出现过的人，有配额） |
| QQ 空间 | 读自己/好友动态；发说说走确认卡 + 每小时/每天上限 + 回读校验 |

### 7. 黑话学习

- 群里出现反复看不懂的新词，桥接会**自动提取候选**，必要时联网查含义，交管理员确认。
- 确认后的词条进入提示词，AI 后面就能听懂；控制台「黑话词库」页可增删、批量整理。
- 默认开启（`slang.enabled`），不想让群聊关键词出机可以关掉自动研究或换搜索后端。

### 8. 管理员动作：改资料、改名片、发说说

- 支持：改群名片 / 群名 / 群头像、QQ 昵称 / 签名 / 头像、发空间说说。
- **三档权限**：不开放 / 仅应要求（其他人要求会先给 owner 发确认卡）/ 人设自主（AI 可按人设驳回，返回 `persona_veto`）。
- 全部动作有**审计、撤销、冷却**；头像只认 `assets/` 里的图片，说说图片只认 `media/` 里的文件名。
- 详见 [docs/guides/ADMIN_OPS.md](docs/guides/ADMIN_OPS.md)。

### 9. 本地控制台

`http://127.0.0.1:3100`，令牌保护，支持浅色/深色主题：

- **运行总览**：模式、连接状态、活动日志。
- **会话与审批**：每个群/私聊的映射、未读、重置、审批。
- **人格与角色**：编辑人格卡、按模式看注入字符数、警告（超长/含一代指令）。
- **一代 / 二代 / 三代仿真**：发送节奏、唤醒、限额、摘要、表情、工具开关、初始提示词。
- **工具参考**：所有 QQ 工具的说明与参数。
- **黑话词库**：候选、已确认、批量操作。
- **令牌与花费**：实时 token 与折算金额，能下钻到每个群/好友/每一轮；区分高峰/空闲价，带走势图。
- **访问与安全**：白名单、模式、机器人自主权限、控制台令牌。
- **调试与运维**：状态 ACL、DSH 端口、日志。

### 10. 安全边界（默认就收紧）

- **默认拒绝**：`allow` 为空时不处理任何会话；每个发送目标都要过白名单。
- **工具面收敛**：DSH 侧只拿到 QQ 动作的安全子集；开发/终端/插件类工具在注册期就被隐藏。
- **按会话令牌**：AI 的每次工具调用都要带当前会话 token，换个会话不能复用。
- **不出本机**：控制台、DSH、SnowLuma 都只监听 `127.0.0.1`；`state/` 建议用 ACL 收紧。
- **出站防护**：资料/头像/搜索走固定域名与 SSRF 校验；本地文件只允许白名单目录（realpath 复核）。
- **运维自愈**：DSH 桌面版重启/更新后端口会变，桥接自动扫描并跟随；`state/` 可用 `npm run harden-acl` 收紧权限。
- **旁路审计**：SnowLuma 自带的 `#sl` 命令会绕过桥接直接发消息，桥接只读检测并告警（这条拦截不了，但能看见）。
- **不碰 SnowLuma 的部署**：本程序只探测网关，不安装、不启动（遵守其 EULA）。
- 发布前可以跑 `npm run privacy-scan` 扫真实号码/路径/令牌。

### 11. 三代仿真（Gen3 / `reserved3`）

先说清楚：**三代不是另起一套引擎**。它和二代共用同一套社交内核、状态文件和工具面，
新增的是「独立配置档 + 独立 preset + 控制台三代页」。三代 preset 会把下面这些机制**从"有能力"变成"默认要求"**：

| 三代 preset 要求模型做的事 | 具体表现 |
| --- | --- |
| 按行为合同行动 | 长度、被@、主动程度以人格卡合同为准，合同优先于提示词 |
| 先判断再回 | 看回复压力（0~1 分）和建议条数；允许 0 条，允许已读不回 |
| 有时机感 | 首条 0.6~3 秒延迟、私聊「正在输入」、按语境分条 |
| 带着记忆醒 | 情景摘要 + 上次聊到哪 + 人物卡，而不是只给 12 条未读 |
| 一次取齐 | 用 `qq_context` 拿摘要/快照/记忆/唤醒/额度，少调几次工具 |
| 好好收尾 | 按 `canSleepNow` 与提示给的超时做睡前观察，不靠猜 |

启用方式（任选）：控制台模式切 `reserved3`；或 `state/mode.json` 写 `{"mode":"reserved3"}`。
切回 `reserved2` 随时可以，数据不迁移。

> 配置上最容易踩的坑：`socialV3` 只覆盖 `tools / timing / decision / context / document` 五块，
> **发送、唤醒、限额仍读 `socialV2`**。改频次去二代页，不要在 `socialV3` 里找。
> 细节（含代码索引、回退、已知边界）见 **[docs/design/GEN3.md](docs/design/GEN3.md)**。

### 12. 限额与成本

- **滑动窗口**：发送和唤醒都有每分钟 / 每小时 / 每 2 小时 / 每日四道限额，分支级 + 跨会话全局级；
  发送超限返回 429 + `retryAfterMs`，唤醒超限自动延后重试，不会静默丢事件。所有额度填 `0` = 不限。
- **花费看得见**：控制台「令牌与花费」实时显示 token 与折算金额，能下钻到每个群、每个好友、每一轮对话，
  区分高峰/空闲价，并给 24 小时 / 3 天 / 7 天 / 30 天走势图。
- **模型可调**：默认 `deepseek-flash` + 思考强度 `max`，可在配置里改；改完下一条消息生效。

---

## 运行模式

| 模式 | 谁能用 | 干什么 |
| --- | --- | --- |
| `chat` | 白名单群/私聊 | 安全聊天：消息转给 DSH，回复发回 QQ，不做群友模拟 |
| `closed-agent` | 仅 owner 私聊 | 在 QQ 里操控 DSH，拥有完整工具 |
| `reserved` | 一代仿真 | 观望/活跃/试探/退场状态机，按空格分句，`[SILENT]` 潜水 |
| `reserved2` | 二代仿真 | 一切皆工具：自主看消息、发言、等待、设置唤醒 |
| `reserved3` | 三代仿真 | 二代内核 + 三代 preset + 独立配置档，强调判断、时机与记忆 |

---

## 名词小抄

| 说法 | 意思 |
| --- | --- |
| 管理员 / owner | `config.json` 里的 `ownerQQ`，也就是你；管理命令和审批只有你能用 |
| 会话 | 一个 QQ 群或一个私聊；每个会话在 DSH 里是独立的对话 |
| 人格卡 | `roles/<名字>.md`，写「它是谁、怎么说话」；和工具用法分开 |
| 唤醒 | 群里发生事情后把 AI 叫起来看一眼；叫醒不等于必须回 |
| 潜水 | AI 主动安静下来，等下一次条件命中再醒 |
| 压力 / 预算 | 唤醒包里给模型的回复倾向分数与建议条数，低压力可以 0 条 |

## 它是怎么工作的

```
QQ 消息 ──► SnowLuma（OneBot v11）──►桥接进程──► DSH Web API
                                        ▲              │
                                        └── agent 回复/工具调用 ┘
```

- 每个 QQ 群/私聊对应一个独立的 DSH 会话，归到「QQ 聊天」工作区，映射存在 `state/sessions.json`。
- 桥接自带三个 MCP server：QQ 动作（`snowluma`）、只读探活（`snowluma-host`）、联网搜索（`web-search-safe`）。
- 人格、记忆、摘要、限额都在桥接侧，AI 通过工具读写；提示词与工具协议在 `dsh/agent-presets/qq-chat-v3/`。
- 想深入目录与模块，见 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)。

---

---

## 快速开始

需要 Node.js ≥ 22.13，并准备好两样东西：**SnowLuma**（QQ 网关，装好并登录、配好 OneBot WS/HTTP）与**可用的 DSH**
（默认 `http://127.0.0.1:3080`，端口会自动跟随）。

```bash
git clone https://github.com/<你的 GitHub 用户名>/qq-bridge.git
cd qq-bridge
npm install                              # postinstall 会修补 SnowLuma SDK 的 ESM 问题
cp config.example.json config.json       # Windows 用：copy config.example.json config.json
node scripts/setup-dsh.mjs               # 把 preset + MCP 装进 DSH，然后重启 DSH
npm start                                # 控制台 http://127.0.0.1:3100
```

详细的从零安装见 [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)。

---

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080`。DSH 桌面版每次重启/更新后端口可能变（实测 `12516` → `2500`），桥接连不上时会自动扫描本机端口、**验证通过后**把地址跟随过去并写回本文件（见下方 `dsh.autoDiscover`） |
| `dsh.autoDiscover` | 默认 `true`。`dsh.baseUrl` 是回环地址且 `settings/describe` 失败时，枚举本机 LISTENING 端口，用无凭据的 `GET /` 指纹粗筛、再用一次真实 RPC 验证，**验证通过才切换**并写回 `config.json`；60 秒最多一次。多开 DSH（多个实例）或要绝对固定地址时设为 `false` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态（DSH 0.1.7 起启动 token 只存在于内存、日志里那条是上一个进程的陈旧值，换 Cookie 只会 401）。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` / `socialV2.gen3Preset` | `reserved2` / `reserved3` 模式使用的 DSH agent preset，默认 `qq-chat-v2` / `qq-chat-v3` |
| `socialV2.initialPromptMaxChars` | 会话「初始提示词」（控制台为某个群/私聊预写的环境说明）的字数上限，默认 2000，允许 100~8000。越界值会在启动时收敛并保持原文件不动 |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）、`dir`（`qq_send_image` 的媒体库目录，默认 `media/`）。越界值启动时收敛 |
| `socialV2.sticker` | 收藏表情体系：`enabled`、`syncTtlMs`、`maxListCount`、`includeInPrompt`、`promptMaxStickers`；`collect`（AI 收藏：`enabled`、`maxPerMinute`/`maxPerHour`/`maxRemarkChars`）；`delete`（AI 删除：`enabled`、`maxPerMinute`/`maxPerHour`/`maxPerDay`，默认 1/5/20，账号级共用）；`send`（发表情频率：`mode` = `off`/`low`/`normal`/`high`/`persona`，默认 `normal`；高级覆盖 `maxPer10Min`/`minGapMs`，`null`=档位默认、`0`=关闭） |
| `socialV2.document` | 文档阅读：`enabled`（默认 false）、`allowHistory`（默认 false）、`maxBytes`/`maxPages`/`maxChars`/`maxPer10Min`。默认关闭；历史文件必须由管理员单独打开 |
| `socialV2.profile` | 别人的 QQ 资料/头像：`enabled`（默认 true）、`cacheTtlMs`（默认 10 分钟）、`maxPer10Min`（每会话资料+空间读共用配额，默认 10）、`avatarSize`（qlogo 尺寸，默认 640）、`maxAvatarBytes`（默认 4MB）。资料只回白名单字段 |
| `socialV2.qzone` | QQ 空间：`enabled`；`read.maxPosts`/`read.maxFeeds`（默认 10/10）；`post.enabled`（默认 true）、`maxContentChars`（默认 1000）、`maxImages`（默认 9）、`defaultUgcRight`（默认 1=所有人可见）、`maxPerHour`/`maxPerDay`（默认 2/6）、`minIntervalMs`（默认 5 分钟）、`duplicateWindowMs`（默认 10 分钟）、`verify`（发完回读，默认 true） |
| `socialV2.context.*` | 上下文与唤醒快照：`recentLimit`、`unreadLimit`、`contextWindow`、`inlineWakeMessages`、`wakeMessageLimit`、`wakeRecentLimit`、`wakeMaxChars`、`digestEnabled`、`digestWindowMs`、`digestMaxChars`、`digestEveryMessages`、`digestEveryMs`、`digestSummaryMaxChars`、`digestRecapMaxChars`、`maxWakePromptChars` |
| `socialV2.send.*` / `socialV2.wake.*` / `socialV2.quota.global.*` | 发送/唤醒限额：`maxSendPerMinute/Hour/Per2Hours/Day`、`maxWakePerMinute/Hour/Per2Hours/Day`；另有跨会话全局的 `maxSendPer2Hours/Day`、`maxWakePer2Hours/Day`。0=不限；默认发送 8/60/30/120 条，唤醒 1/12/10/30 次，全局 120/500 条、30/100 次。每 2 小时为滑动窗口，每日按本地 00:00 重置 |
| `socialV2.voice.maxPerMinute/Hour/Per2Hours/Day` | 语音发送限额，默认 2/10/4/20；另有 `maxSeconds`、`maxBytes` 的体积/时长上限。0=不限 |
| `socialV2.decision.*` / `socialV2.timing.*` | `socialMentionDelayMs`（social @ 延迟，默认 30000）、`highPressure`/`mediumPressure`（默认 0.6/0.35）；`timing.enabled`、`minDelayMs`/`maxDelayMs`（首条发送延迟，默认 600/3000ms）、`typingIndicator`（私聊正在输入，默认 true） |
| `socialV3.wake.privateBatchWindowMs` | 私聊合批上限，默认 1500ms（群聊仍用会话自己的 `batchWindowMs`，默认 8000ms）。只影响 `private:*`：私聊一条完整消息不必再陪跑群聊的 8 秒合批；`0`=不额外限制。读的是 `socialV3.wake`，不经过二代 effective 配置 |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/<你的 GitHub 用户名>/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
```

reserved2 的 token 开销优化、消息水位协议、升级与回退说明，对应的离线回归可运行 `npm run test:token`（已包含在 `test:audit` 里）。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md / CONTRIBUTING.md / SECURITY.md   # 根目录文档，其余全在 docs/
  docs/
    README.md           # 文档索引（每篇一句话）
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 使用者/运维：DSH_SETUP / ADMIN_OPS / PROACTIVE / PRIVACY / SECURITY_BASELINE …
    design/GEN3.md      # 三代仿真：设计、配置与回退
  dsh/agent-presets/    # qq-chat / qq-chat-v2 / qq-chat-v3 的 DSH agent preset 模板
  plugins/
    qq-mode-console     # DSH 插件：注册 qq-mode 设置命名空间
    qq-agent-presets    # 把 preset 打包成 DSH 插件（含 v3 patch）
  public/console.html   # 本地控制台（无构建步骤，直接由 bridge.js 提供）
  roles/                # 人格卡（示例：傲娇助手、小鲸鱼）
  skills/qq-persona-card # 写人格卡的 DSH skill（可复制到 ~/.dsh/skills/）
  src/
    bridge.js           # 主程序（HTTP API + 控制台 + 仿真引擎 + 调度）
    core/session-router.mjs # 按会话解析 mode/preset/model 的路由模块（当前未被 bridge.js 引用）
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    mcp-snowluma-safe.js / mcp-host-server.js # QQ 动作 MCP（白名单 + 权限闸门）
    mcp-web-search-safe.js # 联网搜索 MCP
    role-card.js        # 人格卡解析（行为合同、按模式注入）
  scripts/              # 测试、探针与运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
  assets/               # 头像候选（只放你自己的图；默认只有示例图）
  media/                # 发给 QQ 的图片（不入库）
  state/                # 运行时数据（不入库）
```

> 🎤 语音发送内核在 `src/voice-core.js` / `src/send-voice-lib.js`，默认关闭
> （`socialV2.voice.enabled`）；本仓库不含独立的图形界面。开启前先装好 ffmpeg，
> 并把音频放进 `audio/`（不入库）。

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 才真的有**）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（本功能的第一版实现正是这么写错的，回归里已加反面断言钉住。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级不换原生组件，见下**）。

### 版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **1.14.20 已实测**（1.14.9 亦兼容） | **实测记录（2026-10-03，SnowLuma 1.14.20 + QQ 在线）**：包 SHA256 与官方发布摘要一致；心跳 `status.good=true`／`interval=30000`；桥接走完「首次 1006 → 自愈 WS token → 已连接」；收到群消息（`lastPacketKind: message/group`）；完整往返成功（唤醒 → DSH 建会话挂 `qq-chat-v2` → 工具发送 1/1 条 → 实际发出两条回复）。 ⚠️ **升级运行时不会更换注入用的原生组件**：实测 `native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` 在 **1.14.9 与 1.14.20 之间逐字节完全相同**（三方对比：官方 1.14.9 包 == 本机安装 == 官方 1.14.20 包），变的只有 `index.mjs`（+414 KB）等 JS 层。所以**升级能带来 OneBot 事件流水线、收发与新区块链路上的修复（`bot_status`、markdown 带 text、事件种类订阅更全），但不会修「原生 hook 挂不上 QQ」这类问题** —— 那种要走 SnowLuma 自己的排查。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)） |
| `@snowluma/sdk` / `@snowluma/mcp`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发） |
| `bot_status`（账号上下线） | **1.14.20 有；1.14.9 没有** | 逐一核对的只有这两个版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）。**具体从哪个版本引入未逐版核对**。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；语音/视频以及无法取得图片字节的消息仍使用占位文本
- **发**语音是支持的（发送内核 `src/voice-core.js` + AI 工具 `qq_send_voice`）；**收**到的语音默认只显示占位文本，
  AI 可以主动调 `qq_transcribe_voice` 转写（需网关支持），不会自动把语音内容塞进上下文
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关；你自己发语音不受这个开关影响
- **QQ 空间读取的边界**：能读「自己的说说」与「好友动态」；用 `target_uin` 读**别人**的空间在实测网关上会返回「响应结构异常」（`msglist: null`），所以不提供任意用户的空间读取。好友动态只有第一页可靠。发说说只能带 `media/` 里的图片文件名（URL/路径/base64 一律拒绝）
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
