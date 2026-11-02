// 记忆插件（P1 JSON 后端）的单元测试。
// 跑法：node scripts/test-memory.mjs
//
// 覆盖：分词/BM25、双指数遗忘曲线、记忆权重 w 的单调性与分档、salience 编码阈值、
// 事件落盘与重载、cue 检索、人设锚抽取、social-v2 迁移幂等、清理与重置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tokenize, jaccard, bm25Scores } from '../src/memory/tokenize.js';
import { retention, computeW, wTier, DEFAULT_FORGETTING } from '../src/memory/weights.js';
import { salienceBreakdown, isAddressedToBot, isSelfEventWorthKeeping } from '../src/memory/encoder.js';
import { buildAnchor, ANCHOR_VERSION } from '../src/memory/anchor.js';
import { createMemoryPlugin } from '../src/memory/index.js';
import { selectRoleText } from '../src/role-card.js';

const DAY = 24 * 60 * 60 * 1000;
let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
    console.error(`❌ ${name}\n   ${error?.stack ?? error}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-test-'));
}

function msg(overrides = {}) {
  const now = overrides.time ?? Date.now();
  return {
    seq: 1,
    sender: '阿草',
    userId: '10001',
    text: '',
    plain: '',
    isOwner: false,
    isSelf: false,
    quoteTargetIsSelf: false,
    time: now,
    ...overrides,
  };
}

// ── 分词 / BM25 ────────────────────────────────────────────────────────────
test('tokenize：中文 2-gram，能切出“吉他”', () => {
  const tokens = tokenize('今天学了吉他');
  assert.ok(tokens.includes('吉他'), `tokens=${tokens.join(',')}`);
  assert.ok(tokens.includes('今天'));
});

test('tokenize：英文小写化', () => {
  assert.ok(tokenize('DeepSeek 真强').includes('deepseek'));
});

test('jaccard：同一句为 1，无关句 < 0.2', () => {
  assert.equal(jaccard('今天学了吉他', '今天学了吉他'), 1);
  assert.ok(jaccard('今天学了吉他', '明天要下雨') < 0.2);
});

test('bm25：cue 命中含关键词的文档并排第一', () => {
  const docs = [
    { text: '今天学了吉他' },
    { text: '明天要下雨' },
    { text: '吉他弦断了' },
  ];
  const hits = bm25Scores(docs, '吉他', (d) => d.text);
  assert.ok(hits.length >= 2, `hits=${JSON.stringify(hits)}`);
  assert.ok(hits[0].item.text.includes('吉他'));
  assert.ok(hits[0].score > 0);
});

// ── 遗忘曲线 ───────────────────────────────────────────────────────────────
test('retention：0 时保留率 = 1，随时间单调下降', () => {
  const item = { importance: 0.5 };
  assert.ok(Math.abs(retention(0, item) - 1) < 1e-9);
  const r1 = retention(DAY, item);
  const r7 = retention(7 * DAY, item);
  const r30 = retention(30 * DAY, item);
  assert.ok(r1 > r7 && r7 > r30, `${r1} ${r7} ${r30}`);
});

test('retention：importance 越高衰减越慢', () => {
  const age = 7 * DAY;
  assert.ok(retention(age, { importance: 0.8 }) > retention(age, { importance: 0.3 }));
});

test('retention：反复提取（accessCount）减缓衰减', () => {
  const age = 14 * DAY;
  assert.ok(retention(age, { importance: 0.5, accessCount: 10 }) > retention(age, { importance: 0.5, accessCount: 0 }));
});

// ── 记忆权重 ───────────────────────────────────────────────────────────────
test('computeW：owner 的承诺 > 群友声称的普通事件', () => {
  const now = Date.now();
  const strong = computeW({ t: now, importance: 1, confidence: 0.9, source: 'owner', kind: 'promise', accessCount: 5 }, { now, profile: { isOwner: true, count: 20 } });
  const weak = computeW({ t: now, importance: 0.5, confidence: 0.5, source: 'group-claimed', kind: 'event', accessCount: 0 }, { now });
  assert.ok(strong > weak, `strong=${strong} weak=${weak}`);
  assert.equal(wTier(strong), 'strong');
  assert.ok(['inject', 'weak'].includes(wTier(weak)));
});

test('computeW：越久权重越低，且落在 [0,1]', () => {
  const now = Date.now();
  const fresh = computeW({ t: now, importance: 0.5, source: 'ai-observed', kind: 'event' }, { now });
  const old = computeW({ t: now - 30 * DAY, importance: 0.5, source: 'ai-observed', kind: 'event' }, { now });
  assert.ok(fresh > old, `fresh=${fresh} old=${old}`);
  assert.ok(fresh <= 1 && old >= 0);
  assert.equal(wTier(0.1), 'off');
  assert.equal(wTier(0.4), 'inject');
});

// ── 编码（salience）────────────────────────────────────────────────────────
test('salience：直接对你说的话 > 普通闲聊', () => {
  const now = Date.now();
  const addressed = salienceBreakdown(msg({ plain: '小鲸鱼你在吗', quoteTargetIsSelf: true }), { now });
  const chatter = salienceBreakdown(msg({ plain: '嗯' }), { now });
  assert.ok(addressed.score > chatter.score, `addressed=${addressed.score} chatter=${chatter.score}`);
  assert.equal(isAddressedToBot({ plain: 'D指导好' }), true);
  assert.equal(isAddressedToBot({ plain: '今天吃啥' }), false);
});

// ── 插件端到端 ─────────────────────────────────────────────────────────────
test('插件：编码→重载→cue 检索→注入块', () => {
  const dir = tmpDir();
  const clock = { v: Date.parse('2026-10-28T20:00:00+08:00') };
  const plugin = createMemoryPlugin({ stateDir: dir, config: { recentDays: 7 }, now: () => clock.v });

  const first = plugin.encode('group:100', msg({ seq: 1, plain: '小鲸鱼你在吗，今天学了吉他手好疼', text: '小鲸鱼你在吗，今天学了吉他手好疼', time: clock.v }));
  assert.equal(first.stored, true, `salience=${first.salience}`);
  clock.v += 60_000;
  plugin.encode('group:100', msg({ seq: 2, plain: '嗯', text: '嗯', time: clock.v }));
  clock.v += 60_000;
  plugin.encode('group:100', msg({ seq: 3, sender: '小满', userId: '10002', plain: '明天要下雨', text: '明天要下雨', time: clock.v }));

  const stats = plugin.stats('group:100');
  assert.ok(stats.events >= 1, JSON.stringify(stats));
  assert.ok(stats.profiles >= 1);
  // Windows 上冒号不能做文件名，目录名必须是 group-100
  assert.ok(fs.existsSync(path.join(dir, 'group-100')), '目录名未做冒号转义');

  // 重新建实例：从磁盘恢复
  const reloaded = createMemoryPlugin({ stateDir: dir, config: { recentDays: 7 }, now: () => clock.v });
  const block = reloaded.render('group:100', { cue: '吉他', budgetChars: 800 });
  assert.ok(block.includes('吉他'), `block=${block}`);
  assert.ok(block.includes('【最近的记忆】'), block);
  assert.ok(block.includes('阿草'), block);

  const hits = reloaded.query('group:100', '吉他', 3);
  assert.ok(hits.length >= 1 && hits[0].text.includes('吉他'), JSON.stringify(hits));

  plugin.reset('group:100');
  assert.equal(fs.existsSync(path.join(dir, 'group-100')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：低 salience 聊天不落盘（只更新画像）', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const res = plugin.encode('private:200', msg({ plain: '哦', text: '哦' }));
  assert.equal(res.stored, false, `salience=${res.salience}`);
  assert.equal(plugin.stats('private:200').events, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：owner 消息即使 salience 低也强制记住', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const res = plugin.encode('private:200', msg({ isOwner: true, sender: '老爹', plain: '嗯', text: '嗯' }));
  assert.equal(res.stored, true, `salience=${res.salience}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：清理会丢掉超过保留期的事件', () => {
  const dir = tmpDir();
  const clock = { v: Date.parse('2026-10-28T20:00:00+08:00') };
  const plugin = createMemoryPlugin({
    stateDir: dir,
    config: { forgetting: { eventMaxDays: 0.01 } }, // ≈14.4 分钟
    now: () => clock.v,
  });
  plugin.encode('group:300', msg({ plain: '小鲸鱼你在吗', quoteTargetIsSelf: true, time: clock.v }));
  assert.equal(plugin.stats('group:300').events, 1);
  clock.v += 60 * 60 * 1000; // 1 小时后
  plugin.checkpoint('group:300');
  assert.equal(plugin.stats('group:300').events, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：social-v2 迁移幂等，画像带上旧印象', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const socialSt = {
    memberImpressions: { 阿草: { traits: ['弹吉他'], interactionCount: 6, lastSeenAt: clock.v - 3600_000 } },
    activeTopics: [{ text: '吉他课', lastMentionAt: clock.v - 7200_000 }],
  };
  assert.equal(plugin.migrateFromSocialV2('group:400', socialSt), true);
  assert.equal(plugin.migrateFromSocialV2('group:400', socialSt), false);
  const st = plugin.stateFor('group:400');
  assert.equal(st.profiles['阿草'].count, 6);
  assert.ok(st.events.some((ev) => ev.text.includes('吉他课')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 人设锚 ────────────────────────────────────────────────────────────────
test('buildAnchor：从真实人格卡抽 ≤400 字的人设锚', () => {
  // 不同分支的人格卡文件名不同（小鲸鱼-改.md 不一定入库），能读哪张读哪张。
  const candidates = ['../roles/小鲸鱼-改.md', '../roles/小鲸鱼.md'];
  const roleUrl = candidates.map((p) => new URL(p, import.meta.url)).find((u) => fs.existsSync(u));
  assert.ok(roleUrl, '找不到可测的人格卡');
  const roleText = fs.readFileSync(roleUrl, 'utf8');
  // 低耦合后 buildAnchor 只收"选好模式的文本"；选模式是 bridge 的职责，测试里显式做一次。
  const anchor = buildAnchor(selectRoleText(roleText, 'v2'), { maxChars: 400 });
  assert.ok(anchor.length > 0, 'anchor 为空');
  assert.ok(anchor.length <= 400, `len=${anchor.length}`);
  assert.ok(/小鲸鱼|DeepSeek/.test(anchor), anchor);
  // 老爹专属（只对 owner 生效）不能进常驻锚
  assert.ok(!anchor.includes('老爹专属'), anchor);
});

test('插件：renderAnchor 按角色卡 stamp 失效缓存', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  let role = { name: '测试角色', stamp: 'a:1:100', text: '## 一、你是谁\n你是一只会吐槽的鲸鱼，嘴硬心软。\n\n## 三、说话方式\n- 短句，别写小作文。\n- 少用客服腔。\n' };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v, getRoleInfo: () => role });
  const a1 = plugin.renderAnchor('private:500');
  assert.ok(a1.includes('鲸鱼'), a1);
  assert.ok(a1.length <= 400);
  // stamp 没变：命中缓存（返回同样的文本）
  assert.equal(plugin.renderAnchor('private:500'), a1);
  // stamp 变化：重算
  role = { name: '测试角色', stamp: 'a:2:120', text: '## 一、你是谁\n你是一只会睡觉的猫。\n' };
  const a2 = plugin.renderAnchor('private:500');
  assert.notEqual(a2, a1);
  assert.ok(a2.includes('猫'), a2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 控制台接口依赖的插件能力 ──────────────────────────────────────────────
test('插件：运行期开关 setEnabled 立即生效（不重启）', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: { enabled: true }, now: () => clock.v });
  assert.equal(plugin.enabled, true);
  const on = plugin.encode('group:600', msg({ plain: '小鲸鱼你在吗', quoteTargetIsSelf: true, time: clock.v }));
  assert.equal(on.stored, true);
  plugin.setEnabled(false);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.render('group:600', { cue: '小鲸鱼' }), '');
  assert.equal(plugin.encode('group:600', msg({ plain: '小鲸鱼！', quoteTargetIsSelf: true })).stored, false);
  plugin.setEnabled(true);
  assert.equal(plugin.enabled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：updateConfig 热更新预算与人设锚上限', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const applied = plugin.updateConfig({ budgetChars: 300, anchorMaxChars: 150 });
  assert.equal(applied.budgetChars, 300);
  assert.equal(applied.anchorMaxChars, 150);
  assert.equal(plugin.config.budgetChars, 300);
  // 越界值被夹回合法区间
  const clamped = plugin.updateConfig({ budgetChars: 99999 });
  assert.equal(clamped.budgetChars, 6000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('插件：overview 汇总多会话并保留原始 key，resetAll 清空', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  plugin.encode('group:700', msg({ sender: '阿草', userId: '7001', plain: '小鲸鱼你在吗', quoteTargetIsSelf: true, time: clock.v }));
  plugin.encode('private:800', msg({ sender: '小满', userId: '8001', isOwner: true, plain: '在吗', time: clock.v }));

  const view = plugin.overview();
  assert.equal(view.totals.sessions, 2, JSON.stringify(view));
  assert.ok(view.totals.events >= 2, JSON.stringify(view));
  assert.ok(view.totals.profiles >= 2, JSON.stringify(view));
  const keys = view.sessions.map((s) => s.key).sort();
  assert.deepEqual(keys, ['group:700', 'private:800'], JSON.stringify(view.sessions));
  assert.ok(view.sessions.every((s) => s.events >= 1));

  const cleared = plugin.resetAll();
  assert.equal(cleared, 2);
  assert.equal(plugin.overview().totals.sessions, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('控制台页面：已挂载记忆页与开关（静态检查）', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  for (const needle of ['section-memory', 'data-view="memory"', 'id="memEnabled"', 'id="memBudgetChars"', 'id="memResetAll"', "loadMemory()"]) {
    assert.ok(html.includes(needle), `控制台缺少 ${needle}`);
  }
  assert.ok(html.includes("memory: ['记忆'"), 'consolePages 缺少 memory 条目');
});

test('自己发言：只留信息量够的，语气词不进事件流', () => {
  assert.equal(isSelfEventWorthKeeping('草'), false);
  assert.equal(isSelfEventWorthKeeping('？'), false);
  assert.equal(isSelfEventWorthKeeping('哈哈'), false);
  assert.equal(isSelfEventWorthKeeping('好好好'), false);
  // 约定/提醒类：短也要留（以后要兑现）
  assert.equal(isSelfEventWorthKeeping('说好明天给你带'), true);
  assert.equal(isSelfEventWorthKeeping('记得吃药'), true);
  // 提问：够长就留
  assert.equal(isSelfEventWorthKeeping('你那个吉他练得怎么样了？'), true);
  // 够长的一般叙述：留
  assert.equal(isSelfEventWorthKeeping('我刚刚看到个挺离谱的新闻'), true);

  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const kept = plugin.encodeSelf('group:900', ['草', '？', '哈哈', '说好明天给你带', '我刚刚看到个挺离谱的新闻']);
  assert.equal(kept, 2, '应只留下约定与长句两条');
  const texts = plugin.stateFor('group:900').events.map((ev) => ev.text);
  assert.deepEqual(texts, ['说好明天给你带', '我刚刚看到个挺离谱的新闻']);
  assert.ok(plugin.stateFor('group:900').events.every((ev) => ev.importance === 0.4), '自我事件重要度应为 0.4');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('人设锚：不出现「。；」双标点，且缓存带算法版本', () => {
  // 与上一个锚测试一样：不同分支的人格卡文件名不同，能读哪张读哪张。
  const candidates = ['../roles/小鲸鱼-改.md', '../roles/小鲸鱼.md'];
  const roleUrl = candidates.map((p) => new URL(p, import.meta.url)).find((u) => fs.existsSync(u));
  assert.ok(roleUrl, '找不到可测的人格卡');
  const roleText = fs.readFileSync(roleUrl, 'utf8');
  const anchor = buildAnchor(selectRoleText(roleText, 'v2'), { maxChars: 400 });
  assert.ok(!anchor.includes('。；'), `锚里有双标点：${anchor}`);
  assert.ok(!/；$/.test(anchor), `锚以分号结尾：${anchor}`);
  assert.equal(ANCHOR_VERSION, 2);

  // 算法版本变化必须让缓存的 anchor.json 失效（否则改了文案也刷不出来）
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const role = { name: '测试角色', stamp: 'a:1:100', text: '## 一、你是谁\n你是一只会吐槽的鲸鱼。\n' };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v, getRoleInfo: () => role });
  plugin.renderAnchor('private:901');
  const cached = JSON.parse(fs.readFileSync(path.join(dir, 'private-901', 'anchor.json'), 'utf8'));
  assert.ok(String(cached.stamp).includes(`:a${ANCHOR_VERSION}`), `缓存 stamp 缺版本号：${cached.stamp}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('历史脏画像「私聊」在加载时被清掉', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  // 先按老格式写一份 profiles.json（旧版本把私聊发送者写成字面量「私聊」）
  const keyDir = path.join(dir, 'private-777');
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, 'profiles.json'), JSON.stringify({
    '私聊': { name: '私聊', count: 42, lastSeen: clock.v, lastText: 'hello' },
    '未知': { name: '未知', count: 1, lastSeen: clock.v },
    '真·群友': { name: '真·群友', count: 5, lastSeen: clock.v, lastText: '在吗' },
  }), 'utf8');

  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const names = Object.keys(plugin.stateFor('private:777').profiles).sort();
  assert.deepEqual(names, ['真·群友'], `脏画像未清理：${names.join(',')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const { name, error } of failures) console.error(`\nFAILED: ${name}\n${error?.stack ?? error}`);
  process.exit(1);
}
