import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {recommendationDay,saveRecommendations,localDay,recommendationDir} from './recommendations.mjs';
import {ensureDailyRecommendations,dailyJobId} from './daily.mjs';
import {literatureList,literaturePaper} from './view.mjs';
import {discover} from './discover.mjs';
import {backupData} from '../automation/backup.mjs';
import {includeTestFile} from '../scripts/test-copy.mjs';
import {startReadyWork} from '../agent/run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --literature');
const days=['2030-02-01','2030-02-02','2030-02-03'];
const pick=i=>({doi:'10.5555/daily-'+i,reason:'Fictional useful original research '+i,basis:'abstract'});
async function isolated(fn) {
  const files=['agent/config.json','literature/sources.json','work/queue.json','.runtime/agent/sessions.json','literature/catalog.json',...days.map(d=>'literature/recommendations/'+d+'.json')];
  const saved=Object.fromEntries(files.map(f=>[f,fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null]));
  try{return await fn();}finally{for(const[f,b]of Object.entries(saved)){const p=path.join(root,f);if(b)fs.writeFileSync(p,b);else fs.rmSync(p,{force:true});}}
}
test('daily records allow zero, one or many selections; repeated publish is idempotent and replacement explicit',()=>isolated(async()=>{
  assert.equal(recommendationDay(days[0]).published,false);
  assert.throws(()=>saveRecommendations({date:days[0],items:[]}));
  const empty=saveRecommendations({date:days[0],items:[],note:'No suitable papers today.'});assert.equal(empty.items.length,0);
  const one={date:days[1],items:[pick(0)],note:''};saveRecommendations(one);assert.equal(saveRecommendations(one).reused,true);
  assert.throws(()=>saveRecommendations({...one,items:[pick(1)]}),/已有推荐/);
  const many=saveRecommendations({date:days[2],items:Array.from({length:5},(_,i)=>pick(i)),note:''});assert.equal(many.items.length,5);
  assert.throws(()=>saveRecommendations({date:'../../secret',items:[pick(0)]}));
  assert.throws(()=>saveRecommendations({date:'2030-02-31',items:[pick(0)]}));
  assert.throws(()=>saveRecommendations({date:days[1],items:[{...pick(0),basis:'title'}],replace:true}));
  assert.equal(recommendationDay(days[1]).items[0].doi,pick(0).doi);
}));
test('Chicago day boundary is used instead of UTC',()=>{
  assert.equal(localDay('2026-10-18T04:30:00Z'),'2026-10-17');assert.equal(localDay('2026-10-18T05:30:00Z'),'2026-10-18');
});
test('existing queue receives at most one daily job, no retry on failure, and the normal dispatcher owns its task session',()=>isolated(async()=>{
  const c=read('literature/sources.json');c.daily_recommendations={enabled:true,actor:'codex',not_before_hour:8};write('literature/sources.json',c);
  const a=read('agent/config.json');a.enabled=true;write('agent/config.json',a);write('work/queue.json',{items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  assert.equal(ensureDailyRecommendations({now:'2030-02-01T12:00:00Z'}).state,'not-due');
  const first=ensureDailyRecommendations({now:'2030-02-01T15:00:00Z'});assert.equal(first.state,'queued');assert.equal(first.task_id,dailyJobId(days[0]));
  assert.equal(ensureDailyRecommendations({now:'2030-02-01T16:00:00Z'}).task_id,first.task_id);assert.equal(read('work/queue.json').items.length,1);
  const started=startReadyWork();assert.equal(started.length,1);const s=read('.runtime/agent/sessions.json').sessions[0];assert.equal(s.origin,'task');assert.ok(s.messages[0].text.includes('不下载全文'));assert.ok(s.messages[0].text.includes('推荐与本地记录')||s.messages[0].text.includes('本次筛选和本地记录'));
  const q=read('work/queue.json');q.items[0].status='failed';write('work/queue.json',q);
  assert.equal(ensureDailyRecommendations({now:'2030-02-01T17:00:00Z'}).state,'failed');assert.equal(read('work/queue.json').items.length,1);
  assert.equal(ensureDailyRecommendations({now:'2030-02-02T15:00:00Z'}).state,'queued');assert.equal(read('work/queue.json').items.length,2);
}));
test('schedule defers to assistant work, respects disable, and does not rerun a published empty day',()=>isolated(async()=>{
  const c=read('literature/sources.json');c.daily_recommendations={enabled:true,actor:'codex',not_before_hour:8};write('literature/sources.json',c);
  const a=read('agent/config.json');a.enabled=true;write('agent/config.json',a);write('work/queue.json',{items:[{id:'busy',actor:'claude',status:'active'}]});
  assert.equal(ensureDailyRecommendations({now:'2030-02-01T15:00:00Z'}).state,'busy');
  saveRecommendations({date:days[0],items:[],note:'No suitable research today.'});assert.equal(ensureDailyRecommendations({now:'2030-02-01T15:00:00Z'}).state,'published');
  c.daily_recommendations.enabled=false;write('literature/sources.json',c);assert.equal(ensureDailyRecommendations({now:'2030-02-02T15:00:00Z'}).state,'disabled');
}));
test('recommend CLI persists selected metadata, per-day reasons and archive; does not download or mark user preference',()=>isolated(async()=>{
  write('literature/catalog.json',{papers:[{doi:pick(0).doi,title:'Fictional original research',abstract:'A complete existing abstract.',source:'Fixture Journal'}]});
  const file=path.join(root,'.runtime/daily-publish-input.json');fs.writeFileSync(file,JSON.stringify({date:days[0],items:[{...pick(0),question:'A testable question.'}],note:'Abstract only.'}));
  try{const result=spawnSync(process.execPath,['automation/run.mjs','literature','recommend',file],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
    const list=literatureList({scope:'daily',date:days[0]});assert.equal(list.items.length,1);assert.equal(list.items[0].reason,pick(0).reason);assert.ok(!JSON.stringify(list.items).includes('complete existing abstract'));
    const p=literaturePaper(pick(0).doi,{date:days[0]});assert.equal(p.recommendation.question,'A testable question.');assert.equal(p.fulltext.available,false);
    const stored=read('literature/catalog.json').papers[0];assert.equal(stored.liked,undefined);assert.equal(stored.read,undefined);
  }finally{fs.rmSync(file,{force:true});}
}));
test('permanent daily records are backed up and excluded from sanitized source copies',()=>isolated(async()=>{
  saveRecommendations({date:days[0],items:[pick(0)],note:''});assert.equal(includeTestFile(root,path.join(recommendationDir,days[0]+'.json')),false);
  backupData({now:new Date('2038-02-01T12:00:00Z'),keep:9999});
  assert.equal(fs.existsSync(path.join(root,'.runtime/backups/2038-02-01/literature/recommendations',days[0]+'.json')),true);
}));
test('yesterday displayed candidates remain eligible until formally registered, without rewriting old seen history',async t=>{
  const today=new Date().toISOString().slice(0,10),dir=path.join(root,'.runtime/literature');
  const files=['literature/sources.json','literature/catalog.json','.runtime/literature/seen.json','.runtime/literature/intake.json',`.runtime/literature/candidates-${today}.json`];
  const saved=Object.fromEntries(files.map(f=>[f,fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null]));
  try{
    const c=read('literature/sources.json');c.journals=[['Fixture Journal','0000-0000',1]];c.arxiv_max=0;write('literature/sources.json',c);write('literature/catalog.json',{papers:[{doi:'10.48550/arxiv.2601.12345',library_status:'deferred-publication'}]});fs.mkdirSync(dir,{recursive:true});
    const seen=JSON.stringify({'10.5555/eligible':'2020-01-01'});fs.writeFileSync(path.join(dir,'seen.json'),seen);
    const requests=[];
    t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return {ok:true,status:200,json:async()=>({message:{items:[{DOI:'10.5555/eligible',title:['Useful electrical measurement'],abstract:'A fictional original research abstract.',issued:{'date-parts':[[2026,10,17]]}},{DOI:'10.48550/arxiv.2601.12345',title:['Already deferred'],issued:{'date-parts':[[2026,10,17]]}}]}}),text:async()=>'<feed/>'};});
    const result=await discover({days:7});assert.equal(result.candidates.length,1);assert.equal(fs.readFileSync(path.join(dir,'seen.json'),'utf8'),seen);assert.ok(requests.length);assert.ok(requests.every(url=>url.startsWith('https://api.crossref.org/')),'arxiv_max=0 must make no arXiv request');
  }finally{for(const[f,b]of Object.entries(saved)){const p=path.join(root,f);if(b)fs.writeFileSync(p,b);else fs.rmSync(p,{force:true});}}
});
