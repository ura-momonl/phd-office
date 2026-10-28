import {agentUpdates,sessionBranch} from './workspace.js';

const pages=new Set(['chat','history','tasks','inbox','projects','weekly','board','usage','connections','mail','procurement','instruments','literature','prompts','skills']);
// Page projection: stores and the full snapshot remain authoritative.
// The UI receives an index, not pretend/truncated conversation bodies. A selected
// chat includes its complete messages; work/usage details follow the visible page.
export function splitState(s,{page,sessionId='',taskQuery=''}={}) {
  if(!pages.has(page))throw new Error('Unknown state page');
  const conversation=['chat','history','tasks'].includes(page);
  const updates=new Map();
  for(const update of agentUpdates(s)){
    if(!updates.has(update.sessionId))updates.set(update.sessionId,[]);
    updates.get(update.sessionId).push({...update,text:update.text});
  }
  const query=taskQuery.trim().toLocaleLowerCase();
  const names=ids=>(ids || []).map(id=>s.projects.find(p=>p.id===id)?.name || id).join(' · ') || '共享工作';
  const taskSearchIds=page==='tasks' && query ? s.agent.sessions.filter(session=>session.origin==='task' &&
    [session.title,names(session.project_ids),...(session.messages || []).flatMap(m=>[m.text,...(m.attachments || []).map(a=>a.name)])]
      .join('\n').toLocaleLowerCase().includes(query)).map(session=>session.id) : [];
  // A conversation an assistant started with `agent handoff` shows inside the conversation that started it, not in the lists.
  // Orphans (parent deleted) have no parent_id and stay in the lists.
  const known=new Set(s.agent.sessions.map(x=>x.id));
  const parentOf=session=>{const first=session.messages?.[0];return first?.role==='handoff' && known.has(first.handoff?.session_id) && first.handoff.session_id!==session.id ? first.handoff.session_id : '';};
  const inline=new Set(sessionBranch(s.agent.sessions.map(x=>({id:x.id,parent_id:parentOf(x)})),sessionId).map(x=>x.id));
  const sessions=s.agent.sessions.map(session=>{
    const messages=session.messages || [],visible=messages.filter(m=>!m.interim),last=visible.at(-1),parent_id=parentOf(session);
    return {id:session.id,title:session.title,origin:session.origin,...(parent_id ? {parent_id,handoff_task_id:messages[0].handoff.task_id} : {}),pinned:session.pinned===true,project_ids:session.project_ids,task_ids:session.task_ids,created_at:session.created_at,
      ...(session.workdir ? {workdir:session.workdir} : {}),
      last_at:messages.at(-1)?.at || '',message_count:visible.length,
      preview:last?.text || last?.attachments?.map(a=>a.name).join(' · ') || '暂无消息',
      inbox_ids:[...new Set(messages.map(m=>m.inbox_reply?.id).filter(Boolean))],updates:page==='projects' ? updates.get(session.id) || [] : (updates.get(session.id) || []).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,1),
      ...(page==='chat' && session.id===sessionId ? {messages,context:session.context,questions:session.questions,subagent_runs:session.subagent_runs || []} : page==='chat' && inline.has(session.id) ? {messages,questions:session.questions} : {})};
  });
  const detail=page==='projects';
  const selected=new Set([sessionId,...inline].flatMap(id=>s.agent.sessions.find(x=>x.id===id)?.task_ids || []));
  const liveOnly=conversation || ['board','weekly','connections','mail','procurement','instruments','literature','prompts','skills'].includes(page);
  const live=i=>['queued','active'].includes(i.status) || (!i.operation_id && ['queued','active'].includes(i.last_execution?.status));
  const resumable=i=>page==='board' && !i.operation_id && i.status==='open' && i.last_execution?.status==='done' && i.last_execution.outcome_status==='open';
  const needed=new Set(s.work.items.filter(i=>live(i) || resumable(i)).flatMap(i=>[...(i.blocked_by || []),...(i.parent_id ? [i.parent_id] : [])]));
  const tasks=liveOnly ? s.work.items.filter(i=>(page!=='board' || !i.operation_id) && (live(i) || resumable(i) || needed.has(i.id) || (page==='chat' && selected.has(i.id)))) : s.work.items;
  const items=detail ? tasks : tasks.map(item=>{
    const {goal,handoff,brief,history,sources,...summary}=item;
    // A selected chat shows each reply's 交接 block under the message, so its (short) brief ships with it.
    return page==='chat' && brief && selected.has(item.id) ? {...summary,brief} : summary;
  });
  const inboxIds=new Set(s.inbox.map(i=>i.source_id));
  return {...s,ui:{page,session_id:sessionId,task_query:query},task_search_ids:taskSearchIds,
    agent:{...s.agent,sessions},work:{...s.work,items},
    usage:{...s.usage,runs:page==='usage' ? s.usage.runs : s.usage.runs.filter(r=>inboxIds.has(r.id))}};
}
