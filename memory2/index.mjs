// Derived index for memory2: Markdown -> LanceDB, a Node port of EverOS's cascade handlers (Apache-2.0):
//   memory/cascade/handlers/{_daily_log_base,episode,_common}.py, infra/persistence/records/episode.py
// Markdown stays the source of truth; everything under <root>/.index can be deleted and rebuilt with syncAll().
// Per entry: content_sha256 over the content-bearing fields only decides whether to re-embed (audit fields never do);
// rows whose entry vanished from the md are deleted; frontmatter.deprecated_entries is projected onto deprecated_by.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Utf8, Float64, Float32, FixedSizeList } from 'apache-arrow';
import { readMarkdown, parseStructuredEntry, KINDS } from './md.mjs';
import { tokenizeJoined } from './tokenizer.mjs';

export const DEFAULT_DIM = 1024; // EverOS default; Qwen3-Embedding is Matryoshka-trained so truncation is near-lossless
const q = s => String(s).replaceAll("'", "''");

// ---- per-kind handlers -------------------------------------------------------------------------
// contentKeys: "section:Name" / "inline:name" — the digest covers only these.
const parseInlineList = raw => !raw || !raw.trim() ? [] : raw.trim().replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
export const HANDLERS = {
  episode: {
    contentKeys: ['section:Subject', 'section:Summary', 'section:Content'],
    embedTexts: s => { const t = (s.sections.Content || '').trim(), subj = (s.sections.Subject || '').trim(); return subj ? [t, subj] : [t]; },
    row(ctx, entry, s, vectors) {
      const text = (s.sections.Content || '').trim(), subject = (s.sections.Subject || '').trim();
      const ts = String(s.inline.timestamp || '').trim();
      if (!ts || Number.isNaN(Date.parse(ts))) throw new Error(`entry ${entry.id} 缺少有效 timestamp`);
      return {
        id: `${ctx.owner_id}_${entry.id}`, entry_id: entry.id, owner_id: ctx.owner_id, owner_type: 'user', app_id: ctx.app_id, project_id: ctx.project_id,
        session_id: s.inline.session_id || null, timestamp: ts, timestamp_ms: Date.parse(ts),
        parent_type: s.inline.parent_type || 'memcell', parent_id: s.inline.parent_id || '', sender_ids: parseInlineList(s.inline.sender_ids).join(','),
        subject: subject || null, summary: s.sections.Summary || null, episode: text, episode_tokens: tokenizeJoined(subject ? `${text} ${subject}` : text),
        md_path: ctx.md_path, content_sha256: entry.sha, deprecated_by: null, vector: vectors[0] ?? null, subject_vector: vectors[1] ?? null,
      };
    },
    ftsColumn: 'episode_tokens', textColumn: 'episode', schema: dim => episodeSchema(dim),
  },
  // memory/cascade/handlers/atomic_fact.py: one `Fact` section, embedded and BM25-tokenised; parent_id is the source episode entry id.
  atomic_fact: {
    contentKeys: ['section:Fact'],
    embedTexts: s => [(s.sections.Fact || '').trim()],
    row(ctx, entry, s, vectors) {
      const fact = (s.sections.Fact || '').trim(), ts = String(s.inline.timestamp || '').trim();
      if (!ts || Number.isNaN(Date.parse(ts))) throw new Error(`entry ${entry.id} 缺少有效 timestamp`);
      return {
        id: `${ctx.owner_id}_${entry.id}`, entry_id: entry.id, owner_id: ctx.owner_id, owner_type: 'user', app_id: ctx.app_id, project_id: ctx.project_id,
        session_id: s.inline.session_id || null, timestamp: ts, timestamp_ms: Date.parse(ts), parent_type: s.inline.parent_type || 'episode', parent_id: s.inline.parent_id || '',
        fact, fact_tokens: tokenizeJoined(fact), md_path: ctx.md_path, content_sha256: entry.sha, deprecated_by: null, vector: vectors[0] ?? null,
      };
    },
    ftsColumn: 'fact_tokens', textColumn: 'fact', schema: dim => factSchema(dim),
  },
};
const TABLE_OF = kind => kind; // table names match kinds

function factSchema(dim) {
  const vec = () => new FixedSizeList(dim, new Field('item', new Float32(), true));
  const s = name => new Field(name, new Utf8(), false), n = name => new Field(name, new Utf8(), true);
  return new Schema([s('id'), s('entry_id'), s('owner_id'), s('owner_type'), s('app_id'), s('project_id'), n('session_id'), s('timestamp'),
    new Field('timestamp_ms', new Float64(), false), s('parent_type'), s('parent_id'), s('fact'), s('fact_tokens'), s('md_path'), s('content_sha256'),
    n('deprecated_by'), new Field('vector', vec(), true)]);
}
function episodeSchema(dim) {
  const vec = () => new FixedSizeList(dim, new Field('item', new Float32(), true));
  const s = name => new Field(name, new Utf8(), false), n = name => new Field(name, new Utf8(), true);
  return new Schema([s('id'), s('entry_id'), s('owner_id'), s('owner_type'), s('app_id'), s('project_id'), n('session_id'), s('timestamp'),
    new Field('timestamp_ms', new Float64(), false), s('parent_type'), s('parent_id'), s('sender_ids'), n('subject'), n('summary'), s('episode'),
    s('episode_tokens'), s('md_path'), s('content_sha256'), n('deprecated_by'), new Field('vector', vec(), true), new Field('subject_vector', vec(), true)]);
}

export const contentSha256 = parts => createHash('sha256').update(Object.keys(parts).sort().map(k => `${k}=${parts[k]}`).join('\n'), 'utf8').digest('hex');
function entryDigest(handler, s) {
  const parts = {};
  for (const key of handler.contentKeys) {
    const [kind, ...rest] = key.split(':'), name = rest.join(':');
    if (kind === 'section') parts[key] = s.sections[name] || '';
    else if (kind === 'inline') parts[key] = s.inline[name] || '';
    else throw new Error(`unsupported content key ${key}`);
  }
  return contentSha256(parts);
}

export function truncateNormalize(vector, dim) {
  if (!vector) return null;
  if (vector.length < dim) throw new Error(`embedding 维度 ${vector.length} 小于索引维度 ${dim}`);
  const v = Array.from(vector.slice(0, dim));
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export class MemoryIndex {
  // embedder: { model: string, embed(texts: string[], {query?: boolean}) => Promise<number[][]> } | null  (null = keyword-only, like upstream without [embedding])
  constructor(root, { embedder = null, dim = DEFAULT_DIM } = {}) {
    this.root = root; this.embedder = embedder; this.dim = dim; this.db = null; this.tables = new Map();
    this.dir = path.join(root.indexDir(), 'lancedb'); this.metaFile = path.join(root.indexDir(), 'meta.json');
  }
  async open() {
    if (this.db) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    const want = { embedding_model: this.embedder?.model ?? null, dim: this.dim };
    if (fs.existsSync(this.metaFile)) {
      const have = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (have.dim !== want.dim) throw new Error(`索引维度 ${have.dim} 与当前 ${want.dim} 不符：删除 .index 后用 syncAll() 重建`);
      if (this.embedder && have.embedding_model && have.embedding_model !== want.embedding_model)
        throw new Error(`索引由模型 ${have.embedding_model} 建立，当前是 ${want.embedding_model}：删除 .index 后重建`);
      if (this.embedder && !have.embedding_model) fs.writeFileSync(this.metaFile, JSON.stringify(want));
    } else fs.writeFileSync(this.metaFile, JSON.stringify(want));
    this.db = await lancedb.connect(this.dir);
    return this;
  }
  async table(kind) {
    await this.open();
    if (this.tables.has(kind)) return this.tables.get(kind);
    const name = TABLE_OF(kind), have = await this.db.tableNames();
    const t = have.includes(name) ? await this.db.openTable(name) : await this.db.createEmptyTable(name, HANDLERS[kind].schema(this.dim));
    this.tables.set(kind, t);
    return t;
  }
  relative(file) { return path.relative(this.root.root, path.resolve(file)).split(path.sep).join('/'); }
  kindOf(mdPath) {
    const dirName = mdPath.split('/')[4]; // <app>/<project>/users/<user>/<dir>/<file>
    return Object.keys(KINDS).find(k => KINDS[k].dir === dirName && HANDLERS[k]) || null;
  }

  // Reconcile one md file against its rows: hash mismatch -> embed + upsert; missing entry -> delete; then deprecations.
  async syncFile(file, { fts = true } = {}) {
    const md_path = this.relative(file), kind = this.kindOf(md_path);
    if (!kind) return { md_path, skipped_kind: true };
    const handler = HANDLERS[kind], table = await this.table(kind);
    const parts = md_path.split('/');
    const ctx = { md_path, app_id: parts[0] === 'default_app' ? 'default' : parts[0], project_id: parts[1] === 'default_project' ? 'default' : parts[1] };
    const abs = this.root.within(path.join(this.root.root, md_path));
    const parsed = readMarkdown(abs);
    ctx.owner_id = String(parsed.frontmatter.user_id || parts[3]);
    const entries = parsed.entries.map(e => { const s = parseStructuredEntry(e.body); return { id: e.id, s, sha: entryDigest(handler, s) }; });
    const existing = await table.query().where(`md_path = '${q(md_path)}'`).select(['entry_id', 'content_sha256', 'deprecated_by']).limit(100000).toArray();
    const byEntry = new Map(existing.map(r => [r.entry_id, r]));
    const unvectored = this.embedder ? new Set((await table.query().where(`md_path = '${q(md_path)}' AND vector IS NULL`).select(['entry_id']).limit(100000).toArray()).map(r => r.entry_id)) : new Set();
    const build = entries.filter(e => { const p = byEntry.get(e.id); return !p || p.content_sha256 !== e.sha || unvectored.has(e.id); });
    let upserted = 0;
    if (build.length) {
      const textsPer = build.map(e => handler.embedTexts(e.s)), flat = textsPer.flat();
      let vectors = flat.map(() => null);
      if (this.embedder && flat.length) vectors = (await this.embedder.embed(flat, { query: false })).map(v => truncateNormalize(v, this.dim));
      let cursor = 0;
      const rows = build.map((e, i) => { const vs = vectors.slice(cursor, cursor + textsPer[i].length); cursor += textsPer[i].length; return handler.row(ctx, e, e.s, vs); });
      await table.mergeInsert(['app_id', 'project_id', 'id']).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
      upserted = rows.length;
    }
    const alive = new Set(entries.map(e => e.id)), gone = existing.filter(r => !alive.has(r.entry_id)).map(r => r.entry_id);
    if (gone.length) await table.delete(`md_path = '${q(md_path)}' AND entry_id IN (${gone.map(g => `'${q(g)}'`).join(',')})`);
    // md is the source of truth for deprecated_by: set what the frontmatter lists, clear what it no longer lists.
    const want = parsed.frontmatter.deprecated_entries && typeof parsed.frontmatter.deprecated_entries === 'object' ? parsed.frontmatter.deprecated_entries : {};
    const current = await table.query().where(`md_path = '${q(md_path)}'`).select(['entry_id', 'deprecated_by']).limit(100000).toArray();
    let deprecations = 0;
    for (const r of current) {
      const target = want[r.entry_id] ?? null;
      if ((r.deprecated_by ?? null) === target) continue;
      const where = `md_path = '${q(md_path)}' AND entry_id = '${q(r.entry_id)}'`;
      await table.update(target === null ? { where, valuesSql: { deprecated_by: 'NULL' } } : { where, values: { deprecated_by: target } });
      deprecations++;
    }
    if (fts && (upserted || gone.length)) await this.refreshFts(kind);
    return { md_path, kind, upserted, deleted: gone.length, skipped: entries.length - build.length, deprecations };
  }
  async dropFile(file, { fts = true } = {}) {
    const md_path = this.relative(file), kind = this.kindOf(md_path);
    if (!kind) return { md_path, deleted: 0 };
    const table = await this.table(kind), n = await table.countRows(`md_path = '${q(md_path)}'`);
    if (n) { await table.delete(`md_path = '${q(md_path)}'`); if (fts) await this.refreshFts(kind); }
    return { md_path, kind, deleted: n };
  }
  async refreshFts(kind) {
    const table = await this.table(kind);
    if (!(await table.countRows())) return;
    await table.createIndex(HANDLERS[kind].ftsColumn, { config: lancedb.Index.fts({ baseTokenizer: 'whitespace', lowercase: false, stem: false, removeStopWords: false, asciiFolding: false }), replace: true });
  }

  // Walk every daily-log md under the root, sync it, and drop rows of files that no longer exist (reconciler).
  async syncAll() {
    const files = [];
    const walk = dir => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.index' || d.name.startsWith('.tmp')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full); else if (d.name.endsWith('.md') && this.kindOf(this.relative(full))) files.push(full);
    } };
    if (fs.existsSync(this.root.root)) walk(this.root.root);
    const results = [], touched = new Set();
    for (const f of files) {
      const r = await this.syncFile(f, { fts: false });
      if (r.upserted || r.deleted) touched.add(r.kind);
      results.push(r);
    }
    const present = new Set(files.map(f => this.relative(f)));
    for (const kind of Object.keys(HANDLERS)) {
      const table = await this.table(kind);
      const paths = new Set((await table.query().select(['md_path']).limit(1000000).toArray()).map(r => r.md_path));
      for (const p of paths) if (!present.has(p)) { const r = await this.dropFile(path.join(this.root.root, p), { fts: false }); if (r.deleted) touched.add(kind); results.push(r); }
    }
    // One index rebuild per kind per pass: rebuilding after every file left a replaced index copy behind each time.
    for (const kind of touched) await this.refreshFts(kind);
    await this.compact();
    return results;
  }
  // LanceDB keeps every past version, and each replaced index copy with it: a few hundred rows were holding 160MB,
  // roughly all of it old copies. One optimize per day rewrites the fragments and drops what nothing points at.
  // Markdown stays the source of truth, so if this ever left the index unreadable, delete .index and run syncAll again.
  async compact({ now = Date.now() } = {}) {
    await this.open();
    const marker = path.join(this.root.indexDir(), 'compacted.json');
    try { if (now - Date.parse(JSON.parse(fs.readFileSync(marker, 'utf8')).at) < 6 * 3600e3) return null; } catch { /* never compacted */ }
    const stats = {};
    for (const name of await this.db.tableNames()) {
      const table = await this.db.openTable(name);
      stats[name] = await table.optimize({ cleanupOlderThan: new Date(now - 6 * 3600e3), deleteUnverified: true });
    }
    fs.writeFileSync(marker, JSON.stringify({ at: new Date(now).toISOString(), tables: stats }));
    return stats;
  }
  async close() { this.tables.clear(); this.db?.close?.(); this.db = null; }
}
