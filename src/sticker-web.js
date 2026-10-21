// 网上表情包：PigHub（猪猪图片库）索引 + 取图。
//
// 数据来源：GitHub 仓库 BadFish-HSrui/PigHub-DB 的 data/ 目录（PigHub 官方同步仓库），
// 通过 jsDelivr 拉图。不用 pighub.top 的 /api/images（参数未公开，试了常见组合都 40000）。
//
// 索引只建一次、缓存 7 天：GitHub tree API 一次拿全量路径（1.2 万张），
// 失败再退回 contents 分页；运行时只读本地缓存，不依赖 GitHub 的限流。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'BadFish-HSrui/PigHub-DB';
const BRANCH = 'master';
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const CONTENTS_API = `https://api.github.com/repos/${REPO}/contents/data?per_page=1000`;
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/data/`;
const MAX_BYTES = 8 * 1024 * 1024;

export function createWebStickerStore({ stateDir, log = () => {}, ttlMs = 7 * 24 * 3600 * 1000 }) {
  const INDEX_FILE = path.join(stateDir, 'pighub-index.json');
  let cache = null;

  function loadCache() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (Array.isArray(raw?.names) && raw.names.length) { cache = raw; return cache; }
    } catch {}
    return null;
  }

  function saveCache(names) {
    cache = { fetchedAt: Date.now(), names };
    try { fs.writeFileSync(INDEX_FILE, JSON.stringify(cache), 'utf8'); } catch (error) { log(`[pighub] 索引写盘失败：${error?.message ?? error}`); }
  }

  async function fetchNamesByTree() {
    const res = await fetch(TREE_API, { headers: { 'user-agent': 'qq-bridge/pighub', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`tree API HTTP ${res.status}`);
    const json = await res.json();
    if (json.truncated) throw new Error('tree API 结果被截断（仓库太大），改用分页');
    const names = (json.tree || [])
      .filter((e) => e.type === 'blob' && e.path.startsWith('data/'))
      .map((e) => e.path.slice(5))
      .filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
    if (!names.length) throw new Error('tree API 返回空列表');
    return names;
  }

  async function fetchNamesByPaging() {
    const names = [];
    let lastSignature = '';
    for (let page = 1; page <= 20; page += 1) {
      const res = await fetch(`${CONTENTS_API}&page=${page}`, { headers: { 'user-agent': 'qq-bridge/pighub' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`contents API HTTP ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) break;
      // 这个仓库的目录超过 1000 项时 GitHub 不翻页（page 参数被忽略，每页都返回同一批），
      // 用「首尾名是否和上一页相同」判断，避免把同一批文件重复几十遍。
      const signature = `${list[0]?.name}|${list[list.length - 1]?.name}|${list.length}`;
      if (signature === lastSignature) break;
      lastSignature = signature;
      for (const f of list) if (f.type === 'file') names.push(f.name);
      if (list.length < 1000) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    if (!names.length) throw new Error('contents API 返回空列表');
    return names;
  }

  async function ensureIndex({ force = false } = {}) {
    const cached = loadCache();
    if (!force && cached && Date.now() - Number(cached.fetchedAt) < ttlMs) return cached;
    let names = null;
    try {
      names = await fetchNamesByTree();
      log(`[pighub] 索引已更新（tree API，${names.length} 张）`);
    } catch (error) {
      log(`[pighub] tree API 失败（${error?.message ?? error}），改用分页`);
      try {
        names = await fetchNamesByPaging();
        log(`[pighub] 索引已更新（分页，${names.length} 张）`);
      } catch (error2) {
        log(`[pighub] 索引更新失败：${error2?.message ?? error2}`);
        if (cached) return cached;
        throw new Error('拿不到猪猪表情索引（网络或 GitHub 限流），稍后再试');
      }
    }
    saveCache(names);
    return cache;
  }

  function encodeName(name) {
    return encodeURIComponent(name).replace(/%2F/g, '/');
  }

  function score(name, tokens, fullQuery) {
    const lower = name.toLowerCase();
    let s = 0;
    if (fullQuery && lower.includes(fullQuery)) s += 5;
    for (const t of tokens) if (lower.includes(t)) s += 1;
    return s;
  }

  /**
   * 搜猪猪表情。返回 [{ name, url }]。
   * 没有命中时随机给几张（"随便来张猪猪" 也能用）。
   */
  async function search(query, limit = 8) {
    const idx = await ensureIndex();
    const fullQuery = String(query || '').trim().toLowerCase();
    const tokens = fullQuery.split(/[\s,，、/]+/).filter(Boolean);
    const scored = [];
    for (const name of idx.names) {
      const s = score(name, tokens, fullQuery);
      if (s > 0) scored.push({ name, s });
    }
    scored.sort((a, b) => b.s - a.s);
    let picked = scored.slice(0, limit).map((x) => x.name);
    if (!picked.length) {
      const pool = idx.names.slice();
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      picked = pool.slice(0, Math.min(limit, 6));
    }
    return picked.map((name) => ({ name, url: CDN + encodeName(name) }));
  }

  /** 下载一张（只能取索引里存在的名字，避免被当成任意 URL 代理） */
  async function fetchImage(name) {
    const idx = await ensureIndex();
    if (!idx.names.includes(name)) {
      const found = await search(name, 1);
      if (!found.length) throw new Error('没有找到这张猪猪表情');
      name = found[0].name;
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(CDN + encodeName(name), {
          headers: { 'user-agent': 'qq-bridge/pighub' },
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error(`图片过大（${buf.length} 字节）`);
        if (buf.length < 64) throw new Error('图片内容为空');
        return { name, buffer: buf };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    throw new Error(`取图失败：${lastError?.message ?? lastError}`);
  }

  return { ensureIndex, search, fetchImage, indexFile: INDEX_FILE };
}
