// DSH Web 端点自愈：桌面版每次启动都会换端口。
//
// 为什么需要这个文件（这是本机实测出来的一条适配缺口，不是理论问题）：
//   · 桌面版（Electron）用 `@deepseek-ai/dsh-desktop-host` 启动 Web 宿主，命令行固定带
//     `--port 0`（见 app.asar 内 dsh-desktop-host/lib/index.js）——**由操作系统挑空闲端口**。
//     实测同一台机器四次启动分别是 65292 / 55279 / 61981 / 50996。
//   · 而 config.json 的 `dsh.baseUrl` 是固定值，桥接的 5 秒探活只连这个固定地址。
//     于是用户只要重启一次 DSH，桥接就会永远停在「⚠️ DSH 不可用（重启中？）」，
//     QQ 侧表现为完全不回消息（且日志里不会出现任何 401/连接错误，因为地址是死的）。
//   · CLI 启动的 `dsh web` 可以用 `--port` 固定端口，所以这条路只在「配置的地址探活
//     失败时」才走；成功时一个额外请求都不会发。
//
// 判定方式：候选地址必须能用**同一套离线铸造 Cookie**跑通一次真实的
// `settings/describe` 才认账。绝不因为「这个本地端口开着」就切过去——
// 那会把桥接的请求送给用户机器上任何一个恰好占着端口的本地服务。
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverDshSessionCookie } from './dsh-client.js';

const execFileAsync = promisify(execFile);

/** 单个候选端点的探测上限。探测发生在 5 秒探活循环里，必须短。 */
const PROBE_TIMEOUT_MS = 1500;
/** 单次枚举最多探测多少个端口，避免用户机器上开了一堆服务时扫太久。 */
const MAX_CANDIDATES = 12;
const IS_WINDOWS = process.platform === 'win32';

/** 规范化 DSH 基址：去掉尾部斜杠；不是合法 http(s) 地址时返回 ''。 */
export function normalizeDshBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 探测一个地址是不是「活着的、且认我们的 Cookie 的」DSH。
 *
 * 只发一次 `settings/describe`（桥接每个探活周期本来就在调它），
 * 因此严格来说这是「把同一个探活请求发给另一个候选地址」。
 * @param baseUrl - 候选 DSH 基址。
 * @param options.timeoutMs - 超时上限。
 * @returns 该地址是否返回 ok 的 server-response。
 */
export async function probeDshBaseUrl(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeDshBaseUrl(baseUrl);
  if (!base) return false;
  // 没有签名密钥就没有离线铸造 Cookie；此时不探测（否则每个端口都会 401，白白扫一遍）。
  const cookie = discoverDshSessionCookie(base);
  if (!cookie) return false;
  const endpoint = 'settings/describe';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${Math.random().toString(36).slice(2, 8)}`,
        method: endpoint,
        payload: { args: {} }
      }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.type === 'server-response' && body?.result?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出值得一试的候选地址。
 *
 * 顺序即优先级：`DSH_WEB_URL`（DSH 会把它注入给子进程，从 DSH 里启动桥接时最准）
 * → 配置里的地址 → 本机监听端口（按进程名筛）。
 * @param options.current - 配置里的 baseUrl。
 * @returns 去重后的候选基址数组。
 */
export async function listDshCandidateBaseUrls({ current } = {}) {
  const candidates = [];
  const push = (value) => {
    const base = normalizeDshBaseUrl(value);
    if (base && !candidates.includes(base)) candidates.push(base);
  };
  push(process.env.DSH_WEB_URL);
  push(current);
  if (IS_WINDOWS) for (const port of await windowsListeningPorts()) push(`http://127.0.0.1:${port}`);
  return candidates.slice(0, MAX_CANDIDATES);
}

/**
 * 本机监听中的、像 harness 的端口。
 *
 * 只认进程名是 DeepSeek Harness / dsh / electron 的（桌面版就是
 * "DeepSeek Harness.exe"）；`node.exe` 兜底垫后——CLI 方式跑起来的 `dsh web`
 * 是 node.exe，但 node.exe 也可能是任何开发服务器，所以排在最后。
 * @returns 端口号数组（去重、按「像 harness」优先排序）。
 */
async function windowsListeningPorts() {
  let netstatOut = '';
  let tasklistOut = '';
  try {
    const [netstat, tasklist] = await Promise.all([
      execFileAsync('netstat', ['-ano'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
      execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    ]);
    netstatOut = netstat.stdout;
    tasklistOut = tasklist.stdout;
  } catch {
    return [];
  }
  const imageByPid = new Map();
  for (const line of tasklistOut.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (match) imageByPid.set(match[2], match[1]);
  }
  const harness = new Set();
  const node = new Set();
  for (const line of netstatOut.split(/\r?\n/)) {
    // TCP    127.0.0.1:50996    0.0.0.0:0    LISTENING    5328
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const port = Number(match[1]);
    const image = imageByPid.get(match[2]) ?? '';
    if (!Number.isInteger(port) || port <= 0) continue;
    if (/deepseek|harness|dsh|electron/i.test(image)) harness.add(port);
    else if (/^node(\.exe)?$/i.test(image)) node.add(port);
  }
  return [...harness, ...node];
}

/**
 * 找到真正在跑的 DSH。
 * @param options.current - 配置里的 baseUrl（作为候选之一）。
 * @param options.log - 诊断日志回调。
 * @returns 探通的基址；找不到返回 null。
 */
export async function discoverDshBaseUrl({ current, log = () => {} } = {}) {
  const candidates = await listDshCandidateBaseUrls({ current });
  for (const base of candidates) {
    if (await probeDshBaseUrl(base)) return base;
  }
  if (candidates.length > 1) {
    log(`DSH 端点自愈：试过 ${candidates.length} 个候选地址，没有一个响应 settings/describe`);
  }
  return null;
}

// 手动排障入口：`node src/dsh-endpoint.js` 打印「现在真正在跑的 DSH 地址」。
// 用途：桌面版重启后想确认 config.json 里的 dsh.baseUrl 是不是过期了。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configured = (() => {
    try {
      const file = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
      return file?.dsh?.baseUrl ?? '';
    } catch {
      return '';
    }
  })();
  const found = await discoverDshBaseUrl({ current: configured, log: (message) => console.error(message) });
  console.log(found ?? '');
  process.exitCode = found ? 0 : 1;
}