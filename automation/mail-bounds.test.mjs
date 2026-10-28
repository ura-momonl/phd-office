import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {judgePending} from '../agent/mail.mjs';
import {Flow} from '../mail-flow/flow.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --mail --keep');
const config={automatic_mail_judgment:true,mail_screen_model:'luna-fixture',mail_judgment_model:'sol-fixture'};
const modelPacket=prompt=>JSON.parse(prompt.split('判断包：\n').at(-1));
const result=(p,decisions)=>({result:JSON.stringify({packet_id:p.packet_id,decisions})});
const fixture=(t,close=()=>{})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-bounds-'));
  t.after(()=>{close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^mail-bounds-/);fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
};

test('six opaque 152-char IDs survive both tiers and Flow sees all original mail, not aliases',async t=>{
  let flow;const dir=fixture(t,()=>flow?.close());flow=new Flow(dir,{account:'fixture@example.org',maxBatchMessages:8,maxPacketBytes:20000});
  const ids=Array.from({length:6},(_,i)=>'opaque-'.padEnd(150,'A')+String(i).padStart(2,'0'));
  for(const [i,id] of ids.entries())flow.ingest({id,subject:'Fixture '+i,receivedDateTime:'2032-01-01T12:00:00Z',sender:{emailAddress:{address:'fixture@example.org'}},body:{content:'Fixture information.'}},'inbox');
  const packet=flow.packet();assert.equal(packet.messages.length,6);
  const calls=[];let applied;
  const invoke=async(_,prompt,o)=>{
    const p=modelPacket(prompt);calls.push(p.messages.map(m=>m.id));
    assert.equal(p.packet_id,'batch');assert.ok(ids.every(id=>!prompt.includes(id)));
    assert.ok(p.messages.every(m=>!('fingerprint' in m)));
    const screen=o.model==='luna-fixture';
    return result(p,p.messages.map((m,i)=>({message_id:m.id,decision:screen&&i%2?'escalate':'ignore'})));
  };
  const r=await judgePending({directory:dir,config,invoke,apply:file=>{applied=JSON.parse(fs.readFileSync(file,'utf8'));return flow.apply(applied);}});
  assert.equal(r.applied,6);assert.equal(flow.pending().length,0);
  assert.deepEqual(calls,[['m1','m2','m3','m4','m5','m6'],['m2','m4','m6']]);
  assert.equal(applied.packet_id,packet.packet_id);
  assert.deepEqual(new Set(applied.decisions.map(d=>d.message_id)),new Set(ids));
  assert.ok(applied.decisions.every(d=>['screen','judgment'].includes(d.handler)));
});

test('task references decode to the existing task; task-related mail bypasses screening',async t=>{
  const dir=fixture(t),taskId='real-task-'.padEnd(36,'T'),ids=['real-mail-first','real-mail-related'];
  const packet={packet_id:'original-packet',messages:ids.map((id,i)=>({id,fingerprint:'not-for-model',related_task_ids:i?[taskId]:[]})),tasks:[{id:taskId,status:'todo',action:'Existing action'}]};
  fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify(packet));
  const calls=[];let applied;
  const r=await judgePending({directory:dir,config,invoke:async(_,prompt,o)=>{
    const p=modelPacket(prompt);calls.push(p.messages.map(m=>m.id));assert.equal(p.tasks[0].id,'t1');assert.ok(!prompt.includes(taskId));
    return result(p,p.messages.map(m=>o.model==='luna-fixture'?{message_id:m.id,decision:'ignore'}:{message_id:m.id,decision:'update',task_id:'t1',status:'todo',action:'Existing plus new action',check_at:null}));
  },apply:file=>{applied=JSON.parse(fs.readFileSync(file,'utf8'));return {applied:2};}});
  assert.equal(r.applied,2);assert.deepEqual(calls,[['m1'],['m2']]);assert.equal(applied.decisions[1].task_id,taskId);assert.equal(applied.decisions[1].message_id,ids[1]);
});

test('corrupt IDs, duplicate/missing coverage, wrong envelopes and oversized output stop before Sol or apply',async t=>{
  for(const fault of ['unknown','duplicate','missing','packet','decision','oversized']){
    const dir=fixture(t),packet={packet_id:'fault-'+fault,messages:[{id:'real-a'},{id:'real-b'}],tasks:[]};
    fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify(packet));
    let calls=0;
    const r=await judgePending({directory:dir,config,invoke:async(_,prompt)=>{
      calls++;const p=modelPacket(prompt),ds=p.messages.map(m=>({message_id:m.id,decision:'escalate'}));
      if(fault==='unknown')ds[1].message_id='m2'+'A'.repeat(20);
      if(fault==='duplicate')ds[1].message_id='m1';
      if(fault==='missing')ds.pop();
      if(fault==='packet')p.packet_id='other';
      if(fault==='decision')ds[1].decision='send';
      return fault==='oversized'?{result:'x'.repeat(196890)}:result(p,ds);
    },apply:()=>assert.fail('Invalid screening must not reach apply')});
    assert.ok(r.error,fault);assert.equal(calls,1,fault+' must not spend a Sol call');
    assert.equal(fs.existsSync(path.join(dir,'decisions.json')),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'review-packet.json'),'utf8')),packet);
  }
});

test('judgment omissions and unknown task refs cannot produce a partial applied packet',async t=>{
  for(const fault of ['missing','task','escalate']){
    const dir=fixture(t);fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify({packet_id:'p',messages:[{id:'a',related_task_ids:['real-task']},{id:'b',related_task_ids:['real-task']}],tasks:[{id:'real-task'}]}));
    let calls=0;const r=await judgePending({directory:dir,config,invoke:async(_,prompt)=>{
      calls++;const p=modelPacket(prompt),ds=p.messages.map(m=>({message_id:m.id,decision:'ignore'}));
      if(fault==='missing')ds.pop();if(fault==='task')ds[0].task_id='t99';if(fault==='escalate')ds[0].decision='escalate';
      return result(p,ds);
    },apply:()=>assert.fail('Invalid judgment must not reach apply')});
    assert.ok(r.error);assert.equal(calls,1);assert.equal(fs.existsSync(path.join(dir,'decisions.json')),false);
  }
});

test('mail timeout aborts its call, records failure and releases the judging lock without retrying',async t=>{
  const dir=fixture(t);fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify({packet_id:'timeout',messages:[{id:'a'}],tasks:[]}));
  t.mock.timers.enable({apis:['setTimeout']});
  let signal,calls=0;
  const pending=judgePending({directory:dir,config,invoke:async(_,prompt,o)=>{calls++;signal=o.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},apply:()=>assert.fail('Timed out call must not apply')});
  assert.equal(signal.aborted,false);t.mock.timers.tick(120000);
  const r=await pending;assert.match(r.error,/120 秒/);assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.deepEqual(await judgePending({directory:dir,config,now:Date.now()+1,invoke:()=>assert.fail('backoff must stop replay')}),{skipped:'backoff'});
  fs.unlinkSync(path.join(dir,'judge-state.json'));
  const done=await judgePending({directory:dir,config,invoke:async(_,prompt)=>{const p=modelPacket(prompt);return result(p,p.messages.map(m=>({message_id:m.id,decision:'ignore'})));},apply:()=>({applied:1})});
  assert.equal(done.applied,1,'completed cleanup released the lock');
});
