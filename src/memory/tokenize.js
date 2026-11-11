// 轻量检索：中文 2-gram + 拉丁词，配 BM25 打分。
//
// 为什么不用 FTS5：P1 是纯 JSON 后端（见 docs/design/MEMORY_PLUGIN_DESIGN.md §3.2），
// 单会话事件量在千条内，内存里建一次倒排/DF 表足够；等超过 §3.2 的升级阈值再换 SQLite+FTS5，
// 检索接口（query/recall）保持不变。
//
// 中文为什么不按空格切：中文没有词边界，unicode61 式的"整句一个 token"会让"吉他"匹配不上
// "今天学了吉他"。2-gram 是零依赖、无词典的折中：召回够用，代价是索引略大、偶有误配。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 把一段文本切成去重的 token 集合：拉丁词/数字 + 中文 2-gram（单字也保留）。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();

  for (const m of s.matchAll(/[a-z0-9][a-z0-9_'-]{0,}/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }

  let run = '';
  const flush = () => {
    if (!run) return;
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
    }
    run = '';
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      run += ch;
    } else {
      flush();
    }
  }
  flush();
  return [...tokens];
}

/** 两段文本的 2-gram Jaccard 相似度（用于"新不新"的 novelty 判断）。 */
export function jaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/**
 * BM25：对 items 按 cue 打分。
 * @param {any[]} items
 * @param {string} cue
 * @param {(item: any) => string} getText
 * @returns {{ item: any, score: number }[]} 按分数降序
 */
export function bm25Scores(items, cue, getText) {
  const docs = (Array.isArray(items) ? items : []).map((item) => {
    const tokens = tokenize(getText(item));
    return { item, tokens, set: new Set(tokens) };
  });
  const n = docs.length;
  if (!n) return [];
  const cueTokens = [...new Set(tokenize(cue))];
  if (!cueTokens.length) return [];

  const df = new Map();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.tokens.length;
    for (const t of doc.set) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgLen = totalLen / n || 1;
  const k1 = 1.2;
  const b = 0.75;

  return docs
    .map((doc) => {
      let score = 0;
      for (const t of cueTokens) {
        if (!doc.set.has(t)) continue;
        const dfi = df.get(t) || 0;
        const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
        const tf = doc.tokens.filter((x) => x === t).length;
        score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * doc.tokens.length) / avgLen));
      }
      return { item: doc.item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b2) => b2.score - a.score);
}
