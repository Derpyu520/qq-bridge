// Node 环境的 DSH Web API 客户端。
// 兼容 DSH 0.1.2-alpha.1 引入、并在 0.1.5-rc.1 上复核通过的协议：
// 1. RPC 方法从点号改为斜杠（host.describe -> host/describe 等）；
// 2. payload 包装为 { args: { <参数名>: 原payload } }（session/list 用 _request，其余多为 request）；
// 3. 新增浏览器会话鉴权：先用 dsh.authToken（进程启动 token）换取 Cookie，再带 Cookie 访问 API/WS；
// 4. 事件流不再是 events.mux 下行，而是 /api/remote.mux 上按 session/follow 打开的流，
//    Remote Event（提问/审批）走同一条 mux 上的 $events 逻辑流 + $events/result 回执。
// 复核记录（DSH 0.1.5-rc.1，逐项实测）：session/{list,create,prompt,selectModel,rename},
// workspace/{create,rename,archiveSession}, settings/describe, agentPresets/list 的参数形状与
// 返回结构均与本文件一致；session/prompt 在新版强制要求 requestId（wrapArgs 已自动补）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';

/** 从 DSH guard 日志里自动发现最新的进程启动 token（新版 DSH 打印在 dsh web URL 上）。 */
export function discoverDshLaunchToken() {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const logsDir = path.join(home, 'guard', 'logs');
    let files;
    try {
      files = fs.readdirSync(logsDir)
        .filter((name) => /^server-.*\.out\.log$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return '';
    }
    for (const { name } of files) {
      try {
        const text = fs.readFileSync(path.join(logsDir, name), 'utf8');
        const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
        if (match) return match[1];
      } catch {
        // 单个日志文件可能正被 DSH 占用/轮转，跳过继续看更早的日志。
      }
    }
  } catch {}
  return '';
}

/** 新协议 RPC 的 args 包装：旧 payload -> { <参数名>: payload }。 */
const METHOD_ARG_WRAPPERS = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/rename': 'request',
  'session/fork': 'request',
  'session/updateQueue': 'request',
  'session/page': 'request',
  'session/search': 'request',
  'session/follow': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/delete': 'request',
  'workspace/archiveSession': 'request',
  'workspace/insertBefore': 'request',
  'workspace/insertSessionBefore': 'request',
  'agentPresets/list': null,
  'settings/describe': null,
};

/** 点号方法名 -> 斜杠 endpoint。 */
function endpointOf(method) {
  return method.replace(/\./g, '/');
}

/** 把旧 payload 包装成新协议要求的 { args }，并补新版必填字段。 */
function wrapArgs(method, payload) {
  const endpoint = endpointOf(method);
  let body = payload ?? {};
  // 新版 SessionPromptRequest 强制要求 requestId。
  if (endpoint === 'session/prompt' && typeof body.requestId !== 'string') {
    body = { ...body, requestId: randomUUID() };
  }
  const wrapper = METHOD_ARG_WRAPPERS[endpoint];
  if (wrapper === null) return { args: {} };
  if (wrapper === undefined) return { args: body };
  return { args: { [wrapper]: body } };
}

// 鉴权交换供多个 RPC 共用；取消一个调用只停止它自己的等待，不中断其他调用。
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

export class NodeApiClient extends AbstractApiClient {
  constructor(baseUrl, timeoutMs, auth) {
    super(timeoutMs);
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.auth = auth ?? {};
    this.launchToken = this.auth.token || '';
    this.cookie = null;
    this.cookiePromise = null;
    this._authEpoch = 0;
    this._muxSendOpen = null;
    // 期望 follow 的会话集合：**跨重连保留**。DSH 重启或 WS 中断后必须重放，
    // 否则已有会话再也收不到 session 事件（turn/end 丢失 → QQ 上永远没有回复，且无报错）。
    this._desiredFollows = new Set();
  }

  /** Node 没有 location；把 base 固定为配置的 DSH 地址（回环地址天然通过 /api 信任栅栏）。 */
  resolveBase() {
    return this.baseUrl;
  }

  /** 使当前 Cookie/launch token 失效；DSH 重启或 401 后会自动重新发现最新 token。 */
  invalidateAuth() {
    this._authEpoch += 1;
    this.cookie = null;
    this.cookiePromise = null;
    const discovered = discoverDshLaunchToken();
    if (discovered) this.launchToken = discovered;
  }

  /** 新版 DSH 要求先用 launch token 换 Cookie，之后所有请求带 Cookie。 */
  async ensureAuth(signal) {
    signal?.throwIfAborted();
    if (this.cookie) return this.cookie;
    if (!this.launchToken) throw new Error('DSH auth token missing: set dsh.authToken in config.json (or let auto-discovery read it from DSH guard logs)');
    if (this.cookiePromise) return waitWithSignal(this.cookiePromise, signal);
    const promise = (async () => {
      const epoch = this._authEpoch;
      const url = new URL(this.baseUrl);
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      url.searchParams.set('token', this.launchToken);
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      const setCookie = res.headers.get('set-cookie');
      await res.body?.cancel();
      if (!setCookie) throw new Error(`DSH token exchange failed: HTTP ${res.status}`);
      if (epoch !== this._authEpoch) throw new Error('DSH auth session invalidated during token exchange');
      this.cookie = setCookie.split(';')[0];
      return this.cookie;
    })();
    this.cookiePromise = promise;
    const clearPromise = () => {
      if (this.cookiePromise === promise) this.cookiePromise = null;
    };
    // 不丢弃 finally 返回的 rejected Promise，否则调用方已 catch 仍会触发进程级未处理拒绝。
    promise.then(clearPromise, clearPromise);
    return waitWithSignal(promise, signal);
  }

  async doFetch(input, init) {
    return this._doFetchWithAuth(input, init, false);
  }

  /**
   * 退役会话前先移除 pending inbox，再取消正在运行的 turn。
   * DSH 的 session/cancel 保留 inbox，archiveSession 只隐藏会话，均不能代替清队列。
   */
  async stopSessionWork(sessionId, { signal, timeoutMs = 8000 } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const deadline = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let removed = 0;
    let failure;
    try {
      // 为取消当前 turn 留出时间，即使 control 流没有及时返回 baseline。
      const queueSignal = AbortSignal.any([sig, AbortSignal.timeout(Math.min(5000, timeoutMs))]);
      const items = await this._readSessionQueue(sessionId, queueSignal);
      for (const itemId of new Set(items.map((item) => item?.id))) {
        if (typeof itemId !== 'string' || !itemId) throw new Error('invalid session/control queue item');
        const response = await this.callUnary('session/updateQueue', {
          sessionId, itemId, action: { kind: 'remove' }
        }, sig);
        if (response.result?.ok) removed += 1;
        else if (response.result?.error?.code !== 'session/queue-item-not-found') unwrap(response, 'session/updateQueue');
        // 已被 agent 取走的队列项不再存在；接下来的 cancel 会取消当前 turn。
      }
    } catch (error) {
      failure = error;
    }
    try {
      const response = await this.callUnary('session/cancel', { sessionId }, sig);
      if (!response.result?.ok && response.result?.error?.code !== 'session/not-found') unwrap(response, 'session/cancel');
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    return { removed };
  }

  async _readSessionQueue(sessionId, signal) {
    await this.ensureAuth(signal);
    // 建 socket 前先检查取消状态：已经取消的等待不应该再开一条连接。
    signal.throwIfAborted();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, items) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open);
        socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
        if (error) reject(error); else resolve(items);
      };
      const abort = () => finish(signal.reason);
      const failed = () => finish(new Error('session/control connection closed before baseline'));
      const open = () => {
        try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } })); }
        catch (error) { finish(error); }
      };
      const message = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error' || frame.type === 'end') {
            finish(new Error(`session/control ended before baseline${frame.error?.code ? ` (${frame.error.code})` : ''}`));
          } else if (frame.type === 'item' && frame.value?.type === 'baseline') {
            const queues = frame.value.value?.queues;
            if (!queues || typeof queues !== 'object' || Array.isArray(queues)) throw new Error('invalid session/control baseline');
            const items = Object.hasOwn(queues, sessionId) ? queues[sessionId] : [];
            if (!Array.isArray(items)) throw new Error('invalid session/control queue');
            finish(null, items);
          }
        } catch (error) { finish(error); }
      };
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async _doFetchWithAuth(input, init, isRetry) {
    const authEpoch = this._authEpoch;
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (this.launchToken) {
      try {
        const cookie = await this.ensureAuth(init?.signal);
        headers.set('cookie', cookie);
      } catch (error) {
        if (!isRetry && this.launchToken && /token exchange failed|invalidated during token exchange/i.test(error?.message ?? '')) {
          if (authEpoch === this._authEpoch) this.invalidateAuth();
          return this._doFetchWithAuth(input, init, true);
        }
        throw error;
      }
    }
    init?.signal?.throwIfAborted();
    const response = await fetch(input, { ...init, headers });
    if (!isRetry && response.status === 401 && this.launchToken) {
      await response.body?.cancel();
      // 同一旧 Cookie 的并发 401 只能触发一次换票，不能使已开始的新换票失效。
      if (authEpoch === this._authEpoch) this.invalidateAuth();
      return this._doFetchWithAuth(input, init, true);
    }
    return response;
  }

  /**
   * 覆写 unary RPC：适配 DSH 0.1.2 起、0.1.5 仍沿用的斜杠 endpoint 和 { args } 包装，
   * 并且只解析最外层信封，不依赖官方包的 value schema
   * （桥接依赖的 @deepseek-ai/dsh-host-apiproxy 是独立的旧版客户端包，DSH 升级不影响它）。
   * 注意：新版基类里 callUnary 是 protected/private，这里用同名 public 方法覆写即可，
   * 业务侧一律走桥接自己的 sessions/workspace/settings 门面，不依赖基类的域方法。
   */
  async callUnary(method, payload, signal, timeoutPolicy = 'default') {
    const endpoint = endpointOf(method);
    const message = {
      type: 'client-request',
      rpcId: this.mintRpcId(),
      method: endpoint,
      payload: wrapArgs(method, payload)
    };
    this.onEnvelope(message);
    const response = await this.postJson(`/api/${endpoint}`, message, signal, timeoutPolicy);
    const full = await response.json();
    if (!full || full.type !== 'server-response' || full.rpcId !== message.rpcId || !full.result) {
      throw new Error(`invalid server-response for ${endpoint}`);
    }
    this.onEnvelope(full);
    return { rpcId: full.rpcId, result: full.result };
  }

  /**
   * respond 在新版 DSH 中由 Remote Event 结果通道承担：POST /api/$events/result。
   * 调用方传 { clientId, eventId, outcome }；旧版 { type:'client-response', ... } 仍保留旧路径，
   * 若旧路径 404 会由上层捕获并记录，不会影响新版链路。
   */
  async respond(message, signal) {
    if (message?.clientId && message?.eventId && message?.outcome) {
      const response = await this.callUnary('$events/result', {
        clientId: message.clientId,
        eventId: message.eventId,
        outcome: message.outcome
      }, signal);
      if (!response.result?.ok) {
        const { code, message: errMsg } = response.result?.error ?? {};
        throw new Error(`$events/result rejected${code ? ` (${code})` : ''}: ${errMsg ?? 'unknown error'}`);
      }
      return response;
    }
    this.onEnvelope(message);
    const response = await this.postJson('/api/respond', message, signal);
    return response.json();
  }

  /** 新版 DSH 的 agentPresets 命名空间是复数；旧版基类仍映射到 agentPreset.list。 */
  agentPresets = {
    list: (payload, signal) => this.callUnary('agentPresets.list', payload, signal),
  };

  /**
   * 新版事件流：连接 /api/remote.mux，自动 follow 所有 session，并把
   * session/follow 的 event 帧映射成旧 pumpMux 能消费的 session/event 信封。
   */
  events = {
    mux: (_payload, signal, onOpen) => this.openRemoteEventStream(signal, onOpen),
    host: (_payload, signal, onOpen) => this.openRemoteEventStream(signal, onOpen),
    follow: (sessionId) => this._followSession(sessionId),
  };

  openRemoteEventStream(signal, onOpen) {
    const gen = this._remoteMuxGenerator(signal, onOpen);
    return {
      [Symbol.asyncIterator]: () => gen,
      follow: (sessionId) => this._followSession(sessionId)
    };
  }

  _followSession(sessionId) {
    if (!sessionId) return;
    const sid = String(sessionId);
    // 先记账再发送：即使此刻没有连接（或正处在重连窗口内），重连时也会重放。
    this._desiredFollows.add(sid);
    if (this._muxSendOpen) this._muxSendOpen(sid);
  }

  async *_remoteMuxGenerator(signal, onOpen) {
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own.signal;
    sig.throwIfAborted();
    await this.ensureAuth(sig);
    sig.throwIfAborted();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const inbox = [];
    let wake;
    let socketOpen = false;
    let eventStreamId = null;
    let eventClientId = null;
    let ended = false;
    const followed = new Set();
    const streamToSession = new Map();
    const sessionToStream = new Map();
    const enqueue = (item) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const endStream = () => {
      if (ended) return;
      ended = true;
      if (this._muxSendOpen === sendOpen) this._muxSendOpen = null;
      // 连接断开（含鉴权失败/DSH 重启）时丢弃旧 Cookie，重连会重新 token exchange。
      if (!sig.aborted) this.invalidateAuth();
      enqueue({ kind: 'end' });
    };
    const sendOpen = (sessionId) => {
      if (ended || !socketOpen || sessionToStream.has(sessionId) || followed.has(sessionId)) return;
      const streamId = randomUUID();
      streamToSession.set(streamId, sessionId);
      sessionToStream.set(sessionId, streamId);
      followed.add(sessionId);
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId }
              }
            }
          }
        }));
      } catch (error) {
        console.error('[dsh-client] failed to open session/follow:', error?.message ?? error);
        // 发送失败时不能把该会话永久记为已订阅；结束传输，让上层重连并重放。
        sessionToStream.delete(sessionId);
        streamToSession.delete(streamId);
        followed.delete(sessionId);
        endStream();
      }
    };
    const sendOpenEvents = () => {
      if (ended || !socketOpen || eventStreamId) return;
      const streamId = randomUUID();
      eventStreamId = streamId;
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: '$events',
          payload: { args: {} }
        }));
      } catch (error) {
        console.error('[dsh-client] failed to open $events stream:', error?.message ?? error);
        eventStreamId = null;
        endStream();
      }
    };
    const handleOpen = () => {
      if (ended || sig.aborted) return;
      socketOpen = true;
      this._muxSendOpen = sendOpen;
      // 重放**全部**期望 follow（跨重连保留），而不只是本次连接排队的那些。
      // 少了这一步，DSH 一重启，所有已存在的 QQ 会话就会静默失联。
      for (const sid of this._desiredFollows) sendOpen(sid);
      sendOpenEvents();
      if (!ended) onOpen?.();
    };
    const handleMessage = (event) => {
      let msg;
      try {
        if (typeof event.data !== 'string') throw new Error('binary frame');
        msg = JSON.parse(event.data);
        if (!msg || typeof msg.type !== 'string' || typeof msg.streamId !== 'string') throw new Error('unexpected remote stream frame');
      } catch (error) {
        console.error('[dsh-client] dropping malformed remote.mux frame:', error?.message ?? error);
        return;
      }
      const sessionId = streamToSession.get(msg.streamId);
      const isEventStream = msg.streamId === eventStreamId;
      if (msg.type === 'item') {
        if (isEventStream && msg.value) {
          const value = msg.value;
          if (value.type === 'ready') {
            eventClientId = value.clientId;
          } else if (value.type === 'waterfall' && eventClientId) {
            if (value.event === 'approval/request') {
              enqueue({
                kind: 'frame',
                envelope: {
                  rpcId: value.eventId,
                  payload: {
                    type: 'approval/requested',
                    sessionId: value.agentId,
                    clientId: eventClientId,
                    eventId: value.eventId,
                    toolName: value.request?.toolName,
                    callId: value.request?.callId,
                    reason: value.request?.reason
                  }
                }
              });
            } else if (value.event === 'user-questions/request') {
              enqueue({
                kind: 'frame',
                envelope: {
                  rpcId: value.eventId,
                  payload: {
                    type: 'question/requested',
                    sessionId: value.agentId,
                    clientId: eventClientId,
                    eventId: value.eventId,
                    questions: value.request?.questions
                  }
                }
              });
            }
            // 其他 emit/waterfall 事件当前桥接不需要，保持忽略。
          }
          // emit/cancel 帧忽略
        } else if (sessionId && msg.value?.type === 'event') {
          enqueue({
            kind: 'frame',
            envelope: {
              rpcId: msg.streamId,
              payload: { type: 'session/event', sessionId, event: msg.value.event }
            }
          });
        }
        // snapshot 帧忽略，避免重放历史
      } else if (msg.type === 'end') {
        if (isEventStream) {
          eventStreamId = null;
          eventClientId = null;
          // 仅清掉 id 会让提问/审批通道永久失联；结束 mux 由桥接重连并重开。
          endStream();
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
        }
      } else if (msg.type === 'error') {
        if (isEventStream) {
          console.error('[dsh-client] $events stream failed:', msg.error?.code || 'unknown error');
          eventStreamId = null;
          eventClientId = null;
          endStream();
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
          // 只有已不存在的会话才永久取消订阅；临时服务错误必须在重连后重试。
          if (msg.error?.code === 'session/not-found') this._desiredFollows.delete(sessionId);
          enqueue({
            kind: 'frame',
            envelope: { rpcId: msg.streamId, payload: { type: 'stream/error', error: msg.error } }
          });
          if (msg.error?.code !== 'session/not-found') endStream();
        }
      }
    };
    const handleClose = () => endStream();
    const handleError = () => endStream();
    const handleAbort = () => {
      endStream();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    };
    socket.addEventListener('open', handleOpen);
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', handleClose, { once: true });
    socket.addEventListener('error', handleError, { once: true });
    sig.addEventListener('abort', handleAbort, { once: true });
    if (sig.aborted) handleAbort();
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.kind === 'end') return;
          yield item.envelope;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      if (this._muxSendOpen === sendOpen) this._muxSendOpen = null;
      sig.removeEventListener('abort', handleAbort);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('close', handleClose);
      socket.removeEventListener('error', handleError);
      own?.abort();
      handleAbort();
    }
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      // session/follow may attach in the middle of a live turn (snapshots are not
      // replayed). Track real turn activity even when its turn/start was missed.
      if (event.data?.turn != null && ['step/start', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type) && !turns.has(event.data.turn)) {
        turns.set(event.data.turn, { text: '' });
      }
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        // An orphan turn/end still closes a pending wake after reconnection.
        return { turn: event.data.turn, reason: event.data.reason, text: t?.text ?? '' };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
