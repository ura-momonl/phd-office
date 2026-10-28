import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
import {enqueue,update,editStep,stepEditor} from '../work/run.mjs';
import {submit,execute as executeAgent,drain,answerQuestion} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
import {nativeTextInput} from '../agent/native.mjs';
import {newRun,foldEvent} from '../agent/claude.mjs';
import {deepseekEvent,deepseekStream} from '../agent/deepseek.mjs';
import {renderStatus,projectStatus} from '../projects/run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent);
async function isolated(fn){
  const files=['work/queue.json','.runtime/agent/sessions.json','agent/config.json'];
  const saved=Object.fromEntries(files.map(f=>[f,read(f)]));
  write('work/queue.json',{version:1,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...saved['agent/config.json'],enabled:true,memory_v2:{enabled:false}});
  try{return await fn();}finally{for(const [f,v] of Object.entries(saved))write(f,v);}
}

test('a long business goal and its sources reach execution and the saved handoff intact',()=>isolated(async()=>{
  const goal='完整要求。'.repeat(1100)+'\n末尾决定：保留反例 D:/research/完整目录/结果.csv';
  const title='完整任务标题'.repeat(50),sources=Array.from({length:24},(_,n)=>'source-'+n);
  const job=enqueue({title,goal,sources,kind:'framework',actor:'codex',status:'queued'});
  assert.equal(job.title,title);assert.equal(job.goal,goal);assert.deepEqual(job.sources,sources);
  let got=false;
  await drain(async(_provider,prompt,opts)=>{
    got=true;const delivered=nativeTextInput(prompt,opts.inputParts).map(c=>c.text).join('');
    assert.ok(delivered.includes(goal));assert.ok(delivered.includes('source-23'));
    update({id:job.id,status:'done',handoff:goal,outputs:[]});
    return {result:'已登记。'};
  });
  assert.equal(got,true);assert.equal(read('work/queue.json').items.find(i=>i.id===job.id).handoff,goal);
  const open=enqueue({title:'editable',kind:'framework',actor:'user'});
  editStep({id:open.id,action:'content',revision:stepEditor(open.id).revision,title,goal,handoff:goal});
  const edited=read('work/queue.json').items.find(i=>i.id===open.id);
  assert.equal(edited.goal,goal);assert.equal(edited.handoff,goal);assert.equal(edited.title,title);
}));

test('a long workbench answer is delivered and saved with its last requirement',()=>isolated(async()=>{
  const job=submit({text:'@Claude 请问清一个问题'}),answer='问题补充。'.repeat(1000)+'末尾决定 D:/中文结果.csv';
  await execute(job.task_id,async(_provider,_prompt,opts)=>{
    const pending=opts.onQuestion([{id:'0',question:'补充？',options:[],multi:false,other:true}]);
    const record=read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id).questions.at(-1);
    answerQuestion({session_id:job.session_id,question_id:record.id,answers:{'0':[answer]}});
    assert.deepEqual(await pending,{'0':[answer]});return {result:'收到完整补充。'};
  });
  assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id).questions.at(-1).answers['0'][0],answer);
}));

test('changing date and run material do not alter the stable prefix or cut chronological history',t=>isolated(async()=>{
  const locale=Date.prototype.toLocaleDateString;let date='2026-10-26';
  t.mock.method(Date.prototype,'toLocaleDateString',function(language,...args){return language==='en-CA'?date:locale.call(this,language,...args);});
  const calls=[],first=submit({text:'@Codex 首轮完整请求'});
  const runner=async(_provider,prompt,opts)=>{calls.push({prompt,parts:opts.inputParts});return {result:'完整结论，末尾限制仍然有效。'};};
  await execute(first.task_id,runner);date='2026-10-27';
  const second=submit({session_id:first.session_id,text:'@Codex 新的一天继续'});await execute(second.task_id,runner);
  const office=calls.map(c=>c.parts.find(p=>p.kind==='office_context').text);
  assert.equal(office[0],office[1]);assert.doesNotMatch(office[0],/2026-10-2[67]|本次运行目录|本轮相关记忆/);
  assert.ok(calls.every(c=>c.prompt.startsWith(office[0])));
  assert.ok(calls[0].prompt.includes('2026-10-26'));assert.ok(calls[1].prompt.includes('2026-10-27'));
  const history=calls[1].parts.find(p=>p.kind==='conversation_history').text;
  assert.ok(history.includes('首轮完整请求'));assert.ok(history.includes('末尾限制仍然有效'));
  assert.ok(calls[1].prompt.indexOf(history)<calls[1].prompt.indexOf('今天是'));
  assert.match(calls[1].parts.at(-1).text,/当前请求：@Codex 新的一天继续$/);
}));

test('native child prompts, results and tool details remain complete for Claude and DeepSeek',()=>{
  const long='完整工具材料'.repeat(1800)+'末尾中文 D:/research/结果.md',events=[];
  const run=newRun('fixture'),options={onEvent:e=>events.push(e)};
  foldEvent(run,{type:'assistant',message:{content:[{type:'tool_use',id:'child',name:'Agent',input:{description:long,prompt:long}}]}},options);
  foldEvent(run,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'child',content:long}]}},options);
  assert.equal(events.find(e=>e.type==='subagent_call').prompt,long);
  assert.equal(events.find(e=>e.type==='subagent_result').text,long);
  assert.ok(events.find(e=>e.type==='tool').detail.includes(long));
  const detail=deepseekEvent({method:'session.event',payload:{event:{type:'tool/call',data:{callId:'tool',name:'Read',arguments:JSON.stringify({file_path:long})}}}});
  assert.equal(detail[0].detail,long);
  const ds=[],stream=deepseekStream('root',{onEvent:e=>ds.push(e)});
  stream.push({method:'session.event',payload:{sessionId:'child',event:{type:'user/message',data:{content:[{type:'text',text:long}]}}}});
  assert.equal(ds.find(e=>e.type==='subagent_call'&&e.prompt).prompt,long);
});

test('status keeps a submitted long handoff and all unresolved items, and includes every requested project',()=>isolated(async()=>{
  const ids=['bi-devices','tairte4-transport','graphene-array'],catalog=read('projects/catalog.json');
  const available=catalog.projects.map(p=>p.id),projects=ids.filter(id=>available.includes(id));
  if(projects.length<3)projects.push(...available.filter(id=>!projects.includes(id)).slice(0,3-projects.length));
  assert.equal(projects.length,3);
  const paths=projects.map(id=>path.join(root,'workspace/projects',id,'STATUS.md')),before=paths.map(f=>fs.existsSync(f)?fs.readFileSync(f):null);
  try{
    const result='第一句。'+'完整分析。'.repeat(400)+'尾部结果 D:/research/完整分析.csv';
    const item=enqueue({title:'完整状态',kind:'framework',actor:'codex',project_ids:[projects[0]]});
    update({id:item.id,status:'done',handoff:result,outputs:[]});renderStatus(projects[0]);
    assert.ok(fs.readFileSync(paths[0],'utf8').includes(result));
    update({id:item.id,brief:{summary:'明确摘要',open:['甲','乙','丙','丁']}});renderStatus(projects[0]);
    assert.ok(fs.readFileSync(paths[0],'utf8').includes('未决：丁'));
    for(let i=0;i<paths.length;i++)fs.writeFileSync(paths[i],'project-'+i);
    assert.equal(projectStatus(projects),'project-0\nproject-1\nproject-2');
  }finally{for(let i=0;i<paths.length;i++)if(before[i]===null)fs.rmSync(paths[i],{force:true});else fs.writeFileSync(paths[i],before[i]);}
}));
