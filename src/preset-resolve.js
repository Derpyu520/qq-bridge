// preset 名解析：能不能给这个会话套上某个 preset。
//
// 这是桥里最要紧的一条 fail-closed 规则，所以从 main() 里搬出来单独测：
//   strict=true（群聊/仿真会话）时，名字不可用就返回 ''，由调用方拒绝建会话。
//   绝不能回退到 DSH 默认 preset（standard）—— standard 带 bash/文件读写，
//   一旦套在群聊会话上，群友就能驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
//
// 原来的实现直接读闭包里的 dshPresetIds / dshDefaultPreset，搬出来改成显式参数，
// 行为一字不改，只是让「清单为空」「名字不在清单里」这些分支能被单独喂进去验。

export function resolvePresetName(name, { strict = false, presetIds = [], defaultPreset = '', warn } = {}) {
  const wanted = String(name ?? '').trim();
  const warnFn = typeof warn === 'function' ? warn : () => {};
  const ids = Array.isArray(presetIds) ? presetIds : [];

  if (!wanted) return strict ? '' : (defaultPreset || '');
  // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
  if (ids.length === 0) return strict ? '' : wanted;
  if (ids.includes(wanted)) return wanted;

  warnFn(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${ids.join(', ')}）中`);
  if (strict) {
    warnFn(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
    return '';
  }
  return defaultPreset || '';
}
