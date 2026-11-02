# 记忆（拟人记忆）

> 小鲸鱼有自己的长期记忆：**存成可读的 Markdown 文件**，唤醒时只看到一份「索引」，
> 话题牵扯到过去时由它**自己调用 `qq_memory_recall` 去翻**——像人回忆，而不是被灌一堆上下文。

---

## 1. 它是怎么工作的

```
消息 → 显著性打分 → 值得记才写进 events-*.jsonl（检索用）
                  └→ 同时写进 MEMORY.md（人类/模型都可读的正文）

唤醒 → 提示词里只放「记忆索引」：
        你有记忆，这个会话已记 N 条、涉及 M 个人、最近一条是…
        牵扯到过去就先调 qq_memory_recall(key, question)，再开口

模型判断需要回忆 → qq_memory_recall("摩天轮")
                → 本地 BM25 检索 + 时间衰减 + **上下文扩展**
                → 返回带日期的记忆片段（同一段对话前后几分钟一起带回）
                → 模型用细节接话：「那天摩天轮上的冰淇淋我记得，很甜」
```

**为什么不是「把记忆塞进提示词」**：那样模型只是被动接收一段文本，既浪费 token，也不会
"想起来"。现在正文留在文件里，只在需要时取——检索不到就不硬说记得。

## 2. 存储

```
state/memory/<会话 key 冒号转横线>/
  MEMORY.md                 可读正文（按天分节，最新在上，每条带 [#编号] 与时间/说话人）
  events-YYYY-MM-DD.jsonl   原始事件（检索与增量用，append-only）
  profiles.json             群友画像（互动次数/最近出现/最后一句）
  index.json                条目锚点索引
  meta.json                 版本 / 迁移标记 / 最近清理时间
```

- `MEMORY.md` 可以直接用编辑器打开查看、修正；改坏了用控制台「从事件重建」还原。
- 会话之间**完全隔离**：A 群的记忆不会出现在 B 群，私聊也不会串到群里。

## 3. 控制台

左侧「聊天行为 → 记忆」：

- **启用记忆插件**（开关）：写 `config.json` 的 `memory.enabled`，即时生效、无需重启。
  关闭后唤醒提示回落到旧的便签记忆（进行中的话题 / 想说未说的话 / 群友印象），数据保留。
- **按会话查看**：条目数 / 画像数 / 最近记忆，可**读取 MEMORY.md 正文**、**从事件重建**。
- **清空全部记忆**：只删 `state/memory/`，不碰会话映射与旧便签，不可撤销。

接口（仅控制台令牌可访问）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/memory` | 开关、统计、按会话明细 |
| GET | `/api/memory/file?key=` | 读 MEMORY.md 正文 |
| POST | `/api/memory/rebuild` | 从事件流重建 MEMORY.md |
| POST | `/api/memory/enabled` | `{ enabled }` |
| POST | `/api/memory/config` | `{ eventThreshold?, recentDays? }` |
| POST | `/api/memory/reset` | `{}` 清空全部；`{ key }` 清空单个会话 |

模型侧工具（MCP，带会话令牌）：

- **`qq_memory_recall(key, question, limit?)`** —— 回忆，返回带日期的记忆片段（核心）
- `qq_memory_append` —— 记一条（约定/偏好/重要经历/对某人的印象）
- `qq_memory_query` —— 查当前轻量便签（话题/想说未说的话/群友印象）
- `qq_memory_remove` / `qq_memory_clear` —— 删除

## 4. 配置

```json
{
  "memory": {
    "enabled": true,
    "dir": "state/memory",
    "eventThreshold": 0.45,
    "recentDays": 7,
    "maxEventsRead": 5000,
    "migrateSocialV2": true,
    "weights": { "importance": 0.3, "confidence": 0.2, "source": 0.15, "recency": 0.15, "access": 0.1, "relation": 0.1 },
    "forgetting": { "tauFastDays": 1.5, "tauSlowDays": 30, "fastShare": 0.6 }
  }
}
```

`eventThreshold` 调高 → 记得更挑剔；调低 → 记得更勤。`recentDays` 影响「最近的记忆」窗口。

## 5. 运维

```bash
npm run test:memory                          # 27 项：分词/BM25、遗忘曲线、权重、回忆、Markdown 读写、控制台
node scripts/probe-memory-limits.mjs <key>   # 看某会话的记忆检索效果
node scripts/migrate-memory-markdown.mjs     # 事件流 → MEMORY.md（已有数据升级/修复）
```

- 想让它「重新认识」某个群：控制台清空该会话记忆。
- 觉得它乱回忆：调高 `eventThreshold`，或清理 `MEMORY.md` 里不该留的条目。
- 隐私：记忆只在本地；会话间隔离；提示词里不会出现本机路径。

## 6. 如何移除

1. 控制台关掉开关（写 `memory.enabled: false`）；
2. 删 `src/memory/`、`scripts/*memory*`；
3. 删 `bridge.js` 里 `createMemoryPlugin` 的接入、`/api/memory*` 路由、`/api/socialV2/memory-recall`，
   `public/console.html` 的记忆页，以及 `config.json` 的 `memory` 段。

桥接对记忆的依赖只有几处 `memoryPlugin?.` 软调用，删掉后其余功能不受影响。
