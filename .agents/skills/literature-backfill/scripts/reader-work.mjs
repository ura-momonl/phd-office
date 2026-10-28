import fs from 'node:fs';
import {local,read,sha,loadTask,validate,prefix,save} from './records.mjs';
const args=process.argv.slice(2),action=args[0],arg=args[1];
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
// Progressive disclosure: titles -> mark (title-level exclusions) -> read abstracts only for the rest.
// "-" as file argument reads UTF-8 JSON from stdin (heredoc), so readers need no temp-file round trip.
const input=f=>{if(f!=='-')return read(f);const raw=fs.readFileSync(0,'utf8').trim();
 try{if(/�|\?\?\?/.test(raw))throw 0;return JSON.parse(raw);}catch{throw Error('stdin 内容不是完整的 UTF-8 JSON（PowerShell 管道会把中文变成 ? 或破坏 JSON）。用文件工具把 JSON 写成文件，再把文件路径传给本命令（append 用该任务的 chunk_file）。');}};
// Compact reader record -> full record. Reader supplies only judgement fields; source-derived fields are filled here.
// d=i|x|p (include|exclude|pending) r=reason g=tags t=type e=evidence(abstract quote) s=scope(in|out, exclude only) dir=direction ss=source_status override
const DEC={i:'include',x:'exclude',p:'pending'};
const expand=(c,p)=>{
 if(!c||c.basis!==undefined||c.d===undefined)return c;
 const decision=DEC[c.d]||c.d,tags=c.g||c.tags,reason=c.r||c.reason,id=c.id;
 const hasAbs=!!String(p.abstract||'').trim(),ss=c.ss||(hasAbs?'full-abstract':'missing');
 const dir=String(c.dir||(Array.isArray(tags)?tags[0]:'')||'').replace(/^new:/,'');
 const base={id,decision,direction:'new:'+dir,reason,tags};
 if(decision==='exclude'&&ss!=='full-abstract'){
  const ev=String(p.title).replace(/\s+/g,' ').trim().split(' ').slice(0,20).join(' ');
  return {...base,type:'unknown',scope:c.s||'out',basis:'obvious-title',source_status:ss,evidence:ev};}
 if(!c.t)throw Error('compact record needs t (type) '+id);
 if(decision==='include')return {...base,type:c.t,scope:'in',basis:'abstract',source_status:ss,evidence:c.e};
 if(decision==='exclude'){if(!['in','out'].includes(c.s))throw Error('exclude with abstract needs s=in|out '+id);return {...base,type:c.t,scope:c.s,basis:'abstract',source_status:ss,evidence:c.e};}
 if(decision==='pending')return {...base,type:c.t,scope:'unclear',basis:'insufficient-source',source_status:ss,evidence:c.e||''};
 throw Error('compact record d must be i|x|p '+id);};
const needBrief=(t,arg)=>{if(!fs.existsSync(local(t.chunk_file.replace(/\.json$/,'')+'.briefed.json')))throw Error('先运行 node .agents/skills/literature-backfill/scripts/brief.mjs '+arg+' ：它一次给出阅读卡、唯一选文标准和第一个题名窗口，运行过才能记录这个任务的结果。');};
const GROUPS=['unrelated','energy','catalysis','battery','membrane','biomed'];
const stateFile=t=>t.chunk_file.replace(/\.json$/,'')+'.titles.json';
const loadState=t=>{const f=stateFile(t);return fs.existsSync(local(f))?read(f):{cursor:0,excluded:[]};};
const saveState=(t,st)=>{const f=local(stateFile(t));fs.writeFileSync(f+'.tmp',JSON.stringify(st,null,1)+'\n');fs.renameSync(f+'.tmp',f);};
const synth=(p,x)=>{const ev=String(p.title).replace(/\s+/g,' ').trim().split(' ').slice(0,20).join(' ');return {id:p.id,decision:'exclude',direction:'new:题名排除-'+x.group,type:'unknown',reason:'仅据题名排除（'+x.group+'）：'+x.note,tags:['题名排除',x.group],scope:'out',basis:'obvious-title',source_status:p.abstract?'full-abstract':'missing',evidence:ev};};
// Append synthesized records for title-excluded items sitting at the saved-prefix boundary.
const settle=(t,data,st)=>{let done=prefix(t.output,data);const ex=new Map(st.excluded.map(x=>[x.id,x]));const add=[];
 while(done.length+add.length<data.length&&ex.has(data[done.length+add.length].id)){const p=data[done.length+add.length];add.push(synth(p,ex.get(p.id)));}
 if(add.length){add.forEach((d,i)=>validate(d,data[done.length+i]));const bytes=fs.existsSync(local(t.output))?fs.readFileSync(local(t.output)):null;save(t.output,[...done,...add],bytes);done=[...done,...add];}
 return done;};
if(action==='titles'){
 const {t,data}=loadTask(arg);needBrief(t,arg);const st=loadState(t),done=settle(t,data,st);
 const start=Math.max(st.cursor,done.length),cap=Number(option('--cap',9000));const items=[];
 for(const p of data.slice(start)){const row={id:p.id,title:p.title,journal:p.journal};if(JSON.stringify({items:[...items,row]}).length+800>cap){if(!items.length)throw Error('Single title exceeds page '+p.id);break;}items.push(row);}
 console.log(JSON.stringify({task:arg,window_start:start,through:start+items.length,child_total:data.length,saved_prefix:done.length,complete:done.length===data.length,titles_complete:start>=data.length,items,instructions:'Judge titles only. List ids whose title clearly shows (a) a topic unrelated to low-dimensional/2D materials, or (b) main contribution in energy/catalysis/battery/membrane separation/biology/biomedical (use biomed for both biology and biomedical; groups: '+GROUPS.join('|')+'). Anything uncertain passes through to abstract reading. Write {"through":<through>,"excluded":[{"id":"..","group":"..","note":"short Chinese reason from the title"}]} to a file and run mark; then run read.'}));
}else if(action==='survivors'){
 // Progress of the title pass and which title-screened survivors still lack an abstract (the only ones worth a source lookup).
 const {t,data}=loadTask(arg),st=loadState(t),ex=new Set(st.excluded.map(x=>x.id));
 const screened=data.slice(0,Math.max(st.cursor,0)),survivors=screened.filter(p=>!ex.has(p.id));
 const needSource=survivors.filter(p=>!p.abstract).map(p=>p.id),unscreenedMissing=data.slice(st.cursor).filter(p=>!p.abstract).length;
 const out={task:arg,child_total:data.length,title_screened_through:st.cursor,title_excluded:ex.size,survivors:survivors.length,survivors_missing_abstract:needSource.length,unscreened_missing_abstract:unscreenedMissing,titles_complete:st.cursor>=data.length};
 const o=args.indexOf('--out');if(o>0){fs.writeFileSync(local(args[o+1]),JSON.stringify({...out,need_source_ids:needSource},null,1)+'\n');out.need_source_ids_file=args[o+1];}
 console.log(JSON.stringify(out));
}else if(action==='mark'){
 const {t,data}=loadTask(arg);needBrief(t,arg);const st=loadState(t),done=prefix(t.output,data),m=input(args[2]);
 const start=Math.max(st.cursor,done.length);
 if(!Number.isInteger(m.through)||m.through<=start||m.through>data.length)throw Error('through must be the window end returned by titles');
 const win=new Map(data.slice(start,m.through).map(p=>[p.id,p]));
 for(const x of m.excluded||[]){if(!win.has(x.id)||!GROUPS.includes(x.group)||!String(x.note||'').trim()||/\ufffd|\?\?\?/.test(x.note))throw Error('Invalid title exclusion '+x.id);}
 if(new Set((m.excluded||[]).map(x=>x.id)).size!==(m.excluded||[]).length)throw Error('Duplicate title exclusion');
 st.cursor=m.through;st.excluded.push(...(m.excluded||[]).map(({id,group,note})=>({id,group,note})));saveState(t,st);
 const gone=new Set((m.excluded||[]).map(x=>x.id));
 console.log(JSON.stringify({marked_through:m.through,title_excluded:gone.size,abstracts_to_read_in_window:data.slice(start,m.through).filter(p=>!gone.has(p.id)).length,next:'run read to get abstracts of the remaining items'}));
}else if(action==='read'){
 const {t,data}=loadTask(arg);needBrief(t,arg);const st=loadState(t),done=settle(t,data,st);
 const from=Number(option('--from',done.length));if(!Number.isInteger(from)||from<0||from>data.length)throw Error('Invalid offset');
 const cap=12000,items=[];
 const ex=new Set(st.excluded.map(x=>x.id)),limit=st.cursor>from?st.cursor:data.length;
 for(const p of data.slice(from,limit)){
  if(ex.has(p.id))continue;
  const row={id:p.id,doi:p.doi,title:p.title,journal:p.journal,date:p.date,abstract:p.abstract,abstract_from:p.abstract_from,abstract_url:p.abstract_url};
  if(JSON.stringify({items:[...items,row]}).length+1000>cap){if(!items.length)throw Error('Single record exceeds bounded page; read that full record separately, do not truncate or classify unseen text: '+p.id);break;}items.push(row);
 }
 const result={task:arg,offset:from,next_offset:from+items.length,child_total:data.length,saved_prefix:done.length,complete:done.length===data.length,items,title_window_end:st.cursor,title_excluded_total:st.excluded.length,instructions:'Each returned abstract is complete stored source text. Judge every returned item (title-excluded ones are already filled in by the program), write the task chunk_file with only the returned items in order, then append. When items is empty and complete is false, run titles for the next window.'};
 if(JSON.stringify(result).length>cap)throw Error('Output budget exceeded; no truncated text emitted');console.log(JSON.stringify(result));
}else if(action==='append'){
 const {t,data}=loadTask(arg),file=args[2];needBrief(t,arg);if(!file||(file!=='-'&&local(file)!==local(t.chunk_file)))throw Error('Use - (stdin) or this child task unique chunk_file');
 const st=loadState(t),ex=new Map(st.excluded.map(x=>[x.id,x]));const bytes=fs.existsSync(local(t.output))?fs.readFileSync(local(t.output)):null,done=prefix(t.output,data),chunk=input(file);
 if(!Array.isArray(chunk)||!chunk.length)throw Error('Invalid append size');
 const merged=[...done],errs=[];let ci=0;
 while(ci<chunk.length||(merged.length<data.length&&ex.has(data[merged.length].id))){
  if(merged.length>=data.length)throw Error('Invalid append size');const p=data[merged.length];
  if(ex.has(p.id)){const d=synth(p,ex.get(p.id));validate(d,p);merged.push(d);}else{if(ci>=chunk.length)break;try{const d=expand(chunk[ci],p);validate(d,p);merged.push(d);}catch(e){errs.push('第'+(ci+1)+'条 '+e.message);merged.push(null);}ci++;}
 }
 if(errs.length)throw Error(errs.length+' 条有问题，整批未保存：\n'+errs.slice(0,20).join('\n'));
 save(t.output,merged,bytes);
 console.log(JSON.stringify({saved:merged.length,remaining:data.length-merged.length,complete:merged.length===data.length,output:t.output}));
}else if(action==='merge'){
 const plan=read(arg),pkg=read(plan.package_manifest),all=read(pkg.input),updates=new Map();
 if(sha(JSON.stringify(all))!==pkg.input_sha256)throw Error('Package input changed');
 const originals=new Map(all.map(p=>[p.id,p]));
 for(const job of plan.jobs){const {t,data}=loadTask(job.task_file);for(const d of prefix(t.output,data)){if(updates.has(d.id)||!originals.has(d.id))throw Error('Duplicate or foreign child ID');validate(d,originals.get(d.id));updates.set(d.id,d);}}
 const merged=[];
 if(plan.mode==='review'){
  const reviewed=all.filter(p=>updates.has(p.id)).map(p=>updates.get(p.id));
  if(!args.includes('--dry-run')){
   const bytes=fs.existsSync(local(plan.audit_output))?fs.readFileSync(local(plan.audit_output)):null,previous=bytes?JSON.parse(bytes):[];
   if(!Array.isArray(previous)||new Set(previous.map(d=>d.id)).size!==previous.length||previous.some(d=>!updates.has(d.id)||JSON.stringify(updates.get(d.id))!==JSON.stringify(d)))throw Error('Review conflict or shrink; existing review preserved');
   save(plan.audit_output,reviewed,bytes);
  }
  const total=plan.review_ids?.length||all.length;
  console.log(JSON.stringify({mode:'review',reviewed:reviewed.length,total,complete:reviewed.length===total,output:plan.audit_output,original_outputs_changed:false}));process.exit(0);
 }
 for(const w of pkg.work_items){
  const input=read(w.input).slice(w.start_index-1,w.end_index),bytes=fs.existsSync(local(w.output))?fs.readFileSync(local(w.output)):null,done=prefix(w.output,input);
  for(const d of done){if(updates.has(d.id)&&JSON.stringify(updates.get(d.id))!==JSON.stringify(d))throw Error('Existing result conflict '+d.id);}
  const next=[...done];while(next.length<input.length&&updates.has(input[next.length].id))next.push(updates.get(input[next.length].id));
  if(next.length>done.length)merged.push({output:w.output,bytes,decisions:next,added:next.length-done.length});
 }
 if(!args.includes('--dry-run'))for(const m of merged)save(m.output,m.decisions,m.bytes);
 console.log(JSON.stringify({mode:'screen',dry_run:args.includes('--dry-run'),child_decisions:updates.size,merged_contiguous_records:merged.reduce((n,x)=>n+x.added,0),outputs:merged.map(({output,added})=>({output,added})),note:'Mechanical merge only, not scientific acceptance or catalog admission. Out-of-order partial child results stay in their files until earlier gaps are completed.'}));
}else throw Error('Use titles TASK, mark TASK FILE, survivors TASK [--out FILE], read TASK, append TASK CHUNK_FILE, or merge PLAN. Splitting moved to .agents/skills/literature-dispatch/scripts/dispatch.mjs ROLE.');
