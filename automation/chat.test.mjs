import { launchEdge } from './browser-launch.mjs';
// Run only via scripts/run-tests.mjs, in its sanitised copy. No model invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {root,read,write} from './files.mjs';
import {decodeImages,IMAGE_LIMITS} from '../agent/images.mjs';
import {decodeFiles,FILE_LIMITS} from '../agent/files.mjs';
import {submit,sendChat,execute as executeAgent,drain as drainAgent,agentSnapshot,deleteSession,stop} from '../agent/run.mjs';
import {executeWithoutTitle,withoutTitle} from './titleless.mjs';
const execute=executeWithoutTitle(executeAgent),drain=runner=>drainAgent(withoutTitle(runner));
import {createServer} from '../dashboard/server.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg==','base64');
const image=(bytes=png)=>({name:'剪贴板截图.png',data_url:'data:image/png;base64,'+bytes.toString('base64')});
const file=(name='数据.csv',bytes=Buffer.from('field,value\n1,2\n'))=>({name,data_url:'data:application/octet-stream;base64,'+bytes.toString('base64')});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
const workItem=id=>read('work/queue.json').items.find(i=>i.id===id);
const flushDelivery=()=>new Promise(resolve=>setImmediate(resolve));

test('multiple conversation pins persist across devices without changing messages, drafts or history order',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const queue=read('work/queue.json'),original=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    const chats=Array.from({length:24},(_,i)=>({id:'pin-'+i,title:'研究对话 '+i,origin:'chat',project_ids:[],task_ids:i===23 ? ['pin-busy'] : [],created_at:new Date(Date.UTC(2026,9,1+i)).toISOString(),messages:[{role:'user',text:'原文 '+i,at:new Date(Date.UTC(2026,9,1+i)).toISOString()}]}));
    const task={...chats[0],id:'pin-task',origin:'task',task_ids:[]};
    write('work/queue.json',{...queue,items:[{id:'pin-busy',status:'active',actor:'codex',executor:'codex',project_ids:[]}]});
    write('.runtime/agent/sessions.json',{sessions:[...chats,task]});
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.clock.install();
    await page.goto(origin);await page.locator('#sessions .session-entry').first().waitFor();
    const dir=path.join(root,'.runtime/pin-qa');fs.mkdirSync(dir,{recursive:true});
    const row=page.locator('#sessions .session-row').first(),pinButton=row.locator('.session-pin'),deleteButton=row.locator('.session-delete');
    await page.locator('#message').hover();
    assert.equal(await pinButton.isVisible(),false,'pin is hidden until hover or keyboard focus');
    assert.equal(await deleteButton.isVisible(),false);
    await row.hover();
    assert.equal(await pinButton.isVisible(),true);assert.equal(await deleteButton.isVisible(),true);
    const pbox=await pinButton.boundingBox(),dbox=await deleteButton.boundingBox(),rbox=await row.boundingBox();
    assert.equal(pbox.x,dbox.x,'buttons share one right-side column');
    assert.ok(pbox.y+pbox.height<=dbox.y,'pin is above delete, without overlap');
    assert.ok(dbox.y+dbox.height<=rbox.y+rbox.height,'both rows fit inside the conversation');
    await page.screenshot({path:path.join(dir,'pin-hover-stacked.png')});
    await page.locator('#message').hover();
    assert.equal(await pinButton.isVisible(),false);assert.equal(await deleteButton.isVisible(),false);
    await row.locator('.session-entry').focus();
    assert.equal(await pinButton.isVisible(),true,'keyboard focus also exposes the actions');
    await page.locator('#message').focus();
    const ids=()=>page.locator('#sessions [data-session]').evaluateAll(els=>els.map(e=>e.dataset.session));
    const clickPin=async(selector)=>{
      const response=page.waitForResponse(r=>r.url().endsWith('/api/chat/pin') && r.request().method()==='POST');
      await page.locator(selector).locator('xpath=..').hover();
      await page.locator(selector).click();assert.equal((await response).status(),200);
      await page.waitForFunction(()=>!document.querySelector('#page-chat[aria-busy="true"],#page-history[aria-busy="true"]'));
    };
    assert.equal((await ids()).length,20);
    await page.locator('#sessions [data-session="pin-23"]').click();
    await page.locator('#message').fill('保留的草稿');
    await clickPin('#sessions [data-session-pin="pin-23"]');
    await page.locator('#sessions [data-session-pin="pin-23"][aria-pressed="true"]').waitFor({state:'attached'});
    await page.locator('#message').focus();await page.locator('#message').hover();
    assert.equal(await page.locator('#sessions [data-session-pin="pin-23"]').isVisible(),true,'a pinned conversation keeps its pin visible without hover or focus');
    assert.equal(await page.locator('#sessions [data-session-delete="pin-23"]').isVisible(),false,'delete remains hover-only for pinned conversations');
    assert.equal(await page.locator('#sessions [data-session-pin="pin-22"]').isVisible(),false,'unpinned conversations remain hover-only');
    await page.screenshot({path:path.join(dir,'pin-persistent.png')});
    assert.equal(await page.locator('#message').inputValue(),'保留的草稿');
    assert.equal(await page.locator('#sessions [data-session="pin-23"]').getAttribute('class'),'session-entry selected');
    assert.equal(await page.locator('#sessions [data-session-delete="pin-23"]').isDisabled(),true,'pinning also works while work is active');
    await page.locator('#chat-tabs [data-page="history"]').click();
    await page.locator('#history-list [data-session-pin="pin-0"]').waitFor();
    await clickPin('#history-list [data-session-pin="pin-0"]');
    await page.locator('#sessions [data-session-pin="pin-0"][aria-pressed="true"]').waitFor({state:'attached'});
    assert.deepEqual((await ids()).slice(0,3),['pin-23','pin-0','pin-22']);
    assert.equal((await ids()).length,22,'pins do not consume the twenty ordinary recent slots');
    await page.screenshot({path:path.join(dir,'two-pins.png')});
    assert.equal(await page.locator('#history-list [data-session]').first().getAttribute('data-session'),'pin-23','history retains activity order');
    await page.reload();await page.locator('#sessions [data-session-pin="pin-0"][aria-pressed="true"]').waitFor({state:'attached'});
    await page.locator('#message').hover();
    assert.equal(await page.locator('#sessions [data-session-pin="pin-0"]').isVisible(),true,'persistent pin remains visible after reload');
    // A fresh browser/device reads the same server-side pins, not a local-only cache.
    const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const mobile=await phone.newPage();
    await mobile.route('**/*',route=>route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await mobile.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await mobile.goto(origin);
    await mobile.locator('#sessions [data-session-pin="pin-0"][aria-pressed="true"]').waitFor({state:'attached'});
    assert.equal(await mobile.locator('#sessions [aria-pressed="true"]').count(),2);
    await phone.close();
    // More than twenty simultaneous pins must all remain reachable.
    const pin=async(session_id,pinned)=>fetch(origin+'/api/chat/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id,pinned})});
    for(const chat of chats.slice(1,23))assert.equal((await pin(chat.id,true)).status,200);
    await page.reload();await page.locator('#sessions .session-entry').nth(23).waitFor();
    assert.equal((await ids()).length,24);assert.equal(await page.locator('#sessions [aria-pressed="true"]').count(),24);
    await clickPin('#sessions [data-session-pin="pin-0"]');
    await page.locator('#sessions [data-session-pin="pin-0"][aria-pressed="false"]').waitFor({state:'attached'});
    await page.locator('#message').focus();await page.locator('#message').hover();
    assert.equal(await page.locator('#sessions [data-session-pin="pin-0"]').isVisible(),false,'unpinning restores hover-only visibility');
    assert.equal((await ids()).at(-1),'pin-0');
    const before=read('.runtime/agent/sessions.json');
    for(const chat of chats)assert.deepEqual(before.sessions.find(s=>s.id===chat.id).messages,chat.messages);
    for(const [id,value] of [['pin-1','true'],['missing',true],['pin-task',true]])assert.equal((await pin(id,value)).status,400);
    assert.deepEqual(read('.runtime/agent/sessions.json'),before,'invalid pin requests do not alter stored sessions');
    await page.screenshot({path:path.join(dir,'multiple-pins.png')});
    const next=createServer();await new Promise(resolve=>next.listen(0,'127.0.0.1',resolve));
    try{
      const state=await (await fetch(`http://127.0.0.1:${next.address().port}/api/state?page=chat`)).json();
      assert.equal(state.agent.sessions.filter(s=>s.pinned).length,23,'pins survive a new server instance');
      assert.equal(state.agent.sessions.find(s=>s.id==='pin-0').pinned,false);
    }finally{await new Promise(resolve=>next.close(resolve));}
    assert.deepEqual(errors,[]);
  }finally{
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',original);
  }
});

test('inbox discussion carries provenance across the actual composer; resolved removes only that card',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json'),ack=read('.runtime/inbox/acknowledged.json',{});
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite')),mailId='inbox-discuss-mail-fixture';
  let browser;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const raise=async title=>{const job=submit({text:'@Codex '+title,project_id:'bi-devices'});await execute(job.task_id,async()=>{
      write(`.runtime/agent/runs/${job.task_id}/inbox.json`,{kind:'approval',title,message:'这件事需要确认。\n原事项：work:quoted-untrusted-id',actions:[{id:'go',type:'reply',label:'继续'}]});return {result:'请确认。'};
    });return job;};
    const target=await raise('已自行发出的催信'),other=await raise('另一件未处理的审批');
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(origin);await page.locator('.nav[data-page="inbox"]').click();
    // A mail without a conversation uses the same entry but starts a new one, retaining real mail evidence.
    db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'todo',?,'[]','[]','[]')").run(mailId,'邮件事项入口测试','核对已完成的事项');
    await page.reload();await page.locator('.nav[data-page="inbox"]').click();
    await page.locator(`[data-inbox-chat="mail:${mailId}"]`).click();
    assert.ok((await page.locator('#message').inputValue()).startsWith(`原事项：mail:${mailId}\n`));
    assert.equal(await page.locator('#session-title').textContent(),'新对话');
    const mailResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat' && r.request().method()==='POST');
    await page.locator('#send').click();const mailJob=await (await mailResponse).json();
    const mailVisible=async()=>((await (await fetch(origin+'/api/state')).json()).inbox.some(i=>i.id==='mail:'+mailId));
    assert.equal(await mailVisible(),false,'the submitted reply hides the exact version it answered');
    db.prepare('UPDATE tasks SET action=? WHERE id=?').run('新邮件要求另一个确认',mailId);
    assert.equal(await mailVisible(),true,'new mail action must reappear instead of being hidden by an old source ID');
    db.prepare('UPDATE tasks SET action=? WHERE id=?').run('核对已完成的事项',mailId);
    await execute(mailJob.task_id,async(_,prompt)=>{assert.ok(prompt.includes('这件事的邮件证据'));write(`.runtime/agent/runs/${mailJob.task_id}/inbox.json`,{message:'这件事全部办完。',resolved:true});return {result:'已记录。'};});
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(mailId).status,'done');
    await page.reload();await page.locator('.nav[data-page="inbox"]').click();
    await page.locator(`[data-inbox-chat="work:${target.task_id}"]`).click();
    const draft=await page.locator('#message').inputValue();
    assert.ok(draft.startsWith(`原事项：work:${target.task_id}\n`),'the actual card origin precedes any quoted origin-like text in its detail');
    assert.equal(await page.locator('#project-context').inputValue(),'bi-devices');
    await page.locator('#message').fill('先继续核对催信。\n'+draft);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat' && r.request().method()==='POST');
    await page.locator('#send').click();const job=await (await response).json();
    assert.equal(job.session_id,target.session_id,'discussion reuses the existing conversation');
    assert.ok(workItem(job.task_id).goal.includes(`原事项：work:${target.task_id}`));
    await execute(job.task_id,async(_,prompt)=>{
      assert.ok(prompt.includes(`这条对话来自收件箱卡片（原事项：work:${target.task_id}）`));
      write(`.runtime/agent/runs/${job.task_id}/inbox.json`,{kind:'approval',title:'催信的最新问题',message:'请确认是否已自行发送。',actions:[{id:'go',type:'reply',label:'继续'}]});return {result:'请确认。'};
    });
    await page.reload();await page.locator('.nav[data-page="inbox"]').click();
    await page.locator(`[data-inbox-chat="work:${other.task_id}"]`).waitFor(); // absence is vacuous until the inbox has rendered
    await page.waitForFunction(id=>!document.querySelector(`[data-inbox-chat="work:${id}"]`),target.task_id);
    assert.equal(workItem(target.task_id).review.state,'pending','superseded display does not silently complete the original question');
    await page.locator(`[data-inbox-chat="work:${job.task_id}"]`).click();
    assert.ok((await page.locator('#message').inputValue()).startsWith(`原事项：work:${job.task_id}\n`));
    await page.locator('#message').fill('催信已自行发出，整件事办完了。\n'+await page.locator('#message').inputValue());
    const followResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat' && r.request().method()==='POST');
    await page.locator('#send').click();const follow=await (await followResponse).json();
    await execute(follow.task_id,async()=>{write(`.runtime/agent/runs/${follow.task_id}/inbox.json`,{kind:'approval',message:'用户自行完成，撤掉过期审批；不发送邮件。',resolved:true});return {result:'已撤掉过期审批。'};});
    await page.reload();await page.locator('.nav[data-page="inbox"]').click();
    await page.locator(`[data-inbox-chat="work:${other.task_id}"]`).waitFor();
    await page.waitForFunction(id=>!document.querySelector(`[data-inbox-chat="work:${id}"]`),job.task_id);
    assert.equal(await page.locator(`[data-inbox-chat="work:${other.task_id}"]`).count(),1);
    assert.equal(workItem(target.task_id).review.state,'accepted');assert.equal(workItem(job.task_id).review.state,'accepted');assert.equal(workItem(other.task_id).review.state,'pending');
    assert.deepEqual(errors,[]);
    const dir=path.join(root,'.runtime/inbox-qa');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'after-resolved.png')});
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    db.prepare('DELETE FROM tasks WHERE id=?').run(mailId);db.close();
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);write('.runtime/inbox/acknowledged.json',ack);
  }
});

test('PIRI Office branding is discreet and fits the sidebar on desktop and mobile',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await launchEdge();
    const page=await browser.newPage();
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.title(),'PIRI Office');
    assert.equal((await page.locator('.brand > span:last-child').innerText()).split('\n')[0],'PIRI Office');
    assert.equal((await page.locator('.brand small').innerText()).replace(/\s+/g,' '),'Research Support & Workflow Automation');
    assert.doesNotMatch(await page.content(),/Principal Investigator Replacement/i);
    for(const width of [1440,375]) {
      await page.setViewportSize({width,height:900});
      const fits=await page.locator('.brand').evaluate(el=>{
        const sidebar=el.closest('.sidebar').getBoundingClientRect(),brand=el.getBoundingClientRect();
        return brand.right<=sidebar.right && el.scrollWidth<=el.clientWidth
          && [...el.querySelectorAll('span,small')].every(n=>n.scrollWidth<=n.clientWidth);
      });
      assert.equal(fits,true,`branding must fit at ${width}px`);
    }
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
});

test('the right rail shows each speaker\'s context length for the open conversation only',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const job=submit({text:'@Claude context display'}),other=submit({text:'@Claude other conversation'});
    const stored=read('.runtime/agent/sessions.json');
    stored.sessions.find(s=>s.id===job.session_id).context={claude:{tokens:40265,window:1000000,at:'2026-10-19T22:00:00Z',parts:[{key:'fixed',label:'固定开销（系统提示、工具与技能定义）',tokens:28000},{key:'user',label:'用户消息',tokens:5000},{key:'read',label:'读文件',tokens:7265}]},codex:{tokens:210000,window:258400,at:'2026-10-19T22:01:00Z'}};
    write('.runtime/agent/sessions.json',stored);
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.addInitScript(id=>localStorage.setItem('lab-session',id),job.session_id);
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const rows=page.locator('#context-usage .quota-mini');
    await rows.first().waitFor();
    assert.equal(await rows.count(),2);
    assert.match(await rows.nth(0).textContent(),/Claude.*40k \/ 1M · 4%/s);
    assert.match(await rows.nth(1).textContent(),/Codex.*210k \/ 258k · 81%/s);
    assert.equal(await rows.nth(1).locator('.meter i').getAttribute('class'),'crit');
    assert.equal(await rows.nth(0).locator('.ctx-bar .ctx-seg').count(),3);
    const widths=await rows.nth(0).locator('.ctx-seg').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().width));
    assert.ok(widths[0]>widths[2] && widths[2]>widths[1],'segments are sized by tokens: '+widths);
    const bar=await rows.nth(0).locator('.ctx-bar').evaluate(el=>el.getBoundingClientRect().width);
    assert.equal(await rows.nth(0).locator('.meter').count(),1,'one bar per assistant');
    assert.ok(Math.abs(widths.reduce((x,y)=>x+y,0)/bar-40265/1000000)<0.01,'the coloured part is the used share of the window: '+widths.reduce((x,y)=>x+y,0)/bar);
    const legend=page.locator('#context-usage .ctx-legend');
    assert.equal(await page.locator('#context-usage .ctx-legend').count(),1,'one legend for everyone');
    assert.deepEqual(await legend.locator('li').allTextContents(),['固定开销28k','用户消息5k','读文件7k']);
    assert.equal(await rows.nth(1).locator('.ctx-bar').count(),0,'no breakdown: the plain bar stays');
    // both assistants with a breakdown share the one legend, a column each
    const both=read('.runtime/agent/sessions.json');
    both.sessions.find(s=>s.id===job.session_id).context.codex.parts=[{key:'fixed',label:'固定开销（系统提示、工具与技能定义）',tokens:9000},{key:'user',label:'用户消息',tokens:20000},{key:'output',label:'工具输出',tokens:181000}];
    write('.runtime/agent/sessions.json',both);await page.reload();
    await page.locator('#context-usage .ctx-legend-head').waitFor();
    assert.equal(await page.locator('#context-usage .ctx-legend').count(),1);
    assert.deepEqual(await legend.locator('li').allTextContents(),['ClaudeCodex','固定开销28k9k','用户消息5k20k','读文件7k—','工具输出—181k']);
    assert.equal(await page.locator('#context-usage .ctx-bar').count(),2,'one bar per assistant');
    assert.equal(await page.locator('#quick-quota').count(),0);
    await page.locator('#sessions [data-session="'+other.session_id+'"]').click();
    await page.locator('#context-usage .empty-small').waitFor();
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
  }
});

test('the running badge follows the live speaker through handoffs, not the initial executor',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const gates=Array.from({length:3},deferred),entered=Array.from({length:3},deferred);
  let browser,running,turn=0;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const job=submit({text:'@Claude badge handoff regression'});
    browser=await launchEdge();
    const page=await browser.newPage();
    await page.addInitScript(id=>{
      localStorage.setItem('lab-session',id);
      const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===5000 ? 100 : ms,...args);
    },job.session_id);
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const badge=page.locator('.task-running span');
    await page.waitForFunction(()=>document.querySelector('.task-running span')?.textContent==='Claude · 等待执行');
    const recentStatus=page.locator(`#sessions [data-session="${job.session_id}"] .session-status`);
    assert.equal(await recentStatus.textContent(),'等待执行');
    assert.equal(await page.locator(`#sessions [data-session-delete="${job.session_id}"]`).isDisabled(),true);
    running=execute(job.task_id,async(provider)=>{
      const i=turn++;entered[i].resolve(provider);await gates[i].promise;
      return {result:i===0 ? 'first reply\n@Codex continue' : i===1 ? 'second reply\n@Claude continue' : 'finished'};
    });
    for(const [i,provider] of ['claude','codex','claude'].entries()) {
      assert.equal(await entered[i].promise,provider);
      assert.equal(workItem(job.task_id).executor,'claude','original routing must not be overwritten for display');
      assert.equal(workItem(job.task_id).status,'active');
      const state=await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
      assert.deepEqual(state.agent.active_turns,[{task_id:job.task_id,provider}]);
      await page.waitForFunction(name=>document.querySelector('.task-running span')?.textContent===name+' · 进行中',provider==='codex' ? 'Codex' : 'Claude');
      assert.equal(await badge.textContent(),(provider==='codex' ? 'Codex' : 'Claude')+' · 进行中');
      assert.equal(await recentStatus.textContent(),(provider==='codex' ? 'Codex' : 'Claude')+' · 正在运行');
      gates[i].resolve();
    }
    await running;
    assert.deepEqual(agentSnapshot().active_turns,[]);
    await page.waitForFunction(()=>!document.querySelector('.task-running'));
    assert.equal(await recentStatus.count(),0,'completed sessions no longer claim to be running');
    assert.equal(await page.locator(`#sessions [data-session-delete="${job.session_id}"]`).isDisabled(),false);
  } finally {
    gates.forEach(g=>g.resolve());await running;
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
  }
});

test('a message queued behind a running turn says so, and a queued "@A @B" shows the whole order',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const gate=deferred(),entered=deferred();
  let browser,running;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const first=submit({text:'@Claude running turn'});
    running=execute(first.task_id,async()=>{entered.resolve();await gate.promise;return {result:'done'};});
    await entered.promise;
    const waiting=await sendChat({session_id:first.session_id,text:'@Codex @Claude waits for the turn'});
    assert.equal(waiting.delivery,'queued');
    browser=await launchEdge();
    const page=await browser.newPage();
    await page.addInitScript(id=>localStorage.setItem('lab-session',id),first.session_id);
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const meta=id=>page.locator(`.message.user[data-task="${id}"] .message-meta`);
    await meta(waiting.task_id).filter({hasText:'排队中，等当前轮结束'}).waitFor();
    assert.equal(await meta(first.task_id).filter({hasText:'排队中'}).count(),0);
    await page.locator('.task-running span').filter({hasText:'Codex → Claude · 等待执行'}).waitFor();
  } finally {
    gate.resolve();await running;
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
  }
});

test('history deletion confirms, retains work, protects busy sessions; quota timestamps describe the displayed window reset',async t=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json'),quota=read('.runtime/usage/quota.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const done=submit({text:'@Codex completed conversation for deletion'});
    await execute(done.task_id,async()=>({result:'fixture completed'}));
    const busy=submit({text:'@Claude queued conversation must be retained'});
    const checked='2026-10-07T14:21:00.000Z',claudeChecked='2026-10-07T14:23:00.000Z';
    const codexReset='2026-10-14T18:30:00.000Z',claudeReset='2026-10-07T23:00:00.000Z';
    const limits={rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:Date.parse('2026-10-07T18:00:00Z')/1000},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:Date.parse(codexReset)/1000}}};
    write('.runtime/usage/quota.json',{codex:{checked_at:checked,attempted_at:'2026-10-07T15:30:00.000Z',error:'fixture failed attempt',limits},claude:{checked_at:claudeChecked,windows:[{label:'5 小时窗口',remaining_percent:80,resets_at:'2026-10-07T18:30:00Z'},{label:'7 天窗口',remaining_percent:61,resets_at:claudeReset},{label:'过期窗口',remaining_percent:0,resets_at:'2026-10-06T23:00:00Z'}]}});
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-10-07T15:00:00Z');const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===5000 ? 100 : ms,...args);});
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(origin);await page.locator('#sessions .session-entry').first().waitFor();
    const history=async()=>{await page.locator('#chat-tabs [data-page="history"]').click();await page.locator('#page-history[aria-busy="false"]').waitFor();};
    const row=id=>page.locator('.history-row').filter({has:page.locator(`[data-session="${id}"]`)});
    await t.test('the paperclip and send arrow are centered SVG icons with accessible buttons',async()=>{
      for(const selector of ['#send','#attach-image']) {
        const button=page.locator(selector),icon=button.locator('svg');
        assert.equal(await icon.count(),1);assert.ok(await button.getAttribute('aria-label'));
        const b=await button.boundingBox(),i=await icon.boundingBox();
        assert.ok(Math.abs(b.x+b.width/2-i.x-i.width/2)<1,`${selector} horizontal centering: ${JSON.stringify({b,i})}`);
        assert.ok(Math.abs(b.y+b.height/2-i.y-i.height/2)<1,`${selector} vertical centering: ${JSON.stringify({b,i})}`);
      }
      assert.equal(await page.locator('#send').textContent(),'');
      const dir=path.join(root,'.runtime/chat-polish-qa');fs.mkdirSync(dir,{recursive:true});
      await page.screenshot({path:path.join(dir,'chat-desktop.png')});
    });
    await t.test('quota and each window reset (Chicago) are shown only in the top bar, not in the right rail',async()=>{
      const strip=page.locator('#quota-strip'),times=strip.locator('time');
      assert.equal(await page.locator('#quick-quota').count(),0);
      assert.doesNotMatch(await page.locator('#chat-context').textContent(),/额度剩余|重置/);
      assert.equal(await times.nth(0).getAttribute('datetime'),codexReset);
      assert.equal(await times.nth(1).getAttribute('datetime'),claudeReset);
      assert.match(await times.nth(0).textContent(),/10\/14 13:30.*Chicago/);
      assert.match(await times.nth(1).textContent(),/10\/7 18:00.*Chicago/);
      assert.match(await strip.locator('.header-quota').nth(0).textContent(),/7 天窗口.*40%.*重置/s);
      assert.match(await strip.locator('.header-quota').nth(1).textContent(),/7 天窗口.*61%.*重置/s);
      assert.doesNotMatch(await strip.textContent(),/刷新时间/);
      limits.rateLimits.secondary.resetsAt=Date.parse('2026-10-15T18:30:00Z')/1000;
      write('.runtime/usage/quota.json',{codex:{checked_at:checked,limits},claude:{checked_at:claudeChecked,windows:[]}});
      await page.waitForFunction(()=>document.querySelector('#quota-strip time')?.getAttribute('datetime')==='2026-10-15T18:30:00.000Z');
      limits.rateLimits.secondary.resetsAt=null;
      write('.runtime/usage/quota.json',{codex:{checked_at:checked,limits},claude:{checked_at:claudeChecked,windows:[{label:'5 小时窗口',remaining_percent:80}]}});
      await page.waitForFunction(()=>document.querySelector('#quota-strip')?.textContent.includes('重置时间：未记录'));
      assert.equal(await times.count(),0,'a missing reset is not inferred from the reading time or another window');
    });
    await t.test('busy deletion is disabled and the server rejects direct attempts without removing the conversation',async()=>{
      await history();assert.equal(await row(busy.session_id).locator('.history-delete').isDisabled(),true);
      const response=await fetch(origin+'/api/chat/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:busy.session_id})});
      assert.equal(response.ok,false);assert.match((await response.json()).error,/排队或运行/);
      assert.ok(agentSnapshot().sessions.some(s=>s.id===busy.session_id));
    });
    await t.test('cancel leaves everything intact; confirming deletes only the selected conversation and survives reload',async()=>{
      const button=row(done.session_id).locator('.history-delete');
      page.once('dialog',dialog=>dialog.dismiss());await button.click();
      assert.ok(agentSnapshot().sessions.some(s=>s.id===done.session_id));
      assert.equal(await page.locator('#page-history').isVisible(),true,'delete must not open the conversation');
      page.once('dialog',dialog=>dialog.accept());await button.click();
      await page.waitForFunction(id=>!document.querySelector(`#history-list [data-session="${id}"]`),done.session_id);
      assert.equal(agentSnapshot().sessions.some(s=>s.id===done.session_id),false);
      assert.equal(workItem(done.task_id).status,'done','project work records must remain');
      assert.ok(agentSnapshot().sessions.some(s=>s.id===busy.session_id));
      assert.equal(await page.locator('#history-list .history-entry').count(),1);
      assert.equal(await page.locator('#page-history').isVisible(),true);
      await page.reload();await history();assert.equal(await page.locator('#history-list .history-entry').count(),1);
      await row(busy.session_id).locator('.history-entry').click();
      stop(busy.task_id);
      await history();await page.waitForFunction(()=>!document.querySelector('.history-delete')?.disabled);
      page.once('dialog',dialog=>dialog.accept());await row(busy.session_id).locator('.history-delete').click();
      await page.locator('#page-chat').waitFor();
      assert.equal(await page.locator('#session-title').textContent(),'新对话');
      assert.equal(await page.evaluate(()=>localStorage.getItem('lab-session')),'');
      assert.equal(workItem(busy.task_id).status,'cancelled');
      assert.deepEqual(errors,[]);
    });
  }finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
    if(quota)write('.runtime/usage/quota.json',quota);else fs.rmSync(path.join(root,'.runtime/usage/quota.json'),{force:true});
  }
});

test('history finds conversations beyond the recent list, restores attachments and continues the same saved conversation',async t=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in the sanitised copy, without models');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser,old,stored;
  try {
    write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    old=submit({text:'@Claude 仅在很早正文的关键词',title:'最早的研究讨论 <img onerror=alert(1)>',project_id:'bi-devices',images:[image()],files:[file('earliest-raw.csv')]});
    await execute(old.task_id,async()=>({result:'早期结果，需要继续分析。',sessionId:'fake'}));
    const saved=agentSnapshot().sessions.find(s=>s.id===old.session_id);
    stored=saved.messages[0].attachments;
    saved.created_at='2026-09-01T15:00:00Z';saved.messages.forEach(m=>m.at=saved.created_at);
    const filler=Array.from({length:35},(_,i)=>({id:`history-${i}`,title:`对话 ${i}`,project_ids:['graphene-thz'],created_at:`2026-10-05T15:${String(i).padStart(2,'0')}:00Z`,task_ids:[],messages:[{role:'user',text:`问题 ${i}`,at:`2026-10-05T15:${String(i).padStart(2,'0')}:00Z`}]}));
    // Created long ago, but spoken in recently: must precede newly created conversations.
    const resumed={id:'resumed-fixture',title:'旧对话最近又聊了',project_ids:[],created_at:'2026-08-01T15:00:00Z',task_ids:[],messages:[{role:'user',text:'最近更新',at:'2026-10-06T15:00:00Z'}]};
    const automated={id:'auto-fixture',title:'自动卡片检查',project_ids:['bi-devices'],created_at:'2026-10-06T15:01:00Z',origin:'task',task_ids:[],messages:[{role:'user',text:'自动检查',at:'2026-10-06T15:01:00Z',inbox_reply:{action_id:'agent-check'}}]};
    write('.runtime/agent/sessions.json',{sessions:[saved,...filler,resumed,automated]});
    const untouched=JSON.stringify([...filler,resumed,automated]);
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}
      if(route.request().url().endsWith('/api/usage/refresh'))return route.fulfill({json:{}});
      return route.continue();
    });
    await page.goto(origin);await page.locator('#sessions .session-entry').first().waitFor();
    const list=page.locator('#history-list .history-entry');
    const history=async()=>{await page.locator('#chat-tabs [data-page="history"]').click();await page.locator('#page-history[aria-busy="false"]').waitFor();};
    // The history search asks the server (debounced); the list is marked busy from the keystroke until the answer is drawn.
    const find=async q=>{await page.locator('#history-search').fill(q);await page.locator('#history-list:not([aria-busy="true"])').waitFor();};
    await t.test('history is inside the conversation module and switching preserves the current draft',async()=>{
      assert.equal(await page.locator('.sidebar .nav[data-page="history"]').count(),0);
      assert.equal(await page.locator('#chat-tabs').isVisible(),true);
      await page.locator('#message').fill('尚未发送的研究草稿');
      await history();
      assert.equal(await page.locator('.sidebar .nav.active').getAttribute('data-page'),'chat');
      assert.equal(await page.locator('#chat-tabs [aria-current="page"]').textContent(),'历史对话');
      await page.locator('#chat-tabs [data-page="chat"]').click();
      assert.equal(await page.locator('#page-chat').isVisible(),true);
      assert.equal(await page.locator('#message').inputValue(),'尚未发送的研究草稿');
      await page.locator('.nav[data-page="inbox"]').click();
      assert.equal(await page.locator('#chat-tabs').isVisible(),false);
      await page.locator('.nav[data-page="chat"]').click();
      assert.equal(await page.locator('#chat-tabs').isVisible(),true);
      await page.locator('#message').fill('');
    });
    await t.test('all saved conversations are reachable and ordered by last activity, not creation order',async()=>{
      assert.equal(await page.locator('#sessions .session-entry').count(),20);
      assert.equal(await page.locator('#sessions .session-entry').first().getAttribute('data-session'),resumed.id);
      assert.equal(await page.locator(`#sessions [data-session="${old.session_id}"]`).count(),0);
      await history();assert.equal(await list.count(),30);
      assert.equal(await list.first().getAttribute('data-session'),resumed.id);
      await page.locator('#history-more').click();assert.equal(await list.count(),37);
      assert.equal(await list.last().getAttribute('data-session'),old.session_id);
      assert.equal(await page.locator('#history-list img').count(),0,'titles are plain text, not executable markup');
    });
    await t.test('title, body and attachment search, project filtering, empty states and automatic conversations',async()=>{
      for(const query of ['最早的研究讨论','仅在很早正文的关键词','EARLIEST-RAW.CSV']) {
        await find(query);assert.equal(await list.count(),1);
        assert.equal(await list.first().getAttribute('data-chat-open'),old.session_id,'a hit opens its conversation at the matching turn');
      }
      await page.locator('#history-project').selectOption('graphene-thz');assert.equal(await list.count(),0);
      assert.match(await page.locator('#history-list').textContent(),/没有找到对话/);
      await page.locator('#history-project').selectOption('bi-devices');assert.equal(await list.count(),1);
      await page.locator('#history-project').selectOption('');await find('自动卡片');
      assert.equal(await list.count(),0);await find('');
      // Task sessions have their own tab and never appear in history or the recent list, even after the user speaks in one.
      assert.equal(await page.locator('#history-automated').count(),0);
      assert.equal(await page.locator('#sessions [data-session="auto-fixture"]').count(),0);
      await page.locator('#chat-tabs [data-page="tasks"]').click();
      assert.equal(await page.locator('#tasks-list .history-entry').count(),1);
      assert.equal(await page.locator('#tasks-list .history-entry').first().getAttribute('data-session'),automated.id);
      await page.locator('#tasks-search').fill('不存在');await page.locator('#tasks-list[aria-busy="false"]').waitFor();assert.equal(await page.locator('#tasks-list .history-entry').count(),0);
      await page.locator('#tasks-search').fill('');
      await page.locator('#tasks-list .history-entry').first().click();
      assert.equal(await page.locator('#page-chat').isVisible(),true);assert.match(await page.locator('#session-title').textContent(),/任务会话/);
      await history();
      await page.locator('#history-project').selectOption('__shared__');assert.equal(await list.count(),1);
      assert.equal(await list.first().getAttribute('data-session'),resumed.id);
      await page.locator('#history-project').selectOption('');
    });
    await t.test('the history entrance and list work on desktop and mobile without horizontal overflow',async()=>{
      const dir=path.join(root,'.runtime/history-qa');fs.mkdirSync(dir,{recursive:true});
      for(const width of [1440,1024,390]) {
        await page.setViewportSize({width,height:1000});
        await page.locator('#chat-tabs [data-page="chat"]').click();
        const chatSidebar=await page.locator('.sidebar').boundingBox();
        const chatHeader=await page.locator('.topbar').boundingBox();
        for(const destination of ['inbox','projects','weekly','more']) {
          await page.locator(`.nav[data-page="${destination}"]`).click();
          const sidebar=await page.locator('.sidebar').boundingBox();
          assert.equal(sidebar.width,chatSidebar.width,`sidebar width must match ${destination}`);
          assert.equal(sidebar.x,chatSidebar.x);
        }
        await page.locator('.nav[data-page="chat"]').click();
        await page.screenshot({path:path.join(dir,`chat-${width}.png`)});
        await history();
        assert.equal(await page.locator('#page-history').isVisible(),true);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
        await page.screenshot({path:path.join(dir,`history-${width}.png`)});
        assert.deepEqual(await page.locator('.sidebar').boundingBox(),chatSidebar,'switching conversation tabs must not move or resize the dark sidebar');
        assert.deepEqual(await page.locator('.topbar').boundingBox(),chatHeader,'conversation tabs must retain their header alignment');
        await page.locator('#chat-tabs [data-page="chat"]').click();
        assert.equal(await page.locator('#page-chat').isVisible(),true);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
        await page.screenshot({path:path.join(dir,`chat-${width}.png`)});
      }
      await page.setViewportSize({width:1440,height:1000});
    });
    await t.test('the magnifier beside the recent list opens the history search, which finds by words or a loose sentence and opens the hit at the matching turn',async()=>{
      const note=page.locator('#history-count');
      await page.locator('#chat-tabs [data-page="chat"]').click();
      await page.locator('#open-search').click();
      assert.equal(await page.locator('#page-history').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'history-search');
      await find('仅在很早正文的关键词');
      assert.equal(await list.count(),1);assert.equal(await list.first().getAttribute('data-chat-open'),old.session_id);
      assert.match(await note.textContent(),/找到 1 条/);assert.match(await list.first().textContent(),/仅在很早正文的关键词/);
      assert.equal(await page.locator('#history-list img').count(),0,'titles and snippets stay plain text');
      // Not every word is in one conversation: the closest candidates are listed, marked as approximate.
      await find('很早正文的关键词 研究 xyzqw');
      assert.match(await note.textContent(),/近似/);assert.equal(await list.first().getAttribute('data-chat-open'),old.session_id);
      assert.match(await list.first().textContent(),/近似度 \d+%/);
      await find('qqzzxx');assert.equal(await list.count(),0);assert.match(await page.locator('#history-list').textContent(),/没有找到对话/);
      await find('很早正文的关键词 研究 xyzqw');
      await list.first().click();
      assert.equal(await page.locator('#page-chat').isVisible(),true);
      assert.match(await page.locator('#session-title').textContent(),/最早的研究讨论/);
      assert.match(await page.locator('#transcript').textContent(),/仅在很早正文的关键词/);
      assert.equal(await page.evaluate(()=>localStorage.getItem('lab-session')),old.session_id);
      await history();await find('');
    });
    await t.test('opening old messages and reloading retains the original files, images and conversation identity',async()=>{
      await history();await find('earliest-raw.csv');await list.first().click();
      await page.locator('.message-text').filter({hasText:'仅在很早正文的关键词'}).waitFor();
      assert.equal(await page.locator('#page-chat').isVisible(),true);
      assert.match(await page.locator('#transcript').textContent(),/仅在很早正文的关键词/);
      assert.equal(await page.locator('.message-file strong').textContent(),'earliest-raw.csv');
      const download=await fetch(origin+await page.locator('.message-file').getAttribute('href'));
      assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from('field,value\n1,2\n'));
      assert.equal(await page.locator('.message-images img').count(),1);
      await page.reload();await page.locator('.message-file').waitFor();
      assert.match(await page.locator('#transcript').textContent(),/早期结果/);
      assert.equal(await page.locator('#project-context').inputValue(),'bi-devices');
      const response=page.waitForResponse(r=>r.url()===origin+'/api/chat' && r.request().method()==='POST');
      await page.locator('#message').fill('继续这份早期结果');await page.locator('#send').click();
      const job=await (await response).json();assert.equal(job.session_id,old.session_id);assert.equal(job.provider,'claude');
      await page.locator('#transcript').getByText('继续这份早期结果',{exact:true}).waitFor();
      await execute(job.task_id,async(who,prompt)=>{
        assert.equal(who,'claude');assert.match(prompt,/仅在很早正文的关键词/);assert.match(prompt,/早期结果/);assert.match(prompt,/earliest-raw\.csv/);
        return {result:'已接续同一对话。',sessionId:'fake'};
      });
      assert.deepEqual(agentSnapshot().sessions.find(s=>s.id===old.session_id).messages[0].attachments,stored);
      assert.equal(JSON.stringify(agentSnapshot().sessions.filter(s=>s.id!==old.session_id)),untouched,'other conversations remain unchanged');
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    });
  }finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
    for(const a of stored || [])fs.rmSync(path.join(root,a.path),{force:true});
  }
});

test('a new conversation runs while an older one is held; same-session jobs stay ordered and stop is isolated',async()=>{
  const config=read('agent/config.json'),queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  assert.equal(config.enabled,false,'must run in the isolated copy');
  write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...config,enabled:true});
  const runs=[],holds=[];
  try {
    for(const provider of ['codex','claude']) {
      const old=submit({text:`@${provider} older held conversation`}),entered=deferred(),release=deferred();holds.push(release);
      const started=[],inputs=[];
      const runner=async(who,prompt,opts)=>{
        const id=path.basename(opts.directory);started.push(id);assert.equal(who,provider);
        opts.onReady(async text=>inputs.push({id,text}));
        if(id===old.task_id) {entered.resolve();await release.promise;}
        return {result:`finished ${id}`,sessionId:id};
      };
      runs.push(drain(runner));await entered.promise;
      const ordered=submit({session_id:old.session_id,text:`@${provider} independent next turn`,model:'separate-turn'});
      const fresh=await sendChat({text:`@${provider} new independent conversation`});
      runs.push(drain(runner));runs.push(drain(runner));
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(workItem(old.task_id).status,'active','old conversation is genuinely still running');
      assert.equal(workItem(fresh.task_id).status,'done','new conversation finishes without releasing old one');
      assert.equal(workItem(ordered.task_id).status,'queued');
      assert.deepEqual(started,[old.task_id,fresh.task_id],'repeated drains do not duplicate tasks');
      // Even direct execution cannot overwrite the old session's active input transport.
      runs.push(execute(ordered.task_id,runner));
      await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(started,[old.task_id,fresh.task_id],'one active task per conversation');
      const follow=await sendChat({session_id:old.session_id,text:'old-only follow-up'});
      assert.equal(follow.delivery,'pending');await flushDelivery();assert.equal(workItem(follow.task_id).merged_into,old.task_id);assert.deepEqual(inputs,[{id:old.task_id,text:'old-only follow-up'}]);
      release.resolve();await Promise.all(runs);
      assert.equal(workItem(ordered.task_id).status,'done');
      assert.deepEqual(started,[old.task_id,fresh.task_id,ordered.task_id]);
      for(const job of [old,fresh,ordered,follow])assert.equal(workItem(job.task_id).status,'done');
    }

    const a=submit({text:'@Codex stop only this session'}),b=submit({text:'@Claude keep this session running'});
    const gate=deferred(),stopReady=deferred();holds.push(gate);
    const runner=async(who,prompt,opts)=>{
      opts.onReady(async()=>{});
      if(path.basename(opts.directory)===a.task_id) {await new Promise(resolve=>{opts.signal.addEventListener('abort',resolve,{once:true});stopReady.resolve();});throw new Error('stopped');}
      if(who==='codex')return {result:'next turn finished',sessionId:'next'};
      await gate.promise;assert.equal(opts.signal.aborted,false);return {result:'other conversation finished',sessionId:'other'};
    };
    const stopping=drain(runner);runs.push(stopping);
    assert.equal(workItem(a.task_id).status,'active');assert.equal(workItem(b.task_id).status,'active');
    const next=submit({session_id:a.session_id,text:'run after stop',model:'separate-turn'});
    await stopReady.promise;stop(a.task_id);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(workItem(a.task_id).status,'cancelled');assert.equal(workItem(b.task_id).status,'active');
    assert.equal(workItem(next.task_id).status,'done','stopped session continues its queued work');
    gate.resolve();await stopping;assert.equal(workItem(b.task_id).status,'done');
  } finally {
    holds.forEach(h=>h.resolve());
    for(const item of read('work/queue.json').items)if(item.status==='active')stop(item.id);
    await Promise.allSettled(runs);
    write('agent/config.json',config);write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
  }
});

test('HTTP new-session submission crosses the real queue drain while another session is active',async()=>{
  const config=read('agent/config.json');assert.equal(config.enabled,false);
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`,release=deferred();let running,pump;
  try {
    const post=body=>fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':url},body:JSON.stringify(body)}).then(r=>r.json());
    assert.equal((await (await fetch(url+'/health')).json()).chat_parallel_sessions,true);
    const old=await post({text:'@Codex held via HTTP'});
    running=execute(old.task_id,async(who,prompt,opts)=>{opts.onReady(async()=>{});await release.promise;return {result:'old done'};});
    const fresh=await post({text:'@Codex fresh via HTTP'});
    // HTTP is real; only the native model boundary is substituted, without paid calls.
    write('agent/config.json',{...config,enabled:true});
    pump=drain(async(who,prompt)=>{assert.equal(who,'codex');assert.match(prompt,/fresh via HTTP/);assert.doesNotMatch(prompt,/held via HTTP/);return {result:'fresh done'};});
    await pump;
    const state=await (await fetch(url+'/api/state')).json();
    assert.equal(state.work.items.find(i=>i.id===old.task_id).status,'active');
    assert.equal(state.work.items.find(i=>i.id===fresh.task_id).status,'done');
    assert.ok(state.agent.sessions.find(s=>s.id===fresh.session_id).messages.some(m=>m.role==='assistant' && m.text==='fresh done'));
  } finally {
    release.resolve();await Promise.allSettled([running,pump]);
    write('agent/config.json',config);await new Promise(resolve=>server.close(resolve));
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
  }
});

test('HTTP follow-ups reach the active native input before its result, in order, including images; no second run',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const provider of ['codex','claude']) {
      const first=submit({text:`@${provider} original`});
      const ready=deferred(),finish=deferred(),received=[];
      const running=execute(first.task_id,async(who,prompt,opts)=>{
        assert.equal(who,provider);
        opts.onReady(async text=>{received.push(text);});ready.resolve();
        await finish.promise;return {result:'已处理原消息及追加消息',sessionId:'same-native-thread'};
      });
      await ready.promise;
      const post=body=>fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':url},body:JSON.stringify(body)}).then(r=>r.json());
      const [second,third]=await Promise.all([
        post({session_id:first.session_id,text:'second',images:[image()],files:[file()]}),
        post({session_id:first.session_id,text:'third'})
      ]);
      assert.equal(second.delivery,'pending');assert.equal(third.delivery,'pending');await flushDelivery();
      assert.equal(workItem(first.task_id).status,'active','input arrived before original result');
      assert.deepEqual(received.map(t=>t.split('\n')[0]),['second','third']);
      assert.match(received[0],/图片读取工具/);
      const stored=agentSnapshot().sessions.find(s=>s.id===first.session_id).messages.find(m=>m.task_id===second.task_id).attachments[0];
      assert.ok(received[0].includes(JSON.stringify(path.join(root,stored.path))));
      const doc=agentSnapshot().sessions.find(s=>s.id===first.session_id).messages.find(m=>m.task_id===second.task_id).attachments[1];
      assert.equal(doc.kind,'file');assert.ok(received[0].includes(JSON.stringify(path.join(root,doc.path))));
      assert.deepEqual(fs.readFileSync(path.join(root,doc.path)),Buffer.from('field,value\n1,2\n'));
      assert.equal(second.provider,provider,'unaddressed input follows active speaker, not last finished speaker');
      assert.equal(workItem(second.task_id).merged_into,first.task_id);
      finish.resolve();await running;
      let duplicates=0;
      for(const job of [second,third])await execute(job.task_id,async()=>{duplicates++;});
      assert.equal(duplicates,0);
      for(const job of [first,second,third])assert.equal(workItem(job.task_id).status,'done');
    }
  }finally {await new Promise(resolve=>server.close(resolve));}
});

test('file batches validate before saving; filenames cannot choose storage and rejected batches create no tasks',()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const count=()=>read('work/queue.json').items.length;
  const storedCount=()=>['files','images'].reduce((n,d)=>{const dir=path.join(root,'.runtime/agent',d);return n+(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);},0);
  const filesBefore=storedCount();
  const before=count();
  assert.throws(()=>submit({text:'bad',images:[image()],files:[file(),{data_url:'data:text/plain;base64,!!!!'}]}),/文件数据无效/);
  assert.equal(count(),before);
  assert.equal(storedCount(),filesBefore);
  assert.throws(()=>decodeFiles(Array.from({length:FILE_LIMITS.count+1},()=>file())),/最多 10/);
  assert.throws(()=>decodeFiles([file('too-large.pdf',Buffer.alloc(FILE_LIMITS.each+1))]),/20 MB/);
  assert.throws(()=>decodeFiles([file('a',Buffer.alloc(16*1024*1024)),file('b',Buffer.alloc(16*1024*1024))]),/30 MB/);
  assert.throws(()=>decodeFiles([{name:'bad',data_url:'data:text/plain;base64,AB=='}]),/文件数据无效/);
  assert.equal(decodeFiles([file('empty.txt',Buffer.alloc(0))])[0].size,0);
  const decoded=decodeFiles([file('../../科研数据.CSV')])[0];
  assert.equal(decoded.name,'科研数据.CSV');assert.match(decoded.path,/^\.runtime\/agent\/files\/[\da-f-]+\.csv$/);
});

test('composer sends a whole burst before the next native acknowledgment, for both work providers',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'isolated copy only; no paid model runs');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  const releases=[],runs=[];
  try {
    browser=await launchEdge();const page=await browser.newPage();
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.addInitScript(()=>{const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===5000 ? 100 : ms,...args);});
    for(const provider of ['claude','codex']) {
      const first=submit({text:`@${provider} burst original`}),ready=deferred(),finish=deferred(),received=[],acks=[];
      releases.push(finish);
      const running=execute(first.task_id,async(who,prompt,opts)=>{
        assert.equal(who,provider);
        opts.onReady(text=>{received.push(text);const ack=deferred();acks.push(ack);releases.push(ack);return ack.promise;});
        ready.resolve();await finish.promise;return {result:'whole burst handled',sessionId:'same-native-turn'};
      });runs.push(running);await ready.promise;
      await page.goto(origin);await page.evaluate(id=>localStorage.setItem('lab-session',id),first.session_id);await page.reload();
      const jobs=[];
      for(const text of ['burst one','burst two','burst three']) {
        await page.waitForFunction(()=>!document.querySelector('#message').disabled && !document.querySelector('#send').disabled);
        await page.locator('#message').fill(text);
        const response=page.waitForResponse(r=>r.url()===origin+'/api/chat' && r.request().method()==='POST');
        await page.locator('#send').click();const job=await (await response).json();jobs.push(job);
        assert.equal(job.delivery,'pending','HTTP confirms saved input without waiting for native replay');
      }
      await page.waitForFunction(()=>!document.querySelector('#message').disabled);
      assert.deepEqual(received,['burst one','burst two','burst three'],'all inputs must reach native transport before any ack');
      for(const job of jobs) {
        assert.equal(workItem(job.task_id).status,'queued');assert.equal(workItem(job.task_id).merged_into,undefined);
        assert.equal(await page.locator(`article[data-task="${job.task_id}"] .message-meta`).count(),1);
        assert.doesNotMatch(await page.locator(`article[data-task="${job.task_id}"] .message-meta`).textContent(),/已送入当前轮/);
        await page.locator(`article[data-task="${job.task_id}"] .message-meta`).filter({hasText:'正在提交原生输入'}).waitFor();
        assert.doesNotMatch(await page.locator(`article[data-task="${job.task_id}"] .message-meta`).textContent(),/排队中/);
      }
      // One boundary consumes everything already submitted, rather than unblocking only the next write.
      for(const ack of acks)ack.resolve();await flushDelivery();
      for(const job of jobs)assert.equal(workItem(job.task_id).merged_into,first.task_id);
      await page.waitForFunction(ids=>ids.every(id=>document.querySelector(`article[data-task="${id}"] .message-meta`)?.textContent.includes('已送入当前轮')),jobs.map(j=>j.task_id));
      finish.resolve();await running;
      let extraRuns=0;for(const job of jobs){assert.equal(workItem(job.task_id).status,'done');await execute(job.task_id,async()=>{extraRuns++;});}
      assert.equal(extraRuns,0,'no second model job for accepted burst messages');
    }
  } finally {
    for(const gate of releases)gate.resolve();await Promise.allSettled(runs);
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});

test('burst acknowledgments are independent: rejection keeps only that input queued and run completion waits for all',async()=>{
  const first=submit({text:'@Claude delayed mixed burst'}),ready=deferred(),finish=deferred(),received=[],acks=[];
  const running=execute(first.task_id,async(_,prompt,opts)=>{
    opts.onReady(text=>new Promise((resolve,reject)=>{received.push(text);acks.push({resolve,reject});}));
    ready.resolve();await finish.promise;return {result:'accepted inputs handled'};
  });
  try {
    await ready.promise;
    const jobs=[];for(const text of ['accept first','reject middle','accept last'])jobs.push(await sendChat({session_id:first.session_id,text}));
    assert.deepEqual(received,['accept first','reject middle','accept last']);
    acks[2].resolve();acks[1].reject(new Error('native rejected middle'));await flushDelivery();
    assert.equal(workItem(jobs[0].task_id).merged_into,undefined);
    assert.equal(workItem(jobs[1].task_id).status,'queued');assert.equal(workItem(jobs[1].task_id).merged_into,undefined);
    assert.equal(workItem(jobs[2].task_id).merged_into,first.task_id);
    finish.resolve();await flushDelivery();assert.equal(workItem(first.task_id).status,'active','bookkeeping waits for outstanding ack');
    acks[0].resolve();await running;
    for(const job of [jobs[0],jobs[2]])assert.equal(workItem(job.task_id).status,'done');
    assert.equal(workItem(jobs[1].task_id).status,'queued');
  } finally {for(const ack of acks)ack.resolve();finish.resolve();await running;}
});

test('real chat UI supports chooser, drag/drop, removal, file-only send, persistence, download and readable AI context',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'must run in the isolated copy');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;let browser;
  try {
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.goto(origin);await page.locator('#attach-image:not([disabled])').waitFor();
    const chooserWait=page.waitForEvent('filechooser');await page.locator('#attach-image').click();
    const chooser=await chooserWait;
    await chooser.setFiles([
      {name:'实验记录.txt',mimeType:'text/plain',buffer:Buffer.from('THz sample A: 42\n')},
      {name:'移除这个.csv',mimeType:'text/csv',buffer:Buffer.from('x,y\n1,2\n')}
    ]);
    await page.waitForFunction(()=>document.querySelectorAll('.image-preview').length===2);
    await page.getByRole('button',{name:'移除 移除这个.csv',exact:true}).click();
    // Real browser File/DataTransfer events exercise the same handler as OS drag/drop.
    await page.evaluate(()=>{
      const dt=new DataTransfer();dt.items.add(new File(['%PDF-1.4\nresearch fixture\n%%EOF'],'论文.pdf',{type:'application/pdf'}));
      dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],'截图.png',{type:'image/png'}));
      const area=document.querySelector('.conversation');
      area.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));
      area.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    });
    await page.waitForFunction(()=>document.querySelectorAll('.file-preview-card').length===2 && !document.querySelector('#send').disabled);
    assert.equal(await page.locator('.file-drag-over').count(),0);
    assert.equal(await page.locator('#image-files').getAttribute('accept'),null);
    assert.equal(await page.locator('#message').inputValue(),'');
    const sent=page.waitForResponse(r=>r.url()===origin+'/api/chat' && r.request().method()==='POST');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    const response=await sent;assert.equal(response.status(),200);const job=await response.json();
    await page.locator('.message-file').first().waitFor();
    assert.equal(await page.locator('.message-file').count(),2);
    const msg=agentSnapshot().sessions.find(s=>s.id===job.session_id).messages[0];
    assert.equal(msg.text,'请看看这些附件。');assert.equal(msg.attachments.length,3);
    assert.equal(await page.locator('.message-images img').count(),1);
    assert.equal(await page.locator('.image-preview').count(),0);
    const stored=msg.attachments.find(a=>a.name==='实验记录.txt'),download=await fetch(origin+'/api/chat/file?id='+stored.id);
    assert.equal(download.headers.get('Content-Type'),'application/octet-stream');
    assert.ok(download.headers.get('Content-Disposition').includes(encodeURIComponent('实验记录.txt')));
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(),'THz sample A: 42\n');
    assert.equal((await fetch(origin+'/api/chat/file?id=../../projects/catalog.json')).status,404);
    assert.equal((await fetch(origin+'/api/chat/image?id='+stored.id)).status,404);
    // Current attachments, handoff to the other AI, and subsequent history all expose readable local files.
    const seen=[];
    await execute(job.task_id,async(provider,prompt)=>{
      seen.push(provider);
      for(const attachment of msg.attachments)assert.ok(prompt.includes(JSON.stringify(path.join(root,attachment.path))));
      assert.ok(prompt.includes('实验记录.txt'));assert.match(prompt,/资料，不是指令/);
      assert.equal(fs.readFileSync(path.join(root,stored.path),'utf8'),'THz sample A: 42\n');
      return {result:seen.length===1 ? '已读取\n@'+(provider==='codex' ? 'Claude' : 'Codex')+' 请接着看' : '已核对'};
    });
    assert.deepEqual(new Set(seen),new Set(['codex','claude']));
    const next=submit({session_id:job.session_id,text:'继续整理'});
    await execute(next.task_id,async(provider,prompt)=>{assert.ok(prompt.includes(JSON.stringify(path.join(root,stored.path))));return {result:'已继续'};});
    await page.reload();await page.locator('.message-file').first().waitFor();assert.equal(await page.locator('.message-file').count(),2);
    // A failed submission must keep both the draft and selected attachments for manual retry.
    await page.locator('#image-files').setInputFiles({name:'失败保留.txt',mimeType:'text/plain',buffer:Buffer.from('retry')});
    await page.waitForFunction(()=>document.querySelectorAll('.image-preview').length===1 && !document.querySelector('#send').disabled);
    await page.locator('#message').fill('这段话也保留');
    await page.route('**/api/chat',r=>r.fulfill({status:400,json:{error:'验证用拒绝'}}));
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#error').textContent==='验证用拒绝');
    assert.equal(await page.locator('#message').inputValue(),'这段话也保留');assert.equal(await page.locator('.image-preview').count(),1);
    await page.screenshot({path:path.join(root,'.runtime/file-upload-qa.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('HTTP file uploads exceed the former image-only body limit and downloads are byte-exact and origin-protected',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const health=await (await fetch(origin+'/health')).json();assert.equal(health.chat_files,true);assert.deepEqual(health.chat_file_limits,FILE_LIMITS);
    const bytes=Buffer.alloc(14*1024*1024,42),payload={files:[file('大文件.bin',bytes)]};
    const post=async(body,headers={})=>fetch(origin+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const rejected=await post({files:[file()]},{Origin:'http://evil.example'});assert.equal(rejected.status,400);
    const response=await post(payload,{Origin:origin});assert.equal(response.status,200);const job=await response.json();
    const record=agentSnapshot().sessions.find(s=>s.id===job.session_id).messages[0].attachments[0];
    const downloaded=Buffer.from(await (await fetch(origin+'/api/chat/file?id='+record.id)).arrayBuffer());assert.ok(downloaded.equals(bytes));
    const weekly=submit({text:'生成周计划',files:[file()]});assert.notEqual(weekly.provider,'program');
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('startup messages write as soon as transport exists; native options are forwarded without workbench timing gates',async()=>{
  const first=submit({text:'@Claude original'}),entered=deferred(),ready=deferred(),finish=deferred(),seen=[];
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    entered.resolve();await ready.promise;opts.onReady(async (text,options)=>{seen.push(text);if(options.model)throw new Error('native config needs a new invocation');});
    await finish.promise;return {result:'好的',sessionId:'fake'};
  });
  await entered.promise;
  const early=sendChat({session_id:first.session_id,text:'early'});
  const cases=[{session_id:first.session_id,text:'@Codex other'}, {session_id:first.session_id,text:'@all both'},
    {text:'another session'}];
  for(const request of cases)assert.equal((await sendChat(request)).delivery,'queued');
  assert.equal((await early).delivery,'pending');assert.deepEqual(seen,[]);
  const override=await sendChat({session_id:first.session_id,text:'different model',model:'explicit'});
  assert.equal(override.delivery,'pending');
  ready.resolve();await flushDelivery();assert.equal(workItem((await early).task_id).merged_into,first.task_id);assert.deepEqual(seen,['early','different model']);
  assert.equal(workItem(override.task_id).status,'queued','only the native rejection keeps it queued');
  finish.resolve();await running;
});

test('"@A @B" sent while A speaks reaches A live; the AIs named after her get one queued turn, and a rejected delivery creates none',async()=>{
  const first=submit({text:'@Claude original'}),ready=deferred(),finish=deferred(),seen=[];let reject=false;
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    opts.onReady(async text=>{if(reject)throw new Error('no active turn');seen.push(text);});ready.resolve();
    await finish.promise;return {result:'好的',sessionId:'fake'};
  });
  await ready.promise;
  const sent=await sendChat({session_id:first.session_id,text:'@Claude @Codex @DeepSeek 一起看'});
  assert.equal(sent.delivery,'pending');await flushDelivery();
  assert.equal(workItem(sent.task_id).merged_into,first.task_id);assert.deepEqual(seen,['@Claude @Codex @DeepSeek 一起看']);
  const queuedIn=()=>agentSnapshot().sessions.find(s=>s.id===first.session_id).task_ids.map(workItem).filter(i=>i.status==='queued');
  assert.deepEqual(queuedIn().map(i=>[i.executor,i.speakers,i.goal]),[['codex',['codex','deepseek'],'@Claude @Codex @DeepSeek 一起看']]);
  assert.equal(queuedIn()[0].request_task_id,sent.task_id,'later speakers retain the exact acknowledged user-message source');
  reject=true;
  const refused=await sendChat({session_id:first.session_id,text:'@Claude @Codex 再看'});await flushDelivery();
  assert.equal(workItem(refused.task_id).status,'queued');assert.equal(queuedIn().length,2,'only the refused message itself stays queued');
  finish.resolve();await running;
});

test('rejected input is not replayed with a later message; stopping delivered input only stops its native owner',async()=>{
  const first=submit({text:'@Codex original'}),ready=deferred();let inputs=0;
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    opts.onReady(async()=>{if(++inputs===1)throw new Error('no active turn');});ready.resolve();
    await new Promise(resolve=>opts.signal.addEventListener('abort',resolve,{once:true}));throw new Error('stopped');
  });
  await ready.promise;
  const rejected=await sendChat({session_id:first.session_id,text:'keep this'});
  assert.equal(rejected.delivery,'pending');await flushDelivery();assert.equal(workItem(rejected.task_id).status,'queued');assert.equal(workItem(rejected.task_id).merged_into,undefined);
  const accepted=await sendChat({session_id:first.session_id,text:'stop with owner'});
  assert.equal(accepted.delivery,'pending');await flushDelivery();assert.equal(workItem(accepted.task_id).merged_into,first.task_id);stop(accepted.task_id);await running;
  assert.equal(workItem(first.task_id).status,'cancelled');assert.equal(workItem(accepted.task_id).status,'cancelled');
  assert.equal(inputs,2);assert.equal(workItem(rejected.task_id).status,'queued');assert.equal(workItem(rejected.task_id).merged_into,undefined);
  const later=await sendChat({session_id:first.session_id,text:'after completion'});assert.equal(later.delivery,'queued');
});

test('cancelling an input while the native turn starts does not send or resurrect it',async()=>{
  const first=submit({text:'@Codex original'}),entered=deferred(),ready=deferred(),finish=deferred();let inputs=0;
  const running=execute(first.task_id,async(provider,prompt,opts)=>{
    entered.resolve();await ready.promise;opts.onReady(async()=>{inputs++;});
    await finish.promise;return {result:'original only',sessionId:'fake'};
  });
  await entered.promise;
  const pending=sendChat({session_id:first.session_id,text:'cancel me'});
  const second=agentSnapshot().sessions.find(s=>s.id===first.session_id).messages.at(-1).task_id;
  stop(second);ready.resolve();await pending;
  assert.equal(inputs,0);assert.equal(workItem(second).status,'cancelled');
  finish.resolve();await running;assert.equal(workItem(second).status,'cancelled');
});

test('chat images validate bytes, count and size before creating any work; paths never come from the client',()=>{
  const [decoded]=decodeImages([{...image(),path:'C:/private/file.png',id:'forged'}]);
  assert.match(decoded.path,/^\.runtime\/agent\/images\/[\w-]+\.png$/);assert.notEqual(decoded.id,'forged');
  assert.deepEqual(decoded.bytes,png);
  assert.throws(()=>decodeImages(Array(5).fill(image())),/4 张/);
  assert.throws(()=>decodeImages([{data_url:'data:image/svg+xml;base64,PHN2Zy8+'}]),/格式无效/);
  assert.throws(()=>decodeImages([image(Buffer.from('not an image'))]),/内容与格式不符/);
  assert.throws(()=>decodeImages([image(Buffer.concat([png,Buffer.alloc(IMAGE_LIMITS.each)]))]),/6 MB/);
  const large=Buffer.concat([png,Buffer.alloc(5*1024*1024)]);
  assert.throws(()=>decodeImages([image(large),image(large),image(large)]),/12 MB/);
  const before=read('work/queue.json').items.length;
  assert.throws(()=>submit({text:'bad image',images:[image(Buffer.from('bad'))]}),/内容与格式/);
  assert.equal(read('work/queue.json').items.length,before);
  assert.throws(()=>submit({text:'',images:[]}),/请输入/);
});

test('image-only messages, both AI recipients and later follow-ups retain readable image evidence',async()=>{
  const jobs=[],files=[];
  const imagePaths=prompt=>{
    const records=prompt.split('\n').filter(line=>line.startsWith('{"role":')).map(line=>JSON.parse(line));
    const evidence=[prompt,...records.filter(record=>record.attachments).map(record=>record.attachments)].join('\n');
    return evidence.split('\n').filter(line=>line.startsWith('{"name":')).map(line=>JSON.parse(line).file);
  };
  try {
    const first=submit({text:'@all 看这张图片',images:[image()]});jobs.push(first);
    const stored=agentSnapshot().sessions.find(s=>s.id===first.session_id).messages[0].attachments[0];files.push(stored.path);
    assert.deepEqual(fs.readFileSync(path.join(root,stored.path)),png);assert.equal(stored.data_url,undefined);
    const seen=[];
    await execute(first.task_id,async(provider,prompt)=>{
      seen.push(provider);assert.ok(imagePaths(prompt).includes(path.join(root,stored.path)));assert.match(prompt,/图片读取工具/);
      return {result:'已查看',sessionId:'fake'};
    });
    assert.equal(workItem(first.task_id).status,'done',workItem(first.task_id).handoff);
    assert.deepEqual(seen,['codex','claude','deepseek']);
    const next=submit({session_id:first.session_id,text:'',images:[image()]});jobs.push(next);
    const latest=agentSnapshot().sessions.find(s=>s.id===first.session_id).messages.at(-1);files.push(latest.attachments[0].path);
    assert.equal(next.provider,'deepseek');assert.equal(latest.text,'请看看这些图片。');
    await execute(next.task_id,async(provider,prompt)=>{assert.ok(imagePaths(prompt).includes(path.join(root,stored.path)));assert.ok(imagePaths(prompt).includes(path.join(root,latest.attachments[0].path)));return {result:'好',sessionId:'fake'};});
    deleteSession(first.session_id);assert.ok(read('work/queue.json').items.some(i=>i.id===first.task_id));
    const weekly=submit({text:'生成周计划',images:[image()]});jobs.push(weekly);
    files.push(agentSnapshot().sessions.find(s=>s.id===weekly.session_id).messages[0].attachments[0].path);
    assert.notEqual(weekly.provider,'program');
  }finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!jobs.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!jobs.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
    files.forEach(f=>fs.rmSync(path.join(root,f),{force:true}));
  }
});

test('HTTP chat accepts clipboard-sized payloads and serves only recorded image IDs',async()=>{
  const config=read('agent/config.json');assert.equal(config.enabled,false,'must run in the isolated copy');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;let job,stored;
  try {
    assert.equal((await (await fetch(url+'/health')).json()).chat_images,true);
    const bytes=Buffer.concat([png,Buffer.alloc(24000)]);
    const response=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':url},body:JSON.stringify({text:'看看截图的布局',images:[image(bytes)]})});
    assert.equal(response.status,200);job=await response.json();
    stored=agentSnapshot().sessions.find(s=>s.id===job.session_id).messages[0].attachments[0];
    const picture=await fetch(url+'/api/chat/image?id='+stored.id);assert.equal(picture.headers.get('Content-Type'),'image/png');
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()),bytes);
    assert.equal((await fetch(url+'/api/chat/image?id=../../projects/catalog.json')).status,404);
    const rejected=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':'http://evil.example'},body:JSON.stringify({text:'bad',images:[image()]})});assert.equal(rejected.status,400);
    const noOrigin=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'impersonating the user'})});
    assert.equal(noOrigin.status,403,'a script without the interface Origin cannot post as the user');assert.match((await noOrigin.json()).error,/agent handoff/);
  }finally {
    await new Promise(resolve=>server.close(resolve));
    if(job){const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==job.task_id);write('work/queue.json',q);const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==job.session_id);write('.runtime/agent/sessions.json',s);}
    if(stored)fs.rmSync(path.join(root,stored.path),{force:true});
  }
});


test('inbox options and quiet links stay in one column on desktop and mobile',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only via sanitised test runner');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;let browser;
  try{
    browser=await launchEdge();
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base);await page.locator('.nav[data-page="inbox"]').click();
    const fixture=await page.evaluate(async()=>{
      const {inboxView}=await import('/workspace.js');
      const item={id:'mail-single-column-fixture',source:'mail',source_id:'fixture',kind:'decision',actor:'user',priority:'normal',title:'虚构事项：选择一个下一步',detail:'仅用于验证收件箱按钮排版，不发送邮件、不运行 agent。',actions:[
        {id:'first',type:'reply',label:'按此方案继续'},
        {id:'second',type:'reply',label:'先核对实验条件与原始数据再决定下一步'},
        {id:'third',type:'reply',label:'暂时搁置'},
        {id:'fourth',type:'reply',label:'需要补充信息'}
      ]};
      return inboxView({inbox:[item],usage:{runs:[]},work:{items:[]},mail:{pending:0},projects:[]},'');
    });
    for(const width of [1440,1050,800,390]){
      await page.setViewportSize({width,height:1100});
      // Reinstall the deterministic fixture in case the dashboard's normal refresh ran.
      await page.locator('#inbox-list').evaluate((el,html)=>{el.innerHTML=html;},fixture.groups);
      const buttons=page.locator('#inbox-list .decision-actions button');assert.equal(await buttons.count(),5);
      const boxes=await buttons.evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,overflow:el.scrollWidth>el.clientWidth};}));
      for(let i=0;i<boxes.length;i++){
        assert.ok(Math.abs(boxes[i].x-boxes[0].x)<1,'same left edge at '+width);
        assert.ok(Math.abs(boxes[i].width-boxes[0].width)<1,'same width at '+width);
        assert.equal(boxes[i].overflow,false,'button text fits at '+width);
        if(i)assert.ok(boxes[i].y>=boxes[i-1].y+boxes[i-1].height,'buttons do not share a row at '+width);
      }
      assert.equal(await page.locator('#page-inbox').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      assert.equal(await buttons.nth(0).getAttribute('data-action-id'),'first');
      // The title already opens the basis, so no separate review button repeats it.
      assert.equal(await page.locator('#inbox-list .decision-actions [data-review]').count(),0);
      assert.equal(await page.locator('#inbox-list .title-link').getAttribute('data-review'),'mail-single-column-fixture');
      assert.equal(await buttons.nth(4).getAttribute('data-inbox-chat'),'mail-single-column-fixture');
      if(process.env.PHD_TEST_ARTIFACTS && [1440,390].includes(width)){
        fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'inbox-one-column-'+width+'.png'),fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('composer grows upward with a cap, appends mentions, and sends only with Shift+Enter or send button',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only via sanitised test runner');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;let browser;
  try{
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],posts=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.route('**/api/chat',route=>{posts.push(route.request().postDataJSON());return route.fulfill({json:{session_id:'composer-fixture'}});});
    await page.goto(base);const input=page.locator('#message');await input.waitFor();
    await input.fill('short');const small=await input.boundingBox(),bottom=(await page.locator('#composer').boundingBox());
    await input.fill('line one\nline two\nline three\nline four\nline five');const grown=await input.boundingBox(),now=await page.locator('#composer').boundingBox();
    assert.ok(grown.height>small.height);assert.ok(now.y<bottom.y);assert.ok(Math.abs(now.y+now.height-bottom.y-bottom.height)<2,'bottom stays fixed, grows upward');
    await input.fill(Array.from({length:40},(_,i)=>'Long draft line '+i).join('\n'));
    assert.equal(await input.evaluate(el=>el.scrollHeight>el.clientHeight && el.clientHeight<=180 && getComputedStyle(el).overflowY==='auto'),true);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#composer').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await input.evaluate(el=>el.clientHeight<=180 && el.scrollHeight>el.clientHeight),true);
    if(process.env.PHD_TEST_ARTIFACTS){fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'composer-mobile.png')});}
    await input.fill('保留正文');assert.ok((await input.boundingBox()).height<grown.height);
    await input.press('Home');await page.locator('[data-mention="@Codex"]').click();await page.locator('[data-mention="@Claude"]').click();
    assert.equal(await input.inputValue(),'保留正文 @Codex @Claude ');
    assert.equal(await input.evaluate(el=>el.selectionStart===el.value.length && el.selectionEnd===el.value.length),true);
    await input.press('Enter');assert.equal(await input.inputValue(),'保留正文 @Codex @Claude \n');assert.equal(posts.length,0);
    await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,isComposing:true,bubbles:true,cancelable:true})));assert.equal(posts.length,0,'IME confirmation cannot send');
    await input.press('Shift+Enter');await page.waitForFunction(()=>document.querySelector('#message').value==='');
    assert.equal(posts.length,1);assert.equal(posts[0].text,'保留正文 @Codex @Claude');
    assert.equal(await input.evaluate(el=>el.clientHeight),44,'successful send shrinks input back');
    await input.fill('button send');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#message').value==='');assert.equal(posts.length,2);
    assert.equal(await page.locator('.paste-hint').count(),0,'composer has no permanent shortcut hint');
    assert.deepEqual(errors,[]);assert.deepEqual(read('work/queue.json'),queue);assert.deepEqual(read('.runtime/agent/sessions.json'),sessions);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('inbox cards reach their conversation: handed-off card and re-issued card both link into it',async()=>{
  const {inboxView,sessionOf}=await import('../dashboard/workspace.js');
  const session={id:'card-session',title:'让 agent 处理 · 核对认证',origin:'task',project_ids:[],task_ids:['job-1'],messages:[{role:'user',text:'x',at:'2026-10-08T10:00:00Z',inbox_reply:{id:'mail:m1',fingerprint:'old',action_id:'agent-check'}}]};
  const state=(inbox,status)=>({inbox,usage:{runs:[]},mail:{pending:0},projects:[],work:{items:[{id:'job-1',status}]},agent:{sessions:[session]}});
  const card=(id,extra={})=>({id,source:'mail',source_id:id.slice(5),kind:'decision',priority:'normal',title:'t',detail:'d',actions:[{id:'agent-check',type:'reply',label:'让 agent 处理'}],...extra});
  // Handed off and still running: the card is out of the inbox, but its row leads into the conversation.
  const running=inboxView(state([],'active'),'').groups;
  assert.match(running,/正在处理[\s\S]*data-session="card-session"/);
  // Once finished and not re-issued, no stale row.
  assert.doesNotMatch(inboxView(state([],'done'),'').groups,/card-session/);
  // Re-issued card opens the same conversation and no longer offers a fresh chat.
  const reissued=inboxView(state([card('mail:m1')],'done'),'').groups;
  assert.match(reissued,/data-inbox-chat="mail:m1"/);assert.match(reissued,/进入对话/);
  assert.equal(sessionOf(state([card('mail:m1')],'done'),card('mail:m1')).id,session.id);
  // A card with no conversation still starts one.
  const fresh=inboxView(state([card('mail:other')],'done'),'').groups;
  assert.match(fresh,/data-inbox-chat/);assert.doesNotMatch(fresh,/data-session=/);
  assert.equal(sessionOf(state([card('mail:other')],'done'),card('mail:other')),undefined);
});
