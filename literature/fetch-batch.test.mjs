import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { root, read, write } from '../automation/files.mjs';
import { runFetchBatch } from './fetch-batch.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs');

function fixture(t, count = 3) {
  const baseline = read('literature/catalog.json');
  const papers = Array.from({ length: count }, (_, i) => ({ doi: `10.5555/batch-${i}`, title: `Fictional paper ${i}` }));
  write('literature/catalog.json', { ...baseline, papers });
  const dir = fs.mkdtempSync(path.join(root, '.runtime/fetch-batch-'));
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 0 })); syncBuiltinESMExports();
  t.after(() => { write('literature/catalog.json', baseline); fs.rmSync(dir, { recursive: true }); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const journal = () => fs.readFileSync(path.join(dir, 'attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { dir, papers, journal, run: options => runFetchBatch({ directory: dir, concurrency: 1, ...options }) };
}

function clock(t, onSleep = () => {}) {
  let now = Date.now(), slept = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { now += ms; slept += ms; onSleep(ms); queueMicrotask(fn); return 0; });
  return { now: () => now, slept: () => slept };
}

test('per-paper refusals, login needs, timeouts and identity failures are skipped, not batch stops', async t => {
  const statuses = [...Array(11).fill('access_denied'), 'needs_login', 'login_failed', 'failed', 'validation_failed', 'available'];
  const f = fixture(t, statuses.length), calls = [];
  const state = await f.run({ fetchPaper: async doi => { calls.push(doi); return { status: statuses[calls.length - 1] }; } });
  assert.equal(state.status, 'complete');
  assert.equal(state.completed, statuses.length); assert.equal(state.available, 1);
  assert.deepEqual(calls, f.papers.map(p => p.doi));
  assert.deepEqual(f.journal().map(p => p.result.status), statuses);
  assert.equal(fs.existsSync(path.join(f.dir, 'RUNNING')), false);
});

for (const retryAfter of [900000, undefined, 0]) {
  test(`429 skips that DOI and continues immediately, regardless of Retry-After ${retryAfter}`, async t => {
    const f = fixture(t), c = clock(t), at = c.now(), calls = [];
    const state = await f.run({ fetchPaper: async doi => {
      calls.push({ doi, at: c.now() });
      return calls.length === 1 ? { status: 'rate_limited', retry_after_ms: retryAfter } : { status: 'available' };
    } });
    assert.equal(state.status, 'complete'); assert.equal(state.available, 2);
    assert.equal(calls[1].at - at, 0); assert.equal(c.slept(), 0);
    assert.deepEqual(calls.map(p => p.doi), f.papers.map(p => p.doi));
    assert.equal(state.waiting_until, undefined);
  });
}

test('STOP after a skipped DOI preserves remaining work for the next run', async t => {
  const f = fixture(t), calls = [];
  const state = await f.run({ fetchPaper: async doi => { calls.push(doi); fs.writeFileSync(path.join(f.dir, 'STOP'), 'user pause'); return { status: 'rate_limited' }; } });
  assert.equal(state.status, 'stopped'); assert.equal(state.current.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(f.journal().length, 1);
  fs.unlinkSync(path.join(f.dir, 'STOP'));
  await f.run({ fetchPaper: async doi => { calls.push(doi); return { status: 'available' }; } });
  // The 429 is not a verdict on the article: the next run tries it again.
  assert.deepEqual(calls, [f.papers[0].doi, ...f.papers.map(p => p.doi)]);
});

test('first, second and later runs preserve history and skip existing PDFs, archived and previously attempted papers', async t => {
  const f = fixture(t), calls = [];
  const fetchPaper = async doi => { calls.push(doi); return { status: 'needs_attention' }; };
  const first = await f.run({ fetchPaper }); assert.equal(first.completed, 3);
  const original = fs.readFileSync(path.join(f.dir, 'attempts.jsonl'), 'utf8');
  const local = path.join(f.dir, 'existing.pdf'); fs.writeFileSync(local, 'fixture only; not fetched');
  const extra = { doi: '10.5555/new-paper', title: 'New paper' };
  write('literature/catalog.json', { papers: [...f.papers, extra,
    { doi: '10.5555/local', fulltext_path: local }, { doi: '10.5555/archived', library_status: 'deferred-publication' }] });
  const second = await f.run({ fetchPaper }); assert.equal(second.completed, 4);
  assert.deepEqual(calls, [...f.papers.map(p => p.doi), extra.doi]);
  assert.ok(fs.readFileSync(path.join(f.dir, 'attempts.jsonl'), 'utf8').startsWith(original));
  const third = await f.run({ fetchPaper }); assert.equal(third.completed, 4);
  assert.equal(calls.length, 4); assert.equal(third.total, 4);
});

test('six workers do not wait globally after a 429 and do not duplicate or lose targets', async t => {
  const f = fixture(t, 18), c = clock(t), calls = [];
  let active = 0, max = 0, limitedAt;
  const state = await f.run({ concurrency: 6, fetchPaper: async doi => {
    active++; max = Math.max(max, active); calls.push({ doi, at: c.now() });
    await Promise.resolve(); active--;
    if (doi === f.papers[0].doi) { limitedAt = c.now(); return { status: 'rate_limited', retry_after_ms: 4000 }; }
    return { status: 'available' };
  } });
  assert.equal(state.status, 'complete'); assert.equal(state.completed, 18); assert.equal(state.available, 17);
  assert.equal(max, 6); assert.equal(new Set(calls.map(p => p.doi)).size, 18);
  assert.ok(calls.slice(6).every(p => p.at === limitedAt));
  assert.equal(f.journal().length, 18); assert.equal(state.current.length, 0);
});

test('manual STOP drains already in-flight papers without dispatching the remaining ones', async t => {
  const f = fixture(t, 10), calls = [];
  const state = await f.run({ concurrency: 6, fetchPaper: async doi => {
    calls.push(doi); await Promise.resolve();
    fs.writeFileSync(path.join(f.dir, 'STOP'), 'user pause');
    return { status: 'available' };
  } });
  assert.equal(state.status, 'stopped'); assert.equal(state.completed, 6);
  assert.equal(state.current.length, 0); assert.equal(calls.length, 6);
});

test('shared PDF validator failure still stops without discarding the journal', async t => {
  const f = fixture(t), calls = [];
  const state = await f.run({ fetchPaper: async doi => { calls.push(doi); return { status: 'validation_failed', pdf_reason: 'parser_unavailable' }; } });
  assert.equal(state.status, 'stopped'); assert.equal(calls.length, 1);
  assert.equal(state.reason, 'Local PDF validator unavailable');
  assert.equal(f.journal().length, 1); assert.equal(fs.existsSync(path.join(f.dir, 'RUNNING')), false);
});

test('unexpected shared execution failure is recorded, rather than claiming the batch completed', async t => {
  const f = fixture(t);
  const state = await f.run({ fetchPaper: async () => { throw new Error('fixture disk failure'); } });
  assert.equal(state.status, 'failed'); assert.equal(state.reason, 'fixture disk failure');
  assert.equal(state.completed, 0); assert.equal(fs.existsSync(path.join(f.dir, 'RUNNING')), false);
});

test('a second launcher cannot overwrite or remove the existing writer lock', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'RUNNING'), 'another writer');
  await assert.rejects(f.run({ fetchPaper: async () => assert.fail('must not fetch') }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(f.dir, 'RUNNING'), 'utf8'), 'another writer');
});
