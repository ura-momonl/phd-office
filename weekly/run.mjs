import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { root, read, write, input } from '../automation/files.mjs';
import { enqueue, update, isChatTurn } from '../work/run.mjs';
import { taskContext, directChatTask } from '../work/autonomy.mjs';
import { usageSnapshot } from '../usage/run.mjs';
import { usageGroups, purposeOf, purposes } from '../usage/metrics.mjs';
import { readFramework, frameworkNode, frameworkDigest } from '../projects/framework.mjs';
import { calendarData, calendarItems, ledgerTime, parseWhen } from '../calendar/run.mjs';

// Who owns what. Stored per week in .runtime/weekly/<Monday>/; written by user edits, an explicitly requested assistant proposal, or opening a week:
//   plan.json    the week's goals (intents), edited one by one by id; carried over once when the week is first opened
//   review.json  the user's own summary, next-week adjustments and which research records they chose to include
// Everything else (open work, what happened that week, research-log candidates, exports) is computed from its owner on request and never stored,
// so refreshing can not overwrite anything the user wrote, and a finished week's report follows the records, not today's mood.

const shift=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const config=()=>read('weekly/config.json');
const isDone=t=>['done','cancelled'].includes(t.status);
export function weekWindow(now=new Date()) {
  const cfg=config();
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:cfg.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const today=`${parts.year}-${parts.month}-${parts.day}`;
  const day=new Date(today+'T12:00:00Z').getUTCDay();
  const start=shift(today,-((day+6)%7));
  return {start,end:shift(start,6),previous_start:shift(start,-7),previous_end:shift(start,-1),today,
    due:today>start || Number(parts.hour)*60+Number(parts.minute)>=cfg.hour*60+cfg.minute};
}
// Planning looks ahead on the Chicago weekend; actual-week views and Monday carry-over stay unchanged.
export function planningWeek(now=new Date()) {
  const w=weekWindow(now);
  return weekOf(w.today>=shift(w.start,5) ? shift(w.start,7) : w.start);
}
// Any week, addressed by its Monday.
export function weekOf(start) {
  const text=String(start);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text+'T12:00:00Z')) || shift(text,0)!==text || new Date(text+'T12:00:00Z').getUTCDay()!==1)throw new Error('周的起点必须是周一的日期（YYYY-MM-DD）');
  return {start:text,end:shift(text,6),previous_start:shift(text,-7),previous_end:shift(text,-1)};
}
export function weeklySources() {
  const catalog=read('projects/catalog.json');
  const queue=read('work/queue.json',{items:[]});
  let mail=[];const file=path.join(root,'.runtime/mail-flow/mail.sqlite');
  if(fs.existsSync(file)) {
    const db=new DatabaseSync(file,{readOnly:true});
    try {mail=db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks ORDER BY check_at').all();}finally{db.close();}
  }
  return {projects:catalog.projects.filter(p=>!p.archived_at),links:catalog.links,work:queue.items,mail};
}

// ---- the user's records -------------------------------------------------------------------------------------------------------------------
const planFile=start=>`.runtime/weekly/${start}/plan.json`,reviewFile=start=>`.runtime/weekly/${start}/review.json`;
const text=value=>String(value ?? '').trim();
// Only what the user owns is kept. Files written by the older generator also hold computed groups and a hash; they are dropped when read.
function loadPlan(start,{create=false}={}) {
  const have=read(planFile(start),null);
  if(!have)return create ? {week:start,scheduled_at:null,intents:[]} : null;
  return {week:start,scheduled_at:have.scheduled_at || null,...(have.carried ? {carried:have.carried} : {}),
    intents:(have.intents || []).map(i=>({...i,expected:i.expected || '',project_ids:i.project_ids || [],task_id:i.task_id || null}))};
}
// Only the Monday opening carries goals over, so editing any other week (a past one included) never pulls anything in by itself.
// Identity comes first. Free-text duplicates must also agree on project assignment and expected output;
// matching titles alone would silently drop two different projects' goals.
function carryOver(plan) {
  // A goal whose task is finished, or gone (deleted), stops here. A failed task is carried on purpose: it still needs someone, and planning names it.
  const live=new Map(read('work/queue.json',{items:[]}).items.filter(t=>!t.deleted_at).map(t=>[t.id,t]));
  const finished=new Set([...live.values()].filter(isDone).map(t=>t.id));
  const projects=i=>JSON.stringify([...(i.project_ids || [])].sort());
  const have=i=>plan.intents.some(x=>x.id===i.id || (i.task_id ? x.task_id===i.task_id :
    !x.task_id && x.title===i.title && projects(x)===projects(i) && (x.expected || '')===(i.expected || '')));
  let carried=0;
  // The latest earlier plan that exists, up to eight weeks back, so a week that was never opened does not drop its goals.
  let from=null;for(let k=1;k<=8 && !from;k++)from=loadPlan(shift(plan.week,-7*k));
  for(const i of from?.intents || []) {
    if((i.task_id && (finished.has(i.task_id) || !live.has(i.task_id))) || have(i))continue;
    const {schedule,...goal}=i; // Carry the goal, never last week's time allocation.
    plan.intents.push(goal);carried++;
  }
  return carried;
}
function changePlan(start,change) {
  weekOf(start);const plan=loadPlan(start,{create:true});
  const result=change(plan);write(planFile(start),plan);return result;
}
function inferProjects(title) {
  return read('projects/catalog.json').projects.filter(p=>[p.name,...p.aliases].some(alias=>title.toLowerCase().includes(alias.toLowerCase())) ||
    (p.id==='graphene-thz' && /graphene|石墨烯|thz/i.test(title)) || (p.id==='bi-devices' && /\bBi\b|铋/i.test(title))).map(p=>p.id);
}
function checkedProjects(ids) {
  const known=new Set(read('projects/catalog.json').projects.map(p=>p.id));
  if(!Array.isArray(ids) || ids.some(id=>!known.has(id)))throw new Error('未知项目');
  return [...new Set(ids)];
}
// Add a goal: free text, or an existing task (the task is linked, not copied).
export function addIntent({week,title,expected,project_ids,task_id}) {
  return changePlan(week,plan=>{
    let name=text(title),projects=project_ids;
    if(task_id) {
      const task=read('work/queue.json',{items:[]}).items.find(t=>t.id===task_id);
      if(!task)throw new Error('未知任务');
      if(plan.intents.some(i=>i.task_id===task_id))throw new Error('这件事已经在本周计划里');
      name=name || text(task.title);projects=projects ?? task.project_ids;
    }
    if(!name)throw new Error('目标不能为空');
    const intent={id:randomUUID(),title:name,expected:text(expected),project_ids:projects===undefined ? inferProjects(name) : checkedProjects(projects),task_id:task_id || null,source:'weekly-plan'};
    plan.intents.push(intent);return intent;
  });
}
// Edit by id: a changed title keeps the link to its task and the project assignment unless those are sent too.
export function updateIntent({week,id,title,expected,project_ids,schedule}) {
  return changePlan(week,plan=>{
    const intent=plan.intents.find(i=>i.id===id);if(!intent)throw new Error('未知周目标');
    if(title!==undefined){const name=text(title);if(!name)throw new Error('目标不能为空');intent.title=name;}
    if(expected!==undefined)intent.expected=text(expected);
    if(project_ids!==undefined)intent.project_ids=checkedProjects(project_ids);
    if(schedule==='auto')delete intent.schedule;
    else if(schedule!==undefined) {
      const block=schedule===null ? {locked:true} : {...checkedBlock(schedule,week),locked:true};
      if(block.start) {
        const s=weeklySources(),view=calendarItems(calendarData(s.mail,s.work,s.links));
        if(view.problems.length)throw new Error('有日期无法解析，先修正日程');
        requireKnownEnds(view.items,week);
        if(view.items.some(i=>i.kind==='event' && !(i.source==='weekly' && i.week===week && i.intent_id===id) &&
          i.ms<Date.parse(block.end) && (i.until ?? i.ms)>Date.parse(block.start)))throw new Error('工作块与已有日程冲突');
      }
      intent.schedule=block;
    }
    return intent;
  });
}
// Removing a goal does not touch the task it points to.
export function removeIntent({week,id}) {
  return changePlan(week,plan=>{
    const intent=plan.intents.find(i=>i.id===id);if(!intent)throw new Error('未知周目标');
    // A todo that this plan queued and nobody has started goes back to not-started: leaving the plan must not leave an assistant step that still runs.
    const task=intent.queued_by_plan && intent.task_id ? read('work/queue.json',{items:[]}).items.find(t=>t.id===intent.task_id && !t.deleted_at) : null;
    let released=false;
    if(task?.status==='queued'){update({id:task.id,status:'open',reason:'从周计划移除'});released=true;}
    plan.intents=plan.intents.filter(i=>i.id!==id);return {removed:id,released};
  });
}
export function saveReview({week,summary,next_adjust,included}) {
  weekOf(week);const old=read(reviewFile(week),{});
  if(included!==undefined && (!Array.isArray(included) || included.some(id=>! /^[a-z0-9-]{1,80}:T-\d{8}-\d{2,}$/.test(id))))throw new Error('纳入的记录编号不合法（须带项目编号）');
  const review={week,summary:summary===undefined ? old.summary || '' : text(summary),next_adjust:next_adjust===undefined ? old.next_adjust || '' : text(next_adjust),
    included:included===undefined ? old.included || [] : [...new Set(included)],updated_at:new Date().toISOString()};
  write(reviewFile(week),review);return review;
}
export async function startIntent(id,week=weekWindow().start) {
  const plan=loadPlan(weekOf(week).start);const intent=plan?.intents.find(i=>i.id===id);
  if(!intent)throw new Error('未知周目标');if(intent.task_id)return {task_id:intent.task_id};
  let item;
  const physical=/实验|测量|制备|加工|样品|生长|培训/.test(intent.title) && !/分析|处理|拟合|文献|报告|脚本|计划|规划|方案|设计|整理|总结/.test(intent.title);
  if(physical) {
    item=enqueue({title:intent.title,goal:intent.title,kind:'experiment',actor:'user',project_ids:intent.project_ids});
    update({id:item.id,status:'waiting_user',handoff:'周计划中的现场工作，需要你执行；准备与分析可交给 agent。'});
  } else {
    const {submit}=await import('../agent/run.mjs');item=submit({text:intent.title,project_id:intent.project_ids[0]});item.id=item.task_id;
  }
  intent.task_id=item.id;write(planFile(week),plan);
  return {task_id:item.id,source:'weekly-plan'};
}

// ---- on-demand assistant planning: reasoning belongs to the assistant; allocation and writes belong to the program ------------------------
function checkedBlock(block,week) {
  const w=weekOf(week),start=ledgerTime(block.start),end=ledgerTime(block.end);
  const from=parseWhen(start),to=parseWhen(end);
  if(from.all_day || to.all_day || to.ms<=from.ms || from.date<w.start || to.date>w.end)throw new Error('工作块需有开始和结束时刻，并在所选周内');
  return {start:new Date(from.ms).toISOString(),end:new Date(to.ms).toISOString()};
}
function requireKnownEnds(items,week) {
  const w=weekOf(week),unknown=items.find(i=>i.kind==='event' && !i.all_day && !i.end_date && i.date>=w.start && i.date<=w.end);
  if(unknown)throw new Error('已有事项缺少结束时间，不能判断占用：'+unknown.title);
}
// Read context once when asked to plan. Framework text is evidence, not instructions or an executable task list.
export function planningContext(week=planningWeek().start) {
  const s=weeklySources();
  return {week:weekOf(week),plan:withStates(loadPlan(week),s.work),// The project's own index (titles, summaries, states, the complete log index with corrections marked), not the whole text: bodies are read on demand with `projects read-nodes`.
    projects:s.projects.map(p=>({...p,framework_digest:frameworkDigest(p.id)})),
    work:s.work.filter(t=>!t.deleted_at && !isDone(t) && !isChatTurn(t)),mail:s.mail.filter(t=>!isDone(t)),
    calendar:calendarItems(calendarData(s.mail,s.work,s.links)),
    needed:['项目优先级','明确的可工作时段','各目标预计分钟数或待安排原因','总预计时长会和日历空闲对照；已在计划里的目标（含顺延）带 minutes 和 task_status，是否保留要写进 goals'],
    boundary:'根据项目实际挑选少量目标，不把历史计划或证据缺口直接当本周承诺；排期不是执行授权。'};
}
// A supplied stable key identifies an assistant goal across revised proposals. All existing goal text is preserved;
// only unlocked time allocations in this proposal may move. Missing goals are never deleted implicitly.
function buildPlan(request,now=new Date()) {
  const w=weekOf(request.week),s=weeklySources(),plan=loadPlan(w.start,{create:true});
  if(!Array.isArray(request.goals) || request.goals.length>30)throw new Error('goals 需要数组，最多 30 项');
  if(!Array.isArray(request.availability || []))throw new Error('availability 需要数组');
  const windows=(request.availability || []).map(b=>checkedBlock(b,w.start)).map(b=>({start:Date.parse(b.start),end:Date.parse(b.end)})).sort((a,b)=>a.start-b.start);
  if(windows.some((b,n)=>n && b.start<windows[n-1].end))throw new Error('可工作时段不能重叠');
  const keys=new Set(),selected=[],out=[],pending=[],promote=[];
  // The chat turn that generated a goal is remembered so the page can open that conversation. Outside a running assistant turn there is none.
  let chatItem=null;try {chatItem=taskContext(s.work) || null;} catch {chatItem=null;}
  const chatTask=chatItem?.id || null,chatApproved=!!chatItem && directChatTask(chatItem);
  for(const g of request.goals) {
    const project=s.projects.find(p=>p.id===g.project_id);
    if(!project)throw new Error('未知或已归档项目');
    if(!/^[a-z0-9-]{1,80}$/.test(g.key || ''))throw new Error('每个目标需要稳定 key（小写字母、数字、连字符）');
    const key=g.project_id+':'+g.key;
    if(keys.has(key))throw new Error('方案内目标 key 重复');keys.add(key);
    const task=g.task_id ? s.work.find(t=>t.id===g.task_id && !t.deleted_at && !isDone(t) && t.project_ids?.includes(g.project_id)) : null;
    if(g.task_id && !task)throw new Error('来源任务不存在、已结束或不属该项目（计划里已有的目标若任务已被删除，请先移除该目标再重新提案）');
    if(g.node_id && !frameworkNode(g.project_id,g.node_id))throw new Error('来源项目节点不存在');
    if(!task && !g.node_id)throw new Error('生成目标须关联已有任务或项目节点');
    if(!text(g.title) || !text(g.reason))throw new Error('目标需要 title 和选择依据 reason');
    if(g.minutes!=null && (!Number.isInteger(g.minutes) || g.minutes<=0 || g.minutes>1440))throw new Error('minutes 需要 1–1440 的整数');
    let intent=plan.intents.find(i=>i.origin?.key===key || task && i.task_id===task.id);
    if(intent?.origin?.key===key && g.task_id && intent.task_id!==g.task_id)throw new Error('稳定 key 不能改绑另一项任务');
    if(selected.some(i=>i===intent) && intent)throw new Error('同一目标或任务不能在方案里出现两次');
    if(!intent) {
      intent={id:'wi-'+createHash('sha256').update(w.start+':'+key).digest('hex').slice(0,24),title:text(g.title),expected:text(g.expected),
        project_ids:[project.id],task_id:task?.id || null,source:'project-planning',origin:{key,node_id:g.node_id || null,reason:text(g.reason),...(chatTask ? {chat_task:chatTask} : {})}};
      plan.intents.push(intent);
    }
    if(g.minutes!=null)intent.minutes=g.minutes; // kept on the goal so the week's total time can be counted across proposals and carried goals
    // The plan holds todos only. A goal without a task gets one filed by the program as a todo, with an id derived from the week and key so a rerun reuses it;
    // an existing task that is still not-started is promoted to a todo when the plan is applied. An assistant's todo is run by the workbench once its prerequisites are done; the user's is only listed.
    const bound=task || (intent.task_id ? s.work.find(t=>t.id===intent.task_id && !t.deleted_at) : null);
    if(bound?.status==='open') {
      // Checked here, before anything is written: a step from the autonomous planner can only be queued by the user, from a chat the user started.
      if(bound.autonomy && !bound.autonomy.approved_at && !chatApproved)throw new Error('任务「'+bound.title+'」来自自主规划，只能在你直接发起的对话里排进待办');
      promote.push({intent,task:bound});
    }
    if(!task && !intent.task_id) {
      const route=read('work/policy.json').defaults.find(p=>p.kind===g.kind);
      if(!route)throw new Error('新目标需要 kind（'+read('work/policy.json').defaults.map(p=>p.kind).join('、')+'）：它会成为一张任务');
      const actor=g.actor || route.actor;
      if(!['user','codex','claude','deepseek'].includes(actor))throw new Error('actor 只能是 user、codex、claude 或 deepseek');
      pending.push({intent,spec:{id:'wt-'+createHash('sha256').update(w.start+':'+key).digest('hex').slice(0,24),title:intent.title,kind:g.kind,actor,
        project_ids:[project.id],goal:[intent.expected && '预期产出：'+intent.expected,'来源：周计划 '+w.start+'，'+text(g.reason)].filter(Boolean).join(String.fromCharCode(10)),sources:['weekly:'+key,...(g.node_id ? [project.id+':'+g.node_id] : [])]}});
    }
    selected.push(intent);out.push({intent,g,task});
  }
  const data=calendarItems(calendarData(s.mail,s.work,s.links));
  // Unknown dates must not silently disappear from conflict detection.
  if(data.problems.length && request.goals.length)throw new Error('有日期无法解析，先修正日程后再自动排期');
  if(windows.length && request.goals.length)requireKnownEnds(data.items,w.start);
  const moving=new Set(selected.filter(i=>!i.schedule?.locked).map(i=>i.id));
  // A goal's block stops occupying time once its task is done, cancelled or gone.
  const handedBack=i=>i.source==='weekly' && i.task_id && ['done','cancelled','missing'].includes(taskStatus(i,s.work));
  const busy=data.items.filter(i=>i.kind==='event' && !handedBack(i) && !(i.source==='weekly' && i.week===w.start && moving.has(i.intent_id)))
    .map(i=>({start:i.ms,end:i.until ?? i.ms}));
  const result=[],gaps=freeGaps(windows,busy,now.getTime()),dead=new Map(),idle=new Map();let demand=0,placed=0;
  const newActor=new Map(pending.map(p=>[p.intent,p.spec.actor])),selectedTasks=new Set(out.map(o=>o.task?.id || o.intent.task_id).filter(Boolean));
  for(const {intent,g,task:given} of out) {
    if(intent.schedule?.locked) {result.push({id:intent.id,title:intent.title,status:'preserved',schedule:intent.schedule,reason:'保留你的手动排期或清除'});continue;}
    delete intent.schedule;
    const task=given || s.work.find(t=>t.id===intent.task_id && !t.deleted_at);
    // An assistant works in the background: it takes no time from the user's windows, so it is neither placed nor counted.
    const actor=task?.actor ?? newActor.get(intent);
    const unmet=(task?.dependencies || []).map(id=>s.work.find(t=>t.id===id && !t.deleted_at) || {id,title:id,status:'missing'}).filter(t=>t.status!=='done');
    for(const t of unmet) {if(['failed','cancelled','missing'].includes(t.status))dead.set(t.id,t);else if(!selectedTasks.has(t.id))idle.set(t.id,t);}
    if(actor && actor!=='user') {
      intent.scheduling_note='';
      result.push({id:intent.id,title:intent.title,status:'assistant',schedule:null,reason:'由助手执行，不占用你的时间，不排日历'+(unmet.length ? '；前置步骤未完成：'+unmet.map(t=>t.title+'（'+t.status+'）').join('、') : '')});
      continue;
    }
    const minutes=g.minutes ?? intent.minutes;
    let reason=text(g.blocked_reason) || (unmet.length ? '前置步骤未完成：'+unmet.map(t=>t.title+'（'+t.status+'）').join('、') : '') || (!minutes ? '缺少预计耗时' : '');
    if(!reason)demand+=minutes;
    const deadline=task?.due_at ? parseWhen(task.due_at,'end').ms : Infinity;
    let slot=null;
    if(!reason)for(const window of windows) {
      let start=Math.max(window.start,Math.ceil(now.getTime()/60000)*60000);const end=Math.min(window.end,deadline),duration=minutes*60000;
      for(const b of busy.slice().sort((a,b)=>a.start-b.start)) {
        if(b.end<=start || b.start>=end)continue;
        if(start+duration<=b.start)break;
        start=Math.max(start,b.end);
      }
      if(start+duration<=end){slot={start:new Date(start).toISOString(),end:new Date(start+duration).toISOString()};busy.push({start,end:start+duration});break;}
    }
    if(slot){intent.schedule=slot;placed+=minutes;}
    else reason=reason || (Number.isFinite(deadline) && windows.length && windows.every(x=>x.start>=deadline) ? '任务截止（'+task.due_at+'）早于所有可工作时段' : windows.length ? '可用时段不足或已过截止；未拆分工作块' : '未提供可工作时段');
    intent.scheduling_note=reason;
    result.push({id:intent.id,title:intent.title,status:slot ? 'scheduled' : 'unscheduled',schedule:slot,reason});
  }
  // Time against the calendar: what the windows leave free once existing events and untouched blocks are removed, against what this proposal asks for.
  // A shortfall is reported, never silently dropped or forced; the assistant must cut goals, shorten estimates or ask for more working time.
  const sum=list=>Math.round(list.reduce((n,[a,b])=>n+(b-a),0)/60000),free=sum(gaps),largest=Math.round(Math.max(0,...gaps.map(([a,b])=>b-a))/60000);
  const capacity={available_minutes:sum(windows.map(b=>[Math.max(b.start,Math.ceil(now.getTime()/60000)*60000),b.end]).filter(([a,b])=>b>a)),free_minutes:free,largest_free_gap_minutes:largest,
    requested_minutes:demand,scheduled_minutes:placed,shortfall_minutes:Math.max(0,demand-free),
    not_in_proposal:plan.intents.filter(i=>!selected.includes(i) && !['done','cancelled'].includes(taskStatus(i,s.work))).map(i=>({id:i.id,title:i.title,task_status:taskStatus(i,s.work),scheduled:!!i.schedule?.start,minutes:i.minutes || null}))};
  const warnings=[];
  if(capacity.shortfall_minutes)warnings.push(`预计 ${demand} 分钟，日历上可用空闲只有 ${free} 分钟，缺 ${capacity.shortfall_minutes} 分钟：请减少目标、缩短估时，或补充可工作时段`);
  if(demand<=free && result.some(r=>r.status==='unscheduled' && /不足/.test(r.reason)))warnings.push(`总时长装得下，但最大的连续空闲只有 ${largest} 分钟，放不下更长的目标（目标不拆分）`);
  const broken=plan.intents.filter(i=>['missing','failed'].includes(taskStatus(i,s.work)));
  if(broken.length)warnings.push(`有 ${broken.length} 个目标的任务已不在或已失败：${broken.map(i=>i.title).join('、')}；请先处理任务，或移除该目标`);
  if(dead.size)warnings.push(`有目标的前置任务已失败、取消或已不在，不处理它们，这些目标永远不会就绪：${[...dead.values()].map(t=>t.title+'（'+t.status+'）').join('、')}`);
  if(idle.size)warnings.push(`有目标的前置任务还没开始，也不在本次方案里，它们不会自己开始：${[...idle.values()].map(t=>t.title).join('、')}；要么一并排进计划，要么先处理`);
  if(capacity.not_in_proposal.length)warnings.push(`计划里还有 ${capacity.not_in_proposal.length} 个目标不在这次方案里（顺延或此前提交的），它们的时间不在本次安排内：要保留请写进 goals，要撤回请移除`);
  // Assistant todos are run by the workbench: at once when nothing stands in front of them, otherwise as soon as their prerequisites are done.
  const assistants=[...pending.map(p=>({title:p.spec.title,actor:p.spec.actor,deps:[]})),...promote.map(p=>({title:p.task.title,actor:p.task.actor,deps:p.task.dependencies || []}))].filter(x=>x.actor!=='user');
  const startsNow=assistants.filter(x=>x.deps.every(id=>s.work.find(t=>t.id===id)?.status==='done')).map(x=>x.title),later=assistants.filter(x=>!startsNow.includes(x.title)).map(x=>x.title);
  const queueing={new_todos:pending.map(p=>({id:p.spec.id,title:p.spec.title,kind:p.spec.kind,actor:p.spec.actor})),promoted_to_todo:promote.map(p=>({id:p.task.id,title:p.task.title,actor:p.task.actor})),will_run:[...startsNow,...later],starts_now:startsNow,after_prerequisites:later};
  if(startsNow.length)warnings.push('认可后这些助手任务会立刻开跑（消耗额度）：'+startsNow.join('、'));
  if(later.length)warnings.push('这些助手任务进入待办，前置完成后自动开跑（消耗额度）：'+later.join('、'));
  return {week:w.start,plan,allocation:result,capacity,warnings,pending,promote,queueing};
}
export function previewPlan(request,now=new Date()) {
  const {pending,promote,...result}=buildPlan(request,now);
  return result;
}
// Validate the entire proposal against current owners first; nothing is written when it is refused. Then each new goal gets its open task (never queued,
// no model call, no start; a task left by an interrupted run is reused) and the plan is written once. No ledger or review writes.
export function applyPlan(request,now=new Date()) {
  const {pending,promote,...result}=buildPlan(request,now);
  const have=new Map(read('work/queue.json',{items:[]}).items.map(t=>[t.id,t]));
  for(const {intent,spec} of pending) {
    const reused=have.get(spec.id);
    intent.task_id=spec.id;intent.queued_by_plan=true;
    if(!reused)enqueue({...spec,status:'queued'},{internalId:spec.id});
    else if(reused.status==='open')update({id:spec.id,status:'queued'});
  }
  for(const {intent,task} of promote) {update({id:task.id,status:'queued'});intent.queued_by_plan=true;}
  write(planFile(result.week),result.plan);
  return result;
}

// ---- what the sources say ------------------------------------------------------------------------------------------------------------------
// A goal has no completion or state of its own: it carries its task's status, read on demand and never written to plan.json.
// task_status is the task's own status (open, queued, active, waiting_user, done, failed, cancelled), 'missing' when the task is gone, null without a task.
// The gaps left in the working windows once busy time is removed, first-fit order, exactly as the allocator walks them.
function freeGaps(windows,busy,now) {
  const from=Math.ceil(now/60000)*60000,gaps=[],sorted=busy.slice().sort((a,b)=>a.start-b.start);
  for(const w of windows) {
    let at=Math.max(w.start,from);
    for(const b of sorted) {if(b.end<=at || b.start>=w.end)continue;if(b.start>at)gaps.push([at,b.start]);at=Math.max(at,b.end);}
    if(at<w.end)gaps.push([at,w.end]);
  }
  return gaps;
}
const taskStatus=(i,work)=>!i.task_id ? null : work.find(x=>x.id===i.task_id && !x.deleted_at)?.status || 'missing';
const withStates=(plan,work)=>plan && {...plan,intents:plan.intents.map(i=>({...i,task_status:taskStatus(i,work)}))};
export function weeklySnapshot(now=new Date()) {
  const window=weekWindow(now);
  return {window,config:config(),plan:withStates(loadPlan(window.start),read('work/queue.json',{items:[]}).items)};
}
// The research log decides which week a record belongs to, by the date it says things happened, and only when that date is confirmed and exact
// to the day. Everything else is counted, never placed. What the record says about its own evidence stays attached.
const DAY=/^\d{4}-\d{2}-\d{2}$/;
function researchRecords(w,s,deliveredIds) {
  const candidates=[],problems=[];let unplaced=0;const seen=new Set();
  for(const project of s.projects) {
    let framework;
    try {framework=readFramework(project.id);}catch(error) {problems.push(`${project.name}：${error.message}`);continue;}
    if(!framework)continue;
    problems.push(...framework.problems.map(p=>`${project.name}：${p}`));
    const walk=node=>{
      const key=project.id+':'+node.id; // T numbers are allocated within each project, not globally.
      if(node.entry && !seen.has(key)) {
        seen.add(key);
        const [from,to=from]=String(node.date || '').split('/');
        if(!node.date_confirmed || !DAY.test(from) || !DAY.test(to))unplaced++;
        else if(from<=w.end && to>=w.start)candidates.push({key,id:node.id,project_id:project.id,project:project.name,title:node.title,date:node.date,
          evidence:(node.aux.find(a=>a.label==='来源与性质')?.body || '').replace(/^- /,''),work:node.work,delivered_by:node.work.filter(id=>deliveredIds.has(id))});
      }
      node.children.forEach(walk);
    };
    framework.boards.forEach(walk);
  }
  return {candidates:candidates.sort((a,b)=>a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),unplaced,problems};
}
function weekFacts(w,s) {
  const tz=config().timezone,format=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const inWeek=iso=>{if(!iso)return false;const d=format.format(new Date(iso));return d>=w.start && d<=w.end;};
  const delivered=s.work.filter(i=>i.status==='done' && inWeek(i.completed_at));
  // Board deliveries are the task steps themselves. A finished chat turn is not a board item: if it left a file (or the user's own hand is in it)
  // it is listed apart as "other real delivery"; a turn with only words is counted, never listed.
  const isRecord=i=>(i.outputs || []).length>0 || i.actor==='user';
  const brief=i=>({id:i.id,title:i.title,project_ids:i.project_ids,outcome:i.handoff,outputs:i.outputs || [],completed_at:i.completed_at});
  const settled=delivered.filter(i=>i.review?.state!=='pending');
  const completed=settled.filter(i=>!isChatTurn(i)).map(brief);
  const other=settled.filter(i=>isChatTurn(i) && isRecord(i)).map(brief);
  const unsuccessful=s.work.filter(i=>['failed','cancelled'].includes(i.status) && inWeek(i.updated_at || i.created_at));
  const runs=usageSnapshot().runs.filter(r=>inWeek(r.at));
  const total=(provider,key)=>runs.filter(r=>r.provider===provider).reduce((n,r)=>n+(r[key] || 0),0);
  const ai_usage=['codex','claude','deepseek'].map(provider=>({provider,calls:runs.filter(r=>r.provider===provider).length,input_tokens:total(provider,'input_tokens'),output_tokens:total(provider,'output_tokens')}));
  // Where the week's tokens went, by what each call was for.
  const purpose_usage=usageGroups(runs,purposeOf).map(g=>({purpose:g.key,label:purposes[g.key],calls:g.calls,failed:g.failed,unknown:g.unknown,
    input_tokens:g.input,cached_input_tokens:g.cached,output_tokens:g.output,billed_tokens:g.billed}));
  // What the unattended mail loop did that week, from its own log and card record.
  const judgeLog=path.join(root,'.runtime/mail-flow/judge.log');
  const lines=fs.existsSync(judgeLog) ? fs.readFileSync(judgeLog,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(l=>inWeek(l.at)) : [];
  const auto={judged:lines.filter(l=>Number.isFinite(l.applied)).reduce((n,l)=>n+l.messages,0),failed:lines.filter(l=>l.error).length,
    prepared:Object.values(read('.runtime/inbox/auto-prepared.json',{})).filter(v=>inWeek(v.at)).length};
  const office={delivered:delivered.filter(i=>!isChatTurn(i)).length,unsuccessful:unsuccessful.length,calls:runs.length,input_tokens:runs.reduce((n,r)=>n+(r.input_tokens || 0),0),
    cached_input_tokens:runs.reduce((n,r)=>n+(r.cached_input_tokens || 0),0),output_tokens:runs.reduce((n,r)=>n+(r.output_tokens || 0),0),
    auto_judged:auto.judged,auto_failed:auto.failed,auto_prepared:auto.prepared};
  const handled=settled.filter(i=>isChatTurn(i) && !isRecord(i)).length;
  return {completed,other,handled,ai_usage,purpose_usage,office,delivered_ids:delivered.map(i=>i.id)};
}
// As of now, whichever week is on screen: what is stuck, and what waits for the user.
function currentState(s,now) {
  const blocked=[...new Map(s.work.filter(i=>!isChatTurn(i) && (i.status==='waiting_user' || i.status==='failed' || (i.review?.state==='pending' && i.review.kind==='acceptance'))).map(i=>[i.id,i])).values()];
  return {as_of:now.toISOString(),blocked:blocked.map(i=>({id:i.id,title:i.title,next:text(i.handoff || i.goal),project_ids:i.project_ids})),
    awaiting_decision:s.work.filter(i=>i.status==='done' && i.review?.state==='pending' && i.review.kind==='decision').length,
    awaiting_acceptance:s.work.filter(i=>i.review?.state==='pending' && i.review.kind==='acceptance').length};
}
function officeSuggestions(office,current) {
  const out=[];
  if(office.auto_judged || office.auto_prepared)out.push(`邮件自动处理：判断 ${office.auto_judged} 封、准备选项 ${office.auto_prepared} 张${office.auto_failed ? `，判断失败 ${office.auto_failed} 次，建议查看原因` : ''}。`);
  if(office.unsuccessful)out.push('先检查失败或中止任务的共同原因，修正后再启动下一次执行。');
  if(current.awaiting_acceptance)out.push(`目前有 ${current.awaiting_acceptance} 项交付待验收；优先把结果和依据对照闭环。`);
  if(!office.delivered)out.push('用一项真实工作验证周计划、执行和交付，再决定下一项自动化功能。');
  if(office.calls && !office.unsuccessful && !current.awaiting_acceptance)out.push('从实际调用记录中选择一类重复工作，优先复用现有输入与处理脚本。');
  return out;
}
// Everything the weekly page shows for one week. Reads only; nothing here writes.
export function weekView(start=weekWindow().start,now=new Date()) {
  const w=weekOf(start),s=weeklySources(),plan=withStates(loadPlan(start),s.work);
  const planned=new Set((plan?.intents || []).map(i=>i.task_id).filter(Boolean));
  const linkFor=id=>s.links.find(l=>l.module==='mail' && l.item_id===id);
  const pool={
    work:s.work.filter(t=>!isDone(t) && !isChatTurn(t)).map(t=>({id:t.id,title:t.title,project_ids:t.project_ids,next:t.goal || '',actor:t.actor || null,status:t.status,due_at:t.due_at || null,planned:planned.has(t.id)})),
    mail:s.mail.filter(t=>!isDone(t)).map(t=>({id:t.id,title:t.title,project_ids:linkFor(t.id)?.project_ids || [],next:t.action || '',status:t.status,due_at:t.deadline || null,check_at:t.check_at || null}))};
  const facts=weekFacts(w,s),current=currentState(s,now);
  const research=researchRecords(w,s,new Set(facts.delivered_ids));
  const saved=read(reviewFile(start),{});
  // Older generated reviews have no user fields. Normalise the read result without rewriting the file.
  const review={week:start,summary:saved.summary || '',next_adjust:saved.next_adjust || '',included:saved.included || [],updated_at:saved.updated_at || null};
  return {window:w,plan,pool,review,facts:{completed:facts.completed,other:facts.other,handled:facts.handled,ai_usage:facts.ai_usage,purpose_usage:facts.purpose_usage},current,research,
    office:{...facts.office,suggestions:officeSuggestions(facts.office,current)}};
}

// ---- exports (computed on request) ---------------------------------------------------------------------------------------------------------
export function markdown(start,type,now=new Date()) {
  const view=weekView(start,now),w=view.window,intents=view.plan?.intents || [];
  const projects=read('projects/catalog.json').projects,name=id=>projects.find(p=>p.id===id)?.name || id;
  const work=id=>read('work/queue.json',{items:[]}).items.find(t=>t.id===id);
  if(type==='plan') {
    const lines=[`# 周计划 · ${w.start} — ${w.end}`,'',`导出：${now.toISOString()}`,''];
    if(!intents.length)lines.push('本周研究目标待补充。','');
    for(const group of [...projects.filter(p=>!p.archived_at).map(p=>({id:p.id,name:p.name})),{id:null,name:'共享 / 待关联'}]) {
      const mine=intents.filter(i=>group.id ? i.project_ids.includes(group.id) : !i.project_ids.length);
      if(!mine.length)continue;
      lines.push(`## ${group.name}`,'');
      for(const i of mine) {
        const task=i.task_id ? work(i.task_id) : null;
        lines.push(`- [ ] ${i.title}${i.expected ? ` — 预期产出：${i.expected}` : ''}${task ? `（${task.actor || '待定'}／${task.status}）` : ''}`);
        if(i.origin?.reason)lines.push(`  - 选择依据：${i.origin.reason}`);
        if(i.schedule?.start)lines.push(`  - 工作块：${i.schedule.start} — ${i.schedule.end}（ISO 时刻；日历按芝加哥时间显示）`);
        else if(i.scheduling_note)lines.push(`  - 待安排：${i.scheduling_note}`);
      }
      lines.push('');
    }
    const open=view.pool.work.filter(t=>!t.planned);
    if(open.length)lines.push('## 待安排（未纳入本周）','',...open.map(t=>`- ${t.title}${t.project_ids.length ? `（${t.project_ids.map(name).join('、')}）` : ''}`),'');
    return lines.join('\n');
  }
  const included=new Set(view.review.included),chosen=view.research.candidates.filter(c=>included.has(c.key));
  const lines=[`# 组会材料 · ${w.start} — ${w.end}`,'',`导出：${now.toISOString()}`,'','## 1. 本周进展',''];
  if(!view.facts.completed.length && !chosen.length)lines.push('暂无带完成时间和产出依据的交付，也没有选入的研究记录；现有邮件事项不代表实验完成。','');
  if(view.facts.completed.length)lines.push('### 任务交付','');
  for(const i of view.facts.completed)lines.push(`- ${i.title}${i.project_ids.length ? `（${i.project_ids.map(name).join('、')}）` : ''}：${i.outcome}`,...i.outputs.map(o=>`  - 产出：${o}`));
  if(chosen.length)lines.push('','### 研究记录（你选入）','');
  for(const c of chosen)lines.push(`- ${c.project}｜${c.title}（${c.date}，${c.id}）${c.evidence ? `\n  - 来源与性质：${c.evidence}` : ''}`);
  lines.push('',`## 2. 问题与待决定事项（截至 ${view.current.as_of}）`,'',...view.current.blocked.map(i=>`- ${i.title}：${i.next}`));
  if(!view.current.blocked.length)lines.push('暂无已记录阻塞。');
  if(view.current.awaiting_decision)lines.push('',`另有 ${view.current.awaiting_decision} 项已做完、等待你确认，见收件箱。`);
  lines.push('','## 3. 本周总结','',view.review.summary || '（尚未填写）');
  const next=read(planFile(shift(start,7)),null)?.intents || [];
  lines.push('','## 4. 下周调整与计划','',view.review.next_adjust || '（尚未填写）','',...next.map(i=>`- ${i.title}${i.expected ? `（预期产出：${i.expected}）` : ''}`));
  lines.push('','## 5. 图表与证据','',...view.facts.completed.flatMap(i=>i.outputs.map(o=>`- ${i.title}：${o}`)));
  if(!view.facts.completed.some(i=>i.outputs.length))lines.push('暂无已记录图表；补充实验、分析结果后可据此制作 PPT。');
  return lines.join('\n')+'\n';
}
// Plan the upcoming week on weekends; retain the existing last-calendar-week review convention.
export function exportWeek(now=new Date()) {
  const w=weekWindow(now),plan=planningWeek(now),files={plan:`.runtime/weekly/${plan.start}/plan.md`,review:`.runtime/weekly/${w.previous_start}/meeting-outline.md`};
  for(const [file,start,type] of [[files.plan,plan.start,'plan'],[files.review,w.previous_start,'review']]) {
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
    fs.writeFileSync(path.join(root,file),markdown(start,type,now));
  }
  return {files};
}
// Monday 09:00 Chicago: open the week once, carrying unfinished goals over (once, even if goals were added to it before). Nothing else is generated.
export function tick(now=new Date()) {
  const s=weeklySnapshot(now);
  if(s.config.automatic && s.window.due && !s.plan?.scheduled_at) {
    const plan=changePlan(s.window.start,p=>{p.scheduled_at=now.toISOString();p.carried=carryOver(p);return p;});
    return {plan};
  }
  return null;
}
export async function run(action,arg) {
  if(action==='status')console.log(JSON.stringify(weeklySnapshot()));
  else if(action==='view')console.log(JSON.stringify(weekView(arg)));
  else if(action==='context')console.log(JSON.stringify(planningContext(arg)));
  else if(action==='preview')console.log(JSON.stringify(previewPlan(input(arg))));
  else if(action==='apply')console.log(JSON.stringify(applyPlan(input(arg))));
  else if(action==='export')console.log(JSON.stringify(exportWeek()));
  else if(action==='tick')console.log(JSON.stringify(tick()));
  else throw new Error('weekly status|view|context [周一日期]|preview|apply <JSON文件路径>|export|tick');
}
