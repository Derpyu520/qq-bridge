// Execute both real preset plugins against a captured tools service, without DSH/QQ.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const { apply } = await import(pathToFileURL(path.join(root, 'dsh/agent-presets', preset, 'qq-tool-restrict.mjs')).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name, agent: { id: 'qqb-g-1' }, arguments: { key: 'group:1' } }), undefined, `${preset}: expected allowed ${name}`);
  }
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `${preset}: must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log(`${preset}: checked allowed tools and denied inherited/local/invalid tools`);
}
// ── state/ 权限收紧（Windows 上 mode 0o600 是空操作，必须动 ACL）的离线守卫 ──────────
// 这里只做"结构 + 编码"级断言：真正的 icacls/UAC 行为在这个环境里跑不了（沙箱禁止改 ACL），
// 而**假装测过**比不测更危险，所以明确只钉住下面这些不会骗人的事实。
import fs from 'node:fs';
{
  const helperPath = path.join(root, 'scripts/harden-state-acl.mjs');
  assert.ok(fs.existsSync(helperPath), 'ACL 收紧助手必须存在（start.bat 依赖它）');
  const helper = fs.readFileSync(helperPath, 'utf8');
  for (const needle of ['icacls', '/inheritance:r', '--elevated', 'isHardened', 'process.exit(0)']) {
    assert.ok(helper.includes(needle), `ACL 助手应包含 ${needle}`);
  }
  // 失败必须降级为非阻断：任何一条 sayAlways/console.log 之后都不得以非 0 退出。
  assert.ok(!/process\.exit\([1-9]/.test(helper), 'ACL 助手不得以非 0 退出码结束（否则会阻断启动）');
  // 提权递归防护：被自己拉起的那一次必须跳过提权重试。
  assert.ok(/!isElevatedRun/.test(helper), '提权重试必须被 --elevated 标记短路，防止递归');

  const bat = fs.readFileSync(path.join(root, 'start.bat'));
  const batText = bat.toString('latin1');
  const nonAscii = [...bat].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, 'start.bat 必须保持纯 ASCII（否则非 UTF-8 控制台会乱码）');
  assert.equal(batText.match(/(?<!\r)\n/g)?.length ?? 0, 0, 'start.bat 必须使用 CRLF');
  assert.ok(batText.includes('harden-state-acl.mjs'), 'start.bat 必须在启动桥接前调用 ACL 助手');
  // 桥接与守护窗口都用绝对路径，重启脚本才能证明它们属于当前仓库。
  assert.ok(batText.includes('node "%~dp0src\\bridge.js"'), 'start.bat 必须用绝对路径启动 bridge');
  assert.ok(batText.indexOf('harden-state-acl.mjs') < batText.indexOf('node "%~dp0src\\bridge.js"'), 'ACL 助手必须先于桥接启动');
  const restartText = fs.readFileSync(path.join(root, 'restart.bat'), 'latin1');
  assert.ok(restartText.includes('start "" cmd /c "%~dp0start.bat"'), 'restart.bat 必须用绝对路径启动守护窗口');
  console.log('state ACL hardening: helper is non-blocking, recursion-guarded, and wired into start.bat');
}

// ── 合规不变量 L6：本程序**只探测、不部署** SnowLuma ────────────────────────────────
// 依据：SnowLuma EULA §5.4（中文为准）
//   「除事先取得著作权人的书面授权外……不得复制、修改、单独再分发或再许可该组件。
//     将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**，或者将其用于任何商业用途，
//     均须事先取得书面授权。」
// 2026-09-20：`start_snowluma` / `stop_snowluma` 与 `snowluma.allowProcessControl` 已整体移除。
// 这条测试**防止它们（或同类能力）被无意加回来**——本项目唯一一条"删掉的功能不许复活"的约束。
{
  const host = fs.readFileSync(path.join(root, 'src/mcp-host-server.js'), 'utf8');
  // ① 代码里不得再出现进程启停原语（注释中为记录原因可以提，故先剔掉纯注释行）
  const code = host.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  for (const bad of ['spawn(', 'taskkill', 'execFileSync', 'child_process']) {
    assert.ok(!code.includes(bad), `mcp-host-server.js 不得再出现「${bad}」（违反 EULA §5.4 的 L6 不变量）`);
  }
  // ② 不得再注册这两个工具
  for (const tool of ['start_snowluma', 'stop_snowluma']) {
    assert.ok(!host.includes(`'${tool}'`), `不得再注册 ${tool}（EULA §5.4）`);
  }
  // ③ 配置项不得复活（代码与模板两侧都查）
  assert.ok(!code.includes('allowProcessControl'), 'mcp-host-server.js 不得再读取 allowProcessControl');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.ok(!example.includes('allowProcessControl'), 'config.example.json 不得再提供 allowProcessControl');
  // ④ 只读工具必须还在（别把整个 server 删空）
  assert.ok(host.includes("'snowluma_status'"), 'snowluma_status（只读探活）必须保留');
  // ⑤ 包元数据必须声明许可证（独立复核发现此前缺失）
  // 断言具体值而不是"非空"：许可从 MIT 改成 PolyForm Noncommercial 是刻意的决定，
  // 写死值才能在有人误改回去时立刻发现。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0',
    'package.json 的 license 必须是本仓库实际使用的许可（PolyForm Noncommercial 1.0.0，见 NOTICE.md）');
  // 随仓库分发的子包也不能各自声明 MIT（曾与根清单冲突，见 NOTICE.md §1.3）。
  for (const rel of ['plugins/qq-agent-presets/package.json', 'plugins/qq-mode-console/package.json']) {
    const sub = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    assert.equal(sub.license, 'PolyForm-Noncommercial-1.0.0',
      `${rel} 的 license 必须与根清单一致（PolyForm Noncommercial 1.0.0）`);
  }
  console.log('L6 compliance: no SnowLuma process control, no allowProcessControl, license declared');
}

process.exitCode = failures ? 1 : 0;
