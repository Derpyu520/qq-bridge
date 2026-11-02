# 记忆（拟人记忆）

> 小鲸鱼有自己的长期/短期记忆。**记不记、记多久，由它自己判断**（不是规则替它决定）；
> 遗忘也按重要度自动进行——像人一样，重要的事留着，琐碎的忘掉。

---

## 1. 谁来决定记什么

**AI 自己决定。** 唤醒提示里只给它一份索引和规则，不塞记忆正文：

```
【你的记忆】你有自己的长期记忆（按会话分开，别人看不到）。
- 聊天流水 196 条，涉及 3 个人，跨 5 天。
【记什么由你判断】觉得这件事有长期/短期记忆价值时，自己写进去：
  qq_memory_save(key, text, scope="long"|"short", importance=1~5)
  约定/偏好/重要经历写 long；一时的话题/对方当下状态写 short。
  不写也不会丢细节（流水仍在，recall 查得到），但只有写下的才被当作"记得"。
【牵扯到过去就先查】先 qq_memory_recall(key, question) 查，再开口，别凭印象编。
```

于是它遇到「阿草说她在学吉他」会自己判断：这值得记 → `qq_memory_save(..., scope="long", importance=3, who="阿草")`。
闲聊「今天吃啥」它可能就不写。

## 2. 遗忘：按重要度保留 / 压缩 / 遗忘

| 情形 | 动作 |
| --- | --- |
| 短期记忆超过 3 天，重要度 ≥3 | **升为长期**（同时压成一行摘要） |
| 短期记忆超过 3 天，重要度 ≤2 | **遗忘** |
| 长期记忆 90 天没被回忆，重要度 ≤2 | **遗忘** |
| 长期记忆 90 天没被回忆，重要度 =3 | **压缩**（保留前 80 字） |
| 长期记忆 90 天没被回忆，重要度 ≥4 | **原样保留**（约定/重要经历不压缩） |

- 纯规则、可解释、不调模型；每小时自动跑一次，控制台也能手动触发。
- 被 `qq_memory_recall` 命中会刷新 `lastAccess`——"常被想起的事"不会淡。
- 遗忘的条目保留 7 天便于追溯，之后物理删除。
- 容量护栏：单会话最多 400 条，超出丢最不重要且最旧的。

## 3. 存储

```
state/memory/<会话 key 冒号转横线>/
  memories.json   AI 自己写的记忆（scope/importance/lastAccess/status）——权威数据
  MEMORY.md       上面那份的可读视图（长期在前、短期在后、★ 表示重要度）
  events-*.jsonl  聊天流水（自动记录，供 recall 查细节与审计）
  profiles.json   群友画像   index.json 锚点索引   meta.json 水位
```

会话之间**完全隔离**：A 群的记忆不会出现在 B 群，私聊也不会串到群里。

## 4. 工具（MCP）

| 工具 | 用途 |
| --- | --- |
| **`qq_memory_save(key, text, scope, importance, who)`** | AI 自己写记忆（长期/短期 + 重要度） |
| **`qq_memory_recall(key, question, limit?)`** | 主动回忆：先查自己写的记忆，再查聊天流水；带日期与上下文 |
| **`qq_memory_forget(key, id)`** | 删掉写错/过时的记忆 |
| `qq_memory_append` / `query` / `remove` / `clear` | 旧的轻量便签（话题/想说未说的话/群友印象），保留兼容 |

`qq_memory_recall` 的检索：2-gram BM25 + 时间衰减 + **上下文扩展**（命中一条会把同一段对话前后几分钟一起带回），
整句提问查不到时退化为关键词再查；完全无重合时返回空（宁可说不知道，也不塞无关记忆）。

## 5. 控制台

「聊天行为 → 记忆」：启用开关、统计（流水/画像/AI 自己写的记忆/文件大小）、
**按会话读取 MEMORY.md**、**从事件重建**、**执行记忆整理**、清空。

| 接口 | 用途 |
| --- | --- |
| GET `/api/memory` | 开关、统计、按会话明细 |
| GET `/api/memory/file?key=` | 读 MEMORY.md |
| POST `/api/memory/retention` | 手动跑保留策略（`{}` 全部会话，`{key}` 单个） |
| POST `/api/memory/rebuild` | 从事件重建 MEMORY.md |
| POST `/api/memory/enabled` | 开关（写 config.json，即时生效） |
| POST `/api/memory/reset` | 清空（`{}` 全部 / `{key}` 单个） |

模型侧：`/api/socialV2/memory-save`、`memory-forget`、`memory-recall`（会话令牌鉴权）。

## 6. 配置

```json
{
  "memory": {
    "enabled": true,
    "dir": "state/memory",
    "eventThreshold": 0.45,
    "recentDays": 7,
    "retention": {
      "shortTermDays": 3,
      "promoteImportance": 3,
      "longStaleDays": 90,
      "longForgetImportance": 2,
      "longCompressChars": 80
    }
  }
}
```

## 7. 运维

```bash
npm run test:memory                        # 29 项：检索、记忆写入、遗忘策略、Markdown、控制台
node scripts/migrate-memory-markdown.mjs   # 把聊天流水重建成可读 MEMORY.md
node scripts/probe-memory-limits.mjs <key> # 看某会话的检索效果
```

- 觉得它记太碎：调高 `eventThreshold`，或在提示词里强调"只记以后会用到的"。
- 觉得它忘太快：调大 `retention.shortTermDays` / `longStaleDays`。
- 想让它重新认识某个群：控制台清空该会话记忆。

## 8. 如何移除

1. 控制台关掉开关；
2. 删 `src/memory/`、`scripts/*memory*`；
3. 删 `bridge.js` 里 `createMemoryPlugin` 的接入、`/api/memory*`、`/api/socialV2/memory-*` 路由，
   `public/console.html` 的记忆页，`config.json` 的 `memory` 段。

桥接对记忆的依赖只有几处 `memoryPlugin?.` 软调用，删掉后其余功能不受影响。
