import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('Command Code retained quota stays on one header line without a last-reading label',async()=>{
  const files=['.runtime/usage/quota.json','.runtime/deepseek-harness/provider.json'];
  const originals=files.map(f=>fs.existsSync(path.join(root,f)) ? fs.readFileSync(path.join(root,f)) : null);
  const server=createServer();let browser;
  try{
    write(files[1],{provider:'commandcode'});
    const window=remaining_percent=>({remaining_percent,used:1,cap:10,resets_at:'2099-01-01T00:00:00Z'});
    write(files[0],{...read(files[0],{}),commandcode:{five_hour:window(78),weekly:window(89),checked_at:new Date().toISOString(),error:'HTTP 503'}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const card=page.locator('#quota-strip [data-provider="deepseek"]');await card.waitFor();
    assert.match(await card.getAttribute('title'),/HTTP 503/);
    assert.doesNotMatch(await card.textContent(),/上次读数/);
    assert.equal(await card.locator('b').textContent(),'78%');
    assert.match(await card.locator('.header-reset').textContent(),/5小时 78% · 每周 89%/);
    for(const width of [1440,1100,950]){
      await page.setViewportSize({width,height:1000});
      const layout=await card.evaluate(e=>{
        const label=e.querySelector('div:first-child>span'),value=e.querySelector('b');
        const range=document.createRange();range.selectNodeContents(label);
        const a=label.getBoundingClientRect(),b=value.getBoundingClientRect();
        return {lines:range.getClientRects().length,label:a.right,value:b.left,overflow:e.scrollWidth>e.clientWidth+1};
      });
      assert.equal(layout.lines,1,`label at ${width}px`);
      assert.ok(layout.label<=layout.value,`label and percentage do not overlap at ${width}px`);
      assert.equal(layout.overflow,false,`quota fits at ${width}px`);
    }
  }finally{
    await browser?.close();await new Promise(r=>server.close(r));
    files.forEach((f,i)=>{if(originals[i]===null)fs.rmSync(path.join(root,f),{force:true});else fs.writeFileSync(path.join(root,f),originals[i]);});
  }
});
