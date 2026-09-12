# DSH 0.1.5 适配说明（斜杠端点网关）

本仓库原本对接的是 **DSH 0.1.1-rc.2 世代**的 `@deepseek-ai/dsh-host-apiproxy` 传输：
`POST /api/host.describe`、`GET /api/events.mux`（SSE）、`POST /api/respond`。
DSH 0.1.5 起宿主 API 换成了 **typert remote 网关**，旧传输整体消失，于是 `src/dsh-client.js`
被重写成新网关客户端。**`src/bridge.js` 与 `src/self-test.js` 无需任何改动**——适配全部收敛在
`src/dsh-client.js` 里，对外仍是原来的 `api.*` 形状。

## 新旧对照

| 能力 | 旧（apiproxy） | 新（typert 网关） |
| --- | --- | --- |
| 鉴权 | 无（回环地址直接放行） | `/api` 需要浏览器会话 cookie `dsh-auth-<authority>`，由 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` secret 签名 |
| unary | `POST /api/<method>` | `POST /api/<namespace>/<method>`，信封 `{type:'client-request', rpcId, method, payload:{args}}` |
| 事件流 | `GET /api/events.mux`（SSE） | `WS /api/remote.mux`，帧 `{type:'open'|'cancel', streamId, endpoint, payload}` → `{type:'item'|'end'|'error', streamId, value}` |
| 会话事件 | 全局 `session/event` 帧 | 每会话一条 `session/follow` 流（`snapshot` + `event` 帧） |
| 提问/审批 | unary `POST /api/respond` | `$events` 流上的 `waterfall` 帧，回传走 unary `POST /api/$events/result` |
| 会话创建 | `sessions.create` | `session/create`（`{request:{cwd,agentPreset,workspaceId,sessionId}}`，带 `sessionId` 即**恢复已有会话**） |
| 健康检查 | `host.describe` | 已不存在 → 用 `settings/describe` |

## 端点映射（`src/dsh-client.js` 里的适配）

| bridge 调用 | 实际发出的请求 |
| --- | --- |
| `api.host.describe` | `settings/describe {}` |
| `api.sessions.create` | `session/create {request:{cwd?,agentPreset?,workspaceId?,sessionId?}}`，随后自动 `session/follow` |
| `api.sessions.prompt` | `session/prompt {request:{requestId,sessionId,mode,content,clientTimeZone}}`（先确保 follow 已建立，避免丢事件） |
| `api.sessions.selectModel` | `session/selectModel {request:{sessionId,provider,model,reasoningEffort?}}` |
| `api.workspace.create/rename/delete/archiveSession` | 同名 `workspace/*` |
| `api.workspace.list` | 新网关无此方法 → 用 `workspace/follow` 的首帧 `baseline.items` |
| `api.settings.describe` / `api.agentPresets.list` | 同名 |
| `api.events.mux` | `$events` 流（`ready`/`emit`/`waterfall`）+ 各会话 `session/follow` 流，合成老形状的 `{type:'session/event'|'question/requested'|'approval/requested'|'stream/error'}` 信封 |
| `api.respond({rpcId, result})` | `$events/result {clientId, eventId, outcome:{kind:'result', value}}`；提问的 value 是 `{answers:[{id,selected,custom?}]}`，审批是 `allow-once/rejected/...` 之一 |

## 两个实现细节

1. **偶发 401**：实测宿主繁忙时 `/api` 会在数百毫秒的窗口内连续返回 401（自签与服务端签发的 cookie 都会中招），
   并非 cookie 本身有误。客户端对 401/403 做**退避重试（3 次，200/800/1800ms 并重签 cookie）**；
   压测 150 次 + 负载下 200 次均为 0 失败。
2. **依赖 `ws`**：Node 内置 `WebSocket` 不能自定义请求头，而 `remote.mux` 必须带 cookie，因此新增了 `ws` 依赖。

## 自测

```bash
npm run self-test     # 走新网关：settings/describe → session/create → session/follow → prompt → turn/end
```

`state/` 下另留了几个协议探针（gitignore，不随仓库发布）：
`spike-gateway.mjs`（unary + follow）、`spike-events.mjs`（waterfall 提问回传）、`probe-401.mjs`（401 判定）、`load-turn.mjs`（负载生成）。

## 必要配套修复：QQ preset 在 0.1.5 上挂不起来

0.1.5 里 `@deepseek-ai/dsh-persona` 的配置 schema 变成了：

```js
{ prefix: z.string().required(), suffix: z.string().default(''), complete: z.boolean().default(false), includeRuntimeContext: z.boolean().default(true) }
```

而 `dsh/agent-presets/qq-chat` 与 `qq-chat-v2` 里写的还是旧字段 `text:`，于是挂载直接失败：

```
session/create: agent-preset/invalid: preset "qq-chat" failed to mount:
  failed to apply loader entry persona (@deepseek-ai/dsh-persona):
  invalid config: - $.prefix missing required value (at prefix)
```

更危险的是**这个失败会被静默吞掉**：

- `bridge.js` 的 `ensureSession` 用 `for (const withPreset of [true, false])` 重试，preset 失败后不带 preset 再建一次；
- DSH 在不给 preset 时用默认的 `standard` —— 那是**带完整本地工具（shell / 文件读写）**的编码 preset，而 QQ preset 存在的唯一意义就是把这些工具从群里剥掉。

实测：群里那个会话的 header 曾经是 `"agentPreset":"standard"`，等于 QQ 群成员面对的是一个全工具 agent。

**修复**（已应用）：

1. 两个 preset 的 `config.text` → `config.prefix`（仓库模板 + `~/.dsh/.agent-presets/` 安装副本都要改）；
2. `bridge.js` 在带 preset 创建失败时打印明确的告警，不再静默降级：
   `⚠️ 带 preset（…）创建会话失败，将退化为默认 preset —— QQ 安全边界不生效…`；
3. 已存在的会话不会自动换 preset，需要清掉 `state/sessions.json` 里对应映射后重启桥接重建会话
   （重建后 `session/follow` 的 `snapshot.header.agentPreset` 应显示 `qq-chat-v2`）。

## 验证记录（2026-09-13）

| 环节 | 结果 |
| --- | --- |
| `npm run self-test` | ✅ 连接 → 建会话 → prompt → `turn/end` 收到「收到」 |
| 真机：群消息 → DSH → agent → QQ | ✅ 机器人在群里持续对话（带引用回复） |
| DSH 提问 → QQ → 回复 → DSH | ✅ 私聊里出现「❓ agent 需要你回答」，回复自由文本后桥接回执 `{"ok":true,"accepted":true}`，agent 继续跑完 turn |
| preset 安全边界 | ✅ 修复后新群会话 header = `qq-chat-v2` |
| 审批回传 | 机制与提问同一条 waterfall 通道（`approval/request`，outcome ∈ `allowed-once/rejected/cancelled/unavailable`），spike 已验证；真机待触发 |

## 仍然成立的取舍


与「走官方 `dsh --profile sdk`」的方案（上游 PR #4）相比，本适配保留了三项能力：
**工具审批与提问回传 QQ**、**按会话切换模型**、**会话可恢复（重启桥接不丢上下文）**。
代价是自己维护这一层协议映射——DSH 若再次重构网关，需要重新跟进。
