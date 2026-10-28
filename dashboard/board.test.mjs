import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {enqueue} from '../work/run.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {createServer} from './server.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run via node scripts/run-tests.mjs --board-ui in a sanitised copy');

test('lightweight board uses the real queue, opens original conversations and fits narrow windows',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const beforeQueue=read('work/queue.json'),beforeSessions=read('.runtime/agent/sessions.json');
  const pid=read('projects/catalog.json').projects[0].id;
  let browser,page,server;
  try {
    write('work/queue.json',{...beforeQueue,items:[]});
    const manual=enqueue({title:'人工测量准备',kind:'experiment',actor:'user',project_ids:[pid]});
    const queued=enqueue({title:'等待测量结果的数据处理',kind:'data',actor:'claude',status:'queued',project_ids:[pid],dependencies:[manual.id]});
    const active=enqueue({title:'正在核对数据 <不是 HTML>',kind:'data',actor:'codex',project_ids:[]});
    const old=enqueue({title:'历史已完成问答',kind:'framework',actor:'codex',project_ids:[]});
    const merged=enqueue({title:'已合并请求不重复计数',kind:'framework',actor:'codex',project_ids:[]});
    const deleted=enqueue({title:'已删除步骤不显示',kind:'framework',actor:'codex',project_ids:[]});
    const waiting=enqueue({title:'等用户确认不算执行排队',kind:'framework',actor:'codex',project_ids:[]});
    const setFields=(id,fields)=>{
      const q=read('work/queue.json');Object.assign(q.items.find(i=>i.id===id),fields);write('work/queue.json',q);
    };
    setFields(active.id,{status:'active'});setFields(old.id,{status:'done'});
    setFields(merged.id,{status:'active',merged_into:active.id});
    setFields(deleted.id,{deleted_at:new Date().toISOString()});setFields(waiting.id,{status:'waiting_user'});
    setFields(queued.id,{exploration:{max_rounds:5,round:2,snapshot:[]}});
    const makeSession=(id,title,task,origin)=>({id,title,task_ids:[task.id],project_ids:task.project_ids,origin,
      created_at:'2026-10-10T12:00:00Z',messages:[{role:'user',at:'2026-10-10T12:00:00Z',text:title,task_id:task.id}]});
    write('.runtime/agent/sessions.json',{sessions:[makeSession('board-active','原始核对对话',active,'chat'),makeSession('board-queued','原始处理任务',queued,'task')]});
    server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,posts=[],errors=[];
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1000}});
    // Keep the app's real 5 s poll; jump the page clock to the next tick instead of idling for it.
    await page.clock.install();const poll=()=>page.clock.fastForward(5000);
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(base);
    const rail=page.locator('#chat-context .rail-section').first();
    await rail.locator('.rail-heading').waitFor();
    assert.ok((await rail.locator('.rail-heading').innerText()).startsWith('工作看板'));
    await rail.locator('#overview strong').first().waitFor();
    assert.equal(await rail.locator('.live-dot').count(),0,'remove the old decorative dot only');
    assert.deepEqual(await rail.locator('#overview strong').allTextContents(),['2','1']);
    assert.deepEqual(await rail.locator('#overview small').allTextContents(),['待办','正在进行']);
    await rail.getByRole('button',{name:'详情 ↗'}).click();
    await page.locator('#page-board[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('.nav[data-page="more"]').getAttribute('class'),'nav active');
    await page.locator('#more-tabs .more-tab[data-page="board"].active').waitFor();
    const qcol=page.locator('[data-board-status="queued"]'),acol=page.locator('[data-board-status="active"]');
    assert.equal(await qcol.locator('.board-task').count(),2);assert.equal(await acol.locator('.board-task').count(),1);
    assert.deepEqual(await page.locator('.board-count').allTextContents(),['2','1']);
    const manualCard=page.locator(`[data-board-task="${manual.id}"]`),queueCard=page.locator(`[data-board-task="${queued.id}"]`);
    assert.ok((await manualCard.innerText()).includes('用户'));assert.ok((await manualCard.innerText()).includes('尚未关联对话'));
    assert.equal(await manualCard.locator('button').count(),0,'do not invent a conversation or dispatch a task');
    assert.equal(await queueCard.locator('.board-waiting').innerText(),'等前置：人工测量准备');
    assert.ok((await queueCard.innerText()).includes('Claude'));
    assert.equal(await queueCard.locator('.board-task-meta').innerText().then(t=>t.includes('探索')),false,'legacy exploration metadata does not claim automatic continuation');
    assert.equal((await manualCard.locator('.board-task-meta').innerText()).includes('探索'),false,'ordinary cards are unchanged');
    await page.locator(`[data-board-task="${active.id}"] .board-task-title`).getByText('正在核对数据 <不是 HTML>',{exact:false}).waitFor();
    for(const i of [old,merged,deleted,waiting])assert.equal(await page.locator(`[data-board-task="${i.id}"]`).count(),0);
    const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});
    await page.screenshot({path:path.join(dir,'work-board-desktop.png')});
    // Both ordinary and task sessions keep their original identity when entered from the board.
    await page.locator(`[data-board-task="${active.id}"] .board-task-title`).click();
    assert.equal(await page.locator('#session-title').innerText(),'原始核对对话');
    assert.equal(await page.locator('#transcript [data-task]').first().getAttribute('data-task'),active.id);
    await page.locator('.nav[data-page="more"]').click();await page.locator('#page-board[aria-busy="false"]').waitFor();
    await queueCard.locator('.board-task-title').click();
    assert.equal(await page.locator('#session-title').innerText(),'原始处理任务 · 任务会话');
    await page.locator('.nav[data-page="more"]').click();
    // Existing polling moves work between columns and keeps the compact counts in sync.
    setFields(active.id,{status:'done'});setFields(manual.id,{status:'done'});setFields(queued.id,{status:'active'});
    await poll();
    await page.waitForFunction(()=>document.querySelector('[data-board-status="queued"] .board-count')?.textContent==='0',{},{timeout:12000});
    assert.equal(await qcol.locator('.board-task').count(),0);assert.equal(await acol.locator('.board-task').count(),1);
    assert.deepEqual(await page.locator('#overview strong').allTextContents(),['0','1']);
    assert.equal(await queueCard.locator('.board-waiting').count(),0,'completed predecessors no longer block');
    setFields(queued.id,{title:'LongUnbrokenTitle'.repeat(10)});
    await poll();
    await page.waitForFunction(()=>document.querySelector('.board-task-title')?.textContent.includes('LongUnbrokenTitle'),{},{timeout:12000});
    await page.setViewportSize({width:390,height:900});
    assert.equal(await page.locator('#page-board').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await queueCard.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(dir,'work-board-mobile.png'),fullPage:true});
    await page.locator('.nav[data-page="chat"]').click();await page.locator('.nav[data-page="more"]').click();
    await page.locator('#page-board').waitFor();
    setFields(queued.id,{status:'done'});
    await poll();
    await acol.getByText('当前没有正在进行的任务。',{exact:true}).waitFor({timeout:12000});
    await qcol.getByText('暂无待办任务。',{exact:true}).waitFor();
    assert.deepEqual(await page.locator('#overview strong').allTextContents(),['0','0']);
    // The sidebar badge counts active work, not unread answers. Re-clicking the
    // active module cycles its conversations (including task sessions), not jobs.
    await page.setViewportSize({width:1440,height:1000});
    const chatNav=page.locator('.nav[data-page="chat"]');
    const title=page.locator('#session-title'),message=page.locator('#message');
    await chatNav.click();await title.getByText('原始处理任务 · 任务会话',{exact:true}).waitFor();
    await message.fill('保留这份草稿');await chatNav.click();
    assert.equal(await title.innerText(),'原始处理任务 · 任务会话','no active work leaves the conversation alone');
    assert.equal(await message.inputValue(),'保留这份草稿');
    // A user's ongoing experiments are board work, not running agents. Keep one
    // unlinked (the observed incident) and one attached to an older conversation.
    const manualLinked=enqueue({title:'有旧对话的人工测量',actor:'user',kind:'experiment',project_ids:[]});
    setFields(manual.id,{status:'active'});setFields(manualLinked.id,{status:'active'});await poll();
    await page.waitForFunction(()=>document.querySelectorAll('#overview strong')[1].textContent==='2');
    assert.equal(await page.locator('#active-count').innerText(),'','manual experiments must not leave a stuck chat count');
    assert.equal(await page.locator('#running').innerText(),'');
    await chatNav.click();assert.equal(await title.innerText(),'原始处理任务 · 任务会话');
    // Two jobs in one conversation still create just one navigation target;
    // active work without a session does not invent a new conversation.
    const orphan=enqueue({title:'没有会话的运行任务',actor:'codex',kind:'data',project_ids:[]});
    const duplicate=enqueue({title:'同一会话中的另一任务',actor:'codex',kind:'data',project_ids:[]});
    for(const id of [active.id,queued.id,orphan.id,duplicate.id])setFields(id,{status:'active'});
    const sessions=read('.runtime/agent/sessions.json');
    sessions.sessions.find(s=>s.id==='board-active').task_ids.push(duplicate.id);
    sessions.sessions.find(s=>s.id==='board-queued').task_ids.push(manualLinked.id);
    write('.runtime/agent/sessions.json',sessions);await poll();
    await page.waitForFunction(()=>document.querySelector('#active-count').textContent==='4');
    assert.equal(await page.locator('#running').innerText(),'4 项助手任务正在执行');
    assert.deepEqual(await page.locator('#overview strong').allTextContents(),['0','6'],'the board still includes user experiments');
    await page.locator('.nav[data-page="more"]').click();await chatNav.click();
    await title.getByText('原始处理任务 · 任务会话',{exact:true}).waitFor();
    await page.locator('.chat-tab[data-page="chat"]').click();
    assert.equal(await title.innerText(),'原始处理任务 · 任务会话','the current-chat tab is not the sidebar shortcut');
    await chatNav.click();await title.getByText('原始核对对话',{exact:true}).waitFor();
    await message.fill('另一份草稿');await chatNav.locator('#active-count').click();
    await title.getByText('原始处理任务 · 任务会话',{exact:true}).waitFor();
    assert.equal(await message.inputValue(),'保留这份草稿');
    await page.setViewportSize({width:390,height:900});
    await page.locator('.chat-tab[data-page="history"]').click();await chatNav.click();
    await title.getByText('原始核对对话',{exact:true}).waitFor();
    assert.equal(await message.inputValue(),'另一份草稿');
    await page.locator('.chat-tab[data-page="tasks"]').click();await chatNav.click();
    await title.getByText('原始处理任务 · 任务会话',{exact:true}).waitFor();
    setFields(queued.id,{status:'done'});await poll();
    await page.waitForFunction(()=>document.querySelector('#active-count').textContent==='3');
    await chatNav.click();await title.getByText('原始核对对话',{exact:true}).waitFor();
    await chatNav.click();assert.equal(await title.innerText(),'原始核对对话','one remaining session stays selected');
    for(const id of [active.id,orphan.id,duplicate.id])setFields(id,{status:'done'});await poll();
    await page.waitForFunction(()=>document.querySelector('#active-count').textContent==='');
    assert.equal(await page.locator('#running').innerText(),'');
    assert.deepEqual(await page.locator('#overview strong').allTextContents(),['0','2']);
    await chatNav.click();assert.equal(await title.innerText(),'原始核对对话','a user-only older conversation is not a running-agent target');
    assert.equal(read('work/queue.json').items.find(i=>i.id===manual.id).status,'active');
    assert.equal(read('work/queue.json').items.find(i=>i.id===manualLinked.id).status,'active');
    await page.screenshot({path:path.join(dir,'running-conversation-shortcut.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.ok(posts.every(p=>p==='/api/usage/refresh'),'the board is read-only and cannot dispatch models');
    assert.equal(read('.runtime/agent/sessions.json').sessions.length,2);
  } catch(error) {
    if(page){const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'board-failure.png'),fullPage:true});}
    throw error;
  } finally {
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',beforeQueue);write('.runtime/agent/sessions.json',beforeSessions);
  }
});

test('board keeps unfinished submissions in a separate resumable section without counting execution records as tasks',async()=>{
  const queueBefore=read('work/queue.json'),sessionsBefore=read('.runtime/agent/sessions.json');
  const item=(id,status,extra={})=>({id,title:id,kind:'data',actor:'claude',status,project_ids:[],dependencies:[],outputs:[],handoff:'',created_at:'2026-10-26T12:00:00Z',...extra});
  const parent=item('board-graph-parent','done',{title:'既定分析工作'});
  const unfinished=item('board-graph-unfinished','open',{title:'尚未提交的分析',parent_id:parent.id});
  const untouched=item('board-graph-untouched','open',{title:'尚未开始的提议'});
  const active=item('board-graph-active','done',{title:'已交付分析的再次执行',outputs:['workspace/results/original.csv'],handoff:'上次已交付的结果'}),queued=item('board-graph-queued','queued',{actor:'user',title:'待办测量'});
  const old=item('board-graph-first','done',{executor:'claude',operation_id:unfinished.id,source_task_id:unfinished.id,outcome_status:'done',created_at:'2026-10-26T12:01:00Z'});
  const ended=item('board-graph-ended','done',{executor:'claude',operation_id:unfinished.id,outcome_status:'open',created_at:'2026-10-26T12:02:00Z',completed_at:'2026-10-26T12:03:00Z'});
  const running=item('board-graph-running','active',{executor:'claude',operation_id:active.id,created_at:'2026-10-26T12:04:00Z'});
  write('work/queue.json',{...queueBefore,items:[parent,unfinished,untouched,active,queued,old,ended,running]});
  write('.runtime/agent/sessions.json',{sessions:[{id:'board-graph-session',title:'最近一次分析',origin:'task',project_ids:[],task_ids:[ended.id],created_at:ended.created_at,messages:[{role:'user',text:'继续分析',task_id:ended.id,at:ended.created_at},{role:'assistant',provider:'claude',text:'本轮分析结束',task_id:ended.id,at:ended.completed_at}]},{id:'board-repeat-session',title:'再次执行中的分析',origin:'task',project_ids:[],task_ids:[running.id],created_at:running.created_at,messages:[{role:'user',text:'再次执行',task_id:running.id,at:running.created_at}]}]});
  const server=createServer();let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const snapshot=await (await fetch(base+'/api/state?page=board')).json();
    assert.equal(snapshot.work.items.find(i=>i.id===unfinished.id).last_execution.outcome_status,'open');
    assert.equal(snapshot.work.items.find(i=>i.id===active.id).last_execution.status,'active');
    assert.equal(snapshot.work.items.find(i=>i.id===parent.id).title,parent.title);
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.goto(base);await page.locator('.nav[data-page="more"]').click();
    await page.locator('#more-tabs [data-page="board"]').click();
    const resume=page.locator('[data-board-resume]');await resume.waitFor();
    assert.deepEqual(await page.locator('.board-count').allTextContents(),['1','1'],'pending submissions are not queued or running counts');
    assert.deepEqual(await page.locator('#overview strong').allTextContents(),['1','1']);
    const repeated=page.locator(`[data-board-status="active"] [data-board-task="${active.id}"]`);
    assert.equal(await repeated.count(),1,'one completed operation appears once for its running repeat');
    assert.match(await repeated.innerText(),/本次正在执行；原成果保留/);
    assert.equal(read('work/queue.json').items.find(i=>i.id===active.id).status,'done','the board only derives display placement');
    assert.deepEqual(read('work/queue.json').items.find(i=>i.id===active.id).outputs,active.outputs);
    assert.equal(await resume.locator('[data-board-task]').count(),1);
    const row=resume.locator(`[data-board-task="${unfinished.id}"]`);
    assert.match(await row.innerText(),/上一轮已结束，未提交完成/);
    assert.match(await row.innerText(),/所属操作：既定分析工作/);
    for(const run of [old,ended,running])assert.equal(await page.locator(`[data-board-task="${run.id}"]`).count(),0);
    assert.equal(await page.locator(`[data-board-task="${untouched.id}"]`).count(),0,'an untouched open proposal does not become resumable work');
    await repeated.locator('.board-task-title').click();
    assert.equal(await page.locator('#session-title').innerText(),'再次执行中的分析 · 任务会话');
    await page.locator('.nav[data-page="more"]').click();
    await page.locator('[data-board-resume]').waitFor();
    await row.locator('.board-task-title').click();
    assert.equal(await page.locator('#session-title').innerText(),'最近一次分析 · 任务会话');
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queueBefore);write('.runtime/agent/sessions.json',sessionsBefore);
  }
});
