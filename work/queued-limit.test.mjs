import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { root, read, write } from '../automation/files.mjs';
import { enqueue, update } from './run.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs --files=work/queued-limit.test.mjs');

const database = path.join(root, '.runtime/work/queued-admissions.sqlite');
const files = ['work/queue.json', '.runtime/agent/sessions.json', 'agent/config.json', 'automation/config.json'];
async function isolated(fn) {
  const saved = files.map(file => [file, read(file)]);
  const environment = Object.fromEntries(['OFFICE_MEMORY_RUN_DIR', 'OFFICE_MEMORY_OWNER'].map(key => [key, process.env[key]]));
  delete process.env.OFFICE_MEMORY_RUN_DIR; delete process.env.OFFICE_MEMORY_OWNER;
  fs.rmSync(database, { force: true });
  write('work/queue.json', { version: 1, items: [] });
  write('.runtime/agent/sessions.json', { sessions: [] });
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 2 });
  const config = read('automation/config.json');
  write('automation/config.json', { ...config, autonomy: { ...config.autonomy, level: 1 } });
  try { await fn(); }
  finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const [file, value] of saved) write(file, value);
    fs.rmSync(database, { force: true });
  }
}
const card = extra => ({ title: 'Synthetic queued card', kind: 'data', actor: 'codex', project_ids: [], status: 'queued', ...extra });
const item = id => read('work/queue.json').items.find(i => i.id === id);
const queueBytes = () => fs.readFileSync(path.join(root, 'work/queue.json'), 'utf8');
function receipts() {
  if (!fs.existsSync(database)) return [];
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT root_turn,card_id,source_task FROM admissions ORDER BY root_turn,card_id').all(); }
  finally { db.close(); }
}
function turn({ source, merged, status = 'active', origin = 'chat' } = {}) {
  const id = randomUUID(), now = new Date().toISOString();
  const task = { id, title: 'Synthetic user turn', kind: 'framework', actor: 'codex', executor: 'codex', project_ids: [],
    status, created_at: now, handoff: '', outputs: [], sources: [], dependencies: [], ...(merged ? { merged_into: merged.id } : {}) };
  const queue = read('work/queue.json'); queue.items.push(task); write('work/queue.json', queue);
  const state = read('.runtime/agent/sessions.json');
  state.sessions.push({ id: randomUUID(), origin, task_ids: [id], messages: [{ role: source ? 'handoff' : 'user', task_id: id,
    text: 'Synthetic instruction', ...(source ? { handoff: { task_id: source.id, provider: 'codex' } } : {}) }] });
  write('.runtime/agent/sessions.json', state);
  return task;
}
function context(task, suffix = '') {
  process.env.OFFICE_MEMORY_OWNER = 'codex';
  process.env.OFFICE_MEMORY_RUN_DIR = path.join(root, '.runtime/agent/runs', task.id, suffix);
}

test('queued adds stop at the configured limit; open cards remain free and rejection leaves the queue unchanged', () => isolated(() => {
  const parent = turn(); context(parent, '2');
  const first = enqueue(card()), second = enqueue(card());
  const before = queueBytes(), beforeReceipts = receipts();
  assert.throws(() => enqueue(card()), error => error.code === 'QUEUED_CARD_LIMIT');
  assert.equal(queueBytes(), before); assert.deepEqual(receipts(), beforeReceipts);
  assert.deepEqual(new Set(receipts().map(r => r.card_id)), new Set([first.id, second.id]));
  for (let n = 0; n < 4; n++) assert.equal(enqueue(card({ status: 'open' })).status, 'open');
  assert.equal(receipts().length, 2);
}));

test('open to queued spends a slot; reverting, cancelling and requeueing never refunds or double-counts that card', () => isolated(() => {
  const parent = turn(); context(parent);
  const first = enqueue(card({ status: 'open' }));
  assert.equal(receipts().length, 0);
  update({ id: first.id, status: 'queued' });
  update({ id: first.id, status: 'open' });
  update({ id: first.id, status: 'queued' });
  assert.equal(receipts().length, 1);
  update({ id: first.id, status: 'cancelled' });
  enqueue(card());
  const waiting = enqueue(card({ status: 'open' })), before = queueBytes();
  assert.throws(() => update({ id: waiting.id, status: 'queued' }), /queued.*上限/);
  assert.equal(queueBytes(), before); assert.equal(item(waiting.id).status, 'open');
  update({ id: first.id, status: 'queued' });
  assert.equal(receipts().length, 2);
}));

test('one card can spend one slot in each independent user turn without making turns share an allowance', () => isolated(() => {
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 1 });
  const a = turn(), b = turn(); context(a);
  const first = enqueue(card());
  assert.throws(() => enqueue(card()), /上限/);
  context(b); update({ id: first.id, status: 'open' }); update({ id: first.id, status: 'queued' });
  assert.throws(() => enqueue(card()), /上限/);
  assert.equal(receipts().length, 2);
  assert.deepEqual(new Set(receipts().map(r => r.root_turn)), new Set([a.id, b.id]));
}));

test('merged inputs and multi-level assistant handoffs retain the original user turn, even after that source finishes', () => isolated(() => {
  const parent = turn(); context(parent); enqueue(card());
  const merged = turn({ merged: parent }), handoff = turn({ source: merged }), nested = turn({ source: handoff });
  update({ id: parent.id, status: 'done', handoff: 'Synthetic source complete' });
  context(nested, '2'); const second = enqueue(card());
  assert.throws(() => enqueue(card()), /上限/);
  const row = receipts().find(r => r.card_id === second.id);
  assert.equal(row.root_turn, parent.id); assert.equal(row.source_task, nested.id);
}));

test('later speakers of an acknowledged multi-name input spend the same original user turn', () => isolated(() => {
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 1 });
  const parent=turn();context(parent);enqueue(card());
  const merged=turn({merged:parent}),later=turn();
  const q=read('work/queue.json');q.items.find(i=>i.id===later.id).request_task_id=merged.id;write('work/queue.json',q);
  context(later);assert.throws(()=>enqueue(card()),/上限/);
  assert.equal(receipts().length,1);assert.equal(receipts()[0].root_turn,parent.id);
}));

test('request payloads cannot turn themselves into internal conversation turns or clear the durable admissions', () => isolated(() => {
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 1 });
  const parent = turn(); context(parent);
  const first = enqueue(card());
  update({ id: parent.id, queued_card_ids: [] });
  assert.throws(() => enqueue(card({ conversationTurn: true, queued_card_ids: [], queued_cards_per_turn: 50 })), /上限/);
  assert.deepEqual(receipts().map(r => r.card_id), [first.id]);
}));

test('internal chat-turn creation and updates are not queued cards', () => isolated(() => {
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 1 });
  const parent = turn(); context(parent); enqueue(card());
  const conversation = enqueue(card(), { conversationTurn: true });
  assert.equal(conversation.status, 'queued');
  update({ id: parent.id, handoff: 'Synthetic update of the active chat turn' });
  assert.equal(receipts().length, 1);
}));

test('user-side queue actions and existing autonomous authority stay separate from a chat-turn allowance', () => isolated(() => {
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 1 });
  for (let n = 0; n < 3; n++) enqueue(card());
  assert.equal(receipts().length, 0);
  const parent = turn({ origin: 'task' }); context(parent);
  const proposal = { ...card({ status: 'open', project_ids: ['graphene-thz'] }), sources: ['synthetic source'], decision: 'Synthetic decision', deliverable: 'Synthetic result' };
  const open = enqueue(proposal);
  assert.ok(open.autonomy);
  assert.throws(() => enqueue({ ...proposal, status: 'queued' }), /自主等级/);
  assert.equal(receipts().length, 0);
}));

test('an invalid user source chain or limit does not write a card or admission', () => isolated(() => {
  const parent = turn({ source: { id: 'missing-source' } }); context(parent);
  const before = queueBytes();
  assert.throws(() => enqueue(card()), /所属的用户轮/);
  assert.equal(queueBytes(), before); assert.equal(receipts().length, 0);
  const direct = turn(); context(direct);
  write('agent/config.json', { ...read('agent/config.json'), queued_cards_per_turn: 0 });
  const after = queueBytes(); assert.throws(() => enqueue(card()), /1～50/);
  assert.equal(queueBytes(), after); assert.equal(receipts().length, 0);
}));

test('queue write failure releases only the new admission and preserves earlier successful cards', () => isolated(() => {
  const parent = turn(); context(parent); const first = enqueue(card()), before = queueBytes();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === path.join(root, 'work/queue.json')) throw Object.assign(new Error('Synthetic queue write failure'), { code: 'EIO' });
    return rename(from, to);
  };
  try { assert.throws(() => enqueue(card()), /Synthetic queue write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(queueBytes(), before); assert.deepEqual(receipts().map(r => r.card_id), [first.id]);
  enqueue(card()); assert.equal(receipts().length, 2);
}));

test('a turns-file failure after the queued card is visible does not refund its admission', () => isolated(() => {
  write('agent/config.json',{...read('agent/config.json'),queued_cards_per_turn:1});
  const parent=turn();context(parent);
  fs.appendFileSync(path.join(root,'work/turns.json'),'\n');
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{
    if(path.resolve(to)===path.join(root,'work/turns.json'))throw Object.assign(new Error('Synthetic turns write failure'),{code:'EIO'});
    return rename(from,to);
  };
  try {assert.throws(()=>enqueue(card({title:'Persisted before turns failure'})),/Synthetic turns write failure/);}
  finally {fs.renameSync=rename;}
  const persisted=read('work/queue.json').items.find(i=>i.title==='Persisted before turns failure');
  assert.equal(persisted.status,'queued');assert.deepEqual(receipts().map(r=>r.card_id),[persisted.id]);
  assert.throws(()=>enqueue(card()),/上限/);
}));

function cliAdd(request, parent, name) {
  const file = path.join(root, '.runtime/work', name + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(request));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['automation/run.mjs', 'work', 'add', file], { cwd: root, windowsHide: true,
      env: { ...process.env, OFFICE_MEMORY_OWNER: 'codex', OFFICE_MEMORY_RUN_DIR: path.join(root, '.runtime/agent/runs', parent.id, '2') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('two real CLI processes racing for the last slot admit exactly one card', () => isolated(async () => {
  const parent = turn(); context(parent); const first = enqueue(card());
  const results = await Promise.all([cliAdd(card({ title: 'Synthetic contender A' }), parent, 'contender-a'),
    cliAdd(card({ title: 'Synthetic contender B' }), parent, 'contender-b')]);
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.code !== 0).length, 1);
  assert.match(results.find(r => r.code !== 0).stderr, /queued.*上限/);
  const winner = JSON.parse(results.find(r => r.code === 0).stdout);
  assert.deepEqual(new Set(receipts().map(r => r.card_id)), new Set([first.id, winner.id]));
  assert.ok(item(winner.id));
  assert.equal(read('work/queue.json').items.filter(i => i.title.startsWith('Synthetic contender')).length, 1);
}));
