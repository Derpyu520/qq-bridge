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
import { createHash, createHmac, randomUUID } from 'node:crypto';
import YAML from 'js-yaml';
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';

/** DSH home：凭据文件与（历史）启动日志都在这里。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 自动发现 DSH 的进程启动 token（新版 DSH 把它打印在 `dsh web` 的 URL 上）。
 *
 * 注意：0.1.7 的启动 token 由 processLaunchToken() 现场生成（32 字节随机数，
 * 只存在内存 WeakMap 里，**不落盘、不可推导**），所以「读日志」这条路只有
 * 在启动器把 `dsh web` 的 stdout 重定向到文件时才成立。guard 退役后
 * boot-guard.ps1 不再写 ~/.dsh/guard/logs/server-*.out.log，日志里剩下的是
 * **旧进程的陈旧 token**，拿它换 Cookie 只会得到 401。
 * 因此这里只是最后的兜底，主路径是 {@link discoverDshSessionCookie}。
 *
 * 查找顺序：环境变量 DSH_LAUNCH_TOKEN → DSH_HOME/logs（新启动器）→
 * DSH_HOME/guard/logs（guard 时代的历史日志，按时间从新到旧）。
 */
export function discoverDshLaunchToken() {
  const fromEnv = process.env.DSH_LAUNCH_TOKEN;
  if (typeof fromEnv === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(fromEnv)) return fromEnv;
  const home = resolveDshHome();
  // DSH_HOME/logs 是退役 guard 之后约定的启动日志位置；guard/logs 保留兼容。
  const dirs = [path.join(home, 'logs'), path.join(home, 'guard', 'logs')];
  for (const logsDir of dirs) {
    let files;
    try {
      files = fs.readdirSync(logsDir)
        .filter((name) => /^server-.*\.(?:out\.)?log$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
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
  }
  return '';
}

// ── 浏览器会话 Cookie 铸造（不依赖进程启动 token）────────────────────────────
// 背景：进程启动 token 是现生成、只在内存里的随机数，进程一重启就失效，且只有
// 「启动器记了 stdout 日志」时才能被发现——DSH 每升一次级、启动方式每变一次，
// 这条链路就要重新适配一次。
//
// DSH 另有一份**持久化**的会话签名密钥：credentials 里的
// `client-connection/browser-session`（32 字节，首次生成后长期不变）。浏览器
// Cookie 就是用它做 HMAC 签名的，服务端校验（dsh-client-connection 的
// isAuthenticated）只要求：
//   · cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
//   · payload.authority === authority（Host 头，例如 127.0.0.1:3080）
//   · issuedAt <= now < expiresAt 且 expiresAt - issuedAt <= cookieMaxAgeDays（默认 30 天）
// 所以本机同用户进程可以**离线铸造**一个合法 Cookie，完全绕开启动 token。
// 权限没有提升：桥接本来就用启动 token 换到同等会话权限，这里只是换了一条
// 不依赖「启动器有没有记日志」的路。签名密钥不可用时返回空串，调用方回退到
// 启动 token 交换。
const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
/** 铸造 Cookie 的有效期：远小于 DSH 默认上限（30 天），够用且留足余量。 */
export const MINTED_COOKIE_LIFETIME_MS = 60 * 60 * 1000;
/** 到期前多久主动重铸。铸造是纯本地 HMAC（无网络往返），提前换比撞 401 再重试便宜。 */
const MINTED_COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const base64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * 读取 DSH 持久化的浏览器会话签名密钥。
 * @returns 32 字节密钥；文件缺失/被占用/结构不符时返回 null（调用方回退）。
 */
export function readBrowserSessionSecret() {
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const record = doc?.records?.[BROWSER_SESSION_KEY];
    if (record?.kind !== 'grant' || record?.payload?.version !== 1) return null;
    const secret = record.payload.secret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
    const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    // 长度必须正好 32 字节；否则说明 DSH 换了密钥方案，宁可回退也不发坏 Cookie。
    return decoded.byteLength === SECRET_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 用签名密钥为指定 DSH 地址铸造一个会话 Cookie。
 * @param baseUrl - DSH 基址；其 authority（host:port）会绑定进 Cookie 名与签名载荷。
 * @param secret - {@link readBrowserSessionSecret} 返回的密钥。
 * @param options.lifetimeMs - Cookie 有效期。
 * @returns 可直接放进 Cookie 头的 `name=value` 串。
 */
export function mintBrowserSessionCookie(baseUrl, secret, { lifetimeMs = MINTED_COOKIE_LIFETIME_MS } = {}) {
  const authority = new URL(String(baseUrl)).host;
  if (!authority) throw new Error('DSH baseUrl has no authority');
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = base64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${signature}`;
}

/**
 * 一步到位：为本机 DSH 铸造会话 Cookie。
 * @returns Cookie 串；密钥不可用时返回 ''（调用方回退到启动 token 交换）。
 */
export function discoverDshSessionCookie(baseUrl, options) {
  // 自动发现只能使用本机凭据；远程部署必须走显式配置的 launch token。
  if (!isLoopbackBase(baseUrl)) return '';
  const secret = readBrowserSessionSecret();
  if (!secret) return '';
  try {
    return mintBrowserSessionCookie(baseUrl, secret, options);
  } catch {
    return '';
  }
}

/**
 * baseUrl 是否指向本机回环地址。
 *
 * 用途：DSH 的 launch token 是进程启动凭据，换 Cookie 时必须放进 URL 查询串，
 * 一旦发往非回环地址就等于把凭据交给中途的任何一环（代理日志、抓包、对端记录）。
 * 所以默认只允许回环，远程部署需要显式 opt-in。
 */
export function isLoopbackBase(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '[::1]') return true;
    // 127.0.0.0/8 整个网段都是回环
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
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
  'session/projections': 'request',
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

/**
 * `session/follow` 开场快照携带的历史事件条数。
 * DSH 默认 50；调大以便控制台能回填更长的「逐轮花费」历史。
 * 该值只影响首帧大小，不影响后续增量事件。
 */
export const FOLLOW_SNAPSHOT_MESSAGES = 200;

/**
 * 从一份 Session 投影值里取出待处理的 inbox 项（`next-turn` + `next-step`）。
 *
 * DSH 0.2.0 的投影形状（`SessionProjectionValues.inbox`，见 dsh-agent 的
 * `InboxWireState`）：`{ 'next-turn': UserMessage[], 'next-step': UserMessage[] }`，
 * 每条是一个序列化后的 `UserMessage`，**带 `id`（MessageId）** —— 这正是
 * `session/updateQueue` 的 `itemId` 需要的值。
 *
 * 与 0.1.7 的差异（这就是线上「停止旧会话失败: invalid session/control baseline」的根因）：
 * 控制流 baseline 曾经把待处理队列平铺在 `value.queues[<sessionId>]`，0.2.0 起
 * 统一并入投影表 `value.projections[<sessionId>].values`，队列本身变成 `inbox` 键。
 * 只认旧字段的实现会在**每一次**退役/重置会话时抛错，队列清不掉 ⇒ 旧任务继续跑。
 *
 * @param values - 单个会话的投影值（`SessionProjectionValues`）。
 * @returns 待处理项数组；该项能力缺失（无 agent / 无 inbox 投影）时为空数组。
 * @throws 当 inbox 存在但结构不是两个数组字段时——结构变了必须显式失败，
 *         否则会静默漏掉待处理消息（正是上面那个缺陷的形态）。
 */
export function inboxItemsOfProjections(values) {
  if (values === null || typeof values !== 'object') return [];
  const inbox = values.inbox;
  // 能力缺失（会话没有活动 agent / 未注册 inbox 投影）⇒ 没有待处理项，不是错误。
  if (inbox === undefined) return [];
  if (inbox === null || typeof inbox !== 'object' || Array.isArray(inbox)) {
    throw new Error('invalid session inbox projection');
  }
  const items = [];
  for (const boundary of ['next-turn', 'next-step']) {
    const list = inbox[boundary];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error('invalid session inbox projection');
    items.push(...list);
  }
  return items;
}

/**
 * 校验并抽出待处理项的 `itemId` 列表。
 * @throws 当任何一项缺少可用的字符串 id 时——`session/updateQueue` 需要 MessageId，
 *         拿不到就等于清不掉队列，必须显式失败而不是静默跳过。
 */
export function inboxItemIds(items) {
  return items.map((item) => {
    const id = item?.id;
    if (typeof id !== 'string' || !id) throw new Error('invalid session inbox item');
    return id;
  });
}

/**
 * 从 `session/control` 开场 baseline 帧里取出指定会话的待处理项。
 *
 * 0.2.0 的帧形状：`{ type:'baseline', value:{ projections:{ <sessionId>:{ asOfSeq, values } } } }`。
 * baseline 只包含**当前挂在宿主注册表里**的会话；不在其中即「没有活动 agent」⇒ 无待处理项。
 *
 * @throws 当 baseline 的投影表结构不符时（契约变更必须显式失败）。
 */
export function controlBaselineInboxItems(frame, sessionId) {
  const projections = frame?.value?.projections;
  if (projections === null || typeof projections !== 'object' || Array.isArray(projections)) {
    throw new Error('invalid session/control baseline');
  }
  if (!Object.hasOwn(projections, sessionId)) return [];
  return inboxItemsOfProjections(projections[sessionId]?.values);
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
    // 持久化签名密钥的探测缓存：undefined=未探测，null=不可用，Buffer=可用。
    // 探一次就够（文件在 DSH 生命周期内不变），避免每个请求都读一次磁盘。
    this._secret = undefined;
    // token 是用户显式配置的（true）还是从日志猜的（false）。猜来的不优先于离线铸造。
    this.tokenExplicit = this.auth.tokenExplicit === true;
    // 上次用的鉴权策略（'minted' | 'token' | null）与「改用 launch token」的偏好。
    // _preferToken **只在铸造出来的 Cookie 真的被 401 时**才置位（见 _doFetchWithAuth）：
    // invalidateAuth() 也会被 remote.mux 流结束（WS 抖动 / DSH 重启）调用，那是常态事件，
    // 拿它当「铸造无效」的证据会把客户端钉死在过期 token 上。
    this._strategy = null;
    this._preferToken = false;
    // 铸造 Cookie 的到期时刻；到期前主动重铸，避免先撞一次 401 再重试。
    this._cookieExpiresAt = 0;
    // 期望 follow 的会话集合：**跨重连保留**。DSH 重启或 WS 中断后必须重放，
    // 否则已有会话再也收不到 session 事件（turn/end 丢失 → QQ 上永远没有回复，且无报错）。
    this._desiredFollows = new Set();
  }

  /** Node 没有 location；把 base 固定为配置的 DSH 地址（回环地址天然通过 /api 信任栅栏）。 */
  resolveBase() {
    return this.baseUrl;
  }

  /**
   * 换一个 DSH 基址（桌面版每次启动都会换端口，见 src/dsh-endpoint.js）。
   *
   * Cookie 的签名载荷里绑定了 authority（host:port），所以换地址必须同时作废
   * 已铸造/已交换的 Cookie，否则新地址会收到 401 而旧 Cookie 看着「还没过期」。
   * follow 集合（`_desiredFollows`）是会话级、与地址无关，刻意保留：重连后要重放。
   * @param baseUrl - 新的 DSH 基址。
   * @returns 是否真的换了地址。
   */
  rebind(baseUrl) {
    const next = String(baseUrl ?? '').replace(/\/+$/, '');
    if (!next || next === this.baseUrl) return false;
    this.baseUrl = next;
    this.invalidateAuth();
    return true;
  }

  /** 使当前 Cookie/launch token 失效；DSH 重启或 401 后会自动重新发现最新 token。 */
  invalidateAuth() {
    this._authEpoch += 1;
    this.cookie = null;
    this.cookiePromise = null;
    this._cookieExpiresAt = 0;
    // 密钥文件可能刚被 DSH 重建（首次启动写入凭据），重探一次。
    this._secret = undefined;
    // 这里**刻意不碰 _preferToken**：本方法也被 endStream()（remote.mux 流结束）调用，
    // 而 WS 抖动/DSH 重启都会走到那里——那是常态事件，不是「铸造的 Cookie 无效」的证据。
    // 策略切换只在 _doFetchWithAuth 真正收到 401 时决定。
    this._strategy = null;
    const discovered = discoverDshLaunchToken();
    if (discovered) this.launchToken = discovered;
  }

  /** 持久化签名密钥（惰性探测 + 记忆）。 */
  browserSessionSecret() {
    if (this._secret === undefined) this._secret = readBrowserSessionSecret();
    return this._secret;
  }

  /**
   * 是否具备至少一种鉴权手段：显式配置/可发现的 launch token，或持久化签名密钥。
   * 两者都没有时请求按匿名发出——由服务端回 401，而不是在客户端提前抛错。
   */
  hasAuth() {
    return Boolean(this.launchToken) || this.browserSessionSecret() !== null;
  }

  /**
   * 换取或铸造一个会话 Cookie。
   *
   * 两条路：
   * 1. 有 launch token（config.json 的 dsh.authToken，或从日志发现）→ 走 DSH 的
   *    官方 token 交换；token 是进程启动凭据，只能放进 URL 查询串。
   * 2. 没有 launch token → 用持久化签名密钥**离线铸造** Cookie
   *    （见文件头的说明）。这条路不依赖启动器是否把 stdout 记进日志，
   *    所以 DSH 换启动方式/升级都不再需要重新适配。
   * @param signal - 取消信号。
   * @returns 可直接放进 Cookie 头的串。
   */
  /** 铸造并缓存一个会话 Cookie，同时记下到期时刻。 */
  _mintCookie(secret) {
    this.cookie = mintBrowserSessionCookie(this.baseUrl, secret);
    this._cookieExpiresAt = Date.now() + MINTED_COOKIE_LIFETIME_MS;
    this._strategy = 'minted';
    return this.cookie;
  }

  async ensureAuth(signal) {
    signal?.throwIfAborted();
    // 铸造来的 Cookie 到期前主动重铸：铸造是纯本地 HMAC、没有网络往返，
    // 比「用到 401 再重试」便宜，也不会在重试窗口里丢掉一次 RPC。
    if (this.cookie && this._strategy !== 'minted') return this.cookie;
    if (this.cookie && Date.now() < this._cookieExpiresAt - MINTED_COOKIE_REFRESH_MARGIN_MS) return this.cookie;
    this.cookie = null;
    const secret = this.browserSessionSecret();
    // 铸造只对回环地址成立：签名密钥取自本机 DSH_HOME，远程 DSH 用的是另一份密钥，
    // 拿本机密钥去签只会换来 401。
    const canMint = secret !== null && isLoopbackBase(this.baseUrl);
    // 优先级：默认**铸造优先**——它不依赖「启动器有没有把 stdout 记进日志」，也不随
    // DSH 重启失效，是唯一不需要每次升级重新适配的一条路。两个例外：
    // 用户在 config.json 里显式填了 dsh.authToken（那是明确意图，尊重它），
    // 或铸造刚被 401（_preferToken，见 _doFetchWithAuth）。
    if (canMint && !this._preferToken && !this.tokenExplicit) return this._mintCookie(secret);
    if (!this.launchToken) {
      if (canMint) return this._mintCookie(secret);
      throw new Error(
        'DSH 鉴权不可用：没有可用的 launch token（config.json 的 dsh.authToken 为空，日志里也没发现），'
        + `也读不到 ${path.join(resolveDshHome(), '.credentials.yaml')} 里的 `
        + `${BROWSER_SESSION_KEY} 签名密钥。请在 config.json 里显式设置 dsh.authToken，`
        + '或确认 DSH_HOME 指向真正的 .dsh 目录。'
      );
    }
    // launch token 是**进程启动凭据**，交换时只能放进 URL 查询串（DSH 的协议就这么定的）。
    // 因此绝不能把它发往非回环地址：那会把凭据交给中间人、写进对端访问日志、
    // 也可能落在代理/CDN 的请求行日志里。要连远程 DSH 请显式声明 dsh.allowRemote。
    if (!this.auth.allowRemote && !isLoopbackBase(this.baseUrl)) {
      throw new Error(`拒绝把 DSH launch token 发往非本机地址（${this.baseUrl}）：那是进程启动凭据，只应交给 127.0.0.1。确实要连远程 DSH 时请在 config.json 里显式设置 dsh.allowRemote: true`);
    }
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
      this._strategy = 'token';
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
      // _readSessionQueue 已把 inbox 项校验成 MessageId 列表（取不到 id 会直接抛错）。
      const itemIds = await this._readSessionQueue(sessionId, queueSignal);
      for (const itemId of new Set(itemIds)) {
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

  /**
   * 读取一个会话的待处理 inbox 项（退役/重置前要清掉的队列）。
   *
   * 两条路，都解析同一份 `inbox` 投影（见 {@link inboxItemsOfProjections}）：
   * 1. **主路径 `session/projections`**（DSH 0.2.0 起的一元 RPC，非激活读取）：
   *    `{request:{sessionId}}` → `{ asOfSeq, values } | null`。一条普通 HTTP RPC，
   *    可取消、可超时、可单测，不需要为「看一眼队列」开一条 WebSocket。
   * 2. **回退 `session/control`**：该 endpoint 不存在（更早的 DSH）时，退回全宿主
   *    控制流的开场 baseline，从 `value.projections[sessionId].values` 取同一份数据。
   *
   * 历史教训：这里曾经只认 `value.queues[sessionId]`（0.1.7 的形状），0.2.0 把它并入
   * 投影表之后，每次退役会话都抛 "invalid session/control baseline"，队列清不掉、
   * 旧任务继续烧 token。所以现在的解析放在**具名导出**里，由 test-dsh-client-* 直接钉住。
   */
  async _readSessionQueue(sessionId, signal) {
    await this.ensureAuth(signal);
    signal?.throwIfAborted();
    try {
      const response = await this.callUnary('session/projections', { sessionId }, signal);
      if (response.result?.ok) {
        // value === null ⇒ 会话不在宿主注册表里（已归档/从未挂载）⇒ 没有待处理项。
        return inboxItemIds(inboxItemsOfProjections(response.result.value?.values));
      }
      // `session/not-found` 同样意味着没有队列可清；其余错误交给回退路径判定。
      if (response.result?.error?.code === 'session/not-found') return [];
      // endpoint 不存在之类的协议级错误 ⇒ 走 control 流回退。
    } catch (error) {
      signal?.throwIfAborted();
      // 一元 RPC 失败（旧 DSH 不认这个 endpoint / 网关拒绝）时回退，不把异常当结论。
      void error;
    }
    return this._readSessionQueueViaControl(sessionId, signal);
  }

  /** 回退路径：全宿主 `session/control` 流的开场 baseline。 */
  async _readSessionQueueViaControl(sessionId, signal) {
    signal?.throwIfAborted();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, items) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
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
            finish(null, inboxItemIds(controlBaselineInboxItems(frame.value, sessionId)));
          }
        } catch (error) { finish(error); }
      };
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async _doFetchWithAuth(input, init, isRetry) {
    const authEpoch = this._authEpoch;
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (this.hasAuth()) {
      try {
        const cookie = await this.ensureAuth(init?.signal);
        headers.set('cookie', cookie);
      } catch (error) {
        if (!isRetry && this.launchToken && /token exchange failed|invalidated during token exchange/i.test(error?.message ?? '')) {
          // 交换失败通常意味着那个 launch token 已经过期（DSH 重启过，日志里的是上一个
          // 进程的）。解除「改用 token」的偏好，否则客户端会一直抱着一个死 token 不放 ——
          // 这正是「一次 401 之后所有 RPC 永久失败」的成因。
          this._preferToken = false;
          if (authEpoch === this._authEpoch) this.invalidateAuth();
          return this._doFetchWithAuth(input, init, true);
        }
        throw error;
      }
    }
    init?.signal?.throwIfAborted();
    // RPC 主体包含聊天内容，不能随服务端重定向转交给另一端点。
    const response = await fetch(input, { ...init, headers, redirect: 'error' });
    if (!isRetry && response.status === 401 && this.hasAuth()) {
      await response.body?.cancel();
      // 策略切换只在**真的收到 401** 时决定（不能放在 invalidateAuth 里：那里也会被
      // WS 流结束调用）。铸造的 Cookie 被 401 ⇒ 本机密钥对不上（典型：DSH_HOME 指向了
      // 另一个 .dsh），改用 launch token；token 交换被 401 ⇒ 那个 token 已死，改回铸造。
      if (this._strategy === 'minted' && this.launchToken) this._preferToken = true;
      else if (this._strategy === 'token') this._preferToken = false;
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
    /**
     * 取消一个会话的订阅（会话被退役/重置时调用）。
     *
     * 不做这件事的话 `_desiredFollows` 只增不减：每次重连都会为一个早已不存在的会话
     * 重开一条 follow 流，并让 DSH 回一整份历史快照 —— 内存、重连延迟和账本基线行数
     * 都会随「历史上创建过的会话数」线性增长。
     * 已经打开的流由 DSH 在会话消失时自行结束。
     */
    forget: (sessionId) => {
      if (!sessionId) return;
      this._desiredFollows.delete(String(sessionId));
    },
  };

  openRemoteEventStream(signal, onOpen) {
    const gen = this._remoteMuxGenerator(signal, onOpen);
    return {
      [Symbol.asyncIterator]: () => gen,
      follow: (sessionId) => this._followSession(sessionId),
      forget: (sessionId) => { if (sessionId) this._desiredFollows.delete(String(sessionId)); }
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
                address: { kind: 'session', sessionId },
                // 开场快照的历史深度。默认只有 50 条，不足以回填逐轮花费；
                // 调大只影响首帧体积（每个已 follow 的会话一帧），不改变事件通道语义。
                maxMessages: FOLLOW_SNAPSHOT_MESSAGES
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
        } else if (sessionId && msg.value?.type === 'snapshot') {
          // 打开/重连单会话流时的开场快照：带 projections（整条日志的权威 token 累计）
          // 与 records（最多 maxMessages 条历史事件）。
          // **单独一种帧类型**下发，绝不混进 session/event：快照里含历史 turn 的
          // turn/end，若走事件通道会让桥接把「早已结束的回合」当成新的回合去发 QQ 回复。
          enqueue({
            kind: 'frame',
            envelope: {
              rpcId: msg.streamId,
              payload: { type: 'session/snapshot', sessionId, snapshot: msg.value }
            }
          });
        }
        // 其余 snapshot 之外的帧（assistant-stream 等）当前桥接不需要，保持忽略。
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
          // DSH 正常结束了单条会话流（follow 被回收 / 会话被归档 / 服务端空闲清理）。
          // 旧代码在这里什么都不做：不重订阅、不打日志，而重放只在 socket 'open' 时发生，
          // 于是这个会话**永久失联**且毫无提示。更糟的是若它断在回合中间，
          // collectors/v2TurnStartAt 会一直留着 → isConversationBusyV2 永远为真 →
          // 该群所有唤醒都被塞进 pendingWakeReasons，群彻底哑掉且没有租约能救。
          // 这里主动重开一次订阅；仍然想订阅的会话才重开（forget 过的就让它走）。
          if (this._desiredFollows.has(sessionId)) {
            console.error(`[dsh-client] session/follow 已被服务端结束，重新订阅：${sessionId}`);
            setTimeout(() => {
              if (!ended && this._desiredFollows.has(sessionId)) sendOpen(sessionId);
            }, 2000);
          }
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
    },
    /** 当前仍在跟踪（有 start 无 end）的回合数。供调用方判断 collector 是否已成空壳。 */
    size() {
      return turns.size;
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
