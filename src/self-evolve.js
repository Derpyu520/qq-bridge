// 自我调整：风格备忘（style notes）+ 人设提议（role proposals）。
//
// A. 风格备忘：AI 自己记「我最近说话哪里不对」，下一次唤醒会看到，形成缓慢的风格修正。
//    上限 20 条，超了淘汰最旧的；90 天没过问的自动过期。
// B. 人设提议：AI 觉得人设卡该补/该改，写成提议等人批准；一周最多一条，
//    批准后才写进角色卡（由调用方提供 applyToRole），避免它自己放飞。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY = 24 * 3600 * 1000;

export function createSelfEvolve({ stateDir, log = () => {}, applyToRole = null }) {
  const FILE = path.join(stateDir, 'self-evolve.json');
  let data = null;

  function load() {
    if (data) return data;
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      data = {
        styleNotes: Array.isArray(raw?.styleNotes) ? raw.styleNotes : [],
        proposals: Array.isArray(raw?.proposals) ? raw.proposals : []
      };
    } catch {
      data = { styleNotes: [], proposals: [] };
    }
    return data;
  }

  function save() {
    try {
      fs.writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf8');
    } catch (error) {
      log(`[self] 写盘失败：${error?.message ?? error}`);
    }
  }

  const newId = () => `n${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

  /** 加一条风格备忘；返回 { ok, note } 或 { ok:false, error } */
  function addStyleNote(text, { max = 20, maxChars = 120 } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!t) return { ok: false, error: '备忘内容不能为空' };
    const d = load();
    // 同一句就别重复记了
    if (d.styleNotes.some((n) => n.text === t)) return { ok: true, note: d.styleNotes.find((n) => n.text === t), duplicate: true };
    const note = { id: newId(), text: t, createdAt: new Date().toISOString() };
    d.styleNotes.push(note);
    if (d.styleNotes.length > max) d.styleNotes = d.styleNotes.slice(-max);
    save();
    return { ok: true, note };
  }

  function listStyleNotes({ limit = 5, maxAgeDays = 90 } = {}) {
    const d = load();
    const cut = Date.now() - maxAgeDays * DAY;
    const alive = d.styleNotes.filter((n) => Date.parse(n.createdAt || 0) >= cut);
    if (alive.length !== d.styleNotes.length) { d.styleNotes = alive; save(); }
    return alive.slice(-limit);
  }

  function removeStyleNote(id) {
    const d = load();
    const before = d.styleNotes.length;
    d.styleNotes = d.styleNotes.filter((n) => n.id !== id);
    save();
    return before !== d.styleNotes.length;
  }

  /** 提一条人设建议；一周最多一条 */
  function addProposal(text, rationale, { minIntervalDays = 7, max = 20, maxChars = 200 } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!t) return { ok: false, error: '建议内容不能为空' };
    const d = load();
    const last = d.proposals.filter((p) => p.status === 'pending').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (last && Date.now() - Date.parse(last.createdAt) < minIntervalDays * DAY) {
      const days = Math.ceil((minIntervalDays * DAY - (Date.now() - Date.parse(last.createdAt))) / DAY);
      return { ok: false, error: `还有一条待批的建议（${last.text.slice(0, 30)}…），约 ${days} 天后才能再提` };
    }
    const proposal = {
      id: newId(),
      text: t,
      rationale: String(rationale || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    d.proposals.push(proposal);
    if (d.proposals.length > max) {
      // 先丢最老的已决项，没有就丢最老的
      const decided = d.proposals.filter((p) => p.status !== 'pending');
      if (decided.length) {
        const drop = decided[0].id;
        d.proposals = d.proposals.filter((p) => p.id !== drop);
      } else {
        d.proposals = d.proposals.slice(-max);
      }
    }
    save();
    return { ok: true, proposal };
  }

  function listProposals(status = 'all') {
    const d = load();
    const list = status === 'all' ? d.proposals : d.proposals.filter((p) => p.status === status);
    return list.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /** 批准/驳回；批准时调用 applyToRole 写进角色卡 */
  function decideProposal(id, action) {
    const d = load();
    const p = d.proposals.find((x) => x.id === id);
    if (!p) return { ok: false, error: '找不到这条建议' };
    if (p.status !== 'pending') return { ok: false, error: `这条已经是 ${p.status}` };
    if (action === 'approve') {
      if (typeof applyToRole !== 'function') return { ok: false, error: '当前环境不能写角色卡' };
      try {
        applyToRole(p.text);
      } catch (error) {
        return { ok: false, error: `写角色卡失败：${error?.message ?? error}` };
      }
      p.status = 'approved';
    } else if (action === 'reject') {
      p.status = 'rejected';
    } else {
      return { ok: false, error: 'action 只能是 approve / reject' };
    }
    p.decidedAt = new Date().toISOString();
    save();
    return { ok: true, proposal: p };
  }

  /** 每天扫一次：清掉过期备忘，pending 超 60 天的标记 expired */
  function sweep({ maxAgeDays = 90, proposalExpireDays = 60 } = {}) {
    const d = load();
    const now = Date.now();
    const beforeNotes = d.styleNotes.length;
    d.styleNotes = d.styleNotes.filter((n) => now - Date.parse(n.createdAt || 0) < maxAgeDays * DAY);
    let expired = 0;
    for (const p of d.proposals) {
      if (p.status === 'pending' && now - Date.parse(p.createdAt) > proposalExpireDays * DAY) {
        p.status = 'expired';
        expired += 1;
      }
    }
    if (beforeNotes !== d.styleNotes.length || expired) save();
    return { removedNotes: beforeNotes - d.styleNotes.length, expiredProposals: expired };
  }

  return { addStyleNote, listStyleNotes, removeStyleNote, addProposal, listProposals, decideProposal, sweep, file: FILE };
}
