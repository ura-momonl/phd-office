import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {enqueue,update,repeatOperation,workSnapshot,workOverview,readiness} from './run.mjs';
import {drain} from '../agent/run.mjs';
import {addEntry,parseFramework} from '../projects/framework.mjs';
import {SYSTEM_PROMPT} from '../agent/native.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const item=id=>read('work/queue.json').items.find(i=>i.id===id);
const step=(title,extra={})=>enqueue({title,kind:'framework',actor:'claude',...extra});
const fixture=name=>{const file=path.join(root,'.runtime',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name);return file;};
async function isolated(fn) {
  const files=['work/queue.json','.runtime/agent/sessions.json','agent/config.json'],saved=Object.fromEntries(files.map(f=>[f,read(f)]));
  const artifacts=['FRAMEWORK.md','STATUS.md'].map(name=>path.join(root,'workspace/projects/bi-devices',name));
  const originals=artifacts.map(file=>fs.existsSync(file) ? fs.readFileSync(file) : null);
  write('work/queue.json',{version:1,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...saved['agent/config.json'],enabled:true,memory_v2:{enabled:false}});
  try {await fn();} finally {
    for(const [file,value] of Object.entries(saved))write(file,value);
    artifacts.forEach((file,i)=>{if(originals[i])fs.writeFileSync(file,originals[i]);else fs.rmSync(file,{force:true});});
  }
}

test('child operations inherit filing, while explicit filing overrides remain independent',()=>isolated(async()=>{
  const parent=step('owner',{project_ids:['bi-devices'],plan_node_id:'graph-topic'});
  const child=step('inherited',{parent_id:parent.id});
  assert.deepEqual(child.project_ids,parent.project_ids);assert.equal(child.plan_node_id,'graph-topic');
  assert.deepEqual(child.dependencies,[]);assert.equal(item(parent.id).status,'open');
  assert.equal(step('own topic',{parent_id:parent.id,plan_node_id:'another-topic'}).plan_node_id,'another-topic');
  const unfiled=step('separate filing',{parent_id:parent.id,project_ids:[]});
  assert.deepEqual(unfiled.project_ids,[]);assert.equal(unfiled.plan_node_id,undefined);
  assert.equal(step('clear topic',{parent_id:parent.id,plan_node_id:null}).plan_node_id,undefined);
}));

test('a registered return waits for the latest execution, including failed or incomplete outcomes',()=>{
  const child={id:'child',status:'done'},run={id:'child-run',operation_id:child.id,status:'queued'},other={id:'other',status:'active'};
  const parent={id:'parent-run',status:'queued',after:[child.id,other.id]},items=[child,run,other,parent];
  assert.deepEqual(readiness(parent,items).blocked_by,['child','other']);
  run.status='done';run.outcome_status='open';
  assert.deepEqual(readiness(parent,items).blocked_by,['other']);
  other.status='failed';assert.equal(readiness(parent,items).ready,true);
  run.status='cancelled';assert.equal(readiness(parent,items).ready,true);
  parent.after=[run.id];run.status='active';assert.equal(readiness(parent,items).ready,false);
  run.status='failed';assert.equal(readiness(parent,items).ready,true);
});

test('a registered operation also waits for sub-operations still running, at any depth, but not for ones that cannot start',()=>{
  const branch={id:'branch',status:'done'},next={id:'next',parent_id:'branch',status:'queued',dependencies:[]},
    deeper={id:'deeper',parent_id:'next',status:'open'},stuck={id:'stuck',parent_id:'branch',status:'queued',dependencies:['bad']},
    bad={id:'bad',status:'failed'},userStep={id:'user-step',parent_id:'branch',status:'waiting_user'},
    parent={id:'parent-run',status:'queued',after:['branch']},items=[branch,next,deeper,stuck,bad,userStep,parent];
  assert.deepEqual(readiness(parent,items).blocked_by,['next']);
  next.status='done';deeper.status='active';assert.deepEqual(readiness(parent,items).blocked_by,['deeper']);
  deeper.status='failed';assert.equal(readiness(parent,items).ready,true);
  deeper.status='queued';parent.after=['branch','next'];assert.deepEqual(readiness(parent,items).blocked_by,['deeper']);
});

test('returning a specific execution retains its registered outcome, not a newer operation result',()=>isolated(async()=>{
  const child=step('source',{status:'queued'}),original=fixture('graph-specific-original.csv');
  await drain(async(_provider,_prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    update({id:child.id,status:'done',handoff:'Original registered observation.',outputs:[original]});
    return {result:'A different conversational reply.'};
  });
  const history=workSnapshot().items.find(i=>i.id===child.id).last_execution;
  assert.equal(history.outcome_handoff,'Original registered observation.');
  update({id:child.id,status:'done',handoff:'A newer registered observation.',outputs:[]});
  const parent=step('receiver');repeatOperation({id:parent.id,input:'Read the selected execution.',after:[history.id]});
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.ok(prompt.includes('已登记结果：Original registered observation.'));
    assert.ok(prompt.includes('本轮说明：A different conversational reply.'));
    assert.ok(prompt.includes(original));assert.ok(!prompt.includes('A newer registered observation.'));
    update({id:parent.id,status:'done',handoff:'Selected result consumed.',outputs:[]});return {result:'Received.'};
  });
  assert.equal(item(parent.id).status,'done');
}));

test('parent delegates, receives a failed branch in its own conversation, and files the research result',()=>isolated(async()=>{
  const file=path.join(root,'workspace/projects/bi-devices/FRAMEWORK.md');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'# Graph fixture\n\n## Branch topic\n<!--node {"id":"graph-topic","type":"timeline"}-->\n\n## Current interpretation\n<!--node {"id":"graph-current","type":"timeline","summary":"current framework context marker"}-->\n');
  const parent=step('interpretation owner',{status:'queued',project_ids:['bi-devices'],plan_node_id:'graph-topic',goal:'parent research objective marker',sources:['parent evidence marker']});
  const successor=step('use final interpretation',{status:'queued',project_ids:['bi-devices'],dependencies:[parent.id]});
  const comparisonFile=fixture('graph-reference.csv');
  let child,comparison,returned,parentSession;
  const invoke=(action,body,task)=>{
    const request=path.join(root,'.runtime/graph-link-'+action+'.json');fs.writeFileSync(request,JSON.stringify(body));
    return JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work',action,request],{cwd:root,encoding:'utf8',env:{...process.env,OFFICE_MEMORY_OWNER:'claude',OFFICE_MEMORY_RUN_DIR:path.join(root,'.runtime/agent/runs',task)}}));
  };
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.match(SYSTEM_PROMPT,/本操作一旦调用子 DCG，父 agent 就以统筹为主/);
    assert.match(SYSTEM_PROMPT,/未调用子 DCG 的任务仍直接完成/);
    assert.ok(!prompt.includes('本操作一旦调用子 DCG'));
    child=invoke('add',{title:'test evidence branch',kind:'framework',actor:'claude',parent_id:parent.id},parent.id);
    comparison=invoke('add',{title:'reference comparison',kind:'framework',actor:'codex',parent_id:parent.id},parent.id);
    assert.equal(child.status,'queued');assert.deepEqual(child.project_ids,['bi-devices']);assert.equal(child.plan_node_id,'graph-topic');
    returned=invoke('run',{id:parent.id,input:'Choose the next interpretation using the returned evidence.',after:[child.id,comparison.id]},parent.id);
    assert.equal(item(parent.id).status,'active');assert.equal(readiness(item(returned.id),read('work/queue.json').items).ready,false);
    return {result:'The branch is delegated; the parent result is not submitted yet.'};
  });
  parentSession=read('.runtime/agent/sessions.json').sessions.find(s=>s.task_ids.includes(parent.id)).id;
  assert.equal(item(parent.id).status,'open');assert.equal(readiness(item(successor.id),read('work/queue.json').items).ready,false);
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.ok(prompt.includes('父操作目标：parent research objective marker'));assert.ok(prompt.includes('parent evidence marker'));
    assert.ok(prompt.includes('当前阶段：Branch topic（graph-topic）'));
    if(prompt.includes('本操作 ID：'+comparison.id)) {
      assert.equal(readiness(item(returned.id),read('work/queue.json').items).ready,false);
      update({id:comparison.id,status:'done',handoff:'Reference comparison is available.',outputs:[comparisonFile]});
      return {result:'The reference result is explicitly submitted.'};
    }
    update({id:child.id,status:'failed',handoff:'The proposed explanation disagrees with the reference measurement.',outputs:[]});
    return {result:'The branch produced a negative result.'};
  });
  assert.equal(item(child.id).handoff,'The proposed explanation disagrees with the reference measurement.');
  assert.equal(item(parent.id).status,'open');
  update({id:parent.id,plan_node_id:'graph-current'});
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.ok(prompt.includes('当前阶段：Current interpretation（graph-current）'));
    assert.match(SYSTEM_PROMPT,/父 agent 可以为判断读取证据、抽查结果和做少量衔接/);
    assert.match(SYSTEM_PROMPT,/持续的具体执行工作由子操作承接/);
    assert.ok(!prompt.includes('持续的具体执行工作由子操作承接'));
    assert.ok(prompt.includes('current framework context marker'));
    assert.ok(prompt.includes('本轮结果状态：failed'));
    assert.ok(prompt.includes('disagrees with the reference measurement'));
    assert.ok(prompt.includes('Reference comparison is available.'));assert.ok(prompt.includes(comparisonFile));
    assert.equal(fs.readFileSync(comparisonFile,'utf8'),'graph-reference.csv');
    assert.ok(prompt.includes('Choose the next interpretation'));
    const log=addEntry('bi-devices',{parent:'graph-current',title:'Interpretation after branch comparison',body:'The reference comparison rejects the proposed explanation.',work:[parent.id]});
    invoke('update',{id:parent.id,status:'done',handoff:'The interpretation is recorded in '+log.id,outputs:[file]},returned.id);
    return {result:'The parent research conclusion is explicitly submitted.'};
  });
  const sessions=read('.runtime/agent/sessions.json').sessions;
  assert.equal(sessions.find(s=>s.task_ids.includes(returned.id)).id,parentSession);
  assert.equal(item(parent.id).status,'done',item(returned.id).handoff);assert.equal(item(returned.id).outcome_status,'done');
  assert.equal(readiness(item(successor.id),read('work/queue.json').items).ready,true);
  assert.equal(workSnapshot().items.find(i=>i.id===parent.id).execution_history.length,2);
  const log=parseFramework(fs.readFileSync(file,'utf8')).nodes.find(n=>n.meta.work?.includes(parent.id));
  assert.equal(log.parent.id,'graph-current');assert.ok(log.body.includes('rejects the proposed explanation'));
  assert.ok(fs.readFileSync(path.join(root,'workspace/projects/bi-devices/STATUS.md'),'utf8').includes(item(parent.id).handoff));
  update({id:successor.id,status:'done',handoff:'The final interpretation was consumed.',outputs:[]});
  let extra=0;await drain(async()=>{extra++;return {result:'Unexpected execution'};});assert.equal(extra,0);
}));

test('parent grouping is not a dependency; only explicit delivery releases a DAG successor',()=>isolated(async()=>{
  const parent=step('analysis owner'),a=step('inspect',{status:'queued',parent_id:parent.id}),b=step('compare',{status:'queued',parent_id:parent.id,dependencies:[a.id]});
  assert.equal(readiness(a,read('work/queue.json').items).ready,true);
  const result=fixture('graph-result.csv');let calls=0;
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};calls++;
    assert.ok(prompt.includes(a.id));assert.equal(item(parent.id).status,'open');
    update({id:a.id,status:'done',handoff:'Comparison input ready',outputs:[result]});
    return {result:'Ready; only this registered file is delivered.'};
  });
  assert.equal(calls,1);assert.equal(item(a.id).status,'done');assert.equal(item(parent.id).status,'open');
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};calls++;
    assert.ok(prompt.includes(result));assert.equal(fs.readFileSync(result,'utf8'),'graph-result.csv');
    update({id:b.id,status:'done',handoff:'Comparison finished',outputs:[]});return {result:'Finished.'};
  });
  assert.equal(calls,2);assert.equal(item(b.id).status,'done');assert.equal(item(parent.id).status,'open');
  assert.equal(workSnapshot().items.filter(i=>!i.turn).length,3,'execution history does not add operation nodes');
}));

test('a reply, prose paths, file events and continue text do not submit or reschedule an operation',()=>isolated(async()=>{
  const a=step('unfinished analysis',{status:'queued'}),existing=fixture('not-delivered.csv');let calls=0;
  await drain(async(_provider,_prompt,opts)=>{if(opts.purpose==='title')return {result:''};calls++;return {result:`Complete: ${existing}\n续跑：inspect more`,artifacts:[existing]};});
  assert.equal(item(a.id).status,'open');assert.deepEqual(item(a.id).outputs,[]);assert.notEqual(item(a.id).review?.state,'pending');
  const view=workSnapshot().items.find(i=>i.id===a.id),run=view.last_execution;
  assert.equal(run.status,'done');assert.equal(run.outcome_status,'open');assert.ok(run.handoff.includes(existing));
  assert.ok(workOverview().needs_attention.some(s=>s.includes('未提交完成')));
  await drain(async()=>{throw new Error('No automatic retry');});assert.equal(calls,1);
  const receipt=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work','handoff',a.id],{cwd:root,encoding:'utf8'}));
  assert.equal(receipt.execution_history.length,1);assert.equal(receipt.last_execution.outcome_status,'open');
}));

test('explicit repeated execution preserves the operation result and appends turns in the same conversation',()=>isolated(async()=>{
  const a=step('iterative interpretation',{status:'queued'}),first=fixture('first-result.csv'),second=fixture('second-result.csv');
  await drain(async(_provider,_prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    update({id:a.id,status:'done',handoff:'First interpretation',outputs:[first]});return {result:'First pass delivered.'};
  });
  const request=path.join(root,'.runtime/graph-repeat.json');fs.writeFileSync(request,JSON.stringify({id:a.id,input:'Revisit the interpretation using the new measurement setting.'}));
  const run=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work','run',request],{cwd:root,encoding:'utf8'}));
  assert.equal(item(a.id).status,'done');assert.deepEqual(item(a.id).outputs,[first]);assert.equal(run.operation_id,a.id);
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.ok(prompt.includes('new measurement setting'));assert.ok(prompt.includes('本操作 ID：'+a.id));
    assert.equal(item(a.id).status,'done');assert.deepEqual(item(a.id).outputs,[first]);
    update({id:a.id,status:'done',handoff:'Second interpretation',outputs:[second]});return {result:'Second pass delivered.'};
  });
  let view=workSnapshot().items.find(i=>i.id===a.id);
  assert.equal(view.status,'done');assert.equal(view.execution_history.length,2);
  assert.deepEqual(view.execution_history.map(r=>r.outputs),[[first],[second]]);
  assert.equal(view.execution_history[1].id,run.id);assert.equal(view.execution_history[1].outcome_status,'done');
  assert.equal(read('.runtime/agent/sessions.json').sessions.length,1,'same operation keeps its conversation');
  repeatOperation({id:a.id,input:'Consider another route without declaring completion yet.'});
  await drain(async(_provider,_prompt,opts)=>opts.purpose==='title'?{result:''}:{result:'This pass is incomplete.'});
  view=workSnapshot().items.find(i=>i.id===a.id);
  assert.equal(view.status,'open');assert.deepEqual(view.outputs,[second]);assert.equal(view.handoff,'Second interpretation');
  assert.equal(view.execution_history.length,3);assert.equal(view.last_execution.outcome_status,'open');
  const turns=JSON.parse(fs.readFileSync(path.join(root,'work/turns.json'),'utf8')).items;
  assert.equal(turns.filter(r=>r.operation_id===a.id).length,3);assert.ok(turns.filter(r=>r.operation_id===a.id).every(r=>r.status==='done'));
}));

test('failed, retried and later operation requests retain evidence without replaying standing mechanics',()=>isolated(async()=>{
  const source=step('existing observation');
  update({id:source.id,status:'done',handoff:'evidence marker',outputs:[]});
  const operation=step('retry fixture',{status:'queued',goal:'authorized objective marker',dependencies:[source.id]});
  let calls=0;
  const inspect=(prompt,opts)=>{
    assert.ok(prompt.includes('本操作 ID：'+operation.id));
    assert.ok(prompt.includes('authorized objective marker'));assert.ok(prompt.includes('evidence marker'));
    assert.ok(!prompt.includes('本操作一旦调用子 DCG'));
    assert.ok(!prompt.includes('用 work update <UTF-8 JSON文件路径> 一次提交'));
    assert.ok(!prompt.includes('最终回复简要说明'));
    assert.equal(opts.inputParts.map(p=>p.text).join('\n'),prompt);
    calls++;
  };
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    inspect(prompt,opts);throw new Error('capacity failure fixture');
  });
  assert.equal(item(operation.id).status,'failed');
  for(const direction of ['retry direction marker','later direction marker']) {
    const run=repeatOperation({id:operation.id,input:direction});
    await drain(async(_provider,prompt,opts)=>{
      if(opts.purpose==='title')return {result:''};
      inspect(prompt,opts);
      assert.ok(prompt.includes('本次执行 ID：'+run.id));assert.ok(prompt.includes(direction));
      if(direction==='retry direction marker')assert.ok(prompt.includes('capacity failure fixture'),'failure evidence remains in history');
      update({id:operation.id,status:'done',handoff:direction,outputs:[]});return {result:'Submitted fixture result.'};
    });
  }
  assert.equal(calls,3);assert.equal(item(operation.id).status,'done');
  const session=read('.runtime/agent/sessions.json').sessions.find(s=>s.task_ids.includes(operation.id));
  assert.equal(session.messages.filter(m=>m.role==='user').length,3,'all original requests remain in history');
}));

test('a native child command can submit the repeated operation and add an authorized child under the same graph',()=>isolated(async()=>{
  const a=step('native repeat',{project_ids:['bi-devices']});
  update({id:a.id,status:'done',handoff:'Existing result',outputs:[]});
  const run=repeatOperation({id:a.id,input:'Explore one new branch.'});
  let child;
  await drain(async(_provider,_prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    const env={...process.env,OFFICE_MEMORY_OWNER:'claude',OFFICE_MEMORY_RUN_DIR:path.join(root,'.runtime/agent/runs',run.id)};
    const invoke=(action,body)=>{
      const file=path.join(root,'.runtime/graph-native-'+action+'.json');fs.writeFileSync(file,JSON.stringify(body));
      return JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work',action,file],{cwd:root,encoding:'utf8',env}));
    };
    child=invoke('add',{title:'new evidence branch',kind:'framework',actor:'codex',project_ids:['bi-devices'],parent_id:a.id,status:'open'});
    assert.equal(child.status,'queued');assert.equal(child.parent_id,a.id);assert.equal(child.delegated_by,run.id);
    invoke('update',{id:a.id,status:'done',handoff:'Native submission',outputs:[]});
    return {result:'Submitted from a native command.'};
  });
  assert.equal(item(a.id).handoff,'Native submission');assert.equal(item(run.id).outcome_status,'done');assert.equal(item(child.id).status,'queued');
}));
