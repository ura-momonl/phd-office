// Extraction for memory2 — a Node port of the EverOS user-memory pipeline (Apache-2.0):
//   everalgo user_memory/{episode,atomic_fact}.py + prompts/zh, everos memory/extract/pipeline/user_memory.py,
//   memory/strategies/extract_atomic_facts.py.
// conversation (sessions.json) -> MemCells -> Episode (one LLM call per cell) -> AtomicFacts (one call per episode) -> md.
//
// Deliberate deviation: upstream asks an LLM about every window. Here a first pass cuts cells by a long time gap (default 6 h,
// ours) and upstream's hard limits (8192 tokens / 50 messages). A pilot (2026-10-24, 20 random cells) found topic mixing only in
// big cells (>=40 messages: 3 of 4 mixed; 0 of 16 smaller ones), so upstream's batch boundary prompt (everalgo.boundary: one LLM
// call per cell, several cut points) runs only on cells that big (needsBoundary / detectCuts / splitAt, wired into ingestOwner).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendEntries, readMarkdown, parseStructuredEntry, KINDS } from './md.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS = JSON.parse(fs.readFileSync(path.join(here, 'prompts/zh.json'), 'utf8'));
export const OWNER_NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
export const USER_LABEL = '用户';
const TZ = 'America/Chicago'; // day buckets for the md files follow the user's local date

// ---- everalgo.prompts.render_prompt: str.format semantics, unknown {keys} left verbatim --------------------------
export function renderPrompt(template, fields) {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, key) => m === '{{' ? '{' : m === '}}' ? '}' : key in fields ? String(fields[key]) : m);
}

// ---- time formats (everalgo.llm.format / episode._format_prompt_time) --------------------------------------------
const pad = n => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatPromptTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC (${WEEKDAYS[d.getUTCDay()]})`;
}
export function formatAtomicFactTime(ms) { // "March 10, 2024(Sunday) at 02:00 PM"
  const d = new Date(ms), h = d.getUTCHours() % 12 || 12;
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()}(${WEEKDAYS[d.getUTCDay()]}) at ${pad(h)}:${pad(d.getUTCMinutes())} ${d.getUTCHours() >= 12 ? 'PM' : 'AM'}`;
}
export const localDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// ---- MemCells ----------------------------------------------------------------------------------------------------
export function estimateTokens(text) { // no tiktoken here: Han ~1 token each, everything else ~1 per 4 chars
  let han = 0; for (const c of text) if (/\p{Script=Han}/u.test(c)) han++;
  return han + Math.ceil((text.length - han) / 4);
}
const speakerOf = m => m.role === 'user' ? USER_LABEL : (OWNER_NAMES[m.provider] || m.provider || '助手');

// Messages of one session -> ordered cells. A cell must contain at least one assistant message by `owner`.
export function buildMemCells(session, owner, { sinceMs = 0, gapHours = 6, hardTokens = 8192, hardMessages = 50 } = {}) {
  const msgs = (session.messages || []).map((m, index) => ({ ...m, index, ms: Date.parse(m.at) }))
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim() && Number.isFinite(m.ms) && m.ms >= sinceMs);
  const cells = [], gapMs = gapHours * 3600000;
  let cur = [], tokens = 0;
  const flush = () => { if (cur.length) cells.push(cur); cur = []; tokens = 0; };
  for (const m of msgs) {
    const t = estimateTokens(`${speakerOf(m)}: ${m.text}`);
    if (cur.length && (m.ms - cur.at(-1).ms >= gapMs)) flush();
    else if (cur.length >= 2 && (tokens + t >= hardTokens || cur.length + 1 >= hardMessages)) flush();
    cur.push(m); tokens += t;
  }
  flush();
  return cells.filter(c => ownerTookPart(c, owner)).map(items => cellOf(session.id, items));
}
const ownerTookPart = (items, owner) => items.some(m => m.role === 'assistant' && m.provider === owner);
const cellOf = (sessionId, items) => ({
  id: 'mc_' + createHash('sha256').update([sessionId, items[0].index, items.at(-1).index, items.map(m => m.text).join('\n')].join('|')).digest('hex').slice(0, 12),
  session_id: sessionId, items, start_ms: items[0].ms, timestamp_ms: items.at(-1).ms,
  senders: [...new Set(items.map(speakerOf))],
});

// ---- Topic boundaries inside big cells (everalgo.boundary batch detection; its zh prompt is exported to prompts/zh.json) --
export const BOUNDARY_MIN_MESSAGES = 40, BOUNDARY_MIN_TOKENS = 7000;
export const needsBoundary = (cell, { boundaryMinMessages = BOUNDARY_MIN_MESSAGES, boundaryMinTokens = BOUNDARY_MIN_TOKENS } = {}) =>
  cell.items.length >= boundaryMinMessages || cell.items.reduce((a, m) => a + estimateTokens(m.text), 0) >= boundaryMinTokens;
const isoZ = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// Cut points are 1-based message numbers: a cut at b ends a sub-cell after message b (as upstream). Validated like upstream (1 <= b < n).
export async function detectCuts(llm, cell, { prompts = PROMPTS.boundary } = {}) {
  const n = cell.items.length, messages = cell.items.map((m, i) => `[${i + 1}] [${isoZ(m.ms)}] ${speakerOf(m)}: ${m.text}`).join('\n');
  return callJson(llm, renderPrompt(prompts.CHAT_BOUNDARY_DETECT_PROMPT_ZH, { messages }), 'memory2-boundary', d => {
    if (!Array.isArray(d.boundaries)) throw new Error(`boundaries must be a list: ${JSON.stringify(d).slice(0, 200)}`);
    const nums = d.boundaries.filter(x => x != null).map(Number);
    if (nums.some(x => !Number.isInteger(x))) throw new Error('boundaries must be integers');
    return [...new Set(nums.filter(x => x >= 1 && x < n))].sort((a, b) => a - b);
  });
}
// An episode summarises its whole cell, so a big cell loses detail: on 3 real 41-49 message cells, extracting whole gave ~20-40 facts, in
// 12-message pieces ~75-85 (cutting by topic gave no more). So a not-yet-extracted cell longer than maxMessages is cut into even pieces.
// Cells already extracted whole are never re-cut (the check is on the original id, before this runs), so nothing is written twice.
export const MAX_CELL_MESSAGES = 15;
export function splitBySize(cell, owner, max = MAX_CELL_MESSAGES) {
  const n = cell.items.length, k = max > 0 ? Math.ceil(n / max) : 1;
  if (k <= 1) return [cell];
  return splitAt(cell, Array.from({ length: k - 1 }, (_, j) => Math.round(n * (j + 1) / k)), owner);
}
// Sub-cells of `cell` cut at `cuts`; a piece the owner did not speak in is dropped, like any other cell.
export function splitAt(cell, cuts, owner) {
  const out = []; let prev = 0;
  for (const b of [...cuts, cell.items.length]) { const items = cell.items.slice(prev, b); prev = b; if (items.length && ownerTookPart(items, owner)) out.push(cellOf(cell.session_id, items)); }
  return out;
}

// ---- LLM output handling -----------------------------------------------------------------------------------------
export function extractJsonObject(text) { // first brace-balanced {...}, ignoring braces inside strings
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object found in LLM response: ${text.slice(0, 200)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`Unbalanced JSON in LLM response: ${text.slice(0, 200)}`);
}
export const tuning = { retryDelayMs: 3000 };
const startDenied = e => ['EPERM', 'EACCES'].includes(e.code) || /^spawn E(?:PERM|ACCES)\b/.test(e.message);
async function callJson(llm, prompt, purpose, validate) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) { // one retry on malformed output
    try {
      const text = await llm(prompt, { purpose });
      return validate(JSON.parse(extractJsonObject(String(text))));
    } catch (e) { if (startDenied(e)) throw e; lastError = e; if (attempt === 0) await new Promise(r => setTimeout(r, tuning.retryDelayMs)); } // transient Codex state-db races happen; one retry
  }
  throw lastError;
}

// ---- Episode (everalgo EpisodeExtractor) -------------------------------------------------------------------------
export function renderConversation(cell) {
  return cell.items.map(m => `
                {
                    "timestamp": ${formatPromptTime(m.ms)},
                    "speaker": ${speakerOf(m)},
                    "content": ${m.text}
                }`).join('\n');
}
export async function extractEpisode(llm, cell, owner, { prompts = PROMPTS.episode } = {}) {
  const rendered = renderPrompt(prompts.USER_EPISODE_GENERATION_PROMPT, {
    conversation_start_time: formatPromptTime(cell.start_ms), conversation: renderConversation(cell),
    custom_instructions: prompts.DEFAULT_CUSTOM_INSTRUCTIONS, user_name: OWNER_NAMES[owner] || owner });
  const data = await callJson(llm, rendered, 'memory2-episode', d => {
    if (!('title' in d) || !('content' in d)) throw new Error(`Episode LLM response missing required keys: ${JSON.stringify(d).slice(0, 200)}`);
    if (!String(d.content).trim()) throw new Error('Episode LLM response has empty content');
    return d;
  });
  const body = String(data.content), summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary : null; // upstream falls back to body[:200]; a mid-sentence cut is worse than no Summary
  return { subject: String(data.title), content: body, summary, timestamp_ms: cell.timestamp_ms };
}

// ---- Atomic facts (everalgo AtomicFactExtractor.aextract_from_text) ---------------------------------------------
export async function extractAtomicFacts(llm, text, timestampMs, { prompts = PROMPTS.atomic_fact_from_text } = {}) {
  const rendered = prompts.ATOMIC_FACT_FROM_TEXT_PROMPT_ZH.replaceAll('{{EPISODE_TEXT}}', text).replaceAll('{{TEXT}}', text).replaceAll('{{TIME}}', formatAtomicFactTime(timestampMs));
  const block = await callJson(llm, rendered, 'memory2-atomic-facts', d => {
    const b = d.event_log ?? d.atomic_facts;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('event_log/atomic_facts missing or not an object');
    if (!b.time) throw new Error('time key missing from LLM response');
    if (!Array.isArray(b.atomic_fact)) throw new Error('atomic_fact must be a list');
    return b;
  });
  return block.atomic_fact.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

// ---- Orchestration -----------------------------------------------------------------------------------------------
function inlineValues(root, kind, user, field) {
  const out = new Set(), dir = path.dirname(root.dailyPath(kind, user, '2000-01-01'));
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) for (const e of readMarkdown(path.join(dir, f)).entries) {
    const v = parseStructuredEntry(e.body).inline[field]; if (v) out.add(v);
  }
  return out;
}
export const processedCells = (root, user) => inlineValues(root, 'episode', user, 'parent_id');
export const factParents = (root, user) => inlineValues(root, 'atomic_fact', user, 'parent_id');

const episodeItem = (owner, cell, ep) => ({
  inline: { owner_id: owner, session_id: cell.session_id, timestamp: new Date(ep.timestamp_ms).toISOString(), parent_type: 'memcell', parent_id: cell.id, sender_ids: cell.senders },
  sections: { Subject: ep.subject, ...(ep.summary ? { Summary: ep.summary } : {}), Content: ep.content },
});
const factItem = (owner, sessionId, episodeId, tsMs, fact) => ({
  inline: { owner_id: owner, timestamp: new Date(tsMs).toISOString(), parent_type: 'episode', parent_id: episodeId, ...(sessionId ? { session_id: sessionId } : {}) },
  sections: { Fact: fact },
});

// sessions: array like .runtime/agent/sessions.json `sessions`. Idempotent: cells already written (by parent_id) are skipped.
// Returns a report; failures are listed, never silent, and leave no half-written cell (episode is written only after it parsed).
// A session's last cell is still open (it keeps growing, and its id changes with every message) until `gapHours` have passed since its last
// message; open cells are deferred, as upstream only extracts closed MemCells. Deferred ones are picked up by a later run.
// Big cells (needsBoundary) are split at topic changes first; the cut points are cached in <store>/boundaries.json, so a rerun never pays again.
// A big cell already extracted whole (its id is in `done`) is left alone, so nothing is written twice. Off by default (`boundary: true` turns it on): on 16 hand-labelled big cells it found 3 of 25 topic cuts, and splitting by topic added no facts beyond what splitting by size does.
export async function ingestOwner({ owner, root, sessions, llm, sinceMs = 0, limit = Infinity, only = null, withFacts = true, boundary = false, maxMessages = MAX_CELL_MESSAGES, cell: cellOptions = {}, now = Date.now(), onProgress = () => {} }) {
  const done = processedCells(root, owner), report = { owner, cells_seen: 0, skipped: 0, deferred_open: 0, boundary_calls: 0, boundary_splits: 0, episodes: 0, facts: 0, failures: [] };
  const cacheFile = path.join(root.root, 'boundaries.json'), cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const todo = [];
  for (const s of sessions) {
    if (s.origin === 'task') continue;
    const gapMs = (cellOptions.gapHours ?? 6) * 3600000, cells = buildMemCells(s, owner, { sinceMs, ...cellOptions });
    if (cells.length && now - cells.at(-1).timestamp_ms < gapMs) { cells.pop(); report.deferred_open++; }
    for (const cell of cells) { report.cells_seen++; if (only && !only.has(cell.id)) continue; if (done.has(cell.id)) report.skipped++; else todo.push(cell); }
  }
  todo.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const queue = [], add = c => { for (const p of splitBySize(c, owner, maxMessages)) { if (done.has(p.id)) report.skipped++; else queue.push(p); } };
  for (const cell of todo) {
    if (queue.length >= limit) break;
    if (!boundary || !needsBoundary(cell, cellOptions)) { add(cell); continue; }
    try {
      let cuts = cache[cell.id];
      if (!cuts) {
        cuts = await detectCuts(llm, cell); report.boundary_calls++;
        cache[cell.id] = cuts; fs.mkdirSync(root.root, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache));
      }
      const subs = splitAt(cell, cuts, owner);
      if (cuts.length) report.boundary_splits++;
      for (const sub of subs) add(sub);
    } catch (e) { report.failures.push({ cell: cell.id, session_id: cell.session_id, error: `boundary: ${String(e.message).slice(0, 300)}` }); if (startDenied(e)) return { ...report, aborted: 'process-start-denied' }; }
  }
  for (const cell of queue.slice(0, limit)) {
    try {
      const ep = await extractEpisode(llm, cell, owner);
      const [episodeId] = appendEntries(root, 'episode', owner, localDate(cell.timestamp_ms), [episodeItem(owner, cell, ep)]);
      report.episodes++; onProgress({ stage: 'episode', cell: cell.id, episodeId });
      if (withFacts) report.facts += await addFacts({ owner, root, llm, episodeId, sessionId: cell.session_id, text: ep.content, timestampMs: cell.timestamp_ms });
    } catch (e) { report.failures.push({ cell: cell.id, session_id: cell.session_id, error: String(e.message).slice(0, 300) }); if (startDenied(e)) return { ...report, aborted: 'process-start-denied' }; }
  }
  return report;
}
export async function addFacts({ owner, root, llm, episodeId, sessionId, text, timestampMs }) {
  const facts = await extractAtomicFacts(llm, text, timestampMs);
  if (!facts.length) return 0;
  appendEntries(root, 'atomic_fact', owner, localDate(timestampMs), facts.map(f => factItem(owner, sessionId, episodeId, timestampMs, f)));
  return facts.length;
}
// Episodes whose fact extraction failed earlier (no atomic_fact child): retry them without re-extracting the episode.
export async function backfillFacts({ owner, root, llm, limit = Infinity }) {
  const have = factParents(root, owner), dir = path.dirname(root.dailyPath('episode', owner, '2000-01-01')), report = { owner, episodes_without_facts: 0, facts: 0, failures: [] };
  if (!fs.existsSync(dir)) return report;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const parsed = readMarkdown(path.join(dir, f));
    for (const e of parsed.entries) {
      if (have.has(e.id) || parsed.frontmatter.deprecated_entries?.[e.id]) continue;
      if (report.episodes_without_facts >= limit) return report;
      report.episodes_without_facts++;
      const s = parseStructuredEntry(e.body);
      try { report.facts += await addFacts({ owner, root, llm, episodeId: e.id, sessionId: s.inline.session_id, text: s.sections.Content || '', timestampMs: Date.parse(s.inline.timestamp) }); }
      catch (err) { report.failures.push({ episode: e.id, error: String(err.message).slice(0, 300) }); if (startDenied(err)) return { ...report, aborted: 'process-start-denied' }; }
    }
  }
  return report;
}
export const KIND_DIRS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.dir]));
