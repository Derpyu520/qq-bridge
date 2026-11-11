# 仓库目录地图（FOLDER_MAP）

> 说明顶层目录、主要脚本和公开 / 本地文档边界。本文描述当前结构，不作为删除文件的指令。
> 文档索引见 [README.md](README.md)。最后核对：2026-11-10。

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
| `src/` | 桥接主程序与共享模块 | 入口 `bridge.js` / `self-test.js` 留在根目录；`mcp/` 放三个 MCP server（由 DSH 按 setup-dsh 写入的绝对路径启动）；按职责分目录：`dsh/`（客户端/端点/preset/账本/价目）、`qq/`（文件/转发/表情/连接/等待）、`media/`（图片归一/语音）、`text/`（Markdown/脱敏/人格/提示词/黑话）、`web/`（联网搜索）、`util/`（安全抓取/ACL/配置路径）、`mcp/`（三个 MCP server）；`core/` 是 session-router |
| `scripts/` | 离线回归、安装、诊断、探针和运维脚本 | 文件以 Git 跟踪清单为准；新增回归脚本应加入 `scripts/test-audit.mjs` |
| `dsh/agent-presets/` | `qq-chat` / `qq-chat-v2` / `qq-chat-tools` 的权威 preset 源 | 修改后运行 `node scripts/setup/build-agent-preset-patches.mjs` 重新生成 bundle patch；`qq-*.mjs` 只是 re-export 壳，实现文件在 `plugins/qq-agent-presets/` |
| `plugins/` | DSH bundle：`qq-agent-presets` 与 `qq-mode-console` | 修改后需重新同步安装并重启 DSH；`qq-mode-console` 目前只有 host 半 |
| `work/` | **经常编辑、运行中**的文件：`console.html` 本地控制台前端、`console-ui-contracts.json` 契约基线、`config.json` 本机配置（`.gitignore` 排除，由 scripts/ensure-config.mjs 在 npm 生命周期生成） | 桥接/测试读取这里的最新版本；改完跑 preview/test-console-ui/test:audit；旧布局 `config/config.json` 与根 `config.json` 仍兼容 |
| `data/` | 很少改动的**静态基线/模板**：`console.before.html` 旧版快照、`console-ui-legacy-ids.json` 旧 ID、`config.example.json` 配置模板、`privacy-rules.example.json` 隐私规则模板 | 运行时不写；只有重录基线/改模板时才动 |
| `roles/` | 人格卡与人格写作说明 | 属于用户可编辑内容；权限和注入规则见 `docs/RULES.md`、`roles/README.md` |
| `assets/` | 仓库用图片等资源 | 当前仅跟踪 `deepseek娘.png`；演示视频作为 Release 附件管理，不入库 |
| `audio/` | 本地语音库，默认被 `.gitignore` 排除 | 用户音频不应提交或随意删除 |
| `state/` | 会话、模式、日志、锁、令牌等运行时数据 | 被 `.gitignore` 排除；不要提交，也不要在测试中使用生产副本 |
| `docs/` | 公开指南、历史记录、规则/许可/安全/贡献文档 | 本地扩展清单见 [LOCAL_EXTENSIONS](guides/LOCAL_EXTENSIONS.md)；公开 / 本地边界见第三节 |
| `node_modules/`、`.npm-cache/` | 依赖与缓存 | 不入库 |

## 二、`scripts/` 命名与用途

脚本索引（按前缀分类、标注 audit/npm 入口）见 [scripts/README.md](../scripts/README.md)，
由 `node scripts/setup/gen-scripts-index.mjs` 生成；`scripts/tests/offline/test-scripts-index.mjs` 会在
`test:audit` 里检查索引是否过期。下面是约定摘要，不是允许随意删除的清单；是否仍被使用
应结合 `package.json`、`scripts/test-audit.mjs` 和实际引用判断。

| 目录 | 用途与注意事项 |
| --- | --- |
| `audit/` | 离线审计子模块（桥接、协议、网络、运行时、权限、安装边界）与 `audit-bridge-harness.mjs` 夹具 |
| `tests/offline/` | 离线测试。只有登记在 `scripts/test-audit.mjs` 清单里的才会随 `npm run test:audit` 执行 |
| `tests/live/` | 需要 DSH / SnowLuma / QQ 的实时测试（`test-dsh-*`、`test-mcp-*`、`test-onebot-connection` 等），环境要求见各文件头 |
| `probes/` | 探针与适配校验（`probe-*`、`verify-*`、`probe-auth`/`adaptation-probe-helpers`）。可能连接真实本机服务，不属于纯离线套件；`probe-snowluma-heartbeat` 只读，`probe-020-settings` 会写回原值，`probe-020-protocol` 会建测试会话/工作区并自清理 |
| `setup/` | 安装、生成与修补：`setup-dsh`、`build-agent-preset-patches`、`patch-snowluma-sdk`（postinstall 依赖，不能删）、`gen-scripts-index` |
| `ops/` | 运维、诊断与扫描：`privacy-scan`（规则模板 `data/privacy-rules.example.json`）、`check-onebot-status`、`diagnose-acl`、`harden-state-acl`、`scan-dsh-tool-names`、`stop-bridge-instance`（供 `npm run stop` / `npm run restart` 使用） |
| `console/` | 控制台离线预览、fixture 与 API 基线；说明见 [CONSOLE-UI-TESTING](guides/CONSOLE-UI-TESTING.md) |
| `send/` | 可能向真实 QQ 发送内容的小工具，运行前必须核对目标和环境 |
| `lib/` | 共享实现：`dsh-modules`、`dsh-tool-names`、`voice-tool-locator` |
| `fixtures/` | 测试夹具资源 |
| 根目录 | 只有 `test-audit.mjs`（运行入口）与 `README.md`（本索引导航） |

一次性清理/修复/调试脚本（`cleanup-*`、`fix-*`、`diag-*`、`debug-*`）不提交，规则在 `scripts/.gitignore`。

### 不应误删的基础文件

- `scripts/test-audit.mjs` 清单中的回归脚本；
- `scripts/audit/audit-bridge-harness.mjs`、`scripts/lib/dsh-modules.mjs` 等共享实现；
- `scripts/console/` 的 fixture 与基线；
- `scripts/setup/patch-snowluma-sdk.mjs`；
- `data/privacy-rules.example.json`。

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

根目录的文档只保留 `README.md`、`README.en.md`、`LICENSE`；`work/` 与 `data/` 是资源/数据目录；`RULES.md`、`NOTICE.md`、
`SECURITY.md`、`CONTRIBUTING.md` 与各指南都在 `docs/`，`.github/` 只放社区健康文件与工作流。

`.gitignore` 采用「根规则 + 目录规则」分层：根 `.gitignore` 只放全局项（依赖、运行时状态、
日志、`audio/`），各目录用各自的 `.gitignore` 管本目录的本地文件
（`work/.gitignore`、`docs/.gitignore`、`docs/guides/.gitignore`、`scripts/.gitignore`、`assets/.gitignore`）。
新增本机私密文件时，把规则加到**它所在目录**的 `.gitignore`，不要堆回根文件；
`scripts/ops/privacy-scan.mjs` 在 git 不可用时会逐目录读取这些规则做回退扫描。

## 四、仓库外独立语音工具

`voice-tool/` 位于工作区而非本仓库。它可以复用本仓库的 `src/media/voice-core.js` 与
`src/qq/snowluma-conn.js`，但独立部署和运行。相关测试通过 `scripts/lib/voice-tool-locator.mjs` 查找它；
目录不存在时应明确跳过对应检查，而不是把“缺少可选工具”误判为通过或失败。

本地语音库、工具配置和运行状态仍按各自 `.gitignore` 规则处理，不应因文档整理而移动或删除。
