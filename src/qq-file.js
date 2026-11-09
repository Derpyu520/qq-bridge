// QQ 文件服务：OneBot file 段的字节获取、落盘、缓存，以及把本地文件上传到 QQ。
//
// 从 bridge.js 拆出来的独立模块：跨层依赖（bot、cfg、路径、安全判定）全部由
// createQQFileService 注入；纯函数（路径白名单/文件名净化/文本判定）仍在 qq-file-lib.js。
// bridge.js 只保留依赖注入与转发，函数名不变，调用点无需改动。
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_FILE_BYTES,
  base64FromMaybe,
  findSavedDownload,
  pickGroupFileFromList,
  resolveDownloadDir,
  resolveUploadPath,
  sanitizeQQFileName,
  uniqueDownloadPath
} from './qq-file-lib.js';
import { safeFetchBytes } from './safe-fetch.js';
import { formatBytes, parseTargetKey } from './send-voice-lib.js';

/**
 * @param {object} deps
 * @param {() => any} deps.getBot - 返回 SnowLuma 客户端（延迟取，bridge 里的 bot 是后置创建的）
 * @param {object} deps.cfg - 桥接配置（读 cfg.files / cfg.sessionCwd / cfg.snowluma）
 * @param {string} deps.root - 仓库根（下载目录相对路径按它解析）
 * @param {string} deps.stateDir - state 目录（没有 sessionCwd 时的兜底根）
 * @param {(p:string)=>boolean} deps.isSafeLocalMediaPath - 本地媒体路径是否在 SnowLuma home 内
 */
export function createQQFileService({ getBot, cfg, root, stateDir, isSafeLocalMediaPath }) {
  // ── QQ 文件（OneBot file 段）字节获取、落盘与缓存 ──────────────────────────
  //
  // 与图片完全不同的地方：文件段没有可直接内联的字节，必须由桥接去网关换取下载链接。
  // 安全口径与图片一致：**绝不把消息里的原始 URL 交给网关重新抓取**，链接要么来自
  // 消息段、要么来自 getBot().request('get_group_file_url'/'get_file')，抓取一律走
  // safeFetchBuffer（DNS 固定 + 逐跳校验 + 大小上限），落盘只进配置的下载目录。
  const fileByteCache = new Map(); // cacheKey -> { buffer,name,mime,via,bytes,saved,error,at }
  const FILE_CACHE_TTL_MS = 10 * 60 * 1000; // 收到与投递之间通常只隔几秒；10 分钟足够复用
  const FILE_CACHE_MAX = 24;
  const FILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

  function fileConfig() {
    return cfg.files ?? {};
  }

  function fileCacheKey(media) {
    return [media?.fileId, media?.file, media?.url, media?.name].map((v) => String(v ?? '')).join('|');
  }

  function trimFileByteCache() {
    let total = 0;
    for (const entry of fileByteCache.values()) total += entry?.buffer?.length ?? 0;
    while (fileByteCache.size > FILE_CACHE_MAX || total > FILE_CACHE_MAX_BYTES) {
      const oldest = fileByteCache.keys().next().value;
      if (oldest === undefined) break;
      total -= fileByteCache.get(oldest)?.buffer?.length ?? 0;
      fileByteCache.delete(oldest);
    }
  }

  function downloadDirAbs() {
    return resolveDownloadDir(fileConfig().dir, root);
  }

  /** 把字节落盘到下载目录（净化文件名 + 防重名；已存在同名则加 -2 后缀）。 */
  function saveFileToDownloadDir(buffer, name) {
    const dir = downloadDirAbs();
    fs.mkdirSync(dir, { recursive: true });
    const target = uniqueDownloadPath(dir, sanitizeQQFileName(name));
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return { path: target, name: path.basename(target), dir, bytes: buffer.length };
  }

  /**
   * 列出群文件（root + 子目录，广度优先）。
   *
   * 用途有两个：① 「聊天里的 file_id 找不到群文件」时按名字+大小回退；
   * ② `qq_list_group_files` 工具让模型直接看到群文件里有什么（而不是只能等别人在群里发）。
   * 返回的条目保留 SnowLuma 原始字段（file_id/file_name/file_size/busid/upload_time/uploader_name…），
   * 另加 folder_id/folder_name 便于展示。
   *
   * 遍历有上限（默认 50 个目录）：大群目录树可能很深，列表/下载路径都不能无限翻。
   * @param {number} groupId
   * @param {{recursive?:boolean, maxFolders?:number}} [options]
   * @returns {Promise<{folders:object[], files:object[]}>}
   */
  async function listGroupFiles(groupId, { recursive = true, maxFolders = 50 } = {}) {
    const folders = [];
    const files = [];
    const queue = [{ folderId: '/', folderName: '' }];
    const seen = new Set(['/']);
    let budget = Math.max(1, Math.min(200, Number(maxFolders) || 50));
    while (queue.length > 0 && budget > 0) {
      budget -= 1;
      const { folderId, folderName } = queue.shift();
      let payload;
      try {
        const raw = await getBot().request('get_group_files_by_folder', { group_id: groupId, folder_id: folderId });
        payload = raw?.data ?? raw;
      } catch (error) {
        if (folderId === '/') throw error;
        continue;
      }
      for (const f of Array.isArray(payload?.files) ? payload.files : []) {
        files.push({ ...f, folder_id: folderId, folder_name: folderName });
      }
      for (const folder of Array.isArray(payload?.folders) ? payload.folders : []) {
        const id = String(folder?.folder_id ?? '').trim();
        if (!id) continue;
        const name = String(folder?.folder_name ?? '').trim();
        folders.push({ folder_id: id, folder_name: name, file_count: Number(folder?.total_file_count) || 0, parent_id: folderId });
        if (!recursive || seen.has(id)) continue;
        seen.add(id);
        queue.push({ folderId: id, folderName: name });
      }
    }
    return { folders, files };
  }

  /**
   * 在群文件列表里按「文件名 + 大小」找同名文件。
   *
   * 为什么需要：**聊天消息里的 file_id 与群文件里的 file_id 是两套 id**（实测同一个文件：
   * 段里是 `/14fe…`，群文件列表里是 `/0a5b…`）。用段里的 id 调 get_group_file_url 会报
   * 「文件不存在」；而群文件里确实存在同名同大小的文件。此时用列表里的 file_id 才能取到
   * 下载链接。只按 name + size 匹配，不做模糊匹配（避免把同名但不同内容的文件当成本文件）。
   * @param {number} groupId
   * @param {{name?:string,size?:number}} media
   * @returns {Promise<object|null>} 命中的群文件条目（含 file_id/busid）。
   */
  async function findGroupFileByMeta(groupId, media) {
    const wantedName = String(media?.name ?? '').trim();
    if (!wantedName) return null;
    const { files } = await listGroupFiles(groupId, { recursive: true, maxFolders: 20 });
    return pickGroupFileFromList(files, { name: wantedName, size: media?.size });
  }

  /**
   * 换取文件字节：段内 URL → 群文件下载链接 → 群文件列表按名字回退 → get_file。
   * 任何一路成功即返回；全部失败抛错（错误信息里带上试过哪些渠道，便于群友/管理员排查）。
   * @param {object} media - extractMediaFromSegments 产出的 file 元数据。
   * @param {string} key - 会话 key（群文件链接需要群号）。
   * @param {{maxBytes?:number}} [options]
   * @returns {Promise<{buffer:Buffer,mime:string,via:string}>}
   */
  async function fetchQQFileBytes(media, key, { maxBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    const limit = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_FILE_BYTES;
    const attempts = [];
    const fromUrl = async (url, via) => {
      // 群文件不是图片：必须用 safeFetchBytes（同一套 SSRF/重定向/大小防护，但不校验图片签名）。
      // 曾用 safeFetchBuffer 抓群文件，HTML/zip/pdf 全部被判「不是有效图片」而失败。
      const fetched = await safeFetchBytes(String(url), limit);
      return { buffer: fetched.buffer, mime: fetched.mimeType || 'application/octet-stream', via };
    };
    if (media.url) {
      try { return await fromUrl(media.url, 'segment-url'); }
      catch (error) { attempts.push(`segment-url: ${error?.message ?? error}`); }
    }
    const target = parseTargetKey(key);
    if (target?.kind === 'group' && (media.fileId || media.name)) {
      try {
        const info = await getBot().request('get_group_file_url', {
          group_id: Number(target.id),
          file_id: media.fileId,
          busid: Number(media.busid) || 102
        });
        const url = info?.url ?? info?.data?.url;
        if (url) return await fromUrl(url, 'group-file-url');
        attempts.push(`group-file-url: ${info?.wording ?? '未返回 url'}`);
      } catch (error) { attempts.push(`group-file-url: ${error?.message ?? error}`); }
      // 聊天里收到的文件 id 与「群文件」里的 id 是两套：群临时文件/聊天文件用段里的
      // file_id 调 get_group_file_url 会报「文件不存在」。如果群文件里存在同名（同大小）
      // 的文件，就用群文件列表里的 file_id 再取一次下载链接。
      try {
        const hit = await findGroupFileByMeta(Number(target.id), media);
        if (hit) {
          const info = await getBot().request('get_group_file_url', {
            group_id: Number(target.id),
            file_id: String(hit.file_id ?? hit.id ?? ''),
            busid: Number(hit.busid) || 102
          });
          const url = info?.url ?? info?.data?.url;
          if (url) return await fromUrl(url, 'group-file-list-url');
          attempts.push(`group-file-list-url: ${info?.wording ?? '未返回 url'}`);
        } else {
          attempts.push('group-file-list: 群文件里没有同名同大小的文件');
        }
      } catch (error) { attempts.push(`group-file-list: ${error?.message ?? error}`); }
    }
    if (media.fileId || media.file) {
      try {
        const raw = await getBot().request('get_file', {
          ...(media.fileId ? { file_id: media.fileId } : {}),
          ...(media.file ? { file: media.file } : {})
        });
        const obj = raw && typeof raw === 'object' ? (raw.data ?? raw) : {};
        const base64 = base64FromMaybe(obj.base64) || base64FromMaybe(obj.data) || base64FromMaybe(obj.file);
        if (base64) {
          const buf = Buffer.from(base64, 'base64');
          if (buf.length > 0 && buf.length <= limit) return { buffer: buf, mime: 'application/octet-stream', via: 'get_file-base64' };
          if (buf.length > limit) throw new Error(`超过上限 ${formatBytes(limit)}`);
        }
        if (obj.url) return await fromUrl(obj.url, 'get_file-url');
        if (typeof obj.file === 'string' && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size <= limit) return { buffer: fs.readFileSync(obj.file), mime: 'application/octet-stream', via: 'get_file-local' };
        }
        attempts.push('get_file: 没有可下载内容');
      } catch (error) { attempts.push(`get_file: ${error?.message ?? error}`); }
    }
    if (media.file && fs.existsSync(media.file) && isSafeLocalMediaPath(media.file)) {
      try {
        const stat = fs.statSync(media.file);
        if (stat.size <= limit) return { buffer: fs.readFileSync(media.file), mime: 'application/octet-stream', via: 'segment-local' };
      } catch (error) { attempts.push(`segment-local: ${error?.message ?? error}`); }
    }
    throw new Error(`无法获取文件字节（${attempts.join('；') || '消息段里没有 file_id/url'}）`);
  }

  /**
   * 幂等获取一个 QQ 文件：命中缓存直接复用；否则抓字节、写入下载目录（按配置）、记缓存。
   * 失败不抛异常——返回 `{ error }` 交给调用方决定降级方式（内联/只报元数据）。
   * @param {object} media - file 元数据。
   * @param {string} key - 会话 key。
   * @param {{needBytes?:boolean, save?:boolean|null, name?:string}} [options]
   * @returns {Promise<{name:string,bytes:number,mime:string,buffer:Buffer|null,saved:object|null,error:string|null,via:string,cached:boolean}>}
   */
  async function ensureQQFile(media, key, { needBytes = true, save = null, name = null } = {}) {
    const limit = Number(fileConfig().maxBytes) > 0 ? Number(fileConfig().maxBytes) : DEFAULT_MAX_FILE_BYTES;
    const cacheKey = fileCacheKey(media);
    const wantSave = save === null ? fileConfig().download !== false : save === true;
    const cached = fileByteCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS && (!needBytes || cached.buffer)) {
      const hit = { ...cached, cached: true };
      if (wantSave && !hit.saved && hit.buffer) {
        try {
          hit.saved = saveFileToDownloadDir(hit.buffer, hit.name);
          hit.name = hit.saved.name;
          fileByteCache.set(cacheKey, { ...hit, at: Date.now() });
        } catch (error) {
          hit.error = hit.error ?? `另存失败：${error?.message ?? error}`;
        }
      }
      return hit;
    }
    const displayName = name || media.name || fileNameFromUrl(media.url) || (media.fileId ? `qq-file-${media.fileId}` : 'qq-file');
    const entry = {
      name: displayName,
      bytes: Number(media.size) > 0 ? Number(media.size) : 0,
      mime: '',
      buffer: null,
      saved: null,
      error: null,
      via: '',
      cached: false
    };
    // 已经有同名同大小的落盘文件时直接复用（读盘比重新下载便宜，也不会产生 -2/-3 副本）。
    // 大文件尤其重要：files.maxBytes 调到 1G 后，重复下载 90MB 群文件会又慢又费内存。
    const existing = wantSave ? findSavedDownload(downloadDirAbs(), displayName, entry.bytes) : null;
    if (existing) {
      entry.saved = existing;
      entry.name = existing.name;
      entry.bytes = existing.bytes;
      entry.via = 'existing-download';
      if (needBytes) {
        try { entry.buffer = fs.readFileSync(existing.path); } catch { entry.buffer = null; }
      }
      fileByteCache.set(cacheKey, { ...entry, at: Date.now() });
      trimFileByteCache();
      return entry;
    }
    if (Number(media.size) > limit) {
      entry.error = `文件超过上限（${formatBytes(Number(media.size))} > ${formatBytes(limit)}）`;
      fileByteCache.set(cacheKey, { ...entry, at: Date.now() });
      trimFileByteCache();
      return entry;
    }
    if (needBytes) {
      try {
        const got = await fetchQQFileBytes(media, key, { maxBytes: limit });
        entry.buffer = got.buffer;
        entry.mime = got.mime;
        entry.via = got.via;
        entry.bytes = got.buffer.length;
      } catch (error) {
        entry.error = String(error?.message ?? error);
        fileByteCache.set(cacheKey, { ...entry, at: Date.now() });
        trimFileByteCache();
        return entry;
      }
    }
    if (wantSave && entry.buffer) {
      try {
        entry.saved = saveFileToDownloadDir(entry.buffer, entry.name);
        entry.name = entry.saved.name;
      } catch (error) {
        entry.error = `另存失败：${error?.message ?? error}`;
      }
    }
    fileByteCache.set(cacheKey, { ...entry, at: Date.now() });
    trimFileByteCache();
    return entry;
  }

  /**
   * 上传白名单根目录：默认「会话工作区 + files.dir」，配置 files.uploadRoots 可追加。
   * 上传是出站能力，白名单比下载更严格——只有这些目录里的真实文件可以发给 QQ。
   */
  function uploadRootsAbs() {
    const roots = [
      cfg.sessionCwd ? path.resolve(String(cfg.sessionCwd)) : path.join(stateDir, 'agents'),
      resolveDownloadDir(cfg.files?.dir, root)
    ];
    const extra = Array.isArray(cfg.files?.uploadRoots) ? cfg.files.uploadRoots : [];
    for (const entry of extra) {
      const resolved = resolveDownloadDir(entry, root);
      if (resolved) roots.push(resolved);
    }
    return [...new Set(roots)];
  }

  /**
   * 把本地文件上传到 QQ：群聊走 upload_group_file（进群文件），私聊走 upload_private_file。
   * 路径必须落在 uploadRootsAbs() 内（realpath 校验，防穿越/软链逃逸），大小受 files.maxBytes 约束。
   * 群文件上传后会尝试用群文件列表按「名字+大小」确认落地；私聊只能以网关返回的 file_id 为准。
   */
  async function uploadLocalFileToQQ(key, rawPath, { name = '' } = {}) {
    const target = parseTargetKey(key);
    if (!target) { const error = new Error('key 格式应为 group:群号 或 private:QQ号'); error.client = true; throw error; }
    const limit = Number(cfg.files?.maxBytes) > 0 ? Number(cfg.files.maxBytes) : DEFAULT_MAX_FILE_BYTES;
    let picked;
    try {
      picked = resolveUploadPath(rawPath, {
        roots: uploadRootsAbs(),
        cwd: cfg.sessionCwd ? String(cfg.sessionCwd) : process.cwd()
      });
    } catch (error) {
      error.client = true; // 路径/白名单问题 → 400，不是网关故障
      throw error;
    }
    if (picked.size > limit) {
      const error = new Error(`文件超过上限（${formatBytes(picked.size)} > ${formatBytes(limit)}）`);
      error.client = true;
      throw error;
    }
    const displayName = sanitizeQQFileName(name || picked.name);
    const action = target.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
    const params = target.kind === 'group'
      ? { group_id: Number(target.id), file: picked.path, name: displayName }
      : { user_id: Number(target.id), file: picked.path, name: displayName };
    // 上传可能传很久：单次请求预算给到 5 分钟（SDK 默认 30s 不够）。
    const raw = await getBot().request(action, params, { timeoutMs: 300000 });
    if (raw?.status && raw.status !== 'ok') throw new Error(`网关拒绝 ${action}：${raw.wording || raw.retcode}`);
    if (Number(raw?.retcode ?? 0) !== 0) throw new Error(`网关拒绝 ${action}：${raw.wording || raw.retcode}`);
    const data = raw?.data ?? raw ?? {};
    const fileId = data?.file_id ? String(data.file_id) : null;
    let verified = null;
    if (target.kind === 'group') {
      try {
        const { files } = await listGroupFiles(Number(target.id), { recursive: true, maxFolders: 20 });
        verified = !!pickGroupFileFromList(files, { name: displayName, size: picked.size });
      } catch {
        verified = null; // 列表查不到不影响「已上传」这个事实，只表示未能验证
      }
    }
    return { key: `${target.kind}:${target.id}`, name: displayName, size: picked.size, fileId, verified };
  }

  return {
    fileConfig,
    fileCacheKey,
    trimFileByteCache,
    downloadDirAbs,
    saveFileToDownloadDir,
    listGroupFiles,
    findGroupFileByMeta,
    fetchQQFileBytes,
    ensureQQFile,
    uploadRootsAbs,
    uploadLocalFileToQQ
  };
}
