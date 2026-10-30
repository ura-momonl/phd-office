// Opt-in review of an outer data operation's integrated delivery. Review is a
// sibling in the outer DAG; it does not define or take over the operation's DCG.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root} from '../automation/files.mjs';
import {fragment} from '../prompts/compose.mjs';

const assistants=['codex','claude','deepseek'];
export const resultReviewPending=item=>!!item?.result_review && item.result_review.state!=='accepted';
export const resultReviewLabel=item=>({configured:'待提交成果审查',pending:'待独立审查',pass:'待父级整合',revise:'待父级返工'})[item?.result_review?.state] || '';

export function reviewPolicy(raw,item) {
  if(raw===undefined || raw===false)return null;
  const config=raw===true ? {} : raw;
  if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>!['actor','model','effort'].includes(k)))
    throw new Error('result_review 使用 true 或 {actor?,model?,effort?}');
  if(item.kind!=='data' || !assistants.includes(item.actor) || item.parent_id || item.executor || item.operation_id || item.review_target || item.autonomy)
    throw new Error('成果审查用于已授权的外层数据父级操作，不用于聊天、子 DCG 或自主后台任务');
  const actor=config.actor || item.actor;
  if(!assistants.includes(actor))throw new Error('成果审查者须为 Codex、Claude 或 DeepSeek');
  if(config.model!==undefined && (typeof config.model!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,59}$/.test(config.model)))throw new Error('审查模型名格式不正确');
  if(config.effort!==undefined && !(actor==='deepseek' ? ['off','low','high','max'] : ['low','medium','high','xhigh']).includes(config.effort))throw new Error('审查推理强度不适用于所选助手');
  return {actor,...(config.model ? {model:config.model} : {}),...(config.effort ? {effort:config.effort} : {}),state:'configured'};
}

const sha=value=>createHash('sha256').update(value).digest('hex');
function contentHash(file) {
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())throw new Error('成果审查请引用实际成果路径，不使用符号链接：'+file);
  if(stat.isFile())return sha(fs.readFileSync(file));
  if(!stat.isDirectory())throw new Error('成果不是普通文件或目录：'+file);
  return sha(JSON.stringify(fs.readdirSync(file).sort().map(name=>[name,contentHash(path.join(file,name))])));
}
export function reviewSnapshot(item,items=[]) {
  const reviews=new Set(items.filter(i=>i.review_target?.id===item.id).map(i=>i.id));
  const latest=items.findLast(i=>i.operation_id===item.id && !i.source_task_id && !i.review_return_for && !(i.after || []).some(id=>reviews.has(id)));
  const snapshot={title:item.title,goal:item.goal,sources:item.sources || [],handoff:item.handoff,
    direction:latest?.goal || '',origin:latest?.delegated_by || item.delegated_by || item.id,
    outputs:(item.outputs || []).map(file=>({path:file,sha256:contentHash(path.resolve(root,file))}))};
  return {snapshot,revision:sha(JSON.stringify(snapshot))};
}
const sameMeaning=(a,b)=>['title','goal','handoff','outputs','sources'].every(key=>JSON.stringify(a[key])===JSON.stringify(b[key]));
export function invalidateResultReview(item,previous) {
  if(item.result_review?.revision && !sameMeaning(item,previous)) {
    item.result_review={...item.result_review,state:'configured'};
    delete item.progress_event;
  }
}

function retireQueuedReview(policy,items,now) {
  if(!policy.review_id)return;
  for(const old of items)if((old.id===policy.review_id || old.review_return_for===policy.review_id) && ['open','queued'].includes(old.status)) {
    old.history=[...(old.history || []),{at:now,from:old.status,to:'cancelled',reason:'父级已提交另一版成果'}];
    old.status='cancelled';old.updated_at=now;
  }
}

// Navigation from frozen submissions, not an AI summary or an approval shortcut.
// Do not read the previous files again: they may have changed or been removed.
function reviewChanges(item,items,snapshot) {
  const prior=items.findLast(i=>!i.deleted_at && i.review_target?.id===item.id &&
    i.status==='done' && ['pass','revise'].includes(i.review_verdict));
  if(!prior)return '';
  const before=prior.review_target.snapshot;
  const oldFiles=new Map(before.outputs.map(o=>[o.path,o.sha256]));
  const newFiles=new Map(snapshot.outputs.map(o=>[o.path,o.sha256]));
  const added=snapshot.outputs.filter(o=>!oldFiles.has(o.path)).map(o=>o.path);
  const changed=snapshot.outputs.filter(o=>oldFiles.has(o.path) && oldFiles.get(o.path)!==o.sha256).map(o=>o.path);
  const removed=before.outputs.filter(o=>!newFiles.has(o.path)).map(o=>o.path);
  const unchanged=snapshot.outputs.length-added.length-changed.length;
  return fragment('task/result-review-changes',{id:prior.id,revision:prior.review_target.revision,verdict:prior.review_verdict,
    evidence:prior.outputs.join('\n') || '见该操作的 handoff',
    fields:['title','goal','sources','handoff','direction'].filter(k=>JSON.stringify(before[k])!==JSON.stringify(snapshot[k])).join('、') || '无',
    added:added.join('\n') || '无',changed:changed.join('\n') || '无',removed:removed.join('\n') || '无',unchanged});
}

// Called inside work.update's one queue transaction. The existing dispatcher and
// after-return mechanism own execution; no new polling or retry engine.
export function submitResultForReview(item,previous,items,now) {
  const policy=item.result_review;
  if(!policy || item.review_target)return;
  const {snapshot,revision}=reviewSnapshot(item,items);
  if(previous.result_review?.revision===revision) {
    const state=previous.result_review.state;
    if(state==='pass') {
      const live=items.some(i=>!i.deleted_at && (i.id===policy.review_id || i.operation_id===policy.review_id) && ['queued','active'].includes(i.status));
      if(live)throw new Error('本版成果的审查仍在执行，待实际返回后再整合');
      item.result_review={...policy,state:'accepted',accepted_at:now};
    } else if(state==='revise')throw new Error('本版审查要求返工；请修订成果，或带具体证据接续原审查操作');
    else if(state!=='configured')item.result_review={...policy,state}; // Repeated delivery does not create another reviewer.
    if(state!=='configured')return;
  }
  retireQueuedReview(previous.result_review || {},items,now);
  const changes=reviewChanges(item,items,snapshot);
  const id=randomUUID(),returnId=randomUUID();
  const reviewer={id,title:'成果审查 · '+item.title,kind:'data',actor:policy.actor,
    project_ids:[...item.project_ids],...(item.plan_node_id ? {plan_node_id:item.plan_node_id} : {}),
    sources:[...new Set(['work:'+item.id,'work:'+snapshot.origin])],
    dependencies:[item.id],status:'queued',created_at:now,updated_at:now,handoff:'',outputs:[],session_id:null,
    require_outputs:true,delegated_by:item.id,
    ...(policy.model ? {model:policy.model} : {}),...(policy.effort ? {effort:policy.effort} : {}),
    review_target:{id:item.id,revision,snapshot},
    goal:fragment('task/result-review',{id:item.id,revision,goal:item.goal,direction:snapshot.direction || '无额外接续方向',
      origin:'work handoff '+snapshot.origin,
      handoff:item.handoff,outputs:[snapshot.outputs.map(o=>o.path+'  SHA256='+o.sha256).join('\n'),changes].filter(Boolean).join('\n\n')})};
  const returned={id:returnId,operation_id:item.id,title:item.title,kind:item.kind,actor:item.actor,executor:item.actor,
    project_ids:[...item.project_ids],dependencies:[],after:[id],review_return_for:id,
    status:'queued',created_at:now,updated_at:now,handoff:'',outputs:[],session_id:null,delegated_by:item.id,
    ...(item.model ? {model:item.model} : {}),...(item.effort ? {effort:item.effort} : {}),
    goal:fragment('task/result-review-return',{id,revision})};
  items.push(reviewer,returned);
  item.result_review={actor:policy.actor,...(policy.model ? {model:policy.model} : {}),...(policy.effort ? {effort:policy.effort} : {}),state:'pending',review_id:id,revision};
  delete item.progress_event;
}

export function restartResultReview(operation,items) {
  if(operation.result_review?.state==='accepted')operation.result_review={...operation.result_review,state:'configured'};
  if(!operation.review_target)return;
  const target=items.find(i=>i.id===operation.review_target.id && !i.deleted_at);
  if(!target || target.result_review?.review_id!==operation.id)throw new Error('这份审查已被父级的新版本替代');
  target.result_review={...target.result_review,state:'pending'};
  delete operation.review_verdict;
}

export function submitReviewVerdict(item,request,items,now) {
  if(request.review_verdict!==undefined && !item.review_target)throw new Error('review_verdict 只用于独立成果审查操作');
  if(!item.review_target || request.status!=='done') {
    if(request.review_verdict!==undefined)throw new Error('review_verdict 与本次 status:done 一起提交');
    return;
  }
  if(!['pass','revise'].includes(request.review_verdict))throw new Error('成果审查完成时请明确 review_verdict:pass 或 revise');
  const target=items.find(i=>i.id===item.review_target.id && !i.deleted_at);
  if(!target || target.status!=='done' || target.result_review?.review_id!==item.id ||
    target.result_review.revision!==item.review_target.revision || reviewSnapshot(target,items).revision!==item.review_target.revision)
    throw new Error('审查对应的父级成果版本已变化，请由父级重新提交本版成果');
  item.review_verdict=request.review_verdict;
  target.result_review={...target.result_review,state:request.review_verdict,reviewed_at:now};
  target.updated_at=now;
}
