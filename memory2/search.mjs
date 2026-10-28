// Search for memory2 — a Node port of EverOS memory/search (manager.py, recall/episode.py, recall/base.py,
// filters.py) and everalgo rank/{fusion,weight}.py (Apache-2.0).
//   keyword : BM25 over episode_tokens, OR of the jieba-tokenised query terms
//   vector  : cosine ANN over `vector`
//   hybrid  : both in parallel, fused by LR (calibrated probability, upstream default coefficients) or RRF
// Deprecated (reflection-merged) rows are always excluded unless asked for. Scores of hybrid/LR are probabilities,
// so `minScore` is meaningful there; keyword (raw BM25) and vector-only scores are not calibrated.
import * as lancedb from '@lancedb/lancedb';
import { tokenize } from './tokenizer.mjs';
import { truncateNormalize, HANDLERS } from './index.mjs';

const RECALL_MULTIPLIER = 2, TOP_K_CAP = 100;
const q = s => String(s).replaceAll("'", "''");
// everalgo.rank.weight.LRCoefs defaults (trained upstream on Qwen3-Embedding cosine + raw BM25 score).
export const LR_COEFS = { emb: 6.27473151675093, bm25: 0.09395183408310023, intercept: -4.858095765012703 };

export const rrf = (...lists) => rrfWith(60, ...lists);
export function rrfWith(k, ...lists) {
  const score = new Map(), doc = new Map();
  for (const list of lists) list.forEach((c, i) => { if (!c.id) return; if (!doc.has(c.id)) doc.set(c.id, c); score.set(c.id, (score.get(c.id) || 0) + 1 / (k + i + 1)); });
  return [...score].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ ...doc.get(id), score: s }));
}
export function lrFusion(emb, bm25, coefs = LR_COEFS) {
  const by = new Map(), doc = new Map();
  for (const [name, list] of [['emb', emb], ['bm25', bm25]]) for (const c of list) { if (!c.id) continue; if (!doc.has(c.id)) doc.set(c.id, c); by.set(c.id, { ...(by.get(c.id) || {}), [name]: c.score }); }
  return [...by].map(([id, s]) => ({ ...doc.get(id), score: 1 / (1 + Math.exp(-(coefs.intercept + (s.emb || 0) * coefs.emb + (s.bm25 || 0) * coefs.bm25))), scores: s }))
    .sort((a, b) => b.score - a.score);
}

// ---- hierarchy: port of EverOS memory/search/hierarchy.py (heap_expand) ----------------------------------------------------
// everalgo.rank.fusion.cosine_to_lr_score: a fact's cosine to the query, plus the BM25 score of the episode it belongs to, as an LR probability.
export const cosineToLr = (sim, parentBm25 = 0, coefs = LR_COEFS) => 1 / (1 + Math.exp(-(coefs.intercept + sim * coefs.emb + parentBm25 * coefs.bm25)));

// episode candidate id -> the values a fact's parent_id may carry for it (its entry id; the memcell id too for older facts).
export function buildEpToFactParents(episodes) {
  const out = new Map();
  for (const ep of episodes) {
    const parents = [], entry = ep.row?.entry_id, parent = ep.row?.parent_id;
    if (typeof entry === 'string' && entry) parents.push(entry);
    if (typeof parent === 'string' && parent && parent !== entry) parents.push(parent);
    if (parents.length) out.set(ep.id, parents);
  }
  return out;
}

// RRF decides the order in which episodes are opened; LR probabilities decide who is in the final top-K. An opened episode's best facts
// compete with everything already in the top-K, and when a fact gets in, its episode steps aside (the fact is the precise hit).
// sparse/dense: episode candidates (descending). episodeToFacts: Map episodeId -> facts [{id, score: cosine, row}] (descending).
// Returns [{type:'episode'|'atomic_fact', id, score, row, parent_episode_id?}] by score descending.
export function heapExpand({ sparse, dense, episodeToFacts, topK = 10, alpha = 1, rrfK = 60, maxConvergenceRounds = 10, factsPerEpisode = 3, coefs = LR_COEFS }) {
  if (!sparse.length && !dense.length) return [];
  const bm25 = new Map(sparse.map(c => [c.id, c.score]));
  const episodeScore = new Map(lrFusion(dense, sparse, coefs).map(c => [c.id, c.score]));
  const fused = rrfWith(rrfK, sparse, dense);
  if (!fused.length) return [];
  const order = [...fused].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // the heap pops (-score, id)
  const topn = new Map(); // id -> { item, score, type, source }
  for (const doc of fused.slice(0, topK)) topn.set(doc.id, { item: doc, score: episodeScore.get(doc.id), type: 'episode', source: doc.id });
  const minScore = () => topn.size ? Math.min(...[...topn.values()].map(v => v.score)) : 0;
  let converged = 0;
  for (const { id: episodeId } of order) {
    if (converged >= maxConvergenceRounds) break;
    const before = new Set(topn.keys());
    const facts = (episodeToFacts.get(episodeId) || []).slice(0, factsPerEpisode * 2);
    if (facts.length) {
      const parentBm25 = bm25.get(episodeId) ?? 0, parentLr = episodeScore.get(episodeId);
      const scored = facts.map(f => ({ score: alpha * cosineToLr(f.score, parentBm25, coefs) + (1 - alpha) * parentLr, fact: f }))
        .sort((a, b) => b.score - a.score).slice(0, factsPerEpisode);
      let min = minScore(), entered = false;
      for (const { score, fact } of scored) {
        if (score <= 0) continue;
        if (topn.size < topK || score > min) {
          topn.set(fact.id, { item: fact, score, type: 'atomic_fact', source: episodeId });
          entered = true;
          if (topn.size > topK) { let worst = null; for (const [k, v] of topn) if (worst === null || v.score < topn.get(worst).score) worst = k; topn.delete(worst); }
          min = minScore();
        }
      }
      if (entered && topn.has(episodeId)) topn.delete(episodeId);
    }
    const same = topn.size === before.size && [...topn.keys()].every(k => before.has(k));
    converged = same ? converged + 1 : 0;
  }
  return [...topn.values()].sort((a, b) => b.score - a.score).map(v => ({ type: v.type, id: v.item.id, score: v.score, row: v.item.row, ...(v.type === 'atomic_fact' ? { parent_episode_id: v.source } : {}) }));
}

export function buildWhere({ owner_id, app_id = 'default', project_id = 'default', includeDeprecated = false, session_id, after_ms, before_ms }) {
  const w = [`owner_id = '${q(owner_id)}'`, `app_id = '${q(app_id)}'`, `project_id = '${q(project_id)}'`];
  if (!includeDeprecated) w.push('deprecated_by IS NULL');
  if (session_id) w.push(`session_id = '${q(session_id)}'`);
  if (Number.isFinite(after_ms)) w.push(`timestamp_ms > ${after_ms}`);
  if (Number.isFinite(before_ms)) w.push(`timestamp_ms < ${before_ms}`);
  return w.join(' AND ');
}
const NOISE = new Set(['vector', 'subject_vector', '_distance', '_score', '_rowid', 'episode_tokens', 'fact_tokens']);
const clean = row => Object.fromEntries(Object.entries(row).filter(([k]) => !NOISE.has(k)));
const cosineScore = d => d == null ? 0 : Math.min(1, Math.max(0, 1 - Number(d)));

export class Searcher {
  constructor(index) { this.index = index; }
  async embedQuery(text) {
    const e = this.index.embedder;
    if (!e) return null;
    const [v] = await e.embed([text], { query: true });
    return truncateNormalize(v, this.index.dim);
  }
  async sparse(table, query, where, limit, column = 'episode_tokens') {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const rows = await table.query().fullTextSearch(new lancedb.MatchQuery(terms.join(' '), column, { operator: 'Or' })).where(where).limit(limit).toArray();
    return rows.map(r => ({ id: r.id, score: Number(r._score ?? 0), source: 'keyword', row: clean(r) }));
  }
  async dense(table, vector, where, limit) {
    if (!vector) return [];
    const rows = await table.vectorSearch(vector).column('vector').distanceType('cosine').where(where).limit(limit).toArray();
    return rows.map(r => ({ id: r.id, score: cosineScore(r._distance), source: 'vector', row: clean(r) }));
  }
  // Facts of the given episodes, each scored by cosine to the query vector (EverOS AtomicFactRecaller.facts_for_episodes).
  async factsForEpisodes(epToParents, where, { perEpisode, vector }) {
    const parentToEps = new Map();
    for (const [ep, parents] of epToParents) for (const p of parents) parentToEps.set(p, [...(parentToEps.get(p) || []), ep]);
    if (!parentToEps.size) return new Map();
    const table = await this.index.table('atomic_fact');
    const full = where + ' AND parent_id IN (' + [...parentToEps.keys()].map(p => "'" + q(p) + "'").join(',') + ')';
    const rows = await table.vectorSearch(vector).column('vector').distanceType('cosine').where(full).limit(perEpisode * parentToEps.size).toArray();
    const buckets = new Map();
    for (const r of rows) {
      const fact = { id: r.id, score: cosineScore(r._distance), row: clean(r) };
      for (const ep of parentToEps.get(r.parent_id)) buckets.set(ep, [...(buckets.get(ep) || []), fact]);
    }
    for (const [ep, list] of buckets) buckets.set(ep, list.slice(0, perEpisode)); // rows arrive closest-first
    return buckets;
  }
  // EverOS's default hybrid search ("hierarchy"): episodes by BM25 + vector, then their facts compete with them for the top-K.
  // Returns { items: [{type, id, score, row, parent_episode_id?}], episodes: Map episodeId -> row } (episodes covers every candidate, so a fact's parent can be looked up).
  async hierarchy(req) {
    const { query, topK = 10, minScore, factsPerEpisode = 3, pool = topK * RECALL_MULTIPLIER } = req;
    if (!query || !String(query).trim()) throw new Error('query 不能为空');
    const vector = await this.embedQuery(query);
    if (!vector) throw new Error('hierarchy 需要嵌入模型');
    const where = buildWhere(req), table = await this.index.table('episode'), limit = Math.min(pool, TOP_K_CAP);
    const [sparse, dense] = await Promise.all([this.sparse(table, query, where, limit, HANDLERS.episode.ftsColumn), this.dense(table, vector, where, limit)]);
    const candidates = rrf(sparse, dense);
    const episodeToFacts = await this.factsForEpisodes(buildEpToFactParents(candidates), where, { perEpisode: Math.max(topK * 2, 20), vector });
    let items = heapExpand({ sparse, dense, episodeToFacts, topK, factsPerEpisode });
    if (minScore != null) items = items.filter(i => i.score >= minScore);
    return { items, episodes: new Map(candidates.map(c => [c.id, c.row])) };
  }
  // req: { owner_id, query, method='hybrid', topK=10, fusion='lr', radius, minScore, includeDeprecated, session_id, after_ms, before_ms, app_id, project_id }
  async search(req) {
    const { query, method = 'hybrid', topK = 10, fusion = 'lr', radius, minScore, kind = 'episode' } = req;
    if (!HANDLERS[kind]) throw new Error('kind: ' + Object.keys(HANDLERS).join('|'));
    if (!query || !String(query).trim()) throw new Error('query 不能为空');
    if (!['keyword', 'vector', 'hybrid'].includes(method)) throw new Error('method: keyword|vector|hybrid');
    const table = await this.index.table(kind), where = buildWhere(req);
    const limit = Math.min(topK > 0 ? topK * RECALL_MULTIPLIER : TOP_K_CAP, TOP_K_CAP), top = topK > 0 ? topK : TOP_K_CAP;
    const applyRadius = list => radius == null ? list : list.filter(c => c.score >= radius);
    if (method === 'vector' && !this.index.embedder) throw new Error('向量检索需要嵌入模型（索引未配置 embedder）');
    const vector = method === 'keyword' ? null : await this.embedQuery(query);
    const [sparse, dense] = await Promise.all([
      method === 'vector' ? [] : this.sparse(table, query, where, limit, HANDLERS[kind].ftsColumn),
      vector ? this.dense(table, vector, where, limit) : [],
    ]);
    const denseR = applyRadius(dense);
    let out;
    if (method === 'keyword') out = sparse;
    else if (method === 'vector') out = denseR;
    else if (!vector) out = sparse; // no embedder: raw BM25, not calibrated
    else out = fusion === 'rrf' ? rrf(sparse, denseR) : lrFusion(denseR, sparse);
    if (minScore != null) out = out.filter(c => c.score >= minScore);
    return { method: method === 'hybrid' && !vector ? 'hybrid(keyword-only)' : method, calibrated: method === 'hybrid' && fusion !== 'rrf' && !!vector,
      items: out.slice(0, top).map(c => ({ id: c.id, score: c.score, source: c.source ?? 'fused', ...(c.scores ? { scores: c.scores } : {}), ...c.row })) };
  }
}
