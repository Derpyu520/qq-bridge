// 记忆插件（P1：纯 JSON 后端）。
//
// 分层（详见 docs/design/MEMORY_PLUGIN_DESIGN.md §2）：
//   L0 缓冲   —— 桥接层 recentMessages（不在这里）
//   L1 事件流 —— 本模块 events-YYYY-MM-DD.jsonl（追加，只增不改）
//   L2 情节/事实 —— P1 还没有 LLM 巩固 worker；profile 是规则计数
//   L4 画像   —— profiles.json（只有计数与最后一句，不存推断性结论）
//   L5 人设锚 —— anchor.json（从人格卡抽取，按 mtime/size 失效）
//
// 本模块的边界：**只负责"记什么、记多久、怎么取、取多少"**。
// 不调模型、不发消息、不碰 social-v2 的字段；bridge 负责在正确的时点调 encode/render/checkpoint。
//
// 数据目录：<stateDir>/<safeKey>/
//   events-YYYY-MM-DD.jsonl  追加写事件
//   profiles.json            关于他们的画像（计数）
//   anchor.json              人设锚缓存
//   self.json                自我状态（P2 起用，目前占位）
//   meta.json                水位/版本/迁移标记/最近清理时间
import fs from 'node:fs';
import path from 'node:path';
import {
  DAY_MS, ensureDir, readJsonSafe, writeJsonAtomic, appendJsonl, readJsonl, dayKey, truncate, safeSegment,
} from './util.js';
import { bm25Scores } from './tokenize.js';
import { DEFAULT_FORGETTING, DEFAULT_WEIGHTS, W_TIERS, computeW, profileRapport, retention } from './weights.js';
import { salienceBreakdown, eventFromMessage, selfEventFromText, isForcedMemory, isSelfEventWorthKeeping, updateProfile } from './encoder.js';
import { buildAnchor, ANCHOR_MAX_CHARS, ANCHOR_VERSION } from './anchor.js';

export const MEMORY_VERSION = 1;

// 上限说明：
//   budgetChars —— 记忆块是唤醒 prompt 的一段，其余段落（角色/锚/状态/睡前规则）合计约 5~6k 字符，
//                  4000 已是"记忆占四成"的合理天花板，再大就会把工具协议挤到模型注意力之外。
//   anchorMaxChars —— 人设锚每轮都注入，且与角色卡内容重叠；1200 字足够容纳身份+说话方式+雷点，
//                  再多会稀释重点（完整角色卡仍可用 qq_get_prompt 现拉）。
export const MAX_BUDGET_CHARS = 4000;
export const MIN_BUDGET_CHARS = 200;
export const MAX_ANCHOR_CHARS = 1200;
export const MIN_ANCHOR_CHARS = 80;
export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  budgetChars: 1600,
  anchorMaxChars: ANCHOR_MAX_CHARS,
  eventThreshold: 0.45,
  recentDays: 7,
  recallMinW: W_TIERS.inject,
  maxEventsRead: 5000,
  pruneIntervalMs: 6 * 60 * 60 * 1000,
  migrateSocialV2: true,
};

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeMemoryConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...src,
    budgetChars: clampInt(src.budgetChars, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS, DEFAULT_MEMORY_CONFIG.budgetChars),
    anchorMaxChars: clampInt(src.anchorMaxChars, MIN_ANCHOR_CHARS, MAX_ANCHOR_CHARS, DEFAULT_MEMORY_CONFIG.anchorMaxChars),
    eventThreshold: clampNum(src.eventThreshold, 0, 1, DEFAULT_MEMORY_CONFIG.eventThreshold),
    recentDays: clampInt(src.recentDays, 1, 30, DEFAULT_MEMORY_CONFIG.recentDays),
    recallMinW: clampNum(src.recallMinW, 0, 1, DEFAULT_MEMORY_CONFIG.recallMinW),
    maxEventsRead: clampInt(src.maxEventsRead, 100, 20000, DEFAULT_MEMORY_CONFIG.maxEventsRead),
    forgetting: { ...DEFAULT_FORGETTING, ...(src.forgetting && typeof src.forgetting === 'object' ? src.forgetting : {}) },
    weights: { ...DEFAULT_WEIGHTS, ...(src.weights && typeof src.weights === 'object' ? src.weights : {}) },
    botNames: Array.isArray(src.botNames) && src.botNames.length ? src.botNames.map(String) : undefined,
  };
}

function ageLabel(ts, now) {
  const diff = Math.max(0, now - Number(ts));
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}分钟前`;
  if (diff < DAY_MS) return `${Math.round(diff / 3_600_000)}小时前`;
  return `${Math.round(diff / DAY_MS)}天前`;
}

function oneLine(text, max = 60) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

/**
 * 创建记忆插件。
 * @param {object} opts
 * @param {string} opts.stateDir          记忆根目录（通常 <STATE_DIR>/memory）
 * @param {object} [opts.config]          config.json 的 memory 段
 * @param {(msg: string) => void} [opts.log]
 * @param {() => ({name?: string, text?: string, stamp?: string}|null)} [opts.getRoleInfo] 人格卡读取（带缓存戳）
 * @param {() => number} [opts.now]
 */
export function createMemoryPlugin(opts = {}) {
  const stateDir = String(opts.stateDir ?? '');
  const cfg = normalizeMemoryConfig(opts.config);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const getRoleInfo = typeof opts.getRoleInfo === 'function' ? opts.getRoleInfo : () => null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  // 运行期开关：config.memory.enabled 只是启动初值，控制台可以在不重启的情况下开关。
  let enabled = cfg.enabled !== false;

  /** @type {Map<string, object>} */
  const states = new Map();

  function keyDir(key) {
    return path.join(stateDir, safeSegment(key));
  }

  function eventsFile(key, ts) {
    return path.join(keyDir(key), `events-${dayKey(ts)}.jsonl`);
  }

  function saveStructured(key, st) {
    const dir = keyDir(key);
    ensureDir(dir);
    writeJsonAtomic(path.join(dir, 'profiles.json'), st.profiles ?? {});
    writeJsonAtomic(path.join(dir, 'meta.json'), { ...(st.meta ?? {}), key: st.key });
    if (st.anchor) writeJsonAtomic(path.join(dir, 'anchor.json'), st.anchor);
    writeJsonAtomic(path.join(dir, 'self.json'), st.self ?? { openThreads: [] });
  }

  function trimProfiles(st) {
    const entries = Object.entries(st.profiles ?? {});
    if (entries.length <= 100) return;
    entries.sort((a, b) => (Number(b[1]?.lastSeen) || 0) - (Number(a[1]?.lastSeen) || 0));
    const keep = new Set(entries.slice(0, 100).map(([name]) => name));
    for (const name of Object.keys(st.profiles)) if (!keep.has(name)) delete st.profiles[name];
  }

  function prune(st) {
    const nowMs = now();
    const fg = cfg.forgetting;
    const cutoff = nowMs - (Number(fg.eventMaxDays) || 30) * DAY_MS;
    let events = st.events.filter((ev) => ev && Number(ev.t) >= cutoff);
    const maxCount = Math.max(100, Number(fg.eventMaxCount) || 2000);
    if (events.length > maxCount) events = events.slice(events.length - maxCount);
    st.events = events;
    // 画像只按"最近出现"裁剪；单次互动且 90 天没出现的人才清掉。
    for (const [name, p] of Object.entries(st.profiles ?? {})) {
      const seen = Number(p?.lastSeen) || 0;
      if ((Number(p?.count) || 0) <= 1 && nowMs - seen > 90 * DAY_MS) delete st.profiles[name];
    }
    trimProfiles(st);
    st.meta = { ...(st.meta ?? {}), version: MEMORY_VERSION, lastPruneAt: nowMs };
    saveStructured(st.key, st);
    return { kept: st.events.length };
  }

  function maybePrune(st) {
    const last = Number(st.meta?.lastPruneAt) || 0;
    if (now() - last < cfg.pruneIntervalMs) return;
    try {
      prune(st);
    } catch (error) {
      log(`⚠️ 记忆清理失败 ${st.key}：${error?.message ?? error}`);
    }
  }

  function loadState(key) {
    const dir = keyDir(key);
    ensureDir(dir);
    const meta = readJsonSafe(path.join(dir, 'meta.json'), null, (error) => log(`⚠️ 记忆 meta.json 损坏 ${key}：${error?.message ?? error}`)) ?? {};
    const profiles = readJsonSafe(path.join(dir, 'profiles.json'), {}, (error) => log(`⚠️ 记忆 profiles.json 损坏 ${key}：${error?.message ?? error}`));
    const anchor = readJsonSafe(path.join(dir, 'anchor.json'), null, () => {});
    const self = readJsonSafe(path.join(dir, 'self.json'), { openThreads: [] }, () => {}) ?? { openThreads: [] };

    const events = [];
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    } catch {
      files = [];
    }
    for (const name of files) {
      for (const ev of readJsonl(path.join(dir, name), (error) => log(`⚠️ 记忆事件文件损坏 ${key}/${name}：${error?.message ?? error}`))) {
        if (ev && Number(ev.t)) events.push(ev);
      }
    }
    events.sort((a, b) => Number(a.t) - Number(b.t));
    if (events.length > cfg.maxEventsRead) {
      // 内存里只留最近 N 条；磁盘文件不删（滚动删除属于 P2 的保留策略）。
      events.splice(0, events.length - cfg.maxEventsRead);
    }
    const st = {
      key,
      events,
      // 旧版本把某些会话的画像名写成了字面量「私聊」（private:* 全部挤在同一个人身上）。
      // 加载时清掉这种无意义画像，让它们按新的真实昵称重新累积。
      profiles: (() => {
        const raw = profiles && typeof profiles === 'object' ? profiles : {};
        const clean = {};
        for (const [name, value] of Object.entries(raw)) {
          if (name === '私聊' || name === '未知' || name === '') continue;
          if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
          clean[name] = value;
        }
        return clean;
      })(),
      anchor: anchor && typeof anchor === 'object' ? anchor : null,
      self: self && typeof self === 'object' ? self : { openThreads: [] },
      meta: meta && typeof meta === 'object' ? meta : {},
    };
    states.set(key, st);
    return st;
  }

  function stateFor(key) {
    const existing = states.get(key);
    if (existing) return existing;
    const st = loadState(key);
    maybePrune(st);
    return st;
  }

  /** 会话被删除/重置时使用：清掉磁盘与内存。 */
  function reset(key) {
    const dir = keyDir(key);
    states.delete(key);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 编码一条收到的消息。
   * @returns {{stored: boolean, salience: number, event?: object}}
   */
  function encode(key, msg) {
    if (!enabled || !msg) return { stored: false, salience: 0 };
    const st = stateFor(key);
    const nowMs = now();
    const recentTexts = st.events.slice(-6).map((ev) => ev.text);
    const profile = st.profiles[msg.userId] || (msg.sender ? st.profiles[msg.sender] : null);
    const bd = salienceBreakdown(msg, { recentTexts, botNames: cfg.botNames, profile, now: nowMs });

    const name = String(msg.sender ?? '').trim();
    if (name && !msg.isSelf) {
      st.profiles[name] = updateProfile(st.profiles[name], msg, nowMs);
      trimProfiles(st);
    }

    if (bd.score < cfg.eventThreshold && !isForcedMemory(msg)) {
      saveStructured(key, st);
      return { stored: false, salience: bd.score };
    }
    const ev = eventFromMessage(msg, { salience: bd.score, now: nowMs });
    st.events.push(ev);
    appendJsonl(eventsFile(key, ev.t), ev);
    st.meta = { ...(st.meta ?? {}), version: MEMORY_VERSION, lastEventAt: nowMs };
    saveStructured(key, st);
    return { stored: true, salience: bd.score, event: ev };
  }

  /** 编码自己发出去的消息（人格连续性："我上次说过什么"）。 */
  function encodeSelf(key, texts) {
    if (!enabled) return 0;
    const list = (Array.isArray(texts) ? texts : [texts])
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      // 只留「有信息量」的自我发言：以前每条都记，自己占了事件流 60%~94%，
      // 把群友的偏好/约定挤出了「最近的记忆」（见 encoder.isSelfEventWorthKeeping）。
      .filter(isSelfEventWorthKeeping);
    if (!list.length) return 0;
    const st = stateFor(key);
    for (const text of list) {
      const ev = selfEventFromText(text, { now: now(), seq: ++st.meta.lastEventSeq, importance: 0.4 });
      st.events.push(ev);
      appendJsonl(eventsFile(key, ev.t), ev);
    }
    saveStructured(key, st);
    return list.length;
  }

  /** 从 social-v2 的旧轻量记忆迁移（幂等：meta.migratedFromSocialV2 标记）。 */
  function migrateFromSocialV2(key, socialSt) {
    if (!enabled || !cfg.migrateSocialV2 || !socialSt) return false;
    const st = stateFor(key);
    if (st.meta.migratedFromSocialV2) return false;
    const nowMs = now();

    const impressions = socialSt.memberImpressions && typeof socialSt.memberImpressions === 'object' ? socialSt.memberImpressions : {};
    for (const [name, im] of Object.entries(impressions)) {
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
      st.profiles[name] = {
        name,
        userId: null,
        isOwner: false,
        count: Math.max(1, Number(im?.interactionCount) || 1),
        firstSeen: nowMs - 30 * DAY_MS,
        lastSeen: Number(im?.lastSeenAt) || nowMs,
        // 旧 traits 是印象标签（"爱嘴硬"这类），不是他说过的话；塞进 lastText 会被渲染成
        // 「上次说「爱嘴硬」」，读起来像截错人。旧画像只保留次数/时间，正文宁可空着。
        lastText: '',
      };
    }
    const topics = Array.isArray(socialSt.activeTopics) ? socialSt.activeTopics : [];
    for (const topic of topics.slice(-5)) {
      if (!topic?.text) continue;
      const ev = {
        v: 1,
        t: Number(topic.lastMentionAt) || nowMs,
        seq: 0,
        kind: 'grouplore',
        source: 'ai-observed',
        sender: '群聊',
        userId: null,
        isOwner: false,
        isSelf: false,
        quotedSelf: false,
        text: truncate(String(topic.text), 160),
        importance: 0.5,
        strength: 1,
        accessCount: 0,
      };
      st.events.push(ev);
      appendJsonl(eventsFile(key, ev.t), ev);
    }
    st.meta = { ...(st.meta ?? {}), migratedFromSocialV2: nowMs, version: MEMORY_VERSION };
    saveStructured(key, st);
    return true;
  }

  /** 人设锚：按角色卡 stamp 缓存，变化才重算。 */
  function renderAnchor(key) {
    if (!enabled) return '';
    let info = null;
    try {
      info = getRoleInfo();
    } catch {
      info = null;
    }
    if (!info?.text) return '';
    const st = stateFor(key);
    // stamp 里带 ANCHOR_VERSION 与 anchorMaxChars：抽锚算法改了、或控制台调了上限，
    // 旧的 anchor.json 缓存都必须失效——否则磁盘上会一直用老文案/老长度（改了看不到效果）。
    const stamp = `${String(info.stamp ?? info.name ?? '')}:a${ANCHOR_VERSION}:m${cfg.anchorMaxChars}`;
    if (st.anchor && st.anchor.stamp === stamp && st.anchor.text) return st.anchor.text;
    const text = buildAnchor(info.text, { maxChars: cfg.anchorMaxChars });
    if (!text) return '';
    st.anchor = { text, stamp, roleName: info.name ?? '', updatedAt: now() };
    saveStructured(key, st);
    return text;
  }

  function scoreEvent(ev, st, nowMs) {
    return computeW(ev, {
      now: nowMs,
      profile: st.profiles[ev.sender],
      weights: cfg.weights,
      forgetting: cfg.forgetting,
    });
  }

  /**
   * 渲染注入块。
   * @param {string} key
   * @param {{cue?: string, socialSt?: object, budgetChars?: number}} [options]
   */
  function render(key, options = {}) {
    if (!enabled) return '';
    if (options.socialSt) migrateFromSocialV2(key, options.socialSt);
    const st = stateFor(key);
    const nowMs = now();
    const budget = clampInt(options.budgetChars, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS, cfg.budgetChars);
    const recentCutoff = nowMs - cfg.recentDays * DAY_MS;
    const cue = String(options.cue ?? '').trim();

    const scored = st.events.map((ev) => ({ ev, w: scoreEvent(ev, st, nowMs) }));

    // 每段的候选上限。真正进不进去由 budgetChars 决定（下面的贪心装配），
    // 所以调大预算时能自动多塞几条，而不是被写死的 3 条卡住。
    // 上限按预算缩放：预算 4000 时最多各取 24 条，够填满；预算小时也够用。
    const slotCap = Math.max(3, Math.min(24, Math.ceil(budget / 150)));
    const MAX_RECENT = slotCap;
    const MAX_RECALL = slotCap;
    const MAX_PROFILES = Math.max(3, Math.min(12, Math.ceil(budget / 250)));

    // 1) 最近的记忆：近 N 天里权重最高的若干条
    const recentTop = scored
      .filter((entry) => Number(entry.ev.t) >= recentCutoff && entry.w >= W_TIERS.weak)
      .sort((a, b) => b.w - a.w)
      .slice(0, MAX_RECENT);

    // 2) 相关回忆：cue 命中的、不在"最近"里的旧事
    const recentSet = new Set(recentTop.map((entry) => entry.ev));
    const recall = [];
    if (cue) {
      for (const hit of bm25Scores(st.events, cue, (ev) => ev.text)) {
        if (recall.length >= MAX_RECALL) break;
        if (recentSet.has(hit.item)) continue;
        const w = scoreEvent(hit.item, st, nowMs);
        if (w < cfg.recallMinW) continue;
        recall.push({ ev: hit.item, w, score: hit.score });
      }
    }

    // 3) 关于他们：按亲密度取前若干
    const profiles = Object.values(st.profiles ?? {})
      .filter((p) => p && p.name)
      .map((p) => ({ profile: p, rapport: profileRapport(p, nowMs, cfg.forgetting) }))
      .filter((entry) => entry.rapport > 0.05)
      .sort((a, b) => b.rapport - a.rapport)
      .slice(0, MAX_PROFILES);

    // 每节带 items（对应的记忆对象）：只有**真正注入**的行才算「被回忆一次」，
    // 间隔效应的强化只给读到的记忆，而不是候选池里的全部。
    const sections = [];
    if (recentTop.length) {
      sections.push({
        title: '【最近的记忆】',
        items: recentTop.map(({ ev }) => ev),
        lines: recentTop.map(({ ev }) => `- ${ageLabel(ev.t, nowMs)} ${ev.isSelf ? '我' : oneLine(ev.sender, 20)}：${oneLine(ev.text)}`),
      });
    }
    if (recall.length) {
      sections.push({
        title: '【相关的回忆】',
        items: recall.map(({ ev }) => ev),
        lines: recall.map(({ ev }) => `- ${ageLabel(ev.t, nowMs)} ${oneLine(ev.sender, 20)}：${oneLine(ev.text)}`),
      });
    }
    if (profiles.length) {
      sections.push({
        title: '【关于他们】',
        items: profiles.map(({ profile }) => ({ profile })),
        lines: profiles.map(({ profile }) => {
          const ago = ageLabel(profile.lastSeen, nowMs);
          const last = profile.lastText ? `，上次说「${oneLine(profile.lastText, 24)}」` : '';
          return `- ${oneLine(profile.name, 16)}：聊过 ${Number(profile.count) || 0} 次，${ago}${last}`;
        }),
      });
    }
    if (!sections.length) {
      saveStructured(key, st);
      return '';
    }

    // 按预算逐行装配：标题在预算够时必留；某一行放不下就停在那一行，
    // 而不是「整段放不下就整段丢掉」——后者会让预算调大后依然只吐一个标题。
    let out = '';
    outer:
    for (const section of sections) {
      const header = out ? `\n${section.title}` : section.title;
      if (header.length > budget - out.length) break;
      out += header;
      for (let i = 0; i < section.lines.length; i += 1) {
        const piece = `\n${section.lines[i]}`;
        if (piece.length > budget - out.length) break outer;
        out += piece;
        const item = section.items?.[i];
        if (item?.ev) item.ev.accessCount = (Number(item.ev.accessCount) || 0) + 1;
      }
    }
    const text = out.trim();
    saveStructured(key, st);
    return text;
  }

  /** 检索接口（调试 / 未来的 MCP 工具共用）：返回相关旧事。 */
  function query(key, cue, limit = 3) {
    if (!enabled) return [];
    const st = stateFor(key);
    const nowMs = now();
    const k = clampInt(limit, 1, 20, 3);
    const out = [];
    for (const hit of bm25Scores(st.events, cue, (ev) => ev.text)) {
      if (out.length >= k) break;
      const w = scoreEvent(hit.item, st, nowMs);
      if (w < W_TIERS.weak) continue;
      out.push({
        text: hit.item.text,
        sender: hit.item.sender,
        t: hit.item.t,
        ageMs: Math.max(0, nowMs - Number(hit.item.t)),
        score: Number(hit.score.toFixed(3)),
        w: Number(w.toFixed(3)),
        retained: Number(retention(nowMs - Number(hit.item.t), hit.item, cfg.forgetting).toFixed(3)),
      });
    }
    return out;
  }

  /** 退役/空闲时调用：落盘 + 清理。 */
  function checkpoint(key) {
    if (!enabled) return null;
    const st = stateFor(key);
    try {
      return prune(st);
    } catch (error) {
      log(`⚠️ 记忆检查点失败 ${key}：${error?.message ?? error}`);
      return null;
    }
  }

  /** 控制台用：热更新可调参数（budgetChars / anchorMaxChars 等），不重启进程。 */
  function updateConfig(partial = {}) {
    const next = normalizeMemoryConfig({ ...cfg, ...(partial ?? {}) });
    Object.assign(cfg, next);
    return {
      budgetChars: cfg.budgetChars,
      anchorMaxChars: cfg.anchorMaxChars,
      eventThreshold: cfg.eventThreshold,
      recentDays: cfg.recentDays,
      recallMinW: cfg.recallMinW,
    };
  }

  /** 控制台用：运行期开关（不写 config.json，持久化由 bridge 负责）。 */
  function setEnabled(value) {
    enabled = value !== false;
    return enabled;
  }

  function isEnabled() {
    return enabled;
  }

  /** 控制台用：所有会话的汇总（只读 meta/画像/锚，不把事件全读进内存）。 */
  function overview() {
    const sessions = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      dirs = [];
    }
    for (const dirName of dirs) {
      const dir = path.join(stateDir, dirName);
      const meta = readJsonSafe(path.join(dir, 'meta.json'), {}) ?? {};
      const profiles = readJsonSafe(path.join(dir, 'profiles.json'), {}) ?? {};
      const anchor = readJsonSafe(path.join(dir, 'anchor.json'), null, () => {});
      let events = 0;
      let lastEventAt = Number(meta.lastEventAt) || 0;
      try {
        for (const name of fs.readdirSync(dir).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
          const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            events += 1;
            if (!lastEventAt) {
              try { lastEventAt = Number(JSON.parse(line).t) || 0; } catch { /* 坏行忽略 */ }
            }
          }
        }
      } catch { /* 目录不可读按空处理 */ }
      sessions.push({
        key: String(meta.key ?? dirName),
        dir: dirName,
        events,
        profiles: Object.keys(profiles ?? {}).length,
        anchorChars: anchor?.text?.length ?? 0,
        lastEventAt: lastEventAt || null,
      });
    }
    sessions.sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0));
    return {
      sessions,
      totals: {
        sessions: sessions.length,
        events: sessions.reduce((sum, x) => sum + x.events, 0),
        profiles: sessions.reduce((sum, x) => sum + x.profiles, 0),
      },
    };
  }

  /** 控制台用：清空全部记忆（所有会话）。返回删掉的目录数。 */
  function resetAll() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      dirs = [];
    }
    for (const dirName of dirs) {
      try { fs.rmSync(path.join(stateDir, dirName), { recursive: true, force: true }); } catch { /* 单个失败继续 */ }
    }
    states.clear();
    return dirs.length;
  }

  function stats(key) {
    const st = stateFor(key);
    return {
      enabled,
      events: st.events.length,
      profiles: Object.keys(st.profiles ?? {}).length,
      anchorChars: st.anchor?.text?.length ?? 0,
      key,
      migratedFromSocialV2: Boolean(st.meta?.migratedFromSocialV2),
      lastPruneAt: st.meta?.lastPruneAt ?? null,
    };
  }

  return {
    get enabled() {
      return enabled;
    },
    config: cfg,
    encode,
    encodeSelf,
    render,
    renderAnchor,
    query,
    checkpoint,
    migrateFromSocialV2,
    reset,
    stats,
    stateFor,
    setEnabled,
    isEnabled,
    updateConfig,
    overview,
    resetAll,
  };
}
