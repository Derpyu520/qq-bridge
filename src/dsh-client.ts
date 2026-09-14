// Node 环境的 DSH Web API 客户端。
// 协议：unary RPC 走 POST /api/<method>（fetch），事件流走 WebSocket 下行（/api/events.mux、/api/events.host）。
// 复用官方 @deepseek-ai/dsh-host-apiproxy 的 AbstractApiClient 与 zod schema，只替换传输层。
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema';
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc';
import type { MuxFrame, HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events';
import type { z } from 'zod';

export class NodeApiClient extends AbstractApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string, timeoutMs?: number) {
    super(timeoutMs);
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  }

  /** Node 没有 location；把 base 固定为配置的 DSH 地址（回环地址天然通过 /api 信任栅栏）。 */
  protected override resolveBase(): string {
    return this.baseUrl;
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }

  protected override openMux(_payload: unknown, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen);
  }

  protected override openHost(_payload: unknown, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen);
  }

  /** 与浏览器 WebApiClient 相同的下行协议：只读 WebSocket，文本帧即 server-request 信封。 */
  private async *readWebSocket<F>(
    path: string,
    signal: AbortSignal | undefined,
    frameSchema: z.ZodType<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    // 调用方不传 signal 时自建一个（Node 端 pump 常省略该参数）
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own!.signal;
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.toString());

    type InboxItem = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' };
    const inbox: InboxItem[] = [];
    let wake: (() => void) | undefined;
    const enqueue = (item: InboxItem) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };

    const handleOpen = () => {
      // DSH 的 events.mux / events.host 是“仅下行”WebSocket：
      // 服务端收到任何客户端消息都会以 1008 downlink only 关闭，
      // 因此不能做应用层 ping/pong，也不应因“一段时间没有下行消息”就主动断开。
      onOpen?.();
    };
    const handleMessage = (event: MessageEvent) => {
      let full;
      let frame: F;
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
          const item = inbox.shift()!;
          if (item.kind === 'end') return;
          yield item.envelope;
        }
        await new Promise<void>((resolve) => {
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
export function unwrap<T>(response: RpcResponse<T>, label: string): T {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

interface TurnEventLike {
  type?: string;
  data?: {
    turn?: unknown;
    reason?: { kind?: string; error?: { message?: string } };
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
}

export interface TurnEnd {
  turn: string;
  reason: { kind: string; error?: { message?: string } };
  text: string;
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map<string, { text: string }>();
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event: unknown): TurnEnd | null {
      const e = event as TurnEventLike;
      const type = e.type;
      if (type === 'turn/start') {
        turns.set(String(e.data?.turn), { text: '' });
        return null;
      }
      if (type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (type === 'assistant/message') {
        const t = turns.get(String(e.data?.turn));
        if (!t) return null;
        for (const block of e.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (type === 'turn/end') {
        const turn = String(e.data?.turn);
        const t = turns.get(turn);
        turns.delete(turn);
        if (!t) return null;
        return {
          turn,
          reason: { kind: String(e.data?.reason?.kind ?? 'unknown'), error: e.data?.reason?.error },
          text: t.text,
        };
      }
      return null;
    },
    has(turn: string): boolean {
      return turns.has(turn);
    },
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content: Array<{ type?: string; text?: string }> | null | undefined): string {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}
