// 管理员动作（改群名片 / 群名 / 群头像 / QQ 资料 / QQ 头像 / 发空间说说）的**纯逻辑**。
//
// 为什么单独一层：
//   这些动作带真实副作用（改错会影响整个群或整个账号），所以判定逻辑必须能在**离线**
//   回归里跑：动作白名单、参数校验、路径沙箱、确认文本解析、待确认队列、撤销选点。
//   把它们写进 bridge.js 那个一万五千行的主程序里，就只能靠起真网关手工试。
//
// 安全口径（与 RULES.md 一致）：
//   - 目标群必须在白名单里；allowAllWhenEmpty 对管理员动作**不适用**（空名单不放行）。
//   - 头像/群头像只接受 mediaRoot（默认 assets/）下的普通文件：拒绝绝对路径、`..`、
//     URL、base64 —— 否则模型可以把本机任意文件当头像外发。
//   - 空间说说的图片只接受**媒体库第一层的文件名**（不能带路径），数量/总大小有上限；
//     可见范围只认 QQ 的五个合法值，16/128 必须带名单。
//   - 确认只能由 owner 私聊消费，队列不认「谁说的」，只认桥接给它的 originKey。
import fs from 'node:fs';
import path from 'node:path';
import { allowsSelfService } from './bot-perms.mjs';
import { normalizeQzonePostArgs, ugcRightLabel } from './qq-social-profile.mjs';

/** 群级动作：作用对象是一个群。 */
const GROUP_ACTIONS = ['setGroupCard', 'setGroupName', 'setGroupPortrait'];
/** 账号级动作：作用对象是机器人自己的 QQ。 */
const ACCOUNT_ACTIONS = ['setQqProfile', 'setQqAvatar'];
/** 自助动作：不改变群/账号配置，只动机器人自己的行为。 */
const SELF_ACTIONS = ['recallMessage', 'setOnlineStatus'];
/** 空间动作：发一条说说（公开广播，但内容由 owner 确认）。 */
const SPACE_ACTIONS = ['postQzone'];
/** 全部受支持动作（顺序固定，供文档与测试断言）。 */
export const ADMIN_ACTIONS = Object.freeze([...GROUP_ACTIONS, ...ACCOUNT_ACTIONS, ...SELF_ACTIONS, ...SPACE_ACTIONS]);
/** 默认启用：名片 + 自身资料 + 头像 + 撤回 + 在线状态 + 发说说。群名/群头像需要群主权限，默认不开。 */
export const DEFAULT_ENABLED_ACTIONS = Object.freeze([
  'setGroupCard', 'setQqProfile', 'setQqAvatar', 'recallMessage', 'setOnlineStatus', 'postQzone'
]);

const ACTION_LABELS = Object.freeze({
  setGroupCard: '改群名片',
  setGroupName: '改群名',
  setGroupPortrait: '改群头像',
  setQqProfile: '改 QQ 资料',
  setQqAvatar: '改 QQ 头像',
  recallMessage: '撤回消息',
  setOnlineStatus: '设置在线状态',
  postQzone: '发 QQ 空间说说'
});

/**
 * 在线状态码 → 中文标签。
 * 取值按 Lagrange.Core 的 Status 枚举（10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰）。
 * 本机只实测过 10（在线，无可见变化）；其余值第一件真用时以网关返回为准。
 */
export const ONLINE_STATUS = Object.freeze({
  online: { code: 10, label: '在线' },
  away: { code: 30, label: '离开' },
  invisible: { code: 40, label: '隐身' },
  busy: { code: 50, label: '忙碌' },
  qme: { code: 60, label: 'Q我吧' },
  dnd: { code: 70, label: '请勿打扰' }
});

/** QQ 的硬限制（超了网关会直接拒绝，先在本地挡掉，错误信息才说得清）。 */
const LIMITS = Object.freeze({
  cardMaxChars: 30,
  groupNameMaxChars: 30,
  nicknameMaxChars: 36,
  personalNoteMaxChars: 100,
  mediaMaxBytes: 10 * 1024 * 1024
});

const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

export const APPROVE_WORDS = Object.freeze(['通过', '同意', '允许', '批准', 'yes', 'y', 'ok', 'approve']);
export const REJECT_WORDS = Object.freeze(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'deny', 'reject']);

export function isAdminAction(action) {
  return ADMIN_ACTIONS.includes(String(action ?? ''));
}

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? '未知动作';
}

function codepointLength(s) {
  return [...String(s ?? '')].length;
}

/** 单行文本：拒绝换行与控制字符（它们会被 QQ 当成新消息，或把确认卡搞乱）。 */
function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').replace(/[ ]{2,}/g, ' ').trim();
}

function requireGroupId(args, { allowGroups, allowAllWhenEmpty }) {
  const raw = args.groupId;
  if (raw === undefined || raw === null || String(raw).trim() === '') throw new Error('缺少 groupId（群号）');
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0) throw new Error(`groupId 必须是群号（正整数），收到「${s}」`);
  const list = (allowGroups ?? []).map(String);
  // 管理员动作**不**继承 allowAllWhenEmpty：空名单时宁可不可用，也不要"哪里都能改"。
  if (list.length === 0) throw new Error('adminOps 需要显式配置 allow.groups，空名单不放行');
  if (!list.includes(s)) throw new Error(`群 ${s} 不在白名单（allow.groups）里`);
  return s;
}

/**
 * 校验并规范化头像/群头像的文件路径。
 *
 * 只接受 mediaRoot 下的**已存在普通文件**。返回值是绝对路径（网关要的是本机路径）。
 * 这里的 `exists`/`statSync` 可注入，方便离线测试不碰真实文件系统。
 */
export function resolveMediaFile(relPath, { mediaRoot, exists = fs.existsSync, stat = fs.statSync } = {}) {
  let raw = String(relPath ?? '').trim();
  if (!raw) throw new Error('缺少头像文件路径（只接受 assets/ 下的相对路径）');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('不接受 URL：请把图片放进 assets/ 后用相对路径');
  if (raw.startsWith('data:')) throw new Error('不接受 base64/data URI：请把图片放进 assets/');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) throw new Error('不接受绝对路径：请用 assets/ 下的相对路径');
  if (raw.split(/[\\/]/).includes('..')) throw new Error('路径里不能有 ..');
  if (!MEDIA_EXT_RE.test(raw)) throw new Error('只接受 png / jpg / jpeg / webp / gif 图片');
  const root = path.resolve(String(mediaRoot ?? ''));
  if (!mediaRoot) throw new Error('未配置 mediaRoot（adminOps.mediaDir）');
  // 兼容模型按工具描述写的「assets/xxx.png」：mediaDir 本身就是 assets/，再带一层会变成
  // assets/assets/xxx.png。只有在「原样路径不存在、去掉目录名后存在」时才剥，
  // 这样 mediaDir 里真的有同名子目录时行为不变。
  const rootBase = path.basename(root);
  if (rootBase && raw.toLowerCase().startsWith(`${rootBase.toLowerCase()}/`)) {
    const stripped = raw.slice(rootBase.length + 1);
    if (stripped && !exists(path.resolve(root, raw))) raw = stripped;
  }
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越出了 mediaDir');
  if (!exists(abs)) throw new Error(`文件不存在：${rel}`);
  let info;
  try { info = stat(abs); } catch { throw new Error(`无法读取文件：${rel}`); }
  if (!info?.isFile?.()) throw new Error(`不是普通文件：${rel}`);
  if (Number(info.size) > LIMITS.mediaMaxBytes) throw new Error(`文件超过 ${Math.floor(LIMITS.mediaMaxBytes / 1024 / 1024)}MB：${rel}`);
  return { abs, rel: rel.split(path.sep).join('/') };
}

/**
 * 校验说说配图：只接受**媒体库第一层的文件名**。
 *
 * 比头像更严一档：说说的图片会直接变成公开动态，模型能选的目标必须是管理员预先放进
 * `media/` 的东西，而不是任意本地图片。所以这里拒绝任何路径成分（`/`、`\`、`..`、盘符、
 * URL、base64），再用 realpath 确认没被符号链接/junction 带到库外。
 *
 * @returns {{abs:string, rel:string, name:string, bytes:number}}
 */
export function resolveQzoneMedia(name, {
  mediaRoot,
  exists = fs.existsSync,
  stat = fs.statSync,
  realpath = fs.realpathSync
} = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('缺少图片文件名（只接受媒体库 media/ 里的文件名）');
  if (raw !== String(name)) throw new Error('文件名首尾不能有空白');
  if (raw.length > 120) throw new Error('文件名太长（最多 120 字符）');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('文件名包含控制字符');
  if (/^(https?:|data:|base64:|file:)/i.test(raw)) throw new Error('不接受 URL/base64/file 路径：请把图片放进媒体库 media/');
  if (raw.includes('/') || raw.includes('\\')) throw new Error('只接受文件名，不接受路径（不能带 / 或 \\）');
  if (raw.includes('..')) throw new Error('文件名不能包含 ..');
  if (!MEDIA_EXT_RE.test(raw)) throw new Error('只接受 png / jpg / jpeg / webp / gif 图片');
  if (!mediaRoot) throw new Error('未配置媒体库目录（socialV2.media.dir）');
  const root = path.resolve(String(mediaRoot));
  let rootReal;
  try { rootReal = realpath(root); } catch { throw new Error(`媒体库目录不存在：${mediaRoot}`); }
  const abs = path.resolve(rootReal, raw);
  if (!exists(abs)) throw new Error(`媒体库里找不到「${raw}」`);
  let real;
  try { real = realpath(abs); } catch { throw new Error(`无法解析文件：${raw}`); }
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('图片路径越出了媒体库');
  let info;
  try { info = stat(real); } catch { throw new Error(`无法读取文件：${raw}`); }
  if (!info?.isFile?.()) throw new Error(`不是普通文件：${raw}`);
  if (Number(info.size) > LIMITS.mediaMaxBytes) throw new Error(`图片超过 ${Math.floor(LIMITS.mediaMaxBytes / 1024 / 1024)}MB：${raw}`);
  return { abs: real, rel: rel.split(path.sep).join('/'), name: path.basename(real), bytes: Number(info.size) || 0 };
}

// ── 头像目录的只读预览（qq_list_assets / qq_view_asset）────────────────────
//
// 这两个能力的存在理由：换头像时模型不知道目录里有哪些图，只能猜文件名；而文件名
// 往往是 QQ 下载的哈希。于是给它两条**窄到只剩一个目录**的只读通道：
//   · list 只回 basename + 字节数，不下钻、不递归、不读内容；
//   · view 只读 mediaRoot 这一层的图片，名字里不允许任何路径成分。
//
// 安全口径（与 resolveMediaFile 一致，但更严）：
//   - 入参是「文件名」而不是路径：出现 / \ .. : 盘符或绝对路径一律拒绝；
//   - lstat 必须是普通文件且不是符号链接；realpath 必须仍在 mediaRoot 内（防 junction 逃逸）；
//   - 文件内容必须命中 png/jpeg/webp/gif 的 magic bytes（扩展名不可信）；
//   - 单张 ≤ ASSET_VIEW_MAX_BYTES，列表只保留图片且条数有上限。
// 真正的鉴权（只能 owner 私聊）在桥接端点里做，这一层不判断"谁在调"。

/** 单张可查看图片的字节上限：再大就要靠 ffmpeg 压，压不动会直接拒绝。 */
export const ASSET_VIEW_MAX_BYTES = 2 * 1024 * 1024;
/** 列表最多返回多少条，避免目录被塞满时把一条 QQ 消息撑爆。 */
export const ASSET_LIST_MAX = 100;

/** 校验「可查看的图片名」：只允许 basename，不允许任何路径成分。 */
export function normalizeAssetName(name) {
  const raw = String(name ?? '');
  if (!raw) throw new Error('缺少文件名（只接受头像目录里的图片名）');
  if (raw !== raw.trim()) throw new Error('文件名首尾不能有空白');
  if (raw.length > 120) throw new Error('文件名太长（最多 120 字符）');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('文件名包含控制字符');
  if (raw.includes('/') || raw.includes('\\')) throw new Error('只接受文件名，不接受路径（不能带 / 或 \\）');
  if (raw.includes('..')) throw new Error('文件名不能包含 ..');
  if (raw.includes(':')) throw new Error('文件名不能包含冒号');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('不接受绝对路径');
  if (!MEDIA_EXT_RE.test(raw)) throw new Error('只接受 png / jpg / jpeg / webp / gif 图片');
  if (raw.startsWith('.') || raw.endsWith('.') || raw.endsWith(' ')) throw new Error('文件名不合法');
  return raw;
}

/** 允许查看的名单（adminOps.assetView.allow）；空 = 整个 mediaRoot 的图片。 */
function normalizeAssetAllowList(allow) {
  const list = Array.isArray(allow) ? allow : [];
  return list
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function assertAssetAllowed(name, allow) {
  const list = normalizeAssetAllowList(allow);
  if (!list.length) return;
  if (!list.includes(String(name).toLowerCase())) {
    throw new Error('这张图不在允许查看的名单里（adminOps.assetView.allow）');
  }
}

/** 按文件头判断图片类型；返回空串表示不是允许的图片（不信任扩展名）。 */
export function sniffAllowedImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * 解析一张「可查看的头像」。
 *
 * @param {string} name 纯文件名（来自 qq_list_assets）
 * @param {object} opts mediaRoot / allow 与可注入的 fs 方法（测试用）
 * @returns {{abs:string,name:string,bytes:number,mimeType:string,buffer:Buffer}}
 */
export function resolveViewableAsset(name, {
  mediaRoot,
  allow,
  exists = fs.existsSync,
  lstat = fs.lstatSync,
  realpath = fs.realpathSync,
  readFile = fs.readFileSync
} = {}) {
  if (!mediaRoot) throw new Error('未配置 mediaRoot（adminOps.mediaDir）');
  const safeName = normalizeAssetName(name);
  assertAssetAllowed(safeName, allow);
  const root = path.resolve(String(mediaRoot));
  if (!exists(root)) throw new Error('头像目录不存在');
  const abs = path.resolve(root, safeName);
  if (path.dirname(abs) !== root) throw new Error('头像文件必须直接放在头像目录里');
  let info;
  try { info = lstat(abs); } catch { throw new Error('没有这张图片'); }
  if (info?.isSymbolicLink?.()) throw new Error('不接受符号链接');
  if (!info?.isFile?.()) throw new Error('不是普通文件');
  const size = Number(info.size) || 0;
  if (!size) throw new Error('图片是空文件');
  if (size > ASSET_VIEW_MAX_BYTES) {
    throw new Error(`图片 ${(size / 1024 / 1024).toFixed(2)}MB 超过 ${ASSET_VIEW_MAX_BYTES / 1024 / 1024}MB 上限：换头像请先压缩`);
  }
  let realRoot;
  let realAbs;
  try {
    realRoot = realpath(root);
    realAbs = realpath(abs);
  } catch {
    throw new Error('读取图片路径失败');
  }
  const relReal = path.relative(realRoot, realAbs);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('图片路径越出了头像目录');
  let buffer;
  try { buffer = readFile(abs); } catch { throw new Error('读取图片失败'); }
  const mimeType = sniffAllowedImageMime(buffer);
  if (!mimeType) throw new Error('文件内容不是 png / jpg / webp / gif 图片（扩展名不可信）');
  return { abs, name: safeName, bytes: buffer.length, mimeType, buffer };
}

/**
 * 列出 mediaRoot 第一层里可查看的图片（只回名字/大小/修改时间，不读内容）。
 * @returns {{files:Array<{name:string,bytes:number,mtimeMs:number}>,total:number,truncated:boolean,skipped:number}}
 */
export function listViewableAssets({ mediaRoot, allow, readdir = fs.readdirSync, lstat = fs.lstatSync } = {}) {
  if (!mediaRoot) throw new Error('未配置 mediaRoot（adminOps.mediaDir）');
  const root = path.resolve(String(mediaRoot));
  let entries;
  try { entries = readdir(root, { withFileTypes: true }); } catch { throw new Error('头像目录不存在或不可读'); }
  const allowList = new Set(normalizeAssetAllowList(allow));
  const files = [];
  let skipped = 0;
  for (const entry of entries) {
    const fileName = String(entry?.name ?? '');
    // dirent.isFile() 对符号链接返回 false —— 目录、链接、非图片都在这里被跳过。
    if (!fileName || !entry?.isFile?.() || !MEDIA_EXT_RE.test(fileName)) { skipped += 1; continue; }
    if (allowList.size && !allowList.has(fileName.toLowerCase())) { skipped += 1; continue; }
    let info;
    try { info = lstat(path.join(root, fileName)); } catch { skipped += 1; continue; }
    if (!info?.isFile?.() || info.isSymbolicLink?.()) { skipped += 1; continue; }
    const bytes = Number(info.size) || 0;
    if (!bytes || bytes > ASSET_VIEW_MAX_BYTES) { skipped += 1; continue; }
    files.push({ name: fileName, bytes, mtimeMs: Number(info.mtimeMs) || 0 });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return {
    files: files.slice(0, ASSET_LIST_MAX),
    total: files.length,
    truncated: files.length > ASSET_LIST_MAX,
    skipped
  };
}

/**
 * @returns 规范化后的参数（只含该动作需要的字段）
 */
export function normalizeAdminArgs(action, rawArgs, opts = {}) {
  if (!isAdminAction(action)) throw new Error(`未知动作「${action}」；可用：${ADMIN_ACTIONS.join(' / ')}`);
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const out = {};

  if (action === 'setGroupCard') {
    out.groupId = requireGroupId(args, opts);
    const card = singleLine(args.card);
    if (card.length && codepointLength(card) > LIMITS.cardMaxChars) throw new Error(`群名片不能超过 ${LIMITS.cardMaxChars} 个字`);
    out.card = card; // 空字符串 = 清除名片
    return out;
  }
  if (action === 'setGroupName') {
    out.groupId = requireGroupId(args, opts);
    const name = singleLine(args.name);
    if (!name) throw new Error('缺少 name（新群名）');
    if (codepointLength(name) > LIMITS.groupNameMaxChars) throw new Error(`群名不能超过 ${LIMITS.groupNameMaxChars} 个字`);
    out.name = name;
    return out;
  }
  if (action === 'setGroupPortrait') {
    out.groupId = requireGroupId(args, opts);
    const media = resolveMediaFile(args.file, { mediaRoot: opts.mediaRoot, exists: opts.exists, stat: opts.stat });
    out.file = media.abs;
    out.fileRel = media.rel;
    return out;
  }
  if (action === 'setQqAvatar') {
    const media = resolveMediaFile(args.file, { mediaRoot: opts.mediaRoot, exists: opts.exists, stat: opts.stat });
    out.file = media.abs;
    out.fileRel = media.rel;
    return out;
  }
  if (action === 'recallMessage') {
    const mid = args.messageId;
    const hasMid = mid !== undefined && mid !== null && String(mid).trim() !== '';
    if (hasMid) {
      const s = String(mid).trim();
      // QQ 的 message_id 可能是负数，但绝不能是 0 / 非整数。
      if (!/^-?[1-9]\d*$/.test(s)) throw new Error(`messageId 必须是非零整数，收到「${s}」`);
      out.messageId = s;
    } else {
      // 没给 id 时允许按 targetKey 撤回「机器人最近往那个会话发的一条」——
      // 跨会话代发后 owner 说「赶紧撤回」，模型手里通常没有 message_id。
      const tk = String(args.targetKey ?? '').trim();
      if (!tk) throw new Error('缺少 messageId；也可以传 targetKey（group:群号 / private:QQ号）撤回机器人最近发的那条');
      if (!/^(group|private):\d+$/.test(tk)) throw new Error(`targetKey 格式应为 group:群号 或 private:QQ号，收到「${tk}」`);
      out.targetKey = tk;
    }
    if (args.groupId !== undefined) out.groupId = requireGroupId(args, opts);
    return out;
  }
  if (action === 'setOnlineStatus') {
    const status = String(args.status ?? '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ONLINE_STATUS, status)) {
      throw new Error(`status 只能是 ${Object.keys(ONLINE_STATUS).join(' / ')}`);
    }
    out.status = status;
    return out;
  }
  if (action === 'postQzone') {
    // 正文/可见范围/图片一起归一：正文必填、可见范围只认五个值、图片必须是 media/ 里的文件名。
    return normalizeQzonePostArgs(args, {
      maxChars: opts.qzoneMaxChars,
      maxImages: opts.qzoneMaxImages,
      defaultUgcRight: opts.qzoneDefaultUgcRight,
      resolveMedia: (name) => resolveQzoneMedia(name, {
        mediaRoot: opts.qzoneMediaRoot ?? opts.mediaRoot,
        exists: opts.exists,
        stat: opts.stat,
        realpath: opts.realpath
      })
    });
  }
  // setQqProfile
  const nickname = singleLine(args.nickname);
  const personalNote = singleLine(args.personalNote);
  // 允许只清签名（personalNote: ''）而不改昵称；两个都没给才是空操作。
  if (!nickname && args.personalNote === undefined) throw new Error('至少要给 nickname 或 personalNote');
  if (nickname && codepointLength(nickname) > LIMITS.nicknameMaxChars) throw new Error(`昵称不能超过 ${LIMITS.nicknameMaxChars} 个字`);
  if (personalNote && codepointLength(personalNote) > LIMITS.personalNoteMaxChars) throw new Error(`个性签名不能超过 ${LIMITS.personalNoteMaxChars} 个字`);
  if (nickname) out.nickname = nickname;
  if (args.personalNote !== undefined) out.personalNote = personalNote;
  return out;
}

/** 人类可读的动作描述，用于确认卡、执行回执与审计。 */
export function describeAction(action, args = {}) {
  switch (action) {
    case 'setGroupCard':
      return `${actionLabel(action)} → ${args.card ? `「${args.card}」` : '（清空）'}`;
    case 'setGroupName':
      return `${actionLabel(action)} → 「${args.name ?? ''}」`;
    case 'setGroupPortrait':
      return `${actionLabel(action)} → ${args.fileRel ? path.posix.basename(args.fileRel) : '图片'}`;
    case 'setQqProfile': {
      const bits = [];
      if (args.nickname) bits.push(`昵称「${args.nickname}」`);
      if (args.personalNote !== undefined) bits.push(`签名${args.personalNote ? `「${args.personalNote}」` : '（清空）'}`);
      return `${actionLabel(action)}：${bits.join('，') || '无改动'}`;
    }
    case 'setQqAvatar':
      return `${actionLabel(action)} → ${args.fileRel ? path.posix.basename(args.fileRel) : '图片'}`;
    case 'recallMessage':
      return args.messageId
        ? `${actionLabel(action)} #${args.messageId}`
        : `${actionLabel(action)} 最近一条（${args.targetKey ?? ''}）`;
    case 'setOnlineStatus':
      return `${actionLabel(action)} → ${ONLINE_STATUS[args.status]?.label ?? args.status ?? ''}`;
    case 'postQzone': {
      // 确认卡要让 owner 一眼看到「要发什么、给谁看、带几张图」，否则通过/拒绝只能靠猜。
      // 正文**不截成摘要**：只给前 120 字的话，后文塞私货的注入就能骗过确认（公开广播
      // 一旦发出去就收不回）。正文本身已被 normalize 限长（默认 1000 字），这里全量展示。
      const content = String(args.content ?? '').replace(/\r?\n/g, ' / ');
      const chars = [...content];
      const shown = chars.length > 1000 ? `${chars.slice(0, 1000).join('')}…` : content;
      const bits = [`「${shown}」`];
      if (Array.isArray(args.images) && args.images.length) bits.push(`${args.images.length} 张图`);
      bits.push(ugcRightLabel(args.ugcRight));
      return `${actionLabel(action)}：${bits.join('｜')}`;
    }
    default:
      return actionLabel(action);
  }
}

/**
 * 解析 owner 的确认回复。
 *
 * 支持「通过」「通过 #12」「#12 通过」「12 拒绝」这类写法；带单词集合与桥接的 DSH 审批
 * 保持一致，避免同一个词在两处含义不同。
 *
 * @returns null=这不是一句确认；{ambiguous:true}=有多个待确认但没说编号；
 *          {outcome:'allow'|'deny', id?}=可执行
 */
export function parseConfirm(text, pendingIds = []) {
  const t = singleLine(text).replace(/^[/／]\s*/, '');
  if (!t) return null;
  const ids = pendingIds.map(Number).filter((n) => Number.isFinite(n));
  const wordAlt = [...APPROVE_WORDS, ...REJECT_WORDS]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  let m = new RegExp(`^(${wordAlt})\\s*[#＃]?\\s*(\\d+)?\\s*$`, 'i').exec(t)
    || new RegExp(`^[#＃]?\\s*(\\d+)\\s*(${wordAlt})\\s*$`, 'i').exec(t);
  let word;
  let idText;
  if (m) {
    if (/^\d+$/.test(m[1] ?? '')) { idText = m[1]; word = m[2]; } else { word = m[1]; idText = m[2]; }
  } else {
    return null;
  }
  const lower = String(word).toLowerCase();
  const outcome = APPROVE_WORDS.some((w) => w.toLowerCase() === lower) ? 'allow' : 'deny';
  if (idText) {
    const id = Number(idText);
    if (!ids.includes(id)) return { outcome, id, missing: true };
    return { outcome, id };
  }
  if (ids.length === 1) return { outcome, id: ids[0] };
  if (ids.length === 0) return { outcome, missing: true };
  return { ambiguous: true };
}

export function formatConfirmCard({ id, originLabel, action, args, targetLabel, timeoutMs = 600000 }) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  const lines = [
    `🔧 操作确认 #${id}（${minutes} 分钟内有效）`,
    `来自：${originLabel || '未知会话'}`,
    `动作：${describeAction(action, args)}${targetLabel ? `（${targetLabel}）` : ''}`,
    '回复「通过」执行，「拒绝」取消'
  ];
  return lines.join('\n');
}

function trimHistory(history, max = 100) {
  return history.length > max ? history.slice(-max) : history;
}

/**
 * 待确认队列 + 直连执行 + 撤销。
 *
 * 依赖注入（全部由 bridge 提供）：
 *   execute(action, args, { internal }) → { before, after }
 *   notifyOwner(text)                   → 发到 owner 私聊
 *   ownerKey                            → `private:<ownerQQ>`
 *   onAudit(record)                     → 落盘（bridge 写 state/admin-ops.json）
 */
export class AdminOpQueue {
  constructor({
    execute,
    notifyOwner,
    ownerKey,
    enabledActions = DEFAULT_ENABLED_ACTIONS,
    timeoutMs = 600000,
    maxPerMinute = 3,
    maxPending = 5,
    now = () => Date.now(),
    onAudit = () => {},
    history = [],
    describe = describeAction,
    // 自主权限：返回 { keys, scope }。bridge 注入，读控制台保存的 botPerms。
    resolveScope = () => ({ keys: [], scope: 'none' }),
    // 「人设自主」档的掷骰：只有管理员本人发起的调用才问它。
    // 返回 { veto: boolean, p?: number, role?: string }；bridge 从人格卡读概率。
    vetoFor = () => ({ veto: false }),
    // 否决后的冷却：同一会话同一动作在这段时间内直接拒绝，防止它换个说法再来一次。
    vetoCooldownMs = 5 * 60 * 1000
  } = {}) {
    if (typeof execute !== 'function') throw new Error('AdminOpQueue 需要 execute');
    this.execute = execute;
    this.notifyOwner = typeof notifyOwner === 'function' ? notifyOwner : () => {};
    this.ownerKey = String(ownerKey ?? '');
    this.enabledActions = new Set(enabledActions);
    this.timeoutMs = Math.max(10000, Number(timeoutMs) || 600000);
    this.maxPerMinute = Math.max(1, Number(maxPerMinute) || 3);
    this.maxPending = Math.max(1, Number(maxPending) || 5);
    this.now = now;
    this.onAudit = onAudit;
    this.describe = describe;
    this.resolveScope = typeof resolveScope === 'function' ? resolveScope : () => ({ keys: [], scope: 'none' });
    this.vetoFor = typeof vetoFor === 'function' ? vetoFor : () => ({ veto: false });
    this.vetoCooldownMs = Math.max(0, Number(vetoCooldownMs) || 0);
    this.vetoCooldowns = new Map(); // `${originKey}|${action}` -> 到期时间戳
    this.history = trimHistory(Array.isArray(history) ? history.slice() : []);
    this.pending = new Map();
    this.seq = 0;
    this.submitTimes = [];
  }

  get pendingIds() {
    return [...this.pending.keys()];
  }

  #rateLimit() {
    const t = this.now();
    this.submitTimes = this.submitTimes.filter((ts) => t - ts < 60000);
    if (this.submitTimes.length >= this.maxPerMinute) {
      throw new Error(`操作太频繁（每分钟最多 ${this.maxPerMinute} 次），请稍后再试`);
    }
    this.submitTimes.push(t);
  }

  #assertEnabled(action) {
    if (!isAdminAction(action)) throw new Error(`未知动作「${action}」；可用：${[...this.enabledActions].join(' / ')}`);
    if (!this.enabledActions.has(action)) throw new Error(`动作「${action}」未启用（配置项 adminOps.actions）`);
  }

  #audit(record) {
    const entry = { ts: new Date(this.now()).toISOString(), ...record };
    this.history = trimHistory([...this.history, entry]);
    try { this.onAudit(entry, this.history); } catch {}
    return entry;
  }

  /** 真正执行一次，并把结果做成一条审计记录（成功/失败都记）。 */
  async #run(action, args, meta = {}) {
    const base = { action, args: sanitizeArgsForAudit(args), originKey: meta.originKey ?? '', actor: meta.actor ?? '', internal: meta.internal === true };
    try {
      const result = await this.execute(action, args, { internal: meta.internal === true });
      const record = this.#audit({ ...base, ok: true, before: result?.before ?? null, after: result?.after ?? null });
      return { ok: true, record, before: result?.before ?? null, after: result?.after ?? null };
    } catch (error) {
      const message = String(error?.message ?? error);
      this.#audit({ ...base, ok: false, error: message });
      return { ok: false, error: message };
    }
  }

  /**
   * 提交一个动作。
   *
   * 三档语义（v2，按 AI 的自主程度分档）：
   *   none    = 没有这个能力 → 直接拒绝，不登记确认卡，也不消耗频率额度；
   *   request = 只应管理员要求 → 管理员本人刚说过话才直连，其他人一律走确认卡；
   *   persona = 人设自主 → 不拦；但**管理员本人发起**时按人格概率掷骰，可能返回 persona_veto。
   *
   * @param {object} p
   * @param {boolean} [p.senderIsOwner] 该会话最近一条消息是否 ownerQQ 发的（按 QQ 号判定）
   * @returns {Promise<{status:'done'|'pending', id?:number, before?:any, after?:any, summary:string}>}
   */
  async submit({ action, args, originKey, originLabel, targetLabel, senderIsOwner = false }) {
    this.#assertEnabled(action);
    const summary = this.describe(action, args);
    const { scope } = this.resolveScope(action, args);

    // 1) 不开放：能力不存在。不排队、不发确认卡、不占频率额度。
    if (scope === 'none') {
      throw new Error(`自主权限「不开放」：管理员没有开放「${summary}」。不要重试，也不要换个说法再试。`);
    }

    this.#rateLimit();
    // 「管理员私聊直连」也必须满足「该会话最近一条消息确实是 ownerQQ 发的」。
    // 管理员身份只认 QQ 号、不认会话：否则任何能往那个会话里投一句话的路径
    // （例如从 DSH 界面直接输入、或以后多端接入）都等于拿到了管理员权限。
    const ownerPrivate = Boolean(this.ownerKey) && originKey === this.ownerKey && senderIsOwner;

    const runDirect = async () => {
      const actor = ownerPrivate ? 'owner-direct' : 'self-service';
      const res = await this.#run(action, args, { originKey, actor });
      if (!res.ok) throw new Error(res.error);
      if (!ownerPrivate) {
        // 自主执行要给 owner 留一条可追溯的回执（群里看不到）。
        void this.notifyOwner(`⚙️ 自主执行：${summary}${targetLabel ? `（${targetLabel}）` : ''}${originLabel ? `\n来自：${originLabel}` : ''}`);
      }
      return { status: 'done', before: res.before, after: res.after, summary, scope };
    };

    // 2) 人设自主：不拦。管理员本人发起时掷骰，可能按人设拒绝（persona_veto）。
    if (scope === 'persona') {
      if (senderIsOwner) {
        const cooldownKey = `${originKey}|${action}`;
        if ((this.vetoCooldowns.get(cooldownKey) ?? 0) > this.now()) {
          throw new Error(`persona_veto：这个「${summary}」刚刚已经拒绝过一次，这次也不会做。不要重试。`);
        }
        let info = {};
        try { info = this.vetoFor({ action, args, originKey, senderIsOwner, scope }) || {}; } catch { info = {}; }
        if (info.veto === true) {
          if (this.vetoCooldownMs > 0) this.vetoCooldowns.set(cooldownKey, this.now() + this.vetoCooldownMs);
          const pct = Number.isFinite(Number(info.p)) ? `${Math.round(Number(info.p) * 100)}%` : '按人设';
          this.#audit({ action, args: sanitizeArgsForAudit(args), originKey, actor: 'persona-veto', ok: false, error: 'persona_veto' });
          void this.notifyOwner(`🙅 已按人设拒绝：${summary}${targetLabel ? `（${targetLabel}）` : ''}${originLabel ? `\n来自：${originLabel}` : ''}\n人格：${info.role || '当前人格'}｜本次概率 ${pct}`);
          throw new Error(`persona_veto：这次「${summary}」我按自己的判断拒绝了。不要重试，也不要说已经做了；用你自己的话解释，或者干脆不提。`);
        }
      }
      return runDirect();
    }

    // 3) 仅应要求：管理员本人刚说过话 → 直连；其他人 → 确认卡。
    if (allowsSelfService(scope, { senderIsOwner })) return runDirect();

    if (this.pending.size >= this.maxPending) {
      throw new Error(`待确认的操作已有 ${this.pending.size} 个，请先在私聊里处理（回复「通过」或「拒绝」）`);
    }
    const id = ++this.seq;
    const createdAt = this.now();
    const entry = {
      id, action, args, originKey: String(originKey ?? ''), originLabel: String(originLabel ?? ''),
      targetLabel: String(targetLabel ?? ''), summary, createdAt, expiresAt: createdAt + this.timeoutMs
    };
    entry.timer = setTimeout(() => {
      if (this.pending.get(id) !== entry) return;
      this.pending.delete(id);
      this.#audit({ id, action, args: sanitizeArgsForAudit(args), originKey: entry.originKey, actor: 'expired', ok: false, error: '确认超时' });
      void this.notifyOwner(`⏰ 操作 #${id} 已过期：${summary}`);
    }, this.timeoutMs);
    entry.timer?.unref?.();
    this.pending.set(id, entry);
    void this.notifyOwner(formatConfirmCard({
      id, originLabel: entry.originLabel, action, args, targetLabel: entry.targetLabel, timeoutMs: this.timeoutMs
    }));
    return { status: 'pending', id, summary };
  }

  /**
   * 桥接管理命令专用：owner 已经在 QQ 里**亲手输入**命令，等价于私聊直连，
   * 直接执行并审计，不走确认卡。仍然受动作白名单与频率限制约束。
   */
  async runDirect({ action, args, originKey = this.ownerKey, actor = 'owner-command' }) {
    this.#assertEnabled(action);
    this.#rateLimit();
    const res = await this.#run(action, args, { originKey, actor });
    if (!res.ok) throw new Error(res.error);
    return { summary: this.describe(action, args), before: res.before, after: res.after };
  }

  /**
   * 消费 owner 的确认回复。
   * @param {{requireId?: boolean}} opts requireId=true 时（例如同一会话还挂着 DSH 审批）
   *   必须带编号，避免「通过」被两条流程抢答。
   * @returns {handled:boolean} true 表示这条消息属于确认流程，调用方不要再往下处理。
   */
  async confirm(text, { requireId = false } = {}) {
    const parsed = parseConfirm(text, this.pendingIds);
    if (!parsed) return { handled: false };
    if (requireId && parsed.id === undefined && !parsed.ambiguous) {
      void this.notifyOwner(`现在同时有 DSH 审批和操作确认挂着，请带上编号，例如「通过 #${this.pendingIds[0]}」`);
      return { handled: true };
    }
    if (parsed.ambiguous) {
      const lines = this.pendingIds.map((id) => {
        const op = this.pending.get(id);
        return `#${id} ${this.describe(op.action, op.args)}`;
      });
      void this.notifyOwner(`现在有 ${this.pendingIds.length} 个待确认，请带上编号，例如「通过 #${this.pendingIds[0]}」：\n${lines.join('\n')}`);
      return { handled: true };
    }
    if (parsed.missing || !this.pending.has(parsed.id)) {
      void this.notifyOwner(parsed.id ? `没有待确认的操作 #${parsed.id}（可能已过期或已处理）` : '当前没有待确认的操作');
      return { handled: true };
    }
    const op = this.pending.get(parsed.id);
    clearTimeout(op.timer);
    this.pending.delete(op.id);
    if (parsed.outcome === 'deny') {
      this.#audit({ id: op.id, action: op.action, args: sanitizeArgsForAudit(op.args), originKey: op.originKey, actor: 'owner-reject', ok: false, error: 'owner 拒绝' });
      void this.notifyOwner(`❌ 已取消 #${op.id}：${op.summary}`);
      return { handled: true };
    }
    const res = await this.#run(op.action, op.args, { originKey: op.originKey, actor: 'owner-confirm' });
    if (res.ok) {
      void this.notifyOwner(`✅ #${op.id} 已执行：${op.summary}${op.targetLabel ? `（${op.targetLabel}）` : ''}`);
    } else {
      void this.notifyOwner(`❌ #${op.id} 执行失败：${res.error}`);
    }
    return { handled: true };
  }

  /** 撤掉最近一次可逆的成功动作。返回 null 表示没有可撤销的动作。 */
  async undo() {
    const reversible = new Set(['setGroupCard', 'setGroupName', 'setQqProfile', 'setQqAvatar']);
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const rec = this.history[i];
      if (!rec?.ok || rec.internal || !reversible.has(rec.action)) continue;
      if (rec.undone) continue;
      const before = rec.before;
      if (before === null || before === undefined) continue;
      let inverse = null;
      // 改前值必须是**读到了的**真实值：null / undefined 说明当时没读到，
      // 拿它去回写等于把名片/群名清空（网关会把 null 当空值），所以跳过这条。
      if (rec.action === 'setGroupCard' && before?.card !== undefined && before.card !== null) inverse = { groupId: before.groupId, card: before.card };
      if (rec.action === 'setGroupName' && before?.name !== undefined && before.name !== null) inverse = { groupId: before.groupId, name: before.name };
      // 昵称：只有「这次确实改了昵称」且「读到过旧昵称」才可撤销。
      // 只改签名时没有可靠的改前签名可读，与其假装还原，不如跳过。
      if (rec.action === 'setQqProfile' && before?.nickname && rec.args?.nickname) {
        inverse = { nickname: before.nickname, ...(before.personalNote ? { personalNote: before.personalNote } : {}) };
      }
      // 头像：before 是改前的图片引用；只允许 qlogo 这类可信地址在 internal 模式下回写。
      if (rec.action === 'setQqAvatar' && typeof before?.file === 'string') inverse = { file: before.file, __avatarRef: true };
      if (!inverse) continue;
      const res = await this.#run(rec.action, { ...rec.args, ...inverse }, { internal: true, actor: 'undo' });
      if (!res.ok) throw new Error(res.error);
      rec.undone = true;
      return { record: rec, inverse };
    }
    return null;
  }
}

/** 审计里不要把绝对路径写出去（用户数据 + 路径泄露）。 */
function sanitizeArgsForAudit(args = {}) {
  const out = { ...args };
  if (out.file) out.file = out.fileRel ? out.fileRel : path.basename(String(out.file));
  if (Array.isArray(out.images)) {
    out.images = out.images.map((img) => (img && typeof img === 'object')
      ? { name: img.name ?? (img.rel ? path.posix.basename(String(img.rel)) : ''), bytes: Number(img.bytes) || 0 }
      : path.basename(String(img)));
  }
  delete out.__avatarRef;
  return out;
}
