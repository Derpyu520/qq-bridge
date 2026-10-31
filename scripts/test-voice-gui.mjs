// 图形界面（voice-gui.mjs + public/voice.html）自检：
//   1) 参数解析（--port 必须真的生效，裸 --port 不能退化成 1）
//   2) 静态资源与结构（HTML 里引用的接口、关键控件、内联 JS 可解析）
//   3) 纯函数安全边界：路径穿越、上传文件名净化、库内唯一命名
//   4) live 模式（QQ_BRIDGE_TEST_LIVE=1）：真的起一个随机端口的服务，验证 401 / bootstrap / dry-run
//
// 默认**不真发语音**（live 模式也只用 dryRun）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { safeJoinLibrary, sanitizeUploadName, uniqueLibraryPath } from '../src/voice-core.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolDir, voiceToolPath } from './voice-tool-locator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 独立发语音工具的入口（voice-gui.mjs / voice-cli.mjs / public/voice.html）都在仓库上一级的
// voice-tool/；共享内核仍由本仓库 src/voice-core.js 提供。

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 参数解析（曾经把 --port 解析成 1 的坑）');
{
  // 复刻 voice-gui.mjs 的解析逻辑并验证
  const parse = (argv) => {
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) continue;
      const eq = a.indexOf('=');
      if (eq >= 0) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.set(name, next); i++; }
      else flags.set(name, true);
    }
    return flags;
  };
  const f1 = parse(['--no-open', '--port', '3210']);
  ok(Number(f1.get('port')) === 3210, '`--port 3210` 得到 3210（不是 true/1）');
  ok(f1.get('no-open') === true, '`--no-open` 是布尔而非吞掉下一个参数');
  const f2 = parse(['--port=3215', '--allow-delete']);
  ok(Number(f2.get('port')) === 3215, '`--port=3215` 生效');
  ok(f2.get('allow-delete') === true, '`--allow-delete` 生效');
  // 这条要读工具自己的源码；上面 4 条是复刻的解析逻辑，不依赖工具目录，照跑。
  if (!hasVoiceTool()) {
    skipVoiceTool('voice-gui.mjs 源码里的非法端口守卫 Number.isInteger(PORT)');
  } else {
    const src = fs.readFileSync(voiceToolPath('voice-gui.mjs'), 'utf8');
    ok(src.includes('Number.isInteger(PORT)'), '非法端口会被拦下（不会静默绑到奇怪端口）');
  }
}

console.log('## 安全：路径穿越与文件名净化');
{
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lib-'));
  fs.writeFileSync(path.join(lib, 'ok.mp3'), Buffer.alloc(8, 1));
  fs.writeFileSync(path.join(path.dirname(lib), 'outside.mp3'), Buffer.alloc(8, 1));

  ok(safeJoinLibrary(lib, 'ok.mp3')?.endsWith('ok.mp3'), '库内正常文件放行');
  ok(safeJoinLibrary(lib, '../outside.mp3') === null, '拒绝 ../ 逃逸');
  ok(safeJoinLibrary(lib, '..\\outside.mp3') === null, '拒绝 ..\\ 逃逸（Windows 反斜杠）');
  ok(safeJoinLibrary(lib, '../../config.json') === null, '拒绝 ../../config.json');
  ok(safeJoinLibrary(lib, 'sub/../../x.mp3') === null, '拒绝多级混合穿越');
  ok(safeJoinLibrary(lib, '') === null, '拒绝空路径');
  ok(safeJoinLibrary(lib, 'a\0b.mp3') === null, '拒绝含 NUL 的路径');

  ok(sanitizeUploadName('../../evil.mp3') === 'evil.mp3', '上传名去掉目录部分');
  ok(sanitizeUploadName('C:\\Windows\\x.mp3') === 'x.mp3', '上传名去掉 Windows 路径');
  ok(sanitizeUploadName('a<b>c?.mp3') === 'a_b_c_.mp3', '上传名净化非法字符');
  ok(sanitizeUploadName('语音.wav') === '语音.wav', '保留中文名');
  ok(sanitizeUploadName('noext') === 'noext.mp3', '没有音频扩展名时补 .mp3');
  ok(sanitizeUploadName('...').endsWith('.mp3'), '纯点名不会变成隐藏文件');

  const p1 = uniqueLibraryPath(lib, 'ok.mp3');
  ok(p1.endsWith('ok-2.mp3'), '同名文件自动改名 ok-2.mp3', path.basename(p1));

  fs.rmSync(lib, { recursive: true, force: true });
  try { fs.rmSync(path.join(path.dirname(lib), 'outside.mp3'), { force: true }); } catch {}
}

console.log('## 前端页面结构');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-tool/public/voice.html 的界面结构与前端接口断言');
} else {
  const htmlPath = voiceToolPath('public', 'voice.html');
  ok(fs.existsSync(htmlPath), 'voice-tool/public/voice.html 存在');
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const id of ['libList', 'tgtList', 'sendBtn', 'drop', 'dryRun', 'history', 'gwDot', 'toast']) {
    ok(html.includes(`id="${id}"`), `界面元素 ${id}`);
  }
  for (const ep of ['/api/bootstrap', '/api/library', '/api/send', '/api/upload', '/api/audio']) {
    ok(html.includes(ep), `前端调用 ${ep}`);
  }
  ok(/x-voice-token/.test(html), '前端带令牌请求头');
  ok(/sessionStorage/.test(html), '令牌存 sessionStorage（刷新不丢、关页即清）');
  ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/127\.0\.0\.1:\d+/g, '')), '前端无外部网络依赖');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, '前端 JS 可解析'); }
  catch (e) { ok(false, '前端 JS 可解析', e.message); }
}

console.log('## 服务端接线');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-gui.mjs 的服务端接线断言（host/令牌比较/上传净化/删除接口校验）');
} else {
  const src = fs.readFileSync(voiceToolPath('voice-gui.mjs'), 'utf8');
  ok(/server\.listen\(PORT, HOST/.test(src), '只监听指定 host');
  ok(/const HOST = '127\.0\.0\.1'/.test(src), 'HOST 固定为 127.0.0.1（不暴露到局域网）');
  ok(/timingSafeEqual/.test(src), '令牌比较用 timingSafeEqual');
  ok(/safeJoinLibrary/.test(src) && /sanitizeUploadName/.test(src), '上传/读取都过安全解析');
  ok(/const ALLOW_DELETE = !hasFlag\('no-delete'\)/.test(src), '删除默认开启（--no-delete 才锁）');
  // 删除接口必须过路径校验，否则就是任意文件删除漏洞
  const delAt = src.indexOf("p === '/api/delete'");
  const delSection = delAt >= 0 ? src.slice(delAt, delAt + 900) : '';
  ok(delAt >= 0, '有删除接口');
  ok(/safeJoinLibrary/.test(delSection), '删除接口做路径穿越校验');
  ok(/unlinkSync/.test(delSection), '删除走 unlinkSync');
  ok(/crypto\.randomBytes/.test(src), '每次启动生成随机令牌');
}

console.log('## 独立命令行的删除能力');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-cli.mjs 的删除能力断言（cmdRemove 的穿越校验/--yes/非 TTY 不卡死）');
} else {
  const cli = fs.readFileSync(voiceToolPath('voice-cli.mjs'), 'utf8');
  ok(/async function cmdRemove/.test(cli), '有 cmdRemove');
  ok(/remove.*rm.*delete|cmd === 'remove'/.test(cli), '注册了 remove 命令');
  const fn = cli.slice(cli.indexOf('async function cmdRemove'), cli.indexOf('async function cmdCheck'));
  ok(/safeJoinLibrary/.test(fn), 'CLI 删除也做路径穿越校验');
  ok(/只删|只删除|不在语音库/.test(fn), '库外文件被明确拒绝');
  ok(/--yes|opts\.yes/.test(fn), '支持 --yes 跳过确认');
  // 交互确认：非 TTY 时不能卡死
  ok(/isTTY/.test(cli), '非交互终端下不会卡在确认提示');
}

console.log('## 共享库符号完整性（防"用了但没 import"）');
{
  // 由来：send-voice.mjs 曾经调用 formatDuration 却没 import（重构成 shim 后暴露），
  // 只有真的走 dry-run 才会炸。这里静态检查所有入口文件：凡是用了 voice-core 提供的
  // 符号，就必须在 import 列表里（或在本文件内有定义）。
  const core = await import('../src/voice-core.js');
  const symbols = Object.keys(core).filter((k) => typeof core[k] === 'function' || /^[A-Z_]+$/.test(k));
  // 入口清单：桥接侧用 ROOT 相对路径，独立工具侧用 voice-tool 相对路径（base 决定去哪找）。
  const entrypoints = [
    { file: path.join(ROOT, 'scripts/send-voice.mjs') },
    { file: voiceToolPath('voice-cli.mjs') },
    { file: voiceToolPath('voice-gui.mjs') },
    { file: path.join(ROOT, 'src/bridge.js') }
  ];
  for (const { file: entryFile } of entrypoints) {
    const rel = path.relative(ROOT, entryFile).replace(/\\/g, '/');
    if (!fs.existsSync(entryFile)) continue;
    const src = fs.readFileSync(entryFile, 'utf8');
    // 独立工具经 ../qq-bridge/src/ 引用共享库，桥接侧经 ./ 或 ../src/，两种都要认
    const importedBlock = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*(?:send-voice-lib|voice-core)\.js'/g)]
      .map((m) => m[1]).join(',');
    const missing = symbols.filter((sym) => {
      const used = new RegExp(`(?<![\\w.$])${sym}\\s*[(,)\\[]`).test(src);
      if (!used) return false;
      if (new RegExp(`(?<![\\w$])${sym}(?![\\w$])`).test(importedBlock)) return false;
      // 本文件自己定义的也算（例如 bridge.js 里的同名内部实现不该存在，但保留容错）
      if (new RegExp(`(?:function|const|let|var)\\s+${sym}\\b`).test(src)) return false;
      return true;
    });
    ok(missing.length === 0, `${rel} 用到的共享符号都已 import`, missing.length ? `缺：${missing.join(', ')}` : '');
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：起真服务验证鉴权与 dry-run');
  if (!hasVoiceTool()) {
    // 起真服务需要工具入口文件本身；没有它就无从谈起（不是被测代码失败）。
    skipVoiceTool('live 段要真的 spawn voice-tool/voice-gui.mjs 起一个随机端口服务，而工具目录不在本仓库里');
  } else {
  const port = 3300 + Math.floor(Math.random() * 200);
  let child;
  let spawnError = null;
  try {
    child = spawn(process.execPath, [voiceToolPath('voice-gui.mjs'), '--no-open', '--port', String(port)], {
      cwd: voiceToolDir(), stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('error', (e) => { spawnError = e; });
  } catch (error) {
    spawnError = error;
  }
  if (spawnError || !child) {
    // 受限沙箱（DSH workspace-write / 只读）下 stdio:pipe 的 spawn 会被拒（EPERM）。
    // 这不是被测代码的问题，跳过 live 段而不是让整个套件崩掉。
    console.log(`  ⏭  跳过：本环境不允许 spawn 捕获输出的子进程（${spawnError?.code ?? spawnError?.message ?? '未知'}）`);
    console.log('     在普通终端里重跑即可验证 live 段。');
  } else {
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  const waitFor = async (pred, ms = 12000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
  try {
    const up = await waitFor(() => /界面地址/.test(output));
    ok(up, '服务启动并打印界面地址');
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(output)?.[1] ?? '';
    ok(token.length > 10, '拿到一次性令牌');

    const noAuth = await fetch(`http://127.0.0.1:${port}/api/library`).then((r) => r.status).catch(() => 0);
    ok(noAuth === 401, '无令牌访问接口 → 401');

    const boot = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { 'x-voice-token': token } })
      .then((r) => r.json()).catch((e) => ({ error: e.message }));
    ok(boot.ok === true, 'bootstrap 成功');
    ok(Array.isArray(boot.library?.items), `语音库返回 ${boot.library?.items?.length ?? 0} 个音频`);
    ok(Array.isArray(boot.targets?.groups) && Array.isArray(boot.targets?.friends),
      `目标返回 ${boot.targets?.groups?.length ?? 0} 群 / ${boot.targets?.friends?.length ?? 0} 好友`);

    const bad = await fetch(`http://127.0.0.1:${port}/api/send`, {
      method: 'POST',
      headers: { 'x-voice-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../../config.json', target: 'group:1', dryRun: true })
    }).then((r) => r.json());
    ok(bad.ok === false, '穿越路径被拒（不会读到库外文件）', bad.error ?? '');

    const first = boot.library?.items?.find((v) => v.ok !== false);
    const group = boot.targets?.groups?.[0];
    if (first && group) {
      const dry = await fetch(`http://127.0.0.1:${port}/api/send`, {
        method: 'POST',
        headers: { 'x-voice-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: first.name, target: group.key, dryRun: true })
      }).then((r) => r.json());
      ok(dry.ok === true && dry.dryRun === true, `dry-run 通过（${dry.detail ?? dry.error ?? ''}）`);
    } else {
      ok(false, 'dry-run 前置条件不足（缺语音或目标）');
    }
  } catch (e) {
    ok(false, `live 服务检查异常: ${e.message}`);
  } finally {
    try { child.kill(); } catch {}
  }
  }
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
