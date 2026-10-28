// Markdown store for memory2 — a Node port of EverOS's markdown layer.
// Ported from EverMind-AI/EverOS (Apache-2.0):
//   core/persistence/markdown/{entries,frontmatter,writer}.py, infra/persistence/markdown/writers/base.py
// Differences: no pydantic/anyio; cross-process safety is a lock file next to the target.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

// ---- EntryId: <prefix>_<YYYYMMDD>_<NNNNNNNN> -------------------------------------------------
const SEQ_DIGITS = 8;
export const compactDate = d => d.replaceAll('-', '');
export function formatEntryId(prefix, date, seq) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  return `${prefix}_${compactDate(date)}_${String(seq).padStart(SEQ_DIGITS, '0')}`;
}
export function parseEntryId(id) {
  const parts = String(id).split('_');
  if (parts.length < 3) throw new Error(`invalid entry id format: ${id}`);
  const seqText = parts.pop(), dateText = parts.pop(), prefix = parts.join('_');
  if (!prefix) throw new Error(`empty prefix in entry id: ${id}`);
  if (!/^\d{8}$/.test(dateText)) throw new Error(`invalid date in entry id: ${id}`);
  if (!/^\d+$/.test(seqText)) throw new Error(`invalid seq in entry id: ${id}`);
  return { prefix, date: `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`, seq: Number(seqText) };
}

// ---- Entries: <!-- entry:ID --> ... <!-- /entry:ID --> ---------------------------------------
const ID_PATTERN = '[A-Za-z0-9_-]+';
const stripOneNewline = text => text.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function splitEntries(body) {
  const entries = [], open = new RegExp(`<!-- entry:(${ID_PATTERN}) -->`, 'g');
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(body);
    if (!o) break;
    const closeRe = new RegExp(`<!-- /entry:${escapeRe(o[1])} -->`, 'g');
    closeRe.lastIndex = o.index + o[0].length;
    const c = closeRe.exec(body);
    if (!c) break; // unterminated entry: stop, as upstream does
    entries.push({ id: o[1], body: stripOneNewline(body.slice(o.index + o[0].length, c.index)), start: o.index, end: c.index + c[0].length });
    pos = c.index + c[0].length;
  }
  return entries;
}
export const findEntry = (body, id) => splitEntries(body).find(e => e.id === id) || null;

// Audit form: "## header", "**key**: value" lines, then "### Title" sections.
const renderValue = v => v == null ? '' : Array.isArray(v) ? '[' + v.map(String).join(', ') + ']' : String(v);
export function renderStructuredEntry({ header, inline = {}, sections = {} } = {}) {
  const lines = [];
  if (header) lines.push(`## ${header}`, '');
  for (const [k, v] of Object.entries(inline)) lines.push(`**${k}**: ${renderValue(v)}`);
  for (const [title, text] of Object.entries(sections)) lines.push('', `### ${title}`, String(text).replace(/\s+$/, ''));
  return lines.join('\n');
}
export function parseStructuredEntry(body) {
  const text = body.replace(/^\n+|\n+$/g, ''), parts = text.split(/^###[ \t]+(.+?)[ \t]*$/m);
  const head = parts[0], sections = {}, inline = {};
  for (let i = 1; i < parts.length; i += 2) sections[parts[i].trim()] = (parts[i + 1] || '').replace(/^\n+/, '').replace(/\s+$/, '');
  const h2 = head.match(/^##[ \t]+(.+?)[ \t]*$/m);
  for (const m of head.matchAll(/^\*\*([^*\n]+?)\*\*:[ \t]*(.*?)[ \t]*$/gm)) inline[m[1].trim()] = m[2].trim();
  return { header: h2 ? h2[1].trim() : null, inline, sections };
}

// ---- Frontmatter (YAML, via the yaml package; same contract as upstream parse_frontmatter / dump_frontmatter) ----
export function dumpFrontmatter(meta) {
  if (!Object.keys(meta).length) return '';
  return '---\n' + YAML.stringify(meta, { lineWidth: 0 }) + '---\n';
}
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, rest: text };
  let rest = text.slice(3);
  if (rest.startsWith('\r\n')) rest = rest.slice(2); else if (rest.startsWith('\n')) rest = rest.slice(1); else return { meta: {}, rest: text };
  const m = rest.match(/^---[ \t]*\r?$/m);
  if (!m) return { meta: {}, rest: text };
  const block = rest.slice(0, m.index), after = rest.slice(m.index + m[0].length).replace(/^\r?\n/, '');
  let parsed = null;
  try { parsed = block.trim() ? YAML.parse(block) : {}; } catch { return { meta: {}, rest: text }; }
  if (parsed == null) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { meta: {}, rest: text };
  return { meta: parsed, rest: after };
}

// ---- Atomic file operations -----------------------------------------------------------------
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${randomUUID()}`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let attempt = 0; ; attempt++) { // Windows: another process may briefly hold the target
      try { fs.renameSync(tmp, file); break; }
      catch (e) { if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; sleepMs(25 * 2 ** attempt); }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}
// Cross-process lock for a read-modify-write on one file. Stale locks (dead pid or >30 s) are taken over.
export function withFileLock(file, fn) {
  const lock = file + '.lock';
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 30000; } catch { continue; }
      if (stale) { fs.rmSync(lock, { force: true }); continue; }
      if (attempt > 200) throw new Error(`lock timeout: ${lock}`);
      sleepMs(25);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

export function readMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { meta, rest } = parseFrontmatter(text);
  return { frontmatter: meta, body: rest, entries: splitEntries(rest) };
}

// ---- Layout: <root>/<app>/<project>/users/<user>/{episodes,.atomic_facts,.foresights}/<prefix>-<date>.md ---------
export const KINDS = {
  episode: { prefix: 'ep', dir: 'episodes', file: 'episode', type: 'episode_daily' },
  atomic_fact: { prefix: 'af', dir: '.atomic_facts', file: 'atomic_fact', type: 'atomic_fact_daily' },
  foresight: { prefix: 'fs', dir: '.foresights', file: 'foresight', type: 'foresight_daily' },
};
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function safeSegment(value, label) {
  const s = String(value);
  if (!SAFE.test(s) || s.includes('..')) throw new Error(`${label} 不是安全的目录名: ${s}`);
  return s;
}
export class MemoryRoot {
  constructor(root) { this.root = path.resolve(root); }
  within(target) {
    const full = path.resolve(target);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('路径越出记忆根目录');
    return full;
  }
  scope(app = 'default', project = 'default') {
    return path.join(this.root, app === 'default' ? 'default_app' : safeSegment(app, 'app_id'), project === 'default' ? 'default_project' : safeSegment(project, 'project_id'));
  }
  userDir(user, { app, project } = {}) { return this.within(path.join(this.scope(app, project), 'users', safeSegment(user, 'user_id'))); }
  dailyPath(kind, user, date, scope = {}) {
    const k = KINDS[kind];
    return this.within(path.join(this.userDir(user, scope), k.dir, `${k.file}-${date}.md`));
  }
  profilePath(user, scope = {}) { return this.within(path.join(this.userDir(user, scope), 'user.md')); }
  indexDir() { return this.within(path.join(this.root, '.index')); }
}

// Append entries to a daily-log file in one locked read-modify-write; returns the allocated entry ids.
// entry_count never falls behind the highest sequence already in the file (a hand-edited count must not reuse an id).
export function appendEntries(root, kind, user, date, items, { scope = {}, now = new Date().toISOString() } = {}) {
  if (!items.length) return [];
  const k = KINDS[kind], file = root.dailyPath(kind, user, date, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    let meta = {}, body = '';
    if (fs.existsSync(file)) { const parsed = readMarkdown(file); meta = parsed.frontmatter; body = parsed.body; }
    const highest = splitEntries(body).reduce((h, e) => { try { return Math.max(h, parseEntryId(e.id).seq); } catch { return h; } }, 0);
    const base = Math.max(Number.isInteger(meta.entry_count) ? meta.entry_count : 0, highest);
    const ids = items.map((_, i) => formatEntryId(k.prefix, date, base + i + 1));
    const blocks = items.map((item, i) => `<!-- entry:${ids[i]} -->\n${renderStructuredEntry({ header: ids[i], ...item })}\n<!-- /entry:${ids[i]} -->\n`);
    const next = {
      id: `${k.file}_log_${user}_${date}`, type: k.type, file_type: k.type, schema_version: 1, user_id: user, track: 'user', date,
      entry_count: base + items.length, created_at: meta.created_at || now, last_appended_at: now,
      ...(meta.deprecated_entries && Object.keys(meta.deprecated_entries).length ? { deprecated_entries: meta.deprecated_entries } : {}),
    };
    const prefix = body && !body.endsWith('\n') ? body + '\n' : body;
    writeAtomic(file, dumpFrontmatter(next) + (prefix ? prefix + '\n' : '') + blocks.join('\n'));
    return ids;
  });
}

// Merge updates into an existing file's frontmatter (used to record deprecated_entries after a merge).
export function patchFrontmatter(file, updates) {
  return withFileLock(file, () => {
    const { frontmatter, body } = readMarkdown(file);
    const merged = { ...frontmatter };
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) { delete merged[k]; continue; } // undefined removes the key
      merged[k] = v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object' ? { ...merged[k], ...v } : v;
    }
    writeAtomic(file, dumpFrontmatter(merged) + body);
  });
}

// Physically delete entries from a daily-log file (and their deprecated_entries records). entry_count is left alone, so an id is never reused.
// A file left with no entries is removed. Returns how many entries were deleted.
export function removeEntries(file, ids) {
  const drop = new Set(ids);
  return withFileLock(file, () => {
    const { frontmatter, body, entries } = readMarkdown(file);
    const doomed = entries.filter(e => drop.has(e.id));
    if (!doomed.length) return 0;
    let next = '', pos = 0;
    for (const e of doomed) { next += body.slice(pos, e.start); pos = e.end; }
    next += body.slice(pos);
    next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    const dep = { ...(frontmatter.deprecated_entries || {}) };
    for (const id of drop) delete dep[id];
    const meta = { ...frontmatter };
    if (Object.keys(dep).length) meta.deprecated_entries = dep; else delete meta.deprecated_entries;
    if (!splitEntries(next).length) fs.rmSync(file, { force: true });
    else writeAtomic(file, dumpFrontmatter(meta) + next);
    return doomed.length;
  });
}

// Whole-file rewrite for user.md (profile): frontmatter + body.
export function writeDocument(file, meta, body) { writeAtomic(file, dumpFrontmatter(meta) + body); }
