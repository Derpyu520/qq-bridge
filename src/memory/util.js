// 记忆插件的文件层工具：原子写、JSONL 追加/读取、目录与时间小函数。
//
// 为什么不直接用 bridge.js 里的 atomicWriteJson：那个函数在 main() 闭包里、没有导出。
// 这里保留一份等价实现（唯一临时名 + rename），并额外在覆盖前留一份 `.bak`：
// 结构化记忆（profiles/anchor/meta）比配置更需要能回滚 —— 写坏一份不该让"记忆"全灭。
//
// Windows 注意：mode 0o600 在 Windows 上是空操作（ACL 由父目录继承）。
// state/ 的整体收紧由 bridge 启动时的 hardenDir 负责，这里不重复做。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读 JSON；文件不存在返回 fallback，损坏时回调 onCorrupt 并返回 fallback。 */
export function readJsonSafe(file, fallback, onCorrupt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (typeof onCorrupt === 'function') onCorrupt(error, file);
    return fallback;
  }
}

/** 原子写 JSON：先写唯一临时文件再 rename；覆盖前把旧版复制成 .bak（只留一份）。 */
export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // .bak 是锦上添花，失败不影响主写入。
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** 追加一行 JSONL（只增不改，适合事件流）。 */
export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** 读 JSONL：坏行跳过并在连续损坏时回调；返回解析成功的对象数组。 */
export function readJsonl(file, onCorrupt) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
      bad = 0;
    } catch (error) {
      bad += 1;
      if (bad === 3 && typeof onCorrupt === 'function') onCorrupt(error, file);
    }
  }
  return out;
}

/** 本地时区的 YYYY-MM-DD，用于按天切分事件文件。 */
export function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 按字符截断（不切割代理对）。 */
export function truncate(text, max) {
  const s = String(text ?? '');
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max).join('');
}

/**
 * 会话 key → 目录名。
 * key 形如 `group:123` / `private:456`；**冒号在 Windows 上是非法文件名字符**，
 * 直接 mkdir 会 ENOENT（实测 `mkdir '...\group:100'` 报 ENOENT），所以冒号换成 `-`。
 * 其余非法字符回落 `_`，并防 `.`/`..`/空值造成路径穿越。
 */
export function safeSegment(value) {
  const s = String(value ?? '').trim().replace(/:/g, '-');
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_invalid';
  return cleaned;
}
