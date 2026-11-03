// restart.bat 的本实例识别回归：锁 PID 必须是入口属于本仓库的 node + src/bridge.js；
// 其他仓库的同名脚本与守护窗口不得结束。纯函数测试，不启动/结束任何真实进程。
import assert from 'node:assert/strict';
import {
  isBridgeCommandLine,
  isBridgeProcess,
  isGuardProcess,
  planStop,
  parseNetstatListenerPid
} from './stop-bridge-instance.mjs';

let failures = 0;
function test(name, run) {
  try {
    run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

const proc = (pid, name, commandLine, parentPid = 4) => ({ pid, parentPid, name, commandLine });
const bridgeCmd = 'node.exe src/bridge.js';

test('识别 bridge.js 入口，不把参数中的同名文本当成入口', () => {
  assert.equal(isBridgeCommandLine('"C:\\Program Files\\nodejs\\node.exe" src/bridge.js'), true);
  assert.equal(isBridgeCommandLine('node "C:\\repo with space\\src\\bridge.js"'), true);
  assert.equal(isBridgeCommandLine('node other.js --config bridge.js'), false);
  assert.equal(isBridgeCommandLine('node my-bridge.js'), false);
});

test('bridge 进程必须是 node 且使用可证明归属的绝对入口', () => {
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node src/bridge.js')), false);
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node other.js')), false);
  assert.equal(isBridgeProcess(proc(10, 'python.exe', 'python bridge.js')), false);
  assert.equal(isBridgeProcess(null), false);
});

test('守护窗口只认 start.bat，归属校验时要求绝对路径', () => {
  assert.equal(isGuardProcess(proc(20, 'cmd.exe', 'cmd /c start.bat')), true);
  assert.equal(isGuardProcess(proc(20, 'cmd.exe', 'cmd /c "C:\\repo\\start.bat"')), true);
  assert.equal(isGuardProcess(proc(20, 'cmd.exe', 'cmd /c start.bat'), 'C:\\repo'), false);
  assert.equal(isGuardProcess(proc(20, 'cmd.exe', 'cmd /c restart.bat')), false);
  assert.equal(isGuardProcess(proc(20, 'pwsh.exe', 'start.bat')), false);
});

test('锁 PID 验证通过 + 端口属于同一 PID → 停止守护进程树', () => {
  const plan = planStop({
    root: 'C:\\repo',
    port: 3100,
    lockPid: 100,
    listenerPid: 100,
    processes: [
      proc(50, 'cmd.exe', 'cmd /c C:\\repo\\start.bat'),
      proc(100, 'node.exe', 'node C:\\repo\\src\\bridge.js', 50)
    ]
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.bridgePid, 100);
  assert.equal(plan.guardPid, 50);
  assert.equal(plan.killPid, 50, '应连守护窗口一起结束，避免它 5 秒后把旧实例拉起来');
});

test('锁 PID 验证通过但父进程不是守护窗口 → 只停止 node 本身', () => {
  const plan = planStop({
    root: 'C:\\repo', port: 3100, lockPid: 100, listenerPid: 100,
    processes: [proc(100, 'node.exe', 'node C:\\repo\\src\\bridge.js', 777)]
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.guardPid, null);
  assert.equal(plan.killPid, 100);
});

test('父进程是其他仓库的 start.bat → 不把该守护窗口算入进程树', () => {
  const plan = planStop({
    root: 'C:\\repo',
    port: 3100, lockPid: 100, listenerPid: 100,
    processes: [
      proc(50, 'cmd.exe', 'cmd /c C:\\other\\start.bat'),
      proc(100, 'node.exe', 'node C:\\repo\\src\\bridge.js', 50)
    ]
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.guardPid, null);
  assert.equal(plan.killPid, 100);
});

test('锁 PID 与端口属于其他仓库的 bridge.js → 拒绝结束进程树', () => {
  const plan = planStop({
    root: 'C:\\repo',
    port: 3100, lockPid: 100, listenerPid: 100,
    processes: [
      proc(50, 'cmd.exe', 'cmd /c C:\\other\\start.bat'),
      proc(100, 'node.exe', 'node C:\\other\\bridge.js', 50)
    ]
  });
  assert.equal(plan.action, 'abort');
  assert.equal(plan.bridgePid, undefined);
});

test('bridge 入口必须是当前仓库的绝对路径，相对入口无法证明归属', () => {
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node src/bridge.js'), 'C:\\repo'), false);
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node C:\\repo\\src\\bridge.js'), 'C:\\repo'), true);
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node C:\\other\\bridge.js'), 'C:\\repo'), false);
  assert.equal(isBridgeProcess(proc(10, 'node.exe', 'node C:\\repo-other\\src\\bridge.js'), 'C:\\repo'), false);
});

test('相对 bridge/start 命令即使锁 PID 与端口一致也拒绝停止', () => {
  const plan = planStop({
    root: 'C:\\repo', port: 3100, lockPid: 100, listenerPid: 100,
    processes: [
      proc(50, 'cmd.exe', 'cmd /c start.bat'),
      proc(100, 'node.exe', 'node src/bridge.js', 50)
    ]
  });
  assert.equal(plan.action, 'abort');
  assert.equal(plan.bridgePid, undefined);
});

test('锁 PID 是别的程序（PID 被回收）→ 只清理锁，不杀进程', () => {
  const plan = planStop({
    port: 3100, lockPid: 100, listenerPid: null,
    processes: [proc(100, 'chrome.exe', 'chrome.exe')]
  });
  assert.equal(plan.action, 'cleanup');
  assert.equal(plan.bridgePid, undefined);
});

test('锁 PID 已不存在且没有守护窗口 → 只清理锁', () => {
  const plan = planStop({ port: 3100, lockPid: 100, listenerPid: null, processes: [] });
  assert.equal(plan.action, 'cleanup');
});

test('锁已失效但仍检测到 start.bat 守护窗口 → 中止（不能并发拉起第二个实例）', () => {
  const plan = planStop({
    port: 3100, lockPid: 100, listenerPid: null,
    processes: [proc(50, 'cmd.exe', 'cmd /c start.bat')]
  });
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /守护窗口/);
});

test('端口被“非锁 PID”监听 → 拒绝结束任何进程', () => {
  const plan = planStop({
    port: 3100, lockPid: 100, listenerPid: 200,
    processes: [
      proc(100, 'node.exe', 'node src/bridge.js'),
      proc(200, 'node.exe', 'node C:\\other\\bridge.js')
    ]
  });
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /3100/);
});

test('没有锁但端口有监听 → 拒绝（可能锁被删/别的程序占用）', () => {
  const plan = planStop({
    port: 3100, lockPid: null, listenerPid: 200,
    processes: [proc(200, 'node.exe', 'node C:\\other\\bridge.js')]
  });
  assert.equal(plan.action, 'abort');
});

test('锁 PID 未验证但端口恰好也是它 → 仍拒绝（不能只凭 PID 数字）', () => {
  const plan = planStop({
    port: 3100, lockPid: 100, listenerPid: 100,
    processes: [proc(100, 'node.exe', 'node other.js')]
  });
  assert.equal(plan.action, 'abort');
});

test('无锁、无端口、无进程 → 什么都不做', () => {
  assert.equal(planStop({ port: 3100 }).action, 'none');
});

test('解析 netstat 的 LISTENING PID（IPv4/IPv6）', () => {
  const out = [
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1111',
    '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       2222',
    '  TCP    [::]:3100              [::]:0                 LISTENING       2222',
    '  TCP    127.0.0.1:3100         127.0.0.1:50000        ESTABLISHED     3333'
  ].join('\r\n');
  assert.equal(parseNetstatListenerPid(out, 3100), 2222);
  assert.equal(parseNetstatListenerPid(out, 3101), null);
});

console.log(failures === 0 ? '\n✅ restart.bat 本实例识别回归通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
