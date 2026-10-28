import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {read,write,root} from '../automation/files.mjs';
import {submit} from '../agent/run.mjs';
import {update} from '../work/run.mjs';
import {createServer} from './server.mjs';
import {splitState} from './ui-state.mjs';
import {sessionBranch} from './workspace.js';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --handoff');

test('handoff projection includes every descendant body and completed task, but not unrelated branches',()=>{
  const session=(id,parent_id)=>({id,title:id,task_ids:[id],messages:[{role:parent_id ? 'handoff' : 'user',text:id,task_id:id,
    ...(parent_id ? {handoff:{session_id:parent_id,task_id:parent_id,provider:'codex'}} : {})}]});
  const sessions=[session('leaf','grand'),session('grand','child'),session('other',''),session('child','parent'),session('parent','')];
  const s={projects:[],inbox:[],usage:{runs:[]},agent:{sessions},work:{items:sessions.map(x=>({id:x.id,status:x.id==='leaf' ? 'active' : 'done'}))}};
  const state=splitState(s,{page:'chat',sessionId:'parent'});
  assert.deepEqual(sessionBranch(state.agent.sessions,'parent').map(x=>x.id),['parent','child','grand','leaf']);
  for(const id of ['parent','child','grand','leaf']) {
    assert.deepEqual(state.agent.sessions.find(x=>x.id===id).messages,sessions.find(x=>x.id===id).messages);
    assert.ok(state.work.items.some(x=>x.id===id),'completed descendant metadata remains available');
  }
  assert.equal(state.agent.sessions.find(x=>x.id==='other').messages,undefined);
  assert.equal(state.work.items.some(x=>x.id==='other'),false);
  const child=splitState(s,{page:'chat',sessionId:'child'});
  assert.equal(child.agent.sessions.find(x=>x.id==='parent').messages,undefined);
  assert.equal(child.agent.sessions.find(x=>x.id==='leaf').messages.length,1);
  assert.equal(splitState(s,{page:'history'}).agent.sessions.some(x=>x.messages),false);
  assert.deepEqual(sessionBranch([{id:'a',parent_id:'b'},{id:'b',parent_id:'a'}],'a').map(x=>x.id),['a','b']);
});

test('nested handoffs propagate running, queued and unread state through real HTTP and Edge',{timeout:60000},async()=>{
  const saved=Object.fromEntries(['work/queue.json','.runtime/agent/sessions.json','agent/config.json'].map(f=>[f,read(f)]));
  let browser,server,page;
  const dir=path.join(root,'.runtime/handoff-tree');fs.mkdirSync(dir,{recursive:true});
  try {
    write('agent/config.json',{...saved['agent/config.json'],enabled:false});
    write('work/queue.json',{...saved['work/queue.json'],items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    const parent=submit({text:'@Codex 整理实验数据',title:'Root handoff fixture'});
    const chain=[parent];
    for(const title of ['Child handoff fixture','Grand handoff fixture','Leaf handoff fixture']) {
      const source=chain.at(-1);
      chain.push(submit({text:'@Codex 接续实验数据',title,handoff:{provider:'codex',task_id:source.task_id}}));
    }
    const other=submit({text:'@Codex 独立事项',title:'Unrelated fixture'});
    for(const job of [parent,chain[1],chain[2],other])update({id:job.task_id,status:'done',handoff:'本轮已交接'});
    const leaf=chain.at(-1);update({id:leaf.task_id,status:'active'});
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    const data=await (await fetch(base+'/api/state?page=chat&session='+parent.session_id)).json();
    assert.equal(data.work.items.find(x=>x.id===leaf.task_id).status,'active');
    assert.equal(data.work.items.find(x=>x.id===parent.task_id).status,'done','own turn completion is not chain completion');
    assert.ok(chain.every(x=>data.agent.sessions.find(s=>s.id===x.session_id).messages));
    browser=await launchEdge();page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.clock.install();
    await page.goto(base+'/#history');
    const recent=page.locator(`#sessions .session-entry[data-session="${parent.session_id}"]`);
    await recent.locator('.session-status').filter({hasText:'正在运行'}).waitFor();
    assert.equal(await page.locator('#sessions .session-entry').count(),2,'no descendant leaks into the recent list');
    await recent.click();
    const card=id=>page.locator(`details[data-child="${id}"]`),label=id=>card(id).locator(':scope > summary .child-state');
    for(const job of chain.slice(1)) {
      await label(job.session_id).filter({hasText:'正在运行'}).waitFor({state:'attached'});
      await card(job.session_id).locator(':scope > summary').click();
    }
    assert.equal(await card(chain[1].session_id).locator(`details[data-child="${chain[2].session_id}"]`).count(),1);
    await page.screenshot({path:path.join(dir,'nested-running.png')});
    const poll=()=>page.clock.fastForward(5000);
    update({id:leaf.task_id,status:'queued'});await poll();
    await recent.locator('.session-status').filter({hasText:'等待执行'}).waitFor();
    await label(chain[1].session_id).filter({hasText:'等待执行'}).waitFor();
    assert.equal(await card(chain[1].session_id).getAttribute('open'),'','explicit expansion survives descendant state changes');
    // Only a final reply in the deepest handoff should light the root's unread dot.
    await page.locator('.chat-tab[data-page="history"]').click();
    update({id:leaf.task_id,status:'done',handoff:'Leaf completed'});
    const store=read('.runtime/agent/sessions.json'),at='2026-10-22T17:00:00Z';
    store.sessions.find(s=>s.id===leaf.session_id).messages.push({role:'assistant',provider:'codex',task_id:leaf.task_id,at,text:'Leaf final answer'});
    write('.runtime/agent/sessions.json',store);await poll();
    await recent.locator('.session-unread-dot').waitFor();
    assert.equal(await recent.locator('.session-status').count(),0,'chain stops running only after the leaf stops');
    await recent.click();await card(leaf.session_id).getByText('Leaf final answer',{exact:true}).waitFor();
    await recent.locator('.session-unread-dot').waitFor({state:'detached'});
    await page.waitForFunction(id=>Number(JSON.parse(localStorage.getItem('lab-agent-read') || '{}')[id])>0,leaf.session_id);
    await page.screenshot({path:path.join(dir,'nested-completed.png')});
    await page.reload();await card(chain[1].session_id).waitFor();
    assert.equal(await recent.locator('.session-status').count(),0);
    await card(chain[1].session_id).locator(':scope > summary').click();
    await card(chain[2].session_id).locator(':scope > summary').click();
    await card(leaf.session_id).locator(':scope > summary').click();
    await card(leaf.session_id).locator(`:scope > .child-body > .child-actions [data-session="${leaf.session_id}"]`).click();
    await page.locator('#session-title').filter({hasText:'Leaf handoff fixture · 子对话'}).waitFor();
    assert.equal(await page.locator('.handoff-tag').count(),1,'independent page keeps source access');
    assert.deepEqual(errors,[]);
  } catch(error) {
    if(page)await page.screenshot({path:path.join(dir,'failure.png')});throw error;
  } finally {
    await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    for(const [file,data] of Object.entries(saved))write(file,data);
  }
});
