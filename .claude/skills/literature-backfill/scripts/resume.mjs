// Read-only current-task navigation. No model, network, lock, catalog write or scheduling.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const role=String(process.argv[2]||'').toLowerCase();
if(!['codex','claude','deepseek','coordinator'].includes(role))throw Error('Usage: resume.mjs codex|claude|deepseek|coordinator [--input]');
const local=p=>{const f=path.resolve(root,p);if(!f.toLowerCase().startsWith((path.resolve(root)+path.sep).toLowerCase()))throw Error('Path outside office workspace');return f;};
const stateRel='output/literature-rebuild-20261021/CONTINUE.json';
const state=JSON.parse(fs.readFileSync(local(stateRel),'utf8'));
const catalog=JSON.parse(fs.readFileSync(local(state.catalog),'utf8'));
const ready=state.work_items.filter(w=>w.status==='ready');
const delivered=[],pending=[],allPending=[];let selected=null,remaining=[];
for(const w of ready){
 if(w.owner!==role&&role!==state.catalog_writer&&role!=='coordinator')continue;
 const bytes=fs.readFileSync(local(w.input));const all=JSON.parse(bytes);
 const items=all.slice(w.start_index-1,w.end_index);
 if(items.length!==w.count||items[0]?.id!==w.first_id||items.at(-1)?.id!==w.last_id)throw Error('Input range mismatch '+w.id);
 let done=[];
 if(fs.existsSync(local(w.output))){
  try{done=JSON.parse(fs.readFileSync(local(w.output),'utf8'));}catch{throw Error('Existing output JSON needs repair; do not overwrite: '+w.output);}
  if(!Array.isArray(done)||done.length>items.length||done.some((x,i)=>x?.id!==items[i].id))throw Error('Existing output is not the assigned prefix; do not overwrite: '+w.output);
 }
 if(done.length===items.length){delivered.push({id:w.id,owner:w.owner,output:w.output,count:done.length,status:'delivered-awaiting-main-review'});continue;}
 const work={...w,source_sha256:createHash('sha256').update(bytes).digest('hex'),already_delivered:done.length,remaining:items.length-done.length,action:done.length?'resume-own-partial-output':'read-and-judge'};
 allPending.push(work);
 if(w.owner!==role)continue;
 pending.push(work);
 if(selected)continue;
 selected=work;
 remaining=items.slice(done.length);
}
const plan={state:stateRel,role,task_status:state.status,catalog_total:catalog.papers.length,catalog_writer:state.catalog_writer,default_scope:'Main assistant advances a substantive multi-block stage; selected is only the first reading cursor, not a one-block turn limit. No automatic background execution.',stage_remaining_records:pending.reduce((n,w)=>n+w.remaining,0),stage_pending_blocks:pending.length,pending_work:pending,selected,delivered_waiting_review:delivered,reader_guide:state.reader_guide,other_owner_ready:state.work_items.filter(w=>w.owner!==role&&w.status==='ready').length,note:selected?'Read reader_guide, organize pending_work into disjoint reading/review tasks within the current delegation budget, and integrate the stage. Combine same-owner blocks if useful; write each assigned output only. The designated writer alone accepts and writes shared state/catalog.':'No unread prepared block owned by this assistant. Accept existing deliveries; the source coordinator may register the next uncovered journal/year range within the authorized task. Do not steal another owner or start unattended collection.'};
plan.catalog_writer_conversation=state.catalog_writer_conversation||null;
plan.coordinator=state.coordinator||null;
plan.worker=state.workers?.[role]||null;
plan.selection_standard=role==='coordinator'?null:'output/literature-rebuild-20261021/FUTURE-SCREENING-STRATEGY.md';
plan.catalog_write_interface=state.catalog_write_interface||'.agents/skills/literature-backfill/scripts/admit-reviewed.mjs';
plan.packages=(state.packages||[]).filter(p=>role==='coordinator'||p.owner===role).map(p=>({...p,remaining_records:allPending.filter(w=>p.work_item_ids.includes(w.id)).reduce((n,w)=>n+w.remaining,0),delivered_work_items:delivered.filter(w=>p.work_item_ids.includes(w.id)).map(w=>w.id)}));
plan.default_scope='Main assistant owns the package; invoke independent literature-dispatch for child jobs, then read and risk-review own results. Each owner accepts its own package and submits via shared locked admission CLI. No whole-package second read by default.';
if(role==='coordinator'){plan.source_units=state.source_units||[];plan.total_unread_allocated=allPending.reduce((n,w)=>n+w.remaining,0);plan.note='Coordinator prepares sources/main packages only; each worker independently accepts its own results and calls the shared locked admission CLI.';}
else plan.note='Read the selection standard. If unread work exists, invoke literature-dispatch separately; children read -> judge -> append, parent merges. Machine-check all records, review includes/pending/boundaries and stratified excludes, not a default whole-package reread. Accept and admit your own package; never transfer Claude acceptance to Codex.';
if(role==='deepseek'){
 plan.default_scope='DeepSeek takes its own package: off-effort subagents read the shared reader tasks, she merges and reviews (see SKILL.md DeepSeek section). No automatic execution.';
 plan.note=plan.packages.length?'Use launch.mjs deepseek <package-id>; if no plan exists, prepare serial tasks with literature-dispatch (deepseek, --children 1). Have each task read, merge, run review-pack.mjs, then record actual content review before any admission.':'No package assigned to DeepSeek. The source coordinator can prepare a separate non-overlapping package when screening is requested; do not take Codex/Claude packages. This query does not allocate or start work.';
}
if(process.argv.includes('--input'))console.log(JSON.stringify({assignment:plan,items:remaining.map(({id,doi,title,date,year,journal,authors,abstract,abstract_from,abstract_url})=>({id,doi,title,date,year,journal,authors,abstract,abstract_from,abstract_url}))},null,2));
else console.log(JSON.stringify(plan,null,2));
