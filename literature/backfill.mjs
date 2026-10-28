// 老文献回填：按年份从 OpenAlex 取候选（期刊清单 × 主题分类，按被引降序），程序粗筛后分页给题名。
// 无模型调用、不下载全文；候选只写 .runtime/literature/backfill-<年>.json，选中的才经 ingest 写入资料库。
// 主题分类是 OpenAlex 的算法标签，不是词表，也不读项目；用哪些主题在 sources.json 的 backfill.topics。
import fs from 'node:fs';
import path from 'node:path';
import { root, read } from '../automation/files.mjs';
import { enrichAbstracts } from './abstracts.mjs';
import { record } from './run.mjs';
import { providerKey } from './hosted.mjs';

const UA = 'PhD-Workflows/0.1 (personal literature backfill; low volume)';
const delay = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const plain = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const fileOf = year => path.join(root, '.runtime/literature', `backfill-${year}.json`);
const ABBR = { 'Nature Nanotechnology': 'NatNano', 'Nature Materials': 'NatMat', 'Nature Physics': 'NatPhys', 'Nature Electronics': 'NatElec',
  'Nature Photonics': 'NatPhot', 'Physical Review Letters': 'PRL', 'Physical Review X': 'PRX', 'Physical Review Applied': 'PRApp',
  'Nano Letters': 'NanoL', 'Advanced Materials': 'AdvM', 'Science Advances': 'SciAdv', 'Nature Reviews Physics': 'NRP', 'Nature Reviews Materials': 'NRM' };
const abbr = j => ABBR[j] || (/Physical review\. B/i.test(j) ? 'PRB' : String(j || '?').replace(/^Nature$/, 'Nat').replace(/^Science$/, 'Sci'));

// 程序粗筛：封面/更正/回复/撤稿、被排除词命中、规范化题名重复（留被引高的）。
export function coarse(works, c = read('literature/sources.json')) {
  const dropped = { cover: 0, comment: 0, retracted: 0, excluded: 0, duplicate: 0, no_doi: 0 };
  const seen = new Set(), kept = [];
  const excl = (c.exclude || []).map(k => new RegExp('(?<![a-z0-9])' + k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])'));
  for (const w of works) {
    const title = plain(w.title), key = norm(title);
    if (!w.doi || !title) { dropped.no_doi++; continue; }
    if (/\([^()]*\b\d{1,2}\/\d{4}\)\s*$/.test(title)) { dropped.cover++; continue; }
    if (/^retracted/i.test(title)) { dropped.retracted++; continue; }
    if (/^(comment on|reply to|erratum|correction)\b/i.test(title) || /\breply:?$/i.test(title)) { dropped.comment++; continue; }
    if (excl.some(r => r.test(title.toLowerCase()))) { dropped.excluded++; continue; }
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key); kept.push({ ...w, title });
  }
  return { kept, dropped };
}

async function get(url) {
  await delay(1100);
  const key = providerKey('openalex'); // free-tier key lifts the anonymous daily cap shared with other OpenAlex calls
  if (key) url += (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('OpenAlex HTTP ' + r.status);
  return r.json();
}

export async function fetchYear(year, c = read('literature/sources.json')) {
  const topics = c.backfill?.topics; if (!topics?.length) throw new Error('sources.json 缺 backfill.topics');
  const issn = c.journals.map(j => j[1]).join('|'), cap = c.backfill.max_per_year || 1500;
  const base = `https://api.openalex.org/works?filter=publication_year:${year},type:article,primary_location.source.issn:${issn},primary_topic.id:${topics.join('|')}`
    + '&sort=cited_by_count:desc&select=doi,title,cited_by_count,primary_location&per-page=100';
  const works = [];
  for (let page = 1; works.length < cap; page++) {
    const j = await get(base + '&page=' + page);
    for (const w of j.results) works.push({ doi: String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(), title: w.title,
      cites: w.cited_by_count, journal: w.primary_location?.source?.display_name || '' });
    if (j.results.length < 100) break;
  }
  const { kept, dropped } = coarse(works, c);
  const out = { year, fetched_at: new Date().toISOString(), topics, raw: works.length, dropped, items: kept.map((p, i) => ({ rank: i + 1, ...p })) };
  fs.mkdirSync(path.dirname(fileOf(year)), { recursive: true });
  fs.writeFileSync(fileOf(year), JSON.stringify(out));
  return out;
}

/** 分页给题名：rank|刊|被引|题名。缺文件时才联网取一次。 */
export async function page(year, from = 1, count = 150) {
  const data = fs.existsSync(fileOf(year)) ? JSON.parse(fs.readFileSync(fileOf(year), 'utf8')) : await fetchYear(year);
  const have = new Set(read('literature/catalog.json').papers.map(p => p.doi));
  const window = data.items.filter(p => p.rank >= from && p.rank < from + count), rows = window.filter(p => !have.has(p.doi));
  return { year, raw: data.raw, after_coarse: data.items.length, dropped: data.dropped, from, next_from: from + count, in_library_hidden: window.length - rows.length, shown: rows.length,
    lines: rows.map(p => `${p.rank}|${abbr(p.journal)}|${p.cites}|${p.title.slice(0, 110)}`) };
}

/** 入库：{year, ranks:[...]} 或 {year, dois:[...]}。补摘要（来源标注）、取作者和日期，登记为 library 档；摘要缺的照样登记，标 abstract 为空。 */
export async function ingest({ year, ranks = [], dois = [] }) {
  const data = JSON.parse(fs.readFileSync(fileOf(year), 'utf8'));
  const want = new Set(dois.map(d => d.toLowerCase()));
  const picked = data.items.filter(p => ranks.includes(p.rank) || want.has(p.doi));
  if (!picked.length) throw new Error('没有匹配的候选');
  const stats = await enrichAbstracts(picked, { selected: true, browser: false });
  const meta = new Map();
  for (let i = 0; i < picked.length; i += 50) {
    const batch = picked.slice(i, i + 50).map(p => 'https://doi.org/' + p.doi).join('|');
    const j = await get(`https://api.openalex.org/works?filter=doi:${batch}&per-page=50&select=doi,publication_date,authorships`);
    for (const w of j.results) meta.set(String(w.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(),
      { date: w.publication_date, authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean) });
  }
  let recorded = 0;
  for (const p of picked) {
    const m = meta.get(p.doi) || {};
    const prev = read('literature/catalog.json').papers.find(x => x.doi === p.doi);
    if (!p.abstract && prev?.abstract) Object.assign(p, { abstract: prev.abstract, abstract_from: prev.abstract_from, abstract_url: prev.abstract_url }); // never blank a stored abstract
    record({ doi: p.doi, title: p.title, authors: m.authors || [], date: m.date || null, year: Number(m.date?.slice(0, 4)) || year,
      source: p.journal, abstract: p.abstract || '', abstract_from: p.abstract_from || null, abstract_url: p.abstract_url || null,
      ...(p.abstract_version ? { abstract_version: p.abstract_version } : {}), cited_by_at_collection: p.cites,
      library_tier: 'library', collected_via: `backfill-${year}`, metadata_source: 'https://api.openalex.org/works' });
    recorded++;
  }
  return { recorded, abstracts: { ...stats, attempts: undefined }, without_abstract: picked.filter(p => !p.abstract).map(p => p.doi) };
}
