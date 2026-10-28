import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries } from './md.mjs';
import { MemoryIndex } from './index.mjs';
import { Searcher } from './search.mjs';
import { tokenize } from './tokenizer.mjs';
import { agenticSearch, llmDecider, parseDecision, coerceCore, finalize, renderBlocks, DECIDER_PROMPT } from './agentic.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-agt-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const embedder = { model: 'fake', async embed(texts) {
  return texts.map(t => { const v = new Array(256).fill(0); for (const tok of tokenize(t)) { let h = 7; for (const c of tok) h = (h * 131 + c.codePointAt(0)) % 256; v[h] += 1; } return v; });
} };
const ep = (subject, content) => ({ inline: { owner_id: 'claude', session_id: 's', timestamp: '2026-10-24T10:00:00.000Z', parent_type: 'memcell', parent_id: 'mc' }, sections: { Subject: subject, Content: content } });
async function fixture() {
  const root = new MemoryRoot(tmp());
  const ids = appendEntries(root, 'episode', 'claude', '2026-10-24', [
    ep('Raman 偏振数据整理', '整理 TaIrTe4 的 Raman 偏振数据和图片。'),
    ep('嵌入模型显存优化', '把嵌入模型显存从七千降到五千，向量不变。'),
    ep('文献回填', '回填 Nature Nanotechnology 的两千零二十年文献。'),
    ep('记忆系统试用', '开启新记忆注入，只给 Claude 试用。')]);
  const idx = new MemoryIndex(root, { embedder, dim: 256 });
  await idx.syncAll();
  return { idx, searcher: new Searcher(idx), ids };
}

test('parseDecision tolerates prose and braces around the object; coerceCore keeps valid unique indices only', () => {
  assert.deepEqual(parseDecision('好的 {note} 结果：{"core":[0,2],"next_queries":["a}b"]} 完毕 }'), { core: [0, 2], next_queries: ['a}b'] });
  assert.throws(() => parseDecision('没有 JSON'));
  assert.deepEqual(coerceCore([0, '2', 2, 9, -1, 1.5, true, 'x'], 5), [0, 2]);
  assert.deepEqual(coerceCore('nope', 5), []);
});

test('llmDecider: fills the prompt, parses the reply, caps sub-queries; a broken reply retries then falls back to the top candidates and is flagged', async () => {
  const seen = [];
  const good = llmDecider(async p => { seen.push(p); return '{"core":[1],"next_queries":["q1","q2","q3","q4","  "]}'; }, { maxSubqueries: 3 });
  const d = await good('问题？', '(none)', '[block: original question]\n  0: a - b', 2, 0);
  assert.deepEqual(d, { stop: false, queries: ['q1', 'q2', 'q3'], core: [1] });
  assert.match(seen[0], /QUESTION:\n问题？/); assert.match(seen[0], /up to 3/); assert.doesNotMatch(seen[0], /\{question\}|\{evidence\}|\{max_sub\}/);
  let calls = 0;
  const bad = llmDecider(async () => { calls++; return calls < 9 ? 'oops' : ''; }, { retries: 1, fallbackCore: 3 });
  const f = await bad('q', '', 'e', 5, 0);
  assert.equal(calls, 2); assert.equal(f.failed, true); assert.deepEqual(f.core, [0, 1, 2]); assert.equal(f.stop, true);
  assert.ok(DECIDER_PROMPT.includes('same language as the question'));
});

test('agenticSearch: round 0 stops when the decider is satisfied; the cored item is first and slotted as core', async () => {
  const { idx, searcher } = await fixture();
  const calls = [];
  const decider = async (q, core, evidence, n, round) => { calls.push({ round, n }); const gi = evidence.split('\n').findIndex(l => /Raman/.test(l)); return { stop: true, queries: [], core: [Math.max(0, gi - 1)] }; };
  const r = await agenticSearch({ searcher, decider, query: 'Raman 偏振数据', owner_id: 'claude', tune: { topK: 3 } });
  assert.equal(calls.length, 1); assert.equal(r.rounds.length, 1);
  assert.equal(r.items[0].slot, 'core'); assert.equal(r.items[0].row.subject, 'Raman 偏振数据整理');
  assert.ok(r.items.length <= 3);
  await idx.close();
});

test('agenticSearch: follow-up sub-queries run as separate blocks, accumulate core from both, and stop after the patience limit', async () => {
  const { idx, searcher } = await fixture();
  const rounds = [];
  const pick = (evidence, re) => { const lines = evidence.split('\n'); const i = lines.findIndex(l => /^\s+\d+:/.test(l) && re.test(l)); return i < 0 ? [] : [Number(lines[i].trim().split(':')[0])]; };
  const decider = async (q, core, evidence, n, round) => {
    rounds.push({ round, evidence, core });
    if (round === 0) return { stop: false, queries: ['嵌入模型 显存', '文献回填 Nature'], core: pick(evidence, /Raman/) };
    return { stop: false, queries: ['别的方面'], core: round === 1 ? [...pick(evidence, /显存/), ...pick(evidence, /文献回填 -/)] : [] };
  };
  const r = await agenticSearch({ searcher, decider, query: '最近都做了什么', owner_id: 'claude', tune: { topK: 4, maxRounds: 5, patience: 1 } });
  assert.match(rounds[1].evidence, /\[block: 嵌入模型 显存\]/); assert.match(rounds[1].evidence, /\[block: 文献回填 Nature\]/);
  assert.match(rounds[1].core, /\[from "original question"\].*Raman/);
  assert.equal(r.rounds.length, 3, 'round 2 added nothing -> patience 1 stops there');
  assert.equal(r.core, 3);
  assert.equal(r.items.filter(i => i.slot === 'core').length, 3);
  await idx.close();
});

test('agenticSearch: empty store gives no items without asking the decider; other owners never appear', async () => {
  const { idx, searcher } = await fixture();
  let asked = 0;
  const none = await agenticSearch({ searcher, decider: async () => { asked++; return { stop: true, queries: [], core: [] }; }, query: '完全无关的词汇zzzz', owner_id: 'nobody' });
  assert.deepEqual(none.items, []); assert.equal(asked, 0);
  await assert.rejects(agenticSearch({ searcher, decider: async () => ({}), query: '  ', owner_id: 'claude' }));
  await idx.close();
});

test('agenticSearch preserves the decider failure reason alongside fallback results', async () => {
  const { idx, searcher } = await fixture();
  try {
    let calls=0;
    const result=await agenticSearch({searcher,owner_id:'claude',query:'Raman',decider:llmDecider(async()=>{calls++;throw new Error('spawn EPERM');},{retries:0})});
    assert.equal(calls,1);assert.equal(result.failed_rounds,1);
    assert.equal(result.rounds[0].error,'spawn EPERM');assert.ok(result.items.length>0);
  } finally { await idx.close(); }
});

test('finalize: core first (capped at topK), then per-sub-query guarantee, then max-score fill', () => {
  const row = id => ({ id, score: 0, row: { entry_id: id } });
  const candById = new Map(['a', 'b', 'c', 'd', 'e'].map(i => [i, row(i)]));
  const subqHits = new Map([['a', { q: 0.2 }], ['b', { q: 0.9 }], ['c', { r: 0.8 }], ['d', { q: 0.5, r: 0.7 }], ['e', { q: 0.1 }]]);
  const out = finalize({ topK: 4, coreOrder: ['a'], coreIds: new Set(['a']), candById, subqHits, guarantee: [['q', 'b'], ['r', 'c']] });
  assert.deepEqual(out.map(o => [o.id, o.slot]), [['a', 'core'], ['b', 'guarantee'], ['c', 'guarantee'], ['d', 'fill']]);
  const capped = finalize({ topK: 1, coreOrder: ['a', 'b'], coreIds: new Set(['a', 'b']), candById, subqHits, guarantee: [] });
  assert.deepEqual(capped.map(o => o.id), ['b'], 'core beyond the budget drops the lowest-scored');
  assert.match(renderBlocks([['x', [{ row: { subject: 'S', episode: '正文' } }]]]).text, /0: S - 原文：正文/);
});

test('renderBlocks keeps the entire existing summary or episode, distinguishes them and carries source IDs', () => {
  const tail = ' D:/Main/assistant/workspace/projects/example/final-data.csv';
  const episode = '记录正文'.repeat(100) + tail;
  const summary = '明确摘要'.repeat(80) + '摘要最后的决定';
  const rendered = renderBlocks([['original question', [
    { id: 'row-a', row: { entry_id: 'ep_a', subject: 'A', episode } },
    { id: 'row-b', row: { entry_id: 'ep_b', subject: 'B', summary, episode: '未选取的详细正文' } },
  ]]], 10);
  assert.ok(rendered.text.includes(episode));
  assert.ok(rendered.text.includes(summary));
  assert.match(rendered.text, /原文：.*\[ep_a\]/);
  assert.match(rendered.text, /摘要：.*\[ep_b\]/);
  assert.doesNotMatch(rendered.text, /未选取的详细正文/);
});

test('agenticSearch preserves a selected item tail in later-round core, without extra rounds', async () => {
  const root = new MemoryRoot(tmp());
  const content = 'Raman 数据分析'.repeat(70) + '末尾决定：返回原始数据复核';
  appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('Raman 尾部证据', content)]);
  const idx = new MemoryIndex(root, { embedder, dim: 256 });
  try {
    await idx.syncAll();
    let rounds = 0;
    const result = await agenticSearch({ searcher: new Searcher(idx), query: 'Raman 数据分析', owner_id: 'claude', tune: { maxRounds: 2, textChars: 5 }, decider: async (_query, core, evidence, _count, round) => {
      rounds++;
      assert.ok(evidence.includes(content));
      if (round) assert.ok(core.includes(content), 'the accumulated core must not lose the evidence tail');
      return { core: [0], queries: round ? [] : ['Raman 尾部证据'], stop: !!round };
    } });
    assert.equal(rounds, 2);
    assert.equal(result.items[0].row.episode, content);
  } finally { await idx.close(); }
});
