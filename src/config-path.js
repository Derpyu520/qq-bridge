// 配置文件位置解析（唯一入口）。
//
// 2026-11 起配置目录从仓库根迁到 config/：
//   config/config.json          ← 用户真实配置（.gitignore 排除）
//   config/config.example.json  ← 模板（入库）
// 旧布局（仓库根 config.json / config.example.json）继续兼容：没有任何新文件时
// 回退到旧路径，方便老部署直接升级，不会因为“文件搬家”启动失败。
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR_NAME = 'config';
export const CONFIG_FILE_NAME = 'config.json';
export const EXAMPLE_FILE_NAME = 'config.example.json';

/**
 * 解析当前生效的配置文件路径。
 *
 * 优先级：config/config.json（新）→ config.json（旧）。两者都不存在时返回新路径，
 * 让调用方在报错里提示把模板复制过去；写回路径也因此稳定落在 config/。
 * @param {string} root - 仓库根目录。
 * @returns {string}
 */
export function resolveConfigPath(root) {
  const preferred = path.join(root, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, CONFIG_FILE_NAME);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * 解析配置模板路径：config/config.example.json（新）→ config.example.json（旧）。
 * @param {string} root - 仓库根目录。
 * @returns {string}
 */
export function resolveConfigExamplePath(root) {
  const preferred = path.join(root, CONFIG_DIR_NAME, EXAMPLE_FILE_NAME);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, EXAMPLE_FILE_NAME);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}
