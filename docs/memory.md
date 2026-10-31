# 跨会话世界记忆（soul / people / rooms / 日记）

给「大肥鱼」一套**跨私聊与群聊共享**的记忆，同时保证人格只有一个来源。
数据全部在 `state/memory/`，不依赖 DSH 插件，也不改 DSH 会话。

## 四层作用域

| 层 | 文件 | 内容 | 注入范围 |
|---|---|---|---|
| 我是谁 | `soul.md` | 长期自我设定、语气、立场、与主人的关系 | **所有会话，同一段文本** |
| 我认识谁 | `people.json` | 按 QQ 号的事实/别名/最后互动 | 只注入「本会话当前在场的人」 |
| 这是哪儿 | `rooms.json` | 群规、梗、长期话题 | 只注入当前房间 |
| 现在聊什么 | `social-v2.json` | activeTopic / pendingThought | 只注入本会话（沿用旧逻辑） |

另外：`log/YYYY-MM-DD.jsonl` 是全部消息原文（保留 60 天），`diary/YYYY-MM-DD.md` 是每日日记。
`diary-workspace.json` 记录日记专用工作区 id；`diary-agent/` 是它的工作目录。

## 隐私规则（硬编码在 `compose()` 里）

1. **私聊 → 群：禁止**。`origin` 以 `private:` 开头的事实，在群聊注入里一律丢弃。
2. **群 → 群**：只在当事人也在场时注入，并标注「来源：群xxx」。
3. **群 → 私聊**：允许（当事人自己的私聊里可以提他自己说过的话），保留来源标记。
4. **日记**：默认只在**主人私聊**注入（`diary.inject: owner`），避免私聊细节进群。

## 配置（`config.json` → `socialV2.memory`，可省略，走默认值）

```json
{
  "socialV2": {
    "memory": {
      "enabled": true,
      "budget": { "soul": 600, "people": 520, "room": 260, "diary": 300 },
      "diary": {
        "enabled": true,
        "at": "23:30",
        "maxChars": 140,
        "injectDays": 3,
        "inject": "owner",
        "catchUpDays": 2,
        "preset": "minimal",
        "timeoutMs": 180000
      }
    }
  }
}
```

- `diary.inject`：`owner`（仅主人私聊）/ `private`（所有私聊）/ `all`（所有会话）/ `off`。
- `diary.preset`：写日记用的 DSH preset，默认 `minimal`（不挂 QQ 工具）。
- `budget`：各段注入字数上限，超了从低优先级截断。

## 日记怎么工作

每天到点（默认 23:30）后，桥接在下一次分钟检查时：

1. 读 `log/<今天>.jsonl`，按房间压成摘要（总量 6000 字以内）；
2. 起一个临时 DSH 会话（`minimal` preset），让模型用大肥鱼第一人称写 80~130 字；
3. 写入 `diary/<今天>.md`，然后归档该会话（不留长历史）。

补写：桥接启动后 15 秒会检查一次；如果今天已过 23:30 而日记缺失，或过去 `catchUpDays` 天
有消息却没有日记，会自动补写。想重写某天：删掉 `diary/<那天>.md`，等下一个整分钟。

## 模型侧工具

- `qq_memory_append`：默认写本会话记忆；`scope=people` + `extra.qq` 写跨会话人物事实；
  `scope=room` 写本房间背景。
- `qq_memory_search`：在**本会话**的日志里检索（不跨房间），用于超出最近消息窗口的「以前说过什么」。

## 迁移与备份

- 首次启用时，会把旧版 `social-v2.json` 里按会话存的 `memberImpressions` 迁进 `people.json`，
  以 `alias:<昵称>` 占位；等真实 QQ 号出现时自动合并。
- 备份：直接复制 `state/memory/`。里面只有数据，不含代码。
- 清空某人的记忆：编辑 `people.json` 删除对应 QQ 号；或让模型用 `qq_memory_remove` 清理会话级记忆。
