// New journal -> registered packages on the standard rails. No models, no network, no catalog write.
// Usage (office root): node .agents/skills/literature-backfill/scripts/build-packages.mjs --owner claude|codex --slug prb --dir output/literature-rebuild-20261021/prb-20261023 \
//   --years 2015-2026 --prefix prb --label "Physical Review B" [--register 1] [--dry-run]
// Input: <dir>/directory-<slug>-<year>.json, each {complete_index_response, items:[{doi,title,date,year,openalex_id,journal,authors,abstract,abstract_from,abstract_url,discovery,id?}]}.
// Output: pool/ + out/ under <dir>, coordinator inputs + manifests (~1000 records each, date order), first N registered in CONTINUE.json.
// Next: dispatch.mjs -> launch.mjs <owner> <pkg> --phase titles (sub-agents read brief.mjs; no per-journal reader cards).
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const A=process.argv.slice(2),opt=(k,d)=>{const i=A.indexOf('--'+k);return i<0?d:A[i+1];};
const owner=opt('owner'),slug=opt('slug'),dir=opt('dir'),prefix=opt('prefix'),label=opt('label',slug),dry=A.includes('--dry-run');
const [y0,y1]=String(opt('years','')).split('-').map(Number),reg=Number(opt('register',1));
if(!['claude','codex'].includes(owner)||!/^[a-z0-9]+$/.test(slug||'')||!dir||!y0||!y1||y1<y0)throw Error('Usage: --owner claude|codex --slug <a-z0-9> --dir <dir> --years 2015-2026 [--prefix p] [--label name] [--register N] [--dry-run]');
const root='output/literature-rebuild-20261021',sha=x=>createHash('sha256').update(x).digest('hex');
const norm=s=>String(s||'').replace(/^https?:\/\/(dx\.)?doi.org\//i,'').toLowerCase().trim();
const rd=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const inCat=new Set(rd('literature/catalog.json').papers.map(p=>norm(p.doi)));
const all=[];for(let y=y0;y<=y1;y++){const d=rd(`${dir}/directory-${slug}-${y}.json`);if(!d.complete_index_response)throw Error('directory incomplete: '+y);all.push(...d.items);}
const seen=new Set(),dups=[],skipped=[],rows=[];
for(const it of all){const doi=norm(it.doi);
 if(!doi||!it.title){skipped.push({openalex_id:it.openalex_id,doi:it.doi,title:it.title,reason:'no DOI or title'});continue;}
 if(inCat.has(doi)){dups.push({doi,title:it.title,reason:'already in catalog'});continue;}
 if(seen.has(doi)){dups.push({doi,title:it.title,reason:'duplicate in directory'});continue;}
 seen.add(doi);rows.push({...it,doi});}
rows.sort((a,b)=>(a.date||'').localeCompare(b.date||'')||a.doi.localeCompare(b.doi));
if(!rows.length)throw Error('no records left after dedupe');
if(rows.some(r=>!r.id)){if(!prefix)throw Error('records have no id: pass --prefix');const n={};for(const r of rows){const y=String(r.year).slice(2);n[y]=(n[y]||0)+1;r.id=prefix+y+'-'+String(n[y]).padStart(5,'0');}}
if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('record ids are not unique');
const N=Math.ceil(rows.length/1000),size=Math.ceil(rows.length/N);
const sp=root+'/CONTINUE.json',bytes=fs.readFileSync(sp),state=JSON.parse(bytes);
const tpl=[...state.packages].reverse().find(p=>p.owner===owner&&p.task&&p.output_contract&&p.local_rules);
if(!tpl)throw Error('no existing '+owner+' package to copy the standard contract from');
const plan=[];
for(let i=0;i<N;i++){const part=rows.slice(i*size,(i+1)*size),pid=`pkg-${owner}-${slug}-${String(i+1).padStart(3,'0')}`;plan.push({pid,wid:pid+'-'+slug,part});}
const summary={directory:all.length,duplicates:dups.length,skipped_no_doi_or_title:skipped.length,pool:rows.length,with_abstract:rows.filter(r=>(r.abstract||'').trim()).length,packages:N,per_package:size,register:Math.min(reg,N),packages_detail:plan.map(p=>`${p.pid}:${p.part.length}:${p.part[0].id}..${p.part.at(-1).id}`)};
if(dry){console.log(JSON.stringify({dry_run:true,...summary},null,1));process.exit(0);}
const pkgs=[];
for(const {pid,wid,part} of plan){
 const poolPath=`${dir}/pool/${pid}.json`,outPath=`${dir}/out/${wid}.json`,inputPath=`${root}/coordinator/inputs-${pid}.json`;
 fs.mkdirSync(dir+'/pool',{recursive:true});fs.mkdirSync(dir+'/out',{recursive:true});
 const pool=part.map(r=>({openalex_id:r.openalex_id,doi:r.doi,title:r.title,date:r.date,year:r.year,type:r.type,journal:r.journal,authors:r.authors,abstract:r.abstract||'',abstract_from:r.abstract?r.abstract_from:null,abstract_url:r.abstract?r.abstract_url:null,id:r.id,discovery:r.discovery}));
 const input=pool.map(p=>({...p,work_item_id:wid,assigned_output:outPath}));
 fs.writeFileSync(poolPath,JSON.stringify(pool,null,2)+'\n',{flag:'wx'});fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
 const item={id:wid,owner,status:'ready',source_unit:`${slug}-${y0}-${y1}`,input:poolPath,start_index:1,end_index:pool.length,count:pool.length,first_id:pool[0].id,last_id:pool.at(-1).id,output:outPath,reader_guide:tpl.reader_guide,already_delivered:0,remaining:pool.length};
 const manifestPath=`${root}/coordinator/${pid}.json`;
 const manifest={...rd(tpl.manifest),id:pid,owner,worker_conversation:null,status:'ready',assigned_records:pool.length,work_item_ids:[wid],manifest:manifestPath,input:inputPath,input_sha256:sha(JSON.stringify(input)),child_dispatch_plan:`${root}/coordinator/reader-jobs/${pid}/screen-r01/plan.json`,child_dispatch_status:'not-prepared',work_items:[item],scope_note:`${label} ${pool[0].date}..${pool.at(-1).date}, complete journal-year directory, date order; no topic/title/citation/random gate. Coarse screening pass; not admitted.`};
 delete manifest.resume_prepared_jobs;delete manifest.worker_task;
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});pkgs.push({manifest,item});}
fs.writeFileSync(dir+'/duplicates-and-skipped.json',JSON.stringify({dups,skipped},null,1)+'\n',{flag:'wx'});
fs.writeFileSync(`${dir}/CONTINUE-before-${slug}.json`,bytes,{flag:'wx'});
for(const {manifest,item} of pkgs.slice(0,reg)){const {work_items:_,...pk}=manifest;if(state.packages.some(p=>p.id===pk.id))throw Error('exists: '+pk.id);state.packages.push({...pk,reserve:false});state.work_items.push(item);}
state.updated_at=new Date().toISOString();
if(!fs.readFileSync(sp).equals(bytes))throw Error('CONTINUE.json changed while building; nothing registered');
fs.writeFileSync(sp,JSON.stringify(state,null,2)+'\n');
fs.writeFileSync(dir+'/SUMMARY.json',JSON.stringify(summary,null,1)+'\n',{flag:'wx'});
const first=pkgs[0].manifest.id;
console.log(JSON.stringify({...summary,packages_detail:undefined,next:[`node .agents/skills/literature-dispatch/scripts/dispatch.mjs ${owner} --package ${first} --children 10 --round r01`,`node .agents/skills/literature-backfill/scripts/launch.mjs ${owner} ${first} --phase titles`],registered:Math.min(reg,N)}));
