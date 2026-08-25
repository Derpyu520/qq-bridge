// 查询 SnowLuma 网关与 QQ 会话状态：get_login_info / get_status / get_version_info
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

const bot = new SnowLumaWebSocketClient({ url: wsUrl, accessToken: accessToken || undefined, reconnect: false });

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));

try {
  await Promise.race([bot.connect(), timeout]);
  console.log('✅ 已连接网关');
  const login = await bot.getLoginInfo();
  console.log('✅ get_login_info:', JSON.stringify(login));
  try {
    const status = await bot.getStatus();
    console.log('✅ get_status:', JSON.stringify(status));
  } catch (error) {
    console.log('⚠️  get_status 失败:', error?.message ?? error);
  }
} catch (error) {
  console.error('❌ 网关查询失败:', error?.message ?? error);
  process.exit(1);
} finally {
  try { bot.close(); } catch {}
}
