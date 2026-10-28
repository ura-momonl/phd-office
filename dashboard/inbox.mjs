import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, read, write } from '../automation/files.mjs';
import { update, validateOutcome } from '../work/run.mjs';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { closeTask, reopenTask, latestSourceAt } from '../mail-flow/flow.mjs';
import {readCard,cardActions,cardChain} from './cards.mjs';
import {mailOrigins} from './review.mjs';
import {calendarReminders,calendarData,dueIso,dueMs,REMIND_DAYS} from '../calendar/run.mjs';
const acknowledgmentFile='.runtime/inbox/acknowledged.json';
const mailDirectory=path.join(root,'.runtime/mail-flow');
const cardFile=id=>path.join(root,'.runtime/inbox/cards/mail-'+id+'.json');
const undoWindowMs=5*60000;
function acknowledgments() {
  return Object.fromEntries(Object.entries(read(acknowledgmentFile,{})).map(([id,value])=>[id,typeof value==='string' ? {fingerprint:value} : value]));
}
export function inboxItems(mail,work,links,now=new Date(),includeAcknowledged=false,sessions) {
  const ack=acknowledgments();
  const pending=work.filter(i=>!i.deleted_at && !i.merged_into && i.status!=='cancelled' && i.review?.state==='pending' && !readCard('work',i.id).resolved);
  // Keep one current question per explicit mail matter, not every historical turn's card.
  // A common project/session is not provenance. includeAcknowledged remains the close/undo view.
  const superseded=new Set(),latest=new Map();
  for(const i of pending) {
    const chain=cardChain('work:'+i.id,work);
    for(const ancestor of chain.slice(1))if(ancestor.startsWith('work:'))superseded.add(ancestor);
    const mailId=chain.find(id=>id.startsWith('mail:'));
    if(!mailId)continue;
    // The matter was closed (by the user or by an agent's resolved card): its leftover questions are history, whichever conversation raised them.
    // 'done' is final (a genuinely new request gets its own task), so nothing under it can still be a live question.
    if(mail.find(t=>'mail:'+t.id===mailId)?.status==='done') {superseded.add('work:'+i.id);continue;}
    const prior=latest.get(mailId);
    if(!prior || String(i.updated_at || i.created_at || '')>=String(prior.updated_at || prior.created_at || '')) {
      if(prior)superseded.add('work:'+prior.id);
      latest.set(mailId,i);
    } else superseded.add('work:'+i.id);
  }
  for(const [mailId,i] of latest) {
    const newest=latestSourceAt(mailDirectory,mailId.slice(5)),answeredAt=Date.parse(i.updated_at || i.created_at);
    // A later incoming mail can raise a fresh question; do not hide it under an old card.
    if(!newest || (Number.isFinite(answeredAt) && Date.parse(newest)<=answeredAt))superseded.add(mailId);
    // And that old approval/decision no longer describes the matter: the live mail card carries the task's current action. An acceptance card is about a
    // delivered file, not the thread, and a task that is not a todo has no live card to replace it, so those stay.
    else if(i.review?.kind!=='acceptance' && mail.find(t=>'mail:'+t.id===mailId)?.status==='todo')superseded.add('work:'+i.id);
  }
  const replies=(sessions ?? read('.runtime/agent/sessions.json',{sessions:[]}).sessions).flatMap(s=>s.messages.filter(m=>m.inbox_reply && work.some(w=>w.id===m.task_id && !['cancelled','failed'].includes(w.status))).map(m=>m.inbox_reply));
  // Execution state is not a question for the user. Only a pending review raises a work card;
  // merged inputs belong to their primary turn, not independent matters. Errors stay in work/session history.
  // Most work records are historical chat turns, not inbox candidates. Decide
  // eligibility before touching disk; only current/reviewed cards need a lookup.
  const items=[...work.filter(i=>!i.deleted_at && !i.merged_into && i.status!=='cancelled' && (i.review?.state==='pending' || (includeAcknowledged && ack['work:'+i.id] && i.review?.state==='accepted')) && !readCard('work',i.id).resolved).map(i=>({
    id:'work:'+i.id,source:'work',source_id:i.id,title:i.title,detail:i.handoff || i.goal,
    kind:i.review?.kind || 'decision',task_kind:i.kind,status:i.status,reason:i.review?.reason || '',estimated_minutes:i.review?.estimated_minutes || null,
    project_ids:i.project_ids,actor:i.actor,due_at:i.due_at,outputs:i.outputs||[],created_at:i.updated_at || i.created_at})),
    ...mail.filter(i=>i.status==='todo' || (includeAcknowledged && i.status==='done' && ack['mail:'+i.id])).map(i=>({id:'mail:'+i.id,source:'mail',source_id:i.id,title:i.title,
      detail:i.action,kind:'decision',project_ids:links.find(l=>l.module==='mail' && l.item_id===i.id)?.project_ids || [],due_at:dueIso(i.deadline),outputs:[]})),
    // Dates coming due that no card already carries (a todo mail task is its own card): computed from the sources each time, never stored.
    ...calendarReminders(calendarData(mail,work,links),now),
    // A proposed project link is a one-click question; the answer is applied by the projects module, not by the agent.
    ...links.filter(l=>l.module==='mail' && l.status==='proposed').flatMap(l=>{
      const task=mail.find(t=>t.id===l.item_id);if(!task || task.status==='done')return [];
      const project=read('projects/catalog.json').projects.find(p=>p.id===l.project_ids[0]);
      return [{id:'link:mail:'+l.item_id,source:'link',source_id:l.item_id,title:'归属确认：'+task.title,category:'归属',kind:'decision',
        detail:'建议归入「'+(project?.name || l.project_ids[0])+'」。依据：'+(l.basis || '无'),project_ids:l.project_ids,due_at:null,outputs:[],
        actions:[{id:'confirm',type:'link',label:'确认归入',decision:'confirm'},{id:'decline',type:'link',label:'不是这个项目',decision:'decline'}]}];
    })];
  const origins=mailOrigins(items);
  return items.map((i,n)=>{
    // A mail card saved before the newest mail of its thread arrived describes a state that no longer holds; the task's own action is current, so show that.
    const savedAt=i.source==='mail' && fs.existsSync(cardFile(i.source_id)) ? fs.statSync(cardFile(i.source_id)).mtimeMs : 0,newest=savedAt && latestSourceAt(mailDirectory,i.source_id);
    const card=newest && Date.parse(newest)>savedAt ? {} : readCard(i.source,i.source_id);
    const original=work.find(w=>w.id===i.source_id);
    const actions=cardActions({...i,actions:original?.review?.actions || i.actions},card);
    const signature=[i.title,i.detail,i.due_at,i.outputs];if(Object.keys(card).length)signature.push(card);
    const fingerprint=createHash('sha256').update(JSON.stringify(signature)).digest('hex');
    // A reply hides the card it answered under this key instead: the answering agent rewrites the item's own text (handoff), which must not bring the card back.
    const replySignature=[i.title,i.due_at,i.outputs,card];if(i.source==='mail')replySignature.push(i.detail); // A mail action update is a new question, unlike a rewritten work handoff.
    const key=createHash('sha256').update(JSON.stringify(replySignature)).digest('hex');
    const due=dueMs(i.due_at);
    const priority=Number.isFinite(due) && due<now.getTime()+86400000 ? 'urgent' : Number.isFinite(due) && due<now.getTime()+REMIND_DAYS*86400000 ? 'high' : 'normal';
    const category=card.category || i.category || (i.source==='mail' ? '邮件' : ({mail:'邮件',procurement:'采购',data:'数据',literature:'文献',cad:'设计',presentation:'汇报',experiment:'实验',framework:'流程'})[i.task_kind] || '事项');
    return {...i,kind:['approval','acceptance','decision'].includes(card.kind) ? card.kind : i.kind,title:card.title || i.title,detail:card.message || i.detail,reason:card.reason || i.reason,category,actions,fingerprint,key,priority,mail_links:origins[n].links};
  }).filter(i=>includeAcknowledged || (!superseded.has(i.id) && ack[i.id]?.fingerprint!==i.fingerprint && !replies.some(r=>r.id===i.id && (r.fingerprint===i.fingerprint || r.key===i.key)))).sort((a,b)=>({urgent:0,high:1,normal:2}[a.priority]-{urgent:0,high:1,normal:2}[b.priority]) || (Date.parse(a.due_at)||Infinity)-(Date.parse(b.due_at)||Infinity));
}
export function acknowledgeInbox(item) {
  if(!item)throw new Error('事项已更新，请刷新收件箱');
  const at=new Date().toISOString();let previousReview=null,acceptedAt=null,previousStatus=null;
  if(item.source==='mail')previousStatus=closeTask(mailDirectory,item.source_id);
  if(item.source==='work') {
    const work=read('work/queue.json').items.find(i=>i.id===item.source_id);
    previousReview=work.review || {};acceptedAt=at;
    // Accepting the card is also the answer the step was waiting for: one action settles both the review and the status, so no step stays "等你" behind an accepted card.
    // A step that cannot be marked done as it stands (an output it still owes) keeps its status; the card is accepted either way.
    const closes=work.status==='waiting_user' && (()=>{try {validateOutcome({...work,status:'done'});return true;} catch {return false;}})();
    if(closes)previousStatus=work.status;
    update({id:work.id,review:{...work.review,state:'accepted',accepted_at:at},...(closes ? {status:'done'} : {})});
  }
  const ack=acknowledgments();ack[item.id]={fingerprint:item.fingerprint,title:item.title,kind:item.kind,task_kind:item.task_kind || 'misc',
    source:item.source,source_id:item.source_id,at,previous_review:previousReview,previous_status:previousStatus,accepted_at:acceptedAt};write(acknowledgmentFile,ack);
  return {id:item.id,acknowledged:true};
}
// An agent that has fully dealt with a card it raised (its own card says resolved) closes that card. This is the user's "已处理" step run by the
// program, so it is recorded the same way and can be undone. Closing an approval card only withdraws the question (the user dealt with it themselves);
// it grants nothing. A card already settled is left alone.
export function resolveInbox(id,now=new Date()) {
  const [source,...rest]=id.split(':'),sourceId=rest.join(':'),file=path.join(mailDirectory,'mail.sqlite'),work=read('work/queue.json').items;
  let mail=[];
  if(source==='mail' && fs.existsSync(file)) {
    const db=new DatabaseSync(file,{readOnly:true});
    try {mail=db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks WHERE id=?').all(sourceId);} finally {db.close();}
  }
  // includeAcknowledged: a card the user already answered by reply is hidden from the list but is exactly the one to close.
  const item=inboxItems(mail,work,[],now,true).find(i=>i.id===id);
  const open=item && (source==='mail' ? mail[0]?.status==='todo' : work.find(w=>w.id===sourceId)?.review?.state==='pending');
  if(!open)return null;
  return acknowledgeInbox(item);
}
export function inboxActivity(now=new Date()) {
  const records=Object.entries(acknowledgments()).filter(([,r])=>r.at).map(([id,r])=>({id,title:r.title,kind:r.kind,task_kind:r.task_kind,at:r.at,
    undo_until:new Date(Date.parse(r.at)+undoWindowMs).toISOString()})).sort((a,b)=>b.at.localeCompare(a.at));
  return {recent:records.slice(0,8),undoable:records.filter(r=>Date.parse(r.undo_until)>now.getTime()),
    accepted:records.filter(r=>r.kind==='acceptance').map(r=>({title:r.title,task_kind:r.task_kind,at:r.at}))};
}
export function undoAcknowledgment(id,mail,work,links,now=new Date()) {
  const ack=acknowledgments(),record=ack[id];if(!record?.at || now.getTime()>Date.parse(record.at)+undoWindowMs)throw new Error('撤销窗口已结束');
  const current=inboxItems(mail,work,links,now,true).find(i=>i.id===id);
  if(!current || current.fingerprint!==record.fingerprint)throw new Error('事项已更新，请查看最新内容');
  if(record.source==='work') {
    const item=work.find(i=>i.id===record.source_id);
    if(item.review?.accepted_at!==record.accepted_at)throw new Error('验收记录已更新');
    update({id:item.id,review:record.previous_review,...(record.previous_status ? {status:record.previous_status,reason:'撤销验收'} : {})});
  }
  if(record.source==='mail' && record.previous_status)reopenTask(mailDirectory,record.source_id,record.previous_status);
  delete ack[id];write(acknowledgmentFile,ack);return {id,undone:true};
}
