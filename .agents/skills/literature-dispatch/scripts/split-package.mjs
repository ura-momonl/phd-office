// 从一个空闲的 ready 包（无子任务产出）里拆出前 N 篇，成为交给 DeepSeek 的新包 pkg-deepseek-NNN；源包保留剩余。不调模型、不写库。
// 用法：node split-package.mjs <源包ID> <新包ID> [N=200] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const base='output/literature-rebuild-20261021', A=process.argv.slice(2).filter(x=>!x.startsWith('--'));
const SRC=A[0], NEW=A[1], N=Number(A[2]||200), dir=`${base}/${NEW}-split`;
if(!SRC||!NEW||!/^pkg-deepseek-[0-9]+$/.test(NEW))throw Error('Usage: split-package.mjs <源包ID> pkg-deepseek-NNN [N] [--dry-run]');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const sha=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const save=(p,o)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n');};
const statePath=`${base}/CONTINUE.json`, state=read(statePath), src=state.packages.find(p=>p.id===SRC);
if(!src || src.owner!=='codex' || src.worker_conversation || src.status!=='ready')throw Error('Source not idle and owned');
if(state.packages.some(p=>p.id===NEW))throw Error('Package already exists');
const manifest=read(src.manifest), all=read(src.input), wi=manifest.work_items[0];
if(manifest.work_items.length!==1 || sha(all)!==manifest.input_sha256 || all.length<=N)throw Error('Source shape/hash');
if(fs.existsSync(wi.output))throw Error('Source already has parent output');
const jobsDir=`${base}/coordinator/reader-jobs/${SRC}`;
const walk=p=>fs.existsSync(p)?fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]):[];
if(walk(jobsDir).some(p=>p.endsWith('-out.json')||p.endsWith('-chunk.json')||p.endsWith('merged-review.json')))throw Error('Source has child work');
const take=all.slice(0,N), keep=all.slice(N), keys=new Set(take.map(p=>p.doi.toLowerCase()));
const catPath='literature/catalog.json', catHash=sha(read(catPath));
const have=new Set(read(catPath).papers.map(p=>(p.doi||'').toLowerCase()));
if(keys.size!==N || take.some(p=>have.has(p.doi.toLowerCase())||!p.abstract||p.abstract.length<50))throw Error('Duplicate/catalog/abstract issue');
for(const p of state.packages){
  if(p.id===SRC||p.status==='superseded'||!p.input||!fs.existsSync(p.input))continue;
  if(read(p.input).some(r=>keys.has((r.doi||'').toLowerCase())))throw Error(`Overlap ${p.id}`);
}
console.log(JSON.stringify({package:NEW,source:SRC,take:N,keep:keep.length,first:take[0].id,last:take.at(-1).id,dates:[...take.map(p=>p.date)].sort().filter((v,i,a)=>i===0||i===a.length-1),no_catalog_or_package_duplicates:true}));
if(process.argv.includes('--dry-run'))process.exit(0);
for(const p of [statePath,src.manifest,src.input]){const dst=`${dir}/before/${p}`;fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(p,dst);}
// Archive the unused old dispatch intact, inside the workspace.
if(fs.existsSync(jobsDir)){
  const target=`${dir}/before/reader-jobs-${SRC}`;
  fs.renameSync(jobsDir,target);
}
const workId=`${NEW}-papers`, output=`${dir}/out/${workId}.json`, input=`${base}/coordinator/inputs-${NEW}.json`;
const rows=take.map(p=>({...p,work_item_id:workId,assigned_output:output}));
const nw={...wi,id:workId,owner:'deepseek',status:'ready',count:N,end_index:wi.start_index+N-1,first_id:take[0].id,last_id:take.at(-1).id,output,already_delivered:0,remaining:N};
const nm={...manifest,id:NEW,owner:'deepseek',worker_conversation:null,status:'ready',assigned_records:N,work_item_ids:[workId],manifest:`${base}/coordinator/${NEW}.json`,input,input_sha256:sha(rows),task:`从 ${SRC} 拆出 ${N} 篇交给 DeepSeek；摘要齐全，接续文献 skill（api-screen 首轮、review-finish 收尾）完成筛选、本人复核与入库。`,output_contract:'保留来源与ID，由DeepSeek形成最终判断并通过共享入库入口登记。',child_dispatch_plan:`${base}/coordinator/reader-jobs/${NEW}/screen-r01/plan.json`,child_dispatch_status:'not-prepared',split_from:SRC,split_delivery:`${dir}/DELIVERY.json`,work_items:[nw]};
const sm={...manifest,assigned_records:keep.length,input_sha256:sha(keep),child_dispatch_status:'not-prepared',split_delivery:`${dir}/DELIVERY.json`,work_items:[{...wi,start_index:wi.start_index+N,count:keep.length,first_id:keep[0].id,last_id:keep.at(-1).id,remaining:keep.length}]};
save(input,rows);save(nm.manifest,nm);save(src.input,keep);save(src.manifest,sm);
const {work_items:_a,...ns}=nm, {work_items:_b,...ss}=sm;
Object.assign(src,ss);state.packages.push(ns);state.updated_at=new Date().toISOString();save(statePath,state);
// Read back actual saved inputs and manifests, exact partition and hashes.
const actual=read(input), remaining=read(src.input), current=read(statePath);
if(JSON.stringify([...actual.map(r=>r.id),...remaining.map(r=>r.id)])!==JSON.stringify(all.map(r=>r.id)))throw Error('Partition failed');
for(const p of [nm,sm])if(sha(read(p.input))!==read(p.manifest).input_sha256||sha(read(p.input))!==current.packages.find(r=>r.id===p.id).input_sha256)throw Error('Readback hash mismatch');
if(sha(read(catPath))!==catHash)throw Error('Catalog changed during split');
save(`${dir}/DELIVERY.json`,{at:new Date().toISOString(),request:'切包交给 DeepSeek（split-package.mjs）',package:NEW,owner:'deepseek',journal:all[0].journal||SRC,count:N,first_id:actual[0].id,last_id:actual.at(-1).id,date_range:actual.map(p=>p.date).sort().filter((v,i,a)=>i===0||i===a.length-1),abstracts:actual.filter(p=>p.abstract?.length>50).length,input,manifest:nm.manifest,source:SRC,source_remaining:remaining.length,backup:`${dir}/before`,verification:{exact_partition:true,input_and_state_hash_readback:true,no_catalog_duplicates:true,no_other_package_overlap:true,catalog_unchanged:true}});
console.log('SAVED AND VERIFIED');
