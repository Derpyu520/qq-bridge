// 端到端验证：remote.mux 事件流 + turn 收集 + 工具调用事件形状。
// 只读观测：创建一个探测会话，注入一条简单 prompt，打印收到的事件类型与结构。
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

// 鉴权与 RPC 引导统一走 probe-auth.mjs（旧的「读 guard 日志抓 launch token」在
// DSH 0.1.7 起已失效，会让探针一律 401 —— 见该文件头部说明）。
const cookie = probeCookie();
const rpc = probeRpc(cookie);

const PRESET = process.argv[2] || 'qq-chat';
const PROMPT = process.argv[3] || '只回复两个字：收到';

const dir = probeWorkspaceDir('events');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`✅ session created with preset ${PRESET}: ${sessionId}`);

// 打开 remote.mux，follow 该会话，并开启 $events
const socket = probeMuxSocket(cookie);
const eventTypes = new Map();
let streamId = randomUUID();
let eventStreamId = randomUUID();
let gotText = '';
let turnEnd = null;
const frames = [];

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 90_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    console.log('   ws open; following session + $events');
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, activate: true } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    // 等流建立后再 prompt
    setTimeout(async () => {
      const p = await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: PROMPT }] } });
      console.log('   prompt:', JSON.stringify(p));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'error') { console.log('   ⚠ stream error:', JSON.stringify(m).slice(0, 300)); return; }
    if (m.type === 'end') { console.log('   stream end:', m.streamId === eventStreamId ? '$events' : 'session'); return; }
    if (m.type !== 'item') return;
    if (m.streamId === eventStreamId) {
      const v = m.value;
      if (v?.type === 'ready') console.log('   $events ready clientId=', String(v.clientId).slice(0, 12), 'host=', JSON.stringify(v.host));
      else frames.push(['$events:' + (v?.type ?? '?'), v?.event ?? '']);
      return;
    }
    const v = m.value;
    if (v?.type === 'event') {
      const et = v.event?.type ?? '?';
      eventTypes.set(et, (eventTypes.get(et) ?? 0) + 1);
      if (et === 'assistant/message') {
        for (const b of v.event.data?.message?.content ?? []) if (b?.type === 'text') gotText += b.text;
      }
      if (et === 'turn/end') { turnEnd = v.event.data; finish('done'); }
      if (et === 'tool/call' || et === 'tool/result') frames.push([et, JSON.stringify(v.event.data).slice(0, 260)]);
    } else if (v?.type === 'snapshot') frames.push(['snapshot', Object.keys(v).join(',')]);
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n=== 结果 (${why}) ===`);
console.log('assistant 文本:', JSON.stringify(gotText));
console.log('turn/end data:', JSON.stringify(turnEnd)?.slice(0, 300));
console.log('\n事件类型计数:');
for (const [k, n] of [...eventTypes].sort()) console.log(`   ${k} x${n}`);
console.log('\n其他帧:');
for (const f of frames.slice(0, 12)) console.log('   ', f.join(' | '));

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
console.log('\n[cleanup] session archived');
process.exit(0);
