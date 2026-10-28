import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
import {captureFiles,compareFiles,officeFiles,fileChangesText,runtimeCodeStatus} from './file-state.mjs';
import {createServer} from '../dashboard/server.mjs';
import {submit,agentSnapshot,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
import {loadBaseline} from '../agent/file-baselines.mjs';
import {launchEdge} from './browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent),sessions='.runtime/agent/sessions.json';
const stateOf=id=>{
  const s=read(sessions).sessions.find(s=>s.id===id);
  for(const provider of Object.keys(s.file_snapshots || {}))s.file_snapshots[provider]=loadBaseline(s.file_snapshots[provider]);
  if(s.codex_continuation?.fileSnapshot)s.codex_continuation.fileSnapshot=loadBaseline(s.codex_continuation.fileSnapshot);
  return s;
};
const fixture=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};

test('file snapshots detect add/edit/delete by content, tolerate timestamps, and preserve uncertainty',()=>{
  const dir=fs.mkdtempSync(path.join(root,'.runtime/file-state-'));
  try {
    const file=path.join(dir,'source.mjs');fs.writeFileSync(file,'old');const before=captureFiles(dir,['.']);
    const time=fs.statSync(file).mtime;fs.writeFileSync(file,'new');fs.utimesSync(file,time,time);
    fs.writeFileSync(path.join(dir,'new.csv'),'x,1');const changed=captureFiles(dir,['.']);
    assert.deepEqual(compareFiles(before,changed),[{path:'new.csv',kind:'added'},{path:'source.mjs',kind:'modified'}]);
    const text=fileChangesText(before,changed);assert.match(text,/修改 "source.mjs"/);assert.doesNotMatch(text,/x,1/);
    fs.utimesSync(file,new Date(),new Date());assert.deepEqual(compareFiles(changed,captureFiles(dir,['.'])),[]);
    fs.unlinkSync(file);assert.deepEqual(compareFiles(changed,captureFiles(dir,['.'])),[{path:'source.mjs',kind:'deleted'}]);
    assert.deepEqual(compareFiles(changed,{files:{},errors:['.']}),[],'unreadable directory is not deletion');
    assert.match(fileChangesText(changed,{files:{},errors:['.']}),/不完整/);
    assert.equal(fileChangesText(undefined,changed),'','no invented pre-baseline history');
    const many={files:Object.fromEntries(Array.from({length:16},(_,i)=>['p'+i,'hash'])),errors:[]};
    assert.match(fileChangesText({files:{},errors:[]},many),/另有 4 个变化/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('office snapshot omits runtime, private notebooks, credentials and links; scientific binaries are metadata only',()=>{
  const dir='workspace/projects/bi-devices/file-state-fixture';
  try {
    fixture(dir+'/notes.md','PUBLIC NOTES');fixture(dir+'/credentials.json','DO NOT READ');
    fixture(dir+'/.env','PRIVATE');fixture(dir+'/sample.pdf',Buffer.from('BINARY SECRET CONTENT'));
    const snap=officeFiles();assert.ok(snap.files[dir+'/notes.md']);assert.match(snap.files[dir+'/sample.pdf'],/^stat:/);
    for(const file of Object.keys(snap.files))assert.ok(!/^(output|tmp)\//.test(file) && !file.startsWith('workspace/archives/') && !file.startsWith('.runtime/') &&!file.startsWith('workspace/memory/') && !file.endsWith('credentials.json') && !file.endsWith('/.env'));
    fs.symlinkSync(path.join(root,'.runtime'),path.join(root,dir,'linked-runtime'),'junction');
    assert.equal(Object.keys(officeFiles().files).some(p=>p.includes('linked-runtime')),false);
  } finally {fs.rmSync(path.join(root,dir),{recursive:true,force:true});}
});

test('running health holds startup version fixed; frontend/data changes stay current; loaded module change/deletion is stale',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const files=['dashboard/app.js','agent/config.json','calendar/run.mjs','prompts/office-system.md'];
  const saved=new Map(files.map(f=>[f,fs.readFileSync(path.join(root,f))]));
  const health=async()=>{const r=await fetch(origin+'/health');assert.equal(r.status,200);return r.json();};
  try {
    const first=await health();assert.equal(first.version,2);assert.equal(first.code.state,'current');assert.equal(first.code.loaded,first.code.disk);
    fs.appendFileSync(path.join(root,'dashboard/app.js'),'\n// frontend fixture\n');
    write('agent/config.json',{...read('agent/config.json'),reasoning_effort:'fixture'});
    assert.equal((await health()).code.state,'current','live data and browser resources do not require backend restart');
    fs.appendFileSync(path.join(root,'prompts/office-system.md'),'\nSystem text fixture.\n');
    const promptStale=await health();assert.equal(promptStale.code.state,'stale');
    assert.equal(promptStale.code.loaded,first.code.loaded);
    assert.ok(promptStale.code.changed.some(c=>c.path==='prompts/office-system.md' && c.kind==='modified'));
    fs.writeFileSync(path.join(root,'prompts/office-system.md'),saved.get('prompts/office-system.md'));
    assert.equal((await health()).code.state,'current');
    fs.appendFileSync(path.join(root,'calendar/run.mjs'),'\n// backend fixture\n');
    const stale=await health();assert.equal(stale.code.state,'stale');assert.equal(stale.code.loaded,first.code.loaded);assert.notEqual(stale.code.disk,first.code.disk);
    assert.ok(stale.code.changed.some(c=>c.path==='calendar/run.mjs' && c.kind==='modified'));
    assert.equal((await (await fetch(origin+'/api/state')).json()).code.state,'stale');
    fs.unlinkSync(path.join(root,'calendar/run.mjs'));
    const missing=await health();assert.equal(missing.code.state,'stale');assert.ok(missing.code.changed.some(c=>c.path==='calendar/run.mjs' && c.kind==='deleted'));
  } finally {
    for(const [f,bytes] of saved)fs.writeFileSync(path.join(root,f),bytes);
    await new Promise(r=>server.close(r));
  }
  assert.equal(runtimeCodeStatus().state,'current');
});

test('shared file interface serves both work providers, with independent session/assistant baselines and acknowledged submission timing',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(sessions),config:read('agent/config.json')};
  const name='workspace/projects/bi-devices/file-state-turn-fixture.md',file=fixture(name,'v1');
  const open=(opts,id,resumed=false)=>{opts.onContinuation({threadId:id,signature:'S',total:{}},{phase:'start',resumed});opts.onSubmitted();};
  try {
    // This case pins the shared file interface with Claude on the plain route; Claude's own resume is covered in continuation.test.mjs.
    write('agent/config.json',{...saved.config,codex_resume_sessions:['*'],claude_resume_sessions:[]});
    const a=submit({text:'@Codex first'});
    await execute(a.task_id,async(_,prompt,opts)=>{
      assert.doesNotMatch(opts.resumePrompt,/文件变化提示/);open(opts,'A');fs.writeFileSync(file,'v2');return {result:'first done'};
    });
    const firstSnapshot=stateOf(a.session_id).file_snapshots.codex;
    assert.ok(firstSnapshot.files[name]);assert.notEqual(firstSnapshot.files[name],officeFiles().files[name],'not captured after work finishes');
    assert.equal(agentSnapshot().sessions.find(s=>s.id===a.session_id).file_snapshots,undefined,'UI does not receive internal file maps');
    const b=submit({text:'@Codex independent'});
    await execute(b.task_id,async(_,prompt,opts)=>{assert.doesNotMatch(opts.resumePrompt,/文件变化提示/);open(opts,'B');return {result:'B done'};});
    const failed=submit({session_id:a.session_id,text:'@Codex fail before native submission'});
    await execute(failed.task_id,async()=>{throw new Error('PRE-TURN FIXTURE');});
    assert.deepEqual(stateOf(a.session_id).file_snapshots.codex,firstSnapshot);
    const handoff=submit({session_id:a.session_id,text:'@Claude change then hand off'});
    await execute(handoff.task_id,async(provider,prompt,opts)=>{
      if(provider==='claude') {
        assert.equal(opts.continuation,undefined);assert.deepEqual(stateOf(a.session_id).file_snapshots.codex,firstSnapshot);
        assert.match(prompt,/首次建立文件快照/);assert.match(prompt,/当前执行进程代码/);opts.onSubmitted();
        fs.writeFileSync(file,'v3');return {result:'changed the shared file\n@Codex inspect'};
      }
      assert.match(opts.resumePrompt,/文件变化提示/);assert.ok(opts.resumePrompt.includes('修改 "'+name+'"'));
      assert.doesNotMatch(opts.resumePrompt,/v3/);assert.match(opts.resumePrompt,/当前执行进程代码/);open(opts,'A',true);return {result:'A read the warning'};
    });
    const next=submit({session_id:a.session_id,text:'@Codex unchanged'});
    await execute(next.task_id,async(_,prompt,opts)=>{assert.doesNotMatch(opts.resumePrompt,/文件变化提示/);open(opts,'A',true);return {result:'quiet'};});
    const cnext=submit({session_id:a.session_id,text:'@Claude check changes since your own last turn'});
    await execute(cnext.task_id,async(_,prompt,opts)=>{
      assert.ok(prompt.includes('修改 "'+name+'"'),'Claude receives the same notice without native continuation');
      assert.doesNotMatch(prompt,/v3/);opts.onSubmitted();return {result:'Claude observes delta'};
    });
    assert.equal(agentSnapshot().sessions.find(s=>s.id===a.session_id).file_snapshots,undefined);
    const bnext=submit({session_id:b.session_id,text:'@Codex B next'});
    await execute(bnext.task_id,async(_,prompt,opts)=>{assert.ok(opts.resumePrompt.includes('修改 "'+name+'"'));open(opts,'B',true);return {result:'B sees its own delta'};});
    // Existing deployed pilot baseline migrates, including failure after thread identity but before turn acceptance.
    const old=read(sessions),oldSession=old.sessions.find(s=>s.id===a.session_id);
    oldSession.codex_continuation.fileSnapshot=firstSnapshot;delete oldSession.file_snapshots.codex;write(sessions,old);
    const partial=submit({session_id:a.session_id,text:'@Codex thread prepared but not submitted'});
    await execute(partial.task_id,async(_,prompt,opts)=>{
      opts.onContinuation({threadId:'A',signature:'S',total:{}},{phase:'start',resumed:true});opts.onReady(async()=>{});
      throw new Error('TURN NOT ACKNOWLEDGED');
    });
    assert.deepEqual(stateOf(a.session_id).codex_continuation.fileSnapshot,firstSnapshot);
    assert.equal(stateOf(a.session_id).file_snapshots.codex,undefined);
    const legacy=submit({session_id:a.session_id,text:'@Codex legacy baseline'});
    await execute(legacy.task_id,async(_,prompt,opts)=>{assert.ok(opts.resumePrompt.includes('修改 "'+name+'"'));open(opts,'A',true);return {result:'baseline migrated'};});
    assert.equal(stateOf(a.session_id).codex_continuation.fileSnapshot,undefined);
    // Ordinary non-pilot Codex and Claude use exactly the same interface.
    write('agent/config.json',{...saved.config,codex_resume_sessions:[],claude_resume_sessions:[]});
    for(const provider of ['codex','claude']) {
      const plain=submit({text:'@'+provider+' non-pilot baseline'});
      await execute(plain.task_id,async(_,prompt,opts)=>{assert.equal(opts.continuation,undefined);assert.match(prompt,/首次建立文件快照/);opts.onSubmitted();return {result:'baseline'};});
      fs.appendFileSync(file,'\n'+provider);
      const plainNext=submit({session_id:plain.session_id,text:'@'+provider+' next work'});
      await execute(plainNext.task_id,async(_,prompt,opts)=>{assert.ok(prompt.includes('修改 "'+name+'"'));opts.onSubmitted();return {result:'delta'};});
      assert.ok(stateOf(plain.session_id).file_snapshots[provider]);
    }
    const card=submit({text:'@Codex card',inbox_reply:{id:'fixture',action_id:'agent-check'}});
    await execute(card.task_id,async(_,prompt,opts)=>{assert.equal(opts.mode,'ask');assert.doesNotMatch(prompt,/文件变化提示|当前执行进程代码/);return {result:'card'};});
    assert.equal(stateOf(card.session_id).codex_continuation,undefined);
    assert.equal(stateOf(card.session_id).file_snapshots,undefined);
  } finally {fs.unlinkSync(file);write('work/queue.json',saved.queue);write(sessions,saved.sessions);write('agent/config.json',saved.config);}
});

test('large change notices expose a complete metadata-only report at the actual turn directory',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read(sessions),config:read('agent/config.json')};
  const dir='workspace/projects/bi-devices/file-state-many-fixture';
  try {
    write('agent/config.json',{...saved.config,codex_resume_sessions:['*']});
    const first=submit({text:'@Codex many baseline'});
    await execute(first.task_id,async(_,prompt,opts)=>{opts.onContinuation({threadId:'MANY',signature:'S',total:{}},{phase:'start',resumed:false});opts.onSubmitted();return {result:'baseline'};});
    for(let i=0;i<16;i++)fixture(dir+'/'+i+'.md','SECRET BODY NOT IN PROMPT');
    const next=submit({session_id:first.session_id,text:'@Codex many changes'});
    await execute(next.task_id,async(_,prompt,opts)=>{
      assert.match(opts.resumePrompt,/另有 4 个变化/);
      const report=path.join(opts.directory,'file-changes.json');assert.ok(opts.resumePrompt.includes(JSON.stringify(report)));
      const savedReport=JSON.parse(fs.readFileSync(report,'utf8'));assert.equal(savedReport.changes.length,16);
      assert.ok(savedReport.changes.every(c=>c.path.startsWith(dir+'/')));assert.doesNotMatch(JSON.stringify(savedReport),/SECRET BODY/);
      opts.onContinuation({threadId:'MANY',signature:'S',total:{}},{phase:'start',resumed:true});opts.onSubmitted();return {result:'complete metadata available'};
    });
  } finally {fs.rmSync(path.join(root,dir),{recursive:true,force:true});write('work/queue.json',saved.queue);write(sessions,saved.sessions);write('agent/config.json',saved.config);}
});

test('version notice crosses real browser/HTTP boundary: current, stale with busy guard, and legacy unknown at 390px',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const file=path.join(root,'calendar/run.mjs'),bytes=fs.readFileSync(file);
  const saved={queue:read('work/queue.json'),quota:read('.runtime/usage/quota.json',{})};
  let browser;
  try {
    write('.runtime/usage/quota.json',{...saved.quota,codex:{checked_at:new Date().toISOString()}});
    assert.ok((await (await fetch(origin)).text()).includes('<summary id="code-summary">版本待查</summary>'),'initial HTML preserves Chinese before scripts run');
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='current');
    const version=(await (await fetch(origin+'/health')).json()).code.loaded.slice(0,10);
    assert.equal(await page.locator('#code-summary').innerText(),'v.'+version);
    assert.doesNotMatch(await page.locator('.sidebar').innerText(),/代码一致/);
    assert.doesNotMatch(await page.locator('.sidebar').innerText(),/本地运行|刚刚更新/);
    assert.equal(await page.locator('.sidebar-bottom #code-status').count(),1,'replace the old local-running/sync label, not another footer row');
    const placement=await page.locator('#code-status').evaluate(el=>({version:el.getBoundingClientRect().top,footer:document.querySelector('.sidebar-bottom').getBoundingClientRect().top,sessions:document.querySelector('#sessions').getBoundingClientRect().bottom}));
    assert.ok(placement.version>=placement.sessions && placement.version>=placement.footer,'quiet version number inside sidebar footer');
    await page.screenshot({path:path.join(root,'.runtime/file-state-ui-desktop.png'),fullPage:true});
    fs.appendFileSync(file,'\n// stale UI fixture\n');
    write('work/queue.json',{...saved.queue,items:[{id:'busy-fixture',title:'虚构活动任务',status:'active',actor:'codex',project_ids:[]}]});
    await page.reload();await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='stale');
    assert.equal(await page.locator('#code-summary').innerText(),'v.'+version+' ↻');
    assert.match(await page.locator('#code-summary').getAttribute('aria-label'),/需要重启/);
    assert.match(await page.locator('#code-detail').textContent(),/不要现在重启/);
    await page.locator('#code-summary').click();await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no mobile horizontal overflow');
    await page.screenshot({path:path.join(root,'.runtime/file-state-ui-390.png'),fullPage:true});
    const loaded=(await (await fetch(origin+'/health')).json()).code.loaded;
    assert.equal(runtimeCodeStatus().loaded,loaded,'UI polling never restarts the backend');
    fs.writeFileSync(file,bytes);
    await page.route('**/api/state*',async route=>{const response=await route.fetch(),data=await response.json();delete data.code;await route.fulfill({response,json:data});});
    // The sidebar is intentionally hidden on phones; use the real five-second state refresh, not a forced hidden click.
    await page.waitForFunction(()=>document.querySelector('#code-status').dataset.state==='unknown',null,{timeout:15000});
    assert.match(await page.locator('#code-detail').textContent(),/等助手与后台工作结束后重新打开 Workbench/);
    assert.match(await page.locator('#code-detail').textContent(),/用户自己的任务不阻止重启/);
    assert.deepEqual(errors,[]);
  } finally {fs.writeFileSync(file,bytes);write('work/queue.json',saved.queue);write('.runtime/usage/quota.json',saved.quota);if(browser)await browser.close();await new Promise(r=>server.close(r));}
});
