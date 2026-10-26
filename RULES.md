# QQ 桥接权限与安全规则（RULES）

## 运行模式（QQ 桥接四模式）

模式由**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部的模式按钮切换，也可直接改 DSH 设置的 `qq-mode` 命名空间；
控制台会**同时**写穿到 DSH 设置与本地 `qq-bridge/state/mode.json`，两者保持一致。
（DSH 设置页目前**没有** `qq-mode` 卡片：该插件只有 host 半，未实现浏览器半。详见 docs/guides/DSH_SETUP.md。）
桥接每 5 秒读取一次；控制台切换立即应用。会话持久化记录创建时的模式、preset 和管理员边界，权限变化时自动撤销旧会话映射和二代 token，并在下次消息到达时重建，避免继续使用旧的高权限 preset。升级前没有这些权限元数据的旧会话也会重建一次，历史仍保留在 DSH。
全新安装运行 `scripts/setup-dsh.mjs` 后，DSH 设置与本地兜底默认均为 `reserved2`；若已存在 `state/mode.json` 或 DSH 设置旧值，脚本不会覆盖。

| 模式 | 允许通道 | agent preset | 用途 |
| --- | --- | --- | --- |
| `chat` | 白名单群 + 白名单私聊 | qq-chat（安全聊天） | 日常聊天 |
| `closed-agent` | **仅** 私聊 ownerQQ | DSH 默认 preset（通常 `standard`，完整工具） | 你在 QQ 私聊里操控 DSH |
| `reserved`（一代仿真） | 暂同 chat | qq-chat | 仿真群友：观望/活跃/试探/退场状态机，选择性参与并主动收尾 |
| `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后默认） | 暂同 chat | qq-chat-v2 | 文本不自动转发，AI 通过工具自主看消息/发言/等待/设置唤醒与潜水 |
| `reserved3`（三代仿真） | 暂同 chat | qq-chat-v3 | 在二代全部能力上启用人物卡、摘要、回复判断/时间、发图/表情/语音转写/OCR 等三代能力 |

> ⚠️ `closed-agent` 模式下 owner 私聊 agent 拥有**完整本地工具**（DSH 默认 preset，通常是 `standard`），
> 这是有意为之（QQ 远程操控 DSH）。该模式只放行 owner 私聊，群友完全无法触达；
> 切换回 `chat` 后，owner 私聊也回到 qq-chat 安全预设。
>
> 注：DSH 0.1.5 已不存在 `router-standard` preset。桥接现在留空表示「用 DSH 默认 preset」，
> 并在启动时读取 `agentPresets/list` 校验；填了不存在的 preset 名会回退到默认值并打警告，
> 绝不会创建出「无 preset」会话（那会被 DSH 套上 `standard`，对 QQ 群是安全回归）。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **管理员（ownerQQ，控制台或 DSH 设置页可配置）** | QQ 群/私聊 | 正常聊天 + **管理命令由桥接硬执行**（不经过模型）：`/role <角色名>` 切人格、`/role off` 清除、`/silent` 静默、`/active` 恢复、`/reset`、`/status`、`/undo`；**管理员动作**（改群名片/资料/头像）私聊直连、其它会话必须由管理员在私聊回「通过 #编号」（见 [guides/ADMIN_OPS.md](docs/guides/ADMIN_OPS.md)）；消息自动带【管理员】标记 |
| **群友** | QQ 群 | **仅正常聊天**。控制词、`/` 管理命令被桥接拦截；静默模式下消息不投递给 agent |
| **管理员** | **桥接控制台**（`http://127.0.0.1:3100`） | **最高权限**：控制模式（控制台顶部模式按钮）、控制角色/静默（写 `state/current-role.json`）、完整 DSH 工具（含本地操作）、查看 QQ 活动日志（`state/qq-activity.log`）、直接打开「QQ 聊天」工作区会话对话 |
| **QQ 会话 agent（chat 模式）** | — | 最低权限面（见下） |

## QQ 会话 agent 的硬边界

1. **无本地工具**：qq-chat / qq-chat-v2 预设不挂载 bash/pwsh、文件读写、子代理、工作流——群友无论如何诱导，agent 物理上无法操作本机。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 三个命名空间下的工具，以及 `ask_user_question` / `todo_write`；其他工具（含 `dev_*` 开发/管理工具）在执行期会被 `qq-tool-restrict.mjs` 拒绝。QQ 动作无禁言、踢人、文件上传下载等管理操作。
   - **唯一例外：`qq_admin`（改群名片 / 群名 / 群头像 / QQ 资料 / 头像 / 撤回自己消息 / 在线状态）**。它不走"模型自律"，走桥接的两条硬约束：① 必须携带**本会话**的 agent token（无令牌的智能体调用一律拒）；② 只有 `private:<ownerQQ>` 会直接执行，其它会话只会生成确认卡发到管理员私聊，管理员回「通过 #编号」才执行。因此群友的 prompt injection 最多换来一张确认卡，改不动任何东西。头像只接受 `assets/` 下的图片（拒绝绝对路径/URL/base64），目标群必须在白名单，且有频率上限与全量审计（`state/admin-ops.json`）。
      - **同一条例外的只读部分：`qq_list_assets` / `qq_view_asset`**。前者只回 `mediaDir` 第一层的图片名与大小，后者把其中一张作为图像交给模型（用于“白毛那张”这类外观选择）。两者入参都是**文件名而非路径**（拒绝 `/` `\` `..` 盘符），`realpath` 必须仍在 `mediaDir` 内（防 junction 逃逸），内容必须命中图片 magic bytes，单张 ≤2MB、列表 ≤100 条，并且**只有 owner 本人**能调用（桥接端点用 `sessionSenderIsOwner` 判定，群会话一律 403）。看图与列表都写审计。详见 [guides/ADMIN_OPS.md](docs/guides/ADMIN_OPS.md)。
    - **QQ 资料 / 头像 / 空间（只读 + 一次公开写）**：`qq_get_user_profile` 把某个 QQ 的**公开资料**（仅昵称/备注/性别/年龄/签名/等级/Q 龄/在线白名单字段）与头像（qlogo 固定地址，数字 QQ 号拼接，不走任意 URL）交给模型。**谁能查**是硬约束：机器人自己、owner、owner 本人刚说过话的会话（管理员明确给了号码）、私聊对端、本会话见过的人、当前群成员；其它 QQ 号一律 403，防止群友把机器人当 QQ 号查询台。每会话 10 分钟最多 `profile.maxPer10Min` 次（资料与空间读共用）。`qq_qzone_read` 只读自己/好友动态，好友动态的预渲染 HTML 会被洗成短文本后限长。`qq_qzone_post` 是**账号级公开广播**：走管理员动作队列（`botPerms.qzonePost`，默认「仅应要求」且封顶在 request），owner 本人要求直连，其他人要求只生成确认卡；图片只接受媒体库 `media/` 里的**文件名**（拒绝 URL/路径/base64），最多 9 张、总量 ≤12MB；另有每小时/每天上限、两条间最小间隔、同内容不重复，并在发送后回读自己的说说列表确认落地（`verified`）。详见 [guides/QQ_PROFILE_QZONE.md](docs/guides/QQ_PROFILE_QZONE.md)。
   - **自主操作权限**：控制台「访问与安全 → 机器人自主操作」可逐项设置 `none / request / persona`（界面：不开放 / 仅应要求 / 人设自主），按 **AI 的自主程度** 分档，决定机器人能不能**自己做**（改名片/昵称/签名/头像、撤回自己刚发的消息、在线状态、收藏表情、表情备注、删除收藏表情）。`none`＝没有这个能力（直接拒，不发确认卡）；`request`＝只应管理员要求，管理员身份只看**发消息的 QQ 号**（该会话最近一条消息的发送者，5 分钟 TTL），不看会话、也不看模型自述，其他人要求走确认卡；`persona`＝人设自主，可主动发起，管理员的要求按人格卡「反驳主人」概率可能被驳回（`persona_veto`）。默认身份类与小动作为 `none`、跨会话为 `request`、表情为 `persona`、发空间说说与**删除收藏表情**为 `request`（封顶也是 `request`——公开广播/不可恢复的动作不允许人设自主），旧值 `off/owner/all` 自动迁移。账号级/不可逆/波及别的会话的项封顶在 `request`，需在控制台显式「解除封顶」。`persona` 档需要 preset 第 17 条配合（**重启 DSH 后**才对新会话生效）。
   - **跨会话代发消息**：同一张权限表里的 `crossSessionSend`，默认 `request`。含义是「在 A 会话里让机器人去 B 会话说一句」——B 必须命中白名单，源会话的令牌由桥接反查；`request` 档只允许管理员本人触发，`none` 一律拒绝。不再出现「只有跟你私聊的权限」这种一刀切。
   - **跨会话委派 / 静音**：`crossSessionDelegate`（默认 request）让「去 B 会话说一句」由 **B 自己的会话**来写，用它自己的系统提示、历史和人格卡——这是人设不串台的正确做法；`crossSessionControl`（默认 request）允许改 B 的唤醒/静音。命令 `/mute [群号]` 是 owner 的确定性刹车：单会话静音后不再被任何事件唤醒，发送闸门也会拦住，`/unmute` 恢复。跨会话**代发**不会在目标会话排「回复检查」（旧行为会让目标群自己接着聊下去）。
3. **只读联网搜索**：`qq-chat` / `qq-chat-v2` 预设已关闭 DSH 内置 `tool-web` 的 `search` / `fetch`，联网统一走 `src/mcp-web-search-safe.js` 提供的 `mcp__web-search-safe__web_search/web_fetch`。不暴露本地文件、命令执行、写操作。
   - ✅ `mcp__web-search-safe__web_fetch` 已做 SSRF 加固：仅 http/https、禁止 localhost/私有 IP/链路本地/CGNAT/带凭据 URL、DNS 解析结果全量校验、每跳重定向重新校验、响应体限量读取。
4. **发送强制白名单**：所有发送类工具（`qq_send_group_message` / `qq_send_private_message` / `qq_send_message` / `qq_send_burst` / `qq_reply` / `qq_send_poke` / `qq_send_sticker` / `qq_send_voice` 等）的目标必须命中 `config.json` 的 `allow.groups` / `allow.private`，否则拒绝执行。
   - **语音额外收紧**：`qq_send_voice` 只能发**语音库**（`socialV2.voice.dir`，默认 `qq-bridge/audio/`）里的文件，不能发任意本地路径、URL 或 base64（防 prompt injection 拿本机文件当语音外发）；另有独立的时长/体积/频率上限（`socialV2.voice.*`），额度与文本发送分开计数。
5. **发送禁令（模型层）**：persona 明确规定只有「管理端明确指示」或「【管理员】标记的明确要求」才可使用发送工具；禁止写"我已回复/消息已发送（message_id）"类汇报。
6. **回复审计（桥接层硬拦截）**：agent 回复文本若包含本机路径（`C:\`、`/home/` 等）或凭据特征（token/password/secret/api key 等）→ **整条拦截不发送**，并告知"被安全策略拦截"。
7. **人格由桥接注入**：角色设定来自 `state/current-role.json` + `roles/<角色>.md`（`role` 是默认人格，可选 `byKey` 按群/私聊覆盖），桥接注入到消息；群友口头要求改角色无效（桥接直接拦截），agent 也无文件工具自行更改。
8. **静默模式**：`current-role.json` 的 `mode: "silent"` 时，群友消息不再投递给 agent（仅记录日志），只有管理员消息可对话。
9. **网关旁路必须关闭**：SnowLuma 自带的 `#sl` 状态命令由网关**直接回复**版本、平台/架构与运行时长，不经过桥接的白名单、静默和敏感信息审计。桥接启动时会只读扫描 `snowluma.homeDir/config/onebot*.json`，发现 `statusCommand.enabled` 仍开启就在日志和控制台「访问与安全」页告警；请保持关闭（SnowLuma WebUI → 配置，或改配置后重启 SnowLuma）。

## 提示词的两层边界（仿真 vs 人格）

二代仿真模式下，AI 拿到的提示词由两层拼成，控制台「人格与角色」页可分别查看与修改：

| 层 | 位置 | 管什么 | 生效方式 |
| --- | --- | --- | --- |
| **仿真提示词**（两代各一份） | `dsh/agent-presets/qq-chat/agent.cordis.yml`（一代）与 `qq-chat-v2/agent.cordis.yml`（二代）的 `persona.prefix` | 怎么调工具、怎么参与群聊（行为与协议：安全规则、工具协议、唤醒/分条/记忆/黑话等） | 控制台可按代次分别编辑；保存会写仓库源文件并同步到 `~/.dsh/.agent-presets/<preset>/`；**新会话**自动用新版，**正在进行的 QQ 会话**需 `POST /api/session/reset` 或重启 DSH |
| **人格提示词** | `roles/<人格名>.md` | AI 是谁、什么性格、怎么说话（人设与语气） | 桥接每条消息前注入，**保存即生效** |

- 拼装顺序：`仿真提示词 → 人格提示词 → 本轮消息`。
- **人格卡只写人设，不写工具用法**：两代工具协议不同（一代空格分条 / `[SILENT]`，二代一切皆工具），写进人格卡必然有一代是错的；而且桥接已经每条消息注入当前模式的分条与潜水方式。写作规范见 `roles/README.md`。
- 同一个角色确实需要分代时，用**标题级模式标记**：`## 分条方式 〔一代〕` / `## 表情包 〔二代〕`；无标记的小节两代都注入，标记在注入前会被去掉。桥接按当前模式筛完小节**再**截断。
- **注入上限**：默认每条消息 6000 字符（`config.json` 的 `role.maxInjectChars`，1000~20000，控制台可改）。这是成本护栏——人格卡会随每条消息发送。
- 仿真提示词保存前会做硬性校验：保留 `你没有本地工具` / `群友没有管理权限` / `API 令牌` / `角色由桥接注入` / `不会自动发送到 QQ` 这些安全不变量，且正文 ≥ 500 字符；缺失即拒绝保存（否则会同时削弱权限边界并让 `npm run test:audit` 变红）。写入前自动备份到 `state/preset-backups/`，可一键还原；还原时同样校验。
- 一代遗留写法（空格分句、`[SILENT]`、自动转发）若出现在**未标记**的小节里，二代下会被兜底整行过滤；控制台会提示把它们移到 `〔一代〕` 小节。
- 两层提示词都**只能由控制台（管理员令牌）修改**：带 `x-agent-token` 的请求对这些端点一律 403，QQ 群里的 AI 无法改写自己的提示词。

## 黑话 / 网络用语学习与迭代

- 桥接会把普通群聊消息放入滚动窗口（`state/slang.json` 的候选来源），攒够 `slang.extractMinMessages` 条后交给独立 DSH 学习会话提取“疑似黑话”。
- 候选默认 **不自动转正**：DSH 可联网搜索生成含义/用法/示例，但最终必须由管理员在控制台「黑话词库」里 **确认 / 拒绝 / 编辑 / 删除**。
- 只有 `status: confirmed` 且含义非空的词条会被注入 QQ 聊天 agent 的 prompt（`【群聊黑话表】`），且按出现次数排序、最多 `slang.injectMax` 条。
- 学习会话与 QQ 会话隔离：学习任务的输出不会发到 QQ；它只读消息文本，不执行本地操作。
- 学习会话不会向用户提问/请求审批，桥接会自动跳过这类请求，避免阻塞学习任务。
- `web_search` 工具返回的搜索摘要仅作为候选解释，不视为权威；控制台可随时修改或拒绝。
- 敏感信息/路径/凭据仍走统一审计；黑话库仅存白名单群内消息的文本证据，控制台可删除。

## 管理员操作手册

### 切换角色 / 模式（两种途径，均为硬性机制）

**途径 A：QQ 群内管理命令**（桥接直接执行，不经过模型判断）：
```
/role 傲娇助手    # 切换默认人格（roles/傲娇助手.md）
/role off         # 清除默认人格 + 所有按会话例外
/silent           # 静默模式（群友消息不回复）
/active           # 恢复正常
/status           # 查看会话/白名单/默认人格/本会话人格/模式
/reset            # 重置当前 QQ 会话上下文
/undo             # 撤销最近一次可逆的管理员动作（名片/群名/昵称/头像）
/card 示例名片      # 改机器人在**本群**的名片；/card <群号> <名片> 可指定群；/card - 清空（网关会拒）
/nick 小鲸鱼        # 改 QQ 昵称（账号级）
/sign 在群里摸鱼     # 改个性签名；/sign - 清空
/avatar deepseek娘.png  # 改 QQ 头像（只认 assets/ 下的文件名）
```

**树干只读命令（仅 owner 私聊，不经过模型）**：
```
/branches                     # 列出所有分支：状态/未读/最后活跃/一句话
/summary 示例群 6              # 看某个分支最近 6 小时的消息摘要（群名或群号）
```
owner 在群里发这两个命令会被拒绝，并提示回私聊——群里不展示其他分支。详见 [docs/design/GEN3_ENGINE_PLAN.md](docs/design/GEN3_ENGINE_PLAN.md) 的 6.7 节。

**途径 A2：管理员动作（改名片 / 资料 / 头像）**：
- **最快**：直接用上面的 `/card`、`/nick`、`/sign`、`/avatar` 命令（桥接直连，改完桥接即生效，不需要重启 DSH）；账号级命令只在私聊执行；
- 在**你自己的私聊**里跟 AI 说（如「把你在示例群的名片改成示例名片」）→ 直接执行；
- 在**群里或别的会话**里说 → AI 只发起，桥接把确认卡发到你私聊，你回「通过 #12」才执行；
- 确认、过期、执行结果都只出现在你的私聊，群里看不到；
- 支持 `setGroupCard` / `setQqProfile` / `setQqAvatar`，群名与群头像需在 `config.json` 的 `adminOps.actions` 里显式开启；
- 网关实测：名片（非空）/ 昵称 / 头像都可用；**清空名片会被拒**（OIDB 1007，需要群管理权限）。
- 完整说明与排查见 [guides/ADMIN_OPS.md](docs/guides/ADMIN_OPS.md)。

**途径 B：DSH WebUI**：
- 在 GUI 会话里对我说「给 QQ 机器人设置角色：傲娇助手」/「清除角色」/「开启静默模式」，我写 `state/current-role.json`
- 或手动编辑 `qq-bridge/state/current-role.json`：
  ```json
  {
    "role": "傲娇助手",              // 默认人格
    "mode": "active",                // active=正常, silent=静默
    "byKey": {                       // 可选：按会话覆盖默认人格
      "group:123456789": "傲娇助手",
      "private:1000000001": "小鲸鱼"
    }
  }
  ```
  按会话指定人格推荐用控制台「人格与角色」页（`http://127.0.0.1:3100/#persona`）：默认人格 + 列表选择，支持改名/删除时自动跟随。
- 角色文件放 `qq-bridge/roles/<角色名>.md`（格式见 `roles/README.md`）

### 查看 QQ 活动

- WebUI 里直接打开「QQ 聊天」工作区的会话，可完整查看每次交互（含工具调用）
- 桥接还会把每次收发写入 `qq-bridge/state/qq-activity.log`（最近 500 行），GUI 会话的 agent 可读取汇报

### 在 WebUI 与 QQ 机器人对话

打开「QQ 聊天」工作区里的会话即可直接对话（DSH 原生）。`reserved2` 不自动转发 agent 文本，但工具可以发送 QQ；`chat`、`reserved` 和 `closed-agent` 会转发映射会话的 agent 回合输出，因此在这些会话中从 DSH 界面输入内容，也可能使回复出现在 QQ。需要纯本地讨论时请使用没有 QQ 映射的 DSH 会话。

## 事故与兜底

- 群友诱导 agent 时，preset 的工具限制和目标白名单是主要硬边界。发送工具仍可能造成白名单内的误发；敏感信息正则属于启发式审计，不能识别任意秘密或保证“最多只发一条”。账号和会话隔离仍需结合实际运行模式使用。
- 想彻底关闭机器人：停止桥接进程（start.bat 窗口 Ctrl+C）或 SnowLuma。
- 修改白名单/角色/owner 后保存即热更新（控制台写入 config.json / state/*.json 后即时生效）；修改 preset（权威源在 `dsh/agent-presets/`，改完跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）后重启 DSH 生效。
- ⚠️ 桥接只能运行一个实例：消息异常时先检查任务管理器里是否有多余的 `node ...bridge.js`。
