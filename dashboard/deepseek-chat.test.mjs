import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {submit,execute,agentSnapshot} from '../agent/run.mjs';
import {deepseekStream} from '../agent/deepseek.mjs';
import {rootId,fishIds,fishStart,fishEnd} from '../agent/fixtures/deepseek-fish.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('real chat UI renders DeepSeek identity, original avatar, context and a working mention button',async()=>{
  const at=new Date().toISOString(),id='deepseek-ui';
  write('work/queue.json',{...read('work/queue.json'),items:[{id,actor:'deepseek',executor:'deepseek',kind:'framework',title:'DeepSeek UI',status:'done',project_ids:[],outputs:[],dependencies:[],created_at:at,completed_at:at}]});
  write('.runtime/agent/sessions.json',{sessions:[{id,title:'DeepSeek 正式同事',origin:'chat',project_ids:[],task_ids:[id],created_at:at,
    context:{deepseek:{tokens:12345,at}},messages:[{role:'user',text:'@DeepSeek 你好',at,task_id:id},{role:'assistant',provider:'deepseek',text:'中文回复：我来上班啦。',at,task_id:id}]}]});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    const png=await fetch(base+'/avatars/deepseek.png');assert.equal(png.status,200);
    assert.equal(png.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await png.arrayBuffer()),fs.readFileSync(path.join(root,'dashboard/avatars/deepseek.png')));
    browser=await launchEdge({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
    await page.goto(base);await page.locator('.session-entry[data-session="'+id+'"]').click();
    const reply=page.locator('.message.assistant.deepseek');await reply.waitFor();
    assert.equal(await reply.locator('.message-meta strong').textContent(),'DeepSeek');
    assert.match(await reply.innerText(),/我来上班啦/);
    assert.equal(await reply.locator('img.who').getAttribute('src'),'/avatars/deepseek.png');
    assert.equal(await reply.locator('img.who').evaluate(el=>el.complete && el.naturalWidth>0),true);
    assert.match(await page.locator('#context-usage').innerText(),/DeepSeek/);
    await page.locator('[data-mention="@DeepSeek"]').click();
    assert.equal(await page.locator('#message').inputValue(),'@DeepSeek ');
    assert.match(await page.locator('#message').getAttribute('placeholder'),/三位/);
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(root,'.runtime/deepseek-chat-mobile.png'),fullPage:true});
    assert.equal(await page.locator('[data-mention="@DeepSeek"]').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page must not overflow horizontally');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});

test('DeepSeek workflow fish use existing live counts, activity rows and folded cards in real Edge',{timeout:60000},async()=>{
  const saved=Object.fromEntries(['work/queue.json','.runtime/agent/sessions.json','agent/config.json'].map(f=>[f,read(f)]));
  let server,browser,release,run,stream;
  const gate=new Promise(r=>{release=r;}),dir=path.join(root,'.runtime/deepseek-fish-ui');fs.mkdirSync(dir,{recursive:true});
  try{
    write('agent/config.json',{...saved['agent/config.json'],memory_v2:{enabled:false}});
    const job=submit({text:'@DeepSeek [validation] show workflow fish',title:'DeepSeek fish UI fixture'});
    run=execute(job.task_id,async(_,prompt,opts)=>{
      if(opts.purpose==='title')return {result:'DeepSeek fish fixture'};
      stream=deepseekStream(rootId,opts);for(const n of fishStart())stream.push(n);
      await gate;for(const n of fishEnd())stream.push(n);
      return {result:'ROOT_FINAL',sessionId:rootId,contextBreakdown:stream.contextBreakdown()};
    });
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    browser=await launchEdge({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.goto(base);await page.locator('.session-entry[data-session="'+job.session_id+'"]').click();
    await page.locator('.task-running').filter({hasText:'DeepSeek · 进行中 · 子 agent 2 个'}).waitFor();
    const group=page.locator('.subagent-group');await group.locator(':scope > summary').filter({hasText:'DeepSeek · 子 agent'}).waitFor();
    assert.equal(await group.count(),1);assert.match(await group.locator(':scope > summary').innerText(),/运行中 2/);
    assert.equal(await group.getAttribute('open'),null,'children remain folded by default');
    await group.locator(':scope > summary').click();
    const first=group.locator('.sub-run[data-child="'+fishIds[0]+'"]');
    await first.locator(':scope > summary').click();
    assert.match(await first.locator(':scope > summary .child-title').innerText(),/小鱼1号/);
    assert.match(await first.innerText(),/CHILD_TASK_1/);assert.match(await first.innerText(),/CHILD_PROGRESS_1/);
    assert.equal(await page.locator('#transcript > .message').filter({hasText:'CHILD_PROGRESS'}).count(),0,'child speech is inside its own card, not a root message');
    const state=await (await fetch(base+'/api/state?page=chat&session='+job.session_id)).json();
    assert.equal(state.agent.subagents.filter(e=>e.provider==='deepseek').length,2);
    assert.equal(state.agent.executions.filter(e=>e.tool_id.includes('same-call-id')).length,2,'child tools keep distinct IDs');
    assert.equal(state.agent.sessions.find(s=>s.id===job.session_id).context.deepseek.tokens,130);
    await page.screenshot({path:path.join(dir,'running.png'),fullPage:true});
    release();await run;await page.clock.fastForward(5000);
    await group.locator(':scope > summary').filter({hasText:'已完成 2/2'}).waitFor();
    await first.getByText('CHILD_FINAL_2',{exact:true}).first().waitFor();
    assert.equal(await page.locator('.task-running').count(),0);
    assert.equal(agentSnapshot().sessions.find(s=>s.id===job.session_id).subagent_runs.length,2);
    assert.equal(await page.locator('#transcript > .message').filter({hasText:'CHILD_PROGRESS'}).count(),0);
    await page.screenshot({path:path.join(dir,'completed.png'),fullPage:true});
    await page.reload();await group.locator(':scope > summary').filter({hasText:'已完成 2/2'}).waitFor();
    assert.deepEqual(errors,[]);
  } finally {
    release?.();await run;await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    for(const [f,data] of Object.entries(saved))write(f,data);
  }
});
