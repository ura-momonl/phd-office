// 只读：用 projects/search-eval.json 的题目对真实项目资料评测 `projects search`，并与“按文件顺序取前 5 个含全部词的节点”的字面基线对比。
// 指标：hit@5（任一 expect 在前 5 条）；stale_unflagged（前 5 条里已知被更正的条目没有 corrected_by／correction_note 标记的次数）；
// correction 题还要求命中的那条带标记。用法：node scripts/search-eval.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFramework } from '../projects/framework.mjs';
import { searchKnowledge } from '../projects/search.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), verbose = process.argv.includes('--verbose');
const evalSet = JSON.parse(fs.readFileSync(path.join(root, 'projects/search-eval.json'), 'utf8'));
const base = path.join(root, 'workspace/projects');
const nodes = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'FRAMEWORK.md')))
  .flatMap(e => parseFramework(fs.readFileSync(path.join(base, e.name, 'FRAMEWORK.md'), 'utf8')).nodes.filter(n => n.id)
    .map(n => ({ ref: n.id, text: (n.title + '\n' + (n.meta.summary || '') + '\n' + n.body).toLowerCase() })));
const baseline = q => { const t = q.toLowerCase().split(/\s+/).filter(Boolean); return nodes.filter(n => t.every(x => n.text.includes(x))).slice(0, 5).map(n => ({ ref: n.ref })); };
const corrected = new Set(evalSet.corrected), tally = { search: {}, grep: {} };
for (const k of Object.keys(tally)) tally[k] = { hit: 0, byKind: {}, stale_unflagged: 0, flagged_ok: 0, flagged_total: 0 };
for (const item of evalSet.questions) {
  for (const [name, results] of [['search', searchKnowledge(item.q, { limit: 5 }).results], ['grep', baseline(item.q)]]) {
    const t = tally[name], found = results.find(r => item.expect.includes(r.ref)), kind = t.byKind[item.kind] ||= { hit: 0, total: 0 };
    kind.total++; if (found) { t.hit++; kind.hit++; }
    for (const r of results) if (corrected.has(r.ref) && !r.corrected_by && !r.correction_note) t.stale_unflagged++;
    if (item.flagged) { t.flagged_total++; if (found && (found.corrected_by || found.correction_note)) t.flagged_ok++; }
    if (verbose) console.log(name.padEnd(6), found ? 'hit ' : 'MISS', item.kind.padEnd(10), item.q, '→', results.map(r => r.ref).join(', ') || '(无)');
  }
}
const total = evalSet.questions.length;
for (const [name, t] of Object.entries(tally))
  console.log(`${name.padEnd(6)} hit@5 ${t.hit}/${total}  ` + Object.entries(t.byKind).map(([k, v]) => `${k} ${v.hit}/${v.total}`).join('  ') + `  | 带更正标记 ${t.flagged_ok}/${t.flagged_total}  | 被更正旧条未标记返回 ${t.stale_unflagged} 次`);
