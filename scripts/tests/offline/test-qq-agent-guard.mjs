// qq-agent-guard / qq-chat-tools 自检（离线）。
//
// 覆盖：
// 1. 路径规范化与排除判定（含目录子树、祖先遍历、符号链接 canonical）
// 2. checkToolCall：read/write/edit/glob/grep 的路径拒绝；glob/grep 的搜索根与 pattern 绕过；
//    bash 的排除路径与危险命令（rm -r / sudo / dd / fork bomb…）
// 3. 配置语义：不写 agentGuard ⇒ 内置默认；显式 denyRead/denyExec ⇒ 完全替换
// 4. qq-tool-restrict 的 allowLocalTools：只放行挂载的那几个本地工具，其余照旧拒绝
// 5. qq-chat-tools preset 的源与产物一致性（工具行、守卫配置、patch 里的 !!js / 裸说明符）
// 运行：node scripts/tests/offline/test-qq-agent-guard.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigExamplePath } from '../../../src/util/config-path.js';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DENY_EXEC,
  DEFAULT_DENY_READ,
  checkToolCall,
  expandPath,
  isAncestorOfDenied,
  isPathDenied,
  isUnder,
  resolveGuardConfig
} from '../../../plugins/qq-agent-presets/qq-agent-guard.mjs';
import { apply as restrictApply } from '../../../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const FAKE_REPO = path.join(os.tmpdir(), 'qq-guard-repo');
const FAKE_HOME = path.join(os.tmpdir(), 'qq-guard-home');
const WS = path.join(os.tmpdir(), 'qq-guard-ws');
const config = resolveGuardConfig({
  denyRead: [path.join(FAKE_HOME, '.ssh'), path.join(FAKE_REPO, 'config.json'), path.join(FAKE_REPO, 'state')],
  denyExec: DEFAULT_DENY_EXEC
}, { repoRoot: FAKE_REPO, home: FAKE_HOME });

const check = (name, args, cwd = WS) => checkToolCall({ name, args, cwd, config, home: FAKE_HOME });

console.log('## 路径工具');
{
  ok(expandPath('~/.ssh', { repoRoot: FAKE_REPO, home: FAKE_HOME }) === path.join(FAKE_HOME, '.ssh'), '~ 展开');
  ok(expandPath('state/x', { repoRoot: FAKE_REPO }) === path.join(FAKE_REPO, 'state', 'x'), '相对仓库根');
  ok(expandPath('/abs/x', { repoRoot: FAKE_REPO }) === path.resolve('/abs/x'), '绝对路径');
  ok(isUnder('/a/b', '/a') && isUnder('/a', '/a') && !isUnder('/ab', '/a'), 'isUnder 含自身、挡住同前缀兄弟目录');
  ok(isPathDenied(path.join(FAKE_HOME, '.ssh', 'id_rsa'), config.denyRead), '目录子树内命中');
  ok(!isPathDenied(path.join(FAKE_HOME, '.ssh2', 'id_rsa'), config.denyRead), '同前缀兄弟目录不误伤');
  ok(isAncestorOfDenied(FAKE_HOME, config.denyRead), '祖先目录被识别（遍历会读进排除项）');
  ok(!isAncestorOfDenied(path.join(FAKE_HOME, '.ssh'), config.denyRead), '排除项自身不算祖先');
}

console.log('## fs 工具');
{
  ok(check('read', { file_path: path.join(FAKE_HOME, '.ssh', 'id_rsa') }) !== null, 'read 拒绝排除路径');
  ok(check('read', { file_path: path.join(WS, 'note.txt') }) === null, 'read 放行工作区');
  ok(check('read', { file_path: '../' + path.basename(WS) + '-other/x' }) === null, 'read 放行相对路径解析结果');
  ok(check('read', { file_path: path.join(FAKE_HOME, '.ssh2', 'id_rsa') }) === null, 'read 不误伤同前缀目录');
  ok(check('write', { file_path: path.join(FAKE_REPO, 'config.json'), content: 'x' }) !== null, 'write 拒绝排除路径');
  ok(check('edit', { file_path: path.join(FAKE_REPO, 'state', 'sessions.json') }) !== null, 'edit 拒绝排除路径');
  ok(check('read_image', { file_path: path.join(FAKE_HOME, '.ssh', 'a.png') }) !== null, 'read_image 拒绝排除路径');
}

console.log('## glob / grep');
{
  ok(check('glob', { pattern: '**/*', path: path.join(FAKE_HOME, '.ssh') }) !== null, 'glob 拒绝搜索排除目录');
  ok(check('grep', { pattern: 'token', path: path.join(FAKE_REPO, 'state') }) !== null, 'grep 拒绝搜索排除目录');
  ok(check('glob', { pattern: '**/*', path: FAKE_HOME }) !== null, 'glob 拒绝搜索「排除目录的祖先」');
  ok(check('glob', { pattern: '**/*' }) === null || WS === FAKE_HOME, 'glob 默认工作区（非祖先）放行');
  ok(check('glob', { pattern: '/etc/**' }) !== null, 'glob 拒绝绝对 pattern');
  ok(check('grep', { pattern: '../x' }) !== null, 'grep 拒绝含 .. 的 pattern');
  ok(check('glob', { pattern: '**/*', path: WS }) === null, 'glob 工作区内放行');
}

console.log('## bash 命令');
{
  ok(check('bash', { command: `cat ${path.join(FAKE_HOME, '.ssh', 'id_rsa')}` }) !== null, 'bash 拒绝包含排除绝对路径的命令');
  ok(check('bash', { command: 'cat ~/.ssh/id_rsa' }) !== null, 'bash 拒绝 ~ 形式的排除路径');
  ok(check('bash', { command: 'rm -rf build' }) !== null, 'bash 拒绝 rm -rf');
  ok(check('bash', { command: 'rm -r build' }) !== null, 'bash 拒绝 rm -r');
  ok(check('bash', { command: 'sudo ls' }) !== null, 'bash 拒绝 sudo');
  ok(check('bash', { command: 'dd if=/dev/zero of=/dev/sda' }) !== null, 'bash 拒绝 dd of=');
  ok(check('bash', { command: ':(){ :|:& };:' }) !== null, 'bash 拒绝 fork bomb');
  ok(check('bash', { command: 'ls -la && cat README.md' }) === null, 'bash 放行普通命令');
  ok(check('bash', { command: 'rm note.txt' }) === null, 'bash 放行非递归 rm（工作区内）');
  ok(check('pwsh', { command: 'Remove-Item -Recurse -Force x' }) !== null || !DEFAULT_DENY_EXEC.some((p) => /Remove-Item/.test(p)), 'pwsh 递归删除策略（记录当前口径）');
  ok(check('read', { file_path: path.join(FAKE_HOME, '.ssh', 'id_rsa') }, undefined) !== null, 'cwd 缺省时仍拦绝对路径');
}

console.log('## 配置语义');
{
  const defaults = resolveGuardConfig(undefined, { repoRoot: FAKE_REPO, home: FAKE_HOME });
  ok(defaults.denyRead.length === DEFAULT_DENY_READ.length, '不写 agentGuard ⇒ 内置默认列表');
  ok(defaults.denyExec.length === DEFAULT_DENY_EXEC.length, '不写 agentGuard ⇒ 内置默认命令模式');
  const replaced = resolveGuardConfig({ denyRead: ['only-this'], denyExec: [] }, { repoRoot: FAKE_REPO, home: FAKE_HOME });
  ok(replaced.denyRead.length === 1 && replaced.denyRead[0] === path.join(FAKE_REPO, 'only-this'), '显式 denyRead 完全替换默认');
  ok(replaced.denyExec.length === 0, '显式空 denyExec 表示不拦命令');
  const off = resolveGuardConfig({ enabled: false }, { repoRoot: FAKE_REPO, home: FAKE_HOME });
  ok(off.enabled === false && checkToolCall({ name: 'read', args: { file_path: path.join(FAKE_HOME, '.ssh', 'id_rsa') }, cwd: WS, config: off }) === null, 'enabled:false 全部放行');
  ok(resolveGuardConfig({ denyExec: ['('] }, { repoRoot: FAKE_REPO }).denyExec.length === 0, '非法正则被忽略而不是崩溃');
}

console.log('## qq-tool-restrict · allowLocalTools');
{
  const makeCtx = () => {
    const restricted = [];
    let guard;
    return { restricted, get guard() { return guard; }, tools: { restrict({ deny }) { restricted.push(...deny); }, guard(fn) { guard = fn; } } };
  };
  const strict = makeCtx();
  restrictApply(strict);
  ok(typeof strict.guard({ name: 'read' }) === 'string', '默认：本地工具在执行期被拒');
  ok(typeof strict.guard({ name: 'bash' }) === 'string', '默认：bash 被拒');
  // 上游 0.2.2 起 QQ MCP 工具还要求「会话绑定」：exec.agent.id 要能解出当前 key。
  const boundExec = { agent: { id: `qqb-g-366610352-${'a'.repeat(32)}` } };
  ok(strict.guard({ name: 'mcp__snowluma__qq_status' }) === undefined, '默认：无需 key 的 QQ MCP 工具放行');
  ok(strict.guard({ name: 'mcp__snowluma__qq_send_message', ...boundExec, arguments: { key: 'group:366610352', messages: 'hi' } }) === undefined, '默认：已绑定会话的 QQ MCP 工具放行');
  ok(typeof strict.guard({ name: 'mcp__snowluma__qq_send_message', ...boundExec, arguments: { key: 'group:999' } }) === 'string', '默认：跨会话 QQ MCP 调用被拒');
  ok(strict.restricted.includes('read') && strict.restricted.includes('bash'), '默认：read/bash 在 restrict 名单里');

  const tools = makeCtx();
  restrictApply(tools, { allowLocalTools: true });
  for (const name of ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh']) {
    ok(tools.guard({ name }) === undefined, `allowLocalTools：放行 ${name}`);
  }
  for (const name of ['subagent', 'workflow', 'plugin_manager', 'str_replace_editor', 'read_mcp_resource', '']) {
    ok(typeof tools.guard({ name }) === 'string', `allowLocalTools：仍拒绝 ${JSON.stringify(name)}`);
  }
  ok(!tools.restricted.includes('read') && !tools.restricted.includes('bash'), 'allowLocalTools：不 restrict 本地工具');
  ok(tools.restricted.includes('subagent') && tools.restricted.includes('plugin_manager'), 'allowLocalTools：危险工具仍 restrict');

  // denyTools：按 preset 屏蔽单个工具（群聊不暴露上传文件）
  const denied = makeCtx();
  restrictApply(denied, { denyTools: ['mcp__snowluma__qq_upload_file'] });
  ok(typeof denied.guard({ name: 'mcp__snowluma__qq_upload_file' }) === 'string', 'denyTools：执行期拒绝被屏蔽工具');
  ok(denied.restricted.includes('mcp__snowluma__qq_upload_file'), 'denyTools：restrict 隐藏被屏蔽工具');
  ok(denied.guard({ name: 'mcp__snowluma__qq_send_message', ...boundExec, arguments: { key: 'group:366610352', messages: 'hi' } }) === undefined, 'denyTools 不影响其他 QQ MCP 工具');
}

console.log('## qq-chat-tools preset 契约');
{
  const dir = path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-tools');
  const yml = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8');
  for (const row of ['tool-fs', 'tool-fs-search', 'tool-bash', 'tool-pwsh', 'qq-agent-guard']) {
    ok(new RegExp(`^- id: ${row}$`, 'm').test(yml), `preset 含 ${row} 行`);
  }
  ok(/allowLocalTools: true/.test(yml), 'preset 打开 allowLocalTools');
  ok(/没有本地工具/.test(yml) === false || !/没有本地工具：不能执行命令/.test(yml), '旧「没有本地工具」表述已删除');
  ok(/agentGuard\.denyRead/.test(yml) && /破坏性命令/.test(yml), '人格里写明了排除路径与破坏性命令约束');

  const patch = fs.readFileSync(path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-tools.patch.yml'), 'utf8');
  ok(patch.includes('qq-agent-presets/qq-agent-guard.mjs'), 'patch 用可解析的裸说明符引用 guard');
  ok(patch.includes('!!js process.platform'), 'patch 保留 bash/pwsh 的平台条件');
  ok(patch.includes('allowLocalTools: true'), 'patch 里的 restrict 配置一致');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'qq-agent-presets', 'package.json'), 'utf8'));
  // 纯聊天预设（qq-chat / qq-chat-v2）屏蔽文件上传：只能发图片/表情。
  for (const name of ['qq-chat', 'qq-chat-v2']) {
    const yml = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), 'utf8');
    ok(yml.includes("denyTools: ['mcp__snowluma__qq_upload_file']"), `${name} 屏蔽文件上传工具（纯聊天预设只发图片/表情）`);
  }
  // 带工具的工作区预设（qq-chat-tools）允许上传：不屏蔽，人格里有上传规则。
  const toolsYml = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-tools', 'agent.cordis.yml'), 'utf8');
  ok(!toolsYml.includes('denyTools'), 'qq-chat-tools 不屏蔽上传（工作区预设可以传文件）');
  ok(toolsYml.includes('qq_upload_file') && /上传文件/.test(toolsYml), 'qq-chat-tools 人格写明上传规则');
  ok(toolsYml.includes('allowLocalTools: true'), 'qq-chat-tools 仍放行本地工具');
  ok(pkg.dsh?.bundle?.patch?.includes('./presets/qq-chat-tools.patch.yml'), 'bundle 注册了第三个 patch 层');

  const example = JSON.parse(fs.readFileSync(resolveConfigExamplePath(ROOT), 'utf8'));
  ok(Array.isArray(example.agentGuard?.denyRead) && example.agentGuard.denyRead.includes('~/.ssh'), 'config.example 含 agentGuard.denyRead');
  ok(Array.isArray(example.agentGuard?.denyExec) && example.agentGuard.denyExec.length > 0, 'config.example 含 agentGuard.denyExec');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
