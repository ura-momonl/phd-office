import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries, patchFrontmatter } from './md.mjs';
import { MemoryIndex, truncateNormalize } from './index.mjs';
import { tokenize } from './tokenizer.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-idx-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// Deterministic fake embedder: hashed bag of jieba tokens -> unit vector. Counts calls so tests can prove "no re-embed".
function fakeEmbedder(dim = 64) {
  const e = { model: 'fake-embed', calls: 0, texts: 0, async embed(texts) {
    e.calls++; e.texts += texts.length;
    return texts.map(t => { const v = new Array(dim).fill(0); for (const tok of tokenize(t)) { let h = 0; for (const c of tok) h = (h * 131 + c.codePointAt(0)) % dim; v[h] += 1; } return v; });
  } };
  return e;
}
const ep = (content, subject, extra = {}) => ({ inline: { owner_id: 'claude', session_id: 's1', timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'memcell', parent_id: 'mc1', sender_ids: ['u', 'a'], ...extra },
  sections: { ...(subject ? { Subject: subject } : {}), Content: content } });
const rows = async (idx, where = '') => (await idx.table('episode')).query().where(where || 'true').select(['id', 'entry_id', 'deprecated_by', 'episode_tokens', 'content_sha256', 'session_id', 'sender_ids']).limit(1000).toArray();

test('tokenizer: search-mode jieba, min length 2, stopwords and punctuation dropped, symmetric for query and doc', () => {
  const t = tokenize('她问要不要陪我熬到3:30，The memory-system 换说法也能检索');
  assert.ok(t.includes('检索') && t.includes('memory') && t.includes('system') && t.includes('熬'.repeat(1)) === false);
  assert.ok(!t.includes('the') && !t.includes('，') && !t.includes('我'));
  assert.deepEqual(tokenize('吵架和好'), tokenize('吵架和好'));
});

test('truncateNormalize shortens and renormalises; too-short vectors are rejected', () => {
  const v = truncateNormalize([3, 4, 12, 0], 2);
  assert.deepEqual(v.map(x => Math.round(x * 1000) / 1000), [0.6, 0.8]);
  assert.throws(() => truncateNormalize([1, 2], 3), /小于索引维度/);
});

test('syncFile: first sync embeds and indexes; second sync skips by content hash; audit-field edits do not re-embed', async () => {
  const root = new MemoryRoot(tmp()), emb = fakeEmbedder(), idx = new MemoryIndex(root, { embedder: emb, dim: 32 });
  const [a, b] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('用户和助手讨论记忆系统的召回', '记忆召回'), ep('今天整理 TaIrTe4 的 Raman 数据')]);
  const file = root.dailyPath('episode', 'claude', '2026-10-24');
  const r1 = await idx.syncFile(file);
  assert.deepEqual([r1.upserted, r1.skipped, r1.deleted], [2, 0, 0]);
  assert.equal(emb.calls, 1, 'one embed batch per file');
  assert.equal(emb.texts, 3, 'content + subject for the first entry, content for the second');
  const got = await rows(idx);
  assert.deepEqual(got.map(r => r.id).sort(), [`claude_${a}`, `claude_${b}`]);
  assert.equal(got.find(r => r.entry_id === a).sender_ids, 'u,a');
  const r2 = await idx.syncFile(file);
  assert.deepEqual([r2.upserted, r2.skipped], [0, 2]);
  assert.equal(emb.calls, 1);
  // edit an audit field (session_id) by hand: hash covers content only, so no re-embed and the row is untouched
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('**session_id**: s1', '**session_id**: s2'));
  const r3 = await idx.syncFile(file);
  assert.deepEqual([r3.upserted, r3.skipped], [0, 2]);
  assert.equal(emb.calls, 1);
  assert.equal((await rows(idx)).every(r => r.session_id === 's1'), true);
  // edit content: only that entry is rebuilt
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('今天整理 TaIrTe4 的 Raman 数据', '今天整理 Raman 偏振数据'));
  const r4 = await idx.syncFile(file);
  assert.deepEqual([r4.upserted, r4.skipped], [1, 1]);
  assert.match((await rows(idx)).find(r => r.entry_id === b).episode_tokens, /偏振/);
  await idx.close();
});

test('removed entries and removed files are deleted from the index (md is the source of truth)', async () => {
  const root = new MemoryRoot(tmp()), idx = new MemoryIndex(root, { embedder: fakeEmbedder(), dim: 32 });
  appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('第一条'), ep('第二条')]);
  appendEntries(root, 'episode', 'claude', '2026-10-25', [ep('另一天')]);
  await idx.syncAll();
  assert.equal((await rows(idx)).length, 3);
  const f1 = root.dailyPath('episode', 'claude', '2026-10-24');
  fs.writeFileSync(f1, fs.readFileSync(f1, 'utf8').replace(/<!-- entry:ep_20261024_00000002 -->[\s\S]*?<!-- \/entry:ep_20261024_00000002 -->\n?/, ''));
  fs.rmSync(root.dailyPath('episode', 'claude', '2026-10-25'));
  const res = await idx.syncAll();
  assert.deepEqual((await rows(idx)).map(r => r.entry_id), ['ep_20261024_00000001']);
  assert.ok(res.some(r => r.deleted === 1 && r.md_path.endsWith('episode-2026-10-25.md')));
  await idx.close();
});

test('deprecated_entries in frontmatter project onto deprecated_by and clear again when removed', async () => {
  const root = new MemoryRoot(tmp()), idx = new MemoryIndex(root, { embedder: fakeEmbedder(), dim: 32 });
  const [a] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('旧叙述'), ep('另一条')]);
  const file = root.dailyPath('episode', 'claude', '2026-10-24');
  await idx.syncFile(file);
  patchFrontmatter(file, { deprecated_entries: { [a]: 'ep_20261025_00000001' } });
  const r = await idx.syncFile(file);
  assert.equal(r.deprecations, 1);
  assert.equal((await rows(idx, "deprecated_by IS NOT NULL")).map(x => x.entry_id)[0], a);
  // patchFrontmatter merges maps (as upstream does), so un-deprecating is a hand edit of the md
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/deprecated_entries:\n(?:  .*\n)+/, ''));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /deprecated_entries/);
  await idx.syncFile(file);
  assert.equal((await rows(idx, "deprecated_by IS NOT NULL")).length, 0);
  await idx.close();
});

test('keyword-only index (no embedder) works, and later gets vectors without a content change', async () => {
  const root = new MemoryRoot(tmp());
  appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('先只建关键词索引')]);
  const file = root.dailyPath('episode', 'claude', '2026-10-24');
  const kw = new MemoryIndex(root, { embedder: null, dim: 32 });
  assert.equal((await kw.syncFile(file)).upserted, 1);
  assert.equal((await rows(kw, 'vector IS NULL')).length, 1);
  await kw.close();
  const emb = fakeEmbedder(), full = new MemoryIndex(root, { embedder: emb, dim: 32 });
  const r = await full.syncFile(file);
  assert.equal(r.upserted, 1, 'rows without vectors are rebuilt once an embedder is available');
  assert.equal((await rows(full, 'vector IS NULL')).length, 0);
  await full.close();
});

test('index refuses a different embedding model or dimension instead of mixing vectors', async () => {
  const root = new MemoryRoot(tmp());
  appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('内容')]);
  const a = new MemoryIndex(root, { embedder: fakeEmbedder(), dim: 32 });
  await a.syncAll(); await a.close();
  await assert.rejects(new MemoryIndex(root, { embedder: fakeEmbedder(), dim: 16 }).open(), /维度/);
  const other = { ...fakeEmbedder(), model: 'other-model' };
  await assert.rejects(new MemoryIndex(root, { embedder: other, dim: 32 }).open(), /模型/);
});
