import {inboxView,projectsView,agentUpdates,sessionOf,renderExecutions,goalLamp,sessionBranch,bindWorkGraph} from './workspace.js';
import {ico,paintIcons} from './icons.js';
import {usageSections,purposes,renderExtraResets,announcedReset,renderDeepSeekBalance,renderCommandCodeQuota,commandCodeWindows,big,billed,observed} from './usage-view.js';
import {bindFramework} from './framework-ui.js';
import {bindProjectEditor} from './project-editor.js';
import {bindProjectDrag,dragging} from './project-drag.js';
import {renderInstruments} from './instruments.js';
import {renderPrompts} from './prompts-view.js';
import {bindSettings} from './settings-view.js';
import {bindSkills} from './skills-view.js';
import {esc,num,when,whenFull} from './format.js';
const $=id=>document.getElementById(id);
let renderMarkdown=esc,copyCode,markdownAvailable=false,powershellAvailable=false;
document.addEventListener('click',event=>{const button=event.target.closest('.md-copy');if(button && copyCode)void copyCode(button);});
const statuses={queued:'等待执行',active:'进行中',done:'已交付',waiting_user:'待你处理',failed:'需要处理',cancelled:'已停止',planned:'待推进'};
const providers={codex:'Codex',claude:'Claude',deepseek:'DeepSeek',program:'程序',user:'用户'};
// Avatars exist for the user and the AIs; the program and error lines get none.
const face=m=>{const who=m.role==='user' ? 'user' : ['assistant','handoff'].includes(m.role) && ['codex','claude','deepseek'].includes(m.provider) ? m.provider : '';return who ? `<img class="who" data-who="${who}" src="/avatars/${who}${who==='deepseek'?'.png':'.webp'}" width="48" height="48" alt="">` : '';};
const pages={chat:'对话',history:'历史对话',tasks:'任务会话',inbox:'收件箱',projects:'项目',weekly:'周计划与复盘',literature:'文献',board:'工作看板',usage:'额度与消耗',connections:'设置',mail:'邮件',procurement:'采购',instruments:'仪器图鉴',prompts:'提示词',skills:'技能'};
// Miscellaneous pages share one sidebar entry; the entry returns to the last one opened.
const more=['board','mail','procurement','instruments','skills','prompts','usage','connections'];let moreLast='mail';
let state,sessionId=localStorage.getItem('lab-session') || '',page=location.hash.startsWith('#projects') ? 'projects' : location.hash==='#literature' ? 'literature' : 'chat',transcriptKey='',loading=false,quotaRefreshing=false;
let literatureView,literatureLoading,literatureFailed=false;
function renderLiterature() {
  if(literatureView){literatureView.activate();return;}
  if(literatureLoading || literatureFailed)return;
  literatureLoading=import('./literature.js').then(({bindLiterature})=>{
    literatureView=bindLiterature($('page-literature'));if(page==='literature')literatureView.activate();
  }).catch(()=>{literatureFailed=true;$('literature-message').textContent='文献页面尚未加载。请在当前助手任务结束后重启后端，再刷新页面。';}).finally(()=>literatureLoading=null);
}
const transcriptSources=new WeakMap(); // Keep unchanged message nodes (and native text selections) across polls.
let savedChatPosition,chatRendererReady=false,restoringChatPosition=false;
try {
  const saved=JSON.parse(sessionStorage.getItem('lab-chat-position') || 'null');
  if(saved?.session===sessionId && Number.isFinite(saved.top) && saved.top>=0)savedChatPosition=saved;
}catch{/* Scroll restoration is optional when browser storage is unavailable. */}
function restoreChatPosition() {
  const saved=savedChatPosition,transcript=$('transcript');
  if(!saved || saved.session!==sessionId || page!=='chat' || !transcript.querySelector('.message'))return;
  const apply=()=>{transcript.scrollTop=saved.bottom ? transcript.scrollHeight : saved.top;};
  apply(); // Paint the saved location without delaying the first visible chat.
  if(!chatRendererReady || restoringChatPosition)return;
  restoringChatPosition=true;
  const images=[...transcript.querySelectorAll('img')].filter(img=>!img.complete).map(img=>new Promise(resolve=>{
    img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});
  }));
  void Promise.all([document.fonts.ready,...images]).then(()=>{
    if(savedChatPosition===saved && saved.session===sessionId && page==='chat') {
      apply();savedChatPosition=null;updateLatest();
    }
  }).finally(()=>restoringChatPosition=false);
}
function finishChatRenderer() {chatRendererReady=true;if(state)restoreChatPosition();}
let restartWaiting=false,titlesAvailable=false,pinsAvailable=false,editAvailable=false,voiceInput;
let stateRevision=0; // A poll begun before a saved chat receipt must not overwrite it.
let pageCode; // backend code fingerprint this page was opened against
let stateRead; // Navigation cancels an obsolete request instead of queueing behind it.
let pendingAttachments=[],readingAttachments=false,submitting=false,imagesAvailable=false,filesAvailable=false,projectFilesAvailable=false,searchAvailable=false,fileLimits;
let editingProject='',projectId=location.hash.startsWith('#projects/') ? decodeURIComponent(location.hash.slice(10)) : '',planNodeId='',inboxReply;
// Drafts belong to this browser tab, not the backend process. The empty id is
// the one "new conversation" draft; reloads retain it, fresh tabs do not.
const draftPrefix='lab-chat-draft:',drafts=new Map(),unsavedDrafts=new Set();
const draftError='草稿暂未能保存到浏览器（附件过大或存储受限）。本页切换仍会保留，未保存的文字或附件可能在刷新／关闭时丢失。';
try {
  for(let i=0;i<sessionStorage.length;i++) {
    const key=sessionStorage.key(i);if(!key.startsWith(draftPrefix))continue;
    try {const d=JSON.parse(sessionStorage.getItem(key));if(typeof d?.text==='string' && Array.isArray(d.attachments))drafts.set(key.slice(draftPrefix.length),d);}catch{/* Ignore an invalid local draft only. */}
  }
}catch{/* Input remains usable; saving reports unavailable storage. */}
function rememberSession() {
  localStorage.setItem('lab-session',sessionId);
}
function persistDraft(id) {
  try {
    const d=drafts.get(id);
    if(d)sessionStorage.setItem(draftPrefix+id,JSON.stringify(d));else sessionStorage.removeItem(draftPrefix+id);
    unsavedDrafts.delete(id);if(!unsavedDrafts.size && $('error').textContent===draftError)error('');return true;
  }catch{unsavedDrafts.add(id);error(draftError);return false;}
}
function saveComposer() {
  const d={text:$('message').value,attachments:pendingAttachments,project_id:$('project-context').value,plan_node_id:planNodeId,inbox_reply:inboxReply};
  if(d.text || d.attachments.length || d.project_id || d.plan_node_id || d.inbox_reply)drafts.set(sessionId,d);else drafts.delete(sessionId);
  return persistDraft(sessionId);
}
function discardDraft(id) {drafts.delete(id);persistDraft(id);}
function restoreComposer() {
  const d=drafts.get(sessionId),s=state?.agent.sessions.find(s=>s.id===sessionId);
  $('message').value=d?.text || '';pendingAttachments=[...(d?.attachments || [])];
  planNodeId=d?.plan_node_id || '';inboxReply=d?.inbox_reply;
  const project=s?.project_ids[0] || d?.project_id || '';
  if(project && ![...$('project-context').options].some(o=>o.value===project))$('project-context').add(new Option(project,project));
  $('project-context').value=project;$('project-context').disabled=!!sessionId;
  renderAttachmentPreviews();fitMessage();
}
const listLimit={history:30,tasks:30};
let agentReadAt={};
try{agentReadAt=JSON.parse(localStorage.getItem('lab-agent-read') || '{}');}catch{/* No valid saved reading state. */}
let readSyncing=false;
const readSyncError='已读状态暂未同步，恢复连接后会随页面刷新同步。';
function mergeReadState(remote) {
  // Retain unsent local progress; discard deleted/invalid local entries. The
  // existing browser cache also migrates old read receipts on the first poll.
  agentReadAt=Object.fromEntries(state.agent.sessions.map(s=>[s.id,Math.max(Number(agentReadAt?.[s.id]) || 0,Number(remote[s.id]) || 0)]).filter(([,at])=>Number.isFinite(at) && at>0));
  localStorage.setItem('lab-agent-read',JSON.stringify(agentReadAt));
}
async function syncReadState() {
  if(readSyncing || !state?.agent_read_at)return; // Old backend: keep local behavior until safely reloaded.
  const pending=Object.fromEntries(Object.entries(agentReadAt).filter(([id,at])=>at>Number(state.agent_read_at[id] || 0)));
  if(!Object.keys(pending).length)return;
  readSyncing=true;
  try {
    const saved=await post('/api/chat/read',{read_at:pending});
    // A state poll can finish while this receipt is in flight; neither may
    // roll back a newer receipt (including one from another device).
    for(const [id,at] of Object.entries(saved))state.agent_read_at[id]=Math.max(Number(state.agent_read_at[id]) || 0,at);
    mergeReadState(state.agent_read_at);renderRecentSessions();renderHistory();renderProjects();
    if($('error').textContent===readSyncError)error('');
  }catch{error(readSyncError);}
  finally{readSyncing=false;}
}
// Sub-conversations are shown inside this conversation, so reading it reads them too.
const childOpen=new Map();
document.addEventListener('toggle',e=>{const d=e.target;if(d.matches?.('details.child-chat'))childOpen.set(d.dataset.child,d.open);},true);
function markSessionRead() {
  if(page!=='chat' || !transcriptKey || document.visibilityState!=='visible' || !document.hasFocus() || !$('latest').hidden)return;
  const ids=new Set(sessionBranch(state.agent.sessions,sessionId).map(c=>c.id));
  const updates=agentUpdates(state);let changed=false;
  for(const id of ids) {
    const latest=Math.max(0,...updates.filter(u=>u.sessionId===id).map(u=>Date.parse(u.at)));
    if(latest>Number(agentReadAt[id] || 0)){agentReadAt[id]=latest;changed=true;}
  }
  if(!changed)return;
  localStorage.setItem('lab-agent-read',JSON.stringify(agentReadAt));renderRecentSessions();renderHistory();renderProjects();void syncReadState();
}
const expanded=new Map();
// Hidden descendants have defaults, not a user choice. Do not freeze those defaults during a refresh.
function preserveExpansions(container) {container.querySelectorAll('details[data-expand]').forEach(d=>{if(!d.parentElement.closest('details:not([open])'))expanded.set(d.dataset.expand,d.open);});}
function restoreExpansions(container) {container.querySelectorAll('details[data-expand]').forEach(d=>{if(expanded.has(d.dataset.expand))d.open=expanded.get(d.dataset.expand);});}
// Remember explicit clicks immediately, including closing a child and then its parent before the next refresh.
document.addEventListener('click',event=>{
  if(event.defaultPrevented || event.target.closest('button,a,input,select,textarea,label'))return;
  const d=event.target.closest('summary')?.parentElement;
  if(d?.matches('details[data-expand]'))expanded.set(d.dataset.expand,!d.open);
});
function error(message) {$('error').textContent=message;$('error').hidden=!message;}
// The empty chat owns one local scene iframe. Leaving it unloads the frame,
// including its animation loop; ordinary state polling preserves the same frame.
function refreshCompanion() {
  const slot=$('transcript').querySelector('.companion-slot');if(!slot)return;
  if(page!=='chat' || document.visibilityState!=='visible'){slot.replaceChildren();return;}
  refreshCompanionNotes();
  if(slot.children.length)return;
  if(!companionsAvailable){slot.textContent='小场景已准备好；本轮结束后更新后端并刷新，即可在这里见面。';return;}
  const frame=document.createElement('iframe');frame.className='companion-frame';
  frame.title='像素陪伴小场景';frame.src='/companion/index.html';
  frame.setAttribute('sandbox','allow-scripts');slot.replaceChildren(frame);
}
let companionsAvailable=false,dailyNotesAvailable=false;
const requestedNoteDays=new Set();
function refreshCompanionNotes() {
  const root=$('transcript').querySelector('.companion-notes');if(!root)return;
  const notes=state?.companion_notes;
  const key=JSON.stringify([dailyNotesAvailable,notes]);
  if(root.dataset.key!==key){
    root.dataset.key=key;root.replaceChildren();
    if(!dailyNotesAvailable){root.textContent='每日留言将在后端更新后出现。';return;}
    const authors=(notes?.messages || []).map(m=>m.author);
    for(const m of notes?.messages || []) {
      const author={sol:'sol',Claude:'claude',DeepSeek:'deepseek'}[m.author];
      // sol sits on the left, Claude on the right; DeepSeek takes whichever side the other one of the day leaves free.
      const right=author==='claude' || author==='deepseek' && authors.includes('sol');
      const row=document.createElement('div');row.className='companion-note-row '+author+(right ? ' right' : '');
      const avatar=document.createElement('img');avatar.className='companion-note-avatar';
      avatar.dataset.who=author==='sol' ? 'codex' : author;avatar.src='/avatars/'+avatar.dataset.who+(author==='deepseek' ? '.png' : '.webp');
      avatar.alt='';avatar.width=44;avatar.height=44;
      const bubble=document.createElement('article');bubble.className='companion-note '+author;
      const name=document.createElement('h2');name.textContent=m.author;
      const text=document.createElement('p');
      text.textContent=m.text || (!notes.enabled ? '留言暂未启用。' : m.status==='writing' ? '正在给你写今天的小留言…' : '今天的留言没能写好，先空着，不拿套话替代。');
      if(!m.text)text.className='companion-note-pending';
      bubble.append(name,text);row.append(avatar,bubble);root.append(row);
    }
  }
  if(notes?.enabled && !notes.attempted && !requestedNoteDays.has(notes.date)) {
    requestedNoteDays.add(notes.date);
    void post('/api/companion/notes').then(n=>{
      if(state){state.companion_notes=n;refreshCompanion();}
    }).catch(()=>{
      if(root.isConnected){const p=document.createElement('p');p.className='companion-note-pending';p.textContent='留言请求没能送达，刷新页面后可以再看。';root.append(p);}
    });
  }
}
document.addEventListener('visibilitychange',refreshCompanion);
async function post(url,data={}) {
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const result=await r.json();if(!r.ok)throw new Error(result.error || '操作失败');return result;
}
const settings=bindSettings({root:$('page-connections'),tabs:$('settings-tabs'),body:$('settings-body'),connections:$('settings-connections'),post,fail:error});
if(matchMedia('(max-width:700px)').matches)document.querySelectorAll('details.usage-more').forEach(d=>{d.open=false;});
const skills=bindSkills({root:$('page-skills'),body:$('skills-body')});
function show(name) {
  if(name!=='chat')voiceInput?.cancel();
  if(name==='more')name=moreLast;if(more.includes(name))moreLast=name;
  // The project deep link must describe the visible page, not a page we left.
  const hash=name==='projects' ? '#projects'+(projectId ? '/'+encodeURIComponent(projectId) : '') : name==='literature' ? '#literature' : location.hash.startsWith('#projects') || location.hash==='#literature' ? '' : location.hash;
  if(location.hash!==hash)history.replaceState(null,'',location.pathname+location.search+hash);
  const changed=page!==name;if(changed){stateRevision++;if(name==='connections')settings.reset();if(name==='skills')skills.reset();}
  const inChat=['chat','history','tasks'].includes(name),inLibrary=['projects','literature'].includes(name);
  $('chat-tabs').hidden=!inChat;$('library-tabs').hidden=!inLibrary;$('page-title').hidden=inChat || inLibrary || more.includes(name);
  document.querySelectorAll('.chat-tab').forEach(b=>{const active=b.dataset.page===name;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  page=name;document.body.classList.toggle('is-chat',name==='chat');$('more-tabs').hidden=!more.includes(name);document.querySelectorAll('.more-tab').forEach(b=>b.classList.toggle('active',b.dataset.page===name || (b.dataset.page==='more' && more.includes(name))));for(const p of Object.keys(pages))$('page-'+p).hidden=p!==name;
  refreshCompanion();
  if(state)renderCurrentPage();
  if(name==='chat'){fitMessage();if(state)updateLatest();}
  $('page-title').textContent=pages[name];document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.page===(inChat ? 'chat' : inLibrary ? 'projects' : more.includes(name) ? 'more' : name)));
  if(state && changed)void load();
}
function selectSession(id='') {
  if(submitting || readingAttachments)return false;
  voiceInput?.cancel();
  savedChatPosition=null;
  saveComposer();sessionId=id;rememberSession();restoreComposer();
  stateRevision++;transcriptKey='';show('chat');if(state)renderChat();
  $('message').focus();
  void load();
  return true;
}
function fitMessage() {
  const input=$('message');if(!input.getClientRects().length)return;
  const style=getComputedStyle(input),min=parseFloat(style.minHeight),max=parseFloat(style.maxHeight);
  input.style.height='0px';input.style.height=Math.max(min,Math.min(input.scrollHeight,max))+'px';
  input.style.overflowY=input.scrollHeight>input.clientHeight ? 'auto' : 'hidden';
}
function names(ids=[]) {return ids.map(id=>state.projects.find(p=>p.id===id)?.name || id).join(' · ') || '共享工作';}
// Share the projects' final-reply/read boundary. A running turn or interim text is not an unread answer.
// A conversation an assistant started by handoff lives inside the conversation that started it (see renderChat), not in the lists.
const kidsOf=s=>state.agent.sessions.filter(c=>c.parent_id===s.id);
const branchOf=s=>s ? sessionBranch(state.agent.sessions,s.id) : [];
function sessionUnreadDot(s) {
  const ids=new Set(branchOf(s).map(c=>c.id));
  const unread=agentUpdates(state).some(u=>ids.has(u.sessionId) && Date.parse(u.at)>Number(agentReadAt[u.sessionId] || 0));
  return unread ? '<span class="live-dot session-unread-dot" role="img" aria-label="有未读回复" title="有已完成的回复尚未查看"></span>' : '';
}
// A session created by a card button or an auto-started step is a task session with its own page; the user speaking in it does not move it into 对话.
const isTask=s=>s.origin==='task';
const sessionTime=s=>s.last_at || s.messages?.at(-1)?.at || s.created_at || '';
const sortedSessions=()=>[...state.agent.sessions].sort((a,b)=>sessionTime(b).localeCompare(sessionTime(a)));
const sessionJobs=s=>state.work.items.filter(j=>s?.task_ids?.includes(j.id) && ['active','queued'].includes(j.status) && !j.merged_into);
// The live speaker may differ from the original executor after a handoff.
const jobProvider=j=>(j.status==='active' && state.agent.active_turns?.find(t=>t.task_id===j.id)?.provider) || j.executor || j.actor;
const subCount=j=>j.status==='active' ? (state.agent.subagents || []).filter(r=>r.task_id===j.id && r.provider===jobProvider(j)).length : 0;
function sessionStatus(s) {
  const jobs=branchOf(s).flatMap(sessionJobs),active=jobs.filter(j=>j.status==='active');
  if(!jobs.length)return '';
  const label=active.length ? [...new Set(active.map(j=>providers[jobProvider(j)] || '助手'))].join(' / ')+' · 正在运行' : '等待执行';
  return `<span class="session-status ${active.length ? 'is-running' : 'is-queued'}"><span class="status-dot"></span>${esc(label)}</span>`;
}
function sessionDeleteButton(s,className) {
  const busy=sessionJobs(s).length>0;
  return `<button type="button" class="${className}" data-session-delete="${esc(s.id)}" title="${busy ? '请先停止排队或运行中的任务' : '删除会话'}" aria-label="删除会话：${esc(s.title)}" ${busy ? 'disabled' : ''}>${ico('trash')}${className==='history-delete' ? '<span>删除</span>' : ''}</button>`;
}
function sessionPinButton(s,className) {
  const label=s.pinned ? '取消置顶' : '置顶到最近会话';
  return `<button type="button" class="${className}" data-session-pin="${esc(s.id)}" aria-pressed="${s.pinned===true}" aria-label="${label}：${esc(s.title)}" title="${pinsAvailable ? label : '置顶需要重启后端加载新版'}" ${pinsAvailable ? '' : 'disabled'}>${ico('pin')}</button>`;
}
const running=s=>sessionJobs(s).some(j=>j.status==='active');
function nextRunningSession() {
  const active=new Set(runningAssistantItems().map(boardTaskId));
  const sessions=sortedSessions().filter(s=>s.task_ids?.some(id=>active.has(id)));
  if(!sessions.length)return false;
  const index=sessions.findIndex(s=>s.id===sessionId);
  selectSession(sessions[(index+1)%sessions.length].id);
  return true;
}
function renderSessionList(prefix) {
  const filter=$(prefix+'-project'),selected=filter.value,tasks=prefix==='tasks';
  const options=JSON.stringify(state.projects.map(p=>[p.id,p.name]));
  if(filter.dataset.options!==options) {
    filter.innerHTML='<option value="">所有项目</option><option value="__shared__">共享工作</option>'+state.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.archived_at ? '（已归档）' : ''}</option>`).join('');
    filter.value=selected;filter.dataset.options=options;
  }
  const query=$(prefix+'-search').value.trim().toLocaleLowerCase();
  if(tasks && state.ui && state.ui.task_query!==query){$(prefix+'-list').setAttribute('aria-busy','true');$(prefix+'-count').textContent='正在检索任务会话…';return;}
  if(tasks)$(prefix+'-list').setAttribute('aria-busy','false');
  const taskHits=tasks && state.ui ? new Set(state.task_search_ids) : null;
  // History search results come from the server (agent search); the task page still filters locally.
  const hits=!tasks && query ? historyHits : null,searching=!tasks && !!query && !historyHits;
  // Task sessions list running work first, then the most recent.
  const order=tasks ? (a,b)=>running(b)-running(a) || sessionTime(b).localeCompare(sessionTime(a)) : null;
  const inProject=s=>!filter.value || (filter.value==='__shared__' ? !s.project_ids?.length : s.project_ids?.includes(filter.value));
  // Task conversations have their own tab; a hit that has since been deleted is dropped.
  const entries=hits ? hits.rows.map(hit=>({hit,s:state.agent.sessions.find(s=>s.id===hit.id)})).filter(({s})=>s && !isTask(s) && !s.parent_id && inProject(s))
    : searching ? [] : (order ? [...sortedSessions()].sort(order) : sortedSessions()).filter(s=>isTask(s)===tasks && !s.parent_id && inProject(s) &&
    (!query || (taskHits ? taskHits.has(s.id) : [s.title,names(s.project_ids),...(s.messages || []).flatMap(m=>[m.text,...(m.attachments || []).map(a=>a.name)])].join('\n').toLocaleLowerCase().includes(query)))).map(s=>({s}));
  $(prefix+'-count').textContent=tasks ? `${entries.length} 条任务会话 · ${entries.filter(({s})=>running(s)).length} 条正在运行 · 运行中的在前，其余按最后活动时间排列`
    : searching ? '搜索中…' : hits?.mode==='error' ? hits.message
    : hits?.mode==='near' ? `没有对话同时包含全部词，下面是按字词片段近似匹配的 ${entries.length} 条候选 · 近似度只是参考，请看片段自己判断`
    : hits ? `找到 ${entries.length} 条对话 · 命中词多的在前，其余按最后活动时间排列` : `找到 ${entries.length} 条对话 · 按最后活动时间排列`;
  $(prefix+'-list').innerHTML=entries.slice(0,hits ? entries.length : listLimit[prefix]).map(({s,hit})=>{
    const messages=(s.messages || []).filter(m=>!m.interim),last=messages.at(-1);
    const preview=s.preview ?? (last?.text || last?.attachments?.map(a=>a.name).join(' · ') || '暂无消息');
    const time=sessionTime(s),date=time ? new Date(time).toLocaleString('zh-CN',{timeZone:'America/Chicago',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '时间未记录';
    const open=hit ? `data-chat-open="${esc(s.id)}" data-chat-task="${esc(hit.snippets[0]?.task_id || '')}"` : `data-session="${esc(s.id)}"`;
    const body=hit ? hit.snippets.map(x=>`<span class="search-snippet"><b>${esc(x.who)} · ${esc(x.day)}</b> ${esc(x.text)}</span>`).join('') || `<span class="history-preview">${esc(preview)}</span>`
      : `<span class="history-preview">${esc(preview)}</span>`;
    return `<div class="history-row"><button type="button" class="history-entry" ${open}><span class="history-title">${esc(s.title || '未命名对话')}</span><span class="history-meta">${esc(names(s.project_ids))}${sessionUnreadDot(s)} · ${s.message_count ?? messages.length} 条消息${hit?.score!==undefined ? ` · 近似度 ${hit.score}%` : ''}</span>${sessionStatus(s)}${body}<span class="history-date">${esc(date)} · Chicago <span>${tasks ? '查看过程 ↗' : '打开并继续 ↗'}</span></span></button>${tasks ? '' : sessionPinButton(s,'history-pin')}${sessionDeleteButton(s,'history-delete')}</div>`;
  }).join('') || (searching ? '' : `<div class="weekly-empty">${tasks ? '还没有任务会话。点收件箱里的“让 agent 处理”，或启动自动步骤后，会出现在这里。' : '没有找到对话。试试其他关键词或项目。'}</div>`);
  $(prefix+'-more').hidden=!!hits || entries.length<=listLimit[prefix];
  if(tasks)$('task-count').textContent=sortedSessions().filter(s=>isTask(s) && running(s)).length || '';
}
const renderHistory=()=>{renderSessionList('history');renderSessionList('tasks');};
// 框架「讨论」栏里的 chat:<会话>#<任务> 引用：打开原会话，滚到该任务的第一条发言并短暂高亮。
async function openChatRef(sid,tid) {
  if(!state.agent.sessions.some(s=>s.id===sid)){error('原对话已不在会话列表里（可能已删除；每日备份里仍有一份）。');return;}
  error('');if(!selectSession(sid))return;await load();if(sessionId!==sid)return;
  const m=tid && [...$('transcript').querySelectorAll('article[data-task]')].find(a=>a.dataset.task===tid);
  if(m){m.scrollIntoView({block:'start'});m.classList.add('is-cited');setTimeout(()=>m.classList.remove('is-cited'),2500);}
}
function renderRecentSessions() {
  const chats=sortedSessions().filter(s=>!isTask(s) && !s.parent_id),recent=[...chats.filter(s=>s.pinned),...chats.filter(s=>!s.pinned).slice(0,20)];
  $('sessions').innerHTML=recent.map(s=>`<div class="session-row"><button class="session-entry ${s.id===sessionId ? 'selected' : ''}" data-session="${esc(s.id)}"><span class="session-title">${esc(s.title)}</span><small class="session-meta"><span>${esc(names(s.project_ids))}</span>${sessionUnreadDot(s)}</small>${sessionStatus(s)}</button>${sessionPinButton(s,'session-pin')}${sessionDeleteButton(s,'session-delete')}</div>`).join('') || '<p class="empty-small">从一件事开始。</p>';
}
// A question is answerable only while its native turn is still waiting; a record left behind by a stopped or restarted turn shows as cancelled.
const questionLive=q=>q.status==='pending' && !!state.agent.active_turns?.some(t=>t.task_id===q.task_id);
function questionHtml(q) {
  const who=esc(providers[q.provider] || '助手'),head=`<div class="question-meta"><strong>${who} 在问你</strong><span>${when(q.asked_at)}</span></div>`;
  if(q.status==='answered')return `<section class="question-card done">${head}${q.items.map(it=>`<p><b>${esc(it.header || it.question)}</b>：${esc((q.answers?.[it.id] || []).join('、'))}</p>`).join('')}</section>`;
  if(!questionLive(q))return `<section class="question-card done">${head}${q.items.map(it=>`<p>${esc(it.question)}</p>`).join('')}<p class="question-note">没有回答，这一问已取消。</p></section>`;
  const item=it=>`<fieldset class="question-item" data-item="${esc(it.id)}" data-multi="${it.multi ? 1 : 0}"><legend>${it.header ? `<b>${esc(it.header)}</b>　` : ''}${esc(it.question)}</legend>${it.options.map(o=>`<label class="question-option"><input type="${it.multi ? 'checkbox' : 'radio'}" name="q-${esc(q.id)}-${esc(it.id)}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}${it.other || !it.options.length ? (!it.multi && it.options.length ? `<div class="question-own"><input type="radio" class="question-own-pick" name="q-${esc(q.id)}-${esc(it.id)}" aria-label="自己写">` : '')+`<input type="text" class="question-other" placeholder="${it.options.length ? '其他（自己写）' : '你的回答'}" aria-label="自己写">`+(!it.multi && it.options.length ? '</div>' : '') : ''}</fieldset>`;
  return `<section class="question-card" data-question="${esc(q.id)}">${head}${q.items.map(item).join('')}<div class="question-actions"><button type="button" data-answer="${esc(q.id)}">提交回答</button></div></section>`;
}
document.addEventListener('focusin',e=>{const own=e.target.closest?.('.question-own');if(own && e.target.matches('.question-other'))own.querySelector('.question-own-pick').checked=true;});
async function submitAnswer(card) {
  const answers={};
  for(const box of card.querySelectorAll('.question-item')) {
    const picked=[...box.querySelectorAll('input:checked:not(.question-own-pick)')].map(i=>i.value),own=box.querySelector('.question-other')?.value.trim();
    // Single choice with options: the write-in is its own radio, so a chosen option is never overridden by leftover text.
    answers[box.dataset.item]=box.dataset.multi==='1' ? [...picked,...(own ? [own] : [])]
      : box.querySelector('.question-own-pick') ? (box.querySelector('.question-own-pick:checked') ? (own ? [own] : []) : picked)
      : own ? [own] : picked;
  }
  await post('/api/chat/answer',{session_id:sessionId,question_id:card.dataset.question,answers});await load();
}
function renderChat() {
  const sessions=state.agent.sessions;
  renderRecentSessions();
  const s=sessions.find(s=>s.id===sessionId);if(sessionId && !s){discardDraft(sessionId);sessionId='';rememberSession();restoreComposer();}
  $('session-title').textContent=s ? s.title+(isTask(s) ? ' · 任务会话' : s.parent_id ? ' · 子对话' : '') : '新对话';
  $('rename-session').hidden=!s;$('rename-session').disabled=!titlesAvailable;
  $('rename-session').title=titlesAvailable ? '修改标题' : '修改标题需要重启后端加载新版';
  const jobs=sessionJobs(s);
  if(s && !s.messages){transcriptKey='';$('transcript').innerHTML='<p class="empty-small">正在读取对话…</p>';return;}
  const kidState=branchOf(s).filter(c=>c.id!==s.id).map(c=>[c.id,c.parent_id,c.handoff_task_id,c.title,c.messages,c.questions?.map(q=>[q,questionLive(q)]),sessionJobs(c).map(j=>[j.id,j.status,jobProvider(j)]),childOpen.get(c.id)]);
  const key=JSON.stringify([sessionId,s?.messages?.length ? markdownAvailable : false,s?.messages?.length ? powershellAvailable : false,s?.messages,s?.questions?.map(q=>[q,questionLive(q)]),jobs.map(j=>[j.id,j.status,jobProvider(j),subCount(j)]),kidState,s?.subagent_runs,[...childOpen]]);
  if(key===transcriptKey){refreshCompanion();restoreChatPosition();updateLatest();return;}
  const transcript=$('transcript'),oldTop=transcript.scrollTop;
  const reset=!transcriptKey,selection=window.getSelection();
  const selecting=selection && !selection.isCollapsed && (transcript.contains(selection.anchorNode) || transcript.contains(selection.focusNode));
  const selected=selecting ? [selection.anchorNode,selection.anchorOffset,selection.focusNode,selection.focusOffset] : null;
  if(selected) {
    const range=selection.getRangeAt(0),backwards=selection.anchorNode!==range.startContainer || selection.anchorOffset!==range.startOffset;
    // A paragraph selection can end at the composer outside the transcript.
    // Pin such an edge to the current chat boundary, not future appended text.
    if(!transcript.contains(selected[0])){selected[0]=transcript;selected[1]=backwards ? transcript.childNodes.length : 0;}
    if(!transcript.contains(selected[2])){selected[2]=transcript;selected[3]=backwards ? 0 : transcript.childNodes.length;}
  }
  const follow=!savedChatPosition && !selecting && (reset || transcript.scrollHeight-transcript.clientHeight-oldTop<80);
  transcriptKey=key;
  if(!s?.messages.length) {
    transcript.innerHTML='<div class="companion-welcome"><div class="companion-slot"></div><section class="companion-notes" aria-label="今天的小留言" aria-live="polite"></section></div>';
    refreshCompanion();
  } else {
    // The optional closing status-summary line is stored as task.brief.
    const briefHtml=(s,m)=>{
      if(m.role!=='assistant' || !m.task_id || m.interim)return '';
      const last=[...s.messages].reverse().find(x=>x.task_id===m.task_id && x.role==='assistant' && !x.interim && !x.subagent);
      const b=last===m ? state.work.items.find(i=>i.id===m.task_id)?.brief : null;
      if(!b)return '';
      const row=(label,text)=>text ? `<p><b>${label}</b> ${esc(text)}</p>` : '';
      return `<details class="handoff-brief" open><summary>状态摘要</summary>${row('目标与结果',b.summary)}${(b.facts || []).map(f=>`<p class="hb-fact">· ${esc(f.text)}${f.source ? ` <small>${esc(f.source)}</small>` : ''}</p>`).join('')}${(b.open || []).map(o=>row('未完成',o)).join('')}${row('接续目标',b.next)}</details>`;
    };
    // A message that has not reached an assistant yet says so: its answer is not the reply that appears below it (that belongs to the turn still running).
    const queueNote=id=>{const i=state.work.items.find(x=>x.id===id);return i?.merged_into ? ' · 已送入当前轮' : i?.status==='queued' && i.input_delivery==='pending' ? ' · 正在提交原生输入' : i?.status==='queued' && state.agent.sessions.some(s=>s.task_ids?.includes(id) && sessionJobs(s).some(j=>j.status==='active')) ? ' · 排队中，等当前轮结束' : '';};
    const messageHtml=(s,m,jobs,inline)=>`<article class="message ${esc(m.role)} ${m.role==='assistant' ? esc(m.provider || '') : ''}" ${m.task_id ? `data-task="${esc(m.task_id)}"` : ''}>${face(m)}<div class="message-meta"><strong>${m.role==='user' ? '用户' : m.role==='error' ? '执行状态' : esc(providers[m.provider] || '助手')}</strong>${m.handoff && !inline ? `<span class="handoff-tag">${m.handoff.receipt ? '交接回执' : '发起交接'} · 来源 <button type="button" class="text-button" data-session="${esc(m.handoff.session_id)}">${esc(m.handoff.session_id.slice(0,8))}#${esc(m.handoff.task_id.slice(0,8))}</button></span>` : ''}${m.subagent ? `<span class="subagent-tag" title="这条是 ${esc(providers[m.provider] || '助手')} 派出的子 agent 说的">子 agent</span>` : ''}<span>${when(m.at)}${m.role==='user' ? queueNote(m.task_id) : ''}${m.handoff_to ? ` · 已登记交接 → ${esc(providers[m.handoff_to] || m.handoff_to)}` : ''}${m.edited ? ` · 已编辑（替换了 ${m.edited.replaced} 条旧发言）` : ''}</span>${!inline && editable(s,m,jobs) ? `<button type="button" class="text-button message-edit-open" data-edit-message="${esc(m.task_id)}">编辑</button>` : ''}</div><div class="message-text ${markdownAvailable ? 'markdown-body' : ''}">${renderMarkdown(m.text,{allowPowerShell:powershellAvailable && m.role==='assistant' && ['codex','claude','deepseek'].includes(m.provider)})}</div>${briefHtml(s,m)}${m.attachments?.length ? `<div class="message-images">${m.attachments.map(a=>a.kind==='file' ? `<a class="message-file" href="/api/chat/file?id=${encodeURIComponent(a.id)}" download><strong>${esc(a.name)}</strong><small>${fileSize(a.size)} · 下载附件 ↓</small></a>` : `<a href="/api/chat/image?id=${encodeURIComponent(a.id)}" target="_blank" rel="noreferrer" title="查看原图"><img src="/api/chat/image?id=${encodeURIComponent(a.id)}" alt="${esc(a.name)}"></a>`).join('')}</div>` : ''}</article>`;
    // A sub-conversation the assistant started sits after the turn that started it; if that turn is gone it goes to the end.
    const kids=kidsOf(s),kidSlot=(c,parent=s)=>{const at=parent.messages.findLastIndex(m=>m.task_id===c.handoff_task_id);return at<0 ? parent.messages.length-1 : at;};
    const childHtml=(c,ancestors=new Set([s.id]))=>{
      if(ancestors.has(c.id))return '';
      const path=new Set([...ancestors,c.id]),msgs=(c.messages || []).filter(m=>!m.interim),cj=sessionJobs(c),branch=branchOf(c),branchJobs=branch.flatMap(sessionJobs),run=branchJobs.some(j=>j.status==='active'),open=childOpen.get(c.id) === true;
      const ask=branch.some(x=>(x.questions || []).some(questionLive));
      const label=run ? `${esc(providers[jobProvider(branchJobs.find(j=>j.status==='active'))] || '助手')} · 正在运行` : branchJobs.length ? '等待执行' : `${msgs.length} 条消息`;
      const last=msgs.findLast(m=>m.role!=='handoff'),peek=last?.text || '';
      const who=msgs[0]?.provider,sub=msgs.find(m=>m.role==='assistant')?.provider;
      const nested=kidsOf(c),body=(c.messages || []).map((m,i)=>(!m.interim ? messageHtml(c,m,cj,true) : '')+nested.filter(k=>kidSlot(k,c)===i).map(k=>childHtml(k,path)).join('')).join('') || nested.map(k=>childHtml(k,path)).join('');
      return `<details class="child-chat" data-child="${esc(c.id)}" ${open ? 'open' : ''}><summary><span class="child-title">${esc(c.title || '子对话')}</span><span class="child-state ${run ? 'is-running' : ''}">${ask ? '有问题等你回答 · ' : ''}${label}</span>${open ? '' : `<span class="child-peek">${esc(peek)}</span>`}</summary><div class="child-body">${body || '<p class="empty-small">暂无消息</p>'}${ask ? '<p class="question-note">这条交接链有问题等你回答，请打开对应子对话的独立页回答。</p>' : ''}<div class="child-actions"><button type="button" class="text-button" data-session="${esc(c.id)}">在独立页继续${sub ? ' · '+esc(providers[sub] || '') : ''} ↗</button></div></div></details>`;
    };
    // A sub-agent the assistant launched is one card at the moment it was launched: what it was asked, what it said midway, what it returned.
    const runs=[...(s.subagent_runs || [])],owners=new Map();
    for(const m of s.messages.filter(m=>m.subagent)){
      let run=runs.find(r=>r.id===m.agent_call && r.task_id===m.task_id && r.provider===m.provider);
      if(!run){
        // Old messages did not retain child identity. Group them honestly, without
        // changing stored history or pretending this is one identified child.
        const id=`legacy:${m.task_id}:${m.provider}:${m.agent_call || ''}`;
        run=runs.find(r=>r.id===id);
        if(!run){run={id,task_id:m.task_id,provider:m.provider,title:`${providers[m.provider] || '助手'} · 历史子 agent 记录`,prompt:'旧记录未保存对应的子任务说明。',status:'ended',legacy:true,at:m.at};runs.push(run);}
      }
      owners.set(m,run);
    }
    const folded=m=>owners.has(m);
    const groups=[];
    for(const run of runs){
      const id=`subagents:${run.task_id}:${run.provider}`;
      let group=groups.find(g=>g.id===id);
      if(!group){group={id,task_id:run.task_id,provider:run.provider,at:run.at,runs:[]};groups.push(group);}
      if(run.at<group.at)group.at=run.at;
      group.runs.push(run);
    }
    const runSlot=r=>{let at=-1;s.messages.forEach((m,i)=>{if(!folded(m) && m.task_id===r.task_id && m.at<=r.at)at=i;});return at<0 ? s.messages.findLastIndex(m=>!folded(m)) : at;};
    const runLive=r=>r.status==='running' && jobs.some(j=>j.id===r.task_id && j.status==='active' && jobProvider(j)===r.provider);
    const runHtml=r=>{
      const live=runLive(r),open=childOpen.get(r.id) === true;
      const label=live ? '运行中' : r.status==='completed' ? '已完成' : r.status==='failed' ? '失败' : '已结束';
      const msgs=s.messages.filter(m=>owners.get(m)===r),peek=r.text || msgs.at(-1)?.text || '';
      const md=x=>`<div class="message-text ${markdownAvailable ? 'markdown-body' : ''}">${renderMarkdown(x,{})}</div>`;
      return `<details class="child-chat sub-run" data-child="${esc(r.id)}" ${open ? 'open' : ''}><summary><span class="child-title">子 agent · ${esc(r.title)}</span><span class="child-state ${live ? 'is-running' : ''}">${label}</span>${open ? '' : `<span class="child-peek">${esc(peek)}</span>`}</summary><div class="child-body"><div class="sub-part"><b>任务说明</b>${md(r.prompt || '（没有记录）')}</div>${msgs.map(m=>messageHtml(s,m,jobs,true)).join('')}<div class="sub-part"><b>返回结果</b>${r.text ? md(r.text) : `<p class="empty-small">${live ? '还没有返回' : '没有返回内容'}</p>`}</div></div></details>`;
    };
    const groupHtml=g=>{
      const known=g.runs.filter(r=>!r.legacy),done=known.filter(r=>r.status==='completed').length,running=known.filter(runLive).length,failed=known.filter(r=>r.status==='failed').length,ended=known.length-done-running-failed;
      const label=[known.length ? `已完成 ${done}/${known.length}` : '',running ? `运行中 ${running}` : '',failed ? `失败 ${failed}` : '',ended ? `已结束 ${ended}` : '',g.runs.length>known.length ? '含历史记录' : ''].filter(Boolean).join(' · ');
      return `<details class="child-chat subagent-group" data-child="${esc(g.id)}" ${childOpen.get(g.id)===true ? 'open' : ''}><summary><span class="child-title">${esc(providers[g.provider] || '助手')} · 子 agent</span><span class="child-state ${running ? 'is-running' : ''}">${label}</span></summary><div class="child-body">${g.runs.map(runHtml).join('')}</div></details>`;
    };
    const messageLines=s.messages.map((m,index)=>folded(m) ? [] : [messageHtml(s,m,jobs),...kids.filter(c=>kidSlot(c)===index).map(c=>childHtml(c)),...groups.filter(g=>runSlot(g)===index).map(groupHtml)]);
    // The agent's own questions sit where they were asked (q.after = how many messages existed then).
    const lines=[],asked=s.questions || [];
    messageLines.forEach((htmls,index)=>{lines.push(...asked.filter(q=>q.after===index).map(questionHtml),...htmls);});
    lines.push(...asked.filter(q=>q.after>=messageLines.length).map(questionHtml));
    lines.push(...jobs.map(j=>{const n=subCount(j);return `<div class="task-running"><span>${esc(j.status==='queued' && j.speakers?.length>1 ? j.speakers.map(p=>providers[p]).join(' → ') : providers[jobProvider(j)])} · ${esc(statuses[j.status])}${n ? ` · 子 agent ${n} 个` : ''}</span><button data-stop="${j.id}">停止</button></div>`;}));
    if(reset)transcript.replaceChildren(); // Switching conversations must not retain the previous one's selection.
    const previous=[...transcript.children],template=document.createElement('template');
    lines.forEach((html,index)=>{
      const old=previous[index];if(old && transcriptSources.get(old)===html)return;
      template.innerHTML=html;const node=template.content.firstElementChild;
      transcriptSources.set(node,html);
      if(old)transcript.replaceChild(node,old);else transcript.appendChild(node);
    });
    previous.slice(lines.length).forEach(node=>node.remove());
    // Native double/triple-click selections can expand when a new sibling is
    // appended. Restore the original endpoints, including backwards selections.
    const validEnd=(node,offset)=>node.isConnected && offset<=(node.nodeType===3 ? node.length : node.childNodes.length);
    if(selected && validEnd(selected[0],selected[1]) && validEnd(selected[2],selected[3]))selection.setBaseAndExtent(...selected);
    transcript.scrollTop=follow ? transcript.scrollHeight : oldTop;
  }
  restoreChatPosition();updateLatest();
}
// Only a plain chat turn of an idle conversation can be edited and regenerated; the server re-checks everything (cards, steered follow-ups, exploration).
const editable=(s,m,jobs)=>editAvailable && s.origin==='chat' && m.role==='user' && m.task_id && !m.inbox_reply && !m.round && !jobs.length &&
  state.work.items.find(i=>i.id===m.task_id)?.mode!=='card' && !state.work.items.find(i=>i.id===m.task_id)?.merged_into;
function openMessageEditor(article,taskId) {
  const s=state.agent.sessions.find(x=>x.id===sessionId),index=s.messages.findIndex(m=>m.role==='user' && m.task_id===taskId);
  if(index<0 || article.querySelector('.message-edit'))return;
  const after=s.messages.length-index-1,box=document.createElement('div');
  box.className='message-edit';
  box.innerHTML=`<textarea aria-label="编辑发言"></textarea><small>保存后，这条之后的 ${after} 条发言会移出当前对话（旧分支存档保留，文件改动不会回退），并从这条重新生成。</small><div class="message-edit-actions"><button type="button" class="text-button" data-edit-cancel>取消</button><button type="button" class="text-button" data-edit-save="${esc(taskId)}">保存并重新生成</button></div>`;
  box.querySelector('textarea').value=s.messages[index].text;
  const text=article.querySelector('.message-text');text.hidden=true;text.after(box);box.querySelector('textarea').focus();
}
function closeMessageEditor(article) {
  article.querySelector('.message-edit')?.remove();article.querySelector('.message-text').hidden=false;
}
async function saveMessageEdit(article,taskId) {
  const text=article.querySelector('.message-edit textarea').value.trim();if(!text)return;
  const job=await post('/api/chat/edit',{session_id:sessionId,task_id:taskId,text});
  transcriptKey='';
  if(job.session && job.task){
    const i=state.agent.sessions.findIndex(x=>x.id===job.session_id);
    if(i<0)state.agent.sessions.push(job.session);else state.agent.sessions[i]=job.session;
    const j=state.work.items.findIndex(t=>t.id===job.task_id);
    if(j<0)state.work.items.push(job.task);else state.work.items[j]=job.task;
    stateRevision++;renderChat();renderOverview();
  }
  void load();
}
function updateLatest() {$('latest').hidden=$('transcript').scrollHeight-$('transcript').clientHeight-$('transcript').scrollTop<80;if(state)markSessionRead();}
const imageTypes=['image/png','image/jpeg','image/webp','image/gif'];
const fileSize=n=>n<1024 ? n+' B' : n<1024*1024 ? (n/1024).toFixed(1)+' KB' : (n/1024/1024).toFixed(1)+' MB';
function renderAttachmentPreviews() {
  $('image-previews').hidden=!pendingAttachments.length;
  $('image-previews').innerHTML=pendingAttachments.map((a,i)=>`<div class="image-preview ${a.kind==='file' ? 'file-preview-card' : ''}">${a.kind==='file' ? `<div class="file-preview-icon">${ico('book')}</div>` : `<img src="${a.data_url}" alt="${esc(a.name)}">`}<span title="${esc(a.name)}">${esc(a.name)}</span><span>${fileSize(a.size)}</span><button type="button" data-remove-image="${i}" aria-label="移除 ${esc(a.name)}" title="移除附件">×</button></div>`).join('');
}
async function addAttachments(files) {
  if(submitting || readingAttachments || !files.length)return;
  error('');readingAttachments=true;$('send').disabled=true;
  try {
    const incoming=files.map(f=>({file:f,kind:imageTypes.includes(f.type) ? 'image' : 'file'}));
    const all=[...pendingAttachments,...incoming.map(a=>({kind:a.kind,size:a.file.size}))];
    if(all.some(a=>a.kind==='file') && !filesAvailable)throw new Error('文件上传需要更新后的服务：等这轮任务结束，再重新打开办公室即可。');
    if(all.some(a=>a.kind==='image') && !imagesAvailable)throw new Error('图片功能需要更新后的服务：等运行中的任务结束，再重新打开办公室即可。');
    const images=all.filter(a=>a.kind==='image'),docs=all.filter(a=>a.kind==='file');
    if(images.length>4)throw new Error('每条消息最多 4 张图片');
    if(images.some(a=>a.size>6*1024*1024))throw new Error('单张图片不能超过 6 MB');
    if(images.reduce((n,a)=>n+a.size,0)>12*1024*1024)throw new Error('图片总大小不能超过 12 MB');
    if(docs.length>fileLimits.count)throw new Error('每条消息最多 '+fileLimits.count+' 个文件（图片另计）');
    if(docs.some(a=>a.size>fileLimits.each))throw new Error('单个文件不能超过 '+fileLimits.each/1024/1024+' MB');
    if(docs.reduce((n,a)=>n+a.size,0)>fileLimits.total)throw new Error('文件总大小不能超过 '+fileLimits.total/1024/1024+' MB（图片另计）');
    const added=await Promise.all(incoming.map(({file:f,kind})=>new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败，请重新选择'));
      reader.onload=()=>resolve({kind,name:f.name || '剪贴板图片',size:f.size,data_url:reader.result});reader.readAsDataURL(f);
    })));
    pendingAttachments.push(...added);renderAttachmentPreviews();saveComposer();
  }catch(e){error(e.message);}finally{readingAttachments=false;$('send').disabled=false;}
}
// Remaining quota changes colour as it runs low, so a tight allowance is visible at a glance.
// Both providers show the window that will run out first.
const tightest=ws=>ws.reduce((a,b)=>b.remaining<a.remaining ? b : a,ws[0]);
const tone=v=>v<20 ? 'crit' : v<45 ? 'warn' : '';
function quotaWindows() {
  const q=state.usage.quota.codex;if(!q?.limits)return [];
  const buckets=q.limits.rateLimitsByLimitId || {codex:q.limits.rateLimits};
  return Object.entries(buckets).flatMap(([id,b])=>['primary','secondary'].filter(k=>b?.[k]).map(k=>{
    const w=b[k],mins=w.windowDurationMins;
    const label=mins>=1440 ? `${Math.round(mins/1440)} 天窗口` : mins>=60 ? `${mins/60} 小时窗口` : `${mins} 分钟窗口`;
    return {label:(Object.keys(buckets).length>1 ? (b.limitName || id)+' · ' : '')+label,remaining:Math.max(0,100-w.usedPercent),resetsAt:w.resetsAt ? w.resetsAt*1000 : null};
  }));
}
// A window whose reset time has passed describes usage that no longer counts; show it as unknown until the next reading.
const claudeWindows=()=>(state.usage.quota.claude?.windows || []).filter(w=>!w.resets_at || Date.parse(w.resets_at)>Date.now());
// The reset time of the window that will run out first, in Chicago time whatever the browser's own zone is.
// A current announced extra reset (Codex only) replaces the natural time; the natural time stays in the tooltip.
const chicago=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
function resetStamp(w,announced) {
  if(!w && !announced)return '';
  const t=w?.resetsAt ? new Date(w.resetsAt) : null,natural=t && Number.isFinite(t.getTime()) ? `${chicago(t)} · Chicago` : '未记录';
  if(announced)return `<small class="header-reset extra" title="${esc(announced.title+'。账号窗口的自然重置时间：'+natural)}">重置 <time datetime="${new Date(announced.end).toISOString()}">${esc(announced.until)}前</time> · 预告</small>`;
  if(!t || !Number.isFinite(t.getTime()))return '<small class="header-reset">重置时间：未记录</small>';
  return `<small class="header-reset">重置 <time datetime="${t.toISOString()}">${esc(natural)}</time></small>`;
}
let headerQuotaMarkup='';
function renderHeaderQuota() {
  const extra=announcedReset(state.usage.quota.extra_resets);
  const codex=tightest(quotaWindows()),claude=tightest(claudeWindows().map(w=>({label:w.label,remaining:w.remaining_percent,resetsAt:w.resets_at})));
  const strip=$('quota-strip'),markup=[{name:'Codex',label:codex?.label || '账号额度',value:codex?.remaining,window:codex},
    {name:'Claude',label:claude?.label || '账号额度',value:claude?.remaining,window:claude}].map(q=>`<button class="header-quota${q.name==='Codex' && extra ? ' reset-announced' : ''}" data-page="usage"><div><span>${esc(q.name)} · ${esc(q.label)} 剩余</span><b>${q.value===undefined ? '—' : q.value+'%'}</b></div><div class="meter">${q.value===undefined ? '' : `<i class="${tone(q.value)}" style="width:${q.value}%"></i>`}</div>${resetStamp(q.window,q.name==='Codex' ? extra : null)}</button>`).join('')+(state.usage.quota.deepseek_provider==='commandcode' ? renderCommandCodeQuota(state.usage.quota.commandcode) : renderDeepSeekBalance(state.usage.quota.deepseek));
  // Keep unchanged nodes: the existing state poll must not restart the flowing light.
  if(markup!==headerQuotaMarkup){strip.innerHTML=markup;headerQuotaMarkup=markup;}
}
// Both the compact rail and the board show the same live queue, not weekly intentions or past chat turns.
const boardStatus=i=>['queued','active'].includes(i.last_execution?.status) ? i.last_execution.status : i.status;
const boardTaskId=i=>i.last_execution?.source_task_id || i.last_execution?.id || i.id;
const unsubmittedOperation=i=>i.status==='open' && i.last_execution?.status==='done' && i.last_execution.outcome_status==='open';
const boardItems=()=>state.work.items.filter(i=>['queued','active'].includes(boardStatus(i)) && !i.operation_id && !i.merged_into && !i.deleted_at);
// User experiments can stay active for days; they are not running chat agents.
const runningAssistantItems=()=>boardItems().filter(i=>boardStatus(i)==='active' && i.actor!=='user');
function renderBoard() {
  const items=boardItems();
  const row=i=>{
    const task=boardTaskId(i);
    const s=state.agent.sessions.find(s=>s.task_ids?.includes(task));
    const blocked=(i.blocked_by || []).map(id=>state.work.items.find(t=>t.id===id)?.title || '未找到的前置任务');
    const repeat=i.status==='done' && ['queued','active'].includes(i.last_execution?.status) ? `<p>${i.last_execution.status==='active' ? '本次正在执行' : '本次已排队'}；原成果保留</p>` : '';
    const waiting=(unsubmittedOperation(i) ? '<p class="board-resume-note">上一轮已结束，未提交完成</p>' : '')+repeat+(blocked.length ? `<p class="board-waiting">等前置：${esc(blocked.join('；'))}</p>` : '');
    const parent=i.parent_id ? `<small>所属操作：${esc(state.work.items.find(t=>t.id===i.parent_id)?.title || i.parent_id)}</small>` : '';
    const title=s ? `<button type="button" class="board-task-title" data-session="${esc(s.id)}" title="打开原对话">${esc(i.title)} <span>↗</span></button>` : `<h3>${esc(i.title)}</h3>`;
    return `<article class="board-task" data-board-task="${esc(i.id)}">${title}<p class="board-task-meta">${esc(providers[jobProvider(i)] || '未指定执行者')} · ${esc(names(i.project_ids))}</p>${parent}${waiting}${!s ? '<small class="muted">尚未关联对话</small>' : ''}</article>`;
  };
  $('board-columns').innerHTML=[['queued','待办','暂无待办任务。'],['active','正在进行','当前没有正在进行的任务。']].map(([status,title,empty])=>{
    const tasks=items.filter(i=>boardStatus(i)===status);
    return `<section class="panel board-column" data-board-status="${status}"><div class="panel-heading"><h2>${title}</h2><span class="board-count">${tasks.length}</span></div><div class="board-task-list">${tasks.map(row).join('') || `<p class="empty-small">${empty}</p>`}</div></section>`;
  }).join('');
  const resumable=state.work.items.filter(i=>!i.turn && !i.operation_id && !i.merged_into && !i.deleted_at && unsubmittedOperation(i));
  if(resumable.length)$('board-columns').insertAdjacentHTML('beforeend',`<section class="panel" data-board-resume style="grid-column:1 / -1"><div class="panel-heading"><h2>待接续</h2><small>${resumable.length} 项</small></div><div class="board-task-list">${resumable.map(row).join('')}</div></section>`);
}
// Context length of the open conversation's native sessions: tokens in the last request over the model window (window unknown until the provider reports it).
// One bar, as wide as the window: with a breakdown from the last finished turn (agent/context-breakdown.mjs) the filled part is split into coloured parts and a legend names them.
const tokenText=n=>n>=1e6 ? +(n/1e6).toFixed(2)+'M' : n>=1000 ? Math.round(n/1000)+'k' : String(n);
const partColor={fixed:'#8d9aa5',summary:'#a88bd6',user:'#5b9bd5',assistant:'#6cc08b',reasoning:'#e5c34f',call:'#f0953a',read:'#e8665d',cmd:'#c47ad6',search:'#37b8c4',web:'#e38bb4',result:'#a3b36b',output:'#4f9e8a'};
const shortLabel=l=>l.split('（')[0];
function contextBar(parts,window) {
  const base=window || parts.reduce((a,p)=>a+p.tokens,0);
  const segs=parts.map(p=>`<i class="ctx-seg" style="width:${(100*p.tokens/base).toFixed(2)}%;background:${partColor[p.key] || '#999'}" title="${esc(p.label)} · ${tokenText(p.tokens)}"></i>`).join('');
  return `<div class="meter ctx-bar" role="img" aria-label="上下文构成：${esc(parts.map(p=>shortLabel(p.label)+' '+tokenText(p.tokens)).join('，'))}">${segs}</div>`;
}
// One legend for everyone: a row per kind of content that occurs, a column per assistant that has a breakdown.
function contextLegend(columns) {
  const order=Object.keys(partColor),kinds=new Map();
  for(const c of columns)for(const p of c.parts)if(!kinds.has(p.key))kinds.set(p.key,p.label);
  const rows=[...kinds].sort((x,y)=>order.indexOf(x[0])-order.indexOf(y[0])).map(([key,label])=>
    `<li title="${esc(label)}"><b style="background:${partColor[key] || '#999'}"></b><em>${esc(shortLabel(label))}</em>${columns.map(c=>`<span>${tokenText(c.parts.find(p=>p.key===key)?.tokens || 0).replace(/^0$/,'—')}</span>`).join('')}</li>`).join('');
  const head=columns.length>1 ? `<li class="ctx-legend-head"><b></b><em></em>${columns.map(c=>`<span>${esc(c.name)}</span>`).join('')}</li>` : '';
  return `<ul class="ctx-legend" style="--cols:${columns.length}">${head}${rows}</ul><small class="ctx-note">分项为估算，截至上一轮结束</small>`;
}
function contextUsage() {
  const context=state.agent.sessions.find(s=>s.id===sessionId)?.context || {};
  const speakers=[['claude','Claude'],['codex','Codex'],['deepseek','DeepSeek']].filter(([id])=>context[id]?.tokens);
  const rows=speakers.map(([id,name])=>{
    const {tokens,window,parts}=context[id],pct=window ? Math.min(100,Math.round(100*tokens/window)) : null;
    const fill=window ? `<div class="meter"><i class="${tone(100-pct)}" style="width:${pct}%"></i></div>` : '',bar=parts?.length ? contextBar(parts,window) : fill;
    return `<div class="quota-mini"><div class="quota-line"><span>${name}</span><span class="${pct===null ? '' : tone(100-pct)}">${tokenText(tokens)}${window ? ' / '+tokenText(window)+' · '+pct+'%' : ''}</span></div>${bar}</div>`;
  });
  const columns=speakers.filter(([id])=>context[id].parts?.length).map(([id,name])=>({name,parts:context[id].parts}));
  return rows.join('')+(columns.length ? contextLegend(columns) : '') || '<p class="empty-small">这个对话还没有读到上下文用量。</p>';
}
function renderOverview() {
  const items=boardItems(),active=items.filter(i=>boardStatus(i)==='active'),queued=items.filter(i=>boardStatus(i)==='queued');
  const assistants=runningAssistantItems();
  $('active-count').textContent=assistants.length || '';$('inbox-count').textContent=state.inbox.length || '';
  $('running').textContent=assistants.length ? `${assistants.length} 项助手任务正在执行` : '';
  $('overview').innerHTML=`<div><strong>${queued.length}</strong><small>待办</small></div><div><strong>${active.length}</strong><small>正在进行</small></div>`;
  $('context-usage').innerHTML=contextUsage();
  $('activity').innerHTML=renderExecutions(state.agent.executions);
}
function renderInbox() {
  preserveExpansions($('inbox-list'));const view=inboxView(state,$('inbox-filter').value);
  $('inbox-total').textContent=view.count;$('inbox-summary').textContent=view.summary;
  $('inbox-list').innerHTML=view.groups;$('inbox-aside').innerHTML=view.aside;restoreExpansions($('inbox-list'));
}
function renderProjects() {
  if(!state)return;
  if(state.ui && state.ui.page!=='projects')return;
  if(dragging())return; // a poll must not replace the nodes being dragged
  if($('project-detail').querySelector('[data-project-related-form] [data-dirty]'))return;
  preserveExpansions($('project-detail'));const view=projectsView(state,projectId,$('project-search').value,renderMarkdown,agentReadAt,editingProject===projectId);
  $('project-grid').innerHTML=view.cards;$('project-overview').hidden=view.selected;$('project-detail').hidden=!view.selected;
  $('project-detail').innerHTML=view.detail;restoreExpansions($('project-detail'));
  bindWorkGraph($('project-detail'));
}
// Clickable week/month grid, with on-demand event details (no duplicate agenda list).
let calMonth='',calDay='',calView='week',calWeek='',calEditing='',calWeekly=null;
const addDays=(date,n)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10);
const mondayOf=date=>addDays(date,-((new Date(date).getUTCDay()+6)%7));
function renderCalendar() {
  const c=state.calendar,weekday='日一二三四五六',kind={deadline:'截止',followup:'复查',event:'事项'};
  const dayN=(a,b)=>Math.round((Date.parse(a)-Date.parse(b))/86400000);
  // What each day shows: an entry with an end date appears on every day it covers.
  if(!calMonth)calMonth=c.today.slice(0,7);if(!calWeek)calWeek=weekSel || mondayOf(c.today);
  const week=calView==='week',limit=week ? Infinity : 3;
  let days,title;
  if(week){days=Array.from({length:7},(_,k)=>addDays(calWeek,k));title=`${calWeek.slice(0,4)} 年 ${+calWeek.slice(5,7)} 月 ${+calWeek.slice(8)} 日 – ${+days[6].slice(5,7)} 月 ${+days[6].slice(8)} 日`;}
  else{
    const [y,m]=calMonth.split('-').map(Number),first=Date.UTC(y,m-1,1),offset=(new Date(first).getUTCDay()+6)%7,total=Math.ceil((offset+new Date(Date.UTC(y,m,0)).getUTCDate())/7)*7;
    days=Array.from({length:total},(_,k)=>new Date(first+(k-offset)*86400000).toISOString().slice(0,10));title=`${y} 年 ${m} 月`;
  }
  // Expand visible days only; long events must not vanish after an arbitrary 62-day cutoff.
  const onDay={};[...new Set([...days,...(calDay ? [calDay] : [])])].forEach(date=>{
    onDay[date]=c.items.filter(i=>i.date<=date && date<=(['calendar','weekly'].includes(i.source) && i.end_date>i.date ? i.end_date : i.date))
      .map(i=>date===i.date ? i : {...i,cont:true});
  });
  // Use the server's Chicago wall-clock fields, never the browser's local timezone.
  const minutes=time=>{const [h,m]=time.split(':').map(Number);return h*60+m;};
  const segments=date=>(onDay[date] || []).filter(i=>!i.all_day).map(i=>{
    const start=i.cont ? 0 : minutes(i.time);
    const end=i.end_date ? (date<i.end_date ? 1440 : i.end_time ? minutes(i.end_time) : 1440) : start;
    return {item:i,start,end,point:end<=start};
  });
  const timed=week ? Object.fromEntries(days.map(date=>[date,segments(date)])) : {};
  const visible=Object.values(timed).flat();
  const firstHour=Math.min(8,...visible.map(s=>Math.floor(s.start/60)));
  const lastHour=Math.min(24,Math.max(18,...visible.map(s=>Math.ceil((s.point ? s.start+60 : s.end)/60))));
  const hourHeight=64,dayHeight=(lastHour-firstHour)*hourHeight;
  const hourLines=Array.from({length:(lastHour-firstHour)*2+1},(_,n)=>`<span class="${n%2 ? 'cal-half-line' : 'cal-hour-line'}" style="top:${n*hourHeight/2}px" aria-hidden="true"></span>`).join('');
  const allDayHeight=week ? Math.max(1,...days.map(date=>(onDay[date] || []).filter(i=>i.all_day).length))*30+12 : 0;
  const chip=(i,extra='',style='',label='')=>`<button type="button" data-cal-open="${esc(calendarItemKey(i))}" aria-haspopup="dialog" aria-expanded="false" class="cal-chip cal-${i.kind}${i.due ? ' cal-due' : ''}${i.over || i.done ? ' cal-over' : ''}${extra}" ${style ? `style="${style}"` : ''} title="${esc(kind[i.kind]+' · '+i.title+(label ? ' · '+label : ''))}">${label ? `<span class="cal-time">${esc(label)} </span><span class="cal-title">${i.done ? '✓ ' : ''}${esc(i.title)}</span>` : (i.cont ? '↳ ' : i.all_day ? '' : esc(i.time)+' ')+(i.done ? '✓ ' : '')+esc(i.title)}</button>`;
  const timeBlocks=date=>{
    const list=timed[date].map(s=>({...s,drawEnd:Math.max(s.end,s.start+30)})).sort((a,b)=>a.start-b.start || b.end-a.end);
    // Overlapping appointments share columns rather than covering each other.
    let group=[],ends=[];
    const flush=()=>{for(const s of group)s.columns=ends.length;group=[];ends=[];};
    for(const s of list){
      if(group.length && s.start>=Math.max(...ends))flush();
      let col=ends.findIndex(end=>end<=s.start);if(col<0)col=ends.length;
      ends[col]=s.drawEnd;s.column=col;group.push(s);
    }
    flush();
    return list.map(s=>{
      const top=(s.start-firstHour*60)/60*hourHeight,height=s.point ? 32 : Math.max(32,(s.end-s.start)/60*hourHeight);
      const i=s.item,label=(i.cont ? '↳ 00:00' : i.time)+(s.point ? ' · '+kind[i.kind] : ' – '+(s.end===1440 ? '24:00' : i.end_time));
      // Leave 4px vertical padding and the 12px time row; use every complete 14px title line.
      const titleLines=Math.max(1,Math.floor((height-16)/14));
      return chip(i,' cal-timed'+(s.point ? ' cal-point' : ''),`top:${top}px;height:${height}px;--cal-title-lines:${titleLines};left:calc(${s.column/s.columns*100}% + 4px);width:calc(${100/s.columns}% - 8px)`,label);
    }).join('');
  };
  const cells=days.map(date=>{
    const items=onDay[date] || [];
    const chips=week ? `<span class="cal-allday">${items.filter(i=>i.all_day).map(i=>chip(i)).join('')}</span><span class="cal-timeline">${hourLines}${timeBlocks(date)}</span>` : items.slice(0,limit).map(i=>chip(i)).join('');
    const cls=['cal-cell',new Date(date).getUTCDay()%6===0 && 'cal-weekend',!week && date.slice(0,7)!==calMonth && 'cal-other',date===c.today && 'cal-today',date===calDay && 'cal-selected'].filter(Boolean).join(' ');
    return `<div class="${cls}" data-cal-day="${date}" role="group" aria-label="${date}，${items.length} 项日程"><button type="button" class="cal-day-button" aria-pressed="${date===calDay}" aria-label="选择 ${date} 周${weekday[new Date(date).getUTCDay()]}">${week ? +date.slice(5,7)+'/'+ +date.slice(8) : +date.slice(8)}${date===c.today ? '<small>今天</small>' : ''}</button>${chips}${items.length>limit ? `<button type="button" class="cal-more" data-cal-more="${date}">还有 ${items.length-limit} 项 ↗</button>` : ''}</div>`;
  });
  const step=week ? '周' : '个月';
  const axis=week ? `<div class="cal-time-axis" aria-hidden="true"><div class="cal-axis-spacer"><span>全天</span></div><div class="cal-hours">${Array.from({length:lastHour-firstHour+1},(_,n)=>`<span style="top:${n*hourHeight}px">${String(firstHour+n).padStart(2,'0')}:00</span>`).join('')}</div></div>` : '';
  $('calendar-grid').innerHTML=`<div class="cal-head"><div class="cal-navigation"><button type="button" data-cal-nav="-1" aria-label="上一${step}">‹</button><button type="button" data-cal-nav="1" aria-label="下一${step}">›</button><button type="button" data-cal-nav="0">今天</button></div><strong>${title}</strong><div class="cal-tools"><span class="cal-switch" role="group" aria-label="日历视图"><button type="button" data-cal-view="week" aria-pressed="${week}" class="${week ? 'on' : ''}">周</button><button type="button" data-cal-view="month" aria-pressed="${!week}" class="${week ? '' : 'on'}">月</button></span><button type="button" class="cal-add" data-cal-new="">＋ 新增</button></div></div><div class="cal-legend"><span class="cal-legend-event">事项 / 工作块</span><span class="cal-legend-deadline">截止</span><span class="cal-legend-followup">复查</span><small>${week ? '芝加哥时间 · 点击事件查看详情' : '点击事件查看详情'}</small></div><div class="cal-scroll" tabindex="0" role="region" aria-label="${week ? '周日程时间轴' : '月日程'}，窄屏可横向滚动"><div class="cal-grid${week ? ' cal-week' : ''}" ${week ? `style="--cal-day-height:${dayHeight}px;--cal-allday-height:${allDayHeight}px;--cal-hour-height:${hourHeight}px"` : ''}>${week ? '<span class="cal-dow cal-zone">时间</span>' : ''}${[...'一二三四五六日'].map((d,n)=>`<span class="cal-dow${n>4 ? ' cal-weekend' : ''}">周${d}</span>`).join('')}${axis}${cells.join('')}</div></div>`;
  const near=c.items.filter(i=>!i.over && dayN(i.date,c.today)<=14);
  $('calendar-summary').textContent=`未来 14 天及已到期 ${near.length} 项 · 芝加哥时间`;
  $('calendar-problems').innerHTML=c.problems.length ? `<div class="weekly-empty">有 ${c.problems.length} 个日期读不出来，没有计入日程：${c.problems.map(p=>esc(p.title)+'（'+esc(p.field)+'='+esc(p.value)+'）').join('；')}</div>` : '';
  refreshCalendarDetail();
}
const calendarItemKey=item=>JSON.stringify([item.source,item.kind,item.source_id]);
function closeCalendarDetail(){if($('cal-detail').matches(':popover-open'))$('cal-detail').hidePopover();}
function openCalendarDetail(button,focus=true) {
  const item=state.calendar.items.find(i=>calendarItemKey(i)===button.dataset.calOpen);if(!item)return;
  const detail=$('cal-detail'),weekday='日一二三四五六'[new Date(item.date+'T12:00Z').getUTCDay()];
  const clock=(item.all_day ? '全天' : item.time)+(item.end_date ? ' – '+(item.end_date!==item.date ? item.end_date+' ' : '')+(item.end_time || '全天结束') : '');
  const project=(item.project_ids || []).map(id=>state.projects.find(p=>p.id===id)?.name || id).join('、');
  const rule=item.series?.recurrence,repeat=rule ? `每 ${rule.interval} ${{daily:'天',weekly:'周',monthly:'月',yearly:'年'}[rule.frequency]}重复${rule.until ? ' · 至 '+rule.until : ''}` : '';
  const editable=['calendar','weekly'].includes(item.source),source={calendar:'日程',weekly:'周目标工作块',mail:'邮件',work:'任务'}[item.source] || '日程';
  detail.dataset.key=calendarItemKey(item);detail.dataset.day=button.closest('[data-cal-day]').dataset.calDay;detail.dataset.kind=item.kind;
  detail.innerHTML=`<div class="cal-detail-top"><span>${source} · ${{event:'事项',deadline:'截止',followup:'复查'}[item.kind]}</span><button type="button" popovertarget="cal-detail" popovertargetaction="hide" aria-label="关闭日程详情">×</button></div><h3 id="cal-detail-title">${esc(item.title)}</h3><p class="cal-detail-when">${esc(item.date)} 周${weekday}<br>${esc(clock)} <small>America/Chicago</small></p>${repeat ? `<p class="cal-detail-repeat">↻ ${esc(repeat)}</p>` : ''}${project ? `<p class="cal-detail-project">${esc(project)}</p>` : ''}${item.note ? `<p class="cal-detail-note">${esc(item.note)}</p>` : ''}${editable ? `<div class="cal-detail-actions"><button type="button" class="secondary small" data-cal-edit="${esc(item.source_id)}">修改</button><button type="button" class="secondary small" data-cal-delete="${esc(item.source_id)}">${item.source==='weekly' ? '取消排期' : '删除'}</button></div>` : `<p class="cal-form-hint">来自${source}，请在原事项中修改。</p>`}`;
  if(!detail.matches(':popover-open'))detail.showPopover();
  positionCalendarDetail(button);
  document.querySelectorAll('[data-cal-open]').forEach(b=>b.setAttribute('aria-expanded',String(b===button)));
  if(focus)detail.focus({preventScroll:true});
}
function positionCalendarDetail(button){
  const detail=$('cal-detail'),rect=button.getBoundingClientRect(),width=detail.offsetWidth,height=detail.offsetHeight,gap=12;
  const side=rect.right+gap+width<=innerWidth ? rect.right+gap : rect.left-gap-width>=gap ? rect.left-gap-width : Math.min(rect.left,innerWidth-width-gap);
  const top=side>rect.right || side+width<rect.left ? rect.top : rect.bottom+gap+height<=innerHeight ? rect.bottom+gap : rect.top-height-gap;
  detail.style.left=Math.max(gap,Math.min(side,innerWidth-width-gap))+'px';detail.style.top=Math.max(gap,Math.min(top,innerHeight-height-gap))+'px';
}
const calendarDetailAnchor=()=>[...document.querySelectorAll('[data-cal-open]')].find(b=>b.dataset.calOpen===$('cal-detail').dataset.key && b.closest('[data-cal-day]').dataset.calDay===$('cal-detail').dataset.day);
function refreshCalendarDetail(){
  const detail=$('cal-detail');if(!detail.matches(':popover-open'))return;
  const anchor=calendarDetailAnchor();
  if(anchor)openCalendarDetail(anchor,false);else closeCalendarDetail();
}
$('cal-detail').addEventListener('toggle',e=>{if(e.newState==='closed')document.querySelectorAll('[data-cal-open][aria-expanded=true]').forEach(b=>b.setAttribute('aria-expanded','false'));});
window.addEventListener('resize',closeCalendarDetail);
document.addEventListener('scroll',e=>{const detail=$('cal-detail');if(detail.matches(':popover-open') && !detail.contains(e.target)){const anchor=calendarDetailAnchor();if(anchor)positionCalendarDetail(anchor);else closeCalendarDetail();}},true);
document.addEventListener('click',e=>{if(e.target.closest('[data-page],[data-cal-nav],[data-cal-view]'))closeCalendarDetail();});
const calEventTemplate=$('cal-event-fields').innerHTML;
const calField=(card,name)=>card.querySelector(`[name="${name}"]`);
const calCards=()=>[...$('cal-event-fields').querySelectorAll('[data-cal-event]')];
function numberCalendarCards() {
  const cards=calCards(),ids={date:'date',time:'time',end_date:'end-date',end_time:'end-time'};
  cards.forEach((card,index)=>{
    card.setAttribute('aria-label',`时间段 ${index+1}`);card.querySelector('.cal-event-number').textContent=String(index+1).padStart(2,'0');
    card.querySelector('[data-cal-event-label]').textContent=`时间段 ${index+1}`;card.querySelector('[data-cal-event-remove]').hidden=cards.length===1 || !!calEditing;
    for(const [name,id] of Object.entries(ids))calField(card,name).id='cal-'+id+(index ? '-'+index : '');
  });
}
function calendarSaveSummary() {
  const count=calCards().length,frequency=$('cal-repeat').value,interval=$('cal-interval').value || '—',unit={daily:'天',weekly:'周',monthly:'月',yearly:'年'}[frequency];
  $('cal-interval-unit').textContent=unit || '天';
  $('cal-save-summary').textContent=(calEditing ? '将保存修改' : `同一主题 · ${count} 个时间段`)+(frequency ? ` · 每 ${interval} ${unit}重复` : ' · 不重复');
  $('cal-form').querySelector('[type=submit]').textContent=count>1 ? `保存 ${count} 个时间段` : '保存';
}
function openCalendarForm(item,date) {
  closeCalendarDetail();
  $('cal-event-fields').innerHTML=calEventTemplate;
  const select=$('cal-project');
  select.length=1;state.projects.filter(p=>!p.archived_at || item?.project_ids?.includes(p.id)).forEach(p=>select.add(new Option(p.name+(p.archived_at ? '（已归档）' : ''),p.id)));
  calEditing=item?.series?.id || item?.source_id || '';
  calWeekly=item?.source==='weekly' ? {week:item.week,id:item.intent_id} : null;
  $('cal-form-title').textContent=calWeekly ? '修改周目标工作块' : item?.series ? '修改整个重复系列' : item ? '修改事项' : '新增日程';
  $('cal-form-subtitle').textContent=calWeekly ? '只调整这个工作块的时间，目标内容仍在下方修改。' : item?.series ? '修改应用于该事项的整个系列，已删除的单次仍保持删除。' : item ? '调整这个事项的内容与时间。' : '主题只填一次，添加时间段即可安排在不同日期或时刻。';
  $('cal-add-event').hidden=!!item;$('cal-repeat-title').closest('section').hidden=!!calWeekly;
  $('cal-repeat-scope').textContent=item ? '仅应用于当前事项' : '应用于所有时间段';
  $('cal-title').value=item?.title || '';$('cal-kind').value=item?.kind==='deadline' ? 'deadline' : 'event';
  const dates=item?.series || item;
  $('cal-date').value=dates?.date || date || state.calendar.today;$('cal-time').value=dates?.time || '';
  $('cal-end-date').value=dates?.end_date || '';$('cal-end-time').value=dates?.end_time || '';
  $('cal-repeat').value=item?.series?.recurrence.frequency || '';$('cal-interval').value=item?.series?.recurrence.interval || 1;$('cal-until').value=item?.series?.recurrence.until || '';
  select.value=item?.project_ids?.[0] || '';$('cal-note').value=item?.note || '';
  for(const id of ['cal-title','cal-kind','cal-project','cal-note','cal-repeat'])$(id).disabled=!!calWeekly;
  $('cal-error').hidden=true;numberCalendarCards();syncCalendarKind();syncCalendarRepeat();$('cal-form').hidden=false;$('cal-dialog').showModal();$('cal-dialog').querySelector('.cal-dialog-body').scrollTop=0;$(calWeekly ? 'cal-date' : 'cal-title').focus();
}
const syncCalendarKind=()=>calCards().forEach(card=>card.querySelectorAll('.cal-span').forEach(l=>{l.hidden=$('cal-kind').value==='deadline';l.querySelector('input').disabled=l.hidden;}));
$('cal-kind').addEventListener('change',syncCalendarKind);
// A simple 24-hour field, with optional half-hour suggestions instead of the OS hour/minute/AM-PM widget.
$('cal-time-options').innerHTML=Array.from({length:48},(_,n)=>`<option value="${String(Math.floor(n/2)).padStart(2,'0')}:${n%2 ? '30' : '00'}"></option>`).join('');
function calendarClock(value) {
  const text=value.trim().replace('：',':');if(!text)return '';
  let hour,minute;
  if(/^\d{1,2}:\d{2}$/.test(text))[hour,minute]=text.split(':').map(Number);
  else if(/^\d{1,4}$/.test(text)){hour=Number(text.length<=2 ? text : text.slice(0,-2));minute=text.length<=2 ? 0 : Number(text.slice(-2));}
  else return null;
  return hour<24 && minute<60 ? `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` : null;
}
$('cal-event-fields').addEventListener('input',e=>{if(e.target.matches('[data-cal-clock]'))e.target.setCustomValidity(calendarClock(e.target.value)===null ? '请输入有效的24小时制时间，如09:30或0930（00:00–23:59）' : '');});
$('cal-event-fields').addEventListener('focusout',e=>{if(e.target.matches('[data-cal-clock]')){const time=calendarClock(e.target.value);if(time!==null)e.target.value=time;}});
const syncCalendarRepeat=()=>{const repeat=!!$('cal-repeat').value;document.querySelectorAll('#cal-form .cal-recurrence').forEach(l=>l.hidden=!repeat);$('cal-repeat-hint').hidden=!repeat;$('cal-interval').disabled=!repeat;$('cal-until').disabled=!repeat;calendarSaveSummary();};
$('cal-repeat').onchange=syncCalendarRepeat;
$('cal-form').addEventListener('input',()=>{if(!$('cal-error').hidden){$('cal-error').hidden=true;error('');}calendarSaveSummary();});
$('cal-add-event').onclick=()=>{
  if(calEditing)return;
  const template=document.createElement('template');template.innerHTML=calEventTemplate;
  const card=template.content.querySelector('[data-cal-event]');
  calField(card,'date').value=$('cal-date').value;
  $('cal-event-fields').append(card);numberCalendarCards();syncCalendarKind();calendarSaveSummary();calField(card,'date').focus();
};
$('cal-event-fields').addEventListener('click',e=>{
  const button=e.target.closest('[data-cal-event-remove]');if(!button || calEditing || calCards().length<=1)return;
  button.closest('[data-cal-event]').remove();numberCalendarCards();calendarSaveSummary();calField(calCards()[0],'date').focus();
});
const closeCalendarForm=()=>{if(!$('cal-error').hidden)error('');$('cal-dialog').close();$('cal-form').hidden=true;calEditing='';calWeekly=null;};
$('cal-dialog').addEventListener('cancel',e=>{e.preventDefault();closeCalendarForm();});
$('cal-form').onsubmit=async e=>{
  e.preventDefault();
  const specs=calCards().map(card=>{
    const get=name=>calField(card,name).value,kind=$('cal-kind').value,date=get('date'),time=calendarClock(get('time')),endDate=get('end_date'),endTime=calendarClock(get('end_time'));
    const start=time ? date+'T'+time : date,end=kind==='event' && (endTime || (endDate && endDate!==date)) ? (endDate || date)+(endTime ? 'T'+endTime : '') : '';
    return {title:$('cal-title').value,kind,start,end,project_id:$('cal-project').value,note:$('cal-note').value};
  });
  const date=$('cal-date').value;
  const frequency=$('cal-repeat').value,recurrence=frequency ? {frequency,interval:Number($('cal-interval').value),until:$('cal-until').value} : null;
  const body={...specs[0],recurrence};
  const submit=$('cal-form').querySelector('[type=submit]');submit.disabled=true;$('cal-error').hidden=true;
  try {
    if(calWeekly)await post('/api/weekly/intent/update',{...calWeekly,schedule:{start:body.start,end:body.end}});
    else if(calEditing)await post('/api/calendar/update',{id:calEditing,...body});
    else await post('/api/calendar/add',specs.length>1 ? {events:specs,recurrence} : body);
    closeCalendarForm();setWeek(mondayOf(date),date);calMonth=date.slice(0,7);await load();
  } catch(err) {error(err.message);$('cal-error').textContent=err.message;$('cal-error').hidden=false;$('cal-error').scrollIntoView({block:'nearest'});}
  finally {submit.disabled=false;}
};
let calDeleting=null;
$('cal-delete-dialog').addEventListener('close',()=>{calDeleting=null;});
$('cal-delete-dialog').addEventListener('click',async e=>{
  if(e.target.closest('[data-cal-delete-cancel]')){$('cal-delete-dialog').close();return;}
  const button=e.target.closest('[data-cal-remove]');if(!button || !calDeleting)return;
  const item=calDeleting,buttons=[...$('cal-delete-dialog').querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try {
    await post('/api/calendar/remove',{id:item.series.id,scope:button.dataset.calRemove,occurrence_date:item.occurrence_date});
    $('cal-delete-dialog').close();if(calEditing===item.series.id)closeCalendarForm();await load();
  } catch(err){$('cal-delete-error').textContent=err.message;$('cal-delete-error').hidden=false;}
  finally {buttons.forEach(b=>b.disabled=false);}
});
document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-cal-nav]'),day=e.target.closest('[data-cal-day]'),view=e.target.closest('[data-cal-view]'),add=e.target.closest('[data-cal-new]'),edit=e.target.closest('[data-cal-edit]'),del=e.target.closest('[data-cal-delete]'),chip=e.target.closest('[data-cal-open]'),more=e.target.closest('[data-cal-more]');
  try {
    if(chip){openCalendarDetail(chip);return;}
    if(more){closeCalendarDetail();calView='week';setWeek(mondayOf(more.dataset.calMore),more.dataset.calMore);return;}
    if(nav){
      const n=+nav.dataset.calNav,today=state.calendar.today;
      // In the week view the calendar IS the selected week; its arrows move the whole page. In the month view they only page months.
      if(!n){setWeek(mondayOf(today));calMonth=today.slice(0,7);renderCalendar();}
      else if(calView==='week')setWeek(addDays(calWeek,7*n));
      else{const [y,m]=calMonth.split('-').map(Number);calMonth=new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);calDay='';renderCalendar();}
    }
    else if(view){
      if(view.dataset.calView==='month'){calMonth=(calDay || addDays(calWeek,3)).slice(0,7);calView='month';renderCalendar();}
      else{calView='week';setWeek(mondayOf(calDay || (calMonth===state.calendar.today.slice(0,7) ? state.calendar.today : calMonth+'-01')),calDay);}
    }
    else if(add)openCalendarForm(null,add.dataset.calNew || calDay);
    else if(edit)openCalendarForm(state.calendar.items.find(i=>['calendar','weekly'].includes(i.source) && i.source_id===edit.dataset.calEdit));
    else if(del){
      const item=state.calendar.items.find(i=>['calendar','weekly'].includes(i.source) && i.source_id===del.dataset.calDelete);
      closeCalendarDetail();
      if(item?.series){
        calDeleting=item;$('cal-delete-description').textContent=`“${item.title}” · ${item.date}${item.time ? ' '+item.time : ' 全天'}`;
        $('cal-delete-error').hidden=true;$('cal-delete-dialog').showModal();return;
      }
      const message=item?.source==='weekly' ? `取消“${item.title}”的排期？周目标保留，下次自动排期不会重新填入。` : `删除“${item?.title}”？这只删除该手动事项，不会删除邮件或任务；未经过每日备份的事项可能没有备份。`;
      if(item && confirm(message)){
        if(item.source==='weekly')await post('/api/weekly/intent/update',{week:item.week,id:item.intent_id,schedule:null});
        else await post('/api/calendar/remove',{id:item.source_id});
        if(calEditing===item.source_id)closeCalendarForm();await loadWeek();await load();
      }
    }
    else if(e.target.closest('[data-cal-cancel]'))closeCalendarForm();
    else if(day){calDay=day.dataset.calDay===calDay ? '' : day.dataset.calDay;if(calDay){calMonth=calDay.slice(0,7);if(calView==='week' && (calDay<calWeek || calDay>addDays(calWeek,6)))calWeek=mondayOf(calDay);}renderCalendar();}
  } catch(err) {error(err.message);}
});

// ---- weekly page: one selected week drives the calendar above and the plan / review below ----------------------------------------------------
// The page data for a week is fetched on request (/api/weekly/week); nothing here is stored by the page. While a field in the body has unsaved
// input, the periodic refresh leaves the body alone so typing is never wiped; saving, cancelling or changing week redraws it.
let weekSel='',weekData=null,weekEdit='',weekRequest=0;
const weekDirty=()=>!!$('weekly-body').querySelector('[data-dirty]');
const weeklyBusy=()=>{const a=document.activeElement;return weekDirty() || !!(a && $('weekly-body').contains(a) && a.matches('input:not([type=checkbox]),textarea,select'));};
const discardOk=()=>!weekDirty() || confirm('这一页有未保存的输入，继续会丢弃。');
async function loadWeek(force=false) {
  if(!state)return;
  if(!weekSel)weekSel=calWeek || state.weekly.window.start;
  const asked=weekSel,id=++weekRequest;
  try {
    const r=await fetch('/api/weekly/week?start='+encodeURIComponent(asked)),data=await r.json();
    if(!r.ok)throw new Error(data.error || '周数据读取失败');
    if(id!==weekRequest || asked!==weekSel)return;   // a newer request or another week took over
    weekData=data;renderWeekly(force);
  } catch(e) {error(e.message);}
}
// Select a week (by its Monday): the calendar follows, the plan reloads.
function setWeek(monday,keepDay='') {
  if(!discardOk())return;
  weekSel=monday;calWeek=monday;calDay=keepDay;calMonth=addDays(monday,3).slice(0,7);weekEdit='';weekData=null;
  $('weekly-body').innerHTML='<p class="empty-small">读取中…</p>';
  renderCalendar();void loadWeek(true);
}
function renderWeekly(force=false) {
  if(!state)return;
  const cur=state.weekly.window.start;
  if(!weekData || weekData.window.start!==weekSel){$('week-label').textContent=weekSel;return;}
  const v=weekData,w=v.window,rel=w.start===cur ? '本周（进行中）' : w.start<cur ? '过去的一周' : '之后的一周';
  $('week-label').textContent=`${w.start} — ${w.end.slice(5)}`;
  $('weekly-range').textContent=`${rel} · 日程和计划跟随所选周`;
  if(!force && weeklyBusy())return;
  preserveExpansions($('weekly-body'));
  $('weekly-body').innerHTML=planBody(v);
  restoreExpansions($('weekly-body'));
}
function planBody(v) {
  const intents=v.plan?.intents || [],all=state.projects;
  const intentCard=i=>{
    if(weekEdit===i.id) {
      const choices=all.filter(p=>!p.archived_at || i.project_ids.includes(p.id));
      return `<form class="week-item intent-edit" data-intent-form="${esc(i.id)}"><label>目标<input name="title" required value="${esc(i.title)}"></label><label>预期产出 <small>可选</small><input name="expected" value="${esc(i.expected)}"></label><div class="intent-projects">${choices.map(p=>`<label><input type="checkbox" name="project" value="${esc(p.id)}"${i.project_ids.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}${p.archived_at ? '（已归档）' : ''}</label>`).join('')}</div><div class="cal-form-actions"><button type="submit" class="primary small">保存</button><button type="button" class="secondary small" data-intent-cancel>取消</button></div></form>`;
    }
    const task=i.task_id ? state.work.items.find(t=>t.id===i.task_id) : null;
    const time=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const schedule=i.schedule?.start ? `已排期：${time(i.schedule.start)} – ${time(i.schedule.end)}（芝加哥）` : i.schedule?.locked ? '你已取消排期；自动安排暂不重新填入' : i.scheduling_note ? '待安排：'+i.scheduling_note : '';
    return `<div class="week-item${i.task_status==='done' ? ' goal-done' : ''}"><strong>${esc(i.title)}</strong>${i.expected ? `<p>预期产出：${esc(i.expected)}</p>` : ''}<p class="muted">${esc(names(i.project_ids))}${i.minutes ? ' · 预计 '+i.minutes+' 分钟' : ''}</p>${i.origin?.reason ? `<p class="muted">选择依据：${esc(i.origin.reason)}</p>` : ''}${schedule ? `<p>${esc(schedule)}</p>` : ''}<div class="project-footer"><small>${goalLamp(i) || '未关联任务'}${task ? ' · '+providers[task.actor] : ''}</small><span>${chatOf(i) ? `<button class="text-button" data-intent-chat="${esc(i.id)}">进入对话 ↗</button>` : task || i.task_id ? '' : `<button class="text-button" data-intent="${esc(i.id)}">推进这件事 ↗</button>`}${i.schedule?.locked ? `<button class="text-button" data-intent-auto="${esc(i.id)}">允许下次自动排期</button>` : ''}<button class="text-button" data-intent-edit="${esc(i.id)}">修改</button><button class="text-button" data-intent-remove="${esc(i.id)}">移除</button></span></div></div>`;
  };
  const chatOf=i=>{const id=i.origin?.chat_task || i.task_id;return id ? state.agent.sessions.find(s=>s.task_ids.includes(id)) : null;};
  return `<article class="panel"><div class="panel-heading"><h2>本周计划 · ${intents.length}</h2>${timeSummary(intents)}<button type="button" class="text-button" data-weekly-chat="plan">在对话中生成 ↗</button></div>${intents.map(intentCard).join('') || '<p class="empty-small">这一周还没有计划。在对话里让我们根据项目生成，生成后会出现在这里和日历里。</p>'}</article>`+completedBody(v)+reportsBody(v);
}
function completedBody(v) {
  // Reuse the weekly ledger's settled deliveries, not the plan's current checkmarks or every finished chat turn.
  const latest=(list,kind)=>(list || []).map(i=>({...i,kind})).sort((a,b)=>Date.parse(b.completed_at)-Date.parse(a.completed_at));
  const items=latest(v.facts?.completed,'看板交付'),other=latest(v.facts?.other,'看板外交付');
  const card=i=>{
    const session=state.agent.sessions.find(s=>s.task_ids.includes(i.id));
    const time=new Date(i.completed_at).toLocaleString('zh-CN',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    return `<div class="week-item completed-item"><strong>✓ ${esc(i.title)}</strong><p class="muted">${esc(names(i.project_ids))} · ${esc(i.kind)} · ${esc(time)}（芝加哥）</p><details data-expand="weekly-completed:${esc(v.window.start)}:${esc(i.id)}"><summary>结果与产出${i.outputs.length ? ' · '+i.outputs.length+' 个文件' : ''}</summary><p class="message-text">${esc(i.outcome || '未记录结果说明')}</p>${i.outputs.map(o=>`<code class="file-name">${esc(o)}</code>`).join('')}</details>${session ? `<button type="button" class="text-button" data-session="${esc(session.id)}">进入对话 ↗</button>` : ''}</div>`;
  };
  const more=items.length>5 ? `<details class="completed-overflow" data-expand="weekly-completed:${esc(v.window.start)}:more"><summary>查看其余 ${items.length-5} 项</summary>${items.slice(5).map(card).join('')}</details>` : '';
  const outside=`<details class="completed-other" data-expand="weekly-completed:${esc(v.window.start)}:other"><summary>看板外的其他真实交付 · ${other.length}</summary>${other.map(card).join('') || '<p class="empty-small">这一周没有看板外的其他真实交付。</p>'}</details>`;
  return `<article class="panel weekly-completed"><div class="panel-heading"><h2>本周看板交付 · ${items.length}</h2><span class="muted">${esc(v.window.start)} 至 ${esc(v.window.end)}</span></div><p class="muted">只列任务步骤本身，按完成时间汇总；待确认／验收的交付暂不计入。</p>${items.slice(0,5).map(card).join('') || '<p class="empty-small">这一周还没有已确认的看板交付。</p>'}${more}${outside}<p class="muted completed-handled">仅文字的对话轮 · ${Number(v.facts?.handled || 0)}（只计数，不逐条列出）</p></article>`;
}
// Monday group meeting: one PPT with three parts, made with the assistants in a chat that starts from the week's data. Nothing is stored here.
// Estimated time of what is still open, against what already sits on the calendar.
function timeSummary(intents) {
  const open=intents.filter(i=>i.task_status!=='done'),est=open.reduce((n,i)=>n+(i.minutes || 0),0),unest=open.filter(i=>!i.minutes).length;
  const placed=open.reduce((n,i)=>n+(i.schedule?.start ? Math.round((Date.parse(i.schedule.end)-Date.parse(i.schedule.start))/60000) : 0),0),hours=m=>(m/60).toFixed(1).replace(/.0$/,'')+' 小时';
  return open.length ? `<span class="muted plan-time">预计 ${hours(est)} · 已排入日历 ${hours(placed)}${unest ? ' · '+unest+' 项未估时' : ''}</span>` : '';
}
function reportsBody(v) {
  const w=v.window;
  return `<article class="panel"><div class="panel-heading"><h2>周一组会报告</h2><span class="muted">一份 PPT · 上周 ${w.previous_start} 至 ${w.previous_end}</span></div><div class="week-item"><strong>组会 PPT</strong><p class="muted">① 上周进度（一页）② 本周安排（一页）③ 上周进度详细汇报（多页）</p><button type="button" class="text-button" data-weekly-chat="meeting">在对话中制作 ↗</button></div></article>`;
}
// Each entry opens a new chat with a ready first message; the user reads it and sends. Same pattern as the project-node chat.
function weeklyChat(key) {
  const w=weekData?.window;if(!w)return;
  const last=`${w.previous_start} 至 ${w.previous_end}`;
  const text={
    plan:`帮我生成这一周（${w.start} 至 ${w.end}）的周计划。按 weekly-planning skill（.agents/skills/weekly-planning/SKILL.md）来做：先读它的 settings.md，只问我还缺的设置，已经给过的不再问；再读 node automation/run.mjs weekly context ${w.start}，按项目实际挑目标，用 weekly preview 给我看容量和哪些助手任务会开跑，我认可后再 apply。`,
    meeting:`帮我做周一组会的 PPT，一份，三部分：① 上周进度，一页（${last}）；② 本周安排，一页（${w.start} 至 ${w.end}）；③ 上周进度详细汇报，多页，每项进展一到数页，写清方法、结果、依据和未解决的问题。上周内容用 node automation/run.mjs weekly view ${w.previous_start} 取交付和研究记录，并对照上周计划里每个目标的 task_status，写清哪些完成、哪些没做和原因；本周安排用 weekly view ${w.start} 取计划和日程；只写有来源的内容。`
  }[key];
  if(text && selectSession()){$('message').value=text;saveComposer();}
}
document.addEventListener('input',e=>{if(e.target.closest?.('[data-project-related-form]'))e.target.dataset.dirty='1';if(e.target.closest?.('#weekly-body') && e.target.matches('input:not([type=checkbox]),textarea'))e.target.dataset.dirty='1';});
document.addEventListener('click',async e=>{
  const t=e.target,nav=t.closest('[data-week-nav]'),chat=t.closest('[data-weekly-chat]'),open=t.closest('[data-intent-chat]'),edit=t.closest('[data-intent-edit]'),remove=t.closest('[data-intent-remove]'),cancel=t.closest('[data-intent-cancel]');
  try {
    if(nav){const n=+nav.dataset.weekNav;setWeek(n ? addDays(weekSel,7*n) : state.weekly.window.start);}
    else if(chat){weeklyChat(chat.dataset.weeklyChat);}
    else if(open){
      const intent=[...(weekData?.plan?.intents || []),...(state.weekly.plan?.intents || [])].find(i=>i.id===open.dataset.intentChat),id=intent?.origin?.chat_task || intent?.task_id;
      const session=id && state.agent.sessions.find(s=>s.task_ids.includes(id));if(session)selectSession(session.id);
    }
    else if(edit){if(discardOk()){weekEdit=edit.dataset.intentEdit;renderWeekly(true);}}
    else if(cancel){weekEdit='';renderWeekly(true);}
    else if(remove){
      const intent=weekData.plan?.intents.find(i=>i.id===remove.dataset.intentRemove);
      if(intent && confirm(`从这一周的计划里移除“${intent.title}”？对应的任务不会被删除；计划排进待办、还没开始的，会退回未开始。`)){await post('/api/weekly/intent/remove',{week:weekSel,id:intent.id});await loadWeek();void load();}
    }
    else if(t.closest('[data-intent-auto]')){await post('/api/weekly/intent/update',{week:weekSel,id:t.closest('[data-intent-auto]').dataset.intentAuto,schedule:'auto'});await loadWeek();void load();}
  } catch(err) {error(err.message);}
});
document.addEventListener('change',async e=>{
  if(e.target.matches('#weekly-body input[name=project]'))e.target.dataset.dirty='1';
});
document.addEventListener('submit',async e=>{
  if(e.target.matches?.('[data-project-related-form]')) {
    e.preventDefault();const form=e.target,button=form.querySelector('button[type=submit]'),data=Object.fromEntries(new FormData(form));button.disabled=true;
    try {
      await post('/api/projects/related',{project_id:form.dataset.projectRelatedForm,...data});
      if(JSON.stringify(Object.fromEntries(new FormData(form)))===JSON.stringify(data)){form.reset();form.querySelectorAll('[data-dirty]').forEach(el=>delete el.dataset.dirty);}
      await load();
    } catch(err) {error(err.message);} finally {button.disabled=false;}
    return;
  }
  const form=e.target;if(!form.closest?.('#weekly-body'))return;
  e.preventDefault();const data=new FormData(form),submitted=JSON.stringify([...data]);
  try {
    if(form.dataset.intentForm){await post('/api/weekly/intent/update',{week:weekSel,id:form.dataset.intentForm,title:data.get('title'),expected:data.get('expected'),project_ids:data.getAll('project')});weekEdit='';}
    // Clear only the submitted, unchanged draft. Other forms, or typing during the request, stay protected.
    if(form.isConnected && JSON.stringify([...new FormData(form)])===submitted)form.querySelectorAll('[data-dirty]').forEach(el=>delete el.dataset.dirty);
    await loadWeek(!weekDirty());void load();
  } catch(err) {error(err.message);}
});
// DeepSeek is billed to the Command Code plan: its rolling windows (credit value in USD, not tokens) and the month's credits.
function commandCodeCard(c) {
  const windows=commandCodeWindows(c),money=v=>'$'+Number(v).toFixed(2);
  const body=windows.map(w=>`<div class="quota-window"><div><span>${esc(w.label)} · 剩余</span><strong>${w.remaining}%</strong></div><div class="meter"><i class="${tone(w.remaining)}" style="width:${w.remaining}%"></i></div><small>已用 ${money(w.used)} / ${money(w.cap)} · 重置：${w.resetsAt ? when(w.resetsAt) : '已重置，待刷新'}</small></div>`).join('');
  const month=Number.isFinite(c?.monthly_credits) ? `<div class="quota-window"><div><span>本月套餐余额${c.plan ? ' · '+esc(c.plan.replace(/^individual-/,'').toUpperCase()) : ''}</span><strong>${money(c.monthly_credits)}</strong></div>${c.period_end ? `<small>计费周期至 ${when(c.period_end)}</small>` : ''}</div>` : '';
  return `<article class="quota-card"><h2>Command Code</h2><p class="muted">DeepSeek 当前走的套餐额度 · 按用量金额计</p>${body || '<div class="unknown-quota">尚未读取</div><p class="muted">点右上角更新额度。</p>'}${month}<footer><span>${c?.error ? esc(c.error) : '随额度刷新读取 · 无模型调用'}</span><a href="https://commandcode.ai/usage" target="_blank" rel="noreferrer">官方 Usage ↗</a><span>${when(c?.checked_at)}</span></footer></article>`;
}
function renderUsage() {
  const q=state.usage.quota,codex=quotaWindows();
  const quotaBody=(windows,extra='')=>windows.map((w,i)=>`<div class="quota-window"><div><span>${esc(w.label)} · 剩余</span><strong>${w.remaining}%</strong></div><div class="meter"><i class="${tone(w.remaining)}" style="width:${w.remaining}%"></i></div>${w.resetsAt||extra ? `<small>重置：${w.resetsAt?when(w.resetsAt):'未记录'}${i===0?extra:''}</small>` : ''}</div>`).join('');
  const claude=claudeWindows().map(w=>({label:w.label,remaining:w.remaining_percent,resetsAt:w.resets_at}));
  $('quota-cards').innerHTML=`<article class="quota-card"><h2>Codex</h2><p class="muted">官方账号额度</p>${codex.length ? quotaBody(codex,renderExtraResets(q.extra_resets)) : `<div class="unknown-quota">尚未读取</div><p class="muted">点右上角更新额度。</p><small>重置：未记录${renderExtraResets(q.extra_resets)}</small>`}<footer><span>${esc(q.codex?.error || q.codex?.automatic_reset?.error || (state.agent?.config?.automatic_codex_reset_credit ? '额度用尽时自动用卡 · 无模型调用' : '额度查询 · 无模型调用'))}</span><span>${when(q.codex?.checked_at)}</span></footer></article><article class="quota-card"><h2>Claude Code</h2><p class="muted">Claude Code 返回的账号额度</p>${claude.length ? quotaBody(claude) : '<div class="unknown-quota">暂无有效额度窗口</div><p class="muted">窗口已重置或尚未调用；点右上角更新额度。</p>'}<footer><span>${q.claude?.error ? esc(q.claude.error) : '随每次调用自动记录'}</span><a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">官方 Usage ↗</a><span>${when(q.claude?.checked_at)}</span></footer></article>${q.deepseek_provider==='commandcode' ? commandCodeCard(q.commandcode) : ''}`;
  const days=7;
  const buckets=Array.from({length:days},(_,i)=>{const d=new Date();d.setDate(d.getDate()-days+1+i);return {date:d.toLocaleDateString('en-CA'),label:(d.getMonth()+1)+'/'+d.getDate(),input:0,output:0,cache:0,calls:0};});
  // One start point for the chart, the totals and the table: the first calendar day on screen.
  const runs=state.usage.runs.filter(r=>Date.parse(r.at)>=Date.parse(buckets[0].date+'T00:00:00'));
  const sum=key=>runs.filter(observed).reduce((s,r)=>s+(r[key] || 0),0);
  const input=sum('input_tokens'),cached=sum('cached_input_tokens'),output=sum('output_tokens'),metric=runs.reduce((s,r)=>s+billed(r),0);
  const failed=runs.filter(r=>r.status!=='completed').length,measured=runs.filter(observed).length,partial=runs.filter(r=>r.usage_partial===true).length;
  $('usage-totals').innerHTML=[
    ['调用次数',runs.length,failed ? `其中 ${failed} 次未完成` : '全部完成',''],
    ['总输入（含缓存）',big(input),partial ? `含 ${partial} 次部分用量；至少已发生` : '缓存是输入的一部分，不重复相加',num(input)+' token'],
    ['总输出',big(output),partial ? '含失败过程已观测消耗；汇总为下界' : '已观测输出 token',num(output)+' token'],
    ['非缓存输入＋输出',big(metric),'指标；各家 token 口径不同，合计仅作总览',num(metric)+' token'],
    ['每次平均指标',measured ? big(metric/measured) : '—','按有用量记录的调用算',measured ? num(metric/measured)+' token' : ''],
    ['缓存输入占比',input ? (100*cached/input).toFixed(1)+'%' : '—',`缓存 ${big(cached)} · 输出 ${big(output)}`,'']
  ].map(([label,value,sub,tip])=>`<div class="stat"${tip ? ` title="${esc(tip)}"` : ''}><span>${label}</span><strong>${value}</strong><small class="muted">${esc(sub)}</small></div>`).join('');
  for(const r of runs){const d=new Date(r.at).toLocaleDateString('en-CA');const b=buckets.find(b=>b.date===d);if(b){b.calls++;if(observed(r)){b.input+=Math.max(0,(r.input_tokens || 0)-(r.cached_input_tokens || 0));b.output+=r.output_tokens || 0;b.cache+=r.cached_input_tokens || 0;}}}
  // Bar height is the metric (uncached input + output). Cache hits are ~95% of raw input and would flatten every day to the same bar.
  const max=Math.max(1,...buckets.map(b=>b.input+b.output));
  $('usage-chart').style.setProperty('--chart-days',days);
  $('usage-chart').innerHTML=`<div class="chart">${buckets.map(b=>`<div class="chart-day" title="${b.label}：${b.calls} 次调用；非缓存输入 ${num(b.input)} + 输出 ${num(b.output)}；缓存输入 ${num(b.cache)}"><em class="chart-total">${b.calls ? big(b.input+b.output) : ''}</em><div class="chart-stack" style="height:${140*(b.input+b.output)/max}px"><i class="chart-input" style="height:${140*b.input/max}px"></i><i class="chart-output" style="height:${140*b.output/max}px"></i></div><small>${b.label}</small></div>`).join('')}</div>`;
  const titles=new Map(state.work.items.map(i=>[i.id,i.title]));
  const parts=usageSections(runs,id=>titles.get(id));$('usage-by-provider').innerHTML=parts.provider;$('usage-by-use').innerHTML=parts.use;$('usage-speed').innerHTML=parts.speed;$('usage-top').innerHTML=parts.top;$('usage-note').textContent=parts.note;
  $('usage-table').innerHTML=runs.length ? `<table class="usage-table"><thead><tr><th>时间</th><th>执行</th><th>输入（含缓存）</th><th>缓存</th><th>输出</th><th>状态</th></tr></thead><tbody>${runs.slice(-15).reverse().map(r=>`<tr><td>${when(r.at)}</td><td>${esc(providers[r.provider])}<br><span class="muted">${esc(r.model)}</span></td><td>${observed(r) ? (r.usage_partial ? '≥ ' : '')+num(r.input_tokens) : '—'}</td><td>${observed(r) ? (r.usage_partial ? '≥ ' : '')+num(r.cached_input_tokens) : '—'}</td><td>${observed(r) ? (r.usage_partial ? '≥ ' : '')+num(r.output_tokens) : '—'}</td><td>${r.status==='completed' ? '完成' : '未完成'}${r.usage_partial ? ' · 部分用量' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-small">还没有本机助手的模型调用记录。</p>';
}
const day=t=>t ? String(t).slice(0,10) : '—';
function renderMail() {
  const m=state.mail,open=m.tasks.filter(x=>x.status!=='done');
  $('mail-summary').textContent=`待判断 ${m.pending} 封 · 未完成事项 ${open.length} 项${m.lastRun ? ' · 最近更新 '+when(m.lastRun.completedAt || m.lastRun.finished_at || m.lastRun.at) : ''}`;
  $('mail-tasks').innerHTML=open.length ? open.map(x=>`<div class="software-row"><strong>${esc(x.title)}</strong><span class="muted">${esc(x.action)}</span><span class="badge">${x.status==='waiting' ? '等对方' : '待你'} · ${x.deadline ? '截止 '+day(x.deadline) : x.check_at ? '复查 '+day(x.check_at) : '无日期'}</span></div>`).join('') : '<p class="empty-small">没有未完成的邮件事项。</p>';
  const subject=x=>x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noreferrer">${esc(x.subject || '（无主题）')}</a>` : esc(x.subject || '（无主题）');
  $('mail-sent').innerHTML=(m.sent || []).length ? m.sent.map(x=>`<div class="software-row"><strong>${subject(x)}</strong><span class="muted">${esc((x.recipients || []).join('、'))}</span><span class="badge">${when(x.received)}</span></div>`).join('') : '<p class="empty-small">账本里还没有已发送邮件。</p>';
}
function renderProcurement() {
  const list=state.procurement.requests || [];
  $('procurement-list').innerHTML=list.length ? list.map(r=>`<article class="panel"><div class="panel-heading"><h2>${esc(r.title)}</h2><span class="badge">${r.required_by ? '需要 '+day(r.required_by) : '无需求日期'}</span></div>${(r.vendors || []).map(v=>`<div class="software-row"><strong>${esc(v.name)}</strong><span class="muted">报价 ${esc(v.quote_number || '—')} · 交期 ${esc(v.lead_time || '未记录')} · 有效至 ${esc(v.valid_until || '未记录')}</span><span class="badge">${v.quoted_total==null ? '未记录金额' : esc(v.currency || '')+' '+num(v.quoted_total)}</span></div>`).join('')}<p class="muted">${esc(r.notes || '')}</p></article>`).join('') : '<p class="empty-small">还没有采购记录。</p>';
}
function renderConnections() {settings.ensure();
  const last=state.mail.lastRun,c=state.connections;
  const cards=[['邮箱','每 10 分钟增量更新',last ? '最近更新 '+when(last.completedAt || last.finished_at || last.at) : '收件记录尚未读取'],['Codex',state.usage.quota.codex?.limits ? '账号已连接' : '原生 CLI','对话 · 本地执行 · 项目交接'],['Claude Code',c.claude_installed ? '原生 CLI 已安装' : '尚未检测到 CLI','通过 @Claude 接入'],['Discord',c.discord_configured ? '本地配置已加载' : '等待本地机器人配置','远程对话 · 收件箱 · 周计划'],['校园文献','UW 图书馆与 Zotero','校园登录后获取全文']];
  $('connection-grid').innerHTML=cards.map(([title,status,detail])=>`<article class="project-card"><span class="project-icon">${ico({'邮箱':'mail','Codex':'code','Claude Code':'spark','Discord':'chat','校园文献':'book'}[title] || 'connections')}</span><h2>${title}</h2><p>${esc(detail)}</p><div class="project-footer"><span class="badge">${esc(status)}</span>${title==='校园文献' ? '<a class="text-button" href="https://www.library.wisc.edu/" target="_blank" rel="noreferrer">图书馆 ↗</a>' : ''}</div></article>`).join('');
  $('software-list').innerHTML=state.software.apps.map(a=>`<div class="software-row"><strong>${esc(a.name)}</strong><code>${esc(a.working_directory)}</code><span class="badge">${a.requires_running ? '需打开软件' : '脚本入口'}</span></div>`).join('');
}
function linkArtifacts() {
  for(const code of document.querySelectorAll('.page:not([hidden]) .artifact-paths code')) {
    const item=state.work.items.find(i=>(i.outputs||[]).includes(code.textContent));if(!item)continue;
    const a=document.createElement('a');a.href=`/api/artifact?task=${item.id}&index=${(item.outputs||[]).indexOf(code.textContent)}`;a.title='下载产出文件';
    code.replaceWith(a);a.append(code);
  }
}
async function openReview(key,cardId) {
  const colon=key.indexOf(':'),source=key.slice(0,colon),id=key.slice(colon+1);
  const r=await fetch(`/api/review?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`);const data=await r.json();if(!r.ok)throw new Error(data.error);
  const card=cardId && state.inbox.find(i=>i.id===cardId);
  $('review-title').textContent=card?.title || data.title;
  const sourceText=s=>typeof s==='string' ? s : [s?.path,s?.location,s?.url].filter(Boolean).join(' · ');
  const link=u=>/^https:\/\//.test(u || '') ? `<a href="${esc(u)}" target="_blank" rel="noopener">在 Outlook 打开原邮件 ↗</a>` : '<span class="muted">无原文链接</span>';
  $('review-detail').innerHTML=(card ? `<div class="weekly-group"><h3>${esc(card.reason || '事项')}</h3><div class="message-text">${esc(card.detail)}</div>${card.due_at ? `<p class="muted">截止 ${esc(whenFull(card.due_at))}</p>` : ''}<p class="muted">${esc(card.project_ids?.map(p=>state.projects.find(x=>x.id===p)?.name || p).join(' · ') || '未关联项目')}</p></div>` : '')+
    (data.messages?.length ? `<div class="weekly-group"><h3>相关邮件 · ${data.messages.length} 封</h3>${data.messages.map(m=>`<div class="week-item"><strong>${esc(m.subject)}</strong><p class="muted">${esc(m.sender)} → ${esc((m.recipients || []).join(', '))} · ${esc(whenFull(m.received))} · ${esc(m.folder)}</p><div class="message-text">${esc(m.text)}</div>${link(m.link)}</div>`).join('')}</div>` : '')+
    (!data.messages?.length && data.links?.length ? `<div class="weekly-group"><h3>原邮件</h3>${data.links.map(l=>`<div class="week-item"><strong>${esc(l.subject)}</strong><br>${link(l.url)}</div>`).join('')}</div>` : '')+
    (data.outputs.length ? `<div class="weekly-group"><h3>文件</h3>${data.outputs.map((p,index)=>{const url=source==='work' ? `/api/artifact?task=${encodeURIComponent(id)}&index=${index}` : '',pv=data.previews.find(x=>x.path===p);return pv?.url ? `<details class="file-preview" data-artifact-url="${esc(pv.url)}"><summary><code class="file-name">${esc(p)}</code> · 展开读取全文</summary><a class="text-button" href="${esc(pv.url)}" download>下载完整文件 ↗</a><pre class="evidence-preview">展开后读取完整文件</pre></details>` : `<div><code class="file-name">${esc(p)}</code>${url ? `<a class="text-button" href="${esc(url)}" download>下载完整文件 ↗</a>` : ''}</div>`;}).join('')}</div>` : '')+
    (data.limitations.length ? `<div class="evidence-check">${data.limitations.map(esc).join('<br>')}</div>` : '')+
    (data.criteria.length ? '<div class="weekly-group"><h3>验收标准</h3>'+data.criteria.map(c=>`<div class="week-item">${esc(typeof c==='string' ? c : c.description || c.expected)}</div>`).join('')+'</div>' : '')+
    (data.evidence.length ? `<table class="evidence-table"><thead><tr><th>提取结果</th><th>来源与原文位置</th><th>本组 / 目标数据</th><th>条件</th></tr></thead><tbody>${data.evidence.map(e=>`<tr><td>${esc(e.field)}<br><strong class="evidence-value">${e.extracted_value==null ? '未记录' : esc(e.extracted_value)} ${esc(e.unit)}</strong></td><td class="evidence-source">${esc(sourceText(e.source))}${e.source?.excerpt ? '<br>'+esc(e.source.excerpt) : ''}</td><td class="evidence-value">${e.local_value==null ? '未记录' : esc(e.local_value)}</td><td><span class="badge">${e.conditions?.status==='same' ? '条件一致' : e.conditions?.status==='different' ? '不可直接比较' : '条件待核实'}</span><p class="muted">${esc(e.conditions?.note)}</p></td></tr>`).join('')}</tbody></table>` : card ? '' : `<div class="message-text result-text">${esc(data.outcome || '尚未记录提取值和来源对照。')}</div>`);
  for(const detail of $('review-detail').querySelectorAll('details[data-artifact-url]'))detail.addEventListener('toggle',async()=>{
    const preview=detail.querySelector('.evidence-preview');preview.textContent='正在读取全文…';
    try {const r=await fetch(detail.dataset.artifactUrl);if(!r.ok)throw new Error(await r.text());preview.textContent=await r.text();}
    catch(e){preview.textContent='文件读取失败：'+e.message+'；可使用下载链接。';}
  },{once:true});
  $('review-dialog').showModal();
}
function renderCodeStatus() {
  const code=state.code,kind=code?.state || 'unknown',box=$('code-status');
  box.dataset.state=kind;
  const versions=code ? `运行 ${code.loaded.slice(0,10)} / 磁盘 ${code.disk.slice(0,10)}` : '旧后端尚未提供代码指纹';
  $('code-summary').textContent=code ? `v.${code.loaded.slice(0,10)}${kind==='stale' ? ' ↻' : kind==='unknown' ? ' ?' : ''}` : '版本未知';
  const label='后端版本 · '+versions+(kind==='stale' ? ' · 需要重启（等助手与后台工作结束）' : kind==='unknown' ? ' · 无法确认版本状态' : '');
  $('code-summary').title=label;
  $('code-summary').setAttribute('aria-label',label);
  const busy=state.work.items.some(i=>i.status==='active' && i.actor!=='user');
  const blocked=busy || state.background_busy || state.restart_pending;
  $('refresh').disabled=restartWaiting || !state.backend_restart || blocked;
  $('refresh').title=!state.backend_restart ? '后端尚未加载重启按钮；等助手与后台工作结束后重新打开 Workbench 安装' : blocked ? '还有助手任务或后台工作运行，结束后才能重启；用户自己的任务不阻止重启' : '重启后端并刷新页面';
  const note=kind==='current' ? '后端启动快照与磁盘代码一致。前端资源修改需刷新页面；业务数据与动态配置不触发重启。' :
    kind==='stale' ? (busy ? '还有助手任务运行，不要现在重启。' : '当前无活动助手任务。')+'等助手与后台工作结束后重启，再验证后端改动；用户自己的任务不阻止重启。刷新网页不会重载后端。' :
    code ? '部分源文件未能读取，不能据此认定版本一致或不一致。' : '等助手与后台工作结束后重新打开 Workbench，加载代码版本与文件变化提示；用户自己的任务不阻止重启。';
  $('code-detail').textContent='后端 · '+versions+'\n'+note+(code?.changed.length ? '\n变化：'+code.changed.slice(0,12).map(c=>c.path).join('、')+(code.changed.length>12 ? ` 等 ${code.changed.length} 个文件` : '') : '');
}
function load() {
  if(restartWaiting)return Promise.resolve();
  if(loading && stateRead?.revision===stateRevision)return loading;
  stateRead?.controller.abort();
  const request={revision:stateRevision,controller:new AbortController()};stateRead=request;
  // A read that never answers (a phone tab that was suspended, a dropped tunnel connection) would otherwise be re-used by every later poll and freeze the page.
  const giveUp=setTimeout(()=>request.controller.abort(),15000);
  const pending=(async()=>{
  let revision;
  do {
  revision=stateRevision;
  try {
    const params=new URLSearchParams({page,session:page==='chat' ? sessionId : '',q:page==='tasks' ? $('tasks-search').value.trim() : ''});
    const r=await fetch('/api/state?'+params,{signal:request.controller.signal});if(!r.ok)throw new Error('状态读取失败');const next=await r.json();
    if(request.controller.signal.aborted)return;
    if(revision!==stateRevision)continue;
    state=next;
    if(!pageCode && state.code?.loaded)pageCode=state.code.loaded;
    if(state.agent_read_at){mergeReadState(state.agent_read_at);void syncReadState();}
    renderCodeStatus();
    const options=JSON.stringify(state.projects.filter(p=>!p.archived_at).map(p=>[p.id,p.name]));
    if($('project-context').dataset.options!==options){const selected=$('project-context').value;$('project-context').replaceChildren(new Option('所有工作',''),...JSON.parse(options).map(([id,name])=>new Option(name,id)));$('project-context').value=selected;$('project-context').dataset.options=options;}
    const s=state.agent.sessions.find(s=>s.id===sessionId);if(s){$('project-context').value=s.project_ids[0] || '';$('project-context').disabled=true;}
    if(page!=='chat')renderRecentSessions();renderOverview();renderHeaderQuota();
    $('task-count').textContent=sortedSessions().filter(s=>isTask(s) && running(s)).length || '';
    renderCurrentPage();
    const q=state.usage.quota.codex;
    const lastQuotaCheck=Math.min(Math.max(Date.parse(q?.checked_at) || 0,Date.parse(q?.attempted_at) || 0),Date.parse(state.usage.quota.extra_resets?.checked_at) || 0);
    if(!quotaRefreshing && document.visibilityState==='visible' && Date.now()-lastQuotaCheck>10*60000) {
      quotaRefreshing=true;void post('/api/usage/refresh').catch(()=>{}).finally(()=>{quotaRefreshing=false;});
    }
  }catch(e){if(request.controller.signal.aborted)return;error(e.message);}
  // A navigation/send during the read invalidates its scope. All callers share
  // this one read chain; fetch the latest scope once, not one queue per click.
  }while(revision!==stateRevision && !restartWaiting && stateRead===request);
  })().finally(()=>{clearTimeout(giveUp);if(stateRead===request){loading=false;stateRead=undefined;}});
  loading=pending;
  return loading;
}
function renderCurrentPage() {
  const current=$('page-'+page),pending=state.ui && state.ui.page!==page;
  current.setAttribute('aria-busy',String(!!pending));if(pending)return;
  if(page==='chat')renderChat();
  else if(page==='history' || page==='tasks')renderSessionList(page);
  else if(page==='weekly'){void loadWeek();renderCalendar();}
  else if(page==='instruments')renderInstruments(state);
  else if(page==='prompts')renderPrompts();
  else if(page==='skills')skills.ensure();
  else if(page==='literature')renderLiterature();
  else ({board:renderBoard,inbox:renderInbox,projects:renderProjects,usage:renderUsage,connections:renderConnections,mail:renderMail,procurement:renderProcurement})[page]?.();
  linkArtifacts();
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(submitting && b.closest('#composer'))return;
  try {
    if(b.dataset.removeImage!==undefined && !readingAttachments){pendingAttachments.splice(Number(b.dataset.removeImage),1);renderAttachmentPreviews();saveComposer();}
    if(b.dataset.openUrl?.startsWith('https://'))window.open(b.dataset.openUrl,'_blank','noopener');
    if(b.dataset.page){
      if(b.dataset.page==='chat' && b.classList.contains('nav') && ['chat','history','tasks'].includes(page) && state && nextRunningSession())return;
      if(b.dataset.page==='projects')projectId='';show(b.dataset.page);
    }
    if(b.dataset.session)selectSession(b.dataset.session);
    if(b.dataset.updateRead){const id=b.dataset.updateRead,at=Number(b.dataset.updateAt);if(at>Number(agentReadAt[id] || 0)){agentReadAt[id]=at;localStorage.setItem('lab-agent-read',JSON.stringify(agentReadAt));renderRecentSessions();renderHistory();renderProjects();void syncReadState();}}
    if(b.dataset.chatOpen)openChatRef(b.dataset.chatOpen,b.dataset.chatTask);
    if(b.dataset.sessionPin){
      const s=state.agent.sessions.find(x=>x.id===b.dataset.sessionPin);if(!s || !pinsAvailable)return;
      // Show the new pin state at once; the save and the full state read follow in the background.
      const wanted=!s.pinned,was=s.pinned;stateRevision++;s.pinned=wanted || undefined;renderRecentSessions();renderHistory();
      try{await post('/api/chat/pin',{session_id:s.id,pinned:wanted});stateRevision++;void load();}
      catch(e){stateRevision++;s.pinned=was;renderRecentSessions();renderHistory();error(e.message);}
    }
    if(b.dataset.sessionDelete){const s=state.agent.sessions.find(x=>x.id===b.dataset.sessionDelete);if(s && confirm(`删除会话“${s.title}”？\n消息记录会移除（每日备份里仍有一份），它产生的任务记录会保留。`)){await post('/api/chat/session',{session_id:s.id});if(sessionId===s.id)await selectSession();discardDraft(s.id);await load();}}
    if(b.dataset.projectArchive){const archive=b.dataset.archived!=='true';if(!archive || confirm('归档这个项目？它会从项目列表、周计划和对话选择里隐藏；任务、文献和文件都保留，可以随时恢复。')){await post('/api/projects/archive',{project_id:b.dataset.projectArchive,archived:archive});while($('project-context').options.length>1)$('project-context').remove(1);if(archive){projectId='';show('projects');}await load();}}
    if(b.dataset.suggestion){$('message').value=b.dataset.suggestion;$('message').focus();}
    if(b.dataset.mention){const input=$('message');input.value+=(input.value && !/\s$/.test(input.value) ? ' ' : '')+b.dataset.mention+' ';input.focus();input.setSelectionRange(input.value.length,input.value.length);fitMessage();saveComposer();}
    if(b.dataset.project && selectSession()){$('project-context').value=b.dataset.project;saveComposer();}
    if(b.dataset.editMessage)openMessageEditor(b.closest('article'),b.dataset.editMessage);
    if(b.dataset.editCancel!==undefined)closeMessageEditor(b.closest('article'));
    if(b.dataset.editSave){b.disabled=true;try {await saveMessageEdit(b.closest('article'),b.dataset.editSave);} finally {b.disabled=false;}}
    if(b.dataset.answer){b.disabled=true;try {await submitAnswer(b.closest('.question-card'));} catch(e) {b.disabled=false;throw e;}}
    if(b.dataset.stop){await post('/api/stop',{task_id:b.dataset.stop});await load();}
    if(b.dataset.ack){await post('/api/inbox/ack',{id:b.dataset.ack});await load();}
    if(b.dataset.link){b.disabled=true;await post('/api/links/resolve',{id:b.dataset.link,decision:b.dataset.decision});await load();}
    if(b.dataset.undo){await post('/api/inbox/undo',{id:b.dataset.undo});await load();}
    if(b.dataset.inboxChat){const item=state.inbox.find(i=>i.id===b.dataset.inboxChat);if(selectSession(sessionOf(state,item)?.id)){inboxReply={id:item.id,fingerprint:item.fingerprint,key:item.key,action_id:'discuss',label:'和 agent 交流'};$('message').value=`原事项：${item.id}\n请继续处理：${item.title}\n已知情况：${item.detail}`;$('project-context').value=item.project_ids[0] || '';saveComposer();}}
    if(b.dataset.inboxResponse){const item=state.inbox.find(i=>i.id===b.dataset.inboxResponse);b.disabled=true;const job=await post('/api/inbox/respond',{id:item.id,fingerprint:item.fingerprint,action_id:b.dataset.actionId});await load();if(b.dataset.actionId!=='agent-check')selectSession(job.session_id);}
    if(b.dataset.intent){b.disabled=true;await post('/api/weekly/start',{id:b.dataset.intent,week:weekSel});await load();show('projects');}
    if(b.dataset.taskSession){const s=state.agent.sessions.find(s=>s.task_ids.includes(b.dataset.taskSession));if(s)selectSession(s.id);}
    if(b.dataset.review)await openReview(b.dataset.review,b.dataset.card);
    if(b.hasAttribute('data-project-edit-mode')){editingProject=editingProject===projectId ? '' : projectId;renderProjects();}
    if(b.dataset.projectOpen){editingProject='';projectId=b.dataset.projectOpen;location.hash='projects/'+encodeURIComponent(projectId);renderProjects();show('projects');window.scrollTo(0,0);}
    if(b.hasAttribute('data-project-back')){editingProject='';projectId='';location.hash='projects';renderProjects();window.scrollTo(0,0);}
    if(b.dataset.projectPlan && selectSession()){$('project-context').value=b.dataset.projectPlan;$('message').value='请帮我拆解这个项目的下一阶段，按阶段和步骤组织，并明确每一步的输入、输出和验收标准。';saveComposer();}
    if(b.dataset.nodeFocus){await post('/api/projects/focus',{project_id:b.dataset.nodeProject,node_id:b.dataset.nodeFocus});await load();}
    if(b.dataset.nodeChat){const p=state.projects.find(p=>p.id===b.dataset.nodeProject);const find=ns=>{for(const n of ns || []){if(n.id===b.dataset.nodeChat)return n;const c=find(n.children);if(c)return c;}};const n=find(p.plan) || find(p.framework?.boards);if(selectSession()){$('project-context').value=p.id;planNodeId=n.id;$('message').value=`帮我推进「${n.title}」，先完成你能完成的准备工作，并明确我需要做什么。`;saveComposer();}}
    fitMessage();
  }catch(e){error(e.message);b.disabled=false;}
});
$('new-session').onclick=()=>selectSession();
$('rename-session').onclick=async()=>{
  const id=sessionId,s=state?.agent.sessions.find(s=>s.id===id),button=$('rename-session');if(!s || !titlesAvailable)return;
  const title=prompt('修改对话标题（1～100 个字符）',s.title);if(title===null || title.trim()===s.title)return;
  button.disabled=true;error('');
  try {
    const result=await post('/api/chat/title',{session_id:id,title});
    const current=state.agent.sessions.find(s=>s.id===id);if(current)current.title=result.title;
    stateRevision++;renderRecentSessions();renderCurrentPage();void load();
  }catch(e){error(e.message);}finally{button.disabled=!titlesAvailable;}
};
$('refresh').onclick=async()=>{
  if(restartWaiting)return;
  const shell=document.querySelector('.shell'),button=$('refresh');
  let reloading=false;
  try {
    // Saved chat drafts survive this reload; unfinished reads and other editors do not.
    if(readingAttachments || submitting || weekDirty() || !$('cal-form').hidden || document.querySelector('dialog[open]'))throw new Error('请先完成上传／保存输入，或关闭编辑窗口，再重启；不会丢弃草稿。');
    saveComposer();for(const id of [...unsavedDrafts])persistDraft(id);
    if(unsavedDrafts.size && !confirm('部分草稿未能保存到浏览器（附件过大或存储受限），也可能包括其他对话的草稿。\n刷新后只能恢复上次成功保存的版本，未保存的文字或附件可能丢失。\n仍要重启后端并刷新页面吗？'))return;
    restartWaiting=true;shell.inert=true;button.disabled=true;button.setAttribute('aria-busy','true');error('正在重启后端，完成后刷新页面…');
    const accepted=await post('/api/backend/restart'); // Never retry this write operation.
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      let health;
      try {const response=await fetch('/health',{signal:AbortSignal.timeout(1500)});if(response.ok)health=await response.json();}catch{/* A short disconnect is expected; only health reads are retried. */}
      if(health?.restart_error)throw new Error(health.restart_error);
      if(health?.app==='phd-workflows' && health.version===2 && health.started_at && health.started_at!==accepted.started_at && !health.restart_pending){reloading=true;location.reload();return;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('30 秒内未确认新后端就绪，未自动重试重启；请查看 .runtime/dashboard/restart-error.log。');
  }catch(e){error(e.message);}
  finally {if(!reloading){restartWaiting=false;shell.inert=false;button.removeAttribute('aria-busy');if(state)renderCodeStatus();}}
};
$('composer').onsubmit=async e=>{
  e.preventDefault();if(submitting || readingAttachments || voiceInput?.busy)return;
  const text=$('message').value.trim();if(!text && !pendingAttachments.length)return;
  error('');submitting=true;$('send').disabled=true;$('message').disabled=true;
  try {
    const job=await post('/api/chat',{text,images:pendingAttachments.filter(a=>a.kind==='image').map(({name,data_url})=>({name,data_url})),files:pendingAttachments.filter(a=>a.kind==='file').map(({name,data_url})=>({name,data_url})),session_id:sessionId || undefined,project_id:$('project-context').value || undefined,plan_node_id:planNodeId || undefined,inbox_reply:inboxReply});
    discardDraft(sessionId);sessionId=job.session_id;rememberSession();$('message').value='';fitMessage();pendingAttachments=[];renderAttachmentPreviews();planNodeId='';inboxReply=undefined;transcriptKey='';
    if(job.session && job.task){
      const i=state.agent.sessions.findIndex(s=>s.id===job.session_id);
      if(i<0)state.agent.sessions.push(job.session);else state.agent.sessions[i]=job.session;
      const j=state.work.items.findIndex(t=>t.id===job.task_id);
      if(j<0)state.work.items.push(job.task);else state.work.items[j]=job.task;
      stateRevision++;$('project-context').disabled=true;renderChat();renderOverview();void load();
    }else await load(); // Existing backend until the user can safely reload it.
  }catch(e){error(e.message);}finally{submitting=false;$('send').disabled=false;$('message').disabled=false;$('message').focus();}
};
$('message').onpaste=e=>{
  const files=[...(e.clipboardData?.items || [])].filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
  if(!files.length)return;
  e.preventDefault();if(!imagesAvailable){error('图片功能需要更新后的服务：等运行中的任务结束，再重新打开办公室即可。');return;}
  const text=e.clipboardData.getData('text/plain');if(text){$('message').setRangeText(text,$('message').selectionStart,$('message').selectionEnd,'end');fitMessage();saveComposer();}
  void addAttachments(files);
};
$('attach-image').onclick=()=>{if(!submitting && !readingAttachments)$('image-files').click();};
$('image-files').onchange=()=>{void addAttachments([...$('image-files').files]);$('image-files').value='';};
const isFileDrag=e=>[...(e.dataTransfer?.types || [])].includes('Files');
const dropArea=document.querySelector('.conversation');
let dragDepth=0;
document.addEventListener('dragover',e=>{if(isFileDrag(e)){e.preventDefault();e.dataTransfer.dropEffect=page==='chat' ? 'copy' : 'none';}});
document.addEventListener('drop',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth=0;dropArea.classList.remove('file-drag-over');}});
dropArea.addEventListener('dragenter',e=>{if(isFileDrag(e) && page==='chat'){e.preventDefault();dragDepth++;dropArea.classList.add('file-drag-over');}});
dropArea.addEventListener('dragleave',e=>{if(isFileDrag(e) && --dragDepth<=0){dragDepth=0;dropArea.classList.remove('file-drag-over');}});
dropArea.addEventListener('drop',e=>{
  if(!isFileDrag(e) || page!=='chat')return;
  e.preventDefault();
  if([...(e.dataTransfer.items || [])].some(i=>i.webkitGetAsEntry?.()?.isDirectory)){error('请拖入文件，不支持直接上传文件夹。');return;}
  void addAttachments([...e.dataTransfer.files]);
});
window.addEventListener('blur',()=>{dragDepth=0;dropArea.classList.remove('file-drag-over');});
$('transcript').onscroll=updateLatest;
for(const event of ['wheel','pointerdown'])$('transcript').addEventListener(event,()=>{savedChatPosition=null;},{passive:true});
window.addEventListener('pagehide',()=>{
  if(page!=='chat' || savedChatPosition || !$('transcript').querySelector('.message'))return;
  const transcript=$('transcript');
  try {sessionStorage.setItem('lab-chat-position',JSON.stringify({session:sessionId,top:transcript.scrollTop,bottom:transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<=1}));}
  catch{/* Do not block refresh when optional position storage is unavailable. */}
});
window.addEventListener('focus',()=>{if(state)updateLatest();});
document.addEventListener('visibilitychange',()=>{if(state)updateLatest();});
// Coming back to the tab (phone: unlock, switch app) or regaining the network: drop any read left hanging, read now, and if the backend was restarted
// meanwhile, reload so the page's scripts match it. Unsent text is kept in the composer draft.
let resuming=false;
function resume() {
  if(document.visibilityState!=='visible' || !state || restartWaiting || resuming)return;
  resuming=true;stateRead?.controller.abort();stateRead=undefined;loading=false;
  void load().finally(()=>{resuming=false;if(state?.code?.loaded && pageCode && state.code.loaded!==pageCode && !restartWaiting){saveComposer();location.reload();}});
}
document.addEventListener('visibilitychange',resume);window.addEventListener('pageshow',resume);window.addEventListener('online',resume);
$('latest').onclick=()=>{$('transcript').scrollTop=$('transcript').scrollHeight;updateLatest();};
$('toggle-context').onclick=()=>{
  const collapsed=$('page-chat').classList.toggle('context-collapsed');$('toggle-context').setAttribute('aria-expanded',String(!collapsed));$('toggle-context').textContent=collapsed ? '展开概览' : '收起概览';
};
$('message').oninput=()=>{fitMessage();saveComposer();};
$('project-context').onchange=saveComposer;
window.addEventListener('beforeunload',e=>{if(!restartWaiting && (unsavedDrafts.size || readingAttachments || submitting)){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',fitMessage);
$('message').onkeydown=e=>{if(e.key==='Enter' && e.shiftKey && !e.isComposing){e.preventDefault();$('composer').requestSubmit();}};
$('inbox-filter').onchange=renderInbox;
$('project-search').oninput=renderProjects;
for(const prefix of ['history','tasks']) {
  const reset=()=>{listLimit[prefix]=30;if(prefix==='tasks'){stateRevision++;void load();}renderHistory();};
  $(prefix+'-search').oninput=reset;$(prefix+'-project').onchange=reset;
  $(prefix+'-more').onclick=()=>{listLimit[prefix]+=30;renderHistory();};
}
window.addEventListener('hashchange',()=>{projectId=location.hash.startsWith('#projects/') ? decodeURIComponent(location.hash.slice(10)) : '';if(state)show(location.hash.startsWith('#projects') ? 'projects' : 'chat');});
paintIcons();
document.addEventListener('change',async event=>{
  const input=event.target;
  if(!input.matches?.('[data-project-upload]') || !input.files.length)return;
  error('');input.disabled=true;
  try {
    if(!projectFilesAvailable)throw new Error('阶段文件功能需要更新服务：等这轮任务结束后，重新打开 Workbench。');
    const files=[...input.files];
    if(files.length>fileLimits.count)throw new Error(`每次最多 ${fileLimits.count} 个文件`);
    if(files.some(file=>file.size>fileLimits.each))throw new Error(`单个文件不能超过 ${fileLimits.each/1024/1024} MB`);
    if(files.reduce((n,file)=>n+file.size,0)>fileLimits.total)throw new Error(`文件合计不能超过 ${fileLimits.total/1024/1024} MB`);
    const uploads=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败，请重新选择'));
      reader.onload=()=>resolve({name:file.name,data_url:reader.result});reader.readAsDataURL(file);
    })));
    await post('/api/projects/files',{project_id:input.dataset.projectUpload,node_id:input.dataset.nodeUpload || undefined,files:uploads});
    await load();
  }catch(err){error(err.message);}finally{input.value='';input.disabled=false;}
});
$('refresh-quota').onclick=async()=>{const b=$('refresh-quota');b.disabled=true;b.textContent='读取中…';try{await post('/api/usage/refresh');await load();}catch(e){error(e.message);}finally{b.disabled=false;b.textContent='更新额度 ↻';}};
$('close-review').onclick=()=>$('review-dialog').close();
// The history page's search box is the same search the assistants use (`agent search`): every word in one conversation, else the closest candidates by
// word pieces. The magnifier beside 最近会话 jumps here. A hit opens its conversation at the matching turn.
let historyHits=null,historySeq=0,historyTimer;
async function searchHistory() {
  const q=$('history-search').value.trim(),seq=++historySeq;
  if(!q){historyHits=null;$('history-list').removeAttribute('aria-busy');renderHistory();return;}
  try {
    if(!searchAvailable)throw new Error('搜索需要更新后的服务：等运行中的任务结束，再重新打开办公室即可。');
    const r=await fetch(`/api/chat/search?q=${encodeURIComponent(q)}&limit=50`),data=await r.json();if(!r.ok)throw new Error(data.error || '搜索失败');
    if(seq!==historySeq)return;
    historyHits=data;
  }catch(err){if(seq!==historySeq)return;historyHits={mode:'error',message:err.message,rows:[]};}
  $('history-list').removeAttribute('aria-busy');renderHistory();
}
$('history-search').addEventListener('input',()=>{
  clearTimeout(historyTimer);
  if($('history-search').value.trim()){$('history-list').setAttribute('aria-busy','true');historyTimer=setTimeout(searchHistory,250);}
  else void searchHistory();
});
$('open-search').onclick=()=>{show('history');$('history-search').focus();$('history-search').select();};
document.addEventListener('keydown',e=>{if(e.key!=='n' || e.ctrlKey || e.metaKey || e.altKey || ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) || e.target.isContentEditable || document.querySelector('dialog[open]'))return;selectSession();});
bindFramework({post,load,workItem:id=>state?.work.items.find(i=>i.id===id)});
bindProjectEditor({post,load});
bindProjectDrag({post,load,error});
// Fetch the initial state alongside capability discovery. Optional rich-text code
// upgrades already-visible saved messages; it must not delay avatars or the scene.
$('attach-image').disabled=true;
void (async()=>{
  try {
    const health=await (await fetch('/health')).json();imagesAvailable=health.chat_images===true;filesAvailable=health.chat_files===true;projectFilesAvailable=health.project_files===true;searchAvailable=health.chat_search===true;titlesAvailable=health.chat_session_titles===true;editAvailable=health.chat_edit===true;fileLimits=health.chat_file_limits;companionsAvailable=health.companion_scenes===true;dailyNotesAvailable=health.companion_daily_notes===true;
    pinsAvailable=health.chat_pins===true;if(state){renderRecentSessions();renderHistory();}
    if(health.chat_speech===true) {
      try {
        const {bindVoiceInput}=await import('./voice-input.js');
        voiceInput=bindVoiceInput({button:$('voice-input'),cancel:$('voice-cancel'),status:$('voice-status'),input:$('message'),getContext:()=>page+':'+sessionId,onText:()=>{fitMessage();saveComposer();},onBusy:busy=>{$('send').disabled=busy || submitting || readingAttachments;},maxSeconds:health.speech_limits?.maxSeconds || 120});
      }catch{$('voice-status').textContent='语音输入暂不可用，请刷新页面后再试';}
    }else {$('voice-status').textContent='语音输入待本地模型及后端就绪';}
    // The already-running server cannot serve new modules until it is restarted.
    if(health.chat_markdown===true)void import('./markdown.js').then(async module=>{
      ({renderMarkdown,copyCode}=module);markdownAvailable=true;
      if(health.chat_powershell===true){
        try{const {bindPowerShell}=await import('./powershell.js');bindPowerShell(health.powershell_cwd);powershellAvailable=true;}catch{ /* Keep copy-only code blocks if the run UI cannot load. */ }
      }
      if(state && ['chat','projects'].includes(page))renderCurrentPage();
    }).catch(()=>{ /* Keep safe plain text when the optional renderer is unavailable. */ }).finally(finishChatRenderer);
    else finishChatRenderer();
  }catch {finishChatRenderer(); /* Retain plain text and existing controls until the server supports the feature. */ }
  $('attach-image').disabled=!imagesAvailable && !filesAvailable;
  if(!filesAvailable){$('attach-image').title='文件上传待服务更新；图片仍可选择或粘贴';$('image-files').accept=imageTypes.join(',');}
  if(state && page==='chat')renderChat();
})();
restoreComposer();await load();if(location.hash.startsWith('#projects'))show('projects');else if(location.hash==='#literature')show('literature');setInterval(load,5000);
