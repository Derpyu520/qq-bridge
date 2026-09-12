// 端到端指令测试：用「假 OneBot 网关」驱动真实 bridge，验证 QQ 指令在本地被正确响应。
//
// 为什么需要它：单测只能覆盖纯函数，跑不了 bridge.js 里的闭包。这个脚本假装自己是
// SnowLuma（WS 3001 + HTTP 3002），把伪造的群消息推进去，再看 bridge 发回什么。
// 因为 @snowluma/sdk 用的是 Node 内置 WebSocket（无 ws 依赖），这里手写了一个最小 WS 服务端。
//
// 覆盖：指令解析/权限/限频、机器人名册（is_robot）、引用+@ 发送链路。
// 前置：3001/3002 必须空闲（真 SnowLuma 未运行）；DSH Web 需在 3080。
// 运行：node scripts/test-e2e-qq-commands.mjs
//
// 安全：运行前备份 state/，结束后（含异常）自动还原，不会污染真实会话状态。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const WS_PORT = 3001;
const HTTP_PORT = 3002;
const CONSOLE_PORT = 3100;

const GROUP = '1079916653';
const OWNER = '1576307692';
const SELF = '3827514059';
const MEMBER = '900003';
const COOLDOWN_MS = Number(process.env.E2E_COOLDOWN_MS ?? 2000);

const FAKE_MEMBERS = [
  { user_id: 1576307692, nickname: 'Ricky', card: 'Ricky', role: 'owner', is_robot: false },
  { user_id: 3827514059, nickname: '小鲸鱼', card: '', role: 'member', is_robot: true },
  { user_id: 900001, nickname: '签到机器人', card: '', role: 'member', is_robot: true },
  { user_id: 900002, nickname: '点歌Bot', card: '', role: 'member', is_robot: true },
  { user_id: 900003, nickname: '路人甲', card: '', role: 'member', is_robot: false }
];

const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 WebSocket 服务端（仅文本帧 + ping/close） ─────────────────────────
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
    payload = out;
  }
  return { opcode, payload, totalLength: offset + len };
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function post(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ── 0. 备份 state ──────────────────────────────────────────────────────────
const backupDir = path.join(__dirname, '..', '.e2e-backup');
fs.rmSync(backupDir, { recursive: true, force: true });
fs.mkdirSync(backupDir, { recursive: true });
const stateBackup = new Map();
if (fs.existsSync(STATE)) {
  for (const name of fs.readdirSync(STATE)) {
    const src = path.join(STATE, name);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(backupDir, name);
    fs.copyFileSync(src, dst);
    stateBackup.set(name, dst);
  }
}
console.log(`已备份 ${stateBackup.size} 个 state 文件\n`);

// ── 1. 假 OneBot 网关 ─────────────────────────────────────────────────────
const sentMessages = [];
const seenActions = new Map();
const bump = (a) => seenActions.set(a, (seenActions.get(a) ?? 0) + 1);
/** 已知的"已投递到 bridge"的群消息，供 get_msg 回放 */
const deliveredMessages = new Map();

// bridge 有两条发送链路：sendToQQ 走 SDK/WebSocket，onebotSend 走 OneBot HTTP。
// 两条都要抓，否则会误判成"没有发送"。
function recordSend(channel, action, params) {
  sentMessages.push({
    channel, action,
    group_id: params.group_id,
    segments: (Array.isArray(params.message) ? params.message : []).map((s) => ({
      type: s?.type, text: s?.data?.text, qq: s?.data?.qq, id: s?.data?.id
    }))
  });
  return { message_id: 1000 + sentMessages.length };
}

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const action = req.url.replace(/^\//, '');
    bump(action);
    let params = {};
    try { params = JSON.parse(body); } catch {}
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      const data = recordSend('http', action, params);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: null }));
  });
});

let bridgeConn = null;
const wsServer = http.createServer();
const socketReady = new Promise((resolve) => {
  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', ''
    ].join('\r\n'));
    socket.setNoDelay(true);
    bridgeConn = {
      send(obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch {} },
      close() { try { socket.destroy(); } catch {} }
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.totalLength);
        if (frame.opcode === 0x8) { socket.destroy(); return; }
        if (frame.opcode === 0x9) { try { socket.write(encodeFrame(frame.payload, 0xA)); } catch {} continue; }
        if (frame.opcode !== 0x1) continue;
        let msg = null;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch {}
        if (!msg) continue;
        const action = String(msg.action ?? '');
        bump(action);
        if (action === 'send_group_msg' || action === 'send_private_msg') {
          const data = recordSend('ws', action, msg.params ?? {});
          bridgeConn.send({ status: 'ok', retcode: 0, data, echo: msg.echo });
          continue;
        }
        let data = null;
        if (action === 'get_login_info') data = { user_id: Number(SELF), nickname: '小鲸鱼' };
        else if (action === 'get_group_member_list') data = FAKE_MEMBERS;
        else if (action === 'get_group_member_info') {
          data = FAKE_MEMBERS.find((m) => String(m.user_id) === String(msg.params?.user_id)) ?? null;
        } else if (action === 'get_group_list') data = [{ group_id: Number(GROUP), group_name: '测试群' }];
        else if (action === 'get_msg') {
          const id = String(msg.params?.message_id ?? '');
          data = deliveredMessages.get(id) ?? null;
        }
        bridgeConn.send({ status: 'ok', retcode: 0, data, echo: msg.echo });
      }
    });
    socket.on('error', () => {});
    resolve(true);
  });
});

// ── 2. 启动真实 bridge ────────────────────────────────────────────────────
const logFd = fs.openSync(path.join(backupDir, 'bridge-e2e.log'), 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
  cwd: ROOT, stdio: ['ignore', logFd, logFd]
});
let childExited = false;
child.on('exit', (code) => { childExited = true; });

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (childExited) throw new Error(`bridge 提前退出（等待 ${label}）`);
    await sleep(200);
  }
  return false;
}

let msgSeq = 0;
function makeEvent({ userId, text, card, nickname }) {
  msgSeq += 1;
  const messageId = 700000 + msgSeq;
  const event = {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: messageId, group_id: Number(GROUP),
    user_id: Number(userId), self_id: Number(SELF),
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: nickname ?? String(userId), card: card ?? '', role: 'member' }
  };
  deliveredMessages.set(String(messageId), {
    message_id: messageId, group_id: Number(GROUP), user_id: Number(userId),
    real_id: messageId,
    sender: event.sender,
    message: [{ type: 'text', data: { text } }],
    raw_message: text
  });
  return event;
}

function pushGroupMessage(opts) {
  const event = makeEvent(opts);
  bridgeConn.send(event);
  return event.message_id;
}

function flatten(mine) {
  return mine.map((m) => {
    const prefix = m.segments.filter((s) => s.type === 'reply').length ? '[引用]' : '';
    const at = m.segments.filter((s) => s.type === 'at').map((s) => '@' + s.qq).join('');
    const body = m.segments.filter((s) => s.type === 'text').map((s) => s.text).join('');
    return `${prefix}${at}${body}`;
  }).join('\n');
}

async function expectReply(label, { userId, text, mustInclude = [], mustExclude = [], card, nickname, waitMs = 20000, gapMs = COOLDOWN_MS + 400 }) {
  if (gapMs > 0) await sleep(gapMs);
  const before = sentMessages.length;
  pushGroupMessage({ userId, text, card, nickname });
  const got = await waitFor(() => sentMessages.length > before, waitMs, label);
  if (!got) { record(label, false, `${waitMs / 1000} 秒内没有任何 QQ 发送`); return null; }
  await sleep(900);
  const mine = sentMessages.slice(before);
  const joined = flatten(mine);
  const missing = mustInclude.filter((k) => !joined.includes(k));
  const forbidden = mustExclude.filter((k) => joined.includes(k));
  if (missing.length || forbidden.length) {
    record(label, false, [
      missing.length ? `缺少 ${JSON.stringify(missing)}` : '',
      forbidden.length ? `不该出现 ${JSON.stringify(forbidden)}` : ''
    ].filter(Boolean).join('；') + `｜实发：${JSON.stringify(joined.slice(0, 220))}`);
    return { joined, mine };
  }
  record(label, true, JSON.stringify(joined.slice(0, 70)));
  return { joined, mine };
}

// ── 收尾（幂等：finally / 信号 / 异常退出 都会调） ────────────────────────
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { child.kill(); } catch {}
  try { bridgeConn?.close(); } catch {}
  try { wsServer.close(); } catch {}
  try { httpServer.close(); } catch {}
  sleepSync(1200); // 等 bridge 真正退出，避免它在我们还原之后再写一次 state
  try { fs.closeSync(logFd); } catch {}

  let restored = 0;
  for (const [name, backup] of stateBackup) {
    try { fs.copyFileSync(backup, path.join(STATE, name)); restored++; } catch {}
  }
  if (fs.existsSync(STATE)) {
    for (const name of fs.readdirSync(STATE)) {
      if (stateBackup.has(name)) continue;
      const p = path.join(STATE, name);
      try { if (fs.statSync(p).isFile() && (name.endsWith('.json') || name.endsWith('.log'))) fs.rmSync(p); } catch {}
    }
  }
  console.log(`\nstate 已还原（${restored} 个文件）`);
}

// 被中断也必须还原，否则会留下测试污染（上一轮就吃过这个亏）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}
process.on('uncaughtException', (err) => { console.error(err); cleanup(); process.exit(1); });

// ── 3. 跑用例 ─────────────────────────────────────────────────────────────
try {
  await new Promise((res, rej) => { httpServer.listen(HTTP_PORT, '127.0.0.1', res); httpServer.on('error', rej); });
  await new Promise((res, rej) => { wsServer.listen(WS_PORT, '127.0.0.1', res); wsServer.on('error', rej); });
  console.log(`假 OneBot 网关已就绪（WS ${WS_PORT} / HTTP ${HTTP_PORT}）`);

  const connected = await Promise.race([socketReady, waitFor(() => false, 40000, 'WS 连接').then(() => false)]);
  if (!connected) throw new Error('bridge 没有连上假网关（40 秒）');
  await sleep(3500);
  console.log('bridge 已连上假 OneBot 网关\n');

  record('bridge 启动未崩溃', !childExited);
  record('完成 get_login_info 握手', (seenActions.get('get_login_info') ?? 0) > 0);

  console.log('— 管理员指令 —');
  await expectReply('管理员 /帮助', { userId: OWNER, text: '/帮助', mustInclude: ['指令列表', '调机器人', '重置'] });
  await expectReply('管理员 /状态', { userId: OWNER, text: '/状态', mustInclude: ['【状态】', '运行模式', '主模型'] });
  await expectReply('管理员 /我是谁', { userId: OWNER, text: '/我是谁', mustInclude: [OWNER, '管理员'] });
  await expectReply('管理员 /机器人（走 is_robot 名册）', {
    userId: OWNER, text: '/机器人',
    mustInclude: ['签到机器人', '点歌Bot', 'is_robot'], mustExclude: ['路人甲']
  });
  await expectReply('管理员 /模型（查看）', { userId: OWNER, text: '/模型', mustInclude: ['主模型', '切换'] });
  await expectReply('管理员 /ping', { userId: OWNER, text: '/ping', mustInclude: ['pong'] });

  console.log('\n— 群友权限 —');
  await expectReply('群友 /帮助 可用但看不到管理指令', {
    userId: MEMBER, text: '/帮助', nickname: '路人甲',
    mustInclude: ['指令列表', '部分管理指令仅管理员可用'], mustExclude: ['重置', '调机器人']
  });
  await expectReply('群友用管理指令被挡下', {
    userId: MEMBER, text: '/重置', nickname: '路人甲', mustInclude: ['仅管理员可用']
  });
  await expectReply('群友 /机器人 能看到名册，但看不到"调机器人"提示以外的管理指令', {
    userId: MEMBER, text: '/机器人', nickname: '路人甲',
    mustInclude: ['签到机器人'], mustExclude: ['仅管理员可用']
  });

  console.log('\n— 指令限频 —');
  {
    await sleep(COOLDOWN_MS + 400);
    const before = sentMessages.length;
    pushGroupMessage({ userId: OWNER, text: '/ping' });
    await sleep(400);
    pushGroupMessage({ userId: OWNER, text: '/我是谁' });
    await sleep(4000);
    const mine = sentMessages.slice(before);
    record('同一人连发被限频（只回第一条）', mine.length === 1,
      `实发 ${mine.length} 条：${JSON.stringify(flatten(mine).slice(0, 80))}`);
  }
  {
    await sleep(COOLDOWN_MS + 400);
    const before = sentMessages.length;
    pushGroupMessage({ userId: OWNER, text: '/ping' });
    pushGroupMessage({ userId: MEMBER, text: '/在吗', nickname: '路人甲' });
    await sleep(4000);
    const mine = sentMessages.slice(before);
    record('不同人各自独立限频（都能拿到回复）', mine.length === 2, `实发 ${mine.length} 条`);
  }

  console.log('\n— 引用 + @ 发送链路 —');
  const consoleToken = (() => {
    try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; }
  })();
  const consoleHeaders = consoleToken ? { 'x-console-token': consoleToken } : {};
  const modeRes = await post(CONSOLE_PORT, '/api/mode', { mode: 'reserved2' }, consoleHeaders);
  // 用户的真实状态里 AI 可能是"暂停"的（socialV2.paused=true），暂停时所有 v2 发送工具都会被拒；
  // 这里临时恢复运行，测试结束后 state 整体回滚。
  const activityRes = await post(CONSOLE_PORT, '/api/socialV2/activity', { paused: false }, consoleHeaders);
  await sleep(1200);
  // 切到 reserved2 后，普通消息会被写进 recentMessages，才有可引用的目标
  const quotedId = pushGroupMessage({ userId: MEMBER, text: '这是一条会被引用的原文', nickname: '路人甲' });
  await sleep(2500);
  await expectReply('（跳板）普通消息后仍能响应当前指令', {
    userId: OWNER, text: '/ping', mustInclude: ['pong'], gapMs: 0
  });

  let agentToken = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
    agentToken = raw?.conversations?.[`group:${GROUP}`]?.agentToken ?? null;
  } catch {}

  record('切到 reserved2 成功', modeRes.status === 200 && modeRes.json?.ok === true,
    `HTTP ${modeRes.status} ${JSON.stringify(modeRes.json).slice(0, 100)}`);

  if (!agentToken) {
    record('取到 reserved2 会话令牌', false, 'social-v2.json 里没有该群的 agentToken');
  } else {
    record('取到 reserved2 会话令牌', true, `token ${String(agentToken).slice(0, 8)}…`);
    const beforeBurst = sentMessages.length;
    const burst = await post(CONSOLE_PORT, '/api/socialV2/send-burst', {
      key: `group:${GROUP}`,
      messages: ['第一句带引用和@', '第二句是纯文本'],
      replyToMessageId: quotedId,
      atUserId: Number(MEMBER)
    }, { 'x-agent-token': agentToken, ...consoleHeaders });

    if (burst.status !== 200 || burst.json?.ok !== true) {
      const why = `HTTP ${burst.status} ${JSON.stringify(burst.json).slice(0, 160)}`;
      record('send-burst 不再拒绝引用（HTTP 200）', false, why);
      for (const label of ['第一条带 reply 段且 id 正确', '第一条带 @ 段且指向正确的人', '第二条不带引用/@（不重复打扰）', '响应回传 quoted（模型能看到引用了谁）']) {
        record(label, false, '前置失败，跳过');
      }
    } else {
      await sleep(600);
      const mine = sentMessages.slice(beforeBurst);
      const first = mine[0]?.segments ?? [];
      const second = mine[1]?.segments ?? [];
      record('send-burst 不再拒绝引用（HTTP 200）', true, `实发 ${mine.length} 条`);
      record('第一条带 reply 段且 id 正确',
        first.some((s) => s.type === 'reply' && String(s.id) === String(quotedId)), JSON.stringify(first));
      record('第一条带 @ 段且指向正确的人',
        first.some((s) => s.type === 'at' && String(s.qq) === MEMBER), JSON.stringify(first));
      record('第二条不带引用/@（不重复打扰）',
        second.length > 0 && !second.some((s) => s.type === 'reply' || s.type === 'at'), JSON.stringify(second));
      record('响应回传 quoted（模型能看到引用了谁）',
        !!burst.json?.quoted, JSON.stringify(burst.json?.quoted ?? null));
    }
  }

  console.log('\n— 不应被指令劫持 —');
  {
    await sleep(COOLDOWN_MS + 400);
    const before = sentMessages.length;
    pushGroupMessage({ userId: MEMBER, text: '今天天气不错', nickname: '路人甲' });
    await sleep(3000);
    const chatted = flatten(sentMessages.slice(before));
    record('普通聊天不被指令路由截胡',
      !chatted.includes('指令列表') && !chatted.includes('仅管理员可用'),
      chatted ? `（走了 AI 路径：${JSON.stringify(chatted.slice(0, 40))}）` : '（AI 未抢占回复）');
  }

  record('bridge 全程未崩溃', !childExited);

  console.log('\n假网关收到的 OneBot 动作：');
  for (const [action, n] of [...seenActions.entries()].sort()) console.log(`  ${action} × ${n}`);
} catch (error) {
  record('测试执行', false, error?.message ?? String(error));
} finally {
  cleanup();
  console.log('\n' + results.join('\n'));
  console.log(`\n通过 ${results.length - failures} / ${results.length}${failures ? '，有失败' : '，全部通过'}`);
  console.log(`bridge 日志：${path.join(backupDir, 'bridge-e2e.log')}`);
  process.exit(failures ? 1 : 0);
}
