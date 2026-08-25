#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册 qq-mode-console 插件
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreset(name) {
  const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
  const dest = path.join(DSH_HOME, '.agent-presets', name);
  if (!fs.existsSync(src)) fatal(`preset source not found: ${src}`);
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
  log(`preset installed: ${name}`);
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function mcpBlock() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'),
    'mcp-snowluma-host': path.join(REPO_ROOT, 'src', 'mcp-host-server.js'),
    'mcp-web-search-safe': path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'),
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  for (const [id, script] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${id.replace('mcp-', '')}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(script)}\n`;
    if (id === 'mcp-snowluma') {
      out += `        toolCallTimeoutMs: 725000\n`;
    }
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function patchCordis() {
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
  } else if (text.includes('id: mcp-snowluma') || text.includes('mcp-snowluma-safe.js')) {
    log(`cordis.patch.yml already contains mcp-snowluma entries; skipped auto-insert. Please check manually if they point to this repo.`);
    return;
  } else {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `\n${block}`;
    log(`cordis.patch.yml: qq-bridge MCP block appended`);
  }
  fs.writeFileSync(patchFile, text, 'utf8');
}

function ensurePluginLink() {
  const repoPlugin = path.join(REPO_ROOT, 'plugins', 'qq-mode-console');
  const pluginLink = path.join(DSH_HOME, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) fatal(`plugin not found: ${repoPlugin}`);
  ensureDir(path.dirname(pluginLink));
  if (!fs.existsSync(pluginLink)) {
    try {
      if (process.platform === 'win32') {
        fs.symlinkSync(repoPlugin, pluginLink, 'junction');
      } else {
        fs.symlinkSync(repoPlugin, pluginLink, 'dir');
      }
      log(`plugin link created: ${pluginLink}`);
    } catch (e) {
      fatal(`failed to create plugin link: ${e.message}`);
    }
  } else {
    log(`plugin link already exists: ${pluginLink}`);
  }
  return pluginLink;
}

function patchProfilePackage(pluginLink) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
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

copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis();
const pluginLink = ensurePluginLink();
patchProfilePackage(pluginLink);
log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
