// Offline integration tests. Every setup invocation receives its own repository and DSH_HOME.
// QQ_BRIDGE_TEST_YAML_ROOT is only useful when auditing with an intentionally read-only
// node_modules tree; normal installs resolve the declared js-yaml dependency directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserRoot = process.env.QQ_BRIDGE_TEST_YAML_ROOT || path.dirname(require.resolve('js-yaml/package.json'));
const yaml = (await import(pathToFileURL(path.join(parserRoot, 'dist/js-yaml.mjs')).href)).default;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-audit-setup-'));
let failures = 0;

function fixture(name, patch = '') {
  const base = path.join(sandbox, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-dsh.mjs'), path.join(repo, 'scripts/setup-dsh.mjs'));
  // setup-dsh.mjs 直接从仓库源生成 bundle patch，生成器必须一起进夹具。
  fs.copyFileSync(path.join(root, 'scripts/build-agent-preset-patches.mjs'), path.join(repo, 'scripts/build-agent-preset-patches.mjs'));
  fs.cpSync(path.join(root, 'dsh'), path.join(repo, 'dsh'), { recursive: true });
  fs.cpSync(path.join(root, 'plugins'), path.join(repo, 'plugins'), { recursive: true });
  fs.cpSync(parserRoot, path.join(repo, 'node_modules/js-yaml'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const patchFile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(patchFile, patch);
  fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: path.dirname(process.execPath), DSH_HOME: home, HOME: home, USERPROFILE: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' });
  const run = (profile = 'web', extraEnv = {}) => spawnSync(process.execPath, [path.join(repo, 'scripts/setup-dsh.mjs'), ...(profile === null ? [] : [profile])], {
    env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8', timeout: 15000,
  });
  return { repo, home, patchFile, run };
}

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  for (const profile of ['web', 'desktop', 'custom-profile']) {
    test(`no argument selects the only initialized ${profile} profile`, () => {
      const f = fixture(`auto-${profile}`);
      const profiles = path.join(f.home, 'profiles');
      if (profile !== 'web') fs.renameSync(path.join(profiles, 'web'), path.join(profiles, profile));
      const result = f.run(null);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`auto-selected profile: ${profile}`));
      assert.match(fs.readFileSync(path.join(profiles, profile, 'cordis.patch.yml'), 'utf8'), /mcp-snowluma/);
      if (profile !== 'web') assert.equal(fs.existsSync(path.join(profiles, 'web')), false);
    });
  }

  test('ambiguous discovery writes nothing; an explicit profile resolves it', () => {
    const f = fixture('auto-ambiguous');
    const dir = path.join(f.home, 'profiles/desktop');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'cordis.yml'), '[]\n');
    const before = fs.readdirSync(f.home, { recursive: true }).sort();
    const preset = path.join(f.repo, 'plugins/qq-agent-presets/presets/qq-chat.patch.yml');
    const presetBefore = fs.readFileSync(preset, 'utf8');
    const result = f.run(null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /multiple DSH profiles found: desktop, web/);
    assert.match(result.stderr, /setup-dsh\.mjs <profile>/);
    assert.deepEqual(fs.readdirSync(f.home, { recursive: true }).sort(), before);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), '');
    assert.equal(fs.readFileSync(preset, 'utf8'), presetBefore);
    assert.equal(fs.existsSync(path.join(f.repo, 'state')), false);
    assert.equal(f.run('desktop').status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), '');
  });

  for (const layout of ['missing', 'empty', 'uninitialized']) {
    test(`discovery refuses implicit creation with ${layout} profiles`, () => {
      const f = fixture(`auto-${layout}`);
      const profiles = path.join(f.home, 'profiles');
      fs.rmSync(profiles, { recursive: true });
      if (layout !== 'missing') fs.mkdirSync(profiles);
      if (layout === 'uninitialized') {
        fs.mkdirSync(path.join(profiles, 'scratch'));
        fs.writeFileSync(path.join(profiles, 'scratch/package.json'), '{"name":"ordinary-package"}');
      }
      const before = fs.readdirSync(f.home, { recursive: true }).sort();
      const result = f.run(null);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no initialized DSH profile found/);
      assert.deepEqual(fs.readdirSync(f.home, { recursive: true }).sort(), before);
      assert.equal(fs.existsSync(path.join(f.repo, 'state')), false);
    });
  }

  test('discovery ignores empty directories, reserved names, backup files and malformed metadata', () => {
    const f = fixture('auto-ignore');
    const profiles = path.join(f.home, 'profiles');
    for (const name of ['scratch', 'node_modules', 'broken', 'null-package']) fs.mkdirSync(path.join(profiles, name));
    fs.writeFileSync(path.join(profiles, 'node_modules/cordis.yml'), '[]');
    fs.writeFileSync(path.join(profiles, 'broken/package.json'), '{');
    fs.writeFileSync(path.join(profiles, 'null-package/package.json'), 'null');
    fs.writeFileSync(path.join(profiles, 'desktop.bak'), 'backup');
    assert.equal(f.run(null).status, 0);
    assert.equal(fs.existsSync(path.join(profiles, 'scratch/cordis.patch.yml')), false);
  });

  test('a DSH profile package alone is sufficient for discovery', () => {
    const f = fixture('auto-package');
    fs.unlinkSync(f.patchFile);
    const result = f.run(null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /auto-selected profile: web/);
  });

  test('an explicit profile can still be created in a fresh DSH_HOME', () => {
    const f = fixture('explicit-new');
    fs.rmSync(path.join(f.home, 'profiles'), { recursive: true });
    const result = f.run('custom');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(f.home, 'profiles/custom/cordis.patch.yml')));
    assert.equal(fs.existsSync(path.join(f.home, 'profiles/web')), false);
  });

  test('shared inserts, quoted IDs, flow YAML and unrelated nested arrays survive repeat setup', () => {
    const source = `# user patch\n- insert:\n    - id: mcp-snowluma\n      name: old\n    - id: custom\n      name: custom-plugin\n      config:\n        empty:\n          []\n        nested:\n          - id: mcp-snowluma-host\n            value: keep\n- insert:\n    - id: 'mcp-snowluma-host' # previous setup\n      name: old\n- {insert: [{id: mcp-web-search-safe, name: old}]}\n`;
    const f = fixture('structured', source);
    const originalCustom = yaml.load(source)[0].insert[1];
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const doc = yaml.load(fs.readFileSync(f.patchFile, 'utf8'));
      const entries = doc.flatMap((op) => op.insert || []);
      assert.deepEqual(entries.find((entry) => entry.id === 'custom'), originalCustom);
      for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
        assert.equal(entries.filter((entry) => entry.id === id).length, 1, `${id} duplicate`);
      }
      assert.equal(entries.find((entry) => entry.id === 'mcp-snowluma').config.toolCallTimeoutMs, 725000);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json')));
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing', 'qq-mode-console', 'qq-agent-presets']);
  });

  test('legacy root [] is repaired without altering literal strings', () => {
    const f = fixture('legacy', `[]\n- insert:\n    - id: custom\n      name: custom\n      config:\n        text: |\n          []\n          keep me\n`);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(yaml.load(fs.readFileSync(f.patchFile, 'utf8'))[0].insert[0].config.text, '[]\nkeep me\n');
  });

  test('malformed patch fails before replacing user configuration or presets', () => {
    const source = '- insert: [broken\n';
    const f = fixture('malformed', source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('profile traversal is rejected before filesystem changes', () => {
    const f = fixture('traversal');
    const result = f.run('../../escape');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'escape')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
  });

  test('existing mode, DSH settings and non-link plugin directory remain untouched', () => {
    const f = fixture('preserve', '[]\n');
    fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
    const mode = '{"mode":"closed-agent","closedAgentPreset":"custom"}\n';
    fs.writeFileSync(path.join(f.repo, 'state/mode.json'), mode);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/mode.json'), 'utf8'), mode);
    const blocker = fixture('plugin-conflict', '[]\n');
    fs.mkdirSync(path.join(blocker.home, 'plugins/qq-mode-console'), { recursive: true });
    fs.writeFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'keep');
    assert.notEqual(blocker.run().status, 0);
    assert.equal(fs.readFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'utf8'), 'keep');
  });

  if (process.platform === 'win32') test('Windows runs the npm .cmd shim with literal profile arguments', () => {
    const f = fixture('windows-cli');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const capture = path.join(bin, 'called.json');
    const cli = path.join(bin, 'fake-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), home: process.env.DSH_HOME}));\n`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const profile = 'test&name%CD%!';
    const result = f.run(profile, {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0', QQ_TEST_CAPTURE: capture,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(capture), `CLI was not invoked: ${result.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), { args: ['plugin', '--profile', profile, 'install'], home: f.home });
  });
} finally {
  // Resolve the exact fixture root before removing this test's temporary files.
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
