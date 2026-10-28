// 复核收尾：首轮合并结果 + 一个只含改判条目的小文件 → 最终 decisions / audit / submission（并可入库）。
// 用法：node review-finish.mjs <pkg-id> <patches.json> [--out <目录>] [--admit]
// patches.json: {
//   "patches": { "<id>": { "decision":"include", "reason":"…", "evidence":"…", "direction":"new:…", "tags":[…], "type":"…" } },  // 只写要改的字段，其余沿用首轮
//   "read": ["id",…],   // 可选：实际读过的 id；缺省视为全部读过（只在确实读过全部时省略）
//   "notes": "…",       // 可选：audit 总备注
//   "strata": { "in": "…", "out": "…", "title": "…" }   // 可选：各排除层的复核备注
// }
// 改为 include 时自动补 scope=in、basis=abstract、source_status=full-abstract（首轮是 abstract 判的才行，题名排除的需自己写全）。
// 该包有 coordinator/reviews/<pkg>/flags.json 时，复核者判 admit 而最终仍不收/待核的条目必须在 patches 里写出新理由，与首轮逐字相同会打回（退出码 1，不写文件）；判 keep 的条目不约束。
// 首轮结果取包 manifest 里 work_items[0].output；不带 --out 时写到 deepseek-review-<NNN>/，带 --admit 才调用 admit-reviewed.mjs（有锁，已入库的包不会被改判重提）。
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {local,read,sha,problems,norm} from './records.mjs';
const args=process.argv.slice(2),pid=args[0],patchFile=args[1];
const opt=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
if(!pid||!patchFile)throw Error('Usage: review-finish.mjs <pkg-id> <patches.json> [--out <dir>] [--admit]');
const root='output/literature-rebuild-20261021';
const state=read(`${root}/CONTINUE.json`),pkg=state.packages.find(p=>p.id===pid);
if(!pkg)throw Error('Unknown package '+pid);
const owner=pkg.owner,manifest=read(pkg.manifest),input=read(pkg.input);
if(sha(JSON.stringify(input))!==manifest.input_sha256)throw Error('Package input hash changed');
const first=read(manifest.work_items[0].output);
if(first.length!==input.length||first.some((r,i)=>r.id!==input[i].id))throw Error('First-round result does not match package input (count or order)');
const {patches={},read:readIds=null,notes='',strata={}}=read(patchFile);
const inputIds=new Set(input.map(p=>p.id));
for(const id of Object.keys(patches))if(!inputIds.has(id))throw Error('Patch id not in package: '+id);
const decisions=first.map((r,i)=>{
 const pt=patches[r.id];if(!pt)return r;
 const flip=pt.decision==='include'?{scope:'in',basis:'abstract',source_status:'full-abstract'}:{};
 return {id:r.id,doi:input[i].doi,...r,...flip,...pt};
});
const bad=[];decisions.forEach((d,i)=>{for(const b of problems(d,input[i]))bad.push(input[i].id+'：'+b);});
if(bad.length){console.error(bad.join('\n'));process.exit(1);}
// 复核者判“建议改收”而我最后仍不收，才是真分歧：理由与首轮逐字相同，等于把这条分歧原样退回。
// 复核者判 keep（看过摘要后维持不收）的条目不断言，理由沿用首轮是正常的。
const flagsFile=`${root}/coordinator/reviews/${pid}/flags.json`;
const flagged=fs.existsSync(local(flagsFile))?read(flagsFile).flags:[];
const admitted=flagged.filter(f=>f.verdict!=='keep');        // 旧格式无 verdict 时按“可能建议改收”处理
const unchanged=admitted.filter(f=>{const d=decisions.find(r=>r.id===f.id),o=first.find(r=>r.id===f.id);
 return d&&o&&d.decision!=='include'&&norm(d.reason)===norm(o.reason);});
if(unchanged.length){
 console.error(`复核者建议改收的 ${admitted.length} 条里，有 ${unchanged.length} 条最后仍不收/待核、理由与首轮逐字相同：`);
 for(const f of unchanged)console.error(`  ${f.id}  复核者：${norm(f.why).slice(0,100)}`);
 console.error('请在 patches.json 里为它们写 decision（exclude 或 pending）和新的 reason：这篇实际做了什么、为什么看不到具体看点。如果认为复核者判断有误，理由要说出它漏看或误解的具体内容，不能把首轮理由原样退回。');
 process.exit(1);
}
const dir=opt('--out')||`${root}/deepseek-review-${pid.split('-').pop()}`;
fs.mkdirSync(local(dir),{recursive:true});
const w=(f,o)=>fs.writeFileSync(local(`${dir}/${f}`),JSON.stringify(o,null,1)+'\n','utf8');
const rs=readIds?new Set(readIds):null,keep=ids=>rs?ids.filter(id=>rs.has(id)):ids;
const ids=f=>decisions.filter(f).map(d=>d.id);
const inc=ids(d=>d.decision==='include'),pend=ids(d=>d.decision==='pending');
const exIn=ids(d=>d.decision==='exclude'&&d.scope==='in'),exOut=ids(d=>d.decision==='exclude'&&d.scope==='out'&&d.basis==='abstract'),exTitle=ids(d=>d.decision==='exclude'&&d.basis==='obvious-title');
const changed=Object.keys(patches).filter(id=>first.find(r=>r.id===id).decision!==patches[id].decision&&patches[id].decision);
const audit={owner,package:pid,at:new Date().toISOString(),checked_include_ids:keep(inc),checked_pending_ids:keep(pend),checked_exclude_ids:keep([...exIn,...exOut,...exTitle]),
 exclusion_audit:[
  {stratum:`相关但不收（scope=in，${exIn.length} 条）`,ids:keep(exIn),note:strata.in||`实际读过摘要；改判 ${changed.length} 条：${changed.join('、')||'无'}。`},
  {stratum:`明显无关（scope=out，摘要判，${exOut.length} 条）`,ids:keep(exOut),note:strata.out||'实际读过摘要。'},
  {stratum:`题名排除（${exTitle.length} 条）`,ids:keep(exTitle),note:strata.title||'题名阶段排除。'}].filter(g=>g.ids.length),
 notes:notes||`首轮 ${first.filter(r=>r.decision==='include').length} 收，复核后 ${inc.length} 收；改判 ${changed.length} 条。`};
w(`decisions-${pid}.json`,decisions);w(`audit-${pid}.json`,audit);
w(`submission-${pid}.json`,{owner,package:pid,decisions:`${dir}/decisions-${pid}.json`,audit:`${dir}/audit-${pid}.json`});
const k=d=>d.decision+(d.decision==='exclude'?'/'+d.scope:'');
const flips=decisions.filter((d,i)=>k(d)!==k(first[i])).map(d=>`| ${d.id} | ${k(first.find(r=>r.id===d.id))} → ${k(d)} | ${String(d.reason||'').slice(0,80)} |`);
fs.writeFileSync(local(`${dir}/REVIEW-NOTES-skeleton.md`),`# ${pid} 复核记录（脚本骨架，补充口径后可直接用）\n\n| | 收 | 相关不收 | 明显无关 | 题名排除 | pending |\n|---|---|---|---|---|---|\n| 首轮 | ${first.filter(r=>r.decision==='include').length} | ${first.filter(r=>r.decision==='exclude'&&r.scope==='in').length} | ${first.filter(r=>r.decision==='exclude'&&r.scope==='out').length} | - | ${first.filter(r=>r.decision==='pending').length} |\n| 复核后 | ${inc.length} | ${exIn.length} | ${exOut.length} | ${exTitle.length} | ${pend.length} |\n\n## 改判\n\n| id | 首轮 → 最终 | 理由 |\n|---|---|---|\n${flips.join('\n')||'| （无） | | |'}\n`);
console.log(JSON.stringify({records:decisions.length,include:inc.length,exclude_in:exIn.length,exclude_out:exOut.length,exclude_title:exTitle.length,pending:pend.length,changed:flips.length,dir},null,1));
if(args.includes('--admit')){
 execFileSync(process.execPath,[fileURLToPath(new URL('./admit-reviewed.mjs',import.meta.url)),`${dir}/submission-${pid}.json`],{stdio:'inherit'});
}
