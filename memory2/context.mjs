// What a work turn gets from memory2 — the EverOS read path: the user profile (user.md) plus the memories that a hybrid search
// finds for this turn's topic, instead of a fixed block of cues. Episodes are shown as a title plus the atomic facts that matched
// (EverOS "hierarchy" idea: facts are the precise hits, the episode is their parent); the full episode is one `memory2 show` away.
// Only calibrated (LR) scores gate what is injected: without vectors there is no calibrated score, so only the profile is injected.
import { Searcher } from './search.mjs';
import { readProfile } from './profile.mjs';
import { estimateTokens, localDate } from './extract.mjs';
import { memoryTextV2 } from '../prompts/templates.mjs';
import { readLedger, weightOf } from './ledger-store.mjs';

// minScore gates facts and episodes with matching facts; an episode that matches only as a whole (no fact hit) must clear snippetMinScore,
// because whole-episode similarity is the weakest evidence.
// Calibrated on 117 real user messages (Oct 22-24) against the backfilled store: best-fact scores >= 0.5 were clear topic hits, 0.3-0.5 mostly relevant,
// below 0.3 content-free messages ("@Codex 来做") started matching by accident. The first calibration (short topical queries) said 0.2 and injected for 84% of messages.
export const CONTEXT_DEFAULTS = { minScore: 0.3, snippetMinScore: 0.5, episodePool: 4, factPool: 8, maxGroups: 3, factsPerGroup: 3, tokens: 1000, pinnedTokens: 400, profileItems: 8, profileTokens: 450, implicitTraits: false, retrieval: 'hierarchy', hierarchyTopK: 10 };
const q = s => String(s).replaceAll("'", "''");

// implicit_traits are LLM inferences about the person (some are about moods and closeness); they are only injected when memory_v2.context.implicitTraits is true.
export function renderProfile(profile, { items = CONTEXT_DEFAULTS.profileItems, implicit = CONTEXT_DEFAULTS.implicitTraits, budget = CONTEXT_DEFAULTS.profileTokens } = {}) {
  if (!profile) return '';
  // Choose whole profile records; a budget never changes a record's wording.
  const lines = [], omitted = []; let used = 0;
  const add = (line, source) => { const c = estimateTokens(line); if (used + c > budget) { omitted.push(source); return false; } used += c; lines.push(line); return true; };
  const first = profile.explicit_info.find(it => it?.description)?.description;
  // The summary is the first explicit item's description by construction (everalgo _build_summary): do not print it twice.
  if (profile.summary && profile.summary !== '(no summary)' && profile.summary !== first) add(profile.summary, 'summary');
  profile.explicit_info.forEach((it, i) => {
    if (!it?.description) return;
    const source = `explicit_info[${i}]`;
    if (i >= items) omitted.push(source);
    else add(`- ${it.category ? it.category + '：' : ''}${it.description}`, source);
  });
  if (implicit) profile.implicit_traits.forEach((it, i) => {
    if (!it?.trait && !it?.description) return;
    const source = `implicit_traits[${i}]`;
    if (i >= items) omitted.push(source);
    else add('推断的倾向（推测，不是用户说过的）：' + (it.trait || it.description), source);
  });
  if (omitted.length) lines.push(`（本轮未载入画像条目：${omitted.join('、')}；memory2 show profile 可读全文）`);
  return lines.join('\n');
}

const groupOf = (ep, score) => ({ entry_id: ep.entry_id, score, subject: ep.subject, ms: ep.timestamp_ms, text: String(ep.summary || ep.episode || ''), textKind: ep.summary ? '摘要' : '原文', facts: [] });

// EverOS default retrieval (hierarchy): episodes by BM25 + vector, their facts compete for the top-K by calibrated probability (heap_expand).
// A fact brings its episode in as the group header; an episode that stays in the top-K without any fact is a snippet-only group.
async function hierarchyGroups(searcher, owner, text, c) {
  const r = await searcher.hierarchy({ owner_id: owner, query: text, topK: c.hierarchyTopK, factsPerEpisode: c.factsPerGroup });
  const groups = new Map();
  for (const it of r.items) {
    if (it.type === 'episode') { if (!groups.has(it.row.entry_id)) groups.set(it.row.entry_id, groupOf(it.row, it.score)); continue; }
    const ep = r.episodes.get(it.parent_episode_id);
    if (it.score < c.minScore) continue;
    const g = groups.get(ep.entry_id) || groupOf(ep, it.score);
    g.score = Math.max(g.score, it.score); g.facts.push(it.row.fact); groups.set(ep.entry_id, g);
  }
  return groups;
}

// The first version (kept for comparison): episodes and facts searched separately, grouped by parent id afterwards.
async function flatGroups(searcher, index, owner, text, c) {
  const [eps, facts] = await Promise.all([
    searcher.search({ owner_id: owner, query: text, topK: c.episodePool, minScore: c.minScore }),
    searcher.search({ owner_id: owner, query: text, kind: 'atomic_fact', topK: c.factPool, minScore: c.minScore })]);
  const groups = new Map();
  for (const e of eps.items) groups.set(e.entry_id, groupOf(e, e.score));
  for (const f of facts.items) {
    const g = groups.get(f.parent_id) || { entry_id: f.parent_id, score: f.score, facts: [] };
    g.score = Math.max(g.score, f.score); g.facts.push(f.fact); groups.set(f.parent_id, g);
  }
  const missing = [...groups.values()].filter(g => !g.subject).map(g => g.entry_id);
  if (missing.length) {
    const table = await index.table('episode');
    const rows = await table.query().where(`owner_id = '${q(owner)}' AND deprecated_by IS NULL AND entry_id IN (${missing.map(m => `'${q(m)}'`).join(',')})`)
      .select(['entry_id', 'subject', 'timestamp_ms', 'summary', 'episode']).limit(100).toArray();
    const by = new Map(rows.map(r => [r.entry_id, r]));
    for (const id of missing) { const r = by.get(id), g = groups.get(id); if (!r) groups.delete(id); else Object.assign(g, groupOf(r, g.score), { facts: g.facts }); }
  }
  return groups;
}

// Standing block: episodes the owner pinned (ledger) are shown in every turn whatever the query is, because a topic search never brings back
// the few things that should not depend on the topic ("how she asks to be treated", "the lesson I already paid for"). Only the subject line is
// shown — the body is one `memory2 show` away — and the marker is （常驻）, not （相关度 …）, so ledger.parseInjected does not count these as matches.
// The budget is the old system's standing-entry budget (400), enough for the handful of pins a person actually sets; if it ever overflows, the
// block says how many are left out instead of quietly dropping the newest ones.
async function standingLines({ index, owner, ledger, budget }) {
  const ids = (ledger.pinned || []).filter(Boolean);
  if (!ids.length) return [];
  const table = await index.table('episode');
  const rows = await table.query().where(`owner_id = '${q(owner)}' AND deprecated_by IS NULL AND entry_id IN (${ids.map(i => `'${q(i)}'`).join(',')})`)
    .select(['entry_id', 'subject', 'timestamp_ms']).limit(100).toArray();
  const by = new Map(rows.map(r => [r.entry_id, r])), lines = [];
  let used = 0, omitted = 0;
  for (const id of ids) {
    const r = by.get(id);
    if (!r) continue;
    const line = `${localDate(r.timestamp_ms)} 《${r.subject || '无标题'}》 [${id}]（常驻）`;
    const cost = estimateTokens(line);
    if (used + cost > budget) { omitted++; continue; }
    used += cost; lines.push(line);
  }
  if (omitted) lines.push(`（另有 ${omitted} 条常驻记忆，本轮未列出：memory2 ledger 可见）`);
  return lines;
}

export async function buildContext({ owner, query, root, index, config = {}, now = Date.now() }) {
  const c = { ...CONTEXT_DEFAULTS, ...config };
  const profileText = renderProfile(readProfile(root, owner), { items: c.profileItems, implicit: c.implicitTraits, budget: c.profileTokens });
  const out = { ids: [], groups: [], mode: 'none', omitted: 0, omitted_ids: [], profile: !!profileText };
  const ledger = readLedger(root);
  const parts = [memoryTextV2.header(owner)];
  if (profileText) parts.push(memoryTextV2.profileHeading(), profileText);
  const standing = await standingLines({ index, owner, ledger, budget: c.pinnedTokens });
  if (standing.length) parts.push(memoryTextV2.standingHeading(), standing.join('\n'));
  let recalled = [];
  const text = String(query ?? '').trim();
  if (text && index.embedder) {
    const searcher = new Searcher(index);
    out.mode = 'hybrid';
    const groups = c.retrieval === 'flat' ? await flatGroups(searcher, index, owner, text, c) : await hierarchyGroups(searcher, owner, text, c);
    // Reinforcement/forgetting: episodes the assistant has actually used rank higher, long-idle ones lower (ledger.mjs); the gate applies to the weighted score.
    for (const g of groups.values()) g.score *= weightOf(g.ms, ledger.entries[g.entry_id], now);
    const ranked = [...groups.values()].filter(g => g.facts.length ? g.score >= c.minScore : g.score >= c.snippetMinScore).sort((a, b) => b.score - a.score);
    let used = estimateTokens(parts.join('\n')) + 40;
    for (const g of ranked) {
      if (out.groups.length >= c.maxGroups) { out.omitted++; out.omitted_ids.push(g.entry_id); continue; }
      const body = g.facts.length ? g.facts.slice(0, c.factsPerGroup).map(f => `  - ${f}`).join('\n') : `  ${g.textKind}：${g.text}`;
      const line = `${localDate(g.ms)} 《${g.subject || '无标题'}》 [${g.entry_id}]（相关度 ${g.score.toFixed(2)}）\n${body}`;
      const cost = estimateTokens(line);
      if (used + cost > c.tokens) { out.omitted++; out.omitted_ids.push(g.entry_id); continue; }
      used += cost; recalled.push(line); out.groups.push({ entry_id: g.entry_id, score: g.score, facts: Math.min(g.facts.length, c.factsPerGroup) }); out.ids.push(g.entry_id);
    }
  } else if (text) out.mode = 'profile-only';
  parts.push(memoryTextV2.recalledHeading());
  parts.push(recalled.length ? recalled.join('\n') : (out.omitted ? '已检索到相关记忆，本轮仅列来源入口，正文可按需读取。' : out.mode === 'profile-only' ? memoryTextV2.noVectors() : memoryTextV2.noMatch()));
  if (out.omitted_ids.length) parts.push(`未载入正文的相关记忆：${out.omitted_ids.join('、')}；用 memory2 show <id> 读取完整条目。`);
  out.text = parts.join('\n');
  out.estimated_tokens = estimateTokens(out.text);
  return out;
}
