// 跨会话「世界记忆」：把 QQ 私聊与群聊里的事实/人物/房间/日记收在一个共享目录里，
// 由桥接在每次唤醒前按「隐私规则」组装成 prompt 片段。
//
// 为什么不在 DSH 侧做：DSH 的插件只能看到单个 session 的事件，看不到 QQ 流量，
// 而桥接天然能看到全部入站/出站消息。人格卡已经是全局的（roles/<角色>.md），
// 缺的只是「知识」的全局层——就是本模块。
//
// 四层作用域（与 README 的设计一致）：
//   soul   我是谁        —— 唯一一份，所有会话注入同一段文本
//   people 我认识谁      —— 按 QQ 号，跨群/私聊共享（昵称只是别名）
//   rooms  这是哪儿      —— 按会话 key，只在该房间注入
//   session 现在聊什么   —— 仍由 social-v2.json 的 activeTopics/pendingThoughts 承担
//
// 隐私规则（由使用者确认）：
//   1) 私聊内容永远不进群：origin 以 `private:` 开头的事实/备注，在群聊里一律不注入。
//   2) 群 → 群：只在当事人也在场时注入，并标注来源；不做「别人的群事」的二次传播。
//   3) 群 → 私聊：允许（当事人自己的私聊里可以提他自己在群里说过的话），但仍是
//      「只在和这个人有关时」才注入，且保留来源标记。
//   4) 日记默认只在与主人的私聊里注入（diary.inject = owner），避免把私聊细节带进群。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BUDGET = Object.freeze({ soul: 600, people: 520, room: 260, diary: 300 });

/** 本地时区的日期键：YYYY-MM-DD。传入已有的日期字符串时原样返回。 */
export function dayKey(ts = Date.now()) {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts.trim())) return ts.trim();
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把任意文本压成单行，去掉控制字符并截断。 */
export function oneLine(value, max = 200) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** 超预算时按行裁剪（优先保留前面的高优先级行）。 */
export function clampLines(lines, maxChars) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (!line) continue;
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

function normalizeKey(key) {
  return String(key ?? '').trim();
}

function keyKind(key) {
  if (key.startsWith('private:')) return { type: 'private', id: key.slice('private:'.length) };
  if (key.startsWith('group:')) return { type: 'group', id: key.slice('group:'.length) };
  return { type: 'unknown', id: key };
}

function originLabel(origin) {
  const kind = keyKind(origin);
  if (kind.type === 'group') return `群${kind.id}`;
  if (kind.type === 'private') return '私聊';
  return '记录';
}

/**
 * 创建/加载一个记忆世界。
 * @param {{dir:string, log?:(...a:any[])=>void, now?:()=>number}} options
 */
export function createMemoryWorld({ dir, log = () => {}, now = () => Date.now() } = {}) {
  if (!dir) throw new Error('memory-world: 缺少 dir');
  const paths = {
    root: dir,
    people: path.join(dir, 'people.json'),
    rooms: path.join(dir, 'rooms.json'),
    soul: path.join(dir, 'soul.md'),
    logDir: path.join(dir, 'log'),
    diaryDir: path.join(dir, 'diary')
  };

  let cache = null;

  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(paths.logDir, { recursive: true });
    fs.mkdirSync(paths.diaryDir, { recursive: true });
  }

  function readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function load({ force = false } = {}) {
    if (cache && !force) return cache;
    ensureDirs();
    const people = readJson(paths.people, {}) || {};
    const rooms = readJson(paths.rooms, {}) || {};
    let soul = '';
    try { soul = fs.readFileSync(paths.soul, 'utf8'); } catch {}
    cache = { people, rooms, soul };
    return cache;
  }

  function savePeople() { load(); writeJson(paths.people, cache.people); }
  function saveRooms() { load(); writeJson(paths.rooms, cache.rooms); }

  // ── soul ────────────────────────────────────────────────────────────────
  function getSoul() {
    load();
    return cache.soul || '';
  }

  function setSoul(text) {
    ensureDirs();
    const value = String(text ?? '');
    load();
    cache.soul = value;
    fs.writeFileSync(paths.soul, value, 'utf8');
  }

  // ── people ──────────────────────────────────────────────────────────────
  function personRecord(qq) {
    load();
    const id = String(qq ?? '').trim();
    if (!/^\d{3,}$/.test(id)) return null;
    if (!cache.people[id]) {
      cache.people[id] = { qq: id, names: {}, facts: [], lastSeen: 0, rooms: {}, createdAt: now() };
    }
    return cache.people[id];
  }

  /** 记录一次互动：更新别名、最后出现时间、出现过的房间。 */
  function touchPerson({ qq, name, key, ts = now() } = {}) {
    const rec = personRecord(qq);
    if (!rec) return null;
    const alias = oneLine(name, 24);
    if (alias) rec.names[alias] = (Number(rec.names[alias]) || 0) + 1;
    // 旧版只有昵称的占位档案：一旦拿到真实 QQ 号就并进来，别让人分裂成两个。
    if (alias) {
      const placeholderKey = `alias:${alias}`;
      const placeholder = cache.people[placeholderKey];
      if (placeholder && placeholder.placeholder) {
        for (const f of placeholder.facts || []) {
          if (!rec.facts.some((x) => String(x.text || '') === String(f.text || ''))) rec.facts.push(f);
        }
        for (const [room, count] of Object.entries(placeholder.rooms || {})) {
          rec.rooms[room] = (Number(rec.rooms[room]) || 0) + (Number(count) || 0);
        }
        delete cache.people[placeholderKey];
      }
    }
    rec.lastSeen = Math.max(Number(rec.lastSeen) || 0, Number(ts) || now());
    const k = normalizeKey(key);
    if (k) rec.rooms[k] = (Number(rec.rooms[k]) || 0) + 1;
    savePeople();
    return rec;
  }

  /** 写入一条关于某人的事实（按文本去重；重复只刷新时间与来源）。 */
  function addFact({ qq, name, text, kind = 'fact', origin = '', ts = now() } = {}) {
    const rec = personRecord(qq);
    const body = oneLine(text, 160);
    if (!rec || !body) return { ok: false, reason: 'bad-args' };
    if (name) {
      const alias = oneLine(name, 24);
      if (alias) rec.names[alias] = (Number(rec.names[alias]) || 0) + 1;
    }
    const norm = body.toLowerCase();
    const existing = rec.facts.find((f) => String(f.text || '').toLowerCase() === norm);
    if (existing) {
      existing.at = ts;
      if (origin) existing.origin = origin;
      existing.hits = (Number(existing.hits) || 1) + 1;
      savePeople();
      return { ok: true, duplicate: true, fact: existing };
    }
    const fact = { text: body, kind: oneLine(kind, 16) || 'fact', origin: normalizeKey(origin), at: ts, hits: 1 };
    rec.facts.push(fact);
    // 有界：每人最多 40 条，丢最久没被提到的。
    if (rec.facts.length > 40) {
      rec.facts.sort((a, b) => Number(b.at || 0) - Number(a.at || 0) || Number(b.hits || 0) - Number(a.hits || 0));
      rec.facts.length = 40;
    }
    rec.lastSeen = Math.max(Number(rec.lastSeen) || 0, Number(ts) || now());
    savePeople();
    return { ok: true, duplicate: false, fact };
  }

  function getPeople() {
    load();
    return cache.people;
  }

  function getPerson(qq) {
    load();
    return cache.people[String(qq ?? '').trim()] || null;
  }

  /** 把旧版按会话存的 memberImpressions 合并进全局 people（按名字登记为别名）。 */
  function mergeLegacyImpressions({ key, impressions = {} } = {}) {
    load();
    let merged = 0;
    for (const [name, im] of Object.entries(impressions || {})) {
      const traits = Array.isArray(im?.traits) ? im.traits : [];
      if (!traits.length) continue;
      // 旧数据可能只有昵称；如果昵称写成「小鲸鱼(3404946607)」这种带 QQ 号的形式，
      // 直接落到真实 QQ 号下，避免以后同一个人在两个档案里分裂。
      const parsed = /^(.*?)[（(](\d{5,})[)）]\s*$/.exec(String(name));
      const aliasName = oneLine(parsed ? parsed[1] : name, 24);
      const qq = parsed ? parsed[2] : `alias:${aliasName}`;
      if (!cache.people[qq]) {
        cache.people[qq] = { qq, names: {}, facts: [], lastSeen: 0, rooms: {}, createdAt: now(), placeholder: !parsed };
      }
      const rec = cache.people[qq];
      if (aliasName) rec.names[aliasName] = (Number(rec.names[aliasName]) || 0) + 1;
      for (const t of traits) {
        const body = oneLine(t, 120);
        if (!body) continue;
        if (rec.facts.some((f) => String(f.text || '') === body)) continue;
        rec.facts.push({ text: body, kind: 'impression', origin: normalizeKey(key), at: now(), hits: 1 });
        merged += 1;
      }
      rec.rooms[normalizeKey(key)] = (Number(rec.rooms[normalizeKey(key)]) || 0) + 1;
    }
    if (merged) savePeople();
    return merged;
  }

  // ── rooms ───────────────────────────────────────────────────────────────
  function roomRecord(key) {
    load();
    const k = normalizeKey(key);
    if (!k) return null;
    if (!cache.rooms[k]) cache.rooms[k] = { key: k, notes: [], lastActive: 0, count: 0, createdAt: now() };
    return cache.rooms[k];
  }

  function touchRoom({ key, ts = now() } = {}) {
    const rec = roomRecord(key);
    if (!rec) return null;
    rec.lastActive = Math.max(Number(rec.lastActive) || 0, Number(ts) || now());
    rec.count = (Number(rec.count) || 0) + 1;
    saveRooms();
    return rec;
  }

  function addRoomNote({ key, text, origin = '', ts = now() } = {}) {
    const rec = roomRecord(key);
    const body = oneLine(text, 160);
    if (!rec || !body) return { ok: false, reason: 'bad-args' };
    const existing = rec.notes.find((n) => String(n.text || '') === body);
    if (existing) {
      existing.at = ts;
      existing.hits = (Number(existing.hits) || 1) + 1;
      saveRooms();
      return { ok: true, duplicate: true };
    }
    rec.notes.push({ text: body, origin: normalizeKey(origin) || normalizeKey(key), at: ts, hits: 1 });
    if (rec.notes.length > 30) rec.notes.splice(0, rec.notes.length - 30);
    saveRooms();
    return { ok: true, duplicate: false };
  }

  function getRooms() {
    load();
    return cache.rooms;
  }

  // ── 消息日志（跨会话） ─────────────────────────────────────────────────
  function logFile(day) {
    return path.join(paths.logDir, `${day}.jsonl`);
  }

  /** 追加一条消息到跨会话日志；同一毫秒/同文本去重，避免重连时重复写。 */
  function recordMessage({ key, sender, qq, text, isSelf = false, ts = now() } = {}) {
    const body = oneLine(text, 300);
    if (!body) return false;
    ensureDirs();
    const day = dayKey(ts);
    const line = JSON.stringify({
      t: Number(ts) || now(),
      k: normalizeKey(key),
      s: oneLine(sender, 40),
      q: qq != null ? String(qq) : '',
      x: body,
      me: !!isSelf
    });
    const file = logFile(day);
    let last = '';
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(2048, size));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      fs.closeSync(fd);
      last = buf.toString('utf8').split('\n').filter(Boolean).pop() || '';
    } catch {}
    if (last) {
      try {
        const prev = JSON.parse(last);
        if (prev.t === Number(ts) && prev.x === body && prev.k === normalizeKey(key)) return false;
      } catch {}
    }
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  }

  function readMessages(day) {
    const file = logFile(dayKey(day));
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item && item.x) out.push(item);
      } catch {}
    }
    return out;
  }

  function listDays() {
    ensureDirs();
    try {
      return fs.readdirSync(paths.logDir)
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .map((n) => n.slice(0, 10))
        .sort();
    } catch { return []; }
  }

  /** 只保留最近 N 天日志（默认 60 天）。 */
  function pruneLogs({ keepDays = 60 } = {}) {
    const days = listDays();
    const cutoff = dayKey(now() - Math.max(1, keepDays) * 86400000);
    let removed = 0;
    for (const day of days) {
      if (day >= cutoff) continue;
      try { fs.unlinkSync(logFile(day)); removed += 1; } catch {}
    }
    return removed;
  }

  // ── 日记 ────────────────────────────────────────────────────────────────
  function diaryFile(day) {
    return path.join(paths.diaryDir, `${day}.md`);
  }

  function readDiary(day) {
    try {
      const raw = fs.readFileSync(diaryFile(dayKey(day)), 'utf8');
      return raw.replace(/^#\s*\d{4}-\d{2}-\d{2}\s*\n+/, '').trim();
    } catch { return ''; }
  }

  function writeDiary(day, text, { meta = {} } = {}) {
    ensureDirs();
    const d = dayKey(day);
    const body = String(text ?? '').trim();
    if (!body) return false;
    const head = `# ${d}\n\n`;
    const suffix = meta && Object.keys(meta).length ? `\n<!-- ${JSON.stringify(meta)} -->\n` : '\n';
    fs.writeFileSync(diaryFile(d), `${head}${body}${suffix}`, 'utf8');
    return true;
  }

  function listDiary({ limit = 7 } = {}) {
    ensureDirs();
    let names = [];
    try { names = fs.readdirSync(paths.diaryDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)); } catch {}
    return names.map((n) => n.slice(0, 10)).sort().slice(-Math.max(1, limit));
  }

  function recentDiary({ days = 3 } = {}) {
    return listDiary({ limit: days })
      .map((day) => ({ day, text: readDiary(day) }))
      .filter((d) => d.text);
  }

  // ── 注入组装 ────────────────────────────────────────────────────────────
  /**
   * 组装唤醒 prompt 的世界记忆块。
   * @param {{key:string, speakers?:Array<{qq?:string,name?:string}>, sessionText?:string,
   *          ownerQQ?:string, diaryInject?:'owner'|'private'|'all'|'off', diaryDays?:number,
   *          budget?:object}} options
   */
  function compose({
    key,
    speakers = [],
    sessionText = '',
    ownerQQ = '',
    diaryInject = 'owner',
    diaryDays = 3,
    budget = {}
  } = {}) {
    load();
    const b = { ...DEFAULT_BUDGET, ...(budget || {}) };
    const audience = keyKind(normalizeKey(key));
    const sections = [];

    const soul = clampLines(String(getSoul() || '').split('\n'), b.soul).trim();
    if (soul) sections.push(`【我是谁】\n${soul}`);

    // people：只注入本会话当前在场的人；群聊里过滤掉所有私聊来源。
    const present = new Map();
    for (const sp of speakers || []) {
      const qq = String(sp?.qq ?? '').trim();
      if (qq) present.set(qq, oneLine(sp?.name, 24) || present.get(qq) || '');
    }
    const peopleLines = [];
    for (const [qq, name] of present) {
      const rec = getPerson(qq);
      if (!rec) continue;
      const alias = name || Object.keys(rec.names || {}).sort((a, c) => (rec.names[c] || 0) - (rec.names[a] || 0))[0] || qq;
      const facts = [];
      for (const f of rec.facts || []) {
        const origin = String(f.origin || '');
        if (audience.type === 'group') {
          // 隐私规则 1+2：私聊来源一律不进群；别的群的事实只带来源提示。
          if (origin.startsWith('private:')) continue;
          const src = origin && origin !== normalizeKey(key) ? `（来源：${originLabel(origin)}）` : '';
          facts.push(`${f.text}${src}`);
        } else if (audience.type === 'private') {
          // 隐私规则 3：私聊里只提这个人自己的事；别的私聊来源不进来。
          if (origin.startsWith('private:') && origin !== normalizeKey(key)) continue;
          const src = origin.startsWith('group:') ? `（来源：${originLabel(origin)}）` : '';
          facts.push(`${f.text}${src}`);
        }
      }
      if (facts.length) peopleLines.push(`- ${alias}（QQ ${qq}）：${facts.slice(-6).join('；')}`);
    }
    if (peopleLines.length) sections.push(`【我认识的人】\n${clampLines(peopleLines, b.people)}`);

    // rooms：只注入当前房间。
    const room = getRooms()[normalizeKey(key)];
    if (room && Array.isArray(room.notes) && room.notes.length) {
      const lines = room.notes.slice(-8).map((n) => `- ${n.text}`);
      const text = clampLines(lines, b.room);
      if (text) sections.push(`【${audience.type === 'private' ? '这个私聊' : '这个群'}】\n${text}`);
    }

    // diary：默认只在与主人的私聊里注入。
    const diaryVisible = diaryInject === 'all'
      || (diaryInject === 'private' && audience.type === 'private')
      || (diaryInject === 'owner' && audience.type === 'private' && String(ownerQQ) && audience.id === String(ownerQQ));
    if (diaryVisible) {
      const entries = recentDiary({ days: diaryDays });
      const lines = entries.map((e) => `- ${e.day.slice(5)}：${oneLine(e.text, 120)}`);
      if (lines.length) sections.push(`【最近的日记】\n${clampLines(lines, b.diary)}`);
    }

    if (sessionText && String(sessionText).trim()) sections.push(String(sessionText).trim());
    return sections.join('\n\n');
  }

  function stats() {
    load();
    return {
      dir,
      people: Object.keys(cache.people).length,
      rooms: Object.keys(cache.rooms).length,
      facts: Object.values(cache.people).reduce((n, p) => n + (Array.isArray(p.facts) ? p.facts.length : 0), 0),
      days: listDays().length,
      diary: listDiary({ limit: 999 }).length,
      soulChars: String(cache.soul || '').length
    };
  }

  ensureDirs();
  return {
    dir,
    paths,
    load,
    getSoul,
    setSoul,
    getPeople,
    getPerson,
    touchPerson,
    addFact,
    mergeLegacyImpressions,
    getRooms,
    touchRoom,
    addRoomNote,
    recordMessage,
    readMessages,
    listDays,
    pruneLogs,
    readDiary,
    writeDiary,
    listDiary,
    recentDiary,
    compose,
    stats
  };
}

/**
 * 把一天的消息数组按房间压成一份摘要（纯函数，便于单测）。
 * @param {Array<{k?:string,s?:string,x?:string,me?:boolean,t?:number}>} items
 */
export function buildDiaryTranscript(items, { budget = 6000, perRoom = 14 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const byRoom = new Map();
  for (const it of list) {
    if (!it || !it.x) continue;
    const k = String(it.k || '');
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(it);
  }
  const lines = [];
  let left = budget;
  for (const [k, roomItems] of byRoom) {
    const label = k.startsWith('private:') ? '私聊' : (k.startsWith('group:') ? `群 ${k.slice('group:'.length)}` : k);
    lines.push(`【${label}】`);
    left -= label.length + 3;
    let used = 0;
    for (const it of roomItems) {
      if (used >= perRoom || left <= 0) break;
      const who = it.me ? '我' : (it.s || '某人');
      const body = oneLine(it.x, 120);
      if (!body) continue;
      const line = `${who}：${body}`;
      if (line.length > left) break;
      lines.push(line);
      left -= line.length + 1;
      used += 1;
    }
    if (roomItems.length > used) lines.push('（其余略）');
  }
  return lines.join('\n');
}

/** 日记 prompt（纯函数）。 */
export function buildDiaryPrompt(day, transcript) {
  return [
    '你是「大肥鱼」，DeepSeek 的鲸鱼形象，一个在 QQ 上和朋友聊天的女孩子。',
    `下面是 ${day} 这一天你在几个 QQ 群和私聊里看到/说过的消息（按房间分组）。`,
    '请用第一人称写一篇日记：只写今天真实发生的事和你的感受，约 100 字（80~130 字）。',
    '要求：纯文本一段话；不要标题、不要列表、不要 Markdown；不要称呼“用户”或“AI”；',
    '不要编造没发生的事；涉及私聊内容时用模糊说法，不要写出具体私聊原文；不要提“根据聊天记录”这类话。',
    '直接输出日记正文。',
    '',
    transcript
  ].join('\n');
}

/** 清理模型输出，得到一段可入库的日记正文（纯函数）。 */
export function cleanDiaryText(output, maxChars = 140) {
  let text = String(output ?? '').trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  text = text.replace(/^日记[：:]\s*/, '').replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return text;
}

