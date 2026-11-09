// 验证「Windows 控制台乱码 + chcp 修复」的机制是否成立。
//
// Node 写 stdout 用的是 UTF-8 字节；控制台按自己的**输出代码页**解码这些字节。
// 中文系统默认 936(GBK)：UTF-8 的「语音」被当 GBK 解码 → 乱码。
// 本脚本用字节级往返证明这一点，并证明 chcp 65001 能把它救回来。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from '../../lib/voice-tool-locator.mjs';

// 这条回归验证 Windows 控制台（chcp / GBK 解码）；非 Windows 没有可测对象。
if (process.platform !== 'win32') {
  console.log('\u23ed  跳过：仅 Windows 可测（chcp / 代码页）');
  process.exit(0);
}


const sample = '语音发送工具 简体中文 ✅';
const utf8 = Buffer.from(sample, 'utf8');

const decode = (buf, cp) => {
  // 控制台解码等价于：把字节按该代码页解释。Node 侧用 TextDecoder 模拟。
  const label = cp === 936 ? 'gbk' : 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return '(本机 Node 不支持该解码器)';
  }
};

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 乱码机制（字节级）');
{
  const asGbk = decode(utf8, 936);
  ok(asGbk !== sample, 'UTF-8 字节按 GBK 解码 ≠ 原文（这就是乱码的来源）');
  ok(decode(utf8, 65001) === sample, 'UTF-8 字节按 UTF-8 解码 = 原文（chcp 65001 后正确）');
  console.log(`     原文 : ${sample}`);
  console.log(`     乱码 : ${asGbk.replace(/\uFFFD/g, '?')}   ← 你在 GBK 控制台看到的就是这种`);
}

console.log('## chcp 可用性');
{
  const r = spawnSync('chcp', ['65001'], { encoding: 'latin1', windowsHide: true });
  if (r.error?.code === 'EPERM' || r.error?.code === 'EACCES') {
    // 受限沙箱（DSH workspace-write / 只读）不允许 spawn 捕获输出的子进程。
    // 这是环境限制，不是被测代码的问题 —— 跳过而不是判失败。
    console.log(`  ⏭  跳过：本环境不允许 spawn 子进程（${r.error.code}）；在普通终端里重跑即可验证`);
  } else {
    ok(!r.error, 'chcp 命令可执行', r.error ? r.error.message : '');
    const before = spawnSync('chcp', [], { encoding: 'latin1', windowsHide: true });
    const cpText = String(before.stdout ?? '');
    ok(/\d{3,5}/.test(cpText), 'chcp 能读出当前代码页', (cpText.match(/\d{3,5}/) ?? ['?'])[0]);
  }
}

console.log('## 工具里确实调了 chcp 且只在真控制台时调');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-gui.mjs / voice-cli.mjs 的 chcp 65001 断言（两个入口都在仓库上一级的 voice-tool/ 里）');
} else {
  for (const rel of ['voice-gui.mjs', 'voice-cli.mjs']) {
    const src = fs.readFileSync(voiceToolPath(rel), 'utf8');
    ok(/spawn\('chcp', \['65001'\]/.test(src), `${rel} 调用 chcp 65001`);
    ok(/isTTY/.test(src), `${rel} 用 isTTY 守卫（不干扰管道/重定向）`);
    ok(/platform !== 'win32'|platform === 'win32'/.test(src), `${rel} 限定 Windows`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
