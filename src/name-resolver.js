// 会话显示名：把 `group:1044530112` / `private:2464332489` 这类内部 key
// 转成人能读的「群名 / 好友昵称」。
//
// 数据来源是 SnowLuma 的 get_group_list / get_friend_list（本地缓存到 state/names.json，
// 控制台每次加载不会都去拉一次网关）。缓存过期（默认 6 小时）或手动刷新时才重新拉。
//
// 只读网关，不写网关；拉取失败时退回缓存，缓存也没有就显示 "群 123456" 这种兜底文案，
// 绝不因为拿不到名字就让整页报错。
import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function readCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch {
    /* 缓存写失败不影响功能 */
  }
}

/**
 * 创建名称解析器。
 * @param {object} opts
 * @param {string} opts.cacheFile  缓存文件路径（state/names.json）
 * @param {() => Promise<{groups: object[], friends: object[]}>} opts.fetch 实际拉取函数
 * @param {(msg: string) => void} [opts.log]
 */
export function createNameResolver({ cacheFile, fetch, log = () => {} }) {
  let cache = readCache(cacheFile) || { groups: {}, friends: {}, updatedAt: 0 };
  let inflight = null;

  function apply(list) {
    const groups = {};
    const friends = {};
    for (const g of Array.isArray(list?.groups) ? list.groups : []) {
      const id = String(g?.group_id ?? g?.id ?? '').trim();
      const name = String(g?.group_name ?? g?.name ?? '').trim();
      if (id && name) groups[id] = name;
    }
    for (const f of Array.isArray(list?.friends) ? list.friends : []) {
      const id = String(f?.user_id ?? f?.id ?? '').trim();
      // 备注优先于昵称：主人给好友起的备注更能代表"这个人是谁"
      const name = String(f?.remark ?? '').trim() || String(f?.nickname ?? f?.name ?? '').trim();
      if (id && name) friends[id] = name;
    }
    cache = { groups, friends, updatedAt: Date.now() };
    writeCache(cacheFile, cache);
    return cache;
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const list = await fetch();
        return apply(list);
      } catch (error) {
        log(`⚠️ 拉取群名/好友昵称失败（沿用缓存）：${error?.message ?? error}`);
        return cache;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** 缓存过期就在后台刷新，不阻塞调用方。 */
  function refreshIfStale() {
    if (Date.now() - (Number(cache.updatedAt) || 0) > CACHE_TTL_MS) {
      void refresh();
    }
  }

  /**
   * 把会话 key 解析成可读信息。
   * @returns {{kind:'group'|'private', id:string, name:string, display:string}}
   */
  function resolve(key) {
    const raw = String(key ?? '');
    if (raw === '_global') {
      return { kind: 'global', id: '', name: '共享记忆', display: '共享记忆' };
    }
    // 目录名把冒号转成了短横线（group-1044530112），这里两种写法都认
    const m = /^([a-z]+)[:-](.+)$/.exec(raw);
    if (!m) return { kind: 'other', id: '', name: '', display: raw };
    const kind = m[1];
    const id = m[2];
    if (kind === 'group') {
      const name = cache.groups[id] || '';
      return {
        kind: 'group', id, name, display: name || `群 ${id}`,
      };
    }
    if (kind === 'private') {
      const name = cache.friends[id] || '';
      return {
        kind: 'private', id, name, display: name || `好友 ${id}`,
      };
    }
    return { kind: 'other', id, name: '', display: raw };
  }

  return {
    resolve,
    refresh,
    refreshIfStale,
    get snapshot() {
      return cache;
    },
  };
}

