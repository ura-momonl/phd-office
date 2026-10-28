import {ico} from './icons.js';
import {esc,when} from './format.js';
const actor={codex:'Codex',claude:'Claude',deepseek:'DeepSeek',user:'用户',program:'程序'};
const labels={approval:'需要审批',acceptance:'需要验收',decision:'需要你判断'};
const status={queued:'待执行',active:'进行中',waiting_user:'等你处理',done:'已交付',failed:'被阻塞',cancelled:'已中止'};
const kind={cad:'设计与仿真',data:'数据分析',literature:'文献',presentation:'汇报',procurement:'采购',experiment:'实验',mail:'邮件',framework:'工作流程',misc:'杂事'};
// The board shows no text at all for a missing timestamp, unlike the chat lists' dash.
const time=t=>when(t,'');
const projectNames=(s,ids)=>ids?.map(id=>s.projects.find(p=>p.id===id)?.name || id).join(' · ') || '未关联项目';
// Indexes retain the immediate parent; consumers share one traversal for the
// whole handoff chain, including its root, without changing stored task states.
export function sessionBranch(sessions,sessionId) {
  const children=new Map();
  for(const s of sessions) {
    if(!children.has(s.parent_id))children.set(s.parent_id,[]);
    children.get(s.parent_id).push(s);
  }
  const root=sessions.find(s=>s.id===sessionId),branch=root ? [root] : [],seen=new Set(root ? [root.id] : []);
  for(let i=0;i<branch.length;i++)for(const child of children.get(branch[i].id) || [])if(!seen.has(child.id)) {
    seen.add(child.id);branch.push(child);
  }
  return branch;
}
// The execution rail shares the existing UI module/asset boundary, including
// the reload notice while an older backend is still finishing active tasks.
export function renderExecutions(rows,now=Date.now()) {
  const age=at=>Number.isFinite(Date.parse(at)) ? Math.max(0,Math.floor((now-Date.parse(at))/1000)) : null;
  const duration=seconds=>seconds===null ? '耗时未知' : seconds<60 ? `${seconds} 秒` : seconds<3600 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`;
  const toolName=name=>({commandExecution:'命令',fileChange:'修改文件'}[name] || name || '工具');
  if(!rows || rows.some(r=>'tools' in r))return '<p class="empty-small">活动详情需在任务结束后重启后端加载。</p>';
  if(!rows.length)return '<p class="empty-small">暂无工具活动。没有工具调用不代表 agent 已停止。</p>';
  return rows.map(row=>{
    const running=row.status==='running',seconds=age(row.at),long=running && seconds>=180;
    const elapsed=row.finished_at && Number.isFinite(Date.parse(row.at)) ? duration(Math.max(0,Math.floor((Date.parse(row.finished_at)-Date.parse(row.at))/1000))) : '未知';
    const progress=running ? `等待返回 ${duration(seconds)}${long ? ' · 长时间未返回' : ''}${row.heartbeat_at ? ' · 心跳 '+duration(age(row.heartbeat_at))+'前' : ''}` : row.finished_at ? `${row.status==='failed'?'工具报错':'工具已返回'} · 耗时 ${elapsed} · ${duration(age(row.finished_at))}前` : `${row.task_status==='cancelled'?'任务已停止 · ':''}${duration(seconds)}前开始 · 返回状态未确认`;
    return `<div class="activity-item${long ? ' activity-warning' : ''}" data-execution-task="${esc(row.task_id)}" data-execution-tool="${esc(row.tool_id || row.key)}"><small>${esc(actor[row.provider] || row.provider || '助手')} · ${esc(toolName(row.name))}</small><button class="text-button execution-title" data-session="${esc(row.session_id)}" title="打开会话：${esc(row.task_title)}">${esc(row.summary || '工具未提供动作详情')} ↗</button><small class="execution-tool">${esc(progress)}</small></div>`;
  }).join('')+'<p class="empty-small execution-note">等待中的调用置顶，下方为最近 6 条工具活动。满 3 分钟标黄≠卡死；心跳≠进展。后台子进程不在此追踪。</p>';
}
// The key of the detail dialog behind a card; the project reminder has no source to show.
const reviewKey=i=>i.source==='link' ? 'mail:'+i.source_id : i.source==='project' || i.source==='calendar' ? '' : i.id;
function actionButtons(item) {
  // Only the decisions are solid buttons; discussion is one click away as a quiet link. The title opens the full basis, so no review button is drawn.
  const actions=(item.actions || []).filter(a=>a.type!=='review');
  // A card that already has a conversation goes back into it; only a card without one starts a new chat.
  if(!actions.some(a=>a.type==='compose'))actions.push({id:'discuss',type:'compose',label:item.session_id ? '进入对话' : '和 agent 交流'});
  const button=(action,cls)=>{
    const attr=action.type==='review' ? `data-review="${esc(reviewKey(item))}" data-card="${esc(item.id)}"` : action.type==='accept' ? `data-ack="${esc(item.id)}"` : action.type==='compose' ? `data-inbox-chat="${esc(item.id)}"` : action.type==='nav' ? `data-page="${esc(action.page)}"` : action.type==='link' ? `data-link="${esc(item.id)}" data-decision="${esc(action.decision)}"` : `data-inbox-response="${esc(item.id)}" data-action-id="${esc(action.id)}"`;
    return `<button class="${cls}" title="${esc(action.label)}" ${attr}>${esc(action.label)}</button>`;
  };
  const quiet=a=>a.type==='compose';
  const main=actions.filter(a=>!quiet(a)),rest=actions.filter(quiet);
  return main.map((a,index)=>button(a,(index===0 ? 'primary' : 'secondary')+' small')).join('')+`<div class="quiet-actions">${rest.map(a=>button(a,'text-button')).join('')}</div>`;
}

// The conversation behind a card: the one the card was handed to, or the one executing the task it stands for.
export const sessionOf=(s,item)=>(s.agent?.sessions || []).filter(x=>x.inbox_ids?.includes(item.id) || x.messages?.some(m=>m.inbox_reply?.id===item.id) || (item.source==='work' && x.task_ids?.includes(item.source_id)))
  .sort((a,b)=>String(b.last_at || b.messages?.at(-1)?.at || '').localeCompare(String(a.last_at || a.messages?.at(-1)?.at || '')))[0];
// A card handed to an agent leaves the inbox until she answers, so a card still being worked on is listed here with its way in.
function handedOff(s) {
  const open=new Set(s.inbox.map(i=>i.id));
  const live=x=>s.work.items.some(j=>x.task_ids?.includes(j.id) && ['active','queued'].includes(j.status) && !j.merged_into);
  const rows=(s.agent?.sessions || []).filter(x=>x.origin==='task' && live(x) && !(x.inbox_ids?.some(id=>open.has(id)) || x.messages?.some(m=>open.has(m.inbox_reply?.id))))
    .map(x=>`<div class="handed-row"><span>${esc(x.title)}<small>${esc(projectNames(s,x.project_ids))} · agent 正在处理</small></span><button type="button" class="text-button" data-session="${esc(x.id)}">进入对话 ↗</button></div>`);
  return rows.length ? `<section class="inbox-group handed-group"><h2>正在处理 <span>${rows.length}</span></h2>${rows.join('')}</section>` : '';
}
export function inboxView(s,filter) {
  const count=s.inbox.length,items=s.inbox.filter(i=>!filter || i.kind===filter).map(i=>({...i,session_id:sessionOf(s,i)?.id}));
  const minutes=s.inbox.map(i=>Number(i.estimated_minutes)).filter(n=>n>0);
  const summary=['审批','验收','判断'].map((title,index)=>`${title} ${s.inbox.filter(i=>i.kind===['approval','acceptance','decision'][index]).length} 项`).join(' · ');
  const groups=['approval','acceptance','decision'].filter(k=>!filter || filter===k).map(k=>{
    const group=items.filter(i=>i.kind===k);if(!group.length)return '';
    return `<section class="inbox-group group-${k}"><h2>${labels[k]} <span>${group.length}</span></h2>${group.map(i=>{
      const run=s.usage.runs.findLast(r=>r.id===i.source_id);
      const reason=i.reason || (i.status==='failed' ? '执行受阻，需要处理' : k==='acceptance' ? '交付已生成，等待验收' : k==='approval' ? '方案等待你确认' : i.actor==='user' ? '需要你现场完成' : '');
      const urgency=i.priority!=='normal' ? `<span class="pill tone-amber">${i.priority==='urgent' ? '紧急' : '优先'}</span>` : '';
      const metadata=[i.source==='mail' ? '杂事' : actor[i.actor],run?.model,i.estimated_minutes ? `预计 ${i.estimated_minutes} 分钟` : '',i.due_at ? '截止 '+time(i.due_at) : ''].filter(Boolean).join(' · ');
      return `<article class="inbox-card decision-card ${i.status==='failed' ? 'is-blocked' : ''}"><div class="decision-copy"><div class="card-labels"><span class="pill card-category">${esc(i.category || '事项')}</span>${urgency}</div><div class="decision-title"><h3>${reviewKey(i) ? `<button class="title-link" title="查看完整信息" data-review="${esc(reviewKey(i))}" data-card="${esc(i.id)}">${esc(i.title)}</button>` : esc(i.title)}</h3></div>${reason ? `<p class="decision-reason">${esc(reason)}</p>` : ''}<p class="decision-preview">${esc(i.detail)}</p><div class="decision-meta">${esc(metadata)}${i.mail_links?.length ? `${metadata ? ' · ' : ''}<a class="mail-origin" href="${esc(i.mail_links[0].url)}" target="_blank" rel="noopener" title="${esc(i.mail_links[0].subject)}">原邮件 ↗</a>` : ''}</div></div><div class="decision-actions">${actionButtons(i)}</div></article>`;
    }).join('')}</section>`;
  }).join('');
  const handed=handedOff(s);
  const body=handed+groups || '<div class="panel quiet-empty">暂时没有需要你处理的事项。</div>';
  const today=new Date().toLocaleDateString('en-CA');
  const delivered=s.work.items.filter(i=>i.status==='done' && (!i.turn || i.outputs?.length) && ['codex','claude','deepseek'].includes(i.actor) && i.completed_at &&new Date(i.completed_at).toLocaleDateString('en-CA')===today);
  const last=s.mail.lastRun,activity=s.inbox_activity || {undoable:[],accepted:[],recent:[]};
  const acceptanceTypes=[...new Set(activity.accepted.map(i=>i.task_kind))];
  const aside=`<article class="panel inbox-digest"><h2>今天已自动处理</h2><div class="digest-row"><span>已生成交付</span><b>${delivered.length} 项</b></div><div class="digest-row"><span>邮件增量收集</span><b>${last ? last.pages+' 页' : '暂无记录'}</b></div><div class="digest-row"><span>新待判断邮件</span><b>${s.mail.pending} 封</b></div><div class="digest-row"><span>邮件自动判断</span><b>${s.automation?.judged || 0} 封</b></div><div class="digest-row"><span>自动准备选项</span><b>${s.automation?.prepared || 0} 张</b></div>${s.automation?.issue ? `<div class="digest-row digest-alert"><span>${esc(s.automation.issue)}</span></div>` : ''}${s.automation && s.automation.calls>=s.automation.cap ? `<div class="digest-row digest-alert"><span>今日自动处理已达上限（${s.automation.calls}/${s.automation.cap} 次），明天恢复</span></div>` : ''}</article><article class="panel undo-panel"><h2>撤销窗口</h2>${activity.undoable.length ? activity.undoable.map(r=>`<div class="undo-item"><span>${esc(r.title)}<small>可撤销至 ${time(r.undo_until)}</small></span><button class="secondary small" data-undo="${esc(r.id)}">撤销</button></div>`).join('') : '<p class="muted">处理后 5 分钟内可撤销。</p>'}</article><article class="panel trust-panel"><h2>信任进度</h2>${activity.accepted.length ? acceptanceTypes.map(k=>`<div class="digest-row"><span>${esc(kind[k] || k)}</span><b>${activity.accepted.filter(i=>i.task_kind===k).length} 项已验收</b></div>`).join('') : '<p class="muted">还没有你的验收记录。</p>'}<p class="trust-caption">${activity.accepted.length ? '继续积累同类交付的验收记录。' : '从第一份实际交付开始。'}</p></article>`;
  return {count,summary:summary+(minutes.length ? ` · 已记录预计耗时 ${minutes.reduce((a,b)=>a+b,0)} 分钟` : ''),groups:body,aside};
}

function nodesOf(nodes) {return (nodes || []).flatMap(n=>[n,...nodesOf(n.children)]);}
function taskComplete(task) {return task.status==='done' && task.review?.state!=='pending';}
function projectInfo(s,p) {
  const tasks=s.work.items.filter(i=>i.project_ids.includes(p.id));
  const nodes=nodesOf(p.plan),leaves=nodes.filter(n=>!n.children?.length);
  const framework=!!p.framework;
  const current=tasks.find(i=>i.status==='active' && i.plan_node_id)?.plan_node_id || p.active_node_id || (p.plan_is_example ? p.demo_current_node : null);
  const completed=leaves.filter(n=>tasks.some(t=>t.plan_node_id===n.id && taskComplete(t)) || (p.plan_is_example && n.demo_status==='done')).length;
  const waiting=tasks.filter(t=>t.review?.state==='pending' || ['waiting_user','failed'].includes(t.status)).length;
  return {tasks,nodes,leaves,current,completed,waiting,framework,currentTitle:nodes.find(n=>n.id===current)?.title,
    running:tasks.filter(t=>t.status==='active').length};
}
function taskDetail(t) {
  return `<div class="task-contract">${parentNote(t)}<div class="contract-grid"><div><small>目标与输入</small><p>${esc(t.goal || t.title)}</p>${(t.sources || []).map(x=>`<code class="file-name">${esc(x)}</code>`).join('')}</div><div><small>交付与结果</small>${t.outputs.length ? t.outputs.map(x=>`<code class="file-name">${esc(x)}</code>`).join('') : '<p>尚无交付文件</p>'}${t.handoff ? `<p class="message-text">${esc(t.handoff)}</p>` : ''}</div></div>${executionHistory(t)}<div class="contract-actions"><button class="text-button" data-review="work:${t.id}">验收标准与依据 ↗</button><button class="text-button" data-task-session="${t.id}">打开任务对话 ↗</button>${t.handoff ? `<button class="text-button" data-handoff="${t.id}">复制结果说明 ↗</button>` : ''}</div></div>`;
}
function uploadButton(project,nodeId='',label='添加图片或文件') {
  return `<label class="text-button project-upload">${esc(label)}<input type="file" multiple hidden data-project-upload="${esc(project.id)}" data-node-upload="${esc(nodeId)}"></label>`;
}
function projectFileView(project,owner,nodeId='',includeUpload=true) {
  const files=owner.files || [];
  const query=index=>`project=${encodeURIComponent(project.id)}${nodeId ? '&amp;node='+encodeURIComponent(nodeId) : ''}&amp;index=${index}`;
  return `<div class="project-file-list">${files.map((file,index)=>`<div class="linked-item"><strong>${esc(file.title || file.path)}</strong>${file.description ? `<p>${esc(file.description)}</p>` : ''}${['image/png','image/jpeg','image/webp','image/gif'].includes(file.mime) ? `<a href="/api/projects/file?${query(index)}&amp;preview=1" target="_blank" rel="noopener"><img class="project-file-image" loading="lazy" src="/api/projects/file?${query(index)}&amp;preview=1" alt="${esc(file.title || file.path)}"></a>` : ''}<a class="text-button" href="/api/projects/file?${query(index)}">下载文件 ↗</a></div>`).join('') || (nodeId ? '' : '<p class="muted section-empty">暂无项目文件。</p>')}${includeUpload ? uploadButton(project,nodeId) : ''}</div>`;
}
function nodeView(s,p,node,info) {
  const tasks=info.tasks.filter(t=>t.plan_node_id===node.id),all=nodesOf([node]);
  const leaves=all.filter(n=>!n.children?.length),finished=leaves.filter(n=>info.tasks.some(t=>t.plan_node_id===n.id && taskComplete(t)) || (p.plan_is_example && n.demo_status==='done')).length;
  const current=info.current===node.id,containsCurrent=all.some(n=>n.id===info.current);
  const pending=tasks.some(t=>t.review?.state==='pending' || t.status==='waiting_user');
  const blocked=tasks.some(t=>t.status==='failed');
  const state=blocked ? '被阻塞' : pending ? '等你处理' : finished===leaves.length ? '已完成' : current ? '当前' : containsCurrent ? '进行中' : '待推进';
  const tone=blocked ? 'red' : pending ? 'amber' : finished===leaves.length ? 'green' : containsCurrent ? 'teal' : 'neutral';
  return `<details class="plan-node ${current ? 'node-current' : ''}${containsCurrent && !current ? 'contains-current' : ''}" data-expand="node:${p.id}:${node.id}" ${containsCurrent && node.children?.length ? 'open' : ''}><summary><span class="tree-chevron">›</span><span class="node-dot tone-${tone}"></span><strong>${esc(node.title)}</strong>${node.children?.length ? `<small>${finished} / ${leaves.length}</small>` : ''}<span class="pill tone-${tone}">${state}</span></summary><div class="node-content">${node.description ? `<p class="node-description">${esc(node.description)}</p>` : ''}${node.children?.length ? node.children.map(n=>nodeView(s,p,n,info)).join('') : ''}${tasks.map(t=>`<details class="task-fold" data-expand="task:${t.id}"><summary><span>${esc(t.title)}</span><small>${actor[t.actor]} · ${t.review?.state==='pending' ? '待验收' : status[t.status]}</small></summary>${taskDetail(t)}</details>`).join('')}${node.acceptance_criteria?.length ? `<p class="node-criteria">验收标准：${node.acceptance_criteria.map(esc).join('；')}</p>` : ''}${projectFileView(p,node,node.id)}<div class="node-actions"><button class="text-button" data-node-focus="${node.id}" data-node-project="${p.id}">设为当前</button><button class="text-button" data-node-chat="${node.id}" data-node-project="${p.id}">与 agent 推进 ↗</button></div></div></details>`;
}
// Projects with a FRAMEWORK.md: boards nest freely; every item that has a state shows one chip, set by the user, never inferred from its children.
export const stateLabels={done:'完成',doing:'正在进行',failed:'失败',open:'未开始／待定义'};
const flat=boards=>boards.flatMap(n=>[n,...flat(n.children || [])]);
export function frameworkStats(p) {
  const all=flat(p.framework.boards);
  return {entries:all.filter(n=>n.entry).length,sections:all.filter(n=>n.id && !n.entry && n.level>2).length,tracked:all.filter(n=>n.status).length};
}
const dateText=n=>n.date ? n.date+(n.date_confirmed ? '' : '（待确认）') : n.after ? '日期待补，接在 '+n.after.id+' 之后' : '日期待确认';
const shortDate=d=>/^\d{4}-\d\d-\d\d$/.test(d) ? d.slice(5) : d;
const whenHtml=n=>`<span class="fw-when${n.date && n.date_confirmed ? '' : ' is-open'}" title="${esc(dateText(n))}">${n.date ? (n.date_confirmed ? '' : '约 ')+esc(shortDate(n.date)) : '日期待补'}</span>`;
const kindLabels={milestone:'阶段',attempt:'尝试',info:'说明'};
function chip(p,n,addable) {
  const attr=`data-fw-chip="${esc(n.id)}" data-fw-project="${esc(p.id)}" data-fw-status="${esc(n.status || '')}" data-fw-kind="${esc(n.kind || '')}"`;
  if(n.status)return `<button class="fw-chip st-${n.status}" ${attr} title="${esc(stateLabels[n.status])}${n.status_date ? '，'+n.status_date+' 起' : ''}，点击修改"><i class="fw-dot"></i>${esc(stateLabels[n.status])}${n.status==='open' && n.note ? '：'+esc(n.note) : ''}</button>`;
  return addable ? `<button class="fw-chip st-none" ${attr} title="给这一项加状态">＋ 状态</button>` : '';
}
// Operating steps appear in their log topic, separate from prose. Their state lives in work only; never in the argument map.
// Five states: open 未开始／待定义, queued 待办 (has an operator, on the board), active 正在进行, done, failed. Waiting for predecessors and for the user are written out as words.
const lampOf={open:'open',queued:'todo',active:'doing',waiting_user:'doing',done:'done',failed:'failed',cancelled:'open'};
const lampWords={open:'未开始／待定义',queued:'待办',active:'正在进行',waiting_user:'正在进行',done:'完成',failed:'失败',cancelled:'已中止'};
// A weekly goal carries its task's own status (the server sends task_status) and wears the same lamp as the step chips: nothing of its own to trigger.
export const goalLamp=i=>i.task_status==='missing' ? '任务已不在' : i.task_status ? `<span class="goal-lamp st-${lampOf[i.task_status] || 'open'}"><i class="fw-dot"></i>${esc(lampWords[i.task_status] || i.task_status)}</span>` : '';
// An assistant's running step belongs to her process; the user has no hand on it.
const stepRun=t=>{
  const runs=t.execution_history || (t.last_execution ? [t.last_execution] : []);
  return runs.findLast(r=>r.status==='active') || runs.findLast(r=>r.status==='queued');
};
function returnBlocked(run,all) {
  if(run.blocked_by)return run.blocked_by;
  const byId=new Map([...all.flatMap(t=>t.execution_history || []),...all].map(t=>[t.id,t]));
  return (run.after || []).filter(id=>{
    const item=byId.get(id),result=item?.last_execution || item?.execution_history?.at(-1) || item;
    return !['done','failed','cancelled'].includes(result?.status);
  });
}
const stepLocked=t=>t.actor!=='user' && (t.status==='active' || !!stepRun(t));
function stepNote(t,all) {
  if(t.status==='open' && t.last_execution?.status==='done' && t.last_execution.outcome_status==='open')return '上一轮已结束，未提交完成';
  if(t.status==='waiting_user')return '等你处理';
  if(t.status==='cancelled')return '已中止';
  if(stepLocked(t))return '助手正在执行，不能手动改状态';
  if(!['open','queued'].includes(t.status))return '';
  if(t.blocked_by?.length)return '等待前置：'+t.blocked_by.map(id=>all.find(x=>x.id===id)?.title.split(/[：:]/)[0] || id).join('、');
  if(t.status==='open')return '还没开始；设为待办并指定操作对象后才进看板';
  return t.actor==='user' ? '可做' : '前置已完成，工作台将自动交给助手';
}
function stepDisplay(t,all) {
  const run=stepRun(t);
  if(!run)return {status:t.status,words:lampWords[t.status] || '未开始／待定义',note:stepNote(t,all)};
  const blocked=run.status==='queued' && run.after?.length ? returnBlocked(run,all) : [];
  return {status:blocked.length ? 'active' : run.status,
    words:blocked.length ? '等待子操作结果' : lampWords[run.status],
    note:(blocked.length ? `等待 ${blocked.length} 项返回` : run.status==='active' ? '本次正在执行' : '本次已排队')+(t.status==='done' ? '；原成果保留' : '')};
}
function parentNote(t,all=[]) {
  return t.parent_id ? `<small class="step-parent" data-step-parent="${esc(t.parent_id)}">所属操作：${esc(all.find(x=>x.id===t.parent_id)?.title || t.parent_id)}</small>` : '';
}
function stepFiles(files=[],id) {
  return files.length ? `<details class="step-goal" data-step-files="${esc(id)}" data-expand="step-files:${esc(id)}"><summary>成果文件 · ${files.length} 项</summary>${files.map(file=>`<code class="file-name">${esc(file)}</code>`).join('')}</details>` : '';
}
function executionHistory(t) {
  const history=t.execution_history || [];
  if(!history.length)return '';
  const labels={queued:'待执行',active:'执行中',done:'本轮已结束',failed:'失败',cancelled:'已中止',waiting_user:'等待输入'};
  const outcomes={done:'已提交完成',open:'未提交完成',waiting_user:'等待输入',failed:'提交失败',cancelled:'已中止'};
  return `<details class="step-goal step-executions" data-execution-history="${esc(t.id)}" data-expand="step-executions:${esc(t.id)}"><summary>执行历史 · ${history.length} 次</summary>${history.map((run,index)=>`<div data-execution-row="${esc(run.id)}"><small>第 ${index+1} 次 · ${esc(labels[run.status])}${run.outcome_status ? ' · '+esc(outcomes[run.outcome_status]) : ''} · ${esc(time(run.completed_at || run.created_at))}</small>${run.handoff ? `<p class="message-text">${esc(run.handoff)}</p>` : ''}${stepFiles(run.outputs,run.id)}<button type="button" class="text-button" data-task-session="${esc(run.source_task_id || run.id)}">打开本次对话 ↗</button></div>`).join('')}</details>`;
}
const grip=(p,kind,id)=>`<span class="fw-grip" data-edit-only draggable="true" data-drag-${kind}="${esc(id)}" data-drag-project="${esc(p.id)}" title="拖动重排或改归属" aria-label="拖动">⠿</span>`;
function stepRow(p,t,all) {
    const {status:displayStatus,note,words}=stepDisplay(t,all);
    const attr=`data-step-chip="${esc(t.id)}" data-step-status="${esc(t.status)}" data-step-actor="${esc(t.actor)}" data-step-blocked="${t.blocked_by?.length ? 1 : ''}" data-step-outputs="${t.require_outputs ? 1 : ''}"`;
    const result=(t.handoff ? `<p class="message-text">${esc(t.handoff)}</p>` : '')+stepFiles(t.outputs,t.id);
    return `<div class="fw-step" data-step-row="${esc(t.id)}">${grip(p,'step',t.id)}<button class="fw-chip st-${lampOf[displayStatus] || 'open'}${stepLocked(t) ? ' is-locked' : ''}" ${attr} ${stepLocked(t) ? 'disabled title="助手执行或等待接续中，不能手动改状态"' : 'title="点击修改这一步的状态"'}><i class="fw-dot"></i>${esc(words)}</button><div class="fw-step-main"><strong>${esc(t.title)}</strong>${parentNote(t,all)}<small>${actor[t.actor]}${note ? ' · '+esc(note) : ''}</small>${t.goal ? `<details class="step-goal" data-expand="step-goal:${esc(t.id)}"><summary>步骤说明</summary><p class="message-text">${esc(t.goal)}</p></details>` : ''}${result}${executionHistory(t)}<div class="fw-actions" data-edit-only><button type="button" class="text-button" data-step-edit="${esc(t.id)}">编辑步骤</button><button type="button" class="text-button danger-text" data-step-edit="${esc(t.id)}" data-step-action="delete">删除</button></div></div></div>`;
}
function stepList(p,steps,all) {
  if(!steps.length)return '';
  const n=(...s)=>steps.filter(t=>s.includes(stepDisplay(t,all).status)).length;
  const counts=[['未开始',n('open')],['待办',n('queued')],['正在进行',n('active','waiting_user')],['完成',n('done')],['失败',n('failed')]].filter(([,c])=>c).map(([w,c])=>c+' '+w).join('、');
  const ids=new Set(steps.map(t=>t.id)),hasSubgraph=steps.some(t=>ids.has(t.parent_id));
  const content=hasSubgraph ? workGraph(p.id,all,steps) : steps.map(t=>stepRow(p,t,all)).join('');
  return `<div class="fw-steps"><small class="fw-steps-head">${grip(p,'steps',steps.map(t=>t.id).join(','))}操作步骤 · ${steps.length} 项：${counts}（只是汇总，不代表这一项的结论）</small>${content}</div>`;
}
function linkButtons(label,items) {
  return items.length ? `<div class="fw-links"><small>${label}</small>${items.map(x=>`<button class="fw-link" data-fw-goto="${esc(x.id)}" title="跳到 ${esc(x.id)}">${esc(x.id.startsWith('T-') ? x.id.slice(11)+' ' : '')}${esc(x.title)}${x.date ? ' · '+esc(x.date) : ''}</button>`).join('')}</div>` : '';
}
// 日志以 FRAMEWORK 的主题树为主入口，日期只是记录属性，不再按月份另铺一份。
// 未归入主题的新记录仍显示，避免工具追加后藏起来；具体归属由整理者决定，不从链接猜。
function timelineChildren(p,n,render,tasks) {
  const kids=n.children || [],entries=kids.filter(c=>c.entry),plain=kids.filter(c=>!c.entry).map(c=>fwNode(p,c,render,tasks)).join('');
  return plain+(entries.length ? `<section class="fw-log-records"><h4 class="fw-log-head">尚未归入主题的日志<small>${entries.length} 条</small></h4>${entries.map(e=>fwNode(p,e,render,tasks)).join('')}</section>` : '');
}
const logCount=n=>flat(n.children || []).filter(c=>c.entry).length;
function fwChildren(p,n,render,tasks) {
  if(n.type==='timeline')return timelineChildren(p,n,render,tasks);
  const kids=n.children || [],entries=kids.filter(c=>c.entry),sections=kids.filter(c=>!c.entry);
  // 子栏决定研究环节；T- 编号只标识记录，不再额外包一层「详细日志」。
  // 多个方法共用一条原始叙述时，明确标作共同记录，不复制到各方法。
  // One direct record can show its details with the stage; no merging of identities or actions.
  const single=['milestone','attempt','info'].includes(n.kind) && entries.length===1 && sections.length===0 && !tasks.some(t=>t.plan_node_id===n.id || t.plan_node_id===entries[0].id);
  const rows=entries.map(e=>fwNode(p,e,render,tasks,single)).join('');
  const label=sections.length ? '共同记录' : '过程记录';
  return sections.map(c=>fwNode(p,c,render,tasks)).join('')+(entries.length && (sections.length || entries.length>1) ? `<section class="fw-log-records"><h4 class="fw-log-head">${label}<small>${entries.length} 条</small></h4>${rows}</section>` : rows);
}
// 说明、评价、备注、缺项各收进自己的折叠栏，不和事实混在一起；这些栏来自正文里按固定标签写的顶层条目。
const auxGroups=[{label:'评价与讨论',labels:['用户评价','助手备注','讨论'],tone:'agent'}, {label:'来源与更正',labels:['来源与性质','日期依据'],tone:'plain'}, {label:'缺项',labels:['缺项'],tone:'plain'}, {label:'关联说明',labels:['关联说明'],tone:'plain'}];
// 「讨论」栏里写 chat:<会话id>#<任务id>（任务id可省）指向原对话，页面把它变成按钮：点开该会话并定位到那一轮，不复制全文。
const chatRef=/chat:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:#([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?/g;
const chatLinks=html=>html.replace(chatRef,(m,s,t)=>`<button type="button" class="fw-chat" data-chat-open="${s}" ${t ? `data-chat-task="${t}"` : ''} title="打开原对话${t ? '并定位到那一轮' : ''}">原对话 ↗</button>`);
function auxPanels(p,n,render) {
  const inLogic=p.framework.boards.some(b=>b.type==='logic' && (b.id===n.id || flat(b.children || []).some(c=>c.id===n.id)));
  return auxGroups.map(group=>{
    const items=(n.aux || []).filter(a=>group.labels.includes(a.label));if(!items.length)return '';
    const notes=items.find(a=>a.label==='助手备注');
    const who=notes ? (notes.authors?.length ? `<small class="fw-author">${esc(notes.authors.join('、'))}</small>` : '')+(notes.unsigned ? `<small class="fw-author is-unverified" title="条目标签里没有署名，没有逐条核对作者">${notes.unsigned} 条作者未核实</small>` : '') : '';
    const label=group.label==='缺项' ? (inLogic ? '还缺什么证据' : '待补记录') : group.label;
    const body=items.map(a=>{const html=render(a.body);return `<section class="fw-aux-part" data-aux-label="${esc(a.label)}">${items.length>1 ? `<h5>${esc(a.label)}</h5>` : ''}<div class="markdown-body node-detail">${a.label==='讨论' ? chatLinks(html) : html}</div></section>`;}).join('');
    return `<details class="fw-aux fw-aux-${group.tone}" data-expand="fwaux:${esc(p.id)}:${esc(n.id)}:${esc(group.label)}"><summary><span class="tree-chevron">›</span>${esc(label)}${who}</summary>${body}</details>`;
  }).join('');
}
// 逻辑节点里列出引用它的时间记录（按时间），点一行跳到时间线里的那条；记录正文只在时间线里有一份。
function relatedRecords(n) {
  const inside=new Set(flat(n.children || []).map(c=>c.id));
  const rows=(n.backlinks || []).filter(b=>b.entry && !inside.has(b.id)).sort((a,b)=>(a.sort_key ? 0 : 1)-(b.sort_key ? 0 : 1) || String(a.sort_key).localeCompare(String(b.sort_key)) || a.id.localeCompare(b.id));
  return rows.length ? `<div class="fw-related"><small>相关时间记录 · ${rows.length}</small>${rows.map(b=>`<button class="fw-rel" data-fw-goto="${esc(b.id)}" title="跳到 ${esc(b.id)}"><span class="fw-when${b.date ? '' : ' is-open'}">${b.date ? esc(shortDate(b.date)) : '日期待补'}</span><span>${esc(b.title)}</span></button>`).join('')}</div>` : '';
}
function editorButton(p,n,action='content',label='编辑') {
  return `<button type="button" class="text-button fw-edit" data-edit-only data-fw-edit="${esc(n?.id || '')}" data-editor-project="${esc(p.id)}" data-editor-action="${action}">${label}</button>`;
}
function editorActions(p,n) {
  if(!n.id)return '';
  const inLog=p.framework.boards.some(b=>b.type==='timeline' && (b.id===n.id || flat(b.children || []).some(c=>c.id===n.id)));
  const records=logCount(n);
  const deleteLabel=n.entry ? '删除本条日志' : records ? `删除本栏（含 ${records} 条日志）` : '删除本栏';
  return (!n.entry && n.level<6 ? editorButton(p,n,'add-node','＋ 子栏')+(inLog ? editorButton(p,n,'add-entry','＋ 日志') : '') : '')+(inLog ? `<button type="button" class="text-button" data-edit-only data-step-add="${esc(n.id)}" data-step-project="${esc(p.id)}">＋ 操作步骤</button>` : '')+editorButton(p,n,'delete',deleteLabel);
}
function fwNode(p,n,render,tasks,defaultOpen=false) {
  const body=n.body ? `<div class="markdown-body node-detail">${render(n.body)}</div>` : '';
  if(!n.id)return `<details class="fw-plain" data-expand="fw:${esc(p.id)}:${n.level}:${esc(n.title)}"><summary><span class="tree-chevron">›</span>${esc(n.title)}</summary><div>${body}${fwChildren(p,n,render,tasks)}</div></details>`;
  const gist=n.summary ? `<span class="fw-gist">${esc(n.summary)}</span>` : '';
  const kind=n.kind ? `<span class="fw-kind" title="${n.kind==='attempt' ? '已发生的一次尝试，只有完成或失败' : n.kind==='info' ? '说明性内容，不带状态' : '一个阶段或项目'}">${kindLabels[n.kind]}</span>` : '';
  const count=logCount(n);
  const steps=tasks.filter(t=>t.plan_node_id===n.id),pending=steps.some(t=>!['done','cancelled'].includes(t.status));
  const containsPending=flat(n.children || []).some(c=>tasks.some(t=>t.plan_node_id===c.id && !['done','cancelled'].includes(t.status)));
  const progress=steps.length ? `<span class="pill tone-neutral">步骤 ${steps.filter(t=>t.status==='done').length} / ${steps.length}</span>` : '';
  const title=n.entry ? `<span class="fw-title">${whenHtml(n)}<strong>${esc(n.title)}</strong><code class="fw-id">${esc(n.id)}</code></span>` : `<span class="fw-title">${kind}<strong>${esc(n.title)}</strong>${count ? `<small class="fw-log-count">${count} 条日志</small>` : ''}</span>`;
  const history=n.history?.length ? `<details class="fw-history"><summary class="muted">状态记录 ${n.history.length} 条</summary>${n.history.map(h=>`<p class="muted">${esc(h[0])} · ${esc(stateLabels[h[1]] || '无')} → ${esc(stateLabels[h[2]] || '无')}${h[3] ? '：'+esc(h[3]) : ''}</p>`).join('')}</details>` : '';
  const after=n.after ? `<p class="muted fw-after">日期待补：按用户叙述排在 <button class="fw-link" data-fw-goto="${esc(n.after.id)}">${esc(n.after.id.slice(11))} ${esc(n.after.title)}</button> 之后，不是确切日期。</p>` : '';
  const inside=new Set(flat(n.children || []).map(c=>c.id)),linked=new Set(n.links.map(l=>l.id));
  const cited=(n.backlinks || []).filter(b=>(n.entry || !b.entry) && !inside.has(b.id) && !linked.has(b.id));
  const links=n.links.filter(l=>!inside.has(l.id));
  return `<details class="fw-node ${n.entry ? 'fw-entry' : ''} ${n.entry ? '' : 'fw-logic'}" data-fw-id="${esc(n.id)}" data-drop-node="${esc(n.id)}" ${steps.length ? `data-work-node="${esc(n.id)}"` : ''} data-expand="fw:${esc(p.id)}:${esc(n.id)}" ${defaultOpen || pending || containsPending ? 'open' : ''}><summary><span class="tree-chevron">›</span>${grip(p,'node',n.id)}<span class="fw-head">${title}${gist}</span>${progress}${chip(p,n,n.tracked && !n.entry)}${editorButton(p,n)}</summary><div class="fw-content-inner">${stepList(p,steps,tasks)}${body}${auxPanels(p,n,render)}${after}${n.entry ? '' : relatedRecords(n)}${linkButtons(n.entry ? '关联节点和记录' : '关联',links)}${linkButtons('被引用',cited)}${n.work.length ? `<div class="fw-links"><small>任务</small>${n.work.map(w=>`<code>${esc(w)}</code>`).join(' ')}</div>` : ''}${history}${fwChildren(p,n,render,tasks)}${projectFileView(p,n,n.id,false)}<div class="fw-actions">${editorActions(p,n)}${uploadButton(p,n.id,n.entry ? '给本条日志添加附件' : '给本栏添加附件')}${n.entry && n.tracked && !n.status ? chip(p,n,true) : ''}<button class="text-button" data-node-chat="${esc(n.id)}" data-node-project="${esc(p.id)}">与 agent 推进 ↗</button></div></div></details>`;
}
function frameworkView(p,render,tasks) {
  // The snapshot's turn flag owns this distinction, including pending-review deliverables.
  // Live inputs and merged supplements belong to the conversation, never to operating steps.
  tasks=tasks.filter(t=>!t.turn);
  const timelines=p.framework.boards.filter(b=>b.type==='timeline'),logIds=new Set(flat(timelines).map(n=>n.id).filter(Boolean));
  // A finished project-progress planner is bookkeeping, not a step to file under a topic either.
  const unassigned=tasks.filter(t=>!logIds.has(t.plan_node_id) && !(t.autonomy?.type==='plan' && ['done','cancelled'].includes(t.status)));
  return p.framework.boards.map(b=>{
    const logTasks=b.type==='timeline' ? tasks : [],rootSteps=logTasks.filter(t=>b.id && t.plan_node_id===b.id);
    const remaining=b===timelines[0] && unassigned.length ? `<section class="fw-unassigned-work" data-fw-unassigned-work><h4 class="fw-log-head">待归入日志主题的步骤</h4>${stepList(p,unassigned,tasks)}</section>` : '';
    const count=b.type==='timeline' ? logCount(b)+' 条记录' : '';
    return `<details class="fw-board ${b.type ? 'fw-'+esc(b.type) : ''}" data-expand="fw:${esc(p.id)}:${esc(b.id || b.title)}" ${b.id ? `data-drop-node="${esc(b.id)}"` : ''} open><summary><span class="tree-chevron">›</span>${b.id ? grip(p,'node',b.id) : ''}<strong>${esc(b.title)}</strong>${count ? `<span class="pill tone-neutral">${count}</span>` : ''}${chip(p,b,false)}${b.id ? editorButton(p,b) : ""}</summary><div class="fw-content">${b.summary ? `<p class="fw-intro">${esc(b.summary)}</p>` : ''}${b.body ? `<div class="markdown-body node-detail">${render(b.body)}</div>` : ''}${stepList(p,rootSteps,tasks)}${b.id ? `<div class="fw-actions">${editorActions(p,b)}</div>` : ""}${fwChildren(p,b,render,logTasks)}${remaining}</div></details>`;
  }).join('');
}
// Final replies own update notifications; progress messages and user edits do not.
export function agentUpdates(s) {
  const tasks=new Map(s.work.items.map(t=>[t.id,t]));
  return (s.agent?.sessions || []).flatMap(session=>session.updates || (session.messages || []).flatMap(m=>{
    const task=tasks.get(m.task_id);
    if(m.role!=='assistant' || m.interim || !['codex','claude','deepseek'].includes(m.provider || task?.executor || task?.actor) || !Number.isFinite(Date.parse(m.at)))return [];
    return [{sessionId:session.id,project_ids:task?.project_ids || session.project_ids || [],at:m.at,
      provider:m.provider || task?.executor || task?.actor,title:task?.title || session.title || '未命名对话',text:m.text || ''}];
  }));
}
export function projectsView(s,selected,query='',render=esc,readAt={},editing=false) {
  const replies=agentUpdates(s);
  const unreadFor=p=>replies.filter(u=>u.project_ids.includes(p.id) && Date.parse(u.at)>Number(readAt[u.sessionId] || 0)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const match=p=>(p.name+' '+(p.aliases || []).join(' ')).toLowerCase().includes(query.toLowerCase());
  const makeCard=(p,index)=>{
    const {tasks}=projectInfo(s,p),agents=['codex','claude','deepseek'];
    // Match the yellow ! chips in the detail, not approvals, queued work or demo progress.
    const doing=p.framework ? flat(p.framework.boards).filter(n=>n.status==='doing' && (n.id || p.framework.boards.includes(n))).length+tasks.filter(t=>!t.turn && ['active','waiting_user'].includes(t.status)).length : 0;
    const working=[...new Set(tasks.filter(t=>t.status==='active' && !t.merged_into).map(t=>s.agent?.active_turns?.find(turn=>turn.task_id===t.id)?.provider || t.executor || t.actor).filter(a=>agents.includes(a)))];
    const updates=replies.filter(u=>u.project_ids.includes(p.id)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    const unread=unreadFor(p);
    const update=unread.length ? '<button class="text-button project-new-update" data-session="'+esc(unread[0].sessionId)+'" title="打开有未读回复的对话；查看后标为已读">'+unread.length+' 条新更新</button>' : '<span class="project-update">'+(updates.length ? '无新更新' : '暂无 agent 更新')+'</span>';
    return `<article class="project-card project-summary hue-${index%4}"><h2><button data-project-open="${esc(p.id)}">${esc(p.name)}</button></h2><div class="project-signals"><span class="pill ${doing ? 'tone-amber' : 'tone-neutral'}" data-project-doing="${doing}" title="详情里黄色感叹号的数量（正在进行的项目条目和操作步骤）"><b aria-hidden="true">!</b> ${doing} 项</span><span class="project-agent ${working.length ? 'is-working' : ''}">${working.length ? esc(working.map(a=>actor[a]).join(' / '))+' 工作中' : '无 agent 工作中'}</span>${update}</div></article>`;
  };
  // A finished project is archived, not deleted: it leaves the main list but stays one click away, and can be restored.
  const activeList=s.projects.filter(p=>!p.archived_at && match(p)),archivedList=s.projects.filter(p=>p.archived_at && match(p));
  const cards=(activeList.map(makeCard).join('') || '<div class="quiet-empty">没有匹配的项目。</div>')
    +(archivedList.length ? `<details class="archived-projects"><summary>已归档（${archivedList.length}）</summary><div class="archived-grid">${archivedList.map(makeCard).join('')}</div></details>` : '');
  const p=s.projects.find(p=>p.id===selected);if(!p)return {cards,detail:'',selected:false};
  const i={...projectInfo(s,p),render},unlinked=i.framework ? [] : i.tasks.filter(t=>!i.nodes.some(n=>n.id===t.plan_node_id));
  const intents=s.weekly.plan?.intents.filter(n=>n.project_ids.includes(p.id)) || [];
  const links=s.links.filter(l=>l.project_ids.includes(p.id)),mail=s.mail.tasks.filter(t=>t.status!=='done' && links.some(l=>l.module==='mail' && l.item_id===t.id));
  const papers=s.literature.papers.filter(r=>r.project_ids?.includes(p.id)),files=p.files || [];
  const projectFiles=`<details class="panel project-section" data-expand="files:${p.id}"><summary>项目文件 <span>${files.length}</span></summary>${projectFileView(p,p)}</details>`;
  const done=i.tasks.filter(t=>t.status==='done'),recent=done.filter(t=>t.outputs?.length).reverse(),chatCount=done.length-recent.length;
  const unread=unreadFor(p);
  const newUpdates=unread.length ? `<details class="panel project-section project-new-updates" data-expand="updates:${esc(p.id)}" open><summary>新更新 <span>${unread.length}</span></summary><div class="project-update-list">${unread.map(u=>`<button type="button" class="project-update-entry" data-session="${esc(u.sessionId)}" title="打开原对话；查看后标为已读"><span class="project-update-title"><span class="pill tone-teal">新</span><strong>${esc(u.title)}</strong></span><small>${esc(actor[u.provider])} · ${esc(time(u.at))}</small><span class="project-update-preview">${esc(u.text || '查看回复 ↗')}</span></button>`).join('')}</div></details>` : '';
  const progress=i.framework ? (()=>{const f=frameworkStats(p);return `${f.entries} 条时间记录 · ${f.sections} 个板块条目 · ${f.tracked} 项带状态 · 非实验进度`;})() : i.leaves.length ? `${i.completed} / ${i.leaves.length} 个环节已完成` : i.tasks.length ? `${i.tasks.filter(taskComplete).length} / ${i.tasks.length} 项已交付` : '进度待记录';
  // Each band of the detail page is built on its own, then laid out in the order the page shows them.
  const heading=`<button class="project-back text-button" data-project-back>← 所有项目</button><div class="page-heading project-detail-heading"><div><p class="eyebrow">${i.framework ? 'PROJECT FRAMEWORK' : 'PROJECT PLAN'}${p.plan_is_example ? ' · 示意内容' : ''}${p.archived_at ? ' · 已归档' : ''}</p><h1>${esc(p.name)}</h1></div></div>`;
  const actions=`<div class="project-actions">${i.framework ? `<button class="${editing ? 'primary' : 'text-button'}" data-project-edit-mode aria-pressed="${editing}" title="开启后可编辑栏位、拖动重排和改归属">${editing ? '完成编辑' : '编辑栏位'}</button>` : ''}<button class="text-button" data-project-archive="${p.id}" data-archived="${p.archived_at ? 'true' : 'false'}">${p.archived_at ? '恢复项目' : '归档项目'}</button><button class="primary" data-project="${p.id}">与 agent 推进 ↗</button></div>`;
  const focusBand=`<div class="project-focus-band"><div><small>${i.framework ? '框架内容' : '整体进度'}${p.plan_is_example ? ' · 示意' : ''}</small><strong>${progress}</strong></div>${i.framework ? '' : `<div><small>当前步骤${p.plan_is_example && !p.active_node_id ? ' · 示意' : ''}</small><strong>${esc(i.currentTitle || '尚未记录')}</strong></div>`}<div><small>需要你处理</small><strong>${i.waiting} 项</strong></div></div>`;
  const planColumn=`<div class="project-detail-layout"><div><section class="panel plan-panel${editing && i.framework ? ' is-editing' : ''}"><div class="panel-heading"><h2>${i.framework ? '项目框架' : '阶段与步骤'}</h2><span class="muted">${i.framework ? editorButton(p,null,'add-node','＋ 大板块') : i.nodes.length ? i.nodes.length+' 个节点' : i.tasks.length+' 项任务'}</span></div>${i.framework ? frameworkView(p,render,i.tasks) : (p.plan || []).map(n=>nodeView(s,p,n,i)).join('')}${unlinked.length ? `<details class="project-section" data-expand="work:${p.id}" ${!i.nodes.length ? 'open' : ''}><summary>其他执行事项 <span>${unlinked.length}</span></summary>${unlinked.map(t=>`<details class="task-fold" data-expand="task:${t.id}"><summary><span>${esc(t.title)}</span><small>${actor[t.actor]} · ${status[t.status]}</small></summary>${taskDetail(t)}</details>`).join('')}</details>` : ''}${!i.nodes.length && !i.tasks.length ? `<div class="quiet-empty">还没有阶段计划。<button class="text-button" data-project-plan="${p.id}">一起拆解下一阶段 ↗</button></div>` : ''}</section><details class="panel project-section" data-expand="outputs:${p.id}"><summary>产出与交付 <span>${recent.length}</span></summary>${recent.map(t=>`<details class="task-fold" data-expand="result:${t.id}"><summary><span>${esc(t.title)}</span><small>${time(t.completed_at)}</small></summary>${taskDetail(t)}</details>`).join('') || '<p class="muted section-empty">暂无带产出文件的交付。</p>'}${chatCount ? `<p class="muted section-empty">另有 ${chatCount} 条无产出文件的对话任务，见「任务会话」。</p>` : ''}</details><details class="panel project-section" data-expand="sources:${p.id}"><summary>关联资料与杂事 <span>${mail.length+papers.length}</span></summary>${mail.map(t=>`<div class="linked-item"><strong>${esc(t.title)}</strong><span class="pill tone-neutral">${links.find(l=>l.item_id===t.id)?.status==='proposed' ? '归属待确认' : '杂事'}</span><p>${esc(t.action)}</p><button class="text-button" data-review="mail:${t.id}">查看依据 ↗</button></div>`).join('')}${papers.map(r=>`<div class="linked-item"><strong>${esc(r.title || r.doi)}</strong><p>${esc(r.doi)}</p></div>`).join('')}${!mail.length && !papers.length ? '<p class="muted section-empty">暂无关联记录。</p>' : ''}</details>${projectFiles}</div>`;
  const aside=`<aside class="project-aside"><article class="panel week-focus-panel"><h2>本周重点</h2>${intents.map(n=>{const chat=(s.agent?.sessions || []).some(x=>x.task_ids?.includes(n.origin?.chat_task || n.task_id));return `<div class="linked-item${n.task_status==='done' ? ' goal-done' : ''}"><strong>${esc(n.title)}</strong>${n.task_status ? `<p>${goalLamp(n)}</p>` : ''}${chat ? `<button class="text-button" data-intent-chat="${esc(n.id)}">进入对话 ↗</button>` : n.task_id ? '' : `<button class="text-button" data-intent="${esc(n.id)}">推进这件事 ↗</button>`}</div>`;}).join('') || '<p class="muted">还没有本周目标。</p>'}<button class="text-button" data-page="weekly">周计划 ↗</button></article>${actions}</aside></div>`;
  const detail=`${heading}${newUpdates}${focusBand}${planColumn}${aside}`;
  return {cards,detail,selected:true};
}

// Solid edges are explicit dependencies; dashed returns come only from after.
export function workGraph(projectId,items,scope=items) {
  const operations=scope.filter(t=>!t.turn && !t.operation_id && !t.deleted_at);
  const byId=new Map([...items.flatMap(t=>t.execution_history || []),...items].map(t=>[t.id,t]));
  if(!operations.length)return '';
  const operationIds=new Set(operations.map(t=>t.id)),roots=operations.filter(t=>!operationIds.has(t.parent_id));
  const goto=(id,text)=>`<button type="button" class="work-map-link" data-work-goto="${esc(byId.get(id)?.operation_id || id)}">${esc(text)}</button>`;
  const renderMap=(nodes,owner)=>{
    const ids=new Set(nodes.map(t=>t.id)),ranks=new Map();
    const rank=t=>{
      if(ranks.has(t.id))return ranks.get(t.id);
      ranks.set(t.id,0);
      const level=Math.max(0,...(t.dependencies || []).filter(id=>ids.has(id)).map(id=>rank(byId.get(id))+1));
      ranks.set(t.id,level);return level;
    };
    // Round.step label (DCG only). A round is one dispatch from the parent: blocks linked by dependencies, or created within 2 minutes of each other.
    // The step letter is the dependency depth inside the round, so a chain reads 1.a 1.b 1.c and blocks sent in parallel share one label (2.a 2.a).
    const stepNo=new Map();
    let levels=[],rowRounds=[];
    if(owner) {
      const sorted=[...nodes].sort((x,y)=>Date.parse(x.created_at)-Date.parse(y.created_at)),group=new Map(nodes.map(t=>[t.id,t.id]));
      const find=id=>group.get(id)===id ? id : (group.set(id,find(group.get(id))),group.get(id));
      const join=(x,y)=>group.set(find(x),find(y));
      sorted.forEach((t,i)=>{
        for(const id of t.dependencies || [])if(ids.has(id))join(t.id,id);
        if(i && Date.parse(t.created_at)-Date.parse(sorted[i-1].created_at)<=120000)join(t.id,sorted[i-1].id);
      });
      const order=[];for(const t of sorted)if(!order.includes(find(t.id)))order.push(find(t.id));
      const byStep=new Map();
      for(const t of nodes) {
        const round=order.indexOf(find(t.id))+1,depth=rank(t);
        stepNo.set(t.id,[round,depth<26 ? String.fromCharCode(97+depth) : String(depth+1)]);
        const key=round*100+depth;(byStep.get(key) || byStep.set(key,[]).get(key)).push(t);
      }
      const keys=[...byStep.keys()].sort((x,y)=>x-y);
      levels=keys.map(key=>byStep.get(key));rowRounds=keys.map(key=>Math.floor(key/100));
    } else for(const t of nodes)(levels[rank(t)] ||= []).push(t);
    const rows=levels.filter(Boolean);
    const edges=nodes.flatMap(t=>(t.dependencies || []).filter(id=>ids.has(id)).map(id=>({from:id,to:t.id})));
    const resume=owner && [...(owner.execution_history || [])].reverse().find(r=>r.after?.length);
    let returned='';
    if(resume) {
      const current=byId.get(resume.id) || resume,blocked=returnBlocked(current,items);
      const label=current.status==='queued' ? blocked.length ? `等待 ${blocked.length} 项返回` : '已排队，待接续'
        : current.status==='active' ? '正在接续' : current.outcome_status==='open' ? '本轮结束，未提交完成' : current.outcome_status==='waiting_user' ? '等待输入' : lampWords[current.outcome_status || current.status];
      // The return is a small status block, not a dashed line: it names the sources by their round.step label.
      returned=`<div class="work-map-return"><span class="work-return-symbol" aria-hidden="true">↶</span><div><strong>返回父操作 · ${esc(label)}</strong><small>${esc(owner.title)}</small><div class="work-return-sources">${resume.after.map(id=>{const no=stepNo.get(byId.get(id)?.operation_id || id);return goto(id,(no ? no[0]+'.'+no[1]+' ' : '')+(byId.get(id)?.title || id));}).join('')}</div></div></div>`;
    }
    const column=level=>`<div class="work-map-level" style="--work-columns:${owner ? 1 : Math.min(3,level.length)}">${level.map(t=>{
      const children=operations.filter(child=>child.parent_id===t.id),latest=t.last_execution;
      const live=['queued','active'].includes(latest?.status);
      const refs=(t.dependencies || []).filter(id=>!owner || !ids.has(id)).map(id=>goto(id,'← '+(byId.get(id)?.title || id))).join('');
      const sub=children.length ? `<details class="work-dcg" data-work-dcg="${esc(t.id)}" data-expand="work-dcg:${esc(t.id)}" ${children.some(c=>!['done','cancelled'].includes(c.status) || ['queued','active'].includes(c.last_execution?.status)) || live ? 'open' : ''}><summary><span class="tree-chevron">›</span><span class="work-layer-tag">DCG</span><strong>动态子操作</strong><span class="work-dcg-dots" aria-hidden="true">${children.map(c=>`<i class="st-${lampOf[stepDisplay(c,items).status] || 'open'}"></i>`).join('')}</span><small>${children.length} 项${children.filter(c=>c.status==='done').length ? ' · '+children.filter(c=>c.status==='done').length+' 完成' : ''}</small></summary><div class="work-dcg-body">${renderMap(children,t)}</div></details>` : '';
      const no=stepNo.get(t.id),badge=no ? `<span class="work-step-no" title="第 ${no[0]} 轮 · 步骤 ${no[1]}（同一轮内互不依赖的并行块标号相同）">${no[0]}.${no[1]}</span>` : '';
      return `<div class="work-map-node" data-work-map-node="${esc(t.id)}">${badge}${stepRow({id:projectId},t,items)}${refs ? `<div class="work-map-prerequisites" aria-label="实际前置关系">${refs}</div>` : ''}${sub}</div>`;
    }).join('')}</div>`;
    // In a DCG every round is a lane: steps run left to right inside it, blocks sent in parallel stack in one step column, and lanes pack side by side.
    const cards=owner ? [...new Set(rowRounds)].map(round=>{
      const columns=rows.filter((_,i)=>rowRounds[i]===round),wide=Math.max(...columns.map(c=>c.length));
      return `<section class="work-round" data-work-round="${round}"><div class="work-round-head"><b>第 ${round} 轮</b><small>${[columns.length>1 ? columns.length+' 步' : '',wide>1 ? '并行 '+wide : ''].filter(Boolean).join(' · ')}</small></div><div class="work-round-steps">${columns.map(column).join('')}</div></section>`;
    }).join('') : rows.map(column).join('');
    return `<div class="work-map-canvas" data-work-edges="${esc(JSON.stringify(edges))}"><svg class="work-map-edges" aria-hidden="true"></svg><div class="work-map-levels">${cards}${returned}</div></div>`;
  };
  return `<div class="work-inline-graph" data-work-graph="${esc(projectId)}"><div class="work-map-legend"><span class="work-layer-tag">父 DAG</span><span><i></i>前置依赖</span><small class="work-map-count">${roots.length} 项主操作 · ${operations.length-roots.length} 项子操作</small></div>${renderMap(roots,null)}</div>`;
}

let workGraphObserver;
const openHandoffs=new Set();
export function bindWorkGraph(root) {
  workGraphObserver?.disconnect();
  // Long handoffs in the DCG are clamped to a few lines; the expanded choice survives the 5s re-render.
  root.querySelectorAll('.work-dcg .fw-step-main > .message-text').forEach(text=>{
    const id=text.closest('[data-step-row]')?.dataset.stepRow;
    text.classList.toggle('is-open',openHandoffs.has(id));
    text.classList.toggle('is-clamped',text.classList.contains('is-open') || text.scrollHeight>text.clientHeight+1);
    text.addEventListener('click',()=>{
      if(getSelection()?.toString())return;
      if(!text.classList.contains('is-clamped'))return;
      const open=text.classList.toggle('is-open');open ? openHandoffs.add(id) : openHandoffs.delete(id);
    });
  });
  const maps=[...root.querySelectorAll('.work-map-canvas')];
  const draw=()=>{
    for(const map of maps) {
      const box=map.getBoundingClientRect(),svg=map.querySelector(':scope > svg');
      const nodes=new Map([...map.querySelectorAll('[data-work-map-node]')].filter(n=>n.closest('.work-map-canvas')===map).map(n=>[n.dataset.workMapNode,n]));
      svg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);
      svg.innerHTML=JSON.parse(map.dataset.workEdges).map(edge=>{
        const from=nodes.get(edge.from),to=nodes.get(edge.to);
        if(!from || !to || !from.getClientRects().length || !to.getClientRects().length)return '';
        const a=from.getBoundingClientRect(),b=to.getBoundingClientRect(),dcg=!!map.closest('.work-dcg');
        // Solid dependencies leave a block's bottom centre; dashed returns leave its right side, staggered, so the two never share a line.
        if(b.left>=a.right-1) {
          // Next step of the same round sits to the right: a heavy horizontal link from the block's header line to the next one's.
          const sx=a.right-box.left,sy=a.top-box.top+Math.min(26,a.height/2),ex=b.left-box.left,ey=b.top-box.top+Math.min(26,b.height/2),bend=Math.max(20,(ex-sx)/2);
          return `<path data-work-edge-from="${esc(edge.from)}" data-work-edge-to="${esc(edge.to)}" d="M ${sx} ${sy} C ${sx+bend} ${sy} ${ex-bend} ${ey} ${ex-9} ${ey}"/><path class="work-edge-arrow" d="M ${ex-12} ${ey-6} L ${ex-3} ${ey} L ${ex-12} ${ey+6}"/>`;
        }
        const x=a.left+a.width/2-box.left,y=a.bottom-box.top,tx=b.left+b.width/2-box.left,ty=b.top-box.top,middle=(y+ty)/2;
        const crossesNode=[...nodes.values()].some(n=>{
          if(n===from || n===to)return false;
          const r=n.getBoundingClientRect();
          return r.top<b.top && r.bottom>a.bottom && r.left<Math.max(x,tx)+box.left && r.right>Math.min(x,tx)+box.left;
        });
        const rail=dcg ? 7 : -4;
        const path=crossesNode ? `M ${x} ${y} V ${y+8} H ${rail} V ${ty-12} H ${tx} V ${ty-5}` : `M ${x} ${y} C ${x} ${middle} ${tx} ${middle} ${tx} ${ty-5}`;
        return `<path data-work-edge-from="${esc(edge.from)}" data-work-edge-to="${esc(edge.to)}" d="${path}"/><path class="work-edge-arrow" d="M ${tx-3} ${ty-8} L ${tx} ${ty-3} L ${tx+3} ${ty-8}"/>`;
      }).join('');
    }
  };
  workGraphObserver=new ResizeObserver(draw);
  for(const map of maps){workGraphObserver.observe(map);map.querySelectorAll('.work-map-node,.work-map-return').forEach(n=>workGraphObserver.observe(n));}
  root.querySelectorAll('[data-work-goto]').forEach(button=>button.addEventListener('click',()=>{
    const target=[...root.querySelectorAll('[data-step-row],details.task-fold')].find(n=>n.dataset.stepRow===button.dataset.workGoto || n.dataset.expand==='task:'+button.dataset.workGoto);
    if(!target)return;
    for(let parent=target;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({behavior:'smooth',block:'center'});
  }));
  draw();
}
