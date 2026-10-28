import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {invokeCodex} from '../agent/codex.mjs';
import {read,write} from './files.mjs';
import {submit,execute as executeAgent,stop,agentSnapshot} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --mail --keep');

async function fakeRun(t,variant,opts={},inspect=()=>{}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-output-fixture-'));
  const bin=path.join(dir,'npm/node_modules/@openai/codex/bin/codex.js'),pidFile=path.join(dir,'child.pid');
  fs.mkdirSync(path.dirname(bin),{recursive:true});
  fs.writeFileSync(bin,`
    const fs=require('node:fs'),rl=require('node:readline');
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    const variant=${JSON.stringify(variant)},threadId='fixture-thread';let turnId='fixture-turn',turnCount=0;
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    const event=(method,params)=>send({method,params:{threadId,turnId,...params}});
    setInterval(()=>{},1000);
    rl.createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      fs.appendFileSync(${JSON.stringify(path.join(dir,'requests.jsonl'))},JSON.stringify(q)+'\\n');
      if(q.method==='initialize')return send({id:q.id,result:{userAgent:'fixture'}});
      if(q.method==='turn/steer')return send({id:q.id,result:{turnId}});
      if(q.method==='thread/start' && variant==='early-notice'){event('turn/started',{turn:{id:'old',status:'inProgress'}});event('turn/completed',{turn:{id:'old',status:'completed'}});}
      if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:threadId,model:'fixture'},model:'fixture',sandbox:{type:q.params.sandbox==='read-only'?'readOnly':'workspaceWrite'}}});
      if(q.method!=='turn/start')return;
      turnCount++;turnId='fixture-turn-'+turnCount;
      if(variant==='overload-rpc' && turnCount===2)return send({id:q.id,error:{code:-32000,message:'ambiguous recovery start'}});
      send({id:q.id,result:{turn:{id:turnId,status:'inProgress'}}});
      setTimeout(()=>{
        event('turn/started',{turn:{id:turnId,status:'inProgress'}});
        if(variant==='hang')return;
        const complete=(id,text)=>event('item/completed',{item:{id,type:'agentMessage',text}});
        if(variant==='subagents' || variant==='subagent-only'){
          const child=(method,params)=>event(method,{threadId:'child-thread',turnId:'child-turn',...params});
          event('item/completed',{item:{id:'spawn',type:'subAgentActivity',kind:'started',agentThreadId:'child-thread',agentPath:'/root/helper'}});
          child('turn/started',{turn:{id:'child-turn',status:'inProgress'}});
          if(variant==='subagents')complete('parent-progress','Parent progress');
          child('item/completed',{item:{id:'child-progress',type:'agentMessage',phase:'commentary',text:'Child progress'}});
          const tool={id:'child-tool',type:'commandExecution',command:'node --version'};
          child('item/started',{item:tool});child('item/completed',{item:{...tool,status:'completed',exitCode:0}});
          child('turn/completed',{turn:{id:'child-turn',status:'completed'}});
          event('item/completed',{item:{id:'ended',type:'subAgentActivity',kind:'completed',agentThreadId:'child-thread',agentPath:'/root/helper'}});
          if(variant==='subagents')complete('parent-final','Parent final');
          // A child's late final must not replace the root final or become an unmarked reply.
          child('item/completed',{item:{id:'child-final',type:'agentMessage',phase:'final_answer',text:'Child final'}});
          event('turn/completed',{turn:{id:turnId,status:'completed'}});return;
        }
        if(variant.startsWith('overload') || variant.startsWith('error-')){
          if(turnCount===1)complete('partial','PARTIAL WORK ALREADY DONE');
          event('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:100},total:{inputTokens:100*turnCount,outputTokens:10*turnCount}}});
          const fail=variant==='overload-always' || variant==='overload-rpc' || variant.startsWith('error-') || turnCount<=(variant==='overload-twice'?2:1);
          if(fail){
            const error={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:variant.startsWith('error-')?variant.slice(6):'serverOverloaded'};
            event('turn/completed',{turn:{id:turnId,status:'failed',error}});
            if(variant==='overload-duplicate')event('turn/completed',{turn:{id:turnId,status:'failed',error}});
            return;
          }
          const finish=()=>{complete('final','RECOVERED');event('turn/completed',{turn:{id:turnId,status:'completed'}});};
          if(variant==='overload-steer')return setTimeout(finish,40);
          return finish();
        }
        if(variant==='stream'){
          event('item/agentMessage/delta',{itemId:'a',delta:'1234567'});complete('a','1234567');
          event('item/agentMessage/delta',{itemId:'b',delta:'1234567'});return;
        }
        if(variant==='oversize'){complete('a','x'.repeat(196890));return;}
        if(variant==='tools'){
          for(const item of [{id:'cmd',type:'commandExecution',command:'node scripts/run-tests.mjs --activity'}, {id:'mcp',type:'mcpToolCall',tool:'fixture_read',arguments:{file_path:'fixture/source.txt',text_content:'PRIVATE_BODY'}}]){
            event('item/started',{item});event('item/completed',{item:{...item,status:'completed',exitCode:item.id==='cmd'?1:undefined}});
          }
        }
        const text=variant==='work'?'x'.repeat(17000):'hello';
        event('item/agentMessage/delta',{itemId:'a',delta:text});complete('a',text);
        event('turn/completed',{turn:{id:turnId,status:'completed'}});
      },10);
    });
  `);
  const previous=process.env.APPDATA;process.env.APPDATA=dir;
  t.after(async()=>{
    if(variant==='oversize'){
      const events=path.join(dir,'run/events.jsonl');
      assert.ok(!fs.existsSync(events) || fs.statSync(events).size<16000,'oversized complete text must not be persisted');
    }
    if(fs.existsSync(pidFile)){
      const pid=Number(fs.readFileSync(pidFile,'utf8'));let alive=true;
      for(let i=0;i<100 && alive;i++){try{process.kill(pid,0);await delay(20);}catch{alive=false;}}
      assert.equal(alive,false,'fake native process must actually exit after finish/abort');
    }
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^codex-output-fixture-/);
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const run=path.join(dir,'run');fs.mkdirSync(run);
  const prompt=opts.inputParts?.map(p=>p.text).join('\n') ?? 'Fixture only: no real model.';
  try {return await invokeCodex(prompt,{mode:'ask',model:'fixture',purpose:'mail',directory:run,signal:t.signal,...opts});}
  finally {
    if(previous===undefined)delete process.env.APPDATA;else process.env.APPDATA=previous;
    const requests=path.join(dir,'requests.jsonl');
    inspect(fs.existsSync(requests)?fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse):[]);
  }
}

function fastRecovery(t){
  const original=globalThis.setTimeout,delays=[];
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
    if(ms===60000 || ms===180000){delays.push(ms);return original(fn,2,...args);}
    return original(fn,ms,...args);
  });
  return delays;
}

test('native streamed output limit accumulates across messages and terminates the fake child',async t=>{
  await assert.rejects(fakeRun(t,'stream',{maxOutputChars:10}),/10 字符上限/);
});
test('native completed-only oversized output is rejected before it becomes a saved huge event',async t=>{
  await assert.rejects(fakeRun(t,'oversize',{maxOutputChars:16000}),/16000 字符上限/);
});
test('valid delta plus authoritative completed text is not double-counted',async t=>{
  assert.equal((await fakeRun(t,'normal',{maxOutputChars:5})).result,'hello');
});
test('aborting the mail call ends a non-returning native child and preserves the timeout reason',async t=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('Fixture mail deadline')),250);
  t.after(()=>clearTimeout(timer));
  await assert.rejects(fakeRun(t,'hang',{signal:controller.signal,maxOutputChars:16000}),/Fixture mail deadline/);
});
test('ordinary work has no new implicit mail output cap',async t=>{
  assert.equal((await fakeRun(t,'work',{mode:'work',purpose:'conversation'})).result.length,17000);
});

test('yielding at the initial native send boundary writes no turn and records no model call',async t=>{
  const file='.runtime/usage/runs.jsonl',before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const priority=new Error('user input first');priority.code='USER_INPUT_PRIORITY';
  await assert.rejects(fakeRun(t,'work',{mode:'work',purpose:'chat',beforeSubmit:()=>{throw priority;}},requests=>{
    assert.equal(requests.filter(r=>r.method==='turn/start').length,0);
  }),e=>e===priority);
  assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'',before);
});

test('Codex writes a whole input burst to native RPC without awaiting earlier receipts',async t=>{
  let receipts;
  await fakeRun(t,'work',{mode:'work',purpose:'chat',onReady:send=>{
    receipts=Promise.all([
      send('FIRST',{model:'fixture',mode:'work'}),send('SECOND'),send('THIRD'),
      assert.rejects(send('DIFFERENT MODEL',{model:'another-model'}),/原生运行配置不同/),
      assert.rejects(send('DIFFERENT MODE',{mode:'ask'}),/原生运行配置不同/),
    ]);
  }},requests=>{
    assert.deepEqual(requests.filter(r=>r.method==='turn/steer').map(r=>r.params.input[0].text),['FIRST','SECOND','THIRD']);
  });
  await receipts;
});

test('native Codex emits matching tool start and return events, including nonzero command exits',async t=>{
  const events=[];await fakeRun(t,'tools',{onEvent:e=>events.push(e)});
  assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>[e.tool_id,e.name]),[['cmd','commandExecution'],['mcp','fixture_read']]);
  assert.deepEqual(events.filter(e=>e.type==='tool_end').map(e=>[e.tool_id,e.status]),[['cmd','failed'],['mcp','completed']]);
  assert.match(events.find(e=>e.tool_id==='cmd').summary,/--activity/);
  assert.equal(events.find(e=>e.tool_id==='mcp').summary,'操作文件 · fixture/source.txt');
  assert.doesNotMatch(JSON.stringify(events.map(e=>e.summary)),/PRIVATE_BODY/);
});

test('Codex child thread text/tools are marked without replacing or delaying the root final',async t=>{
  const events=[];const result=await fakeRun(t,'subagents',{mode:'work',purpose:'chat',onEvent:e=>events.push(e)});
  assert.equal(result.result,'Parent final');
  assert.deepEqual(events.filter(e=>e.type==='text').map(e=>[e.text,!!e.sub]),[
    ['Parent progress',false],['Child progress',true],['Parent final',false],['Child final',true]]);
  assert.deepEqual(events.filter(e=>e.tool_id==='child-tool').map(e=>[e.type,e.sub]),[['tool',true],['tool_end',true]]);
  assert.ok(events.filter(e=>e.type==='text' && e.sub).every(e=>e.parent==='child-thread'));
  assert.deepEqual(events.filter(e=>e.type==='subagent_call').map(e=>[e.tool_id,e.title]),[['child-thread','/root/helper']]);
  assert.equal(events.findLast(e=>e.type==='subagent_result' && e.text)?.text,'Child final');
  assert.ok(!events.some(e=>e.type==='subagent_result' && e.text==='Child progress'),'commentary remains a midway record, not the returned result');
  assert.deepEqual(events.filter(e=>e.type==='subagent').map(e=>[e.agent_id,e.status]),[
    ['child-thread','running'],['child-thread','running'],['child-thread','completed'],['child-thread','completed']]);
});

test('notifications that arrive before the thread response belong to the root, not a subagent card',async t=>{
  const events=[];await fakeRun(t,'early-notice',{mode:'work',purpose:'chat',onEvent:e=>events.push(e)}).catch(()=>{});
  assert.deepEqual(events.filter(e=>/^subagent/.test(e.type)),[]);
});

test('a child final alone cannot satisfy a missing root reply',async t=>{
  await assert.rejects(fakeRun(t,'subagent-only',{mode:'work',purpose:'chat'}),/模型未返回完成结果/);
});

test('Codex child source survives the adapter-to-conversation persistence boundary',async t=>{
  const job=submit({text:'@Codex [validation] distinguish child reports'});
  await executeWithoutTitle(executeAgent)(job.task_id,(_,prompt,opts)=>fakeRun(t,'subagents',opts));
  const session=read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id);
  const messages=session.messages.filter(m=>m.role==='assistant');
  assert.deepEqual(messages.filter(m=>m.subagent).map(m=>m.text),['Child progress','Child final']);
  assert.equal(messages.at(-1).text,'Parent final');assert.equal(messages.at(-1).subagent,undefined);
  assert.ok(messages.filter(m=>m.subagent).every(m=>m.provider==='codex' && m.interim));
  assert.ok(messages.filter(m=>m.subagent).every(m=>m.agent_call==='child-thread'));
  assert.equal(session.subagent_runs.length,1);
  assert.equal(session.subagent_runs[0].status,'completed');
  assert.equal(session.subagent_runs[0].text,'Child final','a late final updates the card without overwriting its completion');
  assert.equal(session.subagent_runs[0].title,'/root/helper');
});

test('chat overload resumes the SAME thread without replay, preserves progress/usage and records each native turn',async t=>{
  const delays=fastRecovery(t),events=[],turns=[];let submitted=0;
  const result=await fakeRun(t,'overload-duplicate',{mode:'work',purpose:'chat',continuation:{},
    onSubmitted:()=>submitted++,onEvent:e=>events.push(e),onContinuation:(state,info)=>{if(info.phase==='turn')turns.push(info.ref);}},requests=>{
    const starts=requests.filter(q=>q.method==='turn/start');
    assert.equal(starts.length,2);assert.equal(requests.filter(q=>q.method==='thread/start').length,1);
    assert.equal(starts[0].params.threadId,starts[1].params.threadId);
    assert.doesNotMatch(starts[1].params.input[0].text,/Fixture only/);
    assert.match(starts[1].params.input[0].text,/不重做已完成|不重复启动仍在运行的子 agent/);
    assert.match(starts[1].params.input[0].text,/此次自动唤起不增加任何授权/);
  });
  assert.equal(result.result,'RECOVERED');assert.deepEqual(delays,[60000]);assert.equal(submitted,1);
  assert.deepEqual(turns,['fixture-turn-1','fixture-turn-2']);assert.equal(result.usage.inputTokens,200);
  assert.ok(events.some(e=>e.type==='text'&&e.text==='PARTIAL WORK ALREADY DONE'));
  assert.ok(events.some(e=>e.type==='text'&&e.text.includes('1 分钟后自动续做')));
});

test('overload retry backs off for 1 then 3 minutes and stops after two automatic wakeups',async t=>{
  const delays=fastRecovery(t);
  await assert.rejects(fakeRun(t,'overload-always',{mode:'work',purpose:'chat'},requests=>{
    assert.equal(requests.filter(q=>q.method==='turn/start').length,3);
  }),/已自动唤起两次/);
  assert.deepEqual(delays,[60000,180000]);
});

test('a second overload can recover on the final permitted wakeup',async t=>{
  const delays=fastRecovery(t);
  assert.equal((await fakeRun(t,'overload-twice',{mode:'work',purpose:'chat'})).result,'RECOVERED');
  assert.deepEqual(delays,[60000,180000]);
});

test('live followups target the recovered turn rather than the failed turn',async t=>{
  fastRecovery(t);let send,steering,contexts=0;
  await fakeRun(t,'overload-steer',{mode:'work',purpose:'chat',onReady:fn=>send=fn,onEvent:e=>{
    if(e.type==='context' && ++contexts===2)steering=send('LATEST USER INPUT');
  }},requests=>{
    const steer=requests.find(q=>q.method==='turn/steer');
    assert.equal(steer.params.expectedTurnId,'fixture-turn-2');assert.equal(steer.params.input[0].text,'LATEST USER INPUT');
  });
  await steering;
});

test('quota, permission and generic errors do not wake up even when their message says capacity',async t=>{
  const delays=fastRecovery(t);
  for(const code of ['usageLimitExceeded','sandboxError','other']){
    await assert.rejects(fakeRun(t,'error-'+code,{mode:'work',purpose:'chat'},requests=>{
      assert.equal(requests.filter(q=>q.method==='turn/start').length,1);
    }),/at capacity/);
  }
  assert.deepEqual(delays,[]);
});

test('parsed asks and background work never gain automatic model calls',async t=>{
  const delays=fastRecovery(t);
  for(const options of [{mode:'ask',purpose:'chat'},{mode:'work',purpose:'auto'},{mode:'ask',purpose:'mail'}]){
    await assert.rejects(fakeRun(t,'overload-always',options,requests=>assert.equal(requests.filter(q=>q.method==='turn/start').length,1)),/at capacity/);
  }
  assert.deepEqual(delays,[]);
});

test('an ambiguous recovery start failure is never resubmitted',async t=>{
  const delays=fastRecovery(t);
  await assert.rejects(fakeRun(t,'overload-rpc',{mode:'work',purpose:'chat'},requests=>assert.equal(requests.filter(q=>q.method==='turn/start').length,2)),/ambiguous recovery start/);
  assert.deepEqual(delays,[60000]);
});

test('workbench retains one active task, displays recovery, and the existing stop cancels the wait',async t=>{
  const saved=Object.fromEntries(['agent/config.json','work/queue.json','.runtime/agent/sessions.json'].map(f=>[f,read(f)]));
  t.after(()=>{for(const [f,v] of Object.entries(saved))write(f,v);});
  write('agent/config.json',{...saved['agent/config.json'],memory_v2:{enabled:false}});
  const job=submit({text:'@Codex continue fixture'});let inspected=false;
  await executeWithoutTitle(executeAgent)(job.task_id,(_,prompt,opts)=>fakeRun(t,'overload-always',{...opts,onEvent:e=>{
    opts.onEvent(e);
    if(e.type==='text' && e.text.startsWith('Codex 模型拥堵')){
      const task=read('work/queue.json').items.find(i=>i.id===job.task_id);
      assert.equal(task.status,'active');
      const session=agentSnapshot().sessions.find(s=>s.id===job.session_id);
      assert.ok(session.messages.some(e=>e.text.includes('1 分钟后自动续做')));
      inspected=true;stop(job.task_id);
    }
  }},requests=>assert.equal(requests.filter(q=>q.method==='turn/start').length,1)));
  assert.equal(inspected,true);
  assert.equal(read('work/queue.json').items.find(i=>i.id===job.task_id).status,'cancelled');
});

test('new user intent during the wait supersedes the automatic wakeup and continues through the existing queue',async t=>{
  const {sendChat}=await import('../agent/run.mjs');
  const saved=Object.fromEntries(['agent/config.json','work/queue.json','.runtime/agent/sessions.json'].map(f=>[f,read(f)]));
  t.after(()=>{for(const [f,v] of Object.entries(saved))write(f,v);});
  write('agent/config.json',{...saved['agent/config.json'],memory_v2:{enabled:false}});
  const job=submit({text:'@Codex ORIGINAL FIXTURE TASK'});let latest;
  const execute=executeWithoutTitle(executeAgent);
  await execute(job.task_id,(_,prompt,opts)=>fakeRun(t,'overload-always',{...opts,onEvent:e=>{
    opts.onEvent(e);
    if(e.type==='text' && e.text.startsWith('Codex 模型拥堵'))latest=sendChat({session_id:job.session_id,text:'UPDATED USER INSTRUCTION'});
  }},requests=>assert.equal(requests.filter(q=>q.method==='turn/start').length,1)));
  const next=await latest;
  assert.equal(read('work/queue.json').items.find(i=>i.id===next.task_id).status,'queued');
  assert.match(read('work/queue.json').items.find(i=>i.id===job.task_id).handoff,/已取消自动唤起/);
  await execute(next.task_id,async(_,prompt)=>{
    assert.match(prompt,/ORIGINAL FIXTURE TASK/);assert.match(prompt,/UPDATED USER INSTRUCTION/);
    return {result:'Completed latest request'};
  });
  assert.equal(read('work/queue.json').items.find(i=>i.id===next.task_id).status,'done');
});
