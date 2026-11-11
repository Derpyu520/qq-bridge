// setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次，断言
// **profile 的 cordis.patch.yml 一个字节都没变**（MCP 行现在由 bundle 提供，
// 安装器只做只读检查）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 夹具放系统临时目录，**不要**放仓库的 state/：harden-state-acl.mjs 会把 state/ 的
// 继承 ACE 去掉（只留当前用户 / SYSTEM / Administrators），于是 DSH 沙箱的能力 SID
// 不在 ACL 里，在沙箱内跑这个测试会直接 EPERM 建目录。
const tmpHome = path.join(os.tmpdir(), 'qq-bridge-setup-test-home');
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

// 预置一个「历史版本」patch：含旧版安装器留下的 BEGIN/END 区块 + 用户自己的行。
// 新脚本不应改写它，只应在输出里提示手工处理。
const legacyPatch = `# legacy profile patch
- id: user-setting
  name: '@example/user-setting'
  config:
    keep: true

# === qq-bridge MCP BEGIN ===
# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-snowluma-safe.js'
- insert:
    - id: mcp-snowluma-host
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma-host
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-host-server.js'
- insert:
    - id: mcp-web-search-safe
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web-search-safe
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-web-search-safe.js'
# === qq-bridge MCP END ===
`;
const patchPath = path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml');
fs.writeFileSync(patchPath, legacyPatch, 'utf8');
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-approval-toast': 'file:C:/x/dsh-approval-toast' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-approval-toast'] } },
}, null, 2), 'utf8');

// 用指向本仓库插件的 junction 冒充上一轮已安装的插件链接（与真实安装形态一致），
// 这样脚本会走「已存在且指向本仓库 → 跳过」的正常分支。
fs.symlinkSync(path.join(ROOT, 'plugins', 'qq-mode-console'), path.join(tmpHome, 'plugins', 'qq-mode-console'), 'junction');

// js-yaml 优先从 DSH 安装目录取；拿不到就退回本仓库的 node_modules
// （package.json 已声明该依赖，正常 npm install 后一定可解析）。
async function loadYaml() {
  try {
    const mod = await import(pathToFileURL(path.join(dshModulesDir(), 'js-yaml/index.js')).href);
    return mod.default ?? mod;
  } catch {
    const mod = await import('js-yaml');
    return mod.default ?? mod;
  }
}

function runSetup(label) {  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web'], {
    // 保留最小 PATH（进程启动需要），但把 dsh CLI 排除在外 → 跳过自动 pnpm 安装那一步
    env: { ...process.env, DSH_HOME: tmpHome, PATH: path.dirname(process.execPath) },
    encoding: 'utf8',
    cwd: ROOT,
  });
  console.log(`\n--- ${label} (exit=${r.status}${r.error ? ' err=' + r.error.message : ''}) ---`);
  console.log((r.stdout || '').trim() || '(no stdout)');
  if (r.stderr?.trim()) console.log('STDERR:', r.stderr.trim());
  return r;
}

const first = runSetup('第 1 次运行');
const second = runSetup('第 2 次运行');

const finalPatch = fs.readFileSync(patchPath, 'utf8');

let failed = 0;
const check = (ok, message) => {
  console.log(`${ok ? '✅' : '❌'} ${message}`);
  if (!ok) failed += 1;
};

// 断言 1：两次运行都成功
check(first.status === 0 && second.status === 0, '两次运行都成功退出');

// 断言 2：profile patch 一个字节都没变（这是本次改动的核心）
check(finalPatch === legacyPatch, 'cordis.patch.yml 两次运行后逐字节不变');

// 断言 3：脚本提示了遗留区块，并且明确说不会代改
const warned = /注入区块/.test(first.stdout || '') && /不会替你改/.test(first.stdout || '');
check(warned, '检测到遗留区块并提示手工处理');

// 断言 4：没有产生重复 id（文件没被改写，自然也不会多出来）
for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
  const n = finalPatch.split('\n').filter((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line)).length;
  check(n === 1, `id ${id} 出现 ${n} 次（期望 1）`);
}

// 断言 5：MCP 行改由 bundle 提供，且 bundle 的清单文件都存在
const bundleDir = path.join(ROOT, 'dsh', 'qq-bridge-mcp');
const bundlePatch = path.join(bundleDir, 'cordis.patch.yml');
check(fs.existsSync(bundlePatch), 'dsh/qq-bridge-mcp/cordis.patch.yml 存在');
const yaml = await loadYaml();
const bundleDoc = yaml.load(fs.readFileSync(bundlePatch, 'utf8'));
const bundleIds = bundleDoc.flatMap((op) => op.insert || []).map((entry) => entry.id);
check(JSON.stringify(bundleIds) === JSON.stringify(['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']),
  `bundle 里正好三条 MCP 行（${bundleIds.join(', ')}）`);
const bundlePkg = JSON.parse(fs.readFileSync(path.join(bundleDir, 'package.json'), 'utf8'));
check(bundlePkg.dsh?.bundle?.patch === './cordis.patch.yml', 'bundle package.json 指向自己的 patch');
for (const entry of bundlePkg.files ?? []) {
  if (entry.includes('*')) continue;
  check(fs.existsSync(path.join(bundleDir, entry)), `bundle files 里的 ${entry} 存在`);
}

// 断言 6：profile package.json 含两个 bundle，且未破坏其他 bundle
const pkg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;
check(bundles.includes('qq-mode-console') && bundles.includes('qq-agent-presets') && bundles.includes('dsh-approval-toast'),
  `profile bundles 正确: ${bundles.join(', ')}`);
check(String(pkg.dependencies['qq-agent-presets'] ?? '').startsWith('link:')
  && String(pkg.dependencies['qq-mode-console'] ?? '').startsWith('link:'),
  'link: 依赖已登记（preset 子行的裸说明符靠它解析）');

// 断言 7：DSH 0.1.7 机制 —— preset 由 qq-agent-presets bundle 的 patch 层装配，
// 旧目录 ~/.dsh/.agent-presets 不再写入（也不删除用户数据）。
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const patchFile = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', `${p}.patch.yml`);
  const text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  check(text.includes('@deepseek-ai/dsh-agent-preset') && new RegExp(`^\\s+id: ${p}$`, 'm').test(text),
    `preset ${p} 的 patch 层就绪（含 @deepseek-ai/dsh-agent-preset 行 + config.id）`);
}
check(!fs.existsSync(path.join(tmpHome, '.agent-presets')), '未创建 0.1.7 已废弃的 ~/.dsh/.agent-presets');

console.log(failed === 0 ? '\n✅ setup-dsh.mjs 幂等性测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
