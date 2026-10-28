// Program-owned authority and provenance for autonomous project work. Not an OS/tool sandbox.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read} from '../automation/files.mjs';

export const eventHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const localKinds=new Set(['data','literature','mail','framework','presentation']);
const positive=(value,name)=>{
  if(!Number.isInteger(value) || value<1)throw new Error('自主配置 '+name+' 必须为正整数');
  return value;
};
export function autonomyPolicy() {
  const raw=read('automation/config.json').autonomy;
  if(!raw)return {level:0}; // Old copies do not silently gain authority.
  if(!Number.isInteger(raw.level) || raw.level<0 || raw.level>4)throw new Error('自主等级必须为 0～4');
  const depth=raw.max_chain_depth?.[raw.level] ?? 0;
  if(!Number.isInteger(depth) || depth<0)throw new Error('自主链深必须为非负整数');
  if(!Number.isInteger(raw.debounce_seconds) || raw.debounce_seconds<0)throw new Error('自主防抖秒数必须为非负整数');
  return {level:raw.level,max_chain_depth:depth,debounce_seconds:raw.debounce_seconds,
    per_project_running:positive(raw.per_project_running,'per_project_running'),
    per_project_pending:positive(raw.per_project_pending,'per_project_pending'),daily_runs:positive(raw.daily_runs,'daily_runs')};
}
export function taskContext(items) {
  if(!process.env.OFFICE_MEMORY_RUN_DIR)return null;
  const rel=path.relative(path.join(root,'.runtime/agent/runs'),path.resolve(process.env.OFFICE_MEMORY_RUN_DIR));
  if(rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel))throw new Error('无法核对当前助手任务的来源');
  const item=items.find(i=>i.id===rel.split(path.sep)[0]);
  if(!item || item.status!=='active')throw new Error('当前助手任务不在执行中，不能派生自主步骤');
  if(item.operation_id) {
    const operation=items.find(i=>i.id===item.operation_id);
    return {...item,autonomy:operation.autonomy};
  }
  return item;
}
// Source is the actual active native parent and its saved conversation, not a CLI flag.
// An autonomous task does not become user-directed merely by having a session.
export function directChatTask(item) {
  if(item.operation_id || item.autonomy || !['codex','claude','deepseek'].includes(item.executor))return false;
  return read('.runtime/agent/sessions.json',{sessions:[]}).sessions.some(s=>s.origin==='chat' && s.task_ids.includes(item.id) &&
    s.messages.some(m=>m.role==='user' && m.task_id===item.id && !m.inbox_reply));
}
// Continuation admission depends on the actual running, authorized project step.
// The agent owns the new node's content, filing and dependency structure.
export function authorizedProjectStep(parent) {
  return !!parent && parent.status==='active' && (!parent.executor || !!parent.operation_id) && !parent.deleted_at &&
    parent.project_ids?.length>0 && ['codex','claude','deepseek'].includes(parent.actor) &&
    (!parent.autonomy || (parent.autonomy.type==='step' && !!parent.autonomy.approved_at));
}
export function autonomousChild(request,item,items) {
  if(item.project_ids.length!==1)throw new Error('自主步骤须归属一个明确项目');
  const parent=taskContext(items),ancestor=parent?.autonomy;
  if(ancestor && !parent.project_ids.includes(item.project_ids[0]))throw new Error('自主步骤不能扩展到来源项目以外');
  const sources=item.sources;
  if(!sources.length || !sources.every(s=>s.trim()) || !String(request.decision || '').trim() || !String(request.deliverable || '').trim())
    throw new Error('自主步骤须写 sources（来源）、decision（会改变的决定）、deliverable（交付物）');
  return {type:'step',parent_id:parent?.id || null,root_id:ancestor?.root_id || parent?.id || item.id,
    event_hash:ancestor?.event_hash || eventHash(['instruction',parent?.id || item.id,sources]),
    depth:ancestor ? ancestor.depth+1 : 1,created_at:item.created_at,
    decision:String(request.decision).trim(),deliverable:String(request.deliverable).trim()};
}
export function assertAutonomousState(item,items,{previous,userApproved=false}={}) {
  const a=item.autonomy;
  if(!a || a.approved_at || userApproved)return;
  // Executors may finish their already admitted run, even if authority was lowered meanwhile.
  if(previous?.status==='active' && ['done','failed','cancelled','waiting_user'].includes(item.status))return;
  const policy=autonomyPolicy();
  if(!previous) {
    if(policy.level<1)throw new Error('自主规划已关闭（L0）');
    const pending=items.filter(i=>i.autonomy && !i.autonomy.approved_at && i.autonomy.type==='step' &&
      !i.deleted_at && ['open','queued','active'].includes(i.status) && i.project_ids.includes(item.project_ids[0])).length;
    if(a.type==='step' && pending>=policy.per_project_pending)throw new Error('本项目自主步骤已达待处理上限');
  }
  if(item.status==='open' || ['cancelled','failed','waiting_user'].includes(item.status))return;
  if(item.actor==='user' || !localKinds.has(item.kind))throw new Error('用户实验及非 A 档提议不可自主启动；请保留 open');
  if(a.type==='plan') {
    if(policy.level<1)throw new Error('自主规划已关闭（L0）');
  } else if(policy.level<2 || a.depth>policy.max_chain_depth)throw new Error('当前自主等级或链深不允许排队；请保留 open');
  if(item.status==='done' && previous?.status!=='active')throw new Error('自主步骤须经实际执行后才能完成');
}
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:read('weekly/config.json').timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export function autonomyHoldReason(item,items,now=Date.now()) {
  if(!item.autonomy || item.autonomy.approved_at)return null;
  try {
    assertAutonomousState(item,items,{previous:item});
    const policy=autonomyPolicy(),today=day(now);
    const running=items.filter(i=>i.id!==item.id && i.autonomy && !i.autonomy.approved_at && i.status==='active' && i.project_ids.some(p=>item.project_ids.includes(p)));
    const used=items.filter(i=>i.autonomy?.started_at && day(i.autonomy.started_at)===today).length;
    if(running.length>=policy.per_project_running)return '等待本项目正在执行的自主步骤结束';
    if(!item.autonomy.started_at && used>=policy.daily_runs)return '今日自主执行额度已用完，等待下一本地日或用户调整上限';
    return null;
  } catch(error) {return error.message;}
}
export const autonomousCanStart=(item,items,now)=>autonomyHoldReason(item,items,now)===null;
// Only actual user-owned project steps can supply a fresh real-world event. Chat turns cannot.
export function progressEvent(item,previous,now) {
  if(!['done','failed'].includes(item.status) || item.actor!=='user' || item.executor || !item.project_ids?.length ||
    (item.kind!=='experiment' && !item.plan_node_id))return null;
  if(item.status==='failed') {
    // Failure is itself a result; unlike completion it need not have data files.
    // An unchanged historical failure is not a new event and is never backfilled.
    if(previous.status==='failed' && previous.handoff===item.handoff &&
      JSON.stringify(previous.outputs)===JSON.stringify(item.outputs))return previous.progress_event || null;
    return {id:eventHash([item.id,'failed',now,item.outputs,item.handoff]),at:now};
  }
  if(!item.outputs.length && !item.handoff.trim())return null;
  if(previous.status==='done' && previous.completed_at===item.completed_at &&
    previous.handoff===item.handoff && JSON.stringify(previous.outputs)===JSON.stringify(item.outputs))return previous.progress_event || null;
  const id=eventHash([item.id,item.completed_at,item.outputs,item.handoff]);
  if(previous.progress_event?.id===id)return previous.progress_event;
  return {id,at:now};
}
