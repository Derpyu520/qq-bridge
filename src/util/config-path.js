// 配置文件位置解析（唯一入口）。
//
// 配置位置：
//   work/config.json          ← 用户真实配置（work/.gitignore 排除；npm postinstall 自动生成）
//   data/config.example.json  ← 模板（入库）
// 旧布局（config/config.json、仓库根 config.json）继续兼容：按顺序回退，方便老部署升级。
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR_NAME = 'config';
export const CONFIG_FILE_NAME = 'config.json';
export const EXAMPLE_FILE_NAME = 'config.example.json';

/**
 * 解析当前生效的配置文件路径。
 *
 * 优先级：work/config.json（新）→ config/config.json（2026-11 前的布局）→
 * 仓库根 config.json（更早）。都不存在时返回新路径，让调用方在报错里提示把模板
 * 复制过去；写回路径也因此稳定落在 work/。
 * @param {string} root - 仓库根目录。
 * @returns {string}
 */
export function resolveConfigPath(root) {
  const candidates = [
    path.join(root, 'work', CONFIG_FILE_NAME),
    path.join(root, CONFIG_DIR_NAME, CONFIG_FILE_NAME), // 2026-11 前的 config/ 布局
    path.join(root, CONFIG_FILE_NAME)                   // 更早的仓库根布局
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}

/**
 * 解析配置模板路径：data/config.example.json（新）→ config.example.json（旧）。
 * @param {string} root - 仓库根目录。
 * @returns {string}
 */
export function resolveConfigExamplePath(root) {
  const candidates = [
    path.join(root, 'data', EXAMPLE_FILE_NAME),
    path.join(root, CONFIG_DIR_NAME, EXAMPLE_FILE_NAME), // 2026-11 之前的 config/ 布局
    path.join(root, EXAMPLE_FILE_NAME)                  // 更早的仓库根布局
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}
