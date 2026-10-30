import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {read,write,root} from '../automation/files.mjs';
import {splitQueue,isChatTurn} from './run.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --files=work/queue-split.test.mjs');

const file=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const ids=name=>file(name).items.map(i=>i.id);
const step=(id,at,extra={})=>({id,title:id,kind:'data',actor:'user',status:'open',created_at:at,updated_at:at,handoff:'',outputs:[],...extra});
const turn=(id,at,extra={})=>step(id,at,{actor:'claude',status:'done',executor:'claude',...extra});

test('split moves chat turns to turns.json and every reader still sees one ordered list',()=>{
  fs.rmSync(path.join(root,'work/turns.json'),{force:true}); // the runner starts copies already split; this test is the migration
  write('work/queue.json',{version:1,items:[step('s1','2026-10-01T00:00:00Z'),turn('t1','2026-10-02T00:00:00Z'),step('s2','2026-10-03T00:00:00Z'),
    turn('p1','2026-10-04T00:00:00Z',{review:{kind:'acceptance',state:'pending'}})]});
  assert.equal(fs.existsSync(path.join(root,'work/turns.json')),false);
  assert.deepEqual(splitQueue(),{split:true,steps:3,turns:1});
  assert.deepEqual(ids('work/queue.json'),['s1','s2','p1']);   // a delivery awaiting acceptance is a task, not a turn
  assert.deepEqual(ids('work/turns.json'),['t1']);
  assert.deepEqual(read('work/queue.json').items.map(i=>i.id),['s1','t1','s2','p1']);
  assert.deepEqual(splitQueue(),{split:false});
  assert.ok(fs.readdirSync(path.join(root,'.runtime/work-edits')).some(n=>n.startsWith('queue-before-split-')));
});

test('writing steps leaves the turn log untouched; a record moves when its class changes',()=>{
  const turnsBefore=fs.readFileSync(path.join(root,'work/turns.json'),'utf8'),stat=fs.statSync(path.join(root,'work/turns.json')).mtimeMs;
  const queue=read('work/queue.json');queue.items.find(i=>i.id==='s1').status='done';write('work/queue.json',queue);
  assert.equal(fs.readFileSync(path.join(root,'work/turns.json'),'utf8'),turnsBefore);
  assert.equal(fs.statSync(path.join(root,'work/turns.json')).mtimeMs,stat);
  const next=read('work/queue.json');next.items.find(i=>i.id==='p1').review={kind:'acceptance',state:'accepted'};write('work/queue.json',next);
  assert.deepEqual(ids('work/queue.json'),['s1','s2']);
  assert.deepEqual(ids('work/turns.json'),['t1','p1']);
  assert.ok(isChatTurn(read('work/queue.json').items.find(i=>i.id==='p1')));
  const added=read('work/queue.json');added.items.push(turn('t2','2026-10-05T00:00:00Z'));write('work/queue.json',added);
  assert.deepEqual(ids('work/turns.json'),['t1','p1','t2']);
});

test('an id present in both files is read once, the step copy winning',()=>{
  const turns=file('work/turns.json');turns.items.push(step('s2','2026-10-03T00:00:00Z',{title:'stale copy'}));
  fs.writeFileSync(path.join(root,'work/turns.json'),JSON.stringify(turns,null,2)+'\n');
  const items=read('work/queue.json').items.filter(i=>i.id==='s2');
  assert.equal(items.length,1);assert.equal(items[0].title,'s2');
});


test('past the cap the oldest finished rounds are archived by month, unfinished ones stay however old',()=>{
  const pad='x'.repeat(40000),day=n=>`2026-09-${String(n).padStart(2,'0')}T00:00:00Z`;
  const old=Array.from({length:230},(_,n)=>turn('o'+n,day(1+n%27),{handoff:pad}));
  old.push(turn('live-old','2026-08-01T00:00:00Z',{status:'queued',handoff:pad}));
  const fresh=turn('fresh','2026-10-20T00:00:00Z');
  const queue=read('work/queue.json');queue.items=[...queue.items.filter(i=>!isChatTurn(i)),...old,fresh];
  write('work/queue.json',queue);                      // the file is over 8 MB after this write; the cap runs on the next one
  write('work/queue.json',read('work/queue.json'));
  const kept=ids('work/turns.json');
  assert.ok(kept.includes('live-old'),'an unfinished round is never archived');
  assert.ok(kept.includes('fresh'));
  assert.ok(!kept.includes('o0'),'the oldest finished rounds left the log');
  assert.ok(fs.statSync(path.join(root,'work/turns.json')).size<8*1048576);
  const archived=fs.readdirSync(path.join(root,'.runtime/work/archive')).filter(n=>/^turns-2026-\d\d\.jsonl$/.test(n));
  assert.ok(archived.length>0);
  const lines=archived.flatMap(n=>fs.readFileSync(path.join(root,'.runtime/work/archive',n),'utf8').trim().split('\n')).map(l=>JSON.parse(l).id);
  assert.ok(lines.includes('o0'),'archived rounds are kept in the archive, not dropped');
  assert.ok(!lines.includes('live-old'));
});
