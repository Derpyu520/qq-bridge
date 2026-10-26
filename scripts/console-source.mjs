// 控制台前端在 2026-10-26 被拆成三个文件：public/console.html（结构）、
// public/console.css（样式）、public/console.js（前端逻辑）。
//
// 拆之前几乎所有测试都直接读 console.html 然后对「整页文本」做包含判断，
// 拆完那些断言会变成假失败——不是功能坏了，是它们读错了文件。
// 这里给出一个统一口径：查契约就用 bundle（三个文件拼在一起，等价于拆分前的整页），
// 只想看 DOM 就用 parts.html，只想解析 JS 就用 parts.js。
import fs from 'node:fs';
import path from 'node:path';

/** @returns {{ html: string, css: string, js: string }} */
export function readConsoleParts(root) {
  const read = (name) => {
    try { return fs.readFileSync(path.join(root, 'public', name), 'utf8'); } catch { return ''; }
  };
  return { html: read('console.html'), css: read('console.css'), js: read('console.js') };
}

/** 拆分前的整页等价物：对 bundle 做 includes/regex 断言，行为与拆分前一致。 */
export function readConsoleBundle(root) {
  const { html, css, js } = readConsoleParts(root);
  return `${html}\n<style>\n${css}\n</style>\n<script>\n${js}\n</script>\n`;
}