// 记忆文件：把「记忆」写成人类与模型都能读的 Markdown。
//
// 为什么是 Markdown 而不是只放 JSONL：
//   1) 拟人记忆的重点是「AI 自己会去查」——它要有可读的文件可查，而不是只能被动的塞进提示词；
//   2) 出问题时你能直接用编辑器打开看/改，不用写脚本解 JSONL；
//   3) 检索仍然走 JSONL 索引（BM25 快），Markdown 只是同一批记忆的**可读视图**。
//
// 目录布局（state/memory/<会话 key>/）：
//   MEMORY.md                 全部记忆的可读正文（按时间倒序，分节）
//   events-YYYY-MM-DD.jsonl   原始事件（检索与增量用，append-only）
//   profiles.json             群友画像（计数）
//   index.json                检索索引：条目 → 在 MEMORY.md 里的锚点/时间/标签
//   meta.json                 版本/水位/迁移标记
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, ensureDir, truncate, writeJsonAtomic } from './util.js';

export const MEMORY_MD = 'MEMORY.md';
export const MEMORY_INDEX = 'index.json';

const HEADER = [
  '# 记忆',
  '',
  '> 这份文件是小鲸鱼自己的记忆，按时间倒序记录。可以随时用文本编辑器打开查看或修正。',
  '> 每条前面的 `[#编号]` 是检索用的锚点；`[[索引]]` 段可以快速定位。',
  '',
].join('\n');

function sectionTitle(ev) {
  const day = new Date(Number(ev.t) || Date.now());
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const who = ev.isSelf ? '我说' : `${String(ev.sender ?? '未知')}说`;
  return `${stamp} · ${who}`;
}

/** 事件 → Markdown 里的一行（人类可读）。 */
export function eventToMarkdownLine(ev, seq) {
  const time = new Date(Number(ev.t) || Date.now());
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  const who = ev.isSelf ? '我' : String(ev.sender ?? '未知');
  const tags = [];
  if (ev.kind === 'poke') tags.push('拍一拍');
  if (ev.source === 'owner') tags.push('owner');
  if (ev.quotedSelf) tags.push('@我');
  const tagText = tags.length ? ` \`(${tags.join('/')})\`` : '';
  return `- [#${seq}] ${hhmm} **${who}**：${truncate(String(ev.text ?? '').replace(/\n+/g, ' '), 300)}${tagText}`;
}

/**
 * 把一条新记忆追加进 MEMORY.md。
 * 采用「在文件开头插入」而不是追加到末尾：最新的记忆最先被读到，
 * 也符合人翻笔记本时"最近的事写在最上面"的直觉。
 */
export function appendMemoryMarkdown(dir, ev, seq) {
  ensureDir(dir);
  const file = path.join(dir, MEMORY_MD);
  const line = eventToMarkdownLine(ev, seq);
  const title = sectionTitle(ev);

  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    body = HEADER;
  }
  // 首行之外的内容按「## 日期 · 谁说」分块；同一天同一个人的连续发言合并到同一块。
  const idx = body.indexOf('\n## ');
  const head = idx >= 0 ? body.slice(0, idx) : (body.trim() ? body : HEADER);
  let sections = idx >= 0 ? body.slice(idx + 1) : '';

  const heading = `## ${title}`;
  if (sections.startsWith(heading + '\n')) {
    // 合并进已有块：把新行插入到该块第一行之后（块内也保持最新在上）
    const rest = sections.slice(heading.length + 1);
    const [firstLine, ...others] = rest.split('\n');
    sections = `${heading}\n${line}\n${firstLine}${others.length ? '\n' + others.join('\n') : ''}`;
  } else {
    sections = `${heading}\n${line}\n\n${sections}`;
  }

  const next = `${head.trimEnd()}\n\n${sections.trimStart()}`.trimEnd() + '\n';
  fs.writeFileSync(file, next, 'utf8');
  return { file, seq };
}

/** 读整份 MEMORY.md（给「查看记忆」用）。 */
export function readMemoryMarkdown(dir) {
  try {
    return fs.readFileSync(path.join(dir, MEMORY_MD), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 维护检索索引：条目 → 锚点编号 / 时间 / 说话人 / 标签。
 * 只存元数据（不含正文），BM25 检索仍走 events JSONL，索引用于把命中结果映射回可读行。
 */
export function loadMemoryIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MEMORY_INDEX), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { version: 1, entries: {}, nextSeq: 1 };
  } catch {
    return { version: 1, entries: {}, nextSeq: 1 };
  }
}

export function saveMemoryIndex(dir, index) {
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, MEMORY_INDEX), index);
}

/** 重新生成整份 MEMORY.md（用于迁移/修复：从 events 重建可读视图）。 */
export function rebuildMemoryMarkdown(dir, events) {
  const sorted = [...events].sort((a, b) => Number(b.t) - Number(a.t)); // 最新在上
  const blocks = [];
  let currentTitle = null;
  let currentLines = [];
  let seq = 1;
  for (const ev of sorted) {
    const title = sectionTitle(ev);
    if (title !== currentTitle) {
      if (currentTitle) blocks.push(`## ${currentTitle}\n${currentLines.join('\n')}`);
      currentTitle = title;
      currentLines = [];
    }
    currentLines.push(eventToMarkdownLine(ev, seq));
    seq += 1;
  }
  if (currentTitle) blocks.push(`## ${currentTitle}\n${currentLines.join('\n')}`);
  const text = `${HEADER}${blocks.join('\n\n')}\n`;
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, MEMORY_MD), text, 'utf8');
  return { chars: text.length, entries: seq - 1 };
}

export { dayKey };
