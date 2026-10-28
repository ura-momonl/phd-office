import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {settingsView,saveSettings,skillsView,FIELDS,run} from './settings.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {backupData} from '../automation/backup.mjs';
import {codexLaunch,continuationSignature,startCodexTurn} from '../agent/codex.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs in a sanitised copy');

const logFile=path.join(root,'.runtime/settings/changes.jsonl');
async function withConfig(fn) {
  const before=read('agent/config.json'),policy=read('work/policy.json'),log=fs.existsSync(logFile) ? fs.readFileSync(logFile) : null;
  try{await fn(before);}
  finally{write('agent/config.json',before);write('work/policy.json',policy);if(log)fs.writeFileSync(logFile,log);else fs.rmSync(logFile,{force:true});}
}

test('task model settings offer all colleagues and save to the one owning policy without changing chat or mail automation',()=>withConfig(before=>{
 const fields=settingsView().fields.filter(f=>f.taskKind && f.type==='model'),policy=read('work/policy.json'),queue=read('work/queue.json');
 assert.deepEqual(fields.map(f=>f.taskKind),['mail','literature','presentation']);
 for(const f of fields){assert.equal(f.section,'tasks');for(const value of ['opus',before.codex_model,'deepseek-flash'])assert.ok(f.options.some(o=>o.value===value),value);}
 const choices={mail:'opus',literature:before.codex_model,presentation:'sonnet'};
 const result=saveSettings(Object.fromEntries(Object.entries(choices).map(([kind,value])=>['task_models.'+kind,value])));
 assert.equal(result.changed.length,3);
 const after=read('work/policy.json');
 for(const [kind,value] of Object.entries(choices))assert.equal(after.defaults.find(p=>p.kind===kind).model,value);
 assert.deepEqual(after.defaults.filter(p=>['mail','literature','presentation'].includes(p.kind)).map(p=>p.actor),['claude','codex','claude']);
 assert.deepEqual(after.defaults.filter(p=>!['mail','literature','presentation'].includes(p.kind)),policy.defaults.filter(p=>!['mail','literature','presentation'].includes(p.kind)));
 assert.deepEqual(read('agent/config.json'),before);assert.deepEqual(read('work/queue.json'),queue);
 const bytes=fs.readFileSync(path.join(root,'work/policy.json'));
 assert.throws(()=>saveSettings({'task_models.mail':'deepseek-flash',reasoning_effort:'invalid'}),/可选/);
 assert.ok(fs.readFileSync(path.join(root,'work/policy.json')).equals(bytes),'invalid mixed save changes neither source');
 assert.equal(settingsView().fields.find(f=>f.key==='task_models.mail').value,'opus');
}));

test('browser: each new-task kind has a model picker, saves through HTTP and survives reload without starting a task',()=>withConfig(async before=>{
 saveSettings({'task_models.mail':'deepseek-flash','task_efforts.mail':'high'});
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,queue=read('work/queue.json');let browser;
 try {
  browser=await launchEdge();const page=await browser.newPage({viewport:{width:1300,height:1000}});
  await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
  await page.goto(base);await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="connections"]').click();
  await page.locator('[data-settings-tab="models"]').click();
  // Every model, including chat, titles, mail judgment and memory, has one adjacent effort picker.
  const view=settingsView();
  for(const f of view.fields.filter(f=>f.type==='model')) {
   const pair=view.fields.find(p=>p.pair===f.key);assert.ok(pair,f.key+' needs its own effort');
   const row=page.locator('.setting-row').filter({has:page.locator(`[id="set-${f.key}"]`)});
   assert.equal(await row.locator(`[id="set-${pair.key}"]`).count(),1);
  }
  const mailModel=page.locator('[id="set-task_models.mail"]'),mailEffort=page.locator('[id="set-task_efforts.mail"]');
  await mailEffort.selectOption('max');await mailModel.selectOption('opus');
  assert.equal(await mailEffort.inputValue(),before.claude_reasoning_effort || before.reasoning_effort);
  assert.deepEqual(await mailEffort.locator('option').evaluateAll(o=>o.map(x=>x.value)),['low','medium','high','xhigh']);
  await mailModel.selectOption('__other__');await mailModel.locator('xpath=following-sibling::input[1]').fill('deepseek-custom');
  assert.deepEqual(await mailEffort.locator('option').evaluateAll(o=>o.map(x=>x.value)),['off','low','high','max']);
  await page.locator('[data-settings-section="models"] [data-settings-reset]').click();
  assert.equal(await mailModel.inputValue(),'deepseek-flash');assert.equal(await mailEffort.inputValue(),'high');
  const choices={mail:'opus',literature:before.codex_model,presentation:'sonnet'};
  const efforts={mail:'low',literature:'medium',presentation:'xhigh'};
  for(const [kind,value] of Object.entries(choices)){
   await page.locator(`[id="set-task_models.${kind}"]`).selectOption(value);
   await page.locator(`[id="set-task_efforts.${kind}"]`).selectOption(efforts[kind]);
  }
  await page.locator('[data-settings-section="models"] [data-settings-save]').click();
  await page.locator('[data-settings-section="models"] .settings-status').filter({hasText:'已保存 6 项'}).waitFor();
  await page.reload();await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="connections"]').click();await page.locator('[data-settings-tab="models"]').click();
  for(const [kind,value] of Object.entries(choices)){
   assert.equal(await page.locator(`[id="set-task_models.${kind}"]`).inputValue(),value);
   assert.equal(await page.locator(`[id="set-task_efforts.${kind}"]`).inputValue(),efforts[kind]);
  }
  const section=page.locator('.setting-section').filter({has:page.locator('h3',{hasText:'新建任务默认模型'})});
  await section.scrollIntoViewIfNeeded();assert.match(await section.innerText(),/后台收件判断不变/);
  await page.screenshot({path:path.join(root,'.runtime/task-model-settings.png')});
  const pairBoxes=await section.locator('.setting-control').evaluateAll(rows=>rows.map(row=>{const [model,,effort]=row.children;const m=model.getBoundingClientRect(),e=effort.getBoundingClientRect();return {aligned:Math.abs(m.y-e.y)<2,ordered:e.x>=m.right,visible:e.width>=80 && m.width>100};}));
  assert.ok(pairBoxes.every(p=>p.aligned && p.ordered && p.visible),'each small effort control sits after its model without clipping');
  assert.deepEqual(read('work/queue.json'),queue);assert.deepEqual(read('agent/config.json'),before);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}));

test('independent chat efforts preserve other settings; task effort validates against its final provider before either source is written',()=>withConfig(before=>{
 saveSettings({'task_models.mail':'deepseek-flash','task_models.literature':'deepseek-flash'});
 saveSettings({reasoning_effort:'low',claude_reasoning_effort:'xhigh',deepseek_reasoning_effort:'max'});
 const config=read('agent/config.json');assert.equal(config.reasoning_effort,'low');assert.equal(config.claude_reasoning_effort,'xhigh');assert.equal(config.deepseek_reasoning_effort,'max');
 saveSettings({'task_efforts.mail':'max'});
 const bytes=fs.readFileSync(path.join(root,'work/policy.json')),agentBytes=fs.readFileSync(path.join(root,'agent/config.json'));
 for(const changes of [
  {'task_efforts.mail':'max','task_models.mail':'opus',reasoning_effort:'high'},
  {'task_models.mail':'opus','task_efforts.mail':'max'},
  {'task_efforts.literature':'xhigh'}
 ]){assert.throws(()=>saveSettings(changes),/可选/);assert.ok(fs.readFileSync(path.join(root,'work/policy.json')).equals(bytes));assert.ok(fs.readFileSync(path.join(root,'agent/config.json')).equals(agentBytes));}
 const changed=saveSettings({'task_models.mail':'opus'});assert.ok(changed.changed.includes('task_efforts.mail'));
 assert.equal(read('work/policy.json').defaults.find(p=>p.kind==='mail').effort,'xhigh');
 saveSettings({'task_models.mail':'deepseek-flash'});assert.equal(read('work/policy.json').defaults.find(p=>p.kind==='mail').effort,'max');
 // Configurations from before per-assistant effort still display the prior shared value.
 delete config.claude_reasoning_effort;write('agent/config.json',config);
 assert.equal(settingsView().fields.find(f=>f.key==='claude_reasoning_effort').value,'low');
 saveSettings({title_again_at:before.title_again_at+1});assert.equal(read('agent/config.json').claude_reasoning_effort,undefined,'unrelated saves do not materialize presentation-only defaults');
}));

test('every settings field maps to an existing config key with a value of its declared type',()=>{
  for(const f of settingsView().fields) {
    assert.notEqual(f.value,null,f.key+' missing from agent/config.json');
    if(f.type==='bool')assert.equal(typeof f.value,'boolean',f.key);
    if(f.type==='int'){assert.ok(Number.isInteger(f.value),f.key);assert.ok(f.value>=f.min && f.value<=f.max,f.key+' outside its own range');}
    if(f.type==='enum')assert.ok(f.options.includes(f.value),f.key);
    if(f.type==='model')assert.equal(typeof f.value,'string',f.key);
  }
  for(const f of settingsView().fields.filter(x=>x.pair)){
    const model=settingsView().fields.find(x=>x.key===f.pair);
    assert.ok(model && model.group===f.group && model.type==='model' && f.type==='enum',f.key+' must sit beside a model field of its own group');
  }
  for(const secret of ['enabled','autonomy','memory_v2.enabled'])assert.ok(!FIELDS.some(f=>f.key===secret),secret+' must not be editable here');
});

test('saving writes only the changed whitelisted keys, keeps everything else, and logs old and new values',()=>withConfig(before=>{
  const result=saveSettings({reasoning_effort:'low','memory_v2.auto.idle_minutes':45,claude_model:' opus ',default_provider:before.default_provider},{now:new Date('2026-10-16T12:00:00Z')});
  assert.deepEqual(result.changed.sort(),['claude_model','memory_v2.auto.idle_minutes','reasoning_effort']);
  const after=read('agent/config.json');
  assert.equal(after.reasoning_effort,'low');assert.equal(after.claude_model,'opus');assert.equal(after.memory_v2.auto.idle_minutes,45);
  assert.deepEqual({...after,reasoning_effort:0,claude_model:0,memory_v2:0},{...before,reasoning_effort:0,claude_model:0,memory_v2:0},'untouched keys stay as they were');
  assert.equal(after.memory_v2.auto.consolidate_hours,before.memory_v2.auto.consolidate_hours);
  const lines=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l=>[l.key,l.from,l.to]).sort(),[['claude_model',before.claude_model,'opus'],['memory_v2.auto.idle_minutes',before.memory_v2.auto.idle_minutes,45],['reasoning_effort',before.reasoning_effort,'low']]);
  assert.equal(lines[0].at,'2026-10-16T12:00:00.000Z');
  const again=saveSettings({reasoning_effort:'low'});assert.deepEqual(again.changed,[]);
  assert.equal(fs.readFileSync(logFile,'utf8').trim().split('\n').length,3,'an unchanged save logs nothing');
}));

test('fields sit in named sections, model-calling settings are marked, and recent changes list the newest saves of known keys only',()=>withConfig(before=>{
  const view=settingsView(),ids=new Set(view.groups.flatMap(g=>g.sections.map(x=>x.id)));
  for(const f of view.fields.filter(x=>!x.pair)){assert.ok(ids.has(f.section),f.key+' needs a section');assert.ok(view.groups.find(g=>g.id===f.group).sections.some(x=>x.id===f.section),f.key+' section belongs to its own group');}
  assert.ok(view.fields.find(f=>f.key==='claude_model').llm && !view.fields.find(f=>f.key==='default_provider').llm);
  assert.equal(view.fields.find(f=>f.key==='title_again_at').value,before.title_again_at);
  assert.ok(view.fields.find(f=>f.key==='memory_extract.codex.model') && view.fields.find(f=>f.key==='memory_extract.claude.effort').pair==='memory_extract.claude.model');
  fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.writeFileSync(logFile,JSON.stringify({at:'2026-01-01T00:00:00Z',key:'retired_key',from:1,to:2})+'\n');
  saveSettings({title_again_at:12,'memory_extract.codex.effort':'low'},{now:new Date('2026-10-20T12:00:00Z')});
  const recent=settingsView().recent;
  assert.deepEqual(recent.map(c=>c.key).sort(),['memory_extract.codex.effort','title_again_at'],'a retired key is skipped');
  assert.deepEqual(recent.find(c=>c.key==='title_again_at'),{at:'2026-10-20T12:00:00.000Z',key:'title_again_at',label:'第二次起标题的时机',group:'models',from:before.title_again_at,to:12,actor:'dashboard'});
  assert.equal(read('agent/config.json').memory_extract.codex.effort,'low');assert.equal(read('agent/config.json').memory_extract.claude.effort,before.memory_extract.claude.effort);
  assert.throws(()=>saveSettings({'memory_extract.claude.model':'claude-sonnet-5-5'}),/Codex 一侧的模型|Claude 一侧/,'memory extraction is called through Codex, so a Claude model is refused');
  assert.throws(()=>saveSettings({title_again_at:99}),/之间/);
}));

test('invalid or unsafe changes are rejected as a whole and leave the file untouched',()=>withConfig(before=>{
  const bytes=fs.readFileSync(path.join(root,'agent/config.json'));
  const bad=[[{enabled:false},/不能修改/],[{'autonomy.level':4},/不能修改/],[{reasoning_effort:'extreme'},/可选/],[{automation_daily_calls:1.5},/整数/],[{automation_daily_calls:9999},/之间/],
    [{automatic_cards:'yes'},/开或关/],[{claude_model:'sonnet; rm -rf'},/只允许/],[{codex_model:''},/只允许/],
    [{'memory_v2.auto.idle_minutes':600,'memory_v2.auto.ingest_hours':0},/之间/],
    ...[0,11,-1,1.5,'2',null].map(value=>[{subagent_max_concurrency:value},/整数|之间/])];
  for(const [changes,message] of bad) {
    assert.throws(()=>saveSettings({reasoning_effort:'low',...changes}),message,JSON.stringify(changes));
    assert.deepEqual(fs.readFileSync(path.join(root,'agent/config.json')),bytes,'rejected save must not write: '+JSON.stringify(changes));
  }
  assert.throws(()=>saveSettings(null),/没有可保存/);assert.ok(!fs.existsSync(logFile));
}));

test('subagent concurrency is a persisted, audited setting supporting one through ten',()=>withConfig(before=>{
  const field=settingsView().fields.find(f=>f.key==='subagent_max_concurrency');
  assert.equal(field.group,'models');assert.equal(field.section,'chat');
  assert.equal(field.min,1);assert.equal(field.max,10);
  for(const limit of [1,3,10]) {
    const saved=saveSettings({subagent_max_concurrency:limit});
    assert.equal(read('agent/config.json').subagent_max_concurrency,limit);
    assert.equal(saved.fields.find(f=>f.key===field.key).value,limit);
  }
  const lines=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l=>[l.key,l.to]),[1,3,10].filter((n,i)=>i || before.subagent_max_concurrency!==n).map(n=>[field.key,n]));
}));

test('saving concurrency changes native launch limits and prevents resuming a thread with the old limit',()=>withConfig(async()=>{
  saveSettings({subagent_max_concurrency:1});
  const one=codexLaunch('ordinary'),old=continuationSignature(one,'fixture','high');
  assert.ok(one.overrides.includes('agents.max_concurrent_threads_per_session=1'));
  saveSettings({subagent_max_concurrency:10});
  for(const request of ['ordinary','Fusion','AutoCAD'])assert.ok(codexLaunch(request).overrides.includes('agents.max_concurrent_threads_per_session=10'));
  const ten=codexLaunch('ordinary'),signature=continuationSignature(ten,'fixture','high');
  assert.notEqual(signature,old);
  assert.ok(!codexLaunch('parse only',{mode:'ask'}).overrides.some(o=>o.startsWith('agents.')));
  const calls=[];
  await startCodexTurn(async(method,params)=>{calls.push({method,params});return method==='turn/start' ? {turn:{id:'T'}} : {thread:{id:'new'},sandbox:{type:'workspaceWrite'}};},
    {params:{sandbox:'workspace-write'},signature,continuation:{threadId:'old',signature:old},prompt:'FULL',resumePrompt:'DELTA'});
  assert.deepEqual(calls.map(c=>c.method),['thread/start','turn/start']);
  assert.equal(calls[1].params.input[0].text,'FULL');
  write('agent/config.json',{...read('agent/config.json'),subagent_max_concurrency:11});
  assert.throws(()=>codexLaunch('ordinary'),/1～10/);
}));

test('installed Codex reads the native concurrency override without calling a model',{timeout:25000},()=>withConfig(async()=>{
  if(process.platform!=='win32')return;
  saveSettings({subagent_max_concurrency:10});
  const launch=codexLaunch('ordinary'),bin=path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js');
  const child=spawn(process.execPath,[bin,'app-server','--listen','stdio://',...launch.overrides.flatMap(o=>['-c',o])],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-2000);});child.stdin.on('error',()=>{});
  try {
    const rpc=(id,method,params)=>new Promise((resolve,reject)=>{
      const done=(error,value)=>{clearTimeout(timer);lines.off('line',line);child.off('error',errorEvent);child.off('exit',exit);error ? reject(error) : resolve(value);};
      const line=text=>{let msg;try{msg=JSON.parse(text);}catch{return;}if(msg.id===id)done(msg.error ? new Error(JSON.stringify(msg.error)) : null,msg.result);};
      const errorEvent=error=>done(error),exit=code=>done(new Error('Native startup exited '+code+': '+stderr));
      const timer=setTimeout(()=>done(new Error('Native config read timed out')),15000);
      lines.on('line',line);child.once('error',errorEvent);child.once('exit',exit);
      child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
    await rpc(1,'initialize',{clientInfo:{name:'subagent-config-test',version:'1'}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const effective=await rpc(2,'config/read',{includeLayers:false});
    assert.equal(effective.config.agents.max_concurrent_threads_per_session,10,'native normalized config must contain the effective value');
  } finally {
    lines.close();child.stdin.end();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>child.kill(),2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    child.stdout.destroy();child.stderr.destroy();
  }
}));

test('HTTP: GET returns the form model, POST saves, a bad value is a 400 error, and a foreign origin is refused',()=>withConfig(async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const post=(body,headers={})=>fetch(base+'/api/settings',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  try {
    const view=await (await fetch(base+'/api/settings')).json();
    assert.deepEqual(view.groups.map(g=>g.id),['models','mail','memory']);assert.ok(view.fields.find(f=>f.key==='memory_v2.auto.enabled'));
    const saved=await post({changes:{mail_batch_min_messages:6}});assert.equal(saved.status,200);
    const body=await saved.json();assert.deepEqual(body.changed,['mail_batch_min_messages']);assert.equal(read('agent/config.json').mail_batch_min_messages,6);
    const rejected=await post({changes:{mail_batch_min_messages:0}});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/攒批条数/);
    assert.equal(read('agent/config.json').mail_batch_min_messages,6);
    assert.equal((await post({changes:{mail_batch_min_messages:2}},{origin:'http://untrusted.example'})).status,400);assert.equal(read('agent/config.json').mail_batch_min_messages,6);
    assert.equal((await fetch(base+'/settings-view.js')).status,200);
  } finally {await new Promise(r=>server.close(r));}
}));

test('browser: the 设置 page keeps unsaved edits across tabs and polls, reports errors in place, and saves one group',{timeout:120000},()=>withConfig(async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await launchEdge();const page=await (await browser.newContext({viewport:{width:1300,height:1000}})).newPage();
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(base);await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="connections"]').click();
    assert.equal(await page.locator('#page-title').textContent(),'设置');assert.equal(await page.locator('.more-tab[data-page="connections"]').textContent(),'设置');
    await page.locator('[data-settings-tab="models"]').waitFor();
    assert.equal(await page.locator('#settings-connections').isVisible(),true,'connections stay the default view');
    await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await page.locator('#settings-connections').isVisible(),false);
    const save=page.locator('[data-settings-section="models"] [data-settings-save]');assert.equal(await save.isDisabled(),true);
    const concurrency=page.locator('#set-subagent_max_concurrency');
    assert.equal(await concurrency.getAttribute('min'),'1');assert.equal(await concurrency.getAttribute('max'),'10');
    await concurrency.fill('1');await save.click();
    await page.locator('[data-settings-section="models"] .settings-status').filter({hasText:'已保存 1 项'}).waitFor();
    assert.equal(read('agent/config.json').subagent_max_concurrency,1);
    await concurrency.fill('10');await save.click();
    await page.locator('[data-settings-section="models"] .settings-status').filter({hasText:'已保存 1 项'}).waitFor();
    assert.equal(read('agent/config.json').subagent_max_concurrency,10);
    await page.reload();await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="connections"]').click();
    await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await concurrency.inputValue(),'10','saved concurrency survives page reload');
    await page.locator('[id="set-reasoning_effort"]').selectOption('low');
    assert.equal(await save.isDisabled(),false);assert.match(await page.locator('[data-settings-section="models"] .settings-status').textContent(),/1 项未保存/);
    // A model and its reasoning effort share one row; the action bar sticks to the bottom only while something is unsaved.
    await page.locator('[data-settings-tab="mail"]').click();
    const autoReset=page.locator('#set-automatic_codex_reset_credit'),mailSave=page.locator('[data-settings-section="mail"] [data-settings-save]');
    assert.equal(await autoReset.isChecked(),false);
    await autoReset.check();await mailSave.click();
    await page.locator('[data-settings-section="mail"] .settings-status').filter({hasText:'已保存 1 项'}).waitFor();
    assert.equal(read('agent/config.json').automatic_codex_reset_credit,true);
    await autoReset.uncheck();await mailSave.click();
    await page.locator('[data-settings-section="mail"] .settings-status').filter({hasText:'已保存 1 项'}).waitFor();
    assert.equal(read('agent/config.json').automatic_codex_reset_credit,false);
    assert.equal(await page.locator('.setting-row:has(#set-mail_screen_model):has(#set-mail_screen_effort)').count(),1,'粗筛 model and effort share a row');
    assert.equal(await page.locator('label[for="set-mail_screen_effort"]').count(),0,'a paired effort has no row of its own');
    assert.equal(await page.locator('#set-mail_screen_effort').getAttribute('aria-label'),'粗筛推理强度');
    const mailBar=page.locator('[data-settings-section="mail"] .settings-actions');
    assert.equal(await mailBar.evaluate(el=>getComputedStyle(el).position),'static','clean bar stays in the flow');
    await page.locator('#set-mail_screen_effort').selectOption('low');
    assert.equal(await mailBar.evaluate(el=>getComputedStyle(el).position),'sticky','unsaved bar sticks');
    assert.equal(await page.locator('.setting-row.dirty:has(#set-mail_screen_model)').count(),1,'the shared row is marked once');
    await page.locator('[data-settings-section="mail"] [data-settings-reset]').click();
    assert.equal(await mailBar.evaluate(el=>getComputedStyle(el).position),'static');
    // Model fields are lists with a manual entry: choose, type something unknown, and fall back.
    await page.locator('[data-settings-tab="models"]').click();
    const claude=page.locator('#set-claude_model'),other=claude.locator('xpath=following-sibling::input[1]');
    const claudeOptions=await claude.locator('option').evaluateAll(o=>o.map(x=>x.value));
    assert.deepEqual(claudeOptions.slice(0,4),['sonnet','opus','haiku','fable']);assert.ok(claudeOptions.includes('claude-opus-5-5'));assert.equal(claudeOptions.at(-1),'__other__');
    assert.equal(await other.isHidden(),true);
    const origClaude=read('agent/config.json').claude_model,origEffort=read('agent/config.json').reasoning_effort; // 推理强度 is already edited and unsaved at this point, so the group has one pending edit before ours
    await claude.selectOption('opus');assert.equal(await page.locator('.setting-row.dirty:has(#set-claude_model)').count(),1);
    await claude.selectOption('__other__');assert.equal(await other.isVisible(),true);await other.fill('claude-test-9');
    assert.equal(await page.locator('[data-settings-section="models"] .settings-status').textContent(),'2 项未保存');
    await claude.selectOption(origClaude);assert.equal(await other.isHidden(),true,'choosing a listed model hides the manual box');
    assert.equal(await page.locator('[data-settings-section="models"] .settings-status').textContent(),'1 项未保存');
    await claude.selectOption('__other__');await other.fill('bad model!');await page.locator('[data-settings-section="models"] [data-settings-save]').click();
    await page.locator('[data-settings-section="models"] .settings-error').waitFor();assert.match(await page.locator('[data-settings-section="models"] .settings-status').textContent(),/只允许/);
    assert.equal(read('agent/config.json').reasoning_effort,origEffort,'a rejected batch writes nothing, including the valid edit beside it');
    await claude.selectOption(origClaude);
    // The title model follows the title provider: switching it swaps the list and moves to that side's default; switching back restores the original.
    const provider=page.locator('#set-title_provider'),titleModel=page.locator('#set-title_model'),origProvider=read('agent/config.json').title_provider,origTitle=read('agent/config.json').title_model;
    const status=page.locator('[data-settings-section="models"] .settings-status'),other2=origProvider==='claude' ? 'codex' : 'claude';
    await provider.selectOption(other2);
    const swapped=await titleModel.locator('option').evaluateAll(o=>o.map(x=>x.value));
    assert.ok(other2==='codex' ? !swapped.includes('sonnet') : swapped.includes('sonnet'),'the list now belongs to '+other2);
    assert.equal(await titleModel.inputValue(),other2==='codex' ? 'gpt-6-luna' : 'claude-haiku-5-5');assert.equal(await status.textContent(),'3 项未保存');
    await provider.selectOption(origProvider);
    assert.equal(await titleModel.inputValue(),origTitle,'back on the original side the original model returns');assert.equal(await status.textContent(),'1 项未保存');
    await page.locator('[data-settings-tab="memory"]').click();await page.locator('[id="set-memory_v2.auto.idle_minutes"]').fill('99999');
    await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await page.locator('[id="set-reasoning_effort"]').inputValue(),'low','edit survives tab switches');
    await page.waitForTimeout(300);
    await save.click();await page.locator('[data-settings-section="models"] .settings-status').filter({hasText:'已保存 1 项'}).waitFor();
    assert.equal(read('agent/config.json').reasoning_effort,'low');
    await page.locator('[data-settings-tab="memory"]').click();
    assert.equal(await page.locator('[id="set-memory_v2.auto.idle_minutes"]').inputValue(),'99999','the other group keeps its unsaved edit after a save');
    const memorySave=page.locator('[data-settings-section="memory"] [data-settings-save]');await memorySave.click();
    await page.locator('[data-settings-section="memory"] .settings-error').waitFor();
    assert.match(await page.locator('[data-settings-section="memory"] .settings-status').textContent(),/闲置多久后整理/);
    assert.notEqual(read('agent/config.json').memory_v2.auto.idle_minutes,99999);
    await page.locator('[data-settings-section="memory"] [data-settings-reset]').click();
    assert.equal(await memorySave.isDisabled(),true);
    assert.deepEqual(errors,['Failed to load resource: the server responded with a status of 400 (Bad Request)','Failed to load resource: the server responded with a status of 400 (Bad Request)'],'only the two deliberately rejected saves (a bad model name, an out-of-range token count) log a resource error');
    const dir=path.join(root,'.runtime/settings-review');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'settings.png')});
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
}));

test('command-line entry: show lists every field, set applies a JSON file, and a bad batch writes nothing',()=>withConfig(async before=>{
  const lines=[],log=console.log;console.log=(...a)=>lines.push(a.join(' '));
  try{await run('show');}finally{console.log=log;}
  for(const f of FIELDS)assert.ok(lines.some(l=>l.includes(f.key+' = ')),f.key+' missing from show');
  const dir=fs.mkdtempSync(path.join(root,'.runtime/settings-cli-')),file=path.join(dir,'set.json');
  try {
    fs.writeFileSync(file,JSON.stringify({changes:{reasoning_effort:'medium','memory_v2.auto.ingest_hours':180}}));
    const out=[];console.log=(...a)=>out.push(a.join(' '));
    try{await run('set',file);}finally{console.log=log;}
    assert.match(out.join(' '),/已保存/);assert.equal(read('agent/config.json').reasoning_effort,'medium');assert.equal(read('agent/config.json').memory_v2.auto.ingest_hours,180);
    const bytes=fs.readFileSync(path.join(root,'agent/config.json'));
    fs.writeFileSync(file,JSON.stringify({changes:{reasoning_effort:'low',automation_daily_calls:-1}}));
    await assert.rejects(()=>run('set',file),/每日自动调用上限/);assert.deepEqual(fs.readFileSync(path.join(root,'agent/config.json')),bytes);
    await assert.rejects(()=>run('set'),/JSON文件路径/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  assert.equal(before.enabled,read('agent/config.json').enabled);
}));

test('skills view: reads only project skills, flags bad headers and missing, broken or orphan Claude links, and writes nothing',async()=>{
  const skills=path.join(root,'.agents/skills'),links=path.join(root,'.claude/skills'),made=[];
  const skill=(dir,head)=>{const d=path.join(skills,dir);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'SKILL.md'),head+'\n\n正文。'.repeat(20));made.push(d);return d;};
  const link=(name,target)=>{fs.mkdirSync(links,{recursive:true});const l=path.join(links,name);fs.symlinkSync(target,l,'junction');made.push(l);return l;};
  const before={skills:fs.existsSync(skills),links:fs.existsSync(links)};
  try {
    assert.deepEqual((await skillsView()).skills.filter(s=>s.dir.startsWith('t-')),[]);
    const good=skill('t-good','---\nname: t-good\ndescription: 当用户要整理样品账本时使用\n---');link('t-good',good);
    skill('t-unlinked','---\nname: t-unlinked\ndescription: 没有链接\n---');
    skill('t-mismatch','---\nname: other-name\n---');
    fs.mkdirSync(path.join(skills,'t-empty'),{recursive:true});made.push(path.join(skills,'t-empty'));
    const gone=path.join(root,'tmp-gone-target');fs.mkdirSync(gone);link('t-orphan',gone);fs.rmSync(gone,{recursive:true});
    const stale=skill('t-stale','---\nname: t-stale\ndescription: 链接指向别处\n---');link('t-stale',path.join(skills,'t-good'));
    const view=await skillsView(),by=Object.fromEntries(view.skills.map(s=>[s.dir,s]));
    assert.equal(by['t-good'].claude,'ok');assert.deepEqual(by['t-good'].issues,[]);assert.equal(by['t-good'].description,'当用户要整理样品账本时使用');
    assert.ok(by['t-good'].always_tokens>0 && by['t-good'].body_tokens>by['t-good'].always_tokens,'always-loaded cost is only name and description');
    assert.equal(by['t-unlinked'].claude,'missing');assert.match(by['t-unlinked'].issues.join(),/发现入口未就绪/);
    assert.match(by['t-mismatch'].issues.join(),/不一致/);assert.match(by['t-mismatch'].issues.join(),/description/);
    assert.deepEqual(by['t-empty'].issues,['缺少 SKILL.md']);
    assert.equal(by['t-stale'].claude,'broken');
    assert.ok(view.problems.some(p=>p.includes('t-orphan')),'a link without a body is reported');
    const lines=[],log=console.log;console.log=(...a)=>lines.push(a.join(' '));try{await run('skills');}finally{console.log=log;}
    assert.ok(lines.some(l=>l.startsWith('t-good ') && l.includes('Claude 链接：ok')));
    assert.ok(lines.some(l=>l.includes('估算') && l.includes('不是实际账单')));
    assert.match(by['t-good'].content,/正文/);
    assert.equal(by['t-good'].content,fs.readFileSync(path.join(good,'SKILL.md'),'utf8'),'view does not rewrite the skill');
    void stale;
  } finally {
    for(const p of made.reverse())fs.rmSync(p,{recursive:true,force:true});
    if(!before.links)fs.rmSync(links,{recursive:true,force:true});if(!before.skills)fs.rmSync(skills,{recursive:true,force:true});
  }
});

test('skills view supports quoted/block descriptions and never reads bodies outside the project skill directory',async()=>{
  const skills=path.join(root,'.agents/skills'),made=[];
  const put=(name,content)=>{const dir=path.join(skills,name);fs.mkdirSync(dir,{recursive:true});made.push(dir);fs.writeFileSync(path.join(dir,'SKILL.md'),content);return dir;};
  try {
    put('t-quoted','---\nname: "t-quoted"\ndescription: "when input contains \\"quoted\\" text"\n---\n# Quoted');
    put('t-block','---\nname: t-block\ndescription: >-\n  when checking files\n  without executing them\n---\n# Block');
    const outside=fs.mkdtempSync(path.join(root,'.runtime/skills-outside-'));made.push(outside);
    fs.writeFileSync(path.join(outside,'SKILL.md'),'PRIVATE CONTENT NOT TO PUBLISH');
    const link=path.join(skills,'t-outside');fs.symlinkSync(outside,link,'junction');made.push(link);
    const by=Object.fromEntries((await skillsView()).skills.map(s=>[s.dir,s]));
    assert.equal(by['t-quoted'].description,'when input contains "quoted" text');
    assert.equal(by['t-block'].description,'when checking files without executing them');
    assert.equal(by['t-outside'].content,'');assert.match(by['t-outside'].issues.join(),/目录外/);
  } finally {for(const p of made.reverse())fs.rmSync(p,{recursive:true,force:true});}
});

test('skills view does not enumerate outside directories through the Claude project root link',async()=>{
  const links=path.join(root,'.claude/skills'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'phd-claude-outside-')),saved=path.join(root,'.runtime/claude-original-links');
  const existed=fs.existsSync(links);
  try {
    if(existed)fs.renameSync(links,saved);else fs.mkdirSync(path.dirname(links),{recursive:true});
    fs.mkdirSync(path.join(outside,'private-skill-name'));fs.symlinkSync(outside,links,'junction');
    const view=await skillsView();assert.ok(view.problems.some(p=>p.includes('指向办公室外')));
    assert.ok(!JSON.stringify(view).includes('private-skill-name'),'external skill names are not scanned or exposed');
  } finally {
    fs.rmSync(links,{recursive:true,force:true});if(existed)fs.renameSync(saved,links);
    assert.equal(path.dirname(outside),path.resolve(os.tmpdir()));assert.ok(path.basename(outside).startsWith('phd-claude-outside-'));
    fs.rmSync(outside,{recursive:true,force:true});
  }
});

test('daily backups include project skills and pre-edit copies, while same-day rollback retains the old bytes',()=>{
  const skill=path.join(root,'.agents/skills/t-backup'),saved=path.join(root,'.runtime/skill-edits/t-backup/2097-01-01T120000Z');
  const days=['2097-01-01','2097-01-02'];
  try {
    fs.mkdirSync(skill,{recursive:true});fs.mkdirSync(path.join(skill,'references'));
    fs.writeFileSync(path.join(skill,'SKILL.md'),'original skill');fs.writeFileSync(path.join(skill,'references/source.md'),'source');
    fs.mkdirSync(path.dirname(saved),{recursive:true});fs.cpSync(skill,saved,{recursive:true});
    fs.writeFileSync(path.join(skill,'SKILL.md'),'revised skill');
    assert.equal(fs.readFileSync(path.join(saved,'SKILL.md'),'utf8'),'original skill');
    backupData({now:new Date(days[0]+'T12:00:00Z'),keep:10000});
    for(const relative of ['.agents/skills/t-backup/SKILL.md','.agents/skills/t-backup/references/source.md','.runtime/skill-edits/t-backup/2097-01-01T120000Z/SKILL.md'])
      assert.deepEqual(fs.readFileSync(path.join(root,'.runtime/backups',days[0],relative)),fs.readFileSync(path.join(root,relative)));
    fs.writeFileSync(path.join(skill,'SKILL.md'),'later revision');
    assert.equal(backupData({now:new Date(days[0]+'T18:00:00Z'),keep:10000}).skipped,true);
    backupData({now:new Date(days[1]+'T12:00:00Z'),keep:10000});
    assert.equal(fs.readFileSync(path.join(root,'.runtime/backups',days[1],'.agents/skills/t-backup/SKILL.md'),'utf8'),'later revision');
    assert.equal(fs.readFileSync(path.join(saved,'SKILL.md'),'utf8'),'original skill');
  } finally {
    for(const p of [skill,path.dirname(saved),...days.map(day=>path.join(root,'.runtime/backups',day))])fs.rmSync(p,{recursive:true,force:true});
  }
});

test('HTTP and UI: /api/skills serves the view and the 技能 page (under 更多, not settings) renders it, including the empty state',{timeout:120000},async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  let browser;const dir=path.join(root,'.agents/skills/t-ui'),link=path.join(root,'.claude/skills/t-ui');
  try {
    const view=await (await fetch(base+'/api/skills')).json();assert.ok(Array.isArray(view.skills)&&Array.isArray(view.problems));assert.equal(view.location,'.agents/skills');
    browser=await launchEdge();const page=await (await browser.newContext({viewport:{width:1300,height:900}})).newPage();
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(base);await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="connections"]').click();
    assert.equal(await page.locator('[data-settings-tab="skills"]').count(),0,'skills no longer live in settings');
    await page.locator('.more-tab[data-page="skills"]').click();await page.locator('[data-skills-body]').filter({hasText:'新建约定'}).waitFor();
    if(!view.skills.length)assert.match(await page.locator('[data-skills-body]').textContent(),/目前没有自建 skill/);
    await page.locator('.more-tab[data-page="connections"]').click();await page.locator('[data-settings-tab="models"]').click();await page.locator('[id="set-reasoning_effort"]').selectOption('low');
    fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(dir,link,'junction');
    const content='---\nname: t-ui\ndescription: 当需要核对只读技能视图时使用\n---\n# 只读验收\n\n依据：隔离测试构造的虚构流程。\n适用条件：只读界面验收。\n验证范围：目录、HTTP、正文展示。\n<script>window.skillInjected=true</script>\n'+('long-path/'.repeat(25));
    fs.writeFileSync(path.join(dir,'SKILL.md'),content);
    await page.locator('.more-tab[data-page="skills"]').click();
    const card=page.locator('.skill-card').filter({hasText:'t-ui'});await card.waitFor();
    assert.match(await card.textContent(),/正文估算/);assert.match(await card.textContent(),/Codex 本体在位/);assert.match(await card.textContent(),/Claude 链接有效/);
    await card.locator('summary').click();assert.equal(await card.locator('pre').textContent(),content);
    assert.equal(await page.evaluate(()=>window.skillInjected),undefined,'skill content is displayed as text, never HTML or code');
    const api=await (await fetch(base+'/api/skills')).json();assert.equal(api.skills.find(s=>s.dir==='t-ui').content,content);
    assert.equal((await fetch(base+'/api/skills',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404,'skills endpoint is read-only');
    const screenshots=path.join(root,'.runtime/settings-review');fs.mkdirSync(screenshots,{recursive:true});
    await page.screenshot({path:path.join(screenshots,'skills.png')});
    await page.setViewportSize({width:600,height:1000});await page.screenshot({path:path.join(screenshots,'skills-narrow.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no horizontal overflow on narrow screens');
    await page.locator('.more-tab[data-page="connections"]').click();
    await page.waitForLoadState('networkidle'); // An immediate check can pass before an unintended reload erases the draft.
    assert.equal(await page.locator('[id="set-reasoning_effort"]').inputValue(),'low','visiting the skills page preserves unsaved settings');
  } finally {await browser?.close();await new Promise(r=>server.close(r));fs.rmSync(link,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});

test('model options: Codex lists come from its own cache without hidden entries, Claude gets aliases, and the configured value is always selectable',()=>withConfig(()=>{
  const dir=fs.mkdtempSync(path.join(root,'.runtime/settings-models-')),file=path.join(dir,'models_cache.json');
  fs.writeFileSync(file,JSON.stringify({identity:{secret:'must not be read'},models:[{slug:'m-visible',display_name:'M Visible',visibility:'list'},{slug:'m-hidden',visibility:'hide'},{slug:'bad name!',visibility:'list'}]}));
  const saved=process.env.PHD_CODEX_MODELS_CACHE;process.env.PHD_CODEX_MODELS_CACHE=file;
  try {
    saveSettings({codex_model:'custom-codex-model'});
    const by=Object.fromEntries(settingsView().fields.filter(f=>f.type==='model').map(f=>[f.key,f.options.map(o=>o.value)]));
    assert.deepEqual(by.codex_model,['m-visible','custom-codex-model'],'hidden and malformed entries are dropped; the current value is appended');
    assert.deepEqual(by.mail_screen_model.slice(0,1),['m-visible']);
    assert.deepEqual(by.claude_model.slice(0,4),['sonnet','opus','haiku','fable']);assert.ok(['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5','claude-fable-5-1'].every(id=>by.claude_model.includes(id)),'current full IDs are offered');assert.equal(new Set(by.claude_model).size,by.claude_model.length,'no duplicates');
    assert.ok(by.title_model.includes(read('agent/config.json').title_model),'the current title model stays selectable');
    assert.ok(!JSON.stringify(settingsView()).includes('must not be read'),'nothing but slugs and names leaves the cache');
    process.env.PHD_CODEX_MODELS_CACHE=path.join(dir,'missing.json');
    assert.deepEqual(settingsView().fields.find(f=>f.key==='codex_model').options.map(o=>o.value),['custom-codex-model'],'no cache: only the current value');
  } finally {
    if(saved===undefined)delete process.env.PHD_CODEX_MODELS_CACHE;else process.env.PHD_CODEX_MODELS_CACHE=saved;
    fs.rmSync(dir,{recursive:true,force:true});
  }
}));

test('a model must belong to the side that calls it, and the title model follows the title provider',()=>withConfig(before=>{
  // Start from a known side regardless of which provider the live config currently uses for titles (withConfig restores it afterwards).
  write('agent/config.json',{...before,title_provider:'claude',title_model:'claude-haiku-5-5'});
  const bytes=fs.readFileSync(path.join(root,'agent/config.json'));
  assert.equal(read('agent/config.json').title_provider,'claude');
  assert.throws(()=>saveSettings({title_provider:'codex'}),/标题模型.*Claude 一侧.*同时改标题模型/);
  assert.throws(()=>saveSettings({codex_model:'sonnet'}),/Codex 模型.*Claude 一侧/);
  assert.throws(()=>saveSettings({mail_screen_model:'opus'}),/邮件粗筛模型.*Claude 一侧/);
  assert.throws(()=>saveSettings({claude_model:'gpt-6-luna'}),/Claude 模型.*Codex 一侧/);
  assert.deepEqual(fs.readFileSync(path.join(root,'agent/config.json')),bytes,'every rejected save left the file alone');
  saveSettings({title_provider:'codex',title_model:'gpt-6-luna'});
  assert.equal(read('agent/config.json').title_provider,'codex');
  assert.throws(()=>saveSettings({title_model:'claude-haiku-5-5'}),/标题模型.*Claude 一侧/);
  assert.throws(()=>saveSettings({title_provider:'claude'}),/标题模型.*Codex 一侧/);
  assert.equal(saveSettings({claude_model:'opus[1m]'}).changed[0],'claude_model');
  const title=settingsView().fields.find(f=>f.key==='title_model');
  assert.equal(title.follows,'title_provider');assert.ok(title.options_by.claude.some(o=>o.value==='claude-haiku-5-5') && title.options_by.codex.every(o=>!/^claude/.test(o.value)));
  assert.equal(title.defaults_by.codex,'gpt-6-luna');
}));

test('max_active_agents is a persisted, audited 1-10 setting separate from subagents',()=>withConfig(()=>{
  const field=settingsView().fields.find(f=>f.key==='max_active_agents');
  assert.equal(field.group,'models');assert.equal(field.min,1);assert.equal(field.max,10);
  for(const limit of [1,10]){saveSettings({max_active_agents:limit});assert.equal(read('agent/config.json').max_active_agents,limit);}
  for(const value of [0,11,1.5,'2',null])assert.throws(()=>saveSettings({max_active_agents:value}),/整数|之间/);
  assert.ok(fs.readFileSync(logFile,'utf8').includes('max_active_agents'));
}));
