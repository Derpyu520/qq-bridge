// QQ 资料 / 头像 / QQ 空间（说说）的桥接端点回归。
//
// 这些用例钉的是**边界**而不是 happy path：
//   · 资料只回白名单字段（网关多回 uid/企业/电量也不许透传）；
//   · 只能查本会话/本群出现过的人；owner 发话后才允许指定任意 QQ 号；
//   · 每会话配额、工具开关、profile.enabled 都必须真的拦住；
//   · 发说说：owner 直连 / 其他人 pending 确认卡 / 正文与图片沙箱 / 频率与重复内容；
//   · 发完回读校验（verified）只在真的读到自己空间最新一条时才为 true。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OWNER_PRIVATE = 'private:123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

/** 假的 qlogo 抓取：只接受 qlogo 地址，回一张合法 1×1 PNG。 */
const avatarFetch = async (url) => {
  if (!String(url).startsWith('https://q.qlogo.cn/g?b=qq&nk=')) throw new Error(`unexpected fetch ${url}`);
  return { url: String(url), statusCode: 200, buffer: PNG };
};

async function withBridge(run, { socialV2 = {}, files = {}, globals = {} } = {}) {
  const h = await bridgeHarness({
    config: { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, ...socialV2 } },
    files,
    globals
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(GROUP);
  const ownerToken = h.getSocialV2State(OWNER_PRIVATE).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, {
    token,
    agentToken = true,
    consoleToken = 'fixture-console-token',
    key = GROUP,
    method = 'GET',
    body = null,
    query = ''
  } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    // 默认按 key 取对应会话的令牌（owner 私聊与群会话的 agentToken 不同）。
    const effectiveToken = token !== undefined ? token : (agentToken ? (key === OWNER_PRIVATE ? ownerToken : st.agentToken) : '');
    if (effectiveToken) headers['x-agent-token'] = effectiveToken;
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const path = `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('资料：只回白名单字段，头像走 qlogo 并以图像返回（第二次读缓存）', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('user-profile', { query: '&userId=111&avatar=1' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const p = out.data.profile;
    assert.equal(p.userId, '111');
    assert.equal(p.nickname, '小明');
    assert.equal(p.remark, '明明');
    assert.equal(p.signature, '今天也在摸鱼');
    assert.equal(p.level, 59);
    assert.equal(p.online.label, '隐身');
    assert.equal(p.accountYears > 0, true);
    for (const key of ['uid', 'qid', 'batteryStatus', 'qidian_enterprise_name', 'reg_time', 'vip_level']) {
      assert.equal(key in p, false, `资料里不应出现 ${key}`);
    }
    assert.equal(out.data.source.profile, 'live');
    assert.equal(out.data.source.avatar, 'live');
    assert.equal(out.data.allowedBy, 'group-member');
    assert.equal(out.data.avatar.mimeType, 'image/png');
    assert.ok(out.data.avatar.data.length > 20);
    const again = await request('user-profile', { query: '&userId=111&avatar=0' });
    assert.equal(again.status, 200);
    assert.equal(again.data.source.profile, 'cache');
    assert.equal(again.data.avatar, undefined);
  }, { globals: { safeFetchBuffer: avatarFetch } });
});

await test('资料：与当前会话无关的 QQ 号被拒绝（不变成 QQ 号查询台）', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('user-profile', { query: '&userId=8888' });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /只能查看本会话|不在这个范围/);
  }, { globals: { safeFetchBuffer: avatarFetch } });
});

await test('资料：owner 本人发话后可以指定任意 QQ 号（管理员明确给了号码）', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(GROUP, true);
    const out = await request('user-profile', { query: '&userId=8888&avatar=0' });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.profile.nickname, '用户8888');
    assert.equal(out.data.allowedBy, 'owner-request');
  }, { globals: { safeFetchBuffer: avatarFetch } });
});

await test('资料：令牌错误 / 工具关闭 / profile.enabled=false 各自 403', async () => {
  await withBridge(async ({ request }) => {
    const bad = await request('user-profile', { query: '&userId=111', token: 'deadbeef' });
    assert.equal(bad.status, 403);
    assert.match(bad.data.error, /token/);
  }, { globals: { safeFetchBuffer: avatarFetch } });

  await withBridge(async ({ request }) => {
    const off = await request('user-profile', { query: '&userId=111' });
    assert.equal(off.status, 403);
    assert.match(off.data.error, /qq_get_user_profile/);
  }, { socialV2: { tools: { getUserProfile: false } }, globals: { safeFetchBuffer: avatarFetch } });

  await withBridge(async ({ request }) => {
    const out = await request('user-profile', { query: '&userId=111' });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /profile\.enabled/);
  }, { socialV2: { profile: { enabled: false } }, globals: { safeFetchBuffer: avatarFetch } });
});

await test('资料：每会话配额真的会耗尽（资料与空间读共用）', async () => {
  await withBridge(async ({ request }) => {
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await request('user-profile', { query: '&userId=111&avatar=0' })).status, 200);
    }
    const third = await request('user-profile', { query: '&userId=111&avatar=0' });
    assert.equal(third.status, 429, JSON.stringify(third.data));
    assert.ok(third.data.retryAfterMs > 0);
    const qzone = await request('qzone', { query: '&scope=self' });
    assert.equal(qzone.status, 429, '空间读应共用同一份配额');
  }, { socialV2: { profile: { maxPer10Min: 2 } }, globals: { safeFetchBuffer: avatarFetch } });
});

await test('空间读：自己的说说与好友动态都被洗成短文本', async () => {
  await withBridge(async ({ request }) => {
    const self = await request('qzone', { query: '&scope=self&count=5' });
    assert.equal(self.status, 200, JSON.stringify(self.data));
    assert.equal(self.data.scope, 'self');
    assert.equal(self.data.posts[0].content, '第一条说说');
    assert.equal(self.data.posts[1].private, true);
    assert.equal(self.data.posts[1].imageCount, 1);
    const friends = await request('qzone', { query: '&scope=friends&count=5' });
    assert.equal(friends.status, 200, JSON.stringify(friends.data));
    assert.equal(friends.data.feeds[0].userId, '111');
    assert.equal(friends.data.feeds[0].text, '海边真好看');
    assert.equal(friends.data.feeds[0].imageCount, 1);
  });
});

await test('空间读：工具关闭后 403', async () => {
  await withBridge(async ({ request }) => {
    const off = await request('qzone', { query: '&scope=self' });
    assert.equal(off.status, 403);
    assert.match(off.data.error, /qq_qzone_read/);
  }, { socialV2: { tools: { qzoneRead: false } } });
});

await test('发说说：owner 直连、回读校验为 true、审计里带 tid', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const out = await request('qzone-post', {
      key: OWNER_PRIVATE,
      method: 'POST',
      body: { key: OWNER_PRIVATE, content: '今天也要好好摸鱼' }
    });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.status, 'done');
    assert.equal(out.data.verified, true);
    assert.equal(out.data.tid, 'fixture-tid-1');
    assert.equal(h.calls.qzonePosts.length, 1);
    assert.equal(h.calls.qzonePosts[0].content, '今天也要好好摸鱼');
    assert.equal(h.calls.qzonePosts[0].ugc_right, 1);
    // 审计：不该把 base64/绝对路径写进 state/admin-ops.json
    const audit = JSON.parse(fs.readFileSync(`${h.temp}/state/admin-ops.json`, 'utf8'));
    const last = audit.ops.at(-1);
    assert.equal(last.action, 'postQzone');
    assert.equal(last.ok, true);
    assert.equal(last.after.tid, 'fixture-tid-1');
  });
});

await test('发说说：确认卡确实发到 owner 私聊，且没真的调用网关', async () => {
  await withBridge(async ({ h, request }) => {
    // 正文故意写长（但仍在上限内）：确认卡必须完整展示，不能只给前 120 字摘要
    // —— 否则「前半段正常、后半段塞私货」的注入可以骗过 owner 的确认。
    const content = `开头正常${'啊'.repeat(200)}结尾暗号QZONE_TAIL`;
    const out = await request('qzone-post', {
      key: GROUP,
      method: 'POST',
      body: { key: GROUP, content }
    });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.status, 'pending');
    assert.ok(out.data.id > 0);
    assert.match(out.data.message, /确认卡/);
    assert.equal(h.calls.qzonePosts.length, 0, '确认前绝不能发');
    const card = h.calls.sent.find((m) => m.kind === 'private' && String(m.text).includes(`#${out.data.id}`));
    assert.ok(card, `确认卡应发到 owner 私聊，实际：${JSON.stringify(h.calls.sent)}`);
    assert.match(card.text, /发 QQ 空间说说/);
    assert.match(card.text, /回复「通过」/);
    assert.ok(card.text.includes('QZONE_TAIL'), '确认卡必须展示完整正文（防止后半段注入骗过确认）');
    // 同样的内容再调一次：不该再发一张卡
    const again = await request('qzone-post', {
      key: GROUP,
      method: 'POST',
      body: { key: GROUP, content }
    });
    assert.equal(again.data.status, 'pending');
    assert.equal(again.data.id, out.data.id);
    assert.equal(h.calls.sent.filter((m) => String(m.text).includes(`#${out.data.id}`)).length, 1);
  });
});

await test('发说说：正文超长 / 图片路径穿越 / 图片不存在 → 400，且什么都没发', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const tooLong = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST',
      body: { key: OWNER_PRIVATE, content: '字'.repeat(1200) }
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.data.error, /1000|正文/);
    const traversal = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST',
      body: { key: OWNER_PRIVATE, content: '带图', images: ['../secret.png'] }
    });
    assert.equal(traversal.status, 400);
    assert.match(traversal.data.error, /路径|\.\./);
    const missing = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST',
      body: { key: OWNER_PRIVATE, content: '带图', images: ['nope.png'] }
    });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /找不到|媒体库/);
    assert.equal(h.calls.qzonePosts.length, 0);
  }, { files: { 'media/README.txt': '媒体库占位文件（让 realpath 能解析到目录）' } });
});

await test('发说说：媒体库图片会被读成 base64:// 交给网关', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const out = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST',
      body: { key: OWNER_PRIVATE, content: '带一张图', images: ['pic.png'], ugcRight: 4 }
    });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.status, 'done');
    assert.equal(h.calls.qzonePosts[0].images.length, 1);
    assert.match(h.calls.qzonePosts[0].images[0], /^base64:\/\//);
    assert.equal(h.calls.qzonePosts[0].ugc_right, 4);
  }, { files: { 'media/pic.png': PNG } });
});

await test('发说说：同样内容不重复发 + 每小时上限', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const first = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, content: '重复内容' }
    });
    assert.equal(first.data.status, 'done');
    const dup = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, content: '重复内容' }
    });
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /刚发过|不重复/);
    const other = await request('qzone-post', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, content: '另一条内容' }
    });
    assert.equal(other.status, 400);
    assert.match(other.data.error, /每小时/);
    assert.equal(h.calls.qzonePosts.length, 1);
  }, { socialV2: { qzone: { post: { maxPerHour: 1, minIntervalMs: 0 } } } });
});

await test('发说说：工具关闭 / 没有令牌 / 权限不开放 → 拒绝且不发', async () => {
  await withBridge(async ({ h, request }) => {
    const off = await request('qzone-post', {
      key: GROUP, method: 'POST', body: { key: GROUP, content: 'x' }
    });
    assert.equal(off.status, 403);
    assert.match(off.data.error, /qq_qzone_post|工具未启用/);
    assert.equal(h.calls.qzonePosts.length, 0);
  }, { socialV2: { tools: { qzonePost: false } } });

  await withBridge(async ({ h, request }) => {
    const noToken = await request('qzone-post', {
      key: GROUP, method: 'POST', body: { key: GROUP, content: 'x' }, token: ''
    });
    assert.equal(noToken.status, 403);
    assert.match(noToken.data.error, /令牌/);
    assert.equal(h.calls.qzonePosts.length, 0);
  });

  await withBridge(async ({ h, request }) => {
    const perms = await request('/api/bot-perms', {
      method: 'POST', key: GROUP, agentToken: false, body: { scope: { qzonePost: 'none' } }
    });
    assert.equal(perms.status, 200, JSON.stringify(perms.data));
    const out = await request('qzone-post', {
      key: GROUP, method: 'POST', body: { key: GROUP, content: '不开放的说说' }
    });
    assert.equal(out.status, 400, JSON.stringify(out.data));
    assert.match(out.data.error, /不开放/);
    assert.equal(h.calls.qzonePosts.length, 0);
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
