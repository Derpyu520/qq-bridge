#!/usr/bin/env node
// 首次安装/启动前自动生成 work/config.json（由 npm postinstall / prestart 调用）。
//
// 行为：
//   · work/config.json 已存在 → 什么都不做；
//   · 不存在 → 从 data/config.example.json 复制一份，并按本地配置权限命名。
//
// 这样新 clone / CI 安装完就有可启动的配置骨架，不会因为“忘了 cp”而起不来；
// 本地已有配置（含真实 token / QQ 号）永远不会被覆盖（work/.gitignore 已排除）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ROOT, 'work', 'config.json');
const template = path.join(ROOT, 'data', 'config.example.json');

if (fs.existsSync(target)) {
  console.log('[ensure-config] work/config.json 已存在，跳过');
  process.exit(0);
}
if (!fs.existsSync(template)) {
  console.error(`[ensure-config] 模板缺失：${path.relative(ROOT, template)}；请检查仓库是否完整`);
  process.exit(0); // 不阻断安装，桥接启动时会给出同样的提示
}
try {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(template, target);
  fs.chmodSync(target, 0o600);
  console.log('[ensure-config] 已从 data/config.example.json 生成 work/config.json（请填入本机配置）');
} catch (error) {
  console.error(`[ensure-config] 生成 work/config.json 失败：${error?.message ?? error}`);
  process.exit(1);
}
