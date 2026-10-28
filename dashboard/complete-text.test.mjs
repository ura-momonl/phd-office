import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {splitState} from './ui-state.mjs';
import {agentUpdates} from './workspace.js';
import {reviewDetails} from './review.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run via scripts/run-tests.mjs');

test('page indexes preserve complete last replies and updates without shipping unrelated message histories',()=>{
  const body='完整结果说明。'.repeat(80)+'\n仅适用于低温；文件 D:/research/完整目录/结果.csv。',at='2026-10-26T12:00:00Z';
  const s={projects:[{id:'p',name:'Fixture'}],inbox:[],usage:{runs:[]},work:{items:[{id:'t',actor:'codex',executor:'codex',status:'done',project_ids:['p']}]},
    agent:{sessions:[{id:'s',title:'Fixture',origin:'chat',project_ids:['p'],task_ids:['t'],created_at:at,messages:[{role:'user',text:'unrelated-history',at,task_id:'t'},{role:'assistant',provider:'codex',text:body,at,task_id:'t'}]}]}};
  const history=splitState(s,{page:'history'}),project=splitState(s,{page:'projects'});
  assert.equal(history.agent.sessions[0].preview,body);
  assert.equal(history.agent.sessions[0].messages,undefined);
  assert.equal(project.agent.sessions[0].messages,undefined);
  assert.equal(agentUpdates(project)[0].text,body);
  assert.equal(JSON.stringify(project).includes('unrelated-history'),false);
});

test('review files are indexed without eager body reads and the real dialog loads the complete file on expansion',async()=>{
  const saved=read('work/queue.json'),id='complete-review-file',file=path.join(root,'.runtime/complete-review-file.txt');
  const text='完整中文🌿'.repeat(1500)+'\n文件尾部：只适用于本次测量，D:/research/完整结果.csv。',at='2026-10-26T12:00:00Z';
  let server,browser;
  try {
    fs.writeFileSync(file,text);
    write('work/queue.json',{...saved,items:[{id,title:'完整文件验收',kind:'data',actor:'codex',status:'done',project_ids:[],dependencies:[],outputs:[file],handoff:'已生成完整文件',created_at:at,completed_at:at,review:{state:'pending',kind:'acceptance'}}]});
    const originalRead=fs.readFileSync;let bodyReads=0;
    try {
      fs.readFileSync=function(target,...args){if(String(target)===file)bodyReads++;return originalRead.call(this,target,...args);};
      const detail=reviewDetails('work',id);
      assert.equal(bodyReads,0,'opening the review index must not read a partial or full artifact body');
      assert.deepEqual(detail.previews,[{path:file,url:'/api/artifact?task='+id+'&index=0'}]);
      assert.equal(detail.previews[0].text,undefined,'there is no incomplete body masquerading as a full file');
    }finally{fs.readFileSync=originalRead;}
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    browser=await launchEdge();const page=await browser.newPage(),requests=[];
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    page.on('request',r=>{if(r.url().includes('/api/artifact?'))requests.push(r.url());});
    await page.goto(base);
    assert.equal(await page.locator('#cal-title').getAttribute('maxlength'),null);
    assert.equal(await page.locator('#cal-note').getAttribute('maxlength'),null);
    await page.locator('.nav[data-page="inbox"]').click();
    await page.locator(`[data-review="work:${id}"]`).click();
    await page.locator('#review-dialog').waitFor({state:'visible'});
    assert.equal(requests.length,0,'the file stays unread while folded');
    await page.locator('#review-detail .file-preview summary').click();
    await page.waitForFunction(expected=>document.querySelector('#review-detail .evidence-preview')?.textContent===expected,text);
    assert.equal(await page.locator('#review-detail .evidence-preview').textContent(),text);
    assert.equal(requests.length,1);
    assert.equal(await page.locator('#review-detail [download]').getAttribute('href'),'/api/artifact?task='+id+'&index=0');
  }finally{
    await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}
    write('work/queue.json',saved);fs.rmSync(file,{force:true});
  }
});
