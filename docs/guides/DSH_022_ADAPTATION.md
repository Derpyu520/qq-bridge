# DSH 0.2.2 适配记录（qq-bridge v0.2.2-rc1）

> **本文的边界**：只记录**为适配 DSH 0.2.2-rc.1 而做的改动**。每条给出四件事：
> 现象 / 为什么必须改 / 证据 / 怎么验证。
>
> 复核后**判定兼容、因此没改**的部分在 **§3** —— “没改”同样是结论。
>
> 适配目标：`@deepseek-ai/dsh` **0.2.2-rc.1**（上一版适配目标 0.2.1-rc.2，
> 记录见 [DSH_021_ADAPTATION.md](DSH_021_ADAPTATION.md)）。本文写于 2026-11-05。
>
> 版本身份：桥接 `v0.2.2-rc1`，是 0.2.2 线第 1 个候选发布，GitHub Release 标记为
> prerelease；桥接的 `rc1` 与上游 DSH 的 `rc.1` 是各自独立的版本身份。
>
> **上游行为标注**：文中“协议层/线协议/实测”等指 DSH API 的兼容性验证；
> “本机签名密钥/Cookie 生成”等指 qq-bridge 自身的本机鉴权行为，不是 SnowLuma 或 DSH 的机制。

---

## 0. 一句话结论

**Web API / 会话协议形状未变。** 本分支的功能改动包括 `session/follow` 显式激活、
自定义模型思考强度和 `none`（不指定）选项。工具面守卫名单的更新是**对账/回归网**：
0.2.2 默认并不把 `apply_patch` 或调度工具暴露给 QQ preset。

| 级别 | 问题 | 影响 |
|---|---|---|
| **P2** | 工具定义对账：`apply_patch` 进入 0.2.2 安装树（`applyPatch` 默认 `false`） | QQ preset 不挂 `tool-fs`，默认不暴露；守卫新增是回归网，不是修复活跃暴露 |
| **P2** | 调度面 `schedule_update` / `schedule_delete` 改名 `schedule_view` / `schedule_edit`，旧名不再注册 | QQ preset 不挂 `dsh-tool-schedule`；旧名删除、新名补进回归网 |
| **P2** | `session/follow` 从 0.2.1-rc.3 起默认不再激活冷会话 | 显式激活；DSH 重启后恢复带 pending inbox 的会话 |
| **P2** | 模型适配器可提供自定义思考档位或空档位清单 | 保留自定义 ID，支持 `none` 不下发强度；不支持指定强度时去字段重试 |
| **P3** | DSH 0.2.2 要求 Node.js ≥ 24.9 | 文档/CI 基线；桥接本身仍兼容 22.13+ |

改动涉及模型强度配置与选择、守卫名单、follow 请求体、对账脚本及文档/版本。
思考强度的配置说明见 [README](../../README.md#2-填写配置)。

---

## 1. DSH API 兼容性实测：没动

2026-11-05，`node scripts/probes/verify-dsh-022-adaptation.mjs` 在**运行中的 0.2.2-rc.1** 上逐项断言，
**77 通过 / 0 失败**（含 8 项语法检查；workspace-write 沙箱下跳过语法检查，计 69）：

这是当时版本的验证记录；2026-11-06 修复了探针错误处理并新增清理断言，当前脚本的
检查总数已有变化，尚未重新执行活体探针。离线复查结果见 §9。

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

> MCP 工具真调用**不在**这 77 项里：verify 的活体回合只发文本 prompt；
> MCP 调用由 §6 的 `probe-tools` 单独覆盖。
>
> 传输层仍钉在 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
> （`NodeApiClient extends AbstractApiClient`）。它**仍然讲得通 DSH 0.2.2 的 API**——
> 上面所有断言都是它的实测结果。这是唯一一个版本滞后的依赖，每次升级都要靠
> `verify:adaptation` 盯住，不能假设它一直兼容。

---

## 2. 工具面定义对账：两份名单 + 一个执行期白名单

### 2.1 现象：定义变了，默认没有暴露

0.2.2 安装树的工具**定义/默认配置**发生变化，但这不等于 QQ preset 默认暴露：

- `dsh-tool-fs` 提供 `apply_patch`（一次多文件新增/编辑/删除/移动），但
  `applyPatch` 默认 `false`（`dsh-base/cordis.patch.yml` 与
  `dsh-web-app/presets/standard.patch.yml` 都是 false）；
- 调度工具 `schedule_update` / `schedule_delete` 改名为
  `schedule_view` / `schedule_edit`，旧名不再注册；
- 两个 QQ preset 只挂 persona / tool-web / tool-ask-user / tool-todo / 守卫 /
  compaction，**不挂** `tool-fs` 或 `dsh-tool-schedule`；
- `state/tool-restrict.log` 的 `known global tools` 仍只有 4 个
  （3 个 MCP resource + `working_directory`），说明这些名字默认不在
  QQ 会话的全局层。

`state/tool-restrict.log` 里能看到守卫对未知名字的报错
（`tools.restrict() names unknown global tool ...`），随后 3 秒重试补藏；
默认 QQ 会话里这些名字本来就不在，所以那几条失败不构成活跃暴露。

### 2.2 为什么仍然要改

- 执行期白名单（`ctx.tools.guard`）是最终边界：任何不在 `SAFE_PREFIXES` /
  `SAFE_EXACT` 的调用都会被拒绝；默认 0.2.2 的 QQ 会话没有因为这三个名字
  产生新的可执行能力。
- 但守卫名单是**回归网**：一旦某个 composition / 用户自定义 preset 打开
  `applyPatch`，或把调度工具挂到全局层，名字必须已经在名单里；否则
  `tools.restrict()` 对未知名字抛错、被 try/catch 吞掉 = 静默漏藏。
- 旧调度名已不存在，留着只会制造 `known global tools` 噪声，并掩盖真正的名字。

### 2.3 改法

- [plugins/qq-agent-presets/qq-tool-restrict.mjs](../../plugins/qq-agent-presets/qq-tool-restrict.mjs)：
  - `LOCAL_EXECUTION_TOOLS` 增加 `apply_patch`；
  - 调度面改成 `schedule_create / schedule_list / schedule_view / schedule_edit`；
  - 删除 `schedule_update / schedule_delete`。
- [scripts/tests/offline/test-preset-local-tools.mjs](../../scripts/tests/offline/test-preset-local-tools.mjs)：与守卫保持同一份名单。
- [scripts/probes/verify-dsh-022-adaptation.mjs](../../scripts/probes/verify-dsh-022-adaptation.mjs)：新增 `GUARD_022_NAMES` 断言。

### 2.4 怎么验证

1. `npm run scan:tool-names` —— 325 个包、83 个候选名；**悬空 0 / 未覆盖危险名 0**。
2. `node scripts/tests/offline/test-preset-local-tools.mjs` —— 7/7，含“守卫名单里的每个名字都是
   DSH 真实注册的工具”。
3. `verify:adaptation` 的 `GUARD_022_NAMES` 断言。
4. 活体：`probe-tools.mjs qq-chat` / `qq-chat-v2` 都只调 MCP 工具、未出现本地工具调用
   （`apply_patch` / `str_replace_editor` 已补进探针正则）；它证明当前回合没有本地调用，
   不能单独证明工具面已隐藏，需结合 §2.1 的 preset 行与 `known global tools`。

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
| `sessionProjections.register` 改异步（0.2.1-rc.2 起） / `agent/request` 路由限制 | 桥接不注册 projection、不监听该 waterfall | 无 |
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

[src/dsh/dsh-client.js](../../src/dsh/dsh-client.js) 的 `sendOpen` 请求体加：

```js
request: {
  address: { kind: 'session', sessionId },
  activate: true,
  maxMessages: FOLLOW_SNAPSHOT_MESSAGES
}
```

并在 [scripts/audit/test-audit-protocol.mjs](../../scripts/audit/test-audit-protocol.mjs) 加一条
协议断言，防止以后又被“简化”掉。

### 4.3 为什么安全

- 激活只是把冷 Agent promote 起来，不等同于发 prompt：**没有 pending inbox 时不会凭空多出一个用户回合**。
- 这正是 0.2.1-rc.2 之前 follow 的默认行为，桥接本来就是按那个语义写的。
- 与官方 Web 客户端一致。
- 启动和事件流重连前，桥接先在线读取模式、管理员与 preset 清单，并退役已撤权的
  持久化会话，再发送激活型 follow。读取失败或 preset 清单为空时暂不恢复，避免先运行
  旧 `closed-agent` 待办任务、后做权限检查。

### 4.4 怎么验证

- 协议层：`test-audit-protocol.mjs` 断言 `follow.payload.args.request.activate === true`。
- 活体：`node src/self-test.js` 通过（桥接客户端 follow + prompt + turn/end + 归档），
  证明 0.2.2 接受该字段；`verify` §5g 的活体 follow 也带 `activate: true`，
  字段被拒时回合测试会直接失败。
- **冷会话 promote 的端到端场景需要 DSH 重启/有 pending inbox，未在本机人为制造**；
  这一项的语义依据是 DSH 0.2.1-rc.3 的 upgrade guide 与官方 Web 客户端请求体。
- `test-audit-session-boundaries.mjs` 离线验证启动/重连等待权限查询、撤权退役及查询失败
  时不打开激活型事件流。

### 4.5 思考强度兼容与热切换

- 控制台使用 DSH 目录中的精确档位 ID（保留大小写，包含适配器自定义值和 `off`）。
  模型未声明 `reasoning` 能力时，API 能力列表仅公布 `none`；目录不可用时回退 `low / high / max / none`。
  控制台仍保留未列出的当前配置，并标注“当前配置，目录未列出”，供管理员识别和切换。
- `none` 表示 `selectModel` 不携带 `reasoningEffort`，使用适配器默认值；不代表关闭思考。
  `none` 是桥接保留值，大小写变体也按此解释；其他档位须填写目录中的精确 ID。
- 明确拒绝指定强度时，保持 provider/model 并去掉强度重试；其他临时失败仍保留原参数重试。
- 控制台保存强度后，下一条消息重新应用模型选择。异步选择只缓存请求开始时的配置代号，
  防止旧请求返回后误将新配置标记为已应用。`test-issue-followup-runtime.mjs` 覆盖此并发场景。

---

## 5. Node.js 24.9 基线

### 5.1 上游要求

DSH 0.2.2 的 `package.json` 写死 `engines.node >= 24.9.0`；本机是 24.19.0。
桥接自身没有 24 专属 API，`package.json` 仍保留 `>=22.13.0`，表示“桥接进程
可以跑在 22.13+；与 DSH 0.2.2 同机部署时由 DSH 要求 24.9+”。文档按这个口径写，
CI 的 audit 主 job 保留原名、跑 Node 24；另加一条 Node 22 兼容 job，
避免只在其中一条线上“绿”。

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
| `verify:adaptation`（活 DSH，77 项，含真跑一回合） | **77 通过 / 0 失败** |
| `probe-tools qq-chat` / `qq-chat-v2`（真调 MCP 工具） | 两个 preset 均成功、未调本地工具 |
| `self-test`（桥接客户端 follow + 真回合） | 通过（回复“收到”，会话已归档） |
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

`verify:adaptation` 是活体探针：会写回 `qq-mode` 设置，并选择
`deepseek-official / deepseek-flash / max`。DSH 的 `selectModel` 同时更新全局默认，
所以运行探针会影响 Web 新会话的默认模型/强度，且不自动还原；请在测试实例运行，
或运行后核对设置。探针结束时会停止并归档测试会话；清理失败记为验证失败。
这类活体验证不能由离线回归的通过结果替代。

---

## 7. 下次 DSH 升级的增量清单

沿用 [DSH_020_ADAPTATION.md §10](DSH_020_ADAPTATION.md#10-下次-dsh-升级的操作清单可复用)，
本轮补充四条：

1. **先看 `state/tool-restrict.log` 的 `known global tools`**：新增名字基本等于
   1 个必须补的守卫条目；别只看 `restrict ok=` 的分子——大部分名字是 scoped 工具，
   restrict 对它们本来就抛错，要看失败样例里有没有全局工具。
2. **升级后立刻跑 `node scripts/probes/probe-tools.mjs qq-chat-v2`**：同时覆盖 persona 装配、
   工具面、MCP 调用三条链路，是全仓库最便宜的一次端到端体检。
3. **`verify:adaptation` 必须在活 DSH 上跑**：静态断言看不出提示词变量被删、
   `activate` 语义变化、projection 形状变化。
4. **不要在 DSH 沙箱里把 junction/spawn 假失败当代码 bug**：先看 §5.2，再到普通终端复跑。

---

## 8. 版本与发布

- 本仓库版本：`0.2.2-rc1`（`package.json` / `package-lock.json` / 两个插件 /
  三个 MCP server 的 `serverInfo.version` 全部一致，由 `verify:adaptation` §3 强制）。
- 适配目标：DSH `0.2.2-rc.1`；上一版适配目标 `0.2.1-rc.2`，发布线
  `v0.2.1-r1` / `v0.2.1-r2` 保留为历史。
- 发布流程：适配分支最终验证并提交 → 合入 `dev` → 通过 PR 将 `dev` 合入受保护的
  `main` → 将合并提交快进同步回 `dev` → 打 `v0.2.2-rc1` 标签并创建 GitHub
  prerelease（不替换 stable latest）；**不**在 `main` 上直接改代码。
- 0.2.2 线使用 `rcN` 表示候选发布；旧版 `rN` 标签维持历史含义，见
  [DSH_020 附录 H](DSH_020_ADAPTATION.md#h-版本号方案历史-rn-与当前候选发布)。

---

## 9. 分支复查（2026-11-06）

以 `origin/main` 的 `b80fa51` 为基线，对适配分支代码、协议、安全边界和公开文档进行复查，
并修复以下问题：

- 启动/重连激活冷会话前先校验当前权限，防止旧高权限会话提前恢复待办任务。
- 修复模型选择期间保存新强度的竞态，保证后续消息仍会应用新配置。
- 发布前独立审查补齐真实模型目录边界：没有 `reasoning` 字段时只提供 `none`；
  自定义 `HIGH` / `Low` / `MAX` 等档位 ID 从配置到 `selectModel` 均保留大小写。
- 适配探针不再把必要协议失败记为跳过；使用独占临时目录，等订阅快照后再投递，
  超时取消请求，清理时先停止再归档，并检查 RPC 错误结果；`turn/end` 也必须等待
  prompt 接受结果，避免将迟到的 RPC 拒绝误判为成功。
- 模式探针按用户设置层和 revision 写回，避免将尚未热更新的旧模式覆盖回去；
  明确说明探针对全局默认模型的持久影响。
- 校准安全支持版本、preset 回退条件、`self-test` 范围与本分支思考强度变更说明。
- 修复浏览器回归的基线漂移和图表异步等待：保留历史 24 次请求基线，新增 ACL 操作与
  语音开关独立验证，范围切换等待对应图表数据更新。
- 发布前 CI 追查修复分条发送边界：先对整批文本预检会话令牌，命中则零外发；
  对应回归使用固定间隔并检查 OneBot 传输记录，避免随机长间隔造成测试超时。

普通执行环境验证：Node 22.23.2 和 Node 24.19.0 的 `test:audit` 均为 **58/58 脚本通过**；
新增探针协议回归 **13/13**，权限恢复回归覆盖启动、重连、撤权及查询失败；
浏览器回归 **24/24**，冻结原版对照 **10/10**；依赖漏洞检查为 **0**，
包含新增文件的隐私扫描通过，全部 135 个 JS 文件语法与 8 个 JSON 清单解析通过。

本轮未运行会改变全局默认模型并消耗模型回合的活体探针，未制造 DSH 重启带待办队列的
端到端场景，也未向真实 QQ 发送测试消息；§6 的活体结果保留为 2026-11-05 历史记录。
