// scripts 索引一致性：scripts/README.md 必须与 gen-scripts-index 的生成结果一致。
// 新增/删除/重命名脚本后忘了刷新索引时，这里会红，避免 README 慢慢变成过期文档。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const generator = fileURLToPath(new URL('../../setup/gen-scripts-index.mjs', import.meta.url));
const result = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  console.error('修复：node scripts/setup/gen-scripts-index.mjs');
  process.exit(1);
}
console.log('✅ scripts/README.md 索引最新');
