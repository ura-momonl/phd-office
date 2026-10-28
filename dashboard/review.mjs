import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root,read } from '../automation/files.mjs';
import { compare } from '../procurement/run.mjs';
import {cardChain} from './cards.mjs';
const outlookLink=/https:\/\/outlook\.office365\.com\/owa\/\?ItemID=[^\s"\\)]+/g;
export function reviewDetails(source,id) {
  if(source==='work') {
    const item=read('work/queue.json').items.find(i=>i.id===id);if(!item)throw new Error('未知交付');
    const metadata=read(`.runtime/agent/runs/${item.id}/review.json`,item.review || {});
    // A review lists files; the browser requests a whole text file only when
    // opened. The registered-artifact route also works for runtime outputs.
    const previews=(item.outputs||[]).flatMap((p,index)=>/\.(txt|md|csv|json)$/i.test(p) && fs.existsSync(p)
      ? [{path:p,url:'/api/artifact?task='+encodeURIComponent(item.id)+'&index='+index}] : []);
    return {source,id,title:item.title,outcome:item.handoff,criteria:metadata.criteria || [],evidence:metadata.evidence || [],...mailOrigins([{source,source_id:id}])[0],
      limitations:metadata.limitations || [],outputs:item.outputs||[],previews};
  }
  if(source!=='mail')throw new Error('未知依据来源');
  const request=read('procurement/catalog.json').requests.find(r=>r.mail_task_id===id);
  if(request) {
    const data=compare(request.id);
    const messages=mailMessages(id);
    const fields={quoted_total:'报价总额',currency:'币种',shipping_included:'是否含运费',tax_included:'是否含税',lead_time:'交期',valid_until:'报价有效期',technical_match:'型号与技术条件'};
    return {source,id,title:request.title,criteria:request.specifications,evidence:data.comparison.map(v=>({field:`${v.name} · #${v.quote_number}`,
      extracted_value:v.quoted_total,unit:v.currency,source:{location:`已归档邮件：${v.name} 报价 #${v.quote_number}`,excerpt:'报价金额来自已记录邮件；原报价组成尚待核实。'},local_value:null,
      conditions:{status:v.comparable ? 'same' : 'unknown',note:v.missing.map(field=>fields[field] || field).join('、') || v.technical_match}})),limitations:[request.notes],outputs:[],previews:[],messages};
  }
  const db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'),{readOnly:true});
  try {
    const item=db.prepare('SELECT title,action,subjects,artifacts FROM tasks WHERE id=?').get(id);if(!item)throw new Error('未知事项');
    return {source,id,title:item.title,outcome:item.action,criteria:[],evidence:[],limitations:[],outputs:JSON.parse(item.artifacts),previews:[],subjects:JSON.parse(item.subjects),...originOf(db,id)};
  }finally{db.close();}
}
// The mail task a card is about: a mail card is the task itself, a link card names one, and a work card raised from a mail (or from another card)
// names its origin on a line "原事项：<卡片id>" in its goal.
function mailTaskOf(source,id,work) {
  if(source==='mail' || source==='link')return id;
  return cardChain(`${source}:${id}`,work).find(key=>key.startsWith('mail:'))?.slice(5) || '';
}
// What can be shown of the original mail behind each card: its stored messages and Outlook links. A mail item imported from the old board has no
// stored messages, only the link in its notes.
export function mailOrigins(cards) {
  const file=path.join(root,'.runtime/mail-flow/mail.sqlite');
  if(!fs.existsSync(file))return cards.map(()=>({messages:[],links:[]}));
  const work=read('work/queue.json').items,db=new DatabaseSync(file,{readOnly:true});
  try {return cards.map(c=>originOf(db,mailTaskOf(c.source,c.source_id,work)));} finally {db.close();}
}
function originOf(db,taskId) {
  if(!taskId)return {messages:[],links:[]};
  const messages=mailMessages(taskId,db),links=messages.filter(m=>/^https:\/\//.test(m.link || '')).map(m=>({subject:m.subject,url:m.link}));
  if(!links.length) {
    const task=db.prepare('SELECT subjects,legacy FROM tasks WHERE id=?').get(taskId);
    for(const url of new Set(task?.legacy?.match(outlookLink) || []))links.push({subject:JSON.parse(task.subjects)[0] || '',url});
  }
  return {messages,links};
}
// The mails behind a mail item, newest first, each with its link to the original in Outlook.
function mailMessages(id,db) {
  const own=!db;if(own)db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'),{readOnly:true});
  try {
    return db.prepare('SELECT m.data FROM sources s JOIN messages m ON m.id=s.id WHERE s.task_id=?').all(id).map(r=>JSON.parse(r.data))
      .sort((a,b)=>String(b.received).localeCompare(String(a.received))).map(m=>({sender:m.sender,recipients:m.recipients,received:m.received,folder:m.folder,subject:m.subject,link:m.link,text:m.text}));
  }finally{if(own)db.close();}
}
