# scripts/ 索引

> 目录即分类：
>
> - `audit/` 审计子模块与夹具（`test-audit.mjs` 在根目录，是运行入口）
> - `tests/offline/` 离线测试（必须登记在 `test-audit.mjs` 清单里）
> - `tests/live/` 需要 DSH / SnowLuma / QQ 的实时测试
> - `probes/` 探针与适配校验 · `setup/` 安装/生成/修补 · `ops/` 运维与诊断
> - `send/` 会向 QQ 发送内容 · `console/` 控制台工具 · `lib/` 共享库 · `fixtures/` 资源
>
> 新增脚本：选对目录 → 离线测试加进 `test-audit.mjs` 清单 → 运行
> `node scripts/setup/gen-scripts-index.mjs` 刷新本文件（`--check` 只校验）。
> 一次性调试脚本放 `scripts/.gitignore`，不要提交。
>
> 常用入口：`npm run test:audit`（离线全量）、`npm run privacy-scan`、`npm run verify:adaptation`。

<!-- scripts-index:begin -->

### 入口与运行器

- `test-audit.mjs` — Safe audit suite: fixtures and mocks only, never production QQ/DSH.（npm: test:audit）

### 审计子模块与夹具

- `audit/audit-bridge-harness.mjs` — Execute the real bridge initialization/functions against temporary files and fa…
- `audit/test-audit-bridge.mjs`（audit）
- `audit/test-audit-dsh-endpoints.mjs` — Offline endpoint regressions: all credentials and network responses are fixture…（audit）
- `audit/test-audit-network-boundaries.mjs` — Offline network-boundary regressions. All transports and DNS answers are fixtur…（audit）
- `audit/test-audit-protocol-helpers.mjs`（audit）
- `audit/test-audit-protocol.mjs` — Offline regression tests. No real DSH/QQ endpoints or local credentials are rea…（audit）
- `audit/test-audit-regressions.mjs` — 全项目体检后的「已确认缺陷」回归：每条都钉住一个真实故障形态，（audit；npm: test:regressions）
- `audit/test-audit-runtime-boundaries.mjs` — 离线验证会话资料与语音库路径边界，不连接 QQ/DSH 或读取真实配置。（audit）
- `audit/test-audit-security-mcp.mjs` — Exercise MCP callbacks with a fake transport: no network, config or stdio serve…（audit）
- `audit/test-audit-security.mjs` — Offline regression tests: no sockets, QQ messages, production config or secrets.（audit）
- `audit/test-audit-session-boundaries.mjs` — Isolated peers and temporary files only; never connect to QQ or DSH.（audit）
- `audit/test-audit-setup-guards.mjs` — Execute both real preset plugins against a captured tools service, without DSH/…（audit）
- `audit/test-audit-setup.mjs` — Offline integration tests. Every setup invocation receives its own repository a…（audit）

### 离线测试（test:audit 清单）

- `tests/offline/test-adaptation-probes.mjs` — Isolated protocol peers only; never contact an installed DSH or QQ account.（audit）
- `tests/offline/test-agent-preset-patches.mjs` — 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）（audit）
- `tests/offline/test-code-scanning-boundaries.mjs` — CodeQL 边界回归：真实定时函数配假时钟，真实 HTTP handler 配临时配置与假 DSH。（audit）
- `tests/offline/test-console-encoding.mjs` — 验证「Windows 控制台乱码 + chcp 修复」的机制是否成立。（audit）
- `tests/offline/test-console-static.mjs` — 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。（audit）
- `tests/offline/test-delivery-regressions.mjs` — 交付链路回归（真实 bridge 源码在内存 VM 里跑，不发真实 QQ/DSH）（audit）
- `tests/offline/test-dsh-inbox-projection.mjs` — DSH 0.2.0 会话队列（inbox 投影）解析的登记期回归测试。（audit；npm: test:dsh-inbox）
- `tests/offline/test-encoding.mjs` — 启动器与编码自检（audit；npm: test-encoding）
- `tests/offline/test-forward.mjs` — 合并转发消息能力自检脚本（audit；npm: test-forward）
- `tests/offline/test-hardening.mjs` — 2026-09-20 体检修复的回归测试。（audit；npm: test:hardening）
- `tests/offline/test-installed-preset-sync.mjs` — No production DSH, model calls, or QQ messages; all writes use a temporary dire…（audit）
- `tests/offline/test-issue-followup-bridge.mjs` — Exercise real bridge handlers with temporary state and fake QQ/DSH peers.（audit）
- `tests/offline/test-issue-followup-mcp.mjs` — Offline issue follow-up: real MCP schema validation, fixture config/DNS/HTTP on…（audit）
- `tests/offline/test-issue-followup-runtime.mjs` — GitHub issue runtime regressions. All credentials, network peers and ACLs are f…（audit）
- `tests/offline/test-issue-regressions.mjs` — GitHub issue 回归：把上游 issue 里**已确认可复现**的缺陷钉死，防止回退。（audit；npm: test:issues）
- `tests/offline/test-md-to-plain.mjs` — md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。（audit；npm: test-md）
- `tests/offline/test-media-normalize.mjs` — 媒体归一化（体积 + 动图抽帧）的离线回归。（audit；npm: test:media-normalize）
- `tests/offline/test-media-search.mjs` — 图片/表情链路 + 联网搜索的离线回归。（audit；npm: test:media-search）
- `tests/offline/test-mux-reconnect.mjs` — 事件流重连回归测试：DSH 重启 / WS 断开后，**已有会话必须被重新 follow**。（audit；npm: test:mux-reconnect）
- `tests/offline/test-preset-local-tools.mjs` — 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。（audit）
- `tests/offline/test-preset-prompt.mjs` — 仿真提示词改写（src/text/preset-prompt.js）的离线单测。（audit；npm: test:preset-prompt）
- `tests/offline/test-qq-agent-guard.mjs` — qq-agent-guard / qq-chat-tools 自检（离线）。（audit）
- `tests/offline/test-qq-file.mjs` — QQ 文件链路自检（离线为主）（audit）
- `tests/offline/test-qq-mode-plugin.mjs` — qq-mode-console 插件的登记期静态检验。（audit；npm: test:plugin）
- `tests/offline/test-qq-model-view.mjs`（audit；npm: test:token）
- `tests/offline/test-qq-preset-contract.mjs` — reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。（audit；npm: test:token）
- `tests/offline/test-reply-wait.mjs` — First-reply quiet-window regressions. Real bridge handlers, fixture peers only.（audit；npm: test:token / test:reply-wait）
- `tests/offline/test-restart-instance.mjs` — 启动器（npm run restart / stop）的本实例识别回归：锁 PID 必须是入口属于本仓库的 node + src/bridge.js；（audit）
- `tests/offline/test-role-card.mjs` — 人格卡按仿真模式取用（src/text/role-card.js）的离线单测。（audit；npm: test:role-card）
- `tests/offline/test-role-injection-cadence.mjs` — 角色卡注入节奏的离线回归（不连 DSH、不发 QQ）（audit；npm: test:role-inject）
- `tests/offline/test-scripts-index.mjs` — scripts 索引一致性：scripts/README.md 必须与 gen-scripts-index 的生成结果一致。（audit）
- `tests/offline/test-slang-learn.mjs` — 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。（audit；npm: test-slang）
- `tests/offline/test-snowluma-conn.mjs` — SnowLuma 账号/token 自发现自检。（audit）
- `tests/offline/test-snowluma-upstream-health.mjs` — SnowLuma 上游健康与客户端库版本的登记期回归。（audit）
- `tests/offline/test-stickers.mjs` — 表情包体系自检（audit；npm: test-stickers）
- `tests/offline/test-time-awareness.mjs` — 时间观念回归：沉睡很久后被唤醒，模型必须看得出「这条是旧账」。（audit）
- `tests/offline/test-token-economy.mjs` — Exercise real bridge HTTP handlers and prompt delivery with isolated files,（audit；npm: test:token）
- `tests/offline/test-token-usage.mjs` — Token 用量账本 + 价目表测试。（audit；npm: test:tokens）
- `tests/offline/test-tool-restrict-guard.mjs` — qq-tool-restrict 守卫的回归（2026-10-18 新增）。（audit）
- `tests/offline/test-tool-surface.mjs` — P3「工具面收敛」回归（2026-10-18）。（audit）
- `tests/offline/test-v2-initial-prompt.mjs` — 二代仿真「会话初始提示词」回归：操作者在控制台为某个群/私聊预写环境说明，（audit；npm: test:initial-prompt）
- `tests/offline/test-v2-wait.mjs` — 二代“对面没说完 / 结束前等待”逻辑测试。（audit；npm: test-wait）
- `tests/offline/test-voice-edge.mjs` — 并发与边界体检：确认语音系统在「同时多个请求 / 异常输入 / 重名 / 缺目录」下不炸、不乱。（audit）
- `tests/offline/test-voice-gui.mjs` — 图形界面（voice-gui.mjs + public/voice.html）自检（audit；npm: test-voice:gui）
- `tests/offline/test-voice-system.mjs` — 语音系统整体自检（结构层）：把「独立工具 + qq-bridge 语音系统」的所有入口、依赖、（audit；npm: test-voice:system）
- `tests/offline/test-voice-volume.mjs` — 音量调节自检（audit）
- `tests/offline/test-voice.mjs` — 语音发送自检（audit；npm: test-voice）
- `tests/offline/test-wait-backlog.mjs` — qq_wait_for_messages 的「漏消息窗口」回归（2026-10-18 修）。（audit）

### 单独运行的测试

- `tests/live/test-console-ui.mjs`（npm: test:console-ui）
- `tests/live/test-console.mjs` — 控制台增强功能综合测试（node 直接调 API）（npm: test-console）
- `tests/live/test-dsh-auth.mjs` — DSH 鉴权适配回归测试（0.1.7 起）。（npm: test:dsh-auth）
- `tests/live/test-dsh-session-retire.mjs` — DSH 会话退役（stopSessionWork）的**实时**端到端测试。需要 DSH 正在运行。（npm: test:session-retire:e2e）
- `tests/live/test-dsh-v2-wait.mjs` — 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问，（npm: test-wait:e2e）
- `tests/live/test-mcp-exec.mjs` — 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手
- `tests/live/test-mcp-host.mjs` — 测试桥接自带的 snowluma-host MCP server（status/start/stop）
- `tests/live/test-mcp-safe.mjs` — 测试安全版 QQ MCP server：工具清单 + 白名单发送校验
- `tests/live/test-mcp-servers-stdio.mjs` — 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具，（npm: test:mcp-servers）
- `tests/live/test-mcp-web-search.mjs` — 测试安全 Web Search / Fetch MCP server
- `tests/live/test-onebot-connection.mjs` — 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关，
- `tests/live/test-setup-dsh-idempotent.mjs` — setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次，（npm: test:setup-idempotent）
- `tests/live/test-sticker-http-fallback.mjs` — 表情库同步的「WS 挂掉」兜底回归（2026-10-18）。
- `tests/live/test-vision-media.mjs` — 视觉/图片链路自检脚本（npm: test-vision）
- `tests/live/test-voice-preview.mjs` — 图形界面音量端点验证（live）：/api/preview 必须真的按音量产出不同音频。

### 探针与校验

- `probes/adaptation-probe-helpers.mjs` — Shared by the live verifier and its isolated protocol regressions.
- `probes/probe-020-protocol.mjs` — DSH 0.2.0 协议契约实测探针（只读观测 + 自清理）。（npm: probe:protocol）
- `probes/probe-020-settings.mjs` — 探测 DSH settings 命名空间机制：列出全部命名空间（重点 `qq-mode`）并**幂等写回原值**（npm: probe:settings）
- `probes/probe-auth.mjs` — 诊断探针共用的 DSH 鉴权/请求引导。
- `probes/probe-events.mjs` — 端到端验证：remote.mux 事件流 + turn 收集 + 工具调用事件形状。（npm: probe:events）
- `probes/probe-models.mjs` — 读取 DSH 的 settings/describe，列出所有 namespace 与可选模型（只读）。
- `probes/probe-rpc-compat.mjs` — 对比探测：逐条验证桥接实际使用的 RPC 参数形状在新版 DSH 上是否被接受。
- `probes/probe-snowluma-heartbeat.mjs` — 只读探针：连 SnowLuma 的 OneBot WebSocket，等一个 heartbeat，打印载荷里的（npm: probe:heartbeat）
- `probes/probe-tools.mjs` — 端到端验证 QQ preset 的「工具面」与「工具协议」（npm: probe:tools）
- `probes/probe-workspace.mjs` — 验证 workspace/session RPC 参数形状与返回值结构（对照 bridge.js 实际用法）。
- `probes/verify-agent-presets-017.mjs` — 验证 DSH 0.1.7 的 agent preset 是否真的装上了（只读探测 + 断言）。
- `probes/verify-dsh-022-adaptation.mjs` — DSH 适配总验证（0.2.2 版）。（npm: verify:adaptation）
- `probes/verify-persona-config.mjs` — 用 DSH 自身的 dsh-persona 配置 schema 校验修复后的 preset persona 配置。（npm: verify:persona）

### 安装、生成与修补

- `setup/build-agent-preset-patches.mjs` — 把 dsh/agent-presets/<preset>/ 的 preset 源文件
- `setup/gen-scripts-index.mjs` — scripts/ 索引生成器：按**目录分类**把 scripts/ 里的脚本写进 scripts/README.md。（npm: scripts:index / scripts:index:check）
- `setup/patch-snowluma-sdk.mjs` — 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名，（npm: postinstall）
- `setup/setup-dsh.mjs` — 在目标设备上安装 qq-bridge 的 DSH 端配置

### 控制台

- `console/console-ui-fixture.mjs`（npm: preview:console）

### 运维、诊断与扫描

- `ops/bridge-launcher.mjs` — 跨平台桥接启动器（替代 start.bat / restart.bat）。（npm: start / restart）
- `ops/check-onebot-status.mjs` — 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket
- `ops/convert-role-cards.mjs` — 把旧版 roles/*.md 人格卡迁移成 roles/*.json（不修改 README.md）。
- `ops/diagnose-acl.mjs` — 诊断：仓库里哪些路径的 ACL 被**切断了继承**，因而在 DSH 沙箱会话里不可写。（npm: diagnose:acl）
- `ops/harden-state-acl.mjs` — state/ 目录权限收紧的「可提权」入口。（npm: harden-acl）
- `ops/privacy-scan.mjs` — 发布前隐私与敏感信息扫描（**离线、只读、不联网**）。（npm: privacy-scan / privacy-scan:history）
- `ops/scan-dsh-tool-names.mjs` — DSH 工具名清单扫描器：从**已安装的 DSH 包/插件**里抽取真实注册的工具名，（npm: scan:tool-names）
- `ops/stop-bridge-instance.mjs` — 只停止**本仓库**这一个 qq-bridge 实例，供 `npm run restart` / `npm run stop` 使用。（npm: stop）

### 会向 QQ 发送内容（谨慎）

- `send/send-test-group.mjs` — 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。
- `send/send-voice.mjs` — 快速把「准备好的音频」当 QQ 语音发给指定群聊/私聊。（npm: send-voice）

### 内部库与夹具

- `lib/dsh-modules.mjs` — 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
- `lib/dsh-tool-names.mjs` — DSH 工具名抽取：**唯一实现**，供
- `lib/voice-tool-locator.mjs` — 「发语音」独立工具的位置解析 + 「它不在本仓库」时的统一跳过口径。

### 其它

- `ensure-config.mjs` — 首次安装/启动前自动生成 work/config.json（由 npm postinstall / prestart 调用）。（npm: postinstall / prestart / ensure:config）

### 工作文件（work/，经常编辑）

- `work/console-ui-contracts.json`
- `work/console.html`

### 仓库数据文件（data/，静态只读）

- `data/config.example.json`
- `data/console-ui-legacy-ids.json`
- `data/console.before.html`
- `data/privacy-rules.example.json`

<!-- scripts-index:end -->
