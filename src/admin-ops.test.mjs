// 管理员动作纯逻辑的离线回归。跑法：node --test src/admin-ops.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  AdminOpQueue,
  ASSET_VIEW_MAX_BYTES,
  DEFAULT_ENABLED_ACTIONS,
  describeAction,
  formatConfirmCard,
  listViewableAssets,
  normalizeAdminArgs,
  normalizeAssetName,
  parseConfirm,
  resolveMediaFile,
  resolveViewableAsset,
  sniffAllowedImageMime
} from './admin-ops.mjs';

const ownerQQ = 1000000001;
const ownerKey = `private:${ownerQQ}`;
const groupKey = 'group:123456781';
const allowGroups = ['123456781', '123456789'];
const mediaRoot = path.resolve('C:/repo/assets');

function fakeFs({ files = {}, dirs = [], tooBig = [] } = {}) {
  const known = new Set([...Object.keys(files), ...dirs, ...tooBig]);
  return {
    exists: (p) => known.has(p),
    stat: (p) => {
      if (dirs.includes(p)) return { isFile: () => false, size: 0 };
      if (tooBig.includes(p)) return { isFile: () => true, size: 11 * 1024 * 1024 };
      return { isFile: () => true, size: 1024 };
    }
  };
}

const opts = ({ files = {}, dirs = [], tooBig = [], ...rest } = {}) => ({
  allowGroups, mediaRoot, ...fakeFs({ files, dirs, tooBig }), ...rest
});

// ── 参数校验 ────────────────────────────────────────────────────────────────

test('群名片：去空白、允许空字符串清除、超长拒绝', () => {
  const ok = normalizeAdminArgs('setGroupCard', { groupId: 123456781, card: '  示例名片  ' }, opts());
  assert.deepEqual(ok, { groupId: '123456781', card: '示例名片' });
  assert.equal(normalizeAdminArgs('setGroupCard', { groupId: '123456781', card: '' }, opts()).card, '');
  assert.throws(() => normalizeAdminArgs('setGroupCard', { groupId: '123456781', card: '鱼'.repeat(31) }, opts()), /不能超过 30/);
});

test('群名片：换行/控制字符被压成空格，不会把确认卡撑破', () => {
  const r = normalizeAdminArgs('setGroupCard', { groupId: '123456781', card: 'A\nB\tC' }, opts());
  assert.equal(r.card, 'A B C');
});

test('群 ID 必须在白名单，且 allowAllWhenEmpty 不放行空名单', () => {
  assert.throws(() => normalizeAdminArgs('setGroupCard', { groupId: '123', card: 'x' }, opts()), /不在白名单/);
  assert.throws(() => normalizeAdminArgs('setGroupCard', { groupId: 'abc', card: 'x' }, opts()), /正整数/);
  assert.throws(() => normalizeAdminArgs('setGroupCard', { groupId: '0', card: 'x' }, opts()), /正整数/);
  assert.throws(
    () => normalizeAdminArgs('setGroupCard', { groupId: '123456781', card: 'x' }, opts({ allowGroups: [], allowAllWhenEmpty: true })),
    /空名单不放行/
  );
});

test('头像路径：拒绝绝对路径/URL/base64/..，接受 mediaRoot 下的图片', () => {
  const good = path.resolve(mediaRoot, 'deepseek娘.png');
  const fsOpts = opts({ files: { [good]: true } });
  const r = normalizeAdminArgs('setQqAvatar', { file: 'deepseek娘.png' }, fsOpts);
  assert.equal(r.file, good);
  assert.equal(r.fileRel, 'deepseek娘.png');

  for (const bad of ['C:\\Windows\\win.ini', '/etc/passwd', 'https://evil/x.png', 'data:image/png;base64,AAA', '../secret.png', 'sub/../../x.png']) {
    assert.throws(() => normalizeAdminArgs('setQqAvatar', { file: bad }, fsOpts), /绝对路径|URL|base64|\.\./, bad);
  }
  assert.throws(() => normalizeAdminArgs('setQqAvatar', { file: 'note.txt' }, fsOpts), /只接受 png/);
  assert.throws(() => normalizeAdminArgs('setQqAvatar', { file: 'missing.png' }, fsOpts), /文件不存在/);
});

test('头像路径：目录、超大文件都拒绝', () => {
  const dir = path.resolve(mediaRoot, 'dir.png');
  const big = path.resolve(mediaRoot, 'big.png');
  const o = opts({ dirs: [dir], tooBig: [big] });
  assert.throws(() => normalizeAdminArgs('setQqAvatar', { file: 'dir.png' }, o), /不是普通文件/);
  assert.throws(() => normalizeAdminArgs('setQqAvatar', { file: 'big.png' }, o), /超过 10MB/);
});

test('resolveMediaFile 归一化相对路径并拒绝空/缺根', () => {
  const abs = path.resolve(mediaRoot, 'a/b.png');
  const r = resolveMediaFile('a\\b.png', { mediaRoot, ...fakeFs({ files: { [abs]: true } }) });
  assert.equal(r.rel, 'a/b.png');
  assert.throws(() => resolveMediaFile('', { mediaRoot }), /缺少头像文件路径/);
  assert.throws(() => resolveMediaFile('a.png', { mediaRoot: '' }), /未配置 mediaRoot/);
});

test('QQ 资料：只改签名（清空）合法；两者都不给才报错；超长拒绝', () => {
  assert.deepEqual(normalizeAdminArgs('setQqProfile', { personalNote: '' }, opts()), { personalNote: '' });
  assert.deepEqual(normalizeAdminArgs('setQqProfile', { nickname: '小鲸鱼' }, opts()), { nickname: '小鲸鱼' });
  assert.throws(() => normalizeAdminArgs('setQqProfile', {}, opts()), /至少要给/);
  assert.throws(() => normalizeAdminArgs('setQqProfile', { nickname: '鱼'.repeat(37) }, opts()), /不能超过 36/);
});

test('未知动作与未启用动作分别给出可读错误', () => {
  assert.throws(() => normalizeAdminArgs('kick', {}, opts()), /未知动作/);
  assert.equal(describeAction('nope'), '未知动作');
});

// ── 确认文本解析 ────────────────────────────────────────────────────────────

test('确认词：支持中英文、编号前后、带井号', () => {
  assert.deepEqual(parseConfirm('通过', [12]), { outcome: 'allow', id: 12 });
  assert.deepEqual(parseConfirm('通过 #12', [12]), { outcome: 'allow', id: 12 });
  assert.deepEqual(parseConfirm('#12 通过', [12]), { outcome: 'allow', id: 12 });
  assert.deepEqual(parseConfirm('12 拒绝', [12]), { outcome: 'deny', id: 12 });
  assert.deepEqual(parseConfirm('OK', [7]), { outcome: 'allow', id: 7 });
  assert.deepEqual(parseConfirm('yes #7', [7]), { outcome: 'allow', id: 7 });
  assert.deepEqual(parseConfirm('/通过', [3]), { outcome: 'allow', id: 3 });
});

test('确认词：多个待确认且没编号 → ambiguous', () => {
  assert.deepEqual(parseConfirm('通过', [12, 13]), { ambiguous: true });
});

test('确认词：不是确认的句子原样返回 null；编号不存在标 missing', () => {
  assert.equal(parseConfirm('今天天气不错', [12]), null);
  assert.equal(parseConfirm('', [12]), null);
  assert.deepEqual(parseConfirm('通过 #99', [12]), { outcome: 'allow', id: 99, missing: true });
  assert.deepEqual(parseConfirm('通过', []), { outcome: 'allow', missing: true });
});

// ── 队列 ────────────────────────────────────────────────────────────────────

function makeQueue(overrides = {}) {
  const calls = [];
  const notes = [];
  const audits = [];
  const queue = new AdminOpQueue({
    ownerKey,
    enabledActions: DEFAULT_ENABLED_ACTIONS,
    // 生产环境由 bridge 注入；测试默认给「仅应要求」，等价于改动前的 owner 档，便于回归旧行为。
    resolveScope: () => ({ keys: [], scope: 'request' }),
    execute: async (action, args, meta) => {
      calls.push({ action, args, meta });
      return { before: { groupId: args.groupId, card: '旧名片' }, after: '新' };
    },
    notifyOwner: (t) => notes.push(t),
    onAudit: (r) => audits.push(r),
    ...overrides
  });
  return { queue, calls, notes, audits };
}

test('owner 私聊提交 → 直连执行，不发确认卡', async () => {
  const { queue, calls, notes, audits } = makeQueue();
  const r = await queue.submit({
    action: 'setGroupCard', args: { groupId: '123456781', card: '新名片' }, originKey: ownerKey, originLabel: '私聊', senderIsOwner: true
  });
  assert.equal(r.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.internal, false);
  assert.equal(audits[0].originKey, ownerKey);
  assert.equal(notes.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'owner-direct');
  assert.equal(audits[0].ok, true);
});

test('管理员私聊但最近一条不是本人发的 → 只登记待确认（会话不再等于管理员）', async () => {
  const { queue, calls, notes } = makeQueue();
  const r = await queue.submit({
    action: 'setGroupCard', args: { groupId: '123456781', card: '冒名' },
    originKey: ownerKey, originLabel: '私聊', senderIsOwner: false
  });
  assert.equal(r.status, 'pending');
  assert.equal(calls.length, 0, '身份没确认前不能执行');
  assert.match(notes[0], /操作确认/);
});

test('非 owner 会话提交 → 只登记待确认，确认卡发到 owner 私聊', async () => {
  const { queue, calls, notes } = makeQueue();
  const r = await queue.submit({
    action: 'setGroupCard', args: { groupId: '123456781', card: '示例名片' }, originKey: groupKey,
    originLabel: '群 123456781「示例群」', targetLabel: '群 123456781'
  });
  assert.equal(r.status, 'pending');
  assert.equal(r.id, 1);
  assert.equal(calls.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /操作确认 #1/);
  assert.match(notes[0], /来自：群 123456781「示例群」/);
  assert.match(notes[0], /改群名片 → 「示例名片」/);
});

test('确认通过 → 执行并回执；拒绝 → 不执行', async () => {
  const { queue, calls, notes, audits } = makeQueue();
  const a = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: groupKey });
  const r1 = await queue.confirm(`通过 #${a.id}`);
  assert.deepEqual(r1, { handled: true });
  assert.equal(calls.length, 1);
  assert.match(notes.at(-1), /✅ #1 已执行/);
  assert.equal(audits.at(-1).actor, 'owner-confirm');

  const b = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'B' }, originKey: groupKey });
  await queue.confirm(`拒绝 #${b.id}`);
  assert.equal(calls.length, 1, '拒绝不应触发执行');
  assert.match(notes.at(-1), /❌ 已取消 #2/);
  assert.equal(queue.pendingIds.length, 0);
});

test('多个待确认且没编号 → 提示带编号，不执行', async () => {
  const { queue, calls, notes } = makeQueue();
  await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: groupKey });
  await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'B' }, originKey: groupKey });
  await queue.confirm('通过');
  assert.equal(calls.length, 0);
  assert.match(notes.at(-1), /有 2 个待确认/);
});

test('未知编号与纯闲聊不会误触发', async () => {
  const { queue, calls, notes } = makeQueue();
  assert.deepEqual(await queue.confirm('通过 #42'), { handled: true });
  assert.match(notes.at(-1), /没有待确认的操作 #42/);
  assert.deepEqual(await queue.confirm('今天吃什么'), { handled: false });
  assert.equal(calls.length, 0);
});

test('未启用动作、超频、待确认过多都拒绝', async () => {
  const { queue, calls } = makeQueue();
  await assert.rejects(
    () => queue.submit({ action: 'setGroupName', args: { groupId: '123456781', name: 'x' }, originKey: ownerKey }),
    /未启用/
  );
  const q2 = makeQueue().queue;
  for (let i = 0; i < 3; i += 1) {
    await q2.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: `c${i}` }, originKey: groupKey });
  }
  await assert.rejects(
    () => q2.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'x' }, originKey: groupKey }),
    /太频繁/
  );
  const q3 = makeQueue({ maxPerMinute: 99, maxPending: 2 }).queue;
  await q3.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'a' }, originKey: groupKey });
  await q3.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'b' }, originKey: groupKey });
  await assert.rejects(
    () => q3.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'c' }, originKey: groupKey }),
    /已有 2 个/
  );
  assert.equal(calls.length, 0);
});

test('执行失败：直连向调用方抛错，确认流程回执失败原因', async () => {
  const boom = async () => { throw new Error('网关 500'); };
  const { queue, notes } = makeQueue({ execute: boom });
  await assert.rejects(() => queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'x' }, originKey: ownerKey, senderIsOwner: true }), /网关 500/);
  const a = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'x' }, originKey: groupKey });
  await queue.confirm(`通过 #${a.id}`);
  assert.match(notes.at(-1), /❌ #1 执行失败：网关 500/);
});

// ── 自主权限（三档：不开放 / 仅应要求 / 人设自主） ──────────────────────────

test('人设自主：非 owner 会话也直连，并给 owner 发一条自主回执', async () => {
  const { queue, calls, notes } = makeQueue({ resolveScope: () => ({ keys: ['setGroupCard'], scope: 'persona' }) });
  const r = await queue.submit({
    action: 'setGroupCard', args: { groupId: '123456781', card: '示例名片' },
    originKey: groupKey, originLabel: '群 123456781', targetLabel: '群 123456781'
  });
  assert.equal(r.status, 'done');
  assert.equal(calls.length, 1);
  assert.match(notes.at(-1), /⚙️ 自主执行：改群名片/);
  assert.match(notes.at(-1), /来自：群 123456781/);
});

test('仅应要求：只有该会话最近一条消息是 owner 发的才直连', async () => {
  const { queue, calls } = makeQueue({ resolveScope: () => ({ keys: ['setGroupCard'], scope: 'request' }) });
  const a = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: groupKey, senderIsOwner: false });
  assert.equal(a.status, 'pending');
  const b = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'B' }, originKey: groupKey, senderIsOwner: true });
  assert.equal(b.status, 'done');
  assert.equal(calls.length, 1, '只有 owner 触发的那次才执行');
});

test('不开放：直接拒绝，不登记确认卡、也不占频率额度', async () => {
  const { queue, calls, notes } = makeQueue({
    maxPerMinute: 1,
    // 同一动作按参数区分档位：card=A 不开放，card=B 仅应要求
    resolveScope: (_action, args) => ({ keys: ['setGroupCard'], scope: args.card === 'A' ? 'none' : 'request' })
  });
  const denied = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: groupKey, senderIsOwner: true })
    .then(() => null, (error) => error);
  assert.ok(denied instanceof Error);
  assert.match(String(denied.message), /不开放/);
  assert.equal(queue.pendingIds.length, 0);
  assert.equal(calls.length, 0);
  assert.ok(!notes.some((n) => /操作确认/.test(String(n))), '不应发确认卡');
  // 额度没被吃掉：maxPerMinute=1 时第二次仍能提交（若第一次占了额度，这里会 429）
  const ok = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'B' }, originKey: groupKey });
  assert.equal(ok.status, 'pending');
});

test('人设自主 + 管理员发起：掷骰否决 → persona_veto、审计、回执、冷却期内不许重试', async () => {
  const vetoFor = ({ action }) => ({ veto: action === 'setGroupCard', p: 0.2, role: '傲娇助手' });
  const { queue, calls, notes, audits } = makeQueue({ resolveScope: () => ({ keys: ['setGroupCard'], scope: 'persona' }), vetoFor });
  await assert.rejects(
    () => queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: ownerKey, senderIsOwner: true, originLabel: '私聊' }),
    /persona_veto/
  );
  assert.equal(calls.length, 0);
  assert.match(notes.at(-1), /🙅 已按人设拒绝：改群名片/);
  assert.match(notes.at(-1), /傲娇助手/);
  assert.match(notes.at(-1), /20%/);
  assert.equal(audits.at(-1).actor, 'persona-veto');
  assert.equal(audits.at(-1).ok, false);

  // 冷却期内直接拒（即使这次掷骰会放行）
  const retry = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: ownerKey, senderIsOwner: true })
    .then(() => null, (error) => error);
  assert.match(String(retry.message), /persona_veto/);
  assert.match(String(retry.message), /刚刚已经拒绝/);
  assert.equal(calls.length, 0);

  // 另一个会话不受这条冷却影响
  const other = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'B' }, originKey: groupKey, senderIsOwner: false });
  assert.equal(other.status, 'done');
});

test('人设自主 + 群友发起：不掷骰、不拦', async () => {
  let asked = 0;
  const { queue, calls } = makeQueue({
    resolveScope: () => ({ keys: ['setGroupCard'], scope: 'persona' }),
    vetoFor: () => { asked += 1; return { veto: true, p: 1 }; }
  });
  const r = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: groupKey, senderIsOwner: false });
  assert.equal(r.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(asked, 0, '群友发起不应触发掷骰');
});

test('人设自主 + 管理员发起：掷骰放行则执行', async () => {
  const { queue, calls, audits } = makeQueue({
    resolveScope: () => ({ keys: ['setGroupCard'], scope: 'persona' }),
    vetoFor: () => ({ veto: false, p: 0 })
  });
  const r = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'A' }, originKey: ownerKey, senderIsOwner: true });
  assert.equal(r.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(audits.at(-1).actor, 'owner-direct');
});

test('撤回与在线状态：参数校验与描述', () => {
  assert.deepEqual(normalizeAdminArgs('recallMessage', { messageId: 123 }, opts()), { messageId: '123' });
  assert.deepEqual(normalizeAdminArgs('recallMessage', { messageId: '-9' }, opts()), { messageId: '-9' });
  assert.throws(() => normalizeAdminArgs('recallMessage', {}, opts()), /缺少 messageId/);
  assert.throws(() => normalizeAdminArgs('recallMessage', { messageId: '0' }, opts()), /非零整数/);
  assert.deepEqual(
    normalizeAdminArgs('recallMessage', { messageId: '5', groupId: '123456781' }, opts()),
    { messageId: '5', groupId: '123456781' }
  );
  assert.deepEqual(normalizeAdminArgs('setOnlineStatus', { status: 'away' }, opts()), { status: 'away' });
  assert.throws(() => normalizeAdminArgs('setOnlineStatus', { status: 'sleeping' }, opts()), /status 只能是/);
  assert.match(describeAction('recallMessage', { messageId: '42' }), /撤回消息 #42/);
  assert.match(describeAction('setOnlineStatus', { status: 'dnd' }), /请勿打扰/);
});

test('确认超时后自动清理并提醒 owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { queue, notes, calls } = makeQueue({ timeoutMs: 10000 });
  const a = await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'x' }, originKey: groupKey });
  assert.equal(queue.pendingIds.length, 1);
  t.mock.timers.tick(10001);
  assert.equal(queue.pendingIds.length, 0);
  assert.match(notes.at(-1), new RegExp(`⏰ 操作 #${a.id} 已过期`));
  await queue.confirm(`通过 #${a.id}`);
  assert.equal(calls.length, 0);
  t.mock.timers.reset();
});

test('撤销：还原上一条可逆动作，且不会重复撤销', async () => {
  const { queue, calls } = makeQueue();
  await queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: '新' }, originKey: ownerKey, senderIsOwner: true });
  const r = await queue.undo();
  assert.ok(r);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, { groupId: '123456781', card: '旧名片' });
  assert.equal(calls[1].meta.internal, true);
  assert.equal(await queue.undo(), null);
});

test('撤销：跳过失败记录与内部记录', async () => {
  let n = 0;
  const { queue } = makeQueue({
    execute: async () => {
      n += 1;
      if (n === 1) throw new Error('先失败一次');
      return { before: null, after: null };
    }
  });
  await assert.rejects(() => queue.submit({ action: 'setGroupCard', args: { groupId: '123456781', card: 'x' }, originKey: ownerKey, senderIsOwner: true }), /先失败/);
  assert.equal(await queue.undo(), null);
});

test('审计记录不写绝对路径', async () => {
  const img = path.resolve(mediaRoot, 'deepseek娘.png');
  const { queue, audits } = makeQueue({
    execute: async () => ({ before: null, after: null })
  });
  await queue.submit({
    action: 'setQqAvatar',
    args: { file: img, fileRel: 'deepseek娘.png' },
    originKey: ownerKey, senderIsOwner: true
  });
  assert.equal(audits.at(-1).args.file, 'deepseek娘.png');
});

test('确认卡文案包含动作、目标与有效期', () => {
  const card = formatConfirmCard({
    id: 12, originLabel: '群 123456781「示例群」', action: 'setGroupCard',
    args: { card: '示例名片' }, targetLabel: '群 123456781', timeoutMs: 600000
  });
  assert.match(card, /操作确认 #12（10 分钟内有效）/);
  assert.match(card, /改群名片 → 「示例名片」/);
  assert.match(card, /回复「通过」执行，「拒绝」取消/);
});

test('describeAction 覆盖头像与清空语义', () => {
  assert.match(describeAction('setGroupCard', { card: '' }), /（清空）/);
  assert.match(describeAction('setQqAvatar', { fileRel: 'a/b.png' }), /b\.png/);
  assert.match(describeAction('setQqProfile', { nickname: '鲸', personalNote: '' }), /签名（清空）/);
});

// ── 头像目录的只读预览（qq_list_assets / qq_view_asset）────────────────────

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const assetAbs = path.join(mediaRoot, '白毛.png');

function assetFs({ name = '白毛.png', size = PNG_1X1.length, buffer = PNG_1X1, symlink = false, realAbs = null } = {}) {
  const abs = path.join(mediaRoot, name);
  return {
    exists: (p) => p === mediaRoot || p === abs,
    lstat: (p) => {
      if (p !== abs) throw new Error('ENOENT');
      return { isFile: () => true, isSymbolicLink: () => symlink, size };
    },
    realpath: (p) => (p === mediaRoot ? mediaRoot : (realAbs ?? abs)),
    readFile: () => buffer
  };
}

test('头像文件名：拒绝路径、..、盘符、隐藏名与非图片', () => {
  for (const bad of ['../secret.png', 'a/b.png', 'a\\b.png', 'C:\\x.png', 'x:y.png', '.hidden.png', 'note.txt', '', ' 白毛.png']) {
    assert.throws(() => normalizeAssetName(bad), /路径|\.\.|绝对路径|冒号|不合法|空白|只接受|缺少/, bad);
  }
  assert.equal(normalizeAssetName('白毛.png'), '白毛.png');
});

test('可查看头像：正常读取、大小写不同的白名单也能命中', () => {
  const r = resolveViewableAsset('白毛.png', { mediaRoot, allow: ['白毛.PNG'], ...assetFs() });
  assert.equal(r.mimeType, 'image/png');
  assert.equal(r.bytes, PNG_1X1.length);
  assert.equal(sniffAllowedImageMime(PNG_1X1), 'image/png');
});

test('可查看头像：符号链接、伪扩展名、超限、越界 realpath 都拒绝', () => {
  assert.throws(
    () => resolveViewableAsset('白毛.png', { mediaRoot, ...assetFs({ symlink: true }) }),
    /符号链接/
  );
  assert.throws(
    () => resolveViewableAsset('白毛.png', { mediaRoot, ...assetFs({ buffer: Buffer.from('this is not an image') }) }),
    /不是 png/
  );
  assert.throws(
    () => resolveViewableAsset('白毛.png', { mediaRoot, ...assetFs({ size: ASSET_VIEW_MAX_BYTES + 1 }) }),
    /超过 .*上限/
  );
  assert.throws(
    () => resolveViewableAsset('白毛.png', { mediaRoot, ...assetFs({ realAbs: path.resolve('C:/repo/secret.png') }) }),
    /越出了头像目录/
  );
});

test('可查看头像：allow 非空时只认名单', () => {
  assert.throws(
    () => resolveViewableAsset('蓝毛.png', { mediaRoot, allow: ['白毛.png'], ...assetFs({ name: '蓝毛.png' }) }),
    /不在允许查看的名单/
  );
});

test('头像列表：只列图片、排序稳定、跳过目录/链接/非图片', () => {
  const r = listViewableAssets({
    mediaRoot,
    readdir: () => [
      { name: 'b.png', isFile: () => true },
      { name: 'a.jpg', isFile: () => true },
      { name: 'note.txt', isFile: () => true },
      { name: 'sub', isFile: () => false },
      { name: 'link.png', isFile: () => false }
    ],
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 123, mtimeMs: 1000 })
  });
  assert.deepEqual(r.files.map((f) => f.name), ['a.jpg', 'b.png']);
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.skipped, 3);
});

test('setQqAvatar 兼容模型写的 assets/ 前缀（原路径不存在时才剥）', () => {
  const file = path.join(mediaRoot, 'deepseek娘.png');
  const fsOpts = { mediaRoot, exists: (p) => p === file, stat: () => ({ isFile: () => true, size: 1024 }) };
  const r = resolveMediaFile('assets/deepseek娘.png', fsOpts);
  assert.equal(r.rel, 'deepseek娘.png');
});
