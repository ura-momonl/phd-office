import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { FetchBackoff } from './fetch-backoff.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs');

test('one host 429 skips later requests locally, leaves other hosts available, and expires without extending on skips', async t => {
  let now = Date.parse('2026-10-26T23:39:09Z');
  t.mock.method(Date, 'now', () => now);
  const calls = [], policy = new FetchBackoff();
  t.mock.method(globalThis, 'fetch', async value => {
    calls.push(String(value));
    return String(value).includes('limited.example') ? new Response(null, { status: 429, headers: { 'Retry-After': '900' } }) : new Response('ok');
  });
  assert.equal((await policy.fetch('https://limited.example/a')).status, 429);
  now += 20000;
  const skipped = await policy.fetch('https://limited.example/b');
  assert.equal(skipped.status, 429); assert.equal(Number(skipped.headers.get('retry-after')), 40);
  assert.equal((await policy.fetch('https://independent.example/paper')).status, 200);
  assert.equal(calls.length, 2);
  now += 40000;
  assert.equal(policy.remaining('https://limited.example/c'), 0);
  await policy.fetch('https://limited.example/c'); assert.equal(calls.length, 3);
});

test('observed backoff survives batch restart and stores no URL secrets', async t => {
  const file = path.join(root, '.runtime/backoff-test.json');
  t.after(() => fs.rmSync(file, { force: true }));
  let now = Date.parse('2026-10-26T23:39:09Z'); t.mock.method(Date, 'now', () => now);
  const first = new FetchBackoff(file);
  first.observe('https://limited.example/paper?token=PRIVATE', 429, { 'retry-after': '900' });
  const text = fs.readFileSync(file, 'utf8'); assert.doesNotMatch(text, /PRIVATE|token|paper|https/);
  now += 1000;
  const second = new FetchBackoff(file); let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; return new Response('ok'); });
  assert.equal((await second.fetch('https://limited.example/other')).status, 429);
  assert.equal(called, false); assert.equal(second.remaining('https://limited.example'), 59000);
});

test('arXiv official hosts share the observed deadline; unrelated sites do not', t => {
  const policy = new FetchBackoff();
  policy.observe('https://export.arxiv.org/api/query', 429, { 'retry-after': '900' });
  assert.ok(policy.remaining('https://arxiv.org/pdf/1234.56789') > 50000);
  assert.equal(policy.remaining('https://repository.example/paper'), 0);
});

test('redirect target refusal blocks both original route and target, never a different origin', async t => {
  const policy = new FetchBackoff(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const r = new Response(null, { status: 429, headers: { 'retry-after': '900' } });
    Object.defineProperty(r, 'url', { value: 'https://target.example/final' }); return r;
  });
  await policy.fetch('https://original.example/paper');
  await policy.fetch('https://target.example/other');
  await policy.fetch('https://original.example/other');
  assert.equal(calls, 1); assert.equal(policy.remaining('https://different.example'), 0);
});

test('a 15 minute Retry-After is capped, also for a deadline saved by an older run', t => {
  const file = path.join(root, '.runtime/backoff-cap-test.json');
  t.after(() => fs.rmSync(file, { force: true }));
  const policy = new FetchBackoff();
  policy.observe('https://limited.example/a', 429, { 'retry-after': '900' });
  assert.ok(policy.remaining('https://limited.example/a') <= 60000);
  fs.writeFileSync(file, JSON.stringify({ 'old.example': Date.now() + 900000 }));
  assert.ok(new FetchBackoff(file).remaining('https://old.example/a') <= 60000);
});
