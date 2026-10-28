import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {root,read,write} from '../automation/files.mjs';
import {newRun,foldEvent} from '../agent/claude.mjs';
import {submit,execute as executeAgent,agentSnapshot} from '../agent/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {executionRows,runningSubagents} from './activity.mjs';
import {toolSummary} from '../agent/tool-summary.mjs';
import {renderExecutions} from './workspace.js';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --activity --keep');
const execute=executeWithoutTitle(executeAgent),store='.runtime/agent/sessions.json';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function isolated(fn){
  const files=[store,'work/queue.json','agent/config.json'],before=Object.fromEntries(files.map(f=>[f,read(f)]));
  try{await fn();}finally{for(const [f,data] of Object.entries(before))write(f,data);}
}

test('Claude real event shapes update one pending call through repeated heartbeats and its actual return',()=>isolated(async()=>{
  const job=submit({text:'@Claude fixture tool lifecycle'}),run=newRun('fixture');
  let events;
  const started=gate(),finish=gate();
  const pending=execute(job.task_id,async(_,prompt,opts)=>{
    events=e=>foldEvent(run,e,{onEvent:opts.onEvent});
    events({type:'assistant',message:{content:[{type:'tool_use',id:'one',name:'Bash',input:{command:'fixture'}},{type:'tool_use',id:'two',name:'Read',input:{}}]}});
    started.resolve();await finish.promise;return {result:'Fixture finished'};
  });
  await started.promise;
  try{
    for(let i=0;i<65;i++)events({type:'tool_progress',tool_use_id:`one-heartbeat-${i}`,parent_tool_use_id:'one',elapsed_time_seconds:(i+1)*30,heartbeat:true});
    let state=agentSnapshot(),session=state.sessions.find(s=>s.id===job.session_id);
    assert.equal(session.activity.filter(e=>e.type==='tool').length,2,'heartbeats must not evict starts or grow the store');
    const calls=()=>executionRows(agentSnapshot(),read('work/queue.json').items).filter(r=>r.task_id===job.task_id && r.status==='running');
    assert.equal(calls().length,2);assert.equal(calls()[0].provider,'claude');assert.ok(calls()[0].heartbeat_at);
    events({type:'user',message:{content:[{type:'tool_result',tool_use_id:'two',content:'done'}]}});
    assert.deepEqual(calls().map(t=>t.tool_id),['one'],'a parallel return cannot complete the other call');
    events({type:'user',message:{content:[{type:'tool_result',tool_use_id:'one',content:'error',is_error:true}]}});
    events({type:'tool_progress',tool_use_id:'one-heartbeat-66',parent_tool_use_id:'one',elapsed_time_seconds:2010,heartbeat:true});
    state=agentSnapshot();session=state.sessions.find(s=>s.id===job.session_id);
    assert.equal(session.activity.find(e=>e.tool_id==='one').status,'failed');
    assert.equal(calls().length,0,'late heartbeats never revive a returned tool');
    events({type:'assistant',message:{content:[{type:'tool_use',id:'unconfirmed',name:'Read',input:{}}]}});
  }finally{finish.resolve();await pending;}
  assert.equal(executionRows(agentSnapshot(),read('work/queue.json').items).filter(r=>r.task_id===job.task_id && r.status==='running').length,0);
  const unconfirmed=agentSnapshot().sessions.find(s=>s.id===job.session_id).activity.find(e=>e.tool_id==='unconfirmed');
  assert.equal(unconfirmed.status,'unknown');assert.equal(unconfirmed.finished_at,undefined,'turn end is not a fabricated tool return');
}));

test('Claude background agents outlive launch returns, deduplicate, survive tool history and clear on completion/stop',()=>isolated(async()=>{
  const job=submit({text:'@Claude fixture child lifecycle'}),run=newRun('fixture'),started=gate(),finish=gate();let event;
  const pending=execute(job.task_id,async(_,prompt,opts)=>{
    event=e=>foldEvent(run,e,{onEvent:opts.onEvent});started.resolve();await finish.promise;return {result:'Fixture finished'};
  });
  await started.promise;
  const children=()=>runningSubagents(agentSnapshot(),read('work/queue.json').items).filter(r=>r.task_id===job.task_id);
  try{
    const start={type:'system',subtype:'task_started',task_type:'local_agent',task_id:'child-a',tool_use_id:'launch-a',is_backgrounded:true};
    event(start);event(start);
    event({type:'user',message:{content:[{type:'tool_result',tool_use_id:'launch-a',content:'Background agent launched'}]}});
    event({...start,task_id:'child-b',tool_use_id:'launch-b'});
    event({...start,task_type:'local_bash',task_id:'bash-not-agent'});
    for(let i=0;i<65;i++){
      event({type:'assistant',message:{content:[{type:'tool_use',id:'read-'+i,name:'Read',input:{}}]}});
      event({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-'+i,content:'done'}]}});
    }
    await delay(1100); // Activity batches are persisted on the existing one-second timer.
    assert.deepEqual(children().map(r=>r.agent_id),['child-a','child-b']);
    event({type:'system',subtype:'task_notification',task_id:'child-a',status:'completed'});
    await delay(1100);
    assert.deepEqual(children().map(r=>r.agent_id),['child-b']);
    const q=read('work/queue.json');q.items.find(i=>i.id===job.task_id).status='cancelled';write('work/queue.json',q);
    assert.equal(children().length,0,'stopped parent must never advertise live children');
  }finally{finish.resolve();await pending;}
  assert.equal(children().length,0);
}));

test('activity is per tool, all pending calls survive the six-history limit, and empty sessions invent no activity',()=>{
  const at='2026-10-15T12:00:00Z';
  const items=Array.from({length:14},(_,i)=>({id:String(i),title:'Fixture '+i,status:i<7?'active':['done','failed','cancelled','waiting_user'][i%4],created_at:at}));
  const agent={sessions:items.map(i=>({id:'s'+i.id,task_ids:[i.id],activity:[{type:'tool',task_id:i.id,name:'Bash',tool_id:'old',at},
    ...Array.from({length:6},(_,j)=>({type:'tool',task_id:i.id,name:'Read',provider:'codex',tool_id:'t'+j,at,status:'running'}))]})),active_turns:[]};
  const rows=executionRows(agent,items);
  assert.equal(rows.length,48);assert.equal(rows.filter(r=>r.status==='running').length,42);
  assert.equal(rows.filter(r=>r.task_id==='0' && r.status==='running').length,6);
  assert.equal(rows.filter(r=>r.status!=='running').length,6);
  agent.sessions.push({id:'empty',task_ids:['empty'],activity:[]});items.push({id:'empty',status:'active'});
  assert.equal(executionRows(agent,items).some(r=>r.task_id==='empty'),false);
  agent.sessions[0].activity=agent.sessions[0].activity.slice(0,1);
  assert.equal(executionRows(agent,items).some(r=>r.task_id==='0' && r.status==='running'),false,'an old start-only record has unknown status');
  items[0].merged_into='1';items[1].deleted_at=at;
  assert.equal(executionRows(agent,items).filter(r=>r.status==='running').length,30);
  items[2].status='done';agent.sessions[2].messages=[{role:'assistant',task_id:'2',provider:'claude'}];
  const handed=executionRows(agent,items).find(r=>r.task_id==='2' && r.tool_id==='t0');
  assert.equal(handed.provider,'codex','a later assistant answer must not reattribute an earlier tool activity');
});

test('yellow begins at three minutes, does not reset on a heartbeat, and ends on tool return',()=>{
  const at='2026-10-15T12:00:00Z',now=Date.parse(at)+180000;
  const row={task_id:'x',session_id:'s',task_title:'Fixture session',summary:'<fixture>',provider:'codex',status:'running',tool_id:'t',name:'fixture_tool',at};
  assert.doesNotMatch(renderExecutions([row],now-1),/activity-warning/);
  row.heartbeat_at=new Date(now).toISOString();
  assert.match(renderExecutions([row],now),/activity-warning/);assert.match(renderExecutions([row],now),/等待返回 3 分 0 秒/);
  assert.match(renderExecutions([row],now),/&lt;fixture&gt;/);assert.doesNotMatch(renderExecutions([row],now),/<fixture>/);
  row.status='completed';row.finished_at=new Date(now).toISOString();
  assert.doesNotMatch(renderExecutions([row],now),/activity-warning/);assert.match(renderExecutions([row],now),/工具已返回/);
  assert.match(renderExecutions(undefined),/重启后端/);
  assert.match(renderExecutions([{tools:[]}]),/重启后端/,'old task-summary payload requests a reload rather than rendering duplicate session cards');
});

test('tool descriptions expose useful files and command identity without script/message/credential bodies',()=>{
  assert.equal(toolSummary('Read',{file_path:'dashboard/server.mjs',text_content:'PRIVATE_BODY'}),'读取文件 · dashboard/server.mjs');
  assert.equal(toolSummary('Bash',{description:'核对采购回信',command:'private'}),'核对采购回信');
  assert.equal(toolSummary('commandExecution',{command:'node scripts/run-tests.mjs --activity --keep'}),'运行隔离测试 · --activity --keep');
  assert.equal(toolSummary('commandExecution',{command:'node automation/run.mjs mail guide'}),'办公室命令 · mail guide');
  assert.equal(toolSummary('commandExecution',{command:'"powershell.exe" -Command \'Get-Content -LiteralPath "dashboard/server.mjs" -Encoding utf8\''}),'读取文件 · dashboard/server.mjs');
  assert.equal(toolSummary('fileChange',{changes:[{path:'dashboard/app.js'}]}),'修改文件 · dashboard/app.js');
  assert.equal(toolSummary('commandExecution',{commandActions:[{type:'read',path:'docs/source.md'}],command:'private'}),'读取文件 · docs/source.md');
  for(const input of [{command:'curl --token PRIVATE_TOKEN'},{command:'node --input-type=module -e "PRIVATE_SCRIPT"'},{command:'line1\nPRIVATE_SCRIPT'},
    {url:'https://user:PRIVATE_PASSWORD@example.org/path/PRIVATE_TOKEN?token=PRIVATE_TOKEN'},{description:'token=PRIVATE_TOKEN',command:'curl'}]){
    assert.doesNotMatch(toolSummary('fixture',input),/PRIVATE|user:/);
  }
});

test('real HTTP and Edge rail show task ownership, elapsed tools, heartbeat caveat and return transitions',()=>isolated(async()=>{
  const at='2026-10-15T12:00:00Z',items=[
    {id:'live-codex',title:'测量数据 <并非标签>',actor:'codex',status:'active',created_at:at},
    {id:'live-claude',title:'检查采购回信',actor:'claude',status:'active',created_at:at},
    {id:'done',title:'已经交付',actor:'codex',status:'done',created_at:at,completed_at:at}];
  const session=i=>({id:'s-'+i.id,title:i.title,origin:'chat',task_ids:[i.id],project_ids:[],created_at:at,messages:[{role:'user',text:'Fixture request',task_id:i.id,at}],activity:[
    {type:'tool',tool_id:'tool-'+i.id,task_id:i.id,provider:i.actor,name:i.actor==='claude'?'Bash':'commandExecution',at,status:'running',
      summary:i.actor==='claude'?'读取文件 · procurement/quote.txt':'运行隔离测试 · --activity --keep',
      detail:'PRIVATE_COMMAND_MUST_NOT_TRAVEL',...(i.actor==='claude'?{heartbeat_at:new Date(Date.parse(at)+160000).toISOString()}:{} ),
      ...(i.status==='done'?{status:'completed',finished_at:new Date(Date.parse(at)+1000).toISOString(),summary:'读取文件 · docs/results.md'}:{})}]});
  write('work/queue.json',{...read('work/queue.json'),items});write(store,{sessions:items.map(session)});
  const fixture=read(store);
  for(const s of fixture.sessions)for(let i=0;i<(s.id==='s-live-codex'?2:1);i++)s.activity.push({type:'subagent',agent_id:s.id+'-child-'+i,task_id:s.task_ids[0],provider:items.find(t=>t.id===s.task_ids[0]).actor,status:'running',at});
  write(store,fixture);
  let server,browser;
  try{
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const http=await fetch(base+'/api/state?page=chat'),payload=await http.json();assert.equal(http.status,200);
    assert.equal(payload.agent.executions.length,3);assert.doesNotMatch(JSON.stringify(payload.agent.executions),/PRIVATE_COMMAND/);
    assert.equal(payload.agent.subagents.length,3,'completed parent children are excluded');
    const module=await fetch(base+'/workspace.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
    assert.match(await module.text(),/export function renderExecutions/);
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date(Date.parse(at)+170000)});
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.route('**/api/usage/refresh',route=>route.fulfill({json:{}}));
    await page.goto(base);const rail=page.locator('#activity');await rail.locator('[data-execution-task="live-codex"]').waitFor();
    assert.equal(await rail.locator('.activity-item').count(),3);
    assert.ok((await rail.innerText()).includes('Codex'));assert.ok((await rail.innerText()).includes('Claude'));
    assert.match(await rail.innerText(),/运行隔离测试/);assert.match(await rail.innerText(),/procurement\/quote.txt/);
    assert.doesNotMatch(await rail.innerText(),/测量数据|检查采购回信|已经交付/,'task/session titles are navigation context, not the activity content');
    assert.equal(await rail.locator('.activity-warning').count(),0);
    await rail.locator('[data-execution-task="live-codex"] [data-session]').click();
    await page.waitForFunction(()=>document.querySelector('.task-running')?.textContent.includes('Codex · 进行中 · 子 agent 2 个'));
    const changed=read(store);changed.sessions[0].activity.find(e=>e.type==='subagent').status='completed';write(store,changed);
    await page.clock.fastForward(5000);
    await page.waitForFunction(()=>document.querySelector('.task-running')?.textContent.includes('子 agent 1 个'));
    changed.sessions[0].activity.filter(e=>e.type==='subagent').forEach(e=>e.status='completed');write(store,changed);
    await page.clock.fastForward(5000);
    await page.waitForFunction(()=>!document.querySelector('.task-running')?.textContent.includes('子 agent'));
    await rail.locator('[data-execution-task="live-claude"] [data-session]').click();
    await page.waitForFunction(()=>document.querySelector('.task-running')?.textContent.includes('Claude · 进行中 · 子 agent 1 个'));
    const badgeDir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(badgeDir,{recursive:true});
    await page.locator('.task-running').screenshot({path:path.join(badgeDir,'subagent-badge.png')});
    await page.waitForFunction(()=>document.querySelectorAll('#activity .activity-warning').length===2);
    assert.match(await rail.innerText(),/长时间未返回/);assert.match(await rail.innerText(),/心跳/);
    assert.doesNotMatch(await rail.locator('[data-execution-task="done"]').innerText(),/等待返回/);
    const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});
    await rail.screenshot({path:path.join(dir,'execution-rail.png')});
    const data=read(store);data.sessions[0].activity[0].status='completed';data.sessions[0].activity[0].finished_at=new Date(Date.parse(at)+180000).toISOString();write(store,data);
    await page.clock.fastForward(5000);await page.waitForFunction(()=>document.querySelector('[data-execution-task="live-codex"]').textContent.includes('工具已返回'));
    assert.equal(await rail.locator('.activity-warning').count(),1);
    const q=read('work/queue.json');q.items[1].status='cancelled';write('work/queue.json',q);await page.clock.fastForward(5000);
    await page.waitForFunction(()=>document.querySelectorAll('#activity .activity-warning').length===0);
    await rail.locator('[data-execution-task="live-codex"] [data-session]').click();assert.equal(await page.locator('#session-title').innerText(),items[0].title);
    await page.setViewportSize({width:1100,height:900});await rail.locator('[data-execution-task="live-codex"]').waitFor();
    const overflow=await rail.evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);
    // The office may still run the old backend until this very task finishes.
    // Refreshing during that window must keep chat usable, not break on a new asset.
    await page.route('**/api/state?**',async route=>{
      const response=await route.fetch(),json=await response.json();delete json.agent.executions;await route.fulfill({response,json});
    });
    await page.reload();await rail.getByText('活动详情需在任务结束后重启后端加载。',{exact:true}).waitFor();
    assert.equal(await page.locator('#message').isEnabled(),true);
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));}
}));
