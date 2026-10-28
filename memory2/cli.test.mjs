import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { read, write, root } from '../automation/files.mjs';
import { run } from './run.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs');

test('the actual ingest CLI reports a failed startup with nonzero exit status, one attempt, and no fact-backfill restart', async t => {
  const cfg = read('agent/config.json'), sessions = read('.runtime/agent/sessions.json'), exitCode = process.exitCode;
  t.after(() => { write('agent/config.json', cfg); write('.runtime/agent/sessions.json', sessions); process.exitCode = exitCode; t.mock.restoreAll(); syncBuiltinESMExports(); });
  write('agent/config.json', { ...cfg, memory_extract: { codex: { provider: 'codex', model: 'fixture-only' } } });
  write('.runtime/agent/sessions.json', { sessions: [1, 2].map(i => ({ id: `s${i}`, origin: 'chat', messages: [
    { role: 'user', text: '虚构内容', at: '2026-10-20T01:00:00Z' },
    { role: 'assistant', provider: 'codex', text: '虚构回复', at: '2026-10-20T01:01:00Z' },
  ] })) });
  const request = path.join(root, '.runtime', 'memory2-cli-fixture.json'); fs.writeFileSync(request, '{"owner":"codex"}');
  const output = []; t.mock.method(console, 'log', text => output.push(text));
  let launches = 0;
  t.mock.method(childProcess, 'spawn', () => {
    launches++;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })));
    return child;
  });
  syncBuiltinESMExports();
  await run('ingest', request);
  const report = JSON.parse(output.at(-1));
  assert.equal(launches, 1);
  assert.equal(process.exitCode, 1);
  assert.equal(report.aborted, 'process-start-denied');
  assert.equal(report.failures.length, 1);
  assert.equal(report.episodes, 0);
  assert.equal(report.facts_backfill, undefined);
});
