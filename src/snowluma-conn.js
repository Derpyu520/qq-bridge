// SnowLuma 连接自发现：解决「换 QQ 账号后 token 变了，工具就 401」的问题。
//
// 背景（实测确认）：
//   SnowLuma 的 OneBot 配置是**按账号分文件**的：<SnowLuma>/config/onebot_<QQ号>.json，
//   每个账号有各自的 httpServers[].accessToken（**HTTP 与 WebSocket 的 token 还是不同的**）。
//   换账号登录后，旧的 accessToken 直接 401（retcode 1401），
//   于是任何把它硬编码在 config.json 里的工具（独立工具、图形界面、甚至 qq-bridge）全部失效。
//
// 本模块的做法：**不猜**，而是拿候选 token 真去问一次 get_login_info，谁通就用谁，
// 并把"当前是哪个账号"一并回报出来。候选来源：
//   1) 显式传入的 token / 环境变量
//   2) config.json 里已配置的 token（保持兼容）
//   3) SnowLuma config 目录下所有 onebot_*.json 里的 HTTP token（真实来源）
//
// 这样换账号后无需手改任何配置，工具自动跟上。
import fs from 'node:fs';
import path from 'node:path';

/**
 * SnowLuma 主目录的常见位置。
 *
 * 同时接受两种 cfg 形状（踩过坑：图形界面传的是"窄对象"，没有 snowluma 这一层，
 * 于是 homeDir 被忽略、per-account token 一个都扫不到 → 换账号后界面显示未连接）：
 *   - 完整 config：{ snowluma: { homeDir, launcherPath, httpUrl, accessToken } }
 *   - 窄对象：    { homeDir, launcherPath, httpUrl, accessToken }
 */
export function snowLumaHomeCandidates({ cfg = null } = {}) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const sl = cfg?.snowluma ?? cfg ?? {};
  if (sl.homeDir) push(String(sl.homeDir));
  if (sl.launcherPath) push(path.dirname(String(sl.launcherPath)));
  if (process.env.SNOWLUMA_HOME) push(process.env.SNOWLUMA_HOME);
  return out;
}

/**
 * 从 SnowLuma 的 per-account 配置里读出候选 token。
 *
 * 重要：**HTTP 与 WebSocket 是两个不同的 token**（各自的 server 配置里各有一份），
 * 桥接用 WS 连 3001、工具用 HTTP 连 3000，所以两边都要能取到。
 *
 * 返回 [{ uin, file, http: {token,host,port}, ws: {token,host,port} }]，按 uin 排序。
 */
export function readOneBotTokens(homeDir) {
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      const nets = j?.networks ?? {};
      const http = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const ws = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      out.push({
        uin: m[1],
        file: path.join(dir, e.name),
        http: http ? { token: String(http.accessToken ?? ''), host: http.host || '127.0.0.1', port: Number(http.port) || 3000 } : null,
        ws: ws ? { token: String(ws.accessToken ?? ''), host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001 } : null
      });
    } catch {
      // 单个文件坏了不影响其它账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 兼容旧调用：只取 HTTP token 的扁平列表。 */
export function readOneBotHttpTokens(homeDir) {
  return readOneBotTokens(homeDir)
    .filter((a) => a.http)
    .map((a) => ({ token: a.http.token, uin: a.uin, host: a.http.host, port: a.http.port, file: a.file }));
}

/**
 * 读取每个账号 OneBot 配置里 SnowLuma **内置状态指令**（默认 `#sl`）的设置。
 *
 * 为什么单独读：这条指令的回复由 SnowLuma 自己发（版本/平台/架构/运行时长），
 * 不经过桥接，出站审计看不到；桥接只能在进线侧屏蔽 + 启动时告警，
 * 真正的“不回”要在 SnowLuma 侧关闭（scripts/harden-snowluma-status.mjs）。
 *
 * 返回 [{ uin, file, statusCommand: {enabled,swallow,trigger,cooldownSeconds}|null }]。
 * statusCommand 为 null 表示配置文件里没写（SnowLuma 默认=开启）。
 */
export function readOneBotStatusCommands(homeDir) {
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      let text = fs.readFileSync(path.join(dir, e.name), 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const j = JSON.parse(text);
      const sc = j?.statusCommand;
      out.push({
        uin: m[1],
        file: path.join(dir, e.name),
        statusCommand: sc && typeof sc === 'object' && !Array.isArray(sc)
          ? {
              enabled: sc.enabled !== false,
              swallow: sc.swallow === true,
              trigger: String(sc.trigger ?? ''),
              cooldownSeconds: Number(sc.cooldownSeconds) || 0
            }
          : null
      });
    } catch {
      // 单个文件坏了不影响其它账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 试一次 get_login_info；成功返回 data，失败返回 null。 */
async function probe(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' || body.retcode !== 0) return { ok: false, status: res.status, retcode: body.retcode, wording: body.wording };
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 自动找出一条**能用**的连接（token + baseUrl + 账号信息）。
 *
 * @returns {Promise<{ok:boolean, token?:string, baseUrl?:string, self?:object,
 *                    tried?:Array, error?:string, source?:string}>}
 */
export async function discoverSnowLumaConnection({
  cfg = null,
  baseUrl = null,
  token = null,
  homeDirs = null,
  timeoutMs = 6000
} = {}) {
  const sl = cfg?.snowluma ?? cfg ?? {};
  const base = String(baseUrl || process.env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homes = homeDirs ?? snowLumaHomeCandidates({ cfg });
  const explicit = token || process.env.SNOWLUMA_TOKEN || sl.accessToken || '';

  // 候选顺序：显式配置优先（尊重用户选择），然后才是 per-account 文件里的其它账号
  const candidates = [];
  const seen = new Set();
  const add = (tk, source, url) => {
    const key = `${url}|${tk}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ token: tk, source, url });
  };
  if (explicit) add(explicit, 'config/env', base);
  // per-account 文件：同时收 HTTP token（工具用）与 WS 信息（桥接用）。
  // 两个 token 不同、端口也各自记录，不能混用。
  const wsInfo = new Map();   // uin -> { token, url }
  for (const home of homes) {
    for (const entry of readOneBotTokens(home)) {
      if (entry.http) add(entry.http.token, `onebot_${entry.uin}.json`, `http://${entry.http.host}:${entry.http.port}`);
      if (entry.ws?.token) wsInfo.set(entry.uin, { token: entry.ws.token, url: `ws://${entry.ws.host}:${entry.ws.port}` });
    }
  }
  if (!explicit && candidates.length === 0) add('', 'no-token', base);

  const tried = [];
  for (const c of candidates) {
    const r = await probe(c.url, c.token, timeoutMs);
    tried.push({ source: c.source, url: c.url, token: c.token ? c.token.slice(0, 4) + '…' : '(空)', ok: r.ok, status: r.status, wording: r.wording });
    if (r.ok) {
      // 找到有效 HTTP token 后，把**同一个账号**的 WS 信息也带回去：
      // 桥接走 WebSocket，用另一个 token、另一个端口 —— 只修 HTTP 的话桥接仍然 1006 重连。
      const uin = /onebot_(\d+)\.json/.exec(c.source)?.[1] ?? String(r.data?.user_id ?? '');
      const w = wsInfo.get(uin) ?? null;
      return {
        ok: true,
        token: c.token,
        baseUrl: c.url,
        self: r.data,
        source: c.source,
        wsToken: w?.token ?? null,
        wsUrl: w?.url ?? null,
        tried
      };
    }
  }
  const last = tried[tried.length - 1];
  return {
    ok: false,
    tried,
    baseUrl: base,
    error: last?.status === 401
      ? `所有候选 token 都被拒绝（401）。当前账号的 token 可能还没写进 SnowLuma 的 config：请确认 SnowLuma 已登录目标 QQ，且 OneBot HTTP 服务已开启。`
      : `连不上 OneBot HTTP API（${base}）：${last?.wording ?? last?.status ?? '未知错误'}`
  };
}

/**
 * 把当前有效的 token 写回 config.json（可选动作，供 qq-bridge 这类"必须持久化 token"的组件用）。
 * 只在真的换过账号时才写，避免无谓改动。
 * 返回 { updated, from, to }。
 */
/**
 * 只写 accessToken（兼容旧调用）。返回 { updated, from, to } —— 保留 from/to 是因为
 * 既有调用方与测试按这个形状断言（重构时改成 changed 曾把测试打红）。
 */
export function persistToken(cfgPath, newToken) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const old = String(JSON.parse(text).snowluma?.accessToken ?? '');
  const r = persistSnowLumaEndpoint(cfgPath, { accessToken: newToken });
  return { updated: r.updated, from: old, to: newToken };
}

/**
 * 把**已确认可用**的 SnowLuma 端点写回 config.json。
 * 只写传进来的字段，其它配置一律不动；全部一致时不写文件（幂等）。
 * 返回 { updated, changed: {...} }。
 */
export function persistSnowLumaEndpoint(cfgPath, { accessToken, wsUrl, httpUrl } = {}) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  // 读的时候必须吃掉 BOM，否则 JSON.parse 会抛「Unexpected token」。
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const cur = cfg.snowluma ?? {};
  const next = { ...cur };
  const changed = {};
  const consider = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (String(cur[key] ?? '') === String(value)) return;
    changed[key] = { from: cur[key] ?? null, to: value };
    next[key] = value;
  };
  consider('accessToken', accessToken);
  consider('wsUrl', wsUrl);
  consider('httpUrl', httpUrl);
  if (Object.keys(changed).length === 0) return { updated: false, changed: {} };
  cfg.snowluma = next;
  // 原来 hadBom 只用于读、没用回写：用户文件带 UTF-8 BOM 时，我们改一个 token 就把 BOM 吞掉了
  // —— 那是对用户文件的**字节级**静默改动（Windows 编辑器/工具常写 BOM），会让文件在 git 里
  // 显示成整文件重写，也可能影响按字节读它的其它程序。只改该改的字段，编码原样保留。
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, changed };
}
