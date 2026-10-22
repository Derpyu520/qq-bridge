# DSH 0.2.0 适配改动记录（qq-bridge v0.1.7 → v0.2.0）

> **本文的边界**：只记录**为适配 DSH 0.2.0-rc.2 而做的改动**。每一条给出四件事：
> 现象 / 为什么必须改 / 证据 / 怎么验证。
>
> 同批但不属于适配本身的改动（依赖告警清理、沙箱 ACL 诊断工具）在 **§7** 单独列，
> 避免把"顺手做的"算进"适配必须做的"。
> 复核后**判定兼容、因此没改**的部分在 **§8** —— "没改"同样是结论，而且是省下返工的那种。
>
> 适配目标：`@deepseek-ai/dsh` **0.2.0-rc.2**（上一版适配目标是 0.1.7-rc.2）。
> 对应提交：`e43186a`（主体）；本文写于 2026-10-02。

---

## 0. 一句话结论

**0.2.0 的协议面基本没动**：桥接用到的 14 个 RPC、`$events`/waterfall 帧、`session/follow` 快照、
`settings/update` 参数形状、三个 MCP server 的握手与工具命名，全部实测兼容。

**真正需要改的是三处**，而且其中**最严重的一处并不是 0.2.0 造成的**（见 §2.1 的事实核对）：

1. 会话待处理队列读不出来 ⇒ **每一次**退役/重置 QQ 会话都在抛错，旧任务继续跑；
2. QQ 安全守卫的名单没跟上 0.2.0 的真实工具面（新增了能绕过 L7 的口子）；
3. `qq-mode` 设置命名空间的注册 API 被 0.2.0 删除（旧代码靠一句早退"看起来正常"）。

外加一处**0.1.7 时代遗留、本轮一并清零**的适配缺口：9 个诊断/运维脚本的鉴权路径早已失效（§5）。

---

## 1. 改动总览

| # | 文件 | 改动 | 对治的问题 |
| --- | --- | --- | --- |
| 1 | `src/dsh-client.js` | 新增 `inboxItemsOfProjections` / `inboxItemIds` / `controlBaselineInboxItems`；`_readSessionQueue` 改为「`session/projections` 主路径 + `session/control` 回退」；`METHOD_ARG_WRAPPERS` 增加 `session/projections` | §2 队列读不出来 |
| 2 | `plugins/qq-agent-presets/qq-tool-restrict.mjs` | restrict 名单 **52 → 67**，补 15 个名字 | §3 工具面漂移 |
| 3 | `scripts/dsh-tool-names.mjs`（新增） | 工具名抽取的**唯一实现**（原测试里那份模糊抽取器误报真名） | §3 对账工具 |
| 4 | `scripts/scan-dsh-tool-names.mjs`（新增） | 拿安装包与守卫名单双向求差的 CLI（`npm run scan:tool-names`） | §3 对账工具 |
| 5 | `plugins/qq-mode-console/lib/index.js` | 删掉 0.2.0 已移除的 `ctx.settings.register()` 死路，`apply()` 改为显式空实现 | §4 设置命名空间 |
| 6 | `scripts/test-qq-mode-plugin.mjs` | 重写为 6 项，钉住命名空间可用的三点前提 + 「不许把已删除的 API 加回来」 | §4 |
| 7 | `scripts/probe-auth.mjs`（新增）+ 5 个探针 + 4 个运维脚本 | 鉴权统一走离线铸造 Cookie；夹具改到系统临时目录 | §5 遗留缺口 |
| 8 | `scripts/probe-020-protocol.mjs`、`probe-020-settings.mjs`（新增） | 0.2.0 契约探针（帧结构 / settings 命名空间） | §2 §4 取证 |
| 9 | `scripts/test-dsh-inbox-projection.mjs`（新增，12 项） | 用**真实 0.2.0 帧骨架**钉住队列解析（离线，已进 `test:audit`） | §2 回归网 |
| 10 | `scripts/test-dsh-session-retire.mjs`（新增，11 项） | 活 DSH 端到端：退役会话必须成功且真的清掉队列 | §2 回归网 |
| 11 | `scripts/test-audit-protocol.mjs` | 3 条会话退役用例按两条路径重写（含 0.2.0 形状断言） | §2 回归网 |
| 12 | `scripts/verify-dsh-015-adaptation.mjs` → `verify-dsh-020-adaptation.mjs` | 活 DSH 段重写为 0.2.0 契约；语法检查在禁止 spawn 的环境改为**显式跳过**而非假失败 | §6 |
| 13 | `scripts/test-preset-local-tools.mjs` | 删掉自带的模糊抽取器，改用 §3 的唯一实现；名单同步 | §3 |
| 14 | `scripts/test-audit.mjs` | 清单加入 2 个新脚本（28 → 30） | §6 |
| 15 | 版本身份：`package.json`、`package-lock.json`、两个插件包、三个 MCP serverInfo | 0.1.7 → **0.2.0** | §6 |
| 16 | 文档：`README.md`、`README.en.md`、`RULES.md`、`docs/FOLDER_MAP.md`、`docs/guides/DSH_SETUP.md`、`docs/guides/SECURITY_BASELINE.md`、`docs/guides/PROJECT_GUIDE.md` | 版本行、preset 安装位置、鉴权说明、脚本清单、过期清单 | §6 |

---

## 2. 断裂点一：会话待处理队列读不出来（改动最大，也最容易被忽略）

### 2.1 事实核对：**这不是 0.2.0 引入的**

这一点必须写在最前面，因为它改变了这条改动的定性：

- 读队列的代码（`frame.value.value?.queues`）由提交 `288642d`（**2026-09-18**）引入，
  并**随 v0.1.7 发布**（`git merge-base --is-ancestor 288642d ce726bb` 成立）。
- `state/bridge.log` 里有 `invalid session/control baseline` 报错，时间是 **9/27 21:37** 与 **9/28 08:16**。
- DSH `0.2.0-rc.2` 的发布时间是 **2026-09-29**。

⇒ 报错**全部发生在 0.1.7-rc.2 上**。也就是说：**这段解析从来没有工作过**，不是 0.2.0 改坏了它，
而是 0.2.0 期间做契约探测时才被翻出来。

> ⚠️ 勘误：v0.2.0 的 README 与提交信息把这个缺陷描述成「0.2.0 把队列挪进了 projections」，
> 那个归因是**错的**（已在本轮修正 README）。本仓库不再保留 0.1.7 安装，因此**无法断言
> 0.1.7 的 baseline 形状到底是什么**；能确定的只有：`queues` 不是它。

### 2.2 现象

桥接退役/重置 QQ 会话时要先清掉 DSH 侧还没跑的队列，再取消当前 turn（`stopSessionWork`）。
日志里每次都是：

```
⚠️ 停止旧会话失败 session-…: invalid session/control baseline；请在 DSH 检查旧任务
```

后果不是"少清几条"：**队列清不掉 ⇒ 旧任务继续在 DSH 里跑、继续烧 token**，
而唯一的信号就是那一行警告（不影响启动、不影响收发，所以很容易被当成噪音）。

### 2.3 0.2.0 的实际契约（实测）

`session/control` 的开场 baseline（`scripts/probe-020-protocol.mjs` 采样，逐键确认）：

```
{ type: 'baseline',
  value: { projections: {
    '<sessionId>': { asOfSeq, values: {
      inbox: { 'next-turn': UserMessage[], 'next-step': UserMessage[] },
      title, goal, tokenUsage, ... } } } } }
```

每条 inbox 项的形状（**这就是 `session/updateQueue` 需要的 `itemId` 来源**）：

```
{ content: [{ type:'text', text }], source: { kind:'user', rpcId }, role:'user', id }
```

同时确认 0.2.0 提供一元 RPC `session/projections`（非激活读取）：

```
POST /api/session/projections   { request: { sessionId } }
  → { asOfSeq, values } | null      （null = 会话不在宿主注册表里）
```

### 2.4 改法

- **主路径**改为 `session/projections`：一条普通 HTTP RPC，不开 WebSocket、可取消、可超时、可单测；
  `null` 视为「没有待处理项」（会话已归档/未挂载）。
- **回退路径**保留 `session/control`，但按 0.2.0 形状解析 `projections[<id>].values.inbox`。
- 解析逻辑抽成**具名导出**（`inboxItemsOfProjections` / `inboxItemIds` / `controlBaselineInboxItems`），
  测试可以直接钉住，不必去戳私有方法。
- **结构不符就显式抛错**：静默返回空数组正是这个缺陷的形态——"清不掉却毫无提示"。
  但"能力缺失"（没有 inbox 键 / `values` 为 null）与"结构变了"要分开：前者返回空，后者抛错。
- `stopSessionWork` 的读队列失败**不阻断** `session/cancel`（保持原设计：读不到也要停当前 turn）。

### 2.5 怎么验证

| 测试 | 类型 | 内容 |
| --- | --- | --- |
| `npm run test:dsh-inbox`（12 项） | 离线，已进 `test:audit` | 用真实采样帧骨架钉住层级与键名；断言旧 `queues` 形状**不再被接受**；断言结构异常必须抛错 |
| `npm run test:session-retire:e2e`（11 项） | 需活 DSH | `session/projections` 可用、baseline 带 `projections` 且**没有** `queues`、`stopSessionWork` 成功返回、排队中的消息真的被清掉（实测 `removed: 1`）、退役后队列为空 |
| `test-audit-protocol.mjs`（4 项） | 离线夹具 | 主路径不开 socket；回退路径按 0.2.0 形状只删自己的项；超时关 socket；读失败仍取消 turn |

---

## 3. 断裂点二：QQ 安全守卫名单没跟上 0.2.0 的工具面

### 3.1 为什么这是安全问题而不是清洁问题

守卫有两道闸门：注册期 `tools.restrict({deny})`（把工具从模型 schema 里**隐藏**）与
执行期 `tools.guard` 白名单。`restrict` 对**不存在的**工具名会抛错，而守卫是逐个 `try/catch`
的 ⇒ 拼错/过期的名字 = **静默 no-op**；反过来，DSH 新版本**新增**的能力若没进名单 =
该隐藏的工具留在仿真会话的 schema 里。两类漂移都只能靠"拿安装包重新对账"发现。

### 3.2 对账工具（新增）

- `scripts/dsh-tool-names.mjs`：从已安装的 `@deepseek-ai/dsh-*` 与用户插件里抽真实工具名
  （锚定 `register(defineTool({ name }))` / `toolName:` / 任意层级的 `*.patch.yml`）。
- `scripts/scan-dsh-tool-names.mjs`：`npm run scan:tool-names`，双向求差并给退出码。
- **抽取实现只有一份**，扫描器与 `test-preset-local-tools.mjs` 共用。

> 顺带修掉一个危险缺陷：`test-preset-local-tools.mjs` 原先自带一份**模糊**抽取器
> （全文件乱扫 `name: 'x'` + 只认少数包名前缀 + 只读包根目录的 patch）。0.2.0 对账时它把
> **10 个真实存在**的工具名报成"假名"——`dsh-mcp-resources`、`dsh-experimental-tool-agent-team`
> 不匹配它的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而非包根。
> **误判方向很危险：它会逼人把真名字从安全名单里删掉。**

### 3.3 对账结论：旧名字全在（0 假名），新增 15 个

扫描器按"危险语义"报出 13 个，人工补齐 `read_mcp_resource` 的两个兄弟后实际新增 **15** 个
（守卫 52 → 67）。逐条判定：

| 组 | 名字 | 为什么必须隐藏 |
| --- | --- | --- |
| ① **全局层默认启用，仿真会话真的会继承** | `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | `dsh-base` 的 `mcp-resources` 行**没有被 disabled**，所以每个 QQ 会话都拿到这三个工具。`read_mcp_resource` 的 `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了 filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权 |
| ② 派生 agent / 执行外部代码 | `subagent_codex`、`subagent_claude_code`、`spawn_teammate`、`team_task_{create,get,list,update}` | Codex / Claude Code 子智能体与实验性 Team 模式都能间接拿到 shell。当前只在 DSH 自带 preset 里挂载，列进来是**回归网**（别的 composition 一旦推进全局层就被挡住） |
| ③ 插件装载权 = 任意代码执行 | `plugin_manager` | 安装/卸载/启停插件，内部会 spawn pnpm |
| ④ 无人值守的自我调度 | `schedule_{create,list,update,delete}` | 0.2.0 起 `dsh-schedule` 是可选 bundle，装上就是"agent 给自己排定时任务" |

### 3.4 怎么验证

`npm run scan:tool-names` → 悬空（假名）0 个、未覆盖的危险名 0 个；
`npm run test:preset-local-tools` 7 项全过；`verify:adaptation` 增加两条对应断言。

---

## 4. 断裂点三：`qq-mode` 设置命名空间的注册 API 被删除

### 4.1 现象（不明显，因为被一句早退挡住了）

DSH 0.2.0 删除了 `ctx.settings.register(ns, schema, opts)`——`SettingsForms` 的公开面只剩
`configure` / `writable` / `documentPath` / `prepareDocument` / `describe` / `update` / `replace` / `mutate`。
命名空间改为**从 profile 的 loader entry 推导**。

插件原来的 `apply()` 第一句就是 `if (!settings || typeof settings.register !== 'function') return;`，
所以它**静默早退**：不报错、不影响功能，但那段代码变成了死路，而且注释还在教后来人用已删除的 API。

### 4.2 实测：命名空间本身完全正常

在 0.2.0 上实测（`npm run probe:settings` / `verify:adaptation`）：

- `settings/describe` 列出 **20 个**命名空间，其中**有** `qq-mode`，`value = {"mode":"reserved2"}`，带 `revision`；
- `settings/update` 写回成功并返回 `SettingsNamespaceView`。

即三点前提在 0.2.0 依然成立且是唯一路径：**① entry id 恰好等于命名空间名**（`cordis.patch.yml` 的
`id: qq-mode`）、**② 插件模块导出 `Config`**、**③ `Config` 至少一个 `volatile` 字段**。

> 附带更正一条 0.2.0 的接口形状：`settings/update` 是**多参数** RPC，args 是
> `{ ns, patch, expectedRevision }` **平铺**，不是 `{ request: {...} }`
> （传 request 会被网关拒为 `gateway/arguments-invalid: missing "ns", "patch"; unexpected "request"`）。
> 桥接原本就是平铺调用，**无需改动**——但这条值得写下来，因为它极易踩。

### 4.3 改法

- `apply()` 改为显式空实现 + 一行诊断日志（证明 entry 真的被装配过），**不再触碰 `settings.register`**；
  也不改成 `settings.configure({auto:false})`——那会关掉自动设置页策略，与默认行为相反。
- 注释按 0.2.0 重写，说明为什么 0.2.0 下"什么都不用做"。

### 4.4 怎么验证

`test-qq-mode-plugin.mjs` 重写为 6 项：导出形状、entry id 等于命名空间名、`Config` 可用且带 volatile
（含 schemastery `toJSON()` 的**引用表**形状——顶层是 `{uid, refs}`，dict 在 refs 里）、
schema 接受全部 mode 拼写、**不再出现 `settings.register`**（只看可执行代码，剥注释）、
以及缺 settings 服务时不抛。活 DSH 侧由 `verify:adaptation` 的 qq-mode 段覆盖。

---

## 5. 适配缺口四：探针与夹具的鉴权/落盘路径（0.1.7 遗留，本轮清零）

**这一条不是 0.2.0 造成的**，是 0.1.7 改动留下的尾巴，因为这次要大量用探针才暴露出来。

- **鉴权**：六个探针 + 四个运维脚本各自复制了一份"从 `~/.dsh/guard/logs/server-*.out.log` 抓
  `?token=` 再换 Cookie"的引导。这条路在 0.1.7 就死了（启动 token 只存在内存、日志里是上一个进程的
  陈旧值），于是一律 401 —— **诊断工具本身坏了，而且没人会注意到**（探针不在回归套件里；
  生产代码当时修好了，工具没跟上）。
  → 新增 `scripts/probe-auth.mjs`，统一走本机签名密钥离线铸造 Cookie，并提供
  `probeRpc` / `probeMuxSocket` / `probeWorkspaceDir`；9 个脚本全部改用它。
- **落盘**：探针与测试夹具原先写在仓库 `state/` 下。`state/` 被 `harden-state-acl.mjs` 收紧了 ACL
  （见 §7.2），在 DSH 沙箱会话里**写不进去**（EPERM）。
  → 探针、`self-test`、`test-setup-dsh-idempotent`、`test-dsh-v2-wait` 的临时产物全部改到系统临时目录。
  迁完后 `npm run self-test` 在沙箱里也能完整跑通。
- 删除 `scripts/probe-015.mjs`（0.1.5 专用，已被 verifier 取代，走的是旧点号协议路径）；
  同一用途由 `probe-020-protocol.mjs` 承担。

---

## 6. 版本身份、验证脚本与文档

### 6.1 版本身份 0.1.7 → 0.2.0

沿用项目约定（版本号与 DSH 对齐）。改动点：`package.json`、`package-lock.json`（顶层 + `packages[""]`）、
`plugins/qq-mode-console/package.json`、`plugins/qq-agent-presets/package.json`、三个 MCP server 的
`serverInfo.version`。全部由 `verify:adaptation` 的既有断言钉住（防止再次出现"自报版本与包版本不一致"）。

### 6.2 验证脚本改名与重写

`verify-dsh-015-adaptation.mjs` → **`verify-dsh-020-adaptation.mjs`**
（0.1.7 那次为了不打断调用方沿用了旧文件名，结果留下一个"自称 015 却在验 0.2.0"的脚本；
`npm run verify:adaptation` 入口名保持不变，所以既有调用不受影响）。

活 DSH 段按 0.2.0 重写，新增/保留：qq-mode 可列可写、`session/projections`、
**control baseline 形状（有 `projections`、无 `queues`）**、`stopSessionWork` 不抛、
`$events` ready 帧、`session/modelCatalog`、点号 endpoint 仍 404。
语法检查在禁止 spawn 的环境里改为**显式记 `⏭ 跳过`**，而不是输出 8 条假失败把真失败淹掉。

### 6.3 文档纠偏（原文与代码不符的地方）

| 文档 | 原问题 |
| --- | --- |
| `README.md` / `README.en.md` | 版本行停在 0.1.7；`README.en.md` 更旧，仍停在 v0.1.5，且**仍在介绍已删除的 `start_snowluma`/`stop_snowluma`**；preset 安装位置写成已废弃的 `~/.dsh/.agent-presets/`；`dsh.authToken` 说明仍在讲"从 guard 日志自动发现" |
| `docs/guides/DSH_SETUP.md` | 同上（preset 位置、命名空间机制、401 排查步骤）；断言项数 45 → 65；EPERM 的说明改为"显式跳过" |
| `docs/FOLDER_MAP.md` | 脚本数、被删/新增脚本、探针状态 |
| `docs/guides/SECURITY_BASELINE.md` | 守卫两道闸门与对账工具；回归清单脚本数与新增命令 |
| `RULES.md` | preset 修改说明指向已废弃目录 |
| `docs/guides/PROJECT_GUIDE.md` | 它是历史说明书（文首自带"已过时"清单），补了第 3、4 条：preset 机制、鉴权链路 |

---

## 7. 同批但**不属于** 0.2.0 适配的改动

写在这里是为了不把它们混算成"适配必须做的"。

### 7.1 依赖告警清理（提交 `0595862`）

`fast-uri` 3.1.7→3.1.8、`ip-address` 10.5.0→10.7.3。两者都是
`@modelcontextprotocol/sdk@1.30.0` 的**传递依赖**（经 `ajv` / `express-rate-limit`），
在 0.1.7 时代就存在，与 0.2.0 无关。影响面也小：告警文案提到 SSRF 绕过，而本项目自己的
SSRF 防护 `src/safe-fetch.js` 是独立实现、**没有用 `ip-address`**；`express-rate-limit` 只在
HTTP transport 下起作用，而三个 MCP server 全是 stdio。清掉是为了让已发布版本的门面干净：
`npm audit` → 0，GitHub 上 5 条告警全部转为 fixed。

### 7.2 沙箱 ACL 与 `state/` 收紧的交互（提交 `ede38e3`）

适配过程中发现「DSH 沙箱会话写不进 `state/`」。查清后**结论是"这是有意的取舍，不是缺陷"**：

- DSH 沙箱按**能力 SID**（`sha256(规范化工作区路径)` 派生）授权，写权限**只能靠工作区根上那条
  可继承 ACE 沿继承链传下来**；DSH 只在首次进入工作区时下发一次，之后既不重发也不修复。
  被 `/inheritance:r` 切断继承的对象对它**永久不可写，且失败是静默的**。
- 而 `harden-state-acl.mjs` 正是用 `/inheritance:r` 收紧 `state/` 与 `config.json`——
  Windows 上 `mode 0o600` 是空操作，这是防"本机其他用户读走令牌"的唯一手段。
  **代价（沙箱里写不了 state/）已被接受**，项目的规矩随之明确：沙箱里跑的东西一律不写 `state/`（§5 已落实）。
- ⛔ 因此**绝不能**用 `/inheritance:e` 去"修好" `state/`：实测确认恢复继承会把父目录的
  `Authenticated Users: Modify` 与 `BUILTIN\Users: ReadAndExecute` 一起带回来，等于把凭据重新开放。
- 顺带发现 `plugins/qq-agent-presets/**` 与 `plugins/qq-mode-console/**` 的内容也被切断了继承，
  而**本仓库没有任何脚本这么做**（全历史 `-S` 搜索 + 已安装插件扫描都没有），来源不明。
  这两处不含凭据，是否恢复由使用者决定。

新增 `npm run diagnose:acl`（只读盘点，只对"非预期"那类打印恢复命令），
并在 `SECURITY_BASELINE.md` 加 §2.6 与残余风险 R10/R11。

---

## 8. 复核为「兼容、无需改动」的部分（这些"没改"也是结论）

| 面 | 结论与证据 |
| --- | --- |
| **RPC 面** | 枚举 0.2.0 全部远端 endpoint（约 140 个）后逐条比对：桥接用到的**每一个都还在**——`session/{list,create,prompt,cancel,selectModel,rename,fork,updateQueue,page,search,follow,modelCatalog}`、`workspace/{create,rename,delete,archiveSession,insertBefore,insertSessionBefore}`、`agentPresets/list`、`settings/describe`。点号 endpoint 仍 404（协议确为斜杠式） |
| **`$events` / 审批提问链路** | `$events`、`$events/result` 仍在；waterfall 帧形状不变 `{type:'waterfall', event, eventId, agentId, request}`；`approval/request` 与 `user-questions/request` 仍在 `API_REMOTE_FORWARDED_EVENTS` 白名单里；`request.toolName/callId/reason` 与 `request.questions` 字段未变；outcome 形状 `{kind:'next'|'result'|'rejected'}` 与网关校验一致 |
| **`session/follow`** | 请求形状 `{ address:{kind:'session',sessionId}, maxMessages }` 未变；快照键集与 `projections` 仍在 |
| **三个 MCP server** | DSH 客户端已升级到官方 SDK **v2**，而 server 用的是 v1.30.0：实测五个协议修订版本两侧完全一致，`server/discover` 探测失败会**干净回落**到 2025 握手；`toolCallTimeoutMs` / `serverName` / `mcp__<server>__<tool>` 命名规则 / `serverInfo` 形状均未变；MCP 输入 schema **原样透传**（harness 的 JSON Schema 子集只约束 output schema，因此 ~20 处 `z.union` 产生的 `anyOf` 不受影响）。活链路实测：`mcp__snowluma__qq_status` 返回真实账号信息，三个 server 共 **38** 个工具 |
| **模型目录** | `deepseek-flash` 仍在（新增 `deepseek-v4-pro`），思考档位 `off/low/high/max`。控制台把 `off` 过滤掉是**有意的产品决策**（QQ 聊天助手依赖思考），与内置白名单自洽，未改；实测 `/api/dsh/model` 返回 `options:["low","high","max"]` 且 `labels` 里带 `off`，说明动态读取链路在 0.2.0 正常 |
| **`settings/update` 参数形状** | 是平铺多参数（见 §4.2），桥接原本就对 |
| **preset / bundle 机制** | `@deepseek-ai/dsh-agent-preset` 行 + `plugins/qq-agent-presets` bundle patch 仍有效；两个 preset 的 persona schema 仍通过；`id: qq-mode` 行 + 导出的 `Config` 仍能让命名空间可读写（§4.2） |
| **`session/create` + preset** | 活 DSH 实测：挂 `qq-chat-v2` 成功，`agentPresets/list` 含 `qq-chat` 与 `qq-chat-v2` |
| **`session/modelCatalog`** | 仍可用，返回 `default` / `routableProviders` / `groups` / `failures`，桥接的思考强度下拉依赖它 |

---

## 9. 验证记录（2026-10-02）

### 9.1 自动化

| 命令 | 结果 |
| --- | --- |
| `npm run test:audit` | **30/30 脚本通过**（清单新增 `test-dsh-inbox-projection.mjs`、`test-qq-mode-plugin.mjs`） |
| `npm run verify:adaptation` | **73 通过 / 0 失败**（含 8 项语法检查；在禁止 spawn 的环境里这 8 项显式跳过，计 65） |
| `npm run test:dsh-auth` | 17 项通过 |
| `npm run scan:tool-names` | 悬空假名 0 / 未覆盖危险名 0（扫 282 个包） |
| `npm run verify:persona` | 全过 |
| `npm run test:mcp-servers` | 3 个 server 共 38 个工具全部接入正常 |
| `npm run self-test` | 端到端：DSH 连接 → 建会话 → prompt → 收到回复 → 归档，通过 |
| `npm run test:setup-idempotent` | 通过 |
| `npm run privacy-scan` | `git ls-files` 139 个文件，未发现敏感信息 |

> 环境说明：语法检查、MCP stdio、setup 夹具这几类需要 spawn 子进程，
> 在 DSH 沙箱会话里会被系统拦成 EPERM。**那是环境限制，不是代码问题**——
> 上面这些数字是在无沙箱终端下取得的；只在沙箱里跑时，相关项会显式标为跳过。

### 9.2 真实 QQ 链路实测（活群）

在真实白名单群里跑通了一个完整来回（记录取自 `state/`）：

| 时刻 | 发生的事 |
| --- | --- |
| 22:07:45 | 入站：`@小鲸鱼`（owner）→ 进未读队列 |
| 22:07:54 | 桥接**新建 DSH 会话**、挂上 `qq-chat-v2` preset、模型固定 `deepseek-official/deepseek-flash (max)` |
| 22:07:56 | agent 调 `qq_get_prompt` → 拿到会话令牌与人设 ✅ |
| 22:08:02 | agent 调 `qq_send_message` → **成功 2/2 条** |
| 22:08:15 | 入站：`没事` |
| 22:08:29 | agent 再发 1 条 → **成功 1/1** |

一条链路同时验证了：0.2.0 的 **preset bundle 机制**、**离线铸造 Cookie 鉴权**、
`session/selectModel`、三个 **MCP 工具**的活调用，以及人设确实在起作用（短句、不像客服、不汇报）。

### 9.3 回归网的意义

§2 那个缺陷此前**没有任何测试覆盖**——线上只表现为一行日志，两个版本都没人发现。
本轮补的两个测试（一个离线钉结构、一个活 DSH 钉行为）就是针对这个失败形态：
**契约变了要红，而不是静默漏水**。

---

## 10. 下次 DSH 升级的操作清单（可复用）

1. `node scripts/verify-dsh-021-adaptation.mjs`（先看红在哪；活 DSH 段是主要信号）。
2. `npm run scan:tool-names` —— **每次升级必跑**。守住两类漂移：假名静默失效、新能力漏隐藏。
3. `node scripts/probe-020-protocol.mjs` —— 采样 `session/control` / `session/follow` / `$events` /
   `session/cancel` 的**原始帧结构**，与本文 §2.3 §8 对账。
4. `node scripts/probe-020-settings.mjs` —— 命名空间是否还在、是否还可写。
5. `npm run test:dsh-inbox` + `npm run test:session-retire:e2e` —— 队列与退役路径。
6. `npm run test:audit`（30 个脚本）与 `npm run verify:persona`。
7. 若 DSH 改了 preset / 插件装载机制：`node scripts/setup-dsh.mjs` 后重启 DSH，再看
   `npm run test:setup-idempotent`。
8. `npm run privacy-scan` + `npm run diagnose:acl`（后者需在**无沙箱**终端跑）。

---

## 附：v0.2.0-r3 —— SnowLuma 上游健康、客户端库升级、全新 clone 可移植性

> **版本说明**：本节内容曾以 `v0.2.1` 这个标签发布过约 26 分钟，随后因改用
> 「主版本与 DSH 同步 + `rN` 后缀」的方案，该标签与对应 Release **已撤回**。
> 提交本身仍在 `main` 历史里，内容 100% 包含在 `v0.2.0-r3`，撤回不影响任何功能。
> 完整序列见本节 H。

v0.2.0 发布后，有人反馈「**QQ 注入失败**」。调查后修了三类问题。
**这一节与 DSH 无关**，属于 SnowLuma 侧观测能力与打包质量。

### A. 起因与结论：那个报障**不是**本桥接造成的

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**
（它日志里叫 `[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。
本桥接**没有任何原生/注入面**：7 个依赖全为纯 JS，`src/` 里没有 `.dll`/`.node`/FFI/进程注入，
也不启动、不控制 SnowLuma 或 QQ（v0.1.5 起按 EULA §5.4 移除了启停工具）。

但**桥接让这个失败无法诊断** —— 这才是要修的：

| SnowLuma 的 `[Hook]` 退化时 | 桥接此前看到的现象 |
| --- | --- |
| 进程与 OneBot WebSocket **都还活着** | `bot.on('open')` 打过「SnowLuma 已连接」 |
| 但收不到 QQ 侧数据（`receive path stale`） | 群里一条消息都不来 |
| 它自己报 `good=false` | 桥接**从不读 `good`**；没有看门狗（对比：DSH 有 5 秒探活）、`/api/status` 没有字段、控制台没有指示、文档没有排查分支 |

⇒ 症状是「接了但没反应」，而**没有任何证据指向 SnowLuma**，于是被报成「qq-bridge 注入失败」。
用户自己的 SnowLuma 日志里 `receive path stale` 出现过 4 次（3 次自愈）—— 这个状态是**常态化偶发**，
不是别人的特殊环境。

**修复**：桥接现在把上游健康报出来（`/api/status.snowluma` + 控制台「运行总览」卡片 +
「访问与安全」告警条 + 边沿触发日志），并明确指向 SnowLuma 的 `[Hook]` 日志。判定分两级：
`good=false` 是**确认**；「连心跳都没有」是**另一个故障面**（进程/WS 层面），措辞分开。

### B. 上游健康的两处实现错误（做完就发现是错的，已修）

这两条值得单独记，因为它们是**同一个失败形态的复现** —— "看起来在工作，其实永远不会触发"：

| 错法 | 后果 | 正确做法 |
| --- | --- | --- |
| `good` 取自 **`get_login_info`** | 它只返回 `{user_id, nickname}`，`good` 永远 `undefined`；而 SDK **只校验 status/retcode 信封、不校验 data 载荷** ⇒ 不报错、`good` 永远停在 `null`，那条"权威信号"整条是**死代码** | 取自 **`get_status`**（`{online, good}`），以及**每 30 秒心跳载荷里的 `status.good`** |
| 用心跳/事件**静默**判断 hook 死活 | 心跳由 SnowLuma **自己的定时器无条件**发出（`HEARTBEAT_INTERVAL = 3e4`），不经过 QQ 事件流水线 ⇒ 静默**永远不触发**，检测不到它声称要检测的东西 | 接收链路的健康度只在 `status.good` 里；静默只能说明**进程/WS 卡住**，是另一个故障面 |

两条都实测核对过 SnowLuma 1.14.9 运行时源码，并用 `npm run probe:heartbeat` 连真实网关验证：
`status = {"online":true,"good":true}`、`interval = 30000`。
新增 `test-snowluma-upstream-health.mjs`（9 项）把这两条钉住 —— 特别是**反面断言**：
不得从 `get_login_info` 取 `good`、静默分支不得把结论指向 `[Hook]`。

### C. 客户端库升级 1.14.9/1.14.10 → 1.14.20

- 上游 1.14.9→1.14.20 共 **139 次提交 / 300 个文件**。逐面核对（含 190→195 动作目录双向 diff）：
  **无移除动作、无参数改名、无入站事件形状变化、无 stdout 风险**（`@snowluma/mcp` 在 `src/` 里零引用，
  且它只往 stderr 写）。
- **上游打包 bug 仍在**（dist 相对导入缺 `.js`），`postinstall` 补丁依旧必需（仍命中 13 个文件）。
- 顺带修两处**只影响升级运行时之后**的正确性问题：
  `markdown` 段落此前落到 default 分支、被喂字面量 `[markdown]`（上游 1.14.17 的 changelog 里列为 `1934e4e7`；
  **实测 1.14.20 的线上段落是 `data:{content}`**，桥接读 `d.text ?? d.content`，两个形状都覆盖）；
  图片段落读的是 camelCase `subType` 而线上字段是 snake_case `sub_type`（一直是空串，且不报错）。
- 新增 `npm run probe:heartbeat`：只读探针，验证心跳字段是否真的存在。

### D. 端点自愈会覆盖用户写的 `wsUrl`

`applyHealedTokens` 会把**发现到的** `wsUrl` 无条件写回 `config.json`。主场景（换账号端口变了）是对的，
但它不区分「配置里是过期值」与「用户就是要指向别处」。实测踩到：把 `wsUrl` 指向死端口想让它别连，
启动后仍被改回真实端点并连上 —— **想跑第二实例/指向另一份 SnowLuma 安装时会连错账号**。
新增 `snowluma.followDiscoveredEndpoint`（默认 `true`＝保持既有行为），设 `false` 则只自愈 token、绝不动 URL。

### E. 全新 clone 上 `npm run test:audit` 会失败 7 个脚本（真实的打包缺陷）

用一个真的 `git clone` 复现的（作者机器上全绿，所以一直没人发现）：

| 原因 | 影响的脚本 |
| --- | --- |
| 引用 `../voice-tool/...` —— 语音工具是**仓库上一级**的独立工具，不在本仓库里，测试却按固定相对路径读它 | 6 个 |
| 读 `config.json` —— 它按设计是 gitignore 的，仓库里只有 `config.example.json` | 2 个（其中一个被前一个崩溃掩盖了） |

⇒ 任何照 README 克隆的人跑自检都会看到一堆红，**看起来像"这个项目装出来就是坏的"**。

**修复**：新增 `scripts/voice-tool-locator.mjs` 统一解析位置（支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖），
缺目录时**明确跳过**（`⏭ 跳过…（这是跳过，不是通过）`）而不是崩溃；`config.json` 相关断言改为
只断言 `config.example.json` 的**出厂默认** —— 顺带修掉一个语义错误：原先它断言的是**用户当前状态**，
于是用户按文档打开「AI 发语音」之后测试就会变红（测试不该因为用户用了功能而失败）。

验证（两种模式都 **31/31**）：把工具目录指向不存在时输出 19 条明确的跳过、依旧 31/31。
另用**负向对照**确认这是诚实跳过而非刷绿：故意破坏一个仓库内断言 → 仍然 `exit=1`。

### F. 顺带记录：HTTP token 与 WS token 是两个不同的值

SnowLuma 同一账号的 **HTTP token（3000）与 WS token（3001）不同**，而 `config.json` 只能存一个（存 HTTP 的）。
所以桥接**每次启动的首次 WS 连接几乎必然失败一次**（`连接断开(1006)` → 自愈 → `已连接`）。
这条序列是正常的，日志文案已改清楚；真正会一直连不上的是**自愈无从下手**
（`homeDir` 没配/被移动/读不到 `config/onebot_<QQ>.json`）—— 那才要查。

### G. 运行时升到 1.14.20 的实测（2026-10-03）

把用户的运行时从 1.14.9 升到 1.14.20 并逐项实测（**安装/启动由用户自己做**，本次只做了下载、校验、
迁移与核对）。结论：

| 检查 | 证据 |
| --- | --- |
| 包完整性 | `SnowLuma-v1.14.20-win-x64-lite.zip` SHA256 == 官方发布资产 `digest` |
| **原生组件跨版本未变** | 官方 1.14.9 包 == 本机 1.14.9 == 官方 1.14.20，`native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` **逐字节相同**；`index.mjs` 7,062,899 → 7,476,546 B |
| 配置迁移无损 | 桥接的 `readOneBotTokens()` 在新装目录解析出两个账号，HTTP/WS token 与旧装**逐一相同** |
| 心跳主信号仍成立 | `status = {"online":true,"good":true}`、`interval = 30000` |
| `bot_status` 真的出现了 | 1.14.9：**0** 次；1.14.20：**3** 次（带 `sub_type`/`user_id`） |
| 桥接连通 | 走完「首次 1006 → 自愈 WS token → 已连接」；`/api/status.snowluma` 给出 `good:true`、**`goodSource:"heartbeat"`** |
| 收到 QQ 消息 | `lastPacketKind: message/group`；静默态下正确「仅入库不唤醒」 |
| **完整往返** | 唤醒 → DSH 建会话并挂 `qq-chat-v2` → 工具发送 `成功 1/1 条` → 群里实际出现两条回复 |

> ⚠️ **更正**：本附录 A 一度暗示「升级 SnowLuma 可能修注入（1.14.17 刷新过原生组件）」。
> 字节级证据表明**原生组件根本没有变**，那条推断是错的。升级只换 JS 层
> （事件流水线订阅更全、`bot_status`、markdown 带 text、收发修复），
> **不会修「原生 hook 挂不上 QQ」**——那类问题要走 SnowLuma 自己的排查（QQ 版本、杀软拦注入、权限）。

### H. 版本号方案（自本版起）

主版本号与 DSH 同步，后缀 `rN` 表示「同一 DSH 版本下桥接的第 N 次发布」：

| 标签 | 说明 |
| --- | --- |
| `v0.2.0` | r1 —— DSH 0.2.0-rc.2 适配 |
| ~~`v0.2.1`~~ | r2 —— 采用本方案**之前**的一次性发布：标签与 Release **已撤回**（提交 `9bb7b98` 仍在历史里）。本节全部内容都包含在 r3 中，撤回无功能影响。撤回理由：它不符合「主版本与 DSH 同步」的方案，且发布仅约 26 分钟、无二进制资产、无下游依赖，改写代价为零；留着则每次看标签列表都要额外解释一次 |
| `v0.2.0-r3` | r3 —— 上游健康 + 客户端库升级 + clone 可移植性 + 1.14.20 实测 |
| `v0.2.0-r4` | r4 —— 表情包/动图链路、DSH 同源联网搜索、issue 修复、整体体检（见附录 J） |
| `v0.2.1-r1` | r1（0.2.1 线）—— **当前版本**：DSH 0.2.1-rc.2 适配，P0 `{{cwd}}` 提示词变量修复 + 工具面守卫补齐（见 [DSH_021_ADAPTATION.md](DSH_021_ADAPTATION.md)）。用 `-r1` 而不是裸 `v0.2.1`：那个标签已被上表撤回的 r2 占用过 |

`package.json` 是 `"private": true`（不发布到 npm），所以 `0.2.1-r1` 这种 prerelease 写法
不产生 npm 语义影响；版本号与标签保持一致，便于 `verify:adaptation` 对账。

### I. r3 时**未**修、r4 已修的问题

工具流水里 `mcp__snowluma__qq_wait_for_messages` 出现过 `ok:false` 且
`error: "\"Error: [object Object]\""`（2026-09-28、2026-10-03 各一次）。错误对象被 `String()` 成了
`[object Object]`，**运维与智能体都看不到任何信息**。

r4 已修：MCP 侧统一走 `errorText()`（对象 → `JSON.stringify` 或取 `message`，限长 500），
两条传输通道（普通 fetch 与长轮询）与两个图片工具都用它；并补了「对象形态的 error 必须可读」的回归。
同轮还把 `qq_wait_for_messages` 整体改走 `node:http` 长轮询，绕开 undici 的 300 秒 `headersTimeout`
（见附录 J）。

---

## 附：本文没有覆盖的

- **不是适配范围**：依赖告警、沙箱 ACL（见 §7）。
- **无法验证的**：DSH 0.1.7 的 baseline 真实形状（本机已无 0.1.7 安装，只有报错日志）；
  本文 §2.1 只断言"`queues` 不是它"，没有替 0.1.7 编一个形状。
- **已知的上游缺口**（值得反馈给 DSH）：被切断 DACL 继承的路径对沙箱**永久不可写且无任何提示**，
  而 DSH 自带的 ACL 诊断技能修的是另外两类（缺 `WRITE_DAC` 的目录链、AppContainer 包 ACE），
  对这种形状会报 `NOT_THIS_CLASS`。这条在任何"自己管 ACL"的项目里都会踩到。

---

## 附：v0.2.0-r4 主要改动

> 完整版见 [Release v0.2.0-r4](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.2.0-r4)。
> 本附录只记录「改了什么 / 为什么」的要点，便于在仓库内追溯。

### J.1 图片/表情（含动图）链路

**根因**：QQ 表情 CDN（`gxh.vip.qq.com` / `p.qpic.cn` / `multimedia.nt.qq.com.cn`）的 DNS 应答里
AAAA 排在 A 前面，而本机没有 IPv6 出口；旧 `safe-fetch` 只取 `addresses[0]` 并钉死连接 ——
抢到 AAAA 的那次请求白等 20 秒超时，DNS 顺序又是轮转的，于是表现为「**部分**表情/图片时好时坏」。

- `safe-fetch`：全部解析结果校验后按 **IPv4 优先、两族交替**排序；多地址时逐地址尝试
  （单次 8s、最多 4 个、总预算 20s），仅网络层失败才换地址。
- 表情包：解析保留 `emoji_id`/`summary`/`sub_type`（含 `mface` 段）；**表情优先走 CDN**
  （市场表情不在网关缓存，`get_image` 必失败），无 URL 时用 `emoji_id`（或文件名里的 32 位 hex）
  推出 `gxh.vip.qq.com/.../raw300.gif` 兜底。
- 落库（`appendSocialV2Message`）不再丢 `kind`/`emojiId`/`summary`/`subType`；`summary` 单行化并限长 60。
- 单条媒体上限：8MB / 64MP / 5 张（`socialV2.media` 可调）。

实测：29 个收藏表情 29/29 抓取成功（修复前抽样 5/6，失败那次 20003ms）；会话里的 GIF 表情
`20s 超时 → 421ms`。

### J.2 联网搜索

`src/web-search.js`（新）：与 `@deepseek-ai/dsh-web-search-deepseek` 相同的
`POST https://api.deepseek.com/anthropic/v1/messages` + `web_search_20250305` 服务端工具，
凭据顺序 `webSearch.apiKey` → 环境变量（默认 `DEEPSEEK_API_KEY`）→ `$DSH_HOME/.credentials.yaml`；
Bing **RSS** 仅作兜底；5 分钟查询缓存；空结果显式 `note`。安全：key 只发往校验过的
**https + 公网**端点、禁止跟随重定向、响应体 2MB、总超时 35s、key 不落日志；
`web_fetch` 仍走 SSRF 防护传输。

### J.3 reserved2 状态机与长轮询

- `refreshMode` 读 DSH settings 时 **user 层优先**（0.2.0-rc.2 写完 `value` 不热更新，
  否则控制台切的模式会被 5 秒轮询改回去）。
- 回合判忙改为「起始时间 + 15 分钟租约」：无起始时间的残留 collector 不再永久 busy；
  `rebuildInFlightCollector` 补起始时间；learner collector 同型修复；busy 日志带原因。
- `qq_wait_for_messages` 改走 `node:http` 长轮询（undici 默认 300s headersTimeout 会让
  5 分钟沉睡前观察必然失败）；错误对象统一 `errorText()` 可读。
- DSH 控制调用（停任务/归档/列会话）全部 15s 超时；事件流重连指数退避 + 「已结束」日志；
  SnowLuma `error` 事件也触发 token 自愈。
- 机器人身份（昵称 + QQ 号）注入唤醒 prompt、收尾提醒与 `qq_get_prompt`。

### J.4 体检修复

`/api/send/*` 失败路径的 `catch` 引用了 `try` 内块级变量（发送失败抛 ReferenceError、额度不回滚）；
媒体落库丢表情字段；搜索空结果 note 写在缓存之后；对象形态的 error 被 String 成 `[object Object]`。

### J.5 验证

`npm run test:audit` **33/35**（仅 `test-audit-setup` / `test-qq-model-view` 的沙箱 `spawn EPERM`）；
新增/更新离线回归：`test-media-search`、`test-issue-regressions`、`test-audit-regressions`（R15/R16）、
`test-audit-security-mcp`（长轮询 + 对象 error）；`privacy-scan` 未发现敏感信息。

### J.6 仍已知未修

- `saveSocialV2State()` 写盘失败只记日志、接口仍回 `ok:true`（需写盘队列，改动面大）；
- `auditAndSend` 的返回值不反映真实发送结果（主回复路径已由 `lastSendSucceeded()` 兜住）；
- `toolCallNames` 在 `turn/end` 丢失时不回收（有 15 分钟租约兜底，增长极慢）。
