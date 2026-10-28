import { read, write } from '../automation/files.mjs';
import { createHash } from 'node:crypto';

const ledgerFile='.runtime/remote/notifications.json';
const short=(value,n=160)=>String(value || '').replace(/\s+/g,' ').trim().slice(0,n);
export function notificationTypes(value='inbox') {
  const types=[...new Set(value.split(',').map(s=>s.trim()).filter(Boolean))];
  if(types.some(t=>!['tasks','inbox'].includes(t)))throw new Error('DISCORD_NOTIFY must be tasks,inbox, tasks, inbox, or empty');
  return types;
}
// Mirror actionable card options, never navigation, free-form compose or review links.
const options=item=>item.actions.filter(a=>['reply','accept'].includes(a.type)).slice(0,3);
export const inboxButtonId=(item,action)=>'inbox:'+createHash('sha256').update(JSON.stringify([item.id,item.fingerprint,action.id])).digest('hex');
export function inboxButtons(item) {
  const buttons=options(item).map((a,n)=>({type:2,style:n===0 ? 1 : 2,label:short(a.label,80),custom_id:inboxButtonId(item,a)}));
  return buttons.length ? [{type:1,components:buttons}] : [];
}
export function currentInboxAction(customId,items) {
  for(const item of items)for(const action of options(item))if(inboxButtonId(item,action)===customId)return {item,action};
  return null;
}
// Notifications carry titles and IDs, not mail bodies, raw handoffs, attachments or research data.
export function notificationEvents(state,types) {
  const tasks=state.work.items.filter(i=>!i.deleted_at && i.actor!=='user' && i.mode!=='card' && ['done','failed','waiting_user'].includes(i.status));
  const events=[];
  if(types.includes('tasks'))for(const i of tasks) {
    const card=types.includes('inbox') && state.inbox.find(c=>c.source==='work' && c.source_id===i.id);
    const at=i.history?.filter(h=>h.to===i.status).at(-1)?.at || i.completed_at || i.updated_at || i.created_at;
    events.push({id:'task:'+i.id,version:i.status+':'+at,...(card ? {coveredBy:'inbox:'+card.id} : {}),
      text:`${{done:i.review?.state==='pending' ? '任务完成，待验收' : '任务完成',failed:'任务失败',waiting_user:'任务需要你决定'}[i.status]}：${short(i.title)}\n任务 ID：${i.id}\n用 /handoff id:${i.id} 查看结果。`});
  }
  if(types.includes('inbox'))for(const i of state.inbox) {
    const kind={approval:'审批',acceptance:'验收',decision:'决定'}[i.kind] || '处理';
    const priority={urgent:'紧急',high:'优先',normal:'常规'}[i.priority] || '常规';
    const fields=[{name:'需要你',value:kind,inline:true},{name:'分类',value:short(i.category || ({mail:'邮件',calendar:'日历',work:'任务',project:'项目',link:'归属确认'})[i.source] || '事项',80),inline:true},
      {name:'优先级',value:priority,inline:true}];
    if(i.due_at)fields.push({name:'日期',value:short(i.due_at,80),inline:false});
    events.push({id:'inbox:'+i.id,version:i.fingerprint,components:inboxButtons(i),
      embed:{author:{name:'📥 科研办公室 · 收件箱'},title:short(i.title,240) || '新的待办事项',
        color:({urgent:0xDC5A5A,high:0xD49A32})[i.priority] || 0x10A37F,
        description:`${i.status==='done' ? '任务已完成，等待你'+kind+'。\n' : i.status==='failed' ? '任务未完成，需要你处理。\n' : ''}在工作台收件箱处理；用 \`/inbox\` 查看待办。`,
        fields,footer:{text:'事项 ID · '+short(i.id,160)}}});
  }
  return events;
}
export function baselineNotifications(state,types,scope) {
  const ledger=read(ledgerFile,null);
  if(ledger?.scope===scope)return;
  write(ledgerFile,{scope,records:Object.fromEntries(notificationEvents(state,types).map(e=>[e.id,{version:e.version,status:'baseline'}]))});
}
// The one bridge owns delivery. Persist BEFORE send: an uncertain external write is never retried automatically.
export async function notify(state,{types,send,ownerId,scope,signal}) {
  const events=notificationEvents(state,types);
  const ledger=read(ledgerFile,null);
  if(!ledger || ledger.scope!==scope)throw new Error('Initialise notification baseline before accepting commands');
  const results=[];
  for(const event of events) {
    if(signal?.aborted)break;
    // Inbox notifications announce new IDs only. Updates, reopened cards and restarts do not ping again.
    if(event.id.startsWith('inbox:') ? ledger.records[event.id] : ledger.records[event.id]?.version===event.version)continue;
    if(event.coveredBy) {
      ledger.records[event.id]={version:event.version,status:'covered'};write(ledgerFile,ledger);continue;
    }
    const record={version:event.version,status:'attempted',at:new Date().toISOString()};
    ledger.records[event.id]=record;write(ledgerFile,ledger);
    try {
      const message=await send({content:event.embed ? `<@${ownerId}> 📬 收件箱提醒` : `<@${ownerId}> ${event.text}`.slice(0,1900),
        ...(event.embed ? {embeds:[event.embed],components:event.components} : {}),allowedMentions:{parse:[],users:[ownerId]}});
      record.status='sent';record.message_id=message.id;
    } catch {record.status='failed';}
    write(ledgerFile,ledger);results.push({id:event.id,status:record.status});
  }
  return results;
}
