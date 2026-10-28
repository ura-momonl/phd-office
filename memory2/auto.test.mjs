import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { memory2Tick, autoConfig, metered } from './auto.mjs';
import { root } from '../automation/files.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw Error('Use node scripts/run-tests.mjs --memory2');
const wipe = () => { for (const f of ['auto.json', 'usage.jsonl']) fs.rmSync(`${root}/.runtime/memory2/${f}`, { force: true }); };
const cfg = { enabled: true, idle_minutes: 30, ingest_hours: 24, consolidate_hours: 168, owners: ['claude'] };
const mk = (over = {}) => {
  const log = [];
  const llm = () => async () => { log.push('llm'); return 'ok'; };
  const step = name => async (owner, fn) => { await fn('p'.repeat(10)); log.push(name); return { n: [1, 2] }; };
  return { log, deps: { busy: () => false, lastChatMs: () => 0, llm, steps: { ingest: step('ingest'), account: step('account'), reflect: step('reflect'), profile: step('profile'), forget: step('forget') }, ...over } };
};
const H = 3600000, T = Date.parse('2026-10-25T03:00:00Z');

test('autoConfig: needs memory_v2.enabled, auto.enabled and an owners list', () => {
  assert.equal(autoConfig({}), null);
  assert.equal(autoConfig({ memory_v2: { enabled: true, owners: ['claude'] } }), null);
  assert.equal(autoConfig({ memory_v2: { enabled: true, auto: { enabled: true } } }), null);
  assert.deepEqual(autoConfig({ memory_v2: { enabled: true, owners: ['claude'], auto: { enabled: true } } }).owners, ['claude']);
});

test('first tick runs ingest+account, then reflect, profile and forget; the next hours later runs nothing; a day later only ingest; a week later everything', async () => {
  wipe();
  const a = mk();
  assert.equal((await memory2Tick({ now: T, deps: a.deps, config: cfg })).state, 'ran');
  assert.deepEqual(a.log.filter(x => x !== 'llm'), ['ingest', 'account', 'reflect', 'profile', 'forget']);
  const lines = fs.readFileSync(`${root}/.runtime/memory2/usage.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => [l.step, l.calls, l.prompt_chars, l.output_chars]), [['ingest', 1, 10, 2], ['account', 1, 10, 2], ['reflect', 1, 10, 2], ['profile', 1, 10, 2], ['forget', 1, 10, 2]]);
  assert.equal((await memory2Tick({ now: T + 3 * H, deps: mk().deps, config: cfg })).state, 'nothing-due');
  const b = mk();
  await memory2Tick({ now: T + 25 * H, deps: b.deps, config: cfg });
  assert.deepEqual(b.log.filter(x => x !== 'llm'), ['ingest', 'account']);
  const c = mk();
  await memory2Tick({ now: T + 8 * 24 * H, deps: c.deps, config: cfg });
  assert.deepEqual(c.log.filter(x => x !== 'llm'), ['ingest', 'account', 'reflect', 'profile', 'forget']);
  wipe();
});

test('not idle or busy: no model call, nothing stamped', async () => {
  wipe();
  const a = mk({ lastChatMs: () => T - 10 * 60000 });
  assert.equal((await memory2Tick({ now: T, deps: a.deps, config: cfg })).state, 'not-idle');
  assert.equal((await memory2Tick({ now: T, deps: mk({ busy: () => true }).deps, config: cfg })).state, 'busy');
  assert.equal(fs.existsSync(`${root}/.runtime/memory2/auto.json`), false);
  assert.equal(a.log.length, 0);
});

test('a failing step is logged with its error and not retried before its interval', async () => {
  wipe();
  const a = mk();
  a.deps.steps.ingest = async () => { throw new Error('model down'); };
  await memory2Tick({ now: T, deps: a.deps, config: cfg });
  const line = JSON.parse(fs.readFileSync(`${root}/.runtime/memory2/usage.jsonl`, 'utf8').trim().split('\n')[0]);
  assert.equal(line.error, 'model down');
  assert.equal((await memory2Tick({ now: T + H, deps: mk().deps, config: cfg })).state, 'nothing-due');
  wipe();
});

test('metered counts calls, sizes and failures', async () => {
  const { fn, m } = metered(async p => p === 'bad' ? Promise.reject(new Error('x')) : 'abc');
  await fn('hello'); await assert.rejects(fn('bad'));
  assert.deepEqual(m, { calls: 2, prompt_chars: 8, output_chars: 3, failed_calls: 1 });
});
