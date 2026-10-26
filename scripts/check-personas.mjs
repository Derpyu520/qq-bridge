// 人格 / 会话体检（只读）：角色卡、绑定、卡片指纹、摘要与自身历史的人格串台。
//
// 用法：
//   node scripts/check-personas.mjs          # 人读表格
//   node scripts/check-personas.mjs --json   # 机器可读
//
// 判定口径：
//   · selfForeign：机器人自己的历史消息里出现「另一个人格」的名字 —— 真串台，必须清；
//   · digestForeign：摘要里出现别人格的名字 —— 只作提示（群里可能有同名群友/别的 bot，
//     摘要本来就会提到他们；要人工看有没有把别人的事写成「我」）；
//   · personForeign：人物卡里出现别的人格名 —— 多为群友/别的 bot 的名字，只作提示。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const readJson = (rel, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return fallback; }
};
const rolesDir = path.join(ROOT, 'roles');
const roleFiles = fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3));
const roleState = readJson('state/current-role.json', { role: null, mode: 'active', byKey: {} });
const sessions = readJson('state/sessions.json', { sessions: {}, sessionPolicies: {} });
const social = readJson('state/social-v2.json', { conversations: {} });
const digests = readJson('state/digests.json', {});
const mode = readJson('state/mode.json', { mode: '' });

const aliases = {
  // 只列本仓库自带的两张卡；加了自己的角色卡就补在这里，串台检查才覆盖得到。
  '小鲸鱼': ['小鲸鱼', '鲸鱼', '大肥鱼'],
  '傲娇助手': ['傲娇助手'],
};
// 允许在自述里提名字的人物：同一作品里的角色互相提到对方属正常内容，不算串台。
// 格式：'角色名': ['允许提到的名字', ...]
const allowMentions = {};
const allNames = Object.keys(aliases);
const effectiveRole = (key) => roleState.byKey?.[key] || roleState.role || null;
const hitNames = (text) => allNames.filter((n) => aliases[n].some((a) => String(text ?? '').includes(a)));

// 从角色卡里抽行为合同（只读展示，不参与判定）
function cardInfo(name) {
  try {
    const text = fs.readFileSync(path.join(rolesDir, name + '.md'), 'utf8');
    const contract = (text.match(/##\s*行为合同([\s\S]*?)(?=\n##\s|$)/)?.[1] ?? '');
    const line = (label) => (contract.match(new RegExp(`-\\s*${label}：([^\\n]+)`))?.[1] ?? '').trim();
    return {
      chars: text.length,
      proactive: line('主动'),
      atMention: line('被@'),
      length: line('默认长度'),
      hasContract: Boolean(contract.trim()),
    };
  } catch { return { chars: 0, proactive: '', atMention: '', length: '', hasContract: false }; }
}

const out = {
  mode: mode.mode,
  defaultRole: roleState.role ?? null,
  assignments: roleState.byKey ?? {},
  roleFiles,
  roles: roleFiles.map((name) => ({ name, ...cardInfo(name) })),
  missingRoleFiles: [],
  keys: [],
  realIssues: [],
  hints: [],
};

for (const [key, role] of Object.entries(roleState.byKey ?? {})) {
  if (!roleFiles.includes(role)) out.missingRoleFiles.push({ key, role });
}
if (roleState.role && !roleFiles.includes(roleState.role)) out.missingRoleFiles.push({ key: '<default>', role: roleState.role });

const convKeys = new Set([
  ...Object.keys(social.conversations ?? {}),
  ...Object.keys(sessions.sessions ?? {}),
  ...Object.keys(roleState.byKey ?? {}),
]);

for (const key of [...convKeys].sort()) {
  const st = social.conversations?.[key] ?? null;
  const role = effectiveRole(key);
  const sess = sessions.sessions?.[key] ?? null;
  const policy = sessions.sessionPolicies?.[key] ?? null;
  const fp = String(st?.roleCardFp ?? '');
  const fpRole = fp ? fp.split(':')[0] : '';
  const digest = digests[key]?.text ?? '';
  const digestHits = hitNames(digest);
  const digestForeign = digestHits.filter((n) => n !== role);
  const selfTexts = (st?.recentMessages ?? []).filter((m) => m?.isSelf).map((m) => String(m.plain || m.text || ''));
  const allowed = new Set(allowMentions[role] ?? []);
  const selfHits = [...new Set(selfTexts.flatMap(hitNames))];
  const selfForeign = selfHits.filter((n) => n !== role && !allowed.has(n));
  const personTexts = Object.values(st?.people ?? {}).flatMap((p) => [
    ...(p?.facts ?? []).map((f) => f?.text),
    ...(p?.episodes ?? []).map((e) => e?.summary),
    p?.lastInteraction?.theirLast,
    p?.lastInteraction?.myLast,
  ]);
  const personHits = [...new Set(personTexts.flatMap(hitNames))];
  const personForeign = personHits.filter((n) => n !== role);
  const staleFp = Boolean(fpRole && role && fpRole !== role);
  const entry = {
    key, role, session: Boolean(sess), policy,
    roleCardFp: fp || '(empty)', staleFp,
    digestChars: digest.length, digestForeign,
    selfMessages: selfTexts.length, selfForeign,
    personForeign,
    batch: st?.wakeConfig?.batchWindowMs ?? null,
    wakeMode: st?.wakeConfig?.mode ?? null,
    muted: st?.wakeConfig?.muted === true,
  };
  out.keys.push(entry);
  if (!role) out.realIssues.push(`${key}: 生效人格为空`);
  if (role && !roleFiles.includes(role)) out.realIssues.push(`${key}: 生效人格「${role}」没有角色卡`);
  if (staleFp) out.realIssues.push(`${key}: 卡片指纹属于「${fpRole}」，当前人格是「${role}」`);
  if (selfForeign.length) out.realIssues.push(`${key}: 自身历史消息提到其他人物「${selfForeign.join('、')}」`);
  if (digestForeign.length) out.hints.push(`${key}: 摘要里出现「${digestForeign.join('、')}」——可能是在说群友/别的 bot，人工确认是否把别人的事写成了「我」`);
  if (policy && !String(policy).includes('qq-chat-v3')) out.realIssues.push(`${key}: 会话策略不是 qq-chat-v3（${policy}）`);
  if (personForeign.length) out.hints.push(`${key}: 人物卡里出现「${personForeign.join('、')}」（可能是群友/别的 bot，人工确认）`);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`模式: ${out.mode}   默认人格: ${out.defaultRole}`);
  console.log('\n角色卡:');
  console.log('  名称            字符   主动        被@         长度');
  for (const r of out.roles) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.chars).padStart(5)}  ${r.proactive || '-'.padEnd(10)}  ${(r.atMention || '-').slice(0, 10).padEnd(10)}  ${r.length || '-'}`);
  }
  console.log('\n会话:');
  for (const k of out.keys) {
    console.log(`  ${k.key.padEnd(24)} role=${String(k.role).padEnd(8)} session=${k.session ? 'yes' : 'no '} batch=${k.batch ?? '-'} digest=${k.digestChars} 自身历史=${k.selfMessages} foreign=${JSON.stringify(k.selfForeign)} digestForeign=${JSON.stringify(k.digestForeign)}`);
  }
  console.log('\n问题:');
  if (!out.realIssues.length) console.log('  （无）');
  for (const issue of out.realIssues) console.log('  ❌ ' + issue);
  if (out.hints.length) {
    console.log('\n提示:');
    for (const hint of out.hints) console.log('  · ' + hint);
  }
  if (out.missingRoleFiles.length) {
    console.log('\n缺失角色卡:');
    for (const m of out.missingRoleFiles) console.log(`  ❌ ${m.key} -> ${m.role}`);
  }
}
process.exitCode = out.realIssues.length || out.missingRoleFiles.length ? 1 : 0;
