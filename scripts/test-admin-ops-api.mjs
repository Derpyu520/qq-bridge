// 管理员动作的**接口级**回归：真的起桥接的控制台服务，走 /api/admin/op。
//
// 纯逻辑（白名单/参数/确认解析/队列）在 src/admin-ops.test.mjs；这里只钉住三件容易写错的事：
//   ① 没有会话令牌 → 拒绝（且错误信息能指引用户）；
//   ② 群会话发起 → 只登记 pending，确认卡真的发到了 owner 私聊；
//   ③ owner 私聊发起 → 直接执行；令牌与 key 不匹配 → 403。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 123;
const ownerKey = `private:${OWNER}`;
const groupKey = 'group:456';

async function fixture(run, config = {}, files = {}) {
  const h = await bridgeHarness({
    config: {
      adminOps: { enabled: true, actions: ['setGroupCard', 'setQqProfile', 'setQqAvatar', 'recallMessage', 'setOnlineStatus'], maxPerMinute: 99, maxPending: 5, vetoProbability: 0 },
      ...config
    },
    files
  });
  h.setMode('reserved2');
  h.setSelfIdentity('大肥鱼', '999');
  const owner = h.getSocialV2State(ownerKey);
  const group = h.getSocialV2State(groupKey);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(JSON.stringify(body));
  });
  const post = (body, headers = {}) => request('/api/admin/op', body, headers);
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'GET',
      headers: { 'x-console-token': 'fixture-console-token', ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end();
  });
  const agent = (token) => ({ 'x-agent-token': token, 'x-agent-call': '1' });
  try {
    await run({ h, owner, group, post, request, get, agent });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

async function waitFor(fn, { timeoutMs = 3000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test('没有会话令牌：拒绝，并给出可操作提示', async () => {
  await fixture(async ({ group, post }) => {
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'x' } }, { 'x-agent-call': '1' });
    assert.equal(r.status, 403);
    assert.match(String(r.data?.error ?? ''), /必须在带会话令牌的会话里发起/);
    assert.equal(group.agentToken.length > 0, true);
  });
});

test('群会话发起：只登记 pending，确认卡发到 owner 私聊', async () => {
  await fixture(async ({ h, group, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: '示例名片' } }, agent(group.agentToken));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.id, 1);
    assert.match(r.data.message, /确认卡发到管理员私聊/);
    assert.equal(await waitFor(() => h.calls.sent.some((s) => s.kind === 'private' && s.id === OWNER)), true, '确认卡应发到 owner 私聊');
    const card = h.calls.sent.filter((s) => s.kind === 'private').map((s) => s.text).join('\n');
    assert.match(card, /操作确认 #1/);
    assert.match(card, /示例名片/);
  });
});

test('管理员本人在私聊刚说过话：直接执行，不发确认卡', async () => {
  await fixture(async ({ h, owner, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });
    // 管理员身份按 QQ 号判定：先把「这个会话最近一条消息是 ownerQQ 发的」记上。
    h.markOwnerSender(ownerKey, true);
    const before = h.calls.sent.length;
    const r = await post({ key: ownerKey, action: 'setGroupCard', args: { groupId: '456', card: '示例名片' } }, agent(owner.agentToken));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'done');
    assert.match(String(r.data.summary ?? ''), /改群名片/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(h.calls.sent.length, before, '直连不应额外发确认卡');
  });
});

// 这条钉住本次改动的核心：管理员身份只认 QQ 号，不认会话。
// 私聊 key 本身不再等于管理员——最近一条消息不是 ownerQQ 发的，就必须走确认卡。
test('管理员私聊里最后一条不是本人发的 → 不直连，走确认', async () => {
  await fixture(async ({ h, owner, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });
    h.markOwnerSender(ownerKey, false);
    const r = await post({ key: ownerKey, action: 'setGroupCard', args: { groupId: '456', card: '冒名' } }, agent(owner.agentToken));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.equal(await waitFor(() => h.calls.sent.some((s) => s.kind === 'private' && /操作确认/.test(String(s.text)))), true);
  });
});

test('令牌与 key 不匹配：403（群令牌不能拿去动 owner 私聊）', async () => {
  await fixture(async ({ group, post, agent }) => {
    const r = await post({ key: ownerKey, action: 'setGroupCard', args: { groupId: '456', card: 'x' } }, agent(group.agentToken));
    assert.equal(r.status, 403);
    assert.match(String(r.data?.error ?? ''), /agent token 无效/);
  });
});

test('未启用的动作、非白名单群、空名单都拒绝', async () => {
  await fixture(async ({ group, post, agent }) => {
    const r1 = await post({ key: groupKey, action: 'setGroupName', args: { groupId: '456', name: 'x' } }, agent(group.agentToken));
    assert.equal(r1.status, 400);
    assert.match(String(r1.data?.error ?? ''), /未启用/);

    const r2 = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '999', card: 'x' } }, agent(group.agentToken));
    assert.equal(r2.status, 400);
    assert.match(String(r2.data?.error ?? ''), /不在白名单/);
  });
});

test('频率上限：超过 maxPerMinute 返回 429', async () => {
  await fixture(async ({ group, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });
    const body = { key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'x' } };
    const first = await post(body, agent(group.agentToken));
    const second = await post(body, agent(group.agentToken));
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.match(String(second.data?.error ?? ''), /太频繁/);
  }, { adminOps: { enabled: true, actions: ['setGroupCard'], maxPerMinute: 1, maxPending: 5 } });
});

test('总开关关闭：403', async () => {
  await fixture(async ({ group, post, agent }) => {
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'x' } }, agent(group.agentToken));
    assert.equal(r.status, 403);
    assert.match(String(r.data?.error ?? ''), /管理员动作未启用/);
  }, { adminOps: { enabled: false } });
});

// ── 快捷命令（桥接直连，不依赖 DSH 重启 / MCP 工具） ────────────────────────
const joinSent = (h, kind, id) => h.calls.sent.filter((s) => s.kind === kind && Number(s.id) === Number(id)).map((s) => s.text).join('');

test('群里 owner 发 /card → 直接改本群名片', async () => {
  await fixture(async ({ h }) => {
    await h.handleIncoming('group', '456', {
      self_id: 999, user_id: OWNER, group_id: 456, message_id: 6001,
      message: [{ type: 'text', data: { text: '/card 示例名片' } }],
      raw_message: '/card 示例名片', sender: { nickname: 'owner', card: 'owner' }
    }, h.cfg);
    const text = joinSent(h, 'group', 456);
    assert.match(text, /✅ 已执行：改群名片 → 「示例名片」/, `实际：${text}`);
  });
});

test('私聊 /card 带群号 → 改指定白名单群；不带群号 → 给用法', async () => {
  await fixture(async ({ h }) => {
    const base = { self_id: 999, user_id: OWNER, sender: { nickname: 'owner' } };
    await h.handleIncoming('private', String(OWNER), {
      ...base,
      message_id: 6002,
      message: [{ type: 'text', data: { text: '/card 456789 指定群名片' } }],
      raw_message: '/card 456789 指定群名片'
    }, h.cfg);
    assert.match(joinSent(h, 'private', OWNER), /✅ 已执行：改群名片 → 「指定群名片」/);

    await h.handleIncoming('private', String(OWNER), {
      ...base,
      message_id: 6003,
      message: [{ type: 'text', data: { text: '/card 只有名片' } }],
      raw_message: '/card 只有名片'
    }, h.cfg);
    assert.match(joinSent(h, 'private', OWNER), /\/card <群号> <新名片>/);
  }, { allow: { private: ['123'], groups: ['456', '456789'] } });
});

test('私聊 /nick 与 /sign → 直接改资料', async () => {
  await fixture(async ({ h }) => {
    const base = { self_id: 999, user_id: OWNER, sender: { nickname: 'owner' } };
    await h.handleIncoming('private', String(OWNER), {
      ...base, message_id: 6004,
      message: [{ type: 'text', data: { text: '/nick 小鲸鱼' } }], raw_message: '/nick 小鲸鱼'
    }, h.cfg);
    assert.match(joinSent(h, 'private', OWNER), /✅ 已执行：改 QQ 资料：昵称「小鲸鱼」/);

    await h.handleIncoming('private', String(OWNER), {
      ...base, message_id: 6005,
      message: [{ type: 'text', data: { text: '/sign 在群里摸鱼' } }], raw_message: '/sign 在群里摸鱼'
    }, h.cfg);
    assert.match(joinSent(h, 'private', OWNER), /签名「在群里摸鱼」/);
  });
});

test('/avatar 只认 assets/ 下的文件：不存在时给出可读错误', async () => {
  await fixture(async ({ h }) => {
    await h.handleIncoming('private', String(OWNER), {
      self_id: 999, user_id: OWNER, message_id: 6006,
      message: [{ type: 'text', data: { text: '/avatar 不存在的图.png' } }],
      raw_message: '/avatar 不存在的图.png', sender: { nickname: 'owner' }
    }, h.cfg);
    assert.match(joinSent(h, 'private', OWNER), /⚠️ 文件不存在：不存在的图\.png/);
  });
});

test('群里发账号级命令（/nick）→ 要求去私聊，不执行', async () => {
  await fixture(async ({ h }) => {
    await h.handleIncoming('group', '456', {
      self_id: 999, user_id: OWNER, group_id: 456, message_id: 6008,
      message: [{ type: 'text', data: { text: '/nick 群里的昵称' } }],
      raw_message: '/nick 群里的昵称', sender: { nickname: 'owner', card: 'owner' }
    }, h.cfg);
    assert.match(joinSent(h, 'group', 456), /改昵称请在私聊里发 \/nick/);
  });
});

test('群友发 /card → 被桥接拦截，不执行', async () => {
  await fixture(async ({ h }) => {
    await h.handleIncoming('group', '456', {
      self_id: 999, user_id: 777, group_id: 456, message_id: 6007,
      message: [{ type: 'text', data: { text: '/card 我要改' } }],
      raw_message: '/card 我要改', sender: { nickname: '路人', card: '路人' }
    }, h.cfg);
    assert.match(joinSent(h, 'group', 456), /管理命令仅管理员可用/);
  });
});

// 端到端：这条覆盖桥接消息处理里的确认钩子（isOwner + 私聊 + 待确认 → confirm）。
// 纯逻辑测试只能证明队列会执行；这里证明「owner 在 QQ 私聊里回一句话」真的能走到执行。
test('端到端：群会话发起 → owner 私聊回「通过 #N」→ 真正执行并回执', async () => {
  await fixture(async ({ h, group, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: '示例名片' } }, agent(group.agentToken));
    assert.equal(r.data.status, 'pending');
    assert.equal(await waitFor(() => h.calls.sent.some((s) => s.kind === 'private')), true, '确认卡应先发出');

    const text = `通过 #${r.data.id}`;
    await h.handleIncoming('private', String(OWNER), {
      self_id: 999,
      user_id: OWNER,
      message_id: 5001,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { nickname: 'owner' }
    }, h.cfg);

    const ok = await waitFor(() => h.calls.sent.some((s) => s.kind === 'private' && /✅ #1 已执行/.test(String(s.text))));
    assert.equal(ok, true, `owner 确认后应回执执行结果，实际私聊消息：${JSON.stringify(h.calls.sent.filter((s) => s.kind === 'private').map((s) => s.text))}`);
  });
});

// ── 自主操作权限（控制台「访问与安全」） ────────────────────────────────────

const ownerGroupEvent = (text, userId = OWNER) => ({
  self_id: 999,
  user_id: userId,
  group_id: 456,
  message_id: 7000 + Math.floor(Math.random() * 1000),
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { nickname: userId === OWNER ? 'owner' : '路人', card: userId === OWNER ? 'owner' : '路人' }
});

test('自主权限接口：默认值、非法值拒绝、保存后立即生效', async () => {
  await fixture(async ({ request, get }) => {
    const g = await get('/api/bot-perms');
    assert.equal(g.status, 200);
    assert.equal(g.data.permModel, 2, '控制台靠 permModel 识别「桥接是否已重启」');
    assert.equal(g.data.rows.length, 13);
    const byKey = Object.fromEntries(g.data.rows.map((r) => [r.key, r.scope]));
    assert.equal(byKey.setGroupCard, 'none');
    assert.equal(byKey.collectSticker, 'persona');
    assert.equal(byKey.crossSessionSend, 'request');
    assert.equal(byKey.crossSessionControl, 'request');
    assert.equal(byKey.crossSessionDelegate, 'request');
    // 发空间说说：默认「仅应要求」，且封顶在 request（公开广播不允许人设自主）
    assert.equal(byKey.qzonePost, 'request');
    assert.equal(g.data.rows.find((r) => r.key === 'qzonePost').maxScope, 'request');
    // 删除收藏表情：不可恢复 ⇒ 默认 request、封顶 request
    assert.equal(byKey.deleteSticker, 'request');
    assert.equal(g.data.rows.find((r) => r.key === 'deleteSticker').maxScope, 'request');
    // 封顶：头像最高只能到「仅应要求」
    assert.equal(g.data.rows.find((r) => r.key === 'setQqAvatar').maxScope, 'request');

    const badKey = await request('/api/bot-perms', { scope: { nope: 'persona' } });
    assert.equal(badKey.status, 400);
    assert.match(String(badKey.data?.error ?? ''), /未知权限项/);

    const badValue = await request('/api/bot-perms', { scope: { setGroupCard: 'sometimes' } });
    assert.equal(badValue.status, 400);
    assert.match(String(badValue.data?.error ?? ''), /只能是/);

    // 旧值直接拒绝：否则控制台缓存了旧页面就会把旧语义又写回去
    const legacy = await request('/api/bot-perms', { scope: { setGroupCard: 'all' } });
    assert.equal(legacy.status, 400);
    assert.match(String(legacy.data?.error ?? ''), /旧值/);

    const good = await request('/api/bot-perms', { scope: { setGroupCard: 'persona' } });
    assert.equal(good.status, 200);
    assert.equal(good.data.perms.setGroupCard, 'persona');
    // 未提交的项保持原值（不会把表情类一起清掉）
    assert.equal(good.data.perms.collectSticker, 'persona');
    const g2 = await get('/api/bot-perms');
    assert.equal(g2.data.rows.find((r) => r.key === 'setGroupCard').scope, 'persona');
  });
});

test('自主权限：超过封顶被夹回，解除封顶后才放开', async () => {
  await fixture(async ({ request, get }) => {
    const capped = await request('/api/bot-perms', { scope: { setQqAvatar: 'persona' } });
    assert.equal(capped.status, 200);
    assert.equal(capped.data.perms.setQqAvatar, 'request', '头像默认封顶在「仅应要求」');
    assert.deepEqual(capped.data.clamped, ['setQqAvatar']);

    const unlocked = await request('/api/bot-perms', { scope: { setQqAvatar: 'persona' }, unlocked: ['setQqAvatar'] });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.data.perms.setQqAvatar, 'persona');
    const g = await get('/api/bot-perms');
    assert.deepEqual(g.data.unlocked, ['setQqAvatar']);
    assert.equal(g.data.rows.find((r) => r.key === 'setQqAvatar').unlocked, true);
  });
});

test('人设自主：群友发起直接执行，并给 owner 留自主回执', async () => {
  await fixture(async ({ h, group, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'persona' } });
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: '示例名片' } }, agent(group.agentToken));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'done');
    assert.equal(await waitFor(() => h.calls.sent.some((s) => s.kind === 'private' && /⚙️ 自主执行/.test(String(s.text)))), true, 'owner 应收到自主回执');
  });
});

test('仅应要求：群友发起要走确认，owner 发起才直连', async () => {
  await fixture(async ({ h, group, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'request' } });

    // 1) 群友刚说过话 → 待确认
    await h.handleIncoming('group', '456', ownerGroupEvent('随便聊聊', 777), h.cfg);
    const a = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'A' } }, agent(group.agentToken));
    assert.equal(a.data.status, 'pending');

    // 2) owner 刚说过话 → 直连
    await h.handleIncoming('group', '456', ownerGroupEvent('改成 B 吧'), h.cfg);
    const b = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'B' } }, agent(group.agentToken));
    assert.equal(b.data.status, 'done', JSON.stringify(b.data));
  });
});

test('不开放：直接拒绝，不发确认卡、不登记 pending', async () => {
  await fixture(async ({ h, group, post, agent }) => {
    const before = h.calls.sent.length;
    const r = await post({ key: groupKey, action: 'setGroupCard', args: { groupId: '456', card: 'A' } }, agent(group.agentToken));
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, 'scope_none');
    assert.match(String(r.data.error ?? ''), /不开放/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(h.calls.sent.length, before, '不应发确认卡');
  });
});

test('人设自主 + owner 发起 + 掷骰否决：409 persona_veto、不执行、发回执、冷却生效', async () => {
  await fixture(async ({ h, owner, post, request, agent }) => {
    await request('/api/bot-perms', { scope: { setGroupCard: 'persona' } });
    h.markOwnerSender(ownerKey, true);
    const r = await post({ key: ownerKey, action: 'setGroupCard', args: { groupId: '456', card: 'X' } }, agent(owner.agentToken));
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'persona_veto');
    assert.equal(await waitFor(() => h.calls.sent.some((s) => s.kind === 'private' && /🙅 已按人设拒绝/.test(String(s.text)))), true);
    // 冷却期内再调：仍然 persona_veto
    const again = await post({ key: ownerKey, action: 'setGroupCard', args: { groupId: '456', card: 'X' } }, agent(owner.agentToken));
    assert.equal(again.status, 409);
  }, { adminOps: { enabled: true, actions: ['setGroupCard'], maxPerMinute: 99, maxPending: 5, vetoProbability: 1 } });
});

// ── 跨会话代发（截图里的「你去群里回复一下」） ────────────────────────────────

test('跨会话代发：默认仅管理员——群友触发被拒，owner 触发能发到别的群', async () => {
  await fixture(async ({ h, group, owner, post, request, agent }) => {
    const target = 'group:789';
    h.getSocialV2State(target);
    const send = (token) => request('/api/socialV2/send-message', { key: target, messages: '去回一句' }, agent(token));

    // 1) 群友刚说过话 → 拒绝
    await h.handleIncoming('group', '456', ownerGroupEvent('路人说话', 777), h.cfg);
    const a = await send(group.agentToken);
    assert.equal(a.status, 403, JSON.stringify(a.data));
    assert.match(String(a.data?.error ?? ''), /只允许管理员/);

    // 2) owner 刚说过话 → 允许，消息真的发到目标群，并把 messageIds 交回模型
    await h.handleIncoming('group', '456', ownerGroupEvent('你去回复一下'), h.cfg);
    const b = await send(group.agentToken);
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(b.data.key, target);
    assert.equal(
      await waitFor(() => h.calls.http.some((c) => String(c.url).endsWith('/send_group_msg') && Number(c.body?.group_id) === 789)),
      true,
      `应真的向 789 发送，实际 http 调用：${JSON.stringify(h.calls.http.map((c) => c.url))}`
    );
    assert.ok(Array.isArray(b.data.messageIds) && b.data.messageIds.length === 1, `返回应带 messageIds：${JSON.stringify(b.data)}`);

    // 3) 跨会话发完能撤回：按 targetKey 找最近一条
    //    撤回是管理员动作，发起会话（owner 私聊）最近一条消息必须也是管理员本人发的。
    await request('/api/bot-perms', { scope: { recallOwnMessage: 'request' } });
    h.markOwnerSender(ownerKey, true);
    const recall = await post({ key: ownerKey, action: 'recallMessage', args: { targetKey: target } }, agent(owner.agentToken));
    assert.equal(recall.status, 200, JSON.stringify(recall.data));
    assert.equal(recall.data.status, 'done');
    assert.match(String(recall.data.after ?? ''), /撤回 #9001/);
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

test('跨会话代发：不开放拒绝、仅应要求只认管理员、目标仍必须在白名单', async () => {
  await fixture(async ({ h, group, request, agent }) => {
    const target = 'group:789';
    h.getSocialV2State(target);
    await h.handleIncoming('group', '456', ownerGroupEvent('你去回复一下'), h.cfg);
    const send = (key, token) => request('/api/socialV2/send-message', { key, messages: 'x' }, agent(token));

    await request('/api/bot-perms', { scope: { crossSessionSend: 'none' } });
    const none = await send(target, group.agentToken);
    assert.equal(none.status, 403);
    assert.match(String(none.data?.error ?? ''), /没有开放/);

    // 跨会话代发被封顶在「仅应要求」：owner 刚说过话 → 放行；路人说话后 → 拒绝
    await request('/api/bot-perms', { scope: { crossSessionSend: 'request' } });
    const ownerAsk = await send(target, group.agentToken);
    assert.equal(ownerAsk.status, 200, JSON.stringify(ownerAsk.data));

    await h.handleIncoming('group', '456', ownerGroupEvent('路人说话', 777), h.cfg);
    const memberAsk = await send(target, group.agentToken);
    assert.equal(memberAsk.status, 403, JSON.stringify(memberAsk.data));
    assert.match(String(memberAsk.data?.error ?? ''), /仅应要求/);

    // 目标不在白名单：即使权限放开也不许发
    await h.handleIncoming('group', '456', ownerGroupEvent('你去回复一下'), h.cfg);
    const outside = await send('group:999', group.agentToken);
    assert.equal(outside.status, 403);
    assert.match(String(outside.data?.error ?? ''), /不在当前模式允许范围|白名单/);
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

test('qq_get_prompt 暴露白名单群的名字→key 与人设', async () => {
  await fixture(async ({ get }) => {
    const r = await get(`/api/socialV2/prompt?key=${encodeURIComponent(ownerKey)}`);
    assert.equal(r.status, 200);
    const groups = Array.isArray(r.data.groups) ? r.data.groups : [];
    const g456 = groups.find((g) => g.key === 'group:456');
    assert.ok(g456, `groups 应包含 456：${JSON.stringify(groups)}`);
    assert.equal(g456.name, '测试群');
    assert.ok(Object.prototype.hasOwnProperty.call(g456, 'role'), '每个群应带 role（可为 null）');
    // 未提交的项保持原值
    assert.equal(groups.some((g) => g.key === 'group:999'), false);
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

// ── 单会话静音：/mute /unmute 与跨会话控制 ──────────────────────────────────

test('/mute 群号：不再被唤醒、也发不出去；/unmute 恢复', async () => {
  await fixture(async ({ h, owner, request, agent }) => {
    await h.handleIncoming('private', String(OWNER), {
      self_id: 999, user_id: OWNER, message_id: 7100,
      message: [{ type: 'text', data: { text: '/mute 456' } }], raw_message: '/mute 456', sender: { nickname: 'owner' }
    }, h.cfg);
    assert.equal(h.getSocialV2State('group:456').wakeConfig.muted, true, '应写入 muted');
    const blocked = await request('/api/socialV2/send-message', { key: 'group:456', messages: 'x' }, agent(owner.agentToken));
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
    assert.match(String(blocked.data?.error ?? ''), /静默|静音|不允许发送/);

    await h.handleIncoming('private', String(OWNER), {
      self_id: 999, user_id: OWNER, message_id: 7101,
      message: [{ type: 'text', data: { text: '/unmute 456' } }], raw_message: '/unmute 456', sender: { nickname: 'owner' }
    }, h.cfg);
    assert.equal(h.getSocialV2State('group:456').wakeConfig.muted, false, '应清除 muted');
    const ok = await request('/api/socialV2/send-message', { key: 'group:456', messages: 'x' }, agent(owner.agentToken));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });
});

test('跨会话静音：owner 能让另一个群闭嘴，群友不行', async () => {
  await fixture(async ({ h, group, request, agent }) => {
    const target = 'group:789';
    h.getSocialV2State(target);
    const mute = (token) => request('/api/socialV2/wake-config', { key: target, config: { muted: true } }, agent(token));

    // 群友刚说话 → 拒绝
    await h.handleIncoming('group', '456', ownerGroupEvent('路人说话', 777), h.cfg);
    const a = await mute(group.agentToken);
    assert.equal(a.status, 403, JSON.stringify(a.data));
    assert.match(String(a.data?.error ?? ''), /管理员/);

    // owner 刚说话 → 允许；目标群的发送被拦住
    await h.handleIncoming('group', '456', ownerGroupEvent('别在那个群说话了'), h.cfg);
    const b = await mute(group.agentToken);
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(h.getSocialV2State(target).wakeConfig.muted, true);
    const blocked = await request('/api/socialV2/send-message', { key: target, messages: 'x' }, agent(group.agentToken));
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

// ── 跨会话委派：让目标会话用自己的身份说 ────────────────────────────────────

test('跨会话委派：任务投给目标会话，唤醒 prompt 明确要求用人设处理', async () => {
  await fixture(async ({ h, group, request, agent }) => {
    const target = 'group:789';
    h.getSocialV2State(target);
    await h.handleIncoming('group', '456', ownerGroupEvent('你去那个群回一句'), h.cfg);
    const r = await request('/api/socialV2/delegate', {
      key: 'group:456', targetKey: target, instruction: '回复群里最下面那条：角色甲不用 token'
    }, agent(group.agentToken));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'queued');
    const st = h.getSocialV2State(target);
    assert.equal(st.delegation.text, '回复群里最下面那条：角色甲不用 token');

    const prompt = h.buildWakePromptV2(target, 'delegation');
    assert.match(prompt, /管理员委派/);
    assert.match(prompt, /角色甲不用 token/);
    assert.match(prompt, /人设/);
    assert.match(prompt, /不要用管理员的私聊口吻|不要解释自己被委派/);
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

test('跨会话委派：权限关闭、静音目标、委派给自己都拒绝', async () => {
  await fixture(async ({ h, group, request, agent }) => {
    const target = 'group:789';
    h.getSocialV2State(target);
    await h.handleIncoming('group', '456', ownerGroupEvent('你去那个群回一句'), h.cfg);
    const delegate = (body, token = group.agentToken) => request('/api/socialV2/delegate', { key: 'group:456', ...body }, agent(token));

    const self = await delegate({ targetKey: 'group:456', instruction: 'x' });
    assert.equal(self.status, 400);

    await request('/api/bot-perms', { scope: { crossSessionDelegate: 'none' } });
    const off = await delegate({ targetKey: target, instruction: 'x' });
    assert.equal(off.status, 403);
    assert.match(String(off.data?.error ?? ''), /没有开放/);

    await request('/api/bot-perms', { scope: { crossSessionDelegate: 'request' } });
    await h.handleIncoming('private', String(OWNER), {
      self_id: 999, user_id: OWNER, message_id: 7200,
      message: [{ type: 'text', data: { text: '/mute 789' } }], raw_message: '/mute 789', sender: { nickname: 'owner' }
    }, h.cfg);
    const muted = await delegate({ targetKey: target, instruction: 'x' });
    assert.equal(muted.status, 409);
    assert.match(String(muted.data?.error ?? ''), /静音/);
  }, { allow: { private: ['123'], groups: ['456', '789'] } });
});

// ── 头像目录预览（qq_list_assets / qq_view_asset 的接口层） ──────────────────

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const assetFiles = {
  'assets/白毛.png': PNG_1X1,
  'assets/蓝毛.png': PNG_1X1,
  'assets/note.txt': 'not an image'
};

test('头像列表：owner 私聊返回文件名，群会话一律拒绝', async () => {
  await fixture(async ({ h, owner, group, get, agent }) => {
    h.markOwnerSender(ownerKey, true);
    const ok = await get(`/api/admin/assets?key=${encodeURIComponent(ownerKey)}`, agent(owner.agentToken));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.files.map((f) => f.name).sort(), ['白毛.png', '蓝毛.png'].sort());
    assert.equal(ok.data.dir, 'assets');
    assert.equal(ok.data.count, 2);

    const denied = await get(`/api/admin/assets?key=${encodeURIComponent(groupKey)}`, agent(group.agentToken));
    assert.equal(denied.status, 403);
    assert.match(String(denied.data?.error ?? ''), /只允许管理员本人/);
  }, {}, assetFiles);
});

test('头像查看：owner 能拿到图片字节；群会话与路径穿越被拒', async () => {
  await fixture(async ({ h, owner, group, get, agent }) => {
    h.markOwnerSender(ownerKey, true);
    const name = encodeURIComponent('白毛.png');
    const ok = await get(`/api/admin/asset?key=${encodeURIComponent(ownerKey)}&name=${name}`, agent(owner.agentToken));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.image.mimeType, 'image/png');
    assert.equal(Buffer.from(ok.data.image.data, 'base64').length, PNG_1X1.length);

    const denied = await get(`/api/admin/asset?key=${encodeURIComponent(groupKey)}&name=${name}`, agent(group.agentToken));
    assert.equal(denied.status, 403);

    const traversal = await get(`/api/admin/asset?key=${encodeURIComponent(ownerKey)}&name=${encodeURIComponent('../config.json')}`, agent(owner.agentToken));
    assert.equal(traversal.status, 400);
    assert.match(String(traversal.data?.error ?? ''), /\.\.|路径/);

    const missing = await get(`/api/admin/asset?key=${encodeURIComponent(ownerKey)}&name=${encodeURIComponent('没有.png')}`, agent(owner.agentToken));
    assert.equal(missing.status, 400);
    assert.match(String(missing.data?.error ?? ''), /没有这张图片/);
  }, {}, assetFiles);
});

test('头像查看：2MB 以内的“像素炸弹”也拒绝', async () => {
  const bomb = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bomb, 0);
  bomb.writeUInt32BE(30000, 16);
  bomb.writeUInt32BE(30000, 20);
  await fixture(async ({ h, owner, get, agent }) => {
    h.markOwnerSender(ownerKey, true);
    const name = encodeURIComponent('bomb.png');
    const r = await get(`/api/admin/asset?key=${encodeURIComponent(ownerKey)}&name=${name}`, agent(owner.agentToken));
    assert.equal(r.status, 400);
    assert.match(String(r.data?.error ?? ''), /像素超限/);
  }, {}, { 'assets/bomb.png': bomb });
});

test('头像查看：assetView.allow 名单之外全部拒绝', async () => {
  await fixture(async ({ h, owner, get, agent }) => {
    h.markOwnerSender(ownerKey, true);
    const name = encodeURIComponent('蓝毛.png');
    const r = await get(`/api/admin/asset?key=${encodeURIComponent(ownerKey)}&name=${name}`, agent(owner.agentToken));
    assert.equal(r.status, 400);
    assert.match(String(r.data?.error ?? ''), /不在允许查看的名单/);
  }, {
    adminOps: {
      enabled: true,
      actions: ['setGroupCard', 'setQqProfile', 'setQqAvatar'],
      assetView: { enabled: true, allow: ['白毛.png'] }
    }
  }, assetFiles);
});

