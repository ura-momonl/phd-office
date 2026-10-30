import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
import {dataAnalysisMode} from '../prompts/templates.mjs';
import {traceFragments,promptMap} from '../prompts/compose.mjs';
import {submit,execute as executeAgent,startReadyWork} from '../agent/run.mjs';
import {enqueue,update,repeatOperation} from '../work/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent),sessionFile='.runtime/agent/sessions.json';
const skillFiles=['research-partner','data-analysis'].map(name=>`.agents/skills/${name}/SKILL.md`);
const body=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/,'').trim();
const check=prompt=>{
  for(const file of skillFiles) {
    const actual=body(file);
    assert.equal(String(prompt).split(actual).length-1,1,`${file}: complete body exactly once, not a pointer`);
  }
};
const saved=()=>({queue:read('work/queue.json'),sessions:read(sessionFile),cfg:read('agent/config.json')});
const restore=s=>{write('work/queue.json',s.queue);write(sessionFile,s.sessions);write('agent/config.json',s.cfg);};
const config=s=>write('agent/config.json',{...s.cfg,enabled:true,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});

test('data work mode reads full authoritative skill bodies and records their exact source ranges',()=>{
  let map;
  const [text]=traceFragments(()=>{
    const mode=dataAnalysisMode({kind:'data'});map=promptMap(mode);return String(mode);
  },{sources:true});
  check(text);
  for(const file of skillFiles) {
    const source=map.nodes.find(n=>n.path===file);
    assert.ok(source,file);
    assert.equal(text.slice(source.start,source.end),body(file));
  }
  assert.equal(dataAnalysisMode({kind:'mail',title:'邮件里有数据'}),'');
  assert.equal(dataAnalysisMode({kind:'framework'}),'');
  assert.equal(dataAnalysisMode({kind:'data',autonomy:{type:'plan'}}),'');
  const file=path.join(root,skillFiles[1]),before=fs.readFileSync(file,'utf8');
  try {
    fs.writeFileSync(file,before+'\nUpdated isolated fixture body.\n');
    assert.ok(String(dataAnalysisMode({kind:'data'})).includes('Updated isolated fixture body.'),'later dispatch reads current text without reloading modules');
  } finally {fs.writeFileSync(file,before);}
});

test('routed data chats deliver the mode to all three assistants, including native continuation input',async()=>{
  const s=saved();config(s);
  try {
    for(const actor of ['codex','claude','deepseek']) {
      const first=submit({text:`@${actor} [validation] 分析这组数据`});
      assert.equal(read('work/queue.json').items.find(i=>i.id===first.task_id).kind,'data');
      const thread='data-mode-'+actor;
      await execute(first.task_id,async(provider,prompt,opts)=>{
        assert.equal(provider,actor);check(prompt);
        assert.equal(opts.inputParts.filter(p=>p.kind==='run_context').length,1);
        check(opts.inputParts.find(p=>p.kind==='run_context').text);
        opts.onContinuation?.({threadId:thread,signature:'fixture'},{phase:'start',resumed:false});
        return {result:'Fixture only; no native model called.'};
      });
      const second=submit({text:`@${actor} [validation] 继续分析数据`,session_id:first.session_id});
      await execute(second.task_id,async(_,prompt,opts)=>{
        check(prompt);
        if(actor!=='deepseek')check(opts.resumePrompt);
        return {result:'Fixture continued.'};
      });
    }
    const shared=submit({text:'@Codex @Claude @DeepSeek [validation] 一起核对数据分析结果'}),speakers=[];
    await execute(shared.task_id,async(provider,prompt,opts)=>{
      speakers.push(provider);check(prompt);check(opts.inputParts.find(p=>p.kind==='run_context').text);
      return {result:'Fixture handoff; no model called.'};
    });
    assert.deepEqual(speakers,['codex','claude','deepseek'],'later named speakers also receive the current mode');
    const plain=submit({text:'@Codex [validation] 你好'});
    await execute(plain.task_id,async(_,prompt)=>{
      assert.ok(!prompt.includes(body(skillFiles[1])),'non-data chat keeps its existing prompt');
      return {result:'Hello.'};
    });
  } finally {restore(s);}
});

test('initial and repeated data operations share the same mode entry and never duplicate it in the task goal',async()=>{
  const s=saved();config(s);
  try {
    const operation=enqueue({title:'[validation] data operation',goal:'Use the supplied measurements.',kind:'data',actor:'codex',status:'queued',require_outputs:false});
    const first=startReadyWork().find(j=>j.task_id===operation.id);
    assert.ok(first);
    await execute(first.task_id,async(_,prompt)=>{
      check(prompt);
      update({id:operation.id,status:'done',handoff:'First fixture result.',outputs:[]});
      return {result:'First fixture finished.'};
    });
    const next=repeatOperation({id:operation.id,input:'Compare the existing result again.'});
    assert.ok(startReadyWork().some(j=>j.task_id===next.id));
    await execute(next.id,async(_,prompt,opts)=>{
      // A resumed history may contain the earlier full input. The new run_context
      // must deliver one current copy instead of adding the mode to both wrappers.
      check(opts.inputParts.find(p=>p.kind==='run_context').text);
      check(opts.resumeInputParts.find(p=>p.kind==='run_context').text);
      assert.match(prompt,/Compare the existing result again/);
      update({id:operation.id,status:'done',handoff:'Repeated fixture result.',outputs:[]});
      return {result:'Repeated fixture finished.'};
    });
  } finally {restore(s);}
});
