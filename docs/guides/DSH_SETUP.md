# DSH 端安装说明（本机或另一台设备）

`qq-bridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`qq-chat` / `qq-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

> **上游行为标注**：本文中的 `[Hook]`、进程枚举、PID/pipe 等均为 SnowLuma 接入日志字段；qq-bridge 不注入、不挂钩、不修改 SnowLuma 本体。

## 兼容范围

桌面版端口自动发现默认开启。多实例或固定端点部署可将 `config.json` 的
`dsh.autoDiscoverPort` 设为 `false`，此时桥接只使用配置的地址，不扫描或重绑其他实例。

协议代际与预设 schema 必须分别匹配，不能只凭斜杠 RPC 判断可用性（[#9](https://github.com/Derpyu520/qq-bridge/issues/9)）。

| DSH 版本 | 处理方式 |
| --- | --- |
| 0.1.1-rc.2 及更早 | 历史标签 `v0.1.0`；当前分支不支持旧点号协议 |
| 0.1.2-alpha.1 | 历史标签 `v0.1.2-alpha.1` 使用 `persona.text`；当前分支不兼容该 schema |
| 0.1.2 的其他版本～0.1.4 | 当前预设不支持；没有逐版本验证的标签映射，建议升级到已验证版本 |
| 0.1.5-rc.1 / 0.1.7-rc.2 | 分别使用历史标签 `v0.1.5` / `v0.1.7` |
| 0.2.0-rc.2 / 0.2.1-rc.2 | 当前版本已有适配与验证记录 |

历史标签不包含后续安全修复。DSH 0.2.1-rc.3 的个别环境反馈仍需对应安装形态复现，
不能把某个环境成功或失败的结果推广到全部安装。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   ```

   > 默认分支 `main` 是正式发布线，具体版本以 [Releases](https://github.com/Derpyu520/qq-bridge/releases) 为准，clone 下来无需切换分支。
   > `dev` 是开发与测试线，不保证稳定；只在想参与开发或测试未发布改动时才切过去。

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
   - `dsh.authToken`（通常留空：桥接优先使用本机 DSH 持久化签名密钥生成会话 Cookie，不依赖 guard 日志；旧启动日志仅作为兼容兜底）
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
   > YAML 格式与注释会在序列化时规范化；每次**实际改动内容**前，完整原文会保存在同目录的 `cordis.patch.yml.bak-<ISO 时间戳>`（例如 `cordis.patch.yml.bak-2026-10-31T13-10-31-123Z`），只保留最近 5 份；内容无需改动时不会新增备份。
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

1. **一键自检**：`npm run verify:adaptation` —— 覆盖 preset persona schema、bundle patch 与工具守卫、版本身份一致性、preset fail-closed 护栏，以及运行中 DSH 的协议与活体回合（`qq-mode`、`session/projections`、`session/control`、`stopSessionWork`、`$events`、`session/modelCatalog` 等）。具体断言数量以脚本输出为准。
   > 若你的环境禁止起子进程（例如在 DSH 的沙箱会话里跑），脚本内那批 `node --check` 语法检查会被**显式记为跳过**（`⏭`）而不是报假失败 —— 请在普通终端重跑以覆盖它们。
2. **切换桥接模式**：打开桥接控制台（默认 `http://127.0.0.1:3100`），顶部的「聊天模式 / 封闭 Agent / 一代仿真模式 / 二代仿真模式」按钮即为当前生效的切换入口。控制台会同时写入 DSH 设置与本地 `state/mode.json`。
   > ℹ️ DSH 设置页 `Plugins → Plugin configuration` 里**不会**出现 `qq-mode` 卡片：该槽位要求插件自带浏览器半（`package.json` 的 `dsh.client` + `lib/client.js`），而 `plugins/qq-mode-console` 只实现了 host 半。`qq-mode` 命名空间本身**可用**（`settings/describe` 能列出、`settings/update` 能写成功），缺的只是那张 GUI 表单 —— 所以模式改走控制台。参见下方「常见问题」。
   > DSH 0.2.0 起命名空间**不再需要任何注册调用**：它由 profile 里 `id: qq-mode` 那条 loader entry + 插件导出的 `Config`（带 `volatile` 字段）推导出来。0.1.x 的 `ctx.settings.register()` 已被 DSH 删除。
3. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`qq-chat`）
   - `QQ 聊天角色（二代仿真）`（`qq-chat-v2`）
4. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

## 常见问题

- **启动时先出现「连接断开（1006）」随后恢复**：部分 SnowLuma 部署会为 HTTP 与 WS 使用不同令牌，而 `config.json` 的 `snowluma.accessToken` 只显式保存一个值。首次 WS 连接可能因此失败，再由桥接从 `snowluma.homeDir` 的 `config/onebot_<QQ号>.json` 发现对应令牌并重连。仅在这条自愈链路成功时，短暂 1006 属于预期现象；如果持续失败或收不到消息，则需检查令牌和 `homeDir`，不能一概视为正常。
- **QQ 上毫无反应，但桥接日志说「SnowLuma 已连接」**：已连接只表示 WebSocket 建立，不能证明 QQ 数据链路正常，可能是上游接入层（SnowLuma 的 `[Hook]`）未收到数据，也可能是桥接配置或会话路由问题，应按以下顺序排查。
  1. 打开控制台「运行总览」，看 **`SnowLuma 上游`** 卡片：`已连接 · 未接收` 表示连接存在但未收到上游数据；「访问与安全」页会有对应告警条与处置建议。`GET /api/status` 的 `snowluma` 字段（`degraded` / `good` / `hint`）给的是同一份判断。
  2. 去看 **SnowLuma 自己的接入日志** `logs/snowluma-*.log`，搜 `[Hook]`（以下均为 SnowLuma 日志字段）：
     - `receive path stale: … reporting good=false` —— 日志：收不到数据（会自愈，也可能不自愈）
     - `process enumeration timed out after 4000ms` —— 日志：连 QQ 进程都枚举不到
     - 正常应有 `login detected: PID=…` + `pipe connected: PID=…` —— 日志字段
  3. 再核对白名单、DSH 会话与桥接日志，排除本项目的配置问题。是否升级 SnowLuma 应根据其发布说明判断；本项目只读取本机接入配置与上游健康状态，不部署、不修改上游本体。历史核验仅证明 **1.14.9 与 1.14.20** 的原生组件相同，因此那次版本升级不能修复原生 hook 挂载问题，不能推广为所有版本的结论（见 [DSH 0.2.0 适配记录](DSH_020_ADAPTATION.md)）。
  4. 顺带确认 QQ 客户端本身是登录状态、没有被顶号；SnowLuma **1.14.20** 已验证会通过 `bot_status` 事件报告账号上下线，桥接日志会记录「QQ 账号会话已离线」。
  > 桥接自身不包含原生注入组件，也不启动或控制 SnowLuma / QQ；遇到上游接入失败应先检查 SnowLuma 日志，而不是直接归因于桥接。
- **看不到 `qq-mode` 设置卡片**：这是**已知限制**，不是配置错误。DSH 的 `settings.plugin.item` 槽位只渲染「host 已注册的命名空间 ∩ 声明了该 key 的卡片」，而卡片必须由插件的**浏览器半**（`package.json` 的 `dsh.client` + `lib/client.js`）注册；`plugins/qq-mode-console` 目前只有 host 半。反复重跑 `setup-dsh.mjs` 或重启 DSH 都不会让卡片出现。要真正修好需补一个 `lib/client.js`。
- **改了模式却不生效 / 5 秒后被改回去**：**此问题已在 `src/bridge.js` 修复**（桥接需重启后生效）。历史成因：`refreshMode()` 每 5 秒被 `checkDsh` 调用一次，先读 DSH 的 `qq-mode` 命名空间，只要有合法值就**直接 return，完全忽略本地 `state/mode.json`**；而命名空间的默认值始终存在，所以 DSH 侧永远有值 —— 于是控制台写本地文件会在下一次轮询被覆盖回滚。现在 `POST /api/mode` 会**写穿到 DSH 设置**（`api.settings.update({ ns: 'qq-mode', patch: { mode } })`），响应里新增 `dshSynced` 字段；若写穿失败（DSH 未运行等）会记日志并保留本地值。注意 `settings/update` 在 0.2.0 是**多参数** RPC：args 是 `{ ns, patch, expectedRevision }` 平铺，**不是** `{ request: {...} }`（传 request 会被网关拒为 `gateway/arguments-invalid`）。同源问题：`closedAgentPreset` 在 DSH schema 里不存在，原先也因这个提前 return 而失效，现已改为始终以本地 `state/mode.json` 为准。若仍看到回滚，检查桥接日志里是否有「写穿 DSH 设置失败」。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，并重启 DSH。
- **preset 没有出现**：DSH 0.1.7 起 preset **不再**是 `~/.dsh/.agent-presets/<名>/` 目录（该目录完全不被读取）。preset 现在是 profile 里的一条 `@deepseek-ai/dsh-agent-preset` 行，由 `plugins/qq-agent-presets` 这个 bundle 提供。检查 profile 的 `package.json` 的 `dsh.profile.bundles` 是否含 `qq-agent-presets`、`dependencies` 是否有对应的 `link:`，以及 `~/.dsh/profiles/web/node_modules/qq-agent-presets` 链接是否存在；缺了就重跑 `node scripts/setup-dsh.mjs` 再重启 DSH。桥接里可用 `npm run probe:protocol` / `npm run verify:adaptation` 确认 `agentPresets/list` 里能看到 `qq-chat`、`qq-chat-v2`。
- **安装完成但 RPC 看不到预设或设置**：先对照安装脚本与运行中的 DSH/桥接是否使用相同用户、`DSH_HOME` 和 profile。终端里的 `--dump-config` 只证明该终端所用配置已合成，不证明后台进程使用同一份配置。[#77 的最终讨论](https://github.com/Derpyu520/qq-bridge/issues/77)已将该次故障定位为运行用户不一致。若同一进程的插件注册表能看到预设，而 RPC 仍看不到，需保留安装形态和最小诊断继续定位 DSH 作用域问题（[#97](https://github.com/Derpyu520/qq-bridge/issues/97)）；不能回退到完整工具预设绕过检查。
- **`Cannot find package 'js-yaml'` 等依赖缺失**：Release 源码包不包含 `node_modules`。在解压后的仓库根目录运行 `npm install`，确认成功后再启动；不要跳过 `postinstall`。`package.json` 和锁文件已声明 `js-yaml`（[#91](https://github.com/Derpyu520/qq-bridge/issues/91)）。
- **网页、搜索或图片因 fake-ip 被拦截**：Clash/mihomo 的 fake-ip 可能把域名映射到 `198.18.0.0/15`，该段仍属于禁止访问的保留地址。可按 [mihomo DNS 官方文档](https://wiki.metacubex.one/config/dns/)切换 `enhanced-mode: redir-host`，或在 `fake-ip-filter-mode: blacklist` 时让受影响的公网域名命中 `fake-ip-filter`，使其返回真实地址；修改后清理代理及系统 DNS 缓存再试。桥接仍会校验真实解析结果，不提供跳过私有地址检查的开关（[#40](https://github.com/Derpyu520/qq-bridge/issues/40)、[#111](https://github.com/Derpyu520/qq-bridge/issues/111)）。
- **启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException`**：多为历史版脚本残留的空数组 `[]` 引发。重新运行最新版脚本（会自动剥离）即可，或手动删除该文件里独立成行的 `[]` 后重启 DSH。
- **启动 DSH 报 `cannot resolve profile bundle "qq-mode-console"`**：profile 的 bundle 依赖尚未安装。运行 `dsh plugin --profile web install`（`web` 换成你的实际 profile 名）后重启 DSH；新版脚本会尝试自动执行这一步。
- **启动 DSH 报 `failed to apply loader entry persona (@deepseek-ai/dsh-persona): invalid config: $.prefix missing required value`**：preset 的 persona 段缺少 `prefix`。DSH 0.1.5 起 `dsh-persona` 只接受 `prefix` / `suffix` / `complete` / `includeRuntimeContext`，而旧写法用的是 `text` —— schemastery 的 `z.object` 非 strict，未知键会被**静默忽略**，于是真正报出来的是「缺 `prefix`」（**不是**「`text` 这个键被拒绝」）。重新运行 `node scripts/setup-dsh.mjs`（本仓库 preset 已改为 `prefix`），或手动把 preset 里的 `text:` 改成 `prefix:`。可用 `node scripts/verify-persona-config.mjs` 提前自检。
- **profile 的 bundle 条目被重置**：升级 DSH 可能重置 `~/.dsh/profiles/web/package.json`，把 `qq-mode-console` 的依赖与 bundle 条目删掉（症状是启动报 `cannot resolve profile bundle`，或桥接读不到 `qq-mode` 设置值）。重新运行 `node scripts/setup-dsh.mjs`，再跑 `dsh plugin --profile web install` 并重启 DSH。
- **QQ preset 挂载失败，群里 AI 完全没反应**：`chat` / `reserved` / `reserved2`（会话可能属于 QQ 群）**必须**挂上 `qq-chat` / `qq-chat-v2`，否则桥接**直接拒绝建会话**并打日志 `⛔ 群聊/仿真会话缺少 preset …`——QQ 上表现为「发了消息没人回」，而桥接日志里能查到原因。这是有意的 fail-closed 设计：**「无 preset 会话」= DSH 默认 preset（通常 `standard`，含 bash/文件读写）**，降级过去等于把本地工具暴露给群里的任何人。`closed-agent` 模式（仅 owner 私聊）是唯一例外，那里本就使用完整工具面，允许回落。修复：确认 `plugins/qq-agent-presets` bundle 已注册进 profile（`bundles` + `link:` 依赖 + `node_modules` junction 三者齐备，跑 `node scripts/setup-dsh.mjs` 可自动补齐）并重启 DSH；若手改过 `config.json` 的 `agentPreset`，确认该名字确实在 DSH 的 preset 清单里。
- **发送消息报 `unauthorized` / HTTP 401**：先分别核对 SnowLuma HTTP 与 WebSocket 的令牌、地址和实际使用账号。HTTP 与 WS 可以使用不同令牌，不要求强制设为相同；确保 `snowluma.accessToken` 与 HTTP API 匹配，并确认 `snowluma.homeDir` 能让桥接发现 WS 所需的对应令牌，然后重启桥接。
- **DSH 侧 401/鉴权失败**：DSH 0.1.7 起进程启动 token 是**每进程现生成、只存在内存**的随机数（不落盘、不可推导），旧版「从 `~/.dsh/guard/logs/server-*.out.log` 里读 token」的办法已经失效（读到的是上一个进程的陈旧 token，换 Cookie 只会 401）。桥接现在**默认离线铸造 Cookie**：读 `~/.dsh/.credentials.yaml` 里持久化的 `client-connection/browser-session` 签名密钥自签一个会话 Cookie，不依赖任何进程期状态。`config.json` 的 `dsh.authToken` 一般应留空；只有显式填了才会优先走 token 交换。若报鉴权失败，先确认 `DSH_HOME` 指向真正的 `.dsh` 目录、且该文件里有 `client-connection/browser-session` 记录。`npm run test:dsh-auth`（17 项断言）与 `npm run self-test` 可快速定位。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。也可以运行诊断脚本：
   ```bash
   node scripts/check-onebot-status.mjs
   ```
