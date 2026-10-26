// DSH 端点自愈（端口跟随）的离线回归测试。
//
// 为什么需要它：这段逻辑跑在「DSH 连不上」这个本来就最难排查的时刻，
// 而且它的动作是**改写 baseUrl 并写回 config.json** —— 一旦判错，桥接会被
// 指到一个陌生服务上，比不改更糟。所以这里把三条护栏固定下来：
//   1. 端口枚举只认 LISTENING（ESTABLISHED 的对端端口不是"本机在听"）；
//   2. 只有指纹命中的端口才进入验证，且验证不通过绝不切换；
//   3. 看门狗有节流、不猜非回环地址、地址没变时不乱切。
//
// 全部离线：不依赖 DSH 或网络，端口枚举/探测/验证都由假实现注入。
//
// 用法：node scripts/test-dsh-endpoint.mjs
import {
  parseListeningPorts,
  looksLikeDshIndex,
  discoverDshEndpoint,
  createDshEndpointWatch
} from '../src/dsh-endpoint.js';

let pass = 0;
let fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`OK   ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`FAIL ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 1. netstat / ss 解析 ───────────────────────────────────────────────────
const WIN_NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000
  TCP    127.0.0.1:2500         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       777
  TCP    127.0.0.1:12516        127.0.0.1:52000        ESTABLISHED     4242
  TCP    [::1]:3001             [::]:0                 LISTENING       888
  TCP    [::]:445               [::]:0                 LISTENING       4
  UDP    0.0.0.0:500            *:*                                    1234
`;
const winPorts = parseListeningPorts(WIN_NETSTAT);
check('netstat：只取 LISTENING 端口（含 IPv6）',
  JSON.stringify(winPorts) === JSON.stringify([135, 445, 2500, 3001, 3100]), JSON.stringify(winPorts));
check('netstat：ESTABLISHED 的对端端口不算本机在听', !winPorts.includes(12516), JSON.stringify(winPorts));

const SS_OUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      511          127.0.0.1:2500       0.0.0.0:*
LISTEN 0      4096           0.0.0.0:3100         0.0.0.0:*
ESTAB  0      0            127.0.0.1:2500     127.0.0.1:52001
`;
const ssPorts = parseListeningPorts(SS_OUT);
check('ss：解析 LISTEN 行', JSON.stringify(ssPorts) === JSON.stringify([2500, 3100]), JSON.stringify(ssPorts));
check('空输出不炸', parseListeningPorts('').length === 0 && parseListeningPorts(null).length === 0);

// ── 2. 指纹 ────────────────────────────────────────────────────────────────
check('指纹：注入的 __DSH_BOOT__', looksLikeDshIndex('<script>window.__DSH_BOOT__={}</script>') === true);
check('指纹：页面标题', looksLikeDshIndex('<title>DeepSeek Harness</title>') === true);
check('指纹：服务端下发的 dsh-auth- Cookie', looksLikeDshIndex('', 'dsh-auth-abc=v1.x.y; Path=/') === true);
check('指纹：普通网页不算', looksLikeDshIndex('<html><title>router admin</title></html>') === false);
check('指纹：非字符串输入不炸', looksLikeDshIndex(null, null) === false);

// ── 3. 发现流程 ────────────────────────────────────────────────────────────
function makeProbe(table) {
  return async (port) => table[port] ?? null;
}

// 3a. 命中指纹的端口才验证，找到即返回。
{
  const verified = [];
  const found = await discoverDshEndpoint({
    currentBaseUrl: 'http://127.0.0.1:12516',
    excludePorts: [3100],
    listPorts: () => [3000, 3100, 12516, 2500, 2600],
    probe: makeProbe({ 2500: 'dsh', 2600: 'http' }),
    verify: async (baseUrl) => { verified.push(baseUrl); return baseUrl.endsWith(':2500'); }
  });
  check('发现：返回验证通过的回环地址', found === 'http://127.0.0.1:2500', String(found));
  check('发现：只验证指纹命中的端口（不碰普通 HTTP 服务）',
    JSON.stringify(verified) === JSON.stringify(['http://127.0.0.1:2500']), JSON.stringify(verified));
  check('发现：excludePorts 与当前端口都被排除',
    !verified.some((url) => url.includes(':3100') || url.includes(':12516')), JSON.stringify(verified));
}

// 3b. 指纹全灭时退到「会讲 HTTP」的端口，但同样必须验证通过。
{
  const verified = [];
  const found = await discoverDshEndpoint({
    currentBaseUrl: 'http://127.0.0.1:12516',
    listPorts: () => [2500],
    probe: makeProbe({ 2500: 'http' }),
    verify: async (baseUrl) => { verified.push(baseUrl); return true; }
  });
  check('发现：无指纹命中时可用 HTTP 候选兜底', found === 'http://127.0.0.1:2500', String(found));
  check('发现：兜底同样要过验证', verified.length === 1, String(verified.length));
}

// 3c. 验证失败 = 不切换（宁可报错也不指向陌生服务）。
{
  const found = await discoverDshEndpoint({
    currentBaseUrl: 'http://127.0.0.1:12516',
    listPorts: () => [2500],
    probe: makeProbe({ 2500: 'dsh' }),
    verify: async () => { throw new Error('HTTP 401'); }
  });
  check('发现：验证抛错时返回 null', found === null, String(found));
}

// 3d. 没有任何候选（除当前端口外本机没别的监听）。
{
  const found = await discoverDshEndpoint({
    currentBaseUrl: 'http://127.0.0.1:12516',
    listPorts: () => [12516],
    probe: async () => 'dsh',
    verify: async () => true
  });
  check('发现：没有候选端口时返回 null', found === null, String(found));
}

// 3e. 端口枚举本身失败时要吞掉异常（不能把 checkDsh 带崩）。
{
  const logs = [];
  const found = await discoverDshEndpoint({
    currentBaseUrl: 'http://127.0.0.1:12516',
    listPorts: () => { throw new Error('netstat 不存在'); },
    probe: async () => null,
    verify: async () => true,
    log: (line) => logs.push(line)
  });
  check('发现：枚举失败返回 null 并记日志', found === null && logs.length === 1, logs.join(' | '));
}

// ── 4. 看门狗 ──────────────────────────────────────────────────────────────
// 4a. 关闭时不工作。
{
  let applied = 0;
  const watch = createDshEndpointWatch({
    getBaseUrl: () => 'http://127.0.0.1:12516',
    verify: async () => true,
    apply: () => { applied += 1; },
    enabled: () => false,
    listPorts: () => [2500],
    probe: async () => 'dsh'
  });
  const result = await watch.onUnreachable('test');
  check('看门狗：autoDiscover=false 时完全不动', result === null && applied === 0);
}

// 4b. 非回环地址不猜端口。
{
  const logs = [];
  let scanned = 0;
  const watch = createDshEndpointWatch({
    getBaseUrl: () => 'http://10.0.0.5:3080',
    isLoopback: () => false,
    verify: async () => true,
    apply: () => { throw new Error('不该切换'); },
    listPorts: () => { scanned += 1; return [2500]; },
    probe: async () => 'dsh',
    log: (line) => logs.push(line)
  });
  const result = await watch.onUnreachable('test');
  check('看门狗：非回环地址不扫描不切换', result === null && scanned === 0, `scanned=${scanned}`);
  check('看门狗：非回环时给一句明确日志', logs.some((line) => line.includes('端口自愈不适用')), logs.join(' | '));
}

// 4c. 正常切换：apply + persist 各一次，返回新地址。
{
  let current = 'http://127.0.0.1:12516';
  const applied = [];
  const persisted = [];
  const logs = [];
  const watch = createDshEndpointWatch({
    getBaseUrl: () => current,
    isLoopback: (url) => url.includes('127.0.0.1'),
    verify: async (baseUrl) => baseUrl.endsWith(':2500'),
    apply: (baseUrl) => { current = baseUrl; applied.push(baseUrl); },
    persist: (baseUrl) => persisted.push(baseUrl),
    listPorts: () => [2500],
    probe: async () => 'dsh',
    log: (line) => logs.push(line)
  });
  const result = await watch.onUnreachable('settings/describe 失败');
  check('看门狗：切换成功', result === 'http://127.0.0.1:2500' && current === result, String(result));
  check('看门狗：apply/persist 各一次', applied.length === 1 && persisted.length === 1,
    `apply=${applied.length} persist=${persisted.length}`);
  check('看门狗：日志写明自动跟随', logs.some((line) => line.includes('自动跟随')), logs.join(' | '));
  check('看门狗：状态可观测', watch.state().attempts === 1 && watch.state().lastResult === 'switched',
    JSON.stringify(watch.state()));

  // 4d. 节流：紧接着再调一次不应该再扫。
  let scans = 0;
  const watch2 = createDshEndpointWatch({
    getBaseUrl: () => 'http://127.0.0.1:12516',
    verify: async () => true,
    apply: () => {},
    listPorts: () => { scans += 1; return [2500]; },
    probe: async () => 'dsh',
    // 固定时钟：第一次调用距 0 已经够久（可以扫），第二次距上次为 0（必须被节流）。
    now: () => 1_000_000
  });
  await watch2.onUnreachable('first');
  const second = await watch2.onUnreachable('second');
  check('看门狗：60s 内只扫一次', scans === 1 && second === null, `scans=${scans} second=${second}`);
}

// 4e. 唯一的监听端口就是当前端口：这是鉴权/协议问题，不是端口变化，不能动配置。
{
  let applied = 0;
  let persisted = 0;
  let verified = 0;
  const watch = createDshEndpointWatch({
    getBaseUrl: () => 'http://127.0.0.1:2500',
    verify: async () => { verified += 1; return true; },
    apply: () => { applied += 1; },
    persist: () => { persisted += 1; },
    listPorts: () => [2500],
    probe: async () => 'dsh',
    log: () => {}
  });
  const result = await watch.onUnreachable('test');
  check('看门狗：当前端口被排除，鉴权失败不会被误判成端口变化',
    result === null && applied === 0 && persisted === 0 && verified === 0,
    `result=${result} applied=${applied} verified=${verified}`);
}

// 4f. verify 抛异常不能把 onUnreachable 变成未处理拒绝。
{
  const watch = createDshEndpointWatch({
    getBaseUrl: () => 'http://127.0.0.1:12516',
    verify: async () => { throw new Error('boom'); },
    apply: () => { throw new Error('不该切换'); },
    listPorts: () => [2500],
    probe: async () => 'dsh'
  });
  const result = await watch.onUnreachable('test');
  check('看门狗：验证异常被吞成 null', result === null, String(result));
}

console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
