// 时间观念回归：沉睡很久后被唤醒，模型必须看得出「这条是旧账」。
//
// 真实故障（操作者报告 + 会话实证）：
//   有人发消息时 AI 正在沉睡；很久以后被唤醒，看到那条旧消息仍然当成"刚发的"去回复，
//   甚至抢进早已散场的话题。两个根因：
//     ① 模型看到的时间是裸 epoch（`time:1792294529471`），算不出"这是 38 分钟前"；
//     ② 提示词里没有一条规则说"旧消息不该按实时对话接"。
//
// 本文件验证修复后的契约：at/ago 字段、提示词里的时间感分档、唤醒原因的年龄、���照头的时间。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage, compactModelData, describeAge, serializeModelData } from '../src/qq-model-view.js';

const KEY = 'group:456';
const MIN = 60000;
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 固定 now 便于断言：2026-10-18 11:31:05 本地时间
const NOW = new Date(2026, 9, 18, 11, 31, 5).getTime();

// ── 1. 模型视图：epoch → at / ago ───────────────────────────────────────────
await test('compactModelMessage 把 epoch 换成 at/ago，并去掉裸 time', () => {
  const compact = compactModelMessage(
    { seq: 7, sender: '小明', text: '在吗', time: NOW - 38 * MIN },
    { now: NOW }
  );
  assert.equal(compact.time, undefined, '裸 epoch 不该再出现在模型视图里');
  assert.equal(compact.ago, '38m');
  assert.equal(compact.at, '10:53');
  assert.equal(compact.text, '在吗');
});

await test('ago 单位：秒/分/时/天，未来时间夹到 0s', () => {
  assert.equal(describeAge(NOW - 3000, NOW), '3s');
  assert.equal(describeAge(NOW - 59 * 1000, NOW), '59s');
  assert.equal(describeAge(NOW - 18 * MIN, NOW), '18m');
  assert.equal(describeAge(NOW - 5 * 60 * MIN, NOW), '5h');
  assert.equal(describeAge(NOW - 3 * 24 * 60 * MIN, NOW), '3d');
  assert.equal(describeAge(NOW + 5 * MIN, NOW), '0s', '未来时间不能显示成负数');
});

await test('跨天的消息 at 带日期（否则"23:40"会被误读成今天）', () => {
  const compact = compactModelMessage({ text: '晚安', time: new Date(2026, 9, 16, 23, 40).getTime() }, { now: NOW });
  assert.equal(compact.at, '10-16 23:40');
  // 10-16 23:40 → 10-18 11:31 约 36 小时，按天向下取整 = 1d
  assert.equal(compact.ago, '1d');
});

await test('time 缺失/为 0 时保持原样（不把"没有时间"伪装成"刚刚"）', () => {
  assert.deepEqual(compactModelMessage({ text: '好', time: 0 }, { now: NOW }), { text: '好', time: 0 });
  assert.deepEqual(compactModelMessage({ text: '好' }, { now: NOW }), { text: '好' });
});

await test('一次序列化共用一个 now：同批消息的 ago 不会跨分钟自相矛盾', () => {
  const data = {
    messages: [
      { seq: 1, text: 'a', time: NOW - 70 * 1000 },
      { seq: 2, text: 'b', time: NOW - 10 * 1000 }
    ]
  };
  const out = JSON.parse(serializeModelData(data, { now: NOW }));
  assert.equal(out.messages[0].ago, '1m');
  assert.equal(out.messages[1].ago, '10s');
  // compactModelData 也要把 now 透传下去
  assert.equal(compactModelData(data, { now: NOW }).messages[1].ago, '10s');
});

// ── 2. 唤醒提示：时间感规则 + 具体数字 ─────────────────────────────────────
async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, ...config } } });
  h.setMode('reserved2');
  try { await run(h); } finally { await h.close(); }
}

const append = (h, text, { ageMs = 0, sender = '小明' } = {}) => {
  const st = h.getSocialV2State(KEY);
  const seq = st.lastUnreadSeq + 1;
  h.appendSocialV2Message(KEY, sender, text, text, false, false, `fixture-${seq}`, [], '789');
  if (ageMs > 0) {
    // 模拟"消息是 40 分钟前发的"：把存储层的时间戳往前推（模拟沉睡期间堆积）
    const stored = st.unread.find((m) => m.seq === seq);
    if (stored) stored.time = Date.now() - ageMs;
  }
  return seq;
};

await test('新消息（几秒前）不触发旧账警告', async () => {
  await withBridge(async (h) => {
    append(h, '在吗');
    const prompt = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.match(prompt, /【时间感/);
    assert.match(prompt, /最新一条来自「小明」/);
    assert.doesNotMatch(prompt, /旧账/, '刚发的消息不该被判成旧账');
  });
});

await test('40 分钟前的消息：提示词给出 ago 并明确标记「旧账」', async () => {
  await withBridge(async (h) => {
    append(h, '晚上开黑吗', { ageMs: 40 * MIN });
    const prompt = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.match(prompt, /40m 之前发的/, '最新一条的年龄要写进提示词');
    assert.match(prompt, /旧账/, '超过 staleChatMinutes 必须打「旧账」警告');
    assert.match(prompt, /不要用秒回语气/, '要给出可执行的替代动作');
    assert.match(prompt, /触发这条是 40m 前发的/, '唤醒原因那条的年龄也要写清楚');
  });
});

await test('超过 staleSilentMinutes：规则要求默认不回、直接收尾', async () => {
  await withBridge(async (h) => {
    append(h, '有人吗', { ageMs: 5 * 60 * MIN });
    const prompt = h.buildWakePromptV2(KEY, 'keyword:大肥鱼@seq1');
    assert.match(prompt, /5h 之前发的/);
    assert.match(prompt, /默认不回，直接 qq_mark_read 收尾/);
    assert.match(prompt, /超过 120 分钟/, '默认阈值应写进警告里');
  });
});

await test('阈值可由 config 调整（staleChatMinutes / staleSilentMinutes）', async () => {
  // 默认阈值（10 / 120 分钟）：12 分钟已算旧账
  await withBridge(async (h) => {
    append(h, '刚刚那条', { ageMs: 12 * MIN });
    assert.match(h.buildWakePromptV2(KEY, 'atMention@seq1'), /旧账/);
  });
  // 抬高到 60 分钟：12 分钟不该算旧账，分档文本要跟着变
  await withBridge(async (h) => {
    append(h, '刚刚那条', { ageMs: 12 * MIN });
    const prompt = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.doesNotMatch(prompt, /旧账/);
    assert.match(prompt, /60 分钟以内：正常接/);
  }, { wake: { staleChatMinutes: 60 } });
  // silentMinutes 低于 chatMinutes 时必须被抬平：否则中间档会写成自相矛盾的「60～60 分钟」
  await withBridge(async (h) => {
    append(h, '刚刚那条', { ageMs: 12 * MIN });
    const prompt = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.doesNotMatch(prompt, /60～60/);
    assert.match(prompt, /超过 60 分钟/);
  }, { wake: { staleChatMinutes: 60, staleSilentMinutes: 15 } });
});

await test('定时/引导唤醒不背时间感那段（没有可判断的消息时）', async () => {
  await withBridge(async (h) => {
    const prompt = h.buildWakePromptV2(KEY, 'bootstrap');
    assert.doesNotMatch(prompt, /【时间感/, '没有消息时不该注入时间感规则');
  });
});

// ── 3. 唤醒快照：now / newestAgo / 每条 at-ago ─────────────────────────────
await test('快照头部带 now 与 newestAgo，消息体带 at/ago 且不再有裸 time', async () => {
  await withBridge(async (h) => {
    append(h, '第一条');
    append(h, '第二条', { ageMs: 25 * MIN });
    const snapshot = h.buildWakeSnapshotV2(KEY);
    assert.match(snapshot.now, /^\d{2}:\d{2}$/);
    assert.equal(snapshot.newestAgo, '25m');
    for (const message of snapshot.messages) {
      assert.equal(message.time, undefined, '快照里不该再有裸 epoch');
      assert.match(message.at, /^\d{2}:\d{2}$/);
      assert.match(message.ago, /^\d+[smhd]$/);
    }
    assert.equal(snapshot.messages[1].ago, '25m');
  });
});

// ── 4. 工具结果也走同一套视图（MCP 与桥接共用 qq-model-view） ───────────────
await test('serializeModelData 对 messages/newMessages 同时生效（工具结果同口径）', () => {
  const data = { ok: true, unreadCount: 1, messages: [{ seq: 3, text: 'x', time: NOW - 90 * 1000 }], newMessages: [{ seq: 4, text: 'y', time: NOW - 5 * MIN }] };
  const out = JSON.parse(serializeModelData(data, { now: NOW }));
  assert.equal(out.messages[0].ago, '1m');
  assert.equal(out.newMessages[0].ago, '5m');
  assert.equal(out.unreadCount, 1, '信封字段不受影响');
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
