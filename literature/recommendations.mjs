// Permanent daily selections, not a user-interest/like label and not a derived RAG index.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from '../automation/files.mjs';
export const recommendationDir=path.join(root,'literature/recommendations');
export const localDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function validDay(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw new Error('需要有效的 YYYY-MM-DD 日期');
  return value;
}
export const recommendationDays=()=>fs.existsSync(recommendationDir)?fs.readdirSync(recommendationDir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(0,10)).sort().reverse():[];
export function recommendationDay(date=localDay()) {
  validDay(date);const file=path.join(recommendationDir,date+'.json');
  return fs.existsSync(file)?{...JSON.parse(fs.readFileSync(file,'utf8')),published:true}:{date,items:[],note:'这一天尚未发布推荐。',published:false};
}
export function validateRecommendations(value) {
  const date=validDay(value.date || localDay());
  if(!Array.isArray(value.items))throw new Error('items 必须是数组；没有合适文章时可为空');
  const seen=new Set();const items=value.items.map(p=>{
    const doi=String(p.doi || '').trim().replace(/^https?:\/\/doi\.org\//i,'').toLowerCase();
    if(!/^10\.\d{4,9}\/\S+$/.test(doi) || seen.has(doi))throw new Error('推荐 DOI 无效或重复');seen.add(doi);
    if(!String(p.reason || '').trim())throw new Error('每篇需写推荐理由');
    if(!['abstract','fulltext'].includes(p.basis))throw new Error('basis 须说明已读摘要或全文，不能只凭题名推荐');
    const item={doi,reason:String(p.reason).trim(),basis:p.basis};
    for(const k of ['question','evidence','inspiration','reach'])if(p[k])item[k]=String(p[k]).trim();
    return item;
  });
  const note=String(value.note || '').trim();
  if(!items.length && !note)throw new Error('空推荐需说明原因');
  return {date,items,note};
}
export function prepareRecommendations(value) {
  const record=validateRecommendations(value),old=recommendationDay(record.date);
  if(old.published && JSON.stringify({date:old.date,items:old.items,note:old.note})===JSON.stringify(record))return {record,reused:{...old,reused:true}};
  if(old.published && value.replace!==true)throw new Error('这一天已有推荐；明确修订时传 replace:true，不静默覆盖');
  return {record};
}
export function saveRecommendations(value) {
  const {record,reused}=prepareRecommendations(value);if(reused)return reused;
  const result={...record,updated_at:new Date().toISOString(),source:value.source?String(value.source):null};
  fs.mkdirSync(recommendationDir,{recursive:true});const file=path.join(recommendationDir,record.date+'.json'),temp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n');fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
  return {...result,published:true};
}
