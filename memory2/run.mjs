// CLI for memory2: node automation/run.mjs memory2 <action> <JSON file>. Every action needs {owner}; an assistant can only use its own store.
import fs from 'node:fs';
import path from 'node:path';
import { root as officeRoot, read, input } from '../automation/files.mjs';
import { ownerCheck } from './owner.mjs';
import { MemoryRoot, readMarkdown, parseStructuredEntry } from './md.mjs';
import { MemoryIndex, DEFAULT_DIM } from './index.mjs';
import { Searcher } from './search.mjs';
import { GpuEmbedder } from './embedder.mjs';
import { buildContext } from './context.mjs';
import { ingestOwner, backfillFacts } from './extract.mjs';
import { ClusterStore, runReflection, loadEpisodes } from './reflect.mjs';
import { updateProfile, readProfile } from './profile.mjs';
import { codexChat } from './llm.mjs';
import { agenticSearch, llmDecider } from './agentic.mjs';
import { metered, logUsage } from './auto.mjs';
import { accountRuns, forgetOwner, restoreEntries, pinEntries, readLedger } from './ledger.mjs';

const settings = () => ({ dim: DEFAULT_DIM, ...(read('agent/config.json').memory_v2 || {}) });
export const storeRoot = owner => new MemoryRoot(path.join(officeRoot, '.runtime/memory2', ownerCheck(owner)));
export function openStore(owner, { gpu = true } = {}) {
  const cfg = settings(), root = storeRoot(owner);
  const embedder = gpu && !process.env.MEMORY2_NO_GPU ? new GpuEmbedder({ idleSeconds: cfg.idle_seconds ?? 600 }) : null;
  return { root, cfg, embedder, index: new MemoryIndex(root, { embedder, dim: cfg.dim }) };
}
const sessions = () => JSON.parse(fs.readFileSync(path.join(officeRoot, '.runtime/agent/sessions.json'), 'utf8')).sessions;
function status(owner) {
  const root = storeRoot(owner), eps = fs.existsSync(root.root) ? [...loadEpisodes(root, owner).values()] : [];
  let facts = 0, deprecatedFacts = 0;
  const fdir = path.dirname(root.dailyPath('atomic_fact', owner, '2000-01-01'));
  if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir)) if (f.endsWith('.md')) { const p = readMarkdown(path.join(fdir, f)), dep = p.frontmatter.deprecated_entries || {}; for (const e of p.entries) dep[e.id] ? deprecatedFacts++ : facts++; }
  const p = readProfile(root, owner), reports = fs.existsSync(path.join(root.indexDir(), 'system.sqlite')) ? (() => { const s = new ClusterStore(root); const r = s.reports(owner); s.close(); return r; })() : [];
  return { owner, episodes: eps.filter(e => !e.deprecated_by).length, episodes_deprecated: eps.filter(e => e.deprecated_by).length, merged_episodes: eps.filter(e => e.parent_type === 'cluster' && !e.deprecated_by).length,
    atomic_facts: facts, atomic_facts_deprecated: deprecatedFacts, profile: p ? { summary: p.summary, explicit: p.explicit_info.length, implicit: p.implicit_traits.length } : null, reflections: reports.length };
}
function show(owner, id) {
  const root = storeRoot(owner);
  if (id === 'profile') return readProfile(root, owner);
  const kind = id.startsWith('af_') ? 'atomic_fact' : id.startsWith('ep_') ? 'episode' : null;
  if (!kind) throw new Error('id 须是 ep_… / af_… 或 profile');
  const date = id.split('_')[1]; const file = root.dailyPath(kind, owner, `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
  // entry ids carry the UTC-or-local day they were written under; fall back to scanning the folder
  const dir = path.dirname(file), candidates = [file, ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)) : [])];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const parsed = readMarkdown(f), e = parsed.entries.find(x => x.id === id);
    if (e) return { id, kind, file: path.relative(officeRoot, f), deprecated_by: parsed.frontmatter.deprecated_entries?.[id] ?? null, ...parseStructuredEntry(e.body) };
  }
  throw new Error('未找到自己的记忆：' + id);
}

export async function run(action, argument) {
  const r = input(argument), owner = ownerCheck(r.owner);
  let result;
  if (action === 'status') result = status(owner);
  else if (action === 'show') result = show(owner, String(r.id || ''));
  else if (action === 'search' && r.method === 'agentic') {
    // LLM-guided multi-round recall: 1..3 model calls, logged to usage.jsonl (step 'recall'). For explicit look-backs, not for per-turn injection.
    const s = openStore(owner), { fn, m } = metered(codexChat(owner)), t0 = Date.now();
    try {
      await s.index.syncAll();
      const res = await agenticSearch({ searcher: new Searcher(s.index), decider: llmDecider(fn, r.tune), query: r.query, owner_id: owner, tune: { topK: r.topK ?? 10, ...(r.tune || {}) } });
      result = { method: 'agentic', rounds: res.rounds, core: res.core, failed_rounds: res.failed_rounds,
        items: res.items.map(i => ({ entry_id: i.row.entry_id, slot: i.slot, score: i.score, date: i.row.timestamp, subject: i.row.subject, episode: String(i.row.episode || '') })) };
      logUsage({ at: new Date().toISOString(), owner, step: 'recall', ms: Date.now() - t0, ...m, query: String(r.query).slice(0, 80), result: { rounds: res.rounds.length, core: res.core, failed_rounds: res.failed_rounds } });
    } finally { await s.index.close(); }
  } else if (action === 'search') {
    const s = openStore(owner, { gpu: r.method !== 'keyword' });
    try { await s.index.syncAll(); result = await new Searcher(s.index).search({ owner_id: owner, query: r.query, method: r.method ?? (s.embedder ? 'hybrid' : 'keyword'), kind: r.kind, topK: r.topK ?? 10, includeDeprecated: r.includeDeprecated === true, minScore: r.minScore }); }
    finally { await s.index.close(); }
  } else if (action === 'context') {
    const s = openStore(owner);
    try { await s.index.syncAll(); result = await buildContext({ owner, query: r.query, root: s.root, index: s.index, config: s.cfg.context || {} }); }
    finally { await s.index.close(); }
  } else if (action === 'sync') {
    const s = openStore(owner);
    try { result = (await s.index.syncAll()).map(x => ({ md_path: x.md_path, upserted: x.upserted, deleted: x.deleted, skipped: x.skipped })); } finally { await s.index.close(); }
  } else if (action === 'ingest') {
    const root = storeRoot(owner), llm = codexChat(owner), since = r.since ? Date.parse(r.since) : 0;
    if (r.since && !Number.isFinite(since)) throw new Error('since 须是 ISO 时间');
    result = await ingestOwner({ owner, root, sessions: sessions(), llm, sinceMs: since, limit: r.limit ?? Infinity, withFacts: r.facts !== false });
    if (!result.aborted) result.facts_backfill = await backfillFacts({ owner, root, llm, limit: r.limit ?? Infinity });
    if (result.failures.length || result.facts_backfill?.failures.length) process.exitCode = 1;
  } else if (action === 'reflect') {
    const s = openStore(owner), store = new ClusterStore(s.root);
    try { result = await runReflection({ root: s.root, store, embedder: s.embedder, llm: codexChat(owner), owner, dim: s.cfg.dim, index: s.index, threshold: s.cfg.cluster_threshold }); }
    finally { store.close(); await s.index.close(); }
  } else if (action === 'profile') {
    const { profile, ...rest } = await updateProfile({ owner, root: storeRoot(owner), sessions: sessions(), llm: codexChat(owner), maxCalls: r.maxCalls ?? Infinity });
    result = { ...rest, summary: profile?.summary };
  } else if (action === 'account') {
    result = accountRuns({ root: storeRoot(owner), owner, runsDir: path.join(officeRoot, '.runtime/agent/runs') });
  } else if (action === 'forget') {
    const root = storeRoot(owner);
    result = Array.isArray(r.restore) ? restoreEntries({ root, owner, ids: r.restore }) : Array.isArray(r.pin) ? pinEntries({ root, ids: r.pin, off: r.off === true }) : forgetOwner({ root, owner, dryRun: r.dryRun !== false });
  } else if (action === 'ledger') {
    const l = readLedger(storeRoot(owner)), rows = Object.entries(l.entries).map(([id, e]) => ({ id, ...e })).sort((a, b) => b.used - a.used || b.recalled - a.recalled);
    result = { owner, entries: rows.length, recalled: rows.reduce((n, e) => n + e.recalled, 0), used: rows.reduce((n, e) => n + e.used, 0), pinned: l.pinned, top: rows.slice(0, r.top ?? 10) };
  } else throw new Error('memory2 status|search|show|context|sync|ingest|reflect|profile|account|forget|ledger <JSON文件>');
  console.log(JSON.stringify(result));
}
