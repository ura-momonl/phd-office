import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries, patchFrontmatter } from './md.mjs';
import { MemoryIndex } from './index.mjs';
import { Searcher, rrf, lrFusion, buildWhere, LR_COEFS } from './search.mjs';
import { tokenize } from './tokenizer.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-srch-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function fakeEmbedder(dim = 128) {
  return { model: 'fake', async embed(texts) {
    return texts.map(t => { const v = new Array(dim).fill(0); for (const tok of tokenize(t)) { let h = 7; for (const c of tok) h = (h * 131 + c.codePointAt(0)) % dim; v[h] += 1; } return v; });
  } };
}
const ep = (content, extra = {}) => ({ inline: { owner_id: 'claude', session_id: 's1', timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'memcell', parent_id: 'm', ...extra }, sections: { Content: content } });

async function fixture(embedder = fakeEmbedder()) {
  const root = new MemoryRoot(tmp());
  const [a, b, c] = appendEntries(root, 'episode', 'claude', '2026-10-24', [
    ep('用户和助手争吵之后和好，用户说气消了'),
    ep('整理 TaIrTe4 项目的 Raman 偏振数据和图片', { session_id: 's2', timestamp: '2026-10-25T01:00:00.000Z' }),
    ep('讨论记忆系统的向量召回和关键词检索')]);
  appendEntries(root, 'episode', 'other', '2026-10-24', [ep('别的用户的记忆系统召回讨论', { owner_id: 'other' })]);
  const idx = new MemoryIndex(root, { embedder, dim: 64 });
  await idx.syncAll();
  return { root, idx, s: new Searcher(idx), ids: { a, b, c } };
}

test('fusion helpers: RRF ranks agreement first; LR gives calibrated probabilities from upstream coefficients', () => {
  const l1 = [{ id: 'x', score: 3 }, { id: 'y', score: 2 }], l2 = [{ id: 'y', score: .9 }, { id: 'z', score: .5 }];
  assert.equal(rrf(l1, l2)[0].id, 'y');
  const fused = lrFusion([{ id: 'p', score: 0.9 }, { id: 'q', score: 0.3 }], [{ id: 'q', score: 4 }]);
  assert.equal(fused[0].id, 'p');
  const expected = 1 / (1 + Math.exp(-(LR_COEFS.intercept + 0.9 * LR_COEFS.emb)));
  assert.ok(Math.abs(fused[0].score - expected) < 1e-12);
  assert.ok(fused.every(c => c.score > 0 && c.score < 1));
});

test('buildWhere scopes by owner/app/project, excludes deprecated by default, escapes quotes', () => {
  assert.equal(buildWhere({ owner_id: "o'x" }), "owner_id = 'o''x' AND app_id = 'default' AND project_id = 'default' AND deprecated_by IS NULL");
  assert.doesNotMatch(buildWhere({ owner_id: 'a', includeDeprecated: true }), /deprecated_by/);
  assert.match(buildWhere({ owner_id: 'a', session_id: 's', after_ms: 5 }), /session_id = 's' AND timestamp_ms > 5/);
});

test('keyword, vector and hybrid all find the right episode; other users never appear', async () => {
  const { idx, s, ids } = await fixture();
  for (const method of ['keyword', 'vector', 'hybrid']) {
    const r = await s.search({ owner_id: 'claude', query: '争吵 气消', method, topK: 3 });
    assert.equal(r.items[0].entry_id, ids.a, method);
    assert.ok(r.items.every(i => i.owner_id === 'claude'), method);
  }
  const r = await s.search({ owner_id: 'claude', query: '记忆系统 召回', topK: 5 });
  assert.equal(r.items[0].entry_id, ids.c);
  assert.equal(r.calibrated, true);
  assert.ok(r.items.every(i => i.episode_tokens === undefined && i.vector === undefined), 'no vectors or token blobs in results');
  await idx.close();
});

test('deprecated episodes are hidden by default and visible on request', async () => {
  const { root, idx, s, ids } = await fixture();
  patchFrontmatter(root.dailyPath('episode', 'claude', '2026-10-24'), { deprecated_entries: { [ids.a]: 'ep_20261026_00000001' } });
  await idx.syncAll();
  assert.ok(!(await s.search({ owner_id: 'claude', query: '争吵 气消', topK: 5 })).items.some(i => i.entry_id === ids.a));
  const withOld = await s.search({ owner_id: 'claude', query: '争吵 气消', topK: 5, includeDeprecated: true });
  assert.equal(withOld.items[0].entry_id, ids.a);
  assert.equal(withOld.items[0].deprecated_by, 'ep_20261026_00000001');
  await idx.close();
});

test('filters (session, time window), minScore and radius narrow results', async () => {
  const { idx, s, ids } = await fixture();
  const bySession = await s.search({ owner_id: 'claude', query: '数据 图片 记忆 吵架', method: 'keyword', topK: 10, session_id: 's2' });
  assert.deepEqual(bySession.items.map(i => i.entry_id), [ids.b]);
  const after = await s.search({ owner_id: 'claude', query: '数据 图片 记忆 吵架', method: 'keyword', topK: 10, after_ms: Date.parse('2026-10-24T12:00:00Z') });
  assert.deepEqual(after.items.map(i => i.entry_id), [ids.b]);
  const strict = await s.search({ owner_id: 'claude', query: '争吵 气消', method: 'vector', topK: 5, radius: 0.99 });
  assert.equal(strict.items.length, 0);
  const none = await s.search({ owner_id: 'claude', query: '争吵 气消', topK: 5, minScore: 0.999 });
  assert.equal(none.items.length, 0);
  await idx.close();
});

test('without an embedder: keyword works, hybrid degrades to keyword, vector is refused; empty query is refused', async () => {
  const { idx, s, ids } = await fixture(null);
  const h = await s.search({ owner_id: 'claude', query: '争吵 气消', method: 'hybrid' });
  assert.equal(h.method, 'hybrid(keyword-only)');
  assert.equal(h.calibrated, false);
  assert.equal(h.items[0].entry_id, ids.a);
  await assert.rejects(s.search({ owner_id: 'claude', query: 'x', method: 'vector' }), /嵌入模型/);
  await assert.rejects(s.search({ owner_id: 'claude', query: '  ' }), /不能为空/);
  await idx.close();
});

test('atomic facts are indexed and searchable as their own kind, with the parent episode id', async () => {
  const root = new MemoryRoot(tmp());
  const [ep1] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('用户和助手讨论记忆系统的召回')]);
  appendEntries(root, 'atomic_fact', 'claude', '2026-10-24', [
    { inline: { owner_id: 'claude', timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'episode', parent_id: ep1, session_id: 's1' }, sections: { Fact: '用户想重构长期记忆系统' } },
    { inline: { owner_id: 'claude', timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'episode', parent_id: ep1, session_id: 's1' }, sections: { Fact: '低温恒温器已经到货' } }]);
  const idx = new MemoryIndex(root, { embedder: fakeEmbedder(), dim: 64 });
  await idx.syncAll();
  const s = new Searcher(idx);
  const r = await s.search({ owner_id: 'claude', query: '重构 记忆', kind: 'atomic_fact', topK: 2 });
  assert.equal(r.items[0].fact, '用户想重构长期记忆系统');
  assert.equal(r.items[0].parent_id, ep1);
  assert.equal(r.items[0].fact_tokens, undefined);
  assert.equal((await s.search({ owner_id: 'claude', query: '重构 记忆', kind: 'episode' })).items[0].entry_id, ep1);
  await assert.rejects(s.search({ owner_id: 'claude', query: 'x', kind: 'nope' }), /kind/);
  await idx.close();
});

// ---- hierarchy (port of EverOS heap_expand) ----
import { heapExpand, cosineToLr, buildEpToFactParents, rrfWith } from './search.mjs';
const C = (id, score, row = {}) => ({ id, score, row });

test('cosineToLr is the LR probability of the fact cosine plus the parent BM25', () => {
  assert.ok(Math.abs(cosineToLr(0.9, 4) - 1 / (1 + Math.exp(-(LR_COEFS.intercept + 0.9 * LR_COEFS.emb + 4 * LR_COEFS.bm25)))) < 1e-12);
  assert.ok(cosineToLr(0.9) > cosineToLr(0.5));
  assert.ok(cosineToLr(0.5, 10) > cosineToLr(0.5, 0));
});

test('buildEpToFactParents: entry id first, memcell id too when different, nothing when neither', () => {
  const m = buildEpToFactParents([C('e1', 1, { entry_id: 'ep_1', parent_id: 'mc_1' }), C('e2', 1, { entry_id: 'ep_2', parent_id: 'ep_2' }), C('e3', 1, {})]);
  assert.deepEqual(m.get('e1'), ['ep_1', 'mc_1']);
  assert.deepEqual(m.get('e2'), ['ep_2']);
  assert.equal(m.has('e3'), false);
});

test('heapExpand: a strongly matching fact replaces its episode in the top-K; episodes without facts stay; scores are LR probabilities', () => {
  const dense = [C('e1', 0.62), C('e2', 0.55), C('e3', 0.3)], sparse = [C('e1', 5), C('e3', 2)];
  const facts = new Map([['e1', [C('f1a', 0.85), C('f1b', 0.4)]], ['e3', [C('f3', 0.1)]]]);
  const out = heapExpand({ sparse, dense, episodeToFacts: facts, topK: 3 });
  const ids = out.map(o => o.id);
  assert.ok(ids.includes('f1a'), 'strong fact enters');
  assert.ok(!ids.includes('e1'), 'its episode steps aside');
  assert.ok(ids.includes('e2'), 'episode without facts stays');
  const f1a = out.find(o => o.id === 'f1a');
  assert.equal(f1a.type, 'atomic_fact'); assert.equal(f1a.parent_episode_id, 'e1');
  assert.ok(Math.abs(f1a.score - cosineToLr(0.85, 5)) < 1e-12, 'fact scored with its parent BM25');
  assert.deepEqual(out.map(o => o.score), [...out.map(o => o.score)].sort((a, b) => b - a));
  assert.ok(out.length <= 3);
});

test('heapExpand: facts that cannot beat the current top-K are not added; empty input gives empty output; K is never exceeded', () => {
  const dense = [C('e1', 0.9), C('e2', 0.85)], sparse = [C('e1', 8), C('e2', 6)];
  const weak = new Map([['e1', [C('w', 0.05)]]]);
  const out = heapExpand({ sparse, dense, episodeToFacts: weak, topK: 2 });
  assert.deepEqual(out.map(o => o.id).sort(), ['e1', 'e2']);
  assert.deepEqual(heapExpand({ sparse: [], dense: [], episodeToFacts: new Map() }), []);
  const many = new Map([['e1', [C('a', 0.9), C('b', 0.88), C('c', 0.86), C('d', 0.84)]]]);
  assert.ok(heapExpand({ sparse, dense, episodeToFacts: many, topK: 2, factsPerEpisode: 3 }).length <= 2);
});

test('rrfWith honours k', () => {
  const a = [C('x', 1), C('y', 1)], b = [C('y', 1)];
  assert.ok(Math.abs(rrfWith(10, a, b).find(c => c.id === 'y').score - (1 / 12 + 1 / 11)) < 1e-12);
});

test('searcher.hierarchy: facts of the matching episode come back scored, scoped to the owner; episode pool lets a fact find its parent', async () => {
  const embedder = fakeEmbedder();
  const root = new MemoryRoot(tmp());
  const [a, b] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('讨论记忆系统的向量召回和关键词检索'), ep('整理 TaIrTe4 项目的 Raman 偏振数据')]);
  const fact = (t, p, owner = 'claude') => ({ inline: { owner_id: owner, timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'episode', parent_id: p }, sections: { Fact: t } });
  appendEntries(root, 'atomic_fact', 'claude', '2026-10-24', [fact('记忆系统使用向量召回和关键词检索', a), fact('Raman 偏振数据已整理', b)]);
  appendEntries(root, 'atomic_fact', 'other', '2026-10-24', [fact('别人的记忆系统向量召回', 'zzz', 'other')]);
  const idx = new MemoryIndex(root, { embedder, dim: 64 });
  await idx.syncAll();
  const r = await new Searcher(idx).hierarchy({ owner_id: 'claude', query: '记忆系统 向量召回', topK: 3 });
  const fact1 = r.items.find(i => i.type === 'atomic_fact');
  assert.ok(fact1, 'a fact is returned');
  assert.equal(fact1.row.parent_id, a);
  assert.equal(r.episodes.get(fact1.parent_episode_id).entry_id, a);
  assert.ok(r.items.every(i => i.row.owner_id === 'claude'));
  await idx.close();
});
