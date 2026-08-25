// 测试桥接自带的 snowluma-host MCP server（status/start/stop）
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-host-server.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ snowluma-host MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));
  const status = await client.callTool({ name: 'snowluma_status', arguments: {} });
  const text = status.content?.[0]?.text ?? JSON.stringify(status);
  console.log('✅ snowluma_status:', text);
  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
