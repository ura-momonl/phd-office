// Clustering + Reflection for memory2 — a Node port of EverOS (Apache-2.0):
//   everalgo clustering/algorithm.py (cluster_by_geometry), everalgo user_memory/reflect.py (EpisodeReflector) + prompts/zh/reflect.py,
//   everos memory/strategies/trigger_profile_clustering.py (_fold_in), memory/reflection/orchestrator.py,
//   infra/persistence/sqlite cluster / reflection_report tables.
// Flow per cluster: Select (>=2 members, or reflected before and grown) -> Merge (INIT, or UPDATE of the earlier merged
// narrative) -> write the merged episode (parent_type=cluster) -> re-extract atomic facts -> Deprecate the originals and their
// facts via frontmatter `deprecated_entries` (md stays the source of truth; nothing is deleted) -> reset the cluster to the merged episode.
import fs from 'node:fs';
import path from 'node:path';
import { inheritHistory } from './ledger-store.mjs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendEntries, patchFrontmatter, readMarkdown, parseStructuredEntry, KINDS } from './md.mjs';
import { truncateNormalize } from './index.mjs';
import { PROMPTS, localDate, extractJsonObject, addFacts, tuning } from './extract.mjs';

// Upstream default is 0.65, tuned for its own data. On 22 real Chinese episodes embedded with Qwen3-Embedding-4B (1024-d) the pairwise cosine has median 0.635 and p90 0.81,
// so 0.65 chained 18 unrelated episodes into one cluster; 0.8 gave two coherent clusters (2 + 8 episodes) and left the rest alone. Small sample - revisit with more data.
export const CLUSTER_THRESHOLD = 0.8, CLUSTER_WINDOW_DAYS = 7, MAX_CLUSTERS_PER_RUN = 10, PREVIEW_CAP = 5;
const DAY_MS = 86400000, NORM_EPS = 1e-9;

// ---- cluster_by_geometry (everalgo.clustering) ------------------------------------------------------------------
const norm = v => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
export const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d / ((norm(a) + NORM_EPS) * (norm(b) + NORM_EPS)); };
export function mergeClusters(existing, fresh, previewCap = PREVIEW_CAP) {
  const total = existing.count + fresh.count;
  return { id: existing.id, centroid: existing.centroid.map((x, i) => (x * existing.count + fresh.centroid[i] * fresh.count) / total), count: total,
    last_ts: Math.max(existing.last_ts, fresh.last_ts), preview: [...existing.preview, ...fresh.preview].slice(-previewCap), members: [...existing.members, ...fresh.members] };
}
// Best cluster inside the time window whose cosine clears the threshold -> merged cluster (same id), else null (caller keeps the new one).
export function clusterByGeometry(fresh, existing, { threshold = CLUSTER_THRESHOLD, windowDays = CLUSTER_WINDOW_DAYS, previewCap = PREVIEW_CAP } = {}) {
  let best = null, bestSim = -1;
  existing.forEach((c, i) => {
    if (!c.centroid.length || Math.abs(fresh.last_ts - c.last_ts) > windowDays * DAY_MS) return;
    const sim = cosine(fresh.centroid, c.centroid);
    if (sim > bestSim) { bestSim = sim; best = i; }
  });
  return best !== null && bestSim >= threshold ? mergeClusters(existing[best], fresh, previewCap) : null;
}

// ---- SQLite store: cluster / cluster_member / reflection_report --------------------------------------------------
export class ClusterStore {
  constructor(root) {
    fs.mkdirSync(root.indexDir(), { recursive: true });
    this.db = new DatabaseSync(path.join(root.indexDir(), 'system.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cluster (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, app_id TEXT NOT NULL, project_id TEXT NOT NULL,
        centroid BLOB, count INTEGER NOT NULL, last_ts_ms INTEGER NOT NULL, preview_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_member (cluster_id TEXT NOT NULL, member_id TEXT NOT NULL, member_type TEXT NOT NULL, PRIMARY KEY (cluster_id, member_id));
      CREATE INDEX IF NOT EXISTS cluster_member_by_member ON cluster_member(member_id);
      CREATE TABLE IF NOT EXISTS reflection_report (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, owner_id TEXT NOT NULL, app_id TEXT NOT NULL, project_id TEXT NOT NULL,
        mode TEXT NOT NULL, source_members TEXT NOT NULL, source_count INTEGER NOT NULL, merged_entry_id TEXT NOT NULL, deprecated_fact_count INTEGER NOT NULL, created_at TEXT NOT NULL);`);
  }
  static toBlob(v) { return Buffer.from(new Float32Array(v).buffer); }
  static fromBlob(b) { return b ? Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))) : []; }
  members(clusterId) { return this.db.prepare('SELECT member_id, member_type FROM cluster_member WHERE cluster_id=?').all(clusterId); }
  listForOwner(owner, kind = 'user_memory', { app_id = 'default', project_id = 'default' } = {}) {
    return this.db.prepare('SELECT * FROM cluster WHERE owner_id=? AND kind=? AND app_id=? AND project_id=?').all(owner, kind, app_id, project_id).map(r => ({
      id: r.id, centroid: ClusterStore.fromBlob(r.centroid), count: r.count, last_ts: r.last_ts_ms, preview: JSON.parse(r.preview_json), members: this.members(r.id).map(m => m.member_id) }));
  }
  upsertWithMembers(c, { owner, kind = 'user_memory', memberType = 'episode', app_id = 'default', project_id = 'default' }) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO cluster(id,owner_id,kind,app_id,project_id,centroid,count,last_ts_ms,preview_json) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET centroid=excluded.centroid,count=excluded.count,last_ts_ms=excluded.last_ts_ms,preview_json=excluded.preview_json`)
        .run(c.id, owner, kind, app_id, project_id, ClusterStore.toBlob(c.centroid), c.count, c.last_ts, JSON.stringify(c.preview));
      for (const m of c.members) this.db.prepare('INSERT OR IGNORE INTO cluster_member(cluster_id,member_id,member_type) VALUES (?,?,?)').run(c.id, m, memberType);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  clusterOf(memberId) { return this.db.prepare('SELECT cluster_id FROM cluster_member WHERE member_id=?').get(memberId)?.cluster_id ?? null; }
  idsAndCounts(owner, kind = 'user_memory', { app_id = 'default', project_id = 'default' } = {}) {
    return this.db.prepare(`SELECT c.id AS id, COUNT(m.member_id) AS n FROM cluster c LEFT JOIN cluster_member m ON m.cluster_id=c.id
      WHERE c.owner_id=? AND c.kind=? AND c.app_id=? AND c.project_id=? GROUP BY c.id`).all(owner, kind, app_id, project_id).map(r => [r.id, r.n]);
  }
  reflectedClusterIds(owner, { app_id = 'default', project_id = 'default' } = {}) {
    return new Set(this.db.prepare('SELECT DISTINCT cluster_id FROM reflection_report WHERE owner_id=? AND app_id=? AND project_id=?').all(owner, app_id, project_id).map(r => r.cluster_id));
  }
  removeMembers(clusterId, ids) { for (const id of ids) this.db.prepare('DELETE FROM cluster_member WHERE cluster_id=? AND member_id=?').run(clusterId, id); }
  addMember(clusterId, id, type) { this.db.prepare('INSERT OR IGNORE INTO cluster_member(cluster_id,member_id,member_type) VALUES (?,?,?)').run(clusterId, id, type); }
  updateMetadata(clusterId, { centroid, count, last_ts, preview }) {
    this.db.prepare('UPDATE cluster SET centroid=?,count=?,last_ts_ms=?,preview_json=? WHERE id=?').run(ClusterStore.toBlob(centroid), count, last_ts, JSON.stringify(preview), clusterId);
  }
  createReport(r) {
    this.db.prepare('INSERT INTO reflection_report(id,cluster_id,owner_id,app_id,project_id,mode,source_members,source_count,merged_entry_id,deprecated_fact_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.cluster_id, r.owner_id, r.app_id, r.project_id, r.mode, JSON.stringify(r.source_members), r.source_count, r.merged_entry_id, r.deprecated_fact_count, r.created_at);
  }
  reports(owner) { return this.db.prepare('SELECT * FROM reflection_report WHERE owner_id=? ORDER BY created_at').all(owner).map(r => ({ ...r, source_members: JSON.parse(r.source_members) })); }
  close() { this.db.close(); }
}

// ---- Episodes from md (the source of truth) ----------------------------------------------------------------------
export function walkDaily(root, kind, owner, fn) {
  const dir = path.dirname(root.dailyPath(kind, owner, '2000-01-01'));
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.md')) fn(path.join(dir, f), readMarkdown(path.join(dir, f)));
}
export function loadEpisodes(root, owner) {
  const out = new Map();
  walkDaily(root, 'episode', owner, (file, parsed) => {
    const dep = parsed.frontmatter.deprecated_entries || {};
    for (const e of parsed.entries) {
      const s = parseStructuredEntry(e.body), ts = Date.parse(s.inline.timestamp);
      if (!Number.isFinite(ts)) continue;
      out.set(e.id, { entry_id: e.id, file, owner_id: owner, subject: s.sections.Subject || '', episode: s.sections.Content || '', timestamp_ms: ts,
        parent_type: s.inline.parent_type || 'memcell', parent_id: s.inline.parent_id || '', session_id: s.inline.session_id || null, deprecated_by: dep[e.id] || null });
    }
  });
  return out;
}
export function factsByParent(root, owner) { // parent episode entry id -> [{entry_id, file}]
  const out = new Map();
  walkDaily(root, 'atomic_fact', owner, (file, parsed) => {
    const dep = parsed.frontmatter.deprecated_entries || {};
    for (const e of parsed.entries) {
      if (dep[e.id]) continue;
      const p = parseStructuredEntry(e.body).inline.parent_id;
      if (p) { if (!out.has(p)) out.set(p, []); out.get(p).push({ entry_id: e.id, file }); }
    }
  });
  return out;
}

const embedOne = async (embedder, dim, text) => truncateNormalize((await embedder.embed([text], { query: false }))[0], dim);

// ---- Clustering: fold every not-yet-clustered live episode into the owner's clusters, oldest first ---------------------
export async function clusterNewEpisodes({ root, store, embedder, owner, dim, threshold = CLUSTER_THRESHOLD, windowDays = CLUSTER_WINDOW_DAYS }) {
  const todo = [...loadEpisodes(root, owner).values()].filter(e => !e.deprecated_by && e.parent_type !== 'cluster' && !store.clusterOf(e.entry_id)).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  if (!todo.length) return { folded: 0, created: 0, merged: 0 };
  const vectors = (await embedder.embed(todo.map(e => e.episode), { query: false })).map(v => truncateNormalize(v, dim));
  let created = 0, merged = 0;
  todo.forEach((e, i) => {
    const existing = store.listForOwner(owner), fresh = { id: 'cl_' + randomUUID().slice(0, 12), centroid: vectors[i], count: 1, last_ts: e.timestamp_ms, preview: [e.episode], members: [e.entry_id] };
    const m = clusterByGeometry(fresh, existing, { threshold, windowDays });
    store.upsertWithMembers(m ?? fresh, { owner });
    m ? merged++ : created++;
  });
  return { folded: todo.length, created, merged };
}

// ---- EpisodeReflector (everalgo user_memory/reflect.py) ---------------------------------------------------------------
// Upstream asks for Structured Output {content, title}; our LLM channel returns text, so the prompt gets an explicit JSON instruction.
const JSON_INSTRUCTION = '\n\n请仅返回一个 JSON 对象，格式为 {"title": "简短的主题标题", "content": "合并后的叙述全文"}，不要输出其他内容。';
const timeline = eps => eps.map((e, i) => `${i + 1}. ${e.episode}`).join('\n');
function checkSorted(eps, min) {
  if (eps.length < min) throw new Error(`reflect requires at least ${min} episode(s), got ${eps.length}`);
  for (let i = 1; i < eps.length; i++) if (eps[i].timestamp_ms < eps[i - 1].timestamp_ms) throw new Error('episodes must be sorted by timestamp ascending');
}
export async function reflectEpisodes(llm, episodes, { oldEpisode = null, prompts = PROMPTS.reflect } = {}) {
  let rendered;
  if (!oldEpisode) { checkSorted(episodes, 2); rendered = prompts.REFLECT_EPISODE_PROMPT.replace('{timeline}', () => timeline(episodes)); }
  else { checkSorted(episodes, 1); rendered = prompts.REFLECT_EPISODE_UPDATE_PROMPT.replace('{old_episode}', () => oldEpisode.episode).replace('{new_episodes}', () => timeline(episodes)); }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = JSON.parse(extractJsonObject(String(await llm(rendered + JSON_INSTRUCTION, { purpose: 'memory2-reflect' }))));
      if (!String(d.content ?? '').trim()) throw new Error('reflector returned empty content');
      return { subject: String(d.title ?? ''), episode: String(d.content), timestamp_ms: episodes.at(-1).timestamp_ms };
    } catch (e) { lastError = e; if (attempt === 0) await new Promise(r => setTimeout(r, tuning.retryDelayMs)); }
  }
  throw lastError;
}

// ---- ReflectionOrchestrator --------------------------------------------------------------------------------------------
export function selectCandidates(store, owner, scope = {}) {
  const reflected = store.reflectedClusterIds(owner, scope), counts = new Map(store.idsAndCounts(owner, 'user_memory', scope));
  return [...counts].filter(([id, n]) => (!reflected.has(id) && n >= 2) || (reflected.has(id) && n > 1)).sort((a, b) => b[1] - a[1]).slice(0, MAX_CLUSTERS_PER_RUN).map(([id]) => id);
}

async function processCluster({ clusterId, root, store, embedder, llm, owner, dim, scope }) {
  const members = store.members(clusterId), all = loadEpisodes(root, owner);
  const episodes = members.map(m => all.get(m.member_id)).filter(e => e && !e.deprecated_by).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  if (!episodes.length) return null;
  const merged = episodes.filter(e => e.parent_type === 'cluster'), mode = merged.length ? 'update' : 'init';
  const sources = mode === 'update' ? episodes.filter(e => e.parent_type !== 'cluster') : episodes;
  if (mode === 'update' ? !sources.length : sources.length < 2) return null;
  const result = await reflectEpisodes(llm, sources, { oldEpisode: mode === 'update' ? merged[0] : null });
  const lastTs = Math.max(...episodes.map(e => e.timestamp_ms));
  // 1. write the merged episode (parent_type=cluster; no session_id: an aggregation product belongs to no session)
  const [mergedId] = appendEntries(root, 'episode', owner, localDate(lastTs), [{
    inline: { owner_id: owner, timestamp: new Date(lastTs).toISOString(), parent_type: 'cluster', parent_id: clusterId, merged_from: episodes.map(e => e.entry_id) },
    sections: { Subject: result.subject, Content: result.episode } }]);
  // 2. re-extract atomic facts from the merged narrative
  let newFacts = 0, factError = null;
  try { newFacts = await addFacts({ owner, root, llm, episodeId: mergedId, sessionId: null, text: result.episode, timestampMs: lastTs }); }
  catch (e) { factError = String(e.message).slice(0, 200); } // episode stays; backfillFacts can retry
  // 3. deprecate originals (and their facts) in md, group by file; the merged episode itself is never deprecated here
  const targets = new Set(sources.concat(mode === 'update' ? merged : []).map(e => e.entry_id));
  const byFile = new Map(), add = (file, id) => { if (!byFile.has(file)) byFile.set(file, {}); byFile.get(file)[id] = mergedId; };
  for (const id of targets) add(all.get(id).file, id);
  const facts = factsByParent(root, owner); let deprecatedFacts = 0;
  const factFiles = new Map();
  for (const id of targets) for (const f of facts.get(id) || []) { if (!factFiles.has(f.file)) factFiles.set(f.file, {}); factFiles.get(f.file)[f.entry_id] = mergedId; deprecatedFacts++; }
  for (const [file, map] of byFile) patchFrontmatter(file, { deprecated_entries: map });
  for (const [file, map] of factFiles) patchFrontmatter(file, { deprecated_entries: map });
  // the merged episode inherits what the ledger knows about its sources (pooled uses; the merge counts as one reactivation)
  inheritHistory({ root, mergedId, sources: [...targets].map(id => ({ id, timestamp_ms: all.get(id).timestamp_ms })) });
  // 4. reset the cluster to the merged episode
  store.removeMembers(clusterId, targets);
  store.addMember(clusterId, mergedId, 'episode');
  store.updateMetadata(clusterId, { centroid: await embedOne(embedder, dim, result.episode), count: 1, last_ts: lastTs, preview: [result.episode] });
  store.createReport({ id: randomUUID().replaceAll('-', ''), cluster_id: clusterId, owner_id: owner, app_id: scope.app_id || 'default', project_id: scope.project_id || 'default', mode,
    source_members: [...targets].map(id => ({ member_id: id, member_type: 'episode' })), source_count: targets.size, merged_entry_id: mergedId, deprecated_fact_count: deprecatedFacts, created_at: new Date().toISOString() });
  return { cluster_id: clusterId, mode, merged_entry_id: mergedId, source_count: targets.size, deprecated_facts: deprecatedFacts, new_facts: newFacts, ...(factError ? { fact_error: factError } : {}) };
}

// One Reflection cycle for one owner: cluster new episodes, then consolidate up to MAX_CLUSTERS_PER_RUN clusters.
// A failing cluster is skipped and reported; it never blocks the others. `index` (optional MemoryIndex) is re-synced at the end.
export async function runReflection({ root, store, embedder, llm, owner, dim, index = null, scope = {}, threshold, windowDays }) {
  if (!embedder) throw new Error('Reflection 需要嵌入模型（聚类与合并后重算质心）');
  const clustering = await clusterNewEpisodes({ root, store, embedder, owner, dim, threshold, windowDays });
  const candidates = selectCandidates(store, owner, scope), reports = [], skipped = [];
  for (const clusterId of candidates) {
    try { const r = await processCluster({ clusterId, root, store, embedder, llm, owner, dim, scope }); r ? reports.push(r) : skipped.push({ cluster_id: clusterId, reason: 'no live episodes' }); }
    catch (e) { skipped.push({ cluster_id: clusterId, reason: String(e.message).slice(0, 200) }); }
  }
  if (index && reports.length) await index.syncAll();
  return { owner, clustering, candidates: candidates.length, reports, skipped };
}
export { KINDS };
