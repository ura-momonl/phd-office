import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {known,observed,billed,usageGroups,speedGroups} from './metrics.mjs';
import {recordRun,usageSnapshot,usageDigest} from './run.mjs';
import {usageSections} from '../dashboard/usage-view.js';
import {createServer} from '../dashboard/server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {root} from '../automation/files.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const measured={id:'deepseek-full',provider:'deepseek',model:'fixture',purpose:'chat',status:'completed',usage_known:true,input_tokens:1000000,cached_input_tokens:990000,output_tokens:1000,duration_ms:10000,tool_calls:2};
const partial={...measured,id:'deepseek-partial',status:'failed',usage_known:false,usage_partial:true,input_tokens:2000,cached_input_tokens:1000,output_tokens:300};
const unknown={...measured,id:'deepseek-unknown',usage_known:false,input_tokens:9999,output_tokens:9999};

test('observed partial tokens reach ledger, CLI and provider/model tables without becoming complete or zero',()=>{
  for(const r of [measured,partial,unknown])recordRun(r);
  const snap=usageSnapshot(),g=usageGroups(snap.runs,r=>r.provider).find(g=>g.key==='deepseek');
  assert.equal(known(partial),false);assert.equal(observed(partial),true);assert.equal(observed(unknown),false);
  assert.equal(g.input,1002000);assert.equal(g.output,1300);assert.equal(g.cached,991000);
  assert.equal(g.partial,1);assert.equal(g.unknown,1);assert.equal(g.billed,12300);
  assert.equal(billed(partial),1300);assert.equal(speedGroups([partial]).length,0);
  const digest=Object.values(usageDigest(snap).recent_days).find(g=>g.partial_usage===1);
  assert.equal(digest.input_tokens,1002000);assert.equal(digest.output_tokens,1300);assert.equal(digest.unknown_usage,1);
  const view=usageSections(snap.runs);
  for(const html of [view.provider,view.use]){
    assert.match(html,/总输入（含缓存）/);assert.match(html,/总输出/);
    assert.match(html,/1,002,000/);assert.match(html,/1,300/);assert.match(html,/1 次仅部分用量/);
  }
  assert.match(view.note,/缓存输入是其中一部分/);assert.match(view.note,/汇总是下界/);
});

test('usage page shows total input/output separately from uncached metric, on desktop and mobile',async()=>{
  const server=createServer();let browser;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route(url=>url.pathname==='/api/state',async r=>{
      const response=await r.fetch(),state=await response.json();
      state.usage.runs=[measured,partial,unknown].map(r=>({...r,at:new Date().toISOString()}));
      await r.fulfill({response,json:state});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.nav[data-page="more"]').click();
    await page.locator('.more-tab[data-page="usage"]').click();
    const input=page.locator('#usage-totals .stat').filter({has:page.locator('span').filter({hasText:/^总输入（含缓存）$/})});
    assert.equal(await input.getAttribute('title'),'1,002,000 token');
    assert.match(await input.textContent(),/部分用量/);
    const output=page.locator('#usage-totals .stat').filter({has:page.locator('span').filter({hasText:/^总输出$/})});
    assert.equal(await output.getAttribute('title'),'1,300 token');
    for(const summary of await page.locator('details.usage-more>summary').all())await summary.click();
    const row=page.locator('#usage-by-provider tbody tr').filter({hasText:'DeepSeek'});
    assert.equal(await row.locator('td').nth(3).textContent(),'1,002,000');
    assert.equal(await row.locator('td').nth(4).textContent(),'1,300');
    assert.match(await page.locator('#usage-table').textContent(),/≥ 2,000/);
    const dir=path.join(root,'.runtime/token-usage-ui');fs.mkdirSync(dir,{recursive:true});
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1100});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.locator('#page-usage').screenshot({path:path.join(dir,`${width}.png`)});
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
