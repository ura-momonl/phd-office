import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRoot } from './md.mjs';
import { tuning, buildMemCells } from './extract.mjs';
import { applyOps, buildSummary, renderProfileForUpdate, renderConversationForProfile, extractProfile, readProfile, writeProfile, updateProfile, PROFILE_COMPACT_THRESHOLD } from './profile.mjs';

tuning.retryDelayMs = 0;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-prof-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const at = (h, day = 24) => `2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
const msg = (role, text, when, provider) => ({ role, text, at: when, task_id: 't', ...(provider ? { provider } : {}) });
const session = (id, messages, extra = {}) => ({ id, origin: 'chat', messages, ...extra });
const base = { owner_id: 'claude', summary: 'x', timestamp_ms: 1, explicit_info: [{ category: '学业', description: '博士生', evidence: 'e' }], implicit_traits: [{ trait: '谨慎', description: '重视证据', basis: 'b', evidence: 'e' }] };

test('applyOps: add / update (merge fields) / delete by index, independent lists, bad ops ignored, summary rebuilt', () => {
  const out = applyOps(base, [
    { action: 'add', type: 'explicit_info', data: { category: '工作', description: '做量子材料', evidence: 'e2' } },
    { action: 'update', type: 'explicit_info', index: 0, data: { description: '量子材料方向博士生' } },
    { action: 'delete', type: 'implicit_traits', index: 0 },
    { action: 'update', type: 'explicit_info', index: 9, data: { description: 'ignored' } },
    { action: 'add', type: 'explicit_info', data: 'not-an-object' },
    { action: 'none' }, null], 42);
  assert.deepEqual(out.explicit_info.map(i => i.description), ['量子材料方向博士生', '做量子材料']);
  assert.equal(out.explicit_info[0].category, '学业', 'update merges fields');
  assert.equal(out.implicit_traits.length, 0);
  assert.equal(out.summary, '量子材料方向博士生');
  assert.equal(out.timestamp_ms, 42);
  assert.equal(base.explicit_info.length, 1, 'input not mutated');
  assert.equal(buildSummary([], [{ trait: '谨慎' }]), '谨慎');
  assert.equal(buildSummary([], []), '(no summary)');
});

test('conversation and profile renderings match the upstream formats', () => {
  const [cell] = buildMemCells(session('s', [msg('user', '你好', at(1)), msg('assistant', '嗨', at(1), 'claude')]), 'claude');
  assert.equal(renderConversationForProfile([cell]), '[2026-10-24 01:00:00] 用户(user_id:用户): 你好\n[2026-10-24 01:00:00] Claude(user_id:Claude): 嗨');
  assert.equal(renderProfileForUpdate(base), '=== explicit_info ===\n[0] {"category":"学业","description":"博士生","evidence":"e"}\n=== implicit_traits ===\n[0] {"trait":"谨慎","description":"重视证据","basis":"b","evidence":"e"}');
});

function llmFor(script) {
  const f = async (prompt, { purpose }) => { f.log.push({ purpose, prompt }); const r = script[purpose]; return typeof r === 'function' ? r(prompt, f.log.filter(l => l.purpose === purpose).length) : r; };
  f.log = [];
  return f;
}
const cellOf = (text, h) => buildMemCells(session('s' + h, [msg('user', text, at(h)), msg('assistant', '好', at(h), 'claude')]), 'claude')[0];

test('extractProfile INIT then UPDATE: zh prompts filled with target user, current profile and conversation; compaction when too large', async () => {
  const llm = llmFor({
    'memory2-profile-init': '{"explicit_info": [{"category": "身份", "description": "量子材料博士生", "evidence": "自述"}], "implicit_traits": []}',
    'memory2-profile-update': '```json\n{"operations": [{"action": "add", "type": "implicit_traits", "data": {"trait": "务实", "description": "先做再验", "basis": "多次", "evidence": "10月"}}]}\n```',
    'memory2-profile-compact': '{"explicit_info": [{"description": "精简后"}], "implicit_traits": []}',
  });
  const init = await extractProfile(llm, [cellOf('我是做量子材料的博士生', 1)], { owner: 'claude' });
  assert.equal(init.summary, '量子材料博士生');
  assert.equal(init.timestamp_ms, Date.parse(at(1)));
  const p = llm.log[0].prompt;
  assert.match(p, /目标用户：用户/);
  assert.match(p, /\] 用户\(user_id:用户\): 我是做量子材料的博士生/);
  assert.doesNotMatch(p, /\{target_user\}|\{conversation_text\}/);
  const upd = await extractProfile(llm, [cellOf('我喜欢先做出来再看', 2)], { owner: 'claude', oldProfile: init });
  assert.equal(upd.implicit_traits[0].trait, '务实');
  const up = llm.log[1].prompt;
  assert.match(up, /\[0\] \{"category":"身份"/);
  assert.match(up, /我喜欢先做出来再看/);
  assert.equal(llm.log.filter(l => l.purpose === 'memory2-profile-compact').length, 0, 'no compaction below threshold');
  const big = { ...init, explicit_info: Array.from({ length: PROFILE_COMPACT_THRESHOLD }, (_, i) => ({ description: 'd' + i })) };
  const compacted = await extractProfile(llm, [cellOf('又一条', 3)], { owner: 'claude', oldProfile: big });
  assert.equal(compacted.summary, '精简后');
  assert.match(llm.log.at(-1).prompt, new RegExp(`${PROFILE_COMPACT_THRESHOLD + 1}`));
  await assert.rejects(extractProfile(llm, [], { owner: 'claude' }), /at least one/);
});

test('user.md round-trips through the md layer (single-file rewrite)', () => {
  const root = new MemoryRoot(tmp());
  assert.equal(readProfile(root, 'claude'), null);
  writeProfile(root, 'claude', { ...base, summary: '一段摘要：含冒号', timestamp_ms: 1234 });
  writeProfile(root, 'claude', { ...base, summary: '新摘要', timestamp_ms: 5678 });
  const back = readProfile(root, 'claude');
  assert.deepEqual([back.summary, back.timestamp_ms, back.explicit_info[0].description], ['新摘要', 5678, '博士生']);
  assert.match(fs.readFileSync(root.profilePath('claude'), 'utf8'), /^---\n[\s\S]*type: user_profile[\s\S]*---\n新摘要\n$/);
});

test('updateProfile feeds only cells newer than the profile in size-bounded batches, resumes, and stops at the first failure keeping the last good profile', async () => {
  const root = new MemoryRoot(tmp());
  const sessions = [1, 2, 3, 4].map(h => session('s' + h, [msg('user', '内容'.repeat(10) + h, at(h)), msg('assistant', '好', at(h), 'claude')]));
  let n = 0;
  const llm = llmFor({
    'memory2-profile-init': () => `{"explicit_info": [{"description": "第${++n}次"}], "implicit_traits": []}`,
    'memory2-profile-update': () => { n++; if (n === 3 || n === 4) throw new Error('boom'); return `{"operations": [{"action": "add", "type": "explicit_info", "data": {"description": "第${n}次"}}]}`; },
  });
  const r1 = await updateProfile({ owner: 'claude', root, sessions, llm, batchChars: 30 }); // ~22 chars per cell -> one cell per batch
  assert.deepEqual([r1.calls, r1.cells_used, r1.pending_cells], [2, 2, 4]);
  assert.match(r1.error, /boom/);
  assert.equal(readProfile(root, 'claude').timestamp_ms, Date.parse(at(2)), 'profile keeps the last good state');
  const r2 = await updateProfile({ owner: 'claude', root, sessions, llm, batchChars: 30 });
  assert.deepEqual([r2.pending_cells, r2.calls, r2.error], [2, 2, null], 'resumes after the profile timestamp');
  assert.equal(readProfile(root, 'claude').timestamp_ms, Date.parse(at(4)));
  assert.equal((await updateProfile({ owner: 'claude', root, sessions, llm })).pending_cells, 0);
  const big = await updateProfile({ owner: 'claude', root: new MemoryRoot(tmp()), sessions, llm: llmFor({ 'memory2-profile-init': '{"explicit_info": [], "implicit_traits": []}', 'memory2-profile-update': '{"operations": []}' }), batchChars: 100000 });
  assert.equal(big.calls, 1, 'all cells fit one batch');
});
