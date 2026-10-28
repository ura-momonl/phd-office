import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {instrumentCatalog,instrumentCode,openInstrumentCode,runInstrumentCode,saveInstrument} from './library.mjs';
import {createServer} from '../dashboard/server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --instruments in a sanitised copy');
const code='instruments/programs/fixture/driver.py';
const text='# Fictional driver; do not execute.\nraise RuntimeError("NEVER_EXECUTE")\n';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6lkAAAAASUVORK5CYII=';
test('6221 panel runs offline controller and real Tk acceptance in the sanitised copy',{timeout:30000},()=>{
  const cwd=path.join(root,'instruments/programs/keithley-6221');
  const result=spawnSync('python',['test_control_offline.py'],{cwd,encoding:'utf8',timeout:25000,env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(result.status,0,(result.error?.message || '')+'\n'+result.stdout+'\n'+result.stderr);
});
function fixture(name='示例 Lock-in') {
  fs.mkdirSync(path.join(root,'instruments/programs/fixture'),{recursive:true});fs.writeFileSync(path.join(root,code),text);
  return {name,model:'FICTIONAL-1',category:'示例电学',purpose:'虚构测试用途',connection:'模拟 VISA',cautions:'不会连接真实仪器',code_paths:[code],project_ids:[],photo:''};
}
test('instrument store starts without real cards; validates, persists, preserves code and rejects stale edits',()=>{
  assert.deepEqual(instrumentCatalog().items,[]);
  const first=saveInstrument(fixture()),next=saveInstrument({...first,name:'示例仪器已编辑',photo:png});
  assert.equal(instrumentCatalog().items.length,1);assert.equal(next.photo,png);
  assert.equal(fs.readFileSync(path.join(root,code),'utf8'),text);
  assert.throws(()=>saveInstrument(first),/已被更新/);
  assert.throws(()=>saveInstrument({...fixture(),name:''}),/名称/);
  assert.throws(()=>saveInstrument({...fixture(),code_paths:['instruments/programs/../catalog.json']}),/代码必须/);
  assert.throws(()=>saveInstrument({...fixture(),code_paths:['workspace/projects/graphene-thz/README.md']}),/代码必须/);
  assert.throws(()=>saveInstrument({...fixture(),photo:'data:image/svg+xml;base64,PHN2Zz4='}),/照片/);
  assert.throws(()=>saveInstrument({...fixture(),photo:'data:image/png;base64,QUJDRA=='}),/照片/);
  assert.throws(()=>saveInstrument({...fixture(),sop_url:'javascript:alert(1)'}),/链接/);
  assert.throws(()=>saveInstrument({...fixture(),project_ids:['unknown']}),/Unknown project/);
  write('instruments/catalog.json',{version:1,items:[]});
});
test('registered code is read from the current file, never executed, and cannot expose unregistered files',()=>{
  const item=saveInstrument(fixture());const before=instrumentCode(item.id,0);
  assert.equal(before.text,text);assert.match(before.sha256,/^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(root,code),'# Changed fixture\n');
  assert.notEqual(instrumentCode(item.id,0).sha256,before.sha256);
  assert.throws(()=>instrumentCode(item.id,'../0'),/未找到/);assert.throws(()=>instrumentCode('unknown',0),/未找到/);
  write('instruments/catalog.json',{version:1,items:[]});
});
test('open request launches only registered files, never executes them',async()=>{
  const item=saveInstrument(fixture()),seen=[];
  assert.deepEqual(await openInstrumentCode(item.id,0,f=>seen.push(f)),{opened:'driver.py'});assert.equal(seen.length,1);
  await assert.rejects(()=>openInstrumentCode(item.id,'../0',f=>seen.push(f)),/未找到/);await assert.rejects(()=>openInstrumentCode('unknown',0,f=>seen.push(f)),/未找到/);
  assert.equal(seen.length,1);write('instruments/catalog.json',{version:1,items:[]});
});
test('only files listed in run_paths can be started from the page',async()=>{
  const item=saveInstrument(fixture()),seen=[];
  await assert.rejects(()=>runInstrumentCode(item.id,0,f=>seen.push(f)),/没有被设置/);assert.equal(seen.length,0);
  const run=saveInstrument({...item,run_paths:[code]});assert.deepEqual(run.run_paths,[code]);
  assert.deepEqual(await runInstrumentCode(run.id,0,f=>seen.push(f)),{started:'driver.py'});assert.equal(seen.length,1);
  const renamed=saveInstrument({...run,name:'改名',run_paths:undefined});assert.deepEqual(renamed.run_paths,[code]);   // an edit that does not send run_paths keeps it
  assert.deepEqual(saveInstrument({...renamed,code_paths:[]}).run_paths,[]);      // unregistered files cannot stay runnable
  write('instruments/catalog.json',{version:1,items:[]});
});
test('real more-tab UI searches, opens registered code in the editor, edits cards without touching code, and fits mobile',{timeout:90000},async()=>{
  saveInstrument(fixture());saveInstrument({...fixture('示例 Keithley'),model:'FICTIONAL-6221',category:'示例电流源',run_paths:[code]});
  let server,browser,page;const errors=[],opened=[],ran=[];
  try {
    server=createServer({openCode:file=>opened.push(file),runCode:file=>ran.push(file)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route('**/api/companion/notes',r=>r.fulfill({json:{enabled:false,messages:[]}}));
    await page.goto(base);await page.locator('#overview').waitFor();
    await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="instruments"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.instrument-card').length===2);
    assert.equal(await page.locator('.nav[data-page="more"]').getAttribute('class'),'nav active');
    assert.equal(await page.locator('#more-tabs .more-tab.active').textContent(),'仪器图鉴');
    assert.equal(await page.locator('#page-instruments').getAttribute('aria-busy'),'false');
    await page.locator('#instrument-search').fill('6221');assert.equal(await page.locator('.instrument-card').count(),1);
    await page.locator('#instrument-search').fill('');await page.locator('#instrument-category').selectOption({label:'示例电流源'});assert.equal(await page.locator('.instrument-card').count(),1);
    await page.locator('#instrument-category').selectOption('');
    const card=page.locator('.instrument-card').filter({hasText:'示例 Lock-in'});
    assert.equal(await card.locator('[data-code-id]').count(),0);
    await card.locator('[data-code-open]').click();await page.waitForFunction(()=>!document.querySelector('[data-code-open]').disabled);
    assert.deepEqual(opened,[fs.realpathSync(path.join(root,code))]);assert.equal(await page.locator('#instrument-message').textContent(),'');
    const keithley=page.locator('.instrument-card').filter({hasText:'示例 Keithley'});
    assert.equal(await card.locator('[data-code-run]').count(),0);assert.equal(await keithley.locator('[data-code-run]').count(),1);
    await keithley.locator('[data-code-run]').click();await page.waitForFunction(()=>!document.querySelector('[data-code-run]').disabled);
    assert.deepEqual(ran,[fs.realpathSync(path.join(root,code))]);assert.equal(opened.length,1);assert.equal(await page.locator('#instrument-message').textContent(),'');
    await card.getByRole('button',{name:'编辑'}).click();await page.locator('input[name="location"]').fill('示例实验室 <不是 HTML>');
    await page.locator('input[name="photo"]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
    await page.locator('#instrument-save').click();await page.locator('#instrument-editor').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('.instrument-card')?.textContent.includes('示例实验室 <不是 HTML>'));
    assert.equal(await page.locator('.instrument-photo img').count(),1);
    assert.equal(fs.readFileSync(path.join(root,code),'utf8'),text);
    // Polling does not replace the editor or lose unsaved entries.
    await page.locator('.instrument-card').first().getByRole('button',{name:'编辑'}).click();await page.locator('input[name="location"]').fill('UNSAVED-DRAFT');
    await page.waitForTimeout(5500);assert.equal(await page.locator('input[name="location"]').inputValue(),'UNSAVED-DRAFT');await page.locator('#instrument-cancel').click();
    const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'instruments-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:900});
    assert.equal(await page.locator('#page-instruments').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(dir,'instruments-mobile.png'),fullPage:true});
    // Reject foreign writes via the same shared origin gate, leaving the store unchanged.
    const bad=await fetch(base+'/api/instruments/save',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://foreign.example'},body:JSON.stringify(fixture())});assert.equal(bad.status,400);assert.match((await bad.json()).error,/Origin/);
    await page.reload();await page.locator('.nav[data-page="more"]').click();await page.locator('.more-tab[data-page="instruments"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.instrument-card').length===2);assert.ok((await page.locator('#instrument-grid').textContent()).includes('示例实验室 <不是 HTML>'));
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));write('instruments/catalog.json',{version:1,items:[]});}
});
