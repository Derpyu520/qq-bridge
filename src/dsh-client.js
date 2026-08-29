// Node 环境的 DSH Web API 客户端。
// 兼容 DSH 0.1.2-alpha.1 的大改：
// 1. RPC 方法从点号改为斜杠（host.describe -> host/describe 等）；
// 2. payload 包装为 { args: { <参数名>: 原payload } }；
// 3. 新增浏览器会话鉴权：先用 dsh.authToken（进程启动 token）换取 Cookie，再带 Cookie 访问 API/WS；
// 4. 事件流不再是 events.mux 下行，而是 /api/remote.mux 上按 session/follow 打开的流。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';

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
    this._pendingFollows = [];
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
  async ensureAuth() {
    if (this.cookie) return this.cookie;
    if (!this.launchToken) throw new Error('DSH auth token missing: set dsh.authToken in config.json (or let auto-discovery read it from DSH guard logs)');
    if (this.cookiePromise) return this.cookiePromise;
    const promise = (async () => {
      const epoch = this._authEpoch;
      const url = new URL(this.baseUrl);
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      url.searchParams.set('token', this.launchToken);
      const res = await fetch(url, { redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (!setCookie) throw new Error(`DSH token exchange failed: HTTP ${res.status}`);
      if (epoch !== this._authEpoch) throw new Error('DSH auth session invalidated during token exchange');
      this.cookie = setCookie.split(';')[0];
      return this.cookie;
    })();
    this.cookiePromise = promise;
    promise.finally(() => {
      if (this.cookiePromise === promise) this.cookiePromise = null;
    });
    return promise;
  }

  async doFetch(input, init) {
    return this._doFetchWithAuth(input, init, false);
  }

  async _doFetchWithAuth(input, init, isRetry) {
    const headers = new Headers(init?.headers);
    if (this.launchToken) {
      try {
        const cookie = await this.ensureAuth();
        headers.set('cookie', cookie);
      } catch (error) {
        if (!isRetry && this.launchToken && /token exchange failed|invalidated during token exchange/i.test(error?.message ?? '')) {
          this.invalidateAuth();
          return this._doFetchWithAuth(input, init, true);
        }
        throw error;
      }
    }
    const response = await fetch(input, { ...init, headers });
    if (!isRetry && response.status === 401 && this.launchToken) {
      this.invalidateAuth();
      return this._doFetchWithAuth(input, init, true);
    }
    return response;
  }

  /**
   * 覆写 unary RPC：适配 DSH 0.1.2 的斜杠 endpoint 和 { args } 包装，
   * 并且只解析最外层信封，不依赖官方包的 value schema。
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
    if (this._muxSendOpen) this._muxSendOpen(sessionId);
    else if (!this._pendingFollows.includes(sessionId)) this._pendingFollows.push(sessionId);
  }

  async *_remoteMuxGenerator(signal, onOpen) {
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own.signal;
    await this.ensureAuth();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const inbox = [];
    let wake;
    let socketOpen = false;
    let timer = null;
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
      this._muxSendOpen = null;
      // 连接断开（含鉴权失败/DSH 重启）时丢弃旧 Cookie，重连会重新 token exchange。
      this.invalidateAuth();
      if (timer) clearInterval(timer);
      enqueue({ kind: 'end' });
    };
    const sendOpen = (sessionId) => {
      if (!socketOpen || sessionToStream.has(sessionId) || followed.has(sessionId)) return;
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
      }
    };
    const sendOpenEvents = () => {
      if (!socketOpen || eventStreamId) return;
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
      }
    };
    const handleOpen = () => {
      socketOpen = true;
      this._muxSendOpen = sendOpen;
      for (const sid of this._pendingFollows.splice(0)) sendOpen(sid);
      sendOpenEvents();
      onOpen?.();
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
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
        }
      } else if (msg.type === 'error') {
        if (isEventStream) {
          // $events 是附加的 Remote Event 流；它失败不应拖垮 session/follow 主事件流。
          eventStreamId = null;
          eventClientId = null;
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
          enqueue({
            kind: 'frame',
            envelope: { rpcId: msg.streamId, payload: { type: 'stream/error', error: msg.error } }
          });
        }
      }
    };
    const handleClose = () => endStream();
    const handleError = () => endStream();
    const handleAbort = () => {
      if (timer) clearInterval(timer);
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
      this._muxSendOpen = null;
      if (timer) clearInterval(timer);
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
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
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
