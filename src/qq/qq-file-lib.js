// QQ 收到的「文件」段共享库（纯函数，便于离线回归）。
//
// 背景：OneBot 的 file 段（群文件 / 私聊离线文件）与图片完全不同 —— 它不带可直接
// 内联的字节，只有一个 file_id / busid（群文件）或临时 URL，必须由桥接主动去网关
// 换取下载链接再抓取。这里只放**不依赖网络/不依赖 bot 实例**的部分：
//   · 下载目录解析（config.files.dir，默认 state/downloads）
//   · 文件名净化与去重（防止 `../../` 之类的路径穿越写出目录）
//   · 文本类文件判定与解码（附件不可用时的内联兜底）
//   · file 消息段 → 统一的 media 元数据
//
// 网络抓取/落盘/上传 DSH 的编排放在 bridge.js（那里才有 bot、safeFetchBuffer、api）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认下载目录：相对仓库根；与 state/ 同级，已被 .gitignore 排除。 */
export const DEFAULT_DOWNLOAD_DIR = 'state/downloads';
/** 单个文件默认上限 20 MB（与语音一致；超过就只给元数据，不下载/不内联）。 */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 内联文本时的默认字符上限：约 8k token 量级，避免一条消息吃掉整个上下文。 */
export const DEFAULT_MAX_INLINE_CHARS = 20000;
/** 单条消息里所有文本文件的内联总量上限（默认 = 单文件上限 × 2）。 */
export const DEFAULT_MAX_INLINE_TOTAL_CHARS = DEFAULT_MAX_INLINE_CHARS * 2;

/** 视为「可直接内联为文本」的扩展名（小写，含点）。 */
export const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.cmd',
  '.ps1', '.sql', '.env', '.properties', '.srt', '.vtt'
]);

/** Windows 保留设备名：即使带扩展名也不能作为文件名（CON.txt 同样非法）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * 解析下载目录为绝对路径。
 * 相对路径按仓库根（root）解析，绝对路径原样使用；空值回退默认目录。
 * 不做「必须在仓库内」的限制：用户可能故意指到 ~/Downloads（配置值属于用户）。
 * @param {string} dir - config.files.dir。
 * @param {string} root - 仓库根目录。
 * @returns {string} 绝对路径。
 */
export function resolveDownloadDir(dir, root) {
  const raw = String(dir ?? '').trim() || DEFAULT_DOWNLOAD_DIR;
  if (/^file:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return path.resolve(p);
    } catch {}
  }
  if (/^~[\\/]?/.test(raw)) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    return path.resolve(home, raw.replace(/^~[\\/]?/, ''));
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

/**
 * 净化 QQ 文件名：只保留 basename，去掉路径分隔、控制字符与 Windows 非法字符，
 * 去掉开头/结尾的点与空白，避开保留设备名，并限制长度（保留扩展名）。
 * @param {string} name - 原始文件名（可能含路径/URL 片段）。
 * @param {string} fallback - 净化后为空时的回退名。
 * @returns {string} 可安全用于 path.join(base, name) 的文件名。
 */
export function sanitizeQQFileName(name, fallback = 'qq-file') {
  let base = String(name ?? '').replace(/\\/g, '/');
  base = base.split('/').pop() ?? '';
  // 去掉 URL 查询串残留（有些实现把 `a.txt?x=1` 塞进 name）。只认 `?key=value` 形状：
  // 文件名里本来就可能含 `?`（如 `a?b.txt`），无条件 split('?') 会把后半截名字吃掉。
  base = base.replace(/\?[^?]*=[^?]*$/, '');
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
  base = base.replace(/^[\s.]+|[\s.]+$/g, '');
  base = base.trim();
  if (!base) base = fallback;
  base = base.replace(/\s+/g, ' ').slice(0, 120);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  if (WINDOWS_RESERVED.has(stem.toLowerCase())) base = `_${base}`;
  if (!base || base === '.' || base === '..') base = fallback;
  // 保证净化后仍是一个纯文件名：任何残余分隔符都不允许
  return path.basename(base);
}

/**
 * 在目录里为 filename 找一个不冲突的落盘路径（foo.txt → foo-2.txt）。
 * 调用方需先确保目录存在。
 * @param {string} dir - 目标目录。
 * @param {string} filename - 已净化的文件名。
 * @returns {string} 绝对路径。
 */
export function uniqueDownloadPath(dir, filename) {
  const root = path.resolve(dir);
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(root, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${stem}-${n}${ext}`);
    n += 1;
    if (n > 999) throw new Error('同名文件太多，换个名字再下载');
  }
  return candidate;
}

/**
 * 从文件名/内容推测是不是「可读文本」。
 * 只看扩展名；没有扩展名时返回 false（宁可不内联，也不要塞二进制垃圾进上下文）。
 * @param {string} name - 文件名。
 * @returns {boolean}
 */
export function isTextLikeFileName(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  return TEXT_FILE_EXTS.has(ext);
}

/**
 * 把文本文件字节解码成字符串：先按严格 UTF-8，失败再按 GBK（QQ 文件常见编码），
 * 最后退回宽松 UTF-8（替换字符）。
 * 同时剥离 BOM、统一换行，并按 maxChars 截断。
 * @param {Buffer} buffer - 文件字节。
 * @param {object} [options]
 * @param {number} [options.maxChars] - 最大字符数。
 * @returns {{ text: string, encoding: string, truncated: boolean, chars: number }}
 */
export function decodeTextFile(buffer, { maxChars = DEFAULT_MAX_INLINE_CHARS } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  let text = '';
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('gbk').decode(buf);
      encoding = 'gbk';
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
      encoding = 'utf-8(lossy)';
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 二进制垃圾检测：NUL 或极高比例的控制字符 ⇒ 不是文本，放弃内联。
  const probe = text.slice(0, 4096);
  let controls = 0;
  for (let i = 0; i < probe.length; i += 1) {
    const code = probe.charCodeAt(i);
    if (code === 0) { controls = probe.length; break; }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  if (probe.length > 0 && controls / probe.length > 0.02) {
    return { text: '', encoding: 'binary', truncated: false, chars: 0 };
  }
  text = text.replace(/\r\n?/g, '\n');
  const limit = Math.max(0, Number(maxChars) || 0);
  const truncated = limit > 0 && text.length > limit;
  if (truncated) text = text.slice(0, limit);
  return { text, encoding, truncated, chars: text.length };
}

/**
 * 把 OneBot 的 file 段 data 规范化成 media 元数据。
 * 字段名在 SnowLuma 各版本/各实现间不一致（file_id/fileId、file_name/name、size/file_size），
 * 这里全部读一遍，缺省为空串/0；file 字段可能是缓存文件名或本地路径，原样保留。
 * @param {object} data - 消息段的 data。
 * @returns {{kind:'file', fileId:string, busid:string, name:string, size:number, url:string, file:string}}
 */
export function fileMediaFromSegment(data) {
  const d = data && typeof data === 'object' ? data : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const rawSize = Number(d.size ?? d.file_size ?? d.fileSize ?? 0);
  return {
    kind: 'file',
    fileId: pick('file_id', 'fileId', 'id'),
    busid: pick('busid', 'bus_id'),
    name: pick('name', 'file_name', 'fileName', 'file'),
    size: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0,
    url: pick('url'),
    file: pick('file')
  };
}

/**
 * 人类可读的「[文件 xxx (12.3 KB)]」描述，供日志/提示词/工具返回复用。
 * @param {{name?:string,size?:number}} media
 * @param {(n:number)=>string} formatBytes - 字节格式化函数（避免这里再写一份）。
 * @returns {string}
 */
export function describeFileMedia(media, formatBytes = (n) => `${n} B`) {
  const name = String(media?.name ?? '').trim() || '未命名文件';
  const size = Number(media?.size) > 0 ? ` ${formatBytes(Number(media.size))}` : '';
  return `[文件 ${name}${size}]`;
}

/**
 * 从 URL 猜一个文件名（下载链接常带 filename 参数或 pathname 扩展名）。
 * @param {string} url
 * @returns {string} 猜测的名字；猜不出返回空串。
 */
export function fileNameFromUrl(url) {
  try {
    const u = new URL(String(url));
    const fromQuery = u.searchParams.get('filename') || u.searchParams.get('file') || u.searchParams.get('name');
    if (fromQuery) return String(fromQuery);
    const base = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    return base && base !== '/' ? base : '';
  } catch {
    return '';
  }
}

/**
 * 在「群文件列表」里按文件名 + 大小挑出目标文件。
 *
 * 背景：聊天消息里的 file_id 与群文件里的 file_id 是两套 id（实测同一文件：
 * 段里 `/14fe…`、群文件列表 `/0a5b…`）。段里的 id 调 get_group_file_url 会报
 * 「文件不存在」；但群文件里常常存在同名同大小的文件，用列表里的 id 才能取到链接。
 *
 * 只做**精确**匹配（名字 trim 后全等 + 可选大小相等），不做模糊匹配——
 * 同名不同内容在群文件里很常见，猜错比失败更糟。
 * @param {object[]} files - get_group_files_by_folder 返回的 files。
 * @param {{name?:string,size?:number}} media - 消息段里的文件元数据。
 * @returns {object|null} 命中的条目。
 */
export function pickGroupFileFromList(files, media) {
  const name = String(media?.name ?? '').trim();
  if (!name || !Array.isArray(files)) return null;
  const size = Number(media?.size) > 0 ? Number(media.size) : 0;
  return files.find((f) => String(f?.file_name ?? f?.name ?? '').trim() === name
    && (!size || Number(f?.file_size ?? f?.size ?? 0) === size)) ?? null;
}

/**
 * 下载目录里是否已有「同名同大小」的文件。
 *
 * 用途：`ensureQQFile` 在真正下载前先查一次，避免同一个大文件被重复下载、
 * 也避免反复落盘产生 `foo-2.zip`/`foo-3.zip`。只认精确的大小相等——
 * 大小不同就当作没下过（可能是残缺文件或同名不同内容）。
 * @param {string} dir - 下载目录。
 * @param {string} name - 原始文件名（内部会净化）。
 * @param {number} bytes - 期望字节数；0/未知时不做命中。
 * @returns {{path:string,name:string,dir:string,bytes:number}|null}
 */
export function findSavedDownload(dir, name, bytes) {
  const size = Number(bytes) > 0 ? Number(bytes) : 0;
  if (!size) return null;
  const root = path.resolve(dir);
  const safe = sanitizeQQFileName(name);
  const candidate = path.join(root, safe);
  try {
    const st = fs.statSync(candidate);
    if (st.isFile() && st.size === size) return { path: candidate, name: safe, dir: root, bytes: st.size };
  } catch {}
  return null;
}

/**
 * 解析「要上传到 QQ 的本地文件」并做根目录白名单校验。
 *
 * 上传是**出站**能力（把本机文件发给 QQ），必须比下载更保守：只允许 upload roots
 * （默认会话工作区与 files.dir）内的真实文件，防 `../` 穿越、防工作区内软链接指向
 * root 外。路径先 realpath 再比较，符号链接解析后的真实位置也必须落在 root 内。
 *
 * @param {string} rawPath - 模型/管理员给的路径（支持 `~`，相对路径按 cwd 解析）。
 * @param {{roots?:string[], cwd?:string, home?:string}} options
 * @returns {{path:string,name:string,size:number}}
 * @throws {Error} 路径为空/不存在/不是文件/越界时。
 */
export function resolveUploadPath(rawPath, { roots = [], cwd = process.cwd(), home = os.homedir() } = {}) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) throw new Error('path 不能为空');
  if (raw.includes('\u0000')) throw new Error('path 含非法字符');
  let expanded = raw;
  if (raw === '~') expanded = home;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) expanded = path.join(home, raw.slice(2));
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error(`文件不存在：${raw}`);
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new Error(`无法读取文件：${raw}`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${raw}`);
  const realRoots = (Array.isArray(roots) ? roots : [])
    .map((root) => {
      try { return fs.realpathSync(String(root)); } catch { return path.resolve(String(root ?? '')); }
    })
    .filter(Boolean);
  if (realRoots.length === 0) throw new Error('没有配置允许上传的目录（files.uploadRoots）');
  const within = realRoots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!within) {
    throw new Error(`拒绝上传 ${raw}：只允许上传工作区/下载目录内的文件（${realRoots.join('、')}）`);
  }
  return { path: real, name: path.basename(real), size: stat.size };
}

/**
 * 从网关返回的字段里尽力解析 base64（`base64://` / `data:` / 纯 base64）。
 * 只接受字符串；解析不出返回 null。
 */
export function base64FromMaybe(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
  if (s.startsWith('data:image/')) {
    const idx = s.indexOf(',');
    if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
  return null;
}
