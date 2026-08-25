// 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关，
// 验证地址、端口、accessToken 是否正确。成功即打印 ✅ 并退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

console.log(`测试连接 ${wsUrl}（token ${accessToken ? '已配置' : '未配置'}）…`);

const bot = new SnowLumaWebSocketClient({
  url: wsUrl,
  accessToken: accessToken || undefined,
  reconnect: false
});

const result = await Promise.race([
  new Promise((resolve) => {
    bot.on('open', () => {
      console.log('✅ WebSocket 已连接（网关接受连接，token 正确）');
      resolve(true);
    });
    bot.on('event', (event) => {
      if (event.post_type === 'meta_event') {
        console.log('✅ 收到 meta 事件:', event.meta_event_type, JSON.stringify(event).slice(0, 160));
      } else {
        console.log('📨 收到事件:', event.post_type, event.message_type ?? '', JSON.stringify(event).slice(0, 160));
      }
    });
    bot.on('close', (info) => {
      if (info?.code === 4001 || info?.code === 401) {
        console.error('❌ 网关拒绝连接：鉴权失败（token 不对或未填）', info);
      } else {
        console.error('❌ 连接被关闭:', info);
      }
      resolve(false);
    });
  }),
  bot.connect().catch((error) => {
    console.error('❌ 连接异常:', error?.message ?? error);
    return false;
  }),
  new Promise((resolve) => setTimeout(() => {
    console.error('❌ 超时（10s）：地址/端口不对或网关未启动？');
    resolve(false);
  }, 10_000))
]);

try { bot.close(); } catch {}
process.exit(result ? 0 : 1);
