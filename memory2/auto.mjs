// Unattended upkeep of memory2, driven by the backend's existing background beat (dashboard/server.mjs automate()); no timer of its own.
// For each owner in memory_v2.owners, when the office is idle (no running agent work, no chat message for `idle_minutes`):
//   every `ingest_hours`      -> extract episodes + atomic facts from closed conversation cells (cells still growing are deferred by ingestOwner), then account
//                                which injected memories the assistant used (ledger.mjs; no model call)
//   every `consolidate_hours` -> cluster/merge episodes (reflect), update the profile, then forget (archive long-idle episodes, delete old archives; no model call)
// An attempt is stamped before it runs, so a failing step is not retried until its next interval (no quota burn loop); per-cell failures
// are simply picked up by the next ingest. Every step appends its model-call count and prompt/output size to .runtime/memory2/usage.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { root, read } from '../automation/files.mjs';

const stateFile = path.join(root, '.runtime/memory2/auto.json'), usageFile = path.join(root, '.runtime/memory2/usage.jsonl');
export const AUTO_DEFAULTS = { enabled: false, idle_minutes: 30, ingest_hours: 24, consolidate_hours: 168 };
let running = false;

export function autoConfig(config = read('agent/config.json')) {
  const c = config.memory_v2;
  if (!c?.enabled || !c.auto?.enabled || !Array.isArray(c.owners) || !c.owners.length) return null;
  return { ...AUTO_DEFAULTS, ...c.auto, owners: c.owners };
}
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { owners: {} }; } };
const writeState = s => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)); };
const due = (at, hours, now) => !at || now - Date.parse(at) >= hours * 3600000;

export function logUsage(line) { fs.mkdirSync(path.dirname(usageFile), { recursive: true }); fs.appendFileSync(usageFile, JSON.stringify(line) + '\n'); }

// A model function that counts what it is asked, so usage.jsonl has numbers for every step.
export function metered(llm) {
  const m = { calls: 0, prompt_chars: 0, output_chars: 0, failed_calls: 0 };
  const fn = async (prompt, opts) => {
    m.calls++; m.prompt_chars += String(prompt).length;
    try { const out = await llm(prompt, opts); m.output_chars += String(out ?? '').length; return out; } catch (e) { m.failed_calls++; throw e; }
  };
  return { fn, m };
}

// deps (injected in tests): { busy(), lastChatMs(), steps: { ingest(owner, llm), reflect(owner, llm), profile(owner, llm) }, llm(owner) }
export async function memory2Tick({ now = Date.now(), deps = null, config = autoConfig() } = {}) {
  if (!config) return { state: 'disabled' };
  if (running) return { state: 'busy' };
  const d = deps || await defaultDeps();
  if (d.busy()) return { state: 'busy' };
  if (now - d.lastChatMs() < config.idle_minutes * 60000) return { state: 'not-idle' };
  const state = readState(), done = [];
  running = true;
  try {
    for (const owner of config.owners) {
      const own = state.owners[owner] ||= {};
      const steps = [];
      if (due(own.ingest_at, config.ingest_hours, now)) steps.push('ingest', 'account');
      if (due(own.consolidate_at, config.consolidate_hours, now)) steps.push('reflect', 'profile', 'forget');
      for (const step of steps) {
        const stamp = { ingest: 'ingest_at', reflect: 'consolidate_at' }[step];
        if (stamp) own[stamp] = new Date(now).toISOString(); // stamped before running; the later steps of a group share the first step's stamp
        writeState(state);
        const { fn, m } = metered(d.llm(owner)), t0 = Date.now();
        let result, error = null;
        try { result = await d.steps[step](owner, fn); } catch (e) { error = String(e.message).slice(0, 300); }
        const line = { at: new Date().toISOString(), owner, step, ms: Date.now() - t0, ...m, ...(error ? { error } : {}), result: summarize(result) };
        logUsage(line);
        done.push(line);
      }
    }
    return { state: done.length ? 'ran' : 'nothing-due', done };
  } finally { running = false; }
}
function summarize(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = Array.isArray(v) ? v.length : (typeof v === 'object' && v ? undefined : v);
  return out;
}

export async function defaultDeps() {
  const { agentWorkBusy } = await import('../agent/run.mjs');
  const { storeRoot, openStore } = await import('./run.mjs');
  const { codexChat } = await import('./llm.mjs');
  const { ingestOwner, backfillFacts } = await import('./extract.mjs');
  const { ClusterStore, runReflection } = await import('./reflect.mjs');
  const { updateProfile } = await import('./profile.mjs');
  const { accountRuns, forgetOwner } = await import('./ledger.mjs');
  const sessions = () => read('.runtime/agent/sessions.json', { sessions: [] }).sessions;
  return {
    busy: () => agentWorkBusy(),
    lastChatMs: () => Math.max(0, ...sessions().filter(s => s.origin === 'chat').flatMap(s => s.messages.map(m => Date.parse(m.at)).filter(Number.isFinite))),
    llm: owner => codexChat(owner),
    steps: {
      ingest: async (owner, llm) => {
        const r = storeRoot(owner), ing = await ingestOwner({ owner, root: r, sessions: sessions(), llm });
        return { ...ing, ...(!ing.aborted ? { facts_backfill: (await backfillFacts({ owner, root: r, llm })).facts } : {}) };
      },
      reflect: async (owner, llm) => {
        const s = openStore(owner), store = new ClusterStore(s.root);
        try { return await runReflection({ root: s.root, store, embedder: s.embedder, llm, owner, dim: s.cfg.dim, index: s.index, threshold: s.cfg.cluster_threshold }); }
        finally { store.close(); await s.index.close(); }
      },
      profile: async (owner, llm) => { const { profile, ...rest } = await updateProfile({ owner, root: storeRoot(owner), sessions: sessions(), llm }); return rest; },
      account: async owner => accountRuns({ root: storeRoot(owner), owner, runsDir: path.join(root, '.runtime/agent/runs') }),
      forget: async owner => { const r = storeRoot(owner); accountRuns({ root: r, owner, runsDir: path.join(root, '.runtime/agent/runs') }); return forgetOwner({ root: r, owner }); },
    },
  };
}
