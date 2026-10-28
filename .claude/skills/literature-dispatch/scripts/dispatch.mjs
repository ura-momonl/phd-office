// Independent preparation only. No models, judgments, catalog or shared-state writes.
import fs from 'node:fs';
import {local,read,sha,validate,save} from '../../literature-backfill/scripts/records.mjs';
const args=process.argv.slice(2),arg=args[0];
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};

 if(!['codex','claude','deepseek'].includes(arg))throw Error('split requires codex, claude or deepseek');
 const state=read('output/literature-rebuild-20261021/CONTINUE.json');
 const pkgId=option('--package',null),candidates=state.packages.filter(p=>p.owner===arg&&(!pkgId||p.id===pkgId));
 if(!pkgId&&candidates.length>1)throw Error('Multiple owned packages: pass --package from the resume result; do not accidentally split the first old package');
 const pkg=candidates[0];
 if(!pkg)throw Error('No package owned by '+arg);
 const pkgManifest=read(pkg.manifest),all=read(pkg.input),mode=args.includes('--review')?'review':'screen';
 if(sha(JSON.stringify(all))!==pkgManifest.input_sha256)throw Error('Package input changed');
 const idsFile=option('--ids-file',null);
 if(idsFile&&mode!=='review')throw Error('--ids-file selects review only, not a candidate/initial-screening gate');
 if(mode==='review'&&!idsFile)throw Error('Review requires explicit --ids-file selected by the parent; no default whole-package second read');
 const selectedIds=idsFile?read(idsFile):null;
 if(selectedIds&&(!Array.isArray(selectedIds)||!selectedIds.length||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!all.some(p=>p.id===id))))throw Error('Review IDs must be unique IDs in this owner package');
 const requested=selectedIds?new Set(selectedIds):null;
 const pending=[],issues=[];
 for(const w of pkgManifest.work_items){
  const input=all.filter(p=>p.work_item_id===w.id);
  const source=read(w.input).slice(w.start_index-1,w.end_index);
  const done=mode==='screen'&&fs.existsSync(local(w.output))?read(w.output):[];
  if(!Array.isArray(done)||done.length>source.length||done.some((d,i)=>d.id!==source[i].id))throw Error('Existing output is not the source ID prefix '+w.id);
  done.forEach((d,i)=>{try{validate(d,source[i]);}catch(e){issues.push({work_item:w.id,id:d.id,error:e.message,action:'Main must repair/verify existing result before merge/admission. Preserved, not accepted and not reassigned as unread.'});}});
  const doneIds=new Set(done.map(d=>d.id));
  pending.push(...input.filter(p=>!doneIds.has(p.id)&&(!requested||requested.has(p.id))));
 }
 const children=Number(option('--children',arg==='deepseek'?1:10));if(!Number.isInteger(children)||children<1||children>10)throw Error('Use 1..10 child slots within current native/turn budget');
 if(arg==='deepseek'&&children!==1)throw Error('DeepSeek reads serially; use --children 1 (no subagents)');
 const size=Number(option('--size',arg==='deepseek'?100:Math.max(1,Math.ceil(pending.length/children)))),maxChars=Number(option('--max-chars',160000));
 if(!Number.isInteger(size)||size<1||!Number.isInteger(maxChars)||maxChars<4000)throw Error('Use a positive finite child size and explicit source-character budget; package size is not child size');
 const chunks=[];let chunk=[],chars=0;
 for(const p of pending){const n=JSON.stringify({id:p.id,title:p.title,abstract:p.abstract,doi:p.doi}).length;if(chunk.length&&(chunk.length>=size||chars+n>maxChars)){chunks.push(chunk);chunk=[];chars=0;}chunk.push(p);chars+=n;}
 if(chunk.length)chunks.push(chunk);
 const dry=args.includes('--dry-run');
 if(dry){console.log(JSON.stringify({owner:arg,package:pkg.id,mode,remaining:pending.length,existing_results_need_main_repair:issues.length,issue_samples:issues.slice(0,5),children:chunks.map((c,i)=>({child:i+1,count:c.length,first_id:c[0].id,last_id:c.at(-1).id})),note:'Preview only. Parent must collect existing in-flight jobs before preparing another overlapping round; no models or files created. Existing ID-prefix records with field errors are reported, not silently accepted or reread.'},null,2));process.exit(0);}
 const round=option('--round',null);if(!round||! /^[a-zA-Z0-9_-]+$/.test(round))throw Error('Explicit unique --round required');
 const dir=`output/literature-rebuild-20261021/coordinator/reader-jobs/${pkg.id}/${mode}-${round}`;
 if(fs.existsSync(local(dir)))throw Error('Round already exists; resume its children instead of reallocating');
 const jobs=chunks.map((rows,i)=>{const id=String(i+1).padStart(3,'0');return {id:`${pkg.id}-${mode}-${round}-${id}`,owner:arg,mode,count:rows.length,input:`${dir}/${id}-input.json`,input_sha256:sha(JSON.stringify(rows)),output:`${dir}/${id}-out.json`,chunk_file:`${dir}/${id}-chunk.json`,task_file:`${dir}/${id}-task.json`,reader_guide:pkgManifest.reader_guide,first_id:rows[0].id,last_id:rows.at(-1).id,instructions:'Run: node .agents/skills/literature-backfill/scripts/brief.mjs '+`${dir}/${id}-task.json`};});
 jobs.forEach((j,i)=>{save(j.input,chunks[i]);save(j.task_file,j);});
 const plan={owner:arg,package:pkg.id,package_manifest:pkg.manifest,mode,remaining:pending.length,review_ids:selectedIds,existing_result_issues:issues,jobs,audit_output:`${dir}/merged-review.json`,plan_file:`${dir}/plan.json`};save(plan.plan_file,plan);
 console.log(JSON.stringify({plan:plan.plan_file,owner:arg,mode,records:pending.length,children:jobs.map(j=>({task:j.task_file,count:j.count,output:j.output})),note:'No models launched. Parent assigns only within remaining current-turn delegation budget. Existing running tasks must not be duplicated.'},null,2));
