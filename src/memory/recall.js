// 记忆查询：AI 主动「翻自己的记忆」时走这里。
//
// 与「把记忆塞进提示词」的区别：
//   · 提示词里只放**索引**（有多少条、最近记了什么、要查就去调工具）；
//   · 真正的内容由模型调用 qq_memory_recall(question) 时才拉出来。
//
// 检索策略（纯本地，不调模型）：
//   1) 2-gram BM25 召回（中文无需分词）；
//   2) 时间衰减加权（越近越优先，半衰期 ~30 天）；
//   3) **上下文扩展**：命中一条后，把同一段对话里前后几分钟的话一起带出来
//      —— 人回忆时想起的是"那件事"，不是孤立一句。这样问「摩天轮」也能带出
//      「在上面买了个冰淇淋，草莓味，特别甜」这条细节。
//   4) 兜底：一个字都没匹配上时，返回最近的几条记忆并注明"没直接匹配"，
//      避免模型因为查不到就断言"我不记得"。
import { bm25Scores, tokenize } from './tokenize.js';
import { DAY_MS } from './util.js';

const HALF_LIFE_DAYS = 30;
const EXPAND_WINDOW_MS = 5 * 60 * 1000;   // 前后 5 分钟算同一段对话
const MAX_CONTEXT_LINES = 6;              // 单段最多带几条上下文

function formatDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatAge(ts, now) {
  const days = Math.max(0, (now - Number(ts)) / DAY_MS);
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时前`;
  if (days < 30) return `${Math.round(days)} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

function toLine(ev, now) {
  const who = ev.isSelf ? '我' : String(ev.sender ?? '未知');
  return `${who}：${String(ev.text ?? '')}`;
}

// 只删**疑问词/时间指示词/代词**，保留动词和名词——"吃了什么"里的"吃"是有效线索，
// 删掉它会让整句退化成空（上一版把"吃/玩"也当停用词，导致「上次去玩吃了什么」永远查不到）。
const STOP_WORDS = /(上次|上回|之前|以前|那次|当时|后来|记得|说过|提起|什么|啥|怎么|为什么|哪个|哪位|吗|呢|吧|啊|我们|你们|他们)/g;

/** 从自然语言提问里抽关键词（去掉疑问词/时间指示词/代词）。 */
function extractKeywords(question) {
  const q = String(question ?? '');
  const stripped = q
    .replace(STOP_WORDS, ' ')
    .replace(/[，。！？、,.!?；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 过滤后太短（只剩一两个字）就保留原句，避免把有效信息删光
  return Array.from(stripped).length >= 2 ? stripped : '';
}

/**
 * 在某个会话的事件流里检索记忆。
 * @param {object[]} events 该会话的全部事件
 * @param {string} question 自然语言问题（"摩天轮" / "上次去玩吃了什么"）
 * @param {{now?: number, limit?: number}} [options]
 * @returns {{fragments: object[], total: number, question: string, mode: 'match'|'recent'|'empty'}}
 */
export function recallMemory(events, question, options = {}) {
  const now = Number(options.now) || Date.now();
  const limit = Math.max(1, Math.min(20, Math.round(Number(options.limit) || 5)));
  const q = String(question ?? '').trim();
  if (!q || !Array.isArray(events) || !events.length) {
    return { fragments: [], total: 0, question: q, mode: 'empty' };
  }

  // 按时间排序，方便做上下文扩展
  const ordered = [...events].sort((a, b) => Number(a.t) - Number(b.t));

  // 1) BM25 召回。整句提问（"上次去玩吃了什么"）对 2-gram 不友好，
  //    先按整句查；一条都没命中时，退化成关键词再查一次（去掉疑问词/虚词）。
  let scored = bm25Scores(events, q, (ev) => ev.text);
  if (!scored.length) {
    const keywords = extractKeywords(q);
    if (keywords && keywords !== q) scored = bm25Scores(events, keywords, (ev) => ev.text);
  }
  const qTokens = new Set(tokenize(q));

  // 2) 时间衰减 + 精确词命中加权
  const ranked = [];
  for (const { item, score } of scored) {
    const ageDays = Math.max(0, (now - Number(item.t)) / DAY_MS);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const tokens = new Set(tokenize(item.text));
    let overlap = 0;
    for (const t of qTokens) if (tokens.has(t)) overlap += 1;
    const exact = qTokens.size ? overlap / qTokens.size : 0;
    const final = score * (0.55 + 0.45 * recency) + exact * 2.5;
    ranked.push({ ev: item, final });
  }
  ranked.sort((a, b) => b.final - a.final);

  // 3) 上下文扩展：命中项前后几分钟的话一起带出来，重叠窗口合并
  const hitIdx = new Set();
  for (const { ev } of ranked.slice(0, limit)) {
    const i = ordered.indexOf(ev);
    if (i < 0) continue;
    hitIdx.add(i);
    let lo = i;
    let hi = i;
    while (lo > 0 && ordered[i].t - ordered[lo - 1].t <= EXPAND_WINDOW_MS) lo -= 1;
    while (hi < ordered.length - 1 && ordered[hi + 1].t - ordered[i].t <= EXPAND_WINDOW_MS) hi += 1;
    // 单段别太长
    if (hi - lo + 1 > MAX_CONTEXT_LINES) {
      const half = Math.floor(MAX_CONTEXT_LINES / 2);
      lo = Math.max(lo, i - half);
      hi = Math.min(hi, i + (MAX_CONTEXT_LINES - (i - lo) - 1));
    }
    for (let k = lo; k <= hi; k += 1) hitIdx.add(k);
  }

  if (!hitIdx.size) {
    // 4) 兜底：一个字都没匹配上。不要只丢"最近几条"——那样问「上次去玩吃了什么」只会
    //    翻到今天那句"好累"。改成：按「与提问共享字符/词」打分挑一批，共享得多的优先，
    //    再补最近几条，并注明"没有直接匹配"。
    const qTokens = new Set(tokenize(q));
    const qChars = new Set(Array.from(q).filter((c) => /[\u4e00-\u9fff]/.test(c)));
    const scoredRecent = ordered.map((ev) => {
      const text = String(ev.text ?? '');
      const tokens = new Set(tokenize(text));
      let tokenOverlap = 0;
      for (const t of qTokens) if (tokens.has(t)) tokenOverlap += 1;
      const charOverlap = Array.from(qChars).filter((c) => text.includes(c)).length;
      const ageDays = Math.max(0, (now - Number(ev.t)) / DAY_MS);
      const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      return { ev, overlap: tokenOverlap * 3 + charOverlap * 0.5, recency, score: tokenOverlap * 3 + charOverlap * 0.5 + recency };
    }).sort((a, b) => b.score - a.score);

    const picked = scoredRecent.slice(0, limit).map((x) => x.ev).sort((a, b) => Number(a.t) - Number(b.t));
    // 关键：兜底也要有底线——完全没有任何字符/词重合时（例如问"量子力学"），
    // 宁可返回空让模型照常聊，也不要把无关记忆硬塞给它（否则它会以为"我记得这事"）。
    const bestOverlap = scoredRecent[0]?.overlap ?? 0;
    if (bestOverlap <= 0.5) {
      return { fragments: [], total: events.length, question: q, mode: 'empty', note: '记忆里没有和这个问题相关的内容。照常聊，别硬说记得。' };
    }
    const head = picked[0] ?? ordered[ordered.length - 1];
    return {
      fragments: [{
        date: formatDate(head.t),
        age: formatAge(head.t, now),
        lines: picked.map((ev) => toLine(ev, now)),
        text: picked.map((ev) => toLine(ev, now)).join('\n'),
      }],
      total: events.length,
      question: q,
      mode: 'recent',
      note: '没有直接匹配到关键词，下面是按「和你的问题沾边的程度 + 新旧」挑出来的几条，可作参考；如果确实对不上，就照常聊，别硬说记得。',
    };
  }

  // 把命中的连续区间切成"片段"
  const indices = [...hitIdx].sort((a, b) => a - b);
  const fragments = [];
  let group = [indices[0]];
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] - indices[i - 1] <= 1) group.push(indices[i]);
    else { fragments.push(group); group = [indices[i]]; }
  }
  fragments.push(group);

  const result = fragments.slice(0, limit).map((g) => {
    const evs = g.map((i) => ordered[i]);
    const head = evs[0];
    return {
      date: formatDate(head.t),
      age: formatAge(head.t, now),
      // 给模型一段可直接读的文字
      lines: evs.map((ev) => toLine(ev, now)),
      text: evs.map((ev) => toLine(ev, now)).join('\n'),
    };
  });

  return { fragments: result, total: events.length, question: q, mode: 'match' };
}

/**
 * 生成注入提示词用的「记忆索引」：告诉模型记忆有多少、最近记了什么，以及"去哪查"。
 *
 * 刻意**不放正文**（只放最近一条的 ≤24 字引子，当作"我确实有这段记忆"的钩子）——
 * 正文由模型自己 recall。也**不放本机路径**：模型不需要知道文件系统，
 * 而且把 C:\... 写进提示词违反项目的隐私基线（"绝不透露本地路径"）。
 */
export function describeMemory({ key, counts, latest, now }) {
  const t = Number(now) || Date.now();
  const lines = [];
  lines.push('【你的记忆】你有自己的长期记忆（按会话分开，别人看不到）。');
  const memBits = [];
  if (counts.memories) memBits.push(`自己记下 ${counts.memories} 条（长期 ${counts.longMemories ?? 0} / 短期 ${counts.shortMemories ?? 0}）`);
  memBits.push(`聊天流水 ${counts.events} 条，涉及 ${counts.profiles} 个人，跨 ${counts.days} 天`);
  lines.push(`- ${memBits.join('；')}。`);
  if (latest) {
    const ageDays = Math.max(0, (t - Number(latest.t)) / DAY_MS);
    const age = ageDays < 1 ? `${Math.max(1, Math.round(ageDays * 24))} 小时前` : `${Math.round(ageDays)} 天前`;
    const who = latest.isSelf ? '我' : String(latest.sender ?? '未知');
    lines.push(`- 最近一条流水：${age}，${who}说「${String(latest.text ?? '').slice(0, 24)}…」`);
  }
  lines.push('');
  lines.push('【记什么由你判断】不是每句话都值得记。觉得这件事有长期或短期记忆价值时，自己写进去：');
  lines.push('  · qq_memory_save(key, text, scope="long"|"short", importance=1~5) —— 约定/偏好/重要经历/对某人的具体印象写 long；');
  lines.push('    一时的话题、对方当下的状态写 short（默认 3 天后：重要的升 long，其余自动遗忘）。');
  lines.push('  · 不写也不会丢细节：聊天流水仍在，qq_memory_recall 能查到；但只有你写下的才会被当作"记得"。');
  lines.push('  · importance 认真给：★ 越高越不容易被压缩/遗忘，也越容易被想起来。');
  lines.push('');
  lines.push('【牵扯到过去就先查】话题勾到以前发生过的事时，先调 qq_memory_recall(key, question) 查，再开口。');
  lines.push(`  例：有人说「上次那个摩天轮」→ 先查「摩天轮」，再接着聊细节（比如那天吃的冰淇淋很甜）。`);
  lines.push('  不要凭印象编；查不到就照常聊。记错了用 qq_memory_save 补一条更正、或 qq_memory_forget 删掉。');
  return lines.join('\n');
}
