import fs from 'node:fs';
import {instrumentCatalog,saveInstrument} from './library.mjs';

const NOTE_FIELDS=['experience','cautions','reference_notes','control_notes'];
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
const brief=i=>({id:i.id,name:i.name,model:i.model,category:i.category,location:i.location,purpose:i.purpose.slice(0,100),has_notes:NOTE_FIELDS.some(f=>i[f])});
function find(query) {
  const items=instrumentCatalog().items;
  const exact=items.filter(i=>i.id===query);
  const hits=exact.length ? exact : items.filter(i=>i.name.toLowerCase().includes(String(query).toLowerCase()));
  if(hits.length!==1)throw new Error(hits.length ? `匹配到 ${hits.length} 台仪器，请用更具体的名称或 id：`+hits.map(i=>i.name).join('；') : '图鉴里没有这台仪器；list 查看已登记的');
  return hits[0];
}
// Appends one dated, sourced line to a notes field. Everything else on the card (code paths, projects, photo) is carried over unchanged.
export function addInstrumentNote({instrument,field='experience',text,source}) {
  if(!NOTE_FIELDS.includes(field))throw new Error('field 只能是 '+NOTE_FIELDS.join('、'));
  if(typeof text!=='string' || !text.trim())throw new Error('请填写要记录的内容');
  if(typeof source!=='string' || !source.trim())throw new Error('请注明来源（如“用户 2026-10-15 对话”）');
  const item=find(instrument),line=`- ${today()}（来源：${source.trim()}）：${text.trim()}`;
  const saved=saveInstrument({...item,[field]:item[field] ? item[field]+'\n'+line : line});
  return {id:saved.id,name:saved.name,field,added:line};
}
export async function run(action,argument) {
  if(action==='list'){console.log(JSON.stringify(instrumentCatalog().items.map(brief),null,2));return;}
  if(action==='show'){const {photo,...item}=find(argument);console.log(JSON.stringify({...item,has_photo:!!photo},null,2));return;}
  if(action==='note'){
    if(!argument)throw new Error('note <JSON文件路径>：{instrument, field?, text, source}');
    console.log(JSON.stringify(addInstrumentNote(JSON.parse(fs.readFileSync(argument,'utf8').replace(/^﻿/,''))),null,2));return;
  }
  throw new Error('Instruments actions: list, show <名称或id>, note <json文件>');
}
