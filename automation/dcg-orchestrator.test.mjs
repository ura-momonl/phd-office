import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {root,read,write} from './files.mjs';
import {enqueue,update,repeatOperation,readiness,workSnapshot} from '../work/run.mjs';
import {drain} from '../agent/run.mjs';
import {SYSTEM_PROMPT} from '../agent/native.mjs';
import {taskPrompt} from '../prompts/templates.mjs';
import {skillsView} from '../dashboard/settings.mjs';
import {layers} from '../prompts/run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const skillPath='.agents/skills/dcg-orchestrator/SKILL.md';
const text=()=>fs.readFileSync(path.join(root,skillPath),'utf8');
const get=id=>read('work/queue.json').items.find(i=>i.id===id);
const ready=id=>readiness(get(id),read('work/queue.json').items).ready;
const fixture=(name,content)=>{const file=path.join(root,'.runtime',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;};
async function isolated(fn) {
  const names=['work/queue.json','work/turns.json','.runtime/agent/sessions.json','agent/config.json'];
  const saved=Object.fromEntries(names.map(name=>[name,read(name)]));
  write('work/queue.json',{version:1,items:[]});write('work/turns.json',{version:1,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...saved['agent/config.json'],enabled:true,memory_v2:{enabled:false}});
  try {await fn();} finally {for(const [name,value] of Object.entries(saved))write(name,value);}
}

test('the parent invocation resolves to the registered and discoverable project skill without full-body injection',async()=>{
  const source=text(),match=source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match);const meta=parse(match[1]);assert.equal(meta.name,'dcg-orchestrator');assert.equal(typeof meta.description,'string');assert.ok(meta.description.length>20);
  assert.ok(SYSTEM_PROMPT.includes(skillPath),'the real shared execution instructions provide the callable path');
  const found=(await skillsView()).skills.find(s=>s.name===meta.name);
  assert.equal(found.content,source);assert.equal(found.dir,'dcg-orchestrator');
  assert.equal(layers().find(layer=>layer.id==='skill-dcg-orchestrator').path,skillPath);
  const ordinary=taskPrompt({id:'fixture',actor:'codex',kind:'data',title:'A single analysis',goal:'One bounded analysis'},'',null);
  assert.ok(!String(ordinary).includes(match[2].trim()),'ordinary workers do not receive the orchestration body');
});

test('a parent consumes the current execution, retains valid evidence, and arms a semantic successor only after accepting a revised result',()=>isolated(async()=>{
  const parent=enqueue({title:'Interpret all branches',kind:'framework',actor:'codex'});
  const worker=enqueue({title:'One research question',kind:'framework',actor:'claude',parent_id:parent.id});
  const independent=enqueue({title:'Retained reference',kind:'framework',actor:'codex',parent_id:parent.id});
  const old=fixture('dcg-old.csv','old-result'),reference=fixture('dcg-reference.csv','accepted-reference');
  update({id:worker.id,status:'done',handoff:'Old delivery.',outputs:[old]});
  update({id:independent.id,status:'done',handoff:'Still-valid reference.',outputs:[reference]});
  const join=enqueue({title:'Compare evidence',kind:'framework',actor:'claude',parent_id:parent.id,dependencies:[worker.id,independent.id],status:'open'});
  assert.equal(readiness({...get(join.id),status:'queued'},read('work/queue.json').items).ready,true,'old done is not a semantic acceptance of a future revision');
  const first=repeatOperation({id:worker.id,input:'Resolve the newly identified mismatch.'});
  repeatOperation({id:parent.id,input:'Judge the returned revised evidence.',after:[first.id]});
  assert.equal(get(worker.id).status,'done');assert.equal(ready(join.id),false);
  const revised=fixture('dcg-revised.csv','new-result');let workerCalls=0,parentCalls=0,joinCalls=0,referenceCalls=0;
  const runner=async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    if(prompt.includes('本操作 ID：'+worker.id+'\n')) {
      workerCalls++;
      assert.equal(ready(join.id),false);
      if(workerCalls===1)return {result:'The mismatch has not been resolved; no revised delivery submitted.'};
      update({id:worker.id,status:'done',handoff:'Revised evidence resolves the mismatch.',outputs:[revised]});
      return {result:'New delivery.'};
    }
    if(prompt.includes('本操作 ID：'+parent.id+'\n')) {
      parentCalls++;
      if(parentCalls===1) {
        assert.ok(prompt.includes('本轮结果状态：open'));assert.equal(ready(join.id),false);
        const next=repeatOperation({id:worker.id,input:'Continue from the existing artifacts to resolve the remaining mismatch.'});
        repeatOperation({id:parent.id,input:'Decide whether the revised result can feed the comparison.',after:[next.id]});
      } else if(parentCalls===2) {
        assert.ok(prompt.includes('Revised evidence resolves the mismatch.'));assert.equal(ready(join.id),false);
        update({id:join.id,status:'queued'});
        repeatOperation({id:parent.id,input:'Integrate the comparison and preserved reference.',after:[join.id]});
      } else {
        assert.ok(prompt.includes('Comparison uses the revised evidence and retained reference.'));
        update({id:parent.id,status:'done',handoff:'Integrated research result.',outputs:[revised,reference]});
      }
      return {result:'Parent decision recorded.'};
    }
    if(prompt.includes('本操作 ID：'+join.id+'\n')) {
      joinCalls++;assert.equal(get(worker.id).outputs[0],revised);
      assert.equal(fs.readFileSync(reference,'utf8'),'accepted-reference');
      update({id:join.id,status:'done',handoff:'Comparison uses the revised evidence and retained reference.',outputs:[revised,reference]});
      return {result:'Comparison delivered.'};
    }
    if(prompt.includes('本操作 ID：'+independent.id+'\n'))referenceCalls++;
    throw new Error('Unexpected operation');
  };
  for(let i=0;i<6;i++)await drain(runner);
  assert.equal(get(parent.id).status,'done');assert.equal(workerCalls,2);assert.equal(parentCalls,3);assert.equal(joinCalls,1);assert.equal(referenceCalls,0);
  assert.equal(get(independent.id).outputs[0],reference);
  assert.equal(workSnapshot().items.find(i=>i.id===worker.id).execution_history[0].outcome_status,'open');
  assert.deepEqual(get(worker.id).dependencies,[]);assert.deepEqual(get(join.id).dependencies,[worker.id,independent.id]);
}));
