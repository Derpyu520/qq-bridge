// QQ 资料 / 头像 / QQ 空间（说说）的**纯逻辑**层。
//
// 为什么单独一层（和 quota / bot-perms / admin-ops 同一个思路）：
//   · 「把网关返回的原始资料裁成能给模型看的最小字段集」是隐私边界，不是格式化；
//   · 「说说正文/可见范围/图片」的校验必须在离线回归里跑得到，不能只靠真机手点；
//   · bridge.js 已经一万五千行，再把字段白名单、HTML 清洗、可见性映射塞进去，
//     以后改一个字段就得在 VM 夹具里重新猜。
//
// 安全口径（与 RULES.md 一致）：
//   - 资料只回**白名单字段**，绝不 `{...raw}` 透传：网关字段随实现变化，
//     透传一次就可能把 uid / 电话 / 企业信息带进模型上下文。
//   - 所有文本都去控制字符并限长；模型上下文是有限的，长签名/长说说会挤掉聊天记录。
//   - QQ 空间可见范围只认 QQ 自己的五个值（1/4/16/64/128），映射成中文标签；
//     16/128 必须带名单，否则网关会拒绝 —— 在本地先挡掉，错误信息才说得清。

/** 一组字符串里的控制字符（把它们换成空格，避免把 JSON/QQ 消息结构搞乱）。 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** 零宽字符：从网页/HTML 里抄来的文本常带，肉眼看不见但会白占 token。 */
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;

/** 单字段上限：足够表达，又不至于把一次工具返回撑成一篇小作文。 */
export const PROFILE_LIMITS = Object.freeze({
  nickname: 40,
  remark: 40,
  signature: 200,
  qzoneContent: 1000,
  qzoneFeedText: 240,
  qzoneImageCount: 9,
  qzoneTotalImageBytes: 12 * 1024 * 1024
});

/** 处理一段来自网关/网页的文本：去控制字符、去零宽、折叠空白、限长。 */
export function cleanText(value, maxChars = 200) {
  let s = String(value ?? '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\r\n?/g, '\n');
  // 保留换行（说说正文可能是多行），但把行内的连续空白折叠掉。
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').trim();
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit) return s;
  const chars = [...s];
  if (chars.length <= limit) return s;
  return `${chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

/**
 * QQ 号规范化：只接受 1~12 位十进制、首位非 0。
 *
 * 刻意不接受 `0`：OneBot 的 user_id 缺省/解析失败时常回 0，那会让「查 0 号」变成一个
 * 看起来成功、实际查了个假人的调用。也不接受字符串里的空白与 `@`。
 */
export function normalizeQqId(value) {
  const s = String(value ?? '').trim();
  if (!/^[1-9]\d{0,11}$/.test(s)) {
    throw new Error(`QQ 号必须是 1~12 位数字（首位不能是 0），收到「${cleanText(value, 30)}」`);
  }
  return s;
}

/** 宽松判定（不抛错）：给「这个 id 是不是已知的人」这类过滤用。 */
export function isQqId(value) {
  return /^[1-9]\d{0,11}$/.test(String(value ?? '').trim());
}

const SEX_LABELS = Object.freeze({ male: '男', female: '女', unknown: '未知' });

/**
 * 在线状态码 → 中文。取值按 Lagrange.Core 的 Status 枚举，与 admin-ops 的 ONLINE_STATUS 同源；
 * 这里单独写一份是因为资料接口拿到的是**数字**，而管理员动作接受的是**名字**。
 */
export function onlineStatusLabel(code) {
  const n = Number(code);
  switch (n) {
    case 10: return '在线';
    case 30: return '离开';
    case 40: return '隐身';
    case 50: return '忙碌';
    case 60: return 'Q我吧';
    case 70: return '请勿打扰';
    default: return '未知';
  }
}

/** 注册时间（unix 秒）→ Q 龄（整年）。拿不到/不合理时返回 null，不编年份。 */
export function accountYears(regTime, now = Date.now()) {
  const t = Number(regTime);
  if (!Number.isFinite(t) || t <= 0) return null;
  const ms = t * 1000;
  // 2000 年之前不可能是 QQ 号注册时间；未来时间按脏数据丢弃。
  if (ms < Date.UTC(2000, 0, 1) || ms > now) return null;
  const d = new Date(ms);
  const nowD = new Date(now);
  let years = nowD.getUTCFullYear() - d.getUTCFullYear();
  if (nowD.getUTCMonth() < d.getUTCMonth() || (nowD.getUTCMonth() === d.getUTCMonth() && nowD.getUTCDate() < d.getUTCDate())) years -= 1;
  return years >= 0 ? years : null;
}

/**
 * 把 `get_stranger_info` 的原始返回裁成模型可见的资料。
 *
 * 字段白名单是**硬边界**：网关还会回 uid / qid / 企业信息 / 电量 / 自定义状态等，
 * 那些既不是聊天需要的，也可能比用户以为的「公开资料」更多。这里只保留：
 *   昵称、好友备注、性别、年龄、个性签名、QQ 等级、会员、Q 龄、在线状态。
 *
 * @param {object} raw 网关返回的 data
 * @param {{selfId?: string, now?: number}} [opts]
 * @returns {object|null} 归一后的资料；连 QQ 号都认不出来时返回 null
 */
export function sanitizeProfile(raw, { selfId = '', now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const rawId = raw.user_id ?? raw.userId ?? raw.uin;
  const userId = isQqId(rawId) ? String(rawId).trim() : '';
  if (!userId) return null;
  const sexRaw = String(raw.sex ?? '').toLowerCase();
  const sex = SEX_LABELS[sexRaw] ? sexRaw : 'unknown';
  const ageNum = Number(raw.age);
  const levelNum = Number(raw.qq_level ?? raw.qqLevel ?? raw.level);
  const vipLevel = Number(raw.vip_level ?? raw.vipLevel);
  const profile = {
    userId,
    nickname: cleanText(raw.nickname, PROFILE_LIMITS.nickname),
    remark: cleanText(raw.remark, PROFILE_LIMITS.remark),
    sex,
    sexLabel: SEX_LABELS[sex],
    age: Number.isFinite(ageNum) && ageNum >= 0 && ageNum <= 150 ? Math.round(ageNum) : null,
    signature: cleanText(raw.long_nick ?? raw.longNick ?? raw.sign, PROFILE_LIMITS.signature),
    level: Number.isFinite(levelNum) && levelNum > 0 ? Math.round(levelNum) : null,
    vip: raw.is_vip === true || raw.isVip === true,
    vipLevel: Number.isFinite(vipLevel) && vipLevel > 0 ? Math.round(vipLevel) : 0,
    accountYears: accountYears(raw.reg_time ?? raw.regTime, now),
    online: { code: Number(raw.status ?? raw.extStatus ?? 0) || 0, label: onlineStatusLabel(raw.status ?? raw.extStatus) }
  };
  if (selfId && String(selfId) === userId) profile.isSelf = true;
  return profile;
}

// ── QQ 空间 ────────────────────────────────────────────────────────────────

/** 可见范围：QQ 的五个值 → 中文。顺序固定，供控制台/文档与测试共用。 */
export const QZONE_UGC_RIGHT = Object.freeze([
  { value: 1, key: 'public', label: '所有人可见' },
  { value: 4, key: 'friends', label: '好友可见' },
  { value: 16, key: 'include', label: '部分好友可见' },
  { value: 64, key: 'private', label: '仅自己可见' },
  { value: 128, key: 'exclude', label: '部分好友不可见' }
]);

const UGC_BY_VALUE = new Map(QZONE_UGC_RIGHT.map((x) => [x.value, x]));

export function ugcRightEntry(value) {
  return UGC_BY_VALUE.get(Number(value)) ?? null;
}

export function ugcRightLabel(value) {
  return ugcRightEntry(value)?.label ?? '所有人可见';
}

/**
 * 可见范围归一：只认五个合法值；缺省取 defaultRight（默认 1=所有人可见，与 QQ 自己一致）。
 * 16/128 需要名单，由调用方在拿到 targetUins 后一起校验（见 normalizeQzoneTargetUins）。
 */
export function normalizeUgcRight(value, { defaultRight = 1 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return ugcRightEntry(defaultRight) ? Number(defaultRight) : 1;
  }
  const n = Number(String(value).trim());
  if (!UGC_BY_VALUE.has(n)) {
    throw new Error(`ugcRight 只能是 1（所有人）/ 4（好友）/ 16（部分可见）/ 64（仅自己）/ 128（部分不可见），收到「${value}」`);
  }
  return n;
}

/** 16/128 的名单：只保留合法 QQ 号，去重、限 50 个；其它可见范围传了也忽略。 */
export function normalizeQzoneTargetUins(value, { ugcRight = 1, max = 50 } = {}) {
  const right = Number(ugcRight);
  if (right !== 16 && right !== 128) return [];
  const list = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (!isQqId(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(Number(s));
    if (out.length >= max) break;
  }
  if (!out.length) {
    throw new Error(`${ugcRightLabel(right)}必须提供 targetUins（QQ 号数组）`);
  }
  return out;
}

/**
 * 说说正文校验：非空白、限长、去控制字符。
 *
 * 与普通聊天不同，这里**保留换行**（QQ 空间正文可以多段），但拒绝只有空白的正文：
 * 空说说是纯垃圾动态，网关也会拒。超长**直接报错而不是悄悄截断**——把用户写的
 * 最后一段截掉再发出去，比拒绝更糟（而且模型会以为全文都发出去了）。
 */
export function normalizeQzoneContent(value, { maxChars = PROFILE_LIMITS.qzoneContent } = {}) {
  const text = cleanText(value, 0);
  if (!text) throw new Error('说说正文不能为空');
  const chars = [...text];
  const limit = Math.max(1, Math.floor(Number(maxChars) || PROFILE_LIMITS.qzoneContent));
  if (chars.length > limit) throw new Error(`说说正文最多 ${limit} 字，当前 ${chars.length} 字（请精简后再发）`);
  return text;
}

/**
 * 把好友动态（get_qzone_feeds 的 html）洗成一句可读文本。
 *
 * 为什么要洗：网关回的是**预渲染 HTML**，一条动态几 KB，里面全是 class/内联样式/浏览计数。
 * 原样塞给模型等于一次烧掉几千 token 换来一句「浏览 3 次」。这里按已知结构抽正文：
 *   1. 去 script/style/标签，解码常见实体；
 *   2. 去掉开头的作者昵称与时间（结构里已有 uin/nickname/time 字段）；
 *   3. 在第一个 UI 噪声词（浏览/点赞/评论/转发/分享/收藏）处截断；
 *   4. 折叠空白、限长。
 */
export function stripQzoneFeedText(html, { nickname = '', maxChars = PROFILE_LIMITS.qzoneFeedText } = {}) {
  let s = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const nick = cleanText(nickname, PROFILE_LIMITS.nickname);
  if (nick && s.startsWith(nick)) s = s.slice(nick.length).trim();
  // 时间戳样式：昨天 23:43 / 今天 8:05 / 3 分钟前 / 8月12日 12:00 / 2026-08-12。
  // ⚠️ 必须要求「具体时间」，不能只匹配「今天」：真实正文里就有「今天去看了海」，
  // 把它当成时间戳剥掉会静默吃掉正文开头（离线回归里踩过）。
  const TIME_PREFIX = /^(?:(?:昨天|今天|前天)\s*\d{1,2}:\d{2}|\d{1,2}:\d{2}|(?:刚刚|\d+\s*(?:秒|分钟|小时|天)前)|\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s*\d{1,2}:\d{2})?)\s*/;
  s = s.replace(TIME_PREFIX, '').trim();
  // UI 噪声：只认「强标记」——浏览计数 / 「N 人觉得很赞」/+1。
  // ⚠️ 不能把裸的「评论/点赞/转发」当截断点：正文里「评论区笑死」这种极常见，
  // 一截就把半句话吃掉了。按钮文字只从**结尾**剥（见下）。
  const strongNoise = /(浏览\s*\d*\s*次|人觉得很赞|\+\s*1\b)/.exec(s);
  if (strongNoise) s = s.slice(0, strongNoise.index);
  // 结尾的按钮串（点赞 评论 转发 分享 收藏 …）：反复剥，直到结尾不是这些词。
  for (let i = 0; i < 6; i += 1) {
    const trimmed = s.replace(/\s*(?:点赞|评论|转发|分享|收藏|举报|全文|收起)\s*$/, '');
    if (trimmed === s) break;
    s = trimmed;
  }
  return cleanText(s, maxChars);
}

/**
 * 好友动态 → 模型可见的精简列表项。图片/视频只给数量，不给 URL
 * （模型看不了外链，URL 只会白占上下文；要看图应走 qq_get_user_profile 的头像或消息图片）。
 */
export function sanitizeQzoneFeed(feed, { maxChars = PROFILE_LIMITS.qzoneFeedText } = {}) {
  if (!feed || typeof feed !== 'object') return null;
  const uin = isQqId(feed.uin) ? String(feed.uin) : '';
  const html = String(feed.html ?? '');
  const time = Number(feed.time);
  const item = {
    userId: uin || null,
    nickname: cleanText(feed.nickname, PROFILE_LIMITS.nickname),
    time: Number.isFinite(time) && time > 0 ? time : null,
    appid: Number(feed.appid) || null,
    text: stripQzoneFeedText(html, { nickname: feed.nickname, maxChars })
  };
  // 图片数量：只数「内容图」。QQ 空间的头像 `<img>` 挂在 `<a class="user-avatar">` 里
  // （class 在父元素上，img 自己没 class），src 是 qlogo*.store.qq.com/qzone/<uin>/…；
  // 只按 img 的 class 过滤会把每条动态都算成「有 1 张图」（实测踩过）。
  const images = (html.match(/<img\b[^>]*>/gi) ?? []).filter((tag) => {
    if (/user-avatar|q_namecard|icon|emoji|face/i.test(tag)) return false;
    const src = /src\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return !/qlogo|qzone\/|avatar/i.test(src);
  });
  if (images.length) item.imageCount = Math.min(PROFILE_LIMITS.qzoneImageCount, images.length);
  return item;
}

/** 自己的说说（get_qzone_msg_list）→ 精简列表项。 */
export function sanitizeQzonePost(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const tid = cleanText(msg.tid, 64);
  const time = Number(msg.time);
  const commentNum = Number(msg.comment_num ?? msg.commentNum);
  const images = Array.isArray(msg.images) ? msg.images : [];
  return {
    tid: tid || null,
    content: cleanText(msg.content, PROFILE_LIMITS.qzoneContent),
    time: Number.isFinite(time) && time > 0 ? time : null,
    commentCount: Number.isFinite(commentNum) ? Math.max(0, Math.round(commentNum)) : 0,
    private: msg.is_private === true,
    imageCount: Math.min(PROFILE_LIMITS.qzoneImageCount, images.length)
  };
}

/**
 * 说说列表响应 → 精简结果。网关的 data 形状在不同版本里是 `{total,msglist}` 或
 * `{data:{...}}`，这里都认，但只取 `msglist` 数组，别的一概不往下传。
 */
export function sanitizeQzonePostList(raw, { limit = 10 } = {}) {
  const payload = raw && typeof raw === 'object' && raw.data !== undefined ? raw.data : raw;
  const list = Array.isArray(payload?.msglist) ? payload.msglist : (Array.isArray(payload) ? payload : []);
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 10)));
  const posts = list.slice(0, max).map(sanitizeQzonePost).filter(Boolean);
  const total = Number(payload?.total);
  return {
    total: Number.isFinite(total) && total >= 0 ? Math.round(total) : posts.length,
    returned: posts.length,
    truncated: list.length > posts.length,
    posts
  };
}

/** 好友动态响应 → 精简结果（同样容忍两种外层形状）。 */
export function sanitizeQzoneFeedList(raw, { limit = 10 } = {}) {
  const payload = raw && typeof raw === 'object' && raw.data !== undefined ? raw.data : raw;
  const list = Array.isArray(payload?.feeds) ? payload.feeds : (Array.isArray(payload) ? payload : []);
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 10)));
  const feeds = list.slice(0, max).map(sanitizeQzoneFeed).filter(Boolean);
  return { returned: feeds.length, truncated: list.length > feeds.length, feeds };
}

/**
 * 发说说前的整体参数归一（供 admin-ops 的 postQzone 使用）。
 *
 * 图片在这里只做**名字/数量**层面的校验；真正的文件解析（沙箱、magic bytes）由调用方
 * 注入的 resolveMedia 做，保持本模块不碰文件系统，能在离线测试里跑。
 */
export function normalizeQzonePostArgs(rawArgs = {}, {
  maxChars = PROFILE_LIMITS.qzoneContent,
  maxImages = PROFILE_LIMITS.qzoneImageCount,
  defaultUgcRight = 1,
  resolveMedia = null
} = {}) {
  const content = normalizeQzoneContent(rawArgs.content, { maxChars });
  const ugcRight = normalizeUgcRight(rawArgs.ugcRight ?? rawArgs.ugc_right, { defaultRight: defaultUgcRight });
  const targetUins = normalizeQzoneTargetUins(rawArgs.targetUins ?? rawArgs.target_uins, { ugcRight });
  const rawImages = rawArgs.images;
  const names = rawImages === undefined || rawImages === null || rawImages === ''
    ? []
    : (Array.isArray(rawImages) ? rawImages : [rawImages]);
  if (names.length > maxImages) throw new Error(`最多 ${maxImages} 张图片，收到 ${names.length} 张`);
  const images = [];
  if (names.length && typeof resolveMedia === 'function') {
    let totalBytes = 0;
    for (const name of names) {
      const media = resolveMedia(name);
      totalBytes += Number(media?.bytes) || 0;
      if (totalBytes > PROFILE_LIMITS.qzoneTotalImageBytes) {
        throw new Error(`图片总大小超过 ${Math.floor(PROFILE_LIMITS.qzoneTotalImageBytes / 1024 / 1024)}MB，请减少图片`);
      }
      images.push(media);
    }
  }
  return { content, ugcRight, targetUins, images };
}
