// 诊断探针共用的 DSH 鉴权/请求引导。
//
// 为什么需要它（这是一个真实存在过的适配缺口）
// --------------------------------------------
// 六个探针各自复制了一份「从 ~/.dsh/guard/logs/server-*.out.log 里正则抓 `?token=`，
// 再拿它换 Cookie」的引导代码。DSH 0.1.7 起这条路彻底死了：
//   · 进程启动 token 改为 processLaunchToken() 现生成的 32 字节随机数，**只存在内存
//     WeakMap 里，不落盘、不可推导**；
//   · guard 插件退役后，没有启动器再把 `dsh web` 的 stdout 重定向到那个目录，
//     于是日志里剩下的是**上一个进程的陈旧 token**，换 Cookie 只会得到 401。
// 桥接生产代码当时修好了，但这几个探针没跟上 —— 它们在 0.1.7/0.2.0 上一律 401，
// 等于「诊断工具本身坏了」，而没人会注意到（探针不是回归套件的一部分）。
//
// 现在统一走与生产代码同一条路：用 `~/.dsh/.credentials.yaml` 里**持久化**的
// `client-connection/browser-session` 签名密钥离线铸造会话 Cookie
// （见 src/dsh/dsh-client.js 的 discoverDshSessionCookie）。
//
// 另外：探针的工作区一律建在**系统临时目录**。`state/` 被 scripts/ops/harden-state-acl.mjs
// 收紧了 ACL（去掉继承 ⇒ 沙箱进程的能力 SID 不在 ACL 里），在 DSH 沙箱里跑探针时
// 往 state/ 建目录会直接 EPERM。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDshSessionCookie } from '../../src/dsh/dsh-client.js';

export const PROBE_BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

/**
 * 取得一个可用的会话 Cookie。
 *
 * 顺序：`DSH_PROBE_COOKIE` 环境变量 → argv[2]（显式 launch token，向后兼容旧用法）
 * → 用本机签名密钥离线铸造。
 *
 * @param options.base - DSH 基址。
 * @returns Cookie 串。
 * @throws 三种手段都拿不到时抛错，并说明各自失败的原因。
 */
export function probeCookie({ base = PROBE_BASE } = {}) {
  const explicit = process.env.DSH_PROBE_COOKIE;
  if (explicit) return explicit;
  const minted = discoverDshSessionCookie(base);
  if (minted) return minted;
  throw new Error(
    `无法为 ${base} 取得会话 Cookie：读不到 ${path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')} `
    + '里的 client-connection/browser-session 签名密钥（DSH 是否正在运行？DSH_HOME 是否指向真正的 .dsh？）。'
    + '也可以设 DSH_PROBE_COOKIE 直接给一个 Cookie。'
  );
}

/**
 * 造一个走 `/api/<endpoint>` 的 RPC 调用器（斜杠式 endpoint + { args } 包装）。
 *
 * @param cookie - {@link probeCookie} 的返回值。
 * @param options.base - DSH 基址。
 * @returns `async (endpoint, args) => result`，result 是 `{ ok, value }` / `{ ok:false, error }` 信封。
 */
export function probeRpc(cookie, { base = PROBE_BASE } = {}) {
  return async function rpc(endpoint, args) {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe-' + Math.random().toString(36).slice(2, 8),
        method: endpoint,
        payload: { args },
      }),
    });
    const body = await response.json();
    return body.result;
  };
}

/** 打开 `/api/remote.mux` 的 WebSocket（斜杠式流端点走这一条连接）。 */
export function probeMuxSocket(cookie, { base = PROBE_BASE } = {}) {
  const url = new URL('/api/remote.mux', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url, { headers: { cookie } });
}

/**
 * 探针用的工作区目录：系统临时目录下的独立子目录，不碰仓库里的 `state/`。
 * @param name - 子目录名（探针名即可）。
 */
export function probeWorkspaceDir(name) {
  const dir = path.join(os.tmpdir(), `qq-bridge-probe-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
