// 管理员动作回归入口：纯逻辑（src/admin-ops.test.mjs）+ 接口级（scripts/test-admin-ops-api.mjs）。
// 两个文件分开是因为接口级要用虚拟桥接（较慢），纯逻辑不需要。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  path.join(root, 'src', 'bot-perms.test.mjs'),
  path.join(root, 'src', 'admin-ops.test.mjs'),
  // QQ 资料/头像/空间说说的字段白名单、HTML 清洗、可见范围与图片参数（纯逻辑）。
  path.join(root, 'src', 'qq-social-profile.test.mjs'),
  path.join(root, 'src', 'person-score.test.mjs'),
  path.join(root, 'src', 'proactive-score.test.mjs'),
  path.join(root, 'scripts', 'test-admin-ops-api.mjs')
];
let failed = 0;
for (const file of files) {
  console.log(`\n— ${path.relative(root, file)}`);
  const result = spawnSync(process.execPath, ['--test', file], {
    cwd: root, stdio: 'inherit', timeout: 120000, env: process.env
  });
  if (result.error) {
    console.error(`启动失败：${result.error.message}`);
    failed++;
  } else if (result.status !== 0) {
    failed++;
  }
}
process.exitCode = failed ? 1 : 0;
