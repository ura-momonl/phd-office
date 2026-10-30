import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {enqueue,update,repeatOperation,readiness,workSnapshot,workOverview,stepEditor,editStep} from './run.mjs';
import {drain,startReadyWork,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {taskPrompt,dataAnalysisMode} from '../prompts/templates.mjs';
import {workGraph} from '../dashboard/workspace.js';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const get=id=>read('work/queue.json').items.find(i=>i.id===id);
const items=()=>read('work/queue.json').items;
const file=(name,body=name)=>{const p=path.join(root,'.runtime/result-review-fixtures',name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);return p;};
const source=(extra={})=>enqueue({title:'Research objective',goal:'Compare two explanations using the measurements.',kind:'data',actor:'codex',result_review:true,...extra});
const deliver=(id,output,handoff='Evidence-backed integrated finding.')=>update({id,status:'done',handoff,outputs:[output]});
const verdict=(review,decision='pass')=>update({id:review,status:'done',review_verdict:decision,handoff:decision==='pass' ? 'The stated claim is supported by raw evidence.' : 'The comparison omitted one measurement group.',outputs:[file(review+'.md')]});
async function isolated(fn) {
  const names=['work/queue.json','work/turns.json','.runtime/agent/sessions.json','agent/config.json'];
  const saved=Object.fromEntries(names.map(name=>[name,read(name)]));
  write('work/queue.json',{version:1,items:[]});write('work/turns.json',{version:1,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...saved['agent/config.json'],enabled:true,memory_v2:{enabled:false}});
  try {await fn();} finally {for(const [name,value] of Object.entries(saved))write(name,value);}
}
const ready=id=>readiness(get(id),items()).ready;

test('review execution includes its frozen delivery once rather than repeating live dependency evidence',()=>isolated(async()=>{
  const parent=source(),output=file('single-review-input.csv');
  deliver(parent.id,output,'UNIQUE_FROZEN_DELIVERY_TEXT');
  const review=get(get(parent.id).result_review.review_id);
  startReadyWork();let called=false;
  await executeWithoutTitle(executeAgent)(review.id,async(_,prompt)=>{
    called=true;
    assert.equal(prompt.split('UNIQUE_FROZEN_DELIVERY_TEXT').length-1,1);
    assert.equal(prompt.split(output).length-1,1);
    assert.ok(prompt.includes('SHA256='),'the frozen output hash remains available');
    assert.ok(prompt.includes(parent.goal));assert.ok(prompt.includes('不读取仪器原始文件'));
    verdict(review.id);
    return {result:'Fixture review complete.'};
  });
  assert.ok(called);assert.equal(get(parent.id).result_review.state,'pass');
}));

test('review is opt-in, outer-level, and absent from ordinary child DCGs',()=>isolated(async()=>{
  const parent=source(),child=enqueue({title:'Choose an analysis route',kind:'data',actor:'claude',parent_id:parent.id});
  assert.equal(child.result_review,undefined);assert.equal(items().filter(i=>i.review_target).length,0);
  assert.throws(()=>source({parent_id:parent.id}),/外层/);
  assert.throws(()=>source({result_review:{actor:'user'}}),/审查者/);
  assert.throws(()=>source({result_review:{actor:'deepseek',effort:'medium'}}),/推理/);
  assert.throws(()=>source({result_review:{state:'accepted'}}),/result_review/);
  assert.throws(()=>update({id:parent.id,result_review:{state:'accepted'}}),/程序记录/);
  assert.throws(()=>update({id:parent.id,parent_id:child.id}),/外层/);
  const plain=source({result_review:false}),next=enqueue({title:'Use plain output',kind:'framework',actor:'codex',status:'queued',dependencies:[plain.id]});
  deliver(plain.id,file('plain.csv'));assert.equal(ready(next.id),true);assert.equal(items().filter(i=>i.review_target).length,0);
}));

test('only integrated delivery creates a sibling reviewer, a return, and a blocked downstream boundary',()=>isolated(async()=>{
  const parent=source({result_review:{actor:'claude',model:'sonnet',effort:'high'}});
  const downstream=enqueue({title:'Consume the research result',kind:'framework',actor:'codex',dependencies:[parent.id],status:'queued'});
  const unrelated=enqueue({title:'Independent task',kind:'framework',actor:'codex',status:'queued'});
  const child=enqueue({title:'An independently chosen subproblem',kind:'data',actor:'codex',parent_id:parent.id,status:'queued'});
  assert.throws(()=>deliver(parent.id,file('whole.csv')),/子操作/);assert.equal(items().filter(i=>i.review_target).length,0);
  deliver(child.id,file('child.csv'));deliver(parent.id,file('whole.csv'));
  const reviewed=get(parent.id),review=get(reviewed.result_review.review_id),returned=items().find(i=>i.review_return_for===review.id);
  assert.equal(review.parent_id,undefined);assert.deepEqual(review.dependencies,[parent.id]);
  assert.equal(review.actor,'claude');assert.equal(review.model,'sonnet');assert.equal(review.effort,'high');
  assert.deepEqual(returned.after,[review.id]);assert.equal(returned.operation_id,parent.id);
  assert.equal(ready(review.id),true);assert.equal(ready(returned.id),false);assert.equal(ready(downstream.id),false);
  assert.equal(ready(unrelated.id),true);assert.equal(get(unrelated.id).status,'queued');
  assert.equal(get(child.id).parent_id,parent.id);assert.equal(get(child.id).result_review,undefined);
  const count=items().length;deliver(parent.id,get(parent.id).outputs[0]);assert.equal(items().length,count);
  assert.ok(workOverview().needs_attention.some(line=>line.includes('待独立审查')));
  assert.ok(review.goal.includes('外层 DAG'));assert.ok(review.goal.includes(parent.goal));
  assert.ok(taskPrompt(get(parent.id),'',null).includes('子 DCG 继续按研究问题自主拆分与执行'));
}));

test('review receives a demanding PI brief and deliverables, not a raw-data audit assignment',()=>isolated(async()=>{
  const parent=source({sources:['raw-data/never-read-this-file.csv']});
  deliver(parent.id,file('pi-result.csv'));
  const review=get(get(parent.id).result_review.review_id);
  assert.ok(review.goal.includes('激进的功利主义 PI'));
  assert.ok(review.goal.includes('不读取仪器原始文件'));assert.ok(review.goal.includes('读最后一步的数据本身'));
  assert.ok(review.goal.includes('分析者没试过的路线'));assert.ok(review.goal.includes('可以很激进'));
  assert.ok(review.goal.includes('文件很多、理由合理，都不是通过理由'));
  assert.ok(!review.goal.includes('never-read-this-file'));
  assert.ok(!review.sources.some(source=>source.includes('raw-data')));
  assert.ok(review.goal.includes('具体缺口') || review.goal.includes('具体问题'));
  assert.ok(review.goal.includes('不要求凑出预定答案'));
  assert.equal(dataAnalysisMode(review),'','PI review does not load the raw-data analyst workflow');
}));

test('the reviewer cannot integrate or approve the parent, including on a repeated review execution',()=>isolated(async()=>{
  const parent=source(),output=file('role.csv');deliver(parent.id,output);
  const review=get(parent.id).result_review.review_id;
  update({id:review,status:'active'});
  const saved=process.env.OFFICE_MEMORY_RUN_DIR;
  try {
    process.env.OFFICE_MEMORY_RUN_DIR=path.join(root,'.runtime/agent/runs',review);
    assert.throws(()=>deliver(parent.id,output),/父级负责人/);
  } finally {if(saved===undefined)delete process.env.OFFICE_MEMORY_RUN_DIR;else process.env.OFFICE_MEMORY_RUN_DIR=saved;}
  verdict(review);
  const again=repeatOperation({id:review,input:'Respond to the parent\u2019s evidence.'});update({id:again.id,status:'active'});
  try {
    process.env.OFFICE_MEMORY_RUN_DIR=path.join(root,'.runtime/agent/runs',again.id);
    assert.throws(()=>deliver(parent.id,output),/父级负责人/);
  } finally {if(saved===undefined)delete process.env.OFFICE_MEMORY_RUN_DIR;else process.env.OFFICE_MEMORY_RUN_DIR=saved;}
}));

test('a completed review needs an explicit verdict; passing still waits for parent integration',()=>isolated(async()=>{
  const parent=source(),output=file('accepted.csv');deliver(parent.id,output);
  const review=get(parent.id).result_review.review_id;
  const downstream=enqueue({title:'Next',kind:'framework',actor:'claude',dependencies:[parent.id],status:'queued'});
  assert.throws(()=>deliver(review,file('no-verdict.md')),/review_verdict/);
  assert.throws(()=>update({id:parent.id,review_verdict:'pass',status:'done'}),/只用于/);
  verdict(review);assert.equal(get(parent.id).result_review.state,'pass');assert.equal(ready(downstream.id),false);
  deliver(parent.id,output);assert.equal(get(parent.id).result_review.state,'accepted');assert.equal(ready(downstream.id),true);
  const count=items().length;deliver(parent.id,output);assert.equal(items().length,count);
}));

test('revision requests go back to the parent; only a new integrated version creates the next review',()=>isolated(async()=>{
  const parent=source(),child=enqueue({title:'Retained subproblem',kind:'data',actor:'claude',parent_id:parent.id});
  deliver(child.id,file('retained.csv'));const output=file('revised.csv','version 1');deliver(parent.id,output);
  const oldReview=get(parent.id).result_review.review_id;verdict(oldReview,'revise');
  assert.throws(()=>deliver(parent.id,output),/要求返工/);
  const count=items().filter(i=>i.review_target).length;assert.equal(count,1);
  fs.writeFileSync(output,'version 2, including the omitted group');deliver(parent.id,output,'Both measurement groups are compared.');
  const next=get(parent.id).result_review.review_id;assert.notEqual(next,oldReview);
  assert.equal(get(child.id).status,'done');assert.equal(items().filter(i=>i.parent_id===parent.id).length,1);
  assert.equal(items().filter(i=>i.review_target).length,2);
  assert.notEqual(get(next).review_target.revision,get(oldReview).review_target.revision);
  assert.throws(()=>verdict(oldReview),/版本已变化/);
  verdict(next);deliver(parent.id,output,'Both measurement groups are compared.');assert.equal(get(parent.id).result_review.state,'accepted');
}));

test('a revision delivers frozen change navigation to the reviewer without rereading old files or copying old claims',()=>isolated(async()=>{
  const parent=source(),changed=file('delta/changed.csv','before'),stable=file('delta/stable.csv','retained');
  const removed=file('delta/removed.csv','old appendix'),added=file('delta/added.csv','new comparison');
  update({id:parent.id,status:'done',handoff:'OLD_FULL_CLAIM_NOT_TO_REPEAT',outputs:[changed,stable,removed]});
  let previous=get(get(parent.id).result_review.review_id);
  assert.ok(!previous.goal.includes('复审导航'));
  verdict(previous.id,'revise');
  previous=get(previous.id);
  const oldHash=previous.review_target.snapshot.outputs.find(o=>o.path===changed).sha256;
  fs.writeFileSync(changed,'after');fs.rmSync(removed);
  update({id:parent.id,status:'done',handoff:'The omitted comparison is now included.',outputs:[changed,stable,added]});
  const current=get(get(parent.id).result_review.review_id);
  assert.equal(previous.review_target.snapshot.outputs.find(o=>o.path===changed).sha256,oldHash);
  assert.notEqual(current.review_target.snapshot.outputs.find(o=>o.path===changed).sha256,oldHash);
  startReadyWork();let received=false;
  await executeWithoutTitle(executeAgent)(current.id,async(_,prompt)=>{
    received=true;
    assert.ok(!prompt.includes('work handoff '+previous.id));
    assert.ok(!prompt.includes(previous.outputs[0]));
    assert.ok(!prompt.includes('判定 revise'));
    assert.ok(prompt.includes('新增的成果路径：\n'+added));
    assert.ok(prompt.includes('内容有变化的成果：\n'+changed));
    assert.ok(prompt.includes('未再列入的成果路径：\n'+removed));
    assert.ok(prompt.includes('哈希未变：1 项'));
    assert.ok(prompt.includes('文字有变化的字段：handoff'));
    assert.ok(!prompt.includes('OLD_FULL_CLAIM_NOT_TO_REPEAT'));
    assert.ok(!prompt.includes(oldHash),'old result contents and hashes are not recopied');
    verdict(current.id);return {result:'Reviewed the revised evidence.'};
  });
  assert.ok(received);assert.equal(get(current.id).status,'done',get(current.id).handoff);
  assert.equal(get(parent.id).result_review.state,'pass');
  assert.equal(items().filter(i=>i.review_target?.id===parent.id).length,2);
}));

test('later review navigation uses the latest completed review of this parent and never inherits its pass',()=>isolated(async()=>{
  const parent=source(),output=file('delta/latest.csv');deliver(parent.id,output);
  const first=get(get(parent.id).result_review.review_id);verdict(first.id,'revise');
  deliver(parent.id,output,'Second interpretation.');const second=get(get(parent.id).result_review.review_id);verdict(second.id);
  // A newer completed review of another operation must not become this baseline.
  const other=source();deliver(other.id,file('delta/other.csv'));const otherReview=get(get(other.id).result_review.review_id);verdict(otherReview.id);
  deliver(parent.id,output,'Third interpretation; unchanged numeric data.');const third=get(get(parent.id).result_review.review_id);
  assert.ok(!third.goal.includes('work handoff '+second.id));assert.ok(!third.goal.includes('判定 pass'));
  assert.ok(!third.goal.includes('work handoff '+first.id));assert.ok(!third.goal.includes(otherReview.id));
  assert.ok(third.goal.includes('哈希未变：1 项'));
  assert.equal(get(parent.id).result_review.state,'pending');
  const count=items().filter(i=>i.review_target?.id===parent.id).length;
  deliver(parent.id,output,'Third interpretation; unchanged numeric data.');
  assert.equal(items().filter(i=>i.review_target?.id===parent.id).length,count);
  assert.equal(get(parent.id).result_review.state,'pending');
}));

test('an unfinished review is not presented as a completed review baseline',()=>isolated(async()=>{
  const parent=source(),output=file('delta/no-verdict.csv');deliver(parent.id,output);
  const first=get(get(parent.id).result_review.review_id);
  fs.writeFileSync(output,'A new submission before the review started.');deliver(parent.id,output,'New evidence.');
  const second=get(get(parent.id).result_review.review_id);
  assert.equal(get(first.id).status,'cancelled');assert.ok(!second.goal.includes('复审导航'));
  assert.equal(get(parent.id).result_review.state,'pending');
}));

test('changed bytes and changed claims cannot inherit a previous pass',()=>isolated(async()=>{
  const parent=source(),output=file('mutation.csv','first');deliver(parent.id,output);
  let review=get(parent.id).result_review.review_id;
  fs.writeFileSync(output,'second');assert.throws(()=>verdict(review),/版本已变化/);
  deliver(parent.id,output);const second=get(parent.id).result_review.review_id;assert.notEqual(second,review);
  verdict(second);fs.writeFileSync(output,'third');deliver(parent.id,output);
  review=get(parent.id).result_review.review_id;assert.notEqual(review,second);assert.equal(get(parent.id).result_review.state,'pending');
  verdict(review);deliver(parent.id,output);assert.equal(get(parent.id).result_review.state,'accepted');
  update({id:parent.id,handoff:'A materially different claim.'});assert.equal(get(parent.id).result_review.state,'configured');
  deliver(parent.id,output,'A materially different claim.');assert.notEqual(get(parent.id).result_review.review_id,review);
}));

test('a restarted or failed reviewer cannot leave an old passing verdict live',()=>isolated(async()=>{
  const parent=source(),output=file('retry.csv');deliver(parent.id,output);
  const review=get(parent.id).result_review.review_id;verdict(review);
  const retry=repeatOperation({id:review,input:'Recheck the disputed evidence.'});
  assert.equal(get(parent.id).result_review.state,'pending');assert.equal(get(review).review_verdict,undefined);
  update({id:retry.id,status:'failed',handoff:'Host interrupted the run.'});
  deliver(parent.id,output);assert.equal(get(parent.id).result_review.state,'pending');
  assert.equal(items().filter(i=>i.review_target).length,1,'no automatic retry');
}));

test('every review execution opens a new conversation, including a re-run of the same review operation',()=>isolated(async()=>{
  const parent=source(),output=file('fresh-session.csv');deliver(parent.id,output);
  const review=get(parent.id).result_review.review_id;
  const first=startReadyWork().find(s=>s.task_id===review);assert.ok(first,'the review starts');
  verdict(review);
  const retry=repeatOperation({id:review,input:'Review again from the stated objective.'});
  const second=startReadyWork().find(s=>s.task_id===retry.id);assert.ok(second,'the re-run starts');
  assert.notEqual(second.session_id,first.session_id,'a re-run does not resume the earlier review conversation');
}));

test('new execution directions are part of the reviewed version, but review-return messages are not',()=>isolated(async()=>{
  const parent=source(),run=repeatOperation({id:parent.id,input:'Compare all groups rather than one selected group.'});
  update({id:run.id,status:'active'});const output=file('directions.csv');deliver(parent.id,output);
  const review=get(parent.id).result_review.review_id;
  assert.ok(get(review).goal.includes('Compare all groups rather than one selected group.'));
  verdict(review);deliver(parent.id,output);assert.equal(get(parent.id).result_review.state,'accepted');
  repeatOperation({id:parent.id,input:'A newly requested comparison.'});assert.equal(get(parent.id).result_review.state,'configured');
}));

test('project editing invalidates an accepted claim without rewriting existing child work',()=>isolated(async()=>{
  const parent=source(),output=file('edit.csv');deliver(parent.id,output);verdict(get(parent.id).result_review.review_id);deliver(parent.id,output);
  // No active process; finish the automatically registered return to model the settled task.
  const returned=items().find(i=>i.review_return_for);update({id:returned.id,status:'done',handoff:'Integrated.',outputs:[]});
  editStep({id:parent.id,revision:stepEditor(parent.id).revision,action:'content',goal:'A changed research question.'});
  assert.equal(get(parent.id).result_review.state,'configured');
}));

test('the actual DAG renderer shows review beside the parent, not inside its child DCG or as completed',()=>isolated(async()=>{
  const parent=source(),child=enqueue({title:'Scientific subproblem',kind:'data',actor:'claude',parent_id:parent.id});
  deliver(child.id,file('visual-child.csv'));deliver(parent.id,file('visual-parent.csv'));
  const review=get(parent.id).result_review.review_id;
  const html=workGraph('fixture',workSnapshot().items);
  assert.ok(html.includes('2 项主操作 · 1 项子操作'));
  assert.ok(html.includes('data-review-target="'+parent.id+'"'));
  assert.ok(html.includes('外层独立审查'));assert.ok(html.includes('待独立审查'));
  assert.match(html,new RegExp('data-step-row="'+parent.id+'"[\\s\\S]*?<button class="fw-chip st-doing'));
  assert.ok(html.includes('data-work-map-node="'+review+'"'));
  assert.ok(html.includes('data-work-dcg="'+parent.id+'"'));
}));

test('actual dispatcher preserves dynamic child DCG, uses a fresh review session, then returns to the original parent',()=>isolated(async()=>{
  const parent=source({status:'queued'}),downstream=enqueue({title:'Use accepted evidence',kind:'framework',actor:'claude',dependencies:[parent.id],status:'queued'});
  const output=file('dispatch.csv'),calls=new Map();let phase=0,children=[],review;
  const runner=async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    const id=prompt.match(/本操作 ID：([0-9a-f-]{36})\r?\n/)?.[1];calls.set(id,(calls.get(id)||0)+1);
    if(id===parent.id) {
      if(phase===0) {
        children=['An angle comparison','An independently chosen control'].map(title=>enqueue({title,kind:'data',actor:'codex',parent_id:parent.id,status:'queued'}));
        repeatOperation({id:parent.id,input:'Integrate the subproblem evidence.',after:children.map(i=>i.id)});phase++;
        return {result:'The research subproblems are in progress.'};
      }
      if(phase===1) {deliver(parent.id,output);phase++;return {result:'Integrated evidence submitted for external review.'};}
      assert.ok(prompt.includes('本版审查判定：pass'));assert.ok(prompt.includes('The stated claim is supported'));
      assert.equal(ready(downstream.id),false);deliver(parent.id,output);phase++;return {result:'Whole delivery integrated.'};
    }
    if(children.some(i=>i.id===id)) {deliver(id,file(id+'.csv'));return {result:'Subproblem evidence.'};}
    if(id===downstream.id) {assert.equal(get(parent.id).result_review.state,'accepted');update({id,status:'done',handoff:'Accepted result consumed.',outputs:[]});return {result:'Consumed.'};}
    review=get(id);assert.equal(review.review_target.id,parent.id);assert.equal(review.parent_id,undefined);
    assert.ok(!opts.inputParts.find(p=>p.kind==='run_context').text.includes('# 数据分析：有用结果与可复用工作模式'));
    verdict(id);return {result:'Independent evidence review passed.'};
  };
  for(let i=0;i<6;i++)await drain(runner);
  assert.equal(phase,3,JSON.stringify(items().map(i=>({title:i.title,id:i.id,status:i.status,operation_id:i.operation_id,handoff:i.handoff,after:i.after})),null,2));assert.equal(get(parent.id).result_review.state,'accepted');assert.equal(get(downstream.id).status,'done');
  assert.equal(calls.get(parent.id),3);for(const child of children)assert.equal(calls.get(child.id),1);assert.equal(calls.get(review.id),1);
  const sessions=read('.runtime/agent/sessions.json').sessions;
  const ownerSession=sessions.find(s=>s.task_ids.includes(parent.id)),reviewSession=sessions.find(s=>s.task_ids.includes(review.id));
  assert.notEqual(ownerSession.id,reviewSession.id);
  assert.equal(ownerSession.task_ids.filter(id=>id===parent.id || get(id)?.operation_id===parent.id).length,3);
  assert.equal(get(review.id).review_verdict,'pass');
  assert.equal(workSnapshot().items.find(i=>i.id===review.id).last_execution.review_verdict,'pass');
  assert.deepEqual(get(parent.id).dependencies,[]);assert.deepEqual(get(review.id).dependencies,[parent.id]);
  let extra=0;await drain(async()=>{extra++;return {result:'unexpected'};});assert.equal(extra,0);
}));
