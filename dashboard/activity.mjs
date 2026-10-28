import {toolSummary} from '../agent/tool-summary.mjs';
export function runningSubagents(agent,items) {
  const active=new Set(items.filter(i=>i.status==='active' && !i.merged_into && !i.deleted_at).map(i=>i.id));
  const live=new Map(agent.active_turns.map(t=>[t.task_id,t.provider]));
  return agent.sessions.flatMap(s=>(s.activity || []).filter(e=>e.type==='subagent' && e.status==='running' && active.has(e.task_id) && (!live.has(e.task_id) || live.get(e.task_id)===e.provider))
    .map(e=>({task_id:e.task_id,provider:e.provider,agent_id:e.agent_id})));
}
// Tool events, not another session list: every pending call plus six recent
// returns/unknown outcomes. Raw tool inputs remain in the agent store.
export function executionRows(agent,items) {
  const tasks=new Map(items.filter(i=>!i.merged_into && !i.deleted_at).map(i=>[i.id,i]));
  const live=new Map(agent.active_turns.map(t=>[t.task_id,t.provider]));
  const rows=agent.sessions.flatMap(s=>(s.activity || []).filter(e=>e.type==='tool' && tasks.has(e.task_id)).map((e,index)=>{
    const task=tasks.get(e.task_id);
    const running=e.status==='running' && task.status==='active' && (!live.has(task.id) || live.get(task.id)===e.provider);
    return {key:`${task.id}:${e.tool_id || e.at+':'+index}`,task_id:task.id,session_id:s.id,task_title:task.title,provider:e.provider || task.executor || task.actor,
      event:e,tool_id:e.tool_id,name:e.name,at:e.at,finished_at:e.finished_at,heartbeat_at:e.heartbeat_at,
      status:running ? 'running' : e.finished_at ? e.status : 'unknown',task_status:task.status};
  }));
  const pending=rows.filter(r=>r.status==='running').sort((a,b)=>a.at.localeCompare(b.at));
  const recent=rows.filter(r=>r.status!=='running').sort((a,b)=>(b.finished_at || b.at).localeCompare(a.finished_at || a.at)).slice(0,6);
  return [...pending,...recent].map(({event,...row})=>({...row,summary:event.summary || toolSummary(event.name,event.detail || {})}));
}
