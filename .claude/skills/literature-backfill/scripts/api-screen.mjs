// One-shot API screening of a task block: no agent loop, no accumulating context.
// Each request = fixed system prompt (RUBRIC + selection standard + output format; prefix-cached) + one page of abstracts.
// Replies are fed to reader-work.mjs append (same validation and expansion as hand-written pages), so output files are identical in form.
// Usage: node api-screen.mjs <TASK> [--page 25] [--max-pages N] [--dry-run]
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {local,read,loadTask,prefix} from './records.mjs';
import {postChat,channelName} from './ds-api.mjs';
const args=process.argv.slice(2),taskPath=args[0];
const opt=(k,d)=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
if(!taskPath)throw Error('Usage: api-screen.mjs <TASK> [--page 25] [--max-pages N] [--dry-run]');
const PAGE=Number(opt('--page',25)),MAXP=Number(opt('--max-pages',1e9)),DRY=args.includes('--dry-run');
const {t,data}=loadTask(taskPath);
const worker=fileURLToPath(new URL('./reader-work.mjs',import.meta.url));
const text=p=>fs.readFileSync(local(p),'utf8');
const FORMAT=`# 输出格式
你逐篇读摘要，输出一个 JSON 对象 {"records":[...]}，每篇一条，顺序和 id 与输入完全一致，不能缺、不能多。字段：
- d: "i"(include) | "x"(exclude) | "p"(pending)
- t: experiment|theory|computation|experiment-and-theory|review|method|perspective
- r: 中文理由，写看点和论据（具体内容，不套模板、不写“与低维无关”这类相关性论证）
- g: 2–5 个短标签，第一个是方向
- e: 摘要里的连续原文，≤20 个英文词，大小写空格与原文一致，不含 LaTeX 或公式；必须出自摘要，不是题名
- s: 仅 d="x" 时必填："in"=相关但不收，"out"=明显无关
- 没有摘要的条目：d 只能是 "x"(题名明显无关或明显属排除类，可省 t) 或 "p"(仍要写 t、r、g，t 按题名判断体裁)，加 "ss":"missing"，不写 e。
只输出 JSON，不要解释。`;
const SYSTEM=[ '你是文献初筛读者。按下面的阅读规范和唯一选文标准，逐篇读完整摘要并判断。', text(t.reader_guide), '# 选文标准\n'+text('output/literature-rebuild-20261021/FUTURE-SCREENING-STRATEGY.md'), FORMAT ].join('\n\n');
let usage={req:0,miss:0,hit:0,out:0};
async function ask(messages){
 const r=await postChat({messages,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:12000},300000);
 if(!r.ok)throw Error('DeepSeek API '+r.status+(r.text?(' '+await r.text()):''));
 const j=await r.json(),u=j.usage||{};usage.req++;usage.hit+=u.prompt_cache_hit_tokens||0;usage.miss+=u.prompt_cache_miss_tokens||0;usage.out+=u.completion_tokens||0;
 if(j.choices[0].finish_reason!=='stop')throw Error('reply not finished: '+j.choices[0].finish_reason);
 return j.choices[0].message.content;
}
// Stamp equivalent to brief.mjs: the standard in SYSTEM is what this reader saw.
fs.writeFileSync(local(t.chunk_file.replace(/\.json$/,'')+'.briefed.json'),JSON.stringify({task:taskPath,at:new Date().toISOString(),by:'api-screen',channel:channelName()})+'\n');
// Evidence must be a verbatim <=20-word run of the abstract. If the model's quote drifted, keep the longest verbatim window of its own words (still the model's choice, still source text).
const nz=x=>String(x||'').replace(/\s+/g,' ').trim();
function fixEvidence(e,abs){const a=nz(abs),w=nz(e).split(' ').filter(Boolean);if(!w.length||!a)return e;
 if(w.length<=20&&a.includes(w.join(' ')))return w.join(' ');
 for(let n=Math.min(20,w.length);n>=5;n--)for(let i=0;i+n<=w.length;i++){const c=w.slice(i,i+n).join(' ');if(a.includes(c))return c;}
 return e;}
// 模型偶尔漏写 e 或把题名当引文（多见于判 out 的条目）。单独补要一次引文再 append；引文仍由模型选、仍须出自摘要。
async function fillEvidence(recs,items){
 const a=i=>nz(items[i].abstract);
 const need=recs.map((x,i)=>[x,i]).filter(([x,i])=>a(i)&&(typeof x.e!=='string'||!nz(x.e)||!a(i).includes(nz(x.e))));
 if(!need.length)return 0;
 const q=need.map(([x,i])=>({id:x.id,title:items[i].title,abstract:items[i].abstract}));
 const reply=await ask([{role:'system',content:'为下列每篇给出摘要中的一句连续原文（不超过 20 个英文词，大小写与空格与原文一致，不含 LaTeX 或公式），用于定位该条。只输出 JSON 对象 {"quotes":{"<id>":"…"}}，id 要齐。'},{role:'user',content:JSON.stringify(q)}]);
 const quotes=JSON.parse(reply).quotes||{};
 let n=0;for(const [x,i] of need){const v=quotes[x.id];if(typeof v!=='string')continue;const f=nz(fixEvidence(v,items[i].abstract));if(a(i).includes(f)&&f){x.e=f;n++;}}
 // 残篇摘要（开头或结尾被截断）里模型引文常常对不上原文窗口；这一步只为定位，退回摘要自身的原文窗口。
 for(const [x,i] of need){if(typeof x.e==='string'&&nz(x.e)&&a(i).includes(nz(x.e)))continue;const w=a(i).split(' ').slice(0,20).join(' ');if(w){x.e=w;n++;}}
 return n;
}
let pages=0;
while(pages<MAXP){
 const done=prefix(t.output,data);if(done.length>=data.length)break;
 const items=data.slice(done.length,done.length+PAGE);
 const user=JSON.stringify(items.map(p=>({id:p.id,title:p.title,journal:p.journal,abstract:p.abstract||'(无摘要)'})));
 if(DRY){console.log(JSON.stringify({system_chars:SYSTEM.length,page_items:items.length,user_chars:user.length}));break;}
 const messages=[{role:'system',content:SYSTEM},{role:'user',content:user}];
 let ok=false,lastErr='';
 for(let attempt=0;attempt<2&&!ok;attempt++){
  let reply;try{reply=await ask(messages);}catch(e){lastErr=e.message;break;}
  let recs;try{recs=JSON.parse(reply).records;if(!Array.isArray(recs))throw Error('records 不是数组');
    // 模型偶尔整页不写 id（顺序仍与输入一致）：按位置补上输入 id，仍逐条与输入对齐。
    if(recs.length===items.length&&recs.every(x=>x&&typeof x==='object'&&x.id===undefined))recs.forEach((x,i)=>{x.id=items[i].id;});
    if(recs.length!==items.length||recs.some((x,i)=>x.id!==items[i].id))throw Error('records 数量或 id 顺序与输入不符');}
  catch(e){lastErr=e.message;fs.writeFileSync(local('.runtime/api-screen-last-reject.txt'),String(reply||''));messages.push({role:'assistant',content:reply},{role:'user',content:'输出不合格：'+lastErr+'。请重新输出完整的 {"records":[...]}。'});continue;}
  recs.forEach((x,i)=>{if(x.e!==undefined)x.e=fixEvidence(x.e,items[i].abstract);
   // 模型偶尔把完整字段（basis/scope/source_status）也写出来；basis 存在会让 reader-work 跳过短字段展开，整页被拒。
   for(const k of ['basis','scope','source_status'])delete x[k];
   // 摘要有开头被上游索引截断的条目（OpenAlex 只存了尾部），读者会自行标 suspect-incomplete/synopsis；source_status 记的是“读的是存储文本”，有摘要即 full-abstract，只有真没摘要才由读者标 missing。
   if(x.d!=='p'&&String(items[i].abstract||'').trim())delete x.ss;});
  try{const filled=await fillEvidence(recs,items);if(filled)console.error('补引文 '+filled+' 条');}catch(e){console.error('补引文失败：'+e.message);}
  fs.writeFileSync(local(t.chunk_file),JSON.stringify(recs));
  // 沙箱里子进程不能用管道捕获输出（EPERM），改用文件描述符接 stderr；退出码仍会抛出。
  const logFd=fs.openSync(local(t.chunk_file.replace(/\.json$/,'')+'.append.log'),'w');
  try{execFileSync(process.execPath,[worker,'append',taskPath,t.chunk_file],{stdio:['ignore',logFd,logFd]});ok=true;}
  catch(e){lastErr=String(fs.readFileSync(local(t.chunk_file.replace(/\.json$/,'')+'.append.log'),'utf8')||e.message);
   messages.push({role:'assistant',content:reply},{role:'user',content:'程序拒收，原因如下，请按原因修改后重新输出完整的 {"records":[...]}（不要为迎合程序改判断标准）：\n'+lastErr.slice(0,3000)});}
  finally{fs.closeSync(logFd);}
 }
 if(!ok){console.error('页失败，已保存前缀保留：'+lastErr.slice(0,800));break;}
 pages++;
}
const cny=(usage.miss*2+usage.hit*0.2+usage.out*3)/1e6;
const now=prefix(t.output,data);
console.log(JSON.stringify({task:taskPath,saved:now.length,total:data.length,complete:now.length===data.length,pages,usage,est_cny_at_assumed_prices:+cny.toFixed(3)}));
