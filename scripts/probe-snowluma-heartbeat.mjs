// 只读探针：连 SnowLuma 的 OneBot WebSocket，等一个 heartbeat，打印载荷里的
// `status.online` / `status.good`。
//
// 为什么需要它：桥接的「上游健康」主信号就是心跳里的 `status.good`（SnowLuma 对
// 「QQ → 原生 hook → 我」这条接收链路的自评）。这条信号是否存在、字段名对不对，
// 只能拿**真实运行时**验证 —— 代码里写错字段名是不会报错的（SDK 只校验信封）。
//
// 本探针：只连接、只读取、打印后立刻退出；**不发送任何消息、不创建任何会话**。
// 用法：node scripts/probe-snowluma-heartbeat.mjs [超时秒数]
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const timeoutMs = (Number(process.argv[2]) || 45) * 1000;

// 用项目自己的自发现拿「当前真正可用」的 token 与端点。
// 不能直接用 config.json 里的值：换过账号后它是旧的（连上去只会 1006 关闭），
// 桥接生产代码走的也是这条路（healTokenIfStale → discoverSnowLumaConnection）。
const disc = await discoverSnowLumaConnection({ cfg, timeoutMs: 5000 });
if (!disc.ok) {
  console.log(`❌ 无法发现可用的 SnowLuma 连接：${disc.error}`);
  process.exit(2);
}
console.log(`已发现端点 ${disc.wsUrl}（令牌${disc.wsToken || disc.token ? '已配置' : '未配置'}，来源 ${disc.source}）`);

const bot = new SnowLumaWebSocketClient({
  url: disc.wsUrl,
  accessToken: disc.wsToken || disc.token || undefined,
  reconnect: false,
});

const seen = new Map();
let done = false;
const finish = (why) => {
  if (done) return;
  done = true;
  console.log(`\n=== 结果（${why}）===`);
  console.log('收到的事件类型：');
  for (const [k, n] of [...seen].sort()) console.log(`  ${k} x${n}`);
  try { bot.close(); } catch {}
  process.exit(0);
};

bot.onEvent((event) => {
  const post = String(event?.post_type ?? '?');
  const sub = event?.meta_event_type ? `${post}/${event.meta_event_type}` : (event?.notice_type ? `${post}/${event.notice_type}` : post);
  seen.set(sub, (seen.get(sub) ?? 0) + 1);

  if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
    console.log('✅ 收到 heartbeat —— 心跳是**本地定时器**发的，与 QQ 是否有消息无关');
    console.log('   status =', JSON.stringify(event.status));
    console.log('   interval =', event.interval);
    console.log(`   → status.good = ${JSON.stringify(event.status?.good)}` +
      (typeof event.status?.good === 'boolean'
        ? '  ✅ 字段存在（桥接的上游健康主信号可用）'
        : '  ❌ 字段缺失/非布尔 —— 桥接的 good 会一直停在 null！'));
    console.log(`   → status.online = ${JSON.stringify(event.status?.online)}`);
    finish('拿到心跳');
  }
});

bot.on('error', (e) => console.log('  ws error:', e?.message ?? e));
bot.connect().then(() => console.log(`已连接 ${cfg.snowluma.wsUrl}（只读，不发消息），等心跳…`))
  .catch((e) => { console.log('连接失败:', e?.message ?? e); finish('连接失败'); });

setTimeout(() => finish('超时'), timeoutMs);
