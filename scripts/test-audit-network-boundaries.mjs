// Offline network-boundary regressions. All transports and DNS answers are fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';

const originalLookup = dns.promises.lookup;
dns.promises.lookup = async (host) => {
  if (host === 'search.test') return [{ address: '93.184.216.34', family: 4 }];
  if (host === 'platform.test') return [{ address: '168.63.129.16', family: 4 }];
  throw new Error(`Unexpected offline DNS name: ${host}`);
};
let fetchModule;
let searchModule;
try {
  fetchModule = await import('../src/safe-fetch.js');
  searchModule = await import('../src/web-search.js');
} finally {
  dns.promises.lookup = originalLookup;
}
const { isPrivateIp, safeFetch, safeFetchBuffer, validateFetchUrl } = fetchModule;
const { deepseekSearch } = searchModule;

function mockTransport(t, scripts) {
  const requests = [];
  const request = (options, callback) => {
    const script = scripts[requests.length];
    assert.ok(script, 'Unexpected network connection');
    requests.push(options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough();
      res.statusCode = script.status ?? 200;
      res.headers = script.headers ?? {};
      res.complete = false;
      callback(res);
      if (!res.destroyed) {
        res.complete = true;
        res.end(script.body ?? '');
      }
    });
    return req;
  };
  t.mock.method(https, 'request', request);
  t.mock.method(http, 'request', request);
  return requests;
}

test('Azure platform addresses are blocked through direct, embedded and DNS forms', async (t) => {
  const requests = mockTransport(t, []);
  for (const address of [
    '168.63.129.16', '::ffff:a83f:8110', '64:ff9b::a83f:8110', '2002:a83f:8110::1',
  ]) assert.equal(isPrivateIp(address), true, address);
  for (const url of ['http://168.63.129.16/', 'http://[::ffff:a83f:8110]/', 'http://platform.test/']) {
    await assert.rejects(validateFetchUrl(url), /内网|本机|禁止/);
  }
  assert.equal(requests.length, 0);
  assert.equal(isPrivateIp('168.63.129.17'), false, 'ordinary public addresses must remain usable');
});

test('redirects cannot reach cloud platform services through text or image fetch', async (t) => {
  const requests = mockTransport(t, [
    { status: 302, headers: { location: 'http://168.63.129.16/' } },
    { status: 307, headers: { location: 'http://[::ffff:a83f:8110]/' } },
  ]);
  await assert.rejects(safeFetch('https://93.184.216.34/'), /内网|本机|禁止/);
  await assert.rejects(safeFetchBuffer('https://93.184.216.34/'), /内网|本机|禁止/);
  assert.equal(requests.length, 2, 'only the public redirect sources may be contacted');
});

const fixtureKey = 'fixture-search-key-only';
const searchConfig = { apiKey: fixtureKey, baseURL: 'https://search.test/v1', timeoutMs: 1000 };

test('search HTTP errors never expose API keys echoed by the upstream service', async (t) => {
  mockTransport(t, [{ status: 401, body: JSON.stringify({ error: { message: `Rejected credential ${fixtureKey}` } }) }]);
  await assert.rejects(deepseekSearch('fixture', searchConfig), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(fixtureKey), false, 'HTTP diagnostics reach the model');
    return true;
  });
});

test('search results redact the known API key before returning upstream text', async (t) => {
  mockTransport(t, [{ body: JSON.stringify({ content: [
    { type: 'text', citations: [{ url: 'https://example.com/', cited_text: `diagnostic ${fixtureKey}` }] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: `echo ${fixtureKey}`, url: 'https://example.com/' },
    ] },
  ] }) }]);
  const results = await deepseekSearch('fixture', searchConfig);
  assert.equal(results.length, 1);
  assert.equal(JSON.stringify(results).includes(fixtureKey), false, 'results enter the model context and cache');
  assert.match(results[0].title, /REDACTED/);
});

test('short search credentials cannot corrupt response protocol fields', async (t) => {
  mockTransport(t, [{ body: JSON.stringify({ content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: 'fixture a result', url: 'https://www.bbc.net/', a: 'ignored field' },
    ] },
  ] }) }]);
  const results = await deepseekSearch('fixture', { ...searchConfig, apiKey: 'a' });
  assert.equal(results.length, 1, 'redaction must preserve web_search_tool_result/web_search_result type names');
  assert.equal(results[0].title, 'fixture [REDACTED] result');
  assert.equal(results[0].url, 'https://www.bbc.net/');
  assert.equal(Object.hasOwn(results[0], 'a'), false, 'untrusted object keys are never projected into results');
});

test('credential redaction happens before result title and snippet truncation', async (t) => {
  mockTransport(t, [{ body: JSON.stringify({ content: [
    { type: 'text', citations: [{ url: 'https://example.com/', cited_text: `${'x'.repeat(495)}${fixtureKey}` }] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: `${'x'.repeat(195)}${fixtureKey}`, url: 'https://example.com/' },
    ] },
  ] }) }]);
  const [result] = await deepseekSearch('fixture', searchConfig);
  for (const field of ['title', 'snippet']) {
    assert.equal(result[field].includes(fixtureKey.slice(0, 5)), false, `${field} must not leak a truncated key prefix`);
    assert.match(result[field], /\[REDA/);
  }
});

test('MCP web_fetch applies its web-port allowlist on the shared transport', async () => {
  const tools = new Map();
  const calls = [];
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, callback); }
    registerTool(name, config, callback) { tools.set(name, callback); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer, StdioServerTransport: class {}, z, path, process,
    safeFetch: async (...args) => { calls.push(args); return { body: 'fixture' }; },
    webSearch: async () => { throw new Error('Unexpected search'); },
  });
  await tools.get('web_fetch')({ url: 'https://example.com/' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 50000);
  assert.deepEqual(Array.from(calls[0][2]?.allowPorts ?? []), [80, 443, 8080, 8443]);
});
