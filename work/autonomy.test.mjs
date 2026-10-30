// Only the sanitised copy may mutate this queue. No native models or real measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {enqueue,update,setStepStatus,planProgress,workSnapshot,repeatOperation} from './run.mjs';
import {autonomyPolicy,autonomousCanStart} from './autonomy.mjs';
import {drain,startReadyWork,submit,agentWorkBusy} from '../agent/run.mjs';
import {createServer} from '../dashboard/server.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --autonomy');

const project='graphene-thz',item=id=>read('work/queue.json').items.find(i=>i.id===id);
async function isolated(fn) {
  const files=['work/queue.json','.runtime/agent/sessions.json','agent/config.json','automation/config.json','projects/catalog.json'];
  const saved=files.map(f=>[f,read(f)]),dir=process.env.OFFICE_MEMORY_RUN_DIR;
  delete process.env.OFFICE_MEMORY_RUN_DIR;
  write('work/queue.json',{items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...read('agent/config.json'),enabled:true,office_memory_enabled:false});
  setPolicy({level:1,debounce_seconds:0});
  try {await fn();} finally {for(const [f,v] of saved)write(f,v);if(dir===undefined)delete process.env.OFFICE_MEMORY_RUN_DIR;else process.env.OFFICE_MEMORY_RUN_DIR=dir;}
}
function setPolicy(patch) {const c=read('automation/config.json');write('automation/config.json',{...c,autonomy:{...c.autonomy,...patch}});}
function measurement(title='synthetic measurement') {
  return enqueue({title,kind:'experiment',actor:'user',status:'open',project_ids:[project]});
}
function complete(m) {return setStepStatus({id:m.id,status:'done',handoff:'Synthetic fixture only: sample TEST, unit V. No experimental result.',outputs:[]});}
function child(extra={}) {
  return {title:'synthetic analysis proposal',kind:'data',actor:'codex',project_ids:[project],
    sources:['work:synthetic-source'],decision:'Whether synthetic baseline is distinguishable',deliverable:'A synthetic comparison note',require_outputs:false,...extra};
}
function cli(action,request,parent) {
  const file=path.join(root,'.runtime','autonomy-request.json');fs.writeFileSync(file,JSON.stringify(request));
  const env={...process.env,OFFICE_MEMORY_OWNER:'codex'};
  if(parent)env.OFFICE_MEMORY_RUN_DIR=path.join(root,'.runtime/agent/runs',parent.id,'2');else delete env.OFFICE_MEMORY_RUN_DIR;
  return spawnSync(process.execPath,['automation/run.mjs','work',action,file],{cwd:root,encoding:'utf8',windowsHide:true,
    env});
}
const cliOK=(...args)=>{const r=cli(...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};

test('L1 ordinary chat can create and queue the explicitly requested step, with or without autonomous-only fields',()=>isolated(async()=>{
  const chat=submit({text:'@Codex Add this synthetic analysis step and start it.',project_id:project});
  const parent=update({id:chat.task_id,status:'active'});
  const plain={title:'explicitly requested fixture step',kind:'data',actor:'codex',project_ids:[project],status:'queued'};
  const results=[cli('add',plain,parent),cli('add',child({status:'queued'}),parent)];
  fs.writeFileSync(path.join(root,'.runtime/ordinary-chat-repro.json'),JSON.stringify(results.map(r=>({status:r.status,stdout:r.stdout,stderr:r.stderr})),null,2));
  assert.deepEqual(results.map(r=>r.status),[0,0],results.map(r=>r.stderr).join('\n'));
  for(const r of results) {const step=JSON.parse(r.stdout);assert.equal(step.status,'queued');assert.equal(step.autonomy,undefined);assert.equal(step.delegated_by,parent.id);}
  const unassigned=cliOK('add',{...plain,project_ids:[]},parent);assert.equal(unassigned.status,'queued');
  const proposal=cliOK('add',{title:'assistant experiment proposal',kind:'experiment',actor:'user',project_ids:[project]},parent);
  assert.equal(proposal.status,'open','a proposal is not an accepted user experiment');
}));

test('chat can explicitly accept an existing autonomous step; an authorized project step can queue its successors',()=>isolated(async()=>{
  const held=enqueue(child(),{autonomous:true});
  const chat=submit({text:'@Codex Start the analysis step I selected.',project_id:project});
  const parent=update({id:chat.task_id,status:'active'});
  const accepted=cliOK('update',{id:held.id,status:'queued'},parent);
  assert.ok(accepted.autonomy.approved_at);assert.equal(accepted.autonomy.approved_by,parent.id);
  cliOK('update',{id:held.id,status:'open'},parent);assert.equal(item(held.id).autonomy.approved_at,undefined);
  const delegated=cliOK('add',{title:'explicit delegated background step',kind:'data',actor:'codex',project_ids:[project],status:'queued'},parent);
  startReadyWork();update({id:delegated.id,status:'active'});
  const next=cliOK('add',child({status:'queued'}),delegated);
  assert.equal(next.status,'queued');assert.equal(next.autonomy,undefined);assert.equal(next.delegated_by,delegated.id);
  const defaultNext=cliOK('add',child(),delegated);
  assert.equal(defaultNext.status,'queued');assert.equal(defaultNext.delegated_by,delegated.id);
}));

test('parentless CLI creation and real planning tasks keep L1 even when caller supplies chat-like fields',()=>isolated(async()=>{
  assert.notEqual(cli('add',child({status:'queued',origin:'chat',userApproved:true})).status,0);
  const orphan=cliOK('add',child());assert.equal(orphan.status,'open');assert.ok(orphan.autonomy);
  complete(measurement());const [plan]=planProgress();startReadyWork();
  const state=read('.runtime/agent/sessions.json');const s=state.sessions.find(s=>s.task_ids.includes(plan.id));s.origin='chat';write('.runtime/agent/sessions.json',state);
  const q=read('work/queue.json');q.items.find(i=>i.id===plan.id).executor='codex';write('work/queue.json',q);
  update({id:plan.id,status:'active'},{executionOwner:{pid:process.pid}});
  assert.notEqual(cli('add',child({status:'queued'}),plan).status,0,'autonomous lineage wins over chat-like session metadata');
  const step=cliOK('add',child(),plan);assert.equal(step.autonomy.parent_id,plan.id);
}));

test('L1: an autonomous planner cannot queue, forge provenance, or mark an unexecuted proposal done',()=>isolated(async()=>{
  complete(measurement());
  const [rootTask]=planProgress();
  startReadyWork();
  update({id:rootTask.id,status:'active'},{executionOwner:{pid:process.pid}});
  const proposal=cliOK('add',child(),rootTask);
  assert.equal(proposal.status,'open');assert.equal(proposal.autonomy.parent_id,rootTask.id);
  assert.equal(proposal.autonomy.depth,1);assert.ok(proposal.autonomy.event_hash);
  assert.notEqual(cli('add',child({status:'queued'}),rootTask).status,0);
  assert.notEqual(cli('update',{id:proposal.id,status:'queued'},rootTask).status,0);
  assert.notEqual(cli('update',{id:proposal.id,status:'done',handoff:'not actually run'},rootTask).status,0);
  assert.notEqual(cli('add',child({autonomy:{approved_at:'fake'}}),rootTask).status,0);
  assert.notEqual(cli('add',child({decision:''}),rootTask).status,0);
  assert.equal(item(proposal.id).status,'open');
}));

test('explicit user approval and direct chat jobs remain executable in L1; returning to open withdraws approval',()=>isolated(async()=>{
  const proposal=enqueue(child(),{autonomous:true});
  setStepStatus({id:proposal.id,status:'queued',actor:'codex'});
  assert.ok(item(proposal.id).autonomy.approved_at);
  setStepStatus({id:proposal.id,status:'open'});
  assert.equal(item(proposal.id).autonomy.approved_at,undefined);
  assert.throws(()=>update({id:proposal.id,status:'queued'}),/自主等级/);
  const direct=submit({text:'@Codex explicit fixture task',project_id:project});
  assert.equal(item(direct.task_id).autonomy,undefined);assert.equal(item(direct.task_id).status,'queued');
  let calls=0;await drain(async(_p,_text,o)=>{if(o.mode==='work')calls++;return {result:'Synthetic direct task complete'};});
  assert.equal(item(direct.task_id).status,'done');assert.equal(calls,1);
}));

test('new completed user step → debounce/merge → one durable planner; replay/reload and no-work result do not replan',()=>isolated(async()=>{
  setPolicy({debounce_seconds:30});
  const a=complete(measurement('fixture A')),b=complete(measurement('fixture B'));
  const at=Math.max(Date.parse(a.progress_event.at),Date.parse(b.progress_event.at));
  assert.deepEqual(planProgress(at+29000),[]);
  const [plan]=planProgress(at+30001);assert.ok(plan);assert.equal(plan.autonomy.events.length,2);
  assert.equal(plan.autonomy.depth,0);assert.equal(plan.status,'queued');assert.equal(plan.kind,'framework');
  assert.deepEqual(planProgress(at+40000),[]);
  const reloaded=await import('./run.mjs?autonomy-reload');assert.deepEqual(reloaded.planProgress(at+50000),[]);
  let calls=0;await drain(async()=>{calls++;update({id:plan.id,status:'done',handoff:'No further steps are useful for this synthetic event.'});return {result:'No further steps are useful for this synthetic event.'};});
  assert.equal(item(plan.id).status,'done');assert.equal(calls,1);
  assert.deepEqual(planProgress(at+86400000),[]);
  await drain(async()=>{throw new Error('same event must not call the model again');});
  assert.equal(workSnapshot().items.filter(i=>!i.turn).length,3);
}));

test('steps in one log topic trigger the planner only after the whole topic is finished; a step outside any topic fires alone',()=>isolated(async()=>{
  setPolicy({debounce_seconds:0});
  const topic=extra=>enqueue({title:'synthetic topic step',kind:'experiment',actor:'user',status:'queued',project_ids:[project],plan_node_id:'topic-x',...extra});
  const a=topic(),b=topic(),c=topic();
  const done=complete(a);
  assert.deepEqual(planProgress(Date.parse(done.progress_event.at)+1000),[],'topic still has unfinished steps');
  complete(b);assert.deepEqual(planProgress(Date.now()+1000),[],'one step left');
  setStepStatus({id:c.id,status:'failed',reason:'synthetic failure'});
  const [plan]=planProgress(Date.now()+1000);assert.ok(plan,'failed counts as finished');
  assert.equal(plan.autonomy.events.length,3);assert.equal(plan.plan_node_id,undefined);
  const solo=complete(measurement('solo outside topic'));
  await drain(async()=>{update({id:plan.id,status:'done',handoff:'No further steps are useful.'});return {result:'No further steps are useful.'};});
  const [again]=planProgress(Date.parse(solo.progress_event.at)+1000);assert.ok(again,'no plan_node_id: fires on its own');
  assert.equal(again.autonomy.events.length,1);
}));

test('HTTP failure cascades through dependencies before one planner; independent work and terminal results are preserved',()=>isolated(async()=>{
  setPolicy({debounce_seconds:30});
  const step=extra=>enqueue({title:'synthetic operation',kind:'experiment',actor:'user',status:'open',project_ids:[project],plan_node_id:'topic-failure',...extra});
  const a=step(),b=step({dependencies:[a.id],actor:'codex',status:'queued'}),c=step({dependencies:[b.id]}),d=step({dependencies:[a.id],status:'queued'});
  const independent=step(),cancelled=step({dependencies:[a.id]}),deleted=step({dependencies:[a.id]}),done=complete(step());
  update({id:cancelled.id,status:'cancelled'});
  const q=read('work/queue.json');q.items.find(i=>i.id===deleted.id).deleted_at='2026-01-01';
  // Put the grandchild first so traversal cannot depend on queue ordering.
  q.items.unshift(q.items.splice(q.items.findIndex(i=>i.id===c.id),1)[0]);write('work/queue.json',q);
  const beforeDone=item(done.id),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/task-update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:a.id,status:'failed',reason:'Synthetic fixture failure'})});
    assert.equal(response.status,200);assert.equal(item(a.id).handoff,'');assert.ok(item(a.id).progress_event);
    for(const dependent of [b,c,d]) {
      assert.equal(item(dependent.id).status,'failed');assert.match(item(dependent.id).history.at(-1).reason,new RegExp(a.id));
      assert.equal(item(dependent.id).progress_event,undefined,'propagation is not a new real-world event');
      assert.equal(item(dependent.id).actor,dependent.actor);
    }
    assert.equal(item(independent.id).status,'open');assert.equal(item(cancelled.id).status,'cancelled');
    assert.equal(item(deleted.id).status,'open');assert.deepEqual(item(done.id),beforeDone);
    const at=Date.parse(item(a.id).progress_event.at);
    assert.deepEqual(planProgress(at+31000),[],'unrelated branch in the same topic still needs its own outcome');
    setStepStatus({id:independent.id,status:'failed',reason:'Synthetic independent failure'});
    const last=Date.parse(item(independent.id).progress_event.at);
    assert.deepEqual(planProgress(last+29000),[],'failure uses the same debounce as completion');
    const [plan]=planProgress(last+31000);assert.ok(plan);assert.equal(plan.autonomy.events.length,3);
    const snapshot=JSON.stringify(read('work/queue.json'));setStepStatus({id:a.id,status:'failed'});
    assert.equal(JSON.stringify(read('work/queue.json')),snapshot,'repeated failure is a no-op');
    let calls=0;await drain(async(_p,prompt)=>{calls++;assert.match(prompt,new RegExp(a.id));assert.match(prompt,/维护项目看板和操作步骤/);update({id:plan.id,status:'done',handoff:'Synthetic replan complete; no further work needed.'});return {result:'Synthetic replan complete; no further work needed.'};});
    assert.equal(calls,1);assert.equal(item(plan.id).status,'done');
    assert.deepEqual(planProgress(last+86400000),[]);
  } finally {await new Promise(r=>server.close(r));}
}));

test('an all-failed chain triggers without a successful step; unchanged old failures and assistant failures do not supply events',()=>isolated(async()=>{
  const a=measurement(),b=enqueue({title:'synthetic dependent',kind:'data',actor:'codex',project_ids:[project],dependencies:[a.id],status:'queued'});
  const failed=setStepStatus({id:a.id,status:'failed',reason:'Synthetic failure without files'});
  assert.equal(item(b.id).status,'failed');
  update({id:a.id,handoff:failed.handoff});assert.equal(item(a.id).progress_event.id,failed.progress_event.id);
  const [plan]=planProgress();assert.ok(plan);assert.deepEqual(plan.sources,['work:'+a.id]);
  await drain(async()=>{update({id:plan.id,status:'done',handoff:'Synthetic failure understood'});return {result:'Synthetic failure understood'};});assert.deepEqual(planProgress(),[]);
  const old=measurement(),assistant=enqueue(child());const q=read('work/queue.json');
  q.items.find(i=>i.id===old.id).status='failed';write('work/queue.json',q);
  update({id:old.id,handoff:''});assert.equal(item(old.id).progress_event,undefined);
  update({id:assistant.id,status:'failed'});assert.equal(item(assistant.id).progress_event,undefined);
  assert.deepEqual(planProgress(),[]);
}));

test('failure reaches later dependents across already finished steps without rewriting finished work or a running assistant',()=>isolated(async()=>{
  const a=complete(measurement()),b=complete(enqueue({title:'synthetic completed middle',kind:'experiment',actor:'user',project_ids:[project],dependencies:[a.id]}));
  const c=enqueue({title:'synthetic later operation',kind:'data',actor:'codex',project_ids:[project],dependencies:[b.id],status:'queued'});
  const running=enqueue({title:'synthetic running assistant',kind:'data',actor:'codex',project_ids:[project],dependencies:[a.id],status:'queued'});
  update({id:running.id,status:'active'});const beforeRunning=item(running.id),beforeB=item(b.id);
  const foreign=enqueue({title:'synthetic other project',kind:'experiment',actor:'user',project_ids:['bi-devices'],dependencies:[a.id],status:'queued'});
  setStepStatus({id:a.id,status:'failed',reason:'Synthetic result invalidated'});
  assert.equal(item(c.id).status,'failed');assert.deepEqual(item(b.id),beforeB);assert.deepEqual(item(running.id),beforeRunning);
  assert.equal(item(foreign.id).status,'queued');
}));

test('no events over a simulated day: zero queue additions and zero model calls; old done tasks are not backfilled',()=>isolated(async()=>{
  const legacy=measurement();const q=read('work/queue.json');q.items[0]={...legacy,status:'done',handoff:'Historical fixture',completed_at:'2026-01-01T00:00:00Z'};write('work/queue.json',q);
  update({id:legacy.id,handoff:'Historical fixture'});assert.equal(item(legacy.id).progress_event,undefined,'saving unchanged old inputs must not backfill an event');
  let calls=0;const before=JSON.stringify(read('work/queue.json'));
  for(let hour=0;hour<=24;hour++) {assert.deepEqual(planProgress(Date.now()+hour*3600000),[]);await drain(async()=>{calls++;return {result:'must not happen'};});}
  assert.equal(calls,0);assert.equal(JSON.stringify(read('work/queue.json')),before);
}));

test('source edits create a new event only when inputs change; metadata-only edits do not',()=>isolated(async()=>{
  const done=complete(measurement());const hash=done.progress_event.id;
  update({id:done.id,handoff:done.handoff});assert.equal(item(done.id).progress_event.id,hash);
  const [p]=planProgress();assert.ok(p);
  update({id:p.id,status:'cancelled',handoff:'fixture cancellation; no retry'});
  update({id:done.id,handoff:'New synthetic data batch, different conditions'});
  assert.notEqual(item(done.id).progress_event.id,hash);
  assert.equal(planProgress().length,1);assert.deepEqual(planProgress(),[]);
}));

test('HTTP user completion crosses the real endpoint into planning and CLI-created open steps with inherited provenance',()=>isolated(async()=>{
  const m=measurement(),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/task-update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id,status:'done',handoff:'Synthetic raw-data batch; unit V, test sample TEST'})});
    assert.equal(response.status,200);assert.ok(item(m.id).progress_event);
    let calls=0,proposal;
    await drain(async(_provider,prompt)=>{
      calls++;const plan=read('work/queue.json').items.find(i=>i.autonomy?.type==='plan');
      assert.match(prompt,/自主判断/);assert.match(prompt,new RegExp(m.id));assert.equal(item(plan.id).status,'active');
      proposal=cliOK('add',child({sources:['work:'+m.id]}),plan);
      assert.notEqual(cli('add',child({status:'queued'}),plan).status,0);
      update({id:plan.id,status:'done',handoff:'Created the next useful synthetic analysis proposal; L1 leaves it open.'});
      return {result:'Created the next useful synthetic analysis proposal; L1 leaves it open.'};
    });
    assert.equal(calls,1);assert.equal(item(proposal.id).status,'open');
    const plan=read('work/queue.json').items.find(i=>i.autonomy?.type==='plan');
    assert.equal(proposal.autonomy.event_hash,plan.autonomy.event_hash);assert.equal(proposal.autonomy.parent_id,plan.id);
    assert.equal(proposal.autonomy.deliverable,child().deliverable);
    assert.equal(item(m.id).actor,'user');
  } finally {await new Promise(r=>server.close(r));}
}));

test('L2: queued A work runs, but user experiments and assistant-disguised non-A work remain open',()=>isolated(async()=>{
  setPolicy({level:2});
  for(const extra of [{actor:'user',kind:'experiment'},{actor:'codex',kind:'experiment'},{kind:'decision'}])
    assert.throws(()=>enqueue(child({...extra,status:'queued'}),{autonomous:true}),/非 A 档/);
  const suggestion=enqueue(child({kind:'experiment',actor:'user'}),{autonomous:true});assert.equal(suggestion.status,'open');
  assert.throws(()=>update({id:suggestion.id,status:'queued'}),/非 A 档/);
  const a=enqueue(child({status:'queued'}),{autonomous:true});
  let calls=0;await drain(async()=>{calls++;update({id:a.id,status:'done',handoff:'Synthetic A work complete'});return {result:'Synthetic A work complete'};});
  assert.equal(calls,1);assert.equal(item(a.id).status,'done');assert.ok(item(a.id).autonomy.started_at);
  assert.equal(item(a.id).progress_event,undefined,'assistant results cannot recharge autonomous planning');
  assert.equal(item(suggestion.id).status,'open');
}));

test('L2 depth is inherited from actual current task, never supplied by caller; L3 relaxes via config alone',()=>isolated(async()=>{
  setPolicy({level:2});
  const a=enqueue(child({status:'queued'}),{autonomous:true});
  update({id:a.id,status:'active'},{executionOwner:{pid:process.pid}});
  assert.notEqual(cli('add',child({status:'queued'}),a).status,0);
  const held=cliOK('add',child(),a);assert.equal(held.autonomy.depth,2);
  setPolicy({level:3});
  const second=cliOK('add',child({status:'queued'}),a);assert.equal(second.autonomy.depth,2);
  assert.notEqual(cli('add',child({project_ids:['bi-devices']}),a).status,0);
}));

test('dispatch enforces per-project running and daily run caps, also after sessions already exist',()=>isolated(async()=>{
  setPolicy({level:2,daily_runs:1});
  const a=enqueue(child({status:'queued'}),{autonomous:true}),b=enqueue(child({title:'second fixture',status:'queued'}),{autonomous:true});
  assert.equal(startReadyWork().length,2);
  let calls=0;await drain(async()=>{calls++;assert.equal(autonomousCanStart(item(b.id),read('work/queue.json').items),false);update({id:a.id,status:'done',handoff:'one fixture result'});return {result:'one fixture result'};});
  assert.equal(calls,1);assert.equal(item(a.id).status,'done');assert.equal(item(b.id).status,'queued');
  const held=workSnapshot().items.find(i=>i.id===b.id);assert.equal(held.ready,false);assert.match(held.autonomy_blocked,/额度/);
  assert.equal(agentWorkBusy(),false,'held autonomous backlog must not freeze unrelated background maintenance');
  assert.equal(autonomousCanStart(item(b.id),read('work/queue.json').items,Date.now()+86400000),true,'local-day rollover releases the daily cap without replanning');
  await drain(async()=>{throw Error('daily cap must survive another tick');});
  setPolicy({daily_runs:2});await drain(async()=>{update({id:b.id,status:'done',handoff:'second fixture result'});return {result:'second fixture result'};});assert.equal(item(b.id).status,'done');
}));

test('lowering authority after dispatch prevents start, but permits an admitted run to finish',()=>isolated(async()=>{
  setPolicy({level:2});const a=enqueue(child({status:'queued'}),{autonomous:true});assert.equal(startReadyWork().length,1);
  setPolicy({level:1});assert.equal(autonomousCanStart(item(a.id),read('work/queue.json').items),false);
  await drain(async()=>{throw Error('L1 must hold previously dispatched A work');});assert.equal(item(a.id).status,'queued');
  setPolicy({level:2});update({id:a.id,status:'active'},{executionOwner:{pid:process.pid}});
  setPolicy({level:1});update({id:a.id,status:'done',handoff:'admitted before downgrade'});assert.equal(item(a.id).status,'done');
}));

test('pending cap, archive and disabled controller do not lose source events; failed planners are not retried',()=>isolated(async()=>{
  setPolicy({per_project_pending:1});enqueue(child(),{autonomous:true});assert.throws(()=>enqueue(child(),{autonomous:true}),/待处理上限/);
  const m=complete(measurement());const c=read('projects/catalog.json');c.projects.find(p=>p.id===project).archived_at=new Date().toISOString();write('projects/catalog.json',c);
  assert.deepEqual(planProgress(),[]);delete c.projects.find(p=>p.id===project).archived_at;write('projects/catalog.json',c);
  const config=read('agent/config.json');write('agent/config.json',{...config,enabled:false});await drain(async()=>{throw Error('disabled');});
  assert.equal(read('work/queue.json').items.length,2);write('agent/config.json',config);
  const [plan]=planProgress();assert.ok(plan);await drain(async()=>{throw Error('synthetic model failure');});
  assert.equal(item(plan.id).status,'failed');assert.deepEqual(planProgress(),[]);assert.ok(item(m.id).progress_event);
}));

test('missing or invalid policy fails closed, and L0 never plans',()=>isolated(async()=>{
  setPolicy({level:0});complete(measurement());assert.deepEqual(planProgress(),[]);
  assert.throws(()=>enqueue(child(),{autonomous:true}),/关闭/);
  setPolicy({level:2,daily_runs:0});assert.throws(()=>autonomyPolicy(),/正整数/);
  const direct=submit({text:'@Codex direct fixture despite invalid autonomy config'});
  await drain(async()=>({result:'Direct fixture completed'}));assert.equal(item(direct.task_id).status,'done');
}));

// Dynamic exploration uses explicit scheduling, not prose markers or file mtimes.
test('a continue marker and a new file do not silently schedule a second execution',()=>isolated(async()=>{
  const operation=enqueue({title:'synthetic exploration',kind:'data',actor:'claude',status:'queued',project_ids:[project]});
  const file=path.join(root,'.runtime','explicit-exploration.md');let calls=0;
  await drain(async()=>{calls++;fs.writeFileSync(file,'a new observation');return {result:`Observation saved at ${file}\n续跑：Investigate it`};});
  await drain(async()=>{throw Error('prose must not schedule another model call');});
  assert.equal(calls,1);assert.equal(item(operation.id).status,'open');
  assert.deepEqual(item(operation.id).outputs,[]);assert.notEqual(item(operation.id).review?.state,'pending');
  const history=workSnapshot().items.find(i=>i.id===operation.id).execution_history;
  assert.equal(history.length,1);assert.equal(history[0].status,'done');assert.equal(history[0].outcome_status,'open');
}));

test('an explicit next execution appends a turn and retains prior results until a new submission',()=>isolated(async()=>{
  const operation=enqueue({title:'synthetic cyclic operation',kind:'data',actor:'claude',status:'queued',project_ids:[project]});
  await drain(async()=>{update({id:operation.id,status:'done',handoff:'First accepted observation.'});return {result:'First accepted observation.'};});
  const first=item(operation.id),run=repeatOperation({id:operation.id,input:'A new input changes the next question.'});
  assert.equal(item(operation.id).status,'done');assert.equal(item(operation.id).handoff,first.handoff);
  assert.equal(run.operation_id,operation.id);assert.equal(run.status,'queued');
  await drain(async(_provider,prompt)=>{
    assert.match(prompt,/A new input changes the next question/);
    assert.equal(item(operation.id).status,'done');
    update({id:operation.id,status:'done',handoff:'Second accepted observation.'});
    return {result:'Second accepted observation.'};
  });
  const history=workSnapshot().items.find(i=>i.id===operation.id).execution_history;
  assert.equal(history.length,2);assert.equal(history[0].handoff,'First accepted observation.');
  assert.equal(history[1].handoff,'Second accepted observation.');assert.equal(history[1].status,'done');
  assert.equal(item(operation.id).handoff,'Second accepted observation.');
  assert.equal(autonomyPolicy().level,1,'explicit execution does not change global autonomy policy');
}));

test('a user cancellation is preserved when the native reply arrives later',()=>isolated(async()=>{
  const operation=enqueue({title:'synthetic interrupted operation',kind:'data',actor:'claude',status:'queued',project_ids:[project]});
  await drain(async()=>{update({id:operation.id,status:'cancelled',handoff:'用户停止'});return {result:'late native observation\n续跑：ignore this marker'};});
  assert.equal(item(operation.id).status,'cancelled');assert.equal(item(operation.id).handoff,'用户停止');
  const history=workSnapshot().items.find(i=>i.id===operation.id).execution_history;
  assert.equal(history.length,1);assert.match(history[0].handoff,/late native observation/);
  assert.equal(history[0].outcome_status,'cancelled');
  await drain(async()=>{throw Error('a cancelled operation must not restart');});
}));

test('the last finished step of a log topic triggers the planner whoever owns it; planner-born steps do not',()=>isolated(async()=>{
  setPolicy({debounce_seconds:0});
  const step=extra=>enqueue({title:'synthetic assistant step',kind:'data',actor:'codex',status:'queued',project_ids:[project],plan_node_id:'topic-y',require_outputs:false,...extra});
  const a=step(),b=step();
  const doneA=setStepStatus({id:a.id,status:'done',handoff:'Synthetic result A',outputs:[]});
  assert.ok(doneA.progress_event,'assistant step finishing yields an event');
  assert.deepEqual(planProgress(Date.parse(doneA.progress_event.at)+1000),[],'topic still has an unfinished step');
  const doneB=setStepStatus({id:b.id,status:'done',handoff:'Synthetic result B',outputs:[]});
  const [plan]=planProgress(Date.parse(doneB.progress_event.at)+1000);
  assert.ok(plan,'the last step of the topic fires the planner');assert.equal(plan.autonomy.events.length,2);
  const born=enqueue(child({status:'open',plan_node_id:'topic-z'}),{autonomous:true});
  const doneBorn=setStepStatus({id:born.id,status:'done',handoff:'Synthetic planner-born result',outputs:[]});
  assert.equal(doneBorn.progress_event,undefined,'steps born from planning do not chain');
}));
