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
import { recallMemory, describeMemory } from '../src/memory/recall.js';
import { rebuildMemoryMarkdown, appendMemoryMarkdown, MEMORY_MD } from '../src/memory/markdown.js';
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
  // render 现在只给索引（不再把记忆正文塞进提示词）
  const block = reloaded.render('group:100');
  assert.ok(block.includes('【你的记忆】'), block);
  assert.ok(block.includes('qq_memory_recall'), block);
  assert.ok(block.length < 800, '索引应该很短：' + block.length);
  // 正文要能通过 recall 查到（recall 返回 fragments，每段含若干行）
  const recalled = reloaded.recall('group:100', '吉他');
  assert.ok(recalled.fragments.length >= 1, JSON.stringify(recalled));
  assert.ok(recalled.fragments.some((f) => f.lines.join('').includes('吉他')), JSON.stringify(recalled.fragments));

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

test('插件：updateConfig 热更新事件阈值/回看天数', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  const applied = plugin.updateConfig({ eventThreshold: 0.7, recentDays: 14 });
  assert.equal(applied.eventThreshold, 0.7);
  assert.equal(applied.recentDays, 14);
  assert.equal(plugin.config.eventThreshold, 0.7);
  // 越界值被夹回合法区间
  assert.equal(plugin.updateConfig({ eventThreshold: 5 }).eventThreshold, 1);
  assert.equal(plugin.updateConfig({ recentDays: 999 }).recentDays, 30);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('拟人记忆：recall 能按关键词翻出很久以前的细节', () => {
  const dir = tmpDir();
  const clock = { v: Date.parse('2026-11-02T20:00:00+08:00') };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  // 三个月前的摩天轮那件事
  const longAgo = clock.v - 90 * DAY;
  plugin.encode('private:600', msg({ seq: 1, sender: 'Phoeky', userId: '9', isOwner: true, time: longAgo, plain: '上周去坐了摩天轮，在上面吃了个冰淇淋' }));
  plugin.encode('private:600', msg({ seq: 2, sender: 'Phoeky', userId: '9', isOwner: true, time: longAgo + 60000, plain: '那个冰淇淋特别甜，草莓味的' }));
  // 最近一些无关的话
  plugin.encode('private:600', msg({ seq: 3, sender: 'Phoeky', userId: '9', isOwner: true, time: clock.v, plain: '今天天气不错' }));

  const hit = plugin.recall('private:600', '摩天轮');
  assert.ok(hit.fragments.length >= 1, `没召回：${JSON.stringify(hit)}`);
  // 关键：上下文扩展应把「冰淇淋特别甜」那条一起带出来
  const joined = hit.fragments.map((f) => f.lines.join('\n')).join('\n');
  assert.ok(joined.includes('冰淇淋'), `上下文没带出细节：${joined}`);
  const top = hit.fragments[0];
  assert.ok(top.date && top.age, '片段要带日期与相对时间');
  assert.ok(top.age.includes('个月'), `90 天前应显示为月：${top.age}`);

  // 换个说法也要能查到（BM25 2-gram + 关键词退化）
  const hit2 = plugin.recall('private:600', '摩天轮上吃的什么');
  assert.ok(hit2.fragments.map((f) => f.lines.join('')).join('').includes('冰淇淋'), JSON.stringify(hit2));

  // 完全无关的问题返回空（不许拿无关记忆硬凑，否则模型会以为"我记得"）
  const miss = plugin.recall('private:600', '量子力学');
  assert.deepEqual(miss.fragments, []);
  assert.equal(miss.mode, 'empty');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('拟人记忆：describe 只给索引（不含正文与本地路径）', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  plugin.encode('group:610', msg({ sender: '阿草', userId: '6101', plain: '小鲸鱼你在吗', quoteTargetIsSelf: true, time: clock.v }));
  const text = plugin.describe('group:610');
  assert.ok(text.includes('【你的记忆】'), text);
  assert.ok(text.includes('qq_memory_recall'), '索引里必须教模型去查：' + text);
  // 索引用"最近一条"的 ≤24 字引子当钩子（带省略号表示截断），但绝不能是完整正文，
  // 更不能出现本机路径——模型不需要知道文件系统，项目隐私基线也禁止。
  assert.ok(text.includes('小鲸鱼你在吗…'), '引子应带省略号表示截断：' + text);
  assert.ok(text.length < 700, '索引应该很短：' + text.length);  assert.ok(!/[A-Za-z]:\\/.test(text) && !text.includes('MEMORY.md'), '索引漏了本地路径：' + text);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆文件：encode 会写一份人类可读的 MEMORY.md', () => {
  const dir = tmpDir();
  const clock = { v: Date.parse('2026-11-02T20:00:00+08:00') };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  plugin.encode('group:620', msg({ sender: '阿草', userId: '6201', plain: '小鲸鱼你在吗，今天学了吉他', quoteTargetIsSelf: true, time: clock.v }));
  const md = plugin.readFile('group:620');
  assert.ok(md.includes('# 记忆'), md);
  assert.ok(md.includes('**阿草**'), md);
  assert.ok(md.includes('吉他'), md);
  assert.ok(/## \d{4}-\d{2}-\d{2}/.test(md), '应有按天分节：' + md);

  // 重建：从事件流还原正文
  const rebuilt = plugin.rebuildFile('group:620');
  assert.ok(rebuilt.entries >= 1);
  assert.ok(plugin.readFile('group:620').includes('吉他'));
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
  for (const needle of ['section-memory', 'data-view="memory"', 'id="memEnabled"', 'id="memReadFile"', 'id="memFileBody"', 'id="memResetAll"', "loadMemory()"]) {
    assert.ok(html.includes(needle), `控制台缺少 ${needle}`);
  }
  assert.ok(html.includes("memory: ['记忆'"), 'consolePages 缺少 memory 条目');
  // 预算/锚上限已移除（记忆正文改为 AI 主动查，不再靠注入长度调节）
  assert.ok(!html.includes('id="memBudgetChars"'), '不该再有注入预算输入框');
  assert.ok(!html.includes('id="memAnchorChars"'), '不该再有人设锚上限输入框');
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
  // 上限也必须进 stamp：否则控制台把 400 调到 800 后，缓存命中 → 长度永远不变（真踩过）
  assert.ok(String(cached.stamp).includes(':m400'), `缓存 stamp 缺 anchorMaxChars：${cached.stamp}`);

  // 调大上限后必须重算（用一张更长的卡验证长度确实变长）
  const longRole = {
    name: '测试角色',
    stamp: 'a:1:100',
    text: `## 一、你是谁\n${'你是一只会吐槽的鲸鱼，嘴硬心软，偶尔摆烂。'.repeat(8)}\n\n## 三、说话方式\n- 短句，别写小作文。\n- 少用客服腔。\n`,
  };
  const dir2 = tmpDir();
  const small = createMemoryPlugin({ stateDir: dir2, config: { anchorMaxChars: 200 }, now: () => clock.v, getRoleInfo: () => longRole });
  const smallAnchor = small.renderAnchor('private:902');
  const big = createMemoryPlugin({ stateDir: dir2, config: { anchorMaxChars: 900 }, now: () => clock.v, getRoleInfo: () => longRole });
  const bigAnchor = big.renderAnchor('private:902');
  assert.ok(bigAnchor.length > smallAnchor.length, `调大上限没生效：${smallAnchor.length} → ${bigAnchor.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
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

test('模型写记忆：save/forget + 长期短期 + 重要度', () => {
  const dir = tmpDir();
  const clock = { v: Date.parse('2026-11-02T20:00:00+08:00') };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });

  const long = plugin.saveMemory('private:900', { text: '老爹坐摩天轮时吃了草莓味冰淇淋，说很甜', scope: 'long', importance: 5, who: '老爹' });
  assert.equal(long.scope, 'long');
  assert.equal(long.importance, 5);
  assert.ok(long.id.startsWith('m'), JSON.stringify(long));

  const short = plugin.saveMemory('private:900', { text: '今天他说有点累', scope: 'short', importance: 2, who: '老爹' });
  assert.equal(short.scope, 'short');

  // MEMORY.md 分层：会话文件只放本会话分区（共享记忆在共享层文件里），带 ★
  const md = plugin.readFile('private:900');
  assert.ok(md.includes('## 本会话 · 长期记忆'), md);
  assert.ok(md.includes('## 本会话 · 短期记忆'), md);
  assert.ok(!md.includes('## 共享记忆'), '会话文件不该出现共享分区：' + md);
  assert.ok(md.includes('★★★★★'), '重要度应显示为星：' + md);
  assert.ok(md.indexOf('摩天轮') < md.indexOf('有点累'), '长期应排在短期前：' + md);

  // recall 优先命中模型写下的记忆（mode=memory）
  const r = plugin.recall('private:900', '摩天轮');
  assert.equal(r.mode, 'memory', JSON.stringify(r));
  assert.ok(r.fragments[0].lines.join('').includes('冰淇淋'), JSON.stringify(r.fragments));

  // 删除
  assert.equal(plugin.forgetMemoryById('private:900', long.id), true);
  assert.ok(!plugin.readFile('private:900').includes('摩天轮'), '删除后不该还在：' + plugin.readFile('private:900'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('遗忘策略：短期到期按重要度升长期或遗忘；长期陈旧压缩/遗忘', () => {
  const dir = tmpDir();
  let clock = { v: Date.parse('2026-09-01T12:00:00+08:00') };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });

  // 三条短期：重要(4)、一般(2)，外加长期：重要约定(5) 与 低重要度的旧事(2)
  plugin.saveMemory('group:910', { text: '阿草说她在学吉他，手指疼', scope: 'short', importance: 4, who: '阿草' });
  plugin.saveMemory('group:910', { text: '今天群里在聊外卖', scope: 'short', importance: 2 });
  plugin.saveMemory('group:910', { text: '很重要的约定：下周三给他带咖啡，要少糖', scope: 'long', importance: 5, who: '老爹' });
  plugin.saveMemory('group:910', { text: '以前聊过的那部番，具体剧情细节都记不清了只记得好看', scope: 'long', importance: 2 });

  // 推进 4 天（短期到期）
  clock.v += 4 * DAY;
  const r1 = plugin.runRetention('group:910');
  assert.equal(r1.promoted, 1, JSON.stringify(r1));   // 重要度 4 的升长期
  assert.equal(r1.forgot, 1, JSON.stringify(r1));     // 重要度 2 的短期遗忘
  const md1 = plugin.readFile('group:910');
  assert.ok(!md1.includes('外卖'), '不重要的短期应被遗忘：' + md1);
  assert.ok(md1.includes('吉他'), '重要的短期应升长期并保留：' + md1);

  // 再推进 120 天：长期里「重要度 <4」的陈旧条目会被压缩或遗忘；
  // 重要度 4/5 的（约定、重要经历）必须原样保留——压缩掉细节就失去价值了。
  clock.v += 120 * DAY;
  const r2 = plugin.runRetention('group:910');
  assert.ok(r2.compressed + r2.forgot >= 1, JSON.stringify(r2));
  const md2 = plugin.readFile('group:910');
  assert.ok(md2.includes('咖啡') && md2.includes('少糖'), '重要度 5 的约定不该被压缩/遗忘：' + md2);
  assert.ok(md2.includes('吉他'), '重要度 4 的长期记忆不该被压缩/遗忘：' + md2);
  assert.ok(!md2.includes('具体剧情细节'), '重要度 2 的陈旧长期记忆应被压缩：' + md2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('共享记忆：跨会话共享，本会话记忆不外泄', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });

  // 在 A 群写下「共享记忆」：关于阿草本人
  plugin.saveMemory('group:A', { text: '阿草在学吉他，说手指疼', scope: 'long', importance: 4, who: '阿草', layer: 'global' });
  // 在 A 群写下「本会话记忆」：只属于 A 群的
  plugin.saveMemory('group:A', { text: '本群周五要团建', scope: 'long', importance: 3, layer: 'session' });
  // 在 B 群写一条无关的
  plugin.saveMemory('group:B', { text: 'B 群在聊猫', scope: 'long', importance: 2, layer: 'session' });

  // B 群查「吉他」→ 应命中共享记忆（跨会话共享）
  const inB = plugin.recall('group:B', '吉他');
  assert.equal(inB.mode, 'memory', JSON.stringify(inB));
  assert.ok(inB.fragments[0].lines.join('').includes('[共享]'), JSON.stringify(inB.fragments));
  assert.ok(inB.fragments[0].lines.join('').includes('吉他'), JSON.stringify(inB.fragments));

  // B 群查「团建」→ 不该看到 A 群的本会话记忆（隐私隔离）
  const leak = plugin.recall('group:B', '团建');
  const leakText = (leak.fragments || []).map((f) => f.lines.join('')).join('');
  assert.ok(!leakText.includes('团建'), `A 群的本会话记忆泄漏到 B 群：${leakText}`);

  // A 群查「吉他」→ 共享 + 本会话都可见
  const inA = plugin.recall('group:A', '吉他');
  assert.ok(inA.fragments[0].lines.join('').includes('吉他'), JSON.stringify(inA.fragments));

  // A 群的 MEMORY.md 只放本会话记忆；共享记忆单独存在 _global/MEMORY.md
  assert.ok(plugin.readFile('group:A').includes('团建'), plugin.readFile('group:A'));
  // 共享记忆在共享层可读
  const globalMd = fs.readFileSync(path.join(dir, '_global', 'MEMORY.md'), 'utf8');
  assert.ok(globalMd.includes('阿草在学吉他'), globalMd);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写入合并：交给模型判断——重复内容不新增，replaceId 由模型指定合并', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });

  const a = plugin.saveMemory('private:950', { text: '载舟就是徐文杰', scope: 'long', importance: 3, who: '载舟', layer: 'global' });
  assert.equal(a.merged, false, JSON.stringify(a));

  // ① 完全相同 → 机械去重（防止工具重试/手滑），不新增
  const b = plugin.saveMemory('private:950', { text: '载舟就是徐文杰', scope: 'long', importance: 3, who: '载舟', layer: 'global' });
  assert.equal(b.merged, true, JSON.stringify(b));
  assert.equal(b.id, a.id, '重复内容应复用旧 id');
  assert.equal(b.reinforceCount, 2, JSON.stringify(b));

  // ② 模型先看候选（决定"新增还是合并"的依据）
  const candidates = plugin.memoryCandidates('private:950', { who: '载舟', layer: 'global' });
  assert.ok(candidates.some((x) => x.id === a.id), JSON.stringify(candidates));
  assert.ok(candidates[0].text.includes('载舟'), JSON.stringify(candidates));

  // ③ 模型判断"这是同一条，补充信息" → 带 replaceId 改写合并（服务端不做相似度判断）
  const c = plugin.saveMemory('private:950', {
    text: '载舟就是徐文杰，男，24岁，INFJ人格', scope: 'long', importance: 4, who: '载舟', layer: 'global', replaceId: a.id,
  });
  assert.equal(c.merged, true, JSON.stringify(c));
  assert.equal(c.replaced, true, JSON.stringify(c));
  assert.equal(c.id, a.id, '合并应复用旧 id');
  assert.ok(c.text.includes('INFJ'), '应写入模型合并后的版本：' + c.text);
  assert.ok(c.importance >= 4, '重要度取高：' + c.importance);

  // ④ 不同的事 → 新增（服务端不会因为"字面像"就合并）
  const e = plugin.saveMemory('private:950', { text: '阿草在学吉他', scope: 'long', importance: 3, who: '阿草', layer: 'global' });
  assert.equal(e.merged, false, JSON.stringify(e));

  // 共享层最终 2 条（载舟合并成 1 条 + 阿草 1 条）
  const store = JSON.parse(fs.readFileSync(path.join(dir, '_global', 'memories.json'), 'utf8'));
  assert.equal(store.entries.length, 2, JSON.stringify(store.entries.map((x) => x.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('主动整理：只清完全重复，不做规则相似合并', () => {
  const dir = tmpDir();
  const clock = { v: Date.now() };
  const plugin = createMemoryPlugin({ stateDir: dir, config: {}, now: () => clock.v });
  // 模拟历史遗留：两条一模一样的（工具重试造成）
  const store = { version: 1, nextId: 4, entries: [
    { id: 'm1', t: clock.v, text: '载舟就是徐文杰', scope: 'long', layer: 'global', importance: 3, who: '载舟', status: 'active' },
    { id: 'm2', t: clock.v, text: '载舟就是徐文杰', scope: 'long', layer: 'global', importance: 4, who: '载舟', status: 'active' },
    // 下面这条是"同一事实的补充细节"，但服务端不擅自合并（该由模型判断）
    { id: 'm3', t: clock.v, text: '载舟就是徐文杰，男，24岁，INFJ人格', scope: 'long', layer: 'global', importance: 3, who: '载舟', status: 'active' },
  ] };
  fs.mkdirSync(path.join(dir, '_global'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_global', 'memories.json'), JSON.stringify(store), 'utf8');

  const r = plugin.runConsolidateGlobal();
  assert.equal(r.merged, 1, JSON.stringify(r));
  const after = JSON.parse(fs.readFileSync(path.join(dir, '_global', 'memories.json'), 'utf8'));
  assert.equal(after.entries.length, 2, JSON.stringify(after.entries.map((x) => x.text)));
  // 保留重要度更高的那条
  assert.equal(after.entries.find((x) => x.id === 'm2').importance, 4, JSON.stringify(after.entries));
  fs.rmSync(dir, { recursive: true, force: true });
});
// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const { name, error } of failures) console.error(`\nFAILED: ${name}\n${error?.stack ?? error}`);
  process.exit(1);
}




