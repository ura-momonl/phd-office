import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {read,write} from './files.mjs';
import {claudeArgs,claudeSignature,claudeSessionExists,claudeForkPoint,invokeClaude} from '../agent/claude.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {startCodexTurn,usageDelta,codexUsageFields,continuationSignature,codexLaunch} from '../agent/codex.mjs';
import {submit,execute as executeAgent,sendChat,editMessage,answerQuestion,stop,startReadyWork} from '../agent/run.mjs';
import {enqueue,update,repeatOperation} from '../work/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mailGuide,mailBrief} from '../mail-flow/guide.mjs';
import {frameworkFile,parseFramework} from '../projects/framework.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent),file='.runtime/agent/sessions.json';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const sessionOf=id=>read(file).sessions.find(s=>s.id===id);
const params={sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review'};
const thread=id=>({thread:{id},sandbox:{type:'workspaceWrite'},model:'test'});

test('operation continuations send only additions; fresh threads retain context and material changes',async()=>{
  const paths=['work/queue.json','work/turns.json',file,'agent/config.json'];
  const saved=new Map(paths.map(p=>[p,read(p)]));
  const occurrences=(text,value)=>text.split(value).length-1;
  try {
    write('agent/config.json',{...saved.get('agent/config.json'),enabled:true,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    for(const provider of ['codex','claude']) {
      const dependency=enqueue({title:'Operation input fixture',kind:'framework',actor:provider,require_outputs:false});
      update({id:dependency.id,status:'done',handoff:'DEPENDENCY_CONTEXT_V1',outputs:[]});
      const original='UNCHANGED_OPERATION_OBJECTIVE_'+provider,changed='REVISED_OPERATION_OBJECTIVE_'+provider;
      const op=enqueue({title:'Continuation envelope fixture',goal:original,kind:'framework',actor:provider,status:'queued',require_outputs:false,dependencies:[dependency.id]});
      const key=provider+'_continuation',threadId='operation-envelope-'+provider;
      let sessionId;
      const run=async(job,check,resumed=true)=>{
        const started=startReadyWork().find(j=>j.task_id===job.id);assert.ok(started);
        sessionId=started.session_id;
        let called=false;
        await execute(job.id,async(_,prompt,opts)=>{
          called=true;check(prompt,opts);
          assert.equal(opts.inputParts.map(p=>p.text).join('\n'),prompt);
          assert.equal(opts.resumeInputParts.map(p=>p.text).join('\n'),opts.resumePrompt);
          opts.onContinuation({threadId,signature:'fixture'},{phase:'start',resumed});
          update({id:op.id,status:'done',handoff:'Fixture delivered.',outputs:[]});
          return {result:'Fixture response, without a model call.'};
        });
        assert.ok(called);
      };
      await run(op,(prompt)=>assert.equal(occurrences(prompt,original),1),false);
      for(const direction of ['SECOND_EXECUTION_DELTA','THIRD_EXECUTION_DELTA']) {
        const job=repeatOperation({id:op.id,input:direction});
        await run(job,(prompt,opts)=>{
          assert.equal(occurrences(prompt,original),1,'fresh fallback has one full objective, not one per old run');
          assert.ok(opts.resumePrompt.includes(direction));
          assert.ok(!opts.resumePrompt.includes(original));
          assert.ok(!opts.resumePrompt.includes('DEPENDENCY_CONTEXT_V1'));
          assert.ok(opts.resumePrompt.includes(job.id));assert.ok(opts.resumePrompt.includes(op.id));
        });
      }
      const stored=sessionOf(sessionId).messages.filter(m=>m.operation_prompt);
      assert.equal(stored.length,3);assert.ok(stored.every(m=>m.text.includes(original)),'saved full operation messages are not rewritten');
      const queue=read('work/queue.json');queue.items.find(i=>i.id===op.id).goal=changed;write('work/queue.json',queue);
      await run(repeatOperation({id:op.id,input:'CHANGED_GOAL_DELTA'}),(_,opts)=>{
        assert.ok(opts.resumePrompt.includes(changed),'changed instructions are sent in full');
        assert.ok(opts.resumePrompt.includes('DEPENDENCY_CONTEXT_V1'));
      });
      update({id:dependency.id,handoff:'DEPENDENCY_CONTEXT_V2'});
      await run(repeatOperation({id:op.id,input:'CHANGED_EVIDENCE_DELTA'}),(_,opts)=>{
        assert.ok(opts.resumePrompt.includes(changed));assert.ok(opts.resumePrompt.includes('DEPENDENCY_CONTEXT_V2'),'changed predecessor evidence is not hidden');
      });
      const state=read(file);delete state.sessions.find(s=>s.id===sessionId)[key];write(file,state);
      await run(repeatOperation({id:op.id,input:'REBUILT_THREAD_DELTA'}),(prompt)=>{
        for(const value of [original,changed,'DEPENDENCY_CONTEXT_V1','DEPENDENCY_CONTEXT_V2','SECOND_EXECUTION_DELTA','THIRD_EXECUTION_DELTA','REBUILT_THREAD_DELTA'])assert.ok(prompt.includes(value),'fresh thread retains '+value);
        assert.equal(occurrences(prompt,original),1);
      },false);
    }
  } finally {for(const [p,value] of saved)write(p,value);}
});

test('return inputs do not repeat identical handoffs but retain distinct execution explanations',async()=>{
  const paths=['work/queue.json','work/turns.json',file,'agent/config.json'];
  const saved=new Map(paths.map(p=>[p,read(p)]));
  try {
    write('agent/config.json',{...saved.get('agent/config.json'),enabled:true,memory_v2:{enabled:false}});
    const source=enqueue({title:'Returned fixture',kind:'framework',actor:'codex',require_outputs:false});
    update({id:source.id,status:'done',handoff:'RETURNED_RESULT_ONCE',outputs:[]});
    const parent=enqueue({title:'Consume fixture return',kind:'framework',actor:'codex',require_outputs:false});
    const job=repeatOperation({id:parent.id,input:'Consume both result and explanation.',after:[source.id]});
    startReadyWork();
    let called=false;
    await execute(job.id,async(_,prompt)=>{
      called=true;assert.equal(prompt.split('RETURNED_RESULT_ONCE').length-1,1);
      assert.ok(prompt.includes('本轮结果状态：done'));
      return {result:'No model called.'};
    });
    assert.ok(called);
    const resultRun=repeatOperation({id:source.id,input:'Return a distinct explanation.'});
    startReadyWork();
    await execute(resultRun.id,async()=>{
      update({id:source.id,status:'done',handoff:'NEW_REGISTERED_RESULT',outputs:[]});
      return {result:'DISTINCT_EXECUTION_EXPLANATION'};
    });
    const next=repeatOperation({id:parent.id,input:'Consume the distinct explanation.',after:[resultRun.id]});
    startReadyWork();
    await execute(next.id,async(_,prompt)=>{
      assert.ok(prompt.includes('NEW_REGISTERED_RESULT'));assert.ok(prompt.includes('DISTINCT_EXECUTION_EXPLANATION'));
      return {result:'No model called.'};
    });
  } finally {for(const [p,value] of saved)write(p,value);}
});

test('unbound conversations give both providers progressive project entry points and update old native threads once',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  const artifacts=[];
  const check=prompt=>{
    assert.match(prompt,/未绑定项目：list 找ID/);
    for(const action of ['outline ID','search "ID#词"','read-nodes ID#节点ID,节点ID','context ID'])assert.ok(prompt.includes(action),action+' is discoverable without binding a project');
    assert.doesNotMatch(prompt,/历史日志完整索引|节点摘要：|文件目录 .*workspace[\\/]projects/);
  };
  try {
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    for(const who of ['Codex','Claude']) {
      const first=submit({text:'@'+who+' 查一下资料库里的项目。'}),id='project-entry-'+who,key=who.toLowerCase()+'_continuation';
      await execute(first.task_id,async(provider,prompt,opts)=>{
        assert.equal(provider,who.toLowerCase());check(prompt);artifacts.push({provider,route:'fresh',prompt});
        opts.onContinuation({threadId:id,signature:'fixture'},{phase:'start',resumed:false});return {result:'No model called.'};
      });
      // Simulate a native thread created before the new entry point existed.
      const state=read(file);state.sessions.find(s=>s.id===first.session_id)[key].contextHash='legacy-project-entry';write(file,state);
      const second=submit({text:'@'+who+' 继续查项目。',session_id:first.session_id});
      await execute(second.task_id,async(_,prompt,opts)=>{
        check(prompt);check(opts.resumePrompt);artifacts.push({provider:who.toLowerCase(),route:'legacy-resume',prompt:opts.resumePrompt});
        opts.onContinuation({threadId:id,signature:'fixture'},{phase:'start',resumed:true});return {result:'Entry received.'};
      });
      const third=submit({text:'@'+who+' 再继续。',session_id:first.session_id});
      await execute(third.task_id,async(_,prompt,opts)=>{
        check(prompt);assert.doesNotMatch(opts.resumePrompt,/未绑定项目：list 找ID/,'unchanged navigation is not resent on every native turn');
        return {result:'Navigation remains available without repeated injection.'};
      });
    }
    fs.mkdirSync('.runtime/test-artifacts',{recursive:true});
    fs.writeFileSync('.runtime/test-artifacts/project-progressive-prompts.json',JSON.stringify(artifacts,null,2)+'\n');
  } finally {
    write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);
  }
});

test('both providers see the configured subagent limit in fresh and resumed work prompts',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    for(const who of ['Codex','Claude']) {
      write('agent/config.json',{...read('agent/config.json'),subagent_max_concurrency:10});
      const first=submit({text:'@'+who+' Observe settings without delegating.'});
      await execute(first.task_id,async(_,prompt,opts)=>{
        assert.match(prompt,/本轮运行配置：子 agent 并发 10/);
        opts.onContinuation({threadId:'limit-'+who,signature:'fixture'},{phase:'start',resumed:false});return {result:'Read only.'};
      });
      write('agent/config.json',{...read('agent/config.json'),subagent_max_concurrency:1});
      const next=submit({text:'@'+who+' Continue without delegating.',session_id:first.session_id});
      await execute(next.task_id,async(_,prompt,opts)=>{
        for(const text of [prompt,opts.resumePrompt]){
          assert.match(text,/本轮运行配置：子 agent 并发 1，/);
          assert.doesNotMatch(text,/本轮运行配置：子 agent 并发 10/);
        }
        return {result:'New limit received.'};
      });
    }
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('child transcripts are retained for cards but excluded from fresh, resumed and other-provider history',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try{
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    for(const who of ['Codex','Claude']){
      const first=submit({text:'@'+who+' Fixture parent request.'}),key=who.toLowerCase()+'_continuation';
      await execute(first.task_id,async(provider,prompt,opts)=>{
        opts.onContinuation({threadId:'parent-'+provider,signature:'fixture'},{phase:'start',resumed:false});
        opts.onEvent({type:'text',text:'VISIBLE_PARENT_PROGRESS'});
        opts.onEvent({type:'text',text:'PRIVATE_CHILD_PROGRESS',sub:true,parent:'child-fixture'});
        return {result:'VISIBLE_PARENT_SUMMARY'};
      });
      // Include old unlinked child messages, unseen even by the resumed parent.
      const data=read(file),s=data.sessions.find(s=>s.id===first.session_id);
      s.messages.push({role:'assistant',provider:who.toLowerCase(),task_id:first.task_id,subagent:true,interim:true,text:'LEGACY_CHILD_TRANSCRIPT',at:new Date().toISOString()});
      s.subagent_runs=[{id:'child-fixture',task_id:first.task_id,provider:who.toLowerCase(),title:'CARD_TITLE_ONLY',prompt:'CARD_PROMPT_ONLY',text:'CARD_RESULT_ONLY',status:'completed'}];
      write(file,data);
      for(const recipient of [who,who==='Codex'?'Claude':'Codex']){
        const next=submit({text:'@'+recipient+' Continue fixture.',session_id:first.session_id});
        let received;
        await execute(next.task_id,async(_,prompt,opts)=>{
          received={prompt,resume:opts.resumePrompt};
          return {result:'Fixture continues.'};
        });
        assert.match(received.prompt,/VISIBLE_PARENT_PROGRESS/);assert.match(received.prompt,/VISIBLE_PARENT_SUMMARY/);
        for(const text of [received.prompt,received.resume])assert.doesNotMatch(text,/PRIVATE_CHILD_PROGRESS|LEGACY_CHILD_TRANSCRIPT|CARD_TITLE_ONLY|CARD_PROMPT_ONLY|CARD_RESULT_ONLY/);
      }
      // Rebuilding a native thread still gets the same filtered full prompt.
      const reset=read(file);delete reset.sessions.find(s=>s.id===first.session_id)[key];write(file,reset);
      const fresh=submit({text:'@'+who+' Rebuild fixture.',session_id:first.session_id});
      let rebuilt;
      await execute(fresh.task_id,async(_,prompt)=>{
        rebuilt=prompt;
        return {result:'Fresh fixture completed.'};
      });
      assert.match(rebuilt,/VISIBLE_PARENT_SUMMARY/);assert.doesNotMatch(rebuilt,/PRIVATE_CHILD_PROGRESS|LEGACY_CHILD_TRANSCRIPT|CARD_RESULT_ONLY/);
      assert.equal(sessionOf(first.session_id).messages.filter(m=>m.subagent).length,2,'display records remain intact');
    }
  }finally{write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('both native providers receive source invalidation without resending unchanged project orientation',async()=>{
  const paths=['work/queue.json',file,'agent/config.json','workspace/projects/graphene-thz/STATUS.md'];
  const saved=new Map(paths.map(p=>[p,fs.existsSync(p)?fs.readFileSync(p):null]));
  const framework=frameworkFile('graphene-thz'),original=fs.readFileSync(framework);
  const stableStatus=()=>fs.writeFileSync('workspace/projects/graphene-thz/STATUS.md','Stable execution ledger for source-version isolation.');
  try {
    const cfg=read('agent/config.json');write('agent/config.json',{...cfg,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    for(const who of ['Codex','Claude']) {
      fs.writeFileSync(framework,original);stableStatus();
      const first=submit({text:'@'+who+' Inspect project evidence.',project_id:'graphene-thz'});
      const key=who.toLowerCase()+'_continuation',id='project-source-'+who;
      await execute(first.task_id,async(_,prompt,opts)=>{
        assert.match(prompt,/projects outline graphene-thz/);assert.doesNotMatch(prompt,/历史日志完整索引/);
        opts.onContinuation({threadId:id,signature:'fixture'},{phase:'start',resumed:false});return {result:'Source read simulated.'};
      });
      const prior=sessionOf(first.session_id)[key];assert.ok(prior.projectSourceHash);
      const parsed=parseFramework(original.toString('utf8')),entry=parsed.nodes.find(n=>n.entry),lines=parsed.lines.slice();
      lines.splice(entry.bodyEnd,0,'INDEPENDENT_SOURCE_EDIT_WITNESS');fs.writeFileSync(framework,lines.join('\n'));stableStatus();
      const second=submit({text:'@'+who+' Continue.',session_id:first.session_id});
      await execute(second.task_id,async(_,prompt,opts)=>{
        assert.match(prompt,/projects outline graphene-thz/,'fresh receiver still gets evidence entry points');
        assert.match(opts.resumePrompt,/原始资料有变更/);
        assert.doesNotMatch(opts.resumePrompt,/projects outline graphene-thz|历史日志完整索引/,'unchanged entry points and full indexes are not resent');
        opts.onContinuation({threadId:id,signature:'fixture'},{phase:'start',resumed:true});return {result:'Source recheck simulated.'};
      });
      assert.notEqual(sessionOf(first.session_id)[key].projectSourceHash,prior.projectSourceHash);
      stableStatus();const third=submit({text:'@'+who+' Continue again.',session_id:first.session_id});
      await execute(third.task_id,async(_,prompt,opts)=>{
        assert.doesNotMatch(opts.resumePrompt,/项目原始资料版本|原始资料有变更|项目框架（资料/,'unchanged source is not repeatedly invalidated');
        return {result:'No source change.'};
      });
      fs.writeFileSync('workspace/projects/graphene-thz/STATUS.md','EXECUTION_LEDGER_ONLY_CHANGE');
      const fourth=submit({text:'@'+who+' Inspect work status.',session_id:first.session_id});
      await execute(fourth.task_id,async(_,prompt,opts)=>{
        assert.match(opts.resumePrompt,/项目执行记录有变更/);
        assert.doesNotMatch(opts.resumePrompt,/EXECUTION_LEDGER_ONLY_CHANGE/,'state changes invalidate reads, not preload unrelated state');
        assert.doesNotMatch(opts.resumePrompt,/项目原始资料版本|项目框架（资料/,'execution-ledger changes do not force a research-background resend');
        return {result:'Execution ledger seen.'};
      });
    }
  } finally {
    fs.writeFileSync(framework,original);
    for(const[p,b]of saved)if(b===null)fs.rmSync(p,{force:true});else fs.writeFileSync(p,b);
  }
});

test('resumed mail evidence is sent once per exact version, while fresh prompts and changed evidence stay complete',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  const id='validation-'+randomUUID(),db=new DatabaseSync('.runtime/mail-flow/mail.sqlite');
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(id,'mail fixture','todo','SOURCE_EVIDENCE '+('evidence '.repeat(200)));
  const sources=[
    {id:id+'-1',folder:'inbox',received:'2026-10-10T10:00:00Z',text:'Earlier request'},
    {id:id+'-2',folder:'sent',received:'2026-10-11T10:00:00Z',text:'Existing collaboration plan'},
    {id:id+'-3',folder:'inbox',received:'2026-10-12T10:00:00Z',text:'Latest partner reply'},
  ];
  for(const m of sources){
    db.prepare('INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,?,?,?)').run(m.id,m.id,JSON.stringify(m),'reviewed','fixture',0);
    db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run(m.id,id);
  }
  try {
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:['*']});
    const first=submit({text:'@Codex 请拟稿',inbox_reply:{id:'mail:'+id,action_id:'discuss'}});
    await execute(first.task_id,async(_,prompt,opts)=>{
      assert.match(prompt,/SOURCE_EVIDENCE/);opts.onContinuation({threadId:'mail-native',signature:'S',total:{}},{phase:'start',resumed:false});
      assert.match(prompt,/此前已发的表述与计划；接续依据，不是本轮新授权/);
      assert.match(prompt,/收到的邮件；对方的报告、请求或建议/);
      assert.ok(prompt.indexOf('Earlier request')<prompt.indexOf('Existing collaboration plan') && prompt.indexOf('Existing collaboration plan')<prompt.indexOf('Latest partner reply'),'source chronology survives role presentation');
      assert.ok(prompt.includes(mailBrief())&&!prompt.includes(mailGuide()),'a mail-card work turn gets the short brief, not the send mechanics');
      assert.ok(!prompt.includes('当前项目：'),'a card with no linked project still works without project context');
      return {result:'Draft for review'};
    });
    assert.ok(sessionOf(first.session_id).codex_continuation.focusHash);
    const second=submit({text:'@Codex 只改称呼',session_id:first.session_id});
    await execute(second.task_id,async(_,prompt,opts)=>{
      assert.match(prompt,/SOURCE_EVIDENCE/,'fresh-thread fallback retains all evidence');
      assert.ok(prompt.includes(mailBrief()),'fresh-thread fallback keeps the brief');
      assert.doesNotMatch(opts.resumePrompt,/SOURCE_EVIDENCE|这件事的邮件证据/,'unchanged exact evidence is already in native context');
      assert.match(opts.resumePrompt,/只改称呼/);assert.ok(opts.resumePrompt.length<prompt.length-1500);
      opts.onContinuation({threadId:'mail-native',signature:'S',total:{}},{phase:'start',resumed:true});return {result:'Revised'};
    });
    db.prepare('UPDATE tasks SET action=? WHERE id=?').run('CHANGED_EVIDENCE',id);
    const third=submit({text:'@Codex 后续安排',session_id:first.session_id});
    await execute(third.task_id,async(_,prompt,opts)=>{
      assert.match(opts.resumePrompt,/CHANGED_EVIDENCE/);assert.match(prompt,/CHANGED_EVIDENCE/);
      return {result:'New evidence seen'};
    });
  } finally {
    db.prepare('DELETE FROM sources WHERE task_id=?').run(id);
    for(const m of sources)db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);
  }
});

test('resume applies permissions, excludes hydration, sends delta; only pre-turn errors may fall back',async()=>{
  const run=async(fault)=>{
    const calls=[],published=[];let submitted=0;
    const rpc=async(method,p)=>{
      calls.push({method,p});
      if(method==='thread/resume') {if(fault==='resume')throw new Error('missing rollout');return fault==='sandbox' ? {...thread('old'),sandbox:{type:'readOnly'}} : thread('old');}
      if(method==='thread/start')return thread('new');
      if(fault==='turn')throw new Error('ambiguous timeout after turn/start');
      return {turn:{id:'T'}};
    };
    const work=startCodexTurn(rpc,{params,signature:'S',continuation:{threadId:'old',signature:'S',total:{inputTokens:100}},prompt:'FULL',resumePrompt:'DELTA',onThread:(state,info)=>published.push({state,info}),onSubmitted:()=>submitted++});
    if(fault==='turn')await assert.rejects(work,/ambiguous/);else await work;
    assert.equal(submitted,fault==='turn' ? 0 : 1,'file baseline commits only after turn/start acknowledgment');
    return {calls,published};
  };
  const ok=await run();assert.deepEqual(ok.calls.map(c=>c.method),['thread/resume','turn/start']);
  assert.equal(ok.calls[0].p.excludeTurns,true);assert.equal(ok.calls[0].p.sandbox,'workspace-write');assert.equal(ok.calls[0].p.approvalsReviewer,'auto_review');assert.equal(ok.calls[1].p.input[0].text,'DELTA');
  for(const fault of ['resume','sandbox']) {const r=await run(fault);assert.deepEqual(r.calls.map(c=>c.method),['thread/resume','thread/start','turn/start']);assert.equal(r.calls[1].p.ephemeral,false);assert.equal(r.calls[2].p.input[0].text,'FULL');assert.deepEqual(r.published[0].state.total,{});}
  const late=await run('turn');assert.equal(late.calls.filter(c=>c.method==='turn/start').length,1);assert.equal(late.calls.some(c=>c.method==='thread/start'),false);
});

test('new signature starts fresh; asks stay ephemeral; new-thread permission failure never starts a turn',async()=>{
  for(const continuation of [undefined,{threadId:'old',signature:'different'}]) {
    const calls=[];await startCodexTurn(async(method,p)=>{calls.push({method,p});return method==='turn/start' ? {turn:{id:'T'}} : thread('new');},{params,signature:'S',continuation,prompt:'FULL',resumePrompt:'DELTA'});
    assert.deepEqual(calls.map(c=>c.method),['thread/start','turn/start']);assert.equal(calls[0].p.ephemeral,!continuation);assert.equal(calls[1].p.input[0].text,'FULL');
  }
  let starts=0;await assert.rejects(startCodexTurn(async(method)=>{if(method==='turn/start')starts++;return {...thread('new'),sandbox:{type:'readOnly'}};},{params,signature:'S',continuation:{},prompt:'FULL'}),/写入权限/);assert.equal(starts,0);
  const launch=codexLaunch('ordinary');const s=continuationSignature(launch,'M','high');
  assert.notEqual(s,continuationSignature(launch,'M2','high'));assert.notEqual(s,continuationSignature(launch,'M','low'));assert.notEqual(s,continuationSignature({...launch,cwd:'other'},'M','high'));assert.notEqual(s,continuationSignature(codexLaunch('Fusion'),'M','high'));
});

test('usage ledger is a per-turn delta rather than the last request or the whole thread',()=>{
  assert.deepEqual(usageDelta({inputTokens:150,cachedInputTokens:60,outputTokens:25,totalTokens:175},{inputTokens:100,cachedInputTokens:40,outputTokens:20,totalTokens:120}),{inputTokens:50,cachedInputTokens:20,outputTokens:5,totalTokens:55});
  assert.deepEqual(usageDelta({inputTokens:15,outputTokens:3}),{inputTokens:15,outputTokens:3});
});

test('Codex ledger preserves absent usage fields as unknown and reported zeros as zero',()=>{
  assert.deepEqual(codexUsageFields({}),{input_tokens:null,cached_input_tokens:null,output_tokens:null});
  assert.deepEqual(codexUsageFields(usageDelta({inputTokens:15,outputTokens:3})),{input_tokens:15,cached_input_tokens:null,output_tokens:3});
  assert.deepEqual(codexUsageFields(usageDelta({inputTokens:15,cachedInputTokens:0,outputTokens:0})),{input_tokens:15,cached_input_tokens:0,output_tokens:0});
  assert.deepEqual(codexUsageFields(usageDelta({inputTokens:150,cachedInputTokens:60,outputTokens:25},{inputTokens:100,cachedInputTokens:40,outputTokens:20})),
    {input_tokens:50,cached_input_tokens:20,output_tokens:5});
});

test('append-only seen set excludes queued inputs, includes acknowledged steer and own output; Claude handoff occurs once',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')},ready=gate(),finish=gate();let running;
  try {
    const first=submit({text:'@Codex ORIGINAL',project_id:'bi-devices'});
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:[first.session_id]});
    let delta1;
    running=execute(first.task_id,async(_,prompt,opts)=>{
      delta1=opts.resumePrompt;opts.onContinuation({threadId:'N',signature:'S',total:{}},{phase:'start',resumed:false});
      opts.onEvent({type:'text',text:'OWN INTERIM'});
      opts.onReady(async text=>{if(text==='REJECTED')throw new Error('not delivered');});ready.resolve();await finish.promise;
      opts.onContinuation({threadId:'N',total:{inputTokens:100}},{phase:'finish'});return {result:'OWN FINAL',sessionId:'N'};
    });
    await ready.promise;
    const rejected=await sendChat({session_id:first.session_id,text:'REJECTED'});assert.equal(rejected.delivery,'pending');
    const accepted=await sendChat({session_id:first.session_id,text:'ACKNOWLEDGED'});assert.equal(accepted.delivery,'pending');
    finish.resolve();await running;
    const state=sessionOf(first.session_id);const seen=state.codex_continuation.seen;
    for(const text of ['ORIGINAL','OWN INTERIM','OWN FINAL','ACKNOWLEDGED'])assert.ok(seen.includes(state.messages.findIndex(m=>m.text.includes(text))),text);
    assert.ok(!seen.includes(state.messages.findIndex(m=>m.text==='REJECTED')));assert.equal(state.codex_continuation.total.inputTokens,100);
    await execute(rejected.task_id,async(_,prompt,opts)=>{
      assert.match(opts.resumePrompt,/当前请求：REJECTED$/);assert.doesNotMatch(opts.resumePrompt,/ORIGINAL|OWN INTERIM|OWN FINAL|ACKNOWLEDGED|当前项目/);
      opts.onContinuation({threadId:'N',signature:'S',total:{inputTokens:100}},{phase:'start',resumed:true});return {result:'REJECTED now handled',sessionId:'N'};
    });
    const next=submit({text:'@Claude NEXT',session_id:first.session_id,project_id:'bi-devices'}),later=submit({text:'@Codex FUTURE QUEUED',session_id:first.session_id});
    await execute(next.task_id,async(provider,prompt,opts)=>{
      if(provider==='claude')return {result:'CLAUDE HANDOFF\n@Codex continue'};
      assert.doesNotMatch(prompt,/FUTURE QUEUED/);
      assert.equal(opts.resumePrompt.split('CLAUDE HANDOFF').length-1,1);
      assert.doesNotMatch(opts.resumePrompt,/FUTURE QUEUED|OWN FINAL|ACKNOWLEDGED/);
      assert.match(opts.resumePrompt,/今天是 .*（America\/Chicago）/);
      // A changed project status must be synchronized, unlike the unchanged prior turn.
      assert.match(opts.resumePrompt,/当前项目/);
      return {result:'finished'};
    });
    assert.equal(read('work/queue.json').items.find(i=>i.id===later.task_id).status,'queued');assert.ok(delta1);
  } finally {finish.resolve();await running;write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('handoff keeps user goals current, promotes acknowledged corrections, and retains their attachments',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    for(const pilot of [true,false]) {
      write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:pilot?['*']:[],claude_resume_sessions:pilot?['*']:[]});
      const first=submit({text:'@Codex SCREEN_FIRST_PACKAGE_THEN_REPORT'});let n=0,correction;
      await execute(first.task_id,async(provider,prompt,opts)=>{
        if(++n===1){
          opts.onReady(async()=>{});
          correction=await sendChat({session_id:first.session_id,text:'ONLY_FIRST_PACKAGE_KEEP_SCREENING',files:[{name:'criteria.txt',data_url:'data:text/plain;base64,Y3JpdGVyaWE='}]});
          await new Promise(r=>setImmediate(r));
          return {result:'HANDOFF_PROGRESS\n@Claude prepare packages only'};
        }
        assert.equal(provider,'claude');
        for(const [input,parts] of [[prompt,opts.inputParts],[opts.resumePrompt,opts.resumeInputParts]].filter(([p])=>p)){
          assert.equal(parts.map(p=>p.text).join('\n'),input);
          assert.ok(!parts.some(p=>['current_request','colleague_report'].includes(p.kind)));
          const record=parts.find(p=>p.kind==='conversation_history').text.split('\n').slice(1).map(JSON.parse);
          assert.deepEqual(record.map(m=>m.text),['@Codex SCREEN_FIRST_PACKAGE_THEN_REPORT','ONLY_FIRST_PACKAGE_KEEP_SCREENING','HANDOFF_PROGRESS\n@Claude prepare packages only']);
          assert.equal(record[1].role,'user');assert.match(JSON.stringify(record[1].attachments),/criteria\.txt/);
          assert.equal(record.at(-1).role,'assistant');assert.equal(record.at(-1).provider,'codex');
        }
        for(const input of [prompt,opts.resumePrompt].filter(Boolean)) {
          assert.match(input,/SCREEN_FIRST_PACKAGE_THEN_REPORT/,'original goal remains available');
          assert.match(input,/SCREEN_FIRST_PACKAGE_THEN_REPORT[^]*ONLY_FIRST_PACKAGE_KEEP_SCREENING[^]*criteria\.txt[^]*HANDOFF_PROGRESS/);
          assert.equal(input.split('HANDOFF_PROGRESS').length-1,1,'handoff context is not duplicated');
          assert.doesNotMatch(input,/当前请求：|同事回复（引文）|已回应过，不要当成新输入重答/);
        }
        return {result:'Screened first package.'};
      });
      assert.equal(n,2);assert.equal(read('work/queue.json').items.find(i=>i.id===correction.task_id).merged_into,first.task_id);
    }
  }finally{write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('later named speakers receive the complete acknowledged user request rather than a truncated queue goal',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false}});
    const first=submit({text:'@Claude original input'}),text='@Claude @Codex '+'材料\n'.repeat(1800)+'最后决定：题名粗筛';
    let correction;
    await execute(first.task_id,async(_,prompt,opts)=>{
      opts.onReady(async()=>{});
      correction=await sendChat({session_id:first.session_id,text,files:[{name:'source-criteria.txt',data_url:'data:text/plain;base64,Y3JpdGVyaWE='}]});
      await new Promise(r=>setImmediate(r));return {result:'Claude finished the active input.'};
    });
    const next=read('work/queue.json').items.find(i=>i.request_task_id===correction.task_id);
    assert.ok(next);assert.equal(next.goal,text);
    let invoked=false;
    await execute(next.id,async(provider,prompt,opts)=>{
      invoked=true;assert.equal(provider,'codex');
      assert.ok(prompt.includes(text));
      assert.match(opts.inputParts.at(-1).text,/最后决定：题名粗筛[^]*source-criteria\.txt/);
      return {result:'Codex received the full request and attachment.'};
    });
    assert.equal(invoked,true);
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('Claude selects models only from explicit options or configuration, never Opus mentions in conversation',async t=>{
  const saved=read('agent/config.json'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-model-fixture-'));
  const launches=[];
  t.mock.method(childProcess,'spawn',(_,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    const model=args[args.indexOf('--model')+1];launches.push(model);
    child.stdin=new Writable({write(chunk,encoding,done){
      const request=JSON.parse(chunk.toString());done();
      setImmediate(()=>{
        child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session',model})+'\n');
        child.stdout.write(JSON.stringify({...request,type:'user'})+'\n');
        child.stdout.write(JSON.stringify({type:'result',result:'fixture only',usage:{}})+'\n');
      });
    }});
    child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
    return child;
  });syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();write('agent/config.json',saved);fs.rmSync(directory,{recursive:true,force:true});});
  const cases=[
    {text:'当前请求：你要当妹子吗，作为opus的妹妹'},
    {text:'当前请求：Opus 妹妹倒是可以留，如果你不排斥一个妹子的外形的话'},
    {text:'当前请求：那很奇怪，我并没有换成opus 5.5'},
    {text:'Quoted mail: OPUS is mentioned, not a model instruction'},
    {text:'对话记录：当前请求：Opus 妹妹\n当前请求：不改模型'},
    {text:'当前请求：讨论 opus',model:'haiku',expected:'haiku'},
    {text:'当前请求：普通任务',model:'opus',expected:'opus'},
    {text:'当前请求：普通任务',configured:'opus',expected:'opus'},
    {text:'当前请求：讨论 opus',model:'claude-sonnet-5-5',expected:'claude-sonnet-5-5'},
  ];
  for(const [i,c] of cases.entries()) {
    write('agent/config.json',{...saved,claude_model:c.configured || 'sonnet'});
    const dir=path.join(directory,String(i));fs.mkdirSync(dir);
    const expected=c.expected || 'sonnet';let selectedSignature;
    const result=await invokeClaude(c.text,{directory:dir,model:c.model,effort:'high',continuation:{},
      onContinuation:(state,info)=>{if(info.phase==='start')selectedSignature=state.signature;}});
    assert.equal(launches.at(-1),expected,c.text);
    assert.equal(result.model,expected);
    assert.equal(selectedSignature,claudeSignature(expected,'high'),'continuation identity must use the selected model too');
  }
  assert.equal(launches.length,cases.length,'one fake process per case, no model calls or retries');
});

test('Claude usage ledger includes children, late snapshots, resume deltas and failed work without duplicating tasks',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-usage-fixture-')),oldConfig=process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR=path.join(directory,'native');
  const projects=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(projects,{recursive:true});
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();if(oldConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldConfig;fs.rmSync(directory,{recursive:true,force:true});});
  const u=(inputTokens,cacheReadInputTokens,cacheCreationInputTokens,outputTokens)=>({inputTokens,cacheReadInputTokens,cacheCreationInputTokens,outputTokens});
  const base={sonnet:u(2,10,3,4),haiku:u(5,20,6,8)};
  const next={sonnet:u(3,15,4,10),haiku:u(8,30,7,50)};
  let currentChild,launchArgs;
  t.mock.method(childProcess,'spawn',(_bin,args)=>{launchArgs=args;return currentChild;});syncBuiltinESMExports();
  async function simulate(name,{baseline,checkpoint,fork,changed=false,failed=false,mode='work',snapshots=[next],known=true,expected=60,reset=false}={}){
    const sid=randomUUID(),runId=name+'-'+randomUUID(),dir=path.join(directory,runId);fs.mkdirSync(dir);
    if(baseline!==undefined)fs.writeFileSync(path.join(projects,sid+'.jsonl'),JSON.stringify({type:'cost-state',sessionId:sid,modelUsage:baseline})+'\n');
    const child=new EventEmitter(),written=[],states=[];currentChild=child;
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_enc,done){if(mode==='work')written.push(JSON.parse(chunk.toString()));done();}});
    child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
    const continuation=baseline!==undefined ? {threadId:sid,signature:claudeSignature('fixture','high'),...(checkpoint ? {total:{modelUsage:checkpoint}} : {}),...(fork?{forkAt:'cut'}:{})} : undefined;
    if(changed)continuation.signature='changed';
    const running=invokeClaude('INITIAL',{directory:dir,model:'fixture',effort:'high',mode,continuation,resumePrompt:'DELTA',onContinuation:(s,i)=>states.push(structuredClone({s,i}))});
    const rejection=failed?assert.rejects(running,/limit/):null;
    const emit=e=>child.stdout.write(JSON.stringify(e)+'\n');
    emit({type:'system',subtype:'init',session_id:sid,model:'sonnet'});
    if(mode==='work'){emit({...written[0],type:'user'});emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'child'}]});}
    for(const [i,modelUsage]of snapshots.entries())emit({type:'result',session_id:reset&&i>0?'reset-session':sid,modelUsage,result:'done',is_error:failed,errors:failed?['limit']:undefined,usage:{input_tokens:1,output_tokens:1}});
    if(mode==='work')emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
    if(rejection)await rejection;else await running;
    const rows=readLedger().filter(r=>r.id===runId);assert.equal(rows.length,1,'one original task, not one row per model');
    const row=rows[0];assert.equal(row.output_tokens,expected,name);assert.equal(row.usage_known,known,name);assert.equal(row.status,failed?'failed':'completed');
    if(baseline!==undefined&&!changed)assert.ok(launchArgs.includes('--resume'));
    return {row,states};
  }
  function readLedger(){return fs.readFileSync('.runtime/usage/runs.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
  const fresh=await simulate('usage-fresh',{snapshots:[base,base,next,next]});
  assert.equal(fresh.row.input_tokens,67);assert.equal(fresh.row.cached_input_tokens,45);assert.equal(fresh.row.cache_creation_tokens,11);
  assert.deepEqual(fresh.row.model_usage,next);assert.deepEqual(fresh.states.at(-1).s.total.modelUsage,next);
  await simulate('usage-resume',{baseline:base,checkpoint:base,expected:48});
  await simulate('usage-old-resume',{baseline:base,expected:48});
  await simulate('usage-partial-baseline',{baseline:{sonnet:{inputTokens:2,outputTokens:4}},known:false,expected:56});
  await simulate('usage-fresh-config',{baseline:base,checkpoint:base,changed:true});
  await simulate('usage-fork',{baseline:base,fork:true,known:false,expected:0});
  await simulate('usage-failed',{failed:true});
  await simulate('usage-missing-field',{snapshots:[{sonnet:{contextWindow:1000000}}],known:false,expected:0});
  await simulate('usage-reset',{snapshots:[base,next],reset:true,expected:72});
  await simulate('usage-ask',{mode:'ask'});
});

test('Claude keeps accepting input across a result with an unreplayed message, then closes after the last result',async t=>{
  // Incident order: result -> delayed replay -> tools -> another user instruction.
  // Substitute only the child process; exercise the real adapter's JSON stream and stdin lifecycle.
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-input-fixture-'));
  const child=new EventEmitter(),written=[];let send;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,encoding,done){written.push(JSON.parse(chunk.toString()));done();}});
  child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
  t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});});
  const emit=e=>child.stdout.write(JSON.stringify(e)+'\n');
  const running=invokeClaude('INITIAL',{directory,model:'fixture',onReady:fn=>{send=fn;}});
  emit({type:'system',subtype:'init',session_id:'fixture-session'});
  emit({...written[0],type:'user'});
  await assert.rejects(send('WRONG CONFIG',{model:'different-native-model'}),/原生运行配置不同/);
  await assert.rejects(send('WRONG MODE',{mode:'ask'}),/原生运行配置不同/);
  assert.equal(written.length,1,'native configuration rejection must not write partial input');
  const first=send('FIRST LATE INPUT');
  emit({type:'result',result:'earlier reply',usage:{input_tokens:3,output_tokens:1}});
  assert.equal(child.stdin.writableEnded,false,'the first result must not shut the next native turn out');
  emit({...written[1],type:'user'});await first;
  emit({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Read',input:{file_path:'fixture.md'}}]}});
  const second=send('SECOND LATE INPUT');
  assert.equal(written[2].message.content,'SECOND LATE INPUT');
  emit({...written[2],type:'user'});await second;
  emit({type:'result',result:'final reply including both inputs',usage:{input_tokens:5,output_tokens:2}});
  const result=await running;
  assert.equal(result.result,'final reply including both inputs');assert.equal(child.stdin.writableEnded,true);
  assert.equal(result.usage.input_tokens,8);assert.equal(result.usage.output_tokens,3);
  await assert.rejects(send('TOO LATE'),/已结束/);
});

test('Claude background result keeps the live channel usable until tasks and the latest input finish',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-background-fixture-'));
  const child=new EventEmitter(),written=[];let send;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,encoding,done){written.push(JSON.parse(chunk.toString()));done();}});
  child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
  t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});});
  const emit=e=>child.stdout.write(JSON.stringify(e)+'\n');
  const running=invokeClaude('INITIAL',{directory,model:'fixture',onReady:fn=>{send=fn;}});
  // Observed resume startup order: an empty result can precede the initial replay.
  emit({type:'result',result:'',usage:{}});
  assert.equal(child.stdin.writableEnded,false);
  emit({...written[0],type:'user'});
  emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'harmless-background'}]});
  emit({type:'result',result:'background started',usage:{input_tokens:2}});
  assert.equal(child.stdin.writableEnded,false,'a background run must not become active but deaf');
  const late=send('LATEST INSTRUCTION');
  emit({...written[1],type:'user'});await late;
  emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
  assert.equal(child.stdin.writableEnded,false,'task completion cannot cut off an acknowledged but unfinished request');
  emit({type:'result',result:'LATEST INSTRUCTION handled',usage:{input_tokens:3}});
  assert.equal((await running).result,'LATEST INSTRUCTION handled');
  await assert.rejects(send('TOO LATE'),/已结束/);
});

test('Claude keeps user input open when a background hand-back starts the next wave before the last child exits',async t=>{
  // 2026-10-23 incident 1b541852: a previous result remained latched while the main
  // agent announced wave 2; background_tasks_changed [] then closed stdin at event 559.
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-wave-input-fixture-'));
  const child=new EventEmitter(),written=[];let send;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,_encoding,done){written.push(JSON.parse(chunk.toString()));done();}});
  child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
  t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});});
  const emit=e=>child.stdout.write(JSON.stringify(e)+'\n');
  const running=invokeClaude('INITIAL',{directory,model:'fixture',onReady:fn=>{send=fn;}});
  emit({type:'system',subtype:'init',session_id:'fixture-session'});
  emit({...written[0],type:'user'});
  emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'wave-1-child'}]});
  emit({type:'result',result:'Wave 1 running',usage:{input_tokens:2}});
  emit({type:'assistant',parent_tool_use_id:'wave-1-child',message:{content:[{type:'text',text:'Child finished'}]}});
  // A main turn can begin with either a returned message or its first assistant output.
  emit({type:'user',parent_tool_use_id:null,message:{role:'user',content:'<agent-message>Wave 1 hand-back</agent-message>'}});
  emit({type:'assistant',parent_tool_use_id:null,message:{content:[{type:'text',text:'Now starting wave 2'}]}});
  emit({type:'system',subtype:'task_notification',task_id:'wave-1-child',status:'completed'});
  emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
  assert.equal(child.stdin.writableEnded,false,'zero children is not an idle main agent');
  const late=send('STOP DISPATCHING');
  assert.equal(written[1]?.message.content,'STOP DISPATCHING');
  emit({...written[1],type:'user'});await late;
  emit({type:'result',result:'STOP DISPATCHING handled',usage:{input_tokens:3}});
  assert.equal((await running).result,'STOP DISPATCHING handled');
  assert.equal(child.stdin.writableEnded,true,'the genuine final result still ends the turn');
});

test('Claude result that hands the turn to Codex ends the turn despite a background task, and later input is refused',async t=>{
  // Incident 2026-10-21: a background export kept the CLI alive; the @Codex result stayed "live", later user messages were steered into it,
  // and the CLI's next result overwrote the handoff so Codex was never called.
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-handoff-fixture-'));
  const child=new EventEmitter(),written=[];let send,killed=false;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,encoding,done){written.push(JSON.parse(chunk.toString()));done();}});
  child.kill=()=>{killed=true;setImmediate(()=>{child.stdout.end();child.emit('close',1);});};
  t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});});
  const emit=e=>child.stdout.write(JSON.stringify(e)+'\n');
  const running=invokeClaude('INITIAL',{directory,model:'fixture',onReady:fn=>{send=fn;}});
  emit({type:'system',subtype:'init',session_id:'fixture-session'});
  emit({...written[0],type:'user'});
  emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'export'}]});
  emit({type:'result',result:'done.\n\n@Codex please clear the copy.',usage:{input_tokens:2,output_tokens:1}});
  const result=await running;
  assert.match(result.result,/^@Codex/m,'the handoff result is the turn result');
  assert.equal(killed,true);
  await assert.rejects(send('NEXT USER MESSAGE'),/已结束/);
});

test('native-rejected messages remain individual inputs, never batched by workbench on later startup',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    for(const provider of ['claude','codex'])for(const pilot of [true,false]) {
      write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:pilot?['*']:[],claude_resume_sessions:pilot?['*']:[]});
      const first=submit({text:'@'+provider+' ORIGINAL'}),late=[],received=[];
      await execute(first.task_id,async(_,prompt,opts)=>{
        opts.onReady(async text=>{received.push(text);throw new Error('native closed');});
        late.push(await sendChat({session_id:first.session_id,text:'FIRST INPUT'}));
        late.push(await sendChat({session_id:first.session_id,text:'SECOND INPUT',files:[{name:'input.txt',data_url:'data:text/plain;base64,aW5wdXQ='}]}));
        await new Promise(r=>setImmediate(r));return {result:'original completed'};
      });
      assert.deepEqual(received.map(t=>t.split('\n')[0]),['FIRST INPUT','SECOND INPUT']);
      for(let n=0;n<late.length;n++) {
        const own=late[n],other=late[1-n],q=read('work/queue.json');
        assert.equal(q.items.find(i=>i.id===own.task_id).followup_of,undefined);
        await execute(own.task_id,async(who,prompt,opts)=>{
          assert.equal(who,provider);
          const input=pilot?opts.resumePrompt:prompt;
          assert.match(input,n===0 ? /当前请求：FIRST INPUT$/ : /当前请求：SECOND INPUT/);
          if(n===0)assert.doesNotMatch(input,/SECOND INPUT|input\.txt/);
          else assert.match(input,/input\.txt/);
          opts.onSubmitted();return {result:'handled input '+n};
        });
        assert.equal(read('work/queue.json').items.find(i=>i.id===own.task_id).merged_into,undefined);
        if(n===0)assert.equal(read('work/queue.json').items.find(i=>i.id===other.task_id).status,'queued');
      }
    }
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('new messages never replay rejected or unacknowledged earlier messages',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file)};
  try {
    for(const provider of ['codex','claude']) {
      const first=submit({text:'@'+provider+' ORIGINAL'}),ready=gate(),finish=gate(),seen=[];
      let resolvePending;
      const running=execute(first.task_id,async(_,prompt,opts)=>{
        opts.onReady(text=>{
          seen.push(text);
          if(text==='OLD REJECTED')return Promise.reject(new Error('native rejected'));
          if(text==='STILL IN FLIGHT')return new Promise(resolve=>{resolvePending=resolve;});
          return Promise.resolve();
        });ready.resolve();await finish.promise;return {result:'LATEST handled'};
      });
      try {
        await ready.promise;
        const old=await sendChat({session_id:first.session_id,text:'OLD REJECTED'});await new Promise(r=>setImmediate(r));
        await sendChat({session_id:first.session_id,text:'LATEST'});
        const pending=await sendChat({session_id:first.session_id,text:'STILL IN FLIGHT'});
        await sendChat({session_id:first.session_id,text:'EVEN NEWER'});await new Promise(r=>setImmediate(r));
        assert.deepEqual(seen,['OLD REJECTED','LATEST','STILL IN FLIGHT','EVEN NEWER']);
        assert.equal(read('work/queue.json').items.find(i=>i.id===old.task_id).status,'queued');
        resolvePending();finish.resolve();await running;
        assert.equal(read('work/queue.json').items.find(i=>i.id===pending.task_id).status,'done');
      } finally {resolvePending?.();finish.resolve();await running;}
    }
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);}
});

test('a rejected user message keeps its recipient and runs before the unsent colleague handoff',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file)};
  try {
    for(const source of ['codex','claude']) {
      const target=source==='claude'?'codex':'claude',first=submit({text:'@'+source+' ORIGINAL'});
      let late,calls=0;
      await execute(first.task_id,async(provider,prompt,opts)=>{
        calls++;
        if(provider===source) {
          opts.onReady(async()=>{throw new Error('native closed');});
          late=await sendChat({session_id:first.session_id,text:'LATE INPUT FOR SOURCE'});
          await new Promise(r=>setImmediate(r));return {result:'HANDOFF\n@'+target+' continue'};
        }
        assert.doesNotMatch(prompt,/LATE INPUT FOR SOURCE/);
        opts.onSubmitted();return {result:'handoff handled'};
      });
      assert.equal(calls,1,'the queued user message takes priority over the unsent colleague');
      const item=read('work/queue.json').items.find(i=>i.id===late.task_id);
      assert.equal(item.status,'queued');assert.equal(item.executor,source);assert.equal(item.merged_into,undefined);
      const pending=read('work/queue.json').items.find(i=>i.id===first.task_id && i.handoff_resume);
      assert.equal(pending.executor,target);
      await execute(late.task_id,async(provider,prompt,opts)=>{
        assert.equal(provider,source);assert.match(prompt,/当前请求：LATE INPUT FOR SOURCE$/);
        opts.beforeSubmit();return {result:'source handled late user input'};
      });
      await execute(pending.id,async(provider,prompt,opts)=>{
        assert.equal(provider,target);assert.match(prompt,/LATE INPUT FOR SOURCE/);assert.ok(prompt.endsWith('当前请求：@'+source+' ORIGINAL'));
        opts.beforeSubmit();return {result:'colleague continues after user'};
      });
      assert.equal(read('work/queue.json').items.find(i=>i.id===late.task_id).merged_into,undefined);
    }
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);}
});

test('Claude resume: --resume only for work turns, signature and missing transcript decide fresh start',()=>{
  const resumed=claudeArgs('sonnet',{mode:'work',resume:'ID'});assert.equal(resumed[resumed.indexOf('--resume')+1],'ID');
  assert.ok(!claudeArgs('sonnet',{mode:'ask',resume:'ID'}).includes('--resume'));assert.ok(!claudeArgs('sonnet').includes('--resume'));
  const s=claudeSignature('sonnet','high');
  assert.notEqual(s,claudeSignature('opus','high'));assert.notEqual(s,claudeSignature('sonnet','low'));assert.notEqual(s,claudeSignature('sonnet','high','other prompt'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-cfg-')),id='0d8c6a1e-3f50-4b7d-9a11-5c2e7f4b8a90';
  try {
    assert.equal(claudeSessionExists(id,dir),false);
    fs.mkdirSync(path.join(dir,'projects','D--Main-assistant'),{recursive:true});
    assert.equal(claudeSessionExists(id,dir),false);
    fs.writeFileSync(path.join(dir,'projects','D--Main-assistant',id+'.jsonl'),'');
    assert.equal(claudeSessionExists(id,dir),true);assert.equal(claudeSessionExists('../'+id,dir),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('global resume pilot covers existing and future conversations without sharing threads; asks and disabled pilot stay unchanged',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:[]});
    const existing=submit({text:'@Codex BEFORE GLOBAL'});
    await execute(existing.task_id,async(_,prompt,opts)=>{
      assert.equal(opts.continuation,undefined);return {result:'old reply'};
    });
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:['*']});
    const oldNext=submit({session_id:existing.session_id,text:'@Codex EXISTING START'});
    const fresh=submit({text:'@Codex FUTURE START'});
    assert.notEqual(existing.session_id,fresh.session_id);
    for(const [job,id] of [[oldNext,'OLD'],[fresh,'FRESH']]) {
      await execute(job.task_id,async(provider,prompt,opts)=>{
        assert.equal(provider,'codex');assert.equal(opts.mode,'work');assert.deepEqual(opts.continuation,{});
        if(id==='OLD')assert.match(prompt,/BEFORE GLOBAL|old reply/);
        else assert.doesNotMatch(prompt,/BEFORE GLOBAL|old reply|EXISTING START/);
        opts.onContinuation({threadId:id,signature:'S',total:{}},{phase:'start',resumed:false});
        return {result:`${id} OWN OUTPUT`,sessionId:id};
      });
    }
    for(const [session,id] of [[existing.session_id,'OLD'],[fresh.session_id,'FRESH']]) {
      const next=submit({session_id:session,text:`@Codex ${id} NEXT`});
      await execute(next.task_id,async(_,prompt,opts)=>{
        assert.equal(opts.continuation.threadId,id);assert.match(opts.resumePrompt,new RegExp(`${id} NEXT`));
        assert.doesNotMatch(opts.resumePrompt,/BEFORE GLOBAL|OWN OUTPUT|EXISTING START|FUTURE START/);
        opts.onContinuation({threadId:id,signature:'S',total:{}},{phase:'start',resumed:true});
        return {result:'continued',sessionId:id};
      });
    }
    // Claude has its own thread and seen-set in the same conversation; Codex's thread is not shared with her.
    const claude=submit({session_id:existing.session_id,text:'@Claude ordinary'});
    await execute(claude.task_id,async(provider,prompt,opts)=>{
      assert.equal(provider,'claude');assert.equal(opts.mode,'work');assert.deepEqual(opts.continuation,{});
      assert.match(prompt,/BEFORE GLOBAL|OLD NEXT/);
      opts.onContinuation({threadId:'CLAUDE-OLD',signature:'S',total:{}},{phase:'start',resumed:false});
      return {result:'Claude first thread',sessionId:'CLAUDE-OLD'};
    });
    assert.equal(sessionOf(existing.session_id).claude_continuation.threadId,'CLAUDE-OLD');
    assert.equal(sessionOf(existing.session_id).codex_continuation.threadId,'OLD');
    const between=submit({session_id:existing.session_id,text:'@Codex BETWEEN'});
    await execute(between.task_id,async(provider,prompt,opts)=>{
      assert.equal(provider,'codex');assert.equal(opts.continuation.threadId,'OLD');
      assert.match(opts.resumePrompt,/Claude first thread/,'Codex sees Claude replies made since her last turn');
      opts.onContinuation({threadId:'OLD',signature:'S',total:{}},{phase:'start',resumed:true});
      return {result:'CODEX SAID BETWEEN',sessionId:'OLD'};
    });
    const claudeNext=submit({session_id:existing.session_id,text:'@Claude second'});
    await execute(claudeNext.task_id,async(provider,prompt,opts)=>{
      assert.equal(opts.continuation.threadId,'CLAUDE-OLD');assert.match(opts.resumePrompt,/当前请求：second$/);
      assert.doesNotMatch(opts.resumePrompt,/BEFORE GLOBAL|Claude first thread|ordinary/);
      assert.match(opts.resumePrompt,/CODEX SAID BETWEEN/,'Claude sees Codex replies made since her last turn');
      opts.onContinuation({threadId:'CLAUDE-OLD',signature:'S',total:{}},{phase:'start',resumed:true});
      return {result:'Claude continued',sessionId:'CLAUDE-OLD'};
    });
    // Disabling Claude alone leaves Codex resuming.
    write('agent/config.json',{...saved.cfg,claude_resume_sessions:[]});
    const claudeOff=submit({session_id:existing.session_id,text:'@Claude off'});
    await execute(claudeOff.task_id,async(provider,prompt,opts)=>{
      assert.equal(opts.continuation,undefined);assert.equal(opts.resumePrompt,undefined);return {result:'Claude fresh'};
    });
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:['*']});
    const card=submit({text:'@Codex card',inbox_reply:{id:'fixture',action_id:'agent-check'}});
    await execute(card.task_id,async(provider,prompt,opts)=>{
      assert.equal(provider,'codex');assert.equal(opts.mode,'ask');assert.equal(opts.continuation,undefined);
      return {result:'card unchanged'};
    });
    assert.equal(sessionOf(card.session_id).codex_continuation,undefined);
    write('agent/config.json',{...saved.cfg,codex_resume_sessions:[],claude_resume_sessions:[]});
    const disabled=submit({session_id:existing.session_id,text:'@Codex DISABLED'});
    await execute(disabled.task_id,async(_,prompt,opts)=>{
      assert.equal(opts.continuation,undefined);assert.equal(opts.resumePrompt,undefined);
      assert.match(prompt,/BEFORE GLOBAL/);return {result:'fresh route restored'};
    });
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});

test('editing an earlier user message archives the old branch, forks each native thread before the first removed turn and regenerates from the shortened record',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')},saveEnv=process.env.CLAUDE_CONFIG_DIR;
  const configDir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-config-'));
  try {
    process.env.CLAUDE_CONFIG_DIR=configDir;
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false},codex_resume_sessions:['*'],claude_resume_sessions:['*']});
    // Every native turn reports its thread, then its turn reference (Codex turn id / Claude prompt uuid), as the real providers do.
    const turn=(thread,ref,key,resumed)=>async(_,prompt,opts)=>{
      opts.onContinuation({threadId:thread,signature:'S',total:{}},{phase:'start',resumed});
      opts.onContinuation({threadId:thread},{phase:'turn',ref});return {result:'ANSWER-'+key,sessionId:thread};
    };
    const claudeId='11111111-2222-3333-4444-555555555555';
    const A=submit({text:'@Codex A',project_id:'bi-devices'});await execute(A.task_id,turn('T-codex','cx-A','A',false));
    const B=submit({text:'@Claude B',session_id:A.session_id});await execute(B.task_id,turn(claudeId,'u-B','B',false));
    const C=submit({text:'@Codex C-ORIGINAL',session_id:A.session_id,model:'edit-model'});await execute(C.task_id,turn('T-codex','cx-C','C',true));
    const D=submit({text:'@Claude D',session_id:A.session_id});await execute(D.task_id,turn(claudeId,'u-D','D',true));
    const before=sessionOf(A.session_id);
    assert.deepEqual(before.codex_continuation.turns.map(t=>t.task_id),[A.task_id,C.task_id]);
    assert.deepEqual(before.claude_continuation.turns.map(t=>t.task_id),[B.task_id,D.task_id]);
    // Claude's transcript: B's prompt, an assistant answer, then D's prompt.
    const dir=path.join(configDir,'projects','p');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,claudeId+'.jsonl'),[{type:'user',uuid:'u-B'},{type:'assistant',uuid:'a-B',parentUuid:'u-B'},{type:'attachment',uuid:'x-1',parentUuid:'a-B'},{type:'user',uuid:'u-D',parentUuid:'x-1'}].map(e=>JSON.stringify(e)).join('\n'));
    assert.equal(claudeForkPoint(claudeId,'u-D'),'a-B');assert.equal(claudeForkPoint(claudeId,'u-B'),null,'nothing precedes the first prompt');assert.equal(claudeForkPoint('not-a-uuid','u-D'),null);
    // Refusals: a conversation with a task still queued, an unknown task, empty text.
    const busy=submit({text:'@Codex BUSY',session_id:A.session_id});
    assert.throws(()=>editMessage({session_id:A.session_id,task_id:C.task_id,text:'x'}),/排队或运行/);
    await execute(busy.task_id,turn('T-codex','cx-busy','busy',true));
    assert.throws(()=>editMessage({session_id:A.session_id,task_id:'nope',text:'x'}),/未找到/);
    assert.throws(()=>editMessage({session_id:A.session_id,task_id:C.task_id,text:'  '}),/请输入/);
    const out=editMessage({session_id:A.session_id,task_id:C.task_id,text:'@Codex C-EDITED'});
    assert.equal(out.replaced,6);assert.equal(out.provider,'codex');
    const after=sessionOf(A.session_id);
    assert.deepEqual(after.messages.map(m=>m.text),['@Codex A','ANSWER-A','@Claude B','ANSWER-B','@Codex C-EDITED']);
    assert.deepEqual(after.task_ids,[A.task_id,B.task_id,out.task_id]);
    const codex=after.codex_continuation,claude=after.claude_continuation;
    assert.equal(codex.threadId,'T-codex');assert.equal(codex.forkBefore,'cx-C');assert.deepEqual(codex.turns.map(t=>t.ref),['cx-A']);
    assert.deepEqual(codex.seen,[0,1],'only what the surviving turn delivered: B and its reply reached Codex inside the removed turn');
    assert.equal(codex.contextHash,undefined);
    assert.equal(claude.threadId,claudeId);assert.equal(claude.forkAt,'a-B');assert.deepEqual(claude.turns.map(t=>t.ref),['u-B']);
    assert.equal(after.messages[4].edited.branch,out.branch);assert.equal(after.messages[4].edited.replaced,6);
    const queued=read('work/queue.json').items.find(i=>i.id===out.task_id);assert.equal(queued.status,'queued');assert.equal(queued.model,'edit-model');
    const branch=JSON.parse(fs.readFileSync(`.runtime/agent/branches/${A.session_id}/${out.branch}.json`,'utf8'));
    assert.deepEqual(branch.messages.map(m=>m.text).slice(0,2),['@Codex C-ORIGINAL','ANSWER-C']);assert.ok(branch.messages.some(m=>m.text==='ANSWER-D'));
    assert.equal(branch.continuations.codex.turns.length,3);assert.ok(branch.task_ids.includes(C.task_id) && branch.task_ids.includes(D.task_id));
    assert.ok(read('work/queue.json').items.some(i=>i.id===D.task_id),'work records of the discarded branch stay');
    await execute(out.task_id,async(_,prompt,opts)=>{
      assert.equal(opts.continuation.forkBefore,'cx-C');assert.equal(opts.continuation.threadId,'T-codex');
      assert.match(opts.resumePrompt,/ANSWER-B/,'the message the removed turn delivered is delivered again');
      assert.doesNotMatch(opts.resumePrompt,/ANSWER-A|C-ORIGINAL|ANSWER-C|ANSWER-D|BUSY/);
      assert.match(opts.resumePrompt,/当前项目/,'context hashes were cleared, so project orientation is sent again');
      opts.onContinuation({threadId:'T-codex-fork',signature:'S',total:{}},{phase:'start',resumed:true});
      opts.onContinuation({threadId:'T-codex-fork'},{phase:'turn',ref:'cx-edited'});return {result:'ANSWER-EDITED',sessionId:'T-codex-fork'};
    });
    const forked=sessionOf(A.session_id).codex_continuation;
    assert.equal(forked.threadId,'T-codex-fork');assert.equal(forked.forkBefore,undefined);assert.deepEqual(forked.turns.map(t=>t.ref),['cx-A','cx-edited']);
    // Claude: the fork point reaches the CLI only for work turns that resume.
    assert.ok(claudeArgs('m',{resume:claudeId,forkAt:'a-B'}).join(' ').includes('--resume '+claudeId+' --resume-session-at a-B --fork-session'));
    assert.ok(!claudeArgs('m',{mode:'ask',resume:claudeId,forkAt:'a-B'}).includes('--resume-session-at'));assert.ok(!claudeArgs('m',{resume:claudeId}).includes('--resume-session-at'));
    // Cases that start a fresh thread: the whole thread removed, and a continuation without turn records.
    const wipe=editMessage({session_id:A.session_id,task_id:A.task_id,text:'@Codex A-REWRITTEN'});
    const wiped=sessionOf(A.session_id);assert.equal(wiped.codex_continuation,undefined);assert.equal(wiped.claude_continuation,undefined);assert.equal(wiped.messages.length,1);
    await execute(wipe.task_id,turn('T2','cx-1','1',false));
    const next=submit({text:'@Codex next',session_id:A.session_id});
    write(file,{...read(file),sessions:read(file).sessions.map(s=>{if(s.id!==A.session_id)return s;const {turns,...legacy}=s.codex_continuation;return {...s,codex_continuation:legacy};})});
    await execute(next.task_id,turn('T2','cx-2','2',true));
    assert.equal(sessionOf(A.session_id).codex_continuation.turns,undefined,'a legacy continuation is not given a partial turn list');
    const again=editMessage({session_id:A.session_id,task_id:next.task_id,text:'@Codex next-edited'});
    assert.equal(sessionOf(A.session_id).codex_continuation,undefined,'a legacy continuation cannot be cut exactly, so it is dropped');
    await execute(again.task_id,turn('T3','cx-3','3',false));
  } finally {
    write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);fs.rmSync('.runtime/agent/branches',{recursive:true,force:true});fs.rmSync(configDir,{recursive:true,force:true});
    if(saveEnv===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=saveEnv;
  }
});

test('Codex fork-before-turn: forks a copy with the permissions applied, sends the delta, and a failed fork falls back to a fresh thread before any turn',async()=>{
  const run=async(fault)=>{
    const calls=[],published=[];
    const rpc=async(method,p)=>{
      calls.push({method,p});
      if(method==='thread/fork'){if(fault)throw new Error('turn id not found');return thread('forked');}
      if(method==='thread/start')return thread('new');
      return {turn:{id:'T'}};
    };
    await startCodexTurn(rpc,{params,signature:'S',continuation:{threadId:'old',signature:'S',forkBefore:'turn-3',total:{inputTokens:100}},prompt:'FULL',resumePrompt:'DELTA',onThread:(state,info)=>published.push({state,info})});
    return {calls,published};
  };
  const ok=await run();assert.deepEqual(ok.calls.map(c=>c.method),['thread/fork','turn/start']);
  assert.equal(ok.calls[0].p.threadId,'old');assert.equal(ok.calls[0].p.beforeTurnId,'turn-3');assert.equal(ok.calls[0].p.ephemeral,false);assert.equal(ok.calls[0].p.sandbox,'workspace-write');assert.equal(ok.calls[0].p.excludeTurns,true);
  assert.equal(ok.calls[1].p.threadId,'forked');assert.equal(ok.calls[1].p.input[0].text,'DELTA');
  assert.equal(ok.published[0].state.threadId,'forked');assert.equal(ok.published[0].info.resumed,true);assert.deepEqual(ok.published[0].state.total,{inputTokens:100},'a fork inherits the parent total, so the old baseline still applies');
  const failed=await run(true);assert.deepEqual(failed.calls.map(c=>c.method),['thread/fork','thread/start','turn/start']);
  assert.equal(failed.calls[2].p.input[0].text,'FULL');assert.equal(failed.published[0].info.resumed,false);assert.match(failed.published[0].info.fallbackReason,/turn id not found/);
});

test('agent questions: Claude AskUserQuestion is answered from the workbench, anything else is refused, and work (not ask) launches carry the switches',async t=>{
  const at=(args,flag)=>args[args.indexOf(flag)+1];
  assert.equal(at(claudeArgs('m'),'--permission-prompt-tool'),'stdio');assert.ok(!claudeArgs('m',{mode:'ask'}).includes('--permission-prompt-tool'));
  assert.ok(codexLaunch('x').overrides.includes('features.default_mode_request_user_input=true'));
  assert.ok(!codexLaunch('x',{mode:'ask'}).overrides.some(o=>/request_user_input/.test(o)));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claude-question-fixture-'));
  const child=new EventEmitter(),written=[];
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,encoding,done){written.push(JSON.parse(chunk.toString()));done();}});
  child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
  t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});});
  const emit=e=>child.stdout.write(JSON.stringify(e)+'\n'),asked=[];
  const running=invokeClaude('INITIAL',{directory,model:'fixture',onQuestion:async items=>{asked.push(items);return {'0':['蓝'],'1':['A','自己写的']};}});
  emit({type:'system',subtype:'init',session_id:'q-session'});emit({...written[0],type:'user'});
  const input={questions:[{question:'喜欢哪个颜色？',header:'颜色',multiSelect:false,options:[{label:'红',description:'r'},{label:'蓝',description:'b'}]},
    {question:'要哪些？',header:'多选',multiSelect:true,options:[{label:'A',description:''},{label:'B',description:''}]}]};
  emit({type:'control_request',request_id:'r1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input,tool_use_id:'t1'}});
  emit({type:'control_request',request_id:'r2',request:{subtype:'can_use_tool',tool_name:'PowerShell',input:{command:'x'},tool_use_id:'t2'}});
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(asked[0].map(q=>[q.id,q.header,q.multi,q.options.map(o=>o.label)]),[['0','颜色',false,['红','蓝']],['1','多选',true,['A','B']]]);
  const byId=id=>written.map(w=>w.response).find(r=>r?.request_id===id),answer=byId('r1'),refusal=byId('r2');
  assert.equal(answer.request_id,'r1');assert.equal(answer.response.behavior,'allow');
  assert.deepEqual(answer.response.updatedInput.answers,{'喜欢哪个颜色？':'蓝','要哪些？':'A, 自己写的'});assert.equal(answer.response.updatedInput.questions.length,2);
  assert.equal(refusal.request_id,'r2');assert.equal(refusal.response.behavior,'deny');
  emit({type:'result',result:'done',usage:{}});assert.equal((await running).result,'done');
});

test('agent questions: the turn waits on the workbench answer, records it in place, rejects bad answers, and a stopped turn cancels the question',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(file),cfg:read('agent/config.json')};
  try {
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false}});
    const first=submit({text:'@claude QUESTION ROUND'});let answered,record;
    await execute(first.task_id,async(_,prompt,opts)=>{
      assert.equal(typeof opts.onQuestion,'function');
      const items=[{id:'0',header:'颜色',question:'哪个？',options:[{label:'红',description:''},{label:'蓝',description:''}],multi:false,other:true}];
      const pending=opts.onQuestion(items);
      record=sessionOf(first.session_id).questions[0];assert.equal(record.status,'pending');assert.equal(record.task_id,first.task_id);
      assert.throws(()=>answerQuestion({session_id:first.session_id,question_id:record.id,answers:{}}),/没有回答/);
      assert.throws(()=>answerQuestion({session_id:'other',question_id:record.id,answers:{'0':['红']}}),/已经结束/);
      answerQuestion({session_id:first.session_id,question_id:record.id,answers:{'0':['蓝','红']}});
      answered=await pending;
      assert.throws(()=>answerQuestion({session_id:first.session_id,question_id:record.id,answers:{'0':['红']}}),/已经结束/);
      return {result:'ok'};
    });
    assert.deepEqual(answered,{'0':['蓝']},'a single-choice question keeps one answer');
    const kept=sessionOf(first.session_id).questions[0];assert.equal(kept.status,'answered');assert.deepEqual(kept.answers,{'0':['蓝']});
    // A question left open when the turn ends (or is stopped) is cancelled, not left answerable.
    const second=submit({text:'@claude STOPPED ROUND'});let rejected;
    await execute(second.task_id,async(_,prompt,opts)=>{
      const pending=opts.onQuestion([{id:'0',header:'',question:'？',options:[],multi:false,other:true}]);
      stop(second.task_id);rejected=await pending.then(()=>'answered',e=>e.message);
      throw new Error('stopped');
    });
    assert.match(rejected,/已停止/);
    assert.equal(sessionOf(second.session_id).questions[0].status,'cancelled');
  } finally {write('work/queue.json',saved.queue);write(file,saved.sessions);write('agent/config.json',saved.cfg);}
});
