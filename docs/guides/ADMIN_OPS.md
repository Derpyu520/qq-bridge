# 管理员动作：用 QQ 指挥 AI 改名片 / 资料 / 头像

> 一句话：**你（ownerQQ）刚在私聊里说一句就执行；在群里或别的会话里说，只会变成一张确认卡发到你私聊，你回「通过」才动手。**
> 管理员身份只按**发消息的 QQ 号**判定，不看是哪个会话——私聊里如果最近一条不是你发的（或已超过 5 分钟），同样走确认卡。

---

## 1. 支持的动作

| 动作 | 作用对象 | 第一批默认 | 说明 |
| --- | --- | --- | --- |
| `setGroupCard` | 机器人在某个群的名片 | ✅ | 最多 30 字；空字符串=清除，但**这张网关会拒绝清空**（见 §6） |
| `setQqProfile` | 机器人 QQ 的昵称 / 个性签名 | ✅ | 昵称最多 36 字，签名最多 100 字 |
| `setQqAvatar` | 机器人 QQ 头像 | ✅ | 只接受 `assets/` 里的图片；文件名可先用 `qq_list_assets` 查，带不带 `assets/` 前缀都行 |
| `recallMessage` | 撤回机器人自己发的消息 | ✅ | 只允许撤自己发的（先 `get_msg` 验发送者），碰不到别人的消息 |
| `setOnlineStatus` | 在线状态 | ✅ | `online / away / invisible / busy / qme / dnd`（码值按 Lagrange 枚举，仅 `online` 经实机验证） |
| `postQzone` | 发一条 QQ 空间说说 | ✅ | 走同一条队列：owner 要求直连，其他人要求发确认卡；图片只认 `media/` 文件名，另有每小时/每天上限、同内容不重复、发完回读校验。详见 [QQ_PROFILE_QZONE.md](QQ_PROFILE_QZONE.md) |
| `setGroupName` | 群名 | ❌ 需显式开启 | 需要群主权限 |
| `setGroupPortrait` | 群头像 | ❌ 需显式开启 | 需要群主权限 |

群名 / 群头像默认**不开**：影响整个群、且要群主权限。要开就在 `config.json` 的 `adminOps.actions` 里加上。

## 2. 两条通道

### 通道 A：管理员本人私聊 = 直连

```text
你（私聊）：把你在「示例群」的名片改成「示例名片」
AI：改好了，示例群那边现在叫「示例名片」
```

立即生效，群里不出现任何系统提示。桥接会写一条审计（改前值 + 结果）。
前提是这条请求由**你刚发的那条消息**触发（5 分钟内、发送者 QQ 号 = ownerQQ）；
从 DSH 界面直接往那个会话里打字、或消息已经过期时，不会直连（按通道 B 走确认）。

### 通道 B：群 / 其它会话 = 私聊确认

```text
你（群里）：@小鲸鱼 把你的名片改成「示例名片」
AI：这个得管理员点头，我去问一下。

—— 你的私聊 ——
🔧 操作确认 #12（10 分钟内有效）
来自：群 123456781「示例群」
动作：改群名片 → 「示例名片」（群 123456781）
回复「通过」执行，「拒绝」取消

你：通过
—— 你的私聊 ——
✅ #12 已执行：改群名片 → 「示例名片」（群 123456781）
```

- 有多个待确认时必须带编号：`通过 #12`、`#12 通过`、`12 拒绝` 都认。
- 同一会话同时挂着 DSH 审批和操作确认时，也强制带编号，避免「通过」被两条流程抢答。
- 10 分钟不处理自动过期，私聊里会收到 `⏰ 操作 #12 已过期`。
- **群里不会补一句"改好了"**：管理动作对群友完全隐形。

### 通道 C：快捷命令（桥接直连，不依赖 DSH / 模型）

`qq_admin` 工具要等 **DSH 重启**才会出现在 AI 的工具清单里；命令是 owner 亲手敲的，桥接直接执行，
**改完桥接就生效**，也是 `closed-agent`（模型没有会话令牌）下的唯一入口：

```text
/card 示例名片        # 在群里：改机器人在**本群**的名片
/card 123456781 示例名片   # 任意会话：改指定白名单群的名片
/card -               # 清空名片（这张网关会拒，见 §6）
/nick 小鲸鱼          # 改 QQ 昵称（账号级）
/sign 在群里摸鱼       # 改个性签名；/sign - 清空
/avatar deepseek娘.png # 改 QQ 头像（只认 assets/ 下的文件名）
/undo                 # 还原上一条可逆动作
```

- 只认 `ownerQQ` 发的消息；群友发 `/card` 会被拦成「管理命令仅管理员可用」。
- **账号级命令（`/nick` `/sign` `/avatar`）只在私聊执行**：在群里发会被要求"去私聊"，避免回执把管理动作暴露给群友。`/card` 例外——它本来就改在群里。
- 命令同样走动作白名单、频率上限与审计（`actor=owner-command`）。

### 撤销

```text
你：/undo
AI/桥接：↩️ 已还原：改群名片 → 「旧名片」
```

`/undo` 由桥接直接执行，不经过模型。只支持「改前值确实读到过」的动作：名片、群名、昵称、头像。
只改了签名、或当时读不到旧名片/旧群名时，`/undo` 会跳过这条（而不是拿空值把资料清掉）。
头像的撤销依赖网关接受 QQ 官方图床的 URL（`https://q.qlogo.cn/...`）；网关不认时只能手动换回，审计里保留了原图地址。

### 换头像：先看目录，再按外观挑（`qq_list_assets` / `qq_view_asset`）

`assets/` 里的文件名经常是 QQ 下载的哈希（`2153….png`）。模型没有文件工具、看不到目录，
只说“白毛那张”时只能猜，实测会连续猜错。所以给了两个**只读**工具：

| 工具 | 作用 | 限制 |
| --- | --- | --- |
| `qq_list_assets` | 列出 `mediaDir` 第一层的图片：文件名 + 大小 | 仅管理员私聊；不递归、不读内容；最多 100 条 |
| `qq_view_asset` | 把某张图作为图像返回给模型，用于按外观挑 | 仅管理员私聊；只能传 `qq_list_assets` 返回的名字；单张 ≤2MB；每分钟最多 10 张 |

模型该这样用：先 `qq_list_assets`，名字对得上就直接
`qq_admin(setQqAvatar, file="白毛.png")`；对不上（“白毛那张”“蓝头发那个”）再
`qq_view_asset` 逐张看，最多 3 张就做决定。

它们**不是文件浏览器**：入参是文件名而不是路径，出现 `/`、`\`、`..`、盘符或冒号一律拒绝；
`realpath` 必须仍在 `mediaDir` 内（防 junction/符号链接逃逸）；文件内容必须命中 png/jpeg/webp/gif
的 magic bytes（把 `.txt` 改成 `.png` 骗不过去）；列表与查看都只碰 `mediaDir` 第一层。

## 3. 配置（`config.json`）

```json
"adminOps": {
  "enabled": true,
  "actions": ["setGroupCard", "setQqProfile", "setQqAvatar"],
  "confirmTimeoutMs": 600000,
  "maxPerMinute": 3,
  "maxPending": 5,
  "vetoProbability": 0.05,
  "mediaDir": "assets",
  "assetView": { "enabled": true, "allow": [] }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；未配置 `ownerQQ` 时自动不可用 |
| `actions` | 名片/资料/头像 | 动作白名单，写错名字会被忽略并在日志里提示 |
| `confirmTimeoutMs` | 600000 | 确认卡有效期（1~60 分钟） |
| `maxPerMinute` | 3 | 每分钟最多提交几次（防模型循环改头像） |
| `maxPending` | 5 | 同时挂着的待确认上限 |
| `vetoProbability` | 0.05 | 「人设自主」档下管理员要求被驳回的兜底概率；人格卡「反驳主人」优先 |
| `mediaDir` | `assets` | 头像图片目录；必须在仓库内，否则回退 `assets/` |
| `assetView.enabled` | `true` | 是否允许 `qq_list_assets` / `qq_view_asset`；关掉后这两个工具不注册、端点也拒绝 |
| `assetView.allow` | `[]` | 非空时只允许查看名单里的文件名（大小写不敏感）；适合目录里还放了别的图的情况 |

## 4. 安全边界

1. **授权只看会话与令牌，不看模型说什么**：`/api/admin/op` 必须带本会话的 `x-agent-token`，且令牌与 `key` 绑定。别的会话拿不到你私聊的令牌，所以伪造 `private:<你的QQ>` 不会成立。
2. **无令牌一律拒绝**：没有会话令牌的智能体调用（例如 `closed-agent` 里的模型）不能执行管理员动作。该模式目前只能用 `/undo` 这类桥接命令；需要 AI 代改请在 `reserved2` 下私聊。
3. **群友无法消费确认**：确认只在 `private:<ownerQQ>` 里、且消息发送者等于 `ownerQQ` 时才处理。
4. **目标群必须在白名单**：空名单不放行（`allowAllWhenEmpty` 对管理员动作无效）。
5. **头像只能是 `assets/` 下的图片**：拒绝绝对路径、`..`、URL、base64、非图片扩展名、超过 10MB。
6. **频率上限 + 全量审计**：`state/admin-ops.json` 保留最近 100 条（动作、目标、改前值、结果、发起者）。
7. **头像预览守同一条边界**：`/api/admin/assets`（列表）与 `/api/admin/asset`（看图）必须带本会话令牌、
   必须命中当前模式准入，**并且只对管理员本人开放**（`sessionSenderIsOwner`，群会话一律 403）。
   列表每分钟 30 次、看图每分钟 10 次；单张还要过 6400 万像素上限（防“2MB 的像素炸弹”）；
   两类调用都写 `state/qq-activity.log` 审计。

## 5. 审计文件

`state/admin-ops.json`：

```json
{
  "ops": [
    {
      "ts": "2026-01-01T00:00:00.000Z",
      "id": 12,
      "action": "setGroupCard",
      "args": { "groupId": "123456781", "card": "示例名片" },
      "originKey": "group:123456781",
      "actor": "owner-confirm",
      "ok": true,
      "before": { "groupId": "123456781", "card": "旧名片" },
      "after": "示例名片"
    }
  ]
}
```

`actor` 取值：`owner-direct`（私聊直连）/ `owner-confirm`（确认后执行）/ `owner-reject` / `expired` / `undo` / `owner-command`（QQ 快捷命令）。

## 6. 网关实测结果（SnowLuma 1.14.x）

| 动作 | 结果 | 证据 |
| --- | --- | --- |
| `set_group_card`（设非空名片） | ✅ 可用 | 群 A：`旧名片` → `测试名片` → 回读一致 → 还原 `旧名片`；群 B 同样通过 |
| `set_group_card`（清空名片 `card=""`） | ❌ 被拒 | `retcode=100 OIDB error 1007 on 0x8fc_3`，通常需要群管理权限。桥接会把它翻译成可读提示 |
| `set_qq_profile`（改昵称） | ✅ 可用 | `原昵称` → `原昵称·探针` → 群成员列表/`get_stranger_info` 都读到新值 → 还原成功 |
| `set_qq_avatar`（本地路径） | ✅ 可用 | 换成纯色探针图后 qlogo CDN 哈希在 11s 内变化；换回原图 1s 内恢复 |
| `set_qq_avatar`（`https://` URL） | ✅ 接受 | 用 `q.qlogo.cn/...` 还原返回 ok（`loadBinarySource` 支持 http/base64/本地路径） |

两个反直觉的坑，已经写进代码注释：

1. **`get_login_info` 的昵称是登录时缓存的**：改完昵称它不会变。桥接读「改前昵称」改用 `get_stranger_info`，否则撤销会写回一个过期值。
2. **清空名片不是"设成空字符串"**：网关直接拒。`/card -` 与 `qq_admin(setGroupCard, card:"")` 都会失败并给出提示；想"看起来没名片"，填昵称即可。

复现探针：

```bash
node scripts/probe-admin-actions.mjs                  # 只读：列群 + 读当前名片/昵称
node scripts/probe-admin-actions.mjs --apply          # 名片：改 → 回读 → 还原
node scripts/probe-admin-actions.mjs --apply-profile  # 昵称：改 → 新鲜读 → 还原
node scripts/probe-admin-actions.mjs --apply-avatar   # 头像：换素材 → 用原图 URL 还原
```

## 7. 故障排查

| 现象 | 原因 |
| --- | --- |
| `管理员动作未启用（adminOps.enabled=false 或未配置 ownerQQ）` | 配置总开关或 `ownerQQ` 缺失 |
| `agent token 无效` | 工具调用没带令牌，或令牌与 `key` 不匹配（跨会话代发被关闭时也会走到这里） |
| `管理员没有开放「跨会话代发消息」` | 控制台「跨会话代发消息」是「不开放」；改成「仅应要求」即可由 owner 触发 |
| `persona_veto：…` | 「人设自主」档按人格卡「反驳主人」概率驳回了这次要求；不是故障，别重试，换个时机或换个说法再说 |
| `管理员动作必须在带会话令牌的会话里发起` | 当前是 `closed-agent` 等无令牌模式：用 `/card`、`/nick`、`/avatar` 命令 |
| `群 X 不在白名单（allow.groups）里` | 先把群加进白名单 |
| `不接受 URL / 绝对路径` | 头像图片要放进 `assets/` 再用相对路径 |
| `头像文件不存在` | 路径写错，或桥接进程看不到该文件；先 `qq_list_assets` 或 `GET /api/admin/assets` |
| `查看头像目录只允许管理员本人` | `qq_list_assets` / `qq_view_asset` 只能在 owner 私聊里调，群会话一律拒绝 |
| `这张图不在允许查看的名单里` | `adminOps.assetView.allow` 非空，但文件名不在里面 |
| `文件内容不是 png / jpg / webp / gif` | 扩展名对但内容不是图片（magic bytes 不匹配） |
| `清空群名片被网关拒绝（OIDB 1007…）` | 该群不允许清空名片；改填昵称 |
| `动作「setGroupName」未启用` | 在 `adminOps.actions` 里没开 |
| `操作太频繁` | 等一分钟，或调大 `maxPerMinute` |

## 8. 机器人自主操作（控制台「访问与安全」→ 机器人自主操作）

每项操作一个三档选择，按 **AI 的自主程度** 分档，保存到 `config.json` 的 `botPerms.scope`，**保存即生效**：

| 状态 | 含义 |
| --- | --- |
| `none`（界面「不开放」，默认） | 没有这个能力：调用一律拒绝，**不发确认卡**、不登记 pending |
| `request`（界面「仅应要求」） | 只有 **ownerQQ 本人刚说过话**（按发消息的 QQ 号判定，群聊/私聊都算，5 分钟 TTL）才直接执行；其他人的要求会发确认卡给 owner |
| `persona`（界面「人设自主」） | 它自己判断：可以**主动发起**；管理员的要求这时只是请求，按人格卡「反驳主人」的概率可能被驳回（`persona_veto`），驳回后同会话、同动作冷却 5 分钟 |

旧配置自动迁移：`off→none`、`owner→request`、`all→persona`（读配置时就归一，控制台顶部提示一次，点保存后写回新值）。
迁移注意两个方向：`off→none` 变**严**（以前还会发确认卡，现在直接没这个能力）；`all→persona` 变**宽**（以前只能"被要求后做"，现在可自主发起、也可能驳回你）。

可配置项（`src/bot-perms.mjs` 是唯一权威）：

| 键 | 默认 | 封顶 | 说明 |
| --- | --- | --- | --- |
| `setGroupCard` | none | persona | 改本群名片 |
| `setQqNickname` | none | request | 改 QQ 昵称（账号级） |
| `setQqSignature` | none | request | 改个性签名（账号级） |
| `setQqAvatar` | none | request | 改 QQ 头像（账号级，不可逆） |
| `recallOwnMessage` | none | persona | 撤回自己发的消息 |
| `setOnlineStatus` | none | request | 在线状态（含隐身，影响全局可见性） |
| `crossSessionSend` | **request** | request | 跨会话代发：在 A 会话让它去 B 会话发言；B 必须命中白名单 |
| `crossSessionControl` | **request** | request | 跨会话控制：改 B 会话的唤醒/静音 |
| `crossSessionDelegate` | **request** | request | 跨会话委派：把“去 B 会话回复”交给 B 自己写（用人设，不串台） |
| `collectSticker` | persona | persona | 收藏别人发的表情（保持原有行为） |
| `stickerNote` | persona | persona | 给收藏表情写本地备注（保持原有行为） |
| `deleteSticker` | **request** | **request** | 删除自己收藏的表情（不可恢复；默认只应管理员要求，受每分钟/每小时/每天上限约束） |
| `qzonePost` | **request** | **request** | 发 QQ 空间说说（账号级公开广播；封顶就在 request，不开放人设自主） |

**封顶**：表格里封顶为 `request` 的项，即使选了「人设自主」也会被夹回「仅应要求」；控制台勾「解除封顶」后写入 `botPerms.unlocked` 才真正放开。理由：这些是账号级、不可逆或会波及别的会话的动作，否则「说服它换头像」就只剩限速一道闸。

**「人设自主」怎么反驳你**：概率写在人格卡「行为合同」小节，例如 `- 反驳主人：15%`（`0.15` 也认；0~100%）；没写就用 `adminOps.vetoProbability`（默认 5%）。只有**管理员本人发起**的调用才掷骰，群友的要求由模型自己决定接不接。驳回时返回 `persona_veto`（HTTP 409），MCP 侧不标 `isError`，preset 要求模型"不重试、用人设解释或干脆不提"。

实现要点：

- **「仅应要求」怎么判定**：工具调用只带会话令牌，看不出是谁在说话。桥接在每条进线消息里记录
  「该会话最近一条消息的发送者 QQ 号是不是 ownerQQ」（5 分钟 TTL，`lastSenderOwner`），权限判定读这份记录，
  不让模型自述。**只认 QQ 号，不认会话**：私聊里如果最近一条不是管理员本人发的（例如从 DSH 界面直接输入、
  或消息已超过 5 分钟），同样不直连、改走确认卡。早先那条「`private:<ownerQQ>` 恒为管理员」的会话捷径已删除。
  已知残留：桥接只能看见"最近一条是谁发的"，分不出"你要求了"和"它自己想撤、而你恰好刚说过话"。
- **跨会话代发**：模型在 A 会话里被要求去 B 会话说一句时，`key` 写 B、令牌仍是 A 的。桥接先从令牌
  反查出源会话，再按 `crossSessionSend` 判定；通过后消息真的发到 B（目标仍要命中白名单 / 当前模式）。
  被拒时返回可读原因（例如「只允许管理员本人触发」），AI 应如实转告。
- **表情类**走调用期闸门（`/api/socialV2/collect-sticker` / `sticker-note`），立即生效。
- **管理员动作**走队列：`none` 直接拒（不占频率额度）；`request` 命中时直连，`persona` 直连但管理员发起时先掷骰；
  直连都会在 owner 私聊留回执——`⚙️ 自主执行：…（来自 …）` 或 `🙅 已按人设拒绝：…（人格：…｜本次概率 …）`，
  审计分别是 `actor=self-service` 与 `actor=persona-veto`。
- **「人设自主」需要 AI 侧协议配合**：`qq_get_prompt` 会返回 `selfService` 清单（只列非 `none` 的项），
  preset 第 17 条据此判断三档各自该怎么做。preset 改动**要重启 DSH** 才对新会话生效；
  `none`/`request` 的判定不依赖它，立即生效。
- 风险自担：`persona` 意味着群友可以靠聊天说服它改名片、撤消息。仍有每分钟 3 次上限、审计、封顶和 `/undo` 兜底。

## 9. 跨会话：代发 / 委派 / 静音

三个能力容易混，分工如下：

| 能力 | 工具 | 谁写这句话 | 适合 |
| --- | --- | --- | --- |
| 代发 | `qq_send_message`（key 指向别的会话） | **当前会话**，沿用当前人设 | 原样发一段固定文字、引述 |
| 委派 | `qq_delegate` | **目标会话**，用它自己的系统提示/历史/人设 | 「去 X 群回复/接一句」——人设不会串 |
| 静音 | `/mute <群号>`、`qq_set_wake_config({muted:true})` | — | 让某个群彻底闭嘴（不再唤醒、发送被拦） |

- 委派把任务写进目标会话的 `st.delegation`，并用 `scheduleWakeV2(target,'delegation')` 触发一次唤醒；
  唤醒 prompt 顶部是 `【管理员委派】…请用这个会话的身份…`，目标会话自己发言。
- 目标已静音时委派会被拒绝（先 `/unmute`）；委派来源限频 3 次/分钟；任务只保留最近一条，
  投递后标记 consumed，避免每次唤醒重复。
- **跨会话代发不会在目标会话排“回复检查”**：旧行为会让目标群自己接着聊起来（早期版本踩到的真实事故）。
- 人设为什么以前会串：人格是**会话级提示词**，代发只是搬成品文本；目标会话没有参与书写，
  它自己的人设只会在它自己发言时生效。委派就是让目标会话自己写。

```text
/mute             # 所有白名单群静音
/mute 123456789  # 只静音这个群
/unmute 123456789
```

## 10. 相关代码

- `src/admin-ops.mjs`：动作白名单、参数与路径沙箱、头像目录的只读预览（名字校验 / realpath / magic bytes）、确认文本解析、待确认队列、`runDirect`（命令直连）、撤销
- `src/bot-perms.mjs`：自主操作权限模型（三档、封顶、旧值迁移、反驳概率解析、动作→权限键映射）
- `src/admin-ops.test.mjs` / `src/bot-perms.test.mjs`：纯逻辑离线回归
- `scripts/test-admin-ops-api.mjs`：接口级回归（虚拟桥接 + 命令 + 确认流 + 三档权限端到端 + 封顶 + persona_veto）
- `scripts/probe-admin-actions.mjs`：真实网关探针（`npm run probe:admin`）
- `src/bridge.js`：`/api/admin/op`、`/api/bot-perms`、`/api/socialV2/delegate`、`/mute` `/unmute`、确认消费、`/undo`、`/card` `/nick` `/sign` `/avatar`、执行器、审计落盘
- `src/mcp-snowluma-safe.js`：`qq_admin` 工具 + `qq_delegate` + `qq_list_assets` / `qq_view_asset`（注册期受 `adminOps.enabled`、`ownerQQ` 与 `assetView.enabled` 约束；**要重启 DSH 才加载**）
- `public/console.html`：访问与安全 → 机器人自主操作
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`：工具协议第 1 条（跨会话用 qq_delegate）与第 17 条
