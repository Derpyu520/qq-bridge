// 探测 DSH settings 命名空间机制：列出全部命名空间（重点 `qq-mode`）并**幂等写回原值**
// 验证写入路径，同时打印桥接关心的几个命名空间。
//
// 用途：控制台「改模式不生效 / 被回滚」时的第一手诊断 —— 它能区分「命名空间不可见」
// 「schema 校验拒了」「写穿失败」三种情况。鉴权走 probe-auth.mjs（离线铸造 Cookie）。
//
// 幂等性：只把**读到的值原样写回**，不会改动用户配置。
import { PROBE_BASE as BASE, probeCookie, probeRpc } from './probe-auth.mjs';

const rpc = probeRpc(probeCookie({ base: BASE }));

const st = await rpc('settings/describe', {});
console.log('settings/describe ok =', st?.ok === true);
const namespaces = st?.value?.namespaces ?? [];
console.log('命名空间总数:', namespaces.length);
console.log('全部命名空间:', namespaces.map((n) => n.ns).join(', '));

const qq = namespaces.find((n) => n.ns === 'qq-mode');
console.log('\n=== qq-mode 命名空间 ===');
if (!qq) console.log('❌ 未出现在 describe 里');
else {
  console.log('ns       =', qq.ns);
  console.log('keys     =', Object.keys(qq).join(','));
  console.log('value    =', JSON.stringify(qq.value));
  console.log('revision =', qq.revision);
}

// 幂等写回：把当前 mode 原样写回一次，验证写入路径通不通。
// 注意 0.2.0 的 settings/update 是**多参数** RPC：args 是 { ns, patch, expectedRevision }
// 平铺，不是 { request: {...} }（探测时传 request 会被网关拒为
// `gateway/arguments-invalid: missing "ns", "patch"; unexpected "request"`）。
if (qq) {
  const current = qq.value?.mode;
  const up = await rpc('settings/update', { ns: 'qq-mode', patch: { mode: current }, expectedRevision: qq.revision });
  console.log('\n=== settings/update（写回原值） ===');
  console.log(up?.ok === true ? `✅ 写入成功 accepted=${JSON.stringify(up.value)}` : `❌ ${up?.error?.code}: ${up?.error?.message}`);
  const again = await rpc('settings/describe', {});
  const qq2 = (again?.value?.namespaces ?? []).find((n) => n.ns === qq.ns);
  console.log('写回后 value =', JSON.stringify(qq2?.value), 'revision =', qq2?.revision);
}

// 其他桥接关心的命名空间
console.log('\n=== 桥接关心的命名空间 ===');
for (const want of ['agent-preset-registry', 'agent-default-model', 'llm-deepseek', 'permission-presets']) {
  const hit = namespaces.find((n) => n.ns === want);
  console.log(`  ${hit ? '✅' : '❌'} ${want}${hit ? ` = ${JSON.stringify(hit.value)?.slice(0, 120)}` : ''}`);
}
process.exit(0);
