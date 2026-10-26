// 第五阶段验收：用户方案里列的 13 条，逐条过。
//
// 能在这个进程里自证的（A1/A2/A3/A4/A6/A12）跑真的断言；需要真 DSH、真 QQ、真进程
// 生命周期的（A5/A7/A8/A9/A10/A11/A13）标 MANUAL，并写明证据落在哪 —— 那些已经
// 在别的地方验过了，这里不假装重跑一遍。
//
// 用法：node scripts/verify-acceptance.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = [];

async function check(id, name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    rows.push({ id, name, status: 'PASS', detail: detail ?? '', ms: Date.now() - started });
  } catch (error) {
    rows.push({ id, name, status: 'FAIL', detail: error?.message ?? String(error), ms: Date.now() - started });
  }
}

function manual(id, name, evidence) {
  rows.push({ id, name, status: 'MANUAL', detail: evidence, ms: 0 });
}

const message = (over = {}) => ({
  self_id: 999,
  user_id: 777,
  sender: { card: '老王', nickname: '老王' },
  ...over,
});

const textMsg = (text, { id, seq, group = 456 } = {}) => message({
  group_id: group,
  message_id: id,
  message_seq: seq,
  message: [{ type: 'text', data: { text } }],
});

const atMsg = (text, { id, seq, group = 456 } = {}) => message({
  group_id: group,
  message_id: id,
  message_seq: seq,
  message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }],
});

// 只在指定群生效的唤醒策略。默认全关 + 概率 0：概率唤醒会让验收变成 flaky 的。
const QUIET = {
  batchWindowMs: 1000,
  triggers: {
    atMention: false, nameMention: false, question: false, keywords: [],
    anyMessage: false, poke: false, speakerIds: [], probability: 0,
  },
};

// 第一次进群时桥会主动投递一次「初始提示词」（lastWakeReason=bootstrap）。验收要看的
// 是「有人说话之后会不会被叫醒」，所以先把这一枪标记成已发，否则每条用例都被它污染。
function skipBootstrap(h, key) {
  h.getSocialV2State(key).bootstrapSent = true;
}

// api.sessions.prompt 的 content 是 [{type:'text', text}] 数组，不是字符串。
function flatten(prompt) {
  const content = prompt?.content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
  return typeof content === 'string' ? content : '';
}

function setGroupWake(h, key, wake) {
  const groups = { ...(h.cfg.socialV2?.groups ?? {}) };
  groups[key] = { wake };
  h.cfg.socialV2 = { ...(h.cfg.socialV2 ?? {}), groups };
}

function callPort(port, pathname, { token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' };
    if (token) headers['x-agent-token'] = token;
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end();
  });
}

// ── A1 普通群消息不会调用 DSH ────────────────────────────────────────────────
await check('A1', '普通群消息不会调用 DSH', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', QUIET);
    skipBootstrap(h, 'group:456');
    for (let i = 1; i <= 5; i += 1) {
      await h.handleIncoming('group', '456', textMsg(`随便聊聊 ${i}`, { id: 20000 + i, seq: 700 + i }), h.cfg);
    }
    await sleep(1500);
    assert.equal(h.calls.prompts.length, 0, `普通消息不该产生 sessions.prompt，实际 ${h.calls.prompts.length}`);
    assert.equal(h.getSocialV2State('group:456').unread.length, 5, '五条都该进未读');
    return '5 条普通消息 → prompts 0 / unread 5';
  } finally { await h.close(); }
});

// ── A2 @ 触发能带上上下文投递 ────────────────────────────────────────────────
await check('A2', '@ 触发能带上上下文投递', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', { ...QUIET, triggers: { ...QUIET.triggers, atMention: true } });
    skipBootstrap(h, 'group:456');
    await h.handleIncoming('group', '456', atMsg(' 今天吃什么', { id: 21001, seq: 801 }), h.cfg);
    await sleep(1800);
    assert.equal(h.calls.prompts.length, 1, `应该投递一次，实际 ${h.calls.prompts.length}`);
    const content = flatten(h.calls.prompts[0]);
    assert.match(content, /今天吃什么/, '投递内容里要带上这条消息');
    assert.match(String(h.calls.prompts[0]?.sessionId ?? ''), /^fixture-/, '要投到该群的会话上');
    return `1 次投递 / ${content.length} 字 / 含原文`;
  } finally { await h.close(); }
});

// ── A3 连续多条触发消息合并 ──────────────────────────────────────────────────
await check('A3', '连续多条触发消息合并成一次投递', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', { ...QUIET, triggers: { ...QUIET.triggers, atMention: true } });
    skipBootstrap(h, 'group:456');
    const st = h.getSocialV2State('group:456');

    // 合并的本体在 scheduleWakeV2：窗口内已有待发唤醒，就只升级原因、不重排定时器。
    // 这里不直接调它（它是 main() 里的闭包，harness 只展开文件顶层符号），改为观察
    // st.pendingWakeTimer 这个句柄：三条连发期间它必须一直是同一个。
    await h.handleIncoming('group', '456', atMsg('第1句', { id: 22001, seq: 901 }), h.cfg);
    const timer = st.pendingWakeTimer;
    assert.ok(timer, '第一条 @ 应该排上一次唤醒');
    await h.handleIncoming('group', '456', atMsg('第2句', { id: 22002, seq: 902 }), h.cfg);
    await h.handleIncoming('group', '456', atMsg('第3句', { id: 22003, seq: 903 }), h.cfg);
    assert.equal(st.pendingWakeTimer, timer, '合并窗口内不该重排定时器');
    await sleep(1600);
    assert.equal(h.calls.prompts.length, 1, `三次 @ 只该投一次，实际 ${h.calls.prompts.length}`);
    assert.equal(st.unread.length, 3, '三条都该进未读，一起交给上下文');
    return '窗口内只立一个定时器并升级原因 / 3 条 @ 只投递 1 次 / 未读 3';
  } finally { await h.close(); }
});

// ── A4 相同消息不会重复触发 ──────────────────────────────────────────────────
await check('A4', '相同消息不会重复触发', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', QUIET);
    skipBootstrap(h, 'group:456');
    const once = atMsg(' 同一句', { id: 23001, seq: 950 });
    await h.handleIncoming('group', '456', once, h.cfg);
    await h.handleIncoming('group', '456', { ...once }, h.cfg);
    await h.handleIncoming('group', '456', { ...once, message_id: undefined }, h.cfg); // 只带同一个 seq
    await sleep(1200);
    assert.equal(h.getSocialV2State('group:456').unread.length, 1, '同一 message_id/seq 只该落一条');
    assert.equal(h.calls.prompts.length, 0, '重复投递不该产生任何 DSH 调用');
    return '同一条三次到达 → unread 1 / prompts 0';
  } finally { await h.close(); }
});

// ── A6 AI 工具只能读授权群的历史 ─────────────────────────────────────────────
await check('A6', 'AI 工具只能读取授权群的历史', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', QUIET);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const token = h.getSocialV2State('group:456').agentToken;
    const own = await callPort(port, '/api/socialV2/recent?key=group%3A456&limit=5', { token });
    assert.equal(own.status, 200, `读自己群该放行，实际 ${own.status} ${own.body}`);
    const other = await callPort(port, '/api/socialV2/recent?key=group%3A789&limit=5', { token });
    assert.notEqual(other.status, 200, '拿 456 的令牌读 789 必须被拒');
    await new Promise((resolve) => server.close(resolve));
    return `本群 200 / 越权 ${other.status}`;
  } finally { await h.close(); }
});

// ── A12 大量群消息不会让队列和缓存无限增长 ──────────────────────────────────
await check('A12', '大量群消息不会让队列和缓存无限增长', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    setGroupWake(h, 'group:456', QUIET);
    for (let i = 1; i <= 300; i += 1) {
      await h.handleIncoming('group', '456', textMsg(`刷屏 ${i}`, { id: 30000 + i, seq: 1000 + i }), h.cfg);
    }
    const st = h.getSocialV2State('group:456');
    assert.ok(st.unread.length <= 200, `未读要有上限，实际 ${st.unread.length}`);
    assert.ok(st.recentMessages.length <= 200, `最近消息要有上限，实际 ${st.recentMessages.length}`);
    assert.ok((st.pendingWakeReasons?.length ?? 0) <= 20, `待唤醒原因要有界，实际 ${st.pendingWakeReasons?.length}`);
    assert.ok((st.wakeTimes?.length ?? 0) <= 100, `唤醒时间戳要有界，实际 ${st.wakeTimes?.length}`);
    return `300 条 → unread ${st.unread.length} / recent ${st.recentMessages.length} / pending ${st.pendingWakeReasons?.length ?? 0}`;
  } finally { await h.close(); }
});

// ── 需要真机的那几条 ────────────────────────────────────────────────────────
manual('A5', '每群绑定正确的 DSH 会话', 'state/sessions.json 里 group:681528723 → session-5e4ae458…，键是 convKey(kind,id)，每个群独立一条；真机 /api/sessions 已核对');
manual('A7', 'DSH 地址变化后可以恢复', 'src/qq/bridge.ts 的 syncBridgeBaseUrl() 改 dsh.baseUrl 后按需重启，supervisor 用 dshReady 判存活；本机端口 3100 与 DSH 6934 均在线');
manual('A8', 'Bridge 异常退出后按策略重启', '真机实测：taskkill /F 后 3 秒探测失败、12 秒内自动拉起，restartsInWindow=1、新 pid');
manual('A9', 'QQ 断连不会导致无意义的反复重启', 'supervisor 只认 /api/status 的 200 与 dshReady，QQ 掉线时 status 仍 200 → state 保持 healthy，start 调用 0 次（tests/qqSupervisor.test.ts 的 dshReady=false 用例同构）');
manual('A10', '插件关闭后不会重新启动 Bridge', 'supervisor.stop() 清定时器；插件 unload 走 lifeCtx.effect 的清理函数；停止按钮走 POST /api/stop 写 intent=stopped，巡检看到 stopped 不再拉起（真机已验）');
manual('A11', '恢复上限生效', 'tests/qqSupervisor.test.ts：maxRestartsPerWindow=2 时连续失败 9 次后 state=failed、start 只被调 2 次');
manual('A13', '进程重启后能够正确处理未完成任务', 'unread 与未读水位落在 state/social-v2.json，重启后接上；长历史落 state/history.db，/api/socialV2/recent 能从库里补更早的消息；内存里的 promptQueues 重启即清空（不重放，避免重复回复）');

// ── 汇总 ────────────────────────────────────────────────────────────────────
const pad = (text, width) => String(text).padEnd(width, ' ');
console.log('');
console.log(`${pad('编号', 6)}${pad('结果', 8)}${pad('耗时', 8)}验收项`);
for (const row of rows) {
  console.log(`${pad(row.id, 6)}${pad(row.status, 8)}${pad(row.ms ? `${row.ms}ms` : '-', 8)}${row.name}`);
  if (row.detail) console.log(`      └ ${row.detail}`);
}

const failed = rows.filter((row) => row.status === 'FAIL');
const passed = rows.filter((row) => row.status === 'PASS');
const pending = rows.filter((row) => row.status === 'MANUAL');
console.log('');
console.log(`自动通过 ${passed.length} 条，失败 ${failed.length} 条，需真机 ${pending.length} 条（共 ${rows.length} 条）`);
if (failed.length) process.exitCode = 1;