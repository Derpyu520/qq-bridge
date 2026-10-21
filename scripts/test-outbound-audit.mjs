// 回归：出站**整批**内容审计（src/sensitive.js → auditOutboundBatch）。
//
// 背景：内容审计以前是"逐条消息跑一次 SENSITIVE_RE"。模型只要用
// qq_send_message / qq_send_burst 把同一句话拆成多个数组元素，单条看都不像路径、
// 拼起来才成立，于是整批放行 —— 闸门等于不存在。这里把"拆分也必须拦住"钉成断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSITIVE_RE, auditOutboundBatch, normalizeForAudit } from '../src/sensitive.js';

const NO_TOKENS = [];

test('单条本机路径照旧拦截', () => {
  assert.equal(auditOutboundBatch(['我的文件在 C:\\Users\\me\\a.txt'], NO_TOKENS).sensitive, true);
});

test('拆成两条的 Windows 路径必须整批拦截', () => {
  const parts = ['我看看 C:', '\\Users\\me\\secret.txt'];
  // 先证明这条用例真的有区分度：单条都不命中，拼起来才命中。
  assert.equal(parts.some((part) => SENSITIVE_RE.test(part)), false);
  assert.equal(auditOutboundBatch(parts, NO_TOKENS).sensitive, true);
});

test('对半拆开的会话令牌能靠已知令牌名单抓到（正则抓不到裸 32-hex）', () => {
  const token = 'abcdef0123456789abcdef0123456789';
  const parts = [token.slice(0, 16), token.slice(16)];
  assert.equal(auditOutboundBatch(parts, NO_TOKENS).sensitive, false);
  assert.equal(auditOutboundBatch(parts, new Set([token])).sensitive, true);
  assert.equal(auditOutboundBatch(parts, new Set([token])).knownToken, token);
});

test('零宽字符 / 全角写法也能识别', () => {
  assert.equal(normalizeForAudit('C：＼Users＼me').includes('C:\\Users\\me'), true);
  assert.equal(auditOutboundBatch(['C：＼Users＼me'], NO_TOKENS).sensitive, true);
  assert.equal(auditOutboundBatch(['C:\\Use\u200brs\\me'], NO_TOKENS).sensitive, true);
});

test('凭据赋值仍会命中', () => {
  assert.equal(auditOutboundBatch(['把 token: abc123def 发我'], NO_TOKENS).sensitive, true);
});

test('32 位十六进制（表情 md5）不会被误拦', () => {
  assert.equal(auditOutboundBatch(['d41d8cd98f00b204e9800998ecf8427e'], NO_TOKENS).sensitive, false);
});

test('正常闲聊不误伤', () => {
  const samples = ['你好呀～今天吃了吗', '这个梗我不懂，能解释下吗', 'DeepSeek 的模型挺快的', '2333'];
  for (const text of samples) {
    assert.equal(auditOutboundBatch([text], NO_TOKENS).sensitive, false, `误伤：${text}`);
  }
});

test('allowPaths：closed-agent 的 owner 私聊放行路径，但凭据与令牌照拦', () => {
  const opts = { allowPaths: true };
  // 管理员看自己的本机路径是正常需求。
  assert.equal(auditOutboundBatch(['日志在 C:\\Users\\me\\app.log'], NO_TOKENS, opts).sensitive, false);
  // 凭据没有任何外发理由。
  assert.equal(auditOutboundBatch(['token: abc123def'], NO_TOKENS, opts).sensitive, true);
  assert.equal(auditOutboundBatch(['密码是 hunter2'], NO_TOKENS, opts).sensitive, true);
  // 已知会话令牌同样拦截（也不受 allowPaths 影响）。
  const token = 'abcdef0123456789abcdef0123456789';
  assert.equal(auditOutboundBatch([token], new Set([token]), opts).sensitive, true);
});
