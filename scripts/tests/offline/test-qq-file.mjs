// QQ 文件链路自检（离线为主）：
// 1. qq-file-lib 纯函数：目录解析 / 文件名净化（防路径穿越）/ 去重 / 文本判定与解码 / file 段解析
// 2. dsh-client.uploadFile 的 HTTP 形状与错误降级（404 ⇒ unsupported）
// 3. 配置模板、桥接端点、MCP 工具描述的一致性（防“文档写了、代码没接”）
// 4. 可选 live 段：桥接运行中时校验 /api/socialV2/download-file 的安全拒绝逻辑
// 运行：node scripts/tests/offline/test-qq-file.mjs
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigExamplePath } from '../../../src/util/config-path.js';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DOWNLOAD_DIR,
  decodeTextFile,
  describeFileMedia,
  fileNameFromUrl,
  fileMediaFromSegment,
  findSavedDownload,
  isTextLikeFileName,
  pickGroupFileFromList,
  resolveDownloadDir,
  resolveUploadPath,
  sanitizeQQFileName,
  uniqueDownloadPath
} from '../../../src/qq/qq-file-lib.js';
import { NodeApiClient } from '../../../src/dsh/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('## qq-file-lib · 下载目录');
{
  ok(resolveDownloadDir(undefined, ROOT) === path.resolve(ROOT, DEFAULT_DOWNLOAD_DIR), '默认目录相对仓库根');
  ok(resolveDownloadDir('state/downloads', ROOT) === path.resolve(ROOT, 'state/downloads'), '相对路径按仓库根解析');
  const abs = path.join(os.tmpdir(), 'qq-bridge-dl');
  ok(resolveDownloadDir(abs, ROOT) === path.resolve(abs), '绝对路径原样使用');
}

console.log('## qq-file-lib · 文件名净化');
{
  ok(sanitizeQQFileName('a/b/c.txt') === 'c.txt', '去掉路径只留 basename');
  ok(sanitizeQQFileName('..\\..\\evil.txt') === 'evil.txt', '拒绝 Windows 路径穿越');
  ok(sanitizeQQFileName('../../etc/passwd') === 'passwd', '拒绝 POSIX 路径穿越');
  ok(sanitizeQQFileName('a<b>c:d"e|f?g*h.txt') === 'a_b_c_d_e_f_g_h.txt', '替换 Windows 非法字符');
  ok(sanitizeQQFileName('') === 'qq-file', '空名回退');
  ok(sanitizeQQFileName('...') === 'qq-file', '全点回退');
  ok(sanitizeQQFileName('CON.txt') === '_CON.txt', '避开 Windows 保留设备名');
  ok(sanitizeQQFileName('报告.txt?x=1') === '报告.txt', '去掉 URL 查询串残留');
  ok(sanitizeQQFileName('x'.repeat(300) + '.txt').length <= 120, '超长名截断');
  ok(!sanitizeQQFileName('a/b.txt').includes('/'), '净化结果不含分隔符');
}

console.log('## qq-file-lib · 落盘去重');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-dl-'));
  try {
    const first = uniqueDownloadPath(dir, 'note.txt');
    ok(path.basename(first) === 'note.txt', '首个文件用原名');
    fs.writeFileSync(first, 'x');
    const second = uniqueDownloadPath(dir, 'note.txt');
    ok(path.basename(second) === 'note-2.txt', '重名加 -2 后缀');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('## qq-file-lib · 已下载复用');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-saved-'));
  try {
    fs.writeFileSync(path.join(dir, 'big.zip'), Buffer.alloc(1024));
    ok(findSavedDownload(dir, 'big.zip', 1024)?.name === 'big.zip', '同名同大小命中已有下载');
    ok(findSavedDownload(dir, 'big.zip', 1023) === null, '大小不同不复用');
    ok(findSavedDownload(dir, 'missing.zip', 1024) === null, '不存在返回 null');
    ok(findSavedDownload(dir, 'big.zip', 0) === null, '大小未知不猜');
    fs.writeFileSync(path.join(dir, 'a b.txt'), 'x');
    ok(findSavedDownload(dir, 'a b.txt', 1)?.name === 'a b.txt', '文件名按净化后的名字检查');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('## qq-file-lib · 文本判定与解码');
{
  ok(isTextLikeFileName('a.txt') && isTextLikeFileName('B.MD'), '文本扩展名命中');
  ok(!isTextLikeFileName('a.exe') && !isTextLikeFileName('noext'), '二进制/无扩展名不命中');
  const utf8 = decodeTextFile(Buffer.from('你好\n世界', 'utf8'));
  ok(utf8.text === '你好\n世界' && utf8.encoding === 'utf-8', 'UTF-8 解码');
  const gbk = decodeTextFile(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  ok(gbk.text === '你好' && gbk.encoding === 'gbk', 'GBK 回退解码');
  const truncated = decodeTextFile(Buffer.from('abcdef', 'utf8'), { maxChars: 3 });
  ok(truncated.text === 'abc' && truncated.truncated === true, '按 maxChars 截断');
  const binary = decodeTextFile(Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  ok(binary.encoding === 'binary' && binary.text === '', 'NUL 内容识别为非文本');
  const crlf = decodeTextFile(Buffer.from('a\r\nb', 'utf8'));
  ok(crlf.text === 'a\nb', '换行统一为 \\n');
}

console.log('## qq-file-lib · file 段解析');
{
  const media = fileMediaFromSegment({ file_id: 'fid', busid: 102, name: 'a.zip', size: 1234, url: 'https://x/y' });
  ok(media.kind === 'file' && media.fileId === 'fid' && media.name === 'a.zip' && media.size === 1234, '标准字段');
  const alt = fileMediaFromSegment({ fileId: 'f2', file_name: 'b.txt', file_size: 7 });
  ok(alt.fileId === 'f2' && alt.name === 'b.txt' && alt.size === 7, '兼容 camelCase/file_name/file_size');
  const empty = fileMediaFromSegment(null);
  ok(empty.kind === 'file' && empty.fileId === '' && empty.size === 0, '空输入安全');
  ok(describeFileMedia({ name: 'a.txt', size: 2048 }, (n) => `${n}B`) === '[文件 a.txt 2048B]', '描述格式');
  ok(fileNameFromUrl('https://x/y?filename=%E6%8A%A5%E5%91%8A.pdf') === '报告.pdf', '从 URL 查询串取文件名');
}

console.log('## qq-file-lib · 群文件匹配');
{
  const files = [
    { file_name: 'a.zip', file_id: '/1', busid: 102, file_size: 100 },
    { file_name: 'BOSS OFFICIAL 2.0.html', file_id: '/2', busid: 102, file_size: 3742504 },
    { file_name: 'BOSS OFFICIAL 2.0.html', file_id: '/3', busid: 102, file_size: 10 }
  ];
  ok(pickGroupFileFromList(files, { name: 'BOSS OFFICIAL 2.0.html', size: 3742504 })?.file_id === '/2', '同名同大小精确命中');
  ok(pickGroupFileFromList(files, { name: 'BOSS OFFICIAL 2.0.html', size: 1 }) === null, '同名但大小不符不猜');
  ok(pickGroupFileFromList(files, { name: ' BOSS OFFICIAL 2.0.html ' })?.file_id === '/2', '名字 trim 后匹配、无大小时取第一个同名');
  ok(pickGroupFileFromList(files, { name: '不存在.zip', size: 1 }) === null, '名字不匹配返回 null');
  ok(pickGroupFileFromList(files, {}) === null && pickGroupFileFromList(null, { name: 'a.zip' }) === null, '空输入安全');
}

console.log('## qq-file-lib · 上传路径白名单');
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-up-'));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  try {
    const got = resolveUploadPath('a.txt', { roots: [ws], cwd: ws });
    ok(got.name === 'a.txt' && got.size === 5 && got.path === fs.realpathSync(path.join(ws, 'a.txt')), '工作区内文件可上传（相对路径按 cwd 解析）');
    let denied = false;
    try { resolveUploadPath(path.join(outside, 'secret.txt'), { roots: [ws] }); } catch { denied = true; }
    ok(denied, '工作区外文件被拒绝');
    let dirDenied = false;
    try { resolveUploadPath(ws, { roots: [ws] }); } catch { dirDenied = true; }
    ok(dirDenied, '目录不是可上传文件');
    let missing = false;
    try { resolveUploadPath(path.join(ws, 'nope.txt'), { roots: [ws] }); } catch { missing = true; }
    ok(missing, '不存在的文件被拒绝');
    let noRoots = false;
    try { resolveUploadPath(path.join(ws, 'a.txt'), { roots: [] }); } catch { noRoots = true; }
    ok(noRoots, '没有白名单根目录时拒绝一切');
    let symlinkDenied = false;
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
      try { resolveUploadPath(path.join(ws, 'link.txt'), { roots: [ws] }); } catch { symlinkDenied = true; }
    } catch { symlinkDenied = true; /* Windows 无权限建符号链接：按拒绝处理 */ }
    ok(symlinkDenied, '工作区内软链指向外部被拒绝（realpath）');
    const homeDir = path.join(base, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, 'f.txt'), 'x');
    ok(resolveUploadPath('~/f.txt', { roots: [homeDir], home: homeDir }).name === 'f.txt', '~ 展开后命中白名单');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

console.log('## dsh-client · uploadFile');
{
  const calls = [];
  const client = new NodeApiClient('http://127.0.0.1:3080');
  client.ensureAuth = async () => 'cookie';
  client.doFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, value: { receiptId: 'r1', file: { attachmentId: 'a1', name: 'a.txt', bytes: 3 } } }), { status: 200 });
  };
  const result = await client.uploadFile('sess-1', Buffer.from('abc'), 'a.txt');
  ok(result.receiptId === 'r1', '返回 receiptId');
  ok(calls.length === 1 && calls[0].url.includes('/api/session/uploadFileBinary?') && calls[0].url.includes('sessionId=sess-1'), '请求路径与 sessionId');
  ok(calls[0].url.includes('name=a.txt'), 'name 进查询串');
  ok(calls[0].init.method === 'POST' && calls[0].init.headers['content-type'] === 'application/octet-stream', 'POST + octet-stream');
  ok(Buffer.isBuffer(calls[0].init.body) && calls[0].init.body.length === 3, '原始字节作为 body');

  const notFound = new NodeApiClient('http://127.0.0.1:3080');
  notFound.ensureAuth = async () => 'cookie';
  notFound.doFetch = async () => new Response('not found', { status: 404 });
  let unsupported = false;
  try { await notFound.uploadFile('sess-1', Buffer.from('x'), 'x.txt'); }
  catch (error) { unsupported = error?.unsupported === true; }
  ok(unsupported, '404 ⇒ unsupported 标记（调用方可回退内联）');

  const rejected = new NodeApiClient('http://127.0.0.1:3080');
  rejected.ensureAuth = async () => 'cookie';
  rejected.doFetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'session/not-found', message: 'gone' } }), { status: 200 });
  let rejectedMessage = '';
  try { await rejected.uploadFile('sess-1', Buffer.from('x'), 'x.txt'); }
  catch (error) { rejectedMessage = String(error?.message ?? error); }
  ok(rejectedMessage.includes('session/not-found'), '业务错误透出 code');
}

console.log('## 配置/端点/工具描述一致性');
{
  const example = JSON.parse(fs.readFileSync(resolveConfigExamplePath(ROOT), 'utf8'));
  ok(example.files && example.files.dir === DEFAULT_DOWNLOAD_DIR, 'config.example.json 含 files.dir');
  ok(example.files?.intoContext === true && example.files?.inlineText === true, '模板默认开启附件 + 内联');
  ok(example.files?.inlineMode === 'always', "模板 inlineMode 默认 'always'");
  ok(example.files?.maxInlineTotalChars === 40000, '模板含单条消息内联总量上限');
  ok(example.socialV2?.tools?.downloadFile === true, '模板含 socialV2.tools.downloadFile');

  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  // QQ 文件服务已拆到 src/qq/qq-file.js：涉及抓取/缓存/群文件回退的源码断言看两份合并。
  const qqFileSrc = fs.readFileSync(path.join(ROOT, 'src/qq/qq-file.js'), 'utf8');
  const all = `${bridge}\n${qqFileSrc}`;
  ok(bridge.includes('/api/socialV2/download-file'), '桥接注册了下载端点');
  ok(bridge.includes("v2ToolEnabled('downloadFile')"), '下载端点受工具开关约束');
  ok(bridge.includes('api.uploadFile('), '投递链路调用 DSH 文件上传');
  // 群文件不是图片：曾用 safeFetchBuffer（图片签名校验）抓 HTML/ZIP 全部失败。
  ok(all.includes('safeFetchBytes('), '文件抓取走 safeFetchBytes（不校验图片签名）');
  ok(all.includes('findGroupFileByMeta') && all.includes('pickGroupFileFromList('), '群文件 id 不存在时按名字+大小回退群文件列表');
  ok(all.includes('findSavedDownload('), '已有同名同大小文件时复用，不重复下载');
  ok(/文件下载失败：\$\{detail\}/.test(bridge) || bridge.includes('error: `文件下载失败：${detail}`'), '下载失败把 files[].error 提升成顶层 error');
  ok(bridge.includes('文件下载失败 ${key} ${messageId}: ${detail}'), '下载失败写进桥接日志');
  ok(bridge.includes("ensureQQFile(fileMedia, key)"), '收到文件时自动另存');
  ok(bridge.includes('promptWithoutFilePartsIfRejected'), '附件被拒时有内联降级重投');
  ok(/item\.fileId = String\(m\.fileId\)/.test(bridge) && /if \(m\.kind === 'file'\) return !!/.test(bridge), '二代消息表保留文件定位字段');
  // 关键语义（实测 DSH 结论）：{type:'file'} 只给模型一段带路径的 handle 文本，字节不会进模型；
  // 所以默认必须是「上传附件的同时总是内联文本正文」，而不是只在附件失败时兜底。
  ok(/inlineMode: 'always'/.test(bridge), "默认 inlineMode 是 'always'");
  ok(/inlineMode === 'always' \|\| \(inlineMode === 'fallback' && !attached\)/.test(bridge), '内联判定与 inlineMode 一致');
  ok(bridge.includes('This is the only representation a provider ever receives for a file'), '代码里留了 DSH 投影结论的出处');
  ok(bridge.includes('只读副本') || bridge.includes('内容未进入上下文'), '二进制文件明确告知内容未进上下文');
  ok(/inlineMode === 'always'/.test(bridge) && /fileConfig\(\)\.inlineText === false \? 'off'/.test(bridge), 'inlineText=false 等价于 off');
  ok(bridge.includes('maxInlineTotalChars'), '单条消息内联总量受 maxInlineTotalChars 约束');

  ok(bridge.includes('/api/socialV2/group-files'), '群文件列表端点已注册');
  ok(bridge.includes('/api/socialV2/download-group-file'), '群文件下载端点已注册');
  ok(bridge.includes("v2ToolEnabled('listGroupFiles')"), '群文件列表受工具开关约束');
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp/mcp-snowluma-safe.js'), 'utf8');
  ok(mcp.includes("'qq_list_group_files'"), 'MCP 暴露 qq_list_group_files');
  ok(mcp.includes("'qq_download_group_file'"), 'MCP 暴露 qq_download_group_file');
  ok(mcp.includes("'qq_download_file'"), 'MCP 暴露 qq_download_file');
  ok(mcp.includes("qq_download_file: 'downloadFile'"), 'MCP 注册期按开关过滤');

  const consoleHtml = fs.readFileSync(path.join(ROOT, 'work/console.html'), 'utf8');
  ok(consoleHtml.includes('data-v2-tool="downloadFile"'), '控制台有下载工具开关');
  ok(consoleHtml.includes('data-v2-tool="listGroupFiles"'), '控制台有群文件列表开关');
  ok(bridge.includes('/api/socialV2/upload-file') && bridge.includes('uploadLocalFileToQQ'), '桥接注册了上传端点');
  ok(bridge.includes("v2ToolEnabled('uploadFile')"), '上传端点受工具开关约束');
  ok(bridge.includes('uploadPresets') && bridge.includes('sessionPreset'), '上传按会话实际 preset 判定（qq-chat-tools / closed-agent 才允许）');
  ok(mcp.includes("'qq_upload_file'"), 'MCP 暴露 qq_upload_file');
  ok(consoleHtml.includes('data-v2-tool="uploadFile"'), '控制台有上传工具开关');
}

console.log('## 可选：桥接端点安全拒绝（需桥接运行中）');
{
  const port = 3100;
  const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
  if (fs.existsSync(consoleTokenFile)) {
    const token = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/download-file?key=bad&messageId=1`, {
        headers: { 'x-console-token': token },
        signal: AbortSignal.timeout(5000)
      });
      const body = await res.json().catch(() => ({}));
      ok(res.status === 400 || body.ok === false, '非法 key 被拒绝', `HTTP ${res.status}`);
    } catch (error) {
      console.log(`  ⚠️ 跳过 live 检查（桥接可能未运行）：${error?.message ?? error}`);
    }
  } else {
    console.log('  ⚠️ 跳过 live 检查：缺少 state/console-token');
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
