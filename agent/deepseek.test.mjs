import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {root,read,write} from '../automation/files.mjs';
import {deepseekEvent,deepseekStream,deepseekEnvironment,deepseekInput,invokeDeepSeek} from './deepseek.mjs';
import {rootId,fishIds,fishStart,fishEnd,native,rootUsage} from './fixtures/deepseek-fish.mjs';
import {submit,execute,route,summoned,agentSnapshot} from './run.mjs';
import {ownerCheck} from '../memory2/owner.mjs';
import {contextBreakdown,deepseekTracker} from './context-breakdown.mjs';
import {directChatTask} from '../work/autonomy.mjs';
import {parseEvents} from './calls.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('DeepSeek routes by explicit mention, follows the last speaker, and joins only explicit all',()=>{
  assert.equal(route('@DeepSeek 看看').provider,'deepseek');
  assert.equal(route('继续',{last:'deepseek'}).provider,'deepseek');
  assert.deepEqual(route('@Claude @DeepSeek @Codex 来讨论').speakers,['claude','deepseek','codex']);
  assert.deepEqual(route('@all 看看').speakers,['codex','claude','deepseek']);
  assert.deepEqual(route('@两位 看看').speakers,['codex','claude']);
  assert.equal(summoned('结论\n@DeepSeek 接一下','claude'),'deepseek');
  assert.equal(summoned('提到 @DeepSeek 但不交接','codex'),null);
  assert.equal(summoned('@DeepSeek 自己','deepseek'),null);
});

test('three colleagues keep names, complete history, real handoff provenance and fresh DeepSeek turns',async()=>{
  const config=read('agent/config.json');
  write('agent/config.json',{...config,memory_v2:{enabled:true,owners:['codex','claude','deepseek']}});
  try {
  const seen=[];
  const runner=async(provider,prompt,options)=>{
    if(options.purpose==='title')return {result:'三人接棒验收'};
    seen.push({provider,prompt,options});
    return {result:seen.length===1 ? 'CLAUDE_TO_DS\n@DeepSeek 来接棒' : seen.length===2 ? 'DS_TO_CODEX\n@Codex 来接棒' : seen.length===3 ? 'CODEX_TO_DS\n@DeepSeek 请收尾' : 'DS_完成',sessionId:'fixture-native'};
  };
  const a=submit({text:'@Claude 完成三人验收'});
  await execute(a.task_id,runner);
  assert.deepEqual(seen.map(x=>x.provider),['claude','deepseek','codex','deepseek']);
  assert.match(seen[1].prompt,/你是 DeepSeek/);
  for(const row of seen.slice(1,4)){
    assert.ok(row.prompt.includes(JSON.stringify({role:'user',speaker:'用户',text:'@Claude 完成三人验收'})),'handoff retains the initiating request in the actual history');
    assert.ok(!row.options.inputParts.some(p=>p.kind==='current_request'),'handoff does not repeat the initiating user message as a new request');
  }
  assert.match(seen[1].prompt,/CLAUDE_TO_DS/);
  assert.match(seen[2].prompt,/DS_TO_CODEX/);
  assert.match(seen[3].prompt,/CODEX_TO_DS/);
  for(const row of seen.filter(x=>x.provider==='deepseek')){
    assert.equal(row.options.continuation,undefined);
    assert.match(row.prompt,/办公室长期记忆（仅 deepseek 自己的/);
    assert.doesNotMatch(row.prompt,/日常经历由闲置后台整理/);
  }
  const b=submit({text:'继续上一件事，不点名',session_id:a.session_id});
  assert.equal(b.provider,'deepseek');await execute(b.task_id,runner);
  const history=seen[4].options.inputParts.find(p=>p.kind==='conversation_history').text.split('\n').slice(1).filter(Boolean).map(line=>JSON.parse(line));
  for(const [provider,text] of [['claude','CLAUDE_TO_DS'],['deepseek','DS_TO_CODEX'],['codex','CODEX_TO_DS']])
    assert.ok(history.some(m=>m.provider===provider && m.text.startsWith(text)),'complete colleague history: '+provider);
  assert.equal(read('work/queue.json').items.find(t=>t.id===b.task_id).status,'done');
  assert.ok(directChatTask(read('work/queue.json').items.find(t=>t.id===b.task_id)));
  const c=submit({text:'@Claude 接续正式工作',handoff:{provider:'deepseek',task_id:b.task_id}});
  const session=agentSnapshot().sessions.find(s=>s.id===c.session_id);
  assert.equal(session.messages[0].role,'handoff');assert.equal(session.messages[0].provider,'deepseek');
  } finally {write('agent/config.json',config);}
});

test('DeepSeek memory is separate and preserves owner routing; no invented transcript breakdown',()=>{
  assert.equal(ownerCheck('deepseek'),'deepseek');
  process.env.OFFICE_MEMORY_OWNER='deepseek';
  try{assert.throws(()=>ownerCheck('codex'),/自己的记忆/);assert.throws(()=>ownerCheck('claude'),/自己的记忆/);}
  finally{delete process.env.OFFICE_MEMORY_OWNER;}
  assert.equal(contextBreakdown('deepseek','not-a-codex-thread'),null);
});

test('SDK notifications produce tool activity, receipts, Unicode text and measured context',()=>{
  const ev=(type,data)=>({method:'session.event',payload:{event:{type,data}}});
  assert.deepEqual(deepseekEvent(ev('agent/inbox/spliced',{})),[{type:'submitted'}]);
  assert.deepEqual(deepseekEvent(ev('tool/call',{callId:'a',name:'read',arguments:'{"file_path":"中文.json"}'})),[{type:'tool',tool_id:'a',name:'read',detail:'中文.json'}]);
  assert.equal(deepseekEvent(ev('tool/result',{message:{toolCallId:'a',isError:true}}))[0].status,'failed');
  assert.deepEqual(deepseekEvent(ev('assistant/message',{message:{content:[{type:'reasoning',text:'not public'},{type:'text',text:'中文完成'}]},usage:{inputTokens:10,outputTokens:2,cacheReadTokens:20,cacheWriteTokens:3}})),[{type:'context',tokens:35},{type:'text',text:'中文完成'}]);
  assert.deepEqual(deepseekEvent({method:'session.status'}),[]);
  const file=path.join(root,'.runtime/deepseek-trace-fixture.jsonl');
  fs.writeFileSync(file,[ev('tool/call',{callId:'r1',name:'read',arguments:'{"file_path":"中文.json"}'}),
    ev('tool/result',{message:{toolCallId:'r1',isError:true,content:[{type:'text',text:'权限被拒'}]}}),
    ev('assistant/message',{message:{content:[{type:'reasoning',text:'private'},{type:'text',text:'如实报告失败'}]}})].map(JSON.stringify).join('\n'));
  const parsed=parseEvents(file);
  assert.equal(parsed.calls.length,1);assert.equal(parsed.calls[0].status,'返回错误');assert.equal(parsed.calls[0].output,'权限被拒');
  assert.equal(parsed.says[0].text,'如实报告失败');assert.equal(parsed.thinking,1);
});

test('real calls are disabled in isolated copies and unrelated secrets do not reach tools',async()=>{
  process.env.FIXTURE_SECRET='never pass';process.env.DEEPSEEK_API_KEY='never pass';process.env.DSH_INITIALIZE_TIMEOUT_SECONDS='75';
  try{
    const env=deepseekEnvironment('fixture-run');
    assert.equal(env.OFFICE_MEMORY_OWNER,'deepseek');assert.equal(env.OFFICE_MEMORY_RUN_DIR,'fixture-run');
    assert.equal(env.FIXTURE_SECRET,undefined);assert.equal(env.DEEPSEEK_API_KEY,undefined);
    assert.equal(env.DSH_INITIALIZE_TIMEOUT_SECONDS,'75');
  }finally{delete process.env.FIXTURE_SECRET;delete process.env.DEEPSEEK_API_KEY;delete process.env.DSH_INITIALIZE_TIMEOUT_SECONDS;}
  await assert.rejects(invokeDeepSeek('do not call',{directory:path.join(root,'.runtime/never-start')}),/disabled/);
  assert.equal(fs.existsSync(path.join(root,'.runtime/never-start')),false);
});

test('request context reports the model window and streamed events give a context breakdown that adds up',()=>{
  const ev=(type,data)=>({method:'session.event',payload:{event:{type,data}}});
  assert.deepEqual(deepseekEvent(ev('request/context',{provider:'deepseek-official',model:'deepseek-flash',contextWindow:1000000})),[{type:'context',window:1000000}]);
  assert.deepEqual(deepseekEvent(ev('request/context',{model:'x'})),[]);
  const t=deepseekTracker(),push=(type,data)=>t.push({type,data}),big='中'.repeat(3000);
  assert.equal(t.result(),null);
  push('user/message',{content:[{type:'text',text:big}]});
  push('assistant/message',{message:{content:[{type:'reasoning',text:'想'},{type:'tool-call',id:'c1',name:'read',arguments:'{"file_path":"a.md"}'}]},usage:{inputTokens:9000,outputTokens:50,cacheReadTokens:0,cacheWriteTokens:0}});
  push('tool/result',{message:{toolCallId:'c1',content:[{type:'text',text:'x'.repeat(20000)}]}});
  push('assistant/message',{message:{content:[{type:'text',text:'完成'}]},usage:{inputTokens:200,outputTokens:5,cacheReadTokens:13000,cacheWriteTokens:0}});
  const r=t.result();
  assert.equal(r.total,13205);
  assert.equal(r.parts.reduce((a,p)=>a+p.tokens,0),13205);
  const keys=r.parts.map(p=>p.key);
  for(const k of ['fixed','user','read'])assert.ok(keys.includes(k),k);
});

test('workflow children have distinct cards/tools, while only the root drives text holding, receipt and context',()=>{
 const events=[];let submitted=0;
 const stream=deepseekStream(rootId,{onEvent:e=>events.push(e),onSubmitted:()=>submitted++});
 for(const n of [...fishStart(),...fishEnd()])stream.push(n);
 assert.equal(submitted,1,'child inbox receipts must not submit the parent');
 assert.deepEqual(events.filter(e=>e.type==='text'&&!e.sub).map(e=>e.text),['ROOT_PROGRESS']);
 assert.deepEqual(events.filter(e=>e.type==='text'&&e.sub).map(e=>e.text),['CHILD_PROGRESS_1','CHILD_PROGRESS_2','CHILD_FINAL_1','CHILD_FINAL_2']);
 for(const id of fishIds){
  assert.equal(events.findLast(e=>e.type==='subagent_call'&&e.tool_id===id).title,'小鱼'+(fishIds.indexOf(id)+1)+'号');
  assert.equal(events.findLast(e=>e.type==='subagent'&&e.agent_id===id).status,'completed');
  assert.equal(events.find(e=>e.type==='tool'&&e.parent===id).tool_id,id+':same-call-id');
  assert.ok(events.some(e=>e.type==='tool_end'&&e.tool_id===id+':same-call-id'));
 }
 assert.deepEqual(events.filter(e=>e.type==='context'),[{type:'context',window:1000000},{type:'context',tokens:130},{type:'context',tokens:130}]);
 assert.equal(stream.contextBreakdown().total,130);assert.doesNotMatch(JSON.stringify(events),/PRIVATE_REASONING|CHILD_TOOL_OUTPUT/);
 // A root reply held at the end must not be flushed by a late child message/tool.
 const before=events.filter(e=>e.type==='text'&&!e.sub).length;
 stream.push(native(fishIds[0],'assistant/message',{message:{content:[{type:'text',text:'LATE_CHILD'}]},usage:rootUsage}));
 assert.equal(events.filter(e=>e.type==='text'&&!e.sub).length,before);
 stream.push(native(rootId,'assistant/message',{message:{content:[{type:'text',text:'ROOT_NEXT'}]}}));
 assert.equal(events.filter(e=>e.type==='text'&&!e.sub).at(-1).text,'ROOT_FINAL');
});

test('failed/stopped fish show their real outcome; lifecycle notices from another root are ignored',()=>{
 for(const [nativeStatus,wanted] of [['error','failed'],['cancelled','stopped']]){
  const events=[],stream=deepseekStream(rootId,{onEvent:e=>events.push(e)});
  for(const n of [...fishStart(),...fishEnd(nativeStatus)])stream.push(n);
  assert.ok(events.filter(e=>e.type==='subagent_result').every(e=>e.status===wanted));
 }
 const events=[],stream=deepseekStream(rootId,{onEvent:e=>events.push(e)});
 stream.push({method:'subagent.started',payload:{parentSessionId:'other-root',childSessionId:'other-child'}});
 assert.deepEqual(events,[]);
});

test('DeepSeek live input writes every Unicode message before receipts, and never admits an unacknowledged input',async()=>{
 const child={stdin:new PassThrough()},written=[];let send;
 child.stdin.on('data',data=>written.push(JSON.parse(data.toString('utf8'))));
 const input=deepseekInput(child,{mode:'work',model:'deepseek-flash',effort:'high',onReady:f=>send=f});
 input.push({method:'office.ready'});assert.equal(typeof send,'function');
 let delivered=0;
 const a=send('第一条：中文弯引号“原样”').then(()=>delivered++),b=send('第二条：不要等上一条回执').then(()=>delivered++);
 assert.equal(written.length,2);assert.equal(delivered,0);assert.notEqual(written[0].id,written[1].id);
 assert.equal(written[0].text,'第一条：中文弯引号“原样”');
 input.push({method:'office.input',payload:{id:written[1].id,accepted:true}});await b;assert.equal(delivered,1);
 input.push({method:'office.input',payload:{id:written[0].id,accepted:true}});await a;assert.equal(delivered,2);
 await assert.rejects(send('不同模型',{model:'deepseek-other'}),/配置不同/);assert.equal(written.length,2);
 const denied=send('被拒绝'),denial=assert.rejects(denied,/原生拒收/);
 input.push({method:'office.input',payload:{id:written[2].id,accepted:false,error:'原生拒收'}});await denial;
 const lost=send('未收到回执'),closed=assert.rejects(lost,/保留排队/);input.close();await closed;
 await assert.rejects(send('已经结束'),/结束/);assert.equal(written.length,4);
});

test('workflow child activity persists in cards but not in any later colleague prompt',async()=>{
 const job=submit({text:'@DeepSeek [validation] workflow children'});
 await execute(job.task_id,async(_,prompt,opts)=>{
  if(opts.purpose==='title')return {result:'Workflow fixture'};
  const stream=deepseekStream(rootId,opts);for(const n of [...fishStart(),...fishEnd()])stream.push(n);
  return {result:'ROOT_FINAL',sessionId:rootId,contextBreakdown:stream.contextBreakdown()};
 });
 const session=agentSnapshot().sessions.find(s=>s.id===job.session_id);
 assert.equal(session.subagent_runs.length,2);assert.ok(session.subagent_runs.every(r=>r.status==='completed'));
 const messages=session.messages.filter(m=>m.role==='assistant');
 assert.equal(messages.filter(m=>m.subagent).length,4);
 assert.ok(messages.filter(m=>m.subagent).every(m=>m.interim&&fishIds.includes(m.agent_call)));
 assert.deepEqual(messages.filter(m=>!m.subagent).map(m=>m.text),['ROOT_PROGRESS','ROOT_FINAL']);
 for(const provider of ['deepseek','codex','claude']){
  const next=submit({text:'@'+provider+' Continue fixture',session_id:job.session_id});let captured='';
  await execute(next.task_id,async(_,prompt,opts)=>{if(opts.purpose==='title')return {result:''};captured=prompt;return {result:'Next final'};});
  assert.match(captured,/ROOT_FINAL/);assert.doesNotMatch(captured,/CHILD_PROGRESS|CHILD_FINAL|CHILD_TASK|CHILD_TOOL_OUTPUT|PRIVATE_REASONING/);
 }
});
