# DSH 0.2.1 适配记录（qq-bridge v0.2.1-r1）

> **本文的边界**：只记录**为适配 DSH 0.2.1-rc.2 而做的改动**。每一条给出四件事：
> 现象 / 为什么必须改 / 证据 / 怎么验证。
>
> 复核后**判定兼容、因此没改**的部分在 **§4** —— "没改"同样是结论。
>
> 适配目标：`@deepseek-ai/dsh` **0.2.1-rc.2**（上一版适配目标 0.2.0-rc.2，
> 记录见 [DSH_020_ADAPTATION.md](DSH_020_ADAPTATION.md)）。本文写于 2026-10-22。
>
> 版本身份：桥接 `v0.2.1-r1`（版本号方案见 DSH_020 附录 H：主版本与 DSH 同步，
> `r1` = 0.2.1 线第 1 次发布）。不用裸 `v0.2.1` 是因为历史上那次被撤回的标签
> 已经用过这个名字（commit `9bb7b98` 仍在历史里），重名只会让标签列表更难解释。

---

## 0. 一句话结论

**协议面零漂移，但有两处真实断裂**，第一处会让 QQ 侧**完全不回**：

| 级别 | 问题 | 影响 |
|---|---|---|
| **P0** | 提示词变量 **`{{cwd}}` 在 0.2.1 被删除**（agent loop 现在只注册 `provider` / `model`） | 两个 QQ preset 的**每一次回合**都在 `turn/start` 后立刻 `error`，模型一次都不跑 ⇒ QQ 上表现为「发消息完全没反应」，且日志里只有一行 error |
| **P1** | `dsh-base` 新增默认挂载 `working-directory`，全局层多出 **`working_directory`** 工具 | QQ 仿真会话的 schema 会继承它（L7 的"注册期不得含本地能力"被破坏）；执行期白名单仍会拒绝调用 |

外加两族"潜在口子"（terminal / session-query / plugin_market）已列进守卫回归网；
Codex / Claude Code 改为按需安装，两个老工具名改判为「可选项」。

业务逻辑（bridge.js）一行没动，改动全部落在 **preset persona 文本 + 守卫名单 + 对账脚本**。

---

## 1. 协议层实测：没动

`node scripts/verify-dsh-021-adaptation.mjs`（改名自 `verify-dsh-020-adaptation.mjs`）
在**运行中的 0.2.1** 上逐项断言，**75 通过 / 0 失败**：

| 契约 | 0.2.1 实测 |
|---|---|
| 本机签名密钥离线铸造 Cookie | 成功（224 字节） |
| `settings/describe` / `settings/update`（平铺多参数） | 可用，`qq-mode` 命名空间在列且可写 |
| `agentPresets/list` | `standard, ptc, minimal, cordis, qq-chat, qq-chat-v2` |
| `session/create` 挂 preset + `selectModel(deepseek-flash)` | 成功 |
| `session/projections` | 一元 RPC 可用，带 `values.inbox` |
| `session/control` baseline | 仍是 `value.projections[<id>].values.*`（0.1.7 的 `queues` 形状依旧不存在） |
| `stopSessionWork` | 成功返回（队列退役路径无回归） |
| `$events` | 下发 ready 帧并带 clientId |
| `session/modelCatalog` | 可用（1 组） |
| 点号 endpoint `/api/session.list` | 仍 404（斜杠式协议未变） |
| **preset 真跑一回合** | 文本 `"收到"`（本轮新增断言，见 §2） |
| **preset 内 MCP 工具真调用** | `mcp__snowluma-host__snowluma_status` → `isError:false`，随后回复 `"完成"` |

> 顺带记录：`src/dsh-client.js` 的传输层仍钉在 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
> （`NodeApiClient extends AbstractApiClient`）。它**仍然讲得通 0.2.1 的线协议**——
> 上面所有断言都是它的实测结果。这是唯一一个版本滞后的依赖，每次升级都要靠
> `verify:adaptation` 盯住，不能假设它一直兼容。

---

## 2. 断裂点一（P0）：`{{cwd}}` 变量被删除 ⇒ 每一回合直接 error

### 2.1 现象

用 `qq-chat-v2` 建一个会话、发一句普通 prompt，事件流里只有：

```
turn/start {"turn":1}
turn/end   {"turn":1,"reason":{"kind":"error","error":{
             "message":"unknown prompt variable \"{{cwd}}\" in section \"deployment:persona-suffix\";
                        registered variables: provider, model","code":"UNKNOWN"}},"text":""}
```

**没有 `assistant/message`、没有 `tool/call`**——模型根本没被调用。
QQ 侧的现象就是"发消息没反应"，而桥接日志里只有一行 `AI 内部输出：...`（空）。

### 2.2 为什么必须改

- `dsh-agent-loop` 在 0.2.1 只注册两个提示词变量：
  ```js
  ctx.systemPrompt.variable("provider", ...);
  ctx.systemPrompt.variable("model", ...);
  ```
  0.2.0 还有 `cwd`，0.2.1 把它删了。
- `dsh-system-prompt` 对未知变量是 **fail loud**（不是渲染成空串）：
  `interpolate()` 直接 `throw new Error('unknown prompt variable ...')`。
- 于是两个 preset 的 persona suffix `Your working directory is {{cwd}}.` 让**每一次**
  系统提示词装配都抛错。这不是"少一条信息"，是**整条对话链 100% 不可用**。
- 工作目录**并没有丢**：0.2.1 新增的 `dsh-working-directory` 会以
  `working-directory:current` 的**运行时上下文**（`required: true`、`interpolate: false`）
  注入当前目录，persona 的 `includeRuntimeContext` 默认 true，模型照样看得到。

### 2.3 改法

删掉两个 preset 的 persona `suffix`（并在注释里写明为什么不能再写 `{{cwd}}`）：

- `dsh/agent-presets/qq-chat/agent.cordis.yml`
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`

然后 `node scripts/build-agent-preset-patches.mjs` 重新生成
`plugins/qq-agent-presets/presets/*.patch.yml`（产物是纯生成物，不许手改）。

> **好消息**：preset 文本的改动**不需要重启 DSH**——新建/恢复会话时按当前 patch 解析，
> 实测改完立刻生效（见 §5 的活体回合与工具调用）。

### 2.4 怎么验证

1. 静态：`verify:adaptation` 里的「只引用 DSH 已注册的提示词变量」——
   拿 persona 配置里出现的**所有** `{{var}}` 与 `{provider, model}` 求差，不只看有没有 `{{model}}`。
   `verify-persona-config.mjs` 同样改成了这个口径。
2. 活体（本轮新增，**这就是当初该有的那条网**）：
   `verify:adaptation` §5g 真建一个 `qq-chat-v2` 会话、发一句 prompt、等 `turn/end`，
   断言 `reason.kind === 'completed'` 且文本非空。静态断言只能看出"写了什么变量"，
   只有真跑一回合才能证明它**可解析**。
3. 端到端：`node scripts/probe-tools.mjs qq-chat-v2` → MCP 工具可调用、未调用本地工具。

---

## 3. 断裂点二（P1）：`working_directory` 进了仿真会话

### 3.1 证据

`state/tool-restrict.log`（升级重启后第一轮 preset apply）里 known global tools 从 3 个变 4 个：

```
restrict ok=3 failed=64 原因: tools.restrict() names unknown global tool "pwsh";
known global tools: list_mcp_resource_templates, list_mcp_resources, read_mcp_resource, working_directory
```

来源可查：`dsh-base/cordis.patch.yml` 现在无条件挂载两行：

```yaml
- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'
- id: tool-working-directory
  name: '@deepseek-ai/dsh-tool-working-directory'
```

### 3.2 为什么这是安全问题而不是清洁问题

L7 要求仿真会话的 preset **注册期**就不得含本地能力。`tools.guard` 只在执行期拒绝，
工具名仍留在模型 schema 里——既违反注册期要求，也会诱导模型去调它。
`working_directory` 能改写会话工作目录，属于"本地环境状态"，不是 QQ 动作面能力。

> 执行期白名单这一层**没有失效**：`working_directory` 不在 `SAFE_EXACT` / MCP 前缀里，
> 调用照样被拒。这是"第二层兜住了"，不是"没问题"。

### 3.3 同轮新增的潜在口子（当前未启用，先列进回归网）

| 名字 | 来源包 | 为什么算危险 |
|---|---|---|
| `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list` | `dsh-tool-terminal`（0.2.1 转正） | 终端 = 直接 shell |
| `session_search` / `session_trace` / `session_event_read` / `session_event_search` / `session_event_trace` | `dsh-tool-session-query`（0.2.1 新增） | 能跨会话读事件正文 ⇒ 把别的聊天记录递给 QQ 群 |
| `plugin_market` | `dsh-plugin-market`（0.2.1 新增） | 插件装载权 = 任意代码执行（等价 `plugin_manager`） |
| `create_worktree` / `wait_agent` | 两个实验包 | 写盘 + git 进程 / team 家族同族 |

### 3.4 改法

1. `plugins/qq-agent-presets/qq-tool-restrict.mjs`：`LOCAL_EXECUTION_TOOLS` 增 13 个名字；
   新增导出 `OPTIONAL_BUNDLE_TOOL_NAMES = ['subagent_codex','subagent_claude_code']`
   （0.2.1 把 Codex / Claude Code 改成按需安装，默认扫不到；仍进名单，装上就挡）。
2. `scripts/scan-dsh-tool-names.mjs`：假名判定排除可选组，并在输出里点名说明。
3. `scripts/verify-dsh-021-adaptation.mjs`：新增 `GUARD_021_NAMES` 断言。
4. `scripts/test-preset-local-tools.mjs`：本地执行工具清单同步补齐（restrict 覆盖 + 执行期拒绝两条断言）。

### 3.5 怎么验证

```powershell
node scripts/scan-dsh-tool-names.mjs --missing   # 悬空 0，未覆盖危险名 0
node scripts/test-preset-local-tools.mjs         # 7/7
node scripts/verify-dsh-021-adaptation.mjs       # 75 通过 0 失败
```

守卫是 preset 行 import 的模块，运行中的 DSH 按 URL 缓存；**已经开着的会话**仍用旧名单，
新建会话才用新名单。彻底生效（含既有会话）重启一次 `dsh web` 即可，确认信号：
`state/tool-restrict.log` 里 `restrict ok=3` → `ok=4`，且失败样例里不再有全局工具。

---

## 4. 逐条核对 0.2.1 发布说明：判定"无需改动"

| 0.2.1 变更 | 对桥接的影响 | 处置 |
|---|---|---|
| 移除运行时 `invariant` 插件与 `./invariant` 导出 | 桥接与三个 bundle 都没用 | 无 |
| 子路径插件不再读独立 `package.json` | `qq-mode-console` 是普通单入口插件 | 无 |
| 输入区统计扩展拆成 `activity` / `usage` | 桥接与插件都没有 composer 统计扩展 | 无 |
| 移除工具展示 `both` 混合模式 | preset 里没有配置 `presentation` | 无 |
| `agent-instructions` 逐行 `dshHome` 移除 | QQ preset 未挂 `agent-instructions` | 无 |
| Agent Team 消息改投目标 Inbox | 未启用 team 模式 | 无 |
| 子代理工具立即返回 child ID | 桥接不依赖子代理返回体 | 无 |
| 自动化任务改为 Web 内置（`schedule` 转正） | 守卫早已覆盖 `schedule_*` | 无 |
| 第三方插件兼容性优先看 `engines.dsh` | 三个 bundle 未声明 `engines`，回退 peer 规则，实测全过 | 无 |
| API Key 优先级变更（Web 优先已保存凭据） | 桥接走 Cookie 铸造 + MCP，不读 API Key | 无 |
| pi-ai 1.0.2、DeepSeek-V4.1-Flash-1017 | `modelCatalog` 仍给 `deepseek-flash`，桥接默认模型不变 | 无 |
| `dsh-client-ui-primitives` 等不再随 dsh 附带 | 与桥接无关 | 无 |
| **提示词变量表移除 `cwd`** | **两个 preset 的 persona suffix** | **§2 已修** |
| **`dsh-base` 默认挂 `working-directory`** | **全局工具面多一个名字** | **§3 已修** |

---

## 5. 验证记录（2026-10-22，运行中的 0.2.1-rc.2）

| 套件 | 结果 |
|---|---|
| `verify:adaptation`（活 DSH，75 项，含真跑一回合） | **75 通过 / 0 失败** |
| `probe-tools qq-chat-v2`（真调 MCP 工具） | 工具调用成功、未调本地工具 |
| `scan:tool-names` | 82 个名字；悬空 0；未覆盖危险名 0 |
| `verify-persona-config` | 14 项全过（含"只引用已注册变量"） |
| `test:plugin`（qq-mode 宿主插件） | 6/6 |
| `test:mcp-servers`（三个 MCP server 握手 + 工具表） | 33 + 1 + 2 工具，全部正常 |
| `test:dsh-auth` | 17/17 |
| `test:dsh-inbox` | 12/12 |
| `test:session-retire:e2e` | 10/10 |
| `self-test`（真起会话 + prompt + 回合完成） | 通过（回复"收到"） |
| `test:setup-idempotent` / `test:preset-prompt` / `test:reply-wait` | 通过 / 12 通过 / 10 通过 |
| `test:hardening` / `test:issues` / `test:audit-regressions` | 全部通过 |
| `test:audit` | 35/35 脚本通过 |
| 两个 preset 的实际挂载 | `qq-chat`、`qq-chat-v2` 均成功 |

---

## 6. 下次 DSH 升级的增量清单

沿用 [DSH_020_ADAPTATION.md §10](DSH_020_ADAPTATION.md#10-下次-dsh-升级的操作清单可复用)，本轮补充三条：

1. **`verify:adaptation` 必须有"真跑一回合"**：静态断言看不出提示词变量被删。
   本轮之前它只查"preset 里有没有 `{{cwd}}`"，而 `{{cwd}}` 恰恰是坏的那个。
2. **先看 `state/tool-restrict.log` 的 `known global tools`**——它是"全局层到底有什么"的第一手证据，
   新增名字基本等于 1 个必须补的守卫条目。别只看 `restrict ok=` 的分子：大部分名字是 scoped 工具，
   restrict 对它们本来就抛错，要看的是**失败样例里有没有全局工具**。
3. **升级后立刻跑一次 `node scripts/probe-tools.mjs qq-chat-v2`**：它同时覆盖
   persona 装配、工具面、MCP 调用三条链路，是全仓库最便宜的一次端到端体检。
