// SnowLuma 旁路发送审计（只读）。
//
// 背景：SnowLuma 网关自带一个 `#sl` 状态命令，匹配后由网关自己直接调用
// sendGroupMessage/sendPrivateMessage，不经过 qq-bridge 的白名单、静默与敏感信息审计。
// 桥接拦不住这条出站消息，能做的是：启动时/控制台复检时把这条旁路暴露出来，防止
// SnowLuma 更新后默认值重新打开而没人发现。
//
// 这里只读 config/onebot*.json，不修改 SnowLuma、不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

// SnowLuma 的默认值（见其 onebot/src/config.ts 的 DEFAULT_STATUS_COMMAND）。
// 关键：字段缺失时 SnowLuma 会回落到 enabled:true，所以「没写」不能当成「关闭」。
export const SNOWLUMA_STATUS_DEFAULTS = Object.freeze({
  enabled: true,
  trigger: '#sl',
  swallow: false,
  cooldownSeconds: 5,
});

/** 解析单个 OneBot 配置对象里的 statusCommand，不读文件。 */
export function inspectOneBotConfig(raw, file = '') {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawStatus = obj.statusCommand;
  const hasStatus = !!rawStatus && typeof rawStatus === 'object' && !Array.isArray(rawStatus);
  const enabled = hasStatus ? rawStatus.enabled !== false : SNOWLUMA_STATUS_DEFAULTS.enabled;
  const defaulted = !hasStatus || typeof rawStatus.enabled !== 'boolean';
  const trigger = hasStatus && typeof rawStatus.trigger === 'string' && rawStatus.trigger.trim()
    ? rawStatus.trigger.trim()
    : SNOWLUMA_STATUS_DEFAULTS.trigger;
  const swallow = hasStatus && rawStatus.swallow === true;
  const cooldownSeconds = hasStatus && Number.isFinite(Number(rawStatus.cooldownSeconds))
    ? Number(rawStatus.cooldownSeconds)
    : SNOWLUMA_STATUS_DEFAULTS.cooldownSeconds;
  return {
    file,
    statusCommand: {
      enabled,
      defaulted,
      trigger,
      swallow,
      cooldownSeconds,
    },
  };
}

/**
 * 审计一组已读入的 OneBot 配置。
 * @param {{file: string, text?: string, raw?: any, readError?: string}[]} entries
 * @returns {{ok: boolean, enabled: boolean|null, files: object[], findings: object[], reason?: string}}
 *   enabled=true 表示至少一个文件明确开启；false 表示全部明确关闭；
 *   null 表示「读不到/解析失败/部分失败」，绝不能当成安全。
 */
export function auditOneBotConfigs(entries = []) {
  const files = [];
  const findings = [];
  let ok = true;
  for (const entry of entries) {
    const file = String(entry?.file ?? '');
    if (entry?.readError) {
      ok = false;
      files.push({ file, ok: false, error: String(entry.readError) });
      continue;
    }
    let obj;
    try {
      obj = entry?.raw !== undefined ? entry.raw : JSON.parse(String(entry?.text ?? ''));
    } catch (error) {
      ok = false;
      files.push({ file, ok: false, error: error?.message ?? String(error) });
      continue;
    }
    try {
      const info = inspectOneBotConfig(obj, file);
      files.push({ ...info, ok: true });
      if (info.statusCommand.enabled) findings.push({ ...info.statusCommand, file });
    } catch (error) {
      ok = false;
      files.push({ file, ok: false, error: error?.message ?? String(error) });
    }
  }
  return {
    ok,
    enabled: ok ? findings.length > 0 : null,
    files,
    findings,
    ...(ok ? {} : { reason: '部分 onebot 配置无法读取或解析，无法确认旁路状态' }),
  };
}

// SnowLuma 支持 config/onebot.json 与 config/onebot_<uin>.json 两种命名。
const CONFIG_FILE_RE = /^onebot(_\d+)?\.json$/i;

/**
 * 扫描 `snowluma.homeDir/config/onebot*.json`。只读，不抛异常。
 * @param {{homeDir?: string}} options
 * @returns {{checked: boolean, ok: boolean, enabled: boolean|null, files: object[], findings: object[], reason?: string, configDir?: string}}
 */
export function auditSnowLumaEgress({ homeDir } = {}) {
  const root = String(homeDir ?? '').trim();
  if (!root) {
    return { checked: false, ok: false, enabled: null, files: [], findings: [], reason: 'snowluma.homeDir 未配置' };
  }
  const configDir = path.join(root, 'config');
  let names;
  try {
    names = fs.readdirSync(configDir);
  } catch (error) {
    return {
      checked: false,
      ok: false,
      enabled: null,
      files: [],
      findings: [],
      reason: `无法读取 ${configDir}：${error?.message ?? error}`,
    };
  }
  const targets = names.filter((name) => CONFIG_FILE_RE.test(name)).sort();
  if (!targets.length) {
    return {
      checked: false,
      ok: false,
      enabled: null,
      files: [],
      findings: [],
      reason: `${configDir} 下没有 onebot*.json`,
    };
  }
  const entries = targets.map((name) => {
    const file = path.join(configDir, name);
    try {
      return { file, text: fs.readFileSync(file, 'utf8') };
    } catch (error) {
      return { file, readError: error?.message ?? String(error) };
    }
  });
  return { checked: true, ...auditOneBotConfigs(entries), configDir };
}
