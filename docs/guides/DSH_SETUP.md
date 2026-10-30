# DSH 端安装说明（本机或另一台设备）

`qq-bridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`qq-chat` / `qq-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   ```

   > 默认分支 `main` 即当前正式发布版本 **v0.2.1-r1**（适配 DSH 0.2.1-rc.2），clone 下来无需切换分支。
   > `dev` 是测试线，领先 `main`，不保证稳定；只在想尝鲜时才切过去。

2. **安装依赖**：

   ```bash
   npm install
   ```

   > `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

3. **创建配置文件**：

   ```bash
   cp config.example.json config.json
   ```

   > Windows CMD 用户请用：`copy config.example.json config.json`

   然后编辑 `config.json`，填写：

   - `snowluma.wsUrl` / `httpUrl`（例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，分别对应 OneBot WebSocket 与 HTTP API 端口）
   - `snowluma.accessToken`
   - `dsh.authToken`（新版 DSH 的 launch token，用于换取 Cookie；默认留空，桥接会自动从 DSH guard 日志发现，DSH 重启后也会自动重新发现）
   - `ownerQQ`
   - `allow.private` / `allow.groups`

4. **运行 DSH 端安装脚本**：

   ```bash
   node scripts/setup-dsh.mjs
   ```

   默认安装到 `web` profile；如果 DSH 使用其他 profile，可以传参：

   ```bash
   node scripts/setup-dsh.mjs <profile名>
   ```

   脚本会完成：

   - 安装 agent preset：通过 `plugins/qq-agent-presets` 这个 DSH bundle 把 `qq-chat` / `qq-chat-v2` 两条 `@deepseek-ai/dsh-agent-preset` 行插入 profile（DSH 0.1.7 起 preset **不再是** `~/.dsh/.agent-presets/<名>/` 目录，该目录完全不被读取）。patch 由 `scripts/build-agent-preset-patches.mjs` 从 `dsh/agent-presets/` 的权威源生成
   - 在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载：
     - `mcp-snowluma`（`src/mcp-snowluma-safe.js`，带 `toolCallTimeoutMs: 725000`）
     - `mcp-snowluma-host`（`src/mcp-host-server.js`）
     - `mcp-web-search-safe`（`src/mcp-web-search-safe.js`）
   - 在 `~/.dsh/profiles/web/package.json` 注册 `qq-mode-console` 与 `qq-agent-presets`（`dsh.profile.bundles` + `link:` 依赖），并维护 `node_modules` 下的 junction
   - 把 `qq-mode` 的默认模式设为 `reserved2`（二代仿真）
   - 创建本地 `state/mode.json`（`mode: reserved2`）作为 DSH settings 不可用时的兜底
   - 尝试自动执行 `dsh plugin --profile web install`（当 `dsh` CLI 在 PATH 中可用时），注册两个插件的 bundle 依赖；若 `dsh` 不在 PATH，缺失依赖时 DSH 会提示补跑

   > 脚本可重复运行（幂等）：它会重建 `qq-agent-presets` 的 preset patch、更新 MCP 路径并重建失效的插件链接。
   > MCP 条目通过 YAML 解析后**按顶层 `insert` 内的条目 id 增删**（不依赖标记注释），支持带引号的 id、共享 `insert` 与行内 YAML，并保留其他插件配置和嵌套数据。
   > 脚本在写入前验证 YAML；无法解析时停止，不覆盖配置或 preset。只修复历史版本在文件开头遗留的多余 `[]`，不会删除正文中的空数组或文本。
   > YAML 格式与注释会在序列化时规范化；首次修改前的完整原文保存在同目录 `cordis.patch.yml.qq-bridge.bak`，后续运行不覆盖该备份。
   > 可用 `node scripts/test-audit-setup.mjs` 验证幂等性、配置保留、路径边界和 Windows CLI 调用；测试只使用独立的临时仓库和 DSH_HOME，不启动真实 DSH。
   > 已存在的 `qq-bridge/state/mode.json` 会被保留（不覆盖用户设置）；全新安装才会写入 `mode: reserved2`。
   > 如果之后把 `qq-bridge` 目录移动/重新 clone 到别的路径，请重新运行一次本脚本，否则 DSH 里的 MCP/插件绝对路径会指向旧位置。
   > 也可用环境变量指定 DSH 根目录：`DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>`。
   > `<profile>` 必须是单个目录名，不能包含路径分隔符或 `..` 路径跳转。离线准备配置时，可设置 `QQ_BRIDGE_SKIP_DSH_INSTALL=1` 跳过自动安装 bundle，随后手动运行 `dsh plugin --profile <profile> install`。
   > Windows 下脚本通过隐藏的 `cmd.exe` 调用 npm 的 `dsh.cmd` 启动器；`DSH_HOME` 和 profile 参数会传给该进程。

5. **重启 DSH**：

   必须重启 DSH（或让 DSH 重新加载 profile），新 preset 和 MCP 工具才会生效。

   > 默认模式为 **`reserved2`（二代仿真）**，即“文本不自动转发、AI 通过工具自主收发”。如果你想改用 `chat` / `closed-agent` / `reserved`，在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换即可 —— 桥接会同时写入 DSH 设置与本地 `state/mode.json`，**无需重启**（每 5 秒轮询即时生效）。本地文件保存模式兜底与 `closedAgentPreset`；正常情况下模式以 DSH 设置为准，请通过控制台切换。

## 验证是否装好

离线安全回归：`node scripts/test-audit-setup.mjs` 与 `node scripts/test-audit-setup-guards.mjs`。后者直接执行两套 preset 的限制插件，验证本地工具、未声明工具与裸 `web_fetch` / `web_search` 被拒绝，而带 SSRF 防护的 `mcp__web-search-safe__*` 仍然可用。更新 preset 后需重新运行安装脚本并重启 DSH，现有 DSH 安装中的旧副本才会更新。

0. **一键自检**：`npm run verify:adaptation` —— 覆盖 preset persona schema、bundle patch 与工具守卫、版本身份一致性、preset fail-closed 护栏，以及**运行中的 DSH 0.2.0 实测**（`qq-mode` 命名空间可列可写、`session/projections`、`session/control` 的 `projections` 形状、`stopSessionWork` 退役会话、`$events` ready 帧、`session/modelCatalog`、点号 endpoint 仍 404）等共 65 项断言。
   > 若你的环境禁止起子进程（例如在 DSH 的沙箱会话里跑），脚本内那批 `node --check` 语法检查会被**显式记为跳过**（`⏭`）而不是报假失败 —— 请在普通终端重跑以覆盖它们。
1. **切换桥接模式**：打开桥接控制台（默认 `http://127.0.0.1:3100`），顶部的「聊天模式 / 封闭 Agent / 一代仿真模式 / 二代仿真模式」按钮即为当前生效的切换入口。控制台会同时写入 DSH 设置与本地 `state/mode.json`。
   > ℹ️ DSH 设置页 `Plugins → Plugin configuration` 里**不会**出现 `qq-mode` 卡片：该槽位要求插件自带浏览器半（`package.json` 的 `dsh.client` + `lib/client.js`），而 `plugins/qq-mode-console` 只实现了 host 半。`qq-mode` 命名空间本身**可用**（`settings/describe` 能列出、`settings/update` 能写成功），缺的只是那张 GUI 表单 —— 所以模式改走控制台。参见下方「常见问题」。
   > DSH 0.2.0 起命名空间**不再需要任何注册调用**：它由 profile 里 `id: qq-mode` 那条 loader entry + 插件导出的 `Config`（带 `volatile` 字段）推导出来。0.1.x 的 `ctx.settings.register()` 已被 DSH 删除。
2. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`qq-chat`）
   - `QQ 聊天角色（二代仿真）`（`qq-chat-v2`）
3. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

## 常见问题

- **每次启动日志里都先报一次「连接断开（1006）」再报「已连接」**：**这是正常的，不是故障**。原因：SnowLuma 同一账号的 **HTTP token（默认 3000 端口）与 WS token（默认 3001 端口）是两个不同的值**，而 `config.json` 的 `snowluma.accessToken` 只能存一个（存的是 HTTP 那个）。所以 WS 首次连接会被拒 → 触发 token 自愈（重新发现 WS token）→ 重连成功。真正有问题的是**自愈也失败**：日志里会出现 `token 自愈失败`，QQ 侧完全收不到消息。那时先确认 `config.json` 的 `snowluma.homeDir` 指向真正的 SnowLuma 安装目录（自愈要从它的 `config/onebot_<QQ号>.json` 里读 WS token）。
- **QQ 上毫无反应，但桥接日志说「SnowLuma 已连接」**：这几乎总是 **SnowLuma 侧的 `[Hook]` 收不到 QQ 数据**，不是桥接的问题。桥接的 WebSocket 连的是 SnowLuma，SnowLuma 再通过原生组件挂进 QQ 客户端进程；中间这层退化时 SnowLuma 进程与它的 WebSocket 都还活着，所以桥接这边看不出异常。
  1. 打开控制台「运行总览」，看 **`SnowLuma 上游`** 卡片：`已连接 · 未接收` 就是这个状态；「访问与安全」页会有对应告警条与处置建议。`GET /api/status` 的 `snowluma` 字段（`degraded` / `good` / `hint`）给的是同一份判断。
  2. 去看 **SnowLuma 自己的日志** `logs/snowluma-*.log`，搜 `[Hook]`：
     - `receive path stale: … reporting good=false` —— 收不到数据（会自愈，也可能不自愈）
     - `process enumeration timed out after 4000ms` —— 连 QQ 进程都枚举不到
     - 正常应有 `login detected: PID=…` + `pipe connected: PID=…`
  3. **再考虑升级 SnowLuma**（见 [../../README.md](../../README.md) 的「SnowLuma 版本与上游健康」）。⚠️ 但先别指望它：**实测注入用的原生组件在 1.14.9 与 1.14.20 之间逐字节完全相同**，升级只换 JS 层，**不会修「原生 hook 挂不上 QQ」**。**升级 SnowLuma 是你自己的事**——本桥接只探测、不部署。
  4. 顺带确认 QQ 客户端本身是登录状态、没有被顶号；较新的 SnowLuma（**1.14.20 已确认**）会通过 `bot_status` 事件把账号上下线告诉我们，桥接日志里会打「QQ 账号会话已离线」。
  > 桥接**没有**任何原生/注入面（依赖全纯 JS，源码里没有 `.dll`/`.node`/FFI/进程注入），也不启动、不控制 SnowLuma 或 QQ，所以「QQ 注入失败」不可能是本桥接造成的。
- **看不到 `qq-mode` 设置卡片**：这是**已知限制**，不是配置错误。DSH 的 `settings.plugin.item` 槽位只渲染「host 已注册的命名空间 ∩ 声明了该 key 的卡片」，而卡片必须由插件的**浏览器半**（`package.json` 的 `dsh.client` + `lib/client.js`）注册；`plugins/qq-mode-console` 目前只有 host 半。反复重跑 `setup-dsh.mjs` 或重启 DSH 都不会让卡片出现。要真正修好需补一个 `lib/client.js`。
- **改了模式却不生效 / 5 秒后被改回去**：**此问题已在 `src/bridge.js` 修复**（桥接需重启后生效）。历史成因：`refreshMode()` 每 5 秒被 `checkDsh` 调用一次，先读 DSH 的 `qq-mode` 命名空间，只要有合法值就**直接 return，完全忽略本地 `state/mode.json`**；而命名空间的默认值始终存在，所以 DSH 侧永远有值 —— 于是控制台写本地文件会在下一次轮询被覆盖回滚。现在 `POST /api/mode` 会**写穿到 DSH 设置**（`api.settings.update({ ns: 'qq-mode', patch: { mode } })`），响应里新增 `dshSynced` 字段；若写穿失败（DSH 未运行等）会记日志并保留本地值。注意 `settings/update` 在 0.2.0 是**多参数** RPC：args 是 `{ ns, patch, expectedRevision }` 平铺，**不是** `{ request: {...} }`（传 request 会被网关拒为 `gateway/arguments-invalid`）。同源问题：`closedAgentPreset` 在 DSH schema 里不存在，原先也因这个提前 return 而失效，现已改为始终以本地 `state/mode.json` 为准。若仍看到回滚，检查桥接日志里是否有「写穿 DSH 设置失败」。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，并重启 DSH。
- **preset 没有出现**：DSH 0.1.7 起 preset **不再**是 `~/.dsh/.agent-presets/<名>/` 目录（该目录完全不被读取）。preset 现在是 profile 里的一条 `@deepseek-ai/dsh-agent-preset` 行，由 `plugins/qq-agent-presets` 这个 bundle 提供。检查 profile 的 `package.json` 的 `dsh.profile.bundles` 是否含 `qq-agent-presets`、`dependencies` 是否有对应的 `link:`，以及 `~/.dsh/profiles/web/node_modules/qq-agent-presets` 链接是否存在；缺了就重跑 `node scripts/setup-dsh.mjs` 再重启 DSH。桥接里可用 `npm run probe:protocol` / `npm run verify:adaptation` 确认 `agentPresets/list` 里能看到 `qq-chat`、`qq-chat-v2`。
- **启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException`**：多为历史版脚本残留的空数组 `[]` 引发。重新运行最新版脚本（会自动剥离）即可，或手动删除该文件里独立成行的 `[]` 后重启 DSH。
- **启动 DSH 报 `cannot resolve profile bundle "qq-mode-console"`**：profile 的 bundle 依赖尚未安装。运行 `dsh plugin --profile web install`（`web` 换成你的实际 profile 名）后重启 DSH；新版脚本会尝试自动执行这一步。
- **启动 DSH 报 `failed to apply loader entry persona (@deepseek-ai/dsh-persona): invalid config: $.prefix missing required value`**：preset 的 persona 段缺少 `prefix`。DSH 0.1.5 起 `dsh-persona` 只接受 `prefix` / `suffix` / `complete` / `includeRuntimeContext`，而旧写法用的是 `text` —— schemastery 的 `z.object` 非 strict，未知键会被**静默忽略**，于是真正报出来的是「缺 `prefix`」（**不是**「`text` 这个键被拒绝」）。重新运行 `node scripts/setup-dsh.mjs`（本仓库 preset 已改为 `prefix`），或手动把 preset 里的 `text:` 改成 `prefix:`。可用 `node scripts/verify-persona-config.mjs` 提前自检。
- **profile 的 bundle 条目被重置**：升级 DSH 可能重置 `~/.dsh/profiles/web/package.json`，把 `qq-mode-console` 的依赖与 bundle 条目删掉（症状是启动报 `cannot resolve profile bundle`，或桥接读不到 `qq-mode` 设置值）。重新运行 `node scripts/setup-dsh.mjs`，再跑 `dsh plugin --profile web install` 并重启 DSH。
- **QQ preset 挂载失败，群里 AI 完全没反应**：`chat` / `reserved` / `reserved2`（会话可能属于 QQ 群）**必须**挂上 `qq-chat` / `qq-chat-v2`，否则桥接**直接拒绝建会话**并打日志 `⛔ 群聊/仿真会话缺少 preset …`——QQ 上表现为「发了消息没人回」，而桥接日志里能查到原因。这是有意的 fail-closed 设计：**「无 preset 会话」= DSH 默认 preset（通常 `standard`，含 bash/文件读写）**，降级过去等于把本地工具暴露给群里的任何人。`closed-agent` 模式（仅 owner 私聊）是唯一例外，那里本就使用完整工具面，允许回落。修复：确认 `plugins/qq-agent-presets` bundle 已注册进 profile（`bundles` + `link:` 依赖 + `node_modules` junction 三者齐备，跑 `node scripts/setup-dsh.mjs` 可自动补齐）并重启 DSH；若手改过 `config.json` 的 `agentPreset`，确认该名字确实在 DSH 的 preset 清单里。
- **发送消息报 `unauthorized` / HTTP 401**：`config.json` 的 `snowluma.accessToken` 与 SnowLuma 的 OneBot 实例 token 不一致。将 SnowLuma WebUI 中 HTTP 与 WebSocket 两端的 accessToken 设为相同，再填入 `config.json`，然后重启桥。
- **DSH 侧 401/鉴权失败**：DSH 0.1.7 起进程启动 token 是**每进程现生成、只存在内存**的随机数（不落盘、不可推导），旧版「从 `~/.dsh/guard/logs/server-*.out.log` 里读 token」的办法已经失效（读到的是上一个进程的陈旧 token，换 Cookie 只会 401）。桥接现在**默认离线铸造 Cookie**：读 `~/.dsh/.credentials.yaml` 里持久化的 `client-connection/browser-session` 签名密钥自签一个会话 Cookie，不依赖任何进程期状态。`config.json` 的 `dsh.authToken` 一般应留空；只有显式填了才会优先走 token 交换。若报鉴权失败，先确认 `DSH_HOME` 指向真正的 `.dsh` 目录、且该文件里有 `client-connection/browser-session` 记录。`npm run test:dsh-auth`（17 项断言）与 `npm run self-test` 可快速定位。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。也可以运行诊断脚本：
   ```bash
   node scripts/check-onebot-status.mjs
   ```
