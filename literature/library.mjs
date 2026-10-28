// 本地文献库骨架：SQLite（内置 node:sqlite，FTS5 全文索引）。
// 原则：catalog.json + fulltext/*.pdf 是事实来源；本库是可随时重建的派生索引，丢了不丢数据。
// 阶段（每阶段独立、可单独运行，状态记在 stage 里）：
//   candidate -> picked -> fulltext -> indexed -> read
//   discover(程序)   助手筛选   fetch(逐篇)   ingest(待做)   你/助手阅读并留笔记
// ingest 使用本机 GPU MinerU；既有索引按 PDF 哈希跳过，不自动迁移或整库重建。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { root } from '../automation/files.mjs';
import { pdfTextExecutable } from './pdf-tools.mjs';

// LIT_DB 环境变量可把索引指到别处（做对照实验用，不碰正式库）。
export const DB_FILE = process.env.LIT_DB ? path.resolve(process.env.LIT_DB) : path.join(root, '.runtime/literature/library.sqlite');
export const STAGES = ['candidate', 'picked', 'fulltext', 'indexed', 'read'];

const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists papers(
  id text primary key,            -- 与 catalog.json 的 id 一致（doi-<sha256 前16位>）
  doi text unique not null, title text, year integer, source text,
  stage text not null default 'candidate' check (stage in ('candidate','picked','fulltext','indexed','read')),
  picked_reason text,             -- 助手/用户选它的理由，一句话
  pdf_path text, pdf_sha256 text, updated_at text);
create table if not exists chunks(
  id integer primary key, paper_id text not null references papers(id) on delete cascade,
  page integer, ord integer, text text not null);
create virtual table if not exists chunks_fts using fts5(
  text, content='chunks', content_rowid='id', tokenize='porter unicode61');
create table if not exists embeddings(
  chunk_id integer primary key references chunks(id) on delete cascade,
  model text not null, dim integer not null, vec blob not null);
create table if not exists notes(
  id integer primary key, paper_id text references papers(id) on delete cascade,
  page integer, text text not null, created_at text);
create index if not exists chunks_paper on chunks(paper_id);
`;

export function open() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('pragma foreign_keys = on; pragma journal_mode = wal;');
  db.exec(SCHEMA);
  db.prepare("insert or ignore into meta values('schema_version','1')").run();
  if (!db.prepare("select 1 from pragma_table_info('chunks') where name='kind'").get()) db.exec("alter table chunks add column kind text not null default 'body'");
  return db;
}

export function status() {
  const db = open();
  try {
    const stages = Object.fromEntries(db.prepare('select stage, count(*) n from papers group by stage').all().map(r => [r.stage, r.n]));
    const one = sql => db.prepare(sql).get().n;
    return { db: DB_FILE, schema_version: db.prepare("select value from meta where key='schema_version'").get().value,
      papers: one('select count(*) n from papers'), stages, chunks: one('select count(*) n from chunks'),
      embeddings: one('select count(*) n from embeddings'), notes: one('select count(*) n from notes'),
      implemented: ['init', 'status', 'ingest', 'search(FTS5)', 'embed(GPU)', 'hybrid search(RRF)'], not_implemented: ['notes 索引', '页码高亮'] };
  } finally { db.close(); }
}

// ---- 文字清洗与切块工具；pdfPages 仅用于显式提字诊断，不再作为入库回退。----
const CHUNK_TARGET = 1200, CHUNK_MAX = 1800;
const REFS_RE = /^\s*(references?|bibliography|literature cited)\s*$/i;

// 出版商下载水印（Wiley/ACS 等“Downloaded from … by <学校>”）和每页重复的页眉页脚不是正文：先去掉，免得污染检索，且库越大越多。
const WATERMARK_RE = /^\s*(?:\d{6,},\s*\d+,\s*)?Downloaded from |terms-and-conditions|rules of use; OA articles|applicable Creative Commons License/i;
export function cleanPages(pages) {
  const norm = l => l.trim().replace(/\d+/g, '#');
  const where = new Map(); // 规范化后的行 -> 出现过的页集合
  pages.forEach((t, i) => { for (const l of t.split('\n')) { const k = norm(l); if (k.length >= 12) (where.get(k) || where.set(k, new Set()).get(k)).add(i); } });
  const repeated = new Set([...where].filter(([, ps]) => ps.size >= 3 && ps.size >= pages.length * 0.25).map(([k]) => k));
  return pages.map(t => t.split('\n').filter(l => !WATERMARK_RE.test(l) && !repeated.has(norm(l))).join('\n'));
}

export function pdfPages(file) {
  const r = spawnSync(pdfTextExecutable(), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120000, windowsHide: true });
  if (r.status !== 0 && !r.stdout) throw new Error('pdftotext 失败：' + String(r.stderr).slice(0, 200));
  return cleanPages(r.stdout.replace(/[​\r]/g, '').split('\f').map(t => t.replace(/-\n(?=[a-z])/g, '').replace(/[ \t]+\n/g, '\n')));
}

// 无“References”标题时（APS 等）按内容判断：年份/卷期/作者缩写密集的块视为参考文献。
export function looksLikeRefs(t) {
  const years = (t.match(/\b(?:19|20)\d{2}\b/g) || []).length;
  const cites = (t.match(/\b\d{1,4},\s*\d{2,6}\s*\(\s*(?:19|20)\d{2}\s*\)|\b(?:19|20)\d{2}\s*,\s*\d{1,4}\s*,\s*\d{2,6}|[A-Z]\.\s?(?:[A-Z]\.\s?)*[A-Z][a-z]+,\s*[A-Z]\.|\(\d{1,3}\)\s+[A-Z][A-Za-z'-]+,\s+[A-Z]\.|\b\d{1,3}\.\s+[A-Z]\.\s?(?:[A-Z]\.\s?)*[A-Z][a-z]+,|\b\d{1,4},\s*\d{1,6}\s*[-–—]\s*\d{1,6}\s*\(\s*(?:19|20)\d{2}\s*\)|\bet al\.[^.]{0,200}?\(\s*(?:19|20)\d{2}\s*\)/g) || []).length;
  return cites >= 3 || (years >= 4 && years / (t.length / 1000) >= 3);
}

export function chunkPages(pages) {
  const out = []; let kind = 'body'; let ord = 0;
  pages.forEach((txt, i) => {
    let buf = '';
    const push = t => { t = t.replace(/\s+/g, ' ').trim(); if (t.length >= 40) out.push({ page: i + 1, ord: ord++, kind, heur: looksLikeRefs(t), text: t }); };
    const flush = () => { push(buf); buf = ''; };
    for (const para of txt.split(/\n\s*\n/)) {
      if (REFS_RE.test(para)) { flush(); kind = 'refs'; continue; }
      const p = para.replace(/\n/g, ' ');
      if (buf && buf.length + p.length > CHUNK_MAX) flush();
      buf += (buf ? ' ' : '') + p;
      while (buf.length > CHUNK_MAX) {
        const cut = buf.lastIndexOf('. ', CHUNK_TARGET + 300);
        const at = cut > CHUNK_TARGET / 2 ? cut + 1 : CHUNK_TARGET;
        push(buf.slice(0, at)); buf = buf.slice(at);
      }
      if (buf.length >= CHUNK_TARGET) flush();
    }
    flush();
  });
  return markRefsTail(out);
}

// 参考文献块的判定（2026-10-19 重写）：标题只作线索，不再要求“文末连续且占比 >=50%”——Nature 系论文的参考文献后面还跟 Methods、数据可用性、Extended Data 图注，
// 且页眉“Article”会把章节名冲掉，旧规则会让整篇的参考文献都被当成正文。现规则：连续 >=2 块都像参考文献（内容启发式或标题命中）才算参考文献；全文前 30% 内（长 SI 接在短正文后时参考文献会落在这里）只认有 References 标题的块，或连续 >=3 块都像的，
// 中间夹 1 块不像的短碎片（如被页眉截断）并入；标题命中的单块也算。孤立的像参考文献的块仍算正文，宁可漏判不误伤正文。
export function markRefsTail(out) {
  const n = out.length, from = Math.floor(n * 0.3);
  const isRef = c => c.heur || c.kind === 'refs';
  const flags = out.map(() => false);
  let i = 0;
  while (i < n) {
    if (!isRef(out[i])) { i++; continue; }
    let j = i, last = i;
    while (j + 1 < n && (isRef(out[j + 1]) || (j + 2 < n && isRef(out[j + 2]) && out[j + 1].text.length < 600))) { j++; if (isRef(out[j])) last = j; }
    const hdr = out.slice(i, last + 1).some(c => c.kind === 'refs');
    if ((last > i || hdr) && (i >= from || hdr || last - i >= 2)) for (let k = i; k <= last; k++) flags[k] = true;
    i = last + 1;
  }
  out.forEach((c, k) => { c.kind = flags[k] ? 'refs' : 'body'; delete c.heur; });
  return out;
}

// 摘要块：题录里已有的摘要（catalog.abstract）作为 kind='abstract'、page=0 的一块进索引，检索时和正文块一起参与（refs 才排除）。幂等：先删后插。
export function putAbstract(db, p) {
  db.prepare("delete from chunks_fts where rowid in (select id from chunks where paper_id=? and kind='abstract')").run(p.id);
  db.prepare("delete from chunks where paper_id=? and kind='abstract'").run(p.id);
  const abs = String(p.abstract || '').replace(/^\s*abstract[:.\s]*/i, '').replace(/\s+/g, ' ').trim();
  if (abs.length < 200) return 0;
  const text = p.title + '. ' + abs;
  const r = db.prepare("insert into chunks(paper_id,page,ord,text,kind) values(?,0,-1,?,'abstract')").run(p.id, text);
  db.prepare('insert into chunks_fts(rowid,text) values(?,?)').run(r.lastInsertRowid, text);
  return 1;
}
export function indexAbstracts() {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'literature/catalog.json'), 'utf8'));
  const db = open(); let n = 0;
  try {
    const ids = new Set(db.prepare('select id from papers').all().map(r => r.id));
    db.exec('begin');
    for (const p of catalog.papers) if (ids.has(p.id)) n += putAbstract(db, p);
    db.exec('commit');
  } catch (e) { try { db.exec('rollback'); } catch {} throw e; } finally { db.close(); }
  return { abstracts: n };
}

// ---- 入库只用 MinerU（本机 GPU）：保留章节、PDF 页码、表格和公式；失败不换解析器。----
// 独立缓存，绝不把旧 Docling 结果当作 MinerU 输出。
const MINERU_PY = path.join(root, '.runtime/tools/mineru/venv/Scripts/python.exe');
const MINERU_WORKER = path.join(root, 'literature/mineru_worker.py');
const ITEMS_DIR = path.join(root, '.runtime/literature/mineru-items');
const MINERU_BATCH = 40;

export const mineruErrors = [];
export function mineruItems(list) { // list=[{id,file,sha}] -> Map(id -> items | null)
  const got = new Map(), todo = [];
  mineruErrors.length = 0;
  fs.mkdirSync(ITEMS_DIR, { recursive: true });
  for (const j of list) {
    const f = path.join(ITEMS_DIR, j.id + '.json');
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.sha === j.sha && Array.isArray(c.items) && c.items.length) { got.set(j.id, c.items); continue; } } catch {}
    todo.push({ ...j, out: f + '.tmp' });
  }
  if (todo.length && !fs.existsSync(MINERU_PY)) {
    for (const j of todo) { got.set(j.id, null); mineruErrors.push({ id: j.id, error: 'MinerU GPU 环境未安装' }); }
    return got;
  }
  for (let i = 0; i < todo.length; i += MINERU_BATCH) {
    const batch = todo.slice(i, i + MINERU_BATCH);
    for (const j of batch) fs.rmSync(j.out, { force: true });
    const jf = path.join(ITEMS_DIR, 'job-' + process.pid + '.json');
    fs.writeFileSync(jf, JSON.stringify(batch.map(({ id, file, out }) => ({ id, file, out }))));
    const run = spawnSync(MINERU_PY, [MINERU_WORKER, jf], { encoding: 'utf8', windowsHide: true, timeout: 7200000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUTF8: '1' } });
    const reported = new Set();
    for (const line of String(run.stdout || '').split('\n')) { try { const o = JSON.parse(line); if (o.ok === false) { reported.add(o.id); mineruErrors.push({ id: o.id, error: o.error }); } } catch {} }
    if (run.status !== 0) mineruErrors.push({ batch_exit: run.status ?? String(run.error?.code || 'killed'), stderr_tail: String(run.stderr || '').slice(-200), unreported: batch.filter(j => !fs.existsSync(j.out) && !reported.has(j.id)).length });
    fs.rmSync(jf, { force: true });
    for (const j of batch) {
      try { const items = JSON.parse(fs.readFileSync(j.out, 'utf8')); if (!Array.isArray(items) || !items.length) throw new Error('empty MinerU output'); fs.writeFileSync(path.join(ITEMS_DIR, j.id + '.json'), JSON.stringify({ sha: j.sha, items })); got.set(j.id, items); }
      catch { got.set(j.id, null); }
      fs.rmSync(j.out, { force: true });
    }
  }
  return got;
}

const REFS_HEAD = /^\s*(?:[\dIVX]+\.?\s*)?(?:supplement(?:al|ary)\s+|additional\s+|methods?\s+|online methods\s+)?(references?(?:\s+and\s+notes|\s+for\s+the\s+methods?\s+section)?|bibliography|literature cited)\s*[:.]?\s*$/i;
// 结构化条目 -> 块：章节标题处必断，章节内按段落合并到约 1200 字；块首拼章节名。
// JSTOR 版 PDF：首页是 JSTOR 封面，第 2 页开头常夹着同一期前一篇文章的结尾（参考文献、致谢），会把别的论文的文字混进这篇。
// 检出封面后，丢掉封面，并丢掉第一次出现本文题名之前的所有条目（找不到题名则只丢封面页）。
export function trimJstorCover(items, title = '') {
  const cover = items.filter(x => x.p === 1).map(x => x.text).join(' ');
  if (!/Stable URL:\s*https?:\/\/www\.jstor\.org/i.test(cover)) return items;
  const norm = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const key = norm(title).slice(0, 40);
  const at = key.length >= 15 ? items.findIndex(x => x.p >= 2 && norm(x.text).startsWith(key)) : -1;
  return at > 0 ? items.slice(at) : items.filter(x => x.p !== 1);
}
export function chunkItems(items, { title = '' } = {}) {
  items = trimJstorCover(items, title);
  const out = []; let section = '', kind = 'body', buf = '', page = null, ord = 0, keepShort = false;
  // 在 >=3 个不同页重复出现的“章节标题”是版面页眉（如 Nature 系每页的 Article），不是章节：忽略，免得切断段落、把参考文献标题冲掉、给块文字加无用前缀。
  const headPages = new Map();
  for (const it of items) if (it.label === 'section_header') { const k = it.text.trim().toLowerCase(); (headPages.get(k) || headPages.set(k, new Set()).get(k)).add(it.p); }
  const runningHead = t => { const k = t.trim().toLowerCase(); return (headPages.get(k)?.size || 0) >= 3 && !REFS_HEAD.test(t); };
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t.length >= 40 || (keepShort && t)) out.push({ page: page ?? 1, ord: ord++, kind, heur: looksLikeRefs(t), section, text: (section ? section + '. ' : '') + t });
    buf = ''; page = null; keepShort = false;
  };
  for (const it of items) {
    if (it.label === 'section_header' && runningHead(it.text)) continue;
    if (it.label === 'section_header' || it.label === 'title') { flush(); section = it.text.trim(); kind = REFS_HEAD.test(section) ? 'refs' : 'body'; continue; }
    if (it.label === 'page_header' || it.label === 'page_footer' || it.label === 'picture') continue;
    const t = it.text.replace(/\s+/g, ' ').trim(); if (!t) continue;
    if (buf && buf.length + t.length > CHUNK_MAX) flush();
    if (page == null) page = it.p;
    buf += (buf ? ' ' : '') + t;
    keepShort ||= it.label === 'equation' || it.label === 'table';
    while (buf.length > CHUNK_MAX) {
      const cut = buf.lastIndexOf('. ', CHUNK_TARGET + 300), at = cut > CHUNK_TARGET / 2 ? cut + 1 : CHUNK_TARGET;
      const keep = buf.slice(at), short = keepShort; buf = buf.slice(0, at); flush(); buf = keep; page = it.p; keepShort = short;
    }
    if (buf.length >= CHUNK_TARGET) flush();
  }
  flush();
  return markRefsTail(out);
}

export function ingest({ limit = Infinity, force = false } = {}) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'literature/catalog.json'), 'utf8'));
  const db = open(); const res = { added: 0, skipped: 0, failed: [], chunks: 0, mineru: 0, mineru_errors: [] };
  try {
    const todo = [];
    for (const p of catalog.papers) {
      if (p.library_status === 'deferred-publication' || !p.fulltext_path || !fs.existsSync(p.fulltext_path)) continue;
      if (todo.length >= limit) break;
      const sha = crypto.createHash('sha256').update(fs.readFileSync(p.fulltext_path)).digest('hex');
      const old = db.prepare('select pdf_sha256 from papers where id=?').get(p.id);
      if (old && old.pdf_sha256 === sha && !force) { res.skipped++; continue; }
      todo.push({ p, sha, old: !!old, id: p.id, file: p.fulltext_path });
    }
    const items = mineruItems(todo.map(({ id, file, sha }) => ({ id, file, sha })));
    res.mineru_errors = mineruErrors.map(e => ({ ...e }));
    for (const { p, sha, old } of todo) {
      try {
        const chunks = items.get(p.id) ? chunkItems(items.get(p.id), { title: p.title }) : [];
        if (!chunks.length) throw new Error(res.mineru_errors.find(e => e.id === p.id)?.error || 'MinerU 未产生可索引文字；未回退其他解析器');
        db.exec('begin');
        if (old) { db.prepare('delete from chunks_fts where rowid in (select id from chunks where paper_id=?)').run(p.id); db.prepare('delete from chunks where paper_id=?').run(p.id); }
        const year = Number(String(p.date || '').slice(0, 4)) || null;
        db.prepare(`insert into papers(id,doi,title,year,source,stage,pdf_path,pdf_sha256,updated_at) values(?,?,?,?,?,'indexed',?,?,?)
          on conflict(id) do update set title=excluded.title,year=excluded.year,source=excluded.source,stage='indexed',pdf_path=excluded.pdf_path,pdf_sha256=excluded.pdf_sha256,updated_at=excluded.updated_at`)
          .run(p.id, p.doi, p.title, year, p.source, p.fulltext_path, sha, new Date().toISOString());
        const ins = db.prepare('insert into chunks(paper_id,page,ord,text,kind) values(?,?,?,?,?)');
        const fts = db.prepare('insert into chunks_fts(rowid,text) values(?,?)');
        for (const c of chunks) { const r = ins.run(p.id, c.page, c.ord, c.text, c.kind); fts.run(r.lastInsertRowid, c.text); }
        putAbstract(db, p);
        db.exec('commit'); res.added++; res.mineru++; res.chunks += chunks.length;
      } catch (e) { try { db.exec('rollback'); } catch {} res.failed.push({ doi: p.doi, error: String(e.message).slice(0, 160) }); }
    }
  } finally { db.close(); }
  return res;
}

// ---- search：FTS5 BM25（词面匹配）。默认排除参考文献块。向量检索待 embed。----
export function search(query, { k = 8, refs = false } = {}) {
  const terms = String(query).match(/[\p{L}\p{N}][\p{L}\p{N}\-_.]*/gu) || [];
  if (!terms.length) throw new Error('search: 查询为空');
  const match = terms.map(t => '"' + t + '"').join(' OR ');
  const db = open();
  try {
    return db.prepare(`select c.id, p.doi, p.title, p.year, c.page, c.kind, round(bm25(chunks_fts),2) score,
        snippet(chunks_fts, 0, '[', ']', ' … ', 24) snippet
      from chunks_fts join chunks c on c.id = chunks_fts.rowid join papers p on p.id = c.paper_id
      where chunks_fts match ? ${refs ? '' : "and c.kind<>'refs'"} order by bm25(chunks_fts) limit ?`).all(match, k);
  } finally { db.close(); }
}

// ---- embed：本机 GPU（独立 venv 里的 PyTorch + sentence-transformers）。向量存 embeddings 表（float32 小端 blob，已归一化）。----
// 2026-10-20：bge-m3 -> Qwen3-Embedding-0.6B -> Qwen3-Embedding-4B（评测与模型清单见 MODELS.md）；环境变量只用于对照实验。
export const EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'Qwen/Qwen3-Embedding-4B';
const EMBED_DIR = path.join(root, '.runtime/tools/embed');
// 4B 的 fp16 权重（8.1 GB）放不进本机 8 GB 显存：本机用预先 8 位量化好的目录（约 4.2 GB，加载 5 秒左右，向量与 fp16 余弦 0.997）。
// 向量表里的模型名仍记原名；目录由 .runtime/tools/embed 下的脚本一次性生成（见 MODELS.md “需要时怎么重建”）。
const LOCAL_QUANT_DIRS = { 'Qwen/Qwen3-Embedding-4B': path.join(EMBED_DIR, 'qwen3-4b-int8') };
const EMBED_PY = path.join(EMBED_DIR, 'venv/Scripts/python.exe');
const EMBED_WORKER = path.join(root, 'literature/embed_worker.py');
const SHARED_EMBED_CLI = path.join(root, 'memory2/embed-cli.mjs');

export function embedTexts(texts, { model = EMBED_MODEL, batch = 32, query = false } = {}) {
  if (!fs.existsSync(EMBED_PY)) throw new Error('向量化环境不存在：' + EMBED_PY);
  const tmp = fs.mkdtempSync(path.join(EMBED_DIR, 'job-'));
  try {
    const src = path.join(tmp, 'in.jsonl'), dst = path.join(tmp, 'out.f32');
    fs.writeFileSync(src, texts.map(t => JSON.stringify(t)).join('\n') + '\n');
    const local = LOCAL_QUANT_DIRS[model];
    if (local && !fs.existsSync(local)) throw new Error('缺少预量化模型目录：' + local + '（该模型 fp16 放不进显存）；按 literature/MODELS.md “需要时怎么重建”重新生成');
    // The int8 4B model is shared with the memory system (memory2): one resident copy on the GPU, started on demand and unloaded when idle.
    // Loading a second copy for each literature call does not fit next to it in 8 GB. Vectors are identical to embed_worker.py's (checked on 40 abstracts + 3 queries).
    // RAG_EMBED_STANDALONE=1 restores the one-process-per-call worker; other models (RAG_EMBED_MODEL experiments) always use it.
    const shared = !!local && !process.env.RAG_EMBED_STANDALONE;
    const argv = shared ? [process.execPath, [SHARED_EMBED_CLI, local, src, dst, ...(query ? ['--query'] : [])]] : [EMBED_PY, [EMBED_WORKER, local || model, src, dst, '--batch=' + (local ? Math.min(batch, 16) : batch), ...(query ? ['--query'] : [])]];
    const r = spawnSync(argv[0], argv[1], { encoding: 'utf8', windowsHide: true, timeout: 3600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(process.env.RAG_ALLOW_DOWNLOAD ? {} : { HF_HUB_OFFLINE: '1' }) } });
    if (r.status !== 0) throw new Error('嵌入失败（共用嵌入服务或 embed_worker；模型未缓存时需设 RAG_ALLOW_DOWNLOAD=1 首次下载）：' + String(r.stderr || r.stdout).slice(-400));
    const info = JSON.parse(r.stdout.trim().split('\n').pop());
    const buf = fs.readFileSync(dst);
    if (buf.length !== info.n * info.dim * 4) throw new Error('向量文件大小与行数不符');
    return { info, vectors: texts.map((_, i) => buf.subarray(i * info.dim * 4, (i + 1) * info.dim * 4)) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 每批 BATCH_ROWS 块起一次 GPU 进程并立即落库：中断后重跑只补没算的，不会整批作废。
const BATCH_ROWS = 5000;
export function embed({ limit = Infinity, model = EMBED_MODEL, batch = 32 } = {}) {
  const db = open();
  try {
    let done = 0, info = null;
    while (done < limit) {
      const rows = db.prepare(`select c.id, c.text from chunks c where c.kind<>'refs'
        and not exists (select 1 from embeddings e where e.chunk_id=c.id and e.model=?) order by c.id limit ?`).all(model, Math.min(BATCH_ROWS, limit - done));
      if (!rows.length) break;
      const r = embedTexts(rows.map(x => x.text), { model, batch }); info = r.info;
      db.exec('begin');
      const ins = db.prepare('insert or replace into embeddings(chunk_id,model,dim,vec) values(?,?,?,?)');
      rows.forEach((x, i) => ins.run(x.id, model, r.info.dim, r.vectors[i]));
      db.exec('commit'); done += rows.length;
    }
    return done ? { embedded: done, model, dim: info.dim, device: info.device } : { embedded: 0, note: '全部非参考文献块已有该模型向量' };
  } finally { db.close(); }
}

// ---- 重排序：交叉编码器（本机 GPU）对融合后的前 N 块逐个按“查询—正文块”打分。jobs=[{q,docs}] -> 分数二维数组。----
export const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
const RERANK_WORKER = path.join(root, 'literature/rerank_worker.py');
export function rerankScores(jobs, { model = RERANK_MODEL, batch = 16 } = {}) {
  if (!fs.existsSync(EMBED_PY)) throw new Error('向量化环境不存在：' + EMBED_PY);
  const tmp = fs.mkdtempSync(path.join(EMBED_DIR, 'job-'));
  try {
    const src = path.join(tmp, 'in.json'), dst = path.join(tmp, 'out.json');
    fs.writeFileSync(src, JSON.stringify(jobs));
    const r = spawnSync(EMBED_PY, [RERANK_WORKER, model, src, dst, '--batch=' + batch], { encoding: 'utf8', windowsHide: true, timeout: 3600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(process.env.RAG_ALLOW_DOWNLOAD ? {} : { HF_HUB_OFFLINE: '1' }) } });
    if (r.status !== 0) throw new Error('rerank_worker 失败（模型未缓存时需设 RAG_ALLOW_DOWNLOAD=1 首次下载）：' + String(r.stderr || r.stdout).slice(-400));
    return JSON.parse(fs.readFileSync(dst, 'utf8'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---- 混合检索：BM25 前 N 与向量余弦前 N，用 RRF（1/(60+名次)）合并。向量部分需起一次 GPU 进程（加载模型数秒）。
// rerank=true：融合后前 rerankPool 块交给交叉编码器，最终名次 = 重排名次与融合名次再做一次 RRF（单用重排分会让单篇题的第 1 名变差，见评测）。
// hybridSearchMany 一次嵌入多条查询（评测用）；papers=true 时按论文合并：论文名次取其最佳块，附最多 2 段命中文字。----
export function hybridSearchMany(queries, { k = 8, pool = 50, model = EMBED_MODEL, refs = false, papers = false, mode = 'hybrid', rerank = false, rerankPool = 50 } = {}) {
  const lexicals = queries.map(q => search(q, { k: pool, refs }));
  const db = open();
  try {
    const rows = db.prepare(`select e.chunk_id id, e.vec, p.doi, p.title, p.year, c.page, c.text
      from embeddings e join chunks c on c.id=e.chunk_id join papers p on p.id=c.paper_id where e.model=? ${refs ? '' : "and c.kind<>'refs'"}`).all(model);
    if (!rows.length) throw new Error('没有向量：先运行 library embed');
    const byId = new Map(rows.map(r => [r.id, r]));
    const vecs = rows.map(r => new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.length / 4));
    const qvs = embedTexts(queries, { model, query: true }).vectors;
    const perQuery = queries.map((_, qi) => {
      const qv = new Float32Array(qvs[qi].buffer, qvs[qi].byteOffset, qvs[qi].length / 4);
      const scored = rows.map((r, j) => { let dot = 0; const v = vecs[j]; for (let i = 0; i < v.length; i++) dot += v[i] * qv[i]; return { r, dot }; })
        .sort((a, b) => b.dot - a.dot).slice(0, pool);
      const fused = new Map();
      const add = (id, rank, extra) => { const e = fused.get(id) || { id, rrf: 0 }; e.rrf += 1 / (60 + rank); Object.assign(e, extra); fused.set(id, e); };
      if (mode !== 'lex') scored.forEach(({ dot }, i) => add(scored[i].r.id, i + 1, { cos: Math.round(dot * 1000) / 1000 }));
      if (mode !== 'vec') lexicals[qi].forEach((l, i) => add(l.id, i + 1, { bm25: l.score }));
      const chunks = [...fused.values()].sort((a, b) => b.rrf - a.rrf).map(e => {
        const r = byId.get(e.id) || (db.prepare('select p.doi, p.title, p.year, c.page, c.text from chunks c join papers p on p.id=c.paper_id where c.id=?').get(e.id));
        return { doi: r.doi, title: r.title, year: r.year, page: r.page, rrf: Math.round(e.rrf * 10000) / 10000, cos: e.cos ?? null, bm25: e.bm25 ?? null, text: r.text };
      });
      return chunks;
    });
    if (rerank) {
      const jobs = perQuery.map((cs, qi) => ({ q: queries[qi], docs: cs.slice(0, rerankPool).map(c => c.text) }));
      const scores = rerankScores(jobs);
      perQuery.forEach((cs, qi) => { cs.length = Math.min(cs.length, rerankPool); cs.forEach((c, j) => { c.rerank = Math.round(scores[qi][j] * 10000) / 10000; c.fusedRank = j + 1; });
        const byScore = [...cs].sort((a, b) => b.rerank - a.rerank); byScore.forEach((c, j) => { c.rerankRank = j + 1; });
        cs.sort((a, b) => (1 / (60 + b.rerankRank) + 1 / (60 + b.fusedRank)) - (1 / (60 + a.rerankRank) + 1 / (60 + a.fusedRank))); });
    }
    return perQuery.map(chunks => {
      chunks.forEach(c => { c.text = c.text.slice(0, 600); });
      if (!papers) return chunks.slice(0, k);
      const out = new Map();
      for (const c of chunks) {
        const p = out.get(c.doi) || { doi: c.doi, title: c.title, year: c.year, rrf: c.rrf, ...(c.rerank != null ? { rerank: c.rerank } : {}), passages: [] };
        if (p.passages.length < 2) p.passages.push({ page: c.page, cos: c.cos, bm25: c.bm25, text: c.text });
        out.set(c.doi, p);
      }
      return [...out.values()].slice(0, k);
    });
  } finally { db.close(); }
}

export function hybridSearch(query, opts = {}) { return hybridSearchMany([query], opts)[0]; }
