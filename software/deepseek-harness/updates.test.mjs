import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../../automation/files.mjs';
import {compareVersions,availableUpdate,checkUpdates,updateStatus,registry} from './updates.mjs';
import {inboxItems,acknowledgeInbox} from '../../dashboard/inbox.mjs';
import {pickBareCards} from '../../agent/mail.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const installed='.runtime/deepseek-harness/npm/node_modules/@deepseek-ai/dsh/package.json';
const state='.runtime/deepseek-harness/updates.json',policy='software/deepseek-harness/update-policy.json';
const now=Date.parse('2026-10-25T15:30:00Z'),DAY=864e5;
const tags={latest:'0.2.1-rc.2',next:'0.2.1-rc.3',alpha:'0.3.0-alpha.1'};
const fetcher=(body=tags)=>async url=>{assert.equal(url,registry);return {ok:true,json:async()=>body};};
const cards=()=>inboxItems([],read('work/queue.json').items,[]);
async function fixture(fn) {
  const queue=read('work/queue.json'),originalPolicy=read(policy),ack=read('.runtime/inbox/acknowledged.json',{});
  const remove=file=>{try{fs.unlinkSync(path.join(root,file));}catch(e){if(e.code!=='ENOENT')throw e;}};
  write('work/queue.json',{version:1,items:[]});write('.runtime/inbox/acknowledged.json',{});write(installed,{version:'0.2.1-rc.2'});write(policy,{enabled:true});remove(state);
  try {await fn();}finally{write('work/queue.json',queue);write('.runtime/inbox/acknowledged.json',ack);write(policy,originalPolicy);remove(state);remove(installed);}
}

test('DSH channels compare semantic versions; latest is not automatically newer than installed next',()=>{
  assert.equal(registry,'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags');
  for(const [a,b] of [['0.2.1-rc.10','0.2.1-rc.9'],['0.2.1','0.2.1-rc.3'],['0.3.0-alpha.1','0.2.9'],['0.2.1-rc.a','0.2.1-rc.2']])assert.equal(compareVersions(a,b),1);
  assert.equal(compareVersions('0.2.1+build','0.2.1'),0);
  assert.deepEqual(availableUpdate('0.2.1-rc.2',tags),{version:'0.2.1-rc.3',channels:['next']});
  assert.equal(availableUpdate('0.2.1-rc.3',tags),null);
  assert.deepEqual(availableUpdate('0.2.1-rc.2',{latest:'0.2.1-rc.3',next:'0.2.1-rc.3'}),{version:'0.2.1-rc.3',channels:['latest','next']});
  for(const bad of [null,{},[],{latest:'not a version'},{latest:'0.2.1',next:23}])assert.throws(()=>availableUpdate('0.2.1',bad));
});

test('first, second and later daily checks show one usable inbox reminder without starting AI or reinstalling DSH',async()=>fixture(async()=>{
  let calls=0,current=tags;
  const fetchImpl=async(...args)=>{calls++;return fetcher(current)(...args);};
  const packageBefore=fs.readFileSync(path.join(root,installed));
  const first=await checkUpdates({now,fetchImpl});assert.equal(first.error,null);assert.equal(calls,1);
  let shown=cards();assert.equal(shown.length,1);assert.equal(shown[0].id,'work:dsh-update-available');
  assert.match(shown[0].detail,/0\.2\.1-rc\.3/);assert.equal(shown[0].status,'waiting_user');
  assert.deepEqual(shown[0].actions.map(a=>a.type),['accept','reply']);
  assert.deepEqual(pickBareCards(shown),[],'automatic card preparation must not start a model');
  acknowledgeInbox(shown[0]);assert.equal(cards().length,0);
  assert.equal(read('work/queue.json').items[0].status,'done');
  await checkUpdates({now:now+1000,fetchImpl});assert.equal(calls,1);
  for(const day of [1,2])await checkUpdates({now:now+day*DAY,fetchImpl});
  assert.equal(calls,3);assert.equal(cards().length,0,'same candidate remains acknowledged on later days');
  current={...tags,next:'0.2.1-rc.4'};
  await checkUpdates({now:now+3*DAY,fetchImpl});
  shown=cards();assert.equal(shown.length,1);assert.match(shown[0].detail,/0\.2\.1-rc\.4/);
  assert.equal(read('work/queue.json').items.length,1,'reuse one notification rather than accumulate tasks');
  assert.ok(read('work/queue.json').items.every(i=>i.actor==='user' && i.status!=='queued' && !i.executor));
  assert.ok(fs.readFileSync(path.join(root,installed)).equals(packageBefore));
}));

test('bad registry responses preserve the last successful result and wait until the next daily check',async()=>fixture(async()=>{
  await checkUpdates({now,fetchImpl:fetcher()});
  let calls=0;
  const fail=async()=>{calls++;return {ok:false,status:503};};
  const failed=await checkUpdates({now:now+DAY,fetchImpl:fail});
  assert.match(failed.error,/503/);assert.deepEqual(failed.available,{version:'0.2.1-rc.3',channels:['next']});
  await checkUpdates({now:now+DAY+60000,fetchImpl:fail});assert.equal(calls,1);
  const malformed=await checkUpdates({now:now+2*DAY,fetchImpl:fetcher({wrong:true})});
  assert.match(malformed.error,/not recognized/);assert.equal(cards().length,1);
  const recovered=await checkUpdates({now:now+3*DAY,fetchImpl:fetcher()});assert.equal(recovered.error,null);
  assert.equal(read('work/queue.json').items.length,1);
}));

test('installing the candidate manually clears an obsolete reminder; no update does not create one',async()=>fixture(async()=>{
  const noUpdate=await checkUpdates({now,fetchImpl:fetcher({latest:'0.2.1-rc.2'})});
  assert.equal(noUpdate.available,null);assert.equal(cards().length,0);
  await checkUpdates({now:now+DAY,fetchImpl:fetcher()});assert.equal(cards().length,1);
  write(installed,{version:'0.2.1-rc.3'});
  await checkUpdates({now:now+2*DAY,fetchImpl:fetcher()});assert.equal(cards().length,0);
  assert.equal(read('work/queue.json').items[0].status,'done');
}));

test('concurrent beats share one request; disabling checks and isolated defaults make no network request',async()=>fixture(async()=>{
  let resolve,calls=0;
  const fetchImpl=()=>{calls++;return new Promise(r=>{resolve=r;});};
  const one=checkUpdates({now,fetchImpl}),two=checkUpdates({now,fetchImpl});
  assert.equal(calls,1);resolve({ok:true,json:async()=>tags});await Promise.all([one,two]);
  write(policy,{enabled:false});assert.equal((await checkUpdates({now:now+DAY,fetchImpl})).skipped,'disabled');assert.equal(calls,1);
  assert.equal((await checkUpdates({force:true})).skipped,'isolated tests');
  assert.equal(updateStatus().automatic_install,false);
}));

test('public CLI and existing backend beat expose the checker, not an installer or new timer',()=>{
  const server=fs.readFileSync(path.join(root,'dashboard/server.mjs'),'utf8');
  assert.match(server,/void checkDeepSeekUpdates\(\)/);
  const config=read('automation/config.json');assert.ok(config.modules.deepseek.actions.includes('updates'));
  const code=fs.readFileSync(new URL('./updates.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/node:child_process|\b(?:spawn|setInterval|invokeDeepSeek)\s*\(/);
});
