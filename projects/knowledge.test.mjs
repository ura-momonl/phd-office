// 更正关系（corrects）、影响查询（impact）和全文检索（search）。只用测试自建的夹具项目，不读真实项目数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFramework, checkFramework, addEntry, linkNodes, frameworkDigest, impactReport, frameworkFile } from './framework.mjs';
import { searchKnowledge } from './search.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('这些测试会写入所在目录，请用 node scripts/run-tests.mjs 在隔离副本里运行');

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()).replaceAll('-', '');
const BASE = `## 时间日志
<!--node {"type":"timeline","id":"zz-log"}-->

### T-20261001-01 旧结论：τ 为 20 ms
<!--node {"date":"2026-10-01","summary":"first estimate"}-->
热时间常数 τ = 20 ms，来自第一次拟合。

### T-20261002-01 依赖旧结论的处理
<!--node {"date":"2026-10-02","links":["T-20261001-01"]}-->
基于 T-20261001-01 的数值做了响应度换算。

### T-20261003-01 只在正文提到
<!--node {"date":"2026-10-03"}-->
参见 T-20261001-01 的做法。

### T-20261005-01 重新拟合
<!--node {"date":"2026-10-05"}-->
补到全部频率点后 τ 不是 20 ms。
`;
function fixture(t, text = BASE, id = 'zz-knowledge') {
  const dir = path.dirname(frameworkFile(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(frameworkFile(id), '# Fixture\n\n' + text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return id;
}
const withMeta = (text, id, patch) => text.replace(new RegExp(`(### ${id}[^\\n]*\\n<!--node )(\\{.*?\\})(-->)`), (_, a, json, c) => a + JSON.stringify({ ...JSON.parse(json), ...patch }) + c);
const problemsOf = text => checkFramework('zz-x', { source: '# F\n\n' + text, today: TODAY }).problems;

test('corrects: only records may carry it, and only toward earlier existing records', () => {
  assert.deepEqual(problemsOf(withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261001-01'] })), []);
  const bad = {
    '指向自己': withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261005-01'] }),
    '不存在': withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261001-99'] }),
    '不早于本条': withMeta(BASE, 'T-20261001-01', { corrects: ['T-20261005-01'] }),
    '字符串数组': withMeta(BASE, 'T-20261005-01', { corrects: 'T-20261001-01' }),
  };
  for (const [why, text] of Object.entries(bad)) assert.ok(problemsOf(text).some(p => p.includes('corrects') && p.includes(why)), why);
  const node = BASE.replace('<!--node {"type":"timeline","id":"zz-log"}-->', '<!--node {"type":"timeline","id":"zz-log","corrects":["T-20261001-01"]}-->');
  assert.ok(problemsOf(node).some(p => p.includes('只用于时间记录')), 'a non-record node cannot declare a correction');
});

test('entry-add and node-link record corrections on the newer record and leave the older record byte-identical', t => {
  const id = fixture(t);
  const before = parseFramework(fs.readFileSync(frameworkFile(id), 'utf8')).byId.get('T-20261001-01');
  const made = addEntry(id, { parent: 'zz-log', title: '更正：τ 的拟合范围', body: '全频率点重拟合', corrects: ['T-20261001-01'], date: '2026-10-06' });
  assert.equal(made.id, `T-${TODAY}-01`);
  const after = parseFramework(fs.readFileSync(frameworkFile(id), 'utf8'));
  assert.deepEqual(after.byId.get(made.id).meta.corrects, ['T-20261001-01']);
  assert.deepEqual(after.correctedBy.get('T-20261001-01'), [made.id]);
  const old = after.byId.get('T-20261001-01');
  assert.equal(old.body, before.body); assert.deepEqual(old.meta, before.meta);

  assert.deepEqual(linkNodes(id, 'T-20261005-01', 'T-20261001-01', 'corrects'), { from: 'T-20261005-01', to: 'T-20261001-01', rel: 'corrects', changed: true });
  assert.equal(linkNodes(id, 'T-20261005-01', 'T-20261001-01', 'corrects').changed, false, 'repeating is a no-op');
  assert.deepEqual(parseFramework(fs.readFileSync(frameworkFile(id), 'utf8')).correctedBy.get('T-20261001-01').sort(), ['T-20261005-01', made.id].sort());
  assert.throws(() => linkNodes(id, 'T-20261005-01', 'T-20261001-01', 'supersedes'), /rel 只能是/);

  const bytes = fs.readFileSync(frameworkFile(id), 'utf8');
  assert.throws(() => addEntry(id, { parent: 'zz-log', title: 'x', corrects: ['T-20269999-01'] }), /corrects 指向不存在/);
  assert.throws(() => linkNodes(id, 'T-20261001-01', 'T-20261005-01', 'corrects'), /不早于本条/);
  assert.equal(fs.readFileSync(frameworkFile(id), 'utf8'), bytes, 'rejected writes leave the file untouched');
});

test('the outline marks corrected and correcting records so a reader sees the correction before citing', t => {
  const id = fixture(t, withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261001-01'] }).replace('来自第一次拟合。', '来自第一次拟合。\n- 后续更正（2026-10-05）：见 T-20261005-01。') + '\n### T-20261006-01 原地更正\n<!--node {"date":"2026-10-06"}-->\n结论\n- 后续更正（2026-10-07）：数值有误。\n');
  const out = frameworkDigest(id);
  assert.match(out, /T-20261001-01 .*［已被 T-20261005-01 更正］/);
  assert.match(out, /T-20261005-01 .*［更正 T-20261001-01］/);
  assert.doesNotMatch(out.split('\n').find(l => l.startsWith('- T-20261002-01')), /更正/);
  assert.match(out, /T-20261006-01 .*［正文含后续更正，先读］/, 'an in-place note without a declaration is still flagged, without naming a corrector');
  assert.doesNotMatch(out.split('\n').find(l => l.startsWith('- T-20261001-01')), /正文含后续更正/, 'a declared correction is not double-tagged');
});

test('impact lists direct referrers of corrected records, separates the corrector, and names notes without a declaration', t => {
  const text = withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261001-01'] }).replace('补到全部频率点后', '补到全部频率点后（见 T-20261001-01）');
  const id = fixture(t, text + `
### T-20261006-01 旧条目内联更正
<!--node {"date":"2026-10-06"}-->
结论文字
- 后续更正（2026-10-07）：数值有误。
`);
  const all = impactReport(id);
  assert.equal(all.corrected.length, 1);
  const [c] = all.corrected;
  assert.equal(c.id, 'T-20261001-01');
  assert.deepEqual(c.corrected_by.map(x => x.id), ['T-20261005-01']);
  assert.deepEqual(c.referrers.map(d => [d.id, d.via.join('+')]).sort(), [['T-20261002-01', 'links+mention'], ['T-20261003-01', 'mention']]);
  assert.ok(c.referrers.every(d => d.also_cites_corrector === false));
  assert.deepEqual(all.note_only.map(n => n.id), ['T-20261006-01']);

  const one = impactReport(id, 'T-20261002-01');
  assert.deepEqual(one.corrected[0].corrected_by, []); assert.equal(one.note_only, undefined);
  assert.throws(() => impactReport(id, 'nope'), /未找到/);
  assert.throws(() => impactReport('zz-missing'), /没有 FRAMEWORK/);
});

test('search: Chinese and English substrings, short words, all terms required, corrections flagged not hidden', t => {
  const id = fixture(t, withMeta(BASE, 'T-20261005-01', { corrects: ['T-20261001-01'] }).replace('来自第一次拟合。', '来自第一次拟合。\n- 后续更正（2026-10-05）：见 T-20261005-01。') + `
### T-20261006-01 Mixed 标题 Fit
<!--node {"date":"2026-10-06"}-->
Lock-in "amplifier" 读数 drift；τ 的 Quote\\"s。
- 后续更正（2026-10-07）：读数单位有误。

### T-20261007-01 只有标题的记录
<!--node {"date":"2026-10-07"}-->
`);
  const dir = path.dirname(frameworkFile(id));
  fs.mkdirSync(path.join(dir, 'literature-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'literature-notes', 'paper.md'), '# Calendering paper\n压延条件 55 MPa。\n');
  fs.writeFileSync(path.join(dir, 'STATUS.md'), '# 状态\n压延 55 MPa 生成视图\n');
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis', 'FRAMEWORK.before-edit.md'), '# 旧快照\n压延快照专用词 55 MPa\n');
  const base = path.dirname(dir), find = (q, o) => searchKnowledge(q, { base, project: id, ...o });

  assert.deepEqual(find('热时间常数').results.map(r => r.ref), ['T-20261001-01']);
  const hit = find('热时间常数').results[0];
  assert.deepEqual(hit.corrected_by, ['T-20261005-01']); assert.match(hit.excerpt, /热时间常数/); assert.equal(hit.correction_note, undefined);
  assert.equal(find('LOCK-IN').results[0].ref, 'T-20261006-01', 'case-insensitive');
  assert.equal(find('读数').results[0].ref, 'T-20261006-01', 'two-character word falls back to substring');
  assert.deepEqual(find('只有标题的记录').results.map(r => r.ref), ['T-20261007-01'], 'a node with only a title is still findable');
  assert.equal(find('读数').results[0].correction_note, true, 'inline correction without a declaration is flagged');
  assert.equal(find('第一次拟合').results[0].correction_note, undefined, 'a declared correction is reported through corrected_by, not as an undeclared note');
  assert.equal(find('"amplifier"').total, 1, 'quotes in the query are literal text, not FTS syntax');
  assert.equal(find('amplifier AND OR NEAR').mode, 'near', 'operator-looking words are only words; no exact match falls back to approximate');
  assert.equal(find('lock\"in').results[0].ref, 'T-20261006-01', 'an unbalanced quote is plain text and still finds the piece "lock"');
  assert.equal(find('τ 20 ms').results[0].ref, 'T-20261001-01');
  assert.equal(find('lock-in 压延').mode, 'near', 'exact needs every term in one chunk; otherwise the result is labelled approximate');
  assert.equal(find('lock-in').mode, 'exact'); assert.ok(find('lock-in 压延').results.every(r => r.score > 0), 'approximate hits carry a score');
  const sentence = find('你还记得热时间常数的拟合吗');
  assert.equal(sentence.mode, 'near'); assert.equal(sentence.results[0].ref, 'T-20261001-01'); assert.match(sentence.note, /近似/);
  assert.equal(find('zqxjv').mode, 'none');
  assert.deepEqual(find('压延').results.map(r => r.ref), ['workspace/projects/zz-knowledge/literature-notes/paper.md']);
  assert.equal(find('生成视图').total, 0, 'STATUS.md is generated and not indexed');
  assert.equal(find('快照专用词').total, 0, 'FRAMEWORK snapshots are not indexed beside the live FRAMEWORK.md');
  assert.equal(find('热时间常数', { limit: 0 }).results.length, 0);
  assert.throws(() => find('  '), /请给查询词/);
  assert.throws(() => searchKnowledge('x', { base, project: 'zz-missing' }), /没有这个项目文件夹/);
  assert.throws(() => searchKnowledge('x', { base, project: '../x' }), /没有这个项目文件夹/);
});

test('sessions and projects share one search algorithm: agent/run.mjs uses automation/text-match.mjs and keeps no private copy', () => {
  const agent = fs.readFileSync(new URL('../agent/run.mjs', import.meta.url), 'utf8'), mine = fs.readFileSync(new URL('./search.mjs', import.meta.url), 'utf8');
  for (const source of [agent, mine]) assert.match(source, /from '\.\.\/automation\/text-match\.mjs'/);
  assert.doesNotMatch(agent, /const piecesOf|FUNCTION_CHARS/); assert.doesNotMatch(mine, /const piecesOf|FUNCTION_CHARS/);
});

test('search reads without writing: no index file, FRAMEWORK.md bytes unchanged', t => {
  const id = fixture(t);
  const file = frameworkFile(id), before = fs.readFileSync(file), listing = () => fs.readdirSync(path.dirname(file)).sort();
  const names = listing();
  searchKnowledge('热时间常数', { base: path.dirname(path.dirname(file)), project: id });
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(listing(), names);
});

test('search returns complete matching paragraphs including trailing qualifications and file paths',t=>{
  const paragraph='先保留完整研究背景。'.repeat(25)+'段落命中词。'+'分析结果说明。'.repeat(40)+'但该结论只适用于低温，成果在 D:/research/完整路径/结果.csv。';
  const second='另一段也有段落命中词，必须同时保留这段末尾的排除条件。';
  const id=fixture(t,'## 独立条目\n<!--node {"id":"full-paragraph"}-->\n'+paragraph+'\n\n不相关的中间段落。\n\n'+second,'zz-full-paragraph');
  const result=searchKnowledge('段落命中词',{base:path.dirname(path.dirname(frameworkFile(id))),project:id});
  assert.equal(result.results.length,1);
  assert.equal(result.results[0].ref,'full-paragraph');
  assert.equal(result.results[0].excerpt,paragraph+'\n\n'+second);
});
