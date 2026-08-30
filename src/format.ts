// 纯文本/分句/发送节奏相关的纯函数（不依赖 cfg/QQ/DSH 运行时状态）。

export const randInt = (min: number, max: number): number => {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
};

export function singleLineForQQ(s: unknown): string {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function splitLongSegment(segment: unknown, max: unknown): string[] {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  const rawMax = Number(max);
  const safeMax = Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 500;
  if (s.length <= safeMax) return [s];

  const urlRe = /https?:\/\/[^\s，。；、]+/g;
  const urls: string[] = [];
  const masked = s.replace(urlRe, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  const raw = masked.split(/([，、；：,;:])/);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
  }
  const out: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.length > safeMax) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
    } else if (cur.length + tok.length <= safeMax) {
      cur += tok;
    } else {
      out.push(cur);
      cur = tok;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i: string) => urls[Number(i)] ?? ''))
    .filter(Boolean);
}

export function isCjkChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

export function splitByCjkSpaces(src: unknown): string[] {
  const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return tokens;
  const groups: string[] = [];
  let cur = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const prevLast = [...cur].pop() || '';
    const currFirst = [...tokens[i]][0] || '';
    if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
      groups.push(cur);
      cur = tokens[i];
    } else {
      cur = cur + ' ' + tokens[i];
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

export function planSocialTimeline(text: unknown, socialCfg: any): { main: string[]; followUp: null } {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
  const enabled = socialCfg?.burstEnabled !== false;
  if (!src) return { main: [], followUp: null };

  if (!enabled) {
    return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
  }

  const parts = splitByCjkSpaces(src);
  if (parts.length <= 1) {
    return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
  }

  const main: string[] = [];
  for (const part of parts) {
    main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
  }
  return { main: main.filter(Boolean), followUp: null };
}

export function isCjkLikeChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

export function convertExampleSpacesToComma(line: string): string {
  const chars = Array.from(String(line ?? ''));
  const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && isCjkLikeChar(prev);
      const nextCjk = !!next && isCjkLikeChar(next);
      const prevBlocked = !!prev && NO_REPLACE.has(prev);
      const nextBlocked = !!next && NO_REPLACE.has(next);
      if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function findCjkSpaceWarning(messages: string[]): string | null {
  const bad: number[] = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const chars = Array.from(String(messages[i] ?? ''));
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (ch !== ' ' && ch !== '\t') continue;
      const prev = chars[j - 1];
      const next = chars[j + 1];
      if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
        bad.push(i + 1);
        break;
      }
    }
  }
  if (!bad.length) return null;
  const list = [...new Set(bad)];
  const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
  return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
}

export function findSplitBoundaryWarning(messages: string[]): string | null {
  if (!Array.isArray(messages) || messages.length <= 1) return null;
  const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
  const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
  const bad: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const prev = String(messages[i] ?? '').trim();
    const next = String(messages[i + 1] ?? '').trim();
    if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
    const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
    const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
    const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
    if (nonTerminalPunct || incompleteTail) {
      bad.push(`${i + 1}、${i + 2}`);
    }
  }
  if (!bad.length) return null;
  return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
}

export function clampGapV2(ms: unknown, sendCfg: any): number {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

export function computeGapsV2(messages: string[], gapMode: any, gapMs: any, gaps: any, sendCfg: any): number[] {
  const delays: number[] = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
    } else {
      const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampGapV2(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && Math.random() < longProb;
      const min = useLong ? Number(sendCfg.longGapMinMs) || 5000 : Number(sendCfg.burstIntervalMinMs) || 1000;
      const max = useLong ? Number(sendCfg.longGapMaxMs) || 10000 : Number(sendCfg.burstIntervalMaxMs) || 3000;
      delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
    }
  }
  return delays;
}
