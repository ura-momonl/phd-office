// LLM-guided multi-round recall for memory2 — a Node port of EverOS memory/search/llm_multiround.py (Apache-2.0):
// each round every current sub-query is recalled (BM25 + vector) and fused with RRF INDEPENDENTLY into its own block; a decider shows the blocks with
// one global index, picks the core items that could carry the answer, and either stops or names one focused sub-query per still-missing aspect.
// The final list is core-first, then each sub-query's best non-core item, then a fill by MAX RRF score across sub-queries. No cross-encoder (upstream
// measured it net-negative).
// Deliberately NOT on the per-turn injection path: it costs 1..maxRounds model calls per query, so it is for explicit recall (`memory2 search`
// with method:"agentic"). Differences from upstream, all for cost or language: smaller blocks (seed 20 / sub-query 10 instead of 50 / 20), one retry
// instead of three, the decider sees subject + a complete existing summary or episode, and sub-queries are asked to stay in the
// language of the question.
import { rrfWith, buildWhere } from './search.mjs';
import { HANDLERS } from './index.mjs';

export const AGENTIC_DEFAULTS = { maxRounds: 3, seedTopk: 20, subqTopk: 10, maxSubqueries: 3, rrfK: 60, patience: 1, guarantee: 1, retries: 1, fallbackCore: 3, topK: 10, pool: 50 };

export const DECIDER_PROMPT = `You steer a multi-round memory search. Reply with ONLY a JSON object.
You are shown a RETRIEVED SUBSET of memory, never all of it. "Not shown here" does NOT mean "not in memory" — it may just not have been retrieved yet.

What you see each round:
- QUESTION: the user's original question (unchanged every round).
- CORE SO FAR: items you already selected in earlier rounds, each tagged with the sub-query that surfaced it ("original question" on round 0). These are ALREADY kept — never re-list them; use them only to judge what is still missing.
- CANDIDATES THIS ROUND: on round 0, ONE block retrieved for the original question; on later rounds, ONE BLOCK PER SUB-QUERY, each headed by that sub-query. Items carry a SINGLE global index across all blocks. The same memory may appear in several blocks — that just means several angles retrieved it.

Do two things:

1. CORE (required): global indices of every candidate shown THIS ROUND that could carry information the answer needs — favour RECALL over minimality.
   - A needed fact (an age, price, date, name, count) is often an INCIDENTAL detail inside an episode about a DIFFERENT topic. Judge by whether the item touches the same PERSON / ENTITY / PLACE / ACTIVITY / TIME-WINDOW the question is about — NOT by whether its headline topic matches.
   - SCAN EVERY BLOCK top to bottom; answer-bearing evidence is often ranked LOW in its block.
   - For a count / total / comparison / ordering, core EVERY item that contributes an instance — a multi-part answer usually needs several items from different sessions.
   - If the SAME memory appears in two blocks, core it ONCE (either index).
   - Return an empty list ONLY when nothing shown touches the question at all.

2. NEXT_QUERIES: KEEP SEARCHING (default) or STOP.
   - STOP (set "next_queries" to []) ONLY when the question is a SINGLE, self-contained fact AND the core you already hold answers it unambiguously.
   - OTHERWISE keep searching: one focused sub-query per still-missing aspect (up to {max_sub}). Each sub-query must NAME the specific entity / aspect no current block has covered — never paraphrase a sub-query already asked, never issue a broad topical query.
   - Write sub-queries in the same language as the question.

Illustrative examples (generic, invented — not real data):

Example 1 (round 0, single fact):
QUESTION: What breed is Nora's cat?
CORE SO FAR: (none)
CANDIDATES THIS ROUND:
[block: original question]
  0: Vet visit - Nora brought her cat Biscuit, a Ragdoll, in for shots.
  1: Weekend plans - Nora said she adopted a cat last spring.
Reply: {"core": [0], "next_queries": []}

Example 2 (later round, running total across sub-queries):
QUESTION: How many marathons has Devin run in total?
CORE SO FAR:
  - [from "Devin marathon 2021"] Devin finished the Lakeside Marathon in 2021.
CANDIDATES THIS ROUND:
[block: Devin marathon 2022 2023]
  0: Race recap - Devin ran the Harbor Marathon in 2022.
  1: Training log - Devin jogged 5 km most weekends.
[block: Devin other marathons]
  2: Trip photos - Devin flew to Berlin and ran its city marathon in 2023.
  3: Race recap - Devin ran the Harbor Marathon in 2022.
Reply: {"core": [0, 2], "next_queries": ["Devin marathon before 2021"]}

QUESTION:
{question}

CORE SO FAR:
{core_so_far}

CANDIDATES THIS ROUND:
{evidence}

Reply with ONLY this JSON object (no prose, no code fences); "core" values are GLOBAL indices into the candidates above:
{"core": [<indices>], "next_queries": ["<q1>", "..."]}`;

// First JSON object in the reply that parses as a dict (tolerates prose and braces around it).
export function parseDecision(text) {
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    for (let j = s.indexOf('}', i); j !== -1; j = s.indexOf('}', j + 1)) {
      try { const o = JSON.parse(s.slice(i, j + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* keep widening */ }
    }
  }
  throw new Error('no JSON object in decider reply: ' + s.slice(0, 120));
}
export function coerceCore(raw, n) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), out = [];
  for (const v of raw) {
    const idx = Number.isInteger(v) ? v : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : null);
    if (idx !== null && idx >= 0 && idx < n && !seen.has(idx)) { seen.add(idx); out.push(idx); }
  }
  return out;
}

const textOf = c => `${c.row.subject || ''} - ${c.row.summary ? '摘要' : '原文'}：${String(c.row.summary || c.row.episode || '').replace(/\s+/g, ' ')}${c.row.entry_id || c.id ? ` [${c.row.entry_id || c.id}]` : ''}`;
export function renderBlocks(blocks) {
  const lines = [], cands = [], meta = [];
  blocks.forEach(([label, list]) => { lines.push(`[block: ${label}]`); list.forEach(c => { lines.push(`  ${cands.length}: ${textOf(c)}`); cands.push(c); meta.push(label); }); });
  return { text: lines.join('\n'), cands, meta };
}
const renderCore = (order, source, by) => order.map(id => `  - [from "${source.get(id)}"] ${textOf(by.get(id))}`).join('\n') || '(none)';

// decider(question, coreSoFar, evidence, nCandidates, round) -> { stop, queries, core:number[], failed? }
export function llmDecider(llm, tune = {}) {
  const t = { ...AGENTIC_DEFAULTS, ...tune };
  return async (question, coreSoFar, evidence, n) => {
    const prompt = DECIDER_PROMPT.replace('{max_sub}', String(t.maxSubqueries)).replace('{question}', () => question).replace('{core_so_far}', () => coreSoFar || '(none)').replace('{evidence}', () => evidence || '(no evidence retrieved this round)');
    let lastError = '';
    for (let attempt = 0; attempt <= t.retries; attempt++) {
      try {
        const reply = await llm(prompt, { purpose: 'memory2-recall' });
        if (!String(reply ?? '').trim()) throw new Error('empty decider reply');
        const data = parseDecision(reply);
        const queries = (Array.isArray(data.next_queries) ? data.next_queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, t.maxSubqueries);
        return { stop: !queries.length, queries, core: coerceCore(data.core, n) };
      } catch (e) { lastError = String(e.message); }
    }
    // Every attempt failed: a deterministic core (fused order) beats an empty one, and the failure is flagged so it is countable.
    return { stop: true, queries: [], core: [...Array(Math.min(t.fallbackCore, Math.max(n, 0))).keys()], failed: true, error: lastError.slice(0, 200) };
  };
}

// Core first (capped at topK), then each sub-query's top non-core, then the rest by max RRF score across sub-queries.
export function finalize({ topK, coreOrder, coreIds, candById, subqHits, guarantee }) {
  const maxScore = id => Math.max(0, ...Object.values(subqHits.get(id)));
  const slot = new Map(), chosen = [];
  for (const id of [...coreOrder].sort((a, b) => maxScore(b) - maxScore(a))) { if (chosen.length >= topK) break; if (!slot.has(id)) { chosen.push(id); slot.set(id, 'core'); } }
  for (const [, id] of guarantee) { if (chosen.length >= topK) break; if (slot.has(id) || coreIds.has(id)) continue; chosen.push(id); slot.set(id, 'guarantee'); }
  for (const id of [...candById.keys()].filter(i => !slot.has(i)).sort((a, b) => maxScore(b) - maxScore(a))) { if (chosen.length >= topK) break; chosen.push(id); slot.set(id, 'fill'); }
  return chosen.map(id => ({ id, slot: slot.get(id), score: maxScore(id), row: candById.get(id).row }));
}

// searcher: Searcher (episode table, embedder). decider: see llmDecider. Returns { items, rounds, core, failed_rounds }.
export async function agenticSearch({ searcher, decider, query, owner_id, tune = {}, filters = {} }) {
  const t = { ...AGENTIC_DEFAULTS, ...tune };
  if (!query || !String(query).trim()) throw new Error('query 不能为空');
  const where = buildWhere({ owner_id, ...filters }), table = await searcher.index.table('episode');
  const coreIds = new Set(), coreOrder = [], coreSource = new Map(), subqHits = new Map(), candById = new Map(), guarantee = [], rounds = [];
  let curQueries = [String(query)], streak = 0, failedRounds = 0;
  for (let round = 0; round < t.maxRounds; round++) {
    const blocks = [];
    const recalled = await Promise.all(curQueries.map(async q => {
      const vector = await searcher.embedQuery(q);
      const [sparse, dense] = await Promise.all([searcher.sparse(table, q, where, t.pool, HANDLERS.episode.ftsColumn), searcher.dense(table, vector, where, t.pool)]);
      return rrfWith(t.rrfK, sparse, dense);
    }));
    curQueries.forEach((q, i) => {
      const label = round === 0 ? 'original question' : q, block = recalled[i].slice(0, round === 0 ? t.seedTopk : t.subqTopk);
      blocks.push([label, block]);
      for (const c of block) { const h = subqHits.get(c.id) || {}; h[label] = c.score; subqHits.set(c.id, h); const cur = candById.get(c.id); if (!cur || c.score > cur.score) candById.set(c.id, c); }
      for (const c of block.slice(0, t.guarantee)) guarantee.push([label, c.id]);
    });
    if (round === 0 && blocks.every(([, b]) => !b.length)) return { items: [], rounds, core: 0, failed_rounds: 0 };
    const { text, cands, meta } = renderBlocks(blocks);
    const decision = await decider(String(query), renderCore(coreOrder, coreSource, candById), text, cands.length, round);
    if (decision.failed) failedRounds++;
    let added = 0;
    for (const gi of decision.core) { const c = cands[gi]; if (!c || coreIds.has(c.id)) continue; coreIds.add(c.id); coreOrder.push(c.id); coreSource.set(c.id, meta[gi]); added++; }
    streak = added ? 0 : streak + 1;
    rounds.push({ round: round + 1, queries: curQueries, candidates: cands.length, core_added: added, next: decision.queries, ...(decision.failed ? { failed: true, error: decision.error || 'decider failed' } : {}) });
    if (!decision.queries.length) break;
    if (round >= 1 && streak >= t.patience) break;
    curQueries = decision.queries;
  }
  return { items: finalize({ topK: t.topK, coreOrder, coreIds, candById, subqHits, guarantee }), rounds, core: coreIds.size, failed_rounds: failedRounds };
}
