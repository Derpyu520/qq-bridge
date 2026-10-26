// DSH 端点自动跟随（端口自愈）。
//
// 为什么需要它（真实现场）：DSH 桌面版每次启动/更新后绑定的端口**不保证不变**
// （实测从 127.0.0.1:12516 变成 127.0.0.1:2500），而 `config.json` 的 `dsh.baseUrl`
// 是静态值。端口一变，桥接就连到一个没人监听的地址上：事件流每次都是
// 「连接 DSH 事件流…」→「已结束（本次收到 0 帧）」，模型目录只剩一句 `fetch failed`，
// 而 pumpMux 的启发式提示会把它说成「多半是 DSH 侧事件流协议/版本不匹配」——
// 归因成本极高（README 里 issue #34 的同类误诊就是这么来的）。
//
// 做法（只在「真的连不上」时才动）：
//   1. `netstat -ano` / `ss -ltn` 列出本机 LISTENING 端口；
//   2. 对每个端口发一次**不带任何凭据**的 `GET /`，按 DSH 的指纹
//      （`__DSH_BOOT__` / `DeepSeek Harness` / `dsh-auth-` Cookie）粗筛；
//   3. 粗筛出来的候选**必须**用一次真实 RPC（桥接传进来的 `verify`，即
//      `settings/describe`）验证通过才切换。
// 第 3 步是硬门槛：扫到一个会讲 HTTP 的端口不代表它是 DSH。宁可继续用旧地址报错，
// 也不要把桥接指到一个陌生服务上。
//
// 安全边界（改动这块前请先读）：
//   * 只扫回环地址；`dsh.baseUrl` 不是回环时完全不猜（远程 DSH 的端口无从得知）。
//   * 粗筛阶段**不发任何凭据** —— 扫描不会把 Cookie/launch token 交给无关的本地进程。
//   * 即使走到验证阶段，铸造出来的 Cookie 本身绑定了 `host:port`
//     （见 dsh-client.mintBrowserSessionCookie），发给别的本地端口也无法被重放到真 DSH。
//   * 何时启用由 `dsh.autoDiscover` 控制（默认开）；多开 DSH 时可设为 false。
import { execFileSync } from 'node:child_process';

/** 服务端渲染 index.html 时注入的引导全局变量：只有**活着的 DSH** 才会带它。 */
export const DSH_INDEX_MARKERS = Object.freeze(['__DSH_BOOT__', 'DeepSeek Harness']);

/** DSH 会话 Cookie 的名字前缀（见 dsh-client.js 的铸造实现）。 */
export const DSH_COOKIE_MARKER = 'dsh-auth-';

/** 两次扫描之间的最小间隔：事件流 30s 重连、checkDsh 5s 一次，扫描不能跟着那么勤。 */
export const DEFAULT_REDISCOVER_INTERVAL_MS = 60 * 1000;

/** 单个端口的粗筛超时。本机回环正常应在几毫秒内出结果，700ms 只用来兜住野生服务。 */
export const DEFAULT_PORT_TIMEOUT_MS = 700;

/** index.html 读取上限：超过这个体积的响应不可能是 DSH 的引导页。 */
const MAX_INDEX_BYTES = 512 * 1024;

/** 没有命中指纹、退化成「只要是 HTTP 就验一验」时，最多验这么多个端口。 */
const MAX_FALLBACK_VERIFY = 12;

/**
 * 从 `127.0.0.1:2500` / `[::1]:2500` / `0.0.0.0:2500` 这类地址里取出端口。
 * 取不到（或越界）返回 0，调用方按「不是候选」处理。
 */
function portOfLocalAddress(value) {
  const match = /(?:^|[:.])(\d{1,5})$/.exec(String(value ?? '').trim());
  if (!match) return 0;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : 0;
}

/**
 * 解析 `netstat` / `ss` 的监听端口列表。
 *
 * 支持三种真实输出（**保持宽容，但只取 LISTENING**，别把 ESTABLISHED 的对端端口
 * 也当成"本机在听"）：
 *   Windows: `TCP    127.0.0.1:2500     0.0.0.0:0     LISTENING    1234`
 *   Windows: `TCP    [::1]:2500         [::]:0        LISTENING    1234`
 *   Linux ss: `LISTEN 0 511 127.0.0.1:2500 0.0.0.0:*`
 * @param {string} stdout - 命令输出。
 * @returns {number[]} 去重升序的端口。
 */
export function parseListeningPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Windows netstat：第 1 列 TCP、第 2 列本地地址、第 4 列状态、第 5 列 PID。
    const win = /^TCP\s+(\S+)\s+\S+\s+LISTENING\s+\d+\s*$/i.exec(trimmed);
    if (win) {
      const port = portOfLocalAddress(win[1]);
      if (port) ports.add(port);
      continue;
    }
    // ss / netstat -ltn：字段 4 是本地地址（两边恰好都是第 4 个字段）。
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 4 && /^(?:LISTEN|LISTENING|tcp|tcp6)$/i.test(fields[0])) {
      const port = portOfLocalAddress(fields[3]);
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * 列出本机处于 LISTENING 的 TCP 端口。
 *
 * 与 `consolePortInUse()` 一样用系统自带的 netstat/ss：桥接是纯 JS，不引原生模块。
 * 失败时抛错，由调用方决定是「这轮不猜」还是「记日志」。
 */
export function listListeningPorts({ platform = process.platform, exec = execFileSync } = {}) {
  const options = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] };
  const stdout = platform === 'win32'
    ? exec('netstat', ['-ano', '-p', 'TCP'], options)
    : exec('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], options);
  return parseListeningPorts(stdout);
}

/** 这段响应像不像 DSH 的引导页（正文指纹 + 服务端下发的 Cookie 名）。 */
export function looksLikeDshIndex(text, setCookie = '') {
  const body = typeof text === 'string' ? text : '';
  if (DSH_INDEX_MARKERS.some((marker) => body.includes(marker))) return true;
  return typeof setCookie === 'string' && setCookie.includes(DSH_COOKIE_MARKER);
}

/**
 * 对一个本机端口做**无凭据**粗筛。
 * @returns {Promise<'dsh'|'http'|null>} `dsh`=指纹命中；`http`=会讲 HTTP 但不是 DSH；
 *   `null`=端口不通/不是 HTTP/超时（与 DSH 无关）。
 */
export async function probeHttpEndpoint(port, {
  host = '127.0.0.1',
  timeoutMs = DEFAULT_PORT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return null;
  if (typeof fetchImpl !== 'function') return null;
  let response;
  try {
    response = await fetchImpl(`http://${host}:${numeric}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
  } catch {
    // ECONNREFUSED / 非 HTTP / 超时：这个端口和我们无关。
    return null;
  }
  let text = '';
  const contentType = String(response?.headers?.get?.('content-type') ?? '').toLowerCase();
  const contentLength = Number(response?.headers?.get?.('content-length') ?? 0);
  if (contentType.includes('text/html') && (!contentLength || contentLength <= MAX_INDEX_BYTES)) {
    try { text = String(await response.text()).slice(0, 20000); } catch { text = ''; }
  } else {
    // 不读正文也别把连接晾着：undici 对未消费的 body 会占着 socket。
    try { await response?.body?.cancel?.(); } catch {}
  }
  const setCookie = String(response?.headers?.get?.('set-cookie') ?? '');
  return looksLikeDshIndex(text, setCookie) ? 'dsh' : 'http';
}

/** 有限并发地跑一轮（避免 40 个端口同时开 40 个 socket）。 */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * 扫描本机端口，找出一个**真实 RPC 验证通过**的 DSH 端点。
 *
 * @param {object} options
 * @param {string} options.currentBaseUrl - 当前（连不上的）地址，它自己的端口会被排除。
 * @param {number[]} [options.excludePorts] - 不该被当成 DSH 的端口（控制台、SnowLuma 等）。
 * @param {() => number[]} [options.listPorts] - 端口枚举（测试注入）。
 * @param {(port: number) => Promise<'dsh'|'http'|null>} [options.probe] - 粗筛（测试注入）。
 * @param {(baseUrl: string) => Promise<boolean>} options.verify - 真实 RPC 验证（必填）。
 * @param {(message: string) => void} [options.log] - 日志。
 * @param {number} [options.concurrency] - 粗筛并发。
 * @returns {Promise<string|null>} 例如 `http://127.0.0.1:2500`；找不到返回 null。
 */
export async function discoverDshEndpoint({
  currentBaseUrl,
  excludePorts = [],
  listPorts = listListeningPorts,
  probe = probeHttpEndpoint,
  verify,
  log = () => {},
  concurrency = 6
} = {}) {
  if (typeof verify !== 'function') throw new Error('discoverDshEndpoint：需要 verify(baseUrl) 做真实 RPC 验证');
  const excluded = new Set();
  for (const value of excludePorts) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0) excluded.add(port);
  }
  let currentPort = 0;
  try { currentPort = Number(new URL(String(currentBaseUrl)).port) || 0; } catch { currentPort = 0; }
  if (currentPort) excluded.add(currentPort);

  let ports;
  try {
    ports = Array.from(listPorts() ?? []);
  } catch (error) {
    log(`🔎 扫描本机端口失败：${error?.message ?? error}`);
    return null;
  }
  const candidates = [...new Set(ports
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536 && !excluded.has(port)))];
  if (candidates.length === 0) return null;

  const dshPorts = [];
  const httpPorts = [];
  await runPool(candidates, concurrency, async (port) => {
    let verdict = null;
    try { verdict = await probe(port); } catch { verdict = null; }
    if (verdict === 'dsh') dshPorts.push(port);
    else if (verdict === 'http') httpPorts.push(port);
  });

  dshPorts.sort((a, b) => a - b);
  httpPorts.sort((a, b) => a - b);
  // 指纹命中时**只验命中的**：这时还去逐个验证陌生 HTTP 服务，等于拿扫描时间换噪声。
  const ordered = dshPorts.length > 0 ? dshPorts : httpPorts.slice(0, MAX_FALLBACK_VERIFY);
  for (const port of ordered) {
    const baseUrl = `http://127.0.0.1:${port}`;
    let ok = false;
    try { ok = await verify(baseUrl); } catch { ok = false; }
    if (ok) return baseUrl;
  }
  return null;
}

/**
 * 把上面的发现流程包成「连不上时调用一次」的看门狗：自带节流、去重、失败日志限流。
 *
 * @param {object} options
 * @param {() => string} options.getBaseUrl - 当前地址（`() => api.baseUrl`）。
 * @param {(url: string) => boolean} [options.isLoopback] - 是否回环；非回环直接放弃。
 * @param {(baseUrl: string) => Promise<boolean>} options.verify - 真实 RPC 验证。
 * @param {(baseUrl: string) => void} options.apply - 切换地址（改 api.baseUrl + 失效 Cookie）。
 * @param {(baseUrl: string) => void} [options.persist] - 写回 config.json（失败只记日志）。
 * @param {() => boolean} [options.enabled] - 总开关（`dsh.autoDiscover !== false`）。
 * @param {object} [options] - 其余字段透传给 discoverDshEndpoint。
 */
export function createDshEndpointWatch({
  getBaseUrl,
  isLoopback = () => true,
  verify,
  apply,
  persist,
  log = () => {},
  listPorts = listListeningPorts,
  probe = probeHttpEndpoint,
  excludePorts = [],
  enabled = () => true,
  intervalMs = DEFAULT_REDISCOVER_INTERVAL_MS,
  failureLogIntervalMs = 5 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  if (typeof getBaseUrl !== 'function') throw new Error('createDshEndpointWatch：需要 getBaseUrl()');
  if (typeof verify !== 'function') throw new Error('createDshEndpointWatch：需要 verify(baseUrl)');
  if (typeof apply !== 'function') throw new Error('createDshEndpointWatch：需要 apply(baseUrl)');
  let lastAttemptAt = 0;
  let lastFailureLogAt = 0;
  let inflight = null;
  let attempts = 0;
  let lastResult = null;

  async function attempt(reason) {
    const current = String(getBaseUrl() ?? '');
    if (!current) return null;
    if (!isLoopback(current)) {
      // 远程 DSH：没有"他的端口"可猜。保持现状，让日志说清楚。
      if (now() - lastFailureLogAt >= failureLogIntervalMs) {
        lastFailureLogAt = now();
        log(`🔎 dsh.baseUrl 不是本机地址（${current}），端口自愈不适用：请手动确认 DSH 地址`);
      }
      return null;
    }
    lastAttemptAt = now();
    attempts += 1;
    const found = await discoverDshEndpoint({
      currentBaseUrl: current, excludePorts, listPorts, probe, verify, log
    });
    if (!found) {
      lastResult = 'not-found';
      if (now() - lastFailureLogAt >= failureLogIntervalMs) {
        lastFailureLogAt = now();
        log(`🔎 本机没有找到可验证通过的 DSH 端点（${reason || '连接失败'}）：确认 DSH 已启动；如需手动指定请改 config.json 的 dsh.baseUrl`);
      }
      return null;
    }
    if (found === current) {
      // 地址没变却连不上 —— 那是鉴权/协议问题，不是端口问题，别乱切。
      lastResult = 'unchanged';
      return current;
    }
    apply(found);
    if (typeof persist === 'function') {
      try { persist(found); } catch (error) {
        log(`⚠️ DSH 端点已切到 ${found}，但写回 config.json 失败：${error?.message ?? error}`);
      }
    }
    lastResult = 'switched';
    log(`🔎 DSH 端点已自动跟随：${current} → ${found}（DSH 重启后换了端口；已写回 config.json）`);
    return found;
  }

  return {
    /**
     * 探测失败时调用。内部自带节流与并发去重，可以每 5 秒无脑调一次。
     * @returns {Promise<string|null>} 切换后的地址 / 现状地址 / null（未切换）。
     */
    async onUnreachable(reason = '') {
      if (!enabled()) return null;
      if (inflight) return inflight;
      if (now() - lastAttemptAt < intervalMs) return null;
      inflight = attempt(reason)
        .catch((error) => { log(`DSH 端点自愈异常：${error?.message ?? error}`); return null; })
        .finally(() => { inflight = null; });
      return inflight;
    },
    /** 观测用（控制台/测试）：这轮自愈跑了几次、上次结果是什么。 */
    state: () => ({ attempts, lastAttemptAt, lastResult, scanning: Boolean(inflight) })
  };
}
