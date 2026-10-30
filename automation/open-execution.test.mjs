import test from 'node:test';
import assert from 'node:assert/strict';
import {read,write} from './files.mjs';
import {enqueue,update} from '../work/run.mjs';
import {execute as executeAgent,drain,startReadyWork,agentSnapshot} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent),sessionsFile='.runtime/agent/sessions.json';
async function isolated(run) {
  const queue=read('work/queue.json'),sessions=read(sessionsFile),cfg=read('agent/config.json');
  try {
    write('agent/config.json',{...cfg,enabled:true,memory_v2:{enabled:false}});
    write('work/queue.json',{...queue,items:[]});write(sessionsFile,{sessions:[]});
    await run();
  } finally {write('work/queue.json',queue);write(sessionsFile,sessions);write('agent/config.json',cfg);}
}
const step=()=>enqueue({title:'Open admission fixture',kind:'data',actor:'claude',status:'queued',project_ids:[],goal:'Fixture only'});
const get=id=>read('work/queue.json').items.find(i=>i.id===id);

test('open operations cannot start through dispatch or direct execute',async()=>isolated(async()=>{
  const item=step();startReadyWork();update({id:item.id,status:'open'});
  let calls=0;
  await execute(item.id,async()=>{calls++;return {result:'must not run'};});
  await drain(async()=>{calls++;return {result:'must not run'};});
  assert.equal(calls,0);assert.equal(get(item.id).status,'open');
  assert.deepEqual(agentSnapshot().active_turns,[]);
}));

test('reopening a running operation blocks both final and midway colleague handoffs',async()=>isolated(async()=>{
  for(const midway of [false,true]) {
    const item=step();startReadyWork();const calls=[];
    await execute(item.id,async(provider,prompt,opts)=>{
      calls.push(provider);opts.beforeSubmit();
      if(midway)opts.onEvent({type:'text',text:'@Codex Continue the fixture'});
      update({id:item.id,status:'open',handoff:'Keep the user decision'});
      return {result:'Earlier result remains in history.\n@Codex Continue the fixture'};
    });
    assert.deepEqual(calls,['claude'],'no second provider is started');
    assert.equal(get(item.id).status,'open');assert.equal(get(item.id).handoff,'Keep the user decision');
    const session=read(sessionsFile).sessions.find(s=>s.task_ids.includes(item.id));
    assert.ok(session.messages.some(m=>m.role==='assistant' && !m.interim && m.text.includes('Earlier result')));
    assert.equal(get(item.id).handoff_resume,undefined,'no postponed handoff can restart it');
    assert.deepEqual(agentSnapshot().active_turns,[]);
  }
}));

test('open state at the final native submission boundary prevents sending input',async()=>isolated(async()=>{
  const item=step();startReadyWork();let submitted=false;
  await execute(item.id,async(provider,prompt,opts)=>{
    update({id:item.id,status:'open'});opts.beforeSubmit();submitted=true;
    return {result:'not sent'};
  });
  assert.equal(submitted,false);assert.equal(get(item.id).status,'open');
}));

test('existing dispatch beat interrupts a live native call after it is returned to open',async()=>isolated(async()=>{
  const item=step();startReadyWork();let ready,aborted=false;
  const started=new Promise(resolve=>{ready=resolve;});
  const running=execute(item.id,async(provider,prompt,opts)=>{
    opts.beforeSubmit();ready();
    return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{aborted=true;reject(opts.signal.reason);},{once:true}));
  });
  await started;update({id:item.id,status:'open',handoff:'Not approved'});
  const cfg=read('agent/config.json');write('agent/config.json',{...cfg,enabled:false});
  await drain();await running;
  assert.equal(aborted,true);assert.equal(get(item.id).status,'open');assert.equal(get(item.id).handoff,'Not approved');
  assert.deepEqual(agentSnapshot().active_turns,[]);
}));

test('an authorized active operation still hands off normally',async()=>isolated(async()=>{
  const item=step();startReadyWork();const calls=[];
  await execute(item.id,async(provider,prompt,opts)=>{
    opts.beforeSubmit();calls.push(provider);
    return {result:provider==='claude' ? '@Codex Continue the fixture' : 'Finished fixture'};
  });
  assert.deepEqual(calls,['claude','codex']);
}));
