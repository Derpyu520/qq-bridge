// GitHub issue runtime regressions. All credentials, network peers and ACLs are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { probeDshBaseUrl } from '../src/dsh-endpoint.js';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-runtime-issues-'));
const previousHome = process.env.DSH_HOME;
const previousToken = process.env.SNOWLUMA_TOKEN;
const previousHttp = process.env.SNOWLUMA_HTTP_URL;
const previousFetch = globalThis.fetch;
process.env.DSH_HOME = tmp;
delete process.env.SNOWLUMA_TOKEN;
delete process.env.SNOWLUMA_HTTP_URL;
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('PASS', name);
};
const credentialFile = path.join(tmp, '.credentials.yaml');
const writeCredentials = () => fs.writeFileSync(credentialFile, JSON.stringify({
  records: { 'client-connection/browser-session': { kind: 'grant', payload: {
    version: 1, secret: Buffer.alloc(32, 7).toString('base64url')
  } } }
}));
const cookieAuthority = (cookie) => JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString()).authority;

const aclSource = fs.readFileSync(new URL('../src/state-acl.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const allow = 'fixture BUILTIN\\Administrators:(F)\n        fixture-user:(F)\n';
function fakeAcl(run) {
  const calls = [];
  const context = vm.createContext({
    process: { platform: 'win32', env: { USERNAME: 'fixture-user' } },
    fs: { readdirSync: () => [] },
    spawnSync: (_exe, args) => {
      calls.push(args);
      return run(args, calls.length) ?? { status: 0, stdout: args.length === 1 ? allow : '' };
    }
  });
  vm.runInContext(`${aclSource}\nglobalThis.acl = { hardenDir, hardenFile, isHardened, hasPermissionGrant, manualDirCommand };`, context);
  return { ...context.acl, calls };
}

try {
  await test('#110 initial missing credentials recover without restarting the client', async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    await assert.rejects(client.ensureAuth(), /DSH 鉴权不可用/);
    writeCredentials();
    const cookie = await client.ensureAuth();
    assert.equal(cookieAuthority(cookie), '127.0.0.1:3080');
    assert.equal(client._strategy, 'minted');
  });

  await test('#110 malformed credentials are retried after the file is repaired', async () => {
    fs.writeFileSync(credentialFile, 'records: [');
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    assert.equal(client.browserSessionSecret(), null);
    await assert.rejects(client.ensureAuth(), /DSH 鉴权不可用/);
    writeCredentials();
    assert.equal((await client.ensureAuth()).startsWith('dsh-auth-'), true);
    assert.equal(client.browserSessionSecret().length, 32);
  });

  await test('#56 changing DSH port invalidates the cookie and preserves subscriptions', async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    const original = await client.ensureAuth();
    client.events.follow('fixture-session');
    assert.equal(client.rebind('http://127.0.0.1:42000/'), true);
    assert.equal(client.cookie, null);
    assert.equal(client._desiredFollows.has('fixture-session'), true);
    const rebound = await client.ensureAuth();
    assert.notEqual(rebound, original);
    assert.equal(cookieAuthority(rebound), '127.0.0.1:42000');
    assert.equal(client.rebind('http://127.0.0.1:42000'), false);
  });

  await test('#56 endpoint discovery verifies the DSH RPC envelope with an authority-bound cookie', async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:42000/api/settings/describe');
      assert.equal(cookieAuthority(init.headers.cookie), '127.0.0.1:42000');
      assert.equal(init.redirect, 'manual');
      return { ok: true, json: async () => ({ type: 'server-response', result: { ok: true } }) };
    };
    assert.equal(await probeDshBaseUrl('http://127.0.0.1:42000'), true);
    assert.equal(await probeDshBaseUrl('https://remote.invalid'), false);
    assert.equal(calls, 1);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { ok: true } }) });
    assert.equal(await probeDshBaseUrl('http://127.0.0.1:42000'), false);
  });

  await test('#19 discovery preserves different HTTP and WebSocket credentials', async () => {
    const home = path.join(tmp, 'snowluma');
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config', 'onebot_101.json'), JSON.stringify({ networks: {
      httpServers: [{ host: '127.0.0.1', port: 41000, accessToken: 'fixture-http-credential' }],
      wsServers: [{ host: '127.0.0.1', port: 41001, accessToken: 'fixture-ws-credential' }]
    } }));
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:41000/get_login_info');
      assert.equal(init.headers.authorization, 'Bearer fixture-http-credential');
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 101 } }) };
    };
    const result = await discoverSnowLumaConnection({ cfg: {}, homeDirs: [home] });
    assert.equal(result.token, 'fixture-http-credential');
    assert.equal(result.wsToken, 'fixture-ws-credential');
    assert.equal(result.wsUrl, 'ws://127.0.0.1:41001');
    assert.equal(JSON.stringify(result.tried).includes('fixt'), false, '#115 no credential prefix in diagnostics');
    assert.equal(result.tried[0].token, '(已配置)');
  });

  await test('#55 unsupported reasoning effort retries the configured provider/model without effort', async () => {
    const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    const start = source.indexOf('  async function ensureChatModel(');
    const end = source.indexOf('\n  async function ensureSession(', start);
    assert.ok(start >= 0 && end > start);
    const requests = [];
    const context = {
      modelAppliedSessions: new Map(), modelSelectionEpoch: 1,
      cfg: { dsh: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } },
      REASONING_EFFORT_DEFAULT: 'max', unwrap, log() {}, sleep: async () => {},
      api: { sessions: { selectModel: async (payload) => {
        requests.push(payload);
        if (payload.reasoningEffort) return { result: { ok: false, error: {
          code: 'session/model-unavailable', message: 'model does not support reasoning effort "max"'
        } } };
        return { result: { ok: true, value: { selected: { provider: payload.provider, model: payload.model } } } };
      } } }
    };
    const ensure = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.ok(requests.some((r) => r.reasoningEffort === 'max'));
    assert.equal(Object.hasOwn(requests.at(-1), 'reasoningEffort'), false);
    assert.ok(requests.every((r) => r.provider === 'fixture-provider' && r.model === 'fixture-model'));
    const count = requests.length;
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.equal(requests.length, count);
  });

  await test('#54 directory ACL grants access before removing inheritance, with verification at each step', () => {
    const acl = fakeAcl(() => undefined);
    assert.equal(acl.hardenDir('fixture-dir').ok, true);
    const mutations = acl.calls.filter((args) => args.length > 1);
    assert.equal(mutations.length, 3);
    assert.ok(mutations[0].includes('/grant'));
    assert.equal(mutations[0].includes('/inheritance:r'), false);
    assert.ok(mutations[1].includes('/inheritance:r') && mutations[1].includes('/grant'));
    assert.equal(mutations[1].includes('/T'), false, 'directory inheritance flags must never be applied recursively to files');
    assert.ok(mutations[2].includes('/remove:g'));
    assert.ok(mutations.every((args) => !args.includes('/C')), 'mutation commands must fail fast instead of ignoring recursive failures');
    assert.equal(acl.calls.filter((args) => args.length === 1).length, 3);
    const manual = acl.manualDirCommand('fixture-dir').split('\n');
    assert.ok(manual[0].includes('/grant') && !manual[0].includes('/inheritance:r'));
    assert.ok(manual[1].includes('/inheritance:r') && manual[1].includes('/grant'));
    assert.ok(manual[2].includes('/remove:g'));
    assert.ok(manual.every((line) => !line.includes('/C')));
  });

  await test('#54 failed commands and empty DACLs stop before any subsequent destructive step', () => {
    for (const failure of [
      { status: 5, stdout: '', stderr: 'fixture failure' },
      { status: 0, stdout: 'Successfully processed 0 files; Failed processing 1 files' },
      { status: 0, stderr: '拒绝访问' },
      { status: null, error: new Error('fixture timeout') }
    ]) {
      const acl = fakeAcl(() => failure);
      assert.equal(acl.hardenDir('fixture-dir').ok, false);
      assert.equal(acl.calls.length, 1);
    }
    const empty = fakeAcl((args) => args.length === 1 ? { status: 0, stdout: 'fixture-dir\nSuccessfully processed 1 files' } : undefined);
    assert.equal(empty.hardenDir('fixture-dir').ok, false);
    assert.equal(empty.calls.length, 2);
    assert.equal(empty.isHardened('fixture-dir'), false);
    const labelOnly = fakeAcl(() => ({ status: 0, stdout: 'Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)' }));
    assert.equal(labelOnly.isHardened('fixture-dir'), false);
    const inherited = fakeAcl(() => ({ status: 0, stdout: 'fixture-user:(I)(F)' }));
    assert.equal(inherited.isHardened('fixture-dir'), false);
    const explicit = fakeAcl(() => undefined);
    assert.equal(explicit.isHardened('fixture-dir'), true);
  });

  await test('#54 path names containing permission-like parentheses do not count as ACL grants', () => {
    const pathOnly = 'D:\\Projects\\(F)\\qq-bridge\\state\nSuccessfully processed 1 files; Failed processing 0 files';
    for (const output of [
      pathOnly,
      `${pathOnly}\nfixture-user:(DENY)(F)`,
      `${pathOnly}\nfixture-user:(OI)(CI)(IO)(F)`,
      `${pathOnly}\nMandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)`
    ]) {
      const acl = fakeAcl(() => ({ status: 0, stdout: output }));
      assert.equal(acl.hasPermissionGrant(output), false);
      assert.equal(acl.isHardened('fixture-target'), false);
    }
    const acl = fakeAcl(() => undefined);
    assert.equal(acl.hasPermissionGrant(`${pathOnly}\nfixture-user:(OI)(CI)(F)`), true);
    assert.equal(acl.hasPermissionGrant('fixture-user:(I)(RX)'), true);
    assert.equal(acl.hasPermissionGrant('fixture-user:(R,W)'), true);
    assert.equal(acl.hasPermissionGrant('D:\\Projects\\(IO)\\state fixture-user:(F)'), true);
  });

  await test('#54 localized recursive failures stop at the failing operation independently of error text', () => {
    for (const operation of ['hardenDir', 'hardenFile']) {
      for (const failedStep of [1, 2, 3]) {
        for (const message of ['Zugriff verweigert', 'Acceso denegado', 'fixture-localized-error']) {
          let mutations = 0;
          const acl = fakeAcl((args) => {
            if (args.length === 1) return;
            mutations++;
            if (mutations === failedStep) return { status: 5, stdout: message, stderr: '' };
          });
          assert.equal(acl[operation]('fixture-target').ok, false);
          assert.equal(mutations, failedStep, 'no operation may run after a recursive failure');
          assert.ok(acl.calls.filter((args) => args.length > 1).every((args) => !args.includes('/C')));
        }
      }
    }
    const onlyDeny = fakeAcl(() => ({ status: 0, stdout: 'fixture-user:(DENY)(F)' }));
    assert.equal(onlyDeny.isHardened('fixture-target'), false);
  });

  await test('#54 credential files also grant before removing inheritance and remove broad explicit grants', () => {
    const acl = fakeAcl(() => undefined);
    assert.equal(acl.hardenFile('fixture-file').ok, true);
    const mutations = acl.calls.filter((args) => args.length > 1);
    assert.equal(mutations[0].includes('/inheritance:r'), false);
    assert.ok(mutations[0].includes('/grant:r'));
    assert.ok(mutations[1].includes('/inheritance:r'));
    assert.ok(mutations[2].includes('/remove:g'));
    assert.ok(mutations.every((args) => !args.includes('/T') && !args.includes('/C') && !args.some((arg) => arg.includes('(OI)'))));
  });
} finally {
  globalThis.fetch = previousFetch;
  for (const [key, value] of [['DSH_HOME', previousHome], ['SNOWLUMA_TOKEN', previousToken], ['SNOWLUMA_HTTP_URL', previousHttp]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nRuntime issue regressions: ${passed} passed`);
