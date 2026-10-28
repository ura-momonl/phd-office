// Fill missing abstracts for the title-screened survivors of one package, then re-hash every input that carries them.
// Usage: fill-abstracts.mjs <package-id> [--round screen-r01] [--selected] [--dry-run] [--state <CONTINUE.json>]
// Run after the title phase (launch.mjs --phase titles) and BEFORE dispatching abstract readers: it rewrites child inputs.
// Sources: literature/abstracts.mjs enrichAbstracts (OpenAlex -> Semantic Scholar -> Springer Meta for 10.1038/; --selected adds APS and
// title-matched arXiv). No retries, 401/403/429 stop that source. Only abstract/abstract_from/abstract_url are written.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {local,read,sha,prefix} from './records.mjs';

const STATE='output/literature-rebuild-20261021/CONTINUE.json';
const save=(p,x)=>{const f=local(p),t=f+'.next-'+process.pid;fs.writeFileSync(t,JSON.stringify(x,null,2)+'\n','utf8');fs.renameSync(t,f);};
const publisher=doi=>String(doi||'').split('/')[0]||'unknown';

export async function fillAbstracts({pkgId,round='screen-r01',selected=false,dryRun=false,statePath=STATE,planPath,enrich}){
 const state=read(statePath),pkg=state.packages.find(p=>p.id===pkgId);
 if(!pkg)throw Error('Unknown package '+pkgId);
 const manifest=read(pkg.manifest),parent=read(pkg.input);
 if(sha(JSON.stringify(parent))!==manifest.input_sha256)throw Error('Parent input hash differs from manifest; repair first');
 planPath??=`output/literature-rebuild-20261021/coordinator/reader-jobs/${pkgId}/${round}/plan.json`;const plan=read(planPath);
 // 1. which survivors still lack an abstract (title pass done, not title-excluded, not yet judged)
 const jobs=plan.jobs.map(job=>{
  const task=read(job.task_file),rows=read(job.input);
  if(sha(JSON.stringify(rows))!==job.input_sha256||task.input_sha256!==job.input_sha256)throw Error('Child input hash mismatch '+job.id);
  const sf=local(task.chunk_file.replace(/\.json$/,'')+'.titles.json'),st=fs.existsSync(sf)?JSON.parse(fs.readFileSync(sf,'utf8')):{cursor:0,excluded:[]};
  const done=fs.existsSync(local(task.output))?prefix(task.output,rows).length:0,ex=new Set(st.excluded.map(x=>x.id));
  return {job,task,rows,cursor:st.cursor,done,
   need:rows.slice(done,Math.max(st.cursor,done)).filter(p=>!ex.has(p.id)&&!String(p.abstract||'').trim()),
   unscreened_missing:rows.slice(Math.max(st.cursor,done)).filter(p=>!String(p.abstract||'').trim()).length};
 });
 const need=new Map();for(const j of jobs)for(const p of j.need)need.set(p.id,p);
 const byPublisher={};for(const p of need.values())byPublisher[publisher(p.doi)]=(byPublisher[publisher(p.doi)]||0)+1;
 const report={package:pkgId,round,children:jobs.length,survivors_missing_abstract:need.size,by_doi_prefix:byPublisher,
  unscreened_missing_abstract:jobs.reduce((s,j)=>s+j.unscreened_missing,0),title_pass_complete:jobs.every(j=>j.cursor>=j.rows.length)};
 if(dryRun||!need.size)return {...report,applied:false};
 // 2. look them up (clones only)
 const items=[...need.values()].map(p=>({id:p.id,doi:p.doi,title:p.title,journal:p.journal,date:p.date}));
 const stats=await enrich(items,{selected});
 const updates=new Map(items.filter(p=>String(p.abstract||'').trim()).map(p=>[p.id,{abstract:p.abstract,abstract_from:p.abstract_from,abstract_url:p.abstract_url}]));
 report.filled=updates.size;report.still_missing=need.size-updates.size;
 report.sources=stats&&Object.fromEntries(['openalex','semantic_scholar','springer','aps','nature','arxiv'].map(k=>[k,stats[k]||0]).filter(([,v])=>v));
 if(!updates.size)return {...report,applied:false};
 // 3. back up, then rewrite parent/child/pool inputs and every hash that depends on them
 const stamp=new Date().toISOString().replace(/[-:T]/g,'').slice(0,14),backup=local(`.runtime/fill-abstracts-backup/${pkgId}-${stamp}`);
 fs.mkdirSync(backup,{recursive:true});let n=0;
 const keep=p=>fs.copyFileSync(local(p),path.join(backup,String(++n).padStart(3,'0')+'-'+path.basename(p)));
 const apply=rows=>{let c=0;for(const r of rows){const u=updates.get(r.id);if(u&&!String(r.abstract||'').trim()){Object.assign(r,u);c++;}}return c;};
 const pools=[...new Set(manifest.work_items.map(w=>w.input))];
 [pkg.input,pkg.manifest,planPath,...jobs.flatMap(j=>[j.job.input,j.job.task_file]),...pools,statePath].forEach(keep);
 apply(parent);save(pkg.input,parent);manifest.input_sha256=sha(JSON.stringify(parent));save(pkg.manifest,manifest);
 for(const j of jobs){apply(j.rows);save(j.job.input,j.rows);j.job.input_sha256=sha(JSON.stringify(j.rows));j.task.input_sha256=j.job.input_sha256;save(j.job.task_file,j.task);}
 save(planPath,plan);
 for(const f of pools){const pool=read(f);if(apply(pool))save(f,pool);}
 const fresh=read(statePath),fp=fresh.packages.find(p=>p.id===pkgId);fp.input_sha256=manifest.input_sha256;fresh.updated_at=new Date().toISOString();save(statePath,fresh);
 // 4. read back: hashes agree and every child row equals the parent row
 const pm=new Map(read(pkg.input).map(r=>[r.id,r]));
 for(const j of jobs){const rows=read(j.job.input),t=read(j.job.task_file);
  if(sha(JSON.stringify(rows))!==t.input_sha256||t.input_sha256!==read(planPath).jobs.find(x=>x.id===j.job.id).input_sha256)throw Error('Readback hash mismatch '+j.job.id);
  for(const r of rows)if(JSON.stringify(r)!==JSON.stringify(pm.get(r.id)))throw Error('Child row differs from parent '+r.id);}
 return {...report,applied:true,backup:'.runtime/fill-abstracts-backup/'+path.basename(backup)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const a=process.argv.slice(2),opt=k=>{const i=a.indexOf(k);return i<0?undefined:a[i+1];};
 if(!a[0]||a[0].startsWith('--'))throw Error('Usage: fill-abstracts.mjs <package-id> [--round screen-r01] [--selected] [--dry-run] [--state file]');
 const dry=a.includes('--dry-run');
 const enrich=dry?null:(await import('../../../../literature/abstracts.mjs')).enrichAbstracts;
 console.log(JSON.stringify(await fillAbstracts({pkgId:a[0],round:opt('--round')||'screen-r01',selected:a.includes('--selected'),dryRun:dry,statePath:opt('--state')||STATE,enrich}),null,1));
}
