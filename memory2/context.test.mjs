import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries } from './md.mjs';
import { MemoryIndex } from './index.mjs';
import { buildContext, renderProfile, CONTEXT_DEFAULTS } from './context.mjs';
import { writeProfile } from './profile.mjs';
import { pinEntries } from './ledger.mjs';
import { tokenize } from './tokenizer.mjs';
import { memoryContextV2 } from './inject.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-ctx-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// Token-overlap embedder: related texts share tokens, so cosine is meaningful without a GPU.
const embedder = { model: 'fake', async embed(texts) {
  return texts.map(t => { const v = new Array(256).fill(0); for (const tok of tokenize(t)) { let h = 7; for (const c of tok) h = (h * 131 + c.codePointAt(0)) % 256; v[h] += 1; } return v; });
} };
const ts = '2026-10-24T10:00:00.000Z';
const ep = (subject, content) => ({ inline: { owner_id: 'claude', session_id: 's', timestamp: ts, parent_type: 'memcell', parent_id: 'mc' }, sections: { Subject: subject, Content: content } });
const fact = (text, parent) => ({ inline: { owner_id: 'claude', timestamp: ts, parent_type: 'episode', parent_id: parent }, sections: { Fact: text } });

async function fixture() {
  const root = new MemoryRoot(tmp());
  const [a, b] = appendEntries(root, 'episode', 'claude', '2026-10-24', [
    ep('DeepSeek 费用估算', 'Claude 估算 DeepSeek 处理一千篇文献的费用，约三美元，余额不足需要充值。'),
    ep('提示词精简', '精简 AGENTS.md 提示词，移动场景规则到文档。')]);
  appendEntries(root, 'atomic_fact', 'claude', '2026-10-24', [fact('DeepSeek 处理一千篇文献约三美元', a), fact('余额不足需要充值', a), fact('AGENTS.md 缩小到十二千字节', b)]);
  const index = new MemoryIndex(root, { embedder, dim: 256 });
  await index.syncAll();
  return { root, index, ids: { a, b } };
}

test('context: facts that match are shown under their episode; unrelated episodes stay out; ids are returned', async () => {
  const { root, index, ids } = await fixture();
  const ctx = await buildContext({ owner: 'claude', query: 'DeepSeek 处理一千篇文献费用多少', root, index, config: { minScore: 0.01, snippetMinScore: 0.01 } });
  assert.equal(ctx.mode, 'hybrid');
  assert.ok(ctx.ids.includes(ids.a));
  assert.match(ctx.text, /DeepSeek 费用估算/);
  assert.match(ctx.text, new RegExp(`\[${ids.a}\]`));
  assert.match(ctx.text, /- DeepSeek 处理一千篇文献约三美元/);
  assert.match(ctx.text, /仅 claude 自己的/);
  assert.ok(ctx.estimated_tokens > 0);
  await index.close();
});

test('context: below-threshold queries inject nothing; an episode with no matching fact needs the higher snippet threshold', async () => {
  const { root, index } = await fixture();
  const none = await buildContext({ owner: 'claude', query: '今天晚饭吃什么', root, index });
  assert.deepEqual(none.ids, []);
  assert.match(none.text, /没有检索到足够相关的记忆/);
  // snippet-only group: kept at snippetMinScore 0.01, dropped when it is raised above any realistic score
  const q = 'AGENTS 提示词 场景规则 文档';
  const loose = await buildContext({ owner: 'claude', query: q, root, index, config: { minScore: 0.0001, snippetMinScore: 0.0001 } });
  const strict = await buildContext({ owner: 'claude', query: q, root, index, config: { minScore: 0.0001, snippetMinScore: 0.99 } });
  assert.ok(loose.groups.length >= strict.groups.length);
  assert.ok(strict.groups.every(g => g.facts > 0), 'with a high snippet threshold only fact-backed groups remain');
  await index.close();
});

test('context: budget and group limits are respected and reported as omitted', async () => {
  const { root, index } = await fixture();
  const tiny = await buildContext({ owner: 'claude', query: 'DeepSeek 文献 费用 提示词 AGENTS', root, index, config: { minScore: 0.0001, snippetMinScore: 0.0001, tokens: 60, maxGroups: 1 } });
  assert.ok(tiny.groups.length <= 1);
  assert.ok(tiny.omitted >= 1);
  assert.equal(tiny.omitted_ids.length, tiny.omitted);
  for (const id of tiny.omitted_ids) assert.ok(tiny.text.includes(id), 'a whole record left out of the context remains addressable');
  assert.match(tiny.text, /memory2 show/);
  await index.close();
});

test('context: without an embedder only the profile is injected and the text says vectors are unavailable', async () => {
  const root = new MemoryRoot(tmp());
  appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('标题', '内容')]);
  writeProfile(root, 'claude', { owner_id: 'claude', summary: '量子材料方向的博士生', timestamp_ms: 1, explicit_info: [{ category: '身份', description: '做低温输运' }], implicit_traits: [{ trait: '务实' }] });
  const index = new MemoryIndex(root, { embedder: null, dim: 256 });
  await index.syncAll();
  const plain = await buildContext({ owner: 'claude', query: '随便问点什么', root, index });
  assert.doesNotMatch(plain.text, /推断的倾向|务实/, 'inferred traits are not injected by default');
  const ctx = await buildContext({ owner: 'claude', query: '随便问点什么', root, index, config: { implicitTraits: true } });
  assert.equal(ctx.mode, 'profile-only');
  assert.deepEqual(ctx.ids, []);
  assert.match(ctx.text, /用户画像：\n量子材料方向的博士生\n- 身份：做低温输运\n推断的倾向（推测，不是用户说过的）：务实/);
  assert.match(ctx.text, /向量检索暂时不可用/);
  await index.close();
});

test('context: a pinned episode shows up in every turn whatever the query is, marked 常驻 and not counted as a match', async () => {
  const { root, index, ids } = await fixture();
  pinEntries({ root, ids: [ids.b] });
  const ctx = await buildContext({ owner: 'claude', query: '今天晚饭吃什么', root, index });
  assert.match(ctx.text, /常驻记忆（本人钉住，不按话题检索，每轮都在）：/);
  assert.match(ctx.text, new RegExp(`《提示词精简》 \\[${ids.b}\\]（常驻）`));
  assert.ok(!ctx.ids.includes(ids.b), 'standing lines are not retrieval hits');
  assert.ok(!ctx.text.includes('相关度'), 'an unrelated query retrieves nothing, so no scored groups appear');
  await index.close();
});

test('context: when the standing budget runs out the block says how many pins are left out instead of dropping them silently', async () => {
  const { root, index, ids } = await fixture();
  pinEntries({ root, ids: [ids.a, ids.b] });
  const ctx = await buildContext({ owner: 'claude', query: '今天晚饭吃什么', root, index, config: { pinnedTokens: 20 } });
  assert.match(ctx.text, new RegExp(`\\[${ids.a}\\]（常驻）`));
  assert.doesNotMatch(ctx.text, new RegExp(`\\[${ids.b}\\]`));
  assert.match(ctx.text, /（另有 1 条常驻记忆，本轮未列出：memory2 ledger 可见）/);
  const roomy = await buildContext({ owner: 'claude', query: '今天晚饭吃什么', root, index });
  assert.match(roomy.text, new RegExp(`\\[${ids.b}\\]（常驻）`), 'the default budget fits a normal set of pins');
  assert.doesNotMatch(roomy.text, /另有 \d+ 条常驻/);
  await index.close();
});

test('renderProfile: limits items, marks inferred traits as guesses, empty profile renders nothing', () => {
  assert.equal(renderProfile(null), '');
  const p = { summary: '(no summary)', explicit_info: Array.from({ length: 12 }, (_, i) => ({ description: 'd' + i })), implicit_traits: [] };
  const lines = renderProfile(p, { items: 3 }).split('\n');
  assert.deepEqual(lines.slice(0, 3), ['- d0', '- d1', '- d2']);
  assert.match(lines[3], /explicit_info\[3\].*explicit_info\[11\].*memory2 show profile/);
  assert.equal(CONTEXT_DEFAULTS.snippetMinScore > CONTEXT_DEFAULTS.minScore, true);
});

test('renderProfile: keeps complete records, and a record that does not fit is referenced rather than rewritten', () => {
  const p = { summary: '(no summary)', explicit_info: [{ description: '第一句很重要。第二句也不短，会超出长度。' }], implicit_traits: [] };
  assert.equal(renderProfile(p, { itemChars: 12 }), '- ' + p.explicit_info[0].description);
  const long = { summary: '(no summary)', explicit_info: [{ description: '没有句号的超长内容'.repeat(5) }], implicit_traits: [] };
  assert.equal(renderProfile(long, { itemChars: 10 }), '- ' + long.explicit_info[0].description);
  const small = renderProfile(long, { budget: 10 });
  assert.doesNotMatch(small, /没有句号/);
  assert.match(small, /explicit_info\[0\].*memory2 show profile/);
  assert.doesNotMatch(small, /…/);
});

test('context: the whole query reaches retrieval and a selected episode keeps its tail and path', async () => {
  const root = new MemoryRoot(tmp()), queries = [];
  const wholeQuery = '背景说明 '.repeat(110) + 'Raman 完整尾部';
  const content = 'Raman 数据分析。'.repeat(30) + '最后决定使用 D:/Main/assistant/workspace/projects/example/final-data.csv。';
  const [id] = appendEntries(root, 'episode', 'claude', '2026-10-24', [ep('Raman 完整记录', content)]);
  const recordingEmbedder = { ...embedder, async embed(texts, options) { if (options?.query) queries.push(...texts); return embedder.embed(texts, options); } };
  const index = new MemoryIndex(root, { embedder: recordingEmbedder, dim: 256 });
  try {
    await index.syncAll();
    for (const retrieval of ['hierarchy', 'flat']) {
      const ctx = await buildContext({ owner: 'claude', query: wholeQuery, root, index, config: { retrieval, minScore: 0, snippetMinScore: 0, tokens: 5000, queryChars: 5, snippetChars: 5 } });
      assert.ok(ctx.ids.includes(id));
      assert.ok(ctx.text.includes(content), 'the chosen record is complete even when old character-cap settings are present');
      assert.match(ctx.text, /原文：/);
    }
    assert.ok(queries.every(q => q === wholeQuery), 'both retrieval paths receive the actual topic at the end of a long query');
    assert.ok(queries.length >= 2);
  } finally { await index.close(); }
});

test('disabled memory produces an empty block, without an old-store fallback', () => {
  assert.equal(memoryContextV2('codex', '任何问题').text, '');
});
