// 回归：人格切换 / 静音恢复之后，主动机会检查必须还排着。
//
// 真实故障（2026-10-26 14:13）：管理员私聊把主动概率调整设成 +80% 后切换人格，
// `resetPersonaContextV2()` 清掉了 proactiveTimer 却没有重新排程；直到桥接重启 /
// DSH 重连才会再次 `已安排主动机会检查`。中间三个多小时一次判定都没跑，
// 用户看到的就是「80% 但从来不主动说话」。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TOKEN = 'fixture-console-token';
const KEY = 'private:123';

async function fixture(run) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { private: ['123'], groups: ['456'] },
      socialV2: {
        proactive: { enabled: true, probability: 0, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000 }
      }
    },
    files: {
      'roles/A.md': '# A\n\n- 主动：中\n',
      'roles/B.md': '# B\n\n- 主动：中\n'
    }
  });
  h.setMode('reserved3');
  h.markModeConfirmed();
  h.markOwnerSender(KEY, true);
  const st = h.getSocialV2State(KEY);
  st.proactiveDelta = 0.8;
  assert.ok(st.proactiveTimer, '前置条件：进入仿真模式后主动检查应已排程');

  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': TOKEN }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: (() => { try { return JSON.parse(raw); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(JSON.stringify(body));
  });
  try {
    await run({ h, st, post });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('切换人格后主动检查仍然排程', async () => {
  await fixture(async ({ st, post }) => {
    const r = await post('/api/role', { key: KEY, role: 'A' });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    assert.ok(st.proactiveTimer, '切完人格应重新排主动检查；否则这个会话再也不会主动开口');
  });
});

test('静音后恢复，主动检查也回来', async () => {
  await fixture(async ({ st, post }) => {
    const mute = await post('/api/socialV2/wake-config', { key: KEY, config: { muted: true } });
    assert.equal(mute.status, 200, JSON.stringify(mute.data));
    assert.equal(st.proactiveTimer, null, '静音应清掉主动检查');

    const unmute = await post('/api/socialV2/wake-config', { key: KEY, config: { muted: false } });
    assert.equal(unmute.status, 200, JSON.stringify(unmute.data));
    assert.ok(st.proactiveTimer, '恢复唤醒后应重新排主动检查');
  });
});
