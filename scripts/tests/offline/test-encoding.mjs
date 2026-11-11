// 启动器与编码自检：
//   1) 所有 .cmd 必须是**纯 ASCII**（cmd.exe 用本地 ANSI 代码页解码批处理，
//      任何 UTF-8 中文都会变成乱码）+ **CRLF** 换行（LF 会让 `if (` 块解析出错）
//   2) 面向用户的中文一律由 node 在运行时打印，而 node 侧要显式把 stdout 设成 UTF-8
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from '../../lib/voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 这批 .cmd 里有三个不在本仓库里（两个在仓库上一级、一个在上一级 voice-tool/），
// 全新 clone 上它们本就不存在 —— 那时应"跳过"而不是判失败；仓内的 .cmd 缺了才是真失败。
const OUTSIDE_REPO_LAUNCHERS = new Set(['发语音-图形界面.cmd', '重启DSH-加载语音工具.cmd']);
const launcherKind = (f) => {
  const abs = path.resolve(f);
  const inRepo = abs === ROOT || abs.startsWith(ROOT + path.sep);
  if (inRepo) return 'repo';
  return OUTSIDE_REPO_LAUNCHERS.has(path.basename(abs)) ? 'parent' : 'tool';
};

const launchers = [
  path.join(ROOT, '..', '发语音-图形界面.cmd'),
  path.join(ROOT, '..', '重启DSH-加载语音工具.cmd'),
  voiceToolPath('发语音.cmd'),
];

console.log('## 启动器文件编码（乱码根因）');
for (const f of launchers) {
  const label = path.basename(f);
  if (!fs.existsSync(f)) {
    const kind = launcherKind(f);
    if (kind === 'parent') skipVoiceTool(`上级启动器 ${label}（和 voice-tool/ 并排，不在本仓库里）`);
    else if (kind === 'tool') skipVoiceTool(`voice-tool/${label}（独立发语音工具不在本仓库里）`);
    else ok(false, `${label} 存在`);
    continue;
  }
  const buf = fs.readFileSync(f);
  const nonAscii = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) nonAscii.push(i);
  ok(nonAscii.length === 0, `${label} 纯 ASCII`, nonAscii.length ? `${nonAscii.length} 个非 ASCII 字节（cmd 会按 GBK 解码 → 乱码）` : '');
  const text = buf.toString('latin1');
  ok(!/(?<!\r)\n/.test(text), `${label} 使用 CRLF 换行`, /(?<!\r)\n/.test(text) ? '存在裸 LF（多行 if 块可能解析失败）' : '');
  ok(!buf.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${label} 无 UTF-8 BOM`, '');
}

console.log('## Node 侧 UTF-8 输出');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-gui.mjs / voice-cli.mjs 的 chcp 65001 与中文文案断言（两个入口都在仓库上一级的 voice-tool/ 里）');
} else {
  // 界面服务：中文提示由 node 打印。Windows 控制台按本地代码页（936/GBK）解码，
  // 而 Node 写 UTF-8 —— 必须显式把控制台切到 UTF-8，否则启动横幅就是乱码。
  const gui = fs.readFileSync(voiceToolPath('voice-gui.mjs'), 'utf8');
  ok(/chcp/.test(gui) && /65001/.test(gui), 'voice-gui.mjs 把控制台切到 UTF-8（chcp 65001）');
  ok(/process\.stdout\.isTTY/.test(gui), 'voice-gui.mjs 只在真控制台时切编码（不干扰管道）');
  const cli = fs.readFileSync(voiceToolPath('voice-cli.mjs'), 'utf8');
  ok(/chcp/.test(cli) && /65001/.test(cli), 'voice-cli.mjs 把控制台切到 UTF-8（chcp 65001）');
  ok(/process\.stdout\.isTTY/.test(cli), 'voice-cli.mjs 只在真控制台时切编码（不干扰管道）');
  // 中文文案仍然齐全（没被"改成 ASCII"误伤到产品文案）
  ok(/语音发送工具/.test(gui), 'voice-gui.mjs 中文文案保留');
  ok(/语音发送工具/.test(cli), 'voice-cli.mjs 中文文案保留');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
