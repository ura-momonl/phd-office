import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { root as officeRoot, read, write } from '../automation/files.mjs';
import { MemoryRoot, appendEntries, patchFrontmatter } from './md.mjs';
import { ownerCheck, memoryEnabled } from './owner.mjs';
import { memoryNoteMaterial } from './note.mjs';
import { memoryContextV2 } from './inject.mjs';
import { pinEntries } from './ledger.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs');

test('only memory2 is registered; the old implementation and settings are absent', () => {
  const config = read('agent/config.json');
  assert.ok(!Object.hasOwn(config, 'office_memory_enabled'));
  assert.ok(!Object.hasOwn(config, 'memory_passive'));
  assert.ok(!read('automation/config.json').modules.memory);
  assert.ok(read('automation/config.json').modules.memory2);
  assert.ok(!fs.existsSync(path.join(officeRoot, 'memory')));
  assert.ok(!fs.existsSync(path.join(officeRoot, 'memory2/migrate-legacy.mjs')));
});

test('owner routing remains private after removing the legacy module', () => {
  const before = process.env.OFFICE_MEMORY_OWNER;
  process.env.OFFICE_MEMORY_OWNER = 'codex';
  try {
    assert.equal(ownerCheck('codex'), 'codex');
    assert.throws(() => ownerCheck('claude'), /自己的记忆/);
    assert.throws(() => ownerCheck('deepseek'), /自己的记忆/);
    assert.throws(() => ownerCheck('../escape'), /owner/);
  } finally { if (before === undefined) delete process.env.OFFICE_MEMORY_OWNER; else process.env.OFFICE_MEMORY_OWNER = before; }
});

test('notes use current Markdown episodes and omit superseded records and legacy understandings', () => {
  const config = read('agent/config.json');
  write('agent/config.json', { ...config, memory_v2: { enabled: true, owners: ['codex'] } });
  const root = new MemoryRoot(path.join(officeRoot, '.runtime/memory2/codex'));
  const [current, old, understanding] = appendEntries(root, 'episode', 'codex', '2031-01-01', [
    { inline: { timestamp: '2031-01-01T12:00:00Z' }, sections: { Subject: '共同经历', Content: '真实共同经历正文。' } },
    { inline: { timestamp: '2031-01-01T12:00:00Z' }, sections: { Subject: '已更正', Content: '不该出现的旧正文。' } },
    { inline: { timestamp: '2031-01-01T12:00:00Z' }, sections: { Subject: '偏好理解', Content: '偏好不是经历。', Legacy: JSON.stringify({ type: 'understanding' }) } },
  ]);
  patchFrontmatter(root.dailyPath('episode', 'codex', '2031-01-01'), { deprecated_entries: { [old]: current } });
  pinEntries({ root, ids: [current] });
  try {
    assert.equal(memoryEnabled('codex'), true);assert.equal(memoryEnabled('claude'), false);
    const material = memoryNoteMaterial('codex', '2031-06-01');
    assert.ok(material.cues.some(x => x.includes(current)));
    assert.ok(material.cues.some(x => x.includes(understanding)));
    assert.equal(material.episodes.length, 1);
    assert.match(material.episodes[0], /真实共同经历正文/);
    assert.ok(!JSON.stringify(material).includes(old));
    assert.deepEqual(memoryNoteMaterial('claude', '2031-06-01'), { cues: [], episodes: [] });
  } finally { write('agent/config.json', config); }
});

test('a failed retrieval reports unavailable and never recreates or falls back to the old store', t => {
  const config = read('agent/config.json');
  write('agent/config.json', { ...config, memory_v2: { enabled: true, owners: ['codex'] } });
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stderr: 'fixture retrieval failure' }));
  syncBuiltinESMExports();
  try {
    const block = memoryContextV2('codex', 'a fresh fixture query');
    assert.equal(block.mode, 'unavailable');
    assert.match(block.text, /读取失败/);
    assert.deepEqual(block.ids, []);
    assert.ok(!fs.existsSync(path.join(officeRoot, '.runtime/memory')));
  } finally { write('agent/config.json', config);t.mock.restoreAll();syncBuiltinESMExports(); }
});
