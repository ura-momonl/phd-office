// Ledger file, activation and weight for memory2 reinforcement/forgetting (see ledger.mjs for the whole picture).
// Kept free of any import from reflect.mjs so that reflect.mjs can record merge inheritance without an import cycle.
//
// Activation is the ACT-R base-level equation: B = ln( sum_j max(1, days since event j) ^ -d ), d = 0.5.
// Events are the episode's encoding (its timestamp) plus every time the assistant used it. This gives power-law forgetting
// (fast at first, then slow), more use = stronger, and a recent use counts more than an old one.
import fs from 'node:fs';
import path from 'node:path';

export const DAY = 86400000;
export const POLICY = {
  decay: 0.5, minDays: 1, maxEvents: 30,
  weightRef: 2.0, weightSlope: 0.1, weightFloor: 0.7, weightCap: 1.3, // weight = clamp(1 + slope*(B + ref)); B=-2 (about 60 idle days, never used) is neutral
  archiveB: -2.5,       // episode is archived below this (about 160 idle days when never used)
  factB: -2.2,          // an episode's facts (details) are archived earlier than the episode (about 80 idle days when never used)
  factRestoreB: -1.9,   // archived facts come back once the episode is active again (hysteresis against flapping)
  purgeAfterDays: 365, settleMinutes: 10, minHits: 3, hitShare: 0.25,
};
export const ARCHIVE_PREFIX = 'archived@';

export const ledgerFile = root => path.join(root.root, 'ledger.json');
export function readLedger(root) {
  try { const j = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8')); return { watermark_ms: 0, entries: {}, pinned: [], ...j }; }
  catch { return { watermark_ms: 0, entries: {}, pinned: [] }; }
}
export function writeLedger(root, ledger) { fs.mkdirSync(root.root, { recursive: true }); fs.writeFileSync(ledgerFile(root), JSON.stringify(ledger, null, 1)); }

export function activation(timestampMs, entry, now = Date.now(), p = POLICY) {
  let sum = 0;
  for (const t of [timestampMs, ...(entry?.uses || [])]) {
    if (!Number.isFinite(t)) continue;
    sum += Math.max(p.minDays, (now - t) / DAY) ** -p.decay;
  }
  return sum > 0 ? Math.log(sum) : -Infinity;
}
export function weightOf(timestampMs, entry, now = Date.now(), p = POLICY) {
  const b = activation(timestampMs, entry, now, p);
  return Math.min(p.weightCap, Math.max(p.weightFloor, 1 + p.weightSlope * (b + p.weightRef)));
}

// A merged (consolidated) episode keeps the history of the episodes it replaces: their encodings and uses are pooled, and the merge
// itself counts as one more reactivation (consolidation replays the memory). Called by reflect.mjs after a merge.
export function inheritHistory({ root, mergedId, sources, now = Date.now(), p = POLICY }) {
  const ledger = readLedger(root), pool = [now];
  let recalled = 0, used = 0, lastUsed = 0, lastRecalled = 0;
  for (const s of sources) {
    const e = ledger.entries[s.id];
    pool.push(s.timestamp_ms, ...(e?.uses || []));
    recalled += e?.recalled || 0; used += e?.used || 0;
    lastUsed = Math.max(lastUsed, e?.last_used_ms || 0); lastRecalled = Math.max(lastRecalled, e?.last_recalled_ms || 0);
  }
  const uses = [...new Set(pool.filter(Number.isFinite))].sort((a, b) => a - b).slice(-p.maxEvents);
  ledger.entries[mergedId] = { recalled, used, ...(lastRecalled ? { last_recalled_ms: lastRecalled } : {}), ...(lastUsed ? { last_used_ms: lastUsed } : {}), uses, merged_from: sources.map(s => s.id) };
  writeLedger(root, ledger);
  return ledger.entries[mergedId];
}
