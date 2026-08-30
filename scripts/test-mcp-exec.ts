// 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg: any = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const endpoint = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000/').replace(/\/?$/, '/');
const token = cfg.snowluma?.accessToken || '';

const mcpEntry = fileURLToPath(new URL('../node_modules/@snowluma/mcp/dist/server.js', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry],
  env: {
    SNOWLUMA_MCP_ENDPOINT: endpoint,
    SNOWLUMA_MCP_TOKEN: token,
    SNOWLUMA_MCP_MODE: 'write',
  },
});

const client = new Client({ name: 'bridge-test', version: '0.1.0' });
try {
  await client.connect(transport);
  console.log('✅ MCP 连接成功');

  const tools = await client.listTools();
  console.log(`✅ tools/list: ${tools.tools.length} 个工具`);
  const names = tools.tools.map((t) => t.name);
  console.log('   ', names.join(', '));
  const hasQuery = names.includes('query_action');
  const hasInvoke = names.includes('invoke_action');
  console.log(hasQuery ? '✅ query_action 可用' : '❌ 缺 query_action');
  console.log(hasInvoke ? '✅ invoke_action 可用（write 模式）' : '❌ 缺 invoke_action');

  if (hasQuery) {
    const result = await client.callTool({ name: 'query_action', arguments: { action: 'get_login_info' } });
    console.log('✅ query_action(get_login_info):', JSON.stringify(result).slice(0, 300));
  }
  process.exit(0);
} catch (error) {
  console.error('❌ MCP 测试失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
