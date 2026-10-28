import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {extraResetSummary,renderExtraResets} from './usage-view.js';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const now=Date.parse('2026-10-17T19:30:00Z');
const src={id:'didcodexreset',name:'Did Codex Reset',url:'https://didcodexreset.com/',status:'announced',reset_type:'global',checked_at:'2026-10-17T19:25:00Z',announced_at:'2026-10-17T16:20:57Z',window_start:'2026-10-17T08:00:00Z',window_end:'2026-10-18T08:00:00Z',precision:'date',confidence:0.8,original_url:'https://x.com/thsottiaux/status/2111492673890824348'};
const notices={checked_at:'2026-10-17T19:25:00Z',account:{feature_enabled:false,messages:[]},sources:[src]};
const summary=(o,t=now)=>extraResetSummary({...notices,sources:[{...src,...o}]},t);

test('compact outlook shows only the pending announcement window, or says plainly that there is none',()=>{
  assert.equal(summary({}),'额外预告：10/18 03:00前');
  assert.ok(summary({}).length<30);
  assert.doesNotMatch(summary({}),/6h|24h|估|概率|更新/);
  assert.equal(summary({reset_type:'banked'}),'额外预告：10/18 03:00前');
  assert.equal(summary({status:'none',window_end:null}),'额外：暂无已公布预告');
  assert.equal(summary({},Date.parse('2026-10-17T19:50:00Z')),'额外：预告过期');
  assert.equal(summary({window_end:'2026-10-17T19:00:00Z'}),'额外：暂无已公布预告');
  assert.equal(summary({status:'unknown',window_end:null}),'额外预告：全局重置（时间未解析）');
  assert.equal(summary({status:'error'}),'额外：暂不可用');
  assert.equal(summary({status:'ok'}),'额外：暂不可用');
  assert.equal(summary({checked_at:'bad'}),'额外：预告过期');
  assert.equal(extraResetSummary(undefined,now),'额外：待刷新');
  assert.equal(extraResetSummary({...notices,sources:[]},now),'额外：待刷新');
  const html=renderExtraResets({...notices,account:{feature_enabled:true,messages:[{text:'<img src=x onerror=alert(1)> usage reset'}]},sources:[{...src,original_url:'javascript:alert(1)',name:'<script>bad()</script>',status:'unknown'}]},{now});
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('<section'));assert.ok(!html.includes('<details'));
  assert.match(renderExtraResets(notices,{now}),/href="https:\/\/x\.com\/thsottiaux\/status\/2111492673890824348"/);
  assert.match(renderExtraResets({...notices,sources:[{...src,status:'none'}]},{now}),/href="https:\/\/didcodexreset\.com\//);
  assert.match(renderExtraResets(notices,{now}),/title="[^"]*不是个人到账保证[^"]*"/);
  assert.match(renderExtraResets(notices,{now}),/只精确到日期/);
});

test('both quota locations show one short next-reset outlook without altering the ordinary reset',async()=>{
  const original=read('.runtime/usage/quota.json',{}),server=createServer();let browser;
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    write('.runtime/usage/quota.json',{...original,codex:{checked_at:'2026-10-17T19:30:00Z',limits:{rateLimits:{primary:{usedPercent:8,windowDurationMins:10080,resetsAt:1792472850}}}},extra_resets:notices,deepseek:{checked_at:'2026-10-17T19:30:00Z',is_available:true,balance_infos:[{currency:'CNY',total_balance:'6.40',granted_balance:'0.00',topped_up_balance:'6.40'},{currency:'USD',total_balance:'0.00',granted_balance:'0.00',topped_up_balance:'0.00'}]}});
    const {chromium}=await import(process.env.PHD_TEST_PLAYWRIGHT);browser=await launchEdge(chromium,{headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-10-17T19:30:00Z');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    const response=await page.goto(`http://127.0.0.1:${server.address().port}`);assert.equal(response.status(),200);
    const module=await page.request.get(`http://127.0.0.1:${server.address().port}/usage-view.js`);assert.equal(module.status(),200);
    assert.equal(await module.text(),fs.readFileSync(path.join(root,'dashboard/usage-view.js'),'utf8'));
    const balance=page.locator('#quota-strip [data-provider="deepseek"]');await balance.waitFor();
    assert.match(await balance.textContent(),/DeepSeek · 余额.*¥6.40 \/ \$0.00/);
    assert.equal(await page.locator('#quota-strip .header-quota').count(),3);
    assert.equal(await balance.locator('.meter').count(),0);
    assert.equal(await balance.getAttribute('data-open-url'),'https://platform.deepseek.com/top_up');
    assert.equal(await balance.locator('[data-price-period]').textContent(),'谷值');
    assert.equal(await balance.locator('.header-reset').count(),0);
    assert.doesNotMatch(await balance.textContent(),/更新|10\/17/);
    assert.match(await balance.getAttribute('title'),/CNY 总余额 6.40；赠金 0.00；充值 6.40/);
    for(const width of [1024,1152,1440,2560]){
      await page.setViewportSize({width,height:1000});
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
        clipped:[...document.querySelectorAll('#quota-strip .header-quota')].filter(e=>e.scrollWidth>e.clientWidth+1 || e.getBoundingClientRect().right>innerWidth).map(e=>e.textContent),
        overlaps:document.querySelector('.breadcrumb').getBoundingClientRect().right>document.querySelector('.top-actions').getBoundingClientRect().left}));
      assert.ok(layout.scroll<=width+1 && !layout.overlaps && !layout.clipped.length,JSON.stringify(layout));
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.topbar').screenshot({path:path.join(root,'.runtime/deepseek-header.png')});
    assert.equal(await page.locator('#quick-quota').count(),0);
    // A current announcement replaces the natural reset time in the top bar (Codex only); the natural time stays in the tooltip.
    const codexReset=page.locator('#quota-strip .header-quota').first().locator('.header-reset');
    await codexReset.waitFor();
    assert.match(await codexReset.textContent(),/重置 10\/18 03:00前 · 预告/);
    assert.equal(await codexReset.locator('time').getAttribute('datetime'),'2026-10-18T08:00:00.000Z');
    assert.match(await codexReset.getAttribute('title'),/自然重置时间：10\/20 00:07 · Chicago/);
    assert.doesNotMatch(await page.locator('#quota-strip .header-quota').first().textContent(),/10\/20/);
    await page.locator('#quota-strip [data-page="usage"]').first().click();
    const full=page.locator('#quota-cards .quota-card').first().locator('.quota-window small [data-extra-reset]');await full.waitFor();assert.match(await full.textContent(),/额外预告：10\/18 03:00前/);
    assert.equal(await full.locator('a').count(),1);assert.equal(await full.locator('a').getAttribute('href'),'https://x.com/thsottiaux/status/2111492673890824348');
    assert.equal(await page.locator('#quota-cards > *').count(),2);assert.equal(await page.locator('#quota-cards details').count(),0);
    assert.doesNotMatch(await page.locator('#quota-cards').textContent(),/Reset Watch|Estimate|6h|24h/);
    await page.locator('#quota-cards').screenshot({path:path.join(root,'.runtime/extra-reset-usage.png')});
    assert.doesNotMatch(await full.textContent(),/完成报告|更新|非官方|实验性|6h|24h/);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(r=>server.close(r));write('.runtime/usage/quota.json',original);}
});

test('pending reset text and filled bar shimmer without a frame, invalid notices clear effects, and stale notices refresh',async()=>{
  const server=createServer();let browser;
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=path.join(root,'.runtime/reset-effects');fs.mkdirSync(dir,{recursive:true});
  try{
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-10-17T19:30:00Z');});
    let source={...src},checked=notices.checked_at,refreshes=0;
    await page.route('**/api/usage/refresh',r=>{refreshes++;return r.fulfill({json:{}});});
    await page.route(url=>url.pathname==='/api/state',async r=>{
      const response=await r.fetch(),state=await response.json();
      state.usage.quota={codex:{checked_at:new Date(now).toISOString(),limits:{rateLimits:{primary:{usedPercent:87,windowDurationMins:10080,resetsAt:1792472850}}}},
        claude:{windows:[{label:'5 小时窗口',remaining_percent:13,resets_at:new Date(now+3600000).toISOString()}]},
        extra_resets:{checked_at:checked,sources:[{...source,checked_at:checked}]}};
      await r.fulfill({response,json:state});
    });
    const url=`http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const halo=page.locator('#quota-strip .reset-announced'),text=halo.locator('.header-reset.extra');
    await text.waitFor();assert.equal(await halo.count(),1);
    assert.match(await halo.textContent(),/Codex.*13%.*预告/);
    assert.equal(await halo.locator('.meter .crit').count(),1,'announcement must not hide low-quota warning');
    const bar=halo.locator('.meter i');
    const sheen=await bar.evaluate(e=>{
      const before={width:e.getBoundingClientRect().width,colour:getComputedStyle(e).backgroundColor};
      const a=e.getAnimations({subtree:true}).find(a=>a.animationName==='reset-meter-sweep');a.pause();a.currentTime=0;
      const start=getComputedStyle(e,'::after').transform;a.currentTime=1600;
      return {before,after:{width:e.getBoundingClientRect().width,colour:getComputedStyle(e).backgroundColor},
        positions:[start,getComputedStyle(e,'::after').transform],ratio:e.getBoundingClientRect().width/e.parentElement.getBoundingClientRect().width};
    });
    assert.deepEqual(sheen.before,sheen.after,'sheen must not change quota width or warning colour');
    assert.ok(Math.abs(sheen.ratio-.13)<.01,'filled width still represents 13% remaining');
    assert.notEqual(sheen.positions[0],sheen.positions[1],'highlight moves across the filled part');
    assert.equal(await page.locator('#quota-strip .header-quota').nth(1).locator('.meter i').evaluate(e=>getComputedStyle(e,'::after').content),'none');
    assert.equal(await page.locator('.reset-sparkles').count(),0);
    const appearance=await halo.evaluate(e=>({shadow:getComputedStyle(e).boxShadow,background:getComputedStyle(e).backgroundImage,before:getComputedStyle(e,'::before').content}));
    assert.deepEqual(appearance,{shadow:'none',background:'none',before:'none'},'no frame, panel background or overlay');
    assert.equal(await text.evaluate(e=>getComputedStyle(e).animationName),'reset-flow');
    assert.equal(await text.evaluate(e=>getComputedStyle(e).backgroundClip),'text');
    const positions=await text.evaluate(e=>{
      const a=e.getAnimations()[0];a.pause();a.currentTime=0;
      const start=getComputedStyle(e).backgroundPosition;
      a.currentTime=3000;return [start,getComputedStyle(e).backgroundPosition];
    });
    assert.notEqual(positions[0],positions[1],'gradient actually travels across the text');
    fs.writeFileSync(path.join(dir,'text-effect.json'),JSON.stringify({appearance,positions,sheen},null,2));
    await page.screenshot({path:path.join(dir,'text-and-bar-shimmer.png'),clip:await page.locator('.topbar').boundingBox(),animations:'allow'});
    const node=await text.elementHandle();
    await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state'); // The existing 5-second poll.
    assert.equal(await node.evaluate(e=>e.isConnected),true,'unchanged polling keeps the running light node');
    assert.equal(refreshes,0,'fresh quota and notice need no extra fetch');
    await page.reload();await text.waitFor();
    for(const invalid of [{status:'error'},{status:'none'},{status:'unknown'},{window_end:new Date(now-1000).toISOString()}]){
      source={...src,...invalid};await page.reload();
      await page.waitForFunction(()=>document.querySelector('#quota-strip .header-reset'));
      assert.equal(await halo.count(),0);
      assert.equal(await page.locator('#quota-strip .header-reset').first().evaluate(e=>getComputedStyle(e).animationName),'none');
      assert.equal(await page.locator('#quota-strip .header-quota').first().locator('.meter i').evaluate(e=>getComputedStyle(e,'::after').animationName),'none');
      assert.match(await page.locator('#quota-strip .header-reset').first().textContent(),/10\/20 00:07/);
    }
    source={...src};checked=new Date(now-21*60000).toISOString();
    const requested=page.waitForResponse('**/api/usage/refresh');await page.reload();await requested;
    assert.ok(refreshes>0,'expired announcement refreshes even though the Codex reading is current');
    assert.equal(await halo.count(),0);
    checked=notices.checked_at;await page.reload();await text.waitFor();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.reload();await text.waitFor();
    const reduced=await text.evaluate(e=>({animation:getComputedStyle(e).animationName,background:getComputedStyle(e).backgroundImage,fill:getComputedStyle(e).webkitTextFillColor}));
    assert.equal(reduced.animation,'none');assert.equal(reduced.background,'none');assert.notEqual(reduced.fill,'rgba(0, 0, 0, 0)');
    assert.equal(await bar.evaluate(e=>getComputedStyle(e,'::after').display),'none');
    await page.locator('.topbar').screenshot({path:path.join(dir,'reduced-motion.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});

test('usage fits narrow screens while every table and the 30-day chart remain readable',async()=>{
  const server=createServer();let browser;
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=path.join(root,'.runtime/usage-mobile');fs.mkdirSync(dir,{recursive:true});
  try{
    browser=await launchEdge();const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route(url=>url.pathname==='/api/state',async r=>{
      const response=await r.fetch(),state=await response.json();
      assert.ok(response.ok() && state.usage,JSON.stringify(state));
      state.usage.runs=Array.from({length:20},(_,i)=>({id:'mobile-'+i,at:new Date(Date.now()-i*86400000).toISOString(),provider:i%2?'claude':'codex',model:'long-model-name-for-mobile-compatibility',purpose:'agent',status:i%3?'completed':'failed',usage_known:true,input_tokens:123456789,cached_input_tokens:98765432,output_tokens:23456789,duration_ms:92000,tool_calls:31}));
      state.usage.quota={codex:{checked_at:new Date().toISOString(),limits:{rateLimits:{primary:{usedPercent:8,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}},claude:{checked_at:new Date().toISOString(),windows:[{label:'Weekly long quota window',remaining_percent:57,resets_at:new Date(Date.now()+86400000).toISOString()}]},extra_resets:{...notices,sources:[{...src,checked_at:new Date().toISOString(),window_end:new Date(Date.now()+86400000).toISOString()}]}};
      await r.fulfill({response,json:state});
    });
    await page.setViewportSize({width:390,height:844});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.nav[data-page="more"]').click();
    await page.locator('.more-tab[data-page="usage"]').click();
    assert.equal(await page.locator('details.usage-more[open]').count(),0,'narrow screens start with the long usage tables collapsed');
    for(const summary of await page.locator('details.usage-more>summary').all())await summary.click();
    await page.locator('#usage-breakdown table').first().waitFor();
    const measurements=[];
    for(const width of [320,390,600,844,1440]){
      await page.setViewportSize({width,height:900});
      for(const days of ['7']){
        assert.equal(await page.locator('#usage-period').count(),0,'the usage page is fixed to the last 7 days');
        const layout=await page.evaluate(()=>({
          viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,
          outside:[...document.querySelectorAll('#page-usage .quota-card,#page-usage .stat,#page-usage .usage-history')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.className),
          clippedStats:[...document.querySelectorAll('#usage-totals strong')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent)
        }));
        measurements.push({width,days,...layout});
        fs.writeFileSync(path.join(dir,'measurements.json'),JSON.stringify(measurements,null,2));
        await page.locator('#page-usage').screenshot({path:path.join(dir,`${width}-${days}.png`)});
        assert.ok(layout.pageWidth<=width+1,JSON.stringify(layout));
        assert.deepEqual(layout.outside,[]);assert.deepEqual(layout.clippedStats,[]);
        assert.equal(await page.locator('#page-usage table').count(),5);
        for(const scroll of await page.locator('#page-usage .usage-table-scroll,#usage-chart').all()){
          const result=await scroll.evaluate(e=>{e.scrollLeft=e.scrollWidth;return {overflow:e.scrollWidth>e.clientWidth+1,reached:e.scrollLeft>0};});
          if(result.overflow)assert.equal(result.reached,true,'overflow content must be reachable');
        }
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
