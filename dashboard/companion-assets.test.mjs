import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {companionPackage} from './companion-assets.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const configFile=path.join(root,'dashboard/companion.local.json');
function preserveConfig(){
  const original=fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
  return ()=>{if(original)fs.writeFileSync(configFile,original);else fs.rmSync(configFile,{force:true});};
}
function packageFixture(){
  const directory=fs.mkdtempSync(path.join(root,'.runtime/scene-package-'));
  const files={
    'index.html':'<!doctype html><html><head><link rel="stylesheet" href="scene.css"></head><body><p id="external-scene">External scene fixture</p><img src="assets/pixel.png"><script src="scene.js"></script></body></html>',
    'scene.js':'document.body.dataset.ready="yes";',
    'scene.css':'body{margin:0;background:#d5e9df}',
    'assets/pixel.png':Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'),
    'README.md':'private documentation',
    'config.json':'{"secret":"not public"}',
    '.private/hidden.js':'private',
    'tests/not-public.js':'test code',
  };
  for(const [name,body] of Object.entries(files)){const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
  return {directory,files};
}

test('no local config, missing package and invalid config all mean no scene; no shipped fallback',()=>{
  const restore=preserveConfig();
  try {
    fs.rmSync(configFile,{force:true});assert.equal(companionPackage(),null);
    write('dashboard/companion.local.json',{directory:'.runtime/no-such-package'});assert.equal(companionPackage(),null);
    write('dashboard/companion.local.json',{directory:42});assert.equal(companionPackage(),null);
    fs.writeFileSync(configFile,'{broken');assert.equal(companionPackage(),null);
    assert.equal(fs.existsSync(path.join(root,'dashboard/companion/index.html')),false,'personal scene entry is not distributed');
    assert.equal(fs.existsSync(path.join(root,'dashboard/companion/assets')),false,'personal images are not distributed');
  } finally {restore();}
});

test('external package uses the existing URL with correct bytes, MIME and private cache validation',async()=>{
  const restore=preserveConfig(),fixture=packageFixture();let server;
  try {
    write('dashboard/companion.local.json',{directory:fixture.directory});
    const pack=companionPackage();assert.equal(pack.directory,fixture.directory);assert.equal(pack.assets.size,4);
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal((await (await fetch(base+'/health')).json()).companion_scenes,true);
    for(const [file,mime] of [['index.html','text/html'],['scene.js','text/javascript'],['scene.css','text/css'],['assets/pixel.png','image/png']]){
      const response=await fetch(base+'/companion/'+file);assert.equal(response.status,200);
      assert.ok(response.headers.get('content-type').startsWith(mime));
      assert.equal(response.headers.get('cache-control'),'private, no-cache');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(fixture.files[file]));
      assert.equal((await fetch(base+'/companion/'+file,{headers:{'if-none-match':response.headers.get('etag')}})).status,304);
    }
    for(const file of ['README.md','config.json','.private/hidden.js','tests/not-public.js','../agent/config.json','..%2f..%2fagent/config.json'])assert.equal((await fetch(base+'/companion/'+file)).status,404,file);
  } finally {if(server)await new Promise(r=>server.close(r));restore();fs.rmSync(fixture.directory,{recursive:true,force:true});}
});

test('fresh download has no scene requests or blank slot, still sends chat; configured package mounts sandboxed', {timeout:45000},async()=>{
  const restore=preserveConfig(),fixture=packageFixture();
  const files=['agent/config.json','.runtime/agent/sessions.json','work/queue.json'];
  const originals=Object.fromEntries(files.map(file=>[file,read(file)]));
  let browser,server;
  try {
    write('agent/config.json',{...originals['agent/config.json'],enabled:false});
    browser=await launchEdge();
    for(const mode of ['unconfigured','missing','configured']) {
      if(mode==='unconfigured')fs.rmSync(configFile,{force:true});
      else write('dashboard/companion.local.json',{directory:mode==='missing' ? '.runtime/no-such-package' : fixture.directory});
      write('.runtime/agent/sessions.json',{sessions:[]});write('work/queue.json',{...originals['work/queue.json'],items:[]});
      server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const base='http://127.0.0.1:'+server.address().port;
      const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),requests=[],errors=[];
      page.on('request',r=>requests.push(new URL(r.url()).pathname));page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
      const health=page.waitForResponse(r=>new URL(r.url()).pathname==='/health');
      await page.goto(base);assert.equal((await (await health).json()).companion_scenes,mode==='configured');
      await page.locator('#message').fill('External scene '+mode);
      if(mode==='configured') {
        await page.frameLocator('.companion-frame').locator('body[data-ready="yes"] #external-scene').waitFor();
        assert.equal(await page.locator('.companion-frame').getAttribute('sandbox'),'allow-scripts');
        assert.equal(await page.frameLocator('.companion-frame').locator('img').evaluate(el=>el.complete&&el.naturalWidth>0),true);
      } else {
        await page.locator('.companion-slot').waitFor({state:'hidden'});
        assert.equal(await page.locator('.companion-slot').evaluate(el=>el.getBoundingClientRect().height),0);
        assert.equal(await page.locator('.companion-frame').count(),0);
        assert.deepEqual(requests.filter(url=>url.startsWith('/companion/')),[]);
        assert.equal((await fetch(base+'/companion/index.html')).status,404);
        assert.equal(await page.getByText('小场景已准备好',{exact:false}).count(),0);
      }
      const dir=path.join(root,'.runtime/external-scene-review');fs.mkdirSync(dir,{recursive:true});
      await page.screenshot({path:path.join(dir,mode+'.png')});
      const sent=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat'&&r.request().method()==='POST');
      await page.locator('#send').click();assert.equal((await (await sent).json()).task.status,'queued');
      await page.locator('.message-text').filter({hasText:'External scene '+mode}).waitFor();
      assert.equal(await page.locator('.companion-frame').count(),0,'sending chat tears down the optional scene');
      assert.deepEqual(errors,[]);
      await context.close();await new Promise(r=>server.close(r));server=null;
    }
  } finally {await browser?.close();if(server)await new Promise(r=>server.close(r));restore();for(const [file,value] of Object.entries(originals))write(file,value);fs.rmSync(fixture.directory,{recursive:true,force:true});}
});
