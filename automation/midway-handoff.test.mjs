import test from 'node:test';
import assert from 'node:assert/strict';
import {read} from './files.mjs';
import {submit,execute as executeAgent,stop,agentSnapshot} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
import {launchEdge} from './browser-launch.mjs';
import {createServer} from '../dashboard/server.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent);
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const session=id=>agentSnapshot().sessions.find(s=>s.id===id);

// The screenshot incident: Codex's completed commentary block named Claude,
// but the final reply need not repeat that line. Use the public event boundary.
const incident='我接程序侧：把能由程序执行的数量限制落地，并拆开当前用户目标与历史材料，尽量做减法，不再叠提醒。先核对现有实现和她已改的部分，再验证实际传给模型的内容。\n\n@Claude 我会处理数量限制和消息组装。你已完成的场景拆分我不重复改；完成后把改动和验证结果交给你复核。';

test('screenshot midway @ is registered before source completion and reaches the colleague without a final @',async()=>{
  const first=submit({text:'@Codex KEEP_THIS_USER_GOAL'}),entered=gate(),finish=gate(),calls=[];
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    if(provider==='codex'){
      opts.onEvent({type:'text',text:incident});entered.resolve();await finish.promise;
      return {result:'PROGRAM_CHANGES_AND_VERIFICATION_READY'};
    }
    assert.equal(provider,'claude');assert.match(prompt,/数量限制和消息组装/);
    assert.match(prompt,/PROGRAM_CHANGES_AND_VERIFICATION_READY/);
    assert.match(prompt,/KEEP_THIS_USER_GOAL/);
    assert.doesNotMatch(prompt,/当前请求：@Codex KEEP_THIS_USER_GOAL$/);
    return {result:'COLLEAGUE_RECEIVED'};
  });
  try {
    await entered.promise;
    assert.deepEqual(calls,['codex'],'one native call at a time in this conversation');
    assert.equal(session(first.session_id).messages.find(m=>m.text===incident).handoff_to,'claude');
    finish.resolve();await running;
    assert.deepEqual(calls,['codex','claude']);
    assert.equal(read('work/queue.json').items.find(i=>i.id===first.task_id).status,'done');
    assert.equal(session(first.session_id).messages.at(-1).text,'COLLEAGUE_RECEIVED');
  } finally {finish.resolve();await running;}
});

test('midway repetitions, final @ and an already user-named recipient share one successor turn',async()=>{
  for(const named of [false,true])for(const source of ['codex','claude','deepseek']){
    const target=source==='claude'?'codex':'claude',first=submit({text:'@'+source+(named?' @'+target:'')+' REVIEW_CURRENT_WORK'}),calls=[];
    await execute(first.task_id,async(provider,prompt,opts)=>{
      calls.push(provider);
      if(provider===source){
        const message='PROGRESS_NOTE\n@'+target+' Please review when ready';
        opts.onEvent({type:'text',text:message});opts.onEvent({type:'text',text:message});
        return {result:'FINAL_REPORT\n@'+target+' Please review when ready'};
      }
      assert.match(prompt,/PROGRESS_NOTE/);assert.match(prompt,/FINAL_REPORT/);
      return {result:'REVIEW_DONE'};
    });
    assert.deepEqual(calls,[source,target]);
  }
});

test('multiple midway recipients keep their order and final-only handoff still works',async()=>{
  const first=submit({text:'@Codex ORDERED_HANDOFF'}),calls=[];
  await execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    if(provider==='codex'){
      opts.onEvent({type:'text',text:'@Claude FIRST_COLLEAGUE'});
    }
    return {result:provider==='codex'?'FINAL_ADDITIONAL_RECIPIENT\n@DeepSeek SECOND_COLLEAGUE':provider+' completed'};
  });
  assert.deepEqual(calls,['codex','claude','deepseek']);
  const finalOnly=submit({text:'@Claude FINAL_ONLY'}),finalCalls=[];
  await execute(finalOnly.task_id,async(provider)=>{
    finalCalls.push(provider);return {result:provider==='claude'?'@Codex FINAL_HANDOFF':'done'};
  });
  assert.deepEqual(finalCalls,['claude','codex']);
});

test('different recipients in separate midway blocks are all retained in order',async()=>{
  const first=submit({text:'@Codex MULTIPLE_MIDWAY_RECIPIENTS'}),calls=[];
  await execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    if(provider==='codex'){
      opts.onEvent({type:'text',text:'@DeepSeek FIRST_MIDWAY_RECIPIENT'});
      opts.onEvent({type:'text',text:'@Claude SECOND_MIDWAY_RECIPIENT'});
    }
    return {result:'completed'};
  });
  assert.deepEqual(calls,['codex','deepseek','claude']);
});

test('child commentary, inline mentions and self mentions cannot schedule a root handoff',async()=>{
  const first=submit({text:'@Codex NOT_A_ROOT_HANDOFF'}),calls=[];
  await execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    opts.onEvent({type:'text',text:'@Claude CHILD_MESSAGE',sub:true,parent:'child'});
    opts.onEvent({type:'text',text:'I agree with @Claude about this'});
    opts.onEvent({type:'text',text:'@Codex SELF_MESSAGE'});
    return {result:'done'};
  });
  assert.deepEqual(calls,['codex']);
  assert.ok(!session(first.session_id).messages.some(m=>m.handoff_to));
});

test('stopping after midway @ does not launch the registered recipient',async()=>{
  const first=submit({text:'@Codex STOP_BEFORE_HANDOFF'}),entered=gate(),calls=[];
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);opts.onEvent({type:'text',text:'@Claude review this'});entered.resolve();
    await new Promise(resolve=>opts.signal.addEventListener('abort',resolve,{once:true}));
    throw new Error('stopped');
  });
  await entered.promise;stop(first.task_id);await running;
  assert.deepEqual(calls,['codex']);
  assert.equal(read('work/queue.json').items.find(i=>i.id===first.task_id).status,'cancelled');
});

test('midway-only ping-pong obeys the existing ten-turn chain limit',async()=>{
  const first=submit({text:'@Codex BOUNDED_HANDOFF'}),calls=[];
  await execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    opts.onEvent({type:'text',text:'@'+(provider==='codex'?'Claude':'Codex')+' continue'});
    return {result:'turn '+calls.length};
  });
  assert.equal(calls.length,10);
  assert.equal(session(first.session_id).messages.filter(m=>m.handoff_to).length,9);
});

test('ask/card commentary does not create a conversational handoff',async()=>{
  const first=submit({text:'@Codex CARD_ONLY',inbox_reply:{id:'fixture',action_id:'agent-check'}}),calls=[];
  await execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);assert.equal(opts.mode,'ask');opts.onEvent({type:'text',text:'@Claude not a chat turn'});
    return {result:'card summary'};
  });
  assert.deepEqual(calls,['codex']);
});

test('the real chat page shows a midway handoff receipt before the colleague starts',async()=>{
  const first=submit({text:'@Codex MIDWAY_RECEIPT_UI'}),entered=gate(),finish=gate(),calls=[];
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    calls.push(provider);
    if(provider==='codex'){
      opts.onEvent({type:'text',text:'UI_PROGRESS_NOTE\n@Claude review after completion'});
      entered.resolve();await finish.promise;return {result:'SOURCE_READY'};
    }
    return {result:'UI_COLLEAGUE_RECEIVED'};
  });
  const server=createServer();let browser;
  try {
    await entered.promise;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await launchEdge();const page=await browser.newPage();
    await page.addInitScript(id=>localStorage.setItem('lab-session',id),first.session_id);
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.message.codex .message-meta').filter({hasText:'已登记交接 → Claude'}).waitFor();
    assert.deepEqual(calls,['codex']);
    finish.resolve();await running;
    await page.reload();await page.locator('.message.claude .message-text').filter({hasText:'UI_COLLEAGUE_RECEIVED'}).waitFor();
    assert.deepEqual(calls,['codex','claude']);
  } finally {
    finish.resolve();await running;await browser?.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
});
