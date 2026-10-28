import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {submit,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {createHash} from 'node:crypto';
const execute=executeWithoutTitle(executeAgent);
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --prompts');
// The prompt page edits real fragment files, so it only ever runs against the sanitized copy.
const frag=id=>path.join(root,'prompts/fragments',id+'.md');

test('the prompt page is reachable from "更多", is a live-only page and its assets are served',async()=>{
  const app=fs.readFileSync(path.join(root,'dashboard/app.js'),'utf8'),html=fs.readFileSync(path.join(root,'dashboard/index.html'),'utf8'),ui=fs.readFileSync(path.join(root,'dashboard/ui-state.mjs'),'utf8');
  assert.match(app,/const more=\[[^\]]*'prompts'/);assert.match(html,/data-page="prompts" class="chat-tab more-tab"/);assert.match(html,/id="page-prompts"/);
  assert.equal((ui.match(/'prompts'/g)||[]).length,2,'known page name and live-only list');
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const asset of ['/prompts-view.js','/prompts-view.css'])assert.equal((await fetch(base+asset)).status,200,asset);
  } finally {await new Promise(r=>server.close(r));}
});

test('real-run inspection crosses the read-only HTTP and browser path without changing fragments or reviving the source editor',async()=>{
  const id='22222222-2222-4222-8222-222222222222',dir=path.join(root,'.runtime/agent/runs',id);
  const body='本轮原生增量\r\n<script>window.promptProbe=true</script>\n中文 {{不解析}}\n';
  const put=(file,value)=>fs.writeFileSync(path.join(dir,file),typeof value==='string'?value:JSON.stringify(value));
  fs.mkdirSync(dir,{recursive:true});put('prompt.txt','全量拼装稿，不是本轮实际文字');put('native-prompt.txt',body);
  put('continuation.json',{resumed:true});put('prompt-manifest.json',{speaker:'codex',resume_prompt_chars:body.length,resume_fragments:[{id:'turn/request',uses:1}],fragments:[{id:'turn/intro',uses:1}]});
  const before=fs.readFileSync(frag('turn/request'));
  const saved={cfg:read('agent/config.json'),queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')},created=[];
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;let browser;
  try {
    write('.runtime/agent/sessions.json',{...saved.sessions,sessions:[...saved.sessions.sessions,{id:'legacy-first',title:'旧运行验收',project_ids:[],origin:'chat',created_at:'2026-10-20T12:00:00Z',task_ids:[id],messages:[{role:'user',text:'旧运行验收',task_id:id,at:'2026-10-20T12:00:00Z'},{role:'assistant',provider:'codex',text:'已记录',task_id:id,at:'2026-10-20T12:01:00Z'}]}]});
    const list=await fetch(base+'/api/prompts/runs');assert.equal(list.status,200);assert.equal(list.headers.get('cache-control'),'no-store');assert.ok((await list.json()).runs.some(r=>r.id===id));
    const r=await fetch(base+'/api/prompts/run?id='+id);assert.equal((await r.json()).body,body);
    for(const bad of ['../work',id+'/../2',id+'\\2'])assert.equal((await fetch(base+'/api/prompts/run?id='+encodeURIComponent(bad))).status,400);
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],posts=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/prompts'))posts.push(r.url());});
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(base);await page.evaluate(()=>document.querySelector('[data-page="prompts"]').click());
    await page.locator('.pv-flow').waitFor();
    assert.equal(await page.locator('#pv-browse-runs').count(),0,'the architecture graph has no duplicate run entry');
    await page.locator('.pv-left [data-mode="run"]').click();await page.locator(`[data-run="${id}"]`).click();
    await page.locator('#pv-run-body').waitFor();
    for(const viewport of [{width:1500,height:1000},{width:1200,height:650}]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'desktop prompt page does not need a whole-page scrollbar');
    }
    await page.setViewportSize({width:1500,height:1000});
    assert.equal(await page.locator('#pv-main .pv-layer').count(),0,'the run metadata banner is removed');
    assert.doesNotMatch(await page.locator('#pv-main').innerText(),/本轮原生发送记录|本轮应用层拼装稿|对应总图中的|真实运行透视 · 应用层|本轮文字/);
    assert.equal(await page.locator('#pv-main .pv-head .eyebrow, #pv-main > h3.pv-sec').count(),0,'removed labels leave no empty heading elements');
    assert.equal(await page.locator('#pv-run-body').textContent(),body.replace(/\r\n/g,'\n'),'HTML parsing normalizes CRLF for display only');
    assert.equal(await page.evaluate(()=>window.promptProbe),undefined,'historical markup is text, never executable');
    assert.match(await page.locator('#pv-main').innerText(),/原生续接/);
    assert.equal(await page.locator('#pv-right [data-frag="turn/request"]').count(),1);
    assert.equal(await page.locator('#pv-right [data-frag="turn/intro"]').count(),0,'show delta inventory, not full-prompt inventory');
    await page.locator('#pv-right [data-frag="turn/request"]').click();await page.locator('.pv-expanded .slot').waitFor();
    assert.equal(await page.locator('.pv-seg .active').getAttribute('data-mode'),'domain');
    assert.equal(await page.locator('[data-tab="source"],#pv-editor,#pv-save').count(),0,'viewing cannot mark a draft dirty');
    await page.locator('[data-mode="run"]').click();await page.locator(`[data-run="${id}"]`).click();await page.locator('#pv-run-body').waitFor();
    await page.setViewportSize({width:1100,height:850});
    const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      elements:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right}))}));
    assert.ok(overflow.scrollWidth<=overflow.width,'no horizontal page overflow: '+JSON.stringify(overflow));
    assert.ok(await page.locator('.more-tab.active').first().evaluate(e=>{const r=e.getBoundingClientRect();return r.width>r.height*1.5;}),'top tab label must stay on one line, not shrink into vertical text');
    assert.ok(await page.locator('.topbar').evaluate(e=>[...e.querySelectorAll('.header-quota')].every(q=>q.getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom+1)),'quota cards stay within the header');
    await page.screenshot({path:path.join(root,'.runtime/prompts-width1100.png')});
    // Produce the source map through the actual coordinator, not a hand-written UI map.
    write('agent/config.json',{...saved.cfg,memory_v2:{enabled:true,owners:['codex','claude','deepseek']},codex_resume_sessions:['*']});
    const first=submit({text:'@Codex # 来源渲染验收\n\n请核对 **彩色片段**。\n<script>window.promptProbe=true</script>\n重复内容：当前请求：{{>turn/intro}}'});created.push(first.task_id);
    let fullBody;
    await execute(first.task_id,async(_,prompt,opts)=>{
      fullBody=prompt;fs.writeFileSync(path.join(opts.directory,'prompt.txt'),prompt);fs.writeFileSync(path.join(opts.directory,'native-prompt.txt'),prompt);fs.writeFileSync(path.join(opts.directory,'continuation.json'),JSON.stringify({resumed:false}));
      opts.onContinuation({threadId:'source-map-fixture',signature:'fixture'},{phase:'start',resumed:false});opts.onSubmitted();return {result:'Fixture reply; no model called.'};
    });
    const generated=await(await fetch(base+'/api/prompts/run?id='+first.task_id)).json();
    assert.ok(generated.sources?.nodes.length);assert.equal(generated.sources.sha256,createHash('sha256').update(fullBody).digest('hex'));
    fs.writeFileSync(frag('turn/request'),'# 当前片段版本已变\n{{goal}}');
    await page.locator('#pv-reload').click();await page.locator(`[data-run="${first.task_id}"]`).click();await page.locator('#pv-run-sources:not([hidden]) .pv-origin').first().waitFor();
    assert.equal(await page.locator('#pv-run-body').isVisible(),false,'new records default to coloured source blocks');
    assert.equal(await page.locator('#pv-main .pv-head .eyebrow, #pv-main > h3.pv-sec').count(),0,'source-block view also omits both labels');
    assert.equal(await page.locator('.pv-run-index,#pv-main [data-origin-jump]').count(),0,'the source view has no top index');
    const requestBlock=page.locator('[data-origin="turn/request"]').first();
    await page.locator('#pv-right [data-origin-id="turn/request"]').click();
    await page.waitForFunction(()=>{const m=document.getElementById('pv-main').getBoundingClientRect(),n=document.querySelector('[data-origin="turn/request"]').getBoundingClientRect();return n.top>=m.top&&n.top<m.bottom;});
    assert.equal(await page.locator('#pv-run-sources').isVisible(),true,'sidebar location does not leave the run');
    const nestedId='rule/handoff-writing';
    assert.ok(generated.fragments.some(f=>f.id===nestedId),'the current surroundings block includes nested handoff guidance');
    assert.equal(await page.locator(`[data-origin="${nestedId}"]`).count(),0,'nested sources start collapsed');
    await page.locator('[data-run-view="raw"]').click();
    await page.locator(`#pv-right [data-origin-id="${nestedId}"]`).click();
    await page.locator(`[data-origin="${nestedId}"]`).waitFor();
    assert.equal(await page.locator('#pv-run-sources').isVisible(),true,'a sidebar jump restores source mode and reveals nested ancestors');
    assert.equal(await page.locator('.pv-seg .active').getAttribute('data-mode'),'run');
    const colour=await requestBlock.evaluate(e=>e.style.getPropertyValue('--h'));
    await page.locator('[data-mode="domain"]').click();
    assert.equal(await page.locator('.pv-item[data-frag="turn/request"] .pv-bar').evaluate(e=>e.style.getPropertyValue('--h')),colour,'run boxes use the exact directory hue');
    assert.equal(await page.locator('.pv-origin-original').count(),0,'historical fragment-original panels have been removed');
    assert.doesNotMatch(await page.locator('#pv-run-sources').innerText(),/当时片段原文|查看当前版本/);
    await requestBlock.locator('[data-origin-parts]').first().click();
    await requestBlock.locator('strong').first().waitFor();
    assert.match(await requestBlock.innerText(),/用户消息/);assert.match(await requestBlock.innerText(),/\.runtime\/agent\/sessions\.json/);
    assert.equal(await page.evaluate(()=>window.promptProbe),undefined);
    await page.locator('[data-run-view="raw"]').click();
    assert.equal(await page.locator('#pv-run-body').textContent(),fullBody.replace(/\r\n/g,'\n'),'raw view preserves the complete native record');
    for(const width of [1500,1100]) {
      await page.setViewportSize({width,height:850});
      assert.equal(await page.locator('#pv-main').evaluate(e=>getComputedStyle(e).overflowY),'hidden','no outer run scrollbar');
      assert.ok(await page.locator('#pv-main').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'run controls fit without clipped outer content');
      assert.ok(await page.locator('#pv-run-body').evaluate(e=>{e.scrollTop=e.scrollHeight;return e.scrollHeight>e.clientHeight&&e.scrollTop>0;}),'the full raw text remains scrollable');
    }
    await page.locator('[data-run-view="sources"]').click();
    assert.ok(await page.locator('#pv-run-sources').evaluate(e=>{e.scrollTop=e.scrollHeight;return e.scrollHeight>e.clientHeight&&e.scrollTop>0;}),'source blocks have their own working scrollbar');
    // Ordinary .mjs content sits outside coloured fragment cards; all CSS remains theme based.
    assert.ok(await page.locator('.pv-run-source').count());
    await requestBlock.locator(':scope > .pv-origin-content').click({position:{x:8,y:8}});
    await page.waitForFunction(()=>document.querySelector('.pv-head h2 code')?.textContent==='turn/request');
    assert.equal(await page.locator('.pv-seg .active').getAttribute('data-mode'),'domain','clicking the card body opens directory detail');
    assert.equal(await page.locator('#pv-list .pv-item.active').getAttribute('data-frag'),'turn/request');
    assert.match(await page.locator('.pv-expanded').textContent(),/当前片段版本已变/,'card navigation opens current detail, not the historical snapshot');
    await page.locator('[data-mode="run"]').click();await page.locator(`[data-run="${first.task_id}"]`).click();
    await page.locator(`#pv-right [data-origin-id="${nestedId}"]`).click();
    const nestedTitle=page.locator(`[data-origin="${nestedId}"] > header [data-fragdir]`);
    await nestedTitle.focus();await nestedTitle.press('Enter');
    await page.waitForFunction(id=>document.querySelector('.pv-head h2 code')?.textContent===id,nestedId);
    assert.equal(await page.locator('.pv-seg .active').getAttribute('data-mode'),'domain','nested card keyboard navigation opens the nested fragment, not its parent');
    await page.locator('[data-mode="run"]').click();await page.locator(`[data-run="${first.task_id}"]`).click();
    await page.locator('#pv-run-sources .pv-origin').first().waitFor();
    await page.setViewportSize({width:1100,height:850});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.setViewportSize({width:1500,height:1000});
    const bottomGap=await page.locator('.pv').evaluate(e=>innerHeight-e.getBoundingClientRect().bottom);
    assert.ok(bottomGap>=8&&bottomGap<=24,`desktop columns leave a small bottom margin, got ${bottomGap}px`);
    await page.locator('#page-prompts').evaluate(e=>{const d=document.createElement('div');d.id='pv-test-spacer';d.style.cssText='flex:none;height:40px';e.prepend(d);});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'a taller heading consumes available space instead of overflowing the page');
    assert.equal(await page.locator('.pv').evaluate(e=>innerHeight-e.getBoundingClientRect().bottom),bottomGap,'bottom margin is independent of heading height');
    await page.locator('#pv-test-spacer').evaluate(e=>e.remove());
    await page.screenshot({path:path.join(root,'.runtime/prompts-run.png'),fullPage:true});
    fs.writeFileSync(frag('turn/request'),before);
    const second=submit({text:'@Codex 续接只发送增量。',session_id:first.session_id});created.push(second.task_id);let deltaBody;
    await execute(second.task_id,async(_,prompt,opts)=>{
      deltaBody=opts.resumePrompt;fs.writeFileSync(path.join(opts.directory,'prompt.txt'),prompt);fs.writeFileSync(path.join(opts.directory,'native-prompt.txt'),deltaBody);fs.writeFileSync(path.join(opts.directory,'continuation.json'),JSON.stringify({resumed:true}));
      opts.onContinuation({threadId:'source-map-fixture',signature:'fixture'},{phase:'start',resumed:true});return {result:'Delta fixture; no model called.'};
    });
    const delta=await(await fetch(base+'/api/prompts/run?id='+second.task_id)).json();assert.equal(delta.sources.sha256,createHash('sha256').update(deltaBody).digest('hex'));assert.ok(!delta.fragments.some(f=>f.id==='turn/surroundings'),'delta provenance never borrows the full map');
    assert.equal(generated.turn,1);assert.equal(delta.turn,2,'a later user turn does not reset to 1');
    const allRounds=(await(await fetch(base+'/api/prompts/runs')).json()).runs;
    assert.ok(allRounds.some(r=>r.id===first.task_id));assert.ok(allRounds.some(r=>r.id===second.task_id));
    await page.locator('#pv-reload').click();
    await page.locator(`[data-run="${second.task_id}"]`).click();
    assert.match(await page.locator('.pv-head h2').textContent(),/对话第 2 轮/);
    await page.locator('[data-run-view="raw"]').click();
    assert.equal(await page.locator('#pv-run-body').textContent(),deltaBody,'later rounds are selectable in the real page');
    const manifestFile=path.join(root,'.runtime/agent/runs',second.task_id,'prompt-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    manifest.resume_sources.nodes[0].end=deltaBody.length+1;fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    const broken=await(await fetch(base+'/api/prompts/run?id='+second.task_id)).json();assert.equal(broken.sources,null);assert.equal(broken.body,deltaBody,'a corrupt range only disables provenance');
    assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);assert.deepEqual(fs.readFileSync(frag('turn/request')),before);
    assert.equal(fs.readFileSync(path.join(dir,'native-prompt.txt'),'utf8'),body);
  } finally {
    await browser?.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});
    fs.writeFileSync(frag('turn/request'),before);write('agent/config.json',saved.cfg);write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);
    for(const task of created)fs.rmSync(path.join(root,'.runtime/agent/runs',task),{recursive:true,force:true});
  }
});

test('the prompt API lists, previews, edits, renames and deletes fragments with the same rules as the prompt command',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=async url=>{const r=await fetch(base+url);return {status:r.status,body:await r.json()};};
  const post=async(url,body,headers={Origin:base})=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const id='rule/ui-api-probe',moved='rule/ui-api-moved',user='rule/ui-api-user';
  try {
    const overview=(await get('/api/prompts')).body;
    assert.ok(overview.fragments.length>50&&overview.scenarios.some(s=>s.purpose==='chat')&&overview.standing_files.length>=3);
    assert.ok(overview.fragments.every(f=>typeof f.body==='string'&&Array.isArray(f.purposes)));
    assert.equal((await get('/api/prompts/fragment?id=rule/untrusted-data')).body.id,'rule/untrusted-data');
    assert.equal((await get('/api/prompts/fragment?id=nope/none')).status,400);
    assert.equal((await get('/api/prompts/other')).status,404);
    assert.equal((await post('/api/prompts/new',{id,body:'一 {{v}}'})).status,200);
    assert.equal((await post('/api/prompts/new',{id:'Bad Id'})).status,400);
    assert.deepEqual((await post('/api/prompts/save',{id,body:'二 {{v}}'})).body,{saved:id,changed:true});
    assert.equal((await get('/api/prompts/fragment?id='+id)).body.history[0].body,'一 {{v}}');
    assert.ok((await post('/api/prompts/preview',{id,body:'草稿 {{>turn/record}}'})).body.segments.some(s=>s.from==='turn/record'));
    assert.match((await post('/api/prompts/preview',{id,body:'{{>'+id+'}}'})).body.error,/循环/);
    assert.equal((await post('/api/prompts/save',{id,body:'x'},{Origin:'http://evil.example'})).status,400,'cross-origin writes are refused');
    fs.writeFileSync(frag(user),'含 {{>'+id+'}}');
    const rm=await post('/api/prompts/rm',{id});
    assert.equal(rm.status,400);assert.match(rm.body.error,/ui-api-user/,'refusal names what still uses it');
    const mv=await post('/api/prompts/mv',{from:id,to:moved});
    assert.deepEqual(mv.body.renamed,[id,moved]);assert.equal(fs.readFileSync(frag(user),'utf8'),'含 {{>'+moved+'}}');
    fs.rmSync(frag(user));
    assert.deepEqual((await post('/api/prompts/rm',{id:moved})).body,{removed:moved});
    assert.ok(!fs.existsSync(frag(moved)));
    const snap=(await get('/api/prompts/snapshot')).body;
    assert.equal(snap.changed.length,0,'unused probe fragments do not change any recorded rendering');
  } finally {
    for(const f of [id,moved,user])fs.rmSync(frag(f),{force:true});
    await new Promise(r=>server.close(r));
  }
});
