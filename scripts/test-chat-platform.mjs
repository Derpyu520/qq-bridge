import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chatPlatform, platformId, applyPlatformCapabilities, DISCORD_UNAVAILABLE_TOOLS } from '../src/chat-platform.js';
import { PRESETS, DISCORD_PRESETS, buildPatches } from './build-agent-preset-patches.mjs';
import { presetPromptBlockers } from '../src/preset-prompt.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const channelId = '1234567890123456701';

async function removeFixture(fixture) {
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), path.resolve(root));
  assert.ok(path.basename(resolved).startsWith('.tmp-discord-'));
  await fs.rm(resolved, { recursive: true, force: true });
}

test('existing configs select QQ and retain numeric SDK arguments', () => {
  assert.equal(chatPlatform(), 'qq');
  assert.equal(chatPlatform({ snowluma: {} }), 'qq');
  assert.equal(platformId('456'), 456);
  assert.equal(chatPlatform({ platform: 'discord' }), 'discord');
  assert.equal(platformId(channelId, 'discord'), channelId);
  assert.throws(() => platformId(Number(channelId), 'discord'), /quoted strings/);
  for (const platform of ['', null, 'Discord', 'other']) {
    assert.throws(() => chatPlatform({ platform }));
  }
});

test('capability restrictions apply only to Discord, including forced enable requests', () => {
  const qq = { socialV2: { tools: { sendPoke: true }, voice: { enabled: true }, sticker: { enabled: true } } };
  const original = structuredClone(qq);
  applyPlatformCapabilities(qq);
  assert.deepEqual(qq, original);
  const discord = { ...structuredClone(qq), platform: 'discord' };
  applyPlatformCapabilities(discord);
  for (const flag of DISCORD_UNAVAILABLE_TOOLS) assert.equal(discord.socialV2.tools[flag], false);
  assert.equal(discord.socialV2.voice.enabled, false);
  assert.equal(discord.socialV2.sticker.enabled, false);
});

test('both preset bundles are current and Discord preserves the shared tool safety rules', async () => {
  assert.ok(buildPatches({ check: true, presets: [...PRESETS, ...DISCORD_PRESETS] }).every((result) => !result.changed));
  for (const name of DISCORD_PRESETS) {
    const source = await fs.readFile(path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), 'utf8');
    const rows = yaml.load(source);
    const prefix = rows.find((row) => row.id === 'persona').config.prefix;
    assert.deepEqual(presetPromptBlockers(prefix, name.endsWith('-v2') ? 'v2' : 'v1', 'discord'), []);
    assert.equal(rows.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
    assert.ok(prefix.includes('mcp__snowluma__'));
    assert.ok(!prefix.includes('mcp__discord__'));
  }
  const qqGuard = await import('../plugins/qq-agent-presets/qq-tool-restrict.mjs');
  const discordGuard = await import('../plugins/discord-agent-presets/qq-tool-restrict.mjs');
  assert.equal(discordGuard.apply, qqGuard.apply);
  const mode = await import('../plugins/discord-mode-console/lib/index.js');
  assert.equal(mode.name, 'discord-mode-console');
  assert.equal(typeof mode.Config, 'function');
  mode.apply();
});

test('Discord setup is idempotent, isolates settings and keeps unrelated profile data', async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.tmp-discord-setup-'));
  const repo = path.join(fixture, 'repo');
  const home = path.join(fixture, 'home');
  try {
    await fs.mkdir(path.join(repo, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(repo, 'src'));
    for (const name of ['setup-dsh.mjs', 'build-agent-preset-patches.mjs']) {
      await fs.copyFile(path.join(root, 'scripts', name), path.join(repo, 'scripts', name));
    }
    for (const name of ['chat-platform.js', 'discord-id.js']) {
      await fs.copyFile(path.join(root, 'src', name), path.join(repo, 'src', name));
    }
    for (const directory of ['plugins', 'dsh']) {
      await fs.cp(path.join(root, directory), path.join(repo, directory), { recursive: true });
    }
    await fs.writeFile(path.join(repo, 'config.json'), JSON.stringify({ platform: 'discord' }));
    const profile = path.join(home, 'profiles', 'web');
    await fs.mkdir(profile, { recursive: true });
    const custom = { name: 'custom-provider', config: { model: 'fixture-model' }, id: 'custom-provider' };
    await fs.writeFile(path.join(profile, 'cordis.patch.yml'), yaml.dump([{ insert: [custom] }]));
    await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'fixture', private: true, dependencies: { custom: '1.0.0' },
      dsh: { profile: { bundles: ['custom'] } },
    }));
    const run = () => spawnSync(process.execPath, [path.join(repo, 'scripts', 'setup-dsh.mjs'), 'web'], {
      cwd: repo, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DSH_HOME: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' },
    });
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const rows = yaml.load(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'))
      .flatMap((operation) => operation.insert || []);
    assert.deepEqual(rows.find((row) => row.id === custom.id), custom);
    assert.deepEqual(rows.filter((row) => row.name === '@deepseek-ai/dsh-mcp-client').map((row) => row.id).sort(), [
      'mcp-snowluma', 'mcp-web-search-safe',
    ]);
    const pkg = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dsh.profile.bundles, ['custom', 'discord-mode-console', 'discord-agent-presets']);
    assert.equal(pkg.dependencies.custom, '1.0.0');
    assert.ok(!Object.hasOwn(pkg.dependencies, 'qq-mode-console'));
  } finally { await removeFixture(fixture); }
});

test('Discord MCP advertises string IDs, hides unsupported actions and reads through the authenticated bridge', async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/status'
      ? { mode: 'closed-agent' } : { ok: true, data: [{ user_id: '2234567890123456701', nickname: 'fixture' }] }));
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  let fixture;
  let client;
  try {
    fixture = await fs.mkdtemp(path.join(root, '.tmp-discord-mcp-'));
    await fs.mkdir(path.join(fixture, 'src'));
    await fs.mkdir(path.join(fixture, 'state'));
    for (const name of ['mcp-snowluma-safe.js', 'qq-model-view.js', 'sensitive.js', 'chat-platform.js', 'discord-id.js']) {
      await fs.copyFile(path.join(root, 'src', name), path.join(fixture, 'src', name));
    }
    await fs.writeFile(path.join(fixture, 'state', 'console-token'), 'fixture-console-token');
    await fs.writeFile(path.join(fixture, 'config.json'), JSON.stringify({
      platform: 'discord', consolePort: api.address().port,
      allow: { groups: [channelId] },
      socialV2: { tools: Object.fromEntries([...DISCORD_UNAVAILABLE_TOOLS].map((flag) => [flag, true])) },
    }));
    client = new Client({ name: 'discord-fixture', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(fixture, 'src', 'mcp-snowluma-safe.js')],
      cwd: fixture, stderr: 'pipe',
    }));
    const { tools } = await client.listTools();
    for (const name of ['qq_send_poke', 'qq_send_voice', 'qq_get_forward_msg', 'qq_send_sticker', 'qq_get_self_image']) {
      assert.ok(!tools.some((tool) => tool.name === name), name);
    }
    const history = tools.find((tool) => tool.name === 'qq_get_group_history').inputSchema.properties;
    assert.equal(history.groupId.type, 'string');
    assert.equal(history.messageSeq.type, 'string');
    const wake = tools.find((tool) => tool.name === 'qq_set_wake_config').inputSchema.properties;
    assert.equal(wake.config.properties.triggers.properties.speakerIds.items.type, 'string');
    const result = await client.callTool({ name: 'qq_get_group_members', arguments: { groupId: channelId } });
    assert.ok(!result.isError, result.content[0]?.text);
    const request = requests.find((item) => item.url === '/api/chat/action');
    assert.deepEqual(request.body, { action: 'get_group_member_list', params: { group_id: channelId } });
    assert.equal(request.headers['x-console-token'], 'fixture-console-token');
    assert.equal(request.headers['x-agent-call'], '1');
  } finally {
    await client?.close();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    if (fixture) await removeFixture(fixture);
  }
});
