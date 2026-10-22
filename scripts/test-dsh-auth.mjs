// DSH 鉴权适配回归测试（0.1.7 起）。
//
// 为什么需要这个测试：桥接过去靠「从 ~/.dsh/guard/logs/server-*.out.log 里读
// `?token=`」来拿 DSH 的进程启动 token。DSH 0.1.7 把那个 token 改成
// processLaunchToken() 现生成的 32 字节随机数（只在内存 WeakMap 里，不落盘、
// 不可推导），而 guard 插件退役后也没有启动器再把 stdout 重定向到那个目录 ——
// 于是自动发现会读到**上一个进程的陈旧 token**，换 Cookie 得到 401，
// 整个桥接静默失联。
//
// 现方案：用 ~/.dsh/.credentials.yaml 里持久化的
// `client-connection/browser-session` 签名密钥离线铸造会话 Cookie（见
// src/dsh-client.js）。本测试断言这条路在真实运行的 DSH 上确实通，
// 并且陈旧 token 确实不通（防止有人把发现逻辑改回去而不自知）。
//
// 用法：node scripts/test-dsh-auth.mjs   （需要 DSH 正在运行）
import {
  NodeApiClient, discoverDshLaunchToken, discoverDshSessionCookie,
  readBrowserSessionSecret, resolveDshHome, mintBrowserSessionCookie, isLoopbackBase,
  parseListeningLoopbackPorts
} from '../src/dsh-client.js';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0;
let fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`OK   ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`FAIL ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 纯函数层（不需要 DSH 在线）────────────────────────────────────────────
check('isLoopbackBase 认回环', isLoopbackBase('http://127.0.0.1:3080') === true);
check('isLoopbackBase 拒非回环', isLoopbackBase('http://10.0.0.5:3080') === false);

// DSH 桌面版每次启动随机端口（实测 2601 → 3530），所以桥接会从监听表里找回它。
// 这里钉住解析规则：只取回环 LISTENING、去重、忽略非监听行。
const NETSTAT_FIXTURE = [
  '  TCP    127.0.0.1:3530         0.0.0.0:0              LISTENING       51952',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
  '  TCP    [::1]:3001             [::]:0                 LISTENING       24276',
  '  TCP    127.0.0.1:3530         0.0.0.0:0              LISTENING       51952',
  '  TCP    127.0.0.1:50000        127.0.0.1:3530         ESTABLISHED     51952'
].join('\r\n');
check('netstat 解析只取回环 LISTENING 端口（去重、忽略 ESTABLISHED）',
  JSON.stringify(parseListeningLoopbackPorts(NETSTAT_FIXTURE)) === JSON.stringify([3001, 3530]),
  JSON.stringify(parseListeningLoopbackPorts(NETSTAT_FIXTURE)));

const secret = readBrowserSessionSecret();
check('读到 browser-session 签名密钥（32 字节）', secret?.byteLength === 32, secret ? `${secret.byteLength} bytes` : `未读到（${resolveDshHome()}）`);

if (secret) {
  // Cookie 的形状必须与服务端 decodeCookie/isAuthenticated 的校验一致：
  //   name = 'dsh-auth-' + base64url(sha256(authority))
  //   value = v1.<base64url(json payload)>.<base64url(hmac-sha256)>
  const cookie = mintBrowserSessionCookie(BASE, secret);
  const [name, value] = cookie.split('=');
  const parts = value.split('.');
  check('Cookie 名以 dsh-auth- 开头', name.startsWith('dsh-auth-'));
  check('Cookie 值形如 v1.<body>.<sig>', parts.length === 3 && parts[0] === 'v1');
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  check('payload.authority 等于 baseUrl 的 authority', payload.authority === new URL(BASE).host, payload.authority);
  check('payload 有效期为正且不超过 30 天上限', payload.expiresAt > payload.issuedAt && (payload.expiresAt - payload.issuedAt) <= 30 * 86400000);
}

// ── 端到端（需要 DSH 在线）────────────────────────────────────────────────
const rpc = async (cookie, method, args) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'ta' + Math.random().toString(36).slice(2, 8), method, payload: { args } })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const cookie = discoverDshSessionCookie(BASE);
if (!check('铸造出会话 Cookie', Boolean(cookie))) {
  console.log(results.join('\n'));
  console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

const st = await rpc(cookie, 'settings/describe', {});
check('铸造的 Cookie 能过鉴权（settings/describe）', st.status === 200 && st.body?.result?.ok === true, `HTTP ${st.status}`);

const ap = await rpc(cookie, 'agentPresets/list', {});
const presets = ap.body?.result?.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 可达', ap.status === 200 && presets.length > 0, presets.join(', '));

// NodeApiClient 走真实路径：不传 token、不显式配置 → 应当自动铸造。
const client = new NodeApiClient(BASE, 15000, { tokenExplicit: false });
const viaClient = await client.callUnary('settings/describe', {});
check('NodeApiClient 无 token 也能鉴权', viaClient.result?.ok === true);
check('NodeApiClient 走的是 minted 策略', client._strategy === 'minted', String(client._strategy));

// 回归：remote.mux 流结束（WS 抖动 / DSH 重启 / 服务端回收）会调用 invalidateAuth()，
// 那是**常态事件**。曾经这里会顺手把策略钉到 launch token 上，于是一次普通断线就让
// 客户端永久改用日志里那个过期 token，此后所有 RPC 401，QQ 消息全部静默堆积。
for (let i = 0; i < 3; i += 1) {
  client.invalidateAuth();
  const again = await client.callUnary('settings/describe', {});
  if (!check(`invalidateAuth() 第 ${i + 1} 次后仍走铸造策略`, again.result?.ok === true && client._strategy === 'minted', String(client._strategy))) break;
}

// 铸造的 Cookie 必须能在「到期前主动重铸」——1 小时有效期，没有到期跟踪的话
// 每小时都会先撞一次 401 才恢复。
const firstCookie = client.cookie;
client._cookieExpiresAt = Date.now() - 1; // 假装已过期
const refreshed = await client.callUnary('settings/describe', {});
check('Cookie 过期后自动重铸并继续可用', refreshed.result?.ok === true && client.cookie !== firstCookie, `strategy=${client._strategy}`);

// 陈旧 token 必须失败：证明「读日志」这条老路已经不成立，
// 也防止有人误以为它还在工作。
const stale = discoverDshLaunchToken();
if (stale) {
  const res = await fetch(`${BASE}/?token=${stale}`, { redirect: 'manual' });
  check('日志里的陈旧 token 换 Cookie 失败（老路径确已失效）', res.status !== 303, `HTTP ${res.status}`);
} else {
  results.push('SKIP 日志里没有可发现的 token（若启动器不再记日志，这是预期结果）');
}

console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
