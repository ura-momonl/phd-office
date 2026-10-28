// Cheap second look after the first pass: one-shot API reviewer over the first-pass non-includes, then a compact reading file for the owner.
// The owner reads lite.txt instead of the full 400 KB review pack: A 段（建议改收）读完整摘要，A2 段（维持不收）只给标题＋复核者理由，收录条目给标题＋理由＋证据句，未标出的不收/待核只给标题＋首轮理由。
// 复核者对每条只给一个结论（admit/keep），不再递回“若…则收、若…则排”的条件建议；verdict/why 不合格按格式错误退出，不补成默认结论。
// 2026-10-25 起 review-finish 只对复核者判 admit、最后仍不收且理由与首轮逐字相同的条目打回（判 keep 的条目不受约束）。
// Evaluated offline on pkg-deepseek-005/007/008/009 (output/literature-rebuild-20261021/cheap-review-eval): the reviewer (thinking high) flagged the agent-reviewed flips 23/31 and flagged ~32% of candidates.
// Usage: node review-flags.mjs <PACKAGE_ID> [--effort high|off] [--blind] [--out=<dir>] [--batch=25] [--max-tokens=16000]       Writes coordinator/reviews/<PKG>/{flags.json,lite.txt}
// 一批被 max_tokens 截断时自动对半重发；每批结论落盘 flags.partial.json，中断后重跑同一命令按已得结论续跑。
// --blind 不给复核者看首轮理由（只给标题＋完整摘要），用于检验复核是否被首轮判断锚定；--out 换输出目录，测试时用，不覆盖已交付的 flags。
import fs from 'node:fs';
import {local,read,sha,flipFlagProblem} from './records.mjs';
import {postChat} from './ds-api.mjs';
const pid=process.argv[2],ei=process.argv.indexOf('--effort'),effort=ei<0?'high':process.argv[ei+1];
const blind=process.argv.includes('--blind');
const oi=process.argv.findIndex(a=>a.startsWith('--out=')),outDir=oi<0?null:process.argv[oi].slice(6);
if(!pid)throw Error('Usage: review-flags.mjs <PACKAGE_ID> [--effort high|off] [--blind] [--out=<dir>]');
const root='output/literature-rebuild-20261021';
const state=read(`${root}/CONTINUE.json`),pkg=state.packages.find(p=>p.id===pid);
if(!pkg)throw Error('Unknown package '+pid);
const man=read(pkg.manifest),input=read(pkg.input);
if(sha(JSON.stringify(input))!==man.input_sha256)throw Error('Package input changed');
const first=read(man.work_items[0].output);
if(first.length!==input.length||first.some((d,i)=>d.id!==input[i].id))throw Error('First-pass results do not cover the package in order (run first-pass / merge)');
const byId=new Map(input.map(p=>[p.id,p]));
const cand=first.filter(d=>d.decision!=='include'&&d.basis!=='obvious-title');
const text=p=>fs.readFileSync(local(p),'utf8');
const SYSTEM=`你是文献复核者。下面每篇都被初筛判为“不收”或“待核”，${blind?'附完整摘要':'附初筛理由和完整摘要'}。按唯一选文标准独立判断这一篇相关之后有没有具体看点：该改收，还是维持不收。\n\n每条只给一个结论。不写“若算作…则收、若按…则排”这类条件结论，也不因为初筛已判不收就跟着不收。\n\n${text(`${root}/batch-007/RUBRIC.md`)}\n\n# 选文标准\n${text(`${root}/FUTURE-SCREENING-STRATEGY.md`)}\n\n# 输出\n只输出 JSON：{"flip":[{"id":"..","verdict":"admit","why":"…"},{"id":"..","verdict":"keep","why":"…"}]}。\n- 明显无关、一句话说不出的不必列；列出的每条都要给结论。\n- verdict 只取 admit（建议改收）或 keep（看过完整摘要，维持不收）。\n- why 写这篇实际做了什么，以及看点何在或为什么看不到具体看点；一句中文，不写“属某领域”“常规做法”。`;
const usage={req:0,miss:0,hit:0,out:0};
const maxTokens=Number((process.argv.find(a=>a.startsWith('--max-tokens='))||'').slice(14))||16000;
async function ask(user){
 const body={messages:[{role:'system',content:SYSTEM},{role:'user',content:user}],response_format:{type:'json_object'},max_tokens:maxTokens};
 if(effort==='off')body.thinking={type:'disabled'};else{body.thinking={type:'enabled'};body.reasoning_effort=effort;}
 const r=await postChat(body,600000);
 if(!r.ok)throw Error('DeepSeek API '+r.status+(r.text?(' '+await r.text()):''));
 const j=await r.json(),u=j.usage||{};usage.req++;usage.hit+=u.prompt_cache_hit_tokens||0;usage.miss+=u.prompt_cache_miss_tokens||0;usage.out+=u.completion_tokens||0;
 if(j.choices[0].finish_reason!=='stop')throw Error('reviewer reply not finished: '+j.choices[0].finish_reason);
 return JSON.parse(j.choices[0].message.content);
}
const batchSize=Number((process.argv.find(a=>a.startsWith('--batch='))||'').slice(8))||25;
const dir=outDir||`${root}/coordinator/reviews/${pid}`;
// 一批被 max_tokens 截断时对半再发，避免整包重跑；每批落盘 partial，中断后按已得结论续跑。
const partialFile=`${dir}/flags.partial.json`;
const flags=new Map();let unlabeled=0;const badFlag=[];
if(fs.existsSync(local(partialFile))){
 // 只续用同一 effort／非盲跑的结论；换条件重跑时不混入旧结论。
 const prev=read(partialFile);
 if(prev.effort===effort&&Boolean(prev.blind)===blind)for(const e of prev.flags)if(!flipFlagProblem(e))flags.set(e.id,{verdict:e.verdict,why:e.why});
}
const savePartial=()=>{fs.mkdirSync(local(dir),{recursive:true});
 fs.writeFileSync(local(partialFile),JSON.stringify({package:pid,effort,blind,flags:[...flags].map(([id,f])=>({id,...f}))},null,1)+'\n','utf8');};
const askSplit=async(items)=>{
 try{return (await ask(JSON.stringify(items))).flip||[];}
 catch(e){
  if(!/not finished: length/.test(e.message)||items.length<2)throw e;
  const m=Math.ceil(items.length/2);
  return [...await askSplit(items.slice(0,m)),...await askSplit(items.slice(m))];}
};
const todo=cand.filter(d=>!flags.has(d.id));
for(let i=0;i<todo.length;i+=batchSize){
 const batch=todo.slice(i,i+batchSize).map(d=>({id:d.id,title:byId.get(d.id).title,...(blind?{}:{first_pass_reason:d.reason}),abstract:byId.get(d.id).abstract}));
 const out={flip:await askSplit(batch)};
 for(const f of out.flip)if(batch.some(b=>b.id===f.id)){
  const why=String(f.why||'');
  const problem=flipFlagProblem(f);
  if(problem){badFlag.push(`${f.id}：${problem}`);unlabeled++;continue;}
  flags.set(f.id,{verdict:f.verdict,why});
 }
 savePartial();
}
if(badFlag.length){
 console.error(`复核者回复有 ${badFlag.length} 条格式不合格，按格式错误处理，不替它决定收排，也没有写 flags：`);
 for(const b of badFlag)console.error('  '+b);
 console.error('这一包的复核费用已经花掉；修好提示词后重跑 review-flags 这一包即可，已入库的文献不受影响。');
 process.exit(1);
}
fs.mkdirSync(local(dir),{recursive:true});
const short=(s,n)=>String(s||'').replace(/\s+/g,' ').slice(0,n);
const flagged=cand.filter(d=>flags.has(d.id)),admit=flagged.filter(d=>flags.get(d.id).verdict==='admit'),hold=flagged.filter(d=>flags.get(d.id).verdict==='keep'),rest=cand.filter(d=>!flags.has(d.id)),inc=first.filter(d=>d.decision==='include');
const lines=[`# ${pid} 精简复核（复核者 effort=${effort}）`,`首轮 收 ${inc.length}；不收/待核 ${cand.length}（复核者看过 ${flagged.length}：建议改收 ${admit.length}，维持不收 ${hold.length}）；题名排除 ${first.length-inc.length-cand.length}`,'',`## A. 复核者建议改收（${admit.length}，完整摘要；要判是否改收）`];
for(const d of admit){const p=byId.get(d.id);lines.push('',`### ${d.id} | 首轮 ${d.decision}/${d.scope} | ${p.title}`,`首轮理由：${d.reason}`,`复核者：${flags.get(d.id).why}`,`摘要：${p.abstract}`);}
if(hold.length){lines.push('',`## A2. 复核者看过摘要后维持不收（${hold.length}，标题＋复核者理由；要判是否仍不收）`);
for(const d of hold)lines.push(`${d.id} | ${short(byId.get(d.id).title,110)} | 复核者：${short(flags.get(d.id).why,150)}`);}
lines.push('',`## B. 首轮收录（${inc.length}，只给标题、理由、证据句；有疑问的 id 再取全摘要）`);
for(const d of inc)lines.push(`${d.id} | ${short(byId.get(d.id).title,110)} | ${short(d.reason,150)} | E: ${short(d.evidence,110)}`);
lines.push('',`## C. 复核者未标出的不收/待核（${rest.length}，标题＋首轮理由前段）`);
for(const d of rest)lines.push(`${d.id} | ${d.scope} | ${short(byId.get(d.id).title,110)} | ${short(d.reason,90)}`);
fs.writeFileSync(local(`${dir}/lite.txt`),lines.join('\n')+'\n','utf8');
fs.writeFileSync(local(`${dir}/flags.json`),JSON.stringify({package:pid,effort,blind,candidates:cand.length,flags:[...flags].map(([id,f])=>({id,verdict:f.verdict,why:f.why})),unlabeled,usage},null,1)+'\n','utf8');
const cny=(usage.miss*1.2+usage.hit*0.05+usage.out*2.4)/1e6;
console.log(JSON.stringify({package:pid,effort,candidates:cand.length,flagged:flagged.length,admit:admit.length,keep:hold.length,unlabeled,includes:inc.length,usage,est_cny_calibrated:+cny.toFixed(3),lite:`${dir}/lite.txt`,chars:lines.join('\n').length}));
