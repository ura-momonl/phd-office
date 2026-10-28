import test from 'node:test';
import assert from 'node:assert/strict';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run through scripts/run-tests.mjs in an isolated copy');

// Screenshot incident: three live supplements were presented as operating steps.
// Exercise storage -> snapshot API -> the actual project page, without running a model.
test('project page keeps conversation inputs out of steps and counts, while preserving live-agent and review information',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const saved=read('work/queue.json'),pid='tairte4-transport';
  const item=(id,status,extra={})=>({id,title:id,kind:'data',actor:'claude',status,project_ids:[pid],dependencies:[],outputs:[],created_at:'2026-10-26T12:00:00Z',...extra});
  const turns=[item('chat-root','active',{executor:'claude'}),
    ...['reference','clarification','encouragement'].map(id=>item(id,'active',{executor:'claude',merged_into:'chat-root'})),
    ...['done','cancelled','failed','queued','waiting_user'].map(status=>item('chat-'+status,status,{executor:'claude'}))];
  const steps=[item('real-step','active',{actor:'user',goal:'Fixture active step instructions'}),item('review-delivery','done',{executor:'claude',review:{state:'pending'},handoff:'Fixture result',goal:'Fixture completed step instructions'})];
  write('work/queue.json',{...saved,items:[...turns,...steps]});
  const server=createServer();let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const snapshot=await (await fetch(base+'/api/state')).json();
    for(const t of turns)assert.equal(snapshot.work.items.find(i=>i.id===t.id)?.turn,true);
    assert.equal(snapshot.work.items.find(i=>i.id==='review-delivery')?.turn,false);
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.goto(base+'/#projects/'+pid);
    await page.locator('[data-step-row="real-step"]').waitFor();
    assert.equal(await page.locator('[data-step-row]').count(),2);
    assert.equal(await page.locator('[data-step-row="review-delivery"]').count(),1);
    for(const t of turns)assert.equal(await page.locator(`[data-step-row="${t.id}"]`).count(),0,t.id);
    // Screenshot incident: step instructions closed at the next five-second poll.
    // Observe an actual DOM replacement, not just the HTTP response arriving.
    const activeGoal=page.locator('[data-step-row="real-step"] .step-goal');
    const completedGoal=page.locator('[data-step-row="review-delivery"] .step-goal');
    const nextPoll=async()=>{
      await activeGoal.evaluate(el=>el.dataset.pollProbe='before');
      await page.waitForFunction(()=>{
        const el=document.querySelector('[data-step-row="real-step"] .step-goal');
        return el && !el.dataset.pollProbe;
      },null,{timeout:20000});
    };
    assert.equal(await completedGoal.evaluate(el=>el.open),false);
    await completedGoal.locator('summary').click();
    await nextPoll();
    assert.equal(await completedGoal.evaluate(el=>el.open),true,'completed instructions stay open after automatic refresh');
    assert.equal(await completedGoal.locator('p').isVisible(),true);
    assert.equal(await activeGoal.evaluate(el=>el.open),false,'another step keeps its own collapsed state');
    await activeGoal.locator('summary').click();
    await completedGoal.locator('summary').click();
    await nextPoll();
    assert.equal(await completedGoal.evaluate(el=>el.open),false,'an explicit close stays closed');
    assert.equal(await activeGoal.evaluate(el=>el.open),true,'active instructions also survive a later refresh');
    await page.goto(base+'/#projects');
    const card=page.locator('.project-summary').filter({has:page.locator(`[data-project-open="${pid}"]`)});
    await card.waitFor();
    assert.match(await card.innerText(),/Claude 工作中/);
    // Project entries may have their own doing state; only one operating step is active.
    const project=snapshot.projects.find(p=>p.id===pid);
    const flat=nodes=>nodes.flatMap(n=>[n,...flat(n.children || [])]);
    const doing=flat(project.framework.boards).filter(n=>n.status==='doing' && (n.id || project.framework.boards.includes(n))).length+1;
    assert.equal(await card.locator('[data-project-doing]').getAttribute('data-project-doing'),String(doing));
    assert.deepEqual(errors,[]);
    assert.deepEqual(read('work/queue.json').items.map(i=>i.id).sort(),[...turns,...steps].map(i=>i.id).sort(),'display does not delete or cancel conversation records');
  } finally {
    await browser?.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',saved);
  }
});

test('project operations show parent ownership and execution history without turning runs into extra steps',async()=>{
  const saved=read('work/queue.json'),sessionsBefore=read('.runtime/agent/sessions.json'),pid='tairte4-transport';
  const item=(id,status,extra={})=>({id,title:id,kind:'data',actor:'claude',status,project_ids:[pid],dependencies:[],outputs:[],handoff:'',goal:'Fixture operation',created_at:'2026-10-26T12:00:00Z',...extra});
  const parent=item('graph-parent','open',{title:'分析整个测量批次'});
  const child=item('graph-child','open',{title:'解释异常读数',parent_id:parent.id,handoff:'首轮成果仍保留。',outputs:['workspace/projects/tairte4-transport/analysis/original-result.csv']});
  const first=item('graph-run-first','done',{executor:'claude',operation_id:child.id,source_task_id:child.id,outcome_status:'done',created_at:'2026-10-26T12:01:00Z',completed_at:'2026-10-26T12:02:00Z',handoff:'第一轮已交付。',outputs:[...child.outputs]});
  const second=item('graph-run-second','done',{executor:'claude',operation_id:child.id,outcome_status:'open',created_at:'2026-10-26T12:03:00Z',completed_at:'2026-10-26T12:04:00Z',handoff:'第二轮回复已结束，尚未提交完成。'});
  const repeated=item('graph-repeated','done',{title:'保留成果并再次分析',handoff:'上次分析的已提交结论',outputs:['workspace/projects/tairte4-transport/analysis/accepted-result.csv']});
  const running=item('graph-run-active','active',{executor:'claude',operation_id:repeated.id,created_at:'2026-10-26T12:06:00Z'});
  const session=(id,title,task)=>({id,title,origin:'task',project_ids:[pid],created_at:task.created_at,task_ids:[task.id],messages:[{role:'user',text:title,task_id:task.id,at:task.created_at},{role:'assistant',provider:'claude',text:title+'结果',task_id:task.id,at:'2026-10-26T12:05:00Z'}]});
  write('work/queue.json',{...saved,items:[parent,child,repeated,first,second,running]});
  write('.runtime/agent/sessions.json',{sessions:[session('graph-original-session','首次分析',child),session('graph-second-session','第二次分析',second)]});
  const server=createServer();let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const snapshot=await (await fetch(base+'/api/state')).json(),stored=snapshot.work.items.find(i=>i.id===child.id);
    assert.deepEqual(stored.execution_history.map(r=>r.id),[first.id,second.id]);
    assert.equal(stored.last_execution.outcome_status,'open');assert.deepEqual(stored.outputs,child.outputs);
    for(const run of [first,second,running])assert.equal(snapshot.work.items.find(i=>i.id===run.id).turn,true);
    assert.equal(snapshot.work.items.find(i=>i.id===parent.id).status,'open','child execution does not decide parent completion');
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.goto(base+'/#projects/'+pid);
    const row=page.locator(`[data-step-row="${child.id}"]`);await row.waitFor();
    assert.equal(await page.locator('[data-step-row]').count(),3,'execution records do not create additional operating steps');
    const repeatedRow=page.locator(`[data-step-row="${repeated.id}"]`);
    assert.equal(await repeatedRow.locator('[data-step-chip]').innerText(),'正在进行','the chip reflects the running repeat');
    assert.equal(await repeatedRow.locator('[data-step-chip]').getAttribute('data-step-status'),'done','the submitted operation state remains intact');
    assert.equal(await repeatedRow.locator('[data-step-chip]').isDisabled(),true);
    assert.match(await repeatedRow.innerText(),/本次正在执行；原成果保留/);
    const files=repeatedRow.locator(`[data-step-files="${repeated.id}"]`);
    assert.equal(await files.evaluate(n=>n.open),false,'handoff files start collapsed');
    assert.equal(await files.locator('.file-name').isVisible(),false);
    assert.match(await repeatedRow.innerText(),/上次分析的已提交结论/,'the handoff explanation stays visible');
    await files.locator('summary').click();
    assert.ok((await repeatedRow.innerText()).includes(repeated.outputs[0]));
    const poll=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.clock.fastForward(5000);await response;};
    await poll();assert.equal(await files.evaluate(n=>n.open),true,'an expanded file list survives refresh');
    await files.locator('summary').click();await poll();assert.equal(await files.evaluate(n=>n.open),false,'a closed file list stays closed');
    await repeatedRow.locator('[data-execution-history] > summary').click();
    assert.match(await repeatedRow.locator(`[data-execution-row="${running.id}"]`).innerText(),/执行中/);
    assert.equal(await row.locator('[data-step-parent]').innerText(),'所属操作：分析整个测量批次');
    assert.match(await row.innerText(),/上一轮已结束，未提交完成/);
    const history=row.locator('[data-execution-history]');
    assert.equal(await history.locator(':scope > summary').innerText(),'执行历史 · 2 次');
    await history.locator(':scope > summary').click();
    assert.equal(await history.locator('[data-execution-row]').count(),2);
    assert.match(await history.locator(`[data-execution-row="${first.id}"]`).innerText(),/本轮已结束 · 已提交完成/);
    assert.match(await history.locator(`[data-execution-row="${second.id}"]`).innerText(),/本轮已结束 · 未提交完成/);
    assert.equal(await history.locator(`[data-step-files="${first.id}"]`).evaluate(n=>n.open),false,'execution files are folded separately');
    await row.locator(`[data-step-files="${child.id}"] > summary`).click();
    assert.ok((await row.innerText()).includes(child.outputs[0]),'the original result remains at its original path');
    await history.locator(`[data-task-session="${child.id}"]`).click();
    assert.equal(await page.locator('#session-title').innerText(),'首次分析 · 任务会话','source_task_id opens the original execution conversation');
    assert.deepEqual(errors,[]);
    assert.deepEqual(read('work/queue.json').items.find(i=>i.id===child.id).outputs,child.outputs);
  } finally {
    await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',saved);write('.runtime/agent/sessions.json',sessionsBefore);
  }
});
