// User profile for memory2 — a Node port of EverOS (Apache-2.0):
//   everalgo user_memory/profile.py (ProfileExtractor INIT / UPDATE ops / COMPACT) + prompts/zh/profile.py,
//   everos memory/strategies/extract_user_profile.py (_persist_profile), infra/persistence/markdown/writers/profile_writer.py.
// The profile describes the human user (explicit_info = stated facts, implicit_traits = inferred tendencies) and lives in one
// rewritten file, users/<owner>/user.md. Each owner builds it from the conversations that owner took part in.
import fs from 'node:fs';
import { readMarkdown, writeDocument } from './md.mjs';
import { PROMPTS, USER_LABEL, renderPrompt, extractJsonObject, buildMemCells, tuning } from './extract.mjs';

export const PROFILE_MAX_ITEMS = 30, PROFILE_COMPACT_THRESHOLD = Math.floor(PROFILE_MAX_ITEMS * 1.5);
const pad = n => String(n).padStart(2, '0');
const stamp = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const speakerName = m => m.role === 'user' ? USER_LABEL : (({ claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' })[m.provider] || m.provider || '助手');

// "[YYYY-MM-DD HH:MM:SS] speaker(user_id:xxx): text" — the format the upstream prompts expect.
export function renderConversationForProfile(cells) {
  const lines = [];
  for (const cell of cells) for (const m of cell.items) lines.push(`[${stamp(m.ms)}] ${speakerName(m)}(user_id:${m.role === 'user' ? USER_LABEL : speakerName(m)}): ${m.text}`);
  return lines.length ? lines.join('\n') : '(no prior MemCells in the cluster)';
}
export function renderProfileForUpdate(profile) {
  const part = (title, items) => [`=== ${title} ===`, ...items.map((it, i) => `[${i}] ${JSON.stringify(it)}`)];
  return [...part('explicit_info', profile.explicit_info), ...part('implicit_traits', profile.implicit_traits)].join('\n');
}
export function buildSummary(explicit, implicit) {
  for (const it of explicit) if (it && typeof it === 'object' && typeof it.description === 'string' && it.description.trim()) return it.description.trim();
  for (const it of implicit) { const d = it && typeof it === 'object' ? (it.description || it.trait) : null; if (typeof d === 'string' && d.trim()) return d.trim(); }
  return '(no summary)';
}
// add / update / delete on top of the old profile; indices of the two lists are independent; bad ops are ignored, as upstream.
export function applyOps(old, ops, timestampMs) {
  const explicit = [...old.explicit_info], implicit = [...old.implicit_traits];
  for (const op of ops) {
    if (!op || op.action === 'none') continue;
    const target = op.type === 'explicit_info' ? explicit : implicit, i = op.index;
    if (op.action === 'add') { if (op.data && typeof op.data === 'object' && !Array.isArray(op.data)) target.push(op.data); }
    else if (op.action === 'update') { if (Number.isInteger(i) && op.data && typeof op.data === 'object' && i >= 0 && i < target.length) target[i] = { ...target[i], ...op.data }; }
    else if (op.action === 'delete') { if (Number.isInteger(i) && i >= 0 && i < target.length) target.splice(i, 1); }
  }
  return { owner_id: old.owner_id, summary: buildSummary(explicit, implicit), timestamp_ms: timestampMs, explicit_info: explicit, implicit_traits: implicit };
}

async function callJson(llm, prompt, purpose, validate) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return validate(JSON.parse(extractJsonObject(String(await llm(prompt, { purpose }))))); }
    catch (e) { lastError = e; if (attempt === 0) await new Promise(r => setTimeout(r, tuning.retryDelayMs)); }
  }
  throw lastError;
}
const lists = d => {
  if (!('explicit_info' in d) || !('implicit_traits' in d)) throw new Error(`profile response missing required keys: ${Object.keys(d)}`);
  if (!Array.isArray(d.explicit_info) || !Array.isArray(d.implicit_traits)) throw new Error('explicit_info and implicit_traits must be lists');
  return d;
};

// cells: chronologically ordered MemCells (from buildMemCells). oldProfile null -> INIT, else UPDATE (+ COMPACT when it grows past 1.5x the cap).
export async function extractProfile(llm, cells, { owner, target = USER_LABEL, oldProfile = null, prompts = PROMPTS.profile } = {}) {
  if (!cells.length) throw new Error('memcells must contain at least one MemCell');
  if (!cells.some(c => c.items.some(m => m.role === 'user'))) throw new Error(`target ${target} has no message in the provided cells`);
  const timestamp_ms = cells.at(-1).timestamp_ms, conversation = renderConversationForProfile(cells);
  if (!oldProfile) {
    const d = await callJson(llm, renderPrompt(prompts.PROFILE_INITIAL_EXTRACTION_PROMPT, { conversation_text: conversation, target_user: target }), 'memory2-profile-init', lists);
    return { owner_id: owner, summary: buildSummary(d.explicit_info, d.implicit_traits), timestamp_ms, explicit_info: d.explicit_info, implicit_traits: d.implicit_traits };
  }
  const d = await callJson(llm, renderPrompt(prompts.PROFILE_UPDATE_PROMPT, { current_profile: renderProfileForUpdate(oldProfile), conversations: conversation, target_user: target }), 'memory2-profile-update',
    x => { if (!Array.isArray(x.operations)) throw new Error('operations must be a list'); return x; });
  const merged = applyOps(oldProfile, d.operations, timestamp_ms);
  if (merged.explicit_info.length + merged.implicit_traits.length <= PROFILE_COMPACT_THRESHOLD) return merged;
  const total = merged.explicit_info.length + merged.implicit_traits.length;
  const c = await callJson(llm, renderPrompt(prompts.PROFILE_COMPACT_PROMPT, { total_items: total, max_items: PROFILE_MAX_ITEMS,
    profile_text: JSON.stringify({ explicit_info: merged.explicit_info, implicit_traits: merged.implicit_traits }, null, 2) }), 'memory2-profile-compact', lists);
  return { ...merged, summary: buildSummary(c.explicit_info, c.implicit_traits), explicit_info: c.explicit_info, implicit_traits: c.implicit_traits };
}

// ---- user.md (single-file rewrite) ---------------------------------------------------------------------------------------
export function readProfile(root, owner) {
  const file = root.profilePath(owner);
  if (!fs.existsSync(file)) return null;
  const { frontmatter: fm } = readMarkdown(file);
  return { owner_id: fm.user_id || owner, summary: fm.summary || '', timestamp_ms: fm.profile_timestamp_ms || 0, explicit_info: fm.explicit_info || [], implicit_traits: fm.implicit_traits || [] };
}
export function writeProfile(root, owner, p) {
  writeDocument(root.profilePath(owner), { id: `profile_${owner}`, type: 'user_profile', schema_version: 1, user_id: owner, track: 'user', summary: p.summary,
    explicit_info: p.explicit_info, implicit_traits: p.implicit_traits, profile_timestamp_ms: p.timestamp_ms }, p.summary.endsWith('\n') ? p.summary : p.summary + '\n');
}

// Bring user.md up to date from sessions: cells newer than the profile's timestamp are fed in chronological batches (<= batchChars each).
// Each batch is one LLM call; a failing batch stops the run (the profile keeps the last good state, so the next run resumes there).
export async function updateProfile({ owner, root, sessions, llm, batchChars = 24000, maxCalls = Infinity, cell: cellOptions = {} }) {
  let profile = readProfile(root, owner), calls = 0, cellsUsed = 0;
  const since = profile?.timestamp_ms ?? 0, cells = [];
  for (const s of sessions) if (s.origin !== 'task') cells.push(...buildMemCells(s, owner, { sinceMs: 0, ...cellOptions }).filter(c => c.timestamp_ms > since && c.items.some(m => m.role === 'user')));
  cells.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const report = { owner, pending_cells: cells.length, calls: 0, cells_used: 0, error: null };
  let i = 0;
  while (i < cells.length && calls < maxCalls) {
    const batch = []; let chars = 0;
    while (i < cells.length && (!batch.length || chars + cells[i].items.reduce((a, m) => a + m.text.length, 0) <= batchChars)) { chars += cells[i].items.reduce((a, m) => a + m.text.length, 0); batch.push(cells[i++]); }
    try { profile = await extractProfile(llm, batch, { owner, oldProfile: profile }); writeProfile(root, owner, profile); calls++; cellsUsed += batch.length; }
    catch (e) { report.error = String(e.message).slice(0, 300); break; }
  }
  return { ...report, calls, cells_used: cellsUsed, profile };
}
