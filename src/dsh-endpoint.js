// DSH 端点自动发现：启动时找出**真正在跑**的 DSH 端口。
//
// 为什么需要这个文件
// ────────────────────────────────────────────────────────────────────────────
// DSH 桌面版启动 web 服务时把端口交给系统分配（安装包内部写死 `--port 0`），
// 于是**每重启一次 DSH，端口就换一个**。而 `config.json` 里的 `dsh.baseUrl`
// 是写死的常量，对不上时 WS 握手直接失败。
//
// 更麻烦的是失败的样子：`dsh-client.js` 的 `handleError → endStream` 是静默
// 结束，日志里只剩一句「DSH 事件流已结束（本次收到 0 帧）」，随后触发
// 「多半是协议/版本不匹配」的提示 —— 端口错被误判成协议不兼容，正是 issue
// #34 里三个人卡住的地方。
//
// SnowLuma 一侧有 `followDiscoveredEndpoint` 端点自愈，DSH 这一侧一直没有；
// 本模块补的就是这块：不改协议、不猜端口，只做「列候选 → 逐个验特征 → 命中即用」。
//
// 发现顺序（越靠前越便宜，前一档命中就不走下一档）
//   1. 配置里的 baseUrl：端口没变时 **0 成本**（实测 3ms），也保证常规启动行为完全不变；
//   2. DSH 进程自己监听的端口：`tasklist` 按进程名拿 PID，`netstat` 按 PID 取端口，
//      候选通常只有 1~2 个（实测 ~1.4s、零误报）；
//   3. 本机全部回环监听端口：只对**没有**命中的情况兜底，纯 `GET /` 看特征，
//      实测 75 个端口并发 446ms。
//
// 判定「这是不是 DSH」只认 HTTP 响应特征，不认端口号：写死端口号正是本 bug 的成因。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const exec = promisify(execFile);

/**
 * 未鉴权时 DSH 的 401 正文（实测原文）：
 *   `dsh web authentication required; reopen the URL printed by dsh web.`
 * 这是最可靠的指纹 —— 它只在 DSH 的 web 层出现。
 */
const DSH_UNAUTH_HINT = /dsh web authentication required/i;
/** 带有效 Cookie 时返回的是 WebUI 首页，没有 401 正文，用前端资源名兜底。 */
const DSH_WEBUI_HINT = /dsh-auth-|deepseek[\s-]*harness|dsh-web/i;
/** 进程名匹配：桌面版是 `DeepSeek Harness.exe`，CLI 版通常叫 `dsh`。 */
const DSH_PROCESS_HINT = /deepseek[\s-]*harness|^dsh(\.exe)?$/i;

/** 全部回环端口扫描的并发上限 —— 本机监听端口一般不到 100，够用且不会打爆 FD。 */
const SCAN_CONCURRENCY = 64;
/** 单端口探测超时：本机回环正常响应 <10ms，400ms 足够区分「死端口」和「慢端口」。 */
const DEFAULT_PROBE_TIMEOUT_MS = 400;

/** baseUrl 是否指向本机（只有本机 DSH 才谈得上「自动找端口」）。 */
export function isLoopbackHost(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.replace(/^\[|\]$/g, '');
    return /^(127\.\d+\.\d+\.\d+|localhost|::1|0\.0\.0\.0)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * 探测一个地址上是不是 DSH web 服务。
 * @param {string} baseUrl - 例如 `http://127.0.0.1:14446`
 * @returns {Promise<{ok: boolean, status?: number, reason: string}>}
 *   reason: `auth-required` | `webui` | `not-dsh` | `unreachable` | `timeout` | `bad-url`
 */
export async function probeDshBaseUrl(baseUrl, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'bad-url' };
  const target = new URL('/', url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // redirect: 'manual' —— 有些本地服务会把 `/` 302 到登录页，跟随时会打到别的端口，
    // 那样「这个端口是不是 DSH」的结论就不成立了。
    const res = await fetch(target, {
      signal: ac.signal,
      redirect: 'manual',
      headers: { accept: 'text/html,*/*' }
    });
    const body = await res.text().catch(() => '');
    if (res.status === 401 && DSH_UNAUTH_HINT.test(body)) {
      return { ok: true, status: res.status, reason: 'auth-required' };
    }
    if (res.ok && DSH_WEBUI_HINT.test(body)) {
      return { ok: true, status: res.status, reason: 'webui' };
    }
    return { ok: false, status: res.status, reason: 'not-dsh' };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? '';
    if (error?.name === 'AbortError' || code === 'ABORT_ERR') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: code || 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 `netstat -ano -p TCP` 输出里处于 LISTENING 的回环端口。导出仅为可测。 */
export function parseNetstatListeners(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    //   TCP    127.0.0.1:14446        0.0.0.0:0              LISTENING       36668
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!m) continue;
    const [, addr, port, pid] = m;
    // 只认「从本机访问得到」的绑定：回环与通配地址。
    if (!/^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::\]|\[::1\]|::|::1)$/.test(addr)) continue;
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0) continue;
    out.push({ port: p, pid: String(pid), address: addr });
  }
  return out;
}

/** 解析 `tasklist /FO CSV /NH` 输出，返回匹配 DSH 进程名的 PID 集合。导出仅为可测。 */
export function parseDshPids(text) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    // CSV 每列都被引号包住，进程名里可能带逗号，所以只取前两列。
    const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
    if (cols.length < 2) continue;
    if (DSH_PROCESS_HINT.test(cols[0].trim())) pids.add(cols[1].trim());
  }
  return pids;
}

/** 列出本机监听端口。Windows 走 netstat（无依赖、免管理员）；其它平台尽量用 lsof。 */
async function listListeningPorts() {
  if (process.platform === 'win32') {
    const { stdout } = await exec('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20
    });
    return parseNetstatListeners(stdout);
  }
  try {
    const { stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8', maxBuffer: 16 << 20
    });
    const out = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = line.match(/(\S+):(\d+)\s+\(LISTEN\)/);
      if (m) out.push({ port: Number(m[2]), pid: '', address: m[1] });
    }
    return out;
  } catch {
    return [];
  }
}

/** 取 DSH 进程的 PID 集合。拿不到时返回空集（不致命，会退到全端口扫描）。 */
async function listDshPids() {
  if (process.platform !== 'win32') return new Set();
  try {
    const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20
    });
    return parseDshPids(stdout);
  } catch {
    return new Set();
  }
}

/** 分批并发探测，避免一次性开出上百个连接。 */
async function probeMany(ports, timeoutMs) {
  const hits = [];
  for (let i = 0; i < ports.length; i += SCAN_CONCURRENCY) {
    const batch = ports.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (port) => {
      const r = await probeDshBaseUrl(`http://127.0.0.1:${port}`, { timeoutMs });
      return r.ok ? { port, reason: r.reason } : null;
    }));
    for (const r of results) if (r) hits.push(r);
    // 已经命中就不必继续扫剩下的批次：调用方只需要一个可用端点。
    if (hits.length > 0) break;
  }
  return hits;
}

/**
 * 找出可用的 DSH 端点。
 *
 * @param {object} options
 * @param {string} [options.configured] - config.json 里的 baseUrl，优先验证
 * @param {number} [options.timeoutMs] - 单端口探测超时
 * @param {boolean} [options.deep] - true=即使配置可达也继续枚举（诊断用）
 * @param {string[]} [options.skipPorts] - 明确不探测的端口（例如桥接自己的控制台）
 * @returns {Promise<{
 *   baseUrl: string|null,
 *   source: 'configured'|'process'|'scan'|'none',
 *   candidates: Array<{port: number, reason: string, source: string}>,
 *   scanned: number,
 *   skipped?: 'remote'
 * }>}
 */
export async function discoverDshBaseUrl({
  configured = '',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  deep = false,
  skipPorts = []
} = {}) {
  const skip = new Set(skipPorts.map(Number).filter(Number.isInteger));
  const candidates = [];
  let scanned = 0;

  // 远程 DSH（`dsh.allowRemote` 场景）不参与发现：本机扫出来的端口跟它没关系，
  // 覆盖掉只会把用户显式指定的地址偷偷改坏。发现只对回环地址成立。
  if (configured && !isLoopbackHost(configured)) {
    return { baseUrl: configured, source: 'configured', candidates: [], scanned: 0, skipped: 'remote' };
  }

  // ── 第 1 档：配置值 ──
  if (configured) {
    scanned += 1;
    const r = await probeDshBaseUrl(configured, { timeoutMs });
    if (r.ok) {
      candidates.push({ port: Number(new URL(configured).port) || 80, reason: r.reason, source: 'configured' });
      if (!deep) return { baseUrl: configured, source: 'configured', candidates, scanned };
    }
  }

  const listeners = await listListeningPorts();
  const ports = [...new Set(listeners.map((l) => l.port))].filter((p) => !skip.has(p));

  // ── 第 2 档：DSH 进程自己的监听端口 ──
  const dshPids = await listDshPids();
  if (dshPids.size > 0) {
    const owned = [...new Set(
      listeners.filter((l) => dshPids.has(l.pid)).map((l) => l.port)
    )].filter((p) => !skip.has(p));
    scanned += owned.length;
    for (const port of owned) {
      const r = await probeDshBaseUrl(`http://127.0.0.1:${port}`, { timeoutMs });
      if (r.ok) candidates.push({ port, reason: r.reason, source: 'process' });
    }
    const hit = candidates.find((c) => c.source === 'process');
    if (hit) return { baseUrl: `http://127.0.0.1:${hit.port}`, source: 'process', candidates, scanned };
  }

  // ── 第 3 档：全回环端口扫描（兜底；CLI 版 DSH 的进程名可能是 node，第 2 档认不出）──
  const remaining = ports.filter((p) => !candidates.some((c) => c.port === p));
  scanned += remaining.length;
  const found = await probeMany(remaining, timeoutMs);
  for (const f of found) candidates.push({ port: f.port, reason: f.reason, source: 'scan' });
  if (found.length > 0) {
    // 多个 DSH 同时在线（例如 desktop 与 web 两份 profile）：取端口最小的那个保持稳定，
    // 并把全部候选交回调用方打日志，避免「每次都连到不同实例」的随机感。
    const chosen = found.slice().sort((a, b) => a.port - b.port)[0];
    return { baseUrl: `http://127.0.0.1:${chosen.port}`, source: 'scan', candidates, scanned };
  }

  return { baseUrl: null, source: 'none', candidates, scanned };
}

/**
 * 把**已验证可用**的 dsh.* 字段写回 config.json。
 * 只改传进来的字段，其它配置与 BOM 一律原样保留（与 snowluma-conn 的
 * persistSnowLumaEndpoint 同款约定：不因为改一个值就把整个文件重写）。
 * @returns {{updated: boolean, changed: Record<string, {from: any, to: any}>}}
 */
export function persistDshFields(cfgPath, fields = {}) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const cur = cfg.dsh ?? {};
  const next = { ...cur };
  const changed = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (String(cur[key] ?? '') === String(value)) continue;
    changed[key] = { from: cur[key] ?? null, to: value };
    next[key] = value;
  }
  if (Object.keys(changed).length === 0) return { updated: false, changed: {} };
  cfg.dsh = next;
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, changed };
}

/**
 * 把**已验证可用**的 DSH baseUrl 写回 config.json。
 * @returns {{updated: boolean, from: string|null, to: string|null}}
 */
export function persistDshBaseUrl(cfgPath, baseUrl) {
  const r = persistDshFields(cfgPath, { baseUrl });
  return {
    updated: r.updated,
    from: r.changed.baseUrl?.from ?? baseUrl,
    to: baseUrl
  };
}
