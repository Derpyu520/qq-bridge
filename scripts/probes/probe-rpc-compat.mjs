// 对比探测：逐条验证桥接实际使用的 RPC 参数形状在新版 DSH 上是否被接受。
import { probeCookie, probeRpc, probeWorkspaceDir } from './probe-auth.mjs';

// 鉴权与 RPC 引导统一走 probe-auth.mjs（旧的「读 guard 日志抓 launch token」在
// DSH 0.1.7 起已失效，会让探针一律 401 —— 见该文件头部说明）。
const rawRpc = probeRpc(probeCookie());
async function rpc(endpoint, args) {
  const slot = await rawRpc(endpoint, args);
  if (slot?.ok) return { ok: true, value: slot.value };
  return { ok: false, code: slot?.error?.code, msg: slot?.error?.message };
}

function report(label, r, extra = '') {
  if (r.ok) console.log(`  ✅ ${label} ${extra}`);
  else console.log(`  ❌ ${label} -> ${r.code}: ${r.msg}`);
  return r;
}

// 只报告字段校验结果，不打印敏感内容
function shapeOf(r) {
  if (!r.ok) return '';
  const v = r.value;
  if (v === null || v === undefined) return 'value=null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return 'keys=' + Object.keys(v).slice(0, 12).join(',');
}

console.log('=== 1. session/create（桥接用 { cwd }） ===');
// 探测工作区建在系统临时目录：state/ 的 ACL 被收紧过，沙箱里写不进去。
const cwd = probeWorkspaceDir('rpc-compat');
const created = report('session/create {cwd}', await rpc('session/create', { request: { cwd } }), '(待清理)');
const sessionId = created.ok ? created.value.sessionId : null;

console.log('\n=== 2. session/create 带 agentPreset（preset 是否存在 + 是否接受该字段） ===');
const createdPreset = report('session/create {cwd, agentPreset:"qq-chat-v2"}', await rpc('session/create', { request: { cwd, agentPreset: 'qq-chat-v2' } }));
const presetSessionId = createdPreset.ok ? createdPreset.value.sessionId : null;

console.log('\n=== 3. session/selectModel（桥接用 {sessionId, provider, model, reasoningEffort}） ===');
if (sessionId) {
  report('selectModel deepseek-official/deepseek-flash/max',
    await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } }));
  report('selectModel 旧模型 deepseek-v4-flash-vision-exp（应仍可用或报错）',
    await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'max' } }));
}

console.log('\n=== 4. session/prompt（桥接用 {sessionId, mode:"queue", content:[{type:"text",text}]} + requestId） ===');
if (sessionId) {
  report('prompt 无 requestId',
    await rpc('session/prompt', { request: { sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } }));
  report('prompt 带 requestId',
    await rpc('session/prompt', { request: { sessionId, requestId: 'probe-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } }), shapeOf(await rpc('session/prompt', { request: { sessionId, requestId: 'probe2-' + Date.now(), mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] } })));
}

console.log('\n=== 5. session/list（桥接用 _request 包装） ===');
report('session/list {_request:{}}', await rpc('session/list', { _request: {} }));

console.log('\n=== 6. workspace/*（桥接用于建/查工作区） ===');
report('workspace/list', await rpc('workspace/list', { request: {} }));
report('workspace/create {title}', await rpc('workspace/create', { request: { title: '__probe-015__' } }));

console.log('\n=== 7. agentPresets/list ===');
report('agentPresets/list {}', await rpc('agentPresets/list', {}));

console.log('\n=== 8. settings/describe ===');
report('settings/describe {}', await rpc('settings/describe', {}));

console.log('\n=== 9. session/rename / session/page / session/search ===');
if (sessionId) report('session/rename', await rpc('session/rename', { request: { sessionId, title: '__probe__' } }));
report('session/page', await rpc('session/page', { request: {} }));
report('session/search', await rpc('session/search', { request: { query: 'probe' } }));

console.log('\n=== 清理探测会话 ===');
for (const sid of [sessionId, presetSessionId].filter(Boolean)) {
  const r = await rpc('workspace/archiveSession', { request: { sessionId: sid } });
  console.log(`  archive ${sid}: ${r.ok ? 'ok' : r.code + ' ' + r.msg}`);
}
// 列出 session 里是否还有探测会话
const list = await rpc('session/list', { _request: {} });
if (list.ok) {
  const ids = (list.value.items ?? []).map((i) => i.sessionId);
  console.log('  remaining sessions count:', ids.length);
}
