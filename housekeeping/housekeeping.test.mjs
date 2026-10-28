// Fictional files only. Runs against the isolated copy: ages are set with utimes, nothing real is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { plan, apply, housekeepingDaily, report, stores } from './run.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw Error('Use node scripts/run-tests.mjs --files=housekeeping/housekeeping.test.mjs');
const now = Date.now(), DAY = 864e5;
const abs = (...p) => path.join(root, ...p);
function put(rel, ageDays, text = 'x'.repeat(100)) {
  const f = abs(rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
  const t = new Date(now - ageDays * DAY); fs.utimesSync(f, t, t); return f;
}
function age(rel, days) { const t = new Date(now - days * DAY); fs.utimesSync(abs(rel), t, t); }
const wipe = () => { for (const d of ['.runtime/agent/runs', '.runtime/agent/sessions.json', '.runtime/acceptance', '.runtime/tmp', '.runtime/housekeeping', '.runtime/work-edits', '.runtime/old-experiment', '.runtime/live-run', 'housekeeping/policy.json', 'output/literature-rebuild-20261021/coordinator/admissions']) fs.rmSync(abs(d), { recursive: true, force: true }); };
const removed = actions => actions.map(a => path.relative(root, a.path).replaceAll('\\', '/')).sort();

test('run logs go after 10 days, the prompt copies after 30, and the rest of the run folder stays', () => {
  wipe();
  for (const name of ['events.jsonl', 'prompt.txt', 'native-prompt.txt', 'prompt-manifest.json', 'continuation.json', 'file-changes.json']) put('.runtime/agent/runs/old/' + name, 40);
  age('.runtime/agent/runs/old', 40);
  for (const name of ['events.jsonl', 'prompt.txt', 'prompt-manifest.json']) put('.runtime/agent/runs/mid/' + name, 20);
  age('.runtime/agent/runs/mid', 20);
  put('.runtime/agent/runs/recent/events.jsonl', 3); age('.runtime/agent/runs/recent', 3);
  assert.deepEqual(removed(plan({ now })), [
    '.runtime/agent/runs/mid/events.jsonl',
    '.runtime/agent/runs/old/events.jsonl', '.runtime/agent/runs/old/native-prompt.txt', '.runtime/agent/runs/old/prompt-manifest.json', '.runtime/agent/runs/old/prompt.txt',
  ]);
  const r = apply(plan({ now }), { now });
  assert.equal(r.removed, 5);
  for (const kept of ['old/continuation.json', 'old/file-changes.json', 'mid/prompt.txt', 'mid/prompt-manifest.json', 'recent/events.jsonl'])
    assert.ok(fs.existsSync(abs('.runtime/agent/runs/' + kept)), kept);
  const ledger = fs.readFileSync(abs('.runtime/housekeeping/ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([...new Set(ledger.map(e => e.rule))].sort(), ['run-events', 'run-prompt-copies']);
});

test('a run that restarted an attempt keeps its files in a numbered folder, and those are cleaned too', () => {
  wipe();
  put('.runtime/agent/runs/restarted/2/events.jsonl', 40); put('.runtime/agent/runs/restarted/2/prompt.txt', 40);
  age('.runtime/agent/runs/restarted/2', 40); age('.runtime/agent/runs/restarted', 40);
  assert.deepEqual(removed(plan({ now })), ['.runtime/agent/runs/restarted/2/events.jsonl', '.runtime/agent/runs/restarted/2/prompt.txt']);
});

test('files a task left in its run folder are reported by size and never removed', () => {
  wipe();
  put('.runtime/agent/runs/download/WDSecurity_WIN.zip', 40, 'x'.repeat(11 * 1048576));
  put('.runtime/agent/runs/download/events.jsonl', 40); put('.runtime/agent/runs/download/prompt.txt', 40);
  age('.runtime/agent/runs/download', 40);
  assert.deepEqual(removed(plan({ now })), ['.runtime/agent/runs/download/events.jsonl', '.runtime/agent/runs/download/prompt.txt']);
  const listed = report().find(r => r.rule === 'run-files');
  assert.deepEqual(listed.items, [{ name: 'download/WDSecurity_WIN.zip', bytes: 11 * 1048576 }]);
});

test('a folder with an old date but a freshly written child is not removed', () => {
  wipe();
  put('.runtime/acceptance/stale/a.txt', 30); age('.runtime/acceptance/stale', 30);
  put('.runtime/acceptance/active/old.txt', 30); put('.runtime/acceptance/active/new.txt', 0.2); age('.runtime/acceptance/active', 30);
  assert.deepEqual(removed(plan({ now })), ['.runtime/acceptance/stale']);
});

test('catalog snapshots keep the newest three and only go after the age limit', () => {
  wipe();
  const base = 'output/literature-rebuild-20261021/coordinator/admissions';
  [[40, 'a'], [30, 'b'], [20, 'c'], [15, 'd'], [12, 'e'], [5, 'f']].forEach(([d, n]) => { put(`${base}/${n}/catalog-before.json`, d); age(`${base}/${n}`, d); });
  assert.deepEqual(removed(plan({ now })).map(p => p.split('/').at(-2)), ['a', 'b', 'c']);
});

test('policy cannot go below one day, can adjust other rules, and can disable the daily run', () => {
  wipe();
  put('.runtime/tmp/half-day.txt', 0.5); put('.runtime/tmp/two-days.txt', 2);
  fs.writeFileSync(abs('housekeeping/policy.json'), JSON.stringify({ days: { scratch: 0 } }));
  assert.deepEqual(removed(plan({ now })), ['.runtime/tmp/two-days.txt']);
  fs.writeFileSync(abs('housekeeping/policy.json'), JSON.stringify({ enabled: false }));
  assert.equal(housekeepingDaily({ now: new Date(now) }).skipped, 'disabled');
  assert.ok(fs.existsSync(abs('.runtime/tmp/two-days.txt')));
});

test('daily run happens once per day and symbolic links are never followed', () => {
  wipe();
  const outside = abs('.runtime/housekeeping-outside'); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  put('.runtime/tmp/old.txt', 20);
  let linked = true;
  try { fs.symlinkSync(outside, abs('.runtime/tmp/link'), 'junction'); const t = new Date(now - 20 * DAY); fs.lutimesSync(abs('.runtime/tmp/link'), t, t); } catch { linked = false; }
  const first = housekeepingDaily({ now: new Date(now) });
  assert.equal(first.removed, 1);
  assert.equal(housekeepingDaily({ now: new Date(now) }).skipped, 'done today');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'link target untouched');
  if (linked) assert.ok(fs.existsSync(abs('.runtime/tmp/link')), 'link itself left alone');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('library snapshots: only sqlite files go, the newest one stays, small neighbours stay', () => {
  fs.rmSync(abs('.runtime/literature-edits'), { recursive: true, force: true });
  put('.runtime/literature-edits/a/library.sqlite', 9); put('.runtime/literature-edits/a/catalog.json', 9);
  put('.runtime/literature-edits/b/library.before-x.sqlite', 6); put('.runtime/literature-edits/c/library.sqlite', 4);
  put('.runtime/literature-edits/c/library.sqlite-wal', 4); put('.runtime/literature-edits/d/library.sqlite', 0.5);
  assert.deepEqual(removed(plan({ now })).filter(p => p.includes('literature-edits')), ['.runtime/literature-edits/a/library.sqlite', '.runtime/literature-edits/b/library.before-x.sqlite', '.runtime/literature-edits/c/library.sqlite']);
  fs.rmSync(abs('.runtime/literature-edits'), { recursive: true, force: true });
});

test('queue edit backups keep the newest ten and only go after thirty days', () => {
  wipe();
  for (let i = 0; i < 14; i++) put(`.runtime/work-edits/${String(i).padStart(2, '0')}.json`, 40 + i);
  assert.deepEqual(removed(plan({ now })).filter(p => p.includes('work-edits')), ['.runtime/work-edits/10.json', '.runtime/work-edits/11.json', '.runtime/work-edits/12.json', '.runtime/work-edits/13.json']);
});

test('the growing stores are reported by size and never on the removal list', () => {
  wipe();
  const sessions = abs('.runtime/agent/sessions.json'), turns = abs('work/turns.json');
  fs.mkdirSync(path.dirname(sessions), { recursive: true });
  fs.writeFileSync(sessions, Buffer.alloc(41 * 1048576));
  fs.writeFileSync(turns, '{"items":[]}\n');
  const byFile = Object.fromEntries(stores().map(s => [s.file, s]));
  assert.equal(byFile['.runtime/agent/sessions.json'].over, true, 'a store past its limit is flagged');
  assert.equal(byFile['.runtime/agent/sessions.json'].limit, '40.0 MB');
  assert.equal(byFile['work/turns.json'].over, false, 'a store inside its limit is reported without a warning');
  assert.equal(byFile['work/turns.json'].limit, '24.0 MB');
  assert.equal(byFile['.runtime/usage/runs.jsonl'], undefined, 'a store with no file yet is skipped');
  assert.deepEqual(stores().map(s => s.file), ['.runtime/agent/sessions.json', 'work/turns.json']);
  assert.equal(plan({ now }).some(a => [sessions, turns].includes(a.path)), false, 'stores never appear as removals');
});

test('a big .runtime directory nothing has touched for a month is reported, an active one is not', () => {
  wipe();
  put('.runtime/old-experiment/data.bin', 60, 'x'.repeat(51 * 1048576));
  age('.runtime/old-experiment/data.bin', 60); age('.runtime/old-experiment', 60);
  put('.runtime/live-run/data.bin', 1, 'x'.repeat(51 * 1048576));
  const listed = report().find(r => r.rule === 'idle-runtime-dirs');
  assert.deepEqual(listed.items.map(i => i.name), ['old-experiment']);
  assert.equal(removed(plan({ now })).length, 0, 'report-only never removes anything');
});
