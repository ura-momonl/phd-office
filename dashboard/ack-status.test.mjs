import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {inboxItems,acknowledgeInbox,undoAcknowledgment} from './inbox.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --files=dashboard/ack-status.test.mjs');

const item=(id,extra={})=>({id,title:id,kind:'framework',actor:'claude',project_ids:[],goal:'g',sources:[],dependencies:[],status:'waiting_user',created_at:'2026-10-22T00:00:00Z',
  updated_at:'2026-10-22T00:00:00Z',due_at:null,handoff:'结论',outputs:[],session_id:null,executor:'claude',review:{kind:'decision',state:'pending'},...extra});
const card=(work,id)=>inboxItems([],work,[],new Date('2026-10-22T01:00:00Z'),false,[]).find(i=>i.id==='work:'+id);

test('candidate filtering preserves live, resolved and acknowledged review visibility',()=>{
  const ack='.runtime/inbox/acknowledged.json',saved=read(ack,{}),resolved='.runtime/agent/runs/latency-resolved/inbox.json';
  const work=[item('latency-live'),item('latency-accepted'),item('latency-resolved'),
    item('latency-unacknowledged',{review:{state:'accepted'}}),item('latency-plain',{status:'done',review:undefined}),
    item('latency-cancelled',{status:'cancelled'}),item('latency-merged',{merged_into:'latency-live'}),
    item('latency-deleted',{deleted_at:'2026-10-22T00:00:00Z'})];
  try{
    write('work/queue.json',{version:1,items:work});write(resolved,{resolved:true});
    acknowledgeInbox(card(read('work/queue.json').items,'latency-accepted'));
    const current=read('work/queue.json').items,now=new Date('2026-10-22T01:00:00Z');
    const ids=include=>inboxItems([],current,[],now,include,[]).filter(i=>i.source==='work').map(i=>i.source_id).sort();
    assert.deepEqual(ids(false),['latency-live']);
    assert.deepEqual(ids(true),['latency-accepted','latency-live'],'acknowledged cards still appear in the processed view; resolved cards stay hidden');
  }finally{write(ack,saved);fs.rmSync(path.join(root,resolved),{force:true});}
});

test('accepting a decision card also ends the step that was waiting for it; undo restores both',()=>{
  write('work/queue.json',{version:1,items:[item('w1')]});
  acknowledgeInbox(card(read('work/queue.json').items,'w1'));
  assert.equal(read('work/queue.json').items[0].status,'done');assert.equal(read('work/queue.json').items[0].review.state,'accepted');
  undoAcknowledgment('work:w1',[],read('work/queue.json').items,[],new Date());
  const back=read('work/queue.json').items[0];
  assert.equal(back.status,'waiting_user');assert.equal(back.review.state,'pending');
});

test('a step that still owes an output keeps its status; the card is accepted anyway',()=>{
  write('work/queue.json',{version:1,items:[item('w2',{require_outputs:true})]});
  acknowledgeInbox(card(read('work/queue.json').items,'w2'));
  const after=read('work/queue.json').items[0];
  assert.equal(after.status,'waiting_user');assert.equal(after.review.state,'accepted');
});

test('a delivery that is already done only has its review accepted',()=>{
  write('work/queue.json',{version:1,items:[item('w3',{status:'done'})]});
  acknowledgeInbox(card(read('work/queue.json').items,'w3'));
  const after=read('work/queue.json').items[0];
  assert.equal(after.status,'done');assert.equal(after.review.state,'accepted');
});
