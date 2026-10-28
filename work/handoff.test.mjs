import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {enqueue,normalizeBrief,parseHandoff} from './run.mjs';
import {drain,submit,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from '../automation/titleless.mjs';
import {createServer} from '../dashboard/server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent);
async function isolated(fn) {
  const files=['work/queue.json','.runtime/agent/sessions.json','agent/config.json'],saved=Object.fromEntries(files.map(f=>[f,read(f)]));
  const status=path.join(root,'workspace/projects/bi-devices/STATUS.md'),before=fs.existsSync(status) ? fs.readFileSync(status) : null;
  write('work/queue.json',{version:1,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...saved['agent/config.json'],enabled:true,memory_v2:{enabled:false},automatic_mail_judgment:false});
  try {await fn(status);} finally {for(const [file,value] of Object.entries(saved))write(file,value);if(before)fs.writeFileSync(status,before);else fs.rmSync(status,{force:true});}
}

test('status-summary entries are not truncated; new and old markers are readable and malformed text is retained',()=>{
  const brief={summary:'用户希望继续分析；已完成第一阶段',facts:Array.from({length:8},(_,i)=>({text:'事实'+i,source:'来源'+i})),open:Array.from({length:6},(_,i)=>'余项'+i),next:'请接续形成最终分析，不指定执行规程；原话里也有交接：一词'};
  assert.deepEqual(normalizeBrief(brief),brief);
  for(const label of ['状态摘要：','交接：']) {
    const parsed=parseHandoff('结果正文\n'+label+JSON.stringify(brief));
    assert.equal(parsed.text,'结果正文');assert.deepEqual(parsed.brief,brief);
    const malformed='结果正文\n'+label+'不是 JSON';assert.deepEqual(parseHandoff(malformed),{text:malformed,brief:null});
  }
});

test('one explicit operation submission reaches STATUS and work handoff without a duplicate brief',()=>isolated(async(status)=>{
  const operation=enqueue({title:'single result receipt',kind:'framework',actor:'codex',project_ids:['bi-devices'],status:'queued'});
  const file=path.join(root,'.runtime/handoff-result.txt');fs.writeFileSync(file,'actual result');
  await drain(async(_provider,prompt,opts)=>{
    if(opts.purpose==='title')return {result:''};
    assert.match(prompt,/不另写一份状态摘要|不另写一份结果|不另抄一份结果/);
    const request=path.join(root,'.runtime/handoff-receipt.json');
    fs.writeFileSync(request,JSON.stringify({id:operation.id,status:'done',handoff:'已完成独立对照，结果可接续使用',outputs:[file]}));
    execFileSync(process.execPath,['automation/run.mjs','work','update',request],{cwd:root,encoding:'utf8',env:{...process.env,OFFICE_MEMORY_OWNER:'codex',OFFICE_MEMORY_RUN_DIR:path.join(root,'.runtime/agent/runs',operation.id)}});
    return {result:'对照完成，成果已登记。'};
  });
  const stored=read('work/queue.json').items.find(i=>i.id===operation.id);
  assert.equal(stored.status,'done');assert.equal(stored.brief,undefined);
  assert.ok(fs.readFileSync(status,'utf8').includes(stored.handoff));
  const receipt=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work','handoff',operation.id],{cwd:root,encoding:'utf8'}));
  assert.equal(receipt.handoff,stored.handoff);assert.deepEqual(receipt.outputs,[file]);assert.equal(receipt.brief,undefined);
  assert.equal(fs.readFileSync(receipt.outputs[0],'utf8'),'actual result');
}));

test('the new summary marker reaches chat rendering, project status and all recorded facts',()=>isolated(async(status)=>{
  const brief={summary:'用户希望整理结果；已得到可复用结论',facts:Array.from({length:7},(_,i)=>({text:'可用事实'+i,source:'evidence-'+i+'.csv'})),open:['甲','乙','丙','丁'],next:'接续形成研究报告'};
  const job=submit({text:'@Codex 整理已有结果',project_id:'bi-devices'});
  await execute(job.task_id,async()=>({result:'已整理。\n状态摘要：'+JSON.stringify(brief)}));
  assert.deepEqual(read('work/queue.json').items.find(i=>i.id===job.task_id).brief,brief);
  assert.ok(fs.readFileSync(status,'utf8').includes(brief.summary));
  let server,browser;
  try {
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    browser=await launchEdge();const page=await browser.newPage();
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.goto(base);
    await page.locator(`[data-session="${job.session_id}"]`).first().click();
    await page.locator('.handoff-brief').waitFor();
    assert.equal(await page.locator('.handoff-brief summary').textContent(),'状态摘要');
    assert.equal(await page.locator('.handoff-brief .hb-fact').count(),7);
    assert.ok((await page.locator('.handoff-brief').textContent()).includes('接续目标'));
  } finally {await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
}));
