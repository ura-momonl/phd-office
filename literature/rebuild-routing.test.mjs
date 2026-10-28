// Fictional package lifecycle only; no network, models or real literature data.
import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {root} from '../automation/files.mjs';
import {backfillTask} from './curate.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use node scripts/run-tests.mjs --files=literature/rebuild-routing.test.mjs');
const base='output/literature-rebuild-20261021',back='.agents/skills/literature-backfill/scripts/';
const dispatch='.agents/skills/literature-dispatch/scripts/dispatch.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('DeepSeek can own the ordinary backfill task entry without queuing or changing criteria',()=>{
 const task=backfillTask({year:2020,citationFloor:'用户指定的被引门槛',actor:'deepseek'});
 assert.equal(task.actor,'deepseek');assert.equal(task.status,'open');
 assert.match(task.goal,/用户指定的被引门槛/);assert.throws(()=>backfillTask({year:2020,citationFloor:'x',actor:'robot'}),/actor/);
});
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');};
function run(script,...args){return spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',windowsHide:true});}
function ok(script,...args){const r=run(script,...args);assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
function rejects(script,args,pattern){const r=run(script,...args);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
let pkg,rows,manifest;
beforeEach(()=>{
 fs.rmSync(path.join(root,base),{recursive:true,force:true});
 write('literature/catalog.json',{papers:[]});fixture('deepseek');
});
function fixture(owner){
 pkg='pkg-'+owner+'-fixture';
 rows=Array.from({length:5},(_,i)=>({id:owner+'-'+(i+1),doi:'10.5555/'+owner+'-'+(i+1),
  title:i===0?'A fictional cosmology result':'Fictional low-dimensional result '+(i+1),
  journal:'Fixture Physics',authors:['测试作者'],date:'2020-01-02',year:2020,
  abstract:i===4?'':'We calculate unusual boundary transport and verify the predicted scaling with controlled simulations.',
  abstract_from:'fixture',abstract_url:'https://example.org/'+(i+1),work_item_id:pkg+'-work'}));
 const input=base+'/'+pkg+'-input.json',output=base+'/'+pkg+'-out.json';
 const work={id:pkg+'-work',owner,status:'ready',input,output,start_index:1,end_index:5,count:5,first_id:rows[0].id,last_id:rows.at(-1).id};
 manifest={owner,input,assigned_records:5,input_sha256:sha(JSON.stringify(rows)),reader_guide:base+'/RUBRIC.md',work_items:[work]};
 const entry={id:pkg,owner,status:'ready',input,manifest:base+'/'+pkg+'-manifest.json',work_item_ids:[work.id]};
 const state={status:'fixture',catalog:'literature/catalog.json',catalog_writer:'serialized-admission-cli',scope:{date_start:'2015-01-01',date_end:'2026-10-21'},journal_policy:{excluded:[]},reader_guide:manifest.reader_guide,work_items:[work],packages:[entry]};
 write(input,rows);write(entry.manifest,manifest);write(base+'/CONTINUE.json',state);
 for(const f of ['RUBRIC.md','FUTURE-SCREENING-STRATEGY.md'])fs.writeFileSync(path.join(root,base,f),'Fixture reference: read source evidence.\n');
}
function split(owner='deepseek'){
 const result=ok(dispatch,owner,'--package',pkg,'--size','2','--round','r01');return read(result.plan);
}
const launch=(owner='deepseek',...extra)=>ok(back+'launch.mjs',owner,pkg,...extra);
function mark(job){
 assert.equal(run(back+'brief.mjs',job.task_file).status,0);
 const t=ok(back+'reader-work.mjs','titles',job.task_file);
 write(job.chunk_file,{through:t.through,excluded:t.items.filter(p=>p.id.endsWith('-1')).map(p=>({id:p.id,group:'unrelated',note:'虚构宇宙学题名，与低维无关'}))});
 return ok(back+'reader-work.mjs','mark',job.task_file,job.chunk_file);
}
function finish(job){
 mark(job);const page=ok(back+'reader-work.mjs','read',job.task_file);
 if(page.items.length){
  const decisions=page.items.map(p=>({id:p.id,d:p.id.endsWith('-5')?'p':p.id.endsWith('-3')?'x':'i',t:'computation',
   r:p.id.endsWith('-5')?'缺少来源摘要，暂待核对':'虚构记录：计算边界输运并验证标度，结论仅限计算模型',
   g:['边界输运','计算'],e:p.id.endsWith('-5')?'':'unusual boundary transport',...(p.id.endsWith('-3')?{s:'in'}:{})}));
  write(job.chunk_file,decisions);ok(back+'reader-work.mjs','append',job.task_file,job.chunk_file);
 }
}
function submission(owner){
 const d=base+'/final.json',a=base+'/audit.json',r=base+'/submit.json';
 write(d,read(manifest.work_items[0].output));
 const audit={owner,package:pkg,checked_include_ids:[rows[1].id,rows[3].id],checked_pending_ids:[rows[4].id],checked_exclude_ids:[rows[2].id],exclusion_audit:[{stratum:'相关但不收（虚构数据）',ids:[rows[2].id]}]};
 write(a,audit);write(r,{owner,package:pkg,decisions:d,audit:a});return {a,r,audit};
}
test('reader briefing ignores a large legacy local-rules file and retains the canonical standard and title window',()=>{
 fixture('claude');const job=split('claude').jobs[0],task=read(job.task_file),legacy=base+'/legacy-claude-rules.md';
 fs.writeFileSync(path.join(root,legacy),'OBSOLETE_LOCAL_RULE_CASE\n'.repeat(5000));
 write(job.task_file,{...task,local_rules:legacy});
 const result=run(back+'brief.mjs',job.task_file);assert.equal(result.status,0,result.stderr);
 assert.doesNotMatch(result.stdout,/OBSOLETE_LOCAL_RULE_CASE|=== local_rules:/);
 assert.match(result.stdout,/=== selection standard:/);assert.match(result.stdout,/Fixture reference/);
 assert.match(result.stdout,/=== first title window/);assert.match(result.stdout,/Fictional low-dimensional result/);
 assert.ok(Buffer.byteLength(result.stdout)<25000,'legacy case history must not inflate the briefing payload');
});

test('results cannot be recorded for a task before its brief has been printed',()=>{
 const job=split().jobs[0];
 for(const a of [['titles',job.task_file],['read',job.task_file],['mark',job.task_file,'-'],['append',job.task_file,'-']])rejects(back+'reader-work.mjs',a,/brief\.mjs/);
 assert.match(job.instructions,/brief\.mjs/);
 assert.equal(run(back+'brief.mjs',job.task_file).status,0);
 assert.equal(run(back+'reader-work.mjs','titles',job.task_file).status,0);
});
test('DeepSeek navigation is read-only and never takes another owner package',()=>{
 const before=fs.readFileSync(path.join(root,base+'/CONTINUE.json'));
 const r=ok(back+'resume.mjs','deepseek');assert.equal(r.role,'deepseek');assert.equal(r.packages[0].id,pkg);assert.equal(r.stage_remaining_records,5);
 assert.match(launch().next,/--children 1 --size 100/);
 assert.deepEqual(fs.readFileSync(path.join(root,base+'/CONTINUE.json')),before);
 rejects(back+'launch.mjs',['codex',pkg],/belongs to deepseek/);
 rejects(dispatch,['claude','--package',pkg,'--round','r01'],/No package owned/);
 fixture('codex');const none=ok(back+'resume.mjs','deepseek');assert.equal(none.packages.length,0);assert.equal(none.selected,null);
 assert.equal(read(base+'/CONTINUE.json').packages[0].owner,'codex');
});
test('serial launch exposes brief, preserves partial progress and advances titles independently',()=>{
 const preview=ok(dispatch,'deepseek','--package',pkg,'--size','2','--dry-run');
 assert.equal(preview.children.length,3);assert.equal(fs.existsSync(path.join(root,base+'/coordinator/reader-jobs')),false);
 rejects(dispatch,['deepseek','--package',pkg,'--children','2','--round','r01'],/reads serially/);
 const plan=split();let card=launch();assert.equal(card.spawn,undefined);assert.equal(card.serial.next_task,plan.jobs[0].task_file);
 const brief=run(back+'brief.mjs',card.serial.next_task);assert.equal(brief.status,0,brief.stderr);assert.match(brief.stdout,/Fixture reference/);assert.match(brief.stdout,/PowerShell/);assert.match(brief.stdout,/first title window/);
 mark(plan.jobs[0]);const page=ok(back+'reader-work.mjs','read',plan.jobs[0].task_file);
 card=launch();assert.equal(card.jobs[0].saved,1);assert.equal(card.serial.next_task,plan.jobs[0].task_file);
 const titles=launch('deepseek','--phase','titles');assert.equal(titles.spawn,undefined);assert.equal(titles.serial.next_task,plan.jobs[1].task_file);
 assert.deepEqual(page.items.map(p=>p.id),[rows[1].id]);
 rejects(dispatch,['deepseek','--package',pkg,'--round','r01'],/Round already exists/);
});
test('serial reader through merge and reviewed admission reuses the existing path without early catalog writes',()=>{
 const plan=split(),original=fs.readFileSync(path.join(root,'literature/catalog.json'));
 for(const job of plan.jobs)finish(job);
 assert.equal(launch().serial.next_task,null);
 const dry=ok(back+'reader-work.mjs','merge',plan.plan_file,'--dry-run');assert.equal(dry.merged_contiguous_records,5);
 assert.equal(fs.existsSync(path.join(root,manifest.work_items[0].output)),false);
 ok(back+'reader-work.mjs','merge',plan.plan_file);assert.deepEqual(fs.readFileSync(path.join(root,'literature/catalog.json')),original);
 const resumed=ok(back+'resume.mjs','deepseek');assert.equal(resumed.stage_remaining_records,0);assert.equal(resumed.delivered_waiting_review[0].count,5);
 const {a,r,audit}=submission('deepseek');write(a,{...audit,checked_include_ids:[]});rejects(back+'admit-reviewed.mjs',[r],/Every include requires/);
 assert.deepEqual(fs.readFileSync(path.join(root,'literature/catalog.json')),original);write(a,audit);
 const receipt=ok(back+'admit-reviewed.mjs',r);assert.equal(receipt.added,2);assert.equal(receipt.catalog_readback_verified,true);assert.equal(receipt.state_synced,true);
 const catalog=read('literature/catalog.json');assert.equal(catalog.papers.length,2);assert.equal(catalog.papers[0].authors[0],'测试作者');assert.match(catalog.papers[0].library_reason,/虚构记录/);assert.equal(catalog.papers[0].selection_review.audited_by,'deepseek-main');
 assert.equal(read(base+'/CONTINUE.json').packages[0].status,'accepted');assert.equal(ok(back+'admit-reviewed.mjs',r).already_admitted,true);assert.equal(read('literature/catalog.json').papers.length,2);
});
test('changed inputs and damaged prefixes remain repair items, not new blank work',()=>{
 const plan=split(),j=plan.jobs[0];write(j.output,[{id:'foreign'}]);
 const bytes=fs.readFileSync(path.join(root,j.output));const card=launch();assert.equal(card.jobs[0].state,'repair');assert.notEqual(card.serial.next_task,j.task_file);assert.deepEqual(fs.readFileSync(path.join(root,j.output)),bytes);
 const changed=read(plan.jobs[1].input);changed[0].abstract+=' Changed.';write(plan.jobs[1].input,changed);
 rejects(back+'brief.mjs',[plan.jobs[1].task_file],/Child input changed/);rejects(back+'reader-work.mjs',['merge',plan.plan_file],/id 与输入不符/);
});
for(const owner of ['codex','claude'])test(owner+' keeps its parallel launch and reviewed admission route',()=>{
 fixture(owner);const plan=split(owner);const card=launch(owner);assert.equal(card.serial,undefined);assert.equal(card.spawn.for_each_open_child.length,3);assert.match(card.spawn.model,owner==='codex'?/gpt-6-luna/:/haiku/);
 for(const job of plan.jobs)finish(job);
 ok(back+'reader-work.mjs','merge',plan.plan_file);const {r}=submission(owner);assert.equal(ok(back+'admit-reviewed.mjs',r).added,2);
});
