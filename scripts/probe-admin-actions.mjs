// 管理员动作探针：验证 SnowLuma 网关对「改群名片」这类动作的真实支持度。
//
// 默认**只读**：列群、读自己在群里的名片、读登录信息，不写任何东西。
// 加 --apply 才会真的改：把名片改成探针值 → 回读校验 → 改回原值 → 回读校验。
//
// 为什么必须先探针再做功能：
//   `_snowluma-catalog.json` 里写了 set_group_card / set_qq_avatar 这些动作，
//   但「目录里有」不等于「这台网关上真能改」——协议限制、权限不足、返回 ok 但没生效
//   都是常见情况。功能设计建立在「能改」之上，这一步失败的话整条路线要重估。
//
// 用法：
//   node scripts/probe-admin-actions.mjs                 # 只读盘点
//   node scripts/probe-admin-actions.mjs --apply         # 真改一次（改完立刻还原）
//   node scripts/probe-admin-actions.mjs --apply --group 123456781
//   node scripts/probe-admin-actions.mjs --apply-profile   # 昵称往返（改完立刻还原）
//   node scripts/probe-admin-actions.mjs --apply-avatar    # 头像：换成 assets 图后立刻用原头像 URL 还原
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const APPLY_PROFILE = args.includes('--apply-profile');
const APPLY_AVATAR = args.includes('--apply-avatar');
const groupArg = (() => {
  const i = args.indexOf('--group');
  return i >= 0 ? String(args[i + 1] ?? '').trim() : '';
})();
const avatarFileArg = (() => {
  const i = args.indexOf('--avatar-file');
  return i >= 0 ? String(args[i + 1] ?? '').trim() : 'assets/deepseek娘.png';
})();

function loadConfig() {
  let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const cfg = loadConfig();
const baseHttp = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken ?? '';

async function onebot(action, params = {}) {
  const res = await fetch(`${baseHttp}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '（HTTP 426：httpUrl 可能指向了 WS 端口）' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body?.status !== 'ok' || body?.retcode !== 0) {
    throw new Error(`retcode=${body?.retcode} ${body?.wording ?? body?.message ?? ''}`.trim());
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`);
}

async function readCard(groupId, userId) {
  const info = await onebot('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: true });
  return String(info?.card ?? '');
}

async function main() {
  console.log(`网关: ${baseHttp}  模式: ${APPLY ? '写（改完立刻还原）' : '只读'}\n`);

  const login = await onebot('get_login_info');
  const selfId = String(login?.user_id ?? '');
  console.log(`登录账号: ${selfId}（${login?.nickname ?? ''}）`);
  if (!selfId) throw new Error('get_login_info 没返回 user_id');

  const allowGroups = (cfg.allow?.groups ?? []).map(String);
  const rawGroups = await onebot('get_group_list', { no_cache: true });
  const groups = (Array.isArray(rawGroups) ? rawGroups : (rawGroups?.data ?? []))
    .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? '') }));
  console.log(`机器人加入的群: ${groups.length} 个；白名单 ${allowGroups.length} 个`);

  const candidates = groups.filter((g) => allowGroups.includes(g.id));
  if (!candidates.length) {
    record('找到可测的群', false, '白名单群与机器人实际所在的群没有交集');
    return;
  }
  for (const g of candidates) console.log(`  候选群 ${g.id}  ${g.name}`);

  let target = candidates[0];
  if (groupArg) {
    const hit = candidates.find((g) => g.id === groupArg);
    if (!hit) throw new Error(`群 ${groupArg} 不在白名单或机器人不在群里`);
    target = hit;
  }
  // 优先挑人少的群，减少名片变动的可见面
  let memberCount = null;
  try {
    const detail = await onebot('get_group_info', { group_id: Number(target.id), no_cache: true });
    memberCount = Number(detail?.member_count ?? detail?.memberCount ?? NaN);
    if (Number.isFinite(memberCount)) console.log(`\n目标群 ${target.id}「${target.name}」成员数 ${memberCount}`);
  } catch (error) {
    console.log(`\n目标群 ${target.id}「${target.name}」（读群信息失败：${error?.message ?? error}）`);
  }

  const before = await readCard(target.id, selfId);
  record('读取当前群名片', true, before ? `「${before}」` : '（空）');

  if (!APPLY && !APPLY_PROFILE && !APPLY_AVATAR) {
    console.log('\n只读模式结束。可选：--apply（群名片） / --apply-profile（昵称） / --apply-avatar（头像），都会改完立刻还原。');
    return;
  }

  if (APPLY) {
    const probeCard = '鲸鱼探针';
    let wrote = false;
    try {
      await onebot('set_group_card', { group_id: Number(target.id), user_id: Number(selfId), card: probeCard });
      wrote = true;
      await sleep(1500);
      const afterWrite = await readCard(target.id, selfId);
      const writeOk = afterWrite === probeCard;
      record('set_group_card 写入生效', writeOk, writeOk ? `现在是「${afterWrite}」` : `回读是「${afterWrite}」，与期望「${probeCard}」不一致（网关返回 ok 但没生效）`);
    } catch (error) {
      record('set_group_card 写入', false, error?.message ?? String(error));
    } finally {
      if (wrote) {
        try {
          // 这张网关上「清空名片」会被拒（OIDB 1007，通常需要群管理权限）。
          // 原名片为空时改成机器人昵称——显示上完全等价（没名片时 QQ 也显示昵称）。
          const loginForRestore = before ? null : await onebot('get_login_info');
          const restoreCard = before || String(loginForRestore?.nickname ?? '');
          if (!restoreCard) throw new Error('原名片为空且读不到昵称，无法还原');
          await onebot('set_group_card', { group_id: Number(target.id), user_id: Number(selfId), card: restoreCard });
          await sleep(1500);
          const afterRestore = await readCard(target.id, selfId);
          const restoreOk = afterRestore === restoreCard;
          record(
            '还原原名片',
            restoreOk,
            restoreOk
              ? (before ? `已还原为「${before}」` : `原名片为空，已改成昵称「${restoreCard}」（显示等价）`)
              : `回读是「${afterRestore}」，期望「${restoreCard}」——需要手工改回`
          );
        } catch (error) {
          record('还原原名片', false, `${error?.message ?? error}（原值「${before}」，请手工改回）`);
        }
      }
    }
  }

  // ── QQ 昵称往返 ──────────────────────────────────────────────────────────
  // SnowLuma 的 SetProfile 对缺省字段是"跳过"（见 index.mjs 的 serialize）——
  // 所以只传 nickname 不会清掉个性签名；还原时同样只传 nickname。
  if (APPLY_PROFILE) {
    const loginNow = await onebot('get_login_info');
    const beforeNick = String(loginNow?.nickname ?? '');
    record('读取当前昵称', Boolean(beforeNick), beforeNick || '（空）');
    if (beforeNick) {
      const probeNick = `${beforeNick}·探针`;
      // ⚠️ get_login_info 是登录时缓存，改完不会变（实测）。校验必须走 get_stranger_info。
      const readNick = async () => {
        try {
          const fresh = await onebot('get_stranger_info', { user_id: Number(selfId) });
          return String(fresh?.nickname ?? '');
        } catch {
          return String((await onebot('get_login_info'))?.nickname ?? '');
        }
      };
      let nickWrote = false;
      try {
        await onebot('set_qq_profile', { nickname: probeNick });
        nickWrote = true;
        await sleep(1500);
        const now = await readNick();
        record('set_qq_profile 写入生效', now === probeNick, now === probeNick ? `现在是「${now}」` : `回读是「${now}」，与期望「${probeNick}」不一致`);
      } catch (error) {
        record('set_qq_profile 写入', false, error?.message ?? String(error));
      } finally {
        if (nickWrote) {
          try {
            await onebot('set_qq_profile', { nickname: beforeNick });
            await sleep(1500);
            const back = await readNick();
            record('还原原昵称', back === beforeNick, back === beforeNick ? `已还原为「${back}」` : `回读是「${back}」，原值「${beforeNick}」——请手动改回`);
          } catch (error) {
            record('还原原昵称', false, `${error?.message ?? error}（原值「${beforeNick}」，请手动改回）`);
          }
        }
      }
    }
  }

  // ── QQ 头像 ─────────────────────────────────────────────────────────────
  // 验证两件事：① 本地文件路径能被接受并真的走完上传；② 改完能用 qlogo URL 还原
  // （SnowLuma 的 loadBinarySource 支持 http(s):// 与 base64://，所以还原路径可靠）。
  if (APPLY_AVATAR) {
    const abs = path.resolve(ROOT, avatarFileArg);
    const restoreUrl = `https://q.qlogo.cn/g?b=qq&nk=${selfId}&s=640`;
    if (!fs.existsSync(abs)) {
      record('找到头像素材', false, `${avatarFileArg} 不存在`);
    } else {
      let avatarWrote = false;
      try {
        await onebot('set_qq_avatar', { file: abs });
        avatarWrote = true;
        record('set_qq_avatar 上传本地文件', true, `${avatarFileArg}（网关返回 ok，无法回读校验，请肉眼确认）`);
      } catch (error) {
        record('set_qq_avatar 上传本地文件', false, error?.message ?? String(error));
      } finally {
        try {
          await onebot('set_qq_avatar', { file: restoreUrl });
          record('用原头像 URL 还原', true, restoreUrl);
        } catch (error) {
          record('用原头像 URL 还原', false, `${error?.message ?? error}${avatarWrote ? '——头像可能停在探针图，请手动换回' : ''}`);
        }
      }
    }
  }
}

main()
  .catch((error) => {
    record('探针整体', false, error?.message ?? String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nRESULT: ${failed.length ? `FAILED(${failed.length})` : 'OK'}`);
  });
