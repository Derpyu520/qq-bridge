// CodeQL 边界回归：真实定时函数配假时钟，真实 HTTP handler 配临时配置与假 DSH。
// 不读取生产配置、不连接 QQ/DSH、不执行外部程序。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `missing bridge section: ${from}`);
  return source.slice(start, end);
};

function timerFixture(random = 0) {
  const timers = [];
  const st = { wakeConfig: {}, recentMessages: [], lastIncomingAt: Date.now() };
  const math = Object.create(Math);
  math.random = () => random;
  const context = vm.createContext({
    Math: math, Date, Number, Promise,
    cfg: { socialV2: { proactive: {} } },
    currentMode: 'reserved2', socialV2: { paused: false },
    social: { pendingTimers: new Map() },
    getSocialV2State: () => st,
    isSessionAllowedInCurrentMode: () => true,
    isConversationBusyV2: () => false,
    cancelReplyCheckV2: () => {},
    ensureWakeableV2: () => {},
    wakePriorityV2: () => 1,
    log() {},
    sendWakePromptV2: async () => {}, deliverPrompt: async () => {},
    randInt: (min, max) => Math.min(min, max),
    setTimeout(fn, ms) {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  vm.runInContext([
    section('function boundedTimerDelay(', 'const convKey ='),
    section('  function scheduleSocialReply(', '  // 全局扫描'),
    section('  function scheduleReplyCheckV2(', '  /** 会话此刻算忙'),
    section('  function scheduleWakeV2(', '  /**\n   * 回合结束后补发'),
    section('  function scheduleProactiveCheckV2(', '  function clearSocialV2Timers('),
    'globalThis.fns = { sleep, scheduleSocialReply, scheduleReplyCheckV2, scheduleWakeV2, scheduleProactiveCheckV2 };',
  ].join('\n'), context);
  return { ...context.fns, cfg: context.cfg, st, timers };
}

const latestDelay = (h) => h.timers.at(-1).ms;
const runTimerCases = () => {
  const defaults = timerFixture();
  void defaults.sleep(300);
  assert.equal(latestDelay(defaults), 300);
  defaults.scheduleSocialReply('group:456', 'fixture', 2000, 8000, 'fixture');
  assert.equal(latestDelay(defaults), 2000);
  defaults.scheduleReplyCheckV2('group:456');
  assert.equal(latestDelay(defaults), 30000);
  defaults.st.replyCheckTimer = null;
  defaults.scheduleWakeV2('group:456', 'atMention');
  assert.equal(latestDelay(defaults), 8000);
  defaults.scheduleProactiveCheckV2('group:456');
  assert.equal(latestDelay(defaults), 1800000);
  console.log('PASS normal timer defaults remain unchanged');

  for (const zero of [0, '0']) {
    const h = timerFixture(0.5);
    h.cfg.socialV2.autoReplyCheckMs = zero;
    h.scheduleReplyCheckV2('group:456');
    assert.equal(latestDelay(h), 30000, 'zero reply-check delay must retain its default meaning');
    h.st.replyCheckTimer = null;
    h.st.wakeConfig.batchWindowMs = zero;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.equal(latestDelay(h), 8000, 'zero batching delay must retain its default meaning');
    h.cfg.socialV2.proactive = { checkIntervalMinMs: zero, checkIntervalMaxMs: zero };
    h.scheduleProactiveCheckV2('group:456');
    assert.equal(latestDelay(h), 3600000, 'zero proactive min/max must retain the default 30–90 minute range');
  }
  console.log('PASS numeric and string zero preserve the original default intervals');

  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 2 ** 31, -1, 0, 'Infinity', 'bad']) {
    const h = timerFixture();
    void h.sleep(value);
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 0 && latestDelay(h) <= 86400000);
    h.scheduleSocialReply('group:456', 'fixture', value, value, 'fixture');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 0 && latestDelay(h) <= 86400000);
    h.cfg.socialV2.autoReplyCheckMs = value;
    // 两次回复检查加成也不能把已限幅的数值再次推到上界之外。
    h.st.recentMessages = Array.from({ length: 3 }, () => ({ isSelf: true, time: Date.now(), text: '?' }));
    h.scheduleReplyCheckV2('group:456');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 1000 && latestDelay(h) <= 86400000);
    h.st.replyCheckTimer = null;
    h.st.wakeConfig.batchWindowMs = value;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 1000 && latestDelay(h) <= 3600000);
    const count = h.timers.length;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.equal(h.timers.length, count, 'a pending wake must be coalesced');
    h.cfg.socialV2.proactive = { checkIntervalMinMs: value, checkIntervalMaxMs: value };
    h.scheduleProactiveCheckV2('group:456');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 60000 && latestDelay(h) <= 86400000);
    h.timers.at(-1).fn();
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 60000 && latestDelay(h) <= 86400000,
      'recurring proactive checks must never rearm as a 1ms overflow loop');
  }
  console.log('PASS malformed and overflowing delays stay finite and bounded at every scheduler');
};

function request(port, pathname, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

runTimerCases();
const trustedFfmpeg = 'fixture-local-ffmpeg';
const h = await bridgeHarness({
  config: { socialV2: { voice: { ffmpegPath: trustedFfmpeg, defaultVolume: 1 } } },
  globals: { inspectAudio: async () => ({ ok: true, size: 512, duration: 1, codec: 'mp3', warnings: [] }) },
});
const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
try {
  const rejected = await request(port, '/api/socialV2/config', { voice: { ffmpegPath: 'remote-selected-program', defaultVolume: 2 } });
  assert.equal(rejected.status, 400);
  assert.equal(h.voiceCfg().ffmpegPath, trustedFfmpeg);
  assert.equal(h.cfg.socialV2.voice.defaultVolume, 1, 'rejection must be atomic');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.voice.ffmpegPath, trustedFfmpeg);

  const saved = await request(port, '/api/socialV2/config', { voice: { defaultVolume: 2, maxSeconds: 45 } });
  assert.equal(saved.status, 200);
  assert.equal(h.cfg.socialV2.voice.defaultVolume, 2);
  assert.equal(h.voiceCfg().ffmpegPath, trustedFfmpeg);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.voice.ffmpegPath, trustedFfmpeg);
  console.log('PASS HTTP voice settings cannot select executables and preserve local executable configuration');

  const secret = `Error: private failure at ${path.join(h.temp, 'private.txt')}\n    at privateFunction (private.js:42:1)`;
  h.api.sessions.prompt = async () => { throw new Error(secret); };
  const failed = await request(port, '/api/console/notify-ai', { key: 'group:456', message: 'fixture' });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error, '操作失败，请查看本机 state/bridge.log 排查。');
  assert.ok(!failed.text.includes(h.temp) && !failed.text.includes('privateFunction'));
  const log = fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8');
  assert.ok(log.includes('private failure') && log.includes('privateFunction'), 'operator diagnostics must remain in redacted local logs');

  const invalid = await request(port, '/api/socialV2/wake-config', {});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'key 不能为空');
  h.setReady(false);
  const unavailable = await request(port, '/api/console/notify-ai', { key: 'group:456', message: 'fixture' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error, 'DSH 当前不可用，请稍后再试');
  console.log('PASS internal errors stay in local logs while validation errors remain actionable');

  h.setMode('reserved2');
  h.setReady(true);
  const st = h.getSocialV2State('group:456');
  st.recentMessages.push({ forwardIds: ['fixture-top-forward'] });
  h.bot.raw = async (action, { id }) => {
    assert.equal(action, 'get_forward_msg');
    if (id === 'fixture-top-forward') {
      return { messages: [{ message: [{ type: 'forward', data: { id: 'fixture-nested-forward' } }] }] };
    }
    throw new Error(secret.replace('private failure', 'nested-private failure'));
  };
  const forward = await request(port, '/api/socialV2/forward-message?key=group%3A456&id=fixture-top-forward', undefined, {
    method: 'GET', headers: { 'x-agent-token': st.agentToken },
  });
  assert.equal(forward.status, 200);
  assert.equal(forward.json.ok, true);
  assert.deepEqual(forward.json.nestedPreviews, [{ id: 'fixture-nested-forward', error: '嵌套转发读取失败' }]);
  assert.ok(!forward.text.includes(h.temp) && !forward.text.includes('privateFunction') && !forward.text.includes('nested-private failure'));
  assert.match(fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8'), /nested-private failure/);
  console.log('PASS successful forward responses also hide nested preview exceptions');

  h.cfg.socialV2.tools.sendVoice = true;
  Object.assign(h.cfg.socialV2.voice, { enabled: true, maxPerMinute: 1, maxPerHour: 10 });
  fs.mkdirSync(path.join(h.temp, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(h.temp, 'audio/budget.mp3'), Buffer.alloc(512, 1));
  for (const [pathname, body, headers] of [
    ['/api/voice/send', { target: 'group:456', file: 'budget.mp3', verify: false }, {}],
    ['/api/socialV2/send-voice', { key: 'group:456', voice: 'budget.mp3', verify: false }, { 'x-agent-token': st.agentToken }],
  ]) {
    const sent = await request(port, pathname, body, { headers });
    assert.equal(sent.status, 200, sent.text);
    const limited = await request(port, pathname, body, { headers });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, '语音发送频率超限（每分钟最多 1 条），请稍后再试');
  }
  console.log('PASS operator and agent voice limits retain their specific 429 retry guidance');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}
