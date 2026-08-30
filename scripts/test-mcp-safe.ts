// 测试安全版 QQ MCP server：工具清单 + 白名单发送校验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
function currentMode(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8')).mode;
  } catch {
    return 'chat';
  }
}
const MODE = currentMode();
const RESERVED2 = MODE === 'reserved2';

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.ts', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ 安全 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const status: any = await client.callTool({ name: 'qq_status', arguments: {} });
  console.log('✅ qq_status:', (status.content?.[0] as any)?.text?.slice(0, 150));

  const groups: any = await client.callTool({ name: 'qq_list_groups', arguments: {} });
  console.log('✅ qq_list_groups:', (groups.content?.[0] as any)?.text?.slice(0, 200));

  const history: any = await client.callTool({ name: 'qq_get_group_history', arguments: { groupId: 123456789 } });
  const histText = (history.content?.[0] as any)?.text ?? '';
  if (RESERVED2) {
    console.log('🚫 reserved2 下旧只读工具不可用:', history.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', histText.slice(0, 120));
  } else {
    console.log('✅ qq_get_group_history 含 message_id:', /message_id/.test(histText) ? '是 ✓' : '否 ✗');
  }

  const denied: any = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 987654321, message: '测试' } });
  console.log('🚫 白名单外发送结果:', denied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', (denied.content?.[0] as any)?.text?.slice(0, 120));

  const tools2 = await client.listTools();
  const sendTool = tools2.tools.find((t) => t.name === 'qq_send_group_message');
  const schemaText = JSON.stringify(sendTool?.inputSchema ?? {});
  console.log('✅ replyToMessageId 参数:', schemaText.includes('replyToMessageId') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_reply 工具:', tools2.tools.some((t) => t.name === 'qq_reply') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_slang_query 工具:', tools2.tools.some((t) => t.name === 'qq_slang_query') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ qq_slang_submit 工具:', tools2.tools.some((t) => t.name === 'qq_slang_submit') ? '存在 ✓' : '缺失 ✗');

  const invalidReply: any = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 123456789, message: '测试', replyToMessageId: 'abc' } });
  console.log('🚫 非法引用 id(abc) 结果:', invalidReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', (invalidReply.content?.[0] as any)?.text?.slice(0, 120));

  const zeroReply: any = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 123456789, message: '测试', replyToMessageId: 0 } });
  console.log('🚫 非法引用 id(0) 结果:', zeroReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', (zeroReply.content?.[0] as any)?.text?.slice(0, 120));

  const negativeReply: any = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 987654321, message: '测试', replyToMessageId: -123456789 } });
  const negText = (negativeReply.content?.[0] as any)?.text ?? '';
  console.log('🚫 负 id + 白名单外 结果:', negativeReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', negText.slice(0, 120), '| 校验阶段:', negText.includes('白名单') ? '白名单（参数已通过）' : RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数');

  const replyDenied: any = await client.callTool({ name: 'qq_reply', arguments: { groupId: 987654321, replyToMessageId: -123456789, message: '测试' } });
  const replyText = (replyDenied.content?.[0] as any)?.text ?? '';
  console.log('🚫 qq_reply 白名单外 结果:', replyDenied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', replyText.slice(0, 120), '| 校验阶段:', replyText.includes('白名单') ? '白名单（参数已通过）' : RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数');

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
