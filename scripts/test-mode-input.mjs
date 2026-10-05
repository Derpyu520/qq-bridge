// 模式归一与 DSH 读取口径的回归（被测对象：src/mode-input.js）。
// 两个重点：
// 1. user 层优先 —— DSH 0.2.0-rc.2 写完 settings 后 value 不更新（重启才生效），
//    只读 value 会让控制台切的模式被 5 秒轮询改回去；
// 2. bridge.js 不许改回直读 ns.value（源码断言，见文件末尾）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODE_INPUT_ALIASES, VALID_MODES, normalizeModeInput,
  modeFromDshNamespace, settingFromDshNamespace
} from '../src/mode-input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## normalizeModeInput：别名归一');
{
  ok(normalizeModeInput('chat') === 'chat', 'chat 归一到 chat');
  ok(normalizeModeInput('closed-agent') === 'closed-agent', 'closed-agent 归一到 closed-agent');
  ok(normalizeModeInput('reserved') === 'reserved', 'reserved 归一到 reserved');
  ok(normalizeModeInput('reserved2') === 'reserved2', 'reserved2 归一到 reserved2');
  ok(normalizeModeInput('simulation') === 'reserved2', '规范名 simulation 收敛到内部拼写 reserved2');
  ok(normalizeModeInput('  chat  ') === 'chat', '两侧空白被容忍（trim）');
  ok(normalizeModeInput('Chat') === null, '大小写不宽容（Chat 非法）');
  ok(normalizeModeInput('') === null, '空串非法');
  ok(normalizeModeInput(undefined) === null && normalizeModeInput(null) === null, 'undefined/null 非法');
  ok(normalizeModeInput(42) === null && normalizeModeInput({}) === null, '非字符串非法');
  ok(Object.isFrozen(MODE_INPUT_ALIASES), '别名表被冻结（防运行期篡改）');
  ok(['chat', 'closed-agent', 'reserved', 'reserved2'].every((m) => VALID_MODES.includes(m))
    && !VALID_MODES.includes('simulation'),
    'VALID_MODES 覆盖全部内部拼写（含 reserved2、不含规范名 simulation）');
}

console.log('## modeFromDshNamespace：user 层优先、value 回退');
{
  // 写入后 user 是新值、value 还是旧值 —— 必须取 user。
  ok(modeFromDshNamespace({ user: { mode: 'chat' }, value: { mode: 'reserved2' } }) === 'chat',
    'user=chat / value=reserved2（value 未热更新）→ 取 user');
  ok(modeFromDshNamespace({ user: { mode: 'reserved2' }, value: { mode: 'chat' } }) === 'reserved2',
    '反方向同样 user 优先');
  // 从未写过 user 层时 describe 给 user={}（projectForm 丢空字段）——回退 value。
  ok(modeFromDshNamespace({ user: {}, value: { mode: 'reserved2' } }) === 'reserved2',
    'user 层无 mode（从未写过）→ 回退 value');
  ok(modeFromDshNamespace({ value: { mode: 'reserved2' } }) === 'reserved2',
    '缺 user 字段 → 回退 value');
  // user 层写了无效词（手改文件写错）→ 不该把整条读取打成 null，回退 value 的合法值。
  ok(modeFromDshNamespace({ user: { mode: 'banana' }, value: { mode: 'reserved' } }) === 'reserved',
    'user 层无效词 → 回退 value 层合法值');
  ok(modeFromDshNamespace({ user: { mode: 'simulation' }, value: { mode: 'reserved2' } }) === 'reserved2',
    'user 层规范名 simulation 照常归一');
  ok(modeFromDshNamespace({ user: { mode: 42 }, value: { mode: 'chat' } }) === 'chat',
    'user 层非字符串 → 回退 value');
  ok(modeFromDshNamespace(undefined) === null, '命名空间不存在 → null（调用方回退本地 mode.json）');
  ok(modeFromDshNamespace(null) === null, 'null 命名空间 → null');
  ok(modeFromDshNamespace({}) === null, '空描述符 → null');
  ok(modeFromDshNamespace({ user: {}, value: {} }) === null, '两层都无 mode → null');
  ok(modeFromDshNamespace({ user: { mode: 'banana' }, value: { mode: 'kiwi' } }) === null,
    '两层都无效 → null（调用方回退本地）');
}

console.log('## settingFromDshNamespace：按层取原始值（ownerQQ 等）');
{
  ok(settingFromDshNamespace({ user: { ownerQQ: '10001' }, value: { ownerQQ: '10002' } }, 'ownerQQ') === '10001',
    'user 层优先');
  ok(settingFromDshNamespace({ user: {}, value: { ownerQQ: '10002' } }, 'ownerQQ') === '10002',
    'user 层无该字段 → 回退 value');
  ok(settingFromDshNamespace({ user: {}, value: {} }, 'ownerQQ') === undefined,
    '两层都没有 → undefined（调用方不覆盖 config.json）');
  ok(settingFromDshNamespace(undefined, 'ownerQQ') === undefined, '命名空间不存在 → undefined');
  ok(settingFromDshNamespace({ user: { ownerQQ: '' }, value: { ownerQQ: '9' } }, 'ownerQQ') === '',
    'user 层空串是显式值（不被 value 顶掉，空串语义由调用方校验）');
}

console.log('## bridge.js 源码断言：读取不许直读 ns.value');
{
  const source = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(source.includes('modeFromDshNamespace('), 'refreshMode 使用 modeFromDshNamespace');
  ok(source.includes("settingFromDshNamespace(ns, 'ownerQQ')"),
    'ownerQQ 走 settingFromDshNamespace（同样 user 优先）');
  // 旧写法的特征串：出现就说明读取被改回了直读 value。
  // state/mode.json 的回退分支仍用 normalizeModeInput(local.mode)，这里只钉 ns.value。
  ok(!/normalizeModeInput\(\s*ns\??\.value\b/.test(source),
    '不存在 normalizeModeInput(ns.value.mode) 旧写法');
  ok(!/ns\.value\.ownerQQ/.test(source), '不存在 ns.value.ownerQQ 旧写法');
  // 归一化逻辑不再有 bridge.js 内的第二份定义（防"两份名单各自漂移"的老坑复发）。
  ok(!source.includes('const MODE_INPUT_ALIASES'), '别名表只有 mode-input.js 一份（bridge.js 不重复定义）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
