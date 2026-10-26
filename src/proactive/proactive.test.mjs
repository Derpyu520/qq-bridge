/**
 * 主动聊天：阶段 1+2 的测试。
 *
 * 覆盖任务书 §14 里这一版能做到的部分：
 *   1 关闭时不产生候选  3 近期互动时不主动  4 每日上限  5 冷却期
 *   6 安静时段（含跨夜） 7 已结束话题不主动  8 重复话题不重复生成
 *   9 无到期话题时 AI 调用次数为零  15 调度周期本身不调 AI
 * 另外补了存储层的原子性（额度、幂等、重启恢复）。
 *
 * 阶段 3 的投递场景（QQ 成功 DSH 失败、传输失败重试、结果未知不重发）
 * 等 generate/deliver 接上之后再补，这里只测它们依赖的状态机底座。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProactiveStore } from './store.mjs';
import { createProactiveEngine } from './engine.mjs';
import { createTopicManager } from './topic-manager.mjs';
import { buildTriggerKey, TRIGGER_TYPE } from './trigger-manager.mjs';
import {
  DEFAULT_POLICY,
  checkHardGates,
  dayKeyOf,
  decide,
  isQuietHours,
  normalizePolicy,
  parseClock,
  scoreCandidate,
} from './policy.mjs';

/** 安静时段关掉（start === end 等于没有安静时段），避免测试被时间带偏。 */
const NO_QUIET = { start: '00:00', end: '00:00' };

function fixture(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'proactive.db'), onError: () => {} });
  const clock = { at: Date.UTC(2026, 9, 26, 4, 0, 0) }; // 2026-10-26 12:00 东八区
  const now = () => clock.at;
  let seq = 0;
  const idFactory = () => `id-${++seq}`;
  const engine = createProactiveEngine({
    store,
    now,
    idFactory,
    timeZone: 'Asia/Shanghai',
    config: {
      enabled: true,
      dryRun: true,
      ...config,
      policy: {
        ...DEFAULT_POLICY,
        quietHours: NO_QUIET,
        ...(config.policy ?? {}),
      },
    },
  });
  return {
    dir,
    store,
    engine,
    clock,
    now,
    idFactory,
    advance(ms) { clock.at += ms; },
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withFixture(config, run) {
  const f = fixture(config);
  try {
    await run(f);
  } finally {
    f.cleanup();
  }
}

// ── 纯策略 ─────────────────────────────────────────────────────────────────

test('parseClock 认 HH:mm，拒绝歪值', () => {
  assert.equal(parseClock('23:00'), 1380);
  assert.equal(parseClock('8:05'), 485);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('23:60'), null);
  assert.equal(parseClock('晚上'), null);
  assert.equal(parseClock(undefined), null);
});

test('安静时段跨夜：23:00–08:00 里 02:00 算安静，12:00 不算', () => {
  const quiet = { start: '23:00', end: '08:00' };
  const at2am = Date.UTC(2026, 9, 25, 18, 0, 0);   // 东八区 10-26 02:00
  const atNoon = Date.UTC(2026, 9, 26, 4, 0, 0);   // 东八区 10-26 12:00
  const at11pm = Date.UTC(2026, 9, 26, 15, 0, 0);  // 东八区 10-26 23:00
  assert.equal(isQuietHours(at2am, 'Asia/Shanghai', quiet), true);
  assert.equal(isQuietHours(atNoon, 'Asia/Shanghai', quiet), false);
  assert.equal(isQuietHours(at11pm, 'Asia/Shanghai', quiet), true);
});

test('安静时段 start === end 等于关掉，不是全天安静', () => {
  const at = Date.UTC(2026, 9, 26, 4, 0, 0);
  assert.equal(isQuietHours(at, 'Asia/Shanghai', { start: '08:00', end: '08:00' }), false);
});

test('dayKeyOf 按用户时区算日期，东八区凌晨不算前一天', () => {
  const at = Date.UTC(2026, 9, 25, 17, 30, 0); // 东八区 10-26 01:30
  assert.equal(dayKeyOf(at, 'Asia/Shanghai'), '2026-10-26');
  assert.equal(dayKeyOf(at, 'UTC'), '2026-10-25');
});

test('normalizePolicy 把歪值收敛成默认，不抛错', () => {
  const p = normalizePolicy({ checkIntervalMs: -5, maxPerDay: 'abc', quietHours: '半夜' });
  assert.equal(p.checkIntervalMs, 5_000);          // 被夹到下限
  assert.equal(p.maxPerDay, DEFAULT_POLICY.maxPerDay);
  assert.deepEqual(p.quietHours, DEFAULT_POLICY.quietHours);
});

test('评分：到期话题 + 有效话题达到阈值，以前联系过会被扣回去', () => {
  const now = Date.UTC(2026, 9, 26, 4, 0, 0);
  const policy = { ...DEFAULT_POLICY, quietHours: NO_QUIET };
  const topic = { status: 'open', followUpAt: now - 1000 };
  const fresh = scoreCandidate({ topic, state: {}, now, policy });
  assert.equal(fresh.score, 60); // 35 + 25
  assert.ok(fresh.score >= policy.scoreThreshold);

  const afterContact = scoreCandidate({
    topic,
    state: { lastProactiveAt: now - 4 * 3600_000, lastUserMessageAt: now - 2 * 3600_000 },
    now,
    policy,
  });
  // 35 + 25 + 15(空闲) + 25? → 注意旧联系只 -40，这里验证它真的把分压下来了
  assert.equal(afterContact.score, 35 + 25 + 15 - 40);
});

test('硬门槛不被分数抵消：安静时段里话题再到期也拦', () => {
  const now = Date.UTC(2026, 9, 26, 15, 0, 0); // 东八区 23:00
  const policy = { ...DEFAULT_POLICY };          // 用默认 23:00–08:00
  const gates = checkHardGates({
    engineEnabled: true,
    state: { enabled: true, dailyCount: 0 },
    scope: { dshSessionId: 's1', qqTargetId: '1', enabledChannels: ['qq'] },
    topic: { status: 'open', followUpAt: now - 1000 },
    now,
    timeZone: 'Asia/Shanghai',
    policy,
  });
  assert.equal(gates.allowed, false);
  assert.deepEqual(gates.blocked, ['quiet-hours']);
});

test('硬门槛一次给出所有拦截原因', () => {
  const now = Date.UTC(2026, 9, 26, 4, 0, 0);
  const policy = { ...DEFAULT_POLICY, quietHours: NO_QUIET };
  const gates = checkHardGates({
    engineEnabled: true,
    state: { enabled: false, pausedUntil: now + 1000, lastUserMessageAt: now - 1000, lastProactiveAt: now - 1000, dailyCount: 9 },
    scope: { dshSessionId: '', enabledChannels: [] },
    topic: null,
    now,
    timeZone: 'Asia/Shanghai',
    policy,
  });
  assert.equal(gates.allowed, false);
  for (const reason of ['user-disabled', 'paused', 'recent-user-message', 'cooldown', 'daily-limit', 'session-missing', 'target-missing', 'no-topic']) {
    assert.ok(gates.blocked.includes(reason), `缺少 ${reason}：${gates.blocked.join(',')}`);
  }
});

test('decide：分数不够线就是 suppress，理由写 score-below-threshold', () => {
  const now = Date.UTC(2026, 9, 26, 4, 0, 0);
  const policy = { ...DEFAULT_POLICY, quietHours: NO_QUIET, scoreThreshold: 999 };
  const verdict = decide({
    engineEnabled: true,
    state: { enabled: true, dailyCount: 0 },
    scope: { dshSessionId: 's1', qqTargetId: '1', enabledChannels: ['qq'] },
    topic: { status: 'open', followUpAt: now - 1000 },
    now,
    timeZone: 'Asia/Shanghai',
    policy,
  });
  assert.equal(verdict.decision, 'suppress');
  assert.deepEqual(verdict.blocked, ['score-below-threshold']);
});

// ── 存储层 ─────────────────────────────────────────────────────────────────

test('每日额度是原子的：上限 2 时第三次预留失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const now = Date.UTC(2026, 9, 26, 4, 0, 0);
    assert.equal(store.reserveDailyQuota('u1', '2026-10-26', 2, now), true);
    assert.equal(store.reserveDailyQuota('u1', '2026-10-26', 2, now), true);
    assert.equal(store.reserveDailyQuota('u1', '2026-10-26', 2, now), false);
    assert.equal(store.getState('u1').dailyCount, 2);
    assert.equal(store.releaseDailyQuota('u1', '2026-10-26', now), true);
    assert.equal(store.getState('u1').dailyCount, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('额度跨日自动归零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const day1 = Date.UTC(2026, 9, 26, 4, 0, 0);
    store.reserveDailyQuota('u1', '2026-10-26', 3, day1);
    store.reserveDailyQuota('u1', '2026-10-26', 3, day1);
    assert.equal(store.getState('u1').dailyCount, 2);
    const day2 = day1 + 86_400_000;
    store.rollDay('u1', '2026-10-27', day2);
    assert.equal(store.getState('u1').dailyCount, 0);
    assert.equal(store.getState('u1').dayKey, '2026-10-27');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一个 triggerKey 只进一次库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const now = Date.now();
    const base = { triggerKey: 'topic:t1:1000', userId: 'u1', type: 'explicit', topicId: 't1', reason: '面试', now };
    assert.equal(store.addTrigger({ id: 'a', ...base }), true);
    assert.equal(store.addTrigger({ id: 'b', ...base }), false);
    assert.equal(store.listTriggers({ limit: 10 }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trigger 领取是原子的：lease 期内别人领不到，过期后能领', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const t0 = Date.now();
    store.addTrigger({ id: 'a', triggerKey: 'k', userId: 'u1', type: 'explicit', reason: 'r', now: t0 });
    const first = store.claimTrigger({ now: t0, leaseMs: 1000 });
    assert.equal(first.id, 'a');
    assert.equal(store.claimTrigger({ now: t0 + 500, leaseMs: 1000 }), null); // lease 还没过期
    assert.equal(store.claimTrigger({ now: t0 + 1500, leaseMs: 1000 }), null); // 已不是候选了
    store.setTriggerState('a', 'retry_wait', { now: t0 + 2000, leaseUntil: null });
    const again = store.claimTrigger({ now: t0 + 3000, leaseMs: 1000 });
    assert.equal(again.id, 'a');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启恢复：上一进程遗留的 sending 变 unknown，不会被当失败重发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const now = Date.now();
    store.addMessage({ id: 'm1', triggerId: 't1', userId: 'u1', sessionId: 's1', text: 'hi', channels: ['qq'], now });
    store.ensureDelivery({ messageId: 'm1', channel: 'qq', now });
    store.claimDelivery({ messageId: 'm1', channel: 'qq', now });
    assert.equal(store.listDeliveries('m1')[0].status, 'sending');

    assert.equal(store.reconcileInflightDeliveries(now + 1), 1);
    const row = store.listDeliveries('m1')[0];
    assert.equal(row.status, 'unknown');
    // unknown 不在可领范围内 → 不会盲目重发
    assert.equal(store.claimDelivery({ messageId: 'm1', channel: 'qq', now: now + 2 }), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('僵死的 evaluating 触发会被放回 retry_wait', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-proactive-'));
  const store = createProactiveStore({ file: join(dir, 'p.db'), onError: () => {} });
  try {
    const t0 = Date.now();
    store.addTrigger({ id: 'a', triggerKey: 'k', userId: 'u1', type: 'explicit', reason: 'r', now: t0 });
    store.claimTrigger({ now: t0, leaseMs: 1000 });
    assert.equal(store.getTrigger('a').state, 'evaluating');
    assert.equal(store.releaseStaleTriggers(t0 + 2000), 1);
    assert.equal(store.getTrigger('a').state, 'retry_wait');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('triggerKey 稳定：同话题同改期时间算出同一个键', () => {
  const a = buildTriggerKey({ type: TRIGGER_TYPE.explicit, userId: 'u1', topicId: 't1', followUpAt: 100 });
  const b = buildTriggerKey({ type: TRIGGER_TYPE.explicit, userId: 'u1', topicId: 't1', followUpAt: 100 });
  const c = buildTriggerKey({ type: TRIGGER_TYPE.explicit, userId: 'u1', topicId: 't1', followUpAt: 200 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(buildTriggerKey({ type: TRIGGER_TYPE.externalEvent, externalId: 'e1' }), 'event:e1');
});

// ── 引擎主流程 ─────────────────────────────────────────────────────────────

test('① 关闭时 tick 直接跳过，一条 trigger 都不建', async () => {
  await withFixture({ enabled: false }, async ({ store, engine }) => {
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    const topics = createTopicManager({ store });
    topics.record({ userId: 'u1', summary: '问她面试', followUpAt: Date.now() - 1000 });
    const report = await engine.tick();
    assert.equal(report.skipped, 'disabled');
    assert.equal(store.listTriggers({ limit: 10 }).length, 0);
  });
});

test('⑨ 没有到期话题时，AI 一次都不调（这是任务书的核心约束）', async () => {
  let generateCalls = 0;
  await withFixture({ dryRun: false }, async ({ store, engine }) => {
    // 换成带 generate 的引擎
    const real = createProactiveEngine({
      store,
      config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
      generate: async () => { generateCalls += 1; return { text: '在吗' }; },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    // 只登记一个「还没到时间」的话题
    createTopicManager({ store }).record({ userId: 'u1', summary: '三天后再问', followUpAt: Date.now() + 3 * 86_400_000 });
    const report = await real.tick();
    assert.equal(report.candidates, 0);
    assert.equal(generateCalls, 0);
    void engine;
  });
});

test('⑮ 连续多次 tick 也不调 AI，直到话题到期', async () => {
  let generateCalls = 0;
  await withFixture({ enabled: true, dryRun: false }, async ({ store }) => {
    const engine = createProactiveEngine({
      store,
      config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
      generate: async () => { generateCalls += 1; return { text: '在吗' }; },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    for (let i = 0; i < 5; i += 1) await engine.tick();
    assert.equal(generateCalls, 0);
  });
});

test('可选：dry-run 下判定通过也只记账，不调 AI、不发消息', async () => {
  let generateCalls = 0;
  await withFixture({ dryRun: true }, async ({ store, engine, now }) => {
    const real = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
      generate: async () => { generateCalls += 1; return { text: '在吗' }; },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await real.tick();
    assert.equal(report.candidates, 1);
    assert.equal(generateCalls, 0);
    assert.equal(real.status().reports.length, 1);
    assert.equal(real.status().reports[0].dryRun, true);
    void engine;
  });
});

test('dry-run 报告同一结论只记一次，不会每 60 秒刷一条', async () => {
  await withFixture({ dryRun: true }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    // 有到期话题，但一分钟前刚聊过：每次都卡在 recent-user-message，报告不该刷屏
    store.touchUserMessage('u1', now() - 60_000);
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    await engine.tick();
    await engine.tick();
    await engine.tick();
    const reports = engine.status().reports;
    assert.equal(reports.length, 1);
    assert.ok(reports[0].blocked.includes('recent-user-message'));
  });
});

test('③ 刚聊过就不主动（recent-user-message）', async () => {
  await withFixture({ dryRun: true }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    store.touchUserMessage('u1', now() - 60_000); // 1 分钟前刚说话
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    assert.equal(report.candidates, 0);
    assert.equal(report.suppressed, 1);
    assert.ok(report.details[0].blocked.includes('recent-user-message'));
  });
});

test('④ 到每日上限就停在 daily-limit', async () => {
  await withFixture({ dryRun: true, policy: { maxPerDay: 0 } }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET, maxPerDay: 0 } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    assert.equal(report.candidates, 0);
    assert.ok(report.details[0].blocked.includes('daily-limit'));
  });
});

test('⑤ 冷却期内不主动（cooldown）', async () => {
  await withFixture({ dryRun: true }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    store.markProactiveSent('u1', now() - 10 * 60_000); // 10 分钟前才发过
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    assert.equal(report.candidates, 0);
    assert.ok(report.details[0].blocked.includes('cooldown'));
  });
});

test('⑦ 已关闭的话题不再主动', async () => {
  await withFixture({ dryRun: true }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    const mgr = createTopicManager({ store, now });
    const made = mgr.record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    mgr.close(made.topic.id);
    const report = await engine.tick();
    // 关闭的话题不会再被 due() 选出来，所以压根没有候选
    assert.equal(report.candidates, 0);
    assert.equal(report.details.length, 0);
  });
});

test('⑧ 同一话题重复 tick 只产生一条触发', async () => {
  await withFixture({ dryRun: true }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: true, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    await engine.tick();
    await engine.tick();
    await engine.tick();
    assert.equal(store.listTriggers({ limit: 50 }).length, 1);
  });
});

test('真跑一单：生成一次、记 markProactiveSent、扣一次额度', async () => {
  let generateCalls = 0;
  await withFixture({ dryRun: false }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
      generate: async () => { generateCalls += 1; return { text: '面试那事后来怎么样了？' }; },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    assert.equal(generateCalls, 1);
    assert.equal(report.generated, 1);
    assert.equal(store.getState('u1').dailyCount, 1);
    assert.ok(store.getState('u1').lastProactiveAt);
  });
});

test('生成失败会把额度还回去，并留在 retry_wait', async () => {
  await withFixture({ dryRun: false }, async ({ store, now }) => {
    let attempts = 0;
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET } },
      timeZone: 'Asia/Shanghai',
      generate: async () => {
        attempts += 1;
        throw new Error('模型超时');
      },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    assert.equal(attempts, 1);
    assert.equal(report.generated, 0);
    assert.equal(store.getState('u1').dailyCount, 0); // 额度还回去了
    const [trigger] = store.listTriggers({ limit: 1 });
    assert.equal(trigger.state, 'retry_wait');
  });
});

test('normalizePolicy 把开口概率收敛到 0–1，歪值不抛错', () => {
  assert.equal(normalizePolicy({ sendProbability: 0.35 }).sendProbability, 0.35);
  assert.equal(normalizePolicy({ sendProbability: 2.5 }).sendProbability, 1);
  assert.equal(normalizePolicy({ sendProbability: -1 }).sendProbability, 0);
  assert.equal(normalizePolicy({ sendProbability: '一串中文' }).sendProbability, DEFAULT_POLICY.sendProbability);
  assert.equal(normalizePolicy({ sendProbability: 1 }).sendProbability, 1);
  assert.equal(normalizePolicy({}).sendProbability, DEFAULT_POLICY.sendProbability);
});

test('开口概率 0：判定通过也不调 AI，不花额度', async () => {
  let generateCalls = 0;
  await withFixture({ dryRun: false }, async ({ store, now }) => {
    const engine = createProactiveEngine({
      store,
      now,
      config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET, sendProbability: 0 } },
      timeZone: 'Asia/Shanghai',
      generate: async () => { generateCalls += 1; return { text: '在吗' }; },
    });
    store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
    createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
    const report = await engine.tick();
    // 判定这一层是放行的，死在抽签上
    assert.equal(report.candidates, 1);
    assert.equal(report.skippedProb, 1);
    assert.equal(report.generated, 0);
    assert.equal(generateCalls, 0);
    assert.equal(store.getState('u1').dailyCount, 0);
    assert.ok(store.getState('u1').lastProactiveAt == null || store.getState('u1').lastProactiveAt === 0);
  });
});

test('开口概率 0.5：抽不中不开口，抽中了照常发', async () => {
  for (const [roll, expectGenerated] of [[0.9, 0], [0.1, 1]]) {
    let generateCalls = 0;
    await withFixture({ dryRun: false }, async ({ store, now }) => {
      const engine = createProactiveEngine({
        store,
        now,
        config: { enabled: true, dryRun: false, policy: { ...DEFAULT_POLICY, quietHours: NO_QUIET, sendProbability: 0.5 } },
        timeZone: 'Asia/Shanghai',
        random: () => roll,
        generate: async () => { generateCalls += 1; return { text: '在吗' }; },
      });
      store.upsertScope({ userId: 'u1', dshSessionId: 's1', qqTargetId: '1001' });
      createTopicManager({ store, now }).record({ userId: 'u1', summary: '问她面试', followUpAt: now() - 1000 });
      const report = await engine.tick();
      assert.equal(report.generated, expectGenerated, 'roll=' + roll);
      assert.equal(generateCalls, expectGenerated, 'roll=' + roll);
      assert.equal(report.skippedProb, expectGenerated === 0 ? 1 : 0, 'roll=' + roll);
    });
  }
});
