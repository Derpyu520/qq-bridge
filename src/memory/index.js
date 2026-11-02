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
import {
  appendMemoryMarkdown, loadMemoryIndex, readMemoryMarkdown, rebuildMemoryMarkdown, saveMemoryIndex, MEMORY_MD,
} from './markdown.js';
import { recallMemory, describeMemory } from './recall.js';
import {
  addMemory, applyRetention, consolidateMemories, forgetMemory, listCandidates, loadMemories, touchMemory,
} from './memories.js';

export const MEMORY_VERSION = 2;

// 共享记忆的目录名（state/memory/_global）。它不是会话，控制台要单独区分。
export const GLOBAL_DIR_NAME = '_global';

// 记忆不再用「字符预算 / 人设锚上限」这种被动注入参数：内容由模型自己查（qq_memory_recall），
// 提示词里只放索引（见 recall.js 的 describeMemory）。这两个常量保留导出只为兼容旧配置读取。
export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  eventThreshold: 0.45,
  recentDays: 7,
  recallMinW: W_TIERS.inject,
  maxEventsRead: 5000,
  pruneIntervalMs: 6 * 60 * 60 * 1000,
  migrateSocialV2: true,
  // 记忆保留/压缩/遗忘策略（见 memories.js 的 DEFAULT_RETENTION）
  retention: {},
  // 兼容旧字段（读得到就夹取一下，不再影响注入长度）
  budgetChars: 1600,
  anchorMaxChars: ANCHOR_MAX_CHARS,
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

function formatDateOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 在「模型自己写的记忆」里检索（带重要度加权：重要的事更容易被想起，也排更前）。
 * 用 2-gram BM25 复用 tokenize，避免再引一套分词。
 */
function recallModelMemories(entries, question, { now = Date.now(), limit = 5 } = {}) {
  const q = String(question ?? '').trim();
  const active = (Array.isArray(entries) ? entries : []).filter((e) => e && e.status === 'active');
  if (!q || !active.length) return [];
  const hits = bm25Scores(active, q, (e) => `${e.text} ${e.who ?? ''}`)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  if (!hits.length) return [];
  return hits.map(({ item }) => ({
    id: item.id,
    t: item.t,
    date: formatDateOf(item.t),
    who: item.who ?? '',
    text: item.text,
    importance: Number(item.importance) || 3,
    scope: item.scope,
    score: Number(hits.find((h) => h.item === item)?.score?.toFixed?.(3) ?? 0),
  }));
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

  // 共享记忆（跨会话共享）：放在 state/memory/_global/，关于「这个人/这件事本身」，
  // 任何群聊/私聊都查得到。与会话记忆分开存，避免 A 群的具体聊天内容泄漏到 B 群。
  function globalDir() {
    return path.join(stateDir, GLOBAL_DIR_NAME);
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
    // 同步写进人类可读的 MEMORY.md：AI 查的是它，你排查时看的也是它。
    try {
      const index = loadMemoryIndex(keyDir(key));
      const seq = Number(index.nextSeq) || 1;
      index.nextSeq = seq + 1;
      index.entries = { ...(index.entries ?? {}), [seq]: { t: ev.t, seq, sender: ev.sender, isSelf: ev.isSelf, kind: ev.kind } };
      appendMemoryMarkdown(keyDir(key), ev, seq);
      saveMemoryIndex(keyDir(key), index);
    } catch (error) {
      log(`⚠️ 写记忆文件失败 ${key}：${error?.message ?? error}`);
    }
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
   * 生成注入唤醒提示的**记忆索引**（不含正文）。
   *
   * 这是与旧实现最大的区别：以前把记忆内容按字符预算塞进提示词（"喂给"模型），
   * 现在只告诉模型「你有记忆、在哪、有多少、最近记了什么」，正文由模型自己
   * 调 qq_memory_recall 去查——这才是拟人记忆（需要时才回忆，而不是被灌一堆）。
   *
   * @param {string} key
   * @param {{socialSt?: object}} [options]
   */
  function render(key, options = {}) {
    if (!enabled) return '';
    if (options.socialSt) migrateFromSocialV2(key, options.socialSt);
    return describe(key);
  }

  /**
   * AI 主动查记忆（qq_memory_recall 的后端）。
   * 这是「拟人记忆」的核心：模型带着问题来翻，拿到的是可读片段，而不是被塞进提示词的一堆文本。
   * @param {string} key
   * @param {string} question 自然语言问题（"摩天轮" / "我上次说要去哪"）
   * @param {{limit?: number, includeFile?: boolean}} [opts]
   */
  function recall(key, question, opts = {}) {
    if (!enabled) return { fragments: [], total: 0, question: String(question ?? ''), mode: 'empty' };
    const dir = keyDir(key);
    const st = stateFor(key);
    const q = String(question ?? '').trim();

    // 1) 先查「模型自己写下的记忆」：**共享记忆（跨会话）+ 本会话记忆**一起查。
    //    共享记忆排在前面——它记的是"这个人本身"，比某个群的上下文更该被想起。
    const globalStore = loadMemories(globalDir());
    const sessionStore = loadMemories(dir);
    const globalHits = recallModelMemories(globalStore.entries, q, { now: now(), limit: Math.ceil((opts.limit || 5) / 2) });
    const sessionHits = recallModelMemories(sessionStore.entries, q, { now: now(), limit: opts.limit });
    for (const hit of globalHits) touchMemory(globalDir(), hit.id, now());
    for (const hit of sessionHits) touchMemory(dir, hit.id, now());

    if (globalHits.length || sessionHits.length) {
      const lines = [];
      for (const h of globalHits) lines.push(`[共享] ${h.date} ${'★'.repeat(h.importance)} ${h.who ? h.who + '：' : ''}${h.text}`);
      for (const h of sessionHits) lines.push(`[本会话] ${h.date} ${'★'.repeat(h.importance)} ${h.who ? h.who + '：' : ''}${h.text}`);
      return {
        key,
        question: q,
        mode: 'memory',
        fragments: [{ date: formatDateOf((globalHits[0] || sessionHits[0]).t), age: '', lines }],
        total: globalStore.entries.length + sessionStore.entries.length,
        hint: '这些是你自己记下的事：`[共享]` 是跨群通用的（关于这个人/这件事本身），`[本会话]` 只在这里有效。★ 越多越重要。引用细节要自然，别整段念。',
      };
    }

    // 2) 没写过的记忆命中 → 退回聊天流水检索（补细节/兜底）
    const result = recallMemory(st.events, q, { now: now(), limit: opts.limit });
    result.key = key;
    result.file = path.join(dir, MEMORY_MD);
    return result;
  }

  /** 模型写记忆。scope=long/short，layer=global/session（共享/本会话），importance=1..5。 */
  /** 模型写记忆。layer=global/session；给了 replaceId 就覆盖/合并那一条。 */
  function saveMemory(key, { text, scope, importance, who, layer, replaceId }) {
    if (!enabled) return null;
    const target = String(layer ?? '').toLowerCase() === 'global' ? globalDir() : keyDir(key);
    const entry = addMemory(target, { text, scope, importance, who, layer, replaceId, source: 'model', now: now() });
    return entry;
  }

  /** 写入前先列出候选记忆，交给模型判断该新增还是合并（不做自动合并）。 */
  function memoryCandidates(key, { who, layer, limit } = {}) {
    if (!enabled) return [];
    const target = String(layer ?? '').toLowerCase() === 'global' ? globalDir() : keyDir(key);
    return listCandidates(target, { who, layer, limit });
  }

  /** 删除一条模型记忆（先查本会话，再查共享层）。 */
  function forgetMemoryById(key, id) {
    if (forgetMemory(keyDir(key), id)) return true;
    return forgetMemory(globalDir(), id);
  }

  /** 执行保留/压缩/遗忘（控制台或定时调用）：只整理本会话。 */
  function runRetention(key) {
    return applyRetention(keyDir(key), { now: now(), retention: cfg.retention });
  }

  /** 整理共享记忆（跨会话共享层）。与会话层分开跑，避免每个会话重复处理同一份数据。 */
  function runRetentionGlobal() {
    return applyRetention(globalDir(), { now: now(), retention: cfg.retention });
  }

  /** 主动整理：把重复/高度相似的记忆合并（会话层 + 共享层）。 */
  function runConsolidate(key) {
    const a = consolidateMemories(keyDir(key), { now: now() });
    const b = consolidateMemories(globalDir(), { now: now() });
    return {
      merged: (a.merged || 0) + (b.merged || 0),
      kept: (a.kept || 0) + (b.kept || 0),
    };
  }

  /** 只整理共享层（定时任务用）。 */
  function runConsolidateGlobal() {
    return consolidateMemories(globalDir(), { now: now() });
  }

  /** 注入提示词用的记忆索引（不含正文）。 */
  function describe(key) {
    if (!enabled) return '';
    const st = stateFor(key);
    const sessionStore = loadMemories(keyDir(key));
    const globalStore = loadMemories(globalDir());
    const days = new Set(st.events.map((ev) => dayKey(ev.t))).size;
    const latest = st.events.length ? st.events[st.events.length - 1] : null;
    const active = sessionStore.entries.filter((e) => e.status === 'active');
    const globalActive = globalStore.entries.filter((e) => e.status === 'active');
    return describeMemory({
      key,
      counts: {
        events: st.events.length,
        profiles: Object.keys(st.profiles ?? {}).length,
        days,
        memories: active.length,
        longMemories: active.filter((e) => e.scope === 'long' && (e.layer ?? 'session') === 'session').length,
        shortMemories: active.filter((e) => e.scope === 'short' && (e.layer ?? 'session') === 'session').length,
        globalMemories: globalActive.length,
      },
      latest,
      now: now(),
    });
  }

  /** 读 MEMORY.md 原文（运维/控制台查看用）。 */
  function readFile(key) {
    return readMemoryMarkdown(keyDir(key));
  }

  /** 读共享记忆（跨会话共享层）的 MEMORY.md。 */
  function readGlobalFile() {
    return readMemoryMarkdown(globalDir());
  }

  /** 从事件流重建 MEMORY.md（迁移/修复用）。 */
  function rebuildFile(key) {
    const st = stateFor(key);
    const result = rebuildMemoryMarkdown(keyDir(key), st.events);
    const index = { version: 1, entries: {}, nextSeq: 1 };
    [...st.events].sort((a, b) => Number(b.t) - Number(a.t)).forEach((ev, i) => {
      index.entries[i + 1] = { t: ev.t, seq: i + 1, sender: ev.sender, isSelf: ev.isSelf, kind: ev.kind };
    });
    index.nextSeq = st.events.length + 1;
    saveMemoryIndex(keyDir(key), index);
    return result;
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

  /** 控制台用：热更新可调参数（事件阈值 / 回看天数等），不重启进程。 */
  function updateConfig(partial = {}) {
    const next = normalizeMemoryConfig({ ...cfg, ...(partial ?? {}) });
    Object.assign(cfg, next);
    return {
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
      // MEMORY.md 的字符数：控制台用它反映"记忆文件有多大"（不再是注入预算）。
      let memoryChars = 0;
      try { memoryChars = fs.statSync(path.join(dir, MEMORY_MD)).size; } catch { memoryChars = 0; }
      // AI 自己写下的记忆（长期/短期）
      let memStore = { entries: [] };
      try { memStore = loadMemories(dir); } catch { memStore = { entries: [] }; }
      const activeMem = (memStore.entries ?? []).filter((e) => e && e.status === 'active');
      // _global 是共享记忆的存储目录，不是会话：单独标记，控制台不把它混进会话列表。
      const isGlobal = dirName === GLOBAL_DIR_NAME;
      sessions.push({
        key: isGlobal ? '共享记忆' : String(meta.key ?? dirName),
        dir: dirName,
        isGlobal,
        events,
        profiles: Object.keys(profiles ?? {}).length,
        memories: activeMem.length,
        longMemories: activeMem.filter((e) => e.scope === 'long').length,
        shortMemories: activeMem.filter((e) => e.scope === 'short').length,
        memoryChars,
        lastEventAt: lastEventAt || null,
      });
    }
    sessions.sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0));
    const realSessions = sessions.filter((x) => !x.isGlobal);
    return {
      sessions,
      totals: {
        sessions: realSessions.length,
        events: realSessions.reduce((sum, x) => sum + x.events, 0),
        profiles: realSessions.reduce((sum, x) => sum + x.profiles, 0),
        memories: sessions.reduce((sum, x) => sum + x.memories, 0),
        longMemories: sessions.reduce((sum, x) => sum + x.longMemories, 0),
        shortMemories: sessions.reduce((sum, x) => sum + x.shortMemories, 0),
        memoryChars: sessions.reduce((sum, x) => sum + x.memoryChars, 0),
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
    recall,
    describe,
    readFile,
    readGlobalFile,
    rebuildFile,
    saveMemory,
    memoryCandidates,
    forgetMemoryById,
    runRetention,
    runRetentionGlobal,
    runConsolidate,
    runConsolidateGlobal,
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





