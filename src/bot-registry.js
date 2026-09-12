// 群里"别的机器人"识别与缓存。
//
// 背景：OneBot v11 的消息事件里 `sender` **不含**任何机器人标识，
// 但 SnowLuma 的 `get_group_member_info` / `get_group_member_list` 会返回
// `is_robot`（见 SnowLuma index.mjs 的 formatGroupMember）。所以识别方式是：
// 拉一次群成员列表 → 缓存"哪些 QQ 号是机器人" → 热路径只查内存。
//
// 若网关不提供 is_robot（老版本/其他实现），退化成昵称关键词启发式，
// 并在结果里标 source='heuristic'，让调用方知道可信度不同。
//
// 本模块不直接依赖 @snowluma/sdk：由调用方注入 `call(action, params)`。
import fs from 'node:fs';
import path from 'node:path';

/** 启发式兜底用的昵称关键词（仅在网关不返回 is_robot 时使用）。 */
export const DEFAULT_NAME_PATTERNS = [
  '机器人', '助手', '管家', '精灵', '小冰', '智能', 'bot', 'robot', 'assistant'
];

/** 群成员列表缓存多久视为过期（毫秒）。 */
export const DEFAULT_REFRESH_MS = 10 * 60 * 1000;

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isTruthyRobotFlag(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

function looksLikeBotName(name, patterns) {
  const lower = String(name ?? '').toLowerCase();
  if (!lower) return false;
  return patterns.some((p) => {
    const pat = String(p ?? '').toLowerCase();
    return pat && lower.includes(pat);
  });
}

/**
 * @param {object} options
 * @param {(action: string, params: object) => Promise<any>} options.call OneBot 调用器
 * @param {string} options.stateFile 持久化路径（state/bots.json）
 * @param {(msg: string) => void} [options.log]
 * @param {object} [options.cfg] 配置：{ autoDetect, refreshMs, known:[{qq,name}], namePatterns:[] }
 */
export function createBotRegistry({ call, stateFile, log = () => {}, cfg = {} }) {
  const refreshMs = Math.max(30000, Number(cfg.refreshMs) || DEFAULT_REFRESH_MS);
  const patterns = Array.isArray(cfg.namePatterns) && cfg.namePatterns.length ? cfg.namePatterns : DEFAULT_NAME_PATTERNS;
  const autoDetect = cfg.autoDetect !== false;

  /** @type {Map<string, {ts:number, authoritative:boolean, bots:Map<string,{name:string,source:string}>}>} */
  const groups = new Map();
  /** 正在刷新中的群，避免并发重复请求 */
  const inFlight = new Set();

  // 手工配置的已知机器人（config.bots.known），任何群里都认。
  const manual = new Map();
  for (const item of Array.isArray(cfg.known) ? cfg.known : []) {
    const qq = String(item?.qq ?? item?.userId ?? '').trim();
    if (!/^\d+$/.test(qq)) continue;
    manual.set(qq, { name: String(item?.name ?? item?.nickname ?? qq), source: 'manual' });
  }

  function load() {
    const saved = readJsonSafe(stateFile);
    if (!saved || typeof saved !== 'object' || !saved.groups) return;
    for (const [gid, entry] of Object.entries(saved.groups)) {
      if (!entry || typeof entry !== 'object') continue;
      const bots = new Map();
      for (const [qq, info] of Object.entries(entry.bots ?? {})) {
        if (!info || typeof info !== 'object') continue;
        bots.set(String(qq), { name: String(info.name ?? qq), source: String(info.source ?? 'is_robot') });
      }
      groups.set(String(gid), {
        ts: Number(entry.ts) || 0,
        authoritative: !!entry.authoritative,
        bots
      });
    }
  }

  function save() {
    try {
      const out = { groups: {} };
      for (const [gid, entry] of groups) {
        const bots = {};
        for (const [qq, info] of entry.bots) bots[qq] = { name: info.name, source: info.source };
        out.groups[gid] = { ts: entry.ts, authoritative: entry.authoritative, bots };
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(out, null, 2), 'utf8');
    } catch (error) {
      log(`机器人名册保存失败：${error?.message ?? error}`);
    }
  }

  function entryFor(groupId, { create = false } = {}) {
    const gid = String(groupId);
    let entry = groups.get(gid);
    if (!entry && create) {
      entry = { ts: 0, authoritative: false, bots: new Map() };
      groups.set(gid, entry);
    }
    return entry;
  }

  /**
   * 拉取群成员列表并重建该群的机器人名册。
   * 失败不抛异常（热路径调用方不该被网络问题拖垮）。
   */
  async function refresh(groupId, { force = false } = {}) {
    const gid = String(groupId);
    if (!/^\d+$/.test(gid)) return false;
    if (!autoDetect) return false;
    if (inFlight.has(gid)) return false;
    const existing = groups.get(gid);
    if (!force && existing && Date.now() - existing.ts < refreshMs) return false;
    inFlight.add(gid);
    try {
      const list = await call('get_group_member_list', { group_id: Number(gid) });
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      if (!Array.isArray(members) || members.length === 0) return false;

      // 只要有一个成员带 is_robot 字段，就认为该网关支持权威判定。
      const authoritative = members.some((m) => m && m.is_robot !== undefined);
      const bots = new Map();
      for (const m of members) {
        if (!m || m.user_id == null) continue;
        const qq = String(m.user_id);
        const name = String(m.card || m.nickname || qq);
        if (authoritative) {
          if (isTruthyRobotFlag(m.is_robot)) bots.set(qq, { name, source: 'is_robot' });
        } else if (looksLikeBotName(`${m.card ?? ''} ${m.nickname ?? ''}`, patterns)) {
          bots.set(qq, { name, source: 'heuristic' });
        }
      }
      // 手工名单始终并入（即便网关没把它们标成机器人）
      for (const [qq, info] of manual) {
        if (members.some((m) => String(m?.user_id) === qq)) bots.set(qq, info);
      }
      groups.set(gid, { ts: Date.now(), authoritative, bots });
      save();
      log(`机器人名册已刷新 ${gid}：${bots.size} 个${authoritative ? '（权威 is_robot）' : '（昵称启发式）'}`);
      return true;
    } catch (error) {
      log(`机器人名册刷新失败 ${gid}：${error?.message ?? error}`);
      return false;
    } finally {
      inFlight.delete(gid);
    }
  }

  /** 热路径用：名册过期就后台补一次，不阻塞当前消息处理。 */
  function ensureFresh(groupId) {
    const entry = groups.get(String(groupId));
    if (entry && Date.now() - entry.ts < refreshMs) return;
    refresh(groupId).catch(() => {});
  }

  /** 该 QQ 号在本群是否机器人。纯内存查询，同步返回。 */
  function isBot(groupId, userId) {
    const qq = String(userId ?? '').trim();
    if (!qq) return false;
    if (manual.has(qq)) return true;
    const entry = groups.get(String(groupId));
    if (!entry) return false;
    return entry.bots.has(qq);
  }

  function botInfo(groupId, userId) {
    const qq = String(userId ?? '').trim();
    const entry = groups.get(String(groupId));
    const found = entry?.bots.get(qq);
    if (found) return found;
    return manual.get(qq) ?? null;
  }

  /** 列出本群已知机器人，按名字排序。 */
  function list(groupId) {
    const entry = groups.get(String(groupId));
    const out = [];
    if (entry) {
      for (const [qq, info] of entry.bots) out.push({ qq, name: info.name, source: info.source });
    }
    if (!entry || entry.bots.size === 0) {
      for (const [qq, info] of manual) out.push({ qq, name: info.name, source: info.source });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    return out;
  }

  /** 运行时登记一个机器人（比如 AI 自己发现的）。 */
  function markBot(groupId, userId, name, source = 'learned') {
    const qq = String(userId ?? '').trim();
    if (!/^\d+$/.test(qq)) return false;
    const entry = entryFor(groupId, { create: true });
    entry.bots.set(qq, { name: String(name || qq), source });
    save();
    return true;
  }

  /** 该群名册的元信息，供控制台/指令展示。 */
  function meta(groupId) {
    const entry = groups.get(String(groupId));
    if (!entry) return { known: false, ts: 0, ageMs: null, authoritative: false, count: 0 };
    return {
      known: true,
      ts: entry.ts,
      ageMs: entry.ts ? Date.now() - entry.ts : null,
      authoritative: entry.authoritative,
      count: entry.bots.size
    };
  }

  /** 按昵称/群名片模糊查找本群机器人，返回第一个匹配。 */
  function findByNickname(groupId, needle) {
    const q = String(needle ?? '').trim().toLowerCase();
    if (!q) return null;
    for (const item of list(groupId)) {
      if (String(item.name).toLowerCase().includes(q) || item.qq === q) return item;
    }
    return null;
  }

  load();

  return { refresh, ensureFresh, isBot, botInfo, list, markBot, meta, findByNickname, save, _groups: groups };
}
