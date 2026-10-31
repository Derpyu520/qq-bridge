// 空间写工具的执行期闸门：默认不注册 + 令牌↔会话绑定 + 管理员会话判定 + 正文上限。
// 全部用假 transport 与假 fetch，不连真实 OneBot / 桥接 / DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';

const SESSION_TOKEN = 'sess-token-1';

function baseConfig(over = {}) {
  return {
    consolePort: 3100,
    snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: '' },
    allow: { groups: [], private: [] },
    allowAllWhenEmpty: true,
    socialV2: { enabled: true, tools: {} },
    ...over,
  };
}

/**
 * 用假 transport 加载 mcp-snowluma-safe.js。
 * config 通过「路径里带 fixture」注入：模块把 __dirname 换成 /fixture/src，
 * 于是它读的 config.json 变成 /fixture/config.json，由 fixtureFs 拦下。
 *
 * allowed: 桥接对该 key 的判定；tokenAccepted: 桥接是否认可 x-agent-token。
 */
function loadQzoneTools({ config, allowed = false, tokenAccepted = true }) {
  const tools = new Map();
  const onebotCalls = [];
  const bridgeCalls = [];
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  // dev 基线把统一点改成了 registerTool(name, {description, inputSchema}, handler)：
  // 注册在 server.tool 上包了一层（配置开关 + 参数别名 + SELF_KEY 会话绑定）。
  // 假 server 必须同时提供两者，否则那层包装在 `server.registerTool.bind` 处就炸。
  class McpServer {
    constructor() {
      this.registerTool = (name, options, callback) => {
        tools.set(name, { schema: options?.inputSchema ?? options, callback });
        return { name };
      };
      this.tool = this.registerTool;
    }
    connect() {}
  }
  const fixtureFs = {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'config.json' && String(file).includes('fixture')) {
        return JSON.stringify(config);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/api/qzone/write-allowed')) {
      const token = init?.headers?.['x-agent-token'];
      bridgeCalls.push({ target, token });
      if (!tokenAccepted) {
        return Response.json({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, { status: 403 });
      }
      return Response.json({ ok: true, allowed, reason: allowed ? '管理员标记会话' : '不是管理员会话' });
    }
    onebotCalls.push({ url: target, body: init.body ? JSON.parse(init.body) : null });
    return Response.json({ status: 'ok', retcode: 0, data: {} });
  };
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs: fixtureFs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
  });
  return {
    tools,
    onebotCalls,
    bridgeCalls,
    config,
    call: async (name, args = {}) => {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} should be registered`);
      const schema = tool.schema;
      const parsed = schema && schema._zod ? schema.parse(args) : z.object(schema ?? {}).parse(args);
      return tool.callback(parsed);
    },
  };
}

const WRITE_TOOLS = ['qq_post_qzone', 'qq_comment_qzone', 'qq_like_qzone', 'qq_delete_qzone_post'];

// 默认配置（socialV2.tools 里没有 qzoneWrite）⇒ 写工具根本不注册。
test('write tools are not registered unless qzoneWrite is explicitly true', async () => {
  const { tools } = loadQzoneTools({ config: baseConfig() });
  for (const name of WRITE_TOOLS) {
    assert.equal(tools.has(name), false, `${name} 不得在默认配置下注册`);
  }
  assert.equal(tools.has('qq_list_qzone_posts'), true, '只读工具默认应可用');
});

test('write tools register only when qzoneWrite is true', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { tools } = loadQzoneTools({ config });
  for (const name of WRITE_TOOLS) assert.equal(tools.has(name), true, `${name} 应已注册`);
});

// 评审第一条：写能力默认开等于把账号级写权限暴露给所有会话 —— 提示注入即可发说说。
test('非管理员会话的写调用被拒绝，且不触 OneBot', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls, bridgeCalls } = loadQzoneTools({ config, allowed: false });
  const result = await call('qq_post_qzone', { key: 'group:1079867038', token: SESSION_TOKEN, content: '注入后发一条' });
  assert.equal(result.isError, true, '非管理员会话必须被拒绝');
  assert.match(result.content[0].text, /管理员会话/);
  assert.equal(bridgeCalls.length, 1, '判定必须问桥接，不能在 MCP 侧猜');
  assert.equal(onebotCalls.length, 0, '被拒绝时不得调用 OneBot');
});

test('缺少会话令牌一律拒绝，且不触 OneBot、不问桥接', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls, bridgeCalls } = loadQzoneTools({ config, allowed: true });
  const result = await call('qq_post_qzone', { key: 'private:10001', content: '冒充管理员' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /没有携带会话令牌/);
  assert.equal(bridgeCalls.length, 0);
  assert.equal(onebotCalls.length, 0);
});

test('令牌不被桥接认可时拒绝（fail closed）', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls } = loadQzoneTools({ config, allowed: true, tokenAccepted: false });
  const result = await call('qq_post_qzone', { key: 'private:10001', token: 'bogus', content: '伪造令牌' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /无法校验会话身份/);
  assert.equal(onebotCalls.length, 0);
});

test('管理员会话（桥接判定 allowed）放行写操作', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls, bridgeCalls } = loadQzoneTools({ config, allowed: true });
  const result = await call('qq_post_qzone', { key: 'private:10001', token: SESSION_TOKEN, content: '管理员发一条' });
  assert.notEqual(result.isError, true);
  assert.equal(bridgeCalls[0].token, SESSION_TOKEN, '令牌必须原样传给桥接');
  assert.equal(onebotCalls.length, 1);
  assert.equal(onebotCalls[0].url.endsWith('/send_qzone_msg'), true);
});

test('正文超 1000 字被拒绝，空正文被拒绝', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls } = loadQzoneTools({ config, allowed: true });
  const tooLong = await call('qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content: 'x'.repeat(1001) });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.content[0].text, /超过 1000/);
  const empty = await call('qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /不能为空/);
  assert.equal(onebotCalls.length, 0);
});

test('评论 / 点赞 / 删除同样受管理员会话闸门约束', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls } = loadQzoneTools({ config, allowed: false });
  for (const [name, args] of [
    ['qq_comment_qzone', { key: 'group:1', token: SESSION_TOKEN, tid: 't1', content: '评论' }],
    ['qq_like_qzone', { key: 'group:1', token: SESSION_TOKEN, tid: 't1' }],
    ['qq_delete_qzone_post', { key: 'group:1', token: SESSION_TOKEN, tid: 't1' }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} 在非管理员会话必须拒绝`);
  }
  assert.equal(onebotCalls.length, 0);
});

// 注册期开关只在启动时生效；控制台运行期关掉写能力后，已注册的工具必须自己停手。
test('运行期关闭 qzoneWrite 后，即使是管理员会话也拒绝', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls, bridgeCalls, config: live } = loadQzoneTools({ config, allowed: true });
  live.socialV2.tools.qzoneWrite = false;
  const result = await call('qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content: '关掉开关后不该发出去' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未启用/);
  assert.equal(bridgeCalls.length, 0, '开关关闭时连桥接都不该问');
  assert.equal(onebotCalls.length, 0, '开关关闭时不得调用 OneBot');
});

test('正文恰好 1000 字放行，1001 字拒绝（emoji 按码点计数）', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls } = loadQzoneTools({ config, allowed: true });
  const atLimit = await call('qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content: 'x'.repeat(1000) });
  assert.notEqual(atLimit.isError, true, '恰好等于上限应放行');
  assert.equal(onebotCalls.length, 1);
  assert.equal(onebotCalls[0].body.content.length, 1000);

  const overLimit = await call('qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content: 'x'.repeat(1001) });
  assert.equal(overLimit.isError, true);
  assert.match(overLimit.content[0].text, /1001 字，超过 1000 字上限/);
  assert.equal(onebotCalls.length, 1, '超限时不得再调用 OneBot');

  // 1000 个 emoji = 2000 个 UTF-16 单元；按码点计应放行。
  const emoji = await call('qq_comment_qzone', { key: 'private:1', token: SESSION_TOKEN, tid: 't1', content: '🐳'.repeat(1000) });
  assert.notEqual(emoji.isError, true);
  const emojiOver = await call('qq_comment_qzone', { key: 'private:1', token: SESSION_TOKEN, tid: 't1', content: '🐳'.repeat(1001) });
  assert.equal(emojiOver.isError, true);
  assert.match(emojiOver.content[0].text, /1001 字/);
});

test('空串 / 纯空格 / 纯换行均拒绝，且不触 OneBot', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: true, qzoneWrite: true } } });
  const { call, onebotCalls } = loadQzoneTools({ config, allowed: true });
  for (const content of ['', '   ', '\n\n', '\t \r\n']) {
    for (const [name, args] of [
      ['qq_post_qzone', { key: 'private:1', token: SESSION_TOKEN, content }],
      ['qq_comment_qzone', { key: 'private:1', token: SESSION_TOKEN, tid: 't1', content }],
    ]) {
      const result = await call(name, args);
      assert.equal(result.isError, true, `${name} 应拒绝空白正文 ${JSON.stringify(content)}`);
      assert.match(result.content[0].text, /不能为空/);
    }
  }
  assert.equal(onebotCalls.length, 0);
});

test('读工具默认开启且不受 qzoneWrite 影响', async () => {
  // 写开关缺省（=关）时，两个只读工具仍应注册并真正调用 OneBot。
  const { tools, call, onebotCalls } = loadQzoneTools({ config: baseConfig() });
  assert.equal(tools.has('qq_list_qzone_posts'), true);
  assert.equal(tools.has('qq_list_qzone_feeds'), true);

  const posts = await call('qq_list_qzone_posts', {});
  assert.notEqual(posts.isError, true);
  const feeds = await call('qq_list_qzone_feeds', {});
  assert.notEqual(feeds.isError, true);
  assert.deepEqual(onebotCalls.map((c) => c.url.split('/').pop()), ['get_qzone_msg_list', 'get_qzone_feeds']);
});

test('qzone:false 时连只读工具也不注册', async () => {
  const config = baseConfig({ socialV2: { enabled: true, tools: { qzone: false } } });
  const { tools } = loadQzoneTools({ config });
  assert.equal(tools.has('qq_list_qzone_posts'), false);
  assert.equal(tools.has('qq_list_qzone_feeds'), false);
});

test('config.example.json 里读开写关', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(example.socialV2.tools.qzone, true, '只读工具默认开');
  assert.equal(example.socialV2.tools.qzoneWrite, false, '写工具默认必须关');
});
