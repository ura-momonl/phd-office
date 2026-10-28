import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('uploaded avatars replace the shipped one everywhere; the settings page crops them in a window',async()=>{
  fs.rmSync(path.join(root,'dashboard/avatars/custom'),{recursive:true,force:true});
  write('dashboard/avatars/view.json',{});
  const at=new Date().toISOString(),id='avatar-ui';
  write('work/queue.json',{...read('work/queue.json'),items:[{id,actor:'deepseek',executor:'deepseek',kind:'framework',title:'Avatar UI',status:'done',project_ids:[],outputs:[],dependencies:[],created_at:at,completed_at:at}]});
  write('.runtime/agent/sessions.json',{sessions:[{id,title:'头像',origin:'chat',project_ids:[],task_ids:[id],created_at:at,
    messages:[{role:'user',text:'@DeepSeek 你好',at,task_id:id},{role:'assistant',provider:'deepseek',text:'来了',at,task_id:id}]}]});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;let browser;
  try{
    const post=body=>fetch(base+'/api/avatars/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.equal((await post({who:'claude',image:'data:text/plain;base64,aGk='})).status,400);
    assert.equal((await post({who:'nobody',image:png})).status,400);
    assert.equal((await post({who:'claude',image:png})).status,200);
    assert.match(await (await fetch(base+'/avatars/view.css')).text(),/^img\[data-who="claude"\]\{content:url\(\/avatars\/custom\/claude\?v=\d+\)\}/);
    const custom=await fetch(base+'/avatars/custom/claude');assert.equal(custom.status,200);assert.equal(custom.headers.get('content-type'),'image/png');
    assert.equal((await post({who:'claude',image:null})).status,200);
    assert.equal((await fetch(base+'/avatars/custom/claude')).status,404);
    assert.equal((await (await fetch(base+'/avatars/view.css')).text()).trim(),'');

    browser=await launchEdge({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.locator('button.nav[data-page="more"]').click();await page.locator('.chat-tab[data-page="connections"]').click();
    await page.locator('[data-settings-tab="avatars"]').click();
    assert.equal(await page.locator('.avatar-item').count(),4);
    assert.equal(await page.locator('[data-avatar-original]:visible').count(),0);
    const item=page.locator('[data-who-item="codex"]');
    await item.locator('input[type=file]').setInputFiles(path.join(root,'dashboard/avatars/claude.webp'));
    const dialog=page.locator('.avatar-crop');await dialog.waitFor();
    await dialog.locator('input[type=range]').evaluate(el=>{el.value=250;el.dispatchEvent(new Event('input',{bubbles:true}));});
    const stage=await dialog.locator('canvas').boundingBox();
    await page.mouse.move(stage.x+130,stage.y+130);await page.mouse.down();await page.mouse.move(stage.x+160,stage.y+150,{steps:4});await page.mouse.up();
    await page.screenshot({path:path.join(root,'output/avatar-crop.png')});
    await dialog.locator('[data-ok]').click();
    await item.locator('.avatar-status').filter({hasText:'已更换'}).waitFor();
    assert.equal(await page.locator('.avatar-crop').count(),0);
    const saved=fs.readdirSync(path.join(root,'dashboard/avatars/custom'));assert.deepEqual(saved,['codex.webp']);
    assert.match(await item.locator('img').evaluate(el=>getComputedStyle(el).content),/avatars\/custom\/codex/);
    await item.locator('[data-avatar-original]').waitFor({state:'visible'});
    await page.screenshot({path:path.join(root,'output/avatar-row.png')});
    // cancel leaves things alone
    await item.locator('input[type=file]').setInputFiles(path.join(root,'dashboard/avatars/user.webp'));
    await page.locator('.avatar-crop [data-cancel]').click();assert.equal(await page.locator('.avatar-crop').count(),0);
    await item.locator('[data-avatar-original]').click();
    await item.locator('.avatar-status').filter({hasText:'还原'}).waitFor();
    assert.equal(fs.existsSync(path.join(root,'dashboard/avatars/custom/codex.webp')),false);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
