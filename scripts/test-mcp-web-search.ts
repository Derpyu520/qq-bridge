// 测试安全 Web Search / Fetch MCP server。
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.ts', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const search: any = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  console.log('✅ web_search:', (search.content?.[0] as any)?.text?.slice(0, 300));

  const fetch: any = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://mobile.moegirl.org.cn/DeepSeek%E5%A8%98' },
  });
  const text = (fetch.content?.[0] as any)?.text ?? '';
  console.log('✅ web_fetch:', text.slice(0, 500));
  console.log('isError:', fetch.isError ? '是' : '否');

  const bad: any = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  console.log('🚫 内网拦截:', bad.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', (bad.content?.[0] as any)?.text?.slice(0, 120));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
