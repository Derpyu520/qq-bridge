// 「发语音」独立工具的位置解析 + 「它不在本仓库」时的统一跳过口径。
//
// 背景（这是一个真实踩过的坑）
// ----------------------------
// `voice-tool/`（`voice-cli.mjs` / `voice-gui.mjs` / `public/voice.html` / 启动器 .cmd）
// 是**仓库上一级**的独立工具，不在本仓库里。但仓库里有一批测试脚本直接按
// `<repo>/../voice-tool/...` 去读文件：
//
//   const f = new URL('../../voice-tool/voice-gui.mjs', import.meta.url)
//   fs.readFileSync(f)          // ← 全新 clone 上这里直接 ENOENT 崩溃
//
// 在作者机器上它一直是绿的（上一级确实有那个目录），于是**没人发现**：
// 任何照 README 克隆仓库的人跑 `npm run test:audit`，都会看到 6 个脚本红着崩溃，
// 看起来像"这个项目装出来就是坏的"。
//
// 本模块提供两件事：
//   1. {@link voiceToolDir} —— 统一的位置解析，支持用 `QQ_BRIDGE_VOICE_TOOL_DIR`
//      覆盖（工具放在别处、或想在 CI 里显式模拟"没有这个目录"时用）。
//   2. {@link skipVoiceTool} —— 「不在本仓库」时的统一输出，**明确说这是跳过而不是通过**，
//      并给出怎么真正跑这些断言。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本仓库根目录。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 独立发语音工具所在目录。
 *
 * 解析顺序：`QQ_BRIDGE_VOICE_TOOL_DIR` → `<仓库上一级>/voice-tool`。
 * 不保证存在——调用方应当先问 {@link hasVoiceTool}。
 */
export function voiceToolDir() {
  const override = process.env.QQ_BRIDGE_VOICE_TOOL_DIR;
  if (override) return path.resolve(override);
  return path.resolve(REPO_ROOT, '..', 'voice-tool');
}

/** 该目录是否存在且看起来像那个工具（有 voice-cli.mjs 或 voice-gui.mjs）。 */
export function hasVoiceTool() {
  const dir = voiceToolDir();
  return fs.existsSync(path.join(dir, 'voice-cli.mjs'))
    || fs.existsSync(path.join(dir, 'voice-gui.mjs'));
}

/** 取工具目录下的一个路径（不检查存在性；调用方自己判断）。 */
export function voiceToolPath(...segments) {
  return path.join(voiceToolDir(), ...segments);
}

/**
 * 打印统一的「已跳过」说明。
 *
 * ⚠️ 措辞刻意区分「跳过」与「通过」：这些断言在**这台机器上确实没有被覆盖**，
 * 不能让输出看起来像全绿。
 *
 * @param what - 被跳过的检查是什么（如「voice-tool 的三个入口文件」）。
 * @returns 恒为 false，方便写成 `if (!hasVoiceTool()) return skipVoiceTool(...)`。
 */
export function skipVoiceTool(what) {
  console.log(`  ⏭  跳过：${what}`);
  console.log(`     原因：独立发语音工具不在本仓库里（它是仓库上一级的 ../voice-tool/），当前解析到 ${voiceToolDir()}`);
  console.log('     想跑这些断言：把仓库与 voice-tool/ 放在同一级目录下，或设 QQ_BRIDGE_VOICE_TOOL_DIR=<voice-tool 目录>。');
  console.log('     注意：这是**跳过，不是通过** —— 这台机器上没有覆盖到这部分。');
  return false;
}
