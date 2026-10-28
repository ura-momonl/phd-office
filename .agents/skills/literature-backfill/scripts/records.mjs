// Parent splits; children read/append their own files; parent merges. No models/network/catalog writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const local=p=>{const f=path.resolve(root,p);if(!f.toLowerCase().startsWith((path.resolve(root)+path.sep).toLowerCase()))throw Error('Path outside workspace');return f;};
const read=p=>JSON.parse(fs.readFileSync(local(p),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const norm=x=>String(x||'').replace(/\s+/g,' ').trim();
const loadTask=p=>{const t=read(p),data=read(t.input);if(sha(JSON.stringify(data))!==t.input_sha256)throw Error('Child input changed');return {t,data};};
// 一次列出该条记录的全部问题（不再遇错即停），并给出原因，便于一次改完。
const TYPES=['experiment','theory','computation','experiment-and-theory','review','method','perspective'];
function problems(d,p){
 const bad=[],dec=d?.decision;
 if(d?.id!==p.id)bad.push('id 与输入不符（应为 '+p.id+'）');
 if(!['include','exclude','pending'].includes(dec))bad.push('decision 须为 include|exclude|pending');
 // unknown 仅用于排除条目：题名阶段排除本来无从定体裁，读摘要后判 x 也可能体裁不明（如催化/热电器件），排除条目的 type 不进库。
 if(!TYPES.includes(d?.type)&&!(d?.type==='unknown'&&dec==='exclude'))bad.push('type 非法：'+d?.type);
 if(d?.doi&&d.doi!==p.doi)bad.push('DOI 与输入不符');
 const scopes={include:['in'],exclude:['in','out'],pending:['unclear']}[dec];
 if(scopes&&!scopes.includes(d.scope))bad.push('scope 对 '+dec+' 只能是 '+scopes.join('|'));
 if(!['abstract','obvious-title','insufficient-source'].includes(d?.basis))bad.push('basis 非法：'+d?.basis);
 if(!['full-abstract','synopsis','missing','suspect-incomplete'].includes(d?.source_status))bad.push('source_status 非法：'+d?.source_status);
 if(!d?.direction?.startsWith('new:'))bad.push('direction 须以 new: 开头');
 if(!norm(d?.reason))bad.push('reason 为空');
 if(!Array.isArray(d?.tags)||d.tags.length<2||d.tags.length>5||d.tags.some(x=>!norm(x)))bad.push('tags 须为 2–5 个非空标签');
 if(typeof d?.evidence!=='string')bad.push('evidence 须为字符串');
 if(/\ufffd|\?\?\?/.test(JSON.stringify(d)))bad.push('含乱码字符（U+FFFD 或 ???），检查输入编码');
 const ev=norm(d?.evidence),src=norm(d?.basis==='obvious-title'?p.title:p.abstract);
 if(ev&&!src.includes(ev))bad.push('evidence 不是'+(d.basis==='obvious-title'?'题名':'摘要')+'的原文连续片段');
 if(ev&&ev.split(/\s+/).length>20)bad.push('evidence 超过 20 词');
 if(d?.basis==='abstract'&&(!src||!ev))bad.push('basis=abstract 需要摘要和 evidence');
 if(!p.abstract&&d?.source_status!=='missing')bad.push('输入没有摘要，source_status 须为 missing');
 if(dec==='include'&&(d.basis!=='abstract'||d.source_status!=='full-abstract'))bad.push('include 须 basis=abstract 且 source_status=full-abstract');
 if(dec==='exclude'&&d.basis!=='obvious-title'&&d.source_status!=='full-abstract')bad.push('exclude 若非 obvious-title，须 source_status=full-abstract');
 return bad;
}
function validate(d,p){const bad=problems(d,p);if(bad.length)throw Error(p.id+'：'+bad.join('；'));}
function prefix(file,input){
 const data=fs.existsSync(local(file))?read(file):[];
 if(!Array.isArray(data)||data.length>input.length)throw Error('Invalid result shape/count '+file);
 data.forEach((d,i)=>validate(d,input[i]));return data;
}
function save(file,value,expected){
 const f=local(file),now=fs.existsSync(f)?fs.readFileSync(f):null;
 if(expected===undefined){if(now)throw Error('Refusing existing file '+file);}
 else if((now===null)!==(expected===null)||(now&& !now.equals(expected)))throw Error('Concurrent output change '+file);
 fs.mkdirSync(path.dirname(f),{recursive:true});
 const temporary=f+'.next-'+process.pid;
 fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');fs.renameSync(temporary,f);
}

// 复核者每条回复只收 admit|keep 和非空理由；缺失或非法算格式错误，不替它补成“建议改收”。
function flipFlagProblem(f){
 if(!f||typeof f.id!=='string')return 'id 缺失';
 if(f.verdict!=='admit'&&f.verdict!=='keep')return 'verdict='+JSON.stringify(f.verdict)+'（只接受 admit 或 keep）';
 if(!norm(f.why))return 'why 为空';
 return null;
}

// 校验失败只打印原因一行，不打印源码行和堆栈。
process.on('uncaughtException',e=>{console.error('错误：'+e.message);process.exit(1);});
export {local,read,sha,norm,loadTask,validate,problems,prefix,save,flipFlagProblem};
