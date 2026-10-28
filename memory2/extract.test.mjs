import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, readMarkdown, parseStructuredEntry } from './md.mjs';
import { renderPrompt, formatPromptTime, formatAtomicFactTime, estimateTokens, buildMemCells, extractJsonObject, extractEpisode, extractAtomicFacts,
  ingestOwner, backfillFacts, processedCells, splitAt, splitBySize, PROMPTS, localDate, tuning } from './extract.mjs';
tuning.retryDelayMs = 0;

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-ext-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const at = (h, m = 0, day = 24) => `2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const msg = (role, text, when, provider) => ({ role, text, at: when, task_id: 't', ...(provider ? { provider } : {}) });
const session = (id, messages, extra = {}) => ({ id, origin: 'chat', messages, ...extra });

// A scripted LLM: answers by prompt kind, records prompts, can be told to fail on a marker.
function scriptedLlm({ failEpisodeFor = null } = {}) {
  const f = async (prompt, { purpose }) => {
    f.prompts.push({ purpose, prompt });
    if (purpose === 'memory2-episode') {
      if (failEpisodeFor && prompt.includes(failEpisodeFor)) return '抱歉，我无法处理';
      return '好的，这是结果：\n```json\n{"title": "测试情节标题", "content": "Claude 和用户讨论了记忆系统（2026-10-24 01:00 UTC）。"}\n```';
    }
    return '{"atomic_facts": {"time": "October 24, 2026(Saturday) at 01:00 AM", "atomic_fact": ["用户想重构记忆系统", " ", "Claude 参与了讨论"]}}';
  };
  f.prompts = [];
  return f;
}

test('renderPrompt follows str.format: {{ }} become braces, known keys replaced, unknown {keys} left alone', () => {
  assert.equal(renderPrompt('JSON {{"a": "{x}"}} {missing}', { x: '值' }), 'JSON {"a": "值"} {missing}');
});

test('time formats match everalgo (24h UTC with weekday for episodes; 12h English for atomic facts)', () => {
  const ms = Date.parse('2024-03-14T15:00:00Z');
  assert.equal(formatPromptTime(ms), '2024-03-14 15:00 UTC (Thursday)');
  assert.equal(formatAtomicFactTime(ms), 'March 14, 2024(Thursday) at 03:00 PM');
  assert.equal(formatAtomicFactTime(Date.parse('2024-03-10T00:05:00Z')), 'March 10, 2024(Sunday) at 12:05 AM');
});

test('buildMemCells cuts on a long gap and on hard limits, and keeps only cells the owner took part in', () => {
  const s = session('s1', [
    msg('user', '你好', at(1)), msg('assistant', '你好', at(1, 5), 'claude'),
    msg('user', '隔了很久', at(9)), msg('assistant', 'Codex 回答', at(9, 5), 'codex'), // owner claude absent here
    msg('user', '再隔很久', at(20)), msg('assistant', '收到', at(20, 1), 'claude'),
  ]);
  const cells = buildMemCells(s, 'claude');
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map(c => c.items.length), [2, 2]);
  assert.equal(buildMemCells(s, 'codex').length, 1);
  assert.equal(buildMemCells(s, 'claude', { gapHours: 100 }).length, 1);
  const many = session('s2', Array.from({ length: 120 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`, at(1, i % 60), i % 2 ? 'claude' : undefined)));
  assert.ok(buildMemCells(many, 'claude').every(c => c.items.length < 50), 'hard message limit');
  assert.deepEqual(buildMemCells(s, 'claude').map(c => c.id), cells.map(c => c.id), 'cell ids are stable');
  assert.equal(buildMemCells(s, 'claude', { sinceMs: Date.parse(at(10)) }).length, 1, 'sinceMs');
  assert.ok(estimateTokens('中文四个字') >= 5 && estimateTokens('abcdefgh') === 2);
});

test('extractJsonObject takes the first balanced object even with braces inside strings', () => {
  assert.equal(extractJsonObject('前言 {"a": "}{", "b": {"c": 1}} 后记'), '{"a": "}{", "b": {"c": 1}}');
  assert.throws(() => extractJsonObject('no json'), /No JSON/);
  assert.throws(() => extractJsonObject('{"a": 1'), /Unbalanced/);
});

test('episode prompt is the upstream zh user-centred prompt, centred on the owner, with the conversation rendered', async () => {
  const llm = scriptedLlm();
  const [cell] = buildMemCells(session('s1', [msg('user', '我想重构记忆', at(1)), msg('assistant', '好', at(1, 2), 'claude')]), 'claude');
  const ep = await extractEpisode(llm, cell, 'claude');
  const p = llm.prompts[0].prompt;
  assert.match(p, /关键语言规则/);
  assert.match(p, /"speaker": 用户/);
  assert.match(p, /"content": 我想重构记忆/);
  assert.match(p, /2026-10-24 01:00 UTC \(Saturday\)/);
  assert.match(p, /Claude/);
  assert.doesNotMatch(p, /\{user_name\}|\{conversation\}|\{custom_instructions\}/, 'all placeholders filled');
  assert.deepEqual([ep.subject, ep.content.startsWith('Claude 和用户')], ['测试情节标题', true]);
  assert.equal(ep.summary, null, 'no truncated fallback summary');
  assert.ok(PROMPTS.reflect.REFLECT_EPISODE_PROMPT.includes('{timeline}'));
});

test('atomic facts: filters blanks, accepts event_log or atomic_facts key, fills TIME and EPISODE_TEXT', async () => {
  const llm = scriptedLlm();
  const facts = await extractAtomicFacts(llm, '一段情节叙述', Date.parse(at(1)));
  assert.deepEqual(facts, ['用户想重构记忆系统', 'Claude 参与了讨论']);
  assert.match(llm.prompts[0].prompt, /一段情节叙述/);
  assert.match(llm.prompts[0].prompt, /October 24, 2026\(Saturday\) at 01:00 AM/);
  assert.doesNotMatch(llm.prompts[0].prompt, /\{\{EPISODE_TEXT\}\}|\{\{TIME\}\}/);
  await assert.rejects(extractAtomicFacts(async () => '{"other": 1}', 'x', 0), /missing/);
});

test('ingestOwner writes episodes then facts, is idempotent, and a bad cell fails alone without a half-written episode', async () => {
  const root = new MemoryRoot(tmp());
  const sessions = [
    session('s-ok', [msg('user', '正常内容', at(1)), msg('assistant', '好', at(1, 2), 'claude')]),
    session('s-bad', [msg('user', '会失败的内容BAD', at(2)), msg('assistant', '好', at(2, 2), 'claude')]),
    session('s-task', [msg('user', 'x', at(3)), msg('assistant', 'y', at(3, 1), 'claude')], { origin: 'task' }),
  ];
  const llm = scriptedLlm({ failEpisodeFor: 'BAD' });
  // s-ok and s-bad are within 6 h of each other in one session list but are different sessions -> separate cells
  const r1 = await ingestOwner({ owner: 'claude', root, sessions, llm });
  assert.deepEqual([r1.cells_seen, r1.episodes, r1.facts, r1.failures.length], [2, 1, 2, 1]);
  assert.equal(r1.failures[0].session_id, 's-bad');
  const day = localDate(Date.parse(at(1)));
  const epFile = readMarkdown(root.dailyPath('episode', 'claude', day));
  assert.equal(epFile.entries.length, 1);
  const e = parseStructuredEntry(epFile.entries[0].body);
  assert.equal(e.inline.parent_type, 'memcell');
  assert.equal(e.inline.session_id, 's-ok');
  assert.equal(e.sections.Subject, '测试情节标题');
  const facts = readMarkdown(root.dailyPath('atomic_fact', 'claude', day));
  assert.equal(facts.entries.length, 2);
  assert.equal(parseStructuredEntry(facts.entries[0].body).inline.parent_id, epFile.entries[0].id);
  assert.equal(processedCells(root, 'claude').size, 1);
  const callsBefore = llm.prompts.length;
  const r2 = await ingestOwner({ owner: 'claude', root, sessions: sessions.slice(0, 1), llm });
  assert.deepEqual([r2.skipped, r2.episodes, llm.prompts.length], [1, 0, callsBefore], 'no repeat LLM calls for processed cells');
});

test('backfillFacts retries only episodes that have no facts yet', async () => {
  const root = new MemoryRoot(tmp());
  const sessions = [session('s1', [msg('user', '内容', at(1)), msg('assistant', '好', at(1, 2), 'claude')])];
  let failFacts = true;
  const llm = async (p, o) => failFacts && o.purpose === 'memory2-atomic-facts' ? 'oops' : scriptedLlm()(p, o);
  const r1 = await ingestOwner({ owner: 'claude', root, sessions, llm });
  assert.deepEqual([r1.episodes, r1.facts, r1.failures.length], [1, 0, 1]);
  failFacts = false;
  const r2 = await backfillFacts({ owner: 'claude', root, llm });
  assert.deepEqual([r2.episodes_without_facts, r2.facts, r2.failures.length], [1, 2, 0]);
  assert.equal((await backfillFacts({ owner: 'claude', root, llm })).episodes_without_facts, 0);
});

test('a transient LLM call failure is retried once; two failures in a row are reported', async () => {
  const flaky = (failures) => { let n = 0; const f = async (p, o) => { f.calls = ++n; if (n <= failures) throw new Error('Codex 会话退出 (1)'); return scriptedLlm()(p, o); }; return f; };
  const [cell] = buildMemCells(session('s1', [msg('user', '内容', at(1)), msg('assistant', '好', at(1, 2), 'claude')]), 'claude');
  const once = flaky(1);
  assert.equal((await extractEpisode(once, cell, 'claude')).subject, '测试情节标题');
  assert.equal(once.calls, 2);
  await assert.rejects(extractEpisode(flaky(2), cell, 'claude'), /Codex 会话退出/);
});

test('process-start denial stops the batch once, preserves completed cells, and a later authorized run resumes them', async () => {
  for (const error of [Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }), Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), new Error('spawn EPERM')]) {
    const root = new MemoryRoot(tmp()), good = scriptedLlm();
    const sessions = [1, 2, 3].map(i => session(`s${i}`, [msg('user', `内容${i}`, at(i)), msg('assistant', '好', at(i, 2), 'claude')]));
    let calls = 0;
    const llm = async (p, o) => { calls++; if (p.includes('内容2')) throw error; return good(p, o); };
    const r = await ingestOwner({ owner: 'claude', root, sessions, llm });
    assert.deepEqual([calls, r.episodes, r.facts, r.failures.length, r.aborted], [3, 1, 2, 1, 'process-start-denied']);
    assert.equal(r.failures[0].session_id, 's2');
    assert.equal(processedCells(root, 'claude').size, 1);
    const resumed = await ingestOwner({ owner: 'claude', root, sessions, llm: good });
    assert.deepEqual([resumed.skipped, resumed.episodes, resumed.failures.length], [1, 2, 0]);
    assert.equal(processedCells(root, 'claude').size, 3);
  }
});

test('fact-extraction process denial keeps its episode and stops fact backfill without retrying all other episodes', async () => {
  const root = new MemoryRoot(tmp()), good = scriptedLlm();
  const sessions = [1, 2].map(i => session(`s${i}`, [msg('user', `内容${i}`, at(i)), msg('assistant', '好', at(i, 2), 'claude')]));
  const denied = () => Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  let factCalls = 0;
  const r = await ingestOwner({ owner: 'claude', root, sessions, llm: (p, o) => {
    if (o.purpose === 'memory2-atomic-facts') { factCalls++; throw denied(); } return good(p, o);
  } });
  assert.deepEqual([r.episodes, r.facts, r.aborted, factCalls], [1, 0, 'process-start-denied', 1]);
  // Create a second episode, also without facts, so blindly continuing would be observable.
  await ingestOwner({ owner: 'claude', root, sessions: sessions.slice(1), llm: good, withFacts: false });
  let calls = 0;
  const backfill = await backfillFacts({ owner: 'claude', root, llm: () => { calls++; throw denied(); } });
  assert.deepEqual([calls, backfill.episodes_without_facts, backfill.aborted], [1, 1, 'process-start-denied']);
  const resumed = await backfillFacts({ owner: 'claude', root, llm: good });
  assert.deepEqual([resumed.episodes_without_facts, resumed.facts], [2, 4]);
});

test('boundary process-start denial does not advance to extraction or later cells', async () => {
  const root = new MemoryRoot(tmp());
  const s = session('big', Array.from({ length: 44 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `消息${i}`, at(1, i), i % 2 ? 'claude' : undefined)));
  let calls = 0;
  const r = await ingestOwner({ owner: 'claude', root, sessions: [s], boundary: true, llm: () => { calls++; throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); } });
  assert.deepEqual([calls, r.episodes, r.aborted], [1, 0, 'process-start-denied']);
});

test('the still-open last cell of a session is deferred until the gap has passed (its id would change as it grows)', async () => {
  const root = new MemoryRoot(tmp());
  const s = session('live', [msg('user', '早上的事', at(1)), msg('assistant', '好', at(1, 2), 'claude'), msg('user', '刚刚的事', at(20)), msg('assistant', '好', at(20, 1), 'claude')]);
  const llm = scriptedLlm();
  const nowSoon = Date.parse(at(21)); // 1 h after the last message: the second cell is still open
  const r1 = await ingestOwner({ owner: 'claude', root, sessions: [s], llm, now: nowSoon });
  assert.deepEqual([r1.cells_seen, r1.deferred_open, r1.episodes], [1, 1, 1]);
  const grown = session('live', [...s.messages, msg('user', '又说了一句', at(21, 30)), msg('assistant', '嗯', at(21, 31), 'claude')]);
  const r2 = await ingestOwner({ owner: 'claude', root, sessions: [grown], llm, now: Date.parse(at(22)) });
  assert.deepEqual([r2.skipped, r2.deferred_open, r2.episodes], [1, 1, 0], 'the grown open cell is still deferred, nothing duplicated');
  const r3 = await ingestOwner({ owner: 'claude', root, sessions: [grown], llm, now: Date.parse(at(21, 31)) + 7 * 3600000 });
  assert.deepEqual([r3.deferred_open, r3.episodes], [0, 1], 'once closed it is extracted exactly once');
  assert.equal(processedCells(root, 'claude').size, 2);
});

test('a big cell is split at the model\'s topic cuts (1-based, upstream semantics), the cut points are cached, and a cell already extracted whole is left alone', async () => {
  const mk = (id, n) => session(id, Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `话题消息${i}`, at(1, i), i % 2 ? 'claude' : undefined)));
  const root = new MemoryRoot(tmp()), base = scriptedLlm();
  let boundaryCalls = 0, cuts = [20, 20, 999, null, 0];
  const llm = async (p, o) => { if (o.purpose !== 'memory2-boundary') return base(p, o); boundaryCalls++; assert.ok(p.includes('[1] [2026-10-24T01:00:00Z] 用户: 话题消息0') && p.includes('[44]')); return JSON.stringify({ reasoning: 'x', boundaries: cuts, should_wait: false }); };
  const s = mk('big', 44), now = Date.parse(at(1, 44)) + 7 * 3600000;
  const [whole] = buildMemCells(s, 'claude');
  assert.equal(whole.items.length, 44);
  const r1 = await ingestOwner({ owner: 'claude', root, sessions: [s], llm, now, boundary: true, maxMessages: 0 });
  assert.deepEqual([r1.boundary_calls, r1.boundary_splits, r1.episodes, r1.failures.length], [1, 1, 2, 0], 'out-of-range, duplicate and null cuts are dropped; 2 sub-cells');
  assert.deepEqual([...processedCells(root, 'claude')].sort(), splitAtIds(whole, [20]).sort());
  const r2 = await ingestOwner({ owner: 'claude', root, sessions: [s], llm, now, boundary: true, maxMessages: 0 });
  assert.deepEqual([boundaryCalls, r2.episodes, r2.skipped], [1, 0, 2], 'rerun: cached cuts, nothing duplicated');
  // a cell that was extracted whole earlier is not split afterwards
  const legacy = new MemoryRoot(tmp());
  await ingestOwner({ owner: 'claude', root: legacy, sessions: [s], llm, now, boundary: false, maxMessages: 0 });
  const r3 = await ingestOwner({ owner: 'claude', root: legacy, sessions: [s], llm, now, boundary: true, maxMessages: 0 });
  assert.deepEqual([r3.boundary_calls, r3.episodes, r3.skipped], [0, 0, 1]);
  // small cells never call the boundary step; a failing boundary call fails only that cell
  const r4 = await ingestOwner({ owner: 'claude', root: new MemoryRoot(tmp()), sessions: [mk('small', 10)], llm, now, boundary: true, maxMessages: 0 });
  assert.deepEqual([r4.boundary_calls, r4.episodes], [0, 1]);
  const bad = async (p, o) => o.purpose === 'memory2-boundary' ? '不是JSON' : base(p, o);
  const r5 = await ingestOwner({ owner: 'claude', root: new MemoryRoot(tmp()), sessions: [s], llm: bad, now, boundary: true });
  assert.deepEqual([r5.episodes, r5.failures.length], [0, 1]);
  assert.match(r5.failures[0].error, /^boundary:/);
});
const splitAtIds = (cell, cuts) => splitAt(cell, cuts, 'claude').map(c => c.id);

test('a not-yet-extracted cell longer than maxMessages is cut into even pieces; a cell extracted whole earlier is left alone', async () => {
  const mk = n => session('long', Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `消息${i}`, at(1, i), i % 2 ? 'claude' : undefined)));
  const s = mk(44), now = Date.parse(at(1, 44)) + 7 * 3600000, [whole] = buildMemCells(s, 'claude');
  assert.deepEqual(splitBySize(whole, 'claude', 15).map(c => c.items.length), [15, 14, 15]);
  assert.equal(splitBySize(whole, 'claude', 0).length, 1);
  const root = new MemoryRoot(tmp()), llm = scriptedLlm();
  const r1 = await ingestOwner({ owner: 'claude', root, sessions: [s], llm, now });
  assert.deepEqual([r1.episodes, r1.failures.length], [3, 0]);
  const r2 = await ingestOwner({ owner: 'claude', root, sessions: [s], llm, now });
  assert.deepEqual([r2.episodes, r2.skipped], [0, 3], 'rerun writes nothing twice');
  const legacy = new MemoryRoot(tmp());
  await ingestOwner({ owner: 'claude', root: legacy, sessions: [s], llm, now, maxMessages: 0 });
  assert.equal(processedCells(legacy, 'claude').size, 1);
  const r3 = await ingestOwner({ owner: 'claude', root: legacy, sessions: [s], llm, now });
  assert.deepEqual([r3.episodes, r3.skipped], [0, 1], 'a cell already extracted whole is not re-cut');
});
