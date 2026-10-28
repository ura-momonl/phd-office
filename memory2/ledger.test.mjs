import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot, appendEntries, readMarkdown } from './md.mjs';
import { loadEpisodes } from './reflect.mjs';
import { POLICY, activation, weightOf, inheritHistory, parseInjected, assistantOutput, judgeUse, accountRuns, forgetOwner, restoreEntries, pinEntries, readLedger, writeLedger } from './ledger.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-ledger-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const DAY = 86400000, NOW = Date.parse('2027-06-01T00:00:00Z');
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString(), day = daysAgo => iso(daysAgo).slice(0, 10);
const ep = (subject, daysAgo, extra = {}) => ({ inline: { owner_id: 'claude', session_id: 's1', timestamp: iso(daysAgo), parent_type: 'memcell', parent_id: 'mc', ...extra }, sections: { Subject: subject, Content: subject + ' 的正文' } });
const fact = (text, parent, daysAgo) => ({ inline: { owner_id: 'claude', timestamp: iso(daysAgo), parent_type: 'episode', parent_id: parent }, sections: { Fact: text } });

test('activation: ACT-R base level — power-law forgetting, more use is stronger, a recent use counts more', () => {
  const at = d => NOW - d * DAY;
  assert.ok(Math.abs(activation(at(150), undefined, NOW) - Math.log(150 ** -0.5)) < 1e-9);
  assert.ok(Math.abs(activation(at(150), undefined, NOW) - -2.506) < 0.01, 'about the archive line for something never used');
  assert.ok(activation(at(30), undefined, NOW) > activation(at(150), undefined, NOW));
  assert.ok(activation(at(200), { uses: [at(10)] }, NOW) > activation(at(200), { uses: [at(150)] }, NOW), 'recent use > old use');
  assert.ok(activation(at(200), { uses: [at(20), at(15), at(5)] }, NOW) > activation(at(200), { uses: [at(20)] }, NOW), 'more use > less');
  const drop1 = activation(at(10), undefined, NOW) - activation(at(20), undefined, NOW), drop2 = activation(at(310), undefined, NOW) - activation(at(320), undefined, NOW);
  assert.ok(drop1 > 5 * drop2, 'the same 10 days cost far more early than late');
  assert.equal(activation(NOW, undefined, NOW), 0, 'brand new: one event at the 1-day floor');
});

test('weightOf: monotone in activation, bounded, neutral near 60 idle days', () => {
  const at = d => NOW - d * DAY;
  assert.ok(Math.abs(weightOf(at(60), undefined, NOW) - 1) < 0.01);
  assert.ok(weightOf(at(300), undefined, NOW) < weightOf(at(60), undefined, NOW));
  assert.ok(weightOf(at(300), { uses: [at(3)] }, NOW) > weightOf(at(300), undefined, NOW));
  for (const [ts, e] of [[at(9999), undefined], [NOW, { uses: Array(30).fill(NOW) }]]) { const w = weightOf(ts, e, NOW); assert.ok(w >= POLICY.weightFloor && w <= POLICY.weightCap); }
});

const group = (id, subject, lines) => `2026-10-24 《${subject}》 [${id}]（相关度 0.53）\n` + lines.map(l => `  - ${l}`).join('\n');
const PROMPT = `前文\n用户画像：喜欢简洁\n本轮相关记忆：\n${group('ep_20261024_00000006', '萤火虫观测方案', ['铷原子钟校准', '夜间采样间隔十分钟'])}\n${group('ep_20261023_00000009', '另一件事', ['无关内容'])}\n对话记录：用户说请继续`;

test('parseInjected reads every group with its id, subject and body', () => {
  const g = parseInjected(PROMPT);
  assert.deepEqual(g.map(x => x.id), ['ep_20261024_00000006', 'ep_20261023_00000009']);
  assert.ok(g[0].text.includes('铷原子钟校准') && g[0].text.includes('萤火虫观测方案'));
});

test('assistantOutput keeps text and tool inputs, drops thinking', () => {
  const events = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '秘密想法' }, { type: 'text', text: '回答正文' }, { type: 'tool_use', input: { command: 'ls /tmp', nested: ['深层参数'] } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '用户的话' }] } }),
  ].join('\n');
  const out = assistantOutput(events);
  assert.ok(out.includes('回答正文') && out.includes('ls /tmp') && out.includes('深层参数'));
  assert.ok(!out.includes('秘密想法') && !out.includes('用户的话'));
});

test('judgeUse: id mention counts; words only in the memory count; words that are also in the rest of the prompt do not', () => {
  const [g1, g2] = parseInjected(PROMPT);
  assert.equal(judgeUse(g1, PROMPT, '看过 ep_20261024_00000006 了').used, true);
  assert.equal(judgeUse(g1, PROMPT, '按铷原子钟校准的结果，夜间采样间隔十分钟一次，观测方案保持不变').used, true);
  assert.equal(judgeUse(g1, PROMPT, '好的，我继续做').used, false);
  assert.equal(judgeUse(g2, PROMPT, '好的，我继续做').used, false);
  // the user's own words are not evidence of memory use
  const echoed = PROMPT.replace('请继续', '请继续铷原子钟校准夜间采样间隔十分钟');
  assert.equal(judgeUse(parseInjected(echoed)[0], echoed, '铷原子钟校准，夜间采样间隔十分钟').used, false);
});

function fakeRun(runsDir, name, { owner = 'claude', recalled, prompt, answer, ageMin = 60 }) {
  const dir = path.join(runsDir, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory-context.json'), JSON.stringify({ owner, recalled_ids: recalled }));
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }) + '\n');
  const t = new Date(NOW - ageMin * 60000); for (const f of ['memory-context.json', 'prompt.txt', 'events.jsonl']) fs.utimesSync(path.join(dir, f), t, t);
}

test('accountRuns: counts recalled/used, ignores other owners and unsettled turns, and does not double count on the next scan', () => {
  const root = new MemoryRoot(tmp()), runsDir = tmp();
  fakeRun(runsDir, 'r1', { recalled: ['ep_20261024_00000006', 'ep_20261023_00000009'], prompt: PROMPT, answer: '按铷原子钟校准，夜间采样间隔十分钟继续' });
  fakeRun(runsDir, 'r2', { owner: 'codex', recalled: ['ep_20261024_00000006'], prompt: PROMPT, answer: '铷原子钟校准 夜间采样间隔十分钟' });
  fakeRun(runsDir, 'r3', { recalled: ['ep_20261024_00000006'], prompt: PROMPT, answer: '铷原子钟校准 夜间采样间隔十分钟', ageMin: 2 }); // still running
  const a = accountRuns({ root, owner: 'claude', runsDir, now: NOW });
  assert.deepEqual([a.turns, a.injected, a.used], [1, 2, 1]);
  assert.equal(readLedger(root).entries.ep_20261024_00000006.uses.length, 1, 'the use time is recorded');
  const l = readLedger(root);
  assert.deepEqual([l.entries.ep_20261024_00000006.recalled, l.entries.ep_20261024_00000006.used, l.entries.ep_20261023_00000009.used], [1, 1, 0]);
  const again = accountRuns({ root, owner: 'claude', runsDir, now: NOW });
  assert.equal(again.turns, 0);
  assert.equal(readLedger(root).entries.ep_20261024_00000006.recalled, 1);
});

function store() {
  const root = new MemoryRoot(tmp());
  const [old] = appendEntries(root, 'episode', 'claude', day(200), [ep('旧而无用', 200)]);
  const [oldUsed] = appendEntries(root, 'episode', 'claude', day(200), [ep('旧但用过', 200)]);
  const [legacy] = appendEntries(root, 'episode', 'claude', day(300), [ep('旧库迁入', 300, { parent_type: 'legacy' })]);
  const [pinned] = appendEntries(root, 'episode', 'claude', day(300), [ep('被钉住', 300)]);
  const [fresh] = appendEntries(root, 'episode', 'claude', day(10), [ep('新近', 10)]);
  const [f1, f2] = appendEntries(root, 'atomic_fact', 'claude', day(200), [fact('旧事实一', old, 200), fact('旧事实二', old, 200)]);
  const [f3] = appendEntries(root, 'atomic_fact', 'claude', day(10), [fact('新事实', fresh, 10)]);
  writeLedger(root, { watermark_ms: 0, entries: { [oldUsed]: { recalled: 3, used: 2, last_used_ms: NOW - 20 * DAY, uses: [NOW - 40 * DAY, NOW - 20 * DAY] } }, pinned: [pinned] });
  return { root, old, oldUsed, legacy, pinned, fresh, f1, f2, f3 };
}
const depOf = (root, kind, id) => { let v = null; const dir = path.dirname(root.dailyPath(kind, 'claude', '2000-01-01')); for (const f of fs.readdirSync(dir)) { const d = readMarkdown(path.join(dir, f)).frontmatter.deprecated_entries; if (d?.[id]) v = d[id]; } return v; };

test('forgetOwner: dry run reports only; real run archives idle episodes with their facts, spares used/legacy/pinned/recent', () => {
  const s = store();
  const dry = forgetOwner({ root: s.root, owner: 'claude', now: NOW, dryRun: true });
  assert.equal(dry.archived_episodes, 1); assert.equal(dry.archived_facts, 2);
  assert.equal(depOf(s.root, 'episode', s.old), null, 'a dry run changes nothing');
  const real = forgetOwner({ root: s.root, owner: 'claude', now: NOW });
  assert.equal(real.archived_episodes, 1);
  assert.match(depOf(s.root, 'episode', s.old), /^archived@2027-06-01$/);
  assert.match(depOf(s.root, 'atomic_fact', s.f1), /^archived@/); assert.match(depOf(s.root, 'atomic_fact', s.f2), /^archived@/);
  for (const id of [s.oldUsed, s.legacy, s.pinned, s.fresh]) assert.equal(depOf(s.root, 'episode', id), null, id);
  assert.equal(depOf(s.root, 'atomic_fact', s.f3), null);
  assert.equal(forgetOwner({ root: s.root, owner: 'claude', now: NOW }).archived_episodes, 0, 'already archived: not archived again');
});

test('use keeps an old episode alive: a recent use, repeated use or even one old use beats none', () => {
  const root = new MemoryRoot(tmp());
  const [a, b, c] = appendEntries(root, 'episode', 'claude', day(400), [ep('近期用三次', 400), ep('从没用过', 400), ep('很久前用过一次', 400)]);
  writeLedger(root, { watermark_ms: 0, pinned: [], entries: { [a]: { used: 3, uses: [NOW - 25 * DAY, NOW - 12 * DAY, NOW - 2 * DAY] }, [c]: { used: 1, uses: [NOW - 300 * DAY] } } });
  const r = forgetOwner({ root, owner: 'claude', now: NOW, dryRun: true });
  assert.deepEqual(r.sample.map(x => x.id), [b]);
});

test('details fade before the gist: facts are archived while the episode stays, and come back when the episode is used again', () => {
  const root = new MemoryRoot(tmp());
  const [e] = appendEntries(root, 'episode', 'claude', day(100), [ep('百天前', 100)]);
  const [f1, f2] = appendEntries(root, 'atomic_fact', 'claude', day(100), [fact('细节一', e, 100), fact('细节二', e, 100)]);
  const dry = forgetOwner({ root, owner: 'claude', now: NOW, dryRun: true });
  assert.deepEqual([dry.archived_episodes, dry.facts_only_episodes, dry.archived_facts], [0, 1, 2]);
  assert.equal(depOf(root, 'atomic_fact', f1), null);
  forgetOwner({ root, owner: 'claude', now: NOW });
  assert.match(depOf(root, 'atomic_fact', f1), /^archived@/); assert.match(depOf(root, 'atomic_fact', f2), /^archived@/);
  assert.equal(depOf(root, 'episode', e), null, 'the episode itself stays');
  assert.equal(forgetOwner({ root, owner: 'claude', now: NOW, dryRun: true }).facts_only_episodes, 0, 'nothing left to archive');
  writeLedger(root, { watermark_ms: 0, pinned: [], entries: { [e]: { used: 1, uses: [NOW - 2 * DAY] } } });
  const back = forgetOwner({ root, owner: 'claude', now: NOW });
  assert.equal(back.restored_facts, 2);
  assert.equal(depOf(root, 'atomic_fact', f1), null); assert.equal(depOf(root, 'atomic_fact', f2), null);
});

test('inheritHistory: a merged episode pools the uses and encodings of its sources, adds the merge itself, and sums the counts', () => {
  const root = new MemoryRoot(tmp());
  writeLedger(root, { watermark_ms: 0, pinned: [], entries: { s1: { recalled: 4, used: 2, last_used_ms: NOW - 5 * DAY, uses: [NOW - 30 * DAY, NOW - 5 * DAY] }, s2: { recalled: 1, used: 0 } } });
  const e = inheritHistory({ root, mergedId: 'ep_m', sources: [{ id: 's1', timestamp_ms: NOW - 90 * DAY }, { id: 's2', timestamp_ms: NOW - 60 * DAY }], now: NOW });
  assert.deepEqual([e.recalled, e.used, e.last_used_ms], [5, 2, NOW - 5 * DAY]);
  assert.deepEqual(e.uses, [NOW - 90 * DAY, NOW - 60 * DAY, NOW - 30 * DAY, NOW - 5 * DAY, NOW]);
  assert.deepEqual(e.merged_from, ['s1', 's2']);
  assert.ok(activation(NOW - 60 * DAY, e, NOW) > activation(NOW - 60 * DAY, undefined, NOW) + 1, 'much stronger than a fresh merged episode');
  assert.deepEqual(readLedger(root).entries.ep_m.merged_from, ['s1', 's2']);
  // capped at the most recent maxEvents
  writeLedger(root, { watermark_ms: 0, pinned: [], entries: { big: { uses: Array.from({ length: 40 }, (_, i) => NOW - (40 - i) * DAY) } } });
  assert.equal(inheritHistory({ root, mergedId: 'm2', sources: [{ id: 'big', timestamp_ms: NOW - 100 * DAY }], now: NOW }).uses.length, POLICY.maxEvents);
});

test('restoreEntries brings an archived episode and its facts back; entries merged by reflection stay deprecated', () => {
  const s = store();
  forgetOwner({ root: s.root, owner: 'claude', now: NOW });
  const merged = readMarkdown(s.root.dailyPath('episode', 'claude', day(200))).frontmatter.deprecated_entries;
  assert.ok(merged[s.old]);
  const r = restoreEntries({ root: s.root, owner: 'claude', ids: [s.old] });
  assert.equal(r.restored, 3);
  assert.equal(depOf(s.root, 'episode', s.old), null); assert.equal(depOf(s.root, 'atomic_fact', s.f1), null);
  assert.equal([...loadEpisodes(s.root, 'claude').values()].filter(e => !e.deprecated_by).length, 5);
});

test('pinEntries protects from archiving; off removes the pin', () => {
  const s = store();
  assert.equal(forgetOwner({ root: s.root, owner: 'claude', now: NOW, dryRun: true }).archived_episodes, 1);
  pinEntries({ root: s.root, ids: [s.old] });
  assert.equal(forgetOwner({ root: s.root, owner: 'claude', now: NOW, dryRun: true }).archived_episodes, 0);
  pinEntries({ root: s.root, ids: [s.old], off: true });
  assert.equal(forgetOwner({ root: s.root, owner: 'claude', now: NOW, dryRun: true }).archived_episodes, 1);
});

test('purge: an archive older than a year is deleted from the md (other entries and ids untouched); a younger archive is kept', () => {
  const s = store();
  forgetOwner({ root: s.root, owner: 'claude', now: NOW });
  assert.equal(forgetOwner({ root: s.root, owner: 'claude', now: NOW + 300 * DAY }).purged, 0);
  const later = forgetOwner({ root: s.root, owner: 'claude', now: NOW + 366 * DAY, dryRun: true });
  assert.equal(later.purged, 3, 'dry run counts but keeps them');
  assert.equal([...loadEpisodes(s.root, 'claude').keys()].includes(s.old), true);
  const real = forgetOwner({ root: s.root, owner: 'claude', now: NOW + 366 * DAY });
  assert.equal(real.purged, 3);
  const left = loadEpisodes(s.root, 'claude');
  assert.equal(left.has(s.old), false); assert.equal(left.has(s.oldUsed), true, 'the entry sharing the old entry\'s file survives');
  const file = readMarkdown(s.root.dailyPath('episode', 'claude', day(200)));
  assert.equal(s.old in (file.frontmatter.deprecated_entries || {}), false);
  const [newId] = appendEntries(s.root, 'episode', 'claude', day(200), [ep('后来写入', 200)]);
  assert.notEqual(newId, s.old, 'a deleted id is never reused');
  assert.equal(fs.existsSync(s.root.dailyPath('atomic_fact', 'claude', day(200))), false, 'a file with no entries left is removed');
});
