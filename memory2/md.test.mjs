import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEntryId, parseEntryId, splitEntries, renderStructuredEntry, parseStructuredEntry, dumpFrontmatter, parseFrontmatter,
  MemoryRoot, appendEntries, patchFrontmatter, readMarkdown, writeAtomic, withFileLock } from './md.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-md-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('entry id round-trips and tolerates legacy 4-digit seq', () => {
  assert.equal(formatEntryId('ep', '2026-06-01', 1), 'ep_20260601_00000001');
  assert.deepEqual(parseEntryId('ep_20260601_00000012'), { prefix: 'ep', date: '2026-06-01', seq: 12 });
  assert.equal(parseEntryId('ep_20260601_0003').seq, 3);
  assert.equal(parseEntryId('my_prefix_20260601_00000002').prefix, 'my_prefix');
  assert.throws(() => parseEntryId('bad'), /invalid entry id/);
  assert.throws(() => parseEntryId('ep_2026_1'), /invalid date/);
});

test('structured entry render/parse keeps header, inline fields and sections (Chinese, lists)', () => {
  const text = renderStructuredEntry({ header: 'ep_20261024_00000001', inline: { owner_id: 'claude', sender_ids: ['u1', 'u2'], gap: null }, sections: { Subject: '标题', Content: '第一行\n第二行  \n' } });
  const p = parseStructuredEntry(text);
  assert.equal(p.header, 'ep_20261024_00000001');
  assert.deepEqual(p.inline, { owner_id: 'claude', sender_ids: '[u1, u2]', gap: '' });
  assert.deepEqual(p.sections, { Subject: '标题', Content: '第一行\n第二行' });
});

test('unterminated entry stops the scan; foreign text between entries is ignored', () => {
  const body = 'intro\n<!-- entry:a1 -->\nA\n<!-- /entry:a1 -->\nnote\n<!-- entry:b2 -->\nB\n';
  const entries = splitEntries(body);
  assert.deepEqual(entries.map(e => [e.id, e.body]), [['a1', 'A']]);
});

test('frontmatter round-trips strings that need quoting, ints, nulls and one-level maps', () => {
  const meta = { id: 'episode_log_claude_2026-10-24', date: '2026-10-24', entry_count: 3, created_at: '2026-10-24T01:02:03.000Z', note: 'a: b # c', empty: null, flag: true, word: 'yes',
    deprecated_entries: { ep_20261024_00000001: 'ep_20261024_00000009', '带冒号:的键': 'x' } };
  const { meta: back, rest } = parseFrontmatter(dumpFrontmatter(meta) + 'BODY\n');
  assert.deepEqual(back, meta);
  assert.equal(rest, 'BODY\n');
  assert.deepEqual(parseFrontmatter('no frontmatter'), { meta: {}, rest: 'no frontmatter' });
  assert.equal(dumpFrontmatter({}), '');
});

test('appendEntries allocates ids from file state, keeps order, and survives hand-lowered entry_count', () => {
  const root = new MemoryRoot(tmp());
  const [a, b] = appendEntries(root, 'episode', 'claude', '2026-10-24', [
    { inline: { owner_id: 'claude' }, sections: { Content: '甲' } }, { inline: { owner_id: 'claude' }, sections: { Content: '乙' } }]);
  assert.deepEqual([a, b], ['ep_20261024_00000001', 'ep_20261024_00000002']);
  const file = root.dailyPath('episode', 'claude', '2026-10-24');
  assert.match(file, /default_app[\\/]default_project[\\/]users[\\/]claude[\\/]episodes[\\/]episode-2026-10-24\.md$/);
  // hand-edit: lower the count
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('entry_count: 2', 'entry_count: 0'));
  const [c] = appendEntries(root, 'episode', 'claude', '2026-10-24', [{ inline: {}, sections: { Content: '丙' } }]);
  assert.equal(c, 'ep_20261024_00000003');
  const parsed = readMarkdown(file);
  assert.equal(parsed.frontmatter.entry_count, 3);
  assert.deepEqual(parsed.entries.map(e => e.id), [a, b, c]);
  assert.equal(parseStructuredEntry(parsed.entries[2].body).sections.Content, '丙');
});

test('patchFrontmatter merges deprecated_entries without touching the body', () => {
  const root = new MemoryRoot(tmp());
  const [id] = appendEntries(root, 'episode', 'claude', '2026-10-24', [{ inline: {}, sections: { Content: '内容' } }]);
  const file = root.dailyPath('episode', 'claude', '2026-10-24');
  const before = readMarkdown(file).body;
  patchFrontmatter(file, { deprecated_entries: { [id]: 'ep_20261025_00000001' } });
  patchFrontmatter(file, { deprecated_entries: { ep_x_00000001: 'y' } });
  const after = readMarkdown(file);
  assert.equal(after.body, before);
  assert.deepEqual(after.frontmatter.deprecated_entries, { [id]: 'ep_20261025_00000001', ep_x_00000001: 'y' });
  appendEntries(root, 'episode', 'claude', '2026-10-24', [{ inline: {}, sections: { Content: '后加' } }]);
  assert.equal(readMarkdown(file).frontmatter.deprecated_entries[id], 'ep_20261025_00000001', 'append keeps deprecated_entries');
});

test('path safety: unsafe ids are rejected before any file is touched', () => {
  const dir = tmp(), root = new MemoryRoot(dir);
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.hidden']) assert.throws(() => root.userDir(bad), /安全|越出/, bad);
  assert.throws(() => appendEntries(root, 'episode', '../evil', '2026-10-24', [{ sections: { Content: 'x' } }]), /安全/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('lock file serialises writers and a stale lock is taken over', () => {
  const dir = tmp(), file = path.join(dir, 'f.md');
  fs.writeFileSync(file + '.lock', '99999');
  fs.utimesSync(file + '.lock', new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal(withFileLock(file, () => 'ok'), 'ok');
  assert.equal(fs.existsSync(file + '.lock'), false);
  writeAtomic(file, 'x');
  assert.deepEqual(fs.readdirSync(dir), ['f.md'], 'no temp files left');
});
