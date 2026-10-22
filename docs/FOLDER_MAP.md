# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么、哪些脚本像是过期的一次性产物。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-09-29（v0.2.0 / DSH 0.2.0-rc.2 适配）。新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

```
DSH/                         ← 工作区根（不是仓库根）
├── qq-bridge/               ← 本仓库（QQ ↔ DSH 桥接）
├── voice-tool/              ← 独立「发语音」工具（从 qq-bridge 拆出；不依赖桥接运行）
├── 发语音-图形界面.cmd      ← 工作区根的双击启动器 → 进 voice-tool/ 起图形界面
└── 重启DSH-加载语音工具.cmd  ← 工作区根的运维启动器（重启 DSH 让 MCP 工具重新挂载）
```

`qq-bridge/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：主程序、DSH 客户端、三个 MCP server、黑话/表情/语音共享库 | 不能动。`bridge.js` 是主程序（约 10,400 行，QSH 计划拆分）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现**。**目录里只应有 `.js`**：曾经的 `bridge.js.bak-*` 会污染全局搜索并看起来像 module，2026-09-20 已移出（见下） |
| `scripts/` | 调试 / 测试 / 一次性运维脚本（见第二节命名约定） | 测试脚本不能删；`cleanup-*` / `fix-*` / `patch-*` / `diag-*` 多为历史遗留 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 的**权威源**，含工具白名单 `qq-tool-restrict.mjs` 的 re-export 壳）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/qq-agent-presets/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：`qq-mode-console`（暴露 `qq-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`qq-agent-presets`（生成两个 preset 行 + 携带唯一的 `qq-tool-restrict` 权威实现） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100） | 目录里只应有这一个文件；历史备份 `console.html.bak` 已移出仓库 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `audio/` | **语音库**（用户的真实音频）。桥接的 AI 语音工具只能发这里的文件；独立 `voice-tool` 默认也指向这里 | **用户文件，绝不删除/移动** |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌）。`.gitignore` 排除 | **用户数据，绝不删除/移动** |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

脚本共 87 个文件（83 个 `.mjs` + 4 个 JSON 基线，另有 `fixtures/` 目录）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-dsh-*.mjs` | **需要活的 DSH**（不在 `test:audit` 里）：`test-dsh-auth.mjs`（鉴权链路）、`test-dsh-inbox-projection.mjs`（会话队列投影解析，离线）、`test-dsh-session-retire.mjs`（退役会话的端到端回归）、`test-dsh-v2-wait.mjs`（preset 工具面） | 保留（改 DSH 契约时必须跑） |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-021-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | **探针**：用来问 DSH/SnowLuma「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间）。鉴权统一走 `probe-auth.mjs` | 保留，按需重跑 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `qq-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与 QQ 守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息、不建会话 | 保留（`npm run probe:heartbeat`） |
| `voice-tool-locator.mjs` | 「发语音」独立工具（在仓库上一级 `../voice-tool/`）的位置解析 + 「它不在本仓库」时的统一跳过口径；支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖 | 保留（被 6 个测试引用） |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `harden-snowluma-status.mjs` | 关闭 SnowLuma 自带的状态指令（默认 `#sl`）：由 SnowLuma 自己回版本/平台/运行时长，**绕过桥接出站审计**。幂等，改前备份到 `state/command-shield-backups/`，需重启 SnowLuma 生效；支持 `--dry-run`。要写 `state/`，**必须在普通终端跑**（DSH 沙箱写不进去）。控制台「访问与安全 → 系统指令屏蔽」的同一按钮复用 `src/snowluma-status-hardening.js`，由桥接进程执行，不受沙箱限制 | 保留（`npm run harden:snowluma-status`） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) §2.6：DSH 沙箱的写权限只靠继承下发能力 SID，切断继承 ⇒ 沙箱里写不进去。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-*.mjs` | **补丁**（含 `postinstall` 的 `patch-snowluma-sdk.mjs`：修 `@snowluma/sdk` 的 ESM 打包 bug） | `patch-snowluma-sdk.mjs` **必须保留**（postinstall 依赖）；其余见第四节 |
| `cleanup-*.mjs` | **清理一次性残留**（probe 会话/工作区、测试会话） | 见第四节 |
| `fix-*.mjs` | **一次性修复**（针对某次运行产生的脏数据） | 见第四节 |
| `diag-*.mjs` | **诊断**（如归档并清理日志） | 见第四节 |
| `debug-*.mjs` | **调试**（如白名单逻辑对照） | 见第四节 |
| `CONSOLE-UI-TESTING.md` | 已移到 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | — |

---

## 三、`docs/` 结构

```
docs/
├── README.md     # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md # 本文件
├── guides/       # 面向使用者/运维：DSH_SETUP / DSH_020_ADAPTATION / SECURITY_BASELINE / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY / PROJECT_GUIDE / VOICE
├── design/       # 设计与规划：GEN2_SIMULATION_PLAN / SOCIAL_MODE_PLAN / DSH_QQ_TOOLS_PLAN / 真人语感策略
├── research/     # 调研：SnowLuma功能调研 / 免打扰 / 表情包 / 本地模型选型
├── audits/       # 审查与优化报告（最新的全项目体检是 AUDIT_REPORT_2026-09-20）
└── legacy/       # 历史归档（已被取代 / 问题已全部修复的旧报告）
```

> ⚠️ **哪些文档真的会进公开仓库**：`.gitignore` 第 52–64 行把
> `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 以及
> `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` **整体排除**了
> （原因写在那里：这批文档里扫出过多份含本机真实路径的内容）。
> 也就是说：**只有 `docs/README.md`、`docs/FOLDER_MAP.md` 与 `docs/guides/` 下的其余几篇会出现在 GitHub 上**，
> 上面那份索引里指向 `audits/` `design/` `legacy/` `research/` 的链接**对公开读者是死链**，只在本机有效。
> 因此：**要公开的新文档请放 `docs/guides/`**（新写的 `DSH_020_ADAPTATION.md` 就放这里）；
> 放进那四个目录 = 只在本机可见，`git add` 会直接被 .gitignore 挡下。

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

---

## 四、疑似过期的一次性脚本（未删除，待确认）

> 判断依据：`.gitignore` 已把它们列为「Local one-off dev/debug/patch scripts（machine-specific paths/IDs,
> or bound to artifacts of a single probe run under `state/`）」——也就是说作者当初就认为**它们不该进公开仓库**；
> 加上脚本内容绑定某一次运行留下的 `state/` 残留。**本次整理没有移动或删除任何脚本**，仅列出待人工确认。

| 脚本 | 像是过期的理由 |
| --- | --- |
| `scripts/cleanup-probe-sessions.mjs` | 清理某次 probe 在 DSH 里建的会话；probe 产物已不在（`state/` 下 `self-test*` 目录仍有余留），脚本本身是一次性的 |
| `scripts/cleanup-probe-workspaces.mjs` | 同上，清理 probe 建的工作区 |
| `scripts/cleanup-test-sessions.mjs` | 同上，清理自测会话 |
| `scripts/fix-probe-workspace-title.mjs` | 修某次 probe 工作区标题的脏数据；一次性 |
| `scripts/diag-archive.mjs` | 诊断 + 归档日志；日志归档已手动完成，属一次性运维 |
| `scripts/debug-whitelist.mjs` | 白名单逻辑对照调试；与 `test-audit-*` 的白名单用例重复 |
| `scripts/patch-qq-chat-v2-presleep.mjs` | 给 `qq-chat-v2` preset **打一次补丁**；目标内容现已直接在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里，重跑会重复插入 |
| `scripts/patch-qq-chat-v2-stickers.mjs` | 同上（表情包小节） |
| `scripts/patch-qq-chat-v2-collect-memory.mjs` | 同上（收藏 + 记忆小节） |
| `scripts/patch-web-mcp-timeout.mjs` | 给 DSH 的 web MCP 配置打超时补丁；属对**外部 DSH 安装**的一次性改动，重启/升级 DSH 后语义就变了 |
| `scripts/probe-015.mjs` | **v0.2.0 已删除**：针对 DSH **0.1.5** 的探针，结论早已被 verifier 取代，且它走的是 0.1.5 的点号协议路径。同一用途改由 `scripts/probe-020-protocol.mjs`（`npm run probe:protocol`）承担 | 已删除 |
| `scripts/probe-rpc-compat.mjs` / `probe-models.mjs` / `probe-workspace.mjs` / `probe-events.mjs` / `probe-tools.mjs` | 协议/能力探针：问完「DSH 现在长什么样」用处就小了。**v0.2.0 已修好**：它们的鉴权过去各自复制「从 guard 日志抓 launch token」，那条路在 DSH 0.1.7 起就死了（一律 401），现统一走 `probe-auth.mjs` 的离线铸造 Cookie；工作区也改到系统临时目录（`state/` 的 ACL 被收紧，沙箱里写不进去）。挂在 `npm run probe:*` 上，按需重跑 | 保留 |
| `scripts/test-onebot-connection.mjs` / `test-mcp-*.mjs`（`test-mcp-exec` / `-host` / `-safe` / `-web-search`） | **不在** `test-audit.mjs` 的清单里，属手工排查脚本而非回归套件；功能上被 `check-onebot-status.mjs` / `test-audit-security-mcp.mjs` 覆盖 |

处理建议（**没有执行**，等确认）：确认无用后整批移到一个不影响 `npm run test:audit` 的位置
（例如 `scripts/legacy/`），或直接删除——它们都不在 `package.json` 脚本里，也没有被 `test-audit.mjs` 引用，
移动不会影响任何自动化回归。反过来，**下面这些千万别当"过期脚本"清掉**：

- `scripts/patch-snowluma-sdk.mjs`（`postinstall` 依赖，删了 `npm install` 就坏）
- `scripts/test-audit.mjs` 清单里的每一个（完整清单见该文件 `tests[]` 数组）
- `scripts/console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`（被测试/工具引用）

---

## 五、独立工具 `voice-tool/`（不在本仓库内）

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（**可选**）。本机显式把 `voice.voiceDir` 指向 `../qq-bridge/audio`，让已有音频继续可见 |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../qq-bridge/src/voice-core.js` 与 `../qq-bridge/src/snowluma-conn.js`
引同一份实现（qq-bridge 里的 `src/send-voice-lib.js` 也是转发这同一份）。
