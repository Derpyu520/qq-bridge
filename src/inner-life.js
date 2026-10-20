// 内在状态：日记（分级遗忘）、心情与好感度、未完成的约定。
//
// 设计取舍：
// - 三份状态各自一个文件（state/diary.json / heart.json / promises.json），
//   原子写（tmp + rename），坏文件降级为只读不写，绝不静默清空用户数据。
// - 全部按会话 key 分桶：群聊和私聊的记忆互不串味。
// - 好感度只影响「语气」和「主动概率」，绝不影响权限或能力（安全边界）。
// - 遗忘是硬删除：普通 7 天、重要 30 天、非常重要永不删除（教程里的分级）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIARY_LEVELS = ['normal', 'important', 'critical'];
const MOODS = ['happy', 'calm', 'low', 'sad', 'irritated', 'excited', 'tired'];
const MOOD_LABEL = {
  happy: '高兴',
  calm: '平静',
  low: '低落',
  sad: '难过',
  irritated: '烦躁',
  excited: '兴奋',
  tired: '疲惫'
};
const LEVEL_LABEL = { normal: '普通', important: '重要', critical: '非常重要' };
const MAX_DIARY_PER_KEY = 400;
const MAX_PROMISES_PER_KEY = 50;
const MAX_HISTORY = 300;

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 读坏了：返回 null 让调用方降级为「只读不写」，不覆盖原文件。
      return null;
    }
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 支持 ISO 时间、毫秒时间戳、"2h"/"90m"/"1d" 这种相对时长 */
function parseDueAt(input) {
  if (input === undefined || input === null || input === '') return Date.now() + 2 * 60 * 60 * 1000;
  if (typeof input === 'number' || /^\d{10,}$/.test(String(input).trim())) {
    const n = Number(input);
    return n > 1e12 ? n : n * 1000;
  }
  const s = String(input).trim();
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2].toLowerCase()];
    return Date.now() + Math.round(Number(rel[1]) * unit);
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : Date.now() + 2 * 60 * 60 * 1000;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function createInnerLife({ stateDir, getConfig, log = () => {} }) {
  const DIARY_FILE = path.join(stateDir, 'diary.json');
  const HEART_FILE = path.join(stateDir, 'heart.json');
  const PROMISE_FILE = path.join(stateDir, 'promises.json');

  let diary = readJson(DIARY_FILE, {});
  let heart = readJson(HEART_FILE, {});
  let promises = readJson(PROMISE_FILE, {});
  let diaryWritable = diary !== null;
  let heartWritable = heart !== null;
  let promiseWritable = promises !== null;
  diary = diary ?? {};
  heart = heart ?? {};
  promises = promises ?? {};

  const settings = () => {
    const inner = getConfig()?.socialV2?.innerLife ?? {};
    return {
      normalDays: Math.max(1, num(inner.diaryTtlNormalDays, 7)),
      importantDays: Math.max(1, num(inner.diaryTtlImportantDays, 30)),
      sweepHour: clamp(Math.round(num(inner.sweepHour, 4)), 0, 23),
      deltaPerTurn: Math.max(1, num(inner.affinityMaxDeltaPerTurn, 5)),
      dailyCap: Math.max(1, num(inner.affinityDailyCap, 15)),
      missingIdleMs: Math.max(60_000, num(inner.missingIdleMs, 2 * 60 * 60 * 1000)),
      diaryBriefLimit: clamp(Math.round(num(inner.diaryBriefLimit, 3)), 0, 10),
      profileStaleDays: Math.max(1, num(inner.profileStaleDays, 30)),
      profileDropDays: Math.max(2, num(inner.profileDropDays, 60)),
      scheduleReviewDays: Math.max(1, num(inner.scheduleReviewDays, 3))
    };
  };

  const save = (which) => {
    try {
      if (which === 'diary' && diaryWritable) writeJson(DIARY_FILE, diary);
      if (which === 'heart' && heartWritable) writeJson(HEART_FILE, heart);
      if (which === 'promise' && promiseWritable) writeJson(PROMISE_FILE, promises);
      if (which === 'schedule' && scheduleWritable) writeJson(SCHEDULE_FILE, schedule);
      if (which === 'profile' && profileWritable) writeJson(PROFILE_FILE, profileStore);
    } catch (error) {
      log(`⚠️ 内在状态写盘失败（${which}）：${error?.message ?? error}`);
    }
  };

  const bucket = (store, key) => {
    if (!store[key] || typeof store[key] !== 'object') store[key] = {};
    return store[key];
  };

  // ── 日记 ──────────────────────────────────────────────────────────────────
  function diaryAdd(key, { level, text, mood, unsaid } = {}) {
    const cleanText = String(text ?? '').trim();
    if (!key || !cleanText) throw new Error('key 和 text 不能为空');
    const lv = DIARY_LEVELS.includes(level) ? level : 'normal';
    const s = settings();
    const now = Date.now();
    const ttlDays = lv === 'normal' ? s.normalDays : lv === 'important' ? s.importantDays : 0;
    const entry = {
      id: uid(),
      at: now,
      level: lv,
      text: cleanText.slice(0, 500),
      mood: MOODS.includes(mood) ? mood : 'calm',
      unsaid: String(unsaid ?? '').trim().slice(0, 300) || '',
      expiresAt: ttlDays > 0 ? now + ttlDays * 86400000 : 0
    };
    const b = bucket(diary, key);
    if (!Array.isArray(b.entries)) b.entries = [];
    b.entries.push(entry);
    if (b.entries.length > MAX_DIARY_PER_KEY) {
      // 超量时先丢最旧的「普通」，再丢最旧的「重要」，绝不丢「非常重要」
      const order = { normal: 0, important: 1, critical: 2 };
      b.entries.sort((a, c) => (order[a.level] - order[c.level]) || (a.at - c.at));
      b.entries = b.entries.slice(b.entries.length - MAX_DIARY_PER_KEY).sort((a, c) => a.at - c.at);
    }
    save('diary');
    return entry;
  }

  function diarySearch(key, { query, level, limit } = {}) {
    const b = diary[key] ?? {};
    let list = Array.isArray(b.entries) ? b.entries.slice() : [];
    const now = Date.now();
    list = list.filter((e) => !e.expiresAt || e.expiresAt > now);
    if (level && DIARY_LEVELS.includes(level)) list = list.filter((e) => e.level === level);
    if (query) {
      const q = String(query).toLowerCase();
      list = list.filter((e) => `${e.text} ${e.unsaid ?? ''}`.toLowerCase().includes(q));
    }
    list.sort((a, c) => c.at - a.at);
    return list.slice(0, clamp(Math.round(num(limit, 10)), 1, 50));
  }

  function diarySweep(now = Date.now()) {
    let removed = 0;
    let remaining = 0;
    for (const [key, b] of Object.entries(diary)) {
      if (!Array.isArray(b?.entries)) continue;
      const kept = b.entries.filter((e) => {
        const alive = !e.expiresAt || e.expiresAt > now;
        if (!alive) removed += 1;
        return alive;
      });
      b.entries = kept;
      remaining += kept.length;
      if (!kept.length) delete diary[key];
    }
    if (removed) save('diary');
    return { removed, remaining };
  }

  function diaryBrief(key, limit) {
    const s = settings();
    const n = limit ?? s.diaryBriefLimit;
    if (!n) return '';
    const list = diarySearch(key, { limit: n });
    if (!list.length) return '';
    const lines = list.map((e) => `- [${LEVEL_LABEL[e.level]}|${fmtTime(e.at)}] ${e.text}${e.unsaid ? `（当时没说出口：${e.unsaid}）` : ''}`);
    return `【最近日记】\n${lines.join('\n')}`;
  }

  // ── 心情 / 好感度 ─────────────────────────────────────────────────────────
  function heartGet(key) {
    const b = bucket(heart, key);
    if (!b.affinity) b.affinity = { score: 0, level: 1, updatedAt: 0 };
    if (!b.mood) b.mood = { label: 'calm', reason: '', updatedAt: 0 };
    if (!Array.isArray(b.history)) b.history = [];
    if (!b.day) b.day = { date: '', delta: 0 };
    return b;
  }

  function heartUpdate(key, { affinityDelta, mood, reason } = {}) {
    if (!key) throw new Error('key 不能为空');
    const b = heartGet(key);
    const s = settings();
    const now = Date.now();
    const today = dayKey(now);
    if (b.day.date !== today) b.day = { date: today, delta: 0 };

    const deltaRaw = num(affinityDelta, 0);
    let applied = 0;
    if (deltaRaw !== 0) {
      applied = clamp(deltaRaw, -s.deltaPerTurn, s.deltaPerTurn);
      // 单日总增量封顶，避免「疯狂夸 → 一天刷满」把好感度玩坏
      const room = s.dailyCap - Math.abs(b.day.delta);
      if (room <= 0) applied = 0;
      else if (Math.abs(applied) > room) applied = Math.sign(applied) * room;
      if (applied !== 0) {
        b.affinity.score = clamp(Math.round((b.affinity.score || 0) + applied), 0, 100);
        b.day.delta += applied;
      }
    }
    b.affinity.level = clamp(Math.floor(b.affinity.score / 10) + 1, 1, 10);
    b.affinity.updatedAt = now;

    let moodChanged = false;
    if (mood && MOODS.includes(mood)) {
      moodChanged = b.mood.label !== mood;
      b.mood = { label: mood, reason: String(reason ?? '').trim().slice(0, 120), updatedAt: now };
    } else if (reason) {
      b.mood.reason = String(reason).trim().slice(0, 120);
      b.mood.updatedAt = now;
    }

    if (applied !== 0 || moodChanged) {
      b.history.push({ at: now, delta: applied, mood: b.mood.label, reason: String(reason ?? '').trim().slice(0, 120), level: b.affinity.level });
      if (b.history.length > MAX_HISTORY) b.history = b.history.slice(-MAX_HISTORY);
      save('heart');
    }
    return b;
  }

  function heartLine(key) {
    const b = heartGet(key);
    const moodName = MOOD_LABEL[b.mood.label] ?? '平静';
    const reason = b.mood.reason ? `（${b.mood.reason}）` : '';
    // 只在最近 6 小时内有更新时才提心情，避免陈年情绪一直挂在 prompt 里
    const fresh = b.mood.updatedAt && Date.now() - b.mood.updatedAt < 6 * 3600 * 1000;
    const moodText = fresh ? `心情：${moodName}${reason}` : '';
    const affinityText = `好感度：${b.affinity.level}/10（${b.affinity.score}/100）`;
    return `【此刻心情】${moodText || '心情：平静'}｜${affinityText}`;
  }

  // ── 约定 ──────────────────────────────────────────────────────────────────
  function promiseAdd(key, { text, dueAt } = {}) {
    const clean = String(text ?? '').trim();
    if (!key || !clean) throw new Error('key 和 text 不能为空');
    const b = bucket(promises, key);
    if (!Array.isArray(b.items)) b.items = [];
    const item = { id: uid(), text: clean.slice(0, 200), dueAt: parseDueAt(dueAt), createdAt: Date.now(), status: 'open', doneAt: 0 };
    b.items.push(item);
    if (b.items.length > MAX_PROMISES_PER_KEY) b.items = b.items.slice(-MAX_PROMISES_PER_KEY);
    save('promise');
    return item;
  }

  function promiseDone(key, { id, text } = {}) {
    const b = promises[key];
    if (!b || !Array.isArray(b.items)) return null;
    const idx = b.items.findIndex((p) => (id ? p.id === id : text ? p.text === String(text).trim() : false));
    if (idx < 0) return null;
    b.items[idx].status = 'done';
    b.items[idx].doneAt = Date.now();
    save('promise');
    return b.items[idx];
  }

  function promiseDue(key, now = Date.now()) {
    const b = promises[key];
    if (!b || !Array.isArray(b.items)) return [];
    return b.items.filter((p) => p.status === 'open' && p.dueAt <= now);
  }

  /** 已到期且还没提醒过的约定（60 秒轮询用，避免同一条反复唤醒） */
  function promiseDueUnnotified(key, now = Date.now()) {
    return promiseDue(key, now).filter((p) => !p.notifiedAt);
  }

  function promiseMarkNotified(key, id) {
    const b = promises[key];
    if (!b || !Array.isArray(b.items)) return null;
    const item = b.items.find((p) => p.id === id);
    if (!item) return null;
    item.notifiedAt = Date.now();
    save('promise');
    return item;
  }

  function promiseOpen(key) {
    const b = promises[key];
    if (!b || !Array.isArray(b.items)) return [];
    return b.items.filter((p) => p.status === 'open').slice(-10);
  }

  function promiseLine(key, now = Date.now()) {
    const open = promiseOpen(key);
    if (!open.length) return '';
    const due = open.filter((p) => p.dueAt <= now);
    const lines = open.map((p) => `- ${p.text}（约定时间：${fmtTime(p.dueAt)}${p.dueAt <= now ? '，已到期' : ''}）`);
    const head = due.length ? '【到期的约定】你现在可以决定要不要兑现：' : '【还没兑现的约定】';
    return `${head}\n${lines.join('\n')}`;
  }

  /** 唤醒 prompt 用：心情 + 到期约定 + 最近日记 */
  function wakeBrief(key) {
    const parts = [];
    parts.push(heartLine(key));
    const pl = promiseLine(key);
    if (pl) parts.push(pl);
    const sc = scheduleLine(key);
    if (sc) parts.push(sc);
    const pf = profileLine(key);
    if (pf) parts.push(pf);
    const db = diaryBrief(key);
    if (db) parts.push(db);
    return parts.join('\n\n');
  }

  // ── 日程表：短期小事（明天体检、后天考试）────────────────────────────────
  // 和日记的分工：日记记「值得记的事」，日程记「这两天要发生的小事」。
  // 两级遗忘：先模糊化（上高数 → 有课，原文留底），下一轮结算再删。
  const SCHEDULE_FILE = path.join(stateDir, 'schedule.json');
  let schedule = readJson(SCHEDULE_FILE, {});
  let scheduleWritable = schedule !== null;
  schedule = schedule ?? {};

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function ymd(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function parseScheduleDate(input) {
    const s = String(input ?? '').trim();
    if (!s) return ymd();
    const rel = { 今天: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3, 昨天: -1 };
    if (s in rel) return ymd(Date.now() + rel[s] * 86400000);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;
    const md = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (md) {
      const y = new Date().getFullYear();
      return `${y}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    }
    const plus = s.match(/^\+(\d+)d$/i);
    if (plus) return ymd(Date.now() + Number(plus[1]) * 86400000);
    const ts = Date.parse(s);
    return Number.isFinite(ts) ? ymd(ts) : ymd();
  }

  function scheduleAdd(key, { date, text, detail } = {}) {
    const clean = String(text ?? '').trim();
    if (!key || !clean) throw new Error('key 和 text 不能为空');
    const b = bucket(schedule, key);
    if (!Array.isArray(b.items)) b.items = [];
    const item = {
      id: uid(),
      date: parseScheduleDate(date),
      text: clean.slice(0, 200),
      detail: String(detail ?? '').trim().slice(0, 300),
      fuzzyText: '',
      fuzzCount: 0,
      promotedToProfile: false,
      createdAt: Date.now(),
      lastMentionAt: Date.now(),
      lastReviewedAt: 0
    };
    b.items.push(item);
    if (b.items.length > 200) b.items = b.items.slice(-200);
    save('schedule');
    return item;
  }

  function scheduleList(key, { from, to, includeDropped = false } = {}) {
    const b = schedule[key];
    if (!b || !Array.isArray(b.items)) return [];
    const lo = from ? parseScheduleDate(from) : ymd(Date.now() - 2 * 86400000);
    const hi = to ? parseScheduleDate(to) : ymd(Date.now() + 3 * 86400000);
    return b.items
      .filter((it) => (includeDropped || !it.dropped) && it.date >= lo && it.date <= hi)
      .sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : a.createdAt - c.createdAt))
      .slice(0, 50);
  }

  function scheduleFind(key, id) {
    const b = schedule[key];
    if (!b || !Array.isArray(b.items)) return null;
    return b.items.find((it) => it.id === id) ?? null;
  }

  function scheduleUpdate(key, { id, text, date, detail } = {}) {
    const item = scheduleFind(key, id);
    if (!item) throw new Error('找不到这条日程');
    if (text !== undefined && String(text).trim()) item.text = String(text).trim().slice(0, 200);
    if (detail !== undefined) item.detail = String(detail).trim().slice(0, 300);
    if (date) item.date = parseScheduleDate(date);
    item.lastReviewedAt = Date.now();
    save('schedule');
    return item;
  }

  /** 模糊化：保留原文在 text，只把 fuzzyText 注入给模型 */
  function scheduleFuzz(key, { id, fuzzyText } = {}) {
    const item = scheduleFind(key, id);
    if (!item) throw new Error('找不到这条日程');
    const f = String(fuzzyText ?? '').trim();
    if (!f) throw new Error('fuzzyText 不能为空（例：上午有课）');
    item.fuzzyText = f.slice(0, 120);
    item.fuzzCount = Number(item.fuzzCount || 0) + 1;
    item.lastReviewedAt = Date.now();
    save('schedule');
    return item;
  }

  function scheduleDrop(key, { id } = {}) {
    const item = scheduleFind(key, id);
    if (!item) throw new Error('找不到这条日程');
    item.dropped = true;
    item.droppedAt = Date.now();
    save('schedule');
    return item;
  }

  /** 升级进画像（由结算时 AI 决定） */
  function schedulePromote(key, { id } = {}) {
    const item = scheduleFind(key, id);
    if (!item) throw new Error('找不到这条日程');
    item.promotedToProfile = true;
    item.lastReviewedAt = Date.now();
    save('schedule');
    return item;
  }

  function scheduleLine(key, now = Date.now()) {
    const today = ymd(now);
    const tomorrow = ymd(now + 86400000);
    const dayAfter = ymd(now + 2 * 86400000);
    const items = scheduleList(key, { from: ymd(now - 3 * 86400000), to: ymd(now + 2 * 86400000) });
    if (!items.length) return '';
    const groups = new Map();
    for (const it of items) {
      const label = it.date === today ? '今天' : it.date === tomorrow ? '明天' : it.date === dayAfter ? '后天'
        : it.date < today ? '已经过去' : it.date;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(`- ${it.fuzzyText || it.text}${it.detail && !it.fuzzyText ? `（${it.detail}）` : ''}`);
    }
    const lines = [...groups.entries()].map(([label, list]) => `【${label}】\n${list.join('\n')}`);
    return lines.join('\n');
  }

  // ── 画像：对他的长期认识（按「还成不成立」淡忘，不按时间）──────────────────
  const PROFILE_FILE = path.join(stateDir, 'profile.json');
  let profileStore = readJson(PROFILE_FILE, {});
  let profileWritable = profileStore !== null;
  profileStore = profileStore ?? {};

  function profileBucket(key) {
    const b = bucket(profileStore, key);
    if (!Array.isArray(b.facts)) b.facts = [];
    return b;
  }

  function profileSet(key, { text, confidence } = {}) {
    const clean = String(text ?? '').trim();
    if (!key || !clean) throw new Error('key 和 text 不能为空');
    const b = profileBucket(key);
    const conf = clamp(num(confidence, 0.6), 0.1, 1);
    const existing = b.facts.find((f) => f.text === clean && f.status !== 'dropped');
    if (existing) {
      existing.confidence = Math.max(existing.confidence, conf);
      existing.lastConfirmedAt = Date.now();
      existing.status = 'active';
      save('profile');
      return existing;
    }
    const fact = { id: uid(), text: clean.slice(0, 160), confidence: conf, status: 'active', createdAt: Date.now(), lastConfirmedAt: Date.now(), source: '' };
    b.facts.push(fact);
    if (b.facts.length > 60) b.facts = b.facts.slice(-60);
    save('profile');
    return fact;
  }

  function profileFind(key, { id, text } = {}) {
    const b = profileStore[key];
    if (!b || !Array.isArray(b.facts)) return null;
    if (id) return b.facts.find((f) => f.id === id) ?? null;
    return b.facts.find((f) => f.text === String(text ?? '').trim() && f.status !== 'dropped') ?? null;
  }

  function profileConfirm(key, { id, text } = {}) {
    const fact = profileFind(key, { id, text });
    if (!fact) throw new Error('找不到这条画像');
    fact.lastConfirmedAt = Date.now();
    fact.status = 'active';
    fact.confidence = Math.min(1, (Number(fact.confidence) || 0.6) + 0.1);
    save('profile');
    return fact;
  }

  function profileDrop(key, { id, text } = {}) {
    const fact = profileFind(key, { id, text });
    if (!fact) throw new Error('找不到这条画像');
    fact.status = 'dropped';
    fact.droppedAt = Date.now();
    save('profile');
    return fact;
  }

  /** 过期判定：超过 staleDays 没确认 → stale；超过 dropDays → dropped（不删，可查） */
  function profileSweep(now = Date.now()) {
    const s = settings();
    const staleMs = (s.profileStaleDays ?? 30) * 86400000;
    const dropMs = (s.profileDropDays ?? 60) * 86400000;
    let changed = 0;
    for (const b of Object.values(profileStore)) {
      if (!Array.isArray(b?.facts)) continue;
      for (const f of b.facts) {
        if (f.status === 'dropped') continue;
        const age = now - Number(f.lastConfirmedAt || f.createdAt || now);
        const next = age > dropMs ? 'dropped' : age > staleMs ? 'stale' : 'active';
        if (next !== f.status) { f.status = next; changed += 1; }
      }
    }
    if (changed) save('profile');
    return { changed };
  }

  function profileLine(key) {
    const b = profileStore[key];
    if (!b || !Array.isArray(b.facts)) return '';
    const alive = b.facts.filter((f) => f.status !== 'dropped').slice(-12);
    if (!alive.length) return '';
    const lines = alive.map((f) => {
      const days = Math.max(0, Math.round((Date.now() - Number(f.lastConfirmedAt || f.createdAt)) / 86400000));
      if (f.status === 'stale') return `- ${f.text}（好像还是这样，${days} 天没提了）`;
      return `- ${f.text}${days > 3 ? `（${days} 天前确认过）` : ''}`;
    });
    return `【我对他的长期认识】\n${lines.join('\n')}`;
  }

  function profileList(key) {
    const b = profileStore[key];
    return b && Array.isArray(b.facts) ? b.facts.filter((f) => f.status !== 'dropped') : [];
  }

  return {
    diaryAdd,
    diarySearch,
    diarySweep,
    diaryBrief,
    heartGet,
    heartUpdate,
    heartLine,
    promiseAdd,
    promiseDone,
    promiseDue,
    promiseDueUnnotified,
    promiseMarkNotified,
    promiseOpen,
    promiseLine,
    scheduleAdd,
    scheduleList,
    scheduleUpdate,
    scheduleFuzz,
    scheduleDrop,
    schedulePromote,
    scheduleLine,
    profileSet,
    profileConfirm,
    profileDrop,
    profileSweep,
    profileLine,
    profileList,
    wakeBrief,
    paths: { diary: DIARY_FILE, heart: HEART_FILE, promises: PROMISE_FILE, schedule: SCHEDULE_FILE, profile: PROFILE_FILE }
  };
}
