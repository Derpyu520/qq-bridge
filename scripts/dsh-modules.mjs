// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  const err = new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
  // 给调用方一个可判定信号：这是"前提不满足"，不是"实现有 bug"。
  // 干净 clone / CI 上没装 DSH 时应当跳过相关断言，而不是整套变红。
  err.code = 'DSH_MODULES_NOT_FOUND';
  throw err;
}
