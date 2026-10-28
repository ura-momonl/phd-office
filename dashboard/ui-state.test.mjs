import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer,snapshot} from './server.mjs';
import {splitState} from './ui-state.mjs';
import {agentUpdates,projectsView,sessionOf} from './workspace.js';
import {launchEdge} from '../automation/browser-launch.mjs';
import {agentSnapshot,titleSession,titleDue,draftTitle,submit,stop,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {migrateSessionBaselines,loadBaseline} from '../agent/file-baselines.mjs';
import {inboxItems} from './inbox.mjs';
import {createApp,openSession,drawFrame} from '../tui/app.mjs';
import {strip} from '../tui/text.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs in a sanitised copy');

async function office(fn){
  const files=['.runtime/agent/sessions.json','work/queue.json','agent/config.json'],before=Object.fromEntries(files.map(f=>[f,read(f)]));
  const at='2026-10-12T12:00:00Z',project='graphene-thz',tail='needle-hidden-at-end',long='Fixture record. '.repeat(900);
  const task=(id,status='done')=>({id,title:'Fixture '+id,kind:'misc',actor:'codex',executor:'codex',project_ids:[project],status,dependencies:[],outputs:[],
    created_at:at,completed_at:status==='done'?at:undefined,goal:long+' full-goal',handoff:long+' full-handoff',brief:{summary:'Complete handoff',facts:[],open:[],next:'Next fixture step'},history:[{text:long}],sources:[long]});
  const items=[task('a'),task('b','queued'),task('c'),...Array.from({length:35},(_,i)=>task('extra-'+i))];
  const session=(id,origin,text)=>({id,title:'Conversation '+id,origin,project_ids:[project],task_ids:[id],created_at:at,messages:[
    {role:'user',text:long+text,at,task_id:id,attachments:[{id:'fixture-'+id,kind:'file',name:id+'-deep-attachment.pdf',size:8,mime:'application/octet-stream',path:'.runtime/agent/files/fixture-'+id+'.pdf'}],inbox_reply:{id:'mail:fixture-'+id}},
    {role:'assistant',provider:'codex',text:'Final reply '+id,at,task_id:id},
    {role:'assistant',provider:'codex',text:'Interim only',interim:true,at,task_id:id},
    ...(id==='a'?['claude','codex'].map(provider=>({role:'assistant',provider,text:'Said by a '+provider+' helper',interim:true,subagent:true,at,task_id:id})):[])]});
  const sessions=[session('a','chat',' original-a'),session('b','task',tail),session('c','chat',tail)];
  let server;
  try{
    write('agent/config.json',{...before['agent/config.json'],enabled:false});write('work/queue.json',{...before['work/queue.json'],items});
    fs.mkdirSync(path.join(root,'.runtime/agent/files'),{recursive:true});
    for(const id of ['a','b','c'])fs.writeFileSync(path.join(root,'.runtime/agent/files/fixture-'+id+'.pdf'),'fixture!');
    write('.runtime/agent/sessions.json',{sessions});
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    let full;
    await fn({base:'http://127.0.0.1:'+server.address().port,get full(){return full ??= snapshot();},sessions,items,project,tail});
  }finally{
    if(server)await new Promise(r=>server.close(r));for(const [file,value] of Object.entries(before))write(file,value);
  }
}

test('scoped board carries repeat operations and unfinished submissions with their parent, not separate run cards',()=>office(async({base})=>{
  const at='2026-10-26T12:00:00Z';
  const item=(id,status,extra={})=>({id,title:id,kind:'data',actor:'codex',status,project_ids:[],dependencies:[],outputs:[],handoff:'',created_at:at,...extra});
  const parent=item('projection-parent','done');
  const repeated=item('projection-repeated','done',{parent_id:parent.id,outputs:['workspace/original-result.csv']});
  const unfinished=item('projection-unfinished','open',{parent_id:parent.id});
  const untouched=item('projection-untouched','open');
  const active=item('projection-active-run','active',{operation_id:repeated.id,executor:'codex',created_at:'2026-10-26T12:01:00Z'});
  const ended=item('projection-ended-run','done',{operation_id:unfinished.id,executor:'codex',outcome_status:'open',created_at:'2026-10-26T12:02:00Z',completed_at:'2026-10-26T12:03:00Z'});
  write('work/queue.json',{...read('work/queue.json'),items:[parent,repeated,unfinished,untouched,active,ended]});
  const board=await (await fetch(base+'/api/state?page=board')).json();
  assert.deepEqual(board.work.items.map(i=>i.id).sort(),[parent.id,repeated.id,unfinished.id].sort());
  const repeatView=board.work.items.find(i=>i.id===repeated.id),unfinishedView=board.work.items.find(i=>i.id===unfinished.id);
  assert.equal(repeatView.status,'done');assert.deepEqual(repeatView.outputs,repeated.outputs);
  assert.equal(repeatView.last_execution.status,'active');assert.equal(repeatView.execution_history[0].id,active.id);
  assert.equal(unfinishedView.status,'open');assert.equal(unfinishedView.last_execution.outcome_status,'open');
  assert.equal(unfinishedView.execution_history[0].status,'done');
  const chat=await (await fetch(base+'/api/state?page=chat')).json();
  assert.ok(chat.work.items.some(i=>i.id===repeated.id),'the shared rail can count a running repeat whose original operation stays done');
  assert.ok(chat.work.items.some(i=>i.id===parent.id),'the repeat carries its parent ownership title');
  assert.equal(read('work/queue.json').items.find(i=>i.id===repeated.id).status,'done','projection does not alter the saved completion');
}));

test('real scoped HTTP state restores the bound folder in the TUI and keeps unbound sessions unbound',()=>office(async({base,sessions})=>{
  const workdir='D:/research/材料项目';
  sessions[0].workdir=workdir;
  write('.runtime/agent/sessions.json',{sessions});
  const before=read('.runtime/agent/sessions.json');
  const index=await (await fetch(base+'/api/state?page=chat')).json();
  assert.equal(index.agent.sessions.find(s=>s.id==='a').workdir,workdir);
  assert.equal(index.agent.sessions.find(s=>s.id==='c').workdir,undefined);
  const port=process.env.PHD_DASHBOARD_PORT;
  process.env.PHD_DASHBOARD_PORT=new URL(base).port;
  try{
    const app=createApp({cols:130,rows:34,launchDir:'D:/other/Launch',prefs:{session:'a',workdirs:{a:'D:/wrong/Stale',c:workdir}}});
    await openSession(app,'a');
    assert.match(strip(drawFrame(app)[0]),/▣ 材料项目/);
    assert.doesNotMatch(strip(drawFrame(app)[0]),/Stale|Launch/);
    await openSession(app,'c');
    assert.doesNotMatch(strip(drawFrame(app)[0]),/▣|材料项目|Launch/);
    await openSession(app,'a');
    assert.match(strip(drawFrame(app)[0]),/▣ 材料项目/);
    assert.deepEqual(read('.runtime/agent/sessions.json'),before,'opening sessions must not rewrite their directory binding');
    const prefs=JSON.parse(fs.readFileSync(path.join(root,'.runtime/tui/prefs.json'),'utf8'));
    assert.equal(prefs.workdirs,undefined,'directory bindings no longer persist in TUI preferences');
  }finally{
    if(port===undefined)delete process.env.PHD_DASHBOARD_PORT;else process.env.PHD_DASHBOARD_PORT=port;
  }
}));

test('session view reuses parsing but reads fresh bytes, isolates caller edits, and rejects broken external stores',()=>{
  const name='.runtime/agent/sessions.json',file=path.join(root,name),before=fs.readFileSync(file),cfg=read('agent/config.json');
  const oldParse=JSON.parse;let parses=0;
  const data={sessions:[{id:'cache-fixture',title:'alpha',project_ids:[],task_ids:[],messages:[{role:'user',text:'完整中文与 emoji 🌿',at:'2026-10-12T12:00:00Z'}],
    file_snapshots:{codex:{files:{internal:'private-baseline'}}},codex_continuation:{threadId:'kept-thread',seen:[0],fileSnapshot:{files:{internal:'private-legacy-baseline'}}}}]};
  try{
    write(name,data);JSON.parse=function(text,...args){if(typeof text==='string' && text.includes('cache-fixture'))parses++;return oldParse.call(this,text,...args);};
    const first=agentSnapshot(),second=agentSnapshot();assert.equal(parses,1,'unchanged bytes must not repeatedly parse the large store');
    assert.deepEqual(first,second);assert.notEqual(first.sessions[0].messages,second.sessions[0].messages);
    assert.equal(first.sessions[0].file_snapshots,undefined);assert.equal(first.sessions[0].codex_continuation.fileSnapshot,undefined);
    first.sessions[0].messages[0].text='caller changed it';first.sessions[0].codex_continuation.seen.push(99);
    const next=agentSnapshot();assert.equal(next.sessions[0].messages[0].text,data.sessions[0].messages[0].text);assert.deepEqual(next.sessions[0].codex_continuation.seen,[0]);
    const time=fs.statSync(file).mtime,raw=fs.readFileSync(file,'utf8');
    fs.writeFileSync(file,raw.replace('alpha','bravo'));fs.utimesSync(file,time,time);
    assert.equal(agentSnapshot().sessions[0].title,'bravo','same-length external edit with preserved mtime must still be seen');assert.equal(parses,2);
    write('agent/config.json',{...cfg,cache_fixture_flag:true});assert.equal(agentSnapshot().config.cache_fixture_flag,true,'configuration stays live even when sessions do not change');
    fs.writeFileSync(file,'{broken');assert.throws(()=>agentSnapshot(),SyntaxError,'invalid current bytes must never silently return an older good view');
    fs.unlinkSync(file);assert.deepEqual(agentSnapshot().sessions,[]);
    fs.writeFileSync(file,'\uFEFF'+raw);assert.equal(agentSnapshot().sessions[0].title,'alpha','missing/recreated store and BOM remain supported');
  }finally{JSON.parse=oldParse;fs.writeFileSync(file,before);write('agent/config.json',cfg);}
});

test('snapshot shares one freshly read session view with inbox instead of parsing the private store again',()=>office(async({full})=>{
  const oldRead=fs.readFileSync;let reads=0;
  try{
    fs.readFileSync=function(file,...args){if(String(file)===path.join(root,'.runtime/agent/sessions.json'))reads++;return oldRead.call(this,file,...args);};
    const state=snapshot();assert.equal(reads,1,'one UI snapshot must read the actual session bytes once');
    fs.readFileSync=oldRead;
    const at=new Date('2026-10-12T12:00:00Z');
    assert.deepEqual(inboxItems(full.mail.tasks,full.work.items,full.links,at),inboxItems(full.mail.tasks,full.work.items,full.links,at,false,agentSnapshot().sessions));
    assert.deepEqual(state.agent.sessions.map(s=>s.messages),full.agent.sessions.map(s=>s.messages));
  }finally{fs.readFileSync=oldRead;}
}));

test('scoped state carries indexes, complete selected bodies and exact page details without changing stores',()=>office(async({base,full,sessions,project,tail})=>{
  const original=read('.runtime/agent/sessions.json'),queue=read('work/queue.json');
  const json=async url=>{const r=await fetch(base+url),data=await r.json();assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.status,200,data.error);return data;};
  const legacy=await json('/api/state');assert.deepEqual(legacy.agent.sessions.map(s=>s.messages),full.agent.sessions.map(s=>s.messages));
  const initial=await json('/api/state?page=chat'),chat=await json('/api/state?page=chat&session=a');
  assert.ok(initial.agent.sessions.every(s=>s.messages===undefined),'a new chat must not download historical bodies');
  assert.deepEqual(chat.agent.sessions.find(s=>s.id==='a').messages,sessions[0].messages,'selected body and attachments must be byte-for-byte complete');
  const attachment=await fetch(base+'/api/chat/file?id=fixture-a');assert.equal(attachment.status,200);assert.equal(await attachment.text(),'fixture!');
  assert.equal(chat.agent.sessions.find(s=>s.id==='b').messages,undefined);
  assert.equal(chat.agent.sessions.find(s=>s.id==='a').message_count,2,'interim rows do not inflate the history count');
  assert.equal(chat.agent.sessions.find(s=>s.id==='a').last_at,sessions[0].messages.at(-1).at);
  assert.equal(initial.work.items[0].handoff,undefined);
  assert.equal(chat.work.items.find(i=>i.id==='a').brief.next,'Next fixture step','the selected chat ships its task brief for display');
  assert.equal(chat.work.items.find(i=>i.id==='c')?.brief,undefined,'other tasks stay slim');assert.equal(initial.work.items.find(i=>i.id==='a')?.brief,undefined);
  assert.ok(JSON.stringify(initial).length<JSON.stringify(legacy).length*.55,'fixture must demonstrate an actual payload split');
  for(const page of ['projects'])assert.deepEqual((await json('/api/state?page='+page)).work.items,full.work.items);
  assert.deepEqual((await json('/api/state?page=usage')).usage,full.usage);
  const tasks=await json('/api/state?page=tasks&q='+tail);assert.deepEqual(tasks.task_search_ids,['b'],'task search must inspect text beyond the index preview');
  assert.deepEqual((await json('/api/state?page=tasks&q=B-DEEP-ATTACHMENT.PDF')).task_search_ids,['b']);
  const history=await json('/api/chat/search?q='+tail+'&limit=50');assert.ok(history.rows.some(s=>s.id==='c'),'full historical search still finds hidden bodies');
  const expected=agentUpdates(full);
  assert.deepEqual(agentUpdates(initial),expected,'final-reply counts, times, authors and project attribution remain exact');
  const scopedProject=splitState(full,{page:'projects'});
  assert.deepEqual(projectsView(scopedProject,project),projectsView(full,project),'project badges, replies and all details stay identical');
  assert.equal(sessionOf(initial,{id:'mail:fixture-a',source:'mail'})?.id,'a','mail discussion links work without historical message bodies');
  assert.equal((await fetch(base+'/api/state?page=not-a-page')).status,400);
  assert.deepEqual(read('.runtime/agent/sessions.json'),original);assert.deepEqual(read('work/queue.json'),queue);
}));

test('conversation HTTP avoids unrelated stores but preserves full bodies, all project updates and live task state',()=>office(async({base})=>{
  const file='.runtime/agent/sessions.json',original=read(file),state=read(file),s=state.sessions.find(x=>x.id==='a');
  s.messages.push({role:'assistant',provider:'codex',text:'Newer final 🌿',at:'2026-10-12T13:00:00Z',task_id:'a'});write(file,state);
  const readFile=fs.readFileSync,unrelated=[];
  try{
    fs.readFileSync=function(file,...args){if(/(?:literature|software|procurement)[\\/]catalog\.json$|usage[\\/]runs\.jsonl$/.test(String(file)))unrelated.push(String(file));return readFile.call(this,file,...args);};
    const r=await fetch(base+'/api/state?page=chat&session=a');assert.equal(r.status,200);const chat=await r.json();
    fs.readFileSync=readFile;
    assert.deepEqual(unrelated,[],'chat does not build unrelated pages or parse historical usage');
    assert.deepEqual(chat.agent.sessions.find(x=>x.id==='a').messages,s.messages);
    assert.equal(chat.agent.sessions.find(x=>x.id==='a').updates.length,1);assert.equal(chat.agent.sessions.find(x=>x.id==='a').updates[0].text,'Newer final 🌿');
    assert.deepEqual(chat.work.items.map(x=>x.id),['a','b'],'selected task metadata and every live task survive; unrelated completed tasks do not travel');
    assert.ok(chat.projects.every(p=>!p.framework));
    const project=await (await fetch(base+'/api/state?page=projects')).json();
    assert.equal(project.agent.sessions.find(x=>x.id==='a').updates.length,2,'project counts retain every final reply');
    assert.deepEqual(agentUpdates(project),agentUpdates(splitState(snapshot(),{page:'projects'})));
  }finally{fs.readFileSync=readFile;write(file,original);}
}));

test('opening a chat does not look up inbox files for historical turns without a pending review',()=>office(async({base})=>{
  const queue=read('work/queue.json'),at='2026-10-12T12:00:00Z';
  queue.items.push(...Array.from({length:4000},(_,i)=>({id:'history-turn-'+i,title:'Historical turn',actor:'codex',executor:'codex',
    status:'done',project_ids:[],dependencies:[],outputs:[],created_at:at,completed_at:at})));
  queue.items.push({id:'pending-review',title:'Current decision',actor:'user',status:'waiting_user',project_ids:[],dependencies:[],outputs:[],
    created_at:at,review:{state:'pending',kind:'decision'}});
  write('work/queue.json',queue);
  const exists=fs.existsSync;let historicalLookups=0;
  try{
    fs.existsSync=function(file){if(/[\\/]runs[\\/]history-turn-\d+[\\/]inbox\.json$/.test(String(file)))historicalLookups++;return exists.call(this,file);};
    const response=await fetch(base+'/api/state?page=chat&session=a'),chat=await response.json();
    assert.equal(response.status,200);
    assert.ok(chat.agent.sessions.find(s=>s.id==='a').messages.some(m=>m.text.includes('original-a')),'the selected conversation remains complete');
    assert.ok(chat.inbox.some(i=>i.id==='work:pending-review'),'the live decision still appears');
    assert.equal(historicalLookups,0,'finished turns without reviews have no inbox file to consult');
  }finally{fs.existsSync=exists;}
}));

test('each page builds only its own resources while preserving full details and shared navigation',()=>office(async({base})=>{
  const usageFile=path.join(root,'.runtime/usage/runs.jsonl'),before=fs.existsSync(usageFile) ? fs.readFileSync(usageFile) : null;
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  try{
    const at=new Date().toISOString();
    queue.items.find(i=>i.id==='a').review={state:'pending',kind:'acceptance'};
    queue.items.find(i=>i.id==='b').dependencies=['c'];
    queue.items.find(i=>i.id==='c').status='failed';
    sessions.sessions[0].messages.push({role:'assistant',provider:'codex',text:'Latest complete answer',at,task_id:'a'});
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);
    fs.writeFileSync(usageFile,JSON.stringify({id:'a',at,provider:'codex',model:'fixture-preserved-model',input_tokens:7,output_tokens:3})+'\n');
    const full=JSON.parse(JSON.stringify(snapshot())),required={
      board:[],instruments:[],history:[],tasks:[],chat:[],
      projects:['projects','links','literature','weekly'],
      weekly:['calendar','weekly'],inbox:['inbox_activity','automation'],usage:['usage'],
      connections:['software','connections'],mail:['mail'],procurement:['procurement']};
    const oldRead=fs.readFileSync;
    for(const [page,keys] of Object.entries(required)){
      const reads=[];let response,data;
      try{
        fs.readFileSync=function(file,...args){reads.push(String(file).replaceAll('\\','/'));return oldRead.call(this,file,...args);};
        response=await fetch(base+'/api/state?page='+page);data=await response.json();
      }finally{fs.readFileSync=oldRead;}
      assert.equal(response.status,200,page);
      for(const key of keys)assert.deepEqual(data[key],full[key],page+' keeps complete '+key);
      assert.deepEqual(data.inbox,full.inbox,page+' retains the shared inbox and its deadlines');
      assert.deepEqual(data.usage.quota,full.usage.quota,page+' retains live account quota');
      assert.equal(data.agent.sessions.find(s=>s.id==='a').updates.length,page==='projects'?2:1);
      assert.equal(data.agent.sessions.find(s=>s.id==='a').updates.at(-1).text,'Latest complete answer');
      for(const [resource,owner] of [['literature','projects'],['software','connections'],['procurement','procurement']]){
        // Project literature is cached by file signature: correct returned data,
        // not a fresh read on every refresh, defines this boundary.
        if(resource!=='literature' || page!==owner)assert.equal(reads.some(f=>f.endsWith('/'+resource+'/catalog.json')),page===owner,page+' reads only its own '+resource);
        if(page===owner)assert.deepEqual(data[resource],full[resource],page+' keeps complete owned '+resource);
        if(page!==owner)assert.equal(data[resource],undefined);
      }
      assert.equal(reads.some(f=>f.endsWith('/.runtime/usage/runs.jsonl')),['usage','inbox'].includes(page),page+' usage history is on demand');
      assert.equal(reads.some(f=>f.endsWith('/FRAMEWORK.md')),page==='projects',page+' framework parsing is on demand');
      assert.equal(reads.some(f=>f.endsWith('/work/policy.json')),false,'no UI page consumes execution policy');
      if(page!=='projects')assert.ok(data.projects.every(p=>Object.keys(p).every(k=>['id','name','archived_at'].includes(k))));
      if(['board','weekly','connections','mail','procurement','instruments'].includes(page)){
        assert.deepEqual(data.work.items.map(i=>i.id),['b','c'],'live tasks retain blocked predecessor titles but not completed history');
        assert.deepEqual(data.work.items.find(i=>i.id==='b').blocked_by,['c']);
        assert.ok(Buffer.byteLength(JSON.stringify(data))<Buffer.byteLength(JSON.stringify(splitState(full,{page:'projects'})))*.55);
      }
      if(page==='projects')assert.deepEqual(data.work.items,full.work.items);
      if(page==='inbox'){
        assert.equal(data.work.items.filter(i=>i.status==='done').length,full.work.items.filter(i=>i.status==='done').length,'today delivery counts retain completed history');
        assert.equal(data.usage.runs.find(r=>r.id==='a').model,'fixture-preserved-model','inbox model metadata is retained');
      }
    }
    const procurementFile=path.join(root,'procurement/catalog.json'),original=fs.readFileSync(procurementFile);
    try{
      fs.writeFileSync(procurementFile,'{invalid external edit');
      assert.equal((await fetch(base+'/api/state?page=board')).status,200,'unrelated broken stores must not break the board');
      assert.equal((await fetch(base+'/api/state?page=procurement')).status,400,'the owning page must see current broken bytes, not stale data');
    }finally{fs.writeFileSync(procurementFile,original);}
    queue.items.find(i=>i.id==='b').title='Externally changed live title';write('work/queue.json',queue);
    const changed=await (await fetch(base+'/api/state?page=board')).json();
    assert.equal(changed.work.items.find(i=>i.id==='b').title,'Externally changed live title');
    assert.deepEqual(read('.runtime/agent/sessions.json'),sessions,'projection never modifies conversation records');
  }finally{if(before===null)fs.rmSync(usageFile,{force:true});else fs.writeFileSync(usageFile,before);}
}));

test('representative conversation state shrinks without losing messages or baseline changes',()=>office(async({base})=>{
  const file='.runtime/agent/sessions.json',before=read(file),queue=read('work/queue.json');
  const at='2026-10-12T12:00:00Z',baseline={files:Object.fromEntries(Array.from({length:2500},(_,i)=>['workspace/fixture-'+i+'.md','a'.repeat(64)])),errors:[]};
  const sessions=Array.from({length:112},(_,i)=>({id:'scale-'+i,title:'Fixture '+i,origin:'chat',project_ids:[],task_ids:['scale-task-'+i],created_at:at,
    messages:Array.from({length:12},(_,n)=>({role:n%2?'assistant':'user',...(n%2?{provider:'codex'}:{}),text:'Complete fixture message '+i+' '+n+' 🌿 '.repeat(60),at,task_id:'scale-task-'+i})),
    file_snapshots:{codex:baseline},activity:[{name:'commandExecution',at,detail:'large private command '.repeat(600)}]}));
  try{
    write(file,{sessions});write('work/queue.json',{...queue,items:sessions.map((s,i)=>({id:s.task_ids[0],title:s.title,status:i===111?'active':'done',project_ids:[],dependencies:[],actor:'codex',outputs:[]}))});
    const originalBytes=fs.statSync(path.join(root,file)).size,t=performance.now();
    const oldPayload=JSON.stringify(splitState(snapshot(),{page:'projects'}));
    assert.equal(migrateSessionBaselines(),112);const migratedBytes=fs.statSync(path.join(root,file)).size;
    assert.deepEqual(loadBaseline(read(file).sessions[25].file_snapshots.codex),baseline);
    const start=performance.now(),r=await fetch(base+'/api/state?page=chat&session=scale-25'),text=await r.text(),httpMs=performance.now()-start,chat=JSON.parse(text);
    assert.equal(r.status,200);assert.deepEqual(chat.agent.sessions.find(s=>s.id==='scale-25').messages,sessions[25].messages);
    assert.ok(migratedBytes<originalBytes*.15,'private baselines must no longer dominate each chat write');
    assert.ok(text.length<oldPayload.length*.55,'chat traffic must actually shrink at representative volume');
    assert.equal(chat.work.items.length,2);
    const dir=path.join(root,'.runtime/latency');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'scale.json'),JSON.stringify({sessions:112,originalStoreBytes:originalBytes,migratedStoreBytes:migratedBytes,fullProjectPayloadBytes:Buffer.byteLength(oldPayload),chatPayloadBytes:Buffer.byteLength(text),httpMs,totalMs:performance.now()-t},null,2));
  }finally{write(file,before);write('work/queue.json',queue);}
}));

test('manual title API validates input, retains records and defeats late automatic titles without model calls',()=>office(async({base})=>{
  const post=body=>fetch(base+'/api/chat/title',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const before=read('.runtime/agent/sessions.json'),queue=read('work/queue.json');let release,started,calls=0;
  const ready=new Promise(r=>started=r),result=new Promise(r=>release=r);
  const pending=titleSession('a',async()=>{calls++;started();return {result:await result};},{force:true});await ready;
  try{
    const response=await post({session_id:'a',title:'  手动标题 TaIrTe₄ 🌿  '});assert.equal(response.status,200);
    const saved=read('.runtime/agent/sessions.json').sessions.find(s=>s.id==='a');
    assert.equal(saved.title,'手动标题 TaIrTe₄ 🌿');assert.equal(saved.title_manual,true);assert.equal((await response.json()).title,saved.title);
    assert.deepEqual(saved.messages,before.sessions[0].messages);assert.deepEqual(read('work/queue.json'),queue);
    release('迟到的自动标题');assert.equal(await pending,null);assert.equal(read('.runtime/agent/sessions.json').sessions[0].title,saved.title);
    assert.equal(await titleSession('a',async()=>{calls++;return {result:'不该调用'};}),null);assert.equal(calls,1);
    const due={...saved,origin:'chat',title_tried:true,title_turns:1,messages:Array.from({length:10},()=>({role:'user',text:saved.title}))};
    assert.equal(titleDue(due,10),false);assert.equal(draftTitle({...due,title_tried:false}),false);
    const longTitle='完整标题'.repeat(40)+'末尾';
    assert.equal((await post({session_id:'a',title:longTitle})).status,200);
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id==='a').title,longTitle);
    const stable=read('.runtime/agent/sessions.json');
    for(const title of ['', '   ',null,123])assert.equal((await post({session_id:'a',title})).status,400);
    assert.equal((await post({session_id:'missing',title:'有效标题'})).status,400);
    assert.deepEqual(read('.runtime/agent/sessions.json'),stable);
  }finally{release('fixture cleanup');await pending;}
}));

test('real UI fetches selected conversations and pages, edits titles, and rejects obsolete scopes without losing drafts',{timeout:60000},()=>office(async({base,tail})=>{
  let browser,page,releaseOld,oldSeen;const oldGate=new Promise(r=>releaseOld=r),oldCaptured=new Promise(r=>oldSeen=r),errors=[],requests=[];
  try{
    browser=await launchEdge();const context=await browser.newContext({viewport:{width:1440,height:1050},permissions:['clipboard-read','clipboard-write']});page=await context.newPage();
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','a');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname==='/api/state')requests.push(new URL(r.url()).searchParams.toString());});
    await page.goto(base);await page.locator('.message-text').filter({hasText:'original-a'}).waitFor();
    assert.equal(await page.locator('.subagent-tag').count(),2,'only the two sub-agent messages carry the mark');
    for(const provider of ['claude','codex'])assert.equal(await page.locator('.message').filter({hasText:'Said by a '+provider+' helper'}).locator('.subagent-tag').count(),1);
    await page.screenshot({path:path.join(root,'.runtime/subagent-labels.png')});
    await page.locator('#message').fill('Do not erase this draft');
    await page.locator('#rename-session').waitFor({state:'visible'});
    page.once('dialog',d=>d.dismiss());await page.locator('#rename-session').click();assert.equal(await page.locator('#session-title').textContent(),'Conversation a');
    const renamed='手动标题 TaIrTe₄ 🌿';page.once('dialog',d=>d.accept(renamed));await page.locator('#rename-session').click();
    await page.waitForFunction(title=>document.getElementById('session-title').textContent===title,renamed);
    assert.equal(await page.locator('.session-entry[data-session="a"] .session-title').textContent(),renamed);
    assert.equal(await page.locator('#message').inputValue(),'Do not erase this draft');
    const review=path.join(root,'.runtime/title-ui');fs.mkdirSync(review,{recursive:true});await page.screenshot({path:path.join(review,'desktop.png')});
    await page.setViewportSize({width:430,height:900});
    const icon=await page.locator('#rename-session').boundingBox(),toolbar=await page.locator('.chat-toolbar').boundingBox();
    assert.ok(icon.x>=toolbar.x && icon.x+icon.width<=toolbar.x+toolbar.width,'pencil remains inside the mobile toolbar');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(review,'mobile.png')});
    await page.setViewportSize({width:1440,height:1050});await page.reload();await page.locator('.message-text').filter({hasText:'original-a'}).waitFor();
    assert.equal(await page.locator('#session-title').textContent(),renamed);assert.equal(await page.locator('#message').inputValue(),'Do not erase this draft');
    await page.locator('.chat-tab[data-page="history"]').click();assert.equal(await page.locator('#history-list [data-session="a"] .history-title').textContent(),renamed);
    await page.locator('#history-list [data-session="a"]').click();
    await page.route('**/api/chat/title',r=>r.fulfill({status:503,json:{error:'fixture title save failed'}}));
    page.once('dialog',d=>d.accept('失败时不能伪造保存'));await page.locator('#rename-session').click();await page.locator('#error').filter({hasText:'fixture title save failed'}).waitFor();
    assert.equal(await page.locator('#session-title').textContent(),renamed);assert.equal(await page.locator('#message').inputValue(),'Do not erase this draft');await page.unroute('**/api/chat/title');
    await page.locator('#new-session').click();assert.equal(await page.locator('#rename-session').isVisible(),false);
    await page.locator('.session-entry[data-session="a"]').click();assert.equal(await page.locator('#message').inputValue(),'Do not erase this draft');
    fs.writeFileSync(path.join(review,'acceptance.json'),JSON.stringify({cancelUnchanged:true,savedTitle:renamed,sidebar:true,history:true,reload:true,draftPreserved:true,failedSaveUnchanged:true,newChatHidden:true,mobileFits:true},null,2));
    await page.locator('.chat-tab[data-page="tasks"]').click();await page.locator('#tasks-list [data-session="b"]').click();
    await page.locator('.message-text').filter({hasText:tail}).waitFor();
    assert.equal(await page.locator('.message-file').getAttribute('download'),'');
    assert.equal(await page.locator('#message').inputValue(),'','B has its own empty draft');
    let held=false,oldRequest;
    await page.route('**/api/state*',async r=>{
      const p=new URL(r.request().url()).searchParams;
      if(!held && p.get('page')==='chat' && p.get('session')==='a'){held=true;oldRequest=r.request();const old=await r.fetch();oldSeen();await oldGate;await r.fulfill({response:old});}
      else await r.continue();
    });
    await page.locator('.session-entry[data-session="a"]').click();await oldCaptured;
    await page.locator('.chat-tab[data-page="tasks"]').click();await page.locator('#tasks-list [data-session="b"]').click();
    await page.locator('.message-text').filter({hasText:tail}).waitFor();
    assert.equal(held,true); // B must become usable while A's response is still held.
    const stale=oldRequest.response(); // An obsolete scope may correctly abort its request instead of receiving it.
    releaseOld();const oldResponse=await stale;if(oldResponse)await oldResponse.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.message-text').filter({hasText:'original-a'}).count(),0,'late A must not populate selected B');
    await page.locator('.chat-tab[data-page="tasks"]').click();await page.locator('#tasks-list .history-entry').waitFor();
    await page.locator('#tasks-search').fill(tail);await page.waitForFunction(()=>document.getElementById('tasks-count').textContent.startsWith('1 条任务会话'));
    assert.ok((await page.locator('#tasks-list').textContent()).includes('Conversation b'));
    const searched=page.waitForResponse(r=>new URL(r.url()).searchParams.get('q')==='B-DEEP-ATTACHMENT.PDF');
    await page.locator('#tasks-search').fill('B-DEEP-ATTACHMENT.PDF');await searched;
    await page.locator('#tasks-list .history-entry').waitFor();
    await page.locator('.chat-tab[data-page="history"]').click();await page.locator('#history-search').fill(tail);
    await page.locator('#history-list [data-chat-open="c"]').waitFor();await page.locator('#history-list [data-chat-open="c"]').click();
    await page.locator('.message-text').filter({hasText:tail}).waitFor();assert.equal(await page.locator('#session-title').textContent(),'Conversation c');
    await page.locator('.nav[data-page="more"]').click();
    for(const p of ['board','usage','connections','mail','procurement']){
      await page.locator('.more-tab[data-page="'+p+'"]').click();await page.waitForFunction(p=>document.getElementById('page-'+p).getAttribute('aria-busy')==='false',p);
    }
    await page.locator('.nav[data-page="projects"]').click();await page.waitForFunction(()=>document.getElementById('page-projects').getAttribute('aria-busy')==='false');
    await page.locator('.nav[data-page="inbox"]').click();await page.waitForFunction(()=>document.getElementById('page-inbox').getAttribute('aria-busy')==='false');
    await page.locator('.nav[data-page="weekly"]').click();await page.waitForFunction(()=>document.getElementById('page-weekly').getAttribute('aria-busy')==='false');
    await page.locator('#calendar-grid .cal-head').waitFor();
    assert.equal(await page.locator('#message').inputValue(),'','C does not inherit the A draft');
    await page.locator('.nav[data-page="chat"]').click();await page.locator('.session-entry[data-session="a"]').click();
    assert.equal(await page.locator('#message').inputValue(),'Do not erase this draft');assert.deepEqual(errors,[]);
    assert.ok(requests.some(q=>q.includes('session=b')));
    const dir=path.join(root,'.runtime/ui-state-review');fs.mkdirSync(dir,{recursive:true});
    await page.screenshot({path:path.join(dir,'scoped-inbox.png')});fs.writeFileSync(path.join(dir,'requests.json'),JSON.stringify(requests,null,2));
  }finally{releaseOld();await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();}
}));

test('real UI edits an earlier user message, cancels cleanly, regenerates from it, and offers no edit on card replies',{timeout:60000},()=>office(async({base})=>{
  const at='2026-10-12T12:00:00Z',item=id=>({id,title:'Fixture '+id,kind:'misc',actor:'codex',executor:'codex',project_ids:[],status:'done',dependencies:[],outputs:[],created_at:at,completed_at:at,goal:id});
  const queue=read('work/queue.json');write('work/queue.json',{...queue,items:[...queue.items,item('e1'),item('e2')]});
  const store=read('.runtime/agent/sessions.json');
  write('.runtime/agent/sessions.json',{sessions:[...store.sessions,{id:'e',title:'Edit fixture',origin:'chat',project_ids:[],task_ids:['e1','e2'],created_at:at,messages:[
    {role:'user',text:'@Codex first-question',at,task_id:'e1'},{role:'assistant',provider:'codex',text:'answer-1',at,task_id:'e1'},
    {role:'user',text:'@Codex second-original',at,task_id:'e2'},{role:'assistant',provider:'codex',text:'answer-2',at,task_id:'e2'}]}]});
  let browser,page;const errors=[];
  try{
    browser=await launchEdge();page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage();
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','e');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('.message-text').filter({hasText:'second-original'}).waitFor();
    assert.equal(await page.locator('.message-edit-open').count(),2,'both plain user messages are editable');
    await page.locator('.message.user').nth(1).locator('.message-edit-open').click();
    const box=page.locator('.message-edit textarea');assert.equal(await box.inputValue(),'@Codex second-original');
    assert.match(await page.locator('.message-edit small').textContent(),/之后的 1 条发言/);
    await page.screenshot({path:path.join(root,'.runtime/edit-ui-open.png')});
    await page.locator('[data-edit-cancel]').click();assert.equal(await page.locator('.message-edit').count(),0);
    assert.equal(await page.locator('.message.user').nth(1).locator('.message-text').isVisible(),true);
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id==='e').messages.length,4,'cancel changes nothing');
    await page.locator('.message.user').nth(1).locator('.message-edit-open').click();
    await box.fill('@Codex second-edited');await page.locator('[data-edit-save]').click();
    await page.locator('.message-text').filter({hasText:'second-edited'}).waitFor();
    assert.equal(await page.locator('.message-text').filter({hasText:'answer-2'}).count(),0,'the discarded reply leaves the view');
    assert.equal(await page.locator('.message-text').filter({hasText:'answer-1'}).count(),1);
    assert.match(await page.locator('.message.user').nth(1).locator('.message-meta').textContent(),/已编辑（替换了 2 条旧发言）/);
    const saved=read('.runtime/agent/sessions.json').sessions.find(s=>s.id==='e');
    assert.deepEqual(saved.messages.map(m=>m.text),['@Codex first-question','answer-1','@Codex second-edited']);
    assert.equal(fs.readdirSync(path.join(root,'.runtime/agent/branches/e')).length,1);
    await page.screenshot({path:path.join(root,'.runtime/edit-ui-done.png')});
    assert.deepEqual(errors,[]);
    // The fixture conversation 'a' opens with a card reply: no edit entry.
    await page.locator('.session-entry[data-session="a"]').click();await page.locator('.message-text').filter({hasText:'original-a'}).waitFor();
    assert.equal(await page.locator('.message-edit-open').count(),0);
  }finally{await browser?.close();fs.rmSync(path.join(root,'.runtime/agent/branches'),{recursive:true,force:true});}
}));

test('real UI shows the agent own question while its turn waits, sends the chosen answer back to that turn, and keeps a compact record',{timeout:90000},()=>office(async({base})=>{
  const job=submit({text:'@claude QUESTION UI'});let asked,answers,release;
  const running=executeWithoutTitle(executeAgent)(job.task_id,async(_,prompt,opts)=>{
    asked=true;answers=await opts.onQuestion([{id:'0',header:'颜色',question:'喜欢哪一个？',options:[{label:'红',description:'暖色'},{label:'蓝',description:'冷色'}],multi:false,other:true},{id:'1',header:'饮品',question:'来点什么？',options:[{label:'咖啡',description:''},{label:'茶',description:''}],multi:false,other:true}]);
    await new Promise(r=>{release=r;});return {result:'FINAL '+JSON.stringify(answers)};
  });
  let browser;const errors=[];
  try{
    browser=await launchEdge();const page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage();
    await page.addInitScript(id=>{if(window.top===window)localStorage.setItem('lab-session',id);},job.session_id);
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    const card=page.locator('.question-card[data-question]');await card.waitFor({timeout:30000});
    assert.equal(await card.locator('.question-option').count(),4);assert.match(await card.textContent(),/在问你.*颜色.*喜欢哪一个/s);
    await page.screenshot({path:path.join(root,'.runtime/question-ui-open.png')});
    const first=card.locator('.question-item').nth(0),second=card.locator('.question-item').nth(1);
    // Typing into the write-in selects its radio; picking an option afterwards un-selects it, and the leftover text must not override the pick.
    await first.locator('.question-other').fill('残留文字');
    assert.equal(await first.locator('.question-own-pick').isChecked(),true);
    await first.locator('.question-option').filter({hasText:'蓝'}).click();
    assert.equal(await first.locator('.question-own-pick').isChecked(),false);
    await second.locator('.question-option').filter({hasText:'咖啡'}).click();await second.locator('.question-other').fill('手写奶茶');
    assert.equal(await second.locator('.question-option input:checked').count(),0,'write-in replaces the option pick');
    await card.locator('[data-answer]').click();
    await page.locator('.question-card.done').waitFor({timeout:30000});
    assert.match(await page.locator('.question-card.done').textContent(),/颜色：蓝.*饮品：手写奶茶/s);
    assert.equal(await page.locator('.question-card[data-question]').count(),0,'an answered question is not answerable again');
    while(!release)await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(answers,{'0':['蓝'],'1':['手写奶茶']});release();await running;
    await page.screenshot({path:path.join(root,'.runtime/question-ui-done.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();stop(job.task_id);release?.();await running.catch(()=>{});}
}));

test('a conversation started by assistant handoff is indexed under its parent and ships its body only with the parent',()=>{
  const m=(role,task_id,extra={})=>({role,text:role+task_id,at:'2026-10-21T10:00:00Z',task_id,...extra});
  const s={projects:[],work:{items:[{id:'t1',status:'done'},{id:'k1',status:'active'}]},inbox:[],usage:{runs:[]},agent:{sessions:[
    {id:'p',title:'parent',origin:'chat',project_ids:[],task_ids:['t1'],messages:[m('user','t1'),m('assistant','t1',{provider:'claude'})]},
    {id:'k',title:'kid',origin:'chat',project_ids:[],task_ids:['k1'],messages:[m('handoff','k1',{provider:'claude',handoff:{provider:'claude',session_id:'p',task_id:'t1'}})]},
    {id:'o',title:'orphan',origin:'chat',project_ids:[],task_ids:[],messages:[m('handoff','o1',{provider:'claude',handoff:{provider:'claude',session_id:'gone',task_id:'x'}})]},
  ]}};
  const parent=splitState(s,{page:'chat',sessionId:'p'}),byId=id=>parent.agent.sessions.find(x=>x.id===id);
  assert.equal(byId('k').parent_id,'p');assert.equal(byId('k').handoff_task_id,'t1');
  assert.equal(byId('k').messages.length,1,'the child body is inline in the parent view');
  assert.ok(parent.work.items.some(i=>i.id==='k1'),'the child task status is available for the running label');
  assert.equal(byId('o').parent_id,undefined,'a child whose parent was deleted stays in the lists');
  const flat=splitState(s,{page:'chat',sessionId:''});
  assert.equal(flat.agent.sessions.find(x=>x.id==='k').messages,undefined,'no child body unless the parent is open');
});

test('real UI shows an assistant-started sub-conversation inside its parent, not in the lists',{timeout:60000},()=>office(async({base})=>{
  const at='2026-10-12T12:00:00Z',item=(id,status='done')=>({id,title:'Fixture '+id,kind:'misc',actor:'codex',executor:'codex',project_ids:[],status,dependencies:[],outputs:[],created_at:at,goal:id});
  const queue=read('work/queue.json');write('work/queue.json',{...queue,items:[...queue.items,item('pa1'),item('pa2'),item('kid1')]});
  const store=read('.runtime/agent/sessions.json');
  write('.runtime/agent/sessions.json',{sessions:[...store.sessions,
    {id:'pa',title:'Parent fixture',origin:'chat',project_ids:[],task_ids:['pa1','pa2'],created_at:at,messages:[
      {role:'user',text:'@Claude parent-ask',at,task_id:'pa1'},{role:'assistant',provider:'claude',text:'parent-reply-1',at,task_id:'pa1'},
      {role:'user',text:'@Claude parent-ask-2',at,task_id:'pa2'},{role:'assistant',provider:'claude',text:'parent-reply-2',at,task_id:'pa2'}]},
    {id:'kid',title:'Kid fixture',origin:'chat',project_ids:[],task_ids:['kid1'],created_at:at,messages:[
      {role:'handoff',provider:'claude',handoff:{provider:'claude',session_id:'pa',task_id:'pa1'},text:'kid-handoff-text',at,task_id:'kid1'},
      {role:'assistant',provider:'codex',text:'kid-answer',at,task_id:'kid1'}]}]});
  let browser;const errors=[];
  try{
    browser=await launchEdge();const page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage();
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','pa');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('.message-text').filter({hasText:'parent-reply-2'}).waitFor();
    const order=await page.locator('#transcript > *').evaluateAll(n=>n.map(x=>x.classList.contains('child-chat') ? 'child' : x.querySelector('.message-text')?.textContent.trim()));
    assert.deepEqual(order,['@Claude parent-ask','parent-reply-1','child','@Claude parent-ask-2','parent-reply-2'],'the sub-conversation sits right after the turn that started it');
    assert.equal(await page.locator('.child-chat').getAttribute('open'),null,'a finished sub-conversation starts collapsed');
    assert.match(await page.locator('.child-peek').textContent(),/kid-answer/);
    await page.locator('.child-chat > summary').click();
    await page.locator('.child-body .message-text').filter({hasText:'kid-answer'}).waitFor();
    assert.equal(await page.locator('.child-body .handoff-tag').count(),0,'the inline copy does not repeat the source link');
    assert.equal(await page.locator('.session-entry[data-session="kid"]').count(),0,'not in the recent list');
    assert.equal(await page.locator('.session-entry[data-session="pa"]').count(),1);
    await page.screenshot({path:path.join(root,'.runtime/child-chat-inline.png')});
    await page.locator('[data-session="kid"]').click();
    await page.locator('#session-title').filter({hasText:'子对话'}).waitFor();
    assert.equal(await page.locator('.handoff-tag').count(),1,'opened on its own page it links back to the parent');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();}
}));

test('real UI groups both providers child cards with live completion counts and no loose child replies',{timeout:60000},()=>office(async({base})=>{
  const at='2026-10-12T12:00:00Z',later='2026-10-12T12:00:05Z',item=(id,status='active')=>({id,title:'Fixture '+id,kind:'misc',actor:'codex',executor:'codex',project_ids:[],status,dependencies:[],outputs:[],created_at:at,goal:id});
  const queue=read('work/queue.json');write('work/queue.json',{...queue,items:[...queue.items,item('sa1'),item('sa2','done')]});
  const store=read('.runtime/agent/sessions.json');
  write('.runtime/agent/sessions.json',{sessions:[...store.sessions,{id:'sa',title:'Sub-agent fixture',origin:'chat',project_ids:[],task_ids:['sa1','sa2'],created_at:at,
    subagent_runs:[{id:'toolu_A',task_id:'sa1',provider:'claude',title:'查文件',prompt:'PROMPT-TO-SUB',status:'completed',text:'RESULT-FROM-SUB',at:later},
      {id:'native-child',task_id:'sa1',provider:'codex',title:'/root/helper',prompt:'',kind:'native',status:'completed',text:'CODEX-CHILD-FINAL',at:later},
      {id:'native-failed',task_id:'sa1',provider:'codex',title:'/root/failed',status:'failed',at:later},
      {id:'native-live',task_id:'sa1',provider:'codex',title:'/root/live',status:'running',at:later},
      {id:'native-later',task_id:'sa2',provider:'codex',title:'/root/later',status:'completed',at:'2026-10-12T12:00:12Z'}],messages:[
      {role:'user',text:'@Claude go',at,task_id:'sa1'},
      {role:'assistant',provider:'claude',text:'MIDWAY-SUB',subagent:true,agent_call:'toolu_A',interim:true,at:later,task_id:'sa1'},
      {role:'assistant',provider:'codex',text:'CODEX-CHILD-PROGRESS',subagent:true,agent_call:'native-child',interim:true,at:later,task_id:'sa1'},
      {role:'assistant',provider:'codex',text:'CODEX-CHILD-FINAL',subagent:true,agent_call:'native-child',interim:true,at:later,task_id:'sa1'},
      {role:'assistant',provider:'codex',text:'LEGACY-CODEX-RAW',subagent:true,interim:true,at:later,task_id:'sa1'},
      {role:'assistant',provider:'claude',text:'LEGACY-CLAUDE-RAW',subagent:true,agent_call:'missing-old-call',interim:true,at:later,task_id:'sa1'},
      {role:'assistant',provider:'claude',text:'FINAL-PARENT',at:'2026-10-12T12:00:09Z',task_id:'sa1'},
      {role:'user',text:'@Codex later round',at:'2026-10-12T12:00:10Z',task_id:'sa2'},
      {role:'assistant',provider:'codex',text:'FINAL-LATER-PARENT',at:'2026-10-12T12:00:15Z',task_id:'sa2'}]}]});
  let browser;const errors=[];
  try{
    browser=await launchEdge();const page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage();
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','sa');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('.message-text').filter({hasText:'FINAL-PARENT'}).waitFor();
    assert.equal(await page.locator('.sub-run').count(),7);
    assert.equal(await page.locator('#transcript > .subagent-group').count(),3,'one outer card per parent task and provider');
    assert.equal(await page.locator('#transcript > .sub-run').count(),0,'individual children are nested, not top-level cards');
    assert.equal(await page.locator('.subagent-group[open]').count(),0,'outer cards start collapsed, even while running');
    const claudeGroup=page.locator('.subagent-group[data-child="subagents:sa1:claude"]'),codexGroup=page.locator('.subagent-group[data-child="subagents:sa1:codex"]');
    assert.match(await codexGroup.locator(':scope > summary').textContent(),/已完成 1\/3 · 运行中 1 · 失败 1 · 含历史记录/);
    assert.match(await claudeGroup.locator(':scope > summary').textContent(),/已完成 1\/1 · 含历史记录/,'unidentified historical records do not inflate agent totals');
    assert.match(await page.locator('.subagent-group[data-child="subagents:sa2:codex"] > summary').textContent(),/已完成 1\/1/,'a later round keeps its own total');
    await page.screenshot({path:path.join(root,'.runtime/subagent-groups-collapsed.png')});
    for(const word of ['MIDWAY-SUB','CODEX-CHILD-PROGRESS','CODEX-CHILD-FINAL','LEGACY-CODEX-RAW','LEGACY-CLAUDE-RAW']){
      assert.equal(await page.locator('#transcript > .message').filter({hasText:word}).count(),0,'child words are inside cards, not loose in the transcript');
      assert.equal(await page.locator('.sub-run[open]').count(),0);
    }
    const claude=page.locator('.sub-run[data-child="toolu_A"]'),codex=page.locator('.sub-run[data-child="native-child"]');
    await claudeGroup.locator(':scope > summary').click();await codexGroup.locator(':scope > summary').click();
    assert.match(await claude.locator('.child-peek').textContent(),/RESULT-FROM-SUB/);
    assert.match(await codex.locator('.child-peek').textContent(),/CODEX-CHILD-FINAL/);
    await claude.locator('summary').click();
    const body=await claude.locator('.child-body').textContent();
    for(const word of ['PROMPT-TO-SUB','MIDWAY-SUB','RESULT-FROM-SUB'])assert.match(body,new RegExp(word));
    await codex.locator('summary').click();
    assert.match(await codex.locator('.child-body').textContent(),/CODEX-CHILD-PROGRESS/);
    assert.match(await codex.locator('.subagent-tag').first().getAttribute('title'),/Codex/);
    for(const group of await page.locator('.subagent-group').all())if(await group.getAttribute('open')===null)await group.locator(':scope > summary').click();
    for(const card of await page.locator('.sub-run').all())if(await card.getAttribute('open')===null)await card.locator('summary').click();
    for(const word of ['LEGACY-CODEX-RAW','LEGACY-CLAUDE-RAW'])assert.equal(await page.locator('.sub-run .message-text').filter({hasText:word}).isVisible(),true);
    await page.screenshot({path:path.join(root,'.runtime/subagent-card.png')});
    await page.reload();await page.locator('.sub-run[data-child="native-child"]').waitFor({state:'attached'});
    assert.equal(await page.locator('.sub-run').count(),7,'cards survive reload without rewriting stored history');
    const changed=read('.runtime/agent/sessions.json'),changedSession=changed.sessions.find(s=>s.id==='sa');
    changedSession.subagent_runs.push({id:'native-new',task_id:'sa1',provider:'codex',title:'/root/new',status:'running',at:later});
    changedSession.subagent_runs.find(r=>r.id==='native-live').status='completed';write('.runtime/agent/sessions.json',changed);
    await page.reload();await page.locator('.subagent-group').first().waitFor();
    assert.match(await codexGroup.locator(':scope > summary').textContent(),/已完成 2\/4 · 运行中 1 · 失败 1/,'new launches grow the denominator; only successful completions grow the numerator');
    const stopped=read('work/queue.json');stopped.items.find(i=>i.id==='sa1').status='cancelled';write('work/queue.json',stopped);
    await page.reload();await page.locator('.subagent-group').first().waitFor();
    assert.match(await codexGroup.locator(':scope > summary').textContent(),/已完成 2\/4 · 失败 1 · 已结束 1/,'stopping the parent never fabricates successful child completions');
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id==='sa').messages.filter(m=>m.subagent).length,5);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();}
}));
