import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {read,write} from './files.mjs';
import {submit,sendChat,execute as executeAgent,drain as drainAgent,agentSnapshot,stop} from '../agent/run.mjs';
import {executeWithoutTitle,withoutTitle} from './titleless.mjs';
import {createServer} from '../dashboard/server.mjs';
import {startCodexTurn} from '../agent/codex.mjs';
import {invokeClaude} from '../agent/claude.mjs';
import {enqueue,readiness} from '../work/run.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent),gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const item=id=>read('work/queue.json').items.find(i=>i.id===id);
const session=id=>agentSnapshot().sessions.find(s=>s.id===id);
const owner=opts=>read('work/queue.json').items.find(i=>opts.directory.includes(i.id));
async function drain(runner){
  const cfg=read('agent/config.json');write('agent/config.json',{...cfg,enabled:true});
  try{await drainAgent(withoutTitle(runner));}finally{write('agent/config.json',cfg);}
}

test('a midway @Claude announcement does not change no-@ input away from the still-running Codex',async()=>{
  const first=submit({text:'@Codex ORIGINAL_RUNNING_GOAL'}),ready=gate(),finish=gate(),sent=[],appended=[];
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();sent.push(provider);
    if(provider==='codex'){
      opts.onReady(async text=>appended.push(text));
      opts.onEvent({type:'text',text:'@Claude review when complete'});ready.resolve();await finish.promise;
      return {result:'SOURCE_FINISHED_WITH_NEW_INPUT'};
    }
    assert.match(prompt,/ORIGINAL_RUNNING_GOAL[^]*USER_NO_AT_WHILE_CODEX[^]*SOURCE_FINISHED_WITH_NEW_INPUT/);
    assert.doesNotMatch(prompt,/当前请求：/);return {result:'colleague reviewed'};
  };
  const running=execute(first.task_id,runner);
  try{
    await ready.promise;
    const user=await sendChat({session_id:first.session_id,text:'USER_NO_AT_WHILE_CODEX'});
    assert.equal(user.provider,'codex');assert.equal(user.delivery,'pending');
    await new Promise(r=>setImmediate(r));assert.deepEqual(appended,['USER_NO_AT_WHILE_CODEX']);
    finish.resolve();await running;assert.deepEqual(sent,['codex','claude']);
    assert.equal(item(user.task_id).status,'done');
  }finally{finish.resolve();await running;}
});

test('HTTP no-@ user input during unsent Claude startup still addresses Codex and runs before the saved handoff',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const first=submit({text:'@Codex ORIGINAL_GOAL'}),preparing=gate(),release=gate(),sent=[];
  let claudeAttempts=0,user;
  const runner=async(provider,prompt,opts)=>{
    const task=owner(opts);
    if(provider==='claude' && ++claudeAttempts===1){preparing.resolve();await release.promise;}
    opts.beforeSubmit();sent.push(provider+':'+(task.handoff_resume?'handoff':task.id===first.task_id?'source':'user'));
    if(task.id===first.task_id && !task.handoff_resume)return {result:'CODEX_PROGRESS\n@Claude REVIEW_ORIGINAL_WORK'};
    if(task.handoff_resume){
      assert.match(prompt,/CODEX_PROGRESS/);assert.match(prompt,/REVIEW_ORIGINAL_WORK/);
      assert.equal(prompt.split('CODEX_PROGRESS').length-1,1,'saved colleague report is not repeated as history');
      assert.match(prompt,/USER_INSERT_NO_AT/);assert.match(prompt,/ORIGINAL_GOAL[^]*CODEX_PROGRESS/,'original user message precedes the reply even when the chain resumes');
      assert.doesNotMatch(prompt,/当前请求：/);
      return {result:'CLAUDE_REVIEW_RECEIVED'};
    }
    assert.equal(task.id,user.task_id);assert.equal(provider,'codex');return {result:'CODEX_HANDLED_INSERT'};
  };
  const running=execute(first.task_id,runner),server=createServer();
  try{
    await preparing.promise;await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(origin+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({session_id:first.session_id,text:'USER_INSERT_NO_AT'})});
    assert.equal(response.status,200);user=await response.json();
    assert.equal(user.provider,'codex');assert.equal(user.delivery,'queued');
    release.resolve();await running;
    assert.equal(item(first.task_id).status,'queued','the original task is not completed while its handoff is pending');
    const pending=session(first.session_id).task_ids.map(item).filter(i=>i.handoff_resume && i.status==='queued');
    assert.equal(pending.length,1);assert.equal(pending[0].executor,'claude');
    assert.equal(pending[0].id,first.task_id,'same task, not a cloned continuation');
    const dependent=enqueue({title:'depends on complete handoff',goal:'fixture',kind:'framework',actor:'user',project_ids:[],dependencies:[first.task_id],status:'queued'});
    assert.equal(readiness(dependent,read('work/queue.json').items).ready,false);
    assert.deepEqual(sent,['codex:source'],'the initial Claude input was never sent');
    assert.equal(session(first.session_id).messages.filter(m=>m.role==='assistant' && !m.interim && m.task_id===first.task_id).length,1,'source reply is not duplicated when startup yields');
    await drain(runner);
    assert.deepEqual(sent,['codex:source','codex:user','claude:handoff']);
    assert.equal(item(user.task_id).status,'done');assert.equal(item(pending[0].id).status,'done');
    assert.equal(item(first.task_id).executor,'codex');assert.equal(item(first.task_id).handoff_resume,undefined,'completed tasks do not retain a stale pending stage');
    assert.equal(readiness(dependent,read('work/queue.json').items).ready,true);
    assert.equal(claudeAttempts,2,'one unsent preparation and one actual handoff, not two model inputs');
    assert.ok(!session(first.session_id).messages.some(m=>m.role==='error'));
  }finally{release.resolve();await running;if(server.listening)await new Promise(r=>server.close(r));}
});

test('queued user inputs stay FIFO and ahead of a saved handoff, including inputs arriving after it was queued',async()=>{
  const first=submit({text:'@Codex ORIGINAL_FIFO_GOAL'}),sent=[];let a,b;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();const task=owner(opts);
    sent.push(task.handoff_resume?'handoff':task.id===first.task_id?'source':task.id===a.task_id?'A':'B');
    if(task.id===first.task_id && !task.handoff_resume){
      opts.onEvent({type:'text',text:'@Claude review later'});
      a=submit({session_id:first.session_id,text:'@Codex USER_A'});
      return {result:'SOURCE_FIFO_RESULT'};
    }
    if(!task.handoff_resume)assert.match(prompt,/ORIGINAL_FIFO_GOAL/,'a partially handled root remains visible to the inserted user turn');
    if(task.handoff_resume){
      assert.match(prompt,/SOURCE_FIFO_RESULT/);assert.match(prompt,/USER_A/);assert.match(prompt,/USER_B/);
      assert.match(prompt,/ORIGINAL_FIFO_GOAL[^]*SOURCE_FIFO_RESULT/);assert.doesNotMatch(prompt,/当前请求：/);
    }
    return {result:provider+' completed'};
  };
  await execute(first.task_id,runner);
  const pending=session(first.session_id).task_ids.map(item).find(i=>i.handoff_resume);
  b=await sendChat({session_id:first.session_id,text:'USER_B'});
  assert.equal(b.provider,'codex');
  assert.ok(session(first.session_id).task_ids.indexOf(pending.id)<session(first.session_id).task_ids.indexOf(b.task_id));
  await drain(runner);assert.deepEqual(sent,['source','A','B','handoff']);
  assert.equal(item(pending.id).status,'done');
});

test('an explicit user recipient overrides the default and precedes the registered colleague',async()=>{
  const first=submit({text:'@Codex EXPLICIT_USER_RECIPIENT'}),sent=[];let user;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();sent.push(provider);
    if(owner(opts).id===first.task_id && !owner(opts).handoff_resume){
      user=await sendChat({session_id:first.session_id,text:'@DeepSeek USER_EXPLICIT'});
      assert.equal(user.provider,'deepseek');return {result:'@Claude review this'};
    }
    if(provider==='deepseek')assert.match(prompt,/EXPLICIT_USER_RECIPIENT/,'new recipient receives the original user context, not only the progress reply');
    return {result:'done'};
  };
  await execute(first.task_id,runner);await drain(runner);
  assert.deepEqual(sent,['codex','deepseek','claude']);assert.equal(item(user.task_id).status,'done');
});

test('after Claude initial input is sent, no-@ input belongs to Claude and is neither withdrawn nor replayed',async()=>{
  const first=submit({text:'@Codex ALREADY_SENT_BOUNDARY'}),ready=gate(),finish=gate(),sent=[],appended=[];
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();sent.push(provider);
    if(provider==='codex')return {result:'@Claude review now'};
    opts.onReady(async text=>appended.push(text));ready.resolve();await finish.promise;return {result:'Claude handled the additional input'};
  };
  const running=execute(first.task_id,runner);
  try{
    await ready.promise;
    const user=await sendChat({session_id:first.session_id,text:'USER_AFTER_SEND'});
    assert.equal(user.provider,'claude');assert.equal(user.delivery,'pending');
    await new Promise(r=>setImmediate(r));assert.deepEqual(appended,['USER_AFTER_SEND']);
    finish.resolve();await running;
    assert.deepEqual(sent,['codex','claude']);assert.equal(item(user.task_id).merged_into,first.task_id);
    await drain(runner);assert.deepEqual(sent,['codex','claude']);
  }finally{finish.resolve();await running;}
});

test('cancelling the inserted user input leaves the saved handoff usable with the original goal',async()=>{
  const first=submit({text:'@Codex KEEP_ORIGINAL_AFTER_CANCEL'}),sent=[];let user;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();sent.push(provider);
    if(provider==='codex'){
      user=submit({session_id:first.session_id,text:'@Codex CANCELLED_NEW_GOAL'});
      return {result:'@Claude review original'};
    }
    assert.match(prompt,/当前请求：@Codex KEEP_ORIGINAL_AFTER_CANCEL$/);return {result:'review done'};
  };
  await execute(first.task_id,runner);stop(user.task_id);await drain(runner);
  assert.deepEqual(sent,['codex','claude']);assert.equal(item(user.task_id).status,'cancelled');
});

test('a saved handoff also yields when another user input arrives during its own startup',async()=>{
  const first=submit({text:'@Codex REPEATED_PREEMPTION'}),sent=[];let firstUser,laterUser,attempts=0;
  const runner=async(provider,prompt,opts)=>{
    const task=owner(opts);
    if(task.handoff_resume && ++attempts===1)laterUser=submit({session_id:first.session_id,text:'@Codex LATER_PRIORITY'});
    opts.beforeSubmit();sent.push(task.handoff_resume?'handoff':task.id===first.task_id?'source':task.id===firstUser.task_id?'first-user':'later-user');
    if(task.id===first.task_id && !task.handoff_resume){firstUser=submit({session_id:first.session_id,text:'@Codex FIRST_PRIORITY'});return {result:'@Claude review'};}
    return {result:'done'};
  };
  await execute(first.task_id,runner);await drain(runner);
  assert.deepEqual(sent,['source','first-user','later-user','handoff']);
  assert.equal(attempts,2);assert.equal(item(laterUser.task_id).status,'done');
  assert.equal(session(first.session_id).task_ids.filter(id=>id===first.task_id).length,1,'repeated yielding does not clone the original task');
  assert.equal(item(first.task_id).handoff_resume,undefined);
});

test('interleaved user turns do not reset the ten-turn limit of the original assistant chain',async()=>{
  const first=submit({text:'@Codex BOUNDED_PRIORITY_CHAIN'});let chainCalls=0,userCalls=0;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();const task=owner(opts);
    if(task.id===first.task_id || task.handoff_resume){
      chainCalls++;
      submit({session_id:first.session_id,text:'@Codex USER_PRIORITY_'+chainCalls});
      return {result:'@'+(provider==='codex'?'Claude':'Codex')+' continue'};
    }
    userCalls++;return {result:'user handled'};
  };
  await execute(first.task_id,runner);await drain(runner);
  assert.equal(chainCalls,10);assert.equal(userCalls,10);
  assert.equal(item(first.task_id).handoff_resume,undefined);assert.equal(item(first.task_id).executor,'codex');
});

test('previously delivered corrections retain their ownership and complete after the saved chain resumes',async()=>{
  const first=submit({text:'@Codex RECEIPT_OWNER'}),ready=gate(),finish=gate();let correction,other;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();const task=owner(opts);
    if(task.id===first.task_id && !task.handoff_resume){
      opts.onReady(async()=>{});ready.resolve();await finish.promise;return {result:'@Claude review corrected work'};
    }
    if(task.handoff_resume){assert.match(prompt,/RECEIPT_OWNER[^]*DELIVERED_CORRECTION[^]*review corrected work/);assert.doesNotMatch(prompt,/当前请求：/);}
    return {result:'done'};
  };
  const running=execute(first.task_id,runner);
  try{
    await ready.promise;correction=await sendChat({session_id:first.session_id,text:'DELIVERED_CORRECTION'});
    await new Promise(r=>setImmediate(r));assert.equal(item(correction.task_id).merged_into,first.task_id);
    other=await sendChat({session_id:first.session_id,text:'@DeepSeek INSERT_BEFORE_REVIEW'});
    finish.resolve();await running;assert.equal(item(first.task_id).status,'queued');
    await drain(runner);
    assert.equal(item(first.task_id).status,'done');assert.equal(item(correction.task_id).status,'done');assert.equal(item(other.task_id).status,'done');
    assert.equal(item(correction.task_id).merged_into,first.task_id);
  }finally{finish.resolve();await running;}
});

test('stopping the original queued handoff cancels it without cancelling the independent user insertion',async()=>{
  const first=submit({text:'@Codex STOP_PENDING_HANDOFF'}),calls=[];let user;
  const runner=async(provider,prompt,opts)=>{
    opts.beforeSubmit();calls.push(provider);
    if(owner(opts).id===first.task_id){user=submit({session_id:first.session_id,text:'@Codex INDEPENDENT_USER_INPUT'});return {result:'@Claude review'};}
    return {result:'user done'};
  };
  await execute(first.task_id,runner);assert.equal(item(first.task_id).status,'queued');stop(first.task_id);
  await drain(runner);
  assert.deepEqual(calls,['codex','codex']);assert.equal(item(first.task_id).status,'cancelled');assert.equal(item(user.task_id).status,'done');
});

test('Codex checks priority after thread startup but before turn/start or advancing the seen set',async()=>{
  const calls=[],denied=new Error('yield before input');denied.code='USER_INPUT_PRIORITY';let identity=false;
  await assert.rejects(startCodexTurn(async(method)=>{
    calls.push(method);return {thread:{id:'prepared-thread'},sandbox:{type:'workspaceWrite'}};
  },{params:{sandbox:'workspace-write'},signature:'fixture',prompt:'UNSENT_INPUT',
    beforeSubmit:()=>{throw denied;},onThread:()=>{identity=true;}}),e=>e===denied);
  assert.deepEqual(calls,['thread/start']);assert.equal(identity,false);
});

test('Claude synchronous send boundary can yield without launching a native process',async t=>{
  let spawned=0;t.mock.method(childProcess,'spawn',()=>{spawned++;throw new Error('must not launch');});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const denied=new Error('priority');denied.code='USER_INPUT_PRIORITY';
  await assert.rejects(invokeClaude('UNSENT_INPUT',{mode:'work',directory:'.runtime/unsent-claude',model:'fixture',beforeSubmit:()=>{throw denied;}}),e=>e===denied);
  assert.equal(spawned,0);
});
