// Shared by the live verifier and its isolated protocol regressions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unwrap } from '../../src/dsh/dsh-client.js';

export function createProbeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-verify-022-'));
}

/** Read a required mux response; transport and protocol failures must fail verification. */
export function probeMux({ url, cookie, endpoint, args, timeoutMs, onItem,
  WebSocketClass = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(url, { headers: { cookie } });
    const streamId = randomUUID();
    const pending = new AbortController();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.abort();
      try { socket.close(); } catch {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${endpoint} 超时`)), timeoutMs);
    socket.addEventListener('open', () => {
      if (settled) return;
      try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })); }
      catch (error) { finish(error); }
    });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      let frame;
      try { frame = JSON.parse(event.data); }
      catch { finish(new Error(`${endpoint} 返回无效 JSON`)); return; }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'error' || frame.type === 'end') {
        finish(new Error(`${endpoint} ${frame.type}${frame.error?.code ? ` (${frame.error.code})` : ''}`));
      } else if (frame.type === 'item') {
        Promise.resolve().then(() => onItem(frame.value, pending.signal)).then((value) => {
          if (value !== undefined) finish(null, value);
        }, (error) => finish(error));
      }
    });
    socket.addEventListener('error', () => finish(new Error(`${endpoint} socket error`)));
    socket.addEventListener('close', () => finish(new Error(`${endpoint} socket closed before response`)));
  });
}

/** Wait for the follow snapshot before prompting; no timer may prompt after cleanup. */
export function probeTurn(api, sessionId, options) {
  let text = '';
  let promptAcceptance = null;
  return probeMux({
    ...options, endpoint: 'session/follow',
    args: { request: { address: { kind: 'session', sessionId }, activate: true } },
    onItem: async (value, signal) => {
      if (value?.type === 'snapshot' && promptAcceptance === null && !signal.aborted) {
        // Store the shared ACK before calling prompt: events may arrive before its RPC response.
        promptAcceptance = Promise.resolve().then(() => api.sessions.prompt({ sessionId, mode: 'queue',
          content: [{ type: 'text', text: '只回复两个字：收到' }] }, signal))
          .then((response) => unwrap(response, 'session.prompt'));
        await promptAcceptance;
      }
      const event = value?.type === 'event' ? value.event : null;
      if (event?.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      }
      if (event?.type === 'turn/end') {
        if (promptAcceptance === null) throw new Error('session/follow 在探测 prompt 投递前结束了回合');
        const turn = { reason: event.data?.reason, text };
        await promptAcceptance;
        return turn;
      }
    },
  });
}

/** Archive alone can reject active work. Stop it first and inspect both RPC outcomes. */
export async function cleanupProbeSession(api, sessionId) {
  const errors = [];
  try { await api.stopSessionWork(sessionId); }
  catch (error) { errors.push(`stopSessionWork: ${error?.message ?? error}`); }
  try {
    unwrap(await api.callUnary('workspace/archiveSession', { sessionId, stopActivity: true }), 'archiveSession');
  } catch (error) { errors.push(`archiveSession: ${error?.message ?? error}`); }
  return errors;
}
