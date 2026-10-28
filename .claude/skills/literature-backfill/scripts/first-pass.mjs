// One command for the whole first pass of a DeepSeek package: api-screen every block (serial) -> merge -> review-flags (writes lite.txt for the owner).
// Replaces ~15 separate agent requests (each re-reading the whole conversation) with one. No new model calls beyond api-screen itself.
// Usage: node first-pass.mjs <PACKAGE_ID>      (safe to re-run: api-screen resumes from the saved prefix, merge and review-flags are idempotent; review-flags makes a fresh reviewer call each time)
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {read,local} from './records.mjs';
const pid=process.argv[2];
if(!pid)throw Error('Usage: first-pass.mjs <PACKAGE_ID>');
const dir=p=>fileURLToPath(new URL(p,import.meta.url));
const state=read('output/literature-rebuild-20261021/CONTINUE.json'),pkg=state.packages.find(p=>p.id===pid);
if(!pkg)throw Error('Unknown package '+pid);
const manifest=read(pkg.manifest),planPath=manifest.child_dispatch_plan;
if(!planPath)throw Error('Package has no dispatch plan; run literature-dispatch first');
const plan=read(planPath);
const root=fileURLToPath(new URL('../../../../',import.meta.url));
// 沙箱里子进程不能用管道捕获输出（EPERM），改用文件描述符接 stdout，再读回文本。
// 临时文件带上进程号：多个对话同时跑不同包时，共用一个文件会互相覆盖（2026-10-26 pkg-deepseek-055 撞过）。
const tmp=local(`.runtime/first-pass-child-${process.pid}.out`);
const node=(script,...a)=>{
 const fd=fs.openSync(tmp,'w');
 try{execFileSync(process.execPath,[dir(script),...a],{stdio:['ignore',fd,'inherit'],cwd:root});}
 finally{fs.closeSync(fd);}
 return fs.readFileSync(tmp,'utf8');
};
const total={req:0,miss:0,hit:0,out:0},blocks=[];
for(const job of plan.jobs){
 const out=node('./api-screen.mjs',job.task_file).trim().split('\n').pop();
 const r=JSON.parse(out);blocks.push({task:job.task_file,saved:r.saved,total:r.total,complete:r.complete});
 for(const k in total)total[k]+=r.usage?.[k]||0;
 if(!r.complete){console.log(JSON.stringify({package:pid,stopped_at:job.task_file,blocks,usage:total,note:'block incomplete; re-run first-pass to resume'}));process.exit(1);}
}
const merge=JSON.parse(node('./reader-work.mjs','merge',planPath).trim().split('\n').pop());
const pack=node('./review-flags.mjs',pid).trim();
const cny=(total.miss*1.2+total.hit*0.05+total.out*2.4)/1e6;
const flagsOut=JSON.parse(pack.split('\n').pop());
console.log(JSON.stringify({package:pid,blocks,merge,usage:total,est_cny_calibrated:+cny.toFixed(3),review_flags:flagsOut,next:'读 review_flags.lite（A 段建议改收的完整摘要；A2 段复核者维持不收的标题＋理由；B 段收录的标题＋理由＋证据；C 段未标出的排除），写 patches.json（含 read 和 notes，如实写收录只读了标题理由证据；保留不收的条目要写新理由，与首轮逐字相同会被打回），再 node .agents/skills/literature-backfill/scripts/review-finish.mjs '+pid+' <patches.json> --admit'}));
try{fs.unlinkSync(tmp);}catch{}
