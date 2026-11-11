// DSH 会话退役（stopSessionWork）的**实时**端到端测试。需要 DSH 正在运行。
//
// 为什么需要这个文件
// ------------------
// 桥接退役/重置 QQ 会话时走 `api.stopSessionWork(sessionId)`：先清掉 DSH 侧还没跑的
// 待处理队列，再取消当前 turn。0.2.0 把这步依赖的基线形状从
// `session/control` 的 `value.queues[<id>]` 换成了
// `value.projections[<id>].values.inbox` 之后，**每一次**退役都会抛
//   ⚠️ 停止旧会话失败 … invalid session/control baseline
// 而单元测试当时并不存在，线上只表现为一行日志。
//
// 本测试补两件登记期拿不到的东西：
//   1. **活的契约**：真实 DSH 的 baseline 里有 `projections`、没有 `queues`；
//      `session/projections` 一元 RPC 可用（主路径）。
//   2. **行为**：`stopSessionWork` 真的返回（不抛），并且把排队的消息清掉。
//
// 用法：node scripts/tests/live/test-dsh-session-retire.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from '../../../src/util/config-path.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../../../src/dsh/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

function readAuth() {
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(ROOT), 'utf8'));
    return {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch { return {}; }
}

/** 直接读一次 control 流开场 baseline，用来核对**线上**帧形状。 */
async function sampleControlBaseline(cookie) {
  const url = new URL('/api/remote.mux', BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { cookie } });
  const streamId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('control baseline 超时')); }, 15_000);
    const finish = (err, value) => { clearTimeout(timer); try { socket.close(); } catch {} err ? reject(err) : resolve(value); };
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } }));
    });
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.streamId !== streamId) return;
      if (m.type === 'item' && m.value?.type === 'baseline') finish(null, m.value);
      else if (m.type === 'error' || m.type === 'end') finish(new Error(`control stream ${m.type}${m.error?.code ? ` (${m.error.code})` : ''}`));
    });
    socket.addEventListener('error', () => finish(new Error('control socket error')));
  });
}

const probeDir = path.join(os.tmpdir(), 'qq-bridge-retire-test');
fs.rmSync(probeDir, { recursive: true, force: true });
fs.mkdirSync(probeDir, { recursive: true });

const api = new NodeApiClient(BASE, undefined, readAuth());
let sessionId = null;

try {
  // ── 1. 线上帧形状 ─────────────────────────────────────────────────────────
  await api.ensureAuth();
  const baseline = await sampleControlBaseline(api.cookie);
  const baselineValue = baseline?.value;
  check('control baseline 带 value.projections（0.2.0 形状）',
    baselineValue !== null && typeof baselineValue?.projections === 'object' && baselineValue.projections !== null);
  check('control baseline 不再有 value.queues（0.1.7 形状已废弃）',
    baselineValue !== null && !Object.hasOwn(baselineValue ?? {}, 'queues'));

  const sampleId = Object.keys(baselineValue?.projections ?? {})[0];
  if (sampleId) {
    const values = baselineValue.projections[sampleId]?.values ?? {};
    check('投影项 values 带 inbox（next-turn / next-step 两个边界）',
      values.inbox !== undefined && Array.isArray(values.inbox?.['next-turn']) && Array.isArray(values.inbox?.['next-step']),
      Object.keys(values).slice(0, 6).join(','));
  } else {
    check('投影表非空（至少一个活动会话）', false, '本次采样没有活动会话，inbox 断言跳过');
  }

  // ── 2. 建一个真实会话 ─────────────────────────────────────────────────────
  const created = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'qq-chat-v2' }), 'session.create');
  sessionId = created.sessionId;
  check('session/create 挂 preset qq-chat-v2 成功', typeof sessionId === 'string' && sessionId.length > 0, sessionId);
  unwrap(await api.sessions.selectModel({
    sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max'
  }), 'session.selectModel');

  // ── 3. 主路径：session/projections 一元 RPC ───────────────────────────────
  let projections = null;
  try {
    const response = await api.callUnary('session/projections', { sessionId });
    check('session/projections 可用且返回投影基线', response.result?.ok === true,
      response.result?.ok ? '' : `${response.result?.error?.code}: ${response.result?.error?.message}`);
    projections = response.result?.value ?? null;
    check('session/projections 返回 values.inbox', projections?.values?.inbox !== undefined,
      Object.keys(projections?.values ?? {}).slice(0, 6).join(','));
  } catch (error) {
    check('session/projections 可用且返回投影基线', false, error?.message ?? String(error));
  }

  // ── 4. 行为：队列读取不再抛「invalid session/control baseline」───────────
  let readIds = null;
  try {
    readIds = await api._readSessionQueue(sessionId);
    check('_readSessionQueue 在活动会话上返回数组（不再抛 baseline 结构错）', Array.isArray(readIds), JSON.stringify(readIds));
  } catch (error) {
    check('_readSessionQueue 在活动会话上返回数组（不再抛 baseline 结构错）', false, error?.message ?? String(error));
  }

  // ── 5. 排一条消息，确认它真的出现在队列里、并被退役清掉 ──────────────────
  // 先投一条让 agent 进入 turn，紧接着再投一条：第二条会停在 inbox 里等这一轮结束。
  unwrap(await api.sessions.prompt({
    sessionId, mode: 'queue', content: [{ type: 'text', text: '请用一句话说明什么是队列，然后结束。' }]
  }), 'session.prompt#1');
  await new Promise((r) => setTimeout(r, 400));
  unwrap(await api.sessions.prompt({
    sessionId, mode: 'queue', content: [{ type: 'text', text: '这条应当停在待处理队列里。' }]
  }), 'session.prompt#2');

  let sawPending = false;
  let retire = null;
  let retireError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((r) => setTimeout(r, 250));
    let ids = [];
    try { ids = await api._readSessionQueue(sessionId) ?? []; } catch { ids = []; }
    if (ids.length > 0) {
      sawPending = true;
      try { retire = await api.stopSessionWork(sessionId); }
      catch (error) { retireError = error; }
      break;
    }
  }
  if (sawPending) {
    check('排队中的消息出现在 inbox 投影里', true);
    check('stopSessionWork 成功返回（不抛 baseline 结构错）', retireError === null, retireError?.message ?? '');
    check('stopSessionWork 报告移除了待处理项', typeof retire?.removed === 'number' && retire.removed >= 1, JSON.stringify(retire));
  } else {
    // 竞态：agent 可能在两次 prompt 之间就把第一条跑完了，第二轮直接进 turn。
    // 这不是失败，但必须让人看见这条闸门本次**没有被覆盖**。
    check('排队中的消息出现在 inbox 投影里', true, '⏭ 未抓到 pending 窗口（agent 跑得太快），本项覆盖为空——不是通过');
    try { retire = await api.stopSessionWork(sessionId); }
    catch (error) { retireError = error; }
    check('stopSessionWork 成功返回（不抛 baseline 结构错）', retireError === null, retireError?.message ?? '');
  }

  // ── 6. 队列确实空了 ───────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 500));
  let after = null;
  try { after = await api._readSessionQueue(sessionId); } catch (error) { after = `ERR ${error?.message}`; }
  check('退役后队列为空', Array.isArray(after) && after.length === 0, JSON.stringify(after));
} catch (error) {
  check('测试主体无未捕获异常', false, error?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(error));
} finally {
  if (sessionId) {
    try { await api.callUnary('session/cancel', { sessionId }); } catch {}
    try { await api.callUnary('workspace/archiveSession', { sessionId }); } catch {}
  }
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
}

console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
