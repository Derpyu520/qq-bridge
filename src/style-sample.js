// 从最近的群聊消息里提取「语感样本」：句子长度、标点习惯、常用语气词，再挑几句当范例。
//
// 目的：让 AI 学这个群「怎么说话」，而不是靠通用人设硬演。
// 边界：只学语气与节奏，不学内容、不点名模仿某个人、不重复别人的原句——这三条写在提示词里。
const FILLERS = ['草', '乐', '典', '？', '?', '啊', '吧', '吗', '呢', '哈', '6', '难绷', '小丑', '绝了', '我去', '我超', '不是'];
const NOISE_RE = /\[(图片|表情|语音|视频|文件|转发消息[^\]]*)\]/;

function cleanText(msg) {
  const raw = String(msg?.text ?? msg?.plain ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (NOISE_RE.test(raw)) return '';
  if (/https?:\/\//.test(raw)) return '';
  // 去掉开头的 @某人
  return raw.replace(/^((@\S+\s*)+)/, '').trim();
}

export function buildStyleHint(messages, { maxExamples = 4, maxChars = 600, lookback = 40, title = '这个群怎么说话', closing } = {}) {
  const list = Array.isArray(messages) ? messages.slice(-lookback) : [];
  const others = list.filter((m) => m && !m.isSelf);
  if (others.length < 4) return '';
  const texts = [];
  let mediaCount = 0;
  for (const m of others) {
    if (m.hasMedia) mediaCount += 1;
    const t = cleanText(m);
    if (t && t.length >= 1 && t.length <= 60) texts.push(t);
  }
  if (texts.length < 3) return '';

  const lens = texts.map((t) => t.length);
  const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const punctRate = texts.filter((t) => /[。，！？；：]/.test(t)).length / texts.length;
  const questionRate = texts.filter((t) => /[?？]$/.test(t)).length / texts.length;
  const fillerHits = FILLERS
    .map((f) => ({ f, n: texts.filter((t) => t.includes(f)).length }))
    .filter((x) => x.n >= Math.max(2, Math.round(texts.length * 0.15)))
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((x) => x.f);

  const parts = [`${texts.length} 条里平均 ${avg} 字（中位 ${median} 字）`];
  if (punctRate < 0.3) parts.push('基本不打句号逗号');
  if (questionRate >= 0.2) parts.push('常拿问号收尾');
  if (fillerHits.length) parts.push(`爱用「${fillerHits.join('」「')}」`);
  if (mediaCount > 0) parts.push(`图/表情占 ${Math.round((mediaCount / others.length) * 100)}%`);

  // 挑例句：长短各取一点，避免全是一个调
  const pool = texts.filter((t) => t.length >= 2 && t.length <= 30);
  const shortOnes = pool.filter((t) => t.length <= 8);
  const midOnes = pool.filter((t) => t.length > 8 && t.length <= 20);
  const picked = [];
  const take = (arr, n) => {
    for (const t of arr) {
      if (picked.length >= maxExamples || picked.length >= n + picked.length) break;
      if (!picked.includes(t)) picked.push(t);
      if (picked.length >= maxExamples) break;
    }
  };
  take(shortOnes.slice(-3), Math.ceil(maxExamples / 2));
  take(midOnes.slice(-3), maxExamples);

  let hint = `【${title}】${parts.join('；')}。`;
  if (picked.length) {
    hint += `\n像这样（只学语气，别照抄内容、别模仿某一个具体的人）：\n${picked.slice(0, maxExamples).map((t) => `- ${t}`).join('\n')}`;
  }
  hint += `\n${closing || '你的第一条消息尽量 ≤15 字；能一个词说完就别写一句；不要用「其实/总的来说/希望对你有帮助/确实如此/我理解」这类客服腔。'}`;
  return hint.slice(0, maxChars);
}
