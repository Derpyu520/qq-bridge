// 事件流重连回归测试：DSH 重启 / WS 断开后，**已有会话必须被重新 follow**。
//
// 背景（真实缺陷，已修）：旧实现把「待 follow 队列」放在每次连接里，只在 handleOpen
// 排空一次。DSH 重启或任何 WS 中断会重建 generator，队列已空 → 一个会话都不 follow，
// 而 session 事件只由 session/follow 逻辑流推送（$events 的 allowlist 不含
// session/event）。后果：prompt 被接受、ackMessage 也发了，然后**永远没有回复**，
// 且没有任何报错——QQ 上表现为「新人能聊、老会话集体失联」。
//
// 本测试用假 WebSocket 精确控制 open/close，不需要真实 DSH、不发任何网络请求。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frames = [];
const sockets = [];

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.readyState = FakeWebSocket.CONNECTING;
    this._listeners = new Map();
    sockets.push(this);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  send(data) { frames.push({ socket: this, frame: JSON.parse(data) }); }
  close() { this.readyState = FakeWebSocket.CLOSED; this._emit('close', {}); }
  _emit(type, ev) { for (const fn of this._listeners.get(type) ?? []) fn(ev); }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this._emit('open', {}); }
}
const { NodeApiClient, setWebSocketImplementation } = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);
setWebSocketImplementation(FakeWebSocket);
const client = new NodeApiClient('http://127.0.0.1:3080', undefined, {});
// 不走真实鉴权：本测试只关心 follow 的重放行为。
client.ensureAuth = async () => { client.cookie = 'test-cookie'; };

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const startStream = () => {
  const stream = client.events.mux({}, undefined, () => {});
  const it = stream[Symbol.asyncIterator]();
  (async () => { try { for await (const _ of it) { /* drain */ } } catch { /* ignore */ } })();
  return stream;
};
const followsOn = (socket) => frames
  .filter((f) => f.socket === socket && f.frame.endpoint === 'session/follow')
  .map((f) => f.frame.payload.args.request.address.sessionId);

let failed = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

// 连接 1：follow 一个已有会话
const s1 = startStream();
await tick();
sockets[0].simulateOpen();
await tick();
s1.follow('session-AAA');
await tick();
check('首连即 follow 目标会话', followsOn(sockets[0]).includes('session-AAA'), `[${followsOn(sockets[0]).join(', ')}]`);
check('$events 附加流已打开', frames.some((f) => f.socket === sockets[0] && f.frame.endpoint === '$events'));

// 模拟 DSH 重启 / WS 断开
sockets[0].close();
await tick(60);

// 连接 2：重连（bridge.js 的 for(;;) 会重建 generator）
startStream();
await tick();
sockets[1].simulateOpen();
await tick(60);
check('重连后重放了已有会话的 follow', followsOn(sockets[1]).includes('session-AAA'), `[${followsOn(sockets[1]).join(', ')}]`);

console.log(failed === 0 ? '\n✅ 事件流重连回归测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
