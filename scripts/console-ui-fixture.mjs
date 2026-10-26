#!/usr/bin/env node
/** Offline console preview. No production modules, credentials, state, or network clients are loaded. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCharStats, roleSectionReport } from '../src/role-card.js';
import { pickBucketMs } from '../src/token-ledger.js';
import { manualDirCommand } from '../src/state-acl.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';

// 预设状态：mock 直接复用真实字段口径，避免与 bridge.js 漂移。
function presetStatusFixture(preset) {
  return {
    preset,
    label: preset === 'qq-chat' ? '一代仿真（reserved）' : preset === 'qq-chat-v3' ? '三代仿真（reserved3）' : '二代仿真（reserved2）',
    sourceFile: `dsh/agent-presets/${preset}/agent.cordis.yml`,
    installed: true,
    requiresRestart: true,
  };
}

// ── 令牌与花费：离线示例数据 ──────────────────────────────────────────────
// 字段口径与 src/token-ledger.js 的 summary()/conversation()/recent() 保持一致，
// 这样控制台渲染路径在离线预览与真实环境走的是同一套形状。
const USAGE_SYMBOL = '¥';
const USAGE_PRICE_TABLE = {
  version: '2026-11-04',
  currency: 'CNY',
  symbol: USAGE_SYMBOL,
  unit: 1e6,
  peakMultiplier: 2,
  peakWindows: [[9, 12], [14, 18]],
  peakWeekdays: [1, 2, 3, 4, 5],
  holidayCount: 33,
  models: {
    'deepseek-flash': { label: 'DeepSeek-V4.1-Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
    'deepseek-v4-pro': { label: 'DeepSeek-V4-Pro-0813', off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 } },
  },
};

function usageConversationFixture(key, buckets, cost, turns, steps, unattributed = 0) {
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  return {
    key,
    sessionIds: [`fixture-session-${key.replace(/\W/g, '')}`],
    sessions: 1,
    buckets,
    cost,
    unattributedCost: unattributed,
    attributedCost: cost - unattributed,
    byTier: { peak: cost * 0.4, off: cost * 0.6 },
    turns,
    steps,
    estimated: false,
    lastAt: Date.parse(timestamp),
    firstAt: Date.parse(timestamp) - 3600_000,
    models: ['deepseek-flash'],
    cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
  };
}

function usageSummaryFixture() {
  const conversations = [
    usageConversationFixture('group:123456789', { cacheMiss: 41230, cacheHit: 1284000, cacheWrite: 0, output: 18420, reasoning: 0 }, 0.2886, 42, 231),
    usageConversationFixture('private:100001', { cacheMiss: 8600, cacheHit: 210400, cacheWrite: 0, output: 3900, reasoning: 0 }, 0.0467, 9, 48),
    usageConversationFixture('internal:黑话学习', { cacheMiss: 2200, cacheHit: 18000, cacheWrite: 0, output: 900, reasoning: 0 }, 0.0075, 3, 11),
  ];
  const buckets = conversations.reduce((acc, c) => ({
    cacheMiss: acc.cacheMiss + c.buckets.cacheMiss,
    cacheHit: acc.cacheHit + c.buckets.cacheHit,
    cacheWrite: acc.cacheWrite + c.buckets.cacheWrite,
    output: acc.output + c.buckets.output,
    reasoning: 0,
  }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const cost = conversations.reduce((acc, c) => acc + c.cost, 0);
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const turns = conversations.reduce((acc, c) => acc + c.turns, 0);
  const steps = conversations.reduce((acc, c) => acc + c.steps, 0);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    priceVersion: USAGE_PRICE_TABLE.version,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    nowTier: { model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'off', tierLabel: '空闲时段', estimated: false },
    priceTable: USAGE_PRICE_TABLE,
    totals: {
      buckets,
      cost,
      attributedCost: cost - 0.02,
      unattributedCost: 0.02,
      byTier: { peak: cost * 0.4, off: cost * 0.6 },
      turns,
      steps,
      conversations: conversations.length,
      estimated: false,
      totalTokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output,
      inputTokens: input,
      cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
      avgCostPerTurn: cost / turns,
      avgCostPerStep: cost / steps,
    },
    conversations,
    ledger: { file: '(fixture)', journalLines: 0, maxLines: 20000, droppedLines: 0, sessions: 3, baselines: 3, samples: steps, lastIngestAt: Date.parse(timestamp), lastCompactedAt: 0, priceVersion: USAGE_PRICE_TABLE.version },
  };
}

// 走势图示例数据：24 小时 × 30 分钟 = 48 格，故意留出空白时段。
// 峰谷档位按**真实规则**推算（周一至周五 9:00-12:00、14:00-18:00 为高峰），
// 这样示例图看起来和真实使用一致（两条高峰带），而不是人为交替的噪点。
function usageSeriesFixture(hoursRaw) {
  const hours = [24, 72, 168, 720].includes(Number(hoursRaw)) ? Number(hoursRaw) : 24;
  // 桶宽用**生产同一套阶梯**（从 token-ledger 导出），避免预览与线上粒度不一致。
  const bucketMs = pickBucketMs(hours * 3600 * 1000, 48);
  // 走势图的锚点固定在一个**工作日**：fixture 的 timestamp 落在周日，按真实峰谷规则
  // 算出来整条图都是空闲色，示例数据就永远看不到高峰带（离线预览也就失去意义）。
  // 锚点固定也让截图/断言可复现。
  const anchor = Date.parse('2026-09-16T08:30:00.000Z'); // 周三
  const end = Math.floor(anchor / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil((hours * 3600 * 1000) / bucketMs) * bucketMs;
  const count = Math.round((end - start) / bucketMs);
  const isPeakHour = (ms) => {
    const d = new Date(ms);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  };
  // 档位要**扫完整个桶**，不能只看首尾：12 小时的桶完全可能把 9:00-12:00 整段包在
  // 中间，而两端都在空闲区（首尾采样法会把它误判成「空闲」）。
  const tierOfBucket = (t) => {
    let sawPeak = false;
    let sawOff = false;
    for (let ms = t; ms < t + bucketMs; ms += Math.min(bucketMs, 30 * 60 * 1000)) {
      if (isPeakHour(ms)) sawPeak = true; else sawOff = true;
      if (sawPeak && sawOff) return 'mixed';
    }
    return sawPeak ? 'peak' : 'off';
  };
  const buckets = [];
  // 桶内按 30 分钟小格累加，而不是"只看桶起点那一小时"：
  // 粗桶（如 24 小时）起点可能落在深夜，只看起点会让整条 30 天视图全是 0。
  // 累加也更接近真账本的行为（一个桶 = 该时段所有采样之和）。
  const subStepMs = Math.min(bucketMs, 30 * 60 * 1000);
  for (let i = 0; i < count; i += 1) {
    const t = start + i * bucketMs;
    let cacheMiss = 0;
    let cacheHit = 0;
    let output = 0;
    let cost = 0;
    let turns = 0;
    let steps = 0;
    for (let ms = t; ms < t + bucketMs; ms += subStepMs) {
      const hour = new Date(ms).getHours();
      if (hour < 9 || hour > 23) continue; // 深夜为 0，图上有明显的空白段
      const wave = (Math.sin((ms - start) / (3 * subStepMs)) + 1) / 2;
      const cm = Math.round(300 + wave * 1800);
      const ch = Math.round(6000 + wave * 42000);
      const out = Math.round(60 + wave * 400);
      const sub = (cm / 1e6) * 1 + (ch / 1e6) * 0.02 + (out / 1e6) * 4;
      cacheMiss += cm;
      cacheHit += ch;
      output += out;
      cost += isPeakHour(ms) ? sub * 2 : sub; // 高峰单价 ×2，逐格判定
      turns += 1;
      steps += 3 + (Math.floor(ms / subStepMs) % 5);
    }
    buckets.push({
      t,
      cost,
      tokens: cacheMiss + cacheHit + output,
      cacheMiss,
      cacheHit,
      cacheWrite: 0,
      output,
      turns,
      steps,
      tier: tierOfBucket(t),
      keys: steps > 0 ? ['group:123456789'] : [],
    });
  }
  const totals = buckets.reduce((acc, b) => ({
    cost: acc.cost + b.cost,
    tokens: acc.tokens + b.tokens,
    turns: acc.turns + b.turns,
    steps: acc.steps + b.steps,
  }), { cost: 0, tokens: 0, turns: 0, steps: 0 });
  const busiest = buckets.reduce((best, b) => (!best || b.cost > best.cost ? b : best), null);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    hours,
    bucketMs,
    from: start,
    to: end,
    buckets,
    totals,
    busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
    estimated: false,
    countedSamples: buckets.reduce((n, b) => n + b.steps, 0),
    offChartCost: 0.02,
    offChartTokens: 18000,
  };
}

function usageTurnsFixture(key) {
  const target = key || 'group:123456789';
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const buckets = { cacheMiss: 900 + i * 120, cacheHit: 32000 + i * 800, cacheWrite: 0, output: 420 + i * 30, reasoning: 0 };
    rows.push({
      sessionId: `fixture-session-${target.replace(/\W/g, '')}`,
      key: target,
      turn: 42 - i,
      steps: 4 + (i % 3),
      attempts: i === 2 ? 1 : 0,
      startedAt: base - (i + 1) * 600_000,
      endedAt: base - i * 600_000,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      buckets,
      cost: (buckets.cacheMiss / 1e6) * 1 + (buckets.cacheHit / 1e6) * 0.02 + (buckets.output / 1e6) * 4,
      tier: i === 1 ? 'peak' : (i === 4 ? 'mixed' : 'off'),
    });
  }
  const cost = rows.reduce((acc, t) => acc + t.cost, 0);
  return {
    ok: true,
    generatedAt: base,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    key: target,
    sessionIds: [`fixture-session-${target.replace(/\W/g, '')}`],
    sessions: 1,
    steps: rows.reduce((acc, t) => acc + t.steps, 0),
    cost,
    attributedCost: cost,
    unattributedCost: 0.0123,
    buckets: rows.reduce((acc, t) => ({
      cacheMiss: acc.cacheMiss + t.buckets.cacheMiss,
      cacheHit: acc.cacheHit + t.buckets.cacheHit,
      cacheWrite: 0,
      output: acc.output + t.buckets.output,
      reasoning: 0,
    }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }),
    byTier: { peak: cost * 0.3, off: cost * 0.7 },
    estimated: false,
    models: ['deepseek-flash'],
    turnLimit: 200,
    // 与 src/token-ledger.js 的 conversation() 一致：`turns` 是**数组**（不是条数）。
    turns: rows,
  };
}

function usageRecentFixture() {
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      time: base - i * 45_000,
      key: i % 3 === 2 ? 'private:100001' : 'group:123456789',
      sessionId: 'fixture-session',
      turn: 42 - Math.floor(i / 4),
      step: 1 + (i % 4),
      retry: 0,
      model: 'deepseek-flash',
      tokens: 34000 + i * 500,
      cacheMiss: 820 + i * 40,
      cacheHit: 33000 + i * 400,
      cacheWrite: 0,
      output: 260 + i * 12,
      reasoning: 0,
      cost: 0.0021 + i * 0.0001,
      tier: i === 3 ? 'peak' : 'off',
      estimated: false,
    });
  }
  return rows;
}

export function makeFixtureState() {
  return {
    mode: 'reserved2', role: '小鲸鱼', roleMode: 'active', closedAgentPreset: '', paused: false,
    roles: ['小鲸鱼', '温柔助手', '技术伙伴'],
    // 按会话人格（离线示例）：一个群、一个私聊各指定一张卡，其余会话走默认。
    roleAssignments: { 'group:123456789': '温柔助手', 'private:100001': '技术伙伴' },
    roleContents: {
      小鲸鱼: '# 小鲸鱼\n\n- 性格：好奇、爱接梗，遇到不懂的会直接问\n- 说话风格：简短，偶尔用 emoji',
      温柔助手: '# 温柔助手\n\n- 性格：温和、有耐心\n- 说话风格：先共情再回答',
      技术伙伴: '# 技术伙伴\n\n- 性格：直接、爱讲原理\n- 说话风格：先给结论再解释',
    },
    simPrompts: {
      'qq-chat-v2': '你是 QQ 群里的仿真群友。\n\n【二代仿真模式 —— 安全规则（最高优先级，不可违反）】\n1. 你没有本地工具。\n\n【二代仿真模式 —— 工具协议（最高优先级）】\n1. 文本输出不会自动发送到 QQ。',
      'qq-chat': '你是 QQ 群里的仿真群友（一代）。\n\n【一代仿真模式 —— 安全规则】\n1. 你没有本地工具。\n\n【一代仿真模式 —— 工具协议】\n1. 回复会自动转发到 QQ。',
    },
    roleInjectMax: 8000,
    dshEffort: 'max',
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    sessions: [
      { key: 'group:123456789', sessionId: 'demo-community-20260920', owner: false },
      { key: 'group:100003', sessionId: 'demo-development-20260920', owner: false },
      { key: 'private:100001', sessionId: 'demo-owner-20260920', owner: true },
    ],
    social: {
      triggerProbability: 0.2, activeCheckMinMs: 10000, activeCheckMaxMs: 30000,
      activeReplyDelayMinMs: 1000, activeReplyDelayMaxMs: 3000, activeDurationEnabled: true,
      activeDurationMinMs: 180000, activeDurationMaxMs: 600000, idleWindowMs: 300000,
      idleRetryProbability: 0.4, idleRetryWaitMs: 120000, skipProbability: 0.15,
      surrenderProbability: 0.08, contextWindow: 20, maxReplyChars: 500,
      burstEnabled: true, burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000,
      longGapProbability: 0.1, longGapMinMs: 2500, longGapMaxMs: 5000,
      mustReplyKeywords: ['小鲸鱼', 'DeepSeek'], proactiveEnabled: true,
      proactiveIdleThresholdMs: 1800000, proactiveCheckMinMs: 300000,
      proactiveCheckMaxMs: 900000, proactiveProbability: 0.2,
    },
    socialStates: { 'group:123456789': { phase: 'active' }, 'group:100003': { phase: 'idle' } },
    v2: { enabled: true, agentPreset: 'qq-chat-v2', provideRecommendations: true, tools: {} },
    // 会话初始提示词（离线示例）：整段内容都是虚构的演示文本。
    initPrompt: '离线示例：这是一个演示用的群聊环境说明，不会写进任何真实配置。',
    slangConfig: { enabled: true, extractMinMessages: 10, extractCooldownMs: 300000, inferenceThresholds: [2, 4, 8], injectMax: 8, learnerPreset: 'qq-chat', workspaceTitle: 'QQ 黑话学习', autoResearch: true },
    slang: [
      { id: 'demo-candidate', content: '有被治愈到', meaning: '感到温暖和安慰', status: 'candidate', count: 4, source: 'auto', evidence: [{ sender: '演示群友', text: '今天这张图，有被治愈到。' }], createdAt: timestamp, updatedAt: timestamp },
      { id: 'demo-confirmed', content: '绝绝子', meaning: '很好、很棒', usage: '表达赞美', example: '这个设计绝绝子。', status: 'confirmed', count: 12, source: 'manual', createdAt: timestamp, updatedAt: timestamp },
      { id: 'demo-rejected', content: '测试噪声', meaning: '', risk: '演示排除项', status: 'rejected', count: 1, source: 'auto', createdAt: timestamp, updatedAt: timestamp },
    ],
    security: { interceptNotify: true },
    // state/ 的 ACL 是否已收紧。离线演示默认给「未收紧」，这样告警条在预览里可见
    // （真实场景：Windows 上未以管理员身份运行桥接时就是这个状态）。
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'result', ok: true },
    ],
    feedback: [{ time: timestamp, level: 'info', message: '这是离线演示反馈。' }],
  };
}

/** Bind only to loopback. Mutations affect this server's disposable in-memory state. */
export async function startConsoleFixture({ port = 0, original = false, htmlPath, logWrites = false } = {}) {
  const file = htmlPath || resolve(projectRoot, original ? 'scripts/fixtures/console.before.html' : 'public/console.html');
  await readFile(file); // Fail early rather than displaying a broken preview.
  const state = makeFixtureState();
  const requests = [];
  const unknownRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (method === 'GET' && ['/', '/console', '/console.html'].includes(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'" });
        res.end(await readFile(file));
        return;
      }
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (method === 'GET' && path === '/__fixture/requests') return json({ requests, unknownRequests });
      if (method === 'GET' && path === '/__fixture/info') return json({ offline: true, htmlPath: file });
      if (!path.startsWith('/api/')) return json({ ok: false, error: 'Offline fixture route not found' }, 404);

      let body = {};
      if (method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requests.push({ method, path, body });
        if (logWrites) console.log(`[mock write] ${method} ${path} ${JSON.stringify(body)}`);
      }
      if (method === 'GET') {
        switch (path) {
          case '/api/status': return json({ ok: true, dshReady: true, mode: state.mode, role: state.role, roleMode: state.roleMode, roleAssignments: Object.keys(state.roleAssignments).length, closedAgentPreset: state.closedAgentPreset, ownerQQ: state.whitelist.ownerQQ, allowGroups: state.whitelist.allow.groups, allowPrivate: state.whitelist.allow.private, activity: '[08:30:00] 演示桥接已连接\n[08:30:12] group:123456789 · 已处理一条消息\n[08:30:20] 二代社交助手正在运行\n以上均为离线模拟数据。' });
          case '/api/presets': return json({ presets: [{ id: 'qq-chat-v2', trust: 'user' }, { id: 'qq-chat', trust: 'user' }] });
          case '/api/roles': return json({
            roles: state.roles.slice(),
            summaries: state.roles.map((name) => {
              const content = state.roleContents[name] ?? '';
              const stats = roleCharStats(content);
              const injectMax = state.roleInjectMax;
              return {
                name,
                bytes: Buffer.byteLength(content, 'utf8'),
                chars: content.length,
                lines: content.split('\n').length,
                mtime: Date.parse(timestamp),
                excerpt: content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) ?? '',
                injectedV1: Math.min(stats.v1, injectMax),
                injectedV2: Math.min(stats.v2, injectMax),
                charsV1: stats.v1,
                charsV2: stats.v2,
                hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
                truncated: stats.v1 > injectMax || stats.v2 > injectMax,
                warnings: 0,
              };
            }),
            current: state.role,
            assignments: { ...state.roleAssignments },
            limits: { nameMax: 40, contentMaxBytes: 65536, injectMaxChars: state.roleInjectMax },
          });
          case '/api/roles/content': {
            const name = url.searchParams.get('name') ?? '';
            if (!state.roleContents[name]) return json({ ok: false, error: `人格「${name}」不存在` }, 404);
            const content = state.roleContents[name];
            return json({
              ok: true,
              name,
              content,
              chars: content.length,
              bytes: Buffer.byteLength(content, 'utf8'),
              warnings: [],
              limits: { injectMaxChars: state.roleInjectMax },
              stats: roleCharStats(content),
              sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
            });
          }
          case '/api/preset/sim-prompt': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({
              ok: true,
              content: state.simPrompts[preset],
              chars: state.simPrompts[preset].length,
              bytes: Buffer.byteLength(state.simPrompts[preset], 'utf8'),
              warnings: [],
              status: presetStatusFixture(preset),
              presets: [presetStatusFixture('qq-chat'), presetStatusFixture('qq-chat-v2')],
            });
          }
          case '/api/preset/sim-prompt/backups': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, backups: [{ file: `${preset}.agent.cordis.yml.fixture`, mtime: Date.parse(timestamp) }] });
          }
          case '/api/dsh/model': return json({
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            reasoningEffort: state.dshEffort,
            options: ['low', 'high', 'max'],
            labels: { low: { name: 'Low', description: 'routine' }, high: { name: 'High', description: 'default balance' }, max: { name: 'Max', description: 'hardest tasks' } },
            default: 'max',
            providerDefault: 'high',
            catalogSource: 'dsh',
            globalSideEffect: true,
          });
          case '/api/whitelist': return json(state.whitelist);
          case '/api/sessions': return json({ sessions: state.sessions });
          case '/api/pending': return json({ pending: [{ key: 'group:123456789', kind: 'approval', toolName: '演示工具', reason: '等待管理员确认（离线示例）' }] });
          case '/api/social': return json({ config: state.social, states: state.socialStates, pendingSummaries: { 'group:123456789': 2 } });
          case '/api/socialV2/config': return json({ ok: true, config: state.v2 });
          case '/api/socialV2/activity': return json({ ok: true, paused: state.paused });
          case '/api/socialV2/tool-log': return json({ ok: true, entries: state.toolLog });
          case '/api/socialV2/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/socialV2/memory': return json({ ok: true, raw: { activeTopics: [{ text: '周末的阅读计划', pendingQuestion: '有没有推荐的书？' }], pendingThoughts: [{ text: '分享一张风景照片', motivation: '轻松交流' }], memberImpressions: { 演示群友: { traits: ['友善', '喜欢技术'], interactionCount: 6 } } } });
          case '/api/socialV2/state': return json({ ok: true, key: url.searchParams.get('key'), wakeConfig: { mode: 'diving', infinite: false, sleepUntil: '2026-09-20T09:00:00.000Z', triggers: { atMention: true, keywords: ['小鲸鱼'] }, wakeCount: 4 }, wakeSafety: { guaranteed: true }, unreadCount: 2, lastWakeReason: 'atMention' });
          case '/api/socialV2/states': return json({ ok: true, conversations: state.sessions.map(x => ({ key: x.key, phase: 'diving', unreadCount: 2 })) });
          case '/api/socialV2/initial-prompt': {
            const key = url.searchParams.get('key') || '';
            if (!key) {
              return json({
                ok: true,
                maxChars: 2000,
                writable: true,
                entries: state.initPrompt
                  ? [{ key: 'group:123456789', chars: String(state.initPrompt).length, updatedAt: Date.now(), preview: String(state.initPrompt).slice(0, 80) }]
                  : []
              });
            }
            return json({
              ok: true, key, exists: !!state.initPrompt, text: state.initPrompt || '',
              createdAt: Date.now(), updatedAt: Date.now(), maxChars: 2000, writable: true
            });
          }
          // 语音库（离线示例：不含任何真实音频路径）
          case '/api/voice/list':
          case '/api/socialV2/voices': return json({
            ok: true,
            key: url.searchParams.get('key') || 'group:123456789',
            count: 2,
            voices: [
              { name: '演示-问候.mp3', ok: true, bytes: 20480, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', seconds: 2 },
              { name: '演示-太长.wav', ok: false, bytes: 99999999, error: '时长 12分00秒 超过上限 5分00秒' },
            ],
            limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 },
            hint: '用 qq_send_voice 传 name 即可把其中一个当语音发出去',
          });
          case '/api/slang': return json({ ok: true, entries: state.slang, config: state.slangConfig });
          // state/ 的 ACL 收紧结果：用离线示例值演示「未收紧」的告警条（Windows 上未提权时的真实情况）
          // 命令本身必须来自 `src/state-acl.mjs`，不能在这里另抄一份：这里曾经抄的是
          // `icacls DIR /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T /C` —— 正是那句
          // 会把子文件 DACL 清空、让桥接读不到自己令牌的破坏性命令。示例数据是给人照抄的，
          // 抄错的那一版和真的那一版看起来一模一样。
          case '/api/security': return json({
            ok: true,
            security: state.security,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: 'D:\\demo\\qq-bridge\\state', manualCommand: '' }
              : { hardened: false, path: 'D:\\demo\\qq-bridge\\state', manualCommand: manualDirCommand('D:\\demo\\qq-bridge\\state') }
          });
          // 令牌与花费：全部为离线示例数据，不含任何真实用量。
          case '/api/tokens/summary': return json(usageSummaryFixture());
          case '/api/tokens/series': return json(usageSeriesFixture(url.searchParams.get('hours')));
          case '/api/tokens/turns': return json(usageTurnsFixture(url.searchParams.get('key')));
          case '/api/tokens/recent': return json({ ok: true, symbol: '¥', entries: usageRecentFixture() });
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/mode': state.mode = body.mode; state.closedAgentPreset = body.closedAgentPreset; return json({ ok: true, dshSynced: true });
          case '/api/role':
            if (body.key) {
              const next = { ...state.roleAssignments };
              if (body.role) next[body.key] = body.role; else delete next[body.key];
              state.roleAssignments = next;
              return json({ ok: true, key: body.key, role: body.role ?? null, assignments: next });
            }
            state.role = body.role;
            return json({ ok: true });
          case '/api/roles/create': state.roles.push(body.name); state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, warnings: [] });
          case '/api/roles/update': state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, chars: String(body.content ?? '').length, warnings: [] });
          case '/api/roles/rename': {
            const idx = state.roles.indexOf(body.from);
            if (idx >= 0) state.roles[idx] = body.to;
            state.roleContents[body.to] = state.roleContents[body.from] ?? '';
            delete state.roleContents[body.from];
            if (state.role === body.from) state.role = body.to;
            let assignmentsUpdated = 0;
            for (const [key, value] of Object.entries(state.roleAssignments)) {
              if (value === body.from) { state.roleAssignments[key] = body.to; assignmentsUpdated += 1; }
            }
            return json({ ok: true, role: body.to, renamed: true, currentFollowed: state.role === body.to, assignmentsUpdated });
          }
          case '/api/roles/delete': {
            const idx = state.roles.indexOf(body.name);
            if (idx >= 0) state.roles.splice(idx, 1);
            delete state.roleContents[body.name];
            const cleared = state.role === body.name;
            if (cleared) state.role = null;
            let assignmentsCleared = 0;
            for (const [key, value] of Object.entries(state.roleAssignments)) {
              if (value === body.name) { delete state.roleAssignments[key]; assignmentsCleared += 1; }
            }
            return json({ ok: true, deleted: body.name, clearedCurrent: cleared, assignmentsCleared });
          }
          case '/api/roles/limit': state.roleInjectMax = Number(body.maxInjectChars) || state.roleInjectMax; return json({ ok: true, maxInjectChars: state.roleInjectMax, limits: { injectMaxChars: state.roleInjectMax } });
          case '/api/preset/sim-prompt': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            const content = String(body.content ?? '');
            const unchanged = content === state.simPrompts[preset];
            if (!unchanged) state.simPrompts[preset] = content;
            return json({ ok: true, unchanged, chars: content.length, warnings: [], synced: true, requiresRestart: !unchanged, status: presetStatusFixture(preset) });
          }
          case '/api/preset/sim-prompt/restore': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, restoredFrom: `${preset}.agent.cordis.yml.fixture`, requiresRestart: true });
          }
          case '/api/dsh/effort': state.dshEffort = body.reasoningEffort; return json({ ok: true, reasoningEffort: body.reasoningEffort });
          case '/api/role-mode': state.roleMode = body.mode; return json({ ok: true });
          case '/api/whitelist': state.whitelist = body; return json({ ok: true });
          case '/api/social': state.social = body; return json({ ok: true });
          case '/api/social/state': state.socialStates[body.key] = { phase: body.phase }; return json({ ok: true });
          case '/api/socialV2/config': state.v2 = body; return json({ ok: true });
          case '/api/socialV2/activity': state.paused = body.paused; return json({ ok: true });
          case '/api/socialV2/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/socialV2/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/socialV2/reset': return json({ ok: true });
          case '/api/socialV2/initial-prompt': {
            const text = body.delete === true ? '' : String(body.text ?? '');
            state.initPrompt = text;
            return json({
              ok: true, key: body.key || '', deleted: !text, chars: text.length,
              exists: !!text, updatedAt: Date.now(), maxChars: 2000
            });
          }
          case '/api/slang/config': state.slangConfig = body; return json({ ok: true });
          case '/api/slang': state.slang.push({ ...body, id: `demo-${state.slang.length + 1}`, status: 'confirmed', source: 'manual', count: 1 }); return json({ ok: true });
          case '/api/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: 'D:\\demo\\qq-bridge\\state' });
            }
            state.security = body;
            return json({ ok: true });
          case '/api/console/token': return json({ ok: true, token: body.token || 'offline-demo-token-123456', generated: !body.token });
          case '/api/test-send': return json({ ok: true, message_id: 'mock-message-001' });
          // 语音试发（操作者通道）：离线只回执，不产生任何真实 QQ 消息
          case '/api/voice/send': return json(body.dryRun
            ? { ok: true, dryRun: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', verified: false }
            : { ok: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3', messageId: 9001, verified: true, limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 } });
          case '/api/console/notify-ai': return json({ ok: true, sessionId: 'mock-dsh-session' });
          case '/api/restart': return json({ ok: true, message: '离线预览：已模拟重启，实际服务未改变。' });
          case '/api/workspace/reset': state.sessions = []; return json({ ok: true, archivedCount: 3 });
          case '/api/session/reset': state.sessions = state.sessions.filter(x => x.key !== body.key); return json({ ok: true });
          case '/api/slang/extract': return json({ ok: true });
          case '/api/slang/research': return json({ ok: true, count: body.ids?.length || 1 });
          case '/api/slang/batch-confirm':
          case '/api/slang/batch-reject':
          case '/api/slang/batch-delete': {
            const ids = body.ids || [];
            if (path.endsWith('delete')) state.slang = state.slang.filter(x => !ids.includes(x.id));
            else state.slang.forEach(x => { if (ids.includes(x.id)) x.status = path.endsWith('confirm') ? 'confirmed' : 'rejected'; });
            return json({ ok: true, count: ids.length, confirmed: ids.length, rejected: ids.length, deleted: ids.length });
          }
          case '/api/social/flush':
          case '/api/socialV2/wake':
          case '/api/socialV2/memory-clear':
          case '/api/socialV2/memory-update':
          case '/api/socialV2/memory-remove': return json({ ok: true });
          case '/api/tokens/reset': return json({ ok: true });
        }
      }
      const slangMatch = path.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
      if (slangMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
        const entry = state.slang.find(x => x.id === slangMatch[1]);
        if (!entry) return json({ ok: false, error: '演示词条不存在' }, 404);
        if (method === 'DELETE') state.slang = state.slang.filter(x => x !== entry);
        else Object.assign(entry, body, slangMatch[2] ? { status: slangMatch[2] === 'confirm' ? 'confirmed' : 'rejected' } : {});
        return json({ ok: true });
      }
      unknownRequests.push({ method, path });
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), original: args.includes('--original'), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
