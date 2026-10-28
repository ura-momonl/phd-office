// 项目资料的全文检索。只读，每次现扫文件现算，不落盘、没有缓存，所以不存在“索引过期”。来源：各项目 FRAMEWORK.md 的每个节点／记录，以及项目文件夹里的其他 .md
// （不收 STATUS.md：程序生成的视图；也不收 FRAMEWORK.before-*.md 之类的 FRAMEWORK 快照：同一份内容的旧版会盖住真记录）。
// 算法与会话检索（agent search）共用 automation/text-match.mjs：先要求全部词都出现；凑不齐时按字词片段近似匹配，并标明近似度。字面匹配，不是语义检索。
// 命中不隐藏、不降权：每条带更正标记——corrected_by（后来的记录声明更正了它）、correction_note（正文里写了「后续更正」但还没有记录声明）——
// 由读者先看更正再引用。
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { searchTerms, nearMatches } from '../automation/text-match.mjs';
import { parseFramework, hasCorrectionNote } from './framework.mjs';

const projectsDir = path.join(root, 'workspace/projects');
const lower = s => s.toLocaleLowerCase();
const NEAR_LIMIT = 5; // 近似候选和会话检索一样最多 5 条

function markdownFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(f, out);
    else if (/\.md$/i.test(e.name) && !/^FRAMEWORK\b/.test(e.name) && e.name !== 'STATUS.md') out.push(f);
  }
  return out;
}

function chunksOf(base, projectId) {
  const dir = path.join(base, projectId), out = [], prefix = base === projectsDir ? 'workspace/projects/' : '', rel = f => prefix + path.relative(base, f).split(path.sep).join('/');
  const add = c => out.push({ ...c, low: lower(c.title + '\n' + c.summary + '\n' + c.body) });
  const framework = path.join(dir, 'FRAMEWORK.md');
  if (fs.existsSync(framework)) {
    const parsed = parseFramework(fs.readFileSync(framework, 'utf8'));
    for (const n of parsed.nodes) {
      add({ project: projectId, ref: n.id || `第 ${n.line + 1} 行`, kind: n.entry ? 'record' : 'node', title: n.title, summary: n.meta.summary || '', body: n.body,
        path: rel(framework), date: n.meta.date || null,
        corrected_by: n.id && parsed.correctedBy.get(n.id) || [], corrects: Array.isArray(n.meta.corrects) ? n.meta.corrects : [],
        correction_note: !(n.id && parsed.correctedBy.has(n.id)) && hasCorrectionNote(n) });
    }
  }
  for (const f of markdownFiles(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    add({ project: projectId, ref: rel(f), kind: 'file', title: /^#\s+(.+)$/m.exec(text)?.[1] || path.basename(f), summary: '', body: text,
      path: rel(f), date: null, corrected_by: [], corrects: [], correction_note: false });
  }
  return out;
}

function excerpt(c, terms) {
  for (const text of [c.body, c.summary, c.title]) {
    const paragraphs = text.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
    const matched = paragraphs.filter(p => terms.some(t => lower(p).includes(t)));
    if (matched.length) return matched.join('\n\n');
  }
  return '';
}

const count = (text, t) => text.split(t).length - 1;
// 全匹配的排序：词在标题比在摘要、正文更重要；词越稀有越重要；正文出现次数取对数，长文件不靠堆次数压过短节点。
function exactRank(hits, chunks, terms) {
  const idf = Object.fromEntries(terms.map(t => [t, Math.log(1 + chunks.length / Math.max(1, chunks.filter(c => c.low.includes(t)).length))]));
  const score = c => terms.reduce((s, t) => s + idf[t] * (3 * lower(c.title).includes(t) + 2 * lower(c.summary).includes(t) + Math.log1p(count(lower(c.body), t))), 0);
  return hits.map(c => [score(c), c]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
}

export function searchKnowledge(query, { project, limit = 10, base = projectsDir } = {}) {
  const terms = searchTerms(query);
  if (!terms.length) throw new Error('请给查询词（空格分隔多个词，全部命中才算；找不到全匹配时会按字词片段近似匹配）');
  const projects = project ? [project] : fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name)).map(e => e.name);
  if (project && !(/^[a-z0-9-]+$/.test(project) && fs.existsSync(path.join(base, project)))) throw new Error('没有这个项目文件夹：' + project);
  const chunks = projects.flatMap(p => chunksOf(base, p));
  const shape = (c, extra) => ({ project: c.project, ref: c.ref, kind: c.kind, title: c.title, date: c.date, path: c.path,
    ...(c.corrected_by.length ? { corrected_by: c.corrected_by } : {}), ...(c.corrects.length ? { corrects: c.corrects } : {}),
    ...(c.correction_note ? { correction_note: true } : {}), ...extra });
  const exact = chunks.filter(c => terms.every(t => c.low.includes(t)));
  if (exact.length) {
    const ranked = exactRank(exact, chunks, terms);
    return { query, mode: 'exact', total: ranked.length, shown: Math.min(ranked.length, limit), results: ranked.slice(0, limit).map(c => shape(c, { excerpt: excerpt(c, terms) })) };
  }
  const { weight, scored } = nearMatches(chunks, terms);
  const near = scored.sort((a, b) => b.score - a.score).slice(0, Math.min(limit, NEAR_LIMIT));
  if (!near.length) return { query, mode: 'none', total: 0, shown: 0, results: [] };
  return { query, mode: 'near', total: near.length, shown: near.length,
    note: '没有节点同时包含全部词。按查询里的字词片段近似匹配，下面是最像的候选（近似度＝命中片段的稀有度占比，只是候选，请看片段自己判断）。',
    results: near.map(c => shape(c, { score: Math.round(c.score * 100), excerpt: excerpt(c, [[...c.hit].sort((a, b) => weight[b] - weight[a])[0]]) })) };
}
