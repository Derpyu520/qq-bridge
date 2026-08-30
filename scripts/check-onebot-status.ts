// 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg: any = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, httpUrl, accessToken } = cfg.snowluma;
const baseHttp = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');

console.log('配置:');
console.log(`  wsUrl   = ${wsUrl}`);
console.log(`  httpUrl = ${baseHttp}`);
console.log(`  token   = ${accessToken ? '已配置' : '未配置'}`);

try {
  const res = await fetch(`${baseHttp}/get_login_info`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 426) {
    console.error('\n❌ HTTP 426: httpUrl 指向了 WebSocket 端口。');
    console.error(`   当前 httpUrl = ${baseHttp}`);
    console.error('   请改为 OneBot HTTP API 端口（默认 http://127.0.0.1:3000），不要填 WebSocket 端口（默认 3001）。');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n❌ HTTP ${res.status}: 无法访问 ${baseHttp}/get_login_info`);
    console.error('   请确认 SnowLuma 已启动、HTTP API 已开启，且端口正确。');
    process.exit(1);
  }
  const body: any = await res.json();
  if (body?.status === 'ok' && body?.retcode === 0) {
    console.log('\n✅ OneBot HTTP API 正常');
    if (body.data?.user_id) console.log(`   当前 QQ: ${body.data.user_id} (${body.data.nickname || ''})`);
  } else {
    console.error(`\n❌ 网关返回异常: ${JSON.stringify(body)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\n❌ 无法连接 ${baseHttp}/get_login_info: ${error instanceof Error ? error.message : String(error)}`);
  console.error('   请确认 SnowLuma 已启动、HTTP API 端口正确。');
  process.exit(1);
}

console.log('\n--- WebSocket ---');
const bot = new SnowLumaWebSocketClient({ url: wsUrl, accessToken: accessToken || undefined, reconnect: false });
const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));
try {
  await Promise.race([bot.connect(), timeout]);
  console.log('✅ 已连接网关');
  const login: any = await bot.getLoginInfo();
  console.log('✅ get_login_info:', JSON.stringify(login));
  try {
    const status: any = await bot.getStatus();
    console.log('✅ get_status:', JSON.stringify(status));
  } catch (error) {
    console.log('⚠️  get_status 失败:', error instanceof Error ? error.message : String(error));
  }
} catch (error) {
  console.error('❌ WebSocket 连接失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  try {
    bot.close();
  } catch {}
}
