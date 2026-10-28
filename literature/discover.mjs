// 每日候选抓取：只读、无模型调用、无下载。Crossref（按期刊 ISSN）+ arXiv。
// 程序只做：对正式目录去重、排除明显不相关的粗领域、按期刊层级和少量 focus 词排序、保证每个来源有代表。展示不等于已处理。
// 有没有意思、属于 sources.json 里 lines 的哪一条，由助手读题名/摘要判断；选中后再逐篇 fetch。不靠堆关键词。
import fs from 'node:fs';
import path from 'node:path';
import { root, read } from '../automation/files.mjs';
import { enrichAbstracts } from './abstracts.mjs';
export { enrichAbstracts } from './abstracts.mjs';

const UA = 'PhD-Workflows/0.1 (personal literature discovery; low volume)';
const cfg = () => read('literature/sources.json');
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const isoDay = d => d.toISOString().slice(0, 10);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, k) => new RegExp('(?<![a-z0-9])' + esc(k.toLowerCase()) + '(?![a-z0-9])').test(text);
const textOf = item => (item.title + ' ' + (item.abstract || '')).toLowerCase();

export function annotate(item, c = cfg()) {
  const t = textOf(item);
  const focus = c.focus.filter(k => hasWord(t, k));
  return { ...item, focus, score: (c.tier_weight[String(item.tier ?? 0)] ?? 0) + Math.min(4, focus.length) };
}
export const excludedBy = (item, c = cfg()) => c.exclude.find(k => hasWord(textOf(item), k)) || null;

// 每个期刊保底取 min 条再按分数补足到 size；arXiv 无质量信号，只给 arxivSlots 个名额。
export function select(items, { min, size, arxivSlots = 25 }) {
  const rank = (a, b) => b.score - a.score || (b.date > a.date ? 1 : b.date < a.date ? -1 : 0);
  const chosen = new Set();
  items.filter(p => p.source === 'arXiv').sort(rank).slice(0, arxivSlots).forEach(p => chosen.add(p));
  const journals = items.filter(p => p.source !== 'arXiv');
  for (const list of Map.groupBy(journals, p => p.source).values()) list.slice().sort(rank).slice(0, min).forEach(p => chosen.add(p));
  for (const p of journals.sort(rank)) { if (chosen.size >= size) break; chosen.add(p); }
  return [...chosen].sort(rank);
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' -> HTTP ' + r.status);
  return r;
}

export async function crossrefJournal([name, issn, tier], since, rows) {
  const url = `https://api.crossref.org/journals/${issn}/works?filter=type:journal-article,from-pub-date:${since}`
    + `&sort=published&order=desc&rows=${rows}&select=DOI,title,author,abstract,license,issued`;
  const { message } = await (await get(url)).json();
  return message.items.map(m => {
    const lic = (m.license || []).map(l => l.URL).join(' ');
    return { source: name, tier, doi: String(m.DOI).toLowerCase(), title: strip(m.title?.[0]), date: (m.issued?.['date-parts']?.[0] || []).join('-'),
      authors: (m.author || []).slice(0, 3).map(a => a.family).filter(Boolean).join(', '), abstract: strip(m.abstract),
      oa_hint: /creativecommons/i.test(lic) };
  });
}

export async function arxiv(since, max) {
  const cats = cfg().arxiv_categories.map(c => 'cat:' + c).join('+OR+');
  const until = isoDay(new Date(Date.now() + 86400000)).replaceAll('-', '');
  const range = `submittedDate:[${since.replaceAll('-', '')}0000+TO+${until}2359]`;
  const url = `https://export.arxiv.org/api/query?search_query=(${cats})+AND+${range}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const xml = await (await get(url)).text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const g = tag => strip((e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const id = g('id').replace(/^.*\/abs\//, '').replace(/v\d+$/, '');
    return { source: 'arXiv', tier: 0, arxiv_id: id, doi: '10.48550/arxiv.' + id, title: g('title'), date: g('published').slice(0, 10),
      abstract: g('summary'), oa_hint: true,
      authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 3).map(m => m[1].split(' ').pop()).join(', ') };
  });
}

// Default discovery only queries metadata APIs. Publisher/browser/preprint lookup
// is an explicit shortlist operation: enrichAbstracts(picks, { selected:true, browser:true }).

const dir = () => path.join(root, '.runtime/literature');
// 候选只是暂存（candidates-<日期>.json）；没被选中的不永久保存。旧版曾把所有通过粗筛的候选追加到 intake.json，已于 2026-10-17 去掉（资料库因此膨胀到 800 多条）。

export async function discover({ days = cfg().window_days } = {}) {
  const c = cfg(), today = isoDay(new Date());
  const since = isoDay(new Date(Date.now() - days * 86400000));
  const known = new Set(read('literature/catalog.json').papers.map(p => p.doi));
  const errors = []; let items = [];
  for (const j of c.journals) {
    try { items.push(...await crossrefJournal(j, since, c.per_journal)); } catch (e) { errors.push(j[0] + ': ' + e.message); }
  }
  if (c.arxiv_max > 0) {
    try { items.push(...await arxiv(since, c.arxiv_max)); } catch (e) { errors.push('arXiv: ' + e.message); }
  }
  const skip = (c.exclude_doi_patterns || []).map(x => x.toLowerCase());
  items = items.filter(p => p.title && !skip.some(x => p.doi.includes(x)) && !known.has(p.doi))
    .map(p => annotate(p, c));
  const dropped = {}; const kept = [];
  for (const p of items) { if (excludedBy(p, c)) dropped[p.source] = (dropped[p.source] || 0) + 1; else kept.push(p); }
  const shown = select(kept, { min: c.per_source_min, size: c.list_size, arxivSlots: c.arxiv_slots });
  const enrich = await enrichAbstracts(shown);
  const noAccess = new Set(c.no_fulltext_journals || []);
  for (const p of shown) if (noAccess.has(p.source)) p.fulltext = 'no-subscription';
  const result = { since, total: kept.length, shown: shown.length, dropped_by_exclude: dropped, abstracts: enrich, errors, lines: c.lines,
    note: '无摘要的条目（Nature/Science/APS 常见）只能按题名判断。', candidates: shown };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `candidates-${today}.json`), JSON.stringify(result, null, 1));
  return result;
}
