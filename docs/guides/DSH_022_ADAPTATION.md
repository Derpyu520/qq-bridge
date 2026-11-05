# DSH 0.2.2 适配记录（qq-bridge v0.2.2-r1）

> **本文的边界**：只记录**为适配 DSH 0.2.2-rc.1 而做的改动**。每条给出四件事：
> 现象 / 为什么必须改 / 证据 / 怎么验证。
>
> 复核后**判定兼容、因此没改**的部分在 **§3** —— “没改”同样是结论。
>
> 适配目标：`@deepseek-ai/dsh` **0.2.2-rc.1**（上一版适配目标 0.2.1-rc.2，
> 记录见 [DSH_021_ADAPTATION.md](DSH_021_ADAPTATION.md)）。本文写于 2026-11-05。
>
> 版本身份：桥接 `v0.2.2-r1`（版本号方案见 DSH_020 附录 H：主版本与 DSH 同步，
> `r1` = 0.2.2 线第 1 次发布）。
>
> **上游行为标注**：文中“协议层/线协议/实测”等指 DSH API 的兼容性验证；
> “本机签名密钥/Cookie 生成”等指 qq-bridge 自身的本机鉴权行为，不是 SnowLuma 或 DSH 的机制。

---

## 0. 一句话结论

**Web API / 会话协议零漂移；唯一需要改代码的是工具面守卫名单。**

| 级别 | 问题 | 影响 |
|---|---|---|
| **P1** | 0.2.2 新增全局工具 `apply_patch`（dsh-tool-fs：一次多文件新增/编辑/删除/移动） | 守卫名单少藏一层；执行期白名单仍会拒绝调用，属于纵深防御缺口 |
| **P1** | 调度工具 `schedule_update` / `schedule_delete` 改名 `schedule_view` / `schedule_edit`，旧名不再注册 | 旧名留在 `tools.restrict()` 名单里只会被 try/catch 吞掉；新名不补就少藏一层 |
| **P2** | `session/follow` 从 0.2.1-rc.3 起默认不再激活冷会话 | DSH 重启后仍有 pending inbox 的 QQ 会话可能停住；已显式传 `activate: true` |
| **P3** | DSH 0.2.2 要求 Node.js ≥ 24.9 | 文档/CI 基线；桥接本身仍兼容 22.13+ |

业务逻辑（bridge.js 的收发/队列/机器人格）一行没动；改动全部落在
**守卫名单 + follow 请求体 + 对账脚本 + 文档/版本**。

---

## 1. DSH API 兼容性实测：没动

`node scripts/verify-dsh-022-adaptation.mjs` 在**运行中的 0.2.2-rc.1** 上逐项断言，
**76 通过 / 0 失败**（含 8 项语法检查；workspace-write 沙箱下跳过语法检查，计 68）：

| 契约 | 0.2.2 实测 |
|---|---|
| 本机会话 Cookie 生成 | 成功（224 字节） |
| `settings/describe` / `settings/update`（平铺多参数） | 可用，`qq-mode` 命名空间在列且可写 |
| `agentPresets/list` | `standard, ptc, minimal, cordis, qq-chat, qq-chat-v2` |
| `session/create` 挂 preset + `selectModel(deepseek-flash)` | 成功 |
| `session/projections` | 一元 RPC 可用，带 `values.inbox` |
| `session/control` baseline | 仍是 `value.projections[<id>].values.*`（0.1.7 的 `queues` 形状不存在） |
| `stopSessionWork` | 成功返回（队列退役路径无回归） |
| `$events` | 下发 ready 帧并带 clientId |
| `session/modelCatalog` | 可用（1 组） |
| 点号 endpoint `/api/session.list` | 仍 404（斜杠式协议未变） |
| **preset 真跑一回合** | 文本 `"收到"`（提示词变量可解析） |
| **preset 内 MCP 工具真调用** | `mcp__snowluma-host__snowluma_status` → `isError:false`，随后回复 `"完成"` |

> 传输层仍钉在 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
> （`NodeApiClient extends AbstractApiClient`）。它**仍然讲得通 DSH 0.2.2 的 API**——
> 上面所有断言都是它的实测结果。这是唯一一个版本滞后的依赖，每次升级都要靠
> `verify:adaptation` 盯住，不能假设它一直兼容。

---

## 2. 工具面漂移：两份名单 + 一个执行期白名单

### 2.1 现象

0.2.2 安装树的全局工具比 0.2.1 多/改了三个名字：

- 新增 `apply_patch`（`dsh-tool-fs`）；
- `schedule_update` / `schedule_delete` 改名为 `schedule_view` / `schedule_edit`；
- 旧调度名不再注册。

`state/tool-restrict.log` 里能看到守卫在启动早期对未知名字的报错
（`tools.restrict() names unknown global tool ...`），随后 3 秒重试补藏；
**新名字不补进去，这一层就永远不生效**。

### 2.2 为什么必须改

- `ctx.tools.restrict({ deny: [name] })` 对**未知名字整批原子性抛错**，而守卫逐个
  try/catch 只打日志 ⇒ 拼错/漏掉的名字 = 静默 no-op。
- 执行期白名单（`ctx.tools.guard`）仍然会拒绝 `apply_patch` 这类本地执行工具，
  所以这不是“群友能直接跑命令”的 P0；但注册期 schema 会把它列给模型，
  属于 L7「仿真会话无本地能力」的纵深防御缺口。
- 旧调度名留在名单里不会害人（会被 try/catch 吞掉），但会持续制造
  `known global tools` 噪声，并掩盖真正的新名字。

### 2.3 改法

- [plugins/qq-agent-presets/qq-tool-restrict.mjs](../../plugins/qq-agent-presets/qq-tool-restrict.mjs)：
  - `LOCAL_EXECUTION_TOOLS` 增加 `apply_patch`；
  - 调度面改成 `schedule_create / schedule_list / schedule_view / schedule_edit`；
  - 删除 `schedule_update / schedule_delete`。
- [scripts/test-preset-local-tools.mjs](../../scripts/test-preset-local-tools.mjs)：与守卫保持同一份名单。
- [scripts/verify-dsh-022-adaptation.mjs](../../scripts/verify-dsh-022-adaptation.mjs)：新增 `GUARD_022_NAMES` 断言。

### 2.4 怎么验证

1. `npm run scan:tool-names` —— 325 个包、83 个候选名；**悬空 0 / 未覆盖危险名 0**。
2. `node scripts/test-preset-local-tools.mjs` —— 7/7，含“守卫名单里的每个名字都是
   DSH 真实注册的工具”。
3. `verify:adaptation` 的 `GUARD_022_NAMES` 断言。
4. 活体：`probe-tools.mjs qq-chat` / `qq-chat-v2` 都只调 MCP 工具、不调本地工具。

---

## 3. 逐条核对 0.2.2 / rc.3 / rc.4：判定“无需改动”

上次适配停在 0.2.1-rc.2，因此这次把 rc.3、rc.4、0.2.2 的 upgrade-guide 一起核对了。

| 变更 | 对桥接的影响 | 处置 |
|---|---|---|
| projection 实时帧改为 `{ seq, changes: [{key,val}] }` | 桥接只读 `session/control` 的 baseline 和一元 `session/projections`，不消费 live `projection` 帧 | 无 |
| `session/list` summary 去掉 `contextPressure` / `contextBreakdown` | 桥接只读 `cwd` / `origin` / `parentSessionId`，不读 projections | 无 |
| `session/attachment` 要求完整 `ImageAttachmentRef` | 桥接不调用 `session/attachment`，也不从 DSH 读回图片 | 无 |
| `session/follow` 默认不激活冷会话（rc.3） | 桥接启动时会重放全部 `state.sessions` 的 follow；冷会话带 pending inbox 时不会续跑 | **§4 已改：`activate: true`** |
| `independent-session-forks`（rc.3） | 桥接不 fork；`session/list` 的 `origin`/`parentSessionId` 仅用于 `workspace/reset` 过滤 | 无 |
| `attachment-read-access`（rc.3） | 同上，不读附件 | 无 |
| `model-listing-refresh` / `reasoning-body-props`（rc.4） | 桥接只用 `session/modelCatalog` 的 `groups[].models[].reasoning.efforts`，形状未变 | 无 |
| `tools.mode` 在 0.2.2 变成 `z.never()`（改挂 executor） | 两个 QQ preset 都没有配置 `tools.mode`；守卫用 `ctx.tools.restrict`，不读该字段 | 无 |
| `sessionProjections.register` 改异步 / `agent/request` 路由限制 | 桥接不注册 projection、不监听该 waterfall | 无 |
| `cordis-loader-entry-trees`（EntryTree.commit / Include journal） | 桥接直接写 profile 文件（`cordis.patch.yml` / `package.json`），不实现 `EntryTree` | 无 |
| `fs-observation-policy` 默认 off | QQ preset 不挂 fs 工具；主 profile 是否恢复 read-before-write 是部署选择（见 §5.3） | 无（环境侧） |
| `llm-request-purpose-declarations` / `pi-ai-request-image-count` / `sdk-run-commands` | 桥接不构造辅助 LLM 请求、不走 pi-ai、不用 Python/TS SDK | 无 |
| `schedule-remote-host-tasks` | 桥接不管理调度任务 | 无 |
| `new-session-blank-reuse`（rc.2 起） | 桥接每次创建都用 `qqb-<g 或 p>-<id>-<32hex>` 的**随机后缀**，不会命中已持久化的同 id 会话 | 无 |
| `node-24` | 本机 24.19；桥接代码无 24 专属 API | 文档/CI 基线（见 §5） |

---

## 4. `session/follow` 显式请求激活

### 4.1 现象

DSH 0.2.1-rc.3 起，`session.follow` 在省略 `activate` 时**只读历史、不恢复冷 Agent**
（官方 Web 客户端会显式传 `activate: true`）。桥接在启动时会为 `state.sessions`
里的每个 QQ 会话重放 follow；DSH 重启后这些会话都是冷的。如果断线前 DSH inbox 里
还排着消息（例如用户连发两条，第二条停在队列里），没有激活就永远不会再跑，
QQ 上表现为“它不理我了”，而桥接日志里没有报错。

### 4.2 改法

[src/dsh-client.js](../../src/dsh-client.js) 的 `sendOpen` 请求体加：

```js
request: {
  address: { kind: 'session', sessionId },
  activate: true,
  maxMessages: FOLLOW_SNAPSHOT_MESSAGES
}
```

并在 [scripts/test-audit-protocol.mjs](../../scripts/test-audit-protocol.mjs) 加一条
协议断言，防止以后又被“简化”掉。

### 4.3 为什么安全

- 激活只是把冷 Agent promote 起来，不等同于发 prompt：**没有 pending inbox 时不会凭空多出一个用户回合**。
- 这正是 0.2.1-rc.2 之前 follow 的默认行为，桥接本来就是按那个语义写的。
- 与官方 Web 客户端一致。

---

## 5. Node.js 24.9 基线

### 5.1 上游要求

DSH 0.2.2 的 `package.json` 写死 `engines.node >= 24.9.0`；本机是 24.19.0。
桥接自身没有 24 专属 API，`package.json` 仍保留 `>=22.13.0`，表示“桥接进程
可以跑在 22.13+；与 DSH 0.2.2 同机部署时由 DSH 要求 24.9+”。文档按这个口径写，
CI 的 audit job 加 `[22, 24]` 矩阵，避免只在 22 上验证。

### 5.2 沙箱假失败：不要据此改代码

在 DSH 的 `workspace-write` 文件沙箱里跑 `test:audit`，会看到 3 个假失败：

- `test-audit-runtime-boundaries`：沙箱把 Node 创建的 junction 当普通目录，
  `fs.realpathSync` 不解析；普通终端 / `danger-full-access` 下 10/10 通过。
- `test-audit-setup` / `test-qq-model-view`：`spawnSync` 管道 stdio 被沙箱拒绝（EPERM）；
  普通终端下通过。

**结论：这是运行环境限制，不是代码回归。** 生产桥接在沙箱外运行，
不要为了这 3 项把 `fs.realpathSync` 改成 `.native`（会改变 dangling link 的判定）。

### 5.3 主 profile 的 `fs-observation-policy`

0.2.2 把 `fs-observation-policy` 默认设为 `disabled: true`。本机
`~/.dsh/profiles/web/cordis.patch.yml` 已手动加回：

```yaml
- id: fs-observation-policy
  disabled: false
```

这是**部署侧**选择，不属于 qq-bridge 安装逻辑；QQ preset 不挂 fs 工具，
不受影响。若希望新机器也保持 read-before-write，可在部署文档里复制这一段。

---

## 6. 验证记录（2026-11-05，运行中的 0.2.2-rc.1）

| 套件 | 结果 |
|---|---|
| `verify:adaptation`（活 DSH，76 项，含真跑一回合） | **76 通过 / 0 失败** |
| `probe-tools qq-chat` / `qq-chat-v2`（真调 MCP 工具） | 两个 preset 均成功、未调本地工具 |
| `scan:tool-names` | 325 包 / 83 名；悬空 0；未覆盖危险名 0 |
| `verify-persona-config` | 17 项全过 |
| `test:plugin`（qq-mode 宿主插件） | 6/6 |
| `test:mcp-servers` | 33 + 1 + 2 工具，全部正常 |
| `test:dsh-auth` | 17/17 |
| `test:session-retire:e2e` | 11/11（removed=1，队列清空） |
| `test:audit`（普通终端） | 57/57 脚本通过 |
| `test:setup-idempotent` | 通过 |
| 两个 preset 的实际挂载 | `qq-chat`、`qq-chat-v2` 均成功 |

> 在 `workspace-write` 沙箱里：语法检查 8 项显式跳过；`test:audit` 的 3 项
> junction/spawn 假失败见 §5.2。普通终端重跑即可覆盖。

---

## 7. 下次 DSH 升级的增量清单

沿用 [DSH_020_ADAPTATION.md §10](DSH_020_ADAPTATION.md#10-下次-dsh-升级的操作清单可复用)，
本轮补充四条：

1. **先看 `state/tool-restrict.log` 的 `known global tools`**：新增名字基本等于
   1 个必须补的守卫条目；别只看 `restrict ok=` 的分子——大部分名字是 scoped 工具，
   restrict 对它们本来就抛错，要看失败样例里有没有全局工具。
2. **升级后立刻跑 `node scripts/probe-tools.mjs qq-chat-v2`**：同时覆盖 persona 装配、
   工具面、MCP 调用三条链路，是全仓库最便宜的一次端到端体检。
3. **`verify:adaptation` 必须在活 DSH 上跑**：静态断言看不出提示词变量被删、
   `activate` 语义变化、projection 形状变化。
4. **不要在 DSH 沙箱里把 junction/spawn 假失败当代码 bug**：先看 §5.2，再到普通终端复跑。

---

## 8. 版本与发布

- 本仓库版本：`0.2.2-r1`（`package.json` / `package-lock.json` / 两个插件 /
  三个 MCP server 的 `serverInfo.version` 全部一致，由 `verify:adaptation` §3 强制）。
- 适配目标：DSH `0.2.2-rc.1`；上一版适配目标 `0.2.1-rc.2`，发布线
  `v0.2.1-r1` / `v0.2.1-r2` 保留为历史。
- 发布流程：`dev` 验证通过 → `dev → main` 合并 → 打 `v0.2.2-r1` 标签；
  **不**在 `main` 上直接改代码。
