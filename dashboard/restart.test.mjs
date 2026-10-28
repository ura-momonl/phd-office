import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawnSyncToFiles} from './test-spawn.mjs';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {submit,recoverInterruptedWork} from '../agent/run.mjs';
import {update} from '../work/run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('restart API ignores user work, refuses active assistant/unknown work and origin mismatch, gates writes, and unlocks on helper failure',async()=>{
  const saved=read('work/queue.json');let calls=0,reject;
  const server=createServer({restartBackend:()=>{calls++;return new Promise((_,r)=>reject=r);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const post=(route,extra={})=>fetch(origin+route,{method:'POST',headers:{'content-type':'application/json',...extra},body:'{}'});
  try {
    const userTask={id:'user-experiment',status:'active',actor:'user'};
    for(const actor of ['codex','claude',undefined]) {
      write('work/queue.json',{...saved,items:[userTask,{id:'active-restart-fixture',status:'active',actor}]});
      assert.equal((await post('/api/backend/restart')).status,409);assert.equal(calls,0);
    }
    write('work/queue.json',{...saved,items:[userTask]});
    assert.equal((await post('/api/backend/restart',{origin:'http://untrusted.example'})).status,400);assert.equal(calls,0);
    const accepted=await post('/api/backend/restart');assert.equal(accepted.status,202);assert.ok((await accepted.json()).started_at);
    assert.equal((await post('/api/backend/restart')).status,503);assert.equal((await post('/api/chat',{origin})).status,503);assert.equal(calls,1);
    reject(new Error('fixture helper launch failed'));await new Promise(r=>setTimeout(r,20));
    const health=await (await fetch(origin+'/health')).json();assert.equal(health.restart_pending,false);assert.match(health.restart_error,/fixture helper launch failed/);
    assert.deepEqual(read('work/queue.json').items,[userTask],'user work remains active and gated writes never enqueue work');
  }finally{if(reject)reject(new Error('fixture cleanup'));await new Promise(r=>server.close(r));write('work/queue.json',saved);}
});

test('Windows backend recovery and restart; per-conversation tab drafts survive reload/restart, not fresh tabs', {timeout:120000},async()=>{
  if(process.platform!=='win32')return;
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json'),quota:read('.runtime/usage/quota.json',{})};
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin=`http://127.0.0.1:${port}`,backend=path.join(root,'dashboard/Backend.ps1').replaceAll("'","''");
  const powershell=command=>{
    const out=spawnSyncToFiles('powershell.exe',['-NoProfile','-Command',`. '${backend}'; ${command}`],{windowsHide:true,encoding:'utf8',timeout:40000,env:{...process.env,PHD_DASHBOARD_PORT:String(port)}});
    assert.equal(out.status,0,[out.error?.message,out.stdout,out.stderr].filter(Boolean).join('\n'));return out.stdout;
  };
  let browser,page,posts=0;
  const source=path.join(root,'calendar/run.mjs'),bytes=fs.readFileSync(source);
  const downloadStreams=['Restart-Backend.ps1','Backend.ps1'].map(name=>path.join(root,'dashboard',name)+':Zone.Identifier');
  try {
    write('work/queue.json',{...saved.queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
    write('.runtime/usage/quota.json',{codex:{checked_at:new Date().toISOString()}});
    const parent=submit({text:'@Codex interrupted backend fixture'}),follow=submit({session_id:parent.session_id,text:'@Codex merged input fixture'});
    for(const id of [parent.task_id,follow.task_id])update({id,status:'active'},{executionOwner:{pid:2147483647,host:'dashboard'}});
    const q=read('work/queue.json');q.items.find(i=>i.id===follow.task_id).merged_into=parent.task_id;
    const protectedIds=['live-owner','unknown-owner','other-cli','user-experiment'];
    q.items.push({id:protectedIds[0],status:'active',execution_owner:{pid:process.pid,host:'dashboard'}},
      {id:protectedIds[1],status:'active'}, {id:protectedIds[2],status:'active',execution_owner:{pid:2147483647,host:'agent'}},
      {id:protectedIds[3],status:'active',actor:'user'});
    write('work/queue.json',q);
    powershell('[void](Start-DashboardBackend)');
    const health=async()=>await (await fetch(origin+'/health')).json();const first=await health();assert.equal(first.backend_restart,true);
    const recovered=read('work/queue.json');assert.equal(recovered.items.find(i=>i.id===parent.task_id).status,'failed');assert.equal(recovered.items.find(i=>i.id===follow.task_id).status,'failed');
    for(const id of protectedIds)assert.equal(recovered.items.find(i=>i.id===id).status,'active',id+' must not be recovered');
    assert.equal(read('.runtime/agent/sessions.json').sessions[0].messages.filter(m=>m.role==='error').length,1,'one interrupted primary turn, not one error per merged input');
    assert.deepEqual(recoverInterruptedWork(),[],'recovery is idempotent and current/live/unknown executors remain untouched');
    const busy=await fetch(origin+'/api/backend/restart',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(busy.status,409);
    assert.equal((await health()).started_at,first.started_at,'busy POST does not restart');
    for(const id of protectedIds)update({id,status:'failed',reason:'isolated fixture cleanup'});
    const other=submit({text:'@Claude second draft conversation fixture'});update({id:other.task_id,status:'failed',reason:'isolated fixture'});
    browser=await launchEdge();const browserContext=await browser.newContext({viewport:{width:1280,height:800}});page=await browserContext.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/backend/restart')posts++;});
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(origin);await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    assert.equal(await page.locator('#refresh').getAttribute('aria-label'),'重启后端并刷新页面');
    await page.locator('#message').fill('新对话草稿 🌿\n second line ');
    await page.locator('#project-context').selectOption('graphene-thz');
    await page.locator('#image-files').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('draft attachment')});
    await page.locator('.image-preview').waitFor();
    await page.locator(`.session-entry[data-session="${parent.session_id}"]`).click();
    assert.equal(await page.locator('#message').inputValue(),'','opening A does not carry the new-chat draft');
    assert.equal(await page.locator('.image-preview').count(),0);
    await page.locator('#message').fill('A 草稿');await page.locator('[data-mention="@Claude"]').click();
    await page.locator(`.session-entry[data-session="${other.session_id}"]`).click();
    assert.equal(await page.locator('#message').inputValue(),'');await page.locator('#message').fill('B 草稿');
    await page.locator('#new-session').click();
    assert.equal(await page.locator('#message').inputValue(),'新对话草稿 🌿\n second line ');
    assert.equal(await page.locator('#project-context').inputValue(),'graphene-thz');assert.equal(await page.locator('.image-preview').count(),1);
    // Real browser quota failure must warn, allow cancellation, and retain the
    // in-page draft instead of claiming a large attachment will survive reload.
    await page.locator('#image-files').setInputFiles({name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(6*1024*1024,65)});
    await page.locator('#error').filter({hasText:'草稿暂未能保存'}).waitFor();page.once('dialog',d=>d.dismiss());await page.locator('#refresh').click();
    assert.equal(posts,0);assert.equal((await health()).started_at,first.started_at);
    assert.equal(await page.locator('.image-preview').count(),2);
    await page.locator(`.session-entry[data-session="${parent.session_id}"]`).click();
    assert.equal(await page.locator('#message').inputValue(),'A 草稿 @Claude ');
    await page.locator('#new-session').click();assert.equal(await page.locator('.image-preview').count(),2);
    await page.locator('[data-remove-image="1"]').click();assert.equal(await page.locator('.image-preview').count(),1);
    // User experiments do not block refresh, while an active assistant still does.
    const userTask={id:'ui-user-experiment',status:'active',actor:'user'};
    write('work/queue.json',{...read('work/queue.json'),items:[...read('work/queue.json').items,userTask]});
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    write('work/queue.json',{...read('work/queue.json'),items:[...read('work/queue.json').items,{id:'ui-busy-fixture',status:'active',actor:'codex'}]});
    await page.reload();await page.waitForFunction(()=>document.querySelector('#refresh').disabled);
    assert.equal(await page.locator('#message').inputValue(),'新对话草稿 🌿\n second line ');
    assert.equal(await page.locator('.image-preview').count(),1);
    update({id:'ui-busy-fixture',status:'failed',reason:'isolated fixture cleanup'});
    // The reported two R prompts were for the restart entry and its dot-sourced helper.
    // Keep both marked through the actual UI/HTTP/cmd/PowerShell restart below.
    for(const stream of downloadStreams) {
      const zone='[ZoneTransfer]\r\nZoneId=3\r\n';
      fs.writeFileSync(stream,zone);assert.equal(fs.readFileSync(stream,'utf8'),zone);
    }
    fs.appendFileSync(source,'\n// isolated actual restart fixture\n');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='stale'&&!document.querySelector('#refresh').disabled);
    const oldVersion=await page.locator('#code-summary').innerText();
    const navigated=page.waitForNavigation({waitUntil:'load',timeout:45000});
    await page.locator('#refresh').click();await navigated;
    await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='current');
    const second=await health();assert.notEqual(second.started_at,first.started_at);assert.notEqual(second.code.loaded,first.code.loaded);assert.equal(second.code.loaded,second.code.disk);
    assert.deepEqual(read('work/queue.json').items.find(i=>i.id===userTask.id),userTask,'actual HTTP/UI/helper restart preserves the active user experiment');
    assert.notEqual(await page.locator('#code-summary').innerText(),oldVersion);assert.equal(posts,1,'one explicit restart POST, never retried');
    assert.equal(await page.locator('#message').inputValue(),'新对话草稿 🌿\n second line ');
    assert.equal(await page.locator('#project-context').inputValue(),'graphene-thz');assert.equal(await page.locator('.image-preview').count(),1);
    await page.locator(`.session-entry[data-session="${parent.session_id}"]`).click();assert.equal(await page.locator('#message').inputValue(),'A 草稿 @Claude ');
    await page.reload();await page.locator('.message-text').filter({hasText:'interrupted backend fixture'}).waitFor();
    assert.equal(await page.locator('#message').inputValue(),'A 草稿 @Claude ','selected conversation and its draft both survive reload');
    await page.locator(`.session-entry[data-session="${other.session_id}"]`).click();assert.equal(await page.locator('#message').inputValue(),'B 草稿');
    await page.route('**/api/chat',r=>r.fulfill({status:400,json:{error:'fixture rejected submission'}}));
    await page.locator('#send').click();await page.locator('#error').filter({hasText:'fixture rejected submission'}).waitFor();
    await page.reload();await page.locator('#session-title').filter({hasText:'second draft conversation'}).waitFor();
    assert.equal(await page.locator('#message').inputValue(),'B 草稿','a rejected send remains a draft');await page.unroute('**/api/chat');
    await page.locator('#new-session').click();
    const receipt=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat' && r.request().method()==='POST');await page.locator('#send').click();
    const sent=await(await receipt).json();assert.equal(sent.session.messages.at(-1).attachments[0].name,'draft.txt');
    await page.waitForFunction(()=>!document.querySelector('#message').disabled && !document.querySelector('#message').value);
    assert.equal(await page.locator('.image-preview').count(),0);await page.locator('#new-session').click();assert.equal(await page.locator('#message').inputValue(),'','accepted new-chat send clears only its own draft');
    await page.locator(`.session-entry[data-session="${other.session_id}"]`).click();assert.equal(await page.locator('#message').inputValue(),'B 草稿');
    page.once('dialog',d=>d.accept());await page.locator(`[data-session-delete="${other.session_id}"]`).first().click();
    await page.waitForFunction(id=>!sessionStorage.getItem('lab-chat-draft:'+id),other.session_id);
    await page.locator(`.session-entry[data-session="${parent.session_id}"]`).click();assert.equal(await page.locator('#message').inputValue(),'A 草稿 @Claude ','deleting B does not erase A');
    await page.locator('#image-files').setInputFiles({name:'confirmed-loss.txt',mimeType:'text/plain',buffer:Buffer.alloc(6*1024*1024,65)});
    await page.locator('#error').filter({hasText:'草稿暂未能保存'}).waitFor();
    const dialogs=[],acceptLoss=async d=>{dialogs.push({type:d.type(),text:d.message()});await d.accept();};page.on('dialog',acceptLoss);
    const confirmedReload=page.waitForNavigation({waitUntil:'load',timeout:45000});await page.locator('#refresh').click();await confirmedReload;page.off('dialog',acceptLoss);
    await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='current');
    assert.equal(posts,2,'explicit confirmation permits one additional restart');assert.equal(dialogs.length,1,'no second beforeunload prompt after explicit confirmation');
    assert.equal(dialogs[0].type,'confirm');assert.ok(dialogs[0].text.includes('未保存的文字或附件可能丢失'));
    assert.equal(await page.locator('#message').inputValue(),'A 草稿 @Claude ','the last saved text is restored after confirmed loss');
    assert.equal(await page.locator('.image-preview').count(),0,'the user-confirmed unsaved large attachment is not falsely restored');
    const context=page.context();await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));await page.goto(origin);
    await page.locator('.message-text').filter({hasText:'interrupted backend fixture'}).waitFor();
    assert.equal(await page.locator('#message').inputValue(),'','a genuinely fresh tab has no old tab drafts');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(root,'.runtime/restart-ui-desktop.png'),fullPage:true});
    fs.writeFileSync(path.join(root,'.runtime/restart-acceptance.json'),JSON.stringify({first,second,posts,recovered:[parent.task_id,follow.task_id],protected:protectedIds,pageReloaded:true,drafts:{isolated:true,reload:true,restart:true,attachments:true,projectContext:true,quotaCancel:true,quotaConfirm:true,rejectedSend:true,acceptedSendCleared:true,deleteIsolated:true,freshTabEmpty:true},errors},null,2)+'\n');
  } catch(error) {
    const failure={error:String(error.stack || error),posts};
    if(page && !page.isClosed()) {
      failure.ui=await page.evaluate(()=>({error:document.querySelector('#error').textContent,version:document.querySelector('#code-summary').textContent,disabled:document.querySelector('#refresh').disabled,inert:document.querySelector('.shell').inert}));
      await page.screenshot({path:path.join(root,'.runtime/restart-ui-failure.png'),fullPage:true});
    }
    try{failure.health=await(await fetch(origin+'/health',{signal:AbortSignal.timeout(1500)})).json();}catch(e){failure.healthError=e.message;}
    fs.writeFileSync(path.join(root,'.runtime/restart-failure.json'),JSON.stringify(failure,null,2)+'\n');
    throw error;
  } finally {
    if(browser)await browser.close();
    // Release only isolated fixtures; never run this against the actual office.
    const q=read('work/queue.json');for(const i of q.items)if(i.status==='active')i.status='failed';write('work/queue.json',q);
    for(const stream of downloadStreams)if(fs.existsSync(stream))fs.unlinkSync(stream);
    powershell('Stop-DashboardBackend');fs.writeFileSync(source,bytes);
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);write('.runtime/usage/quota.json',saved.quota);
  }
});
