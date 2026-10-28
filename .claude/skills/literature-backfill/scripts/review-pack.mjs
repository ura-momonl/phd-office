// 包合并后、提交前的内容复核工具：生成阅读包，并做块间一致性与库内先例比对。只读，不调模型、不写 catalog。
// 用法：node .agents/skills/literature-backfill/scripts/review-pack.mjs <package-id> [--round screen-r01] [--out <目录>]
// 输出（默认 output/literature-rebuild-20261021/coordinator/reviews/<包>/）：
//   inc-NN.txt     全部拟收（每份 20 条，含题名、理由、完整摘要）
//   exin-NN.txt    全部“相关但不收”（scope=in 的排除）
//   exout-abs.txt  scope=out 且 basis=abstract 的全部（题名排除的只列在 REPORT 里）
//   REPORT.md      块间统计、scope=out 理由自查、每条排除项在库内的近邻先例
import fs from 'node:fs';
import path from 'node:path';
import {local,read,norm} from './records.mjs';

const args=process.argv.slice(2),pkgId=args[0];
if(!pkgId)throw Error('Usage: review-pack.mjs <package-id> [--round screen-r01] [--out <dir>]');
const opt=(k,d)=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
const round=opt('--round','screen-r01');
const R='output/literature-rebuild-20261021';
const outDir=opt('--out',`${R}/coordinator/reviews/${pkgId}`);
const plan=read(`${R}/coordinator/reader-jobs/${pkgId}/${round}/plan.json`);

const rows=[];
plan.jobs.forEach((j,ci)=>{
 const input=read(j.input);
 const dec=fs.existsSync(local(j.output))?read(j.output):[];
 if(dec.length!==input.length)throw Error(`块 ${j.id} 只交付 ${dec.length}/${input.length}，先完成再复核`);
 input.forEach((p,i)=>rows.push({chunk:ci+1,src:p,rec:dec[i]}));
});

const fmt=({src,rec})=>[
 `### ${rec.id} | ${rec.decision} | scope=${rec.scope} | ${rec.type} | dir=${rec.direction}`,
 `T: ${src.title}`,`R: ${rec.reason}`,`G: ${rec.tags.join(', ')}  E: ${rec.evidence}`,`A: ${src.abstract||''}`,''].join('\n');
fs.mkdirSync(local(outDir),{recursive:true});
const write=(name,list)=>fs.writeFileSync(local(path.join(outDir,name)),list.map(fmt).join('\n'),'utf8');
const chunked=(prefix,list,per)=>{for(let i=0;i<list.length;i+=per)write(`${prefix}-${String(i/per+1).padStart(2,'0')}.txt`,list.slice(i,i+per));};

const inc=rows.filter(r=>r.rec.decision==='include');
const exIn=rows.filter(r=>r.rec.decision==='exclude'&&r.rec.scope==='in');
const exOutAbs=rows.filter(r=>r.rec.decision==='exclude'&&r.rec.scope==='out'&&r.rec.basis!=='obvious-title');
const exOutTitle=rows.filter(r=>r.rec.decision==='exclude'&&r.rec.scope==='out'&&r.rec.basis==='obvious-title');
const pending=rows.filter(r=>r.rec.decision==='pending');
chunked('inc',inc,20);chunked('exin',exIn,14);if(exOutAbs.length)write('exout-abs.txt',exOutAbs);

// 库内先例：按题名词的 IDF 加权重合度，找在库（active）里最像的几篇；已移出的也列出，标注状态。
const catalog=read('literature/catalog.json').papers;
const STOP=new Set('the of and in on for with by from to a an at as via using based into over under between through its their this that are is be or'.split(' '));
const tok=s=>[...new Set(norm(s).toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&!STOP.has(w)))];
const df=new Map();const ct=catalog.map(p=>{const t=tok(p.title);t.forEach(w=>df.set(w,(df.get(w)||0)+1));return t;});
const idf=w=>Math.log(catalog.length/(1+(df.get(w)||0)));
const nearest=(title,doi,k=3)=>{
 const t=tok(title),ts=new Set(t);const scored=[];
 catalog.forEach((p,i)=>{if(doi&&p.doi===doi)return;let s=0;for(const w of ct[i])if(ts.has(w))s+=idf(w);if(s>0)scored.push([s,p]);});
 return scored.sort((a,b)=>b[0]-a[0]).slice(0,k).map(([s,p])=>`${p.library_status==='active'?'在库':'已移出'}｜${p.source||''} ${p.year||''}｜${p.title}`);
};

// scope=out 的理由若在“论证不相关”，而题名/摘要里有明显的低维词，标出来重读（标准：相关性不写论证，一维/二维/纳米线/层状就算相关）。
const LOWD=/nanowire|nanotube|nanoribbon|\b(?:2D|1D|two-dimensional|one-dimensional)\b|monolayer|bilayer|atomically thin|van der Waals|layered|moir|graphene|quantum dot|nanosheet|thin film|edge state|surface state|纳米线|二维|一维|层状/i;
const ARGUE=/无实质关系|无直接关系|与低维|与二维|无关/;
const flagged=exOutAbs.filter(r=>ARGUE.test(r.rec.reason)&&LOWD.test(`${r.src.title} ${r.src.abstract||''}`));

const pct=(a,b)=>b?`${(100*a/b).toFixed(0)}%`:'-';
const perChunk=plan.jobs.map((_,ci)=>{
 const c=rows.filter(r=>r.chunk===ci+1);
 const n=f=>c.filter(f).length;
 return `| ${ci+1} | ${c.length} | ${n(r=>r.rec.decision==='include')} (${pct(n(r=>r.rec.decision==='include'),c.length)}) | ${n(r=>r.rec.decision==='exclude'&&r.rec.scope==='in')} | ${n(r=>r.rec.scope==='out'&&r.rec.basis!=='obvious-title')} | ${n(r=>r.rec.basis==='obvious-title')} |`;
});

const section=(title,list)=>list.length?[`## ${title}（${list.length}）`,...list.map(r=>`- **${r.rec.id}**（块${r.chunk}）${r.src.title}\n  理由：${r.rec.reason.slice(0,160)}\n  库内近邻：\n${nearest(r.src.title,r.src.doi).map(x=>'    - '+x).join('\n')}`),'']:[];
const md=[
 `# ${pkgId} 复核包`,'',
 `共 ${rows.length} 条：include ${inc.length}｜exclude scope=in ${exIn.length}｜scope=out 摘要判 ${exOutAbs.length}｜题名排除 ${exOutTitle.length}｜pending ${pending.length}`,'',
 '## 块间统计（块与块的口径是否一致）','','| 块 | 条数 | 收录 | 相关但不收 | scope=out（摘要） | 题名排除 |','| --- | --- | --- | --- | --- | --- |',...perChunk,'',
 '各块收录率或 scope=out 摘要判的条数差得多，先回头比较两块里同一类论文的判法，不要只在块内复核。','',
 ...(flagged.length?[`## scope=out 理由在论证不相关、但题名/摘要含低维词（${flagged.length}）：先重读这几条`,...flagged.map(r=>`- ${r.rec.id}｜${r.src.title}｜${r.rec.reason.slice(0,90)}`),'']:['## scope=out 理由自查：没有命中','']),
 ...section('scope=out 摘要判：每条的库内近邻（有近邻在库就对照其收录理由）',exOutAbs),
 ...section('相关但不收：每条的库内近邻',exIn),
].join('\n');
fs.writeFileSync(local(path.join(outDir,'REPORT.md')),md,'utf8');
console.log(JSON.stringify({out:outDir,total:rows.length,include:inc.length,exclude_in:exIn.length,out_abstract:exOutAbs.length,out_title:exOutTitle.length,pending:pending.length,flagged_out_reasons:flagged.map(r=>r.rec.id)},null,1));
