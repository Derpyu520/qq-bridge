// DSH 0.1.5 官方 SDK 运行时客户端（stdio JSON-RPC）。
//
// 背景：DSH 0.1.5 移除了老的 host-apiproxy HTTP/WS 传输（/api/host.describe、
// /api/events.mux 全部 404），旧插件与 0.1.5 的 dsh-api-remotes 也已不兼容。
// 官方对外承诺的稳定接口是 `dsh --profile sdk`：一个 stdio 上跑换行分隔
// JSON-RPC 2.0 的运行时，请求只有 initialize / session/prompt / shutdown，
// 通知有 session.event / session.status / subagent.*。
//
// 本文件把它**适配成 bridge.js 已经在用的 api.* 形状**（host.describe /
// sessions.prompt / events.mux ...），这样 bridge.js 的 29 处调用点几乎不用改。
// 代价是 SDK 没有的能力要显式降级（见下方 respond / selectModel / workspace.*）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_DSH_BIN = 'C:\\Users\\Ricky\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

const ok = (value) => ({ result: { ok: true, value } });
const fail = (code, message) => ({ result: { ok: false, error: { code, message, details: {} } } });

/** 把 bridge 的 content block 数组规范成 SDK 的 contentBlocks。 */
function toContentBlocks(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && block.data) {
      // SDK 侧要求显式 mimeType；bridge 的 media 解析已带，缺省按 png 兜。
      out.push({ type: 'image', data: String(block.data), mimeType: block.mimeType || 'image/png' });
      continue;
    }
  }
  return out;
}

export class DshSdkRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.cwd 运行时工作目录（SDK 会话持久化到这里）
   * @param {string} opts.provider
   * @param {string} opts.model
   * @param {string} [opts.reasoningEffort]
   * @param {string} [opts.profile] dsh profile 名，默认 sdk
   * @param {string} [opts.dshBin] dsh 入口路径
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd;
    this.provider = opts.provider;
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.profile = opts.profile || 'sdk';
    this.dshBin = opts.dshBin || DEFAULT_DSH_BIN;
    this.log = opts.log || (() => {});
    this.maxTokens = opts.maxTokens;

    this.child = null;
    this.ready = false;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();       // jsonrpc id -> {resolve, reject, timer}
    this.frameListeners = new Set(); // (frame) => void
    this.closeListeners = new Set(); // () => void
    this.exitListeners = new Set();  // (info) => void
    this.stopping = false;
    this.lastExit = null;
  }

  isReady() { return this.ready; }

  onExit(cb) { this.exitListeners.add(cb); return () => this.exitListeners.delete(cb); }

  /** 启动运行时并完成 initialize 握手。重复调用复用同一次启动。 */
  start() {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.#doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #doStart() {
    this.stopping = false;
    // spawn 的 cwd 必须真实存在，否则 Node 直接抛 ENOENT（踩过一次）。
    try { fs.mkdirSync(this.cwd, { recursive: true }); } catch {}
    const child = spawn(process.execPath, [this.dshBin, '--profile', this.profile], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    this.child = child;

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.#handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = decoder.write(chunk).trim();
      if (text) this.log(`[sdk-runtime] ${text.split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);
    });
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.child = null;
      this.lastExit = { code, signal, at: Date.now() };
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`DSH SDK 运行时已退出（code=${code}）`));
      }
      this.pending.clear();
      for (const cb of this.closeListeners) { try { cb(); } catch {} }
      for (const cb of this.exitListeners) { try { cb(this.lastExit); } catch {} }
      if (!this.stopping) this.log(`DSH SDK 运行时退出（code=${code} signal=${signal}），等待外层重连`);
    });
    child.on('error', (error) => this.log(`DSH SDK 运行时进程错误：${error?.message ?? error}`));

    // 握手：SDK 服务器要先 await loader 才处理 initialize，给足冷启动时间。
    const result = await this.#request('initialize', {
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      // 'default' 是 bridge 配置里的占位值，SDK 侧不认，必须整个省略。
      ...(this.reasoningEffort && this.reasoningEffort !== 'default' ? { reasoningEffort: this.reasoningEffort } : {}),
      ...(this.maxTokens ? { maxTokens: this.maxTokens } : {})
    }, 120000);
    this.ready = true;
    this.log(`DSH SDK 运行时已就绪（${result?.serverInfo?.name ?? 'unknown'}，provider=${this.provider} model=${this.model}）`);
  }

  #handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // 响应
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.code ?? 'error'}: ${msg.error.message ?? 'unknown'}`));
      else entry.resolve(msg.result);
      return;
    }
    // 通知
    if (msg.method === 'session.event' && msg.params) {
      const frame = { type: 'session/event', sessionId: String(msg.params.sessionId), event: msg.params.event };
      for (const cb of this.frameListeners) { try { cb(frame); } catch {} }
      return;
    }
    if (msg.method === 'session.status' && msg.params) {
      const frame = { type: 'session/status', sessionId: String(msg.params.sessionId), status: msg.params.status };
      for (const cb of this.frameListeners) { try { cb(frame); } catch {} }
    }
  }

  #request(method, params, timeoutMs = 60000) {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error('DSH SDK 运行时未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH SDK 请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** 发一轮用户消息。 */
  async prompt(sessionId, content) {
    const blocks = toContentBlocks(content);
    if (blocks.length === 0) return fail('empty-prompt', 'content 不能为空');
    try {
      if (!this.ready) await this.start();
      const value = await this.#request('session/prompt', { sessionId: String(sessionId), contentBlocks: blocks }, 120000);
      return ok({ accepted: true, messageId: value?.messageId });
    } catch (error) {
      return fail('sdk-prompt-failed', error?.message ?? String(error));
    }
  }

  /** 事件流：把 session.event 通知吐成 bridge 期望的 mux 信封形状。 */
  async *mux(_payload, signal, onOpen) {
    const queue = [];
    let wake = null;
    let closed = false;
    const push = (frame) => { queue.push(frame); if (wake) { const w = wake; wake = null; w(); } };
    const onClose = () => { closed = true; if (wake) { const w = wake; wake = null; w(); } };
    this.frameListeners.add(push);
    this.closeListeners.add(onClose);
    const onAbort = () => { closed = true; if (wake) { const w = wake; wake = null; w(); } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      // 起流前确保运行时已就绪，bridge 的 for-await 才不会立刻退出。
      await this.start();
      onOpen?.();
      while (true) {
        while (queue.length > 0) yield { rpcId: 'sdk', payload: queue.shift() };
        if (closed) return;
        if (signal?.aborted) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      this.frameListeners.delete(push);
      this.closeListeners.delete(onClose);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** 主动关闭运行时（bridge 退出时调用）。 */
  stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: {} }) + '\n'); } catch {}
    setTimeout(() => { try { child.kill(); } catch {} }, 1200);
  }
}

/**
 * 把 DshSdkRuntime 包成 bridge.js 现在用的 `api` 形状。
 *
 * SDK 没有的能力在这里显式降级，而不是静默失败：
 *   - respond（审批/提问回传）→ 记日志并返回 ok，调用方不会崩，但交互式审批失效。
 *   - sessions.selectModel → 记日志 no-op（SDK 的 provider/model 是每进程一次）。
 *   - workspace.* / sessions.create → 桩实现，SDK 侧按 sessionId 懒建会话。
 */
export function createSdkApiAdapter(runtime, { log = () => {} } = {}) {
  let sessionSerial = 0;
  // 每次 bridge 进程一个随机 runId：SDK 会话 id 必须全局唯一。
  // 原因见 create() 上的注释——SDK 无法恢复已存在的会话。
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const unsupported = (what) => {
    log(`[sdk-adapter] SDK 协议不支持「${what}」，已降级为空操作`);
    return ok({ unsupported: what });
  };

  return {
    __sdk: runtime,
    host: {
      describe: async () => { await runtime.start(); return ok({ runtime: 'dsh-sdk' }); }
    },
    settings: {
      // 返回空命名空间：bridge 会回退到 state/mode.json 读模式，正是我们要的。
      describe: async () => ok({ namespaces: [] })
    },
    agentPresets: {
      list: async () => ok({ presets: [] })
    },
    workspace: {
      create: async () => ok({ workspace: { workspaceId: 'sdk-workspace' } }),
      rename: async () => ok({}),
      list: async () => ok({ workspaces: [] }),
      delete: async () => ok({}),
      archiveSession: async () => ok({})
    },
    sessions: {
      // ⚠️ 返回形状必须与 bridge 的读取方式一致：bridge 里是
      //   const value = unwrap(await api.sessions.create(params), 'session.create');
      //   sessionId = value.sessionId;        ← 扁平的 value.sessionId
      // 早期写成 { session: { sessionId } } 会让 sessionId 变成 undefined
      // （踩过一次，且不会报错，只是后面 prompt 拿不到会话）。
      //
      // 另外：SDK 运行时**不能恢复已存在的会话**。给它一个 DSH 会话库里已有的 id
      // （web 端建过的 session-xxxx，或上次 bridge 留下的），它会直接报
      // `-32603: session "..." already exists` 把消息顶回来。所以这里一律用带
      // runId 的全新 id，保证本进程内绝不与历史 id 相撞。
      create: async () => ok({ sessionId: `qq-${runId}-${sessionSerial++}`, created: true }),
      prompt: async ({ sessionId, content }) => runtime.prompt(sessionId, content),
      selectModel: async ({ provider, model, reasoningEffort }) => {
        // SDK 的 provider/model 是**每进程一次**设定的，这里无法真正切换。
        // 但必须把请求原样回显成 { selected: {...} }：bridge 的 ensureVisionModel
        // 会读 result.selected.provider，回少了就是 TypeError（踩过一次）。
        log(`[sdk-adapter] selectModel(${provider}/${model}) 在 SDK 下不支持，按原样回显；实际仍用 ${runtime.provider}/${runtime.model}`);
        return ok({ selected: { provider, model, reasoningEffort: reasoningEffort ?? 'default' }, ignored: true });
      }
    },
    respond: async () => unsupported('respond（审批/提问回传）'),
    events: {
      mux: (payload, signal, onOpen) => runtime.mux(payload, signal, onOpen)
    }
  };
}
