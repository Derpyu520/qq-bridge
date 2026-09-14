// Node 环境的 DSH Web API 客户端 —— 适配 DSH 0.1.5+ 的 typert remote 网关。
//
// 背景：DSH 0.1.5 起 /api 换成了斜杠端点网关：
//   - unary:  POST /api/<namespace>/<method>，信封 {type:'client-request', rpcId, method, payload:{args}}
//   - 流式:  WS /api/remote.mux，帧 {type:'open'|'cancel', streamId, endpoint, payload} →
//            {type:'item'|'end'|'error', streamId, value|error}
//   - 鉴权:  /api 需要浏览器会话 cookie（dsh-auth-<authority>，由 ~/.dsh/.credentials.yaml 的
//            client-connection/browser-session secret 签名；也可用 launcher 打印的 ?token= 换取）
//   - 旧的 host.describe / sessions.* / events.mux(SSE) / respond 均已不存在。
//
// 本文件把这些差异收敛在一个适配器里，对外仍然暴露 bridge.js 一直在用的 api.* 形状：
//   api.host.describe / api.sessions.{create,prompt,selectModel} / api.workspace.* /
//   api.settings.describe / api.agentPresets.list / api.events.mux / api.respond
//
// 事件流的两条来源：
//   - session/follow（每个已知会话一条流）→ 转成老的 {type:'session/event', sessionId, event}
//   - $events（全局转发事件）→ waterfall 帧转成 {type:'question/requested'} 与
//     {type:'approval/requested'}；应答走 unary POST /api/$events/result
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CLIENT_TIME_ZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
})();

function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * 由本机 DSH 凭据存储签出 /api 需要的浏览器会话 cookie。
 * secret 持久化在 ~/.dsh/.credentials.yaml，因此 DSH 重启后 cookie 依然有效。
 */
export function mintBrowserCookie(authority, dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  const match = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('未在 DSH 凭据里找到 client-connection/browser-session secret（DSH 版本过旧或凭据被重建）');
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const name = `dsh-auth-${b64url(crypto.createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 29 * 24 * 3600 * 1000,
  }), 'utf8'));
  const signature = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

/** bridge 的 content block → 网关的 PromptContentPart。 */
function toContentParts(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && block.data) {
      out.push({
        type: 'image',
        mediaType: block.mediaType || block.mimeType || 'image/png',
        data: String(block.data),
        ...(block.name ? { name: String(block.name) } : {}),
      });
      continue;
    }
    if (block.type === 'file' && block.receiptId) out.push({ type: 'file', receiptId: block.receiptId });
  }
  return out;
}

export class NodeApiClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.authority = new URL(this.baseUrl).host;
    this.dshHome = options.dshHome;
    this.cookieOverride = options.cookie ?? null;

    this.socket = null;
    this.connectPromise = null;
    this.clientId = null;

    /** 待消费的事件信封队列与等待者（单一消费者：bridge 的 pumpMux / self-test）。 */
    this.inbox = [];
    this.waiters = [];
    this.closed = false;

    this.follows = new Map();   // sessionId -> { streamId, opened }
    this.pending = new Map();   // rpcId -> { clientId, eventId, kind, sessionId }
    this.nextStreamId = 1;
    this.workspaceStream = null;

    // bridge.js / self-test.js 一直在用的 api.* 形状
    this.host = { describe: () => this.#rpc('settings/describe', {}) };
    this.sessions = {
      create: (params) => this.#createSession(params),
      prompt: (payload) => this.#prompt(payload),
      selectModel: (payload) => this.#rpc('session/selectModel', {
        request: {
          sessionId: payload.sessionId,
          provider: payload.provider,
          model: payload.model,
          ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
        },
      }),
      cancel: (payload) => this.#rpc('session/cancel', { request: { sessionId: payload.sessionId, ...(payload.turn !== undefined ? { turn: payload.turn } : {}) } }),
      rename: (payload) => this.#rpc('session/rename', { request: { sessionId: payload.sessionId, title: String(payload.title ?? '').slice(0, 200) } }),
      page: (payload) => this.#rpc('session/page', { request: payload }),
    };
    this.workspace = {
      create: (payload) => this.#rpc('workspace/create', { request: { path: payload.path } }),
      rename: (payload) => this.#rpc('workspace/rename', { request: { workspaceId: payload.workspaceId, title: payload.title } }),
      delete: (payload) => this.#rpc('workspace/delete', { request: { workspaceId: payload.workspaceId } }),
      archiveSession: (payload) => this.#rpc('workspace/archiveSession', { request: { sessionId: payload.sessionId } }),
      list: () => this.#listWorkspaces(),
    };
    this.settings = { describe: () => this.#rpc('settings/describe', {}) };
    this.agentPresets = { list: () => this.#rpc('agentPresets/list', {}) };
    this.events = { mux: (payload, signal, onOpen) => this.#mux(signal, onOpen) };
    this.respond = (message) => this.#respond(message);
  }

  // ────────────────────────────── 传输：unary RPC ──────────────────────────────

  #cookie() {
    if (this.cookieOverride) return this.cookieOverride;
    return mintBrowserCookie(this.authority, this.dshHome);
  }

  async #rpc(method, args) {
    const rpcId = crypto.randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: args ?? {} } });
    const send = () => fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.#cookie() },
      body,
    });
    let res;
    try {
      res = await send();
      // /api 的 BrowserAuth 偶发 401（实测与宿主繁忙相关，且同一窗口内会连续拒绝）：
      // 重新签 cookie 并退避重试，覆盖几百毫秒级的窗口。
      for (let attempt = 0; (res.status === 401 || res.status === 403) && !this.cookieOverride && attempt < 3; attempt += 1) {
        await res.text().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1) * (attempt + 1)));
        res = await send();
      }
    } catch (error) {
      throw new Error(`${method}: 传输失败（${error?.message ?? error}）`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}（${text.slice(0, 200)}）`);
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`${method}: 响应不是 JSON（${text.slice(0, 200)}）`);
    }
    if (!envelope?.result?.ok) {
      const error = envelope?.result?.error ?? {};
      const failure = new Error(`${method}: ${error.code ?? 'gateway/unknown'}: ${error.message ?? '未知错误'}`);
      failure.code = error.code;
      failure.details = error.details;
      throw failure;
    }
    return { result: { ok: true, value: envelope.result.value } };
  }

  // ────────────────────────────── 传输：remote.mux 流 ──────────────────────────────

  #ensureMux() {
    if (this.socket?.readyState === WebSocket.OPEN && this.clientId) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.#connectOnce();
          return;
        } catch (error) {
          lastError = error;
          if (!/HTTP 40[13]/.test(String(error?.message))) break;
        }
      }
      this.connectPromise = null;
      throw lastError ?? new Error('DSH 事件流连接失败');
    })();
    return this.connectPromise;
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/remote.mux', this.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, { headers: { cookie: this.#cookie() } });
      const fail = (error) => {
        try { socket.terminate(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.on('unexpected-response', (_req, res) => fail(new Error(`事件流升级被拒：HTTP ${res.statusCode}`)));
      socket.on('error', (error) => fail(new Error(`事件流连接错误：${error?.message ?? error}`)));
      socket.on('open', () => {
        this.socket = socket;
        this.#openStream('$events', {});
      });
      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        this.#onMuxMessage(message);
      });
      socket.on('close', () => {
        this.socket = null;
        this.clientId = null;
        this.connectPromise = null;
        this.follows.clear();
        this.#notifyClosed(new Error('DSH 事件流已断开'));
      });
      // $events 的 ready 帧到达即视为通道可用
      this.__resolveReady = resolve;
    });
  }

  #openStream(endpoint, args) {
    const streamId = `s${this.nextStreamId++}`;
    this.socket?.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: args ?? {} } }));
    return streamId;
  }

  #onMuxMessage(message) {
    const value = message.value;
    if (message.type === 'error') {
      if (message.streamId === this.workspaceStream) this.workspaceStream = null;
      if (message.streamId === this.follows.get(this.__streamSession)?.streamId) { /* noop */ }
      for (const [sessionId, entry] of this.follows) {
        if (entry.streamId === message.streamId) {
          this.follows.delete(sessionId);
          this.#push({ rpcId: crypto.randomUUID(), payload: { type: 'stream/error', error: message.error } });
        }
      }
      return;
    }
    if (message.type === 'end') {
      for (const [sessionId, entry] of this.follows) {
        if (entry.streamId === message.streamId) {
          this.follows.delete(sessionId);
          this.#push({ rpcId: crypto.randomUUID(), payload: { type: 'stream/error', error: { code: 'stream/end', message: `会话事件流结束：${sessionId}` } } });
        }
      }
      return;
    }
    if (message.type !== 'item') return;

    // $events：全局转发事件（提问 / 审批 waterfall）
    if (value?.type === 'ready') {
      this.clientId = value.clientId;
      this.__resolveReady?.();
      this.__resolveReady = null;
      return;
    }
    if (value?.type === 'waterfall') {
      this.#onWaterfall(value);
      return;
    }
    if (value?.type === 'emit') return;

    // session/follow：会话事件
    if (value?.type === 'snapshot') {
      for (const entry of this.follows.values()) {
        if (entry.streamId === message.streamId) entry.opened = true;
      }
      return;
    }
    if (value?.type === 'event') {
      const sessionId = this.#sessionOfStream(message.streamId);
      if (sessionId) {
        this.#push({ rpcId: crypto.randomUUID(), payload: { type: 'session/event', sessionId, event: value.event } });
      }
      return;
    }
    // assistant-stream 帧：bridge 用持久化的 assistant/message 事件，无需转发
  }

  #sessionOfStream(streamId) {
    for (const [sessionId, entry] of this.follows) {
      if (entry.streamId === streamId) return sessionId;
    }
    return null;
  }

  #onWaterfall(frame) {
    const sessionId = frame.agentId;
    const eventId = frame.eventId;
    if (!sessionId || !eventId) return;
    const rpcId = crypto.randomUUID();
    if (frame.event === 'user-questions/request') {
      const questions = frame.request?.questions ?? [];
      this.pending.set(rpcId, { clientId: this.clientId, eventId, kind: 'question', sessionId });
      this.#push({ rpcId, payload: { type: 'question/requested', sessionId, questions } });
      return;
    }
    if (frame.event === 'approval/request') {
      const request = frame.request ?? {};
      this.pending.set(rpcId, { clientId: this.clientId, eventId, kind: 'approval', sessionId });
      this.#push({
        rpcId,
        payload: {
          type: 'approval/requested',
          sessionId,
          approvalId: rpcId,
          toolName: String(request.toolName ?? request.name ?? '未知工具'),
          reason: String(request.reason ?? request.message ?? ''),
        },
      });
    }
  }

  #push(envelope) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: envelope });
    else this.inbox.push(envelope);
  }

  #notifyClosed(error) {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter({ done: true, error });
    }
  }

  async *#mux(signal, onOpen) {
    await this.#ensureMux();
    onOpen?.();
    for (;;) {
      if (signal?.aborted) return;
      if (this.inbox.length > 0) {
        yield this.inbox.shift();
        continue;
      }
      const next = await new Promise((resolve) => {
        this.waiters.push(resolve);
        if (signal) {
          const onAbort = () => resolve({ done: true, aborted: true });
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (next.done) {
        if (next.aborted) return;
        throw next.error ?? new Error('DSH 事件流已断开');
      }
      yield next.value;
    }
  }

  // ────────────────────────────── 会话 ──────────────────────────────

  async #ensureFollow(sessionId) {
    await this.#ensureMux();
    const existing = this.follows.get(sessionId);
    if (existing?.opened) return;
    if (existing) {
      // 已在建立中：等它的 snapshot
      for (let i = 0; i < 200 && !existing.opened; i += 1) await new Promise((r) => setTimeout(r, 10));
      return;
    }
    const entry = { streamId: this.#openStream('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }), opened: false };
    this.follows.set(sessionId, entry);
    for (let i = 0; i < 300 && !entry.opened; i += 1) await new Promise((r) => setTimeout(r, 10));
  }

  async #createSession(params = {}) {
    const request = {};
    if (params.cwd) request.cwd = params.cwd;
    if (params.workspaceId) request.workspaceId = params.workspaceId;
    if (params.agentPreset) request.agentPreset = params.agentPreset;
    if (params.sessionId) request.sessionId = params.sessionId;
    const response = await this.#rpc('session/create', { request });
    const sessionId = response.result.value?.sessionId;
    if (sessionId) await this.#ensureFollow(sessionId);
    return response;
  }

  async #prompt(payload) {
    const sessionId = payload.sessionId;
    await this.#ensureFollow(sessionId);
    const request = {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: payload.mode === 'steer' ? 'steer' : 'queue',
      content: toContentParts(payload.content),
      ...(CLIENT_TIME_ZONE ? { clientTimeZone: CLIENT_TIME_ZONE } : {}),
    };
    return this.#rpc('session/prompt', { request });
  }

  async #listWorkspaces() {
    // 新网关没有 workspace.list；用 workspace/follow 的首帧 baseline 取当前列表
    await this.#ensureMux();
    const streamId = this.#openStream('workspace/follow', {});
    const items = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('workspace.follow: 等待 baseline 超时')), 8000);
      const onMessage = (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.streamId !== streamId) return;
        if (message.type === 'item' && message.value?.type === 'baseline') {
          clearTimeout(timer);
          this.socket?.off('message', onMessage);
          this.socket?.send(JSON.stringify({ type: 'cancel', streamId }));
          resolve(message.value.items ?? []);
          return;
        }
        if (message.type === 'error') {
          clearTimeout(timer);
          this.socket?.off('message', onMessage);
          reject(new Error(`workspace.follow: ${message.error?.message ?? '流错误'}`));
        }
      };
      this.socket?.on('message', onMessage);
    });
    return { result: { ok: true, value: { items } } };
  }

  // ────────────────────────────── 提问 / 审批回传 ──────────────────────────────

  async #respond(message) {
    const rpcId = message?.rpcId;
    const entry = this.pending.get(rpcId);
    if (!entry) throw new Error(`无对应的挂起请求：${rpcId}`);
    const value = entry.kind === 'approval'
      ? message?.result?.value?.outcome
      : (message?.result?.value?.answer ?? { answers: [] });
    if (entry.kind === 'approval' && typeof value !== 'string') throw new Error('审批回执缺少 outcome');
    await this.#rpc('$events/result', {
      clientId: entry.clientId ?? this.clientId,
      eventId: entry.eventId,
      outcome: { kind: 'result', value },
    });
    this.pending.delete(rpcId);
    return { result: { ok: true, value: { accepted: true } } };
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
