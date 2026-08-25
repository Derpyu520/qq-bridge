// 测试安全版 QQ MCP server：工具清单 + 白名单发送校验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
function currentMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8')).mode;
  } catch {
    return 'chat';
  }
}
const MODE = currentMode();
const RESERVED2 = MODE === 'reserved2';

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ 安全 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const status = await client.callTool({ name: 'qq_status', arguments: {} });
  console.log('✅ qq_status:', status.content?.[0]?.text?.slice(0, 150));

  const groups = await client.callTool({ name: 'qq_list_groups', arguments: {} });
  console.log('✅ qq_list_groups:', groups.content?.[0]?.text?.slice(0, 200));

  const history = await client.callTool({ name: 'qq_get_group_history', arguments: { groupId: 123456789 } });
  const histText = history.content?.[0]?.text ?? '';
  if (RESERVED2) {
    console.log('🚫 reserved2 下旧只读工具不可用:', history.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', histText.slice(0, 120));
  } else {
    console.log('✅ qq_get_group_history 含 message_id:', /message_id/.test(histText) ? '是 ✓' : '否 ✗');
  }

  // 白名单外发送：应被拒绝（isError）
  const denied = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 987654321, message: '测试' } });
  console.log('🚫 白名单外发送结果:', denied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', denied.content?.[0]?.text?.slice(0, 120));

  // 新能力：发送工具应暴露可选 replyToMessageId
  const tools2 = await client.listTools();
  const sendTool = tools2.tools.find((t) => t.name === 'qq_send_group_message');
  const schemaText = JSON.stringify(sendTool?.inputSchema ?? {});
  console.log('✅ replyToMessageId 参数:', schemaText.includes('replyToMessageId') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_reply 工具:', tools2.tools.some((t) => t.name === 'qq_reply') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_slang_query 工具:', tools2.tools.some((t) => t.name === 'qq_slang_query') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_slang_submit 工具:', tools2.tools.some((t) => t.name === 'qq_slang_submit') ? '存在 ✓' : '缺失 ✗');

  // 白名单内但 replyToMessageId 非法：应在发送前被参数校验拒绝（不会真实发消息）
  const invalidReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 'abc' }
  });
  console.log('🚫 非法引用 id(abc) 结果:', invalidReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', invalidReply.content?.[0]?.text?.slice(0, 120));

  const zeroReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 0 }
  });
  console.log('🚫 非法引用 id(0) 结果:', zeroReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', zeroReply.content?.[0]?.text?.slice(0, 120));

  // 真实 QQ 消息 id 可能是负数；负数应通过参数校验（这里用白名单外群，应被白名单拦截而非参数拦截）
  const negativeReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 987654321, message: '测试', replyToMessageId: -123456789 }
  });
  const negText = negativeReply.content?.[0]?.text ?? '';
  console.log('🚫 负 id + 白名单外 结果:', negativeReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', negText.slice(0, 120), '| 校验阶段:', negText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  // 专用引用工具 qq_reply：白名单外 + 负 id 应被白名单拦截（参数已通过）
  const replyDenied = await client.callTool({
    name: 'qq_reply',
    arguments: { groupId: 987654321, replyToMessageId: -123456789, message: '测试' }
  });
  const replyText = replyDenied.content?.[0]?.text ?? '';
  console.log('🚫 qq_reply 白名单外 结果:', replyDenied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', replyText.slice(0, 120), '| 校验阶段:', replyText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
