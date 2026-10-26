import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBehaviorContract } from '../src/role-card.js';

// 逐张卡校验行为合同；没有合同的极简卡（roles/傲娇助手.md）跳过——
// 它故意只保留「人设层最小可用」的写法，用来演示「不写合同也能用，但不会那么稳」。
for (const name of ['小鲸鱼', '傲娇助手']) {
  const text = fs.readFileSync(`roles/${name}.md`, 'utf8');
  const c = parseBehaviorContract(text);
  if (!c.precedence && !c.atMention) continue;
  assert.ok(c.precedence, `${name} 缺少优先级`);
  assert.ok(c.atMention, `${name} 缺少被@策略`);
  assert.ok(c.facts, `${name} 缺少事实策略`);
  assert.ok(c.serious, `${name} 缺少认真策略`);
  assert.ok(c.proactive, `${name} 缺少主动策略`);
  // 卡是事实来源：只校验「主动」仍是**单一可判**的档位，不钉死某一个值。
  assert.match(c.proactive, /^(关闭|低|中|高)/, `${name} 的「主动」不是单一可判的档位`);
  assert.ok(c.toneByRelation.owner, `${name} 缺少 owner 语气`);
  assert.ok(c.toneByRelation['熟人'], `${name} 缺少熟人语气`);
}
const v3 = fs.readFileSync('dsh/agent-presets/qq-chat-v3/agent.cordis.yml', 'utf8');
assert.ok(!v3.includes('You are a coding agent'), 'V3 不应再自居 coding agent');
assert.ok(v3.includes('【冲突裁决'), 'V3 应有冲突裁决');
assert.ok(v3.includes('以行为合同为准'), 'V3 应让位给行为合同');
assert.ok(!v3.includes('可以偶尔打错字'), 'V3 不应鼓励故意错字');
console.log('✅ behavior contract / V3 priority checks passed');
