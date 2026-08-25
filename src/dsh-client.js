// Node 环境的 DSH Web API 客户端。
// 协议：unary RPC 走 POST /api/<method>（fetch），事件流走 WebSocket 下行（/api/events.mux、/api/events.host）。
// 复用官方 @deepseek-ai/dsh-host-apiproxy 的 AbstractApiClient 与 zod schema，只替换传输层。
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema';
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';

export class NodeApiClient extends AbstractApiClient {
  constructor(baseUrl, timeoutMs) {
    super(timeoutMs);
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  }

  /** Node 没有 location；把 base 固定为配置的 DSH 地址（回环地址天然通过 /api 信任栅栏）。 */
  resolveBase() {
    return this.baseUrl;
  }

  doFetch(input, init) {
    return fetch(input, init);
  }

  openMux(_payload, signal, onOpen) {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen);
  }

  openHost(_payload, signal, onOpen) {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen);
  }

  /** 与浏览器 WebApiClient 相同的下行协议：只读 WebSocket，文本帧即 server-request 信封。 */
  async *readWebSocket(path, signal, frameSchema, onOpen) {
    // 调用方不传 signal 时自建一个（Node 端 pump 常省略该参数）
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own.signal;
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const inbox = [];
    let wake;
    const enqueue = (item) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const handleOpen = () => {
      // DSH 的 events.mux / events.host 是“仅下行”WebSocket：
      // 服务端收到任何客户端消息都会以 1008 downlink only 关闭，
      // 因此不能做应用层 ping/pong，也不应因“一段时间没有下行消息”就主动断开。
      // 之前 90s 空闲 watchdog 是日志里频繁“连接 DSH 事件流…”的根源。
      // 现在改为长连接保活：不因空闲主动 close；
      // 断线/重启由 WebSocket close/error 事件驱动，桥接另有 5s 一次的 HTTP checkDsh 兜底。
      onOpen?.();
    };
    const handleMessage = (event) => {
      let full;
      let frame;
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame');
        full = serverRequestSchema.parse(JSON.parse(event.data));
        frame = frameSchema.parse(full.payload);
      } catch (error) {
        console.error(`[dsh-client] dropping malformed WebSocket frame on ${path}:`, error);
        return;
      }
      this.onEnvelope(full);
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } });
    };
    const handleClose = () => enqueue({ kind: 'end' });
    const handleError = () => enqueue({ kind: 'end' });
    const handleAbort = () => {
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
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    } finally {
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
