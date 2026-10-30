import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { root, read, write, input, checkProjects, isTurnRecord } from '../automation/files.mjs';
import { frameworkFile, parseFramework } from '../projects/framework.mjs';
import { fragment } from '../prompts/compose.mjs';
import {reviewPolicy,resultReviewPending,resultReviewLabel,invalidateResultReview,submitResultForReview,submitReviewVerdict,restartResultReview} from './result-review.mjs';
import { autonomyPolicy, autonomousChild, assertAutonomousState, autonomousCanStart, autonomyHoldReason, progressEvent, eventHash, taskContext, directChatTask, authorizedProjectStep } from './autonomy.mjs';
// Readiness is derived, not another persisted status. Missing/failed/cancelled predecessors never release work.
// auto_start is retired: the status (open / queued) is the only switch. Refuse the old field loudly so no caller thinks it still works.
function noAutoStart(request) { if (request.auto_start !== undefined) throw new Error('auto_start 已取消：未开始（open）不排队，待办（queued）且前置完成后由工作台交给助手'); }
// Native children keep OFFICE_MEMORY_RUN_DIR; merged inputs and assistant handoffs
// keep their source task. All of them spend the original user's turn allowance.
function queuedUserRound(parent, items) {
  if (!parent) return null;
  const sessions = read('.runtime/agent/sessions.json', { sessions: [] }).sessions, seen = new Set();
  let current = parent;
  for (;;) {
    if (!current || seen.has(current.id)) throw new Error('无法核对 queued 卡片所属的用户轮');
    seen.add(current.id);
    if (current.request_task_id) { current = items.find(i => i.id === current.request_task_id); continue; }
    if (current.merged_into) { current = items.find(i => i.id === current.merged_into); continue; }
    if (directChatTask(current)) return current.id;
    const handoff = sessions.find(s => s.task_ids.includes(current.id))?.messages
      .find(m => m.task_id === current.id && m.role === 'handoff')?.handoff;
    if (!handoff) return null; // Autonomous/background work retains its own policy.
    current = items.find(i => i.id === handoff.task_id);
  }
}
// A durable admission is not the card's current status. Reopening, cancelling or
// deleting a card never refunds a slot. The transaction also covers parallel CLI
// processes; queue.json's unrelated read/modify/write operations need no new lock.
function queuedAdmission(queue, item, parent) {
  if (item.status !== 'queued' || item.executor) return null;
  const round = queuedUserRound(parent, queue.items);
  if (!round) return null;
  const limit = read('agent/config.json').queued_cards_per_turn ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('queued_cards_per_turn 须为 1～50 的整数');
  const file = path.join(root, '.runtime/work/queued-admissions.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let transaction = false, inserted = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS admissions (root_turn TEXT NOT NULL, card_id TEXT NOT NULL, source_task TEXT NOT NULL, admitted_at TEXT NOT NULL, PRIMARY KEY(root_turn,card_id))');
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    if (!db.prepare('SELECT 1 FROM admissions WHERE root_turn=? AND card_id=?').get(round, item.id)) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM admissions WHERE root_turn=?').get(round).n;
      if (used >= limit) throw Object.assign(new Error(`本用户轮 queued 卡片已达上限（${limit} 张）；open 卡片不计入`), { code: 'QUEUED_CARD_LIMIT' });
      db.prepare('INSERT INTO admissions(root_turn,card_id,source_task,admitted_at) VALUES(?,?,?,?)').run(round, item.id, parent.id, new Date().toISOString());
      inserted = true;
    }
    db.exec('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
  if (!inserted) return null;
  return () => {
    const rollback = new DatabaseSync(file);
    try { rollback.exec('PRAGMA busy_timeout=5000'); rollback.prepare('DELETE FROM admissions WHERE root_turn=? AND card_id=?').run(round, item.id); }
    finally { rollback.close(); }
  };
}
function writeQueueWithAdmission(queue, item, parent) {
  const release = queuedAdmission(queue, item, parent);
  // write(queue) stores steps before turns. A later turns-file failure must not
  // refund an admission whose queued card is already visible to dispatch.
  const file=path.join(root,'work/queue.json'),before=release ? fs.readFileSync(file,'utf8') : null;
  try { write('work/queue.json', queue); }
  catch (error) {
    let unchanged=false;try {unchanged=release && fs.readFileSync(file,'utf8')===before;} catch { /* Keep the receipt when persistence is unknown. */ }
    if(unchanged)release();
    throw error;
  }
}
// A return waits for an execution to end, not for its research conclusion to succeed.
export function returnResult(id, items) {
  return items.findLast(i=>i.operation_id===id) || items.find(i=>i.id===id);
}
// Registering an operation also waits for its sub-operations (parent_id, any depth) that are still running or queued to run.
// A queued sub-operation whose prerequisite already failed or was cancelled will never start, so it does not hold the return.
function pendingBranch(id, items) {
  const seen=new Set([id]),pending=[],stack=[id];
  while(stack.length) {
    const owner=stack.pop();
    for(const op of items) {
      if(op.parent_id!==owner || op.deleted_at || op.operation_id || seen.has(op.id))continue;
      seen.add(op.id);stack.push(op.id);
      const status=returnResult(op.id,items)?.status;
      const dead=(op.dependencies || []).some(d=>['failed','cancelled'].includes(items.find(i=>i.id===d)?.status));
      if(status==='active' || (status==='queued' && !dead))pending.push(op.id);
    }
  }
  return pending;
}
export function readiness(item, items) {
  const blocked_by = [...new Set([...(item.dependencies || []).filter(id => {
    const source=items.find(i=>i.id===id && !i.deleted_at);
    return source?.status!=='done' || (item.review_target?.id!==id && resultReviewPending(source));
  }),
    ...(item.after || []).flatMap(id=>[...(!['done','failed','cancelled'].includes(returnResult(id,items)?.status) ? [id] : []),
      ...(items.some(i=>i.id===id && !i.operation_id && !i.deleted_at) ? pendingBranch(id,items) : [])])])];
  const hold=item.status==='queued' ? autonomyHoldReason(item,items) : null;
  return { ready: !item.deleted_at && item.status === 'queued' && !blocked_by.length && !hold, blocked_by,...(hold ? {autonomy_blocked:hold} : {}) };
}
// A chat turn is the queue record a chat message leaves behind (it carries an executor); it is not a to-do.
// A turn whose result waits for acceptance is a deliverable and counts as a task. This is the only definition:
// readers call it, the browser reads the derived `turn` flag on workSnapshot items.
export const isChatTurn = isTurnRecord;
export const workSnapshot = () => {
  const queue = read('work/queue.json');
  const histories=new Map();
  for(const run of queue.items.filter(i=>i.operation_id)) {
    if(!histories.has(run.operation_id))histories.set(run.operation_id,[]);
    histories.get(run.operation_id).push(run);
  }
  return { ...queue, items: queue.items.filter(i=>!i.deleted_at).map(i => {
    const execution_history=histories.get(i.id) || [];
    return { ...i, ...readiness(i, queue.items), turn: isChatTurn(i),...(resultReviewLabel(i) ? {result_review_label:resultReviewLabel(i)} : {}),...(!isChatTurn(i) ? {execution_history,...(execution_history.length ? {last_execution:execution_history.at(-1)} : {})} : {}) };
  }) };
};
// Keep task details and the complete history in the owning queue. The default CLI
// view is an index, not another copy of a thousand completed conversation turns.
export function workDigest(snapshot=workSnapshot(), pick=null) {
  const counts={},unfinished=[],recent=[];
  const index=i=>({id:i.id,title:i.title,status:i.status,actor:i.actor,project_ids:i.project_ids,
    ...(i.parent_id ? {parent_id:i.parent_id} : {}),...(i.last_execution ? {last_execution:i.last_execution} : {}),
    ...(i.autonomy ? {autonomy:{type:i.autonomy.type,depth:i.autonomy.depth,event_hash:i.autonomy.event_hash,parent_id:i.autonomy.parent_id,blocked_reason:i.autonomy_blocked || null}} : {}),
    ...(i.due_at ? {due_at:i.due_at} : {}),ready:i.ready,blocked_by:i.blocked_by,
    ...(i.review?.state ? {review:i.review.state} : {}),...(i.result_review ? {result_review:i.result_review,result_review_label:resultReviewLabel(i)} : {}),updated_at:i.updated_at || i.created_at});
  for(const i of snapshot.items) {
    counts[i.status]=(counts[i.status] || 0)+1;
    const finished=['done','cancelled'].includes(i.status) && !(i.status==='done' && (i.review?.state==='pending' || resultReviewPending(i)));
    if(finished) recent.push(i); else if(!pick || pick(i)) unfinished.push(i);
  }
  return {total_items:snapshot.items.length,counts,unfinished:unfinished.map(index),
    recent_finished:recent.sort((a,b)=>(b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '')).slice(0,8).map(index),
    note:'所有未结束或待验收任务及最近8条结束记录的索引；完整任务用 work handoff <完整id>，全量队列用 work list full。正文、交接、产出和历史未删除。'};
}
// Default `work list` view: a record-selected overview that is complete by construction, so a truncated read
// (head, tail, a tool's output limit) cannot pass for the whole queue. Detail comes from `work list <project|status|all>`.
const OVERVIEW_ATTENTION=12,OVERVIEW_CHAINS=6;
const short=id=>String(id).slice(0,8),oneLine=t=>String(t||'').replace(/\s+/g,' ');
export function workOverview(snapshot=workSnapshot()) {
  const byId=new Map(snapshot.items.map(i=>[i.id,i])),counts={};
  const finished=i=>['done','cancelled'].includes(i.status) && !(i.status==='done' && (i.review?.state==='pending' || resultReviewPending(i)));
  const unfinishedAll=snapshot.items.filter(i=>!finished(i)),isTurn=isChatTurn,open=unfinishedAll.filter(i=>!isTurn(i)),turns=unfinishedAll.filter(isTurn),turnCounts={};
  for(const i of turns) turnCounts[i.status]=(turnCounts[i.status]||0)+1;
  const dead=id=>{const seen=new Set(),walk=x=>{if(seen.has(x))return false;seen.add(x);const t=byId.get(x);if(!t)return false;if(t.status==='failed'||t.status==='cancelled')return true;return (t.dependencies||[]).some(walk);};return walk(id);};
  const category=i=>i.status==='done' ? resultReviewLabel(i) || '待验收' : i.status==='active' ? '进行中' : i.status==='waiting_user' ? '等你' : i.status==='failed' ? '失败'
    : i.status==='open' && i.last_execution?.outcome_status==='open' ? '上一轮已结束，未提交完成'
    : i.ready ? '可立即做' : (i.blocked_by||[]).some(dead) ? '前置已失败或取消' : (i.blocked_by||[]).length ? '等前置' : i.status==='queued' ? '待办' : '未开始';
  const groups={},lines=[],children=new Map();
  for(const i of snapshot.items) counts[i.status]=(counts[i.status]||0)+1;
  for(const i of open) {
    const c=category(i),p=(i.project_ids||[])[0]||'(无项目)';
    (groups[p]??={})[c]=(groups[p][c]||0)+1;
    if(['待验收','待提交成果审查','待独立审查','待父级整合','待父级返工','进行中','等你','失败','可立即做','上一轮已结束，未提交完成'].includes(c)) lines.push(short(i.id)+' '+c+' '+p+' '+oneLine(i.title)+' → work handoff '+short(i.id));
    for(const d of i.dependencies||[]) (children.get(d)||children.set(d,[]).get(d)).push(i.id);
  }
  const chains=[];
  for(const i of open) if(i.status==='failed' && children.has(i.id)) {
    const order=[],seen=new Set([i.id]),queue=[...children.get(i.id)];
    while(queue.length){const x=queue.shift();if(seen.has(x)||!byId.has(x)||finished(byId.get(x)))continue;seen.add(x);order.push(x);queue.push(...(children.get(x)||[]));}
    if(order.length) chains.push(short(i.id)+' 失败（'+oneLine(i.title)+'）卡住 '+order.length+' 条：'+order.slice(0,4).map(short).join('、')+(order.length>4?'…':''));
  }
  const categories={};for(const g of Object.values(groups)) for(const [k,v] of Object.entries(g)) categories[k]=(categories[k]||0)+v;
  return {
    coverage:'任务步骤未结束 '+open.length+' 条（队列共 '+snapshot.items.length+' 条）：'+Object.entries(categories).map(([k,v])=>k+' '+v).join('、')+'。另有对话轮 '+turns.length+' 条未结束（'+Object.entries(turnCounts).map(([k,v])=>k+' '+v).join('、')+'），是聊天消息留下的记录，不是待办，不在下面列出，需要时 work list turns。本总览按条目选择、自身完整，以末尾 end 字段为读完标志；没读到 end 就是被截断，不要据此下结论。明细：work list <项目id|状态|all>，单条：work handoff <完整id>。',
    total_items:snapshot.items.length,counts,turns:turnCounts,by_project:groups,
    needs_attention:lines.slice(0,OVERVIEW_ATTENTION).concat(lines.length>OVERVIEW_ATTENTION?['另有 '+(lines.length-OVERVIEW_ATTENTION)+' 条，用 work list <项目id|状态> 看']:[]),
    blocked_by_failed:chains.slice(0,OVERVIEW_CHAINS).concat(chains.length>OVERVIEW_CHAINS?['另有 '+(chains.length-OVERVIEW_CHAINS)+' 组']:[]),
    end:'work list 总览结束'};
}
// Detail view: unfinished task steps filtered by project id or status; `turns` lists the chat-turn records instead. One task per line.
export function workDetail(argument,snapshot=workSnapshot()) {
  const STATUS=['open','queued','active','waiting_user','failed','review'];
  if(argument!=='turns' && !STATUS.includes(argument)) checkProjects([argument]);
  const isTurn=isChatTurn,match=i=>argument==='turns' ? isTurn(i) : !isTurn(i) && (argument==='review' ? i.review?.state==='pending' || resultReviewPending(i) : STATUS.includes(argument) ? i.status===argument : (i.project_ids||[]).includes(argument));
  const d=workDigest(snapshot,match),total=workDigest(snapshot).unfinished.length;
  const slim=x=>({id:x.id,status:x.status,project:(x.project_ids||[])[0]||null,title:x.title,...(x.parent_id?{parent_id:x.parent_id}:{}),...(x.last_execution?{last_execution:x.last_execution}:{}),...(x.blocked_by?.length?{blocked_by:x.blocked_by.map(short)}:{}),...(x.review?{review:x.review}:{}),...(x.result_review?{result_review:x.result_review,result_review_label:x.result_review_label}:{}),...(x.due_at?{due_at:x.due_at}:{}),next:'work handoff '+short(x.id)});
  return {coverage:'筛选 '+argument+'：未结束 '+d.unfinished.length+' 条（'+(argument==='turns'?'对话轮':'不含对话轮')+'；全部未结束含对话轮 '+total+' 条）。每行一条，末尾 end 为读完标志。',unfinished:d.unfinished.map(slim),end:'work list 明细结束'};
}
// Items print one per line so a head/tail read of the detail view still shows whole tasks.
function printLines(d) {
  const one=(k,v)=>'  '+JSON.stringify(k)+': '+(Array.isArray(v)&&v.length&&typeof v[0]==='object' ? '[\n'+v.map(x=>'    '+JSON.stringify(x)).join(',\n')+'\n  ]' : JSON.stringify(v));
  console.log('{\n'+Object.keys(d).map(k=>one(k,d[k])).join(',\n')+'\n}');
}
// The assistant chooses which results have lasting research value. Filing a
// step under a project/topic does not itself create a project-log requirement.
export function logRequirementOf(item) {
  return item.log_requirement ?? null;
}
function logContext(item) {
  const r = logRequirementOf(item);
  if (r === null) return null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k=>!['project_id','parent','links'].includes(k)) ||
      typeof r.project_id !== 'string' || !item.project_ids?.includes(r.project_id) || typeof r.parent !== 'string' ||
      !Array.isArray(r.links) || r.links.some(id=>typeof id !== 'string'))
    throw new Error('log_requirement 须指定本项目、日志父栏，links 为数组（可为空）');
  checkProjects([r.project_id]);
  const file = frameworkFile(r.project_id);
  if (!fs.existsSync(file)) throw new Error('处理日志所属项目没有 FRAMEWORK.md');
  const parsed = parseFramework(fs.readFileSync(file,'utf8'));
  const parent = parsed.byId.get(r.parent);
  if (!parent || parent.entry || parent.level >= 6 || !parent.ancestors.concat(parent).some(n=>n.meta.type==='timeline'))
    throw new Error('处理日志 parent 必须是可追加记录的时间日志子栏');
  if (r.links.some(id=>!parsed.byId.get(id)?.entry)) throw new Error('处理日志 links 必须指向已有原记录/上下文日志');
  return { requirement:r, parsed, file };
}
// Automatic file-producing assistant steps need real outputs by default. Interactive answers,
// cards and exploration rounds retain their own completion contracts; an explicitly
// file-free step can opt out with require_outputs:false.
export const requiresOutputs = item => item.require_outputs ?? (
  !item.executor && item.mode !== 'card' && !item.exploration &&
  ['codex','claude','deepseek'].includes(item.actor) && ['data','cad','presentation'].includes(item.kind));
export function validateOutcome(item) {
  const context = logContext(item);
  if (!String(item.handoff || '').trim() && !item.outputs.length) throw new Error('Record an outcome before marking done');
  if (item.require_outputs) {
    if (!item.outputs.length || !String(item.handoff || '').trim()) throw new Error('完成前请填写数据/产出位置和留言');
    for (const file of item.outputs) if (!fs.existsSync(path.resolve(root, file))) throw new Error('数据/产出位置不存在：' + file);
    if (context && !item.outputs.some(file=>path.resolve(root,file)!==path.resolve(context.file))) throw new Error('处理日志不能替代分析产出文件');
  }
  if (context) {
    const { requirement:r, parsed } = context;
    const log = parsed.nodes.find(n=>n.entry && n.parent?.id===r.parent && n.meta.work?.includes(item.id) &&
      r.links.every(id=>n.meta.links?.includes(id)) && n.body.trim());
    if (!log) throw new Error('处理日志未交付：请在 '+r.parent+' 下追加非空日志（结论写在日志里，留言只指向它），work 关联本任务'+(r.links.length ? '，links 关联 '+r.links.join('、') : ''));
  }
}
export function enqueue(request,{autonomous=false,background=false,provenance,internalId,modelDefaults=true,conversationTurn=false}={}) {
  if(request.autonomy!==undefined || request.progress_event!==undefined || request.delegated_by!==undefined)throw new Error('自主来源由程序记录，不能由请求设置');
  if(request.review_target!==undefined || request.review_verdict!==undefined)throw new Error('成果审查身份和结论由对应操作记录，不能在创建请求中设置');
  if (typeof request.title !== 'string' || !request.title.trim()) throw new Error('A task title is required');
  const policy = read('work/policy.json');
  const route = policy.defaults.find(p => p.kind === request.kind);
  if (!route) throw new Error('Unknown task kind');
  const actor = request.actor || route.actor;
  if (!['user', 'codex', 'claude', 'deepseek'].includes(actor)) throw new Error('Unknown actor');
  const model=request.model ?? (modelDefaults && actor===route.actor ? route.model : undefined);
  if(model!==undefined && (typeof model!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,59}$/.test(model.trim())))throw new Error('任务模型名格式不正确');
  const effort=request.effort ?? (modelDefaults && actor===route.actor ? route.effort : undefined);
  if(effort!==undefined && !(actor==='deepseek' ? ['off','low','high','max'] : ['low','medium','high','xhigh']).includes(effort))throw new Error('任务推理强度不适用于所选助手');
  const queue = read('work/queue.json');
  const dependencies = request.dependencies || [];
  if (!Array.isArray(dependencies) || dependencies.some(id => !queue.items.some(i => i.id === id && !i.deleted_at))) throw new Error('Unknown dependency');
  const owner=request.parent_id ? queue.items.find(i=>i.id===request.parent_id && !i.deleted_at && !isChatTurn(i)) : null;
  if(request.parent_id && !owner)throw new Error('Unknown parent operation');
  const project_ids=checkProjects(request.project_ids===undefined ? owner?.project_ids : request.project_ids);
  const sameProjects=owner && project_ids.length===owner.project_ids.length && project_ids.every(id=>owner.project_ids.includes(id));
  const plan_node_id=request.plan_node_id===undefined && sameProjects ? owner.plan_node_id : request.plan_node_id;
  const item = { id: internalId || randomUUID(), title: request.title.trim(), kind: request.kind, actor,
    project_ids, goal: String(request.goal || ''),
    sources: (request.sources || []).map(String), dependencies,
    status: request.status === 'queued' || request.status === 'open' ? request.status : actor === 'user' ? 'queued' : 'open', created_at: new Date().toISOString(), due_at: request.due_at || null,
    handoff: '', outputs: [], session_id: null,...(request.parent_id ? {parent_id:request.parent_id} : {}),
    ...(plan_node_id ? {plan_node_id:String(plan_node_id)} : {}),...(model!==undefined ? {model:model.trim()} : {}),...(effort!==undefined ? {effort} : {}) };
  noAutoStart(request);
  if (request.require_outputs !== undefined) {
    if (typeof request.require_outputs !== 'boolean') throw new Error('require_outputs must be boolean');
    item.require_outputs = request.require_outputs;
  }
  if (request.log_requirement !== undefined) { item.log_requirement = request.log_requirement; logContext(item); }
  if (item.due_at && !Number.isFinite(Date.parse(item.due_at))) throw new Error('Invalid due_at');
  const parent=taskContext(queue.items);
  const userDirected=!!queuedUserRound(parent,queue.items);
  const successor=!provenance && !autonomous && !conversationTurn && !userDirected && authorizedProjectStep(parent);
  if(provenance)item.autonomy=provenance;
  else if(successor) {
    item.delegated_by=parent.id;
    // Existing background callers pass open for L1. An admitted DAG successor
    // is queued here instead; later explicit status changes still mean what they say.
    if(item.actor!=='user')item.status='queued';
  }
  else if(autonomous || ((background || parent) && !userDirected))item.autonomy=autonomousChild(request,item,queue.items);
  else if(parent)item.delegated_by=parent.id;
  if((item.autonomy || background || parent) && item.actor==='user' && request.status===undefined)item.status='open';
  if(item.autonomy) {
    assertAutonomousState(item,queue.items);
  }
  const resultReview=reviewPolicy(request.result_review,item);
  if(resultReview)item.result_review=resultReview;
  queue.items.push(item); writeQueueWithAdmission(queue, item, conversationTurn ? null : parent); return item;
}
// Reuse drain's beat. The queue owns both source events and their one-shot planning receipt;
// no watcher, historical backfill, extra timer, model call or second workflow store.
export function planProgress(now=Date.now()) {
  const policy=autonomyPolicy();
  if(policy.level<1)return [];
  const items=read('work/queue.json').items,projects=read('projects/catalog.json').projects;
  const consumed=new Set(items.flatMap(i=>i.autonomy?.type==='plan' ? i.project_ids.flatMap(p=>i.autonomy.events.map(e=>p+':'+e.event_id)) : []));
  const created=[];
  for(const project of projects) {
    if(project.archived_at || items.some(i=>i.autonomy?.type==='plan' && i.project_ids.includes(project.id) && ['queued','active'].includes(i.status)))continue;
    // A step in a log topic waits until every step in that topic is finished (done/cancelled/failed); steps outside any topic fire alone.
    const unfinished=j=>!j.deleted_at && (['open','queued','active','waiting_user'].includes(j.status) || (j.status==='done' && resultReviewPending(j)));
    const blockPending=i=>i.plan_node_id && items.some(j=>j.id!==i.id && j.plan_node_id===i.plan_node_id && j.project_ids.includes(project.id) && unfinished(j));
    const fresh=items.filter(i=>!i.deleted_at && ['done','failed'].includes(i.status) && !i.autonomy && !i.review_target && !resultReviewPending(i) && i.project_ids.includes(project.id) && i.progress_event && !consumed.has(project.id+':'+i.progress_event.id) && !blockPending(i));
    if(!fresh.length || fresh.some(i=>now-Date.parse(i.progress_event.at)<policy.debounce_seconds*1000))continue;
    const events=fresh.map(i=>({task_id:i.id,event_id:i.progress_event.id})).sort((a,b)=>a.event_id.localeCompare(b.event_id));
    const hash=eventHash([project.id,events]),id='progress-'+hash;
    const goal=fragment('task/progress-goal', { sources: events.map(e=>e.task_id).join('、') });
    const item=enqueue({title:'项目推进 · '+project.name,kind:'framework',actor:read('agent/config.json').default_provider,
      project_ids:[project.id],status:'queued',goal,sources:events.map(e=>'work:'+e.task_id),log_requirement:null},
      {internalId:id,provenance:{type:'plan',root_id:id,event_hash:hash,events,depth:0,created_at:new Date(now).toISOString()}});
    created.push(item);
  }
  return created;
}
// Optional status summary for a conversation; operation results live in handoff/outputs.
export function normalizeBrief(raw) {
  const text = v => typeof v === 'string' ? v.trim() : '';
  const list = v => (Array.isArray(v) ? v : []).map(text).filter(Boolean);
  const facts = (Array.isArray(raw?.facts) ? raw.facts : []).map(f => ({ text: text(f?.text), source: text(f?.source) })).filter(f => f.text);
  const brief = { summary: text(raw?.summary), facts, open: list(raw?.open), next: text(raw?.next) };
  return brief.summary || brief.next || facts.length || brief.open.length ? brief : null;
}
// Status summaries use 状态摘要; keep reading the old 交接 marker for existing replies.
// Malformed JSON stays in the readable reply and creates no summary.
export function parseHandoff(text) {
  const body = String(text || ''), marker=[...body.matchAll(/^(状态摘要：|交接：)/gm)].at(-1);
  if (!marker) return { text: body, brief: null };
  const at=marker.index,rest = body.slice(at + marker[1].length), start = rest.indexOf('{'), end = rest.lastIndexOf('}');
  let brief = null;
  try { brief = normalizeBrief(JSON.parse(rest.slice(start, end + 1))); } catch { /* not a valid block: keep the reply as it is */ }
  return brief ? { text: body.slice(0, at).trim(), brief } : { text: body, brief: null };
}
// explorationRound / explorationPatch are executor-only options (never request fields): a round may only write back while the card is still that
// round's active run, so a user's stop, edit or re-open during the round is not overwritten by the old round's ending.
export function update(request,{executionOwner,userApproved=false,explorationRound,explorationPatch}={}) {
  if(request.result_review!==undefined || request.review_target!==undefined)throw new Error('成果审查在 work add 用 result_review 启用，审查状态和版本由程序记录');
  if(request.autonomy!==undefined || request.progress_event!==undefined || request.delegated_by!==undefined || request.exploration!==undefined)throw new Error('自主来源由程序记录，不能由请求设置');
  const queue = read('work/queue.json'); const index = queue.items.findIndex(i => i.id === request.id);
  if (index < 0) throw new Error('Unknown work item');
  const previous = queue.items[index], item = { ...previous };
  if (explorationRound !== undefined && (previous.status !== 'active' || previous.exploration?.round !== explorationRound))
    throw Object.assign(new Error('探索任务这一轮已被改动，旧轮结果不再写回'), { code: 'STALE_ROUND' });
  if (explorationPatch) item.exploration = { ...previous.exploration, ...explorationPatch };
  // Internal executor identity is set by the caller, never taken from an HTTP task payload.
  if(executionOwner)item.execution_owner=executionOwner;
  if (previous.deleted_at) throw new Error('该步骤已删除，不能更新');
  if (request.status && !['open','queued','active','waiting_user','done','cancelled','failed'].includes(request.status)) throw new Error('Unknown status');
  for (const field of ['status','handoff','session_id']) if (request[field] !== undefined) item[field] = String(request[field]);
  if (request.outputs) item.outputs = request.outputs.map(String);
  if (request.review) item.review = request.review;
  if (request.brief) item.brief = normalizeBrief(request.brief) || item.brief;
  if(request.parent_id!==undefined) {
    if(request.parent_id && !queue.items.some(i=>i.id===request.parent_id && i.id!==item.id && !i.deleted_at && !isChatTurn(i)))throw new Error('Unknown parent operation');
    if(request.parent_id)item.parent_id=request.parent_id;else delete item.parent_id;
  }
  if (request.actor) {
    if (!['user','codex','claude','deepseek'].includes(request.actor)) throw new Error('Unknown actor');
    if(request.actor!==item.actor){delete item.model;delete item.effort;}
    item.actor = request.actor;
  }
  noAutoStart(request);
  if (request.require_outputs !== undefined) {
    if (typeof request.require_outputs !== 'boolean') throw new Error('require_outputs must be boolean');
    item.require_outputs = request.require_outputs;
  }
  for (const field of ['goal', 'plan_node_id']) if (request[field] !== undefined) item[field] = String(request[field]);
  if (request.log_requirement !== undefined) { item.log_requirement = request.log_requirement; logContext(item); }
  const parent=taskContext(queue.items);
  const contextOperation=parent && queue.items.find(i=>i.id===(parent.operation_id || parent.id));
  if(contextOperation?.review_target?.id===item.id)throw new Error('审查者向自己的审查操作提交结果，由父级负责人整合父级成果');
  if(item.result_review && (item.parent_id || item.actor==='user'))throw new Error('已启用成果审查的操作保持为外层助手数据父级');
  const chatApproval=parent?.id!==item.id && request.status!==undefined && !!queuedUserRound(parent,queue.items);
  const explicitApproval=userApproved || chatApproval;
  if(!item.autonomy && parent?.autonomy && item.id!==parent.id && ['queued','active','done'].includes(request.status))
    throw new Error('自主任务不能启动或完成未经自主登记的旧步骤');
  if(item.autonomy && explicitApproval) {
    item.autonomy={...item.autonomy};
    if(item.status==='open') {delete item.autonomy.approved_at;delete item.autonomy.approved_by;}
    else {item.autonomy.approved_at=new Date().toISOString();item.autonomy.approved_by=chatApproval ? parent.id : 'user';}
  }
  if(request.status!==undefined)assertAutonomousState(item,queue.items,{previous:parent?.operation_id===item.id ? {...previous,status:'active'} : previous,userApproved:explicitApproval});
  if(item.autonomy && item.status==='active' && previous.status!=='active' && !item.autonomy.approved_at) {
    if(!executionOwner)throw new Error('自主步骤只能由现有执行器启动');
    if(!autonomousCanStart(item,queue.items))throw new Error('自主执行暂缓：等级、并发或每日上限');
    item.autonomy={...item.autonomy,started_at:item.autonomy.started_at || new Date().toISOString()};
  }
  if (item.status !== previous.status && ['active','done'].includes(item.status)) {
    const { blocked_by } = readiness(item, queue.items);
    if (blocked_by.length) throw new Error('前置步骤未完成：' + blocked_by.join(', '));
  }
  if (request.status === 'done' && !item.executor) validateOutcome(item);
  item.updated_at = new Date().toISOString();
  invalidateResultReview(item,previous);
  if(request.status==='done' && item.result_review) {
    const pending=pendingBranch(item.id,queue.items);
    if(pending.length)throw new Error('请在仍执行或排队的子操作返回后提交父级整合成果：'+pending.join(', '));
    submitResultForReview(item,previous,queue.items,item.updated_at);
  }
  submitReviewVerdict(item,request,queue.items,item.updated_at);
  if (item.status !== previous.status || request.status==='done') {
    item.history = [...(previous.history || []), { at:item.updated_at, from:previous.status, to:item.status, reason:String(request.reason || ''), ...(item.actor !== previous.actor ? { actor_from:previous.actor } : {}) }];
    if (item.status !== 'done') delete item.completed_at;
  }
  if(item.status === 'done' && (!item.completed_at || request.status==='done')) item.completed_at = item.updated_at;
  const event=progressEvent(item,previous,item.updated_at);
  if(event && !resultReviewPending(item) && !item.review_target)item.progress_event=event;
  queue.items[index] = item;
  // A failed operation invalidates its remaining dependent operations, not unrelated
  // siblings. Save the whole chain with its source in one queue write, before drain
  // can observe the topic as finished. Never rewrite completed work or a running assistant.
  if(item.status==='failed' && previous.status!=='failed' && !item.executor &&
    (item.kind==='experiment' || item.plan_node_id) && item.project_ids.length) {
    const affected=new Set([item.id]);
    let changed;
    do {
      changed=false;
      for(const dependent of queue.items) {
        if(dependent.deleted_at || dependent.executor || affected.has(dependent.id) ||
          !dependent.project_ids.some(p=>item.project_ids.includes(p)) ||
          !(dependent.dependencies || []).some(id=>affected.has(id)))continue;
        affected.add(dependent.id);changed=true;
        if(!['open','queued','active','waiting_user'].includes(dependent.status) ||
          (dependent.status==='active' && dependent.actor!=='user'))continue;
        const reason='前置步骤失败，后续无法继续：'+item.id+'（'+item.title+'）';
        dependent.history=[...(dependent.history || []),{at:item.updated_at,from:dependent.status,to:'failed',reason}];
        dependent.status='failed';dependent.updated_at=item.updated_at;
        delete dependent.completed_at;
      }
    } while(changed);
  }
  writeQueueWithAdmission(queue, item, item.status !== previous.status ? parent : null); return item;
}

// An explicit next execution is a turn, not a new operation or a state reset.
// Old results remain on the operation until its agent submits a new result.
export function repeatOperation(request) {
  const queue=read('work/queue.json'),operation=queue.items.find(i=>i.id===request.id && !i.deleted_at && !isChatTurn(i));
  if(!operation || !['codex','claude','deepseek'].includes(operation.actor))throw new Error('Choose an assistant operation');
  const parent=taskContext(queue.items);
  const candidate={...operation,status:'queued'};
  assertAutonomousState(candidate,queue.items,{previous:operation,userApproved:!!queuedUserRound(parent,queue.items)});
  const blocked=readiness(candidate,queue.items).blocked_by;
  if(blocked.length)throw new Error('前置步骤未完成：'+blocked.join(', '));
  const after=request.after || [];
  if(!Array.isArray(after) || after.some(id=>id===operation.id || !queue.items.some(i=>i.id===id && !i.deleted_at)))throw new Error('after 须为要等候返回的现有操作或执行 ID');
  const now=new Date().toISOString();
  const run={id:randomUUID(),operation_id:operation.id,title:operation.title,kind:operation.kind,actor:operation.actor,executor:operation.actor,
    project_ids:operation.project_ids,dependencies:[],goal:String(request.input || ''),status:'queued',created_at:now,updated_at:now,handoff:'',outputs:[],session_id:null,
    ...(after.length ? {after} : {}),...(operation.model ? {model:operation.model} : {}),...(operation.effort ? {effort:operation.effort} : {}),...(parent ? {delegated_by:parent.id} : {})};
  restartResultReview(operation,queue.items);
  queue.items.push(run);writeQueueWithAdmission(queue,run,parent);return run;
}
// Project-page edits keep execution identity, state and dispatch policy under work's ownership.
const itemRevision = item => createHash('sha256').update(JSON.stringify(item)).digest('hex');
// The execution ledger also contains chat turns. Only filed, non-cancelled steps are new choices;
// existing prerequisites remain editable even if they have since been cancelled or re-filed.
const dependencyChoices = (items, projectIds, current) => items.filter(i=>!i.deleted_at && i.id!==current?.id &&
  (current?.dependencies?.includes(i.id) || (i.plan_node_id && i.status!=='cancelled' && i.project_ids.some(p=>projectIds.includes(p)))))
  .map(i=>({id:i.id,title:i.title,project_ids:i.project_ids,status:i.status}));
// A page-created step belongs to an existing log node and never grants automatic execution.
export function newStepEditor(projectId, nodeId) {
  checkProjects([projectId]);
  const file=frameworkFile(projectId);
  const node=parseFramework(fs.readFileSync(file,'utf8')).byId.get(nodeId);
  if(!node || !node.ancestors.concat(node).some(n=>n.meta.type==='timeline'))throw new Error('操作步骤只能添加到现有时间日志板块或记录');
  return {owner:{project_id:projectId,id:node.id,title:node.title},choices:dependencyChoices(read('work/queue.json').items,[projectId])};
}
export function addStep(request) {
  const context=newStepEditor(request.project_id,request.plan_node_id);
  const allowed=new Set(context.choices.map(i=>i.id));
  if(!Array.isArray(request.dependencies || []) || (request.dependencies || []).some(id=>!allowed.has(id)))throw new Error('前置步骤必须是本项目现有的操作步骤');
  if(request.goal!==undefined && typeof request.goal!=='string')throw new Error('步骤说明格式不合适');
  return enqueue({title:request.title,goal:request.goal,actor:request.actor || 'user',kind:'framework',project_ids:[request.project_id],plan_node_id:request.plan_node_id,dependencies:[...new Set(request.dependencies || [])],status:'open'});
}
// The user's hand on a step's state chip. Executors keep calling update(); only this path changes the operator.
// The status alone decides whether an assistant step starts: 未开始 (open) never runs; 待办 (queued) with an assistant operator runs once its predecessors are done.
// Marking 正在进行／完成／失败 by hand means the user is doing it, so the operator becomes the user; the old operator is kept in history.
export function setStepStatus(request) {
  const previous=read('work/queue.json').items.find(i=>i.id===request.id && !i.deleted_at);
  if(!previous)throw new Error('该步骤已不存在');
  if(!['open','queued','active','done','failed'].includes(request.status))throw new Error('步骤状态不合法');
  if(request.status===previous.status)return previous;
  const dispatched=read('.runtime/agent/sessions.json',{sessions:[]}).sessions.some(s=>s.task_ids.includes(previous.id));
  if(previous.actor!=='user' && (previous.status==='active' || (previous.status==='queued' && dispatched)))throw new Error('助手正在执行或已接手这一步，不能手动改状态；请在对话里让她停止');
  const patch={id:previous.id,status:request.status,reason:request.reason,handoff:request.handoff,outputs:request.outputs};
  if(request.status==='queued') {
    const actor=request.actor ?? (previous.status==='open' ? undefined : previous.actor);
    if(!['user','codex','claude','deepseek'].includes(actor))throw new Error('设为待办要先指定操作对象');
    patch.actor=actor;
  } else if(['active','done','failed'].includes(request.status) && previous.actor!=='user') patch.actor='user';
  return update(patch,{userApproved:true});
}
export function stepEditor(id) {
  const queue=read('work/queue.json'),item=queue.items.find(i=>i.id===id && !i.deleted_at);
  if(!item)throw new Error('该步骤已不存在');
  return {item,revision:itemRevision(item),choices:dependencyChoices(queue.items,item.project_ids,item)};
}
export function editStep(request) {
  const queue=read('work/queue.json'),index=queue.items.findIndex(i=>i.id===request.id && !i.deleted_at);
  if(index<0)throw new Error('该步骤已不存在');
  const previous=queue.items[index];
  if(request.revision!==itemRevision(previous))throw new Error('步骤已被其他操作更新，未覆盖；请保留草稿并重新打开核对');
  const dispatched=read('.runtime/agent/sessions.json',{sessions:[]}).sessions.some(s=>s.task_ids.includes(previous.id));
  if(previous.status==='active' || (previous.status==='queued' && dispatched))throw new Error('步骤正在执行或已交给助手，请先停止再编辑或删除');
  const item={...previous},now=new Date().toISOString();
  if(request.action==='delete') {
    if(request.confirm!==true)throw new Error('请确认删除这一步');
    const users=queue.items.filter(i=>!i.deleted_at && i.dependencies?.includes(item.id));
    if(users.length)throw new Error('仍被前置依赖引用，请先调整这些步骤：'+users.map(i=>i.title).join('、'));
    item.deleted_at=now;item.status='cancelled';
    item.history=[...(item.history || []),{at:now,from:previous.status,to:'cancelled',reason:'用户在项目页删除步骤（记录保留）'}];
  } else if(request.action==='content') {
    for(const key of ['title','goal','handoff'])if(request[key]!==undefined) {
      if(typeof request[key]!=='string')throw new Error(key+' 格式不合适');
      item[key]=request[key].trim();
    }
    if(!item.title)throw new Error('步骤标题不能为空');
    if(request.actor!==undefined) {
      if(!['user','codex','claude','deepseek'].includes(request.actor))throw new Error('负责人不合法');
      if(request.actor!==item.actor){delete item.model;delete item.effort;}
      item.actor=request.actor;
    }
    if(request.dependencies!==undefined) {
      const allowed=new Set(dependencyChoices(queue.items,previous.project_ids,previous).map(i=>i.id));
      if(!Array.isArray(request.dependencies) || request.dependencies.some(id=>typeof id!=='string' || (id!==item.id && !allowed.has(id))))throw new Error('前置步骤不存在或不属于本项目可选的操作步骤');
      item.dependencies=[...new Set(request.dependencies)];
      const reaches=(id,seen=new Set())=>{if(id===item.id)return true;if(seen.has(id))return false;seen.add(id);return (queue.items.find(i=>i.id===id)?.dependencies || []).some(d=>reaches(d,seen));};
      if(item.dependencies.some(id=>reaches(id)))throw new Error('前置依赖不能指向自己或形成循环');
      if(item.status==='done' && readiness(item,queue.items).blocked_by.length)throw new Error('已完成步骤不能改为依赖尚未完成的步骤');
    }
    if(item.status==='done')validateOutcome(item);
  } else throw new Error('未知步骤编辑动作');
  invalidateResultReview(item,previous);
  if(JSON.stringify(item)===JSON.stringify(previous))return item;
  item.updated_at=now;
  backupQueue();
  queue.items[index]=item;write('work/queue.json',queue);return item;
}
function backupQueue() {
  const dir=path.join(root,'.runtime/work-edits');fs.mkdirSync(dir,{recursive:true});
  const original=fs.readFileSync(path.join(root,'work/queue.json'));
  const backup=path.join(dir,createHash('sha256').update(original).digest('hex')+'.json');
  if(!fs.existsSync(backup))fs.writeFileSync(backup,original);
}
// Drag in the project page: re-file steps under another log node (request.ids moves a whole step list, in its current order),
// or put one step next to a sibling step (before/after). Only the grouping changes; status, operator, dependencies and files stay with
// the step. Re-filed steps are appended after the target node's existing steps. If any step is running or already handed to an assistant, none move.
export function moveStep(request) {
  const queue=read('work/queue.json'),ids=request.ids ?? [request.id];
  if(!Array.isArray(ids) || !ids.length || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length)throw new Error('要移动的步骤格式不对');
  const at=id=>queue.items.findIndex(i=>i.id===id && !i.deleted_at);
  if(ids.some(id=>at(id)<0))throw new Error('该步骤已不存在');
  const moving=ids.map(id=>queue.items[at(id)]).sort((x,y)=>queue.items.indexOf(x)-queue.items.indexOf(y));
  if(moving.some(i=>!i.project_ids.includes(request.project_id)))throw new Error('步骤不属于这个项目');
  const handed=read('.runtime/agent/sessions.json',{sessions:[]}).sessions;
  const busy=moving.find(i=>i.status==='active' || (i.status==='queued' && handed.some(x=>x.task_ids.includes(i.id))));
  if(busy)throw new Error('步骤「'+busy.title+'」正在执行或已交给助手，请先停止再移动');
  const ref=request.before || request.after;
  if(request.before && request.after)throw new Error('只能指定 before 或 after 其中一个');
  if(ref && moving.length>1)throw new Error('整组步骤只能整体移到某个节点，不能指定前后位置');
  const sibling=ref ? queue.items.find(i=>i.id===ref && !i.deleted_at && i.project_ids.includes(request.project_id)) : null;
  if(ref && (!sibling || sibling.id===moving[0].id))throw new Error('定位对象必须是本项目的其他操作步骤');
  const nodeId=ref ? sibling.plan_node_id : request.plan_node_id;
  newStepEditor(request.project_id,nodeId);
  if(!ref && moving.every(i=>i.plan_node_id===nodeId))return request.ids ? moving : moving[0];
  const now=new Date().toISOString(),moved=moving.map(i=>({...i,plan_node_id:nodeId,...(i.plan_node_id!==nodeId ? {updated_at:now} : {})}));
  const rest=queue.items.filter(i=>!ids.includes(i.id));
  let place;
  if(ref)place=rest.findIndex(i=>i.id===ref)+(request.after ? 1 : 0);
  else {
    const last=rest.map(i=>i.plan_node_id===nodeId && i.project_ids.includes(request.project_id)).lastIndexOf(true);
    place=last>=0 ? last+1 : queue.items.indexOf(moving[0]);
  }
  rest.splice(place,0,...moved);queue.items=rest;
  backupQueue();
  write('work/queue.json',queue);return request.ids ? moved : moved[0];
}
export function renderPlan() {
  const policy = read('work/policy.json'); const queue = read('work/queue.json');
  const lines = ['# 工作分工与当前安排', '', '这是默认分工，可按任务改负责人。登记助手任务默认是「未开始」，不会调用模型；改成「待办」后，前置全部完成时由工作台执行一次，失败或等待用户不会自动重试。', '',
    '| 工作 | 默认负责人 | 负责内容 | 触发 |', '|---|---|---|---|'];
  const actors = { user:'你', codex:'Codex', claude:'Claude', deepseek:'DeepSeek' };
  for (const p of policy.defaults) lines.push(`| ${p.kind} | ${actors[p.actor]} | ${p.scope} | ${p.mode} |`);
  lines.push('', '## 当前任务', '');
  for (const i of queue.items.filter(i => !['done','cancelled'].includes(i.status)))
    lines.push(`- ${i.title} — ${actors[i.actor]} / ${i.status}; ${i.project_ids.join(', ') || '待关联'}; ${i.id}`);
  if (!queue.items.some(i => !['done','cancelled'].includes(i.status))) lines.push('尚无新提交的工作请求；邮箱行动仍从邮箱原账本读取，不复制到此队列。');
  const mailFile=path.join(root,'.runtime/mail-flow/mail.sqlite');
  if(fs.existsSync(mailFile)) {
    const db=new DatabaseSync(mailFile,{readOnly:true});
    try {
      const purchases=new Set(read('procurement/catalog.json',{requests:[]}).requests.map(r=>r.mail_task_id));
      const cell=value=>String(value || '').replace(/[|\r\n]/g,' ');
      lines.push('','## 邮箱当前安排（生成时快照）','',
        '默认协助人是工作分配建议，尚未自动执行；实际实验/平台完成情况仍需来源证据。工作台从原账本读取最新行动。','',
        '| 事项 | 默认协助 | 当前下一步 | 复查 |','|---|---|---|---|');
      for(const task of db.prepare("SELECT id,title,action,check_at FROM tasks WHERE status!='done' ORDER BY check_at").all())
        lines.push(`| ${cell(task.title)} | ${purchases.has(task.id) ? 'Codex' : 'Claude'} | ${cell(task.action)} | ${cell(task.check_at)} |`);
    } finally {db.close();}
  }
  lines.push('', '两 AI 对话：用 @Codex、@Claude 指定；回复里行首的 @对方 会把话转给对方，每条消息最多 4 轮发言。',
    '换对话：新任务或阶段交付后保存短交接，再开新会话；正在排查同一错误时继续当前会话。', '');
  const file = path.join(root, '.runtime/work/plan.md'); fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, lines.join('\n')); return file;
}
// One-time move of chat-turn records out of queue.json into turns.json (see automation/files.mjs). Run at backend start, when no old-code process is
// still using the single file; a copy of the old queue.json is kept in .runtime/work-edits. Safe to repeat.
export function splitQueue() {
  if (fs.existsSync(path.join(root, 'work/turns.json'))) return { split: false };
  const queue = read('work/queue.json'), dir = path.join(root, '.runtime/work-edits');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'work/queue.json'), path.join(dir, 'queue-before-split-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'));
  write('work/turns.json', { version: queue.version, items: queue.items.filter(isTurnRecord) });
  write('work/queue.json', queue);
  return { split: true, steps: queue.items.filter(i => !isTurnRecord(i)).length, turns: queue.items.filter(isTurnRecord).length };
}
export async function run(action, argument) {
  if (action === 'list') {
    if (argument==='full') console.log(JSON.stringify(workSnapshot(), null, 2));
    else if (argument==='all') printLines(workDigest());
    else if (argument) printLines(workDetail(argument));
    else console.log(JSON.stringify(workOverview(), null, 2));
  }
  else if (action === 'add') console.log(JSON.stringify(enqueue(input(argument),{background:true})));
  else if (action === 'update') console.log(JSON.stringify(update(input(argument))));
  else if (action === 'run') console.log(JSON.stringify(repeatOperation(input(argument))));
  else if (action === 'editor') console.log(JSON.stringify(stepEditor(argument)));
  else if (action === 'edit') console.log(JSON.stringify(editStep(input(argument))));
  else if (action === 'plan') console.log(renderPlan());
  else if (action === 'split') console.log(JSON.stringify(splitQueue()));
  else if (action === 'handoff') {
    const items = workSnapshot().items, matches = items.filter(i => i.id === argument);
    if (!matches.length && /^[0-9a-f-]{8,}$/i.test(argument || '')) matches.push(...items.filter(i => i.id.startsWith(argument)));
    if (matches.length > 1) throw new Error('任务 id 前缀不唯一，请多写几位');
    const item = matches[0];
    if (!item) throw new Error('Unknown task');
    console.log(JSON.stringify(item, null, 2));
  } else throw new Error('work: list, add <json>, update <json>, editor <id>, edit <json>, plan, handoff <id>, split');
}
