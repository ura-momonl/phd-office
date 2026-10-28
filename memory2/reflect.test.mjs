import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries, readMarkdown, parseStructuredEntry } from './md.mjs';
import { MemoryIndex } from './index.mjs';
import { Searcher } from './search.mjs';
import { tuning } from './extract.mjs';
import { writeLedger, readLedger } from './ledger-store.mjs';
import { clusterByGeometry, mergeClusters, cosine, ClusterStore, clusterNewEpisodes, selectCandidates, reflectEpisodes, runReflection, loadEpisodes } from './reflect.mjs';

tuning.retryDelayMs = 0;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-refl-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const DIM = 8;
// Topic-keyed embedder: 甲 / 乙 / 丙 point along different axes, so cluster membership is decided by the test, not by chance.
const embedder = { model: 'topic-fake', async embed(texts) {
  return texts.map(t => { const v = new Array(DIM).fill(0.01); ['甲', '乙', '丙'].forEach((k, i) => { if (t.includes(k)) v[i] = 1; }); return v; });
} };
const ep = (content, iso, extra = {}) => ({ inline: { owner_id: 'claude', session_id: 's1', timestamp: iso, parent_type: 'memcell', parent_id: 'mc', ...extra }, sections: { Subject: content.slice(0, 6), Content: content } });
const fact = (text, parent, iso) => ({ inline: { owner_id: 'claude', timestamp: iso, parent_type: 'episode', parent_id: parent }, sections: { Fact: text } });

function scriptedLlm({ failFor = null } = {}) {
  const f = async (prompt, { purpose }) => {
    f.log.push({ purpose, prompt });
    if (purpose === 'memory2-reflect') {
      if (failFor && prompt.includes(failFor)) throw new Error('reflector down');
      return '```json\n{"title": "合并后的标题", "content": "合并叙述：' + (prompt.match(/主题[甲乙丙]\d*/g) || []).join('、') + '"}\n```';
    }
    return '{"atomic_facts": {"time": "October 24, 2026(Saturday) at 01:00 AM", "atomic_fact": ["合并后的事实一", "合并后的事实二"]}}';
  };
  f.log = [];
  return f;
}
// Fixture: 3 topic-甲 episodes within a week, one 乙, one 甲 three weeks later; the first two 甲 episodes have atomic facts.
function fixture() {
  const root = new MemoryRoot(tmp());
  const [a1] = appendEntries(root, 'episode', 'claude', '2026-10-01', [ep('主题甲1 第一次讨论', '2026-10-01T10:00:00.000Z')]);
  const [a2, b1] = appendEntries(root, 'episode', 'claude', '2026-10-03', [ep('主题甲2 继续讨论', '2026-10-03T10:00:00.000Z'), ep('主题乙1 另一件事', '2026-10-03T11:00:00.000Z')]);
  const [late] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('主题甲3 三周后又提到', '2026-10-24T10:00:00.000Z')]);
  appendEntries(root, 'atomic_fact', 'claude', '2026-10-01', [fact('旧事实A', a1, '2026-10-01T10:00:00.000Z')]);
  appendEntries(root, 'atomic_fact', 'claude', '2026-10-03', [fact('旧事实B', a2, '2026-10-03T10:00:00.000Z'), fact('乙的事实', b1, '2026-10-03T11:00:00.000Z')]);
  return { root, store: new ClusterStore(root), ids: { a1, a2, b1, late } };
}

test('cluster geometry: needs similarity >= threshold inside the time window; merge is a weighted centroid', () => {
  const c = (v, ts, id = 'x', n = 1) => ({ id, centroid: v, count: n, last_ts: ts, preview: ['p'], members: [id + ts] });
  const day = 86400000;
  assert.ok(Math.abs(cosine([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-6);
  assert.equal(clusterByGeometry(c([1, 0], 0), [c([0, 1], 0)]), null, 'orthogonal');
  assert.equal(clusterByGeometry(c([1, 0], 8 * day), [c([1, 0], 0)]), null, 'outside 7-day window');
  const m = clusterByGeometry(c([1, 0], 3 * day, 'new'), [c([1, 0.1], 0, 'old', 3)]);
  assert.equal(m.id, 'old');
  assert.equal(m.count, 4);
  assert.equal(m.last_ts, 3 * day);
  assert.ok(Math.abs(m.centroid[1] - 0.075) < 1e-9, 'weighted by counts');
  assert.deepEqual(mergeClusters(c([1], 5, 'a'), c([1], 9, 'b')).members, ['a5', 'b9']);
  assert.equal(clusterByGeometry(c([1, 0], 0), []), null);
});

test('clusterNewEpisodes groups by topic and window, is idempotent, and keeps clusters in SQLite', async () => {
  const { root, store, ids } = fixture();
  const r = await clusterNewEpisodes({ root, store, embedder, owner: 'claude', dim: DIM });
  assert.deepEqual(r, { folded: 4, created: 3, merged: 1 });
  const clusters = store.listForOwner('claude');
  const sizes = clusters.map(c => c.members.length).sort();
  assert.deepEqual(sizes, [1, 1, 2]);
  assert.deepEqual(clusters.find(c => c.members.length === 2).members.sort(), [ids.a1, ids.a2].sort());
  assert.deepEqual(await clusterNewEpisodes({ root, store, embedder, owner: 'claude', dim: DIM }), { folded: 0, created: 0, merged: 0 });
  assert.equal(selectCandidates(store, 'claude').length, 1, 'only the 2-member cluster is a candidate');
  store.close();
});

test('reflectEpisodes: INIT needs >=2 sorted episodes; UPDATE feeds the old narrative; prompt is the zh upstream one', async () => {
  const llm = scriptedLlm();
  const e = (t, ms) => ({ episode: t, timestamp_ms: ms });
  await assert.rejects(reflectEpisodes(llm, [e('主题甲1', 1)]), /at least 2/);
  await assert.rejects(reflectEpisodes(llm, [e('主题甲1', 5), e('主题甲2', 1)]), /sorted/);
  const r = await reflectEpisodes(llm, [e('主题甲1', 1), e('主题甲2', 2)]);
  assert.deepEqual([r.subject, r.timestamp_ms], ['合并后的标题', 2]);
  assert.match(llm.log[0].prompt, /1\. 主题甲1\n2\. 主题甲2/);
  assert.match(llm.log[0].prompt, /记忆整合助手/);
  assert.match(llm.log[0].prompt, /"content"/);
  await reflectEpisodes(llm, [e('主题甲5', 9)], { oldEpisode: { episode: '旧叙述XYZ' } });
  assert.match(llm.log.at(-1).prompt, /旧叙述XYZ/);
  assert.match(llm.log.at(-1).prompt, /1\. 主题甲5/);
});

test('runReflection merges a cluster: merged episode written, originals + their facts deprecated, nothing deleted, cluster reset, index hides the old ones', async () => {
  const { root, store, ids } = fixture();
  const idx = new MemoryIndex(root, { embedder, dim: DIM });
  await idx.syncAll();
  const llm = scriptedLlm();
  writeLedger(root, { watermark_ms: 0, pinned: [], entries: { [ids.a1]: { recalled: 3, used: 2, last_used_ms: 1000, uses: [900, 1000] } } });
  const run = await runReflection({ root, store, embedder, llm, owner: 'claude', dim: DIM, index: idx });
  assert.equal(run.reports.length, 1);
  const rep = run.reports[0];
  const inherited = readLedger(root).entries[rep.merged_entry_id];
  assert.deepEqual([inherited.recalled, inherited.used, inherited.merged_from.length], [3, 2, 2], 'the merged episode inherits the ledger history of its sources');
  assert.ok(inherited.uses.includes(900) && inherited.uses.includes(1000));
  assert.deepEqual([rep.mode, rep.source_count, rep.deprecated_facts, rep.new_facts], ['init', 2, 2, 2]);
  // md: merged episode exists with parent_type=cluster and provenance; originals still present but deprecated
  const eps = loadEpisodes(root, 'claude');
  const merged = eps.get(rep.merged_entry_id);
  assert.equal(merged.parent_type, 'cluster');
  assert.equal(merged.session_id, null);
  assert.match(merged.episode, /主题甲1.*主题甲2/);
  assert.deepEqual(parseStructuredEntry(readMarkdown(merged.file).entries.find(e => e.id === rep.merged_entry_id).body).inline.merged_from, `[${[ids.a1, ids.a2].join(', ')}]`);
  assert.equal(eps.get(ids.a1).deprecated_by, rep.merged_entry_id);
  assert.equal(eps.get(ids.a2).deprecated_by, rep.merged_entry_id);
  assert.equal(eps.get(ids.a1).episode, '主题甲1 第一次讨论', 'original text is kept');
  assert.equal(eps.get(ids.b1).deprecated_by, null);
  assert.equal(eps.get(ids.late).deprecated_by, null);
  // facts: old facts of the merged episodes deprecated, the other topic's fact untouched, new facts attached to the merged episode
  const facts = path.join(path.dirname(root.dailyPath('atomic_fact', 'claude', '2026-10-01')));
  const allFacts = fs.readdirSync(facts).flatMap(f => { const p = readMarkdown(path.join(facts, f)); return p.entries.map(e => ({ text: parseStructuredEntry(e.body).sections.Fact, dep: p.frontmatter.deprecated_entries?.[e.id] || null, parent: parseStructuredEntry(e.body).inline.parent_id })); });
  assert.deepEqual(allFacts.filter(f => f.dep).map(f => f.text).sort(), ['旧事实A', '旧事实B']);
  assert.equal(allFacts.find(f => f.text === '乙的事实').dep, null);
  assert.deepEqual(allFacts.filter(f => f.parent === rep.merged_entry_id).map(f => f.text), ['合并后的事实一', '合并后的事实二']);
  // store: cluster reset to the merged episode, report recorded
  const cl = store.listForOwner('claude').find(c => c.members.includes(rep.merged_entry_id));
  assert.deepEqual([cl.members, cl.count], [[rep.merged_entry_id], 1]);
  assert.equal(store.reports('claude').length, 1);
  // search: deprecated episodes/facts are gone from default results, the merged one is findable
  const s = new Searcher(idx);
  const hit = await s.search({ owner_id: 'claude', query: '主题甲 讨论', method: 'keyword', topK: 10 });
  assert.ok(hit.items.some(i => i.entry_id === rep.merged_entry_id));
  assert.ok(!hit.items.some(i => [ids.a1, ids.a2].includes(i.entry_id)));
  assert.ok((await s.search({ owner_id: 'claude', query: '主题甲 讨论', method: 'keyword', topK: 10, includeDeprecated: true })).items.some(i => i.entry_id === ids.a1));
  // a second run has nothing to do
  const again = await runReflection({ root, store, embedder, llm, owner: 'claude', dim: DIM, index: idx });
  assert.deepEqual([again.candidates, again.reports.length], [0, 0]);
  await idx.close(); store.close();
});

test('a new episode joining a reflected cluster triggers UPDATE mode with the earlier narrative', async () => {
  const { root, store } = fixture();
  const llm = scriptedLlm();
  const first = await runReflection({ root, store, embedder, llm, owner: 'claude', dim: DIM });
  const mergedId = first.reports[0].merged_entry_id;
  const [a3] = appendEntries(root, 'episode', 'claude', '2026-10-05', [ep('主题甲4 又有进展', '2026-10-05T10:00:00.000Z')]);
  const second = await runReflection({ root, store, embedder, llm, owner: 'claude', dim: DIM });
  assert.equal(second.reports.length, 1);
  assert.equal(second.reports[0].mode, 'update');
  const updatePrompt = llm.log.filter(l => l.purpose === 'memory2-reflect').at(-1).prompt;
  assert.match(updatePrompt, /合并叙述：主题甲1/, 'old narrative is passed in');
  assert.match(updatePrompt, /1\. 主题甲4 又有进展/);
  const eps = loadEpisodes(root, 'claude');
  assert.equal(eps.get(mergedId).deprecated_by, second.reports[0].merged_entry_id, 'previous merged episode is superseded');
  assert.equal(eps.get(a3).deprecated_by, second.reports[0].merged_entry_id);
  assert.deepEqual(store.reports('claude').map(r => r.mode), ['init', 'update']);
  store.close();
});

test('a failing cluster is skipped and reported, writes nothing, and does not block other clusters', async () => {
  const root = new MemoryRoot(tmp()), store = new ClusterStore(root);
  const [a1, a2] = appendEntries(root, 'episode', 'claude', '2026-10-01', [ep('主题甲1 内容', '2026-10-01T10:00:00.000Z'), ep('主题甲2 内容', '2026-10-01T11:00:00.000Z')]);
  const [b1, b2] = appendEntries(root, 'episode', 'claude', '2026-10-02', [ep('主题乙1 内容', '2026-10-02T10:00:00.000Z'), ep('主题乙2 内容', '2026-10-02T11:00:00.000Z')]);
  const run = await runReflection({ root, store, embedder, llm: scriptedLlm({ failFor: '主题甲1' }), owner: 'claude', dim: DIM });
  assert.equal(run.reports.length, 1);
  assert.equal(run.skipped.length, 1);
  assert.match(run.skipped[0].reason, /reflector down/);
  const eps = loadEpisodes(root, 'claude');
  assert.equal(eps.get(a1).deprecated_by, null);
  assert.equal(eps.get(a2).deprecated_by, null);
  assert.ok(eps.get(b1).deprecated_by && eps.get(b2).deprecated_by);
  assert.equal([...eps.values()].filter(e => e.parent_type === 'cluster').length, 1, 'only the successful cluster produced a merged episode');
  await assert.rejects(runReflection({ root, store, embedder: null, llm: scriptedLlm(), owner: 'claude', dim: DIM }), /嵌入模型/);
  store.close();
});
