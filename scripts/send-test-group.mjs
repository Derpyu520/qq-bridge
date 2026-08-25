// 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。
// 用法：node scripts/send-test-group.mjs <群名关键词> [消息内容]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

const keyword = process.argv[2] ?? '机器人测试';
const message = process.argv[3] ?? '【桥接测试】我是 DSH agent，通过 SnowLuma 桥接接入本群。收到请回复～';

const bot = new SnowLumaWebSocketClient({ url: wsUrl, accessToken: accessToken || undefined, reconnect: false });
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));

try {
  await Promise.race([bot.connect(), timeout]);
  console.log('✅ 已连接网关');

  const groups = await bot.raw('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  console.log(`共 ${list.length} 个群：`, list.map((g) => `${g.group_id}(${g.group_name})`).join('、'));

  const target = list.find((g) => String(g.group_name ?? '').includes(keyword));
  if (!target) {
    console.error(`❌ 未找到名称包含「${keyword}」的群`);
    process.exit(1);
  }

  const result = await bot.sendGroupMessage(target.group_id, text(message));
  console.log(`✅ 已发送到群 ${target.group_id}（${target.group_name}）: ${message}`);
  console.log('  响应:', JSON.stringify(result));
} catch (error) {
  console.error('❌ 发送失败:', error?.message ?? error);
  process.exit(1);
} finally {
  try { bot.close(); } catch {}
}
