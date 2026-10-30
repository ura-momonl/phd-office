import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {createServer} from './server.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run via node scripts/run-tests.mjs --unread-ui in a sanitised copy');

test('unread dots follow actual viewing and synchronise across independent desktop/mobile browsers',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let browser,page;
  try {
    const fixture=await (await fetch(base+'/api/state')).json(),pid=fixture.projects[0].id;
    const reply=(at,text,provider='codex',interim=false)=>({role:'assistant',provider,at,text,interim});
    const session=(id,project_ids,messages,origin='chat')=>({id,title:'Fixture '+id,project_ids,task_ids:[],messages,origin});
    const shared=session('shared',[],[reply('2026-10-10T12:00:00Z','Shared final','claude')]);
    const project=session('project',[pid],[reply('2026-10-10T12:01:00Z','Project final')]);
    const progress=session('progress',[],[reply('2026-10-10T12:02:00Z','Progress only','codex',true)]);
    const task=session('task',[pid],[reply('2026-10-10T12:03:00Z','Task final','claude')],'task');
    fixture.agent.sessions=[shared,project,progress,task];
    progress.task_ids=['active-progress'];
    fixture.work.items=[{id:'active-progress',actor:'codex',executor:'codex',status:'active',project_ids:[]}];
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    // Keep the app's real 5 s poll; jump the page clock to the next tick instead of idling for it.
    await page.clock.install();const poll=()=>page.clock.fastForward(5000);
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.route('**/api/state*',route=>route.fulfill({json:fixture}));
    await page.goto(base+'/#projects');
    const recent=id=>page.locator(`#sessions [data-session="${id}"]`);
    const dot=id=>recent(id).locator('.session-unread-dot');
    await dot('shared').waitFor();await dot('project').waitFor();
    assert.equal(await dot('progress').count(),0,'interim text is not a finished unread reply');
    await recent('progress').getByText('Codex · 正在运行',{exact:true}).waitFor();
    assert.equal(await recent('shared').locator('.session-meta').innerText(),'共享工作');
    assert.equal(await dot('shared').getAttribute('aria-label'),'有未读回复');
    // The dot remains visible even when a long project name has to truncate.
    fixture.projects.find(p=>p.id===pid).name='A very long project name '.repeat(8);
    await page.reload();await dot('project').waitFor();
    assert.equal(await recent('project').evaluate(el=>{
      const dot=el.querySelector('.session-unread-dot').getBoundingClientRect(),button=el.getBoundingClientRect();
      return dot.width>0 && dot.left>=button.left && dot.right<button.right;
    }),true);
    const projectCard=page.locator('#project-grid .project-summary').filter({has:page.locator(`[data-project-open="${pid}"]`)});
    await projectCard.getByText('2 条新更新',{exact:true}).waitFor();
    await page.locator('.nav[data-page="chat"]').click();
    await page.locator('[data-page="history"].chat-tab').click();
    await page.locator('#history-list [data-session="shared"] .session-unread-dot').waitFor();
    await page.locator('[data-page="tasks"].chat-tab').click();
    await page.locator('#tasks-list [data-session="task"] .session-unread-dot').waitFor();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lab-agent-read') || '{}').shared || 0),0,'opening lists is not reading replies');
    const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});
    await page.locator('.nav[data-page="projects"]').click();
    await page.screenshot({path:path.join(dir,'conversation-unread.png')});
    // Click one conversation: its dot clears immediately, not another conversation's.
    await recent('shared').click();await page.locator('#transcript').getByText('Shared final',{exact:true}).waitFor();
    await dot('shared').waitFor({state:'detached'});assert.equal(await dot('project').count(),1);
    await recent('project').click();await dot('project').waitFor({state:'detached'});
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('1 条新更新',{exact:true}).waitFor();
    // The project page offers a per-update and an all-at-once read button that does not open the conversation.
    await page.locator(`[data-project-open="${pid}"]`).first().click();
    await page.locator('.project-new-updates .project-update-read-all').click();
    await page.locator('.project-new-updates').waitFor({state:'detached'});
    assert.ok(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('lab-agent-read') || '{}')).length>0));
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('无新更新',{exact:true}).waitFor();
    await page.locator('.nav[data-page="chat"]').click();
    await page.locator('[data-page="tasks"].chat-tab').click();
    await page.locator('#tasks-list [data-session="task"]').click();
    await page.locator('#transcript').getByText('Task final',{exact:true}).waitFor();
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('无新更新',{exact:true}).waitFor();
    await page.reload();assert.equal(await dot('shared').count(),0);assert.equal(await dot('project').count(),0);
    // A finished answer arriving on another page remains unread through polling and reload.
    shared.messages.push(reply('2026-10-10T13:00:00Z','New shared final'));
    await poll();await dot('shared').waitFor({timeout:12000});await page.reload();await dot('shared').waitFor();
    await recent('shared').click();await dot('shared').waitFor({state:'detached'});
    shared.messages.push(reply('2026-10-10T14:00:00Z','Visible final','claude'));await poll();
    await page.locator('#transcript').getByText('Visible final',{exact:true}).waitFor({timeout:12000});
    assert.equal(await dot('shared').count(),0,'following the visible conversation reads the final automatically');
    // Scrolling up is not viewing a new final. Only returning to the bottom clears its dot.
    shared.messages.push(reply('2026-10-10T15:00:00Z',Array.from({length:80},(_,i)=>'Long line '+i).join('\n')));await poll();
    await page.locator('#transcript').getByText(/Long line 79/).waitFor({timeout:12000});
    await page.locator('#transcript').evaluate(el=>{el.scrollTop=0;});await page.locator('#latest').waitFor();
    shared.messages.push(reply('2026-10-10T16:00:00Z','Below the fold'));await poll();
    await dot('shared').waitFor({timeout:12000});
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lab-agent-read')).shared),Date.parse('2026-10-10T15:00:00Z'));
    await page.locator('#latest').click();await dot('shared').waitFor({state:'detached'});
    await page.screenshot({path:path.join(dir,'conversation-read.png')});
    assert.deepEqual(errors,[]);
    await page.close();page=undefined;
    await crossDeviceReads(browser,base,pid,dir);
  } catch(error) {
    if(page){const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'unread-failure.png')});}
    throw error;
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
});

async function crossDeviceReads(browser,base,pid,dir) {
  const t1=Date.parse('2026-10-12T12:00:00Z'),t2=t1+3600000,t3=t2+3600000;
  const reply=(at,text,interim=false)=>({role:'assistant',provider:'codex',at:new Date(at).toISOString(),text,interim});
  const shared={id:'sync',title:'Cross-device reply',origin:'chat',project_ids:[pid],task_ids:[],messages:[reply(t1,'Synced first final')]};
  const legacy={id:'legacy-sync',title:'Legacy cache',origin:'chat',project_ids:[],task_ids:[],messages:[reply(t1,'Previously read')]};
  const progress={id:'sync-progress',title:'Interim only',origin:'chat',project_ids:[],task_ids:[],messages:[reply(t1,'Still running',true)]};
  const save=()=>write('.runtime/agent/sessions.json',{sessions:[shared,legacy,progress]});
  save();write('work/queue.json',{...read('work/queue.json'),items:[]});
  const desktop=await browser.newContext({viewport:{width:1440,height:1000}});
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try {
    const pc=await desktop.newPage(),phone=await mobile.newPage(),errors=[];
    for(const p of [pc,phone]){
      p.on('pageerror',e=>errors.push(e.message));await p.clock.install();
      await p.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    }
    // Existing local-only receipts migrate without opening a conversation.
    await pc.addInitScript(at=>{if(window!==window.top)return; /* the sandboxed companion iframe has no localStorage */ if(!localStorage.getItem('lab-agent-read'))localStorage.setItem('lab-agent-read',JSON.stringify({'legacy-sync':at}));},t1);
    const migration=pc.waitForResponse(r=>r.url().endsWith('/api/chat/read') && r.status()===200);
    await pc.goto(base+'/#projects');await migration;
    await phone.goto(base+'/#projects');
    const dot=p=>p.locator('#sessions [data-session="sync"] .session-unread-dot');
    const card=p=>p.locator('#project-grid .project-summary').filter({has:p.locator(`[data-project-open="${pid}"]`)});
    const poll=p=>p.clock.fastForward(5000);
    await dot(pc).waitFor();await card(phone).getByText('1 条新更新',{exact:true}).waitFor();
    assert.equal(await phone.locator('#sessions [data-session="legacy-sync"] .session-unread-dot').count(),0);
    const json=async url=>(await (await fetch(base+url)).json());
    const receipt=async read_at=>fetch(base+'/api/chat/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({read_at})});
    assert.equal((await json('/api/state?page=projects')).agent_read_at['legacy-sync'],t1);

    // Phone reads -> desktop recent/history/project markers clear on the normal poll.
    await phone.bringToFront();
    const phoneRead=phone.waitForResponse(r=>r.url().endsWith('/api/chat/read') && r.status()===200);
    await card(phone).locator('.project-new-update').click();await phoneRead;
    await phone.locator('#transcript').getByText('Synced first final',{exact:true}).waitFor();
    await poll(pc);await dot(pc).waitFor({state:'detached'});await card(pc).getByText('无新更新',{exact:true}).waitFor();
    await pc.bringToFront();await pc.locator('.nav[data-page="chat"]').click();await pc.locator('[data-page="history"].chat-tab').click();
    await pc.locator('#history-list [data-session="sync"]').waitFor();
    assert.equal(await pc.locator('#history-list [data-session="sync"] .session-unread-dot').count(),0);
    await pc.locator('.nav[data-page="projects"]').click();await phone.locator('.nav[data-page="projects"]').click();

    // A later final is new on both devices; reading on desktop synchronises back to phone.
    shared.messages.push(reply(t2,'Synced second final'));save();await poll(pc);await poll(phone);
    await dot(pc).waitFor();await card(phone).getByText('1 条新更新',{exact:true}).waitFor();
    await pc.bringToFront();const pcRead=pc.waitForResponse(r=>r.url().endsWith('/api/chat/read') && r.status()===200);
    await pc.locator('#sessions [data-session="sync"]').click();await pcRead;
    await poll(phone);await card(phone).getByText('无新更新',{exact:true}).waitFor();
    await phone.reload();await phone.locator('.nav[data-page="projects"]').click();await card(phone).getByText('无新更新',{exact:true}).waitFor();
    assert.equal((await json('/api/state?page=chat&session=sync')).agent_read_at.sync,t2);

    // A delayed older receipt cannot rewind; unknown/interim replies are not acknowledged.
    await receipt({sync:t1,'sync-progress':t3,'unknown-session':t3});
    const saved=(await json('/api/state?page=history')).agent_read_at;
    assert.equal(saved.sync,t2);assert.equal(saved['sync-progress'],undefined);assert.equal(saved['unknown-session'],undefined);
    assert.equal((await receipt({sync:'bad'})).status,400);
    assert.equal((await receipt([])).status,400);

    // A disconnected read stays cached locally, then syncs on the existing poll.
    await pc.locator('.nav[data-page="projects"]').click();shared.messages.push(reply(t3,'Read while offline'));save();
    await poll(pc);await poll(phone);await dot(pc).waitFor();await card(phone).getByText('1 条新更新',{exact:true}).waitFor();
    await phone.route('**/api/chat/read',route=>route.abort());await phone.bringToFront();
    await card(phone).locator('.project-new-update').click();await phone.locator('#error').getByText(/已读状态暂未同步/).waitFor();
    assert.equal((await json('/api/state?page=projects')).agent_read_at.sync,t2);
    assert.equal(await phone.evaluate(()=>JSON.parse(localStorage.getItem('lab-agent-read')).sync),t3);
    await phone.unroute('**/api/chat/read');const recovered=phone.waitForResponse(r=>r.url().endsWith('/api/chat/read') && r.status()===200);
    await poll(phone);await recovered;await phone.locator('#error').waitFor({state:'hidden'});await poll(pc);await dot(pc).waitFor({state:'detached'});
    await card(pc).getByText('无新更新',{exact:true}).waitFor();
    await phone.screenshot({path:path.join(dir,'unread-synced-mobile.png')});await pc.screenshot({path:path.join(dir,'unread-synced-desktop.png')});
    // Persisted reply boundary (not a device clock) survives new server instances.
    const next=createServer();await new Promise(r=>next.listen(0,'127.0.0.1',r));
    try{assert.equal((await (await fetch(`http://127.0.0.1:${next.address().port}/api/state?page=projects`)).json()).agent_read_at.sync,t3);}
    finally{await new Promise(r=>next.close(r));}
    await receipt({sync:t3+86400000});assert.equal((await json('/api/state?page=projects')).agent_read_at.sync,t3,'future timestamps cannot suppress the next reply');
    assert.deepEqual(errors,[]);
  }catch(error){for(const [context,name] of [[desktop,'desktop'],[mobile,'mobile']])for(const p of context.pages())await p.screenshot({path:path.join(dir,'unread-sync-failure-'+name+'.png')});throw error;}
  finally{await desktop.close();await mobile.close();}
}
