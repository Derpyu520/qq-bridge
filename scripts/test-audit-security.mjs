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

// ── 端口白名单：SSRF 判定只看地址，不看端口 ──────────────────────────────────
//
// 一个**公网可达**的非常规端口（某内网服务通过端口映射暴露出来）在地址判定看来完全
// 合法，于是能被拿来探测。端口白名单把"能抓什么"收窄到常规 Web 端口，与地址判定互补。
test('optional allowPorts rejects non-web ports before opening a connection', async (t) => {
  const transport = mockTransport(t, []);
  const allowPorts = [80, 443, 8080, 8443];

  // 默认不限端口：既有调用方行为不变（否则会静默收紧媒体抓取）。
  await assert.doesNotReject(validateFetchUrl('http://public.test:9200/'));

  // 显式传入白名单后，非常规端口必须被拦。
  for (const url of [
    'http://public.test:9200/', 'http://public.test:6379/', 'http://public.test:8081/',
    'https://public.test:8444/', 'http://public.test:3000/',
  ]) {
    await assert.rejects(validateFetchUrl(url, { allowPorts }), /端口 \d+ 不在允许列表/);
  }

  // 白名单内的端口（含省略端口的默认 80/443）必须照常放行。
  for (const url of [
    'http://public.test/', 'https://public.test/', 'http://public.test:80/',
    'https://public.test:443/', 'http://public.test:8080/', 'https://public.test:8443/',
  ]) {
    await assert.doesNotReject(validateFetchUrl(url, { allowPorts }));
  }

  // 校验必须在**发起连接之前**失败。
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
