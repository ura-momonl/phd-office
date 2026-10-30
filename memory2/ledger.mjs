// Reinforcement and forgetting for memory2 (not in EverOS; designed here, 2026-10-25).
//   ledger : per episode, when it was injected and when the assistant then actually used it. Built from the work-turn records the office
//            already writes (memory-context.json, prompt.txt, events.jsonl); no model call, and it can be rebuilt from those records.
//   used   : the episode's id shows up in the assistant's output/tool calls, or the assistant's output repeats several words that appear
//            only in the injected memory (not anywhere else in that turn's prompt, i.e. not the user's own words or the profile).
//   activation/weight : ACT-R base-level activation over the encoding time and the use times (ledger-store.mjs); retrieval score x weight in context.mjs.
//   forget : activation below archiveB archives the episode with its facts; below factB (earlier) only the facts, the gist stays; facts come
//            back when the episode is active again. Archive = frontmatter deprecated_entries value `archived@YYYY-MM-DD` (search drops it,
//            `memory2 show` still reads it); an archive older than purgeAfterDays is deleted from the md. Legacy-migrated and pinned episodes are never archived.
//   merge  : a merged episode inherits the history of its sources (ledger-store.mjs inheritHistory, called from reflect.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './tokenizer.mjs';
import { patchFrontmatter, removeEntries, parseStructuredEntry } from './md.mjs';
import { loadEpisodes, factsByParent, walkDaily } from './reflect.mjs';
import { DAY, POLICY, ARCHIVE_PREFIX, ledgerFile, readLedger, writeLedger, activation, weightOf, inheritHistory } from './ledger-store.mjs';
export { DAY, POLICY, ARCHIVE_PREFIX, ledgerFile, readLedger, writeLedger, activation, weightOf, inheritHistory };

// ---- reading the injected block and the turn's output ------------------------------------------------------------------------
// Injected group (context.mjs): "<date> 《<subject>》 [<ep id>]（相关度 0.53）" then body lines indented by two spaces.
const GROUP_HEAD = /^(\d{4}-\d{2}-\d{2}) 《(.*)》 \[(ep_[A-Za-z0-9_]+)\]（相关度 [\d.]+）$/;
export function parseInjected(promptText) {
  const lines = String(promptText).split(/\r?\n/), groups = [];
  for (let i = 0; i < lines.length; i++) {
    const m = GROUP_HEAD.exec(lines[i]);
    if (!m) continue;
    const raw = [lines[i]];
    while (i + 1 < lines.length && /^ {2}\S/.test(lines[i + 1])) raw.push(lines[++i]);
    groups.push({ id: m[3], text: raw.slice(1).join('\n') + '\n' + m[2], raw: raw.join('\n') });
  }
  return groups;
}
function strings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}
// What the assistant said and did in one turn. Every provider writes its own shape into the same events.jsonl — Claude
// stream-json `{type:'assistant'}`, Codex app-server `item/completed` items and the DeepSeek harness `session.event`
// notifications — so all three are read here. Thinking is not included.
export function assistantOutput(eventsText) {
  const out = [];
  for (const line of String(eventsText).split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b.type === 'text') out.push(b.text);
        else if (b.type === 'tool_use') strings(b.input, out);
      }
      continue;
    }
    const item = j.params?.item;
    if (j.method === 'item/completed' && item) {
      if (item.type === 'agentMessage') { if (item.text) out.push(item.text); }
      else if (item.type === 'commandExecution') strings(item.aggregatedOutput, out);
      else if (item.type !== 'reasoning' && item.type !== 'userMessage') strings(item.arguments ?? item.command ?? item.path, out);
      continue;
    }
    const native = j.payload?.event;
    if (j.method === 'session.event' && native) {
      if (native.type === 'assistant/message') { for (const b of native.data?.message?.content || []) if (b.type === 'text') out.push(b.text); }
      else if (native.type === 'tool/call') strings(native.data?.arguments, out);
    }
  }
  return out.join('\n');
}
// Pure decision for one injected group. promptText = whole prompt of the turn; output = assistantOutput().
export function judgeUse(group, promptText, output, p = POLICY) {
  if (output.includes(group.id)) return { used: true, why: 'id' };
  const outside = promptText.split(group.raw).join('');
  const seen = new Set(tokenize(outside)), mine = [...new Set(tokenize(group.text))].filter(t => !seen.has(t));
  if (!mine.length) return { used: false, why: 'no-private-words', hits: 0, private: 0 };
  const said = new Set(tokenize(output)), hits = mine.filter(t => said.has(t));
  return { used: hits.length >= Math.max(p.minHits, Math.ceil(mine.length * p.hitShare)), why: 'words', hits: hits.length, private: mine.length };
}

// ---- accounting: runs -> ledger --------------------------------------------------------------------------------------------
// Scans the office's per-turn run folders newer than the ledger's watermark. A turn counts once its events file has been quiet for settleMinutes.
export function accountRuns({ root, owner, runsDir, now = Date.now(), p = POLICY, detail = null }) {
  const ledger = readLedger(root);
  let turns = 0, injected = 0, used = 0, maxMs = ledger.watermark_ms;
  // A run keeps turn 1 in its own folder and every later turn (handoff, @all, resumed execution) in a numbered subfolder.
  const turnDirs = [];
  if (fs.existsSync(runsDir)) for (const d of fs.readdirSync(runsDir)) {
    const dir = path.join(runsDir, d);
    if (fs.existsSync(path.join(dir, 'memory-context.json'))) turnDirs.push([d, dir]);
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (/^\d+$/.test(n) && fs.existsSync(path.join(dir, n, 'memory-context.json'))) turnDirs.push([d + '/' + n, path.join(dir, n)]);
  }
  for (const [d, dir] of turnDirs) {
    const mcFile = path.join(dir, 'memory-context.json');
    let st; try { st = fs.statSync(mcFile); } catch { continue; }
    if (st.mtimeMs <= ledger.watermark_ms) continue;
    const eventsFile = path.join(dir, 'events.jsonl');
    let quiet = st.mtimeMs; try { quiet = Math.max(quiet, fs.statSync(eventsFile).mtimeMs); } catch { /* no events yet */ }
    if (now - quiet < p.settleMinutes * 60000) continue;
    let mc; try { mc = JSON.parse(fs.readFileSync(mcFile, 'utf8')); } catch { maxMs = Math.max(maxMs, st.mtimeMs); continue; }
    maxMs = Math.max(maxMs, st.mtimeMs);
    if (mc.owner !== owner || !(mc.recalled_ids || []).some(x => /^ep_/.test(x))) continue;
    let prompt = '', events = '';
    try { prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'); events = fs.readFileSync(eventsFile, 'utf8'); } catch { continue; }
    const output = assistantOutput(events), groups = parseInjected(prompt);
    turns++;
    for (const g of groups) {
      const verdict = judgeUse(g, prompt, output, p), e = ledger.entries[g.id] ||= { recalled: 0, used: 0 };
      e.recalled++; e.last_recalled_ms = st.mtimeMs; injected++;
      if (verdict.used) { e.used++; e.last_used_ms = st.mtimeMs; e.uses = [...(e.uses || []), st.mtimeMs].slice(-p.maxEvents); used++; }
      detail?.push({ run: d, id: g.id, subject: g.text.split('\n').pop(), ...verdict });
    }
  }
  ledger.watermark_ms = maxMs;
  writeLedger(root, ledger);
  return { owner, turns, injected, used, entries: Object.keys(ledger.entries).length };
}

// ---- forgetting ------------------------------------------------------------------------------------------------------------
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// Archive by activation, restore details of revived episodes, then delete archives past the retention. dryRun only reports.
export function forgetOwner({ root, owner, now = Date.now(), p = POLICY, dryRun = false }) {
  const ledger = readLedger(root), pinned = new Set(ledger.pinned);
  const episodes = loadEpisodes(root, owner), facts = factsByParent(root, owner);
  const archivedFacts = new Map(); // parent episode id -> archived fact ids
  walkDaily(root, 'atomic_fact', owner, (file, parsed) => {
    const dep = parsed.frontmatter.deprecated_entries || {};
    for (const e of parsed.entries) {
      if (typeof dep[e.id] !== 'string' || !dep[e.id].startsWith(ARCHIVE_PREFIX)) continue;
      const parent = parseStructuredEntry(e.body).inline.parent_id;
      if (parent) archivedFacts.set(parent, [...(archivedFacts.get(parent) || []), e.id]);
    }
  });
  const toArchive = [], toArchiveFacts = [], toRestore = [];
  for (const ep of episodes.values()) {
    if (ep.parent_type === 'legacy' || pinned.has(ep.entry_id)) continue;
    if (ep.deprecated_by) continue; // merged away by reflection, or already archived
    const entry = ledger.entries[ep.entry_id], b = activation(ep.timestamp_ms, entry, now, p), live = facts.get(ep.entry_id) || [];
    const row = { id: ep.entry_id, subject: ep.subject, b: Math.round(b * 100) / 100, used: entry?.used || 0, file: ep.file, facts: live };
    if (b < p.archiveB) toArchive.push(row);
    else if (b < p.factB && live.length) toArchiveFacts.push(row);
    else if (b >= p.factRestoreB && archivedFacts.has(ep.entry_id)) toRestore.push(ep.entry_id);
  }
  const mark = ARCHIVE_PREFIX + isoDay(now), byFile = new Map();
  const add = (file, id) => { if (!byFile.has(file)) byFile.set(file, {}); byFile.get(file)[id] = mark; };
  for (const a of toArchive) add(a.file, a.id);
  for (const a of [...toArchive, ...toArchiveFacts]) for (const f of a.facts) add(f.file, f.entry_id);
  // archives past retention
  const doomed = new Map(); // file -> [ids]
  for (const kind of ['episode', 'atomic_fact']) walkDaily(root, kind, owner, (file, parsed) => {
    for (const [id, v] of Object.entries(parsed.frontmatter.deprecated_entries || {})) {
      if (typeof v !== 'string' || !v.startsWith(ARCHIVE_PREFIX)) continue;
      const at = Date.parse(v.slice(ARCHIVE_PREFIX.length));
      if (Number.isFinite(at) && now - at > p.purgeAfterDays * DAY) { if (!doomed.has(file)) doomed.set(file, []); doomed.get(file).push(id); }
    }
  });
  const purged = [...doomed.values()].flat();
  const restoredFacts = toRestore.reduce((n, id) => n + archivedFacts.get(id).length, 0);
  if (!dryRun) {
    if (toRestore.length) restoreEntries({ root, owner, ids: toRestore });
    for (const [file, map] of byFile) patchFrontmatter(file, { deprecated_entries: map });
    for (const [file, ids] of doomed) removeEntries(file, ids);
    if (purged.length) { for (const id of purged) delete ledger.entries[id]; writeLedger(root, ledger); }
  }
  const sample = list => list.slice(0, 10).map(({ id, subject, b, used }) => ({ id, subject: String(subject).slice(0, 40), activation: b, used }));
  return { owner, dry_run: dryRun, archived_episodes: toArchive.length, archived_facts: [...toArchive, ...toArchiveFacts].reduce((n, a) => n + a.facts.length, 0),
    facts_only_episodes: toArchiveFacts.length, restored_facts: restoredFacts, purged: purged.length, sample: sample(toArchive), sample_facts_only: sample(toArchiveFacts) };
}

// Undo an archive: the listed episodes/facts (and, for an episode, its archived facts) come back into search after the next sync.
// Only entries marked archived@… are touched; entries deprecated by a reflection merge stay deprecated.
export function restoreEntries({ root, owner, ids }) {
  const want = new Set(ids);
  let restored = 0;
  for (const kind of ['episode', 'atomic_fact']) walkDaily(root, kind, owner, (file, parsed) => {
    const dep = parsed.frontmatter.deprecated_entries || {}, keep = {}, parentOf = new Map();
    if (kind === 'atomic_fact') for (const e of parsed.entries) parentOf.set(e.id, parseStructuredEntry(e.body).inline.parent_id);
    let changed = false;
    for (const [id, v] of Object.entries(dep)) {
      if (typeof v === 'string' && v.startsWith(ARCHIVE_PREFIX) && (want.has(id) || want.has(parentOf.get(id)))) { changed = true; restored++; } else keep[id] = v;
    }
    if (!changed) return;
    patchFrontmatter(file, { deprecated_entries: undefined });
    if (Object.keys(keep).length) patchFrontmatter(file, { deprecated_entries: keep });
  });
  return { owner, restored };
}

export function pinEntries({ root, ids, off = false }) {
  const ledger = readLedger(root), set = new Set(ledger.pinned);
  for (const id of ids) off ? set.delete(id) : set.add(id);
  ledger.pinned = [...set]; writeLedger(root, ledger);
  return { pinned: ledger.pinned };
}
