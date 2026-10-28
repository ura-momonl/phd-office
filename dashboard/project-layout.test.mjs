import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {read} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run through scripts/run-tests.mjs in an isolated copy');

test('project controls sit below weekly focus and remain reachable while scrolling',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const server=createServer();let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const fixture=await (await fetch(base+'/api/state')).json();
    const project=fixture.projects.find(p=>p.framework?.boards.length);
    assert.ok(project,'a framework project is present in the sanitised fixture');
    // Real rendered rows make the left column long enough to exercise sticky positioning.
    const board=project.framework.boards[0];
    project.framework.boards=Array.from({length:36},(_,i)=>({...structuredClone(board),id:`layout-${i}`,title:`布局测试板块 ${i+1}`,children:[]}));
    fixture.work.items=[];fixture.agent.sessions=[];
    const goals=Array.from({length:2},(_,i)=>({id:`layout-goal-${i}`,title:['周一：四组样品基底 plasma 前处理并交接','收样后：probe station 测四组电阻'][i],project_ids:[project.id],task_status:'open'}));
    fixture.weekly.plan={...fixture.weekly.plan,intents:goals};
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    await page.clock.install();
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.route('**/api/state*',route=>route.fulfill({json:fixture}));
    await page.goto(base+'/#projects/'+project.id);
    const aside=page.locator('.project-aside'),actions=aside.locator('.project-actions');
    await actions.waitFor();
    assert.equal(await page.locator('.project-detail-heading button').count(),0);
    assert.equal(await actions.locator('button').count(),3);
    assert.equal(await aside.evaluate(el=>el.querySelector('.project-actions').getBoundingClientRect().top>=el.querySelector('.week-focus-panel').getBoundingClientRect().bottom),true);
    const capture=async name=>{
      if(!process.env.PHD_TEST_ARTIFACTS)return;
      fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});
      await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,name+'.png')});
    };
    await capture('project-controls-top');
    for(const y of [550,1000]) {
      await page.evaluate(y=>window.scrollTo(0,y),y);
      await page.waitForFunction(()=>Math.abs(document.querySelector('.project-aside').getBoundingClientRect().top-24)<2);
      const box=await actions.evaluate(el=>el.getBoundingClientRect().toJSON());
      assert.ok(box.y>=24 && box.y+box.height<=1000,'all controls remain in the viewport');
    }
    await capture('project-controls-scrolled');
    await actions.locator('[data-project-edit-mode]').click();
    assert.equal(await page.locator('.plan-panel.is-editing').count(),1);
    assert.equal(await actions.locator('[data-project-edit-mode]').getAttribute('aria-pressed'),'true');
    await actions.locator('[data-project-edit-mode]').click();
    assert.equal(await page.locator('.plan-panel.is-editing').count(),0);

    for(const width of [1000,390]) {
      await page.setViewportSize({width,height:900});
      await actions.locator('[data-project]').evaluate(el=>el.scrollIntoView({block:'nearest'}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
      assert.equal(await aside.evaluate(el=>getComputedStyle(el).position),width>900?'sticky':'static');
      await capture('project-controls-'+width);
    }
    // A long weekly list must scroll within the desktop sidebar, not hide its actions.
    fixture.weekly.plan.intents=Array.from({length:16},(_,i)=>({...goals[i%2],id:`long-goal-${i}`}));
    await page.setViewportSize({width:1440,height:700});await page.reload();await actions.waitFor();
    assert.equal(await aside.evaluate(el=>el.scrollHeight>el.clientHeight),true);
    await actions.locator('[data-project]').evaluate(el=>el.scrollIntoView({block:'nearest'}));
    const bottom=await actions.locator('[data-project]').evaluate(el=>el.getBoundingClientRect().toJSON());
    assert.ok(bottom.y>=0 && bottom.y+bottom.height<=700,'primary action remains reachable with many goals');
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
});
