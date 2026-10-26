# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余都在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。

---

## 先读哪几篇

| 你想做的事 | 读这篇 |
| --- | --- |
| 看本仓库相对上游改了什么 | [CHANGES.md](CHANGES.md) |
| 从零装起来、接上 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 搞懂三代仿真（Gen3）是什么、怎么开 | [design/GEN3.md](design/GEN3.md) |
| 看三代的设计取舍与完整方案 | [design/GEN3_ENGINE_PLAN.md](design/GEN3_ENGINE_PLAN.md)（设计稿，含未落地部分） |
| 验收一个角色像不像、稳不稳 | [guides/GEN3_CHAT_PERSONA_EVAL.md](guides/GEN3_CHAT_PERSONA_EVAL.md) |
| 写/改一张人格卡 | [../skills/qq-persona-card/SKILL.md](../skills/qq-persona-card/SKILL.md) + [../roles/README.md](../roles/README.md) |
| 让机器人改群名片/资料/头像 | [guides/ADMIN_OPS.md](guides/ADMIN_OPS.md) |
| 发布前清个人数据 | [guides/PRIVACY.md](guides/PRIVACY.md) |
| 安全边界、威胁模型 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |

---

## guides/ —— 使用与运维

| 文档 | 一句话说明 |
| --- | --- |
| [ADMIN_OPS.md](guides/ADMIN_OPS.md) | 管理员动作（群名片、QQ 资料/头像、撤回）：三档权限、确认卡、审计与撤销 |
| [DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 侧安装：agent preset、MCP server、端口发现与排错 |
| [DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | 适配 DSH 0.2.0 的改动与踩坑记录 |
| [DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | 适配 DSH 0.2.1：`{{cwd}}` 移除、工具面变化 |
| [GEN3_CHAT_PERSONA_EVAL.md](guides/GEN3_CHAT_PERSONA_EVAL.md) | 三代自然度与人设一致性的评测题目、锚点与评分表 |
| [PROACTIVE.md](guides/PROACTIVE.md) | 主动发言：什么时候可以主动开口、概率与冷却 |
| [QQ_PROFILE_QZONE.md](guides/QQ_PROFILE_QZONE.md) | QQ 资料/头像读取与 QQ 空间读写的边界 |
| [TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台里的 token 统计口径与缓存命中 |
| [CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台前端契约测试怎么写 |
| [PRIVACY.md](guides/PRIVACY.md) | 开源前的隐私清理清单与扫描器用法 |
| [SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线与威胁模型：白名单、闸门、已知风险 |

## design/ —— 设计与方案

| 文档 | 一句话说明 |
| --- | --- |
| [GEN3.md](design/GEN3.md) | 三代仿真的实现说明：模式、配置、分层、工具面、回退 |
| [GEN3_ENGINE_PLAN.md](design/GEN3_ENGINE_PLAN.md) | 三代设计稿：问题诊断、四层架构、数据模型、实施阶段（部分未落地） |
| [UPSTREAM_PR.md](UPSTREAM_PR.md) | 把三代作为 PR 送回上游的操作步骤与描述模板 |

---

## 约定

- 文档里出现真实 QQ 号/群号/路径一律用占位符：`1000000001`、`123456789`、`<你的昵称>`。
- 命令默认在仓库根目录执行；Windows 用 PowerShell，Linux/macOS 用 bash。
- 改了行为就顺手改对应文档；文档与代码冲突时以代码为准，并在 PR 里说明。
