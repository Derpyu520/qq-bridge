# QQ 资料 / 头像 / 空间（看人 + 发说说）

> 状态：2026-10-26 新增，默认开启。涉及文件：
> `src/qq-social-profile.mjs`（纯逻辑）、`src/bridge.js`（端点与权限）、
> `src/mcp-snowluma-safe.js`（三个 MCP 工具）、`src/admin-ops.mjs`（说说的动作队列）、
> `dsh/agent-presets/qq-chat-v2|v3/agent.cordis.yml`（提示词）、`public/console.html`（开关与参数）。

## 1. 能做什么

| 工具 | 作用 | 是否写操作 |
| --- | --- | --- |
| `qq_get_user_profile(userId, avatar=true)` | 读某个 QQ 的**公开资料**，并把头像作为图像交给多模态模型 | 只读 |
| `qq_qzone_read(scope="self"\|"friends", count)` | 读自己的说说 / 好友动态（返回精简文本，不是整页 HTML） | 只读 |
| `qq_qzone_post(content, images?, ugcRight?, targetUins?)` | 发一条 QQ 空间说说（可带媒体库图片、可设可见范围） | **公开写** |

典型用法：

- 群里有人换了头像/签名，AI 想接一句：「你这头像换得挺突然啊」→ 先 `qq_get_user_profile` 看一眼再说话。
- 群友说「你看看我这签名」→ 查资料拿到 `signature`。
- AI 想回顾自己之前发过什么、或确认刚才的说说是否真的发出去 → `qq_qzone_read`。
- 管理员私聊说「发条说说：今天也要好好摸鱼」→ `qq_qzone_post`。

## 2. 权限：谁能查、谁能发

### 2.1 看资料 / 头像

目标 QQ 必须属于下面**任一**来源，否则 403：

1. 机器人自己；
2. `ownerQQ`；
3. **owner 本人刚在这个会话里说过话**（5 分钟 TTL，按最近一条消息的发送者 QQ 号判定）
   —— 等价于「管理员明确给了号码」，私聊里问「查一下我朋友 12345」走这条；
4. 私聊对端（`private:<QQ>` 里的那个 QQ）；
5. 本会话的 `recentMessages` / `unread` 里出现过的人（群里说过话的人）；
6. 人物卡（`qq_person_get` 记过的人）；
7. 当前白名单群的成员（查网关 `get_group_member_list`，2 分钟缓存；失败按空集合处理）。

**为什么这么严**：群友可以在群里发任意 QQ 号诱导 AI 去查。没有这条边界，机器人就是一个
「输入 QQ 号返回资料+头像」的查询台（还能被用来批量扒群成员）。白名单群成员与「说过话的人」
已经覆盖了正常聊天需要；真要查陌生人，让管理员在私聊里说一句即可。

配额：每个会话 **10 分钟最多 `socialV2.profile.maxPer10Min` 次**（默认 10），资料查询和空间读取
**共用同一份预算**（避免用「查资料 + 翻空间」绕过）。

### 2.2 发说说

发说说走的是**管理员动作队列**（与改头像/改名片同一条链）：

- 权限项 `botPerms.qzonePost`，三档：`none` / `request`（默认）/ `persona`，且**封顶在 `request`**
  ——账号级公开广播不允许「人设自主」，要放开只能在控制台显式解除封顶（不推荐）。
- `request` 档下：**owner 本人刚说过话 → 直连**；其他人（群友/别的私聊）要求 → 只生成确认卡，
  发到管理员私聊，管理员回「通过」才执行。
- 返回 `status="pending"` 时，模型只会看到「已把确认卡发到管理员私聊」，**不能宣称已经发了**。
- 确认卡里是**完整正文**（不是前 120 字摘要）：公开广播一旦发出就收不回，不能让「前半段正常、
  后半段塞私货」的注入骗过确认。图片只显示张数（文件名在审计里）。

硬限制（`socialV2.qzone.post`）：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| `maxContentChars` | 1000 | 超长**直接报错**，不悄悄截断 |
| `maxImages` | 9 | 只接受媒体库 `media/` 里的**文件名** |
| 单张/总量 | 10MB / 12MB | 目录沙箱 + realpath 防 junction 逃逸 + magic bytes 校验 |
| `maxPerHour` / `maxPerDay` | 2 / 6 | 账号级（跨会话共享） |
| `minIntervalMs` | 5 分钟 | 两条说说的最小间隔 |
| `duplicateWindowMs` | 10 分钟 | 同样内容不重复发（模型重试/循环的兜底） |
| `defaultUgcRight` | 1（所有人可见） | 可选 4/16/64/128；16/128 必须带 `targetUins` |
| `verify` | true | 发完回读自己的说说列表，确认真的落地 |

> 注意：`qzonePostTimes` / `qzoneRecentPosts` 是**进程内存态**，重启桥接会清零。这是有意的：
> 它只是防手滑/防循环的限速，不是安全边界；真正的安全边界是权限档位与确认卡。

## 3. 数据最小化：资料只回哪些字段

`get_stranger_info` 在真实网关上会回很多字段（`uid`、`qid`、`batteryStatus`、
`qidian_enterprise_name`、`customStatus`…，见 2026-10-26 实测）。桥接**不做透传**，
只保留：

```
userId, nickname, remark, sex/sexLabel, age, signature(long_nick),
level(qq_level), vip, vipLevel, accountYears(由 reg_time 算), online{code,label}
```

理由：① 模型上下文有限，无关字段白烧 token；② 网关字段会随版本变化，透传一次就可能把
「用户以为不公开」的东西带进上下文；③ 资料是私人信息，AI 在群里应少播报。

头像来源固定为 `https://q.qlogo.cn/g?b=qq&nk=<数字QQ号>&s=<avatarSize>`：

- QQ 号必须先通过 `normalizeQqId`（1~12 位数字、首位非 0），**不接受任何外部 URL**；
- 下载走 `safeFetchBuffer`（只有 http/https、禁内网/回环、DNS 全量校验、限字节）；
- 交给模型前过 `normalizeImageForModel`（>1MB 或长边 >1280 会自动缩放；动图抽帧）；
- 头像按 QQ 号缓存 10 分钟，最多 16 个（base64 体积大）；资料缓存 10 分钟、最多 200 个。

## 4. 空间读取：为什么必须洗 HTML

`get_qzone_feeds` 返回的是**预渲染 HTML**，一条动态几 KB（class/内联样式/浏览计数/点赞列表）。
`qq-social-profile.mjs` 的 `stripQzoneFeedText` 做四件事：

1. 去 `<script>/<style>`、去标签、解常见实体；
2. 去掉开头的作者昵称与时间（结构里已有 `uin`/`nickname`/`time`）；
3. 在**强噪声**（`浏览 N 次` / `N 人觉得很赞` / `+1`）处截断，再从结尾反复剥按钮词
   （点赞/评论/转发/分享/收藏/全文/收起）——不能把裸的「评论」当截断点，否则正文里
   「评论区笑死」这类极常见表达会被吃掉半句；
4. 折叠空白并限长（默认 240 字）。

脱敏示例（以下为虚构样本，仅示意效果）：`某群友 某日 某时 示例正文第一句… 浏览 N 次 共 N 人觉得很赞 评论`
→ `示例正文第一句…`。

## 5. 配置与控制台

控制台「二代仿真模式 → QQ 资料与空间」可直接改：

- 启用资料/头像、资料缓存分钟、每会话 10 分钟查询上限；
- 启用空间、允许发说说、发完回读校验；
- 正文上限、配图上限、默认可见范围、每小时/每天上限、两条间隔。

> `reserved3`（三代）读的是同一份设置：三代的有效配置 = 二代基线 + 三代差异，`profile` / `qzone`
> 不单独复制一份，避免两页参数打架。所以只在二代页改，两代同时生效。

工具开关：`socialV2.tools.getUserProfile` / `qzoneRead` / `qzonePost`（默认全开）。
**关闭后重启 DSH** 才会从工具清单里消失；重启前只是调用时 403。

`config.json` 片段：

```json
{
  "socialV2": {
    "profile": { "enabled": true, "cacheTtlMs": 600000, "maxPer10Min": 10, "avatarSize": 640 },
    "qzone": {
      "enabled": true,
      "read": { "maxPosts": 10, "maxFeeds": 10 },
      "post": {
        "enabled": true, "maxContentChars": 1000, "maxImages": 9,
        "defaultUgcRight": 1, "maxPerHour": 2, "maxPerDay": 6,
        "minIntervalMs": 300000, "duplicateWindowMs": 600000, "verify": true
      }
    }
  }
}
```

## 6. 已知限制与排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `只能查看本会话/本群出现过的人…` | 目标不在 §2.1 的 7 个来源里。让管理员在私聊里说「查一下 QQ xxx」。 |
| `10 分钟内查资料/空间太多次` | 配额用尽。等窗口过去，或调大 `profile.maxPer10Min`。 |
| `avatarError` 但资料正常 | qlogo 拉不到（默认灰头像/网络抖动）。如实说看不到头像，不要编长相。 |
| `没有返回 QQ xxx 的资料` | 目标设置了隐私、号不存在，或网关的 `get_stranger_info` 不支持该号。60 秒内不会重复打网关。 |
| 读空间报「响应结构异常」 | 用 `target_uin` 读**别人**的空间在实测网关上会失败（`msglist: null`）。本功能只提供「自己的说说」与「好友动态」两种读法。 |
| 好友动态只有第一页 | 上游 `page_num` 只有首页可靠（深翻页要时间游标，网关暂未实现）。 |
| 发说说 400「刚刚发过」 | 10 分钟内同样内容不重复发。 |
| 发说说 400「超过每小时上限」 | 账号级限额；等窗口或调大 `maxPerHour`。 |
| 发说说 pending 一直不执行 | 确认卡在管理员私聊；回「通过」执行、「拒绝」取消，默认 10 分钟过期。 |
| `verified=false` | 网关返回了成功，但回读没在最新一条里看到。可能还在同步；**不要**编造 tid。 |

## 7. 回归

- `npm run test:qzone`（= `node scripts/test-qzone-profile.mjs`）：端点级边界（白名单字段、
  谁能查、配额、确认卡、图片沙箱、重复与限速、verified）。
- `node --test src/qq-social-profile.test.mjs`：纯逻辑（字段白名单、HTML 清洗、可见范围、
  正文长度、图片数量/总量）。
- 两个都在 `npm run test:audit` 里（前者直接登记；后者经 `scripts/test-admin-ops.mjs` 汇总）。
