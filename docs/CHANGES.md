# 本仓库相对上游的改动

> 基线：上游 [`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge) `main`（2026-10-22，`a49877f`）。
> 本仓库 = 该基线 + 二代上线后的全部改进 + 三代仿真。**没有删除上游文件**：
> 对比结果是 **55 个文件修改、49 个文件新增、0 个删除**（其中 8 个新增是开源脚手架，见文末）。
>
> 复现方法（需要 git）：
>
> ```bash
> git clone https://github.com/Derpyu520/qq-bridge.git upstream
> # 把本仓库内容覆盖进 upstream（排除 .git / node_modules / state），再：
> cd upstream && git status --short && git diff --stat
> ```

---

## 一、引擎（`src/bridge.js` 678 KB → 921 KB）

二代上线后的一整批行为改动，按主题：

| 主题 | 内容 |
| --- | --- |
| 限额 | 发送/唤醒的滑动窗口：每分钟 / 每小时 / 每 2 小时 / 每日；分支级 + 跨会话全局级；超限 429 + `retryAfterMs` |
| 管理员动作 | 改群名片/群名/群头像、QQ 昵称/签名/头像、发空间说说；确认卡、审计、撤销、冷却 |
| 权限模型 | 「不开放 / 仅应要求 / 人设自主」三档 + `persona_veto` 驳回 |
| 资料与空间 | 读公开资料/头像、读自己与好友的空间动态、发说说（白名单字段 + SSRF-safe + 回读校验） |
| 表情包 | 清单/看图/人格匹配/发送频率档位/收藏/删除；动图抽帧 |
| 记忆与关系 | 人物卡（事实/边界/互动/置信度）、熟悉度与关系档位、轻量记忆、摘要 |
| 主动发言 | 会话级概率调整、冷场/被无视打分、四道乘数；换人格/解除静音后自动补排检查 |
| 多模态 | 图片归一化、语音发送内核、文档阅读（PDF/DOCX/XLSX）、语音转写/OCR |
| 运维 | DSH 端口自动跟随、状态 ACL 加固、旁路发送审计、token 账本与价目表 |
| 三代仿真 | `reserved3` 模式、`socialV3` 配置档、`qq-chat-v3` preset——详见 [design/GEN3.md](design/GEN3.md) |

## 二、新增模块（上游没有这些文件）

| 文件 | 作用 |
| --- | --- |
| `src/admin-ops.mjs` | 管理员动作的纯逻辑：参数归一、确认、撤销、审计 |
| `src/bot-perms.mjs` | 机器人自主操作三档权限模型 |
| `src/quota.js` | 滑动窗口限额（分钟/小时/2 小时/日）纯计算 |
| `src/qq-social-profile.mjs` | QQ 资料/头像/空间的纯逻辑层 |
| `src/person-score.mjs` | 人物熟悉度与关系档位 |
| `src/proactive-score.mjs` | 每会话主动概率调整 |
| `src/dsh-endpoint.js` | DSH 端口发现与自愈 |
| `src/snowluma-egress.js` | SnowLuma 旁路发送审计（只读） |

> 对应地，`src/role-card.js`（4.2 KB → 9.8 KB）、`src/sticker-lib.js`（15.5 KB → 25.8 KB）、
> `src/preset-prompt.js`、`src/media-normalize.js` 也有扩展。

## 三、控制台（`public/console.html` 241 KB → 320 KB）

- 三代仿真页（克隆二代表单，只提交 `timing/decision/context/document/tools`）
- 令牌与花费看板（峰谷分时、逐轮下钻）
- 人格与角色页（按模式注入字符数、警告、绑定）
- 表情包参数（频率档位、收藏/删除上限）
- 访问与安全页（模式、白名单、机器人自主权限）
- 活动日志 / 决策日志 / 额度使用

## 四、preset

| 文件 | 变化 |
| --- | --- |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 24.5 KB → 29.0 KB：工具协议、记忆/表情/引用/收尾规则补全 |
| `dsh/agent-presets/qq-chat-v3/` | **新增**：三代专用 preset（32 KB） |
| `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` | 23.3 KB → 27.7 KB（生成物） |
| `plugins/qq-agent-presets/presets/qq-chat-v3.patch.yml` | **新增**（生成物） |

## 五、文档

| 文档 | 说明 |
| --- | --- |
| `README.md` / `README.en.md` | 33.7 KB → 41.9 KB：新增能力、配置项、运维说明 |
| `RULES.md` | 11.9 KB → 19.8 KB：权限边界、管理员动作、群聊安全 |
| `docs/guides/SECURITY_BASELINE.md` | 16.9 KB → 20.8 KB：新闸门与风险 |
| `docs/guides/DSH_SETUP.md` | 16.7 KB → 18.2 KB |
| `docs/guides/ADMIN_OPS.md` | **新增**：管理员动作全流程 |
| `docs/guides/PROACTIVE.md` | **新增**：主动发言的概率与冷却 |
| `docs/guides/QQ_PROFILE_QZONE.md` | **新增**：资料/头像/空间边界 |
| `docs/guides/GEN3_CHAT_PERSONA_EVAL.md` | **新增**：自然度与人设一致性评测 |
| `docs/design/GEN3.md` | **新增**：三代实现说明（对代码求证） |
| `docs/design/GEN3_ENGINE_PLAN.md` | **新增**：三代设计稿（部分未落地） |
| `docs/README.md` / `docs/FOLDER_MAP.md` | 按实际目录重写 |

## 六、测试与工具

- `scripts/test-audit-regressions.mjs`：27 KB → 74 KB，新增三代/权限/限额/人格切换等回归（R1–R43）。
- 新增离线测试：`test-admin-ops*`、`test-quota`、`test-role-card`（扩充）、`test-stickers`（扩充）、
  `test-sticker-delete`、`test-sticker-frequency`、`test-qzone-profile`、`test-dsh-endpoint`、
  `test-document-parser`、`test-proactive-session`、`test-snowluma-egress`、`test-behavior-contract`、
  `test-console-static`（扩充）等。
- 新增运维/探针：`check-personas`、`probe-admin-actions`、`smoke-gateway-p1`、`sync-dsh-port`。
- `scripts/privacy-scan.mjs`：修复「9–10 位数字」规则被噪音过滤吞掉的 bug，并补占位符白名单。

## 七、开源脚手架（不属于上游功能，PR 时可单独一个 commit）

`CONTRIBUTING.md`、`SECURITY.md`、`skills/qq-persona-card/`、`skills/README.md`、`assets/README.md`、
`docs/UPSTREAM_PR.md`、`audio/.gitkeep`、`media/.gitkeep`。

---

## 怎么核对

```bash
git diff --stat                    # 55 modified / 49 added
git diff -- src/bridge.js          # 引擎改动（最大的一块）
git diff -- public/console.html    # 控制台
git status --short                 # 新增文件
```
