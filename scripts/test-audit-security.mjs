// Offline regression tests: no sockets, QQ messages, production config or secrets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SENSITIVE_RE } from '../src/sensitive.js';

const lookupCalls = [];
const originalLookup = dns.promises.lookup;
dns.promises.lookup = async (host) => {
  lookupCalls.push(host);
  if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
  if (host === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }];
  if (host === 'expanded.test') return [{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 }];
  // 双栈主机：IPv6 在前（真实 DNS 的常见顺序），用于验证「IPv4 优先 + 失败切换」。
  if (host === 'dual.test') return [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '93.184.216.34', family: 4 },
  ];
  throw new Error(`Unexpected DNS lookup in offline test: ${host}`);
};
let fetchModule;
try { fetchModule = await import('../src/safe-fetch.js'); }
finally { dns.promises.lookup = originalLookup; }
const { isPrivateIp, safeFetch, safeFetchBuffer, validateFetchUrl } = fetchModule;

function mockTransport(t, scripts) {
  const requests = [];
  const responses = [];
  const request = (options, callback) => {
    const script = scripts[requests.length];
    assert.ok(script, 'Unexpected outgoing request');
    const req = new EventEmitter();
    requests.push({ options, req });
    req.destroyed = false;
    req.destroy = (error) => {
      req.destroyed = true;
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    req.end = () => queueMicrotask(() => {
      if (script.failWith) {
        // 模拟「这个地址连不上」：连接阶段报错，而不产生响应。
        req.emit('error', new Error(script.failWith));
        return;
      }
      const res = new PassThrough();
      res.statusCode = script.status || 200;
      res.headers = script.headers || {};
      res.complete = false;
      responses.push(res);
      callback(res);
      if (res.destroyed) return;
      if (script.produce) script.produce(res);
      else {
        res.complete = true;
        res.end(script.body || 'ok');
      }
    });
    return req;
  };
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  return { requests, responses };
}

test('sensitive audit catches UNC paths and quoted JSON credentials', () => {
  for (const value of [
    String.raw`\\server\share\private.txt`,
    String.raw`C:\Users\someone\config.json`,
    '/root/.ssh/id_rsa',
    '{"token":"fixture-only-token"}',
    '{"accessToken": "fixture-only-token"}',
    "{'password': 'fixture-password'}",
    'api_key = fixture-api-value',
  ]) assert.equal(SENSITIVE_RE.test(value), true, value);
  for (const value of ['你好，今天吃什么', '如何设置密码？', 'token 的作用是什么？', '访问 https://example.com/guide']) {
    assert.equal(SENSITIVE_RE.test(value), false, value);
  }
});

// ── 伪装形态：逐字匹配的正则挡不住"看起来一样、字节不同"的写法 ──────────────
//
// 攻击者只需要让文本在**归一化之后**相同就能绕过逐字正则：
//   · 全角冒号/反斜杠（NFKC 归一后与半角相同）
//   · 零宽字符（肉眼不可见）
//   · 整段 base64 编码
//   · 用空格/点/横线把关键词拆开
// 这条把"归一化后必须命中"钉成断言。
test('sensitive audit normalizes disguises before matching', () => {
  const ZWSP = '\u200b';
  const ZWJ = '\u200d';
  for (const value of [
    'C：＼Users＼someone＼config.json',                 // 全角冒号 + 全角反斜杠
    `C:${ZWSP}\\Users\\someone`,                       // 零宽空格
    `C:${ZWJ}\\Users\\someone`,                        // 零宽连接符
    'dG9rZW49Zml4dHVyZS1vbmx5LXRva2Vu',                // base64('token=fixture-only-token')
    't o k e n = fixture-value-xxx',                   // 空格拆开
    'to-ken=fixture-value-xxx',                        // 横线拆开
  ]) assert.equal(SENSITIVE_RE.test(value), true, `伪装形态必须被拦：${value}`);
});

// 归一化不得把正常内容误伤成敏感 —— 否则闸门会被用成"随便拦"。
test('sensitive normalization does not flag ordinary content', () => {
  for (const value of [
    '你好，今天吃什么',
    '如何设置密码？',
    'token 的作用是什么？',
    '访问 https://example.com/guide',
    '表情 md5 是 0123456789abcdef0123456789abcdef',   // 32-hex 不得被当令牌
    '这个包的版本是 v0.2.1-r1',
    '随便一串英文 base64 lookalike 字符串',
  ]) assert.equal(SENSITIVE_RE.test(value), false, `不得误伤：${value}`);
});

test('IPv6 canonicalization cannot turn a private address into public', () => {
  for (const value of [
    '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1',
    '::ffff:127.0.0.1', 'fd00::8.8.8.8', 'fe80::8.8.8.8',
    '64:ff9b::7f00:1', '64:ff9b:1:a00::808:808', 'not-an-ip',
  ]) assert.equal(isPrivateIp(value), true, value);
  for (const value of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(value), false, value);
  }
});

test('URLs and every DNS result are validated before opening a connection', async (t) => {
  const transport = mockTransport(t, []);
  for (const url of [
    'file:///etc/passwd', 'http://user:pass@public.test/', 'http://127.1/',
    'http://[::ffff:127.0.0.1]/', 'http://localhost./', 'http://host.local./',
    'http://mixed.test/', 'http://expanded.test/',
  ]) await assert.rejects(validateFetchUrl(url));
  assert.equal(transport.requests.length, 0);
});

test('HTTP transport pins the validated IP and preserves Host and TLS SNI', async (t) => {
  const before = lookupCalls.length;
  const { requests } = mockTransport(t, [{ body: 'fixture' }]);
  const result = await safeFetch('https://public.test/page?q=1');
  assert.equal(result.body, 'fixture');
  assert.equal(result.truncated, false);
  assert.deepEqual(lookupCalls.slice(before), ['public.test']);
  assert.equal(requests[0].options.hostname, '93.184.216.34');
  assert.equal(requests[0].options.headers.host, 'public.test');
  assert.equal(requests[0].options.servername, 'public.test');
  assert.equal(requests[0].options.path, '/page?q=1');
});

test('dual-stack hosts try IPv4 first and fail over to the next validated address', async (t) => {
  // 真实故障形态：QQ 表情 CDN 的 AAAA 记录排在前面，而本机没有 IPv6 出口 ——
  // 只取第一个地址的旧实现会一路等到 20 秒超时（表现为「部分表情/图片发不出去」）。
  const before = lookupCalls.length;
  const { requests } = mockTransport(t, [{ failWith: 'connect ETIMEDOUT' }, { body: 'second address ok' }]);
  const result = await safeFetch('https://dual.test/sticker');
  assert.equal(result.body, 'second address ok');
  assert.deepEqual(lookupCalls.slice(before), ['dual.test']);
  assert.equal(requests.length, 2, '第一个地址失败后必须换下一个地址重试');
  assert.equal(requests[0].options.hostname, '93.184.216.34', 'IPv4 必须优先（即使 DNS 先给 AAAA）');
  assert.equal(requests[1].options.hostname, '2606:4700:4700::1111', '失败后切到另一个已校验地址');
  assert.equal(requests[1].options.headers.host, 'dual.test', '换地址不能改变 Host');
  assert.equal(requests[1].options.servername, 'dual.test', '换地址不能改变 TLS SNI');
});

test('redirect bodies are closed immediately and internal redirects are rejected', async (t) => {
  const { requests, responses } = mockTransport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/' }, produce() {} }]);
  await assert.rejects(safeFetch('http://93.184.216.34/'), /禁止/);
  assert.equal(requests.length, 1);
  assert.equal(responses[0].destroyed, true);
});

test('public redirects still work without downloading their bodies', async (t) => {
  const { responses } = mockTransport(t, [
    { status: 307, headers: { location: '/next' }, produce() {} },
    { body: 'redirect worked' },
  ]);
  const result = await safeFetch('http://93.184.216.34/start');
  assert.equal(result.url, 'http://93.184.216.34/next');
  assert.equal(result.body, 'redirect worked');
  assert.equal(responses[0].destroyed, true);
});

test('text limits count Unicode code points and close oversized responses', async (t) => {
  const { responses } = mockTransport(t, [{ body: '😀😀😀继续' }]);
  const result = await safeFetch('http://93.184.216.34/', 3);
  assert.equal(result.body, '😀😀😀');
  assert.equal(result.truncated, true);
  assert.equal(responses[0].destroyed, true);
});

test('image byte limits and signatures are checked', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const { responses } = mockTransport(t, [{ body: png }, { body: png }, { body: Buffer.alloc(20) }]);
  assert.deepEqual((await safeFetchBuffer('http://93.184.216.34/', 12)).buffer, png);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 11), /大小限制/);
  assert.equal(responses[1].destroyed, true);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/'), /不是有效图片/);
});

test('text and image requests have a total deadline despite continuous incoming data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { requests, responses } = mockTransport(t, [{ produce() {} }, { produce() {} }]);
  for (const fetcher of [safeFetch, safeFetchBuffer]) {
    const pending = fetcher('http://93.184.216.34/');
    const rejected = assert.rejects(pending, /请求超时/);
    // Let URL validation and the mocked response callback complete.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    t.mock.timers.tick(19000);
    responses.at(-1).write(Buffer.from('a'));
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(requests.at(-1).req.destroyed, true);
    assert.equal(responses.at(-1).destroyed, true);
  }
});

test('aborted bodies reject instead of leaving the operation pending', async (t) => {
  mockTransport(t, [{ produce: (res) => res.emit('aborted') }]);
  await assert.rejects(safeFetch('http://93.184.216.34/'), /中断/);
});

test('invalid resource limits are rejected before network access', async (t) => {
  mockTransport(t, []);
  for (const limit of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(safeFetch('http://93.184.216.34/', limit), /正整数/);
    await assert.rejects(safeFetchBuffer('http://93.184.216.34/', limit), /正整数/);
  }
});
