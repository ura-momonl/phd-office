import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {submit,sendChat,execute as executeAgent,agentSnapshot} from './run.mjs';
import {update} from '../work/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {createServer} from '../dashboard/server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent);

for(const scenario of ['runner-error','missing-file'])test(`completion after explicit work update releases merged inputs on ${scenario}`,async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json'),cfg:read('agent/config.json')};
  const output=path.join(root,'.runtime/lifecycle-error.csv');let follow;
  try {
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false}});
    fs.writeFileSync(output,'fixture\n');
    const job=submit({text:'@Codex analyse fixture'});
    update({id:job.task_id,require_outputs:true});
    await execute(job.task_id,async(_,prompt,opts)=>{
      opts.onReady(async()=>{});
      follow=await sendChat({session_id:job.session_id,text:'additional context'});
      while(!read('work/queue.json').items.find(i=>i.id===follow.task_id).merged_into)await new Promise(r=>setImmediate(r));
      update({id:job.task_id,status:'done',handoff:'Registered CSV',outputs:[output]});
      if(scenario==='runner-error')throw new Error('fixture native failure after registration');
      fs.rmSync(output);return {result:'Only relative paths in this reply.'};
    });
    const items=read('work/queue.json').items,expected=scenario==='runner-error'?'failed':'done';
    for(const id of [job.task_id,follow.task_id])assert.equal(items.find(i=>i.id===id).status,expected);
    assert.deepEqual(agentSnapshot().active_turns,[]);
    const parent=items.find(i=>i.id===job.task_id);
    if(scenario==='runner-error')assert.ok(parent.history.at(-1).reason,'a native failure explains reopening the completed registration');
    if(scenario==='missing-file') {
      assert.deepEqual(parent.outputs,[output],'the executor preserves the explicit receipt rather than reclassifying delivery');
      assert.doesNotMatch(parent.handoff,/交付检查未通过/);
    }
  } finally {
    fs.rmSync(output,{force:true});write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);write('agent/config.json',saved.cfg);
  }
});

// Natural incident: the agent registered real outputs via work update before
// replying with relative paths. Completion lost those outputs, threw on reopening
// done -> waiting_user, then threw again on done -> failed, stranding merged input.
test('explicitly delivered files survive the final reply; merged inputs release the UI and restart API',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json'),cfg:read('agent/config.json')};
  const output=path.join(root,'.runtime/lifecycle-output.csv');
  let browser,server,calls=0;
  try {
    write('work/queue.json',{...saved.queue,items:[]});
    write('.runtime/agent/sessions.json',{sessions:[]});
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:false}});
    fs.writeFileSync(output,'fixture,value\nrow,1\n');
    const job=submit({text:'@Claude analyse the existing data'}),inputs=[];
    update({id:job.task_id,require_outputs:true});
    await execute(job.task_id,async(_,prompt,opts)=>{
      opts.onReady(async()=>{});
      for(const text of ['reference data','clarification','encouragement'])inputs.push(await sendChat({session_id:job.session_id,text}));
      // Delivery receipts are asynchronous; ensure all three reached this turn.
      for(;;){
        if(inputs.every(j=>read('work/queue.json').items.find(i=>i.id===j.task_id).merged_into===job.task_id))break;
        await new Promise(r=>setImmediate(r));
      }
      update({id:job.task_id,status:'done',handoff:'Registered the CSV',outputs:[output]});
      return {result:'Analysis complete. Output: lifecycle-output.csv'};
    });
    const items=read('work/queue.json').items,primary=items.find(i=>i.id===job.task_id);
    assert.equal(primary.status,'done');assert.deepEqual(primary.outputs,[output]);
    for(const j of inputs)assert.equal(items.find(i=>i.id===j.task_id).status,'done','merged inputs are not independent running jobs');
    const s=agentSnapshot();assert.deepEqual(s.active_turns,[]);
    assert.ok(s.sessions.find(s=>s.id===job.session_id).messages.some(m=>m.role==='assistant'&&!m.interim&&m.text.includes('Analysis complete')));
    server=createServer({restartBackend:()=>{calls++;}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await launchEdge();const page=await browser.newPage();
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.goto(base);
    await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
    assert.equal(await page.locator('#refresh').isEnabled(),true);
    const accepted=page.waitForResponse(r=>r.url()===base+'/api/backend/restart'&&r.request().method()==='POST');
    await page.locator('#refresh').click();
    assert.equal((await accepted).status(),202);
    assert.equal(calls,1,'the actual restart button reaches the accepted API');
  } finally {
    await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));
    fs.rmSync(output,{force:true});
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);write('agent/config.json',saved.cfg);
  }
});
