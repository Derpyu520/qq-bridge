# 仓库目录地图（FOLDER_MAP）

> 说明顶层目录、主要脚本和公开 / 本地文档边界。本文描述当前结构，不作为删除文件的指令。
> 文档索引见 [README.md](README.md)。最后核对：2026-11-01。

## 一、工作区与仓库布局

典型本地工作区如下；仓库外目录不是 qq-bridge 的组成部分：

```text
DSH/                         ← 工作区根（不是仓库根）
├── qq-bridge/               ← 本仓库
├── voice-tool/              ← 可选的独立语音工具
├── 发语音-图形界面.cmd      ← 工作区启动器
└── 重启DSH-加载语音工具.cmd  ← 工作区运维启动器
```

`qq-bridge/` 内部的主要路径：

| 路径 | 作用 | 修改注意事项 |
| --- | --- | --- |
| `src/` | 桥接主程序、DSH 客户端、MCP server、共享库和核心模块 | 包含 `.js` 与 `.mjs`。`bridge.js` 约 1.3 万行；`state-acl.mjs`、`core/*.mjs` 同样属于源码 |
| `scripts/` | 离线回归、安装、诊断、探针和运维脚本 | 文件以 Git 跟踪清单为准；新增回归脚本应加入 `scripts/test-audit.mjs` |
| `dsh/agent-presets/` | `qq-chat` / `qq-chat-v2` 的权威 preset 源 | 修改后运行 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch |
| `plugins/` | DSH bundle：`qq-agent-presets` 与 `qq-mode-console` | 修改后需重新同步安装并重启 DSH；`qq-mode-console` 目前只有 host 半 |
| `public/console.html` | 桥接自带本地控制台 | 修改前端契约时同步 fixture、基线和离线回归 |
| `roles/` | 人格卡与人格写作说明 | 属于用户可编辑内容；权限和注入规则见 `RULES.md`、`roles/README.md` |
| `assets/` | 仓库用图片等资源 | 当前仅跟踪 `deepseek娘.png`；演示视频作为 Release 附件管理，不入库 |
| `audio/` | 本地语音库，默认被 `.gitignore` 排除 | 用户音频不应提交或随意删除 |
| `state/` | 会话、模式、日志、锁、令牌等运行时数据 | 被 `.gitignore` 排除；不要提交，也不要在测试中使用生产副本 |
| `docs/` | 公开指南、历史记录和本地文档目录约定 | 公开 / 本地边界见第三节 |
| `node_modules/`、`.npm-cache/` | 依赖与缓存 | 不入库 |
| `config.example.json` | 配置模板 | 修改配置结构时同步代码、文档和相关测试 |
| `config.json` | 用户真实配置 | 不入库，测试不得依赖它 |

## 二、`scripts/` 命名与用途

以下是主要约定，不是允许随意删除的清单。是否仍被使用应结合 `package.json`、
`scripts/test-audit.mjs` 和实际引用判断。

| 前缀 / 文件 | 用途与注意事项 |
| --- | --- |
| `test-*.mjs` | 自动化测试。只有加入 `scripts/test-audit.mjs` 的测试才会随 `npm run test:audit` 执行 |
| `test-audit-*.mjs` | 离线审计子模块，覆盖桥接、协议、网络、运行时、权限和安装边界 |
| `test-dsh-*.mjs` | DSH 契约测试；有些使用离线夹具，有些需要活的 DSH，环境要求以各文件和 `package.json` 为准 |
| `console-ui-*` | 控制台离线预览、fixture 和 API 基线；说明见 [CONSOLE-UI-TESTING](guides/CONSOLE-UI-TESTING.md) |
| `setup-*.mjs` | DSH 插件、preset 与 MCP 的幂等安装 |
| `verify-*.mjs` | DSH 适配和 persona 一致性检查 |
| `probe-*.mjs` | 本机兼容性检查，鉴权路径以各脚本为准（部分使用 `probe-auth.mjs`）。`probe-snowluma-heartbeat` 只读；`probe-020-settings` 将读取的 mode 原值写回以验证写入路径；`probe-020-protocol` 会创建测试会话 / 工作区，结束后归档会话、删除工作区并清理临时目录。可能连接真实本机服务，不属于纯离线套件 |
| `scan-*.mjs` | 工具名、依赖或其他静态对账 |
| `privacy-scan.mjs` | 工作树与历史隐私扫描；本地规则模板为 `privacy-rules.example.json` |
| `patch-*.mjs` | 兼容性修补。`patch-snowluma-sdk.mjs` 是 `postinstall` 依赖，不能当作一次性脚本删除 |
| `stop-bridge-instance.mjs` | 供 `restart.bat` 使用；结合锁 PID、控制台端口和当前仓库绝对脚本路径验证实例，无法证明归属时拒绝停止 |
| `harden-state-acl.mjs`、`diagnose-acl.mjs` | Windows ACL 收紧与只读诊断 |
| `send-*.mjs` | 可能向真实 QQ 发送内容的小工具，运行前必须核对目标和环境 |
| `cleanup-*`、`fix-*`、`diag-*`、`debug-*` | 清理、一次性修复或调试脚本；删除前仍需检查引用，不能仅凭前缀认定无用 |

### 不应误删的基础文件

- `scripts/test-audit.mjs` 清单中的回归脚本；
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs` 等共享实现；
- `scripts/console-ui-*` 的 fixture 与基线；
- `scripts/patch-snowluma-sdk.mjs`；
- `scripts/privacy-rules.example.json`。

## 三、公开与本地文档边界

入库文档主要是：

```text
docs/
├── README.md     # 公开文档索引
├── FOLDER_MAP.md # 本文件
└── guides/       # 安装、运维、安全、隐私、控制台、适配与带日期的工程记录
```

以下目录或文件可能存在于本地工作副本，但被 `.gitignore` 排除，不属于公开仓库：

- `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/`；
- `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md`。

公开文档不要给这些本地资料提供链接。`PROJECT_GUIDE.md` 是历史说明书，不是当前实现的唯一权威来源；
当前行为以代码、入库指南和带日期的验证记录为准。

根目录主要保留 `README.md`、`README.en.md`、`RULES.md`。`LICENSE`、`NOTICE.md`、`SECURITY.md`、
`CONTRIBUTING.md` 及 `.github/` 社区健康文件是约定例外，不适用于“其他文档一律进 `docs/`”的规则。

## 四、仓库外独立语音工具

`voice-tool/` 位于工作区而非本仓库。它可以复用本仓库的 `src/voice-core.js` 与
`src/snowluma-conn.js`，但独立部署和运行。相关测试通过 `scripts/voice-tool-locator.mjs` 查找它；
目录不存在时应明确跳过对应检查，而不是把“缺少可选工具”误判为通过或失败。

本地语音库、工具配置和运行状态仍按各自 `.gitignore` 规则处理，不应因文档整理而移动或删除。
