// 「机器人自主操作」权限模型（纯逻辑，可离线回归）。
//
// 三档语义（v2）：按**AI 的自主程度**分档，而不是「谁有资格触发」。
//   none    = 没有这个能力。调用一律拒绝，连确认卡都不发。
//   request = 只应管理员要求。该会话最近一条消息是 ownerQQ 发的（按 QQ 号判定，5 分钟 TTL）
//             → 直连；其他人在要求 → 发确认卡给管理员；它自己起意，桥接看不出来（见 ADMIN_OPS.md）。
//   persona = 人设自主。它自己判断要不要做、要不要主动发起；管理员的要求只是「请求」，
//             按人格卡「行为合同」里的「反驳主人」概率可能被否决（persona_veto）。
//
// 旧值迁移：off → none、owner → request、all → persona（读配置时就归一，下次保存写新值）。
//
// 封顶（maxScope）：账号级、不可逆或会波及别的会话的动作不允许「人设自主」，
// 除非控制台里逐项解除封顶（写入 unlocked）。否则「说服它换头像」就只剩限速一道闸。
const SCOPE_ORDER = Object.freeze({ none: 0, request: 1, persona: 2 });

/**
 * 权限模型的版本号。控制台会拿它对 GET /api/bot-perms 的返回值，对不上就提示「桥接还是旧进程」
 * ——否则新页面 + 旧进程只会得到一句「值只能是 off / owner / all」，看起来像权限值写错了。
 */
export const BOT_PERM_MODEL = 2;

export const BOT_SCOPES = Object.freeze(['none', 'request', 'persona']);

/** 界面文案：唯一一份，控制台与文档都读它。 */
export const BOT_SCOPE_LABELS = Object.freeze({
  none: '不开放',
  request: '仅应要求',
  persona: '人设自主'
});

/** 旧值 → 新值。迁移是单向的，新值不会被当成旧值。 */
export const LEGACY_BOT_SCOPES = Object.freeze({ off: 'none', owner: 'request', all: 'persona' });

/** 「人设自主」档反驳管理员要求的默认概率；人格卡里的「反驳主人」会覆盖它。 */
export const DEFAULT_VETO_PROBABILITY = 0.05;

/**
 * 控制台「机器人自主操作」列表的唯一权威定义。
 * mode='admin' 的项走管理员动作队列（有确认流程）；mode='tool' 的项是 MCP 工具，调用期直接判定。
 * maxScope 是这一项允许达到的最高档；超过就夹回 maxScope，除非在 unlocked 里显式放开。
 */
export const BOT_PERM_ROWS = Object.freeze([
  { key: 'setGroupCard', label: '改本群名片', group: '身份', mode: 'admin', default: 'none', maxScope: 'persona', hint: '只改机器人自己在某个群的名片' },
  { key: 'setQqNickname', label: '改 QQ 昵称', group: '身份', mode: 'admin', default: 'none', maxScope: 'request', hint: '账号级，所有群和好友都看得到' },
  { key: 'setQqSignature', label: '改个性签名', group: '身份', mode: 'admin', default: 'none', maxScope: 'request', hint: '账号级' },
  { key: 'setQqAvatar', label: '改 QQ 头像', group: '身份', mode: 'admin', default: 'none', maxScope: 'request', hint: '只认 assets/ 下的图片；改错可用 /undo' },
  { key: 'recallOwnMessage', label: '撤回自己发的消息', group: '小动作', mode: 'admin', default: 'none', maxScope: 'persona', hint: '只允许撤机器人自己发的消息，碰不到别人的' },
  { key: 'setOnlineStatus', label: '设置在线状态', group: '小动作', mode: 'admin', default: 'none', maxScope: 'request', hint: '在线/离开/忙碌/请勿打扰/隐身；状态码按 Lagrange 枚举' },
  { key: 'crossSessionSend', label: '跨会话代发消息', group: '跨会话', mode: 'tool', default: 'request', maxScope: 'request', hint: '在 A 会话让它去 B 会话发言；B 必须命中白名单' },
  { key: 'crossSessionControl', label: '跨会话控制（唤醒/静音）', group: '跨会话', mode: 'tool', default: 'request', maxScope: 'request', hint: '在 A 会话让它控制 B 会话的唤醒与静音（比如“别在那个群说话”）' },
  { key: 'crossSessionDelegate', label: '跨会话委派（让那个会话自己说）', group: '跨会话', mode: 'tool', default: 'request', maxScope: 'request', hint: '把“去某个群回复”交给目标会话，用它自己的人设和历史来写，避免人设串台' },
  { key: 'collectSticker', label: '收藏别人发的表情', group: '表情', mode: 'tool', default: 'persona', maxScope: 'persona', hint: '受每分钟 2 张 / 每小时 10 张限制' },
  { key: 'stickerNote', label: '给收藏表情写本地备注', group: '表情', mode: 'tool', default: 'persona', maxScope: 'persona', hint: '只写本地笔记，不改 QQ 上的官方备注' },
  // 删除收藏表情 = 账号级不可恢复（除非再收到同一张图）。按本文件的封顶规则，它最高只能到
  // 「仅应要求」，默认也是 request：管理员本人要求时直连，群友让删一律拒绝；另有频率上限。
  { key: 'deleteSticker', label: '删除自己收藏的表情', group: '表情', mode: 'tool', default: 'request', maxScope: 'request', hint: '不可恢复；默认只应管理员要求，受每分钟/每小时/每天上限约束' },
  // 空间说说 = 账号级公开广播（好友全看得到，而且不是"改错可撤销"的自助动作）。
  // 按本文件的封顶规则，它最高只能到「仅应要求」：管理员本人要求 → 直连；
  // 其他人（含群友）要求 → 确认卡发到管理员私聊，回「通过 #编号」才发。
  { key: 'qzonePost', label: '发 QQ 空间说说', group: '空间', mode: 'admin', default: 'request', maxScope: 'request', hint: '账号级公开广播；默认只应管理员要求，其他人要求走确认卡；另有每小时/每天上限' }
]);

const ROW_BY_KEY = new Map(BOT_PERM_ROWS.map((r) => [r.key, r]));

export function botPermRow(key) {
  return ROW_BY_KEY.get(key) ?? null;
}

export function defaultBotPerms() {
  return Object.fromEntries(BOT_PERM_ROWS.map((r) => [r.key, r.default]));
}

function clampScope(key, scope, unlocked) {
  const row = ROW_BY_KEY.get(key);
  if (!row) return scope;
  const cap = row.maxScope ?? 'persona';
  if (unlocked.includes(key)) return scope;
  return SCOPE_ORDER[scope] > SCOPE_ORDER[cap] ? cap : scope;
}

/**
 * 归一配置：未知键丢弃、非法值回退默认、旧值按表迁移、超封顶的夹回去。
 * 永远返回全部键（fail-closed 不依赖缺失），并额外返回 migrated（哪些键用了旧值）与 unlocked。
 * @param {object|null} raw 兼容三种形状：扁平 scope、{ scope }, { scope, unlocked }
 */
export function normalizeBotPerms(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const nested = src.scope && typeof src.scope === 'object' && !Array.isArray(src.scope);
  const scopeIn = nested ? src.scope : src;
  const unlocked = Array.isArray(src.unlocked)
    ? [...new Set(src.unlocked.map((k) => String(k)).filter((k) => ROW_BY_KEY.has(k)))]
    : [];
  const scope = defaultBotPerms();
  const unknown = [];
  const migrated = [];
  for (const [key, value] of Object.entries(scopeIn)) {
    if (key === 'unlocked') continue;
    if (!ROW_BY_KEY.has(key)) { unknown.push(key); continue; }
    const v = String(value ?? '').trim().toLowerCase();
    const normalized = LEGACY_BOT_SCOPES[v] ?? v;
    if (!BOT_SCOPES.includes(normalized)) continue;
    if (LEGACY_BOT_SCOPES[v]) migrated.push(key);
    scope[key] = clampScope(key, normalized, unlocked);
  }
  return { scope, unlocked, unknown, migrated };
}

export function scopeOf(perms, key) {
  const scope = perms?.scope ?? perms ?? {};
  const unlocked = Array.isArray(perms?.unlocked) ? perms.unlocked : [];
  const row = ROW_BY_KEY.get(key);
  const value = String(scope?.[key] ?? '').toLowerCase();
  const normalized = LEGACY_BOT_SCOPES[value] ?? value;
  const picked = BOT_SCOPES.includes(normalized) ? normalized : (row?.default ?? 'none');
  return row ? clampScope(key, picked, unlocked) : picked;
}

/** 多字段动作（例如同时改昵称与签名）取最严格的一档：任何一项 none 就不算放开。 */
export function strictestScope(scopes) {
  const list = (scopes ?? []).filter((s) => BOT_SCOPES.includes(s));
  if (!list.length) return 'none';
  return list.reduce((acc, s) => (SCOPE_ORDER[s] < SCOPE_ORDER[acc] ? s : acc), 'persona');
}

/**
 * 把管理员动作映射到权限键。
 * setQqProfile 一个动作可能同时带昵称与签名 ⇒ 返回两个键，调用方取最严格值。
 */
export function permissionKeysForAction(action, args = {}) {
  switch (action) {
    case 'setGroupCard': return ['setGroupCard'];
    case 'setQqAvatar': return ['setQqAvatar'];
    case 'recallMessage': return ['recallOwnMessage'];
    case 'setOnlineStatus': return ['setOnlineStatus'];
    // 发说说走管理员动作队列（public 广播 + 确认卡），权限键与动作同名。
    case 'postQzone': return ['qzonePost'];
    case 'setQqProfile': {
      const keys = [];
      if (args.nickname !== undefined) keys.push('setQqNickname');
      if (args.personalNote !== undefined) keys.push('setQqSignature');
      return keys;
    }
    default: return [];
  }
}

export function resolveActionScope(perms, action, args = {}) {
  const keys = permissionKeysForAction(action, args);
  if (!keys.length) return { keys, scope: 'none' };
  return { keys, scope: strictestScope(keys.map((k) => scopeOf(perms, k))) };
}

/**
 * 是否允许「直接执行」（不发确认卡、也不拒绝）。
 *
 * `senderIsOwner` 必须由调用方算成「该会话最近一条消息的发送者 QQ 号是 ownerQQ」——
 * 管理员身份只认 QQ 号，不认会话；私聊也不例外，没有「私聊 key 恒为管理员」的捷径。
 *
 * @param {'none'|'request'|'persona'} scope
 * @param {boolean} senderIsOwner 该会话最近一条消息是否 ownerQQ 发的（按 QQ 号判定）
 */
export function allowsSelfService(scope, { senderIsOwner = false } = {}) {
  if (scope === 'persona') return true;
  if (scope === 'request' && senderIsOwner) return true;
  return false;
}

/** 是否「没有这个能力」（直接拒绝，不登记确认卡）。 */
export function isScopeNone(scope) {
  return scope === 'none';
}

/**
 * 解析人格卡「反驳主人」的取值：`15%` / `0.15` / `15` 都认，夹到 0~1；解析不出来就用 fallback。
 */
export function parseVetoRate(text, fallback = DEFAULT_VETO_PROBABILITY) {
  const raw = String(text ?? '').trim();
  if (!raw) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  if (!m) return fallback;
  const hasPercent = raw.includes('%');
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  const p = hasPercent || n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, p));
}

/** 控制台展示用：把权限表整理成 rows（含当前值、封顶与是否已解除封顶）。 */
export function describeBotPerms(perms) {
  const unlocked = Array.isArray(perms?.unlocked) ? perms.unlocked : [];
  return BOT_PERM_ROWS.map((row) => ({
    ...row,
    scope: scopeOf(perms, row.key),
    unlocked: unlocked.includes(row.key)
  }));
}
