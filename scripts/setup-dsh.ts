#!/usr/bin/env bun
// setup-dsh.ts — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册 qq-mode-console 插件
//
// 用法：
//   bun scripts/setup-dsh.ts [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

function log(msg: string): void {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg: string): never {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreset(name: string): void {
  const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
  const dest = path.join(DSH_HOME, '.agent-presets', name);
  if (!fs.existsSync(src)) fatal(`preset source not found: ${src}`);
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
  log(`preset installed: ${name}`);
}

function yamlSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function mcpBlock(): string {
  // 使用 Bun 作为 MCP server 运行时（qq-bridge 已整体迁移到 TypeScript + Bun）。
  const bunPath = Bun.which('bun') ?? process.execPath;
  const servers: Record<string, string> = {
    'mcp-snowluma': path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.ts'),
    'mcp-snowluma-host': path.join(REPO_ROOT, 'src', 'mcp-host-server.ts'),
    'mcp-web-search-safe': path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.ts'),
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  for (const [id, script] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${id.replace('mcp-', '')}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(bunPath)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(script)}\n`;
    if (id === 'mcp-snowluma') {
      out += `        toolCallTimeoutMs: 725000\n`;
    }
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function patchCordis(): void {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  ensureDir(profileDir);
  let text = '';
  if (fs.existsSync(patchFile)) {
    text = fs.readFileSync(patchFile, 'utf8');
  }
  const beginMarker = '# === qq-bridge MCP BEGIN ===';
  const endMarker = '# === qq-bridge MCP END ===';
  const block = mcpBlock();
  if (text.includes(beginMarker) && text.includes(endMarker)) {
    text = text.replace(
      /[^\n]*# === qq-bridge MCP BEGIN ===[\s\S]*?# === qq-bridge MCP END ===[^\n]*/,
      block.trimEnd(),
    );
    log(`cordis.patch.yml: qq-bridge MCP block updated`);
  } else if (text.includes('id: mcp-snowluma') || text.includes('mcp-snowluma-safe')) {
    log(`cordis.patch.yml already contains mcp-snowluma entries; skipped auto-insert. Please check manually if they point to this repo.`);
    return;
  } else {
    text = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
    if (text.trim().length > 0) {
      if (!text.endsWith('\n')) text += '\n';
      text += `\n${block}`;
    } else {
      text += block;
    }
    log(`cordis.patch.yml: qq-bridge MCP block appended`);
  }
  fs.writeFileSync(patchFile, text, 'utf8');
}

function ensurePluginLink(): string {
  const repoPlugin = path.join(REPO_ROOT, 'plugins', 'qq-mode-console');
  const pluginLink = path.join(DSH_HOME, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) fatal(`plugin not found: ${repoPlugin}`);
  ensureDir(path.dirname(pluginLink));

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(pluginLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') fatal(`failed to inspect plugin link: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`plugin path already exists and is not a symlink/junction: ${pluginLink}. Please remove it manually or move it out of the way, then rerun.`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(pluginLink);
      const expected = fs.realpathSync(repoPlugin);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`plugin link already exists and points to this repo: ${pluginLink}`);
      return pluginLink;
    }
    log(`plugin link exists but points elsewhere/broken, recreating: ${pluginLink}`);
    fs.rmSync(pluginLink, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(repoPlugin, pluginLink, 'junction');
    } else {
      fs.symlinkSync(repoPlugin, pluginLink, 'dir');
    }
    log(`plugin link created: ${pluginLink}`);
  } catch (e) {
    fatal(`failed to create plugin link: ${e instanceof Error ? e.message : String(e)}`);
  }
  return pluginLink;
}

function patchProfilePackage(pluginLink: string): void {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg: any = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  const linkVal = `link:${pluginLink.replace(/\\/g, '/')}`;
  if (pkg.dependencies['qq-mode-console'] !== linkVal) {
    pkg.dependencies['qq-mode-console'] = linkVal;
    log(`package.json dependency qq-mode-console -> ${linkVal}`);
  }
  if (!pkg.dsh.profile.bundles.includes('qq-mode-console')) {
    pkg.dsh.profile.bundles.push('qq-mode-console');
    log(`package.json bundle added: qq-mode-console`);
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile(): void {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: 'router-standard' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

function autoInstallProfileBundles(): void {
  const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const r = spawnSync(cmd, ['plugin', '--profile', PROFILE, 'install'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) {
    log(`auto-install skipped: dsh CLI 未找到（${(r.error as any)?.code || r.error?.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle \\"qq-mode-console\\"”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis();
const pluginLink = ensurePluginLink();
patchProfilePackage(pluginLink);
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
