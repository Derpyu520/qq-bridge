# 三代仿真（Gen3 / `reserved3`）设计说明

面向要读懂 V3、或准备做 code review 的开发者。本文只写代码里能验证的行为；"代码分支"指 `src/bridge.js`
里真实存在的判断，仅改提示词、仅改默认值的会单独注明。

## 1. 一句话定位

`reserved3`（三代仿真）不是新引擎，而是**同一套社交内核 + 一份独立配置档 + 一套独立 preset**：

- 社交引擎、状态文件、工具面全部与二代共用；`isSocialMode()` 同时接受 `reserved2` 与 `reserved3`。
- 三代自己的东西只有三样：`socialV3` 配置档（只覆盖五个子块）、`qq-chat-v3` preset、模式级别标签
  （唤醒提示自称"三代"、日志前缀 `[reserved3]`、preset 解析）。
- `reserved2` 原样保留，两条模式是**并行**关系；切换只改变配置来源与 preset，不改变代码路径。

所以"三代比二代多了什么"要分三层答：**提示词层差异最大，配置默认值层几乎没有差异，代码分支层很少**
（配置来源、preset、模式标签）。

## 2. 与二代的分工

### 2.1 代码层差异（全部实证）

| 项 | `reserved2` | `reserved3` | 代码位置 |
| --- | --- | --- | --- |
| 是否走社交引擎 | 是 | 是 | `isSocialMode()`：两者皆真 |
| 生效配置对象 | `cfg.socialV2Base` | `effectiveSocialV3Config()` | `applySocialConfigForMode()` |
| DSH preset | `socialV2.agentPreset`（默认 `qq-chat-v2`） | `socialV3.gen3Preset`（默认 `qq-chat-v3`） | `modePreset()` |
| preset 不可用 | 拒绝建会话 | 拒绝建会话 | `resolvePresetName(..., {strict:true})` |
| 唤醒提示代际自称 | 二代 | 三代 | `socialGenLabel()` |
| 日志前缀 | `[reserved2]` | `[reserved3]` | `socialLogTag()` |
| 社交状态文件 | `state/social-v2.json` | 同一个文件 | `SOCIAL_V2_FILE` |
| 工具开关表 | `socialV2.tools` | `socialV3.tools` 覆盖 | `effectiveSocialV3Config()` |
| 控制台写配置 | `POST /api/socialV2/config` | `POST /api/socialV3/config` | 两个独立端点 |

三代**没有**独立的社交状态、消息缓冲、额度计数，也没有"三代专属工具"。`qq_context`、人物卡、摘要、
回复判断、延迟与分条这些常被当成"三代能力"的东西都在共享内核里，二代的配置默认值也一样（见 §7.4）；
差别在三代 preset 明确要求模型使用它们。

### 2.2 preset 层差异（提示词，不是代码）

`dsh/agent-presets/qq-chat-v3/agent.cordis.yml` 相对 v2 的实际改动：

| 位置 | 二代 | 三代 |
| --- | --- | --- |
| 开场身份 | `You are a coding agent ...` | `You are a QQ group member ...` |
| 安全规则第 5 条 | 写死默认角色形象 | 改为"角色由人格卡决定"，不冒充其它模型 |
| 工具协议第 5 条 | "能接就接、能聊就聊，不要聊两句就潜水" | "按人格卡行为合同决定接不接" |
| 冲突裁决 | 无 | 新增：安全 > 情境 > 人格稳定特征 > 表达风格；行为合同优先 |
| 能力条目 | 18/19 两条（资料、空间） | 18~24 七条：上下文、动作、文件、改口、P1、资料、空间 |
| 收尾段 | 固定 `timeoutMs=300000` | 以唤醒提示给的值和 `canSleepNow` 为准，点名"30/60/180 秒不算观察" |
| 单条长度 | "单条尽量短" | 追加"行为合同有更具体长度时以合同为准" |

注意：三代**没有** `〔三代〕` 人格卡标记。`roleHintForMode('v2', ...)` 被两代共用，所以人格卡里标成
`〔二代〕` 的小节在 `reserved3` 下同样注入（`src/role-card.js` 只认 v1/v2）。

## 3. 如何启用

前置：preset 必须先装进 DSH，否则建会话会被拒绝（fail-closed）。

1. 运行 `node scripts/setup-dsh.mjs`：从 `dsh/agent-presets/qq-chat-v3/` 重新生成
   `plugins/qq-agent-presets/presets/qq-chat-v3.patch.yml`，并注册 `qq-agent-presets` bundle。
   patch 是生成物，不要手改。
2. 重启 DSH（preset 由 DSH 在启动时装配）。

| 入口 | 做法 | 备注 |
| --- | --- | --- |
| 控制台 | 顶栏模式切到 `reserved3` | 同时写 `state/mode.json` 与 DSH settings |
| 本地文件 | `state/mode.json` 写 `{"mode":"reserved3"}` | DSH 不可用时的兜底 |
| DSH settings | `qq-mode` 命名空间的 `mode` | 插件 `plugins/qq-mode-console` 提供，无 WebUI 卡片 |

优先级：DSH settings 的 `qq-mode.mode` 优先，读不到才回落 `state/mode.json`（`refreshMode()`）。控制台切换
时若写穿失败，只写本地，并在日志注明"下次轮询会覆盖回滚"。模式归一入口是 `MODE_INPUT_ALIASES`：
`simulation` 归一成 `reserved2`，`reserved3` 没有别名。验证：日志前缀变 `[reserved3]`、引导唤醒写着
"当前是三代仿真模式"、会话创建日志里的 preset 是 `qq-chat-v3`。

## 4. 运行时分层

### 4.1 感知

入口 `handleIncoming()`。管理员私聊（`ownerQQ`）即使不在白名单也能进——树干与 `/branches` 依赖这一点；
其余会话按当前模式的白名单判定。斜杠命令在进模型前就被桥接消费掉（`/reset`、`/mute`、`/branches`、
`/summary` 等，仅 owner）。

唤醒触发顺序（`evaluateWakeTriggerV2()`）：静音 → 私聊 → `anyMessage` → `atMention` → `nameMention`
（只看本条文字，不含引用原文）→ `keywords`（短英文/数字词走词边界，避免 `DS` 命中 `ADS`）→ `question`
（须指向机器人）→ `speakerIds` → `probability`。

`@` 分三档（`classifyAtMentionV2()`）：owner、催问、提问、引用自己是 `summon`；其余 `social`；@全体或
一次 @ 多人是 `mass`。`mass` **不唤醒**，消息留在未读等下一次自然唤醒；`social` 额外叠
`decision.socialMentionDelayMs`（默认 30000ms）再合批。缓冲：未读 `context.unreadLimit`（默认 30）、
最近 `context.recentLimit`（默认 100）；媒体视图优先给本地句柄，正常消息不带传输 URL。`readThroughSeqV2()`
只推进"确实交给过模型"的 seq，快照被预算截断时返回 `partial: true`，模型须用 `afterSeq` 续读。时间感由
`buildTimeSenseLine()` 按 `socialV2.wake.staleChatMinutes`（10）/`staleSilentMinutes`（120）分档。

### 4.2 记忆与关系

**会话状态**（`state/social-v2.json`，按 `group:123456789` / `private:1000000001` 这类 key 存）：未读、
最近消息、唤醒配置、发送/唤醒时间戳、人物卡、轻量记忆、已读水位、`roleCardFp`；合批/潜水定时器只在内存。

**人物卡**：称呼、关系档位、熟悉度/亲近度/信任、事实（带置信度）、互动片段、边界、互动次数、上次对话。
熟悉度增量：接着说 +2、被 @ +1、同一人连发 +0.2、普通发言 +0.5；档位只由"熟悉度 + 消息数"派生
（熟人 25/10、常客 5/3，见 `src/person-score.mjs`）。唤醒包只注入最近出现的最多 5 人，每人一行：
档位、熟悉度、互动次数、最近事实（置信度 <0.6 标"推测"）、边界、上次互动，以及称呼/语气/句数/表情
频率建议；行为合同里的关系语气可覆盖建议。

**轻量记忆**：`activeTopic`（24 小时未再提自动移除）、`pendingThought`（默认 2 小时过期）、
`memberImpression`（人物卡为空时的降级展示）。

**摘要**（双轨）：规则版 `buildDigestV2()` 在 `context.digestWindowMs`（6 小时）窗口内统计条数/人数/
话题/提到你/提问/最后一条，压到 `digestMaxChars`（600）；LLM 版 `runDigestSummaryV2()` 异步跑，
要求 150~300 字，每 `digestEveryMessages`（20）条或 `digestEveryMs`（10 分钟）触发一次，单次 90 秒超时，
写 `state/digests.json`（最多 200 个会话、单条 1000 字），有效期 `max(2 × window, 2 小时)`，过期回落规则版。
摘要器复用"黑话学习"那条长期 DSH 会话，人格切换时作废重建。`bootstrap` 唤醒额外注入一次上次落盘摘要
（`digestRecapMaxChars`，800）。

**树干只读视图**：owner 私聊里 `/branches`（按最后活跃排序，最多 15 行）与 `/summary <群名或群号> [小时数]`
（最多 8 条原文 + 状态）。只读、不经过模型、不建立分叉——没有"树枝会话"这种对象。

### 4.3 判断与预算

唤醒包的【回复判断】由 `replyPressureV2()` 算出，是可解释的分数而非硬规则：

| 因素 | 变化 |
| --- | --- |
| 基础分 | 0.15 |
| 最近一条来自 owner | +0.35 |
| 直接点名/提问/引用自己 | +0.30 |
| 最新消息已超过 30 分钟 | -0.20 |
| 10 分钟内已发 ≥3 条 | -0.15 |
| 刚说过话（<60 秒） | -0.15 |
| 3 人以上在聊且没直接叫你 | -0.10 |
| 连续 ≥2 条机器人消息没人接 | -0.10 |

阈值来自 `decision.highPressure`（0.6）/`mediumPressure`（0.35），分高/中/低并给出建议条数（高 1~2、中 0~2、
低 0~1）。两条兜底不能省：文本命中"你怎么不回/第二个问题/你倒是"等追问，或 `direct && 纯标点 &&
10 分钟内说过话`，分数强制抬到 `high + 0.05`；私聊里 owner 的普通消息抬到 `medium + 0.05`，避免 1v1
被当成群聊的"允许不回"。

额度两层（`checkSendQuotaV2()` / `checkWakeQuotaV2()`）：分支级（2 小时/日）与全局（`quota.global`）。
发送按条数预占、失败回滚；唤醒默认 1/分钟、12/小时、10/2 小时、30/日，超限不丢事件，按 `retryAfterMs`
（封顶 60 秒）延后重试。`wake.noActionLimit`（3）次唤醒无动作会把唤醒配置重置成默认值——有意的兜底，
但会让"沉默题"评测不可比。每轮唤醒与每次发送都写 `state/decisions.jsonl`（`kind=wake|send`、`reason`、
`pressure.level`、`budget`、`delayMs`、`count`、`sentAt`），它是区分"选择不回"与"没被唤醒"的唯一依据。

### 4.4 表达与动作

发送不是"调完工具就发"，中间有一层 outbox：

- 首条延迟 `replyDelayMsV2()`：`600 + 字数 × 40 + 随机 400`，owner 在说话乘 0.75，23:00–08:00 乘 1.4，
  12 点/18 点乘 1.15，最后夹到 `[timing.minDelayMs, timing.maxDelayMs]`（默认 600~3000）。
- 正在输入：`timing.typingIndicator` 打开时发 OneBot `set_input_status`，**只对私聊**（群聊网关支持不稳定）。
- 分条间隔 `computeGapsV2()`：`auto` 按 `burstIntervalMin/Max` 并以 `longGapProbability` 抽长间隔；`fixed`
  用给定间隔；`byLength` 用 `gapBaseMs + 字数 × gapPerCharMs`；全部夹在 `[burstIntervalMinMs, maxGapMs]`。
- 硬上限：一次最多 `send.burstMaxMessages`（8）条、单条 `send.maxMessageChars`（500）字，出站再做一次
  敏感信息正则拦截；`timing.enabled=false` 时整层跳过。
- 发送成功后清 `noActionCount`；若当前没有其它待唤醒/潜水定时器，安排一次 `replyCheck`（基准
  `autoReplyCheckMs`，30 秒；问过问题 ×1.5，自己刚连发 ≥3 条 ×1.3）。

收尾只有两个动作：`qq_mark_read(throughSeq=…)` 或 `qq_set_wake_config(config, throughSeq)`（后者同时确认
已读）。沉睡前观察是独立闸门：只有**单次** `timeoutMs ≥ wake.preSleepWaitMs`（300000）的
`qq_wait_for_messages` 才算完成观察；等待工具直接返回 `canSleepNow`、`countsAsObservation`、`hint`
（还差多少秒），模型不必猜。参与回复后，下次收尾要重新观察。`qq_wait_for_messages` 有两种用途：
`purpose="reply"` 按最后来信补静默、读取与思考时间也计入；`purpose="messages"` 等新消息再按静默窗口收束。
收到新消息后至少再等 `wait.minQuietAfterNewMs`（10 秒）。同一会话只允许一个等待（租约 15 分钟）。

## 5. 上下文与 token

**唤醒包**（`buildWakePromptV2()`）按固定顺序拼装，每段都有出现条件：

角色卡（仅指纹变化时注入整张）→ 行为合同 → 自身身份 → 跨会话委派 → 会话令牌 → 操作者初始提示
（仅首次）→ 重置前摘要（仅 bootstrap）→ 反 AI 味 → 别拿系统当借口 → 积极性 → 表情策略 → 首回复节奏 →
此刻状态 → 摘要 → 记人提示 → 回复判断 → 当前唤醒 → 轻量记忆 → 参与度参考 → 沉睡前等待 → 时间感 →
【唤醒】原因与行动指令。

**唤醒快照**（`buildWakeSnapshotV2()`）：未读从最旧开始给、最近消息去重后补，共用一份预算
`context.wakeMaxChars`（默认 6000，夹 500~20000）；带 `now`、`newestAgo`、`unreadCount`、`readThroughSeq`、
`partial`。任一读取工具关掉时对应缓冲直接不进快照。

**一次取齐**（`qq_context` → `GET /api/socialV2/context`）返回 `digest`（规则摘要 + 落盘文本与时间）、
`snapshot`、`memory`（进行中话题/想说未说/在场的人）、`wake`（模式、是否无限期、触发条件、静音）、
`quota`（分支与全局的 2 小时/日用量）、`now`、`hint`。它受各段自身上限约束，没有额外的总预算裁剪。

**预算与降级**：`maxWakePromptChars`（默认 12000）由 `trimWakePromptV2()` 按固定顺序逐段删：上次会话
摘要 → 最近摘要 → LLM 摘要 → 在场的人 → 进行中的话题 → 想说未说的 → 对群友的印象 → 参与度参考 →
时间感；删完仍超长才硬截断。角色卡另有 `role.maxInjectChars`（1000~20000）独立上限，且先按模式过滤
小节再截断，避免另一模式的内容白占预算。

## 6. 工具面

**注册期过滤**：MCP server 在模块加载时读 `config.json` 的 `socialV2.tools`，值为 `false` 的工具
**根本不注册**（省下每次请求的 schema token），改开关必须重启 DSH。两个后果必须知道：

- 过滤只看 `socialV2.tools`，不看 `socialV3.tools`。所以三代页关掉的工具仍会出现在模型清单里，
  只是调用时被桥接 403。
- 反之，某工具在 `socialV2.tools` 里是 `false`、只在 `socialV3.tools` 里打开，它不会注册，三代也用不了。

在 `reserved2`/`reserved3` 下可用、常被误认为"三代专属"的工具：

| 工具 | 开关默认 | 额外闸门 |
| --- | --- | --- |
| `qq_context` | 开 | 会话令牌 |
| `qq_person_get` / `qq_person_note` / `qq_person_forget` | 开（`person`） | 只能操作本会话人物卡 |
| `qq_send_image` | 开 | 只认 `media/` 下的文件名，拒 URL/路径/base64 |
| `qq_react` | 开 | 最近 10 分钟最多 3 次 |
| `qq_transcribe_voice` / `qq_ocr_image` | 开 | 转写走网关 `fetch_ptt_text`；OCR 需图片仍在会话缓存 |
| `qq_recall` / `qq_revise_message` | 开 | 只能撤自己最近发的 |
| `qq_search_history` | 开 | 只在最近缓存里搜 |
| `qq_read_document` | 开（工具） | `document.enabled` 默认 **false**，默认报"文档阅读未开启" |
| `qq_get_user_profile` | 开 | 每会话 10 分钟配额；只能查本会话/本群出现过的人 |
| `qq_qzone_read` / `qq_qzone_post` | 开 | 发说说走 `botPerms.qzonePost`（默认"仅应要求"）+ 确认卡 + 频次上限 |
| `qq_delegate` | 无工具开关 | `botPerms.crossSessionDelegate`（默认 `request`）+ 每分钟 3 次 + 目标静音则拒 |
| `qq_admin` | 无工具开关 | `botPerms` 三档（不开放/仅应要求/人设自主）：直连、发确认卡或按人设否决 |
| `qq_group_sign` / `qq_like` / `qq_share_card` | **关** | 需管理员开启；签到/点赞每日一次 |
| `qq_send_voice` / `qq_list_voices` | **关** | 语音库未准备时报未启用属正常 |

发送与收尾：`qq_send_message`（字符串=一条，数组=多条；`gapMode`/`gapMs`/`gaps`）、`qq_reply`、
`qq_send_burst`、`qq_send_group_message`/`qq_send_private_message`（跨模式共用，不受 v2 开关过滤，由桥接
调用期校验）、`qq_mark_read`、`qq_set_wake_config`、`qq_wait_for_messages`。

## 7. 配置

### 7.1 生效公式

```
effectiveSocialV3Config() = clone(socialV2 基线)
                          + { enabled, gen3Preset, tools, timing, decision, context, document }
```

`applySocialConfigForMode('reserved3')` 把 `cfg.socialV2` 指向这份结果——**社交引擎读的永远是
`cfg.socialV2`**，三代只是换了这个对象的来源。

### 7.2 只有五个子块生效（最容易踩的坑）

`socialV3` 只覆盖 **`tools` / `timing` / `decision` / `context` / `document`**。下面这些**永远读 `socialV2`
基线**，写在 `socialV3` 里没有任何效果：`send`、`wake`、`quota`、`sticker`、`proactive`、`wait`、`media`、
`profile`、`qzone`、`feedback`、`initialPromptMaxChars`、`agentPreset`、`autoReplyCheckMs`。

具体后果：

- 发送/唤醒限额改不动。要调频次得改二代页的 `socialV2.send`/`socialV2.wake`/`socialV2.quota`；这是两代
  共享的硬闸门，回归里有断言"三代继承二代发送额度"。
- `socialV3.proactive` 是不生效的旧键。主动概率仍在二代页 `socialV2.proactive.probability`（内部还叠加
  会话级 `proactiveDelta` 与四道乘数）。
- 时间感阈值（`socialV2.wake.staleChatMinutes`/`staleSilentMinutes`）与合批窗口（`socialV2.wake.batchWindowMs`、
  会话级 `wakeConfig.batchWindowMs`）也在二代侧。

唯一例外：`privateBatchWindowMs()` 直接读 `config.json` 的 `socialV3.wake.privateBatchWindowMs`（默认 1500，
夹 500~60000，`0` = 关闭；控制台没有输入项），绕过 effective 配置。只对 `private:*` 生效，且**不判断当前
模式**——`reserved2` 下同样生效。早期说明常把它写成"三代专属"，实现上不是。

### 7.3 控制台行为

三代页（`section-social-v3`）从二代表单克隆，保存时只提交上述 7 个键到 `POST /api/socialV3/config`，
端点也只接受这 7 个键。但写入的是"合并后的整份对象"：首次启动时 `socialV3` 由 `socialV2` 克隆而来，
所以落盘内容会带一批从二代复制来的 `wake`/`send`/`quota` 等键；它们进文件，但运行时仍不生效（见 §7.2）。

影子效应：首次克隆时 `tools`/`timing`/`decision`/`context`/`document` 被快照进 `socialV3`，之后在**二代页**
改这五项，三代模式看不到（被 profile 覆盖）。要改三代的这五项必须用三代页；要改两代共用的发送/唤醒
额度只能改二代页。

### 7.4 推荐值

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `timing.enabled` / `minDelayMs` / `maxDelayMs` | true / 600 / 3000 | 首条延迟；关掉退化成"调完即发" |
| `timing.typingIndicator` | true | 仅私聊可见 |
| `decision.socialMentionDelayMs` | 30000 | `social` 类 @ 的额外等待 |
| `decision.highPressure` / `mediumPressure` | 0.6 / 0.35 | 压力分档阈值 |
| `context.digestEnabled` / `inlineWakeMessages` | true / true | 关掉后摘要段/快照整体消失 |
| `context.wakeMaxChars` / `maxWakePromptChars` | 6000 / 12000 | 快照预算 / 唤醒包硬上限 |
| `context.wakeMessageLimit` / `wakeRecentLimit` | 12 / 4 | 快照条数 |
| `context.unreadLimit` / `recentLimit` | 30 / 100 | 缓冲条数 |
| `context.digestMaxChars` / `digestSummaryMaxChars` | 600 / 500 | 规则摘要 / LLM 摘要长度 |
| `role.maxInjectChars` | 1000~20000 | 人格卡注入上限 |
| `document.enabled` | false | 文档阅读默认关 |
| `wake.privateBatchWindowMs` | 1500 | 只影响私聊合批，两代共用 |

首次生成 `socialV3` 时代码显式写入 `timing`（0.6~3 秒 + 正在输入）、`decision.socialMentionDelayMs=30000`、
`context.digestEnabled/inlineWakeMessages/wakeRecentLimit=4`。这些值与 `socialV2` 默认值**相同**，所以默认
参数下两代的**引擎参数**一致，差异主要来自 preset（§2.2）。

## 8. 兼容与回退

切回二代：控制台把模式改回 `reserved2`，或把 `state/mode.json` 写成 `{"mode":"reserved2"}`。`socialV3`
配置留在 `config.json` 里，不影响二代运行。

**共用、切换不删**：`state/social-v2.json`（会话状态、人物卡、轻量记忆、唤醒配置、额度时间戳）、
`state/digests.json`、`state/decisions.jsonl`、`state/current-role.json`、`roles/`。

| 切换时失效的对象 | 原因 |
| --- | --- |
| 该会话的 DSH 会话 | `sessionPolicy()` 把模式与 preset 纳入键，模式一变即不等，`reconcileSessionPolicies()` 退役旧会话 |
| `agentToken` | 退役路径换新令牌，旧令牌保留在脱敏集合但撤销权限 |
| 内存定时器 / outbox / 等待 | 离开仿真模式时清空社交定时器并排空投递队列；进入时重建有限潜水与主动检查 |
| `modelSeenSeqs` | 只在内存，重新投递后需重新读取 |

退役判定在 `dshPresetIds` 为空时**跳过**，否则一次 preset 清单抖动会把所有会话集体退役。

人格切换是另一条清空路径（`/api/role` 且生效人格变化时触发 `resetPersonaContextV2()`）：清空该会话的
摘要、最近消息、未读、`roleCardFp`、进行中话题、未说出口的话、群友印象，以及人物卡的互动片段，但保留
事实与边界；同时退役旧 DSH 会话，避免新人格沿用旧上下文。

## 9. 已知边界

- 正在输入、群成员信息、状态查询依赖 SnowLuma / OneBot 的具体 action；网关不实现或平台不支持时，
  `set_input_status` 之类失败被静默吞掉，表现为"没有正在输入"，不影响发送。群聊不做正在输入。
- 语音默认关闭（`tools.sendVoice=false`），文档阅读默认关闭（`document.enabled=false`）；转写/OCR 的
  实际可用性取决于网关能力。
- LLM 摘要依赖 DSH 可用；失败只记日志并降级到规则摘要，不阻塞唤醒。
- 会话树只有只读视图（`/branches`、`/summary`），没有独立分支会话，也没有跨分支写操作。
- 两代共用同一份发送/唤醒额度、未读缓冲与已读水位：在 A 模式花掉的额度，切到 B 模式不会重置。
- 群聊 @全体不唤醒；管理命令与树干视图只在 owner 私聊可用。
- 改 preset 内容后必须重跑 `setup-dsh.mjs` 并重启 DSH，否则 DSH 里仍是旧提示词。

## 10. 怎么验（评测口径）

见 `docs/guides/GEN3_CHAT_PERSONA_EVAL.md`。做 A/B（`reserved2` vs `reserved3`）前先固定并记录三件事，
否则结论不可复现：配置快照（`batchWindowMs`、`timing`、唤醒配额、工具开关、当前人格卡行为合同）；
起点水位（`state/decisions.jsonl` 最后一行时间）；环境阻断（`noActionLimit` 是否触发过重置、是否根本没
被唤醒）。

关键指标：首条延迟中位数（`sentAt` − 最后来信时间）、连发条数（`count`）、单条字数、Markdown 泄漏、
复读率，以及每个"未回"是否有对应的 wake 记录。取数示例（仓库根目录执行）：
`Get-Content state/decisions.jsonl -Tail 50`。

## 11. 代码索引

| 文件 | 关键符号 | 作用 |
| --- | --- | --- |
| `src/bridge.js` | `MODE_INPUT_ALIASES` / `normalizeModeInput()` | 模式拼写归一 |
| `src/bridge.js` | `effectiveSocialV3Config()` / `applySocialConfigForMode()` | 三代配置合成与切换 |
| `src/bridge.js` | `isSocialMode()` / `socialGenLabel()` / `socialLogTag()` | 两代共用的模式判定与标签 |
| `src/bridge.js` | `modePreset()` / `resolvePresetName()` | preset 解析与 fail-closed |
| `src/bridge.js` | `handleIncoming()` / `evaluateWakeTriggerV2()` / `classifyAtMentionV2()` | 感知与唤醒触发 |
| `src/bridge.js` | `buildWakeSnapshotV2()` / `buildWakePromptV2()` / `trimWakePromptV2()` | 快照、唤醒包与预算裁剪 |
| `src/bridge.js` | `replyPressureV2()` / `checkSendQuotaV2()` / `checkWakeQuotaV2()` | 回复判断与额度 |
| `src/bridge.js` | `replyDelayMsV2()` / `computeGapsV2()` / `enqueueOutboxV2()` / `setTypingV2()` | 延迟、分条、正在输入 |
| `src/bridge.js` | `buildDigestV2()` / `runDigestSummaryV2()` | 规则摘要与 LLM 摘要 |
| `src/bridge.js` | `formatPeopleV2()` / `formatMemoryV2()` / `resetPersonaContextV2()` | 记忆注入与换卡清上下文 |
| `src/bridge.js` | `privateBatchWindowMs()` / `scheduleWakeV2()` | 合批与唤醒调度 |
| `src/bridge.js` | `buildBranchOverviewText()` / `buildBranchSummaryText()` | 树干只读视图 |
| `src/person-score.mjs` | `relationTier()` / `familiarityDelta()` | 关系档位与熟悉度 |
| `src/role-card.js` | `selectRoleText()` / `parseBehaviorContract()` | 人格卡分模式与行为合同解析 |
| `src/bot-perms.mjs` | `BOT_PERM_ROWS` / `scopeOf()` | 机器人自主操作三档 |
| `src/mcp-snowluma-safe.js` | `TOOL_CONFIG_FLAGS` / 注册过滤器 / `qq_context` | 注册期开关与一次取齐 |
| `dsh/agent-presets/qq-chat-v3/` | `preset.yml` / `agent.cordis.yml` | 三代 preset 源（生成 patch 的输入） |
| `public/console.html` | `loadV3Config()` / `saveV3Config()` | 三代页读写 |
| `scripts/test-audit-regressions.mjs` | R31 / R34 / R35 / R39 / R40 / R41 | 三代模式相关回归 |
