// RAG 评测：node literature/rag-eval.mjs [--set=题集文件] [--label=名称] [--mode=hybrid|lex|vec] [--rerank]
// items：单篇题，按 DOI 判命中（hit@1/5/10、MRR）。topics：主题题，答案为一批论文（hit@5、P@5、nDCG@10）。
// 论文级合并后评分；结果追加到 .runtime/literature/rag-eval-log.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { hybridSearchMany } from './library.mjs';

const arg = (n, d) => process.argv.find(a => a.startsWith('--' + n + '='))?.slice(n.length + 3) || d;
const label = arg('label', 'unnamed'), mode = arg('mode', 'hybrid'), rerank = process.argv.includes('--rerank');
const set = JSON.parse(fs.readFileSync(path.join(root, 'literature', arg('set', 'rag-eval.json')), 'utf8')); // --set=rag-eval-2020.json 只有单篇题
set.topics = set.topics || [];
const qs = [...set.items.map(i => i.q), ...set.topics.map(t => t.q)];
const universe = set.universe ? new Set(set.universe) : null;
const res = hybridSearchMany(qs, { k: universe ? 40 : 10, papers: true, mode, rerank });
const r3 = x => Math.round(x * 1000) / 1000;
const items = set.items.map((it, i) => {
  const got = res[i].slice(0, 10);
  const ev = it.evidence ? got.slice(0, 5).some(r => r.doi === it.doi && r.passages.some(p => p.page === it.evidence.page)) : null;
  return { doi: it.doi, rank: got.findIndex(r => r.doi === it.doi) + 1 || null, evidence: ev, q: it.q };
});
const single = { n: items.length, 'hit@1': items.filter(r => r.rank === 1).length, 'hit@5': items.filter(r => r.rank && r.rank <= 5).length, 'hit@10': items.filter(r => r.rank).length, mrr: r3(items.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / items.length) };
const tops = set.topics.map((t, i) => {
  const got = res[set.items.length + i].map(r => r.doi).filter(d => !universe || universe.has(d)).slice(0, 10), rel = new Set(t.rel);
  const dcg = got.reduce((s, d, j) => s + (rel.has(d) ? 1 / Math.log2(j + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, rel.size) }, (_, j) => 1 / Math.log2(j + 2)).reduce((a, b) => a + b, 0);
  return { q: t.q, hit5: got.slice(0, 5).some(d => rel.has(d)), p5: got.slice(0, 5).filter(d => rel.has(d)).length / 5, ndcg: dcg / ideal };
});
const avg = k => tops.length ? r3(tops.reduce((s, t) => s + Number(t[k]), 0) / tops.length) : null;
const out = { label, mode, rerank, at: new Date().toISOString(), single, topics: { n: tops.length, 'hit@5': avg('hit5'), 'P@5': avg('p5'), 'nDCG@10': avg('ndcg') },
  evidence: (() => { const e = items.filter(r => r.evidence !== null); return e.length ? { n: e.length, hit: e.filter(r => r.evidence).length } : null; })(), single_misses: items.filter(r => !r.rank || r.rank > 5).map(r => ({ rank: r.rank, doi: r.doi })), topic_weak: tops.filter(t => t.p5 < 0.4).map(t => ({ q: t.q.slice(0, 50), p5: t.p5 })) };
fs.appendFileSync(path.join(root, '.runtime/literature/rag-eval-log.jsonl'), JSON.stringify(out) + '\n');
console.log(JSON.stringify(out));
