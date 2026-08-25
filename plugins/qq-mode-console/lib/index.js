// QQ 桥接模式控制台（host 插件，仅注册 settings 命名空间）。
//
// 通过 DSH 官方用户设置扩展点（ctx.settings.register）暴露一个
// `qq-mode` 命名空间。WebUI 的设置页会自动渲染该命名空间的配置卡片，
// 用户在那里切换桥接模式（chat / closed-agent / 仿真模式，内部标识 reserved），
// 桥接进程通过 DSH settings API 轮询读取。本插件不修改任何 WebUI 内核。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAG = path.join(__dirname, '..', '..', '..', 'state', 'qq-mode-plugin.log');

function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

export const QqModeSchema = z.object({
  mode: z.union([z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2')]).default('chat'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

export function apply(ctx, config = {}) {
  diag(`apply called, settings=${typeof ctx.settings} inject=${JSON.stringify(ctx._inject)}`);
  try {
    const settings = ctx.settings;
    if (!settings || typeof settings.register !== 'function') {
      diag('settings service unavailable');
      return;
    }
    const scope = settings.register(QQMODE_NAMESPACE, QqModeSchema, {
      base: { mode: 'chat' },
      applies: 'live'
    });
    diag(`registered ${QQMODE_NAMESPACE} scope=${typeof scope}`);
    console.log(`[qq-mode-console] active (namespace=${QQMODE_NAMESPACE})`);
  } catch (error) {
    if (/already registered/i.test(String(error?.message ?? error))) {
      diag(`qq-mode namespace already registered, skip`);
      return;
    }
    diag(`register threw: ${error?.stack ?? error}`);
    throw error;
  }
}
