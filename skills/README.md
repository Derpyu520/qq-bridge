# qq-persona-card（DSH skill）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的一个 skill：把「我想加一个角色」变成一张
可以直接启用的 `roles/<角色名>.md`，并跑完校验。

## 安装

```bash
# Windows（PowerShell）
Copy-Item -Recurse skills\qq-persona-card "$env:USERPROFILE\.dsh\skills\qq-persona-card"

# Linux / macOS
cp -r skills/qq-persona-card ~/.dsh/skills/
```

装好后在 DSH 里说「帮我写一张人格卡」即可触发；也可以直接把 `SKILL.md` 的内容当提示词喂给模型。

## 它管什么

- 人格层（你是谁、关系、语气、梗、雷点）与仿真层（工具怎么调、怎么分条）的分层判据；
- `## 行为合同` 的精确格式与解析规则（写错不会报错，只会静默失效）；
- 去 AI 味的可执行手法、回复示例的必考五类；
- 注入预算、截断顺序、模式标记；
- 上线前的校验命令与验收清单。

## 它不管什么

- 改仿真提示词（那是 `dsh/agent-presets/qq-chat*/agent.cordis.yml` 的 `persona.prefix`）；
- 改桥接代码；
- 人物卡记忆（用 `qq_person_note`）。

## 示例卡

仓库自带两张：`roles/小鲸鱼.md`（完整结构）与 `roles/傲娇助手.md`（极简卡）。
照着写之前先读 [roles/README.md](../roles/README.md)。
