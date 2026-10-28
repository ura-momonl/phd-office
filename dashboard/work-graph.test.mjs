import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {workGraph} from './workspace.js';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('empty work does not create a pretend graph; titles are escaped',()=>{
  assert.equal(workGraph('p',[]),'');
  assert.equal(workGraph('p',[{id:'turn',turn:true}]),'');
  const html=workGraph('p',[{id:'a',title:'<script>not HTML</script>',actor:'codex',status:'open',dependencies:[]}]);
  assert.ok(html.includes('&lt;script&gt;not HTML&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
});

test('step chips follow live executions without changing the submitted operation',()=>{
  const run=(id,status,extra={})=>({id,status,outputs:[],...extra});
  const task={id:'owner',title:'整体分析',actor:'codex',status:'open',dependencies:[],outputs:[],execution_history:[]};
  const chip=html=>html.match(/<button class="fw-chip[^]*?<\/button>/)[0];
  const render=(runs,all=[],extra={})=>workGraph('p',[{...task,...extra,execution_history:runs,last_execution:runs.at(-1)},...all]);
  const active=run('active','active'),waiting=run('return','queued',{after:['child']});
  const child={id:'child',title:'子操作',actor:'codex',status:'active',dependencies:[],outputs:[],parent_id:task.id};
  assert.match(chip(render([active])),/>正在进行<\/button>/);
  assert.match(chip(render([active])),/data-step-status="open"/);
  assert.match(chip(render([active,waiting],[child])),/>正在进行<\/button>/,'a queued future return must not hide an executing round');
  const waitingHtml=render([run('first','done'),waiting],[child]);
  assert.match(chip(waitingHtml),/>等待子操作结果<\/button>/);
  assert.match(chip(waitingHtml),/disabled/);
  assert.match(waitingHtml,/等待 1 项返回/);
  // Returning from a failed/cancelled/unsubmitted exploration is valid, not a success dependency.
  for(const status of ['done','failed','cancelled'])assert.match(chip(render([waiting],[{...child,status}])),/>待办<\/button>/);
  const repeat=render([active],[],{status:'done',handoff:'原结论',outputs:['original.csv']});
  assert.match(chip(repeat),/>正在进行<\/button>/);assert.match(chip(repeat),/data-step-status="done"/);
  assert.match(repeat,/原成果保留/);assert.match(repeat,/original.csv/);
  const ended=render([run('ended','done',{outcome_status:'open'})]);
  assert.match(chip(ended),/>未开始／待定义<\/button>/);assert.match(ended,/上一轮已结束，未提交完成/);
  assert.doesNotMatch(chip(ended),/disabled/);
  assert.match(chip(render([run('ended','done',{outcome_status:'done'})],[],{status:'done'})),/>完成<\/button>/);
});

test('the chronological analysis topic contains the parent DAG and nested DCG, with no separate workflow panel',async()=>{
  const saved=read('work/queue.json'),pid='tairte4-transport',server=createServer();let browser;
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const initial=await(await fetch(base+'/api/state')).json(),p=initial.projects.find(p=>p.id===pid);
    const topic='tairte4-t-disc-processing';
    const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children || [])]);
    assert.ok(flatten(p.framework.boards).some(n=>n.id===topic));
    const item=(id,title,status,extra={})=>({id,title,status,kind:'framework',actor:'codex',project_ids:[pid],plan_node_id:topic,goal:'UI fixture',dependencies:[],outputs:[],handoff:'',created_at:'2026-10-27T12:00:00Z',...extra});
    const prep=item('visual-prep','整理测量数据','done');
    const owner=item('visual-owner','解释异常输运信号','open',{dependencies:[prep.id]});
    const check=item('visual-check','核对测量设置','done',{parent_id:owner.id});
    const failed=item('visual-failed','尝试背景扣除','failed',{parent_id:owner.id});
    const active=item('visual-active','重新分析异常区间','done',{parent_id:owner.id,dependencies:[check.id],handoff:'上一轮的已提交结果仍保留',outputs:['workspace/projects/tairte4-transport/analysis/fixture-result.csv']});
    const independent=item('visual-independent','整理文献对照','open');
    const plain=item('visual-plain','普通测量步骤','done',{plan_node_id:'tairte4-t-disc-measure',actor:'user'});
    const report=item('visual-report','汇总分析报告','queued',{dependencies:[owner.id]});
    const first=item('visual-first','异常区间第一轮','done',{executor:'codex',operation_id:active.id,source_task_id:active.id,outcome_status:'done',created_at:'2026-10-27T12:01:00Z'});
    const current=item('visual-current','异常区间第二轮','active',{executor:'codex',operation_id:active.id,created_at:'2026-10-27T12:02:00Z'});
    const returned=item('visual-return','等待分支汇合','queued',{executor:'codex',operation_id:owner.id,after:[check.id,failed.id,active.id],created_at:'2026-10-27T12:03:00Z'});
    write('work/queue.json',{...saved,items:[prep,owner,check,failed,active,independent,report,plain,first,current,returned]});
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.goto(base+'/#projects/'+pid);
    const topicView=page.locator(`[data-fw-id="${topic}"]`),graph=topicView.locator('[data-work-graph]'),dcg=graph.locator(`[data-work-dcg="${owner.id}"]`);
    await graph.waitFor();
    assert.equal(await page.locator('.project-workflow').count(),0,'the standalone workflow panel has been removed');
    assert.equal(await page.locator('[data-work-graph]').count(),1);
    assert.equal(await graph.evaluate(n=>!!n.closest('.fw-timeline')),true,'the graph is inside the original chronological framework');
    assert.equal(await graph.evaluate(n=>n.closest('[data-fw-id]').dataset.fwId),topic);
    assert.equal(await graph.locator('.work-map-node').count(),7,'each operation uses one shared row; execution turns are not graph nodes');
    assert.equal(await graph.locator('[data-step-row="visual-prep"]').count(),1);
    assert.equal(await page.locator('.work-map-card,.work-graph-details').count(),0,'the alternate cards and duplicate detail layer are removed');
    await page.locator(`[data-step-row="${plain.id}"]`).evaluate(n=>{
      for(let parent=n.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    });
    for(const task of [owner,check,plain]) {
      const row=page.locator(`[data-step-row="${task.id}"]`);
      assert.equal(await row.getAttribute('class'),'fw-step');
      assert.equal(await row.locator(':scope > [data-step-chip]').count(),1);
      assert.equal(await row.locator(':scope > .fw-step-main > strong').innerText(),task.title);
      assert.equal(await row.locator('[data-step-edit]:not([data-step-action])').count(),1);
    }
    const metrics=n=>{const row=getComputedStyle(n),title=getComputedStyle(n.querySelector('.fw-step-main>strong'));return {display:row.display,gap:row.gap,titleSize:title.fontSize,titleWeight:title.fontWeight};};
    const ordinaryMetrics=await page.locator(`[data-step-row="${plain.id}"]`).evaluate(metrics);
    assert.deepEqual(await page.locator(`[data-step-row="${owner.id}"]`).evaluate(metrics),ordinaryMetrics);
    assert.deepEqual(await page.locator(`[data-step-row="${check.id}"]`).evaluate(metrics),ordinaryMetrics);
    const ownerChip=page.locator(`[data-step-chip="${owner.id}"]`);
    assert.equal(await ownerChip.innerText(),'等待子操作结果');assert.equal(await ownerChip.isDisabled(),true);
    assert.equal(await graph.locator(`[data-step-chip="${active.id}"]`).innerText(),'正在进行');
    assert.equal(await graph.locator(`[data-step-chip="${active.id}"]`).getAttribute('data-step-status'),'done');
    await page.locator(`[data-step-chip="${independent.id}"]`).click();await page.locator('#fw-menu').waitFor();
    assert.equal(await page.locator('#fw-menu [data-step-set]').count(),5,'idle rows keep the ordinary interactive state menu');
    await page.keyboard.press('Escape');
    assert.match(await graph.locator('.work-map-count').innerText(),/4 项主操作 · 3 项子操作/);
    assert.equal(await dcg.evaluate(n=>n.open),true);
    await graph.locator(`[data-work-edge-from="${prep.id}"][data-work-edge-to="${owner.id}"]`).waitFor({state:'attached'});
    assert.equal(await graph.locator(`[data-work-edge-from="${owner.id}"][data-work-edge-to="${report.id}"]`).count(),1);
    assert.equal(await graph.locator(`[data-work-edge-from="${independent.id}"]`).count(),0,'unrelated operations are not drawn as a sequential chain');
    assert.equal(await dcg.locator('path.is-return').count(),0,'returns are a status block, not dashed lines');
    assert.match(await dcg.locator('.work-map-return').innerText(),/\d\.[a-z] /,'the return block names its sources by round.step');
    assert.match(await dcg.locator('.work-map-return').innerText(),/等待 1 项返回/);
    assert.match(await dcg.locator(`[data-work-map-node="${active.id}"]`).innerText(),/本次正在执行；原成果保留/);
    assert.match(await dcg.locator(`[data-work-map-node="${active.id}"]`).innerText(),/执行历史 · 2 次/);
    const files=dcg.locator(`[data-step-files="${active.id}"]`);
    assert.equal(await files.evaluate(n=>n.open),false,'DCG files are collapsed by default too');
    assert.equal(await files.locator('.file-name').isVisible(),false);
    const capture=async name=>{
      if(!process.env.PHD_TEST_ARTIFACTS)return;
      fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});
      await topicView.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,name+'.png')});
    };
    await capture('dag-dcg-desktop');
    await dcg.locator(':scope > summary').click();assert.equal(await dcg.evaluate(n=>n.open),false);
    const polled=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.clock.fastForward(5000);await polled;
    assert.equal(await dcg.evaluate(n=>n.open),false,'a poll preserves the user collapse choice');
    await capture('dag-dcg-collapsed');
    await dcg.locator(':scope > summary').click();
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.querySelector('[data-work-edge-from="visual-prep"][data-work-edge-to="visual-owner"]').getAttribute('d').includes(' H '));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no page-wide horizontal overflow');
    await capture('dag-dcg-mobile');
    await dcg.locator(`.work-map-return [data-work-goto="${active.id}"]`).click();
    assert.equal(await page.locator(`[data-step-row="${active.id}"]`).evaluate(n=>n===document.activeElement),true);
    assert.equal(await page.locator('[data-step-row]').count(),8,'the existing framework operating controls remain single instances');
    assert.equal(read('work/queue.json').items.find(t=>t.id===owner.id).status,'open','viewing a child never changes its parent state');
    const poll=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.clock.fastForward(5000);await response;};
    const update=()=>write('work/queue.json',{...saved,items:[prep,owner,check,failed,active,independent,report,plain,first,current,returned]});
    current.status='done';update();await poll();
    await page.waitForFunction(()=>document.querySelector('[data-step-chip="visual-owner"]').textContent==='待办');
    assert.equal(read('work/queue.json').items.find(t=>t.id===owner.id).status,'open');
    returned.status='active';update();await poll();
    await page.waitForFunction(()=>document.querySelector('[data-step-chip="visual-owner"]').textContent==='正在进行');
    await capture('dag-dcg-resumed');
    returned.status='done';returned.outcome_status='open';update();await poll();
    await page.waitForFunction(()=>document.querySelector('[data-step-chip="visual-owner"]').textContent==='未开始／待定义');
    assert.match(await graph.locator(`[data-step-row="${owner.id}"]`).innerText(),/上一轮已结束，未提交完成/);
    owner.status='done';owner.handoff='整体结果已提交';returned.outcome_status='done';update();await poll();
    await page.waitForFunction(()=>document.querySelector('[data-step-chip="visual-owner"]').textContent==='完成');
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server.listening)await new Promise(r=>server.close(r));write('work/queue.json',saved);
  }
});
