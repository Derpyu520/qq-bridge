// 读取 DSH 的 settings/describe，列出所有 namespace 与可选模型（只读）。
//
// 输出落在**系统临时目录**（不是仓库里的 state/）：`state/` 被
// scripts/ops/harden-state-acl.mjs 收紧了 ACL（去掉继承 ⇒ 沙箱进程的能力 SID 不在
// ACL 里），在 DSH 沙箱里往 state/ 写文件会 EPERM。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBE_BASE as BASE, probeCookie, probeRpc } from './probe-auth.mjs';

// 鉴权与 RPC 引导统一走 probe-auth.mjs（旧的「读 guard 日志抓 launch token」在
// DSH 0.1.7 起已失效，会让探针一律 401 —— 见该文件头部说明）。
const rpc = probeRpc(probeCookie());
const outDir = path.join(os.tmpdir(), 'qq-bridge-probe-models');
fs.mkdirSync(outDir, { recursive: true });

const out = await rpc('settings/describe', {});
if (!out?.ok) {
  console.error(`settings/describe 失败：${out?.error?.code}: ${out?.error?.message}`);
  process.exit(1);
}
const namespaces = out.value.namespaces;
console.log('=== settings namespaces ===');
for (const ns of namespaces) console.log(' -', ns.ns, '| value:', JSON.stringify(ns.value)?.slice(0, 200));

const modelNs = namespaces.find((n) => n.ns === 'agent-default-model');
if (modelNs) {
  console.log('\n=== agent-default-model schema (JSON) ===');
  console.log(JSON.stringify(modelNs.schema, null, 2).slice(0, 4000));
}

const describeFile = path.join(outDir, 'dsh-settings-describe.json');
fs.writeFileSync(describeFile, JSON.stringify(out, null, 2));
console.log(`\n[saved] ${describeFile}`);

const presets = await rpc('agentPresets/list', {});
const presetsFile = path.join(outDir, 'dsh-agent-presets.json');
fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2));
console.log(`[saved] ${presetsFile}`);
console.log('presets:', presets.value?.presets?.map((p) => p.id).join(', '));
