// Read-only progressive disclosure, shared by the dashboard and assistant CLI.
import fs from 'node:fs';
import path from 'node:path';
import { root, read } from '../automation/files.mjs';
import { resolveLocalFile } from '../dashboard/local-files.mjs';
import { localDay, recommendationDay, recommendationDays } from './recommendations.mjs';

const key = value => String(value || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim().toLowerCase();
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function optionalJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')); // Corrupt data is not an empty library.
}
// The catalog is ~80 MB; parsing it and building the DOI map on every list/page/search request took ~0.7 s each.
// Reuse the result while the files it is built from are unchanged (size + mtime).
let sourcesCache;
function sources() {
  const dir = path.join(root, '.runtime/literature');
  const latest = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^candidates-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1) : null;
  const stamp = f => { try { const s = fs.statSync(f); return s.size + ':' + s.mtimeMs; } catch { return '-'; } };
  const signature = [path.join(root, 'literature/catalog.json'), path.join(root, 'literature/sources.json'), path.join(dir, 'intake.json'), latest && path.join(dir, latest)].map(f => f ? stamp(f) : '-').join('|') + '|' + latest;
  if (sourcesCache?.signature !== signature) sourcesCache = { signature, value: buildSources(dir, latest) };
  return sourcesCache.value;
}
function buildSources(dir, latest) {
  const empty = { candidates: [], errors: [] };
  const candidates = latest ? optionalJSON(path.join(dir, latest), empty) : empty;
  const intake = Object.values(optionalJSON(path.join(dir, 'intake.json'), {}));
  const catalog = read('literature/catalog.json').papers;
  // 重审移出（rereview-excluded）与推迟发表一样不进入在库视图；记录仍留在 catalog 供追溯与恢复。
  const deferred = new Set(catalog.filter(p => p.library_status === 'deferred-publication').map(p => key(p.doi)));
  const rereviewed = new Set(catalog.filter(p => p.library_status === 'rereview-excluded').map(p => key(p.doi)));
  const hidden = new Set([...deferred, ...rereviewed]);
  const all = new Map(), registered = new Set(catalog.filter(p => !hidden.has(key(p.doi))).map(p => key(p.doi)));
  for (const p of [...intake, ...candidates.candidates, ...catalog]) {
    const doi = key(p.doi); if (!doi || hidden.has(doi)) continue;
    const old = all.get(doi) || {};
    const abstract = p.abstract || strip(p.abstract_html) || old.abstract || '';
    all.set(doi, { ...old, ...p, doi, title: p.title || old.title || doi, abstract,
      abstract_from: p.abstract ? p.abstract_from || (p.abstract === old.abstract ? old.abstract_from : null) : p.abstract_html ? 'crossref' : old.abstract_from,
      abstract_version: p.abstract || p.abstract_html ? p.abstract_version || null : old.abstract_version });
  }
  const noSubscription = new Set(read('literature/sources.json').no_fulltext_journals || []);
  const summary = p => ({ doi: p.doi, title: p.title, source: p.source || '', date: p.date || String(p.year || ''),
    has_abstract: !!p.abstract, has_fulltext: !!p.fulltext_path && fs.existsSync(p.fulltext_path), registered: registered.has(p.doi),
    no_subscription: noSubscription.has(p.source) });
  const pool = [...all.values()].sort((a, b) => String(b.date || b.year || '').localeCompare(String(a.date || a.year || '')) || a.title.localeCompare(b.title));
  const short = candidates.candidates.map(p => all.get(key(p.doi))).filter(Boolean);
  const local = pool.filter(p => summary(p).has_fulltext);
  const nofull = pool.filter(p => !summary(p).has_fulltext);
  return { all, pool, short, local, nofull, summary, deferred, rereviewed, hidden, latest: latest?.slice(11, 21) || null, errors: candidates.errors,
    counts: { candidates: short.length, pool: pool.length, registered: registered.size, local: local.length, nofulltext: nofull.length, deferred: deferred.size, rereview_excluded: rereviewed.size },
    storage: { catalog: 'literature/catalog.json', fulltext: 'literature/fulltext/',
      discovery: '.runtime/literature/', rag_index: '.runtime/literature/library.sqlite', rag_ready: false } };
}
export function literatureList({ scope = 'candidates', q = '', page = 1, limit = 20, date = localDay() } = {}) {
  if (!['daily', 'candidates', 'pool', 'local', 'nofull'].includes(scope)) throw new Error('scope: daily | candidates | pool | local | nofull');
  page = Number(page); limit = Number(limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('页码须为正整数，每页1–50条');
  const s = sources(), query = String(q || '').trim().toLocaleLowerCase();
  const daily=recommendationDay(date),reasons=new Map(daily.items.map(p=>[p.doi,p]));
  const task=read('work/queue.json').items.find(p=>p.id==='literature-daily-'+date);
  const picked=daily.items.filter(p=>!s.hidden.has(key(p.doi))).map(p=>s.all.get(p.doi) || {doi:p.doi,title:p.doi,source:'资料记录缺失'});
  const input = { daily:picked,candidates: s.short, pool: s.pool, local: s.local, nofull: s.nofull }[scope];
  const filtered = query ? input.filter(p => [p.title, p.source, p.doi, p.authors].join(' ').toLocaleLowerCase().includes(query)) : input;
  return { scope, query, page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit),
    latest: s.latest, counts: {...s.counts,daily:picked.length}, errors: s.errors, storage: s.storage,
    today:localDay(),daily:{date,published:daily.published,note:daily.note,days:recommendationDays(),task_status:task?.status || null},
    items: filtered.slice((page - 1) * limit, page * limit).map(p=>({...s.summary(p),...(scope==='daily'?{reason:reasons.get(p.doi)?.reason,basis:reasons.get(p.doi)?.basis}:{})})) };
}
export function literaturePaper(doi,{date}={}) {
  const s = sources(), p = s.all.get(key(doi));
  if (!p) return null;
  let file = null;
  if (p.fulltext_path && fs.existsSync(p.fulltext_path)) {
    try { const safe = resolveLocalFile(p.fulltext_path); if (path.extname(safe).toLowerCase() === '.pdf') file = safe; } catch { /* No link around the existing file boundary. */ }
  }
  const preprint = /^https:\/\/arxiv\.org\/abs\/(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.test(p.preprint_url || '') ? p.preprint_url : null;
  const recommendation=date?recommendationDay(date).items.find(r=>r.doi===p.doi):null;
  return { ...s.summary(p), authors: p.authors || [], abstract: p.abstract,
    abstract_from: p.abstract_from || (p.abstract ? '记录未注明' : null), abstract_version: p.abstract_version || null,
    pick_reason: recommendation?.reason || p.pick_reason || p.picked_reason || null, recommendation:recommendation || null,project_ids: p.project_ids || [],
    publisher_url: 'https://doi.org/' + p.doi.split('/').map(encodeURIComponent).join('/'), preprint_url: preprint,
    fulltext: { available: s.summary(p).has_fulltext, open_url: file ? '/api/local-file?path=' + encodeURIComponent(file) : null,
      note: file ? '本地文件存在；此页面未重新校验正文或版本。' : p.fulltext_path ? '登记路径缺失或不在页面允许打开的范围。' : '尚无本地全文；只读页面不会自动下载。' } };
}
