// 验证 DSH 0.1.7 的 agent preset 是否真的装上了（只读探测 + 断言）。
//
// 0.1.7 起 preset 不再是 ~/.dsh/.agent-presets/ 下的目录：注册表既不扫描目录也不接受
// preset 路径，preset 变成一条普通的 loader 行（@deepseek-ai/dsh-agent-preset），
// 由 bundle 的 patch 文件插入。所以「装上了没有」只能在运行中的 DSH 上问注册表：
// agentPresets/list 返回的每个 id 都会带 broken 字段（挂载失败时的诊断）。
//
// 用法：node scripts/verify-agent-presets-017.mjs [baseUrl]
//
// 退出码：全部通过 0，任一断言失败 1。
// ⚠️ 不要用 process.exit()：成功路径上 undici 的 keep-alive socket 仍在关闭，
// 强行退出会在 Windows 上触发 libuv 断言（0xC0000409），把成功跑成非 0 退出码。
// 这里只设 process.exitCode，让事件循环自己排空。
import { discoverDshSessionCookie } from '../src/dsh-client.js';
import { discoverDshBaseUrl } from '../src/dsh-endpoint.js';

// 端口不能写死：DSH 桌面版每次启动都换端口（`--port 0`），写死 3080 会让这个校验
// 在没跑过 setup 和跑过 setup 时都报同一种「fetch failed」，完全分不清原因。
const CONFIGURED = process.argv[2] || process.env.DSH_BASE_URL || '';
const DISCOVERED = await discoverDshBaseUrl({ configured: CONFIGURED || 'http://127.0.0.1:3080' });
const BASE = DISCOVERED.baseUrl || CONFIGURED || 'http://127.0.0.1:3080';
if (DISCOVERED.baseUrl && CONFIGURED && DISCOVERED.baseUrl !== CONFIGURED) {
  console.log(`🔄 DSH 端点已自动校正：${CONFIGURED} → ${DISCOVERED.baseUrl}`);
}
const WANTED = ['qq-chat', 'qq-chat-v2'];

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function rpc(cookie, method, args = {}) {
  const rpcId = `verify-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status !== 200 || (body && body.error)) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${body?.error?.message ?? text.slice(0, 200)}`);
  }
  return body?.result?.value;
}

async function main() {
  console.log(`DSH: ${BASE}`);
  const cookie = discoverDshSessionCookie(BASE);
  if (!cookie) {
    console.error('❌ 拿不到 DSH 会话 Cookie（读不到本机 browser session secret）');
    failed += 1;
    return;
  }

  let presets;
  try {
    const value = await rpc(cookie, 'agentPresets/list');
    presets = value?.presets ?? [];
  } catch (error) {
    console.error(`❌ agentPresets/list 调用失败：${error.message}`);
    failed += 1;
    return;
  }
  console.log(`agentPresets/list → ${presets.map((p) => p.id).join(', ')}`);
  for (const preset of presets) {
    if (preset.broken) console.log(`   ⚠️ ${preset.id} broken: ${preset.broken}`);
  }
  for (const id of WANTED) {
    const found = presets.find((p) => p.id === id);
    check(`agentPresets/list 含 ${id}`, found !== undefined);
    // 注册表把「行导入失败 / 服务泄漏」都写进 broken：非空即 preset 不可用（桥接会 fail-closed 拒绝建会话）。
    if (found) check(`${id} 挂载无错误（broken 为空）`, !found.broken, found.broken ?? '');
  }

  // 子行是否真的装上了：agentPresets/read 会把该 preset 的子行清单渲染回 YAML。
  for (const id of WANTED) {
    if (!presets.some((p) => p.id === id)) continue;
    try {
      const doc = await rpc(cookie, 'agentPresets/read', { agentPreset: id });
      const text = String(doc?.content ?? '');
      const rows = text.split('\n').filter((l) => /^- id:/.test(l)).map((l) => l.trim().slice(2));
      check(`${id} 可读回子行清单`, rows.length > 0, rows.join(' | '));
      check(`${id} 含 qq-tool-restrict 守卫行`, text.includes('qq-tool-restrict'));
    } catch (error) {
      check(`${id} agentPresets/read`, false, error.message);
    }
  }
}

await main();
console.log(failed === 0 ? '\n✅ agent preset 验证通过' : `\n❌ ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
