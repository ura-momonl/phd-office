import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { root, read, write, input, checkProjects, sharedReads } from '../automation/files.mjs';
import { workingFolder } from '../automation/workdir.mjs';
import { searchTerms, nearMatches } from '../automation/text-match.mjs';
import { enqueue, update, parseHandoff, readiness, returnResult, logRequirementOf, planProgress } from '../work/run.mjs';
import { autonomousCanStart } from '../work/autonomy.mjs';
import { exportWeek } from '../weekly/run.mjs';
import { invokeCodex } from './codex.mjs';
import { invokeClaude, claudeForkPoint } from './claude.mjs';
import { invokeDeepSeek } from './deepseek.mjs';
import { projectNode, projectStatus, renderStatus } from '../projects/run.mjs';
import {frameworkRevision} from '../projects/framework.mjs';
import {readCard,extractJSON,normalizeCard,cardOrigin,cardChain} from '../dashboard/cards.mjs';
import {resolveInbox} from '../dashboard/inbox.mjs';
import { taskEvidence } from '../mail-flow/flow.mjs';
import {mailBrief} from '../mail-flow/guide.mjs';
import {decodeImages,saveImages} from './images.mjs';
import {decodeFiles,saveFiles,attachmentContext} from './files.mjs';
import {memoryContextV2,prefetchMemoryV2} from '../memory2/inject.mjs';
import {taskPrompt,dataAnalysisMode,cardPrompt,titlePrompt,turn as say} from '../prompts/templates.mjs';
import {traceFragments,joinPrompt,promptSource,promptMap} from '../prompts/compose.mjs';
import {memoryVersion,tokenEstimate} from '../memory2/telemetry.mjs';
import {callsReport} from './calls.mjs';
import {contextBreakdown} from './context-breakdown.mjs';
import {loadBaseline,saveBaseline} from './file-baselines.mjs';
import {prepareFileNotice,runtimeCodeStatus,runtimeCodeText} from '../automation/file-state.mjs';

const stateFile='.runtime/agent/sessions.json';
// 每个会话保留的事件条数。看板最多显示 6 条已完成的工具调用（dashboard/activity.mjs），运行中的事件另外一律保留，
// 12 是它的两倍余量。这个数字决定 sessions.json 里 activity 的体积，它占该文件一半以上，且每次轮询都整份发给浏览器。
const ACTIVITY_KEEP=12;
const executionOwner={pid:process.pid,host:process.argv.at(-2)==='dashboard' && process.argv.at(-1)==='serve' ? 'dashboard' : 'agent'};
let visibleStateCache;
export const agentSnapshot=()=>{
  flushPending(); // Public readers must see queued stream events, just like readState callers.
  // Read the actual bytes every time: metadata/TTL would miss external edits.
  // Keep only the public view, not the large private file baselines. Callers get
  // independent objects, so neither editing a fixture nor handling a response
  // can mutate the next snapshot without an actual store write.
  const file=path.join(root,stateFile),bytes=fs.existsSync(file) ? fs.readFileSync(file) : null;
  const version=bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  if(!visibleStateCache || visibleStateCache.version!==version){
    const state=bytes ? JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')) : {sessions:[]};
    const view={...state,sessions:state.sessions.map(s=>{
      const {file_snapshots,...visible}=s; // Internal baselines are not a five-second UI payload.
      if(!visible.codex_continuation?.fileSnapshot)return visible;
      const {fileSnapshot,...continuation}=visible.codex_continuation;
      return {...visible,codex_continuation:continuation};
    })};
    visibleStateCache={version,state:view};
  }
  return {config:read('agent/config.json'),...structuredClone(visibleStateCache.state),
    active_turns:[...liveTurns.values()].map(({taskId,provider})=>({task_id:taskId,provider}))};
};
// sessions.json is one large file, so every write costs a full read+parse+serialize. Live stream events (tool, context, interim text) are queued
// and applied together at most once a second; every other edit and every read through readState applies the queue first, in order, so nothing
// observes a stale store and edits keep their sequence. A crash can lose at most the last second of live activity.
const FLUSH_MS=1000;
const pendingEdits=[];let flushTimer=null;
function takePending() {
  if(flushTimer){clearTimeout(flushTimer);flushTimer=null;}
  return pendingEdits.splice(0);
}
function applyPending(state,edits) {
  for(const {id,callback} of edits) {
    const session=state.sessions.find(s=>s.id===id);
    if(!session)continue; // the conversation was deleted meanwhile
    try {callback(session);} catch(error) {console.error('queued session edit failed:',error.message);}
  }
}
function flushPending() {
  const edits=takePending();
  if(!edits.length)return;
  try {
    const state=read(stateFile,{sessions:[]});applyPending(state,edits);write(stateFile,state);
  } catch(error) {
    pendingEdits.unshift(...edits); // keep them for the next flush instead of losing them
    console.error('queued session edits not saved:',error.message);
  }
}
process.on('exit',flushPending);
const readState=fallback=>{flushPending();return read(stateFile,fallback);};
function modifySession(id,callback,{defer=false}={}) {
  if(defer) {
    pendingEdits.push({id,callback});
    if(!flushTimer){flushTimer=setTimeout(flushPending,FLUSH_MS);flushTimer.unref();}
    return;
  }
  const edits=takePending(),state=read(stateFile,{sessions:[]});
  applyPending(state,edits);
  const session=state.sessions.find(s=>s.id===id);
  if(!session){if(edits.length)write(stateFile,state);throw new Error('未知会话');}
  callback(session);write(stateFile,state);return session;
}
// Who answers is decided by @ alone: the AIs named in the message, in the order named (@all = both); with no @, whoever answered last in the
// session, else the default. A reply can pass the turn on the same way (see summoned), so the user and the AIs share one mechanism.
const assistantNames={codex:'Codex',claude:'Claude',deepseek:'DeepSeek'};
const assistants=Object.keys(assistantNames);
const MENTION=/@(codex|claude(?: code)?|deepseek|all|两位|双方|大家|你)/gi;
const MAX_TURNS=10;   // the one hard limit in the system: AIs handing the turn to each other. The soft rule is in the prompt (do not go back and forth for long).
export function route(text,{last,fallback=read('agent/config.json').default_provider}={}) {
  const content=text.replace(MENTION,'');
  const kinds=[['cad',/autocad|comsol|fusion|altium|\bcad\b|仿真|绘图|画图/i],['data',/数据|\bcsv\b|\bpython\b|分析脚本|拟合/i],
    ['procurement',/quote|报价|采购|供货|供应商/i],['mail',/邮件|邮箱|跟进|回信|写信|\be-?mail\b/i],['literature',/文献|论文|doi|zotero/i],
    ['presentation',/ppt|幻灯片|报告/i],['framework',/代码|编程|实现|修复|创建.*文件|修改.*文件/i]];
  const kind=kinds.find(([,re])=>re.test(content))?.[0] || 'framework';
  const named=[];
  for(const [,word] of text.matchAll(MENTION)) {
    const who=/^codex$/i.test(word) ? ['codex'] : /^claude/i.test(word) ? ['claude'] : /^deepseek$/i.test(word) ? ['deepseek'] : word==='你' ? [] : /两位|双方/.test(word) ? ['codex','claude'] : assistants;
    for(const p of who)if(!named.includes(p))named.push(p);
  }
  if(named.length)return {provider:named[0],speakers:named,kind};
  // Only a whole bare command runs the exporter; discussion and requests to change its rules belong to an AI.
  if(/^(?:生成|更新|整理|准备|做|看看)\s*(?:周计划|周复盘|组会材料)[。！!]?$/u.test(text.trim()))return {provider:'program',kind:'presentation'};
  const provider=last || fallback;
  return {provider,speakers:[provider],kind};
}
// A reply passes the turn on by starting a line with the other AI's name; quoting it mid-line does nothing.
export function summoned(reply,self,already=[]) {
  const who=reply.match(/^[ \t]*@(codex|claude|deepseek)\b/im)?.[1]?.toLowerCase();
  return who && who!==self && !already.includes(who) ? who : null;
}
const lastSpeaker=session=>[...session.messages].reverse().find(m=>m.role==='assistant' && assistants.includes(m.provider))?.provider;
// Tasks that exist only because a card button was pressed are card work, not project work; older ones predate the mode flag.
// Every session records its creation origin: 'task' (card button or auto-started step) or 'chat'. Older sessions predate the field and are stamped once
// from what their first message shows (card entry, or the auto-start prompt startReadyWork writes) — never from the task's current, editable state.
const autoStartPrompt=/^@(Claude|Codex) 执行已获授权的项目步骤：/;
// The card button that asks the agent to handle it: cards.mjs writes 'agent-handle', replies stored before the rename say 'agent-check'.
const cardAction=id=>id==='agent-handle' || id==='agent-check';
export function markCardTasks() {
  const state=readState({sessions:[]}),queue=read('work/queue.json');let changed=0,stamped=0;
  for(const s of state.sessions) {
    const said=(s.messages || []).filter(m=>m.role==='user');
    if(!s.origin){s.origin=said[0] && (cardAction(said[0].inbox_reply?.action_id) || autoStartPrompt.test(said[0].text || '')) ? 'task' : 'chat';stamped++;}
    if(!said.length || !said.every(m=>cardAction(m.inbox_reply?.action_id)))continue;
    for(const id of s.task_ids) {const item=queue.items.find(i=>i.id===id);if(item && item.mode!=='card'){item.mode='card';changed++;}}
  }
  if(changed)write('work/queue.json',queue);
  if(stamped)write(stateFile,state);
  return changed+stamped;
}
// An assistant starts a new conversation as herself. This is provenance, not a new
// grant of authority; the original user's request remains at the linked source.
export function handoffCaller() {
  const provider=process.env.OFFICE_MEMORY_OWNER,directory=process.env.OFFICE_MEMORY_RUN_DIR;
  if(!assistants.includes(provider) || !directory)throw new Error('交接须从助手工作轮发起');
  const relative=path.relative(path.join(root,'.runtime/agent/runs'),directory);
  if(relative.startsWith('..') || path.isAbsolute(relative))throw new Error('交接来源运行目录不属于本办公室');
  return {provider,task_id:relative.split(path.sep)[0]};
}
const isRequest=m=>m.role==='user' || m.role==='handoff';
export function submit({text='',images=[],files=[],session_id,project_id,plan_node_id,inbox_reply,title,model,effort,handoff,workdir,notify_back},{last}={}) {
  if(process.env.OFFICE_MEMORY_OWNER && !handoff)handoff=handoffCaller();
  let source;
  if(handoff) {
    if(session_id || inbox_reply)throw new Error('助手交接只创建新对话，不代替用户回复现有对话或卡片');
    if(!assistants.includes(handoff.provider))throw new Error('交接发起者须为办公室助手');
    const parent=readState({sessions:[]}).sessions.find(s=>s.task_ids.includes(handoff.task_id));
    if(!parent || !read('work/queue.json').items.some(i=>i.id===handoff.task_id))throw new Error('未找到交接来源任务');
    // notify_back: when the child conversation's first turn finishes, post its result back to the conversation that started it (see sendReceipt).
    source={provider:handoff.provider,session_id:parent.id,task_id:handoff.task_id,...(notify_back===true ? {return_receipt:true} : {})};
  }
  const decoded=decodeImages(images),decodedFiles=decodeFiles(files);
  if(typeof text!=='string' || (!text.trim() && !decoded.length && !decodedFiles.length))throw new Error('请输入要做的事');
  if(!text.trim())text=decodedFiles.length ? '请看看这些附件。' : '请看看这些图片。';
  if(project_id)checkProjects([project_id]);
  if(plan_node_id && !projectNode(read('projects/catalog.json').projects.find(p=>p.id===project_id),plan_node_id))throw new Error('未找到项目步骤');
  // A folder the user opened the terminal front end in: the conversation is bound to it when it is created and keeps it (a thread's sandbox must not change mid-way).
  let folder;
  if(workdir) {
    folder=path.resolve(String(workdir));
    if(!path.isAbsolute(String(workdir)) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())throw new Error('工作文件夹不存在或不是文件夹：'+workdir);
    folder=workingFolder(folder,root);
  }
  const state=readState({sessions:[]});
  let session=state.sessions.find(s=>s.id===session_id);
  if(session_id && !session)throw new Error('未知会话');
  if(!session) {
    // origin records who created the session; it never changes when the user later speaks in it.
    session={id:randomUUID(),title:title || text.trim(),project_ids:project_id ? [project_id] : [],created_at:new Date().toISOString(),origin:inbox_reply ? 'task' : 'chat',messages:[],task_ids:[],
      ...(folder && folder.toLowerCase()!==path.resolve(root).toLowerCase() ? {workdir:folder} : {})};
    state.sessions.push(session);
  }
  let job=route(text,{last:last || lastSpeaker(session)});
  if(source && job.provider==='program')job=route('助手交接',{last:last || lastSpeaker(session)});
  // The deterministic weekly generator cannot inspect attachments; these turns need an AI.
  if((decoded.length || decodedFiles.length) && job.provider==='program')job=route('查看附件',{last:lastSpeaker(session)});
  const attachments=[...saveImages(decoded),...saveFiles(decodedFiles)];
  const item=enqueue({title:title || session.title,goal:text.trim(),kind:job.kind,status:'queued',
    actor:job.provider==='program' ? 'codex' : job.provider,project_ids:session.project_ids,plan_node_id},{modelDefaults:false,conversationTurn:true});
  session.messages.push({role:source ? 'handoff' : 'user',...(source ? {provider:source.provider,handoff:source} : {}),text:text.trim(),at:new Date().toISOString(),task_id:item.id,...(attachments.length ? {attachments} : {}),...(inbox_reply ? {inbox_reply} : {})});session.task_ids.push(item.id);
  write(stateFile,state);
  // Provider selection belongs to the controller, never a required user form field.
  const q=read('work/queue.json');{const queued=q.items.find(i=>i.id===item.id);queued.executor=job.provider;if(job.speakers?.length>1)queued.speakers=job.speakers;if(model)queued.model=model;if(effort)queued.effort=effort;if(cardAction(inbox_reply?.action_id))queued.mode='card';}write('work/queue.json',q);
  return {session_id:session.id,task_id:item.id,provider:job.provider};
}
// The message that starts the current run. An exploration card keeps one conversation across rounds; each round appends its own
// user message (with a `round`), so the newest one is the request. Every other task has exactly one.
const requestOf=(session,item)=>item.exploration ? session.messages.findLast(m=>isRequest(m) && m.task_id===item.id) : session.messages.find(m=>isRequest(m) && m.task_id===(item.request_task_id || item.id));
// An acknowledged correction in this chain is newer user intent. Keep the
// original in history rather than putting it after the correction again.
const turnRequest=(item,session,previous,queue)=>{
  const initiating=requestOf(session,item);
  return previous ? session.messages.findLast(m=>isRequest(m) && (m===initiating || queue.find(i=>i.id===m.task_id)?.merged_into===item.id)) : initiating;
};
// Memory retrieval takes seconds in a child process. Run it asynchronously before the synchronous prompt build so the backend keeps serving pages.
const prefetchMemory=(item,session,me,previous='')=>prefetchMemoryV2(me,(turnRequest(item,session,previous,read('work/queue.json').items)?.text ?? item.goal));
// Execution facts live with turns; operation identity and its submitted result
// stay in the queue. First executions use their existing task as the source.
function saveOperationTurn(operation,item,{status,outcome_status,outcome_handoff,handoff,outputs,session_id,started}) {
  const queue=read('work/queue.json'),now=new Date().toISOString();
  const run=item.operation_id ? queue.items.find(i=>i.id===item.id) : {
    id:randomUUID(),source_task_id:item.id,operation_id:operation.id,executor:item.actor,actor:item.actor,
    title:item.title,kind:item.kind,project_ids:item.project_ids,dependencies:[],goal:item.goal,created_at:new Date(started).toISOString()
  };
  Object.assign(run,{status,outcome_status,outcome_handoff,handoff,outputs:[...outputs],session_id,updated_at:now,completed_at:now});
  const verdict=queue.items.find(i=>i.id===operation.id)?.review_verdict;
  if(status==='done' && outcome_status==='done' && verdict)run.review_verdict=verdict;
  else delete run.review_verdict;
  if(!item.operation_id)queue.items.push(run);
  write('work/queue.json',queue);
}
// Opted-in workflow steps enter the existing controller under their ORIGINAL work ID.
// A session is the durable dispatch record; repeated ticks/restarts cannot create a second job for the same step.
export function startReadyWork() {
  const config = read('agent/config.json');
  if (!config.enabled) return [];
  const queue = read('work/queue.json'), state = readState({sessions:[]}), started=[];
  for (const item of queue.items) {
    if (!assistants.includes(item.actor) || !readiness(item,queue.items).ready || state.sessions.some(s=>s.task_ids.includes(item.id))) continue;
    if(!autonomousCanStart(item,queue.items))continue;
    const prior=item.operation_id && state.sessions.find(s=>s.task_ids.includes(item.operation_id) || s.task_ids.some(id=>queue.items.find(i=>i.id===id)?.operation_id===item.operation_id));
    if(prior) {
      prior.messages.push({role:'user',text:item.goal,at:new Date().toISOString(),task_id:item.id});prior.task_ids.push(item.id);
      started.push({task_id:item.id,session_id:prior.id});
    } else {
      const session={id:randomUUID(),title:item.title,project_ids:item.project_ids,created_at:new Date().toISOString(),origin:'task',messages:[{role:'user',text:item.goal,at:new Date().toISOString(),task_id:item.id}],task_ids:[item.id]};
      state.sessions.push(session);started.push({task_id:item.id,session_id:session.id});
    }
  }
  if(started.length)write(stateFile,state);
  return started;
}
// History for the AIs (`agent search|show`). The saved conversations are the source; nothing is indexed or copied.
// Interim words are left out: the same content is in the turn's final message.
const spoken=s=>(s.messages || []).filter(m=>!m.interim);
const dayOf=at=>at ? new Date(at).toLocaleDateString('en-CA',{timeZone:read('weekly/config.json').timezone}) : '时间未记录';
const flat=text=>String(text || '').replace(/\s+/g,' ').trim();
const lastAt=s=>spoken(s).at(-1)?.at || s.created_at || '';
const textOf=m=>`${m.text || ''}${attachmentContext(m)}`;
const SEARCH_USAGE='agent search <关键词；多个词用空格分开，需全部出现在同一条对话里；整句也可以，全匹配不到时会近似匹配>';
// The structured result, shared by the command line (searchSessions, text) and the dashboard's search box (/api/chat/search).
// {mode:'exact'|'near'|'none', total, rows:[{id,title,project_ids,projects,origin,last,count,score?,snippets:[{who,day,task_id,text}]}]}
export function findSessions(query,{limit=10,snippets=3,includeRunning=false}={}) {
  const terms=searchTerms(query);
  if(!terms.length)throw new Error(SEARCH_USAGE);
  const names=Object.fromEntries(read('projects/catalog.json').projects.map(p=>[p.id,p.name]));
  // For the AIs: the question being asked right now is itself saved in the conversation, so a running turn's messages are not searched: they would only find themselves.
  // The dashboard's user has no such turn to exclude.
  const running=new Set(includeRunning ? [] : read('work/queue.json').items.filter(i=>i.status==='active').map(i=>i.id));
  const rows=readState({sessions:[]}).sessions.map(s=>{
    const said=spoken(s).filter(m=>!running.has(m.task_id)).map(m=>{const text=flat(textOf(m));return {m,text,low:text.toLocaleLowerCase()};});
    const title=(s.title || '').toLocaleLowerCase(),all=[title,...said.map(x=>x.low)].join('\n');
    return {s,said,title,titled:terms.every(t=>title.includes(t)),full:terms.every(t=>all.includes(t))};
  });
  // Every word in one conversation; a conversation whose title holds them all (asking for a conversation by name) comes first, then the newest.
  const found=rows.filter(x=>x.full).sort((a,b)=>b.titled-a.titled || lastAt(b.s).localeCompare(lastAt(a.s)));
  const card=(s,said,extra)=>({id:s.id,title:s.title || '未命名对话',project_ids:s.project_ids || [],projects:(s.project_ids || []).map(id=>names[id] || id),origin:s.origin==='task' ? 'task' : 'chat',last:dayOf(lastAt(s)),count:said.length,...extra});
  const snippet=({m},gram)=>{const paragraphs=textOf(m).split(/\r?\n\s*\r?\n/),text=paragraphs.find(p=>p.toLocaleLowerCase().includes(gram)) || textOf(m);return {who:speakerName(m),day:dayOf(m.at),task_id:m.task_id || '',text};};
  if(found.length) {
    return {mode:'exact',total:found.length,rows:found.slice(0,limit).map(({s,said})=>{
      const hits=said.map((x,index)=>({...x,index,score:terms.filter(t=>x.low.includes(t)).length})).filter(x=>x.score)
        .sort((a,b)=>b.score-a.score || a.index-b.index).slice(0,snippets).sort((a,b)=>a.index-b.index);
      return card(s,said,{snippets:hits.map(x=>snippet(x,terms.find(t=>x.low.includes(t))))});
    })};
  }
  // No conversation has every word (typically a whole sentence from memory): score each message by the pieces of the query it contains. Short words stay whole,
  // longer ones are cut into two-character pieces; a piece found in few messages counts for more than one found everywhere. Plain arithmetic, no model.
  const docs=rows.flatMap(r=>[{r,title:true,low:r.title},...r.said.map(x=>({...x,r}))]),{weight,scored}=nearMatches(docs,terms);
  const near=rows.map(r=>({r,docs:scored.filter(d=>d.r===r).sort((a,b)=>b.score-a.score)})).filter(x=>x.docs.length)
    .sort((a,b)=>b.docs[0].score-a.docs[0].score || lastAt(b.r.s).localeCompare(lastAt(a.r.s))).slice(0,5);
  return {mode:near.length ? 'near' : 'none',total:near.length,rows:near.map(({r,docs:ds})=>card(r.s,r.said,{score:Math.round(ds[0].score*100),
    snippets:ds.filter(d=>!d.title).slice(0,Math.min(snippets,2)).map(d=>snippet(d,[...d.hit].sort((a,b)=>weight[b]-weight[a])[0]))}))};
}
export function searchSessions(query,options) {
  const {mode,total,rows}=findSessions(query,options),limit=options?.limit ?? 10;
  const header=r=>`\n[${r.id}] ${r.title} · ${r.projects.join('、') || '无项目'} · ${r.origin==='task' ? '任务会话' : '对话'} · 最后活动 ${r.last}`;
  const snippet=x=>`  · ${x.who} ${x.day} #${x.task_id.slice(0,8)}：${x.text}`;
  const how='\n读原文：node automation/run.mjs agent show <会话id前缀>[#任务id前缀]';
  if(mode==='none')return '找到 0 条对话。';
  const lines=mode==='exact'
    ? [`找到 ${total} 条对话${total>limit ? `，显示前 ${limit} 条（加关键词可缩小）` : ''}。`]
    : [`没有对话同时包含全部词。按查询里的字词片段近似匹配，下面是最像的 ${total} 条候选（近似度＝命中片段的稀有度占比，只是候选，请看片段自己判断；整句不必拆，也可换更有辨识度的短词再查）。`];
  for(const r of rows)lines.push(mode==='exact' ? `${header(r)} · ${r.count} 条` : `${header(r)} · 近似度 ${r.score}%`,...r.snippets.map(snippet));
  return [...lines,how].join('\n');
}
// show <session>: one line per turn, so a long conversation is not dumped whole; show <session>#<task>: that turn's complete messages.
export function showSession(ref) {
  const [sid,tid]=String(ref || '').split('#');
  if(!sid || sid.length<4)throw new Error('agent show <会话id前缀，至少 4 位>[#任务id前缀]（id 来自 agent search）');
  const matches=readState({sessions:[]}).sessions.filter(s=>s.id.startsWith(sid));
  if(matches.length!==1)throw new Error(matches.length ? `前缀不唯一，匹配 ${matches.length} 条对话，请多写几位` : '没有这条对话（可能已删除；每日备份里仍有）');
  const s=matches[0],said=spoken(s),zone=read('weekly/config.json').timezone;
  const head=`[${s.id}] ${s.title || '未命名对话'} · ${s.origin==='task' ? '任务会话' : '对话'} · 创建 ${dayOf(s.created_at)} · 最后活动 ${dayOf(lastAt(s))}`;
  if(tid) {
    const turn=said.filter(m=>m.task_id?.startsWith(tid));
    if(!turn.length)throw new Error('这条对话里没有该任务的发言');
    if(new Set(turn.map(m=>m.task_id)).size>1)throw new Error('任务前缀不唯一，请多写几位');
    return [head,...turn.map(m=>`\n【${speakerName(m)} · ${dayOf(m.at)} ${new Date(m.at).toLocaleTimeString('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'})}】\n${textOf(m)}`)].join('\n');
  }
  const turns=[...new Set(said.map(m=>m.task_id))].map(id=>{
    const mine=said.filter(m=>m.task_id===id),ask=mine.find(isRequest),reply=mine.filter(m=>!isRequest(m)).at(-1);
    return `#${(id || '').slice(0,8)} ${dayOf(mine[0].at)} ${ask ? speakerName(ask) : '请求'}：${flat(ask?.text)}${reply ? `\n    ${speakerName(reply)}：${flat(reply.text)}` : ''}`;
  });
  return [head,...turns,`\n看某一轮全文：agent show ${s.id.slice(0,8)}#<任务id前缀>`].filter(Boolean).join('\n');
}
// Automatic titles. A chat starts with its first words as a draft title; after its first answer a small model names it, and once more when the chat
// reaches its `title_again_at`-th user message (the first title was made from almost nothing). Never again after that. A conversation made for a card or an
// automatic step already has its task's title. The user-message count at each try is recorded (title_turns), so a try is not repeated, failed or not.
export const draftTitle=s=>{const first=(s.messages || []).find(m=>m.role==='user');return s.origin==='chat' && !s.title_manual && !s.title_tried && !!first && (s.title===first.text.trim() || s.title===first.text.trim().slice(0,40));};
const userTurns=s=>(s.messages || []).filter(m=>m.role==='user').length;
export const titleDue=(s,again=read('agent/config.json').title_again_at)=>s.origin==='chat' && !s.title_manual && (draftTitle(s) || (!!s.title_tried && !!again && userTurns(s)>=again && (s.title_turns ?? 0)<again));
// Letters of unrelated scripts, which a small model occasionally emits mid-title, are dropped; Han, Latin, Greek and common symbols stay.
export const cleanTitle=raw=>flat(String(raw || '').split('\n').find(l=>l.trim())?.replace(/[^\p{Script=Han}\p{Script=Latin}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/gu,'')).replace(/^(?:标题|题目)[:：]\s*/,'').replace(/^@\S+\s*/,'').replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》。.]+$/g,'');
export async function titleSession(sessionId,runner=invokeNative,{force=false}={}) {
  try {
    const cfg=read('agent/config.json'),session=readState({sessions:[]}).sessions.find(s=>s.id===sessionId);
    if(!session || session.title_manual || (!force && !titleDue(session,cfg.title_again_at)))return null;
    const users=session.messages.filter(m=>m.role==='user'),firstReply=spoken(session).find(m=>m.role==='assistant');
    modifySession(sessionId,s=>{s.title_tried=true;s.title_turns=users.length;});
    // A long conversation is named from its beginning and its latest messages.
    const excerpt=(users.length>7 ? [...users.slice(0,3),...users.slice(-4)] : users).map(m=>`用户：${flat(m.text)}`);
    if(firstReply)excerpt.splice(1,0,`${speakerName(firstReply)}：${flat(firstReply.text)}`);
    const prompt=titlePrompt(excerpt.join('\n'));
    const {result}=await runner(cfg.title_provider,prompt,{directory:path.join(root,'.runtime/agent/runs','title-'+randomUUID()),mode:'ask',purpose:'title',model:cfg.title_model,effort:cfg.title_effort});
    const title=cleanTitle(result);
    if(!title)return null;
    let applied=false;
    modifySession(sessionId,s=>{if(s.title_manual)return;s.title=title;s.titled_at=new Date().toISOString();applied=true;});
    return applied ? title : null;
  } catch(error) {
    // Titling is a courtesy: it must not break the turn that has finished, nor a conversation deleted in the meantime.
    try {modifySession(sessionId,s=>{s.activity=[...(s.activity || []),{type:'title',detail:'自动起标题失败：'+error.message,at:new Date().toISOString()}].slice(-ACTIVITY_KEEP);});} catch { /* the conversation is gone */ }
    return null;
  }
}
export function renameSession(sessionId,title) {
  if(typeof title!=='string' || !title.trim())throw new Error('标题不能为空');
  const s=modifySession(sessionId,s=>{s.title=title.trim();s.title_manual=true;s.titled_at=new Date().toISOString();});
  return {id:s.id,title:s.title};
}
export function pinSession(sessionId,pinned) {
  if(typeof pinned!=='boolean')throw new Error('pinned 必须为布尔值');
  if(readState({sessions:[]}).sessions.find(s=>s.id===sessionId)?.origin==='task')throw new Error('任务会话不支持置顶到最近会话');
  const s=modifySession(sessionId,s=>{
    if(pinned)s.pinned=true;else delete s.pinned;
  });
  return {id:s.id,pinned:s.pinned===true};
}
// Deleting a conversation removes its messages only. The work records its tasks made stay: they feed the project status pages and the weekly
// review. A conversation with a task still queued or running cannot be deleted, because that task writes its reply back into it.
export function deleteSession(sessionId) {
  const state=readState({sessions:[]}),session=state.sessions.find(s=>s.id===sessionId);
  if(!session)throw new Error('未知会话');
  const queue=read('work/queue.json');
  if(session.task_ids.some(id=>['queued','active'].includes(queue.items.find(i=>i.id===id)?.status)))throw new Error('这个会话还有任务在排队或运行，请先停止');
  state.sessions=state.sessions.filter(s=>s.id!==sessionId);write(stateFile,state);
  return {deleted:sessionId,tasks_kept:session.task_ids.length};
}
// Edit an earlier user message and regenerate from there (what Claude Code and Codex now offer natively). The conversation is cut at that message;
// everything from it on is archived whole (.runtime/agent/branches/<会话>/<id>.json), not deleted, and the edited text goes through the ordinary submit path.
// Both native threads already saw the discarded replies, so their continuations are dropped: the next turn starts a fresh thread from the shortened
// Workbench record. Files the discarded replies
// changed on disk are not rolled back, and the work records their tasks made stay (as with deleteSession).
// A turn's `got` is every message index the thread had seen by the end of that turn (own replies and steered inputs included), minus what earlier turns
// already had. It is closed when the next turn starts, because only then is the seen set final. Rebuilt after a fork from the turns that survive.
function closeTurns(c) {
  const turns=(c?.turns || []).map(t=>({...t})),last=turns.at(-1);
  if(last && !last.got)last.got=(c.seen || []).filter(i=>!turns.some(t=>t.got?.includes(i)));
  return turns;
}
// Rewind one provider's native thread for an edit at message `cut` that removes `removed` tasks. Returns the continuation to keep, or null for a fresh thread.
// Fork before the first removed turn; nothing removed from this thread keeps it as is; the whole thread removed, a legacy continuation without turn records,
// or an unreadable Claude transcript all mean a fresh thread (the established fallback).
function rewindContinuation(provider,c,cut,removed) {
  if(!c?.threadId || !c.turns)return null;
  const turns=closeTurns(c),first=turns.findIndex(t=>removed.has(t.task_id));
  if(first===0)return null;
  const {fileSnapshot,...base}=c;
  if(first<0)return {...base,turns,seen:(c.seen || []).filter(i=>i<cut)};
  const keep=turns.slice(0,first),fork=provider==='claude' ? {forkAt:claudeForkPoint(c.threadId,turns[first].ref)} : {forkBefore:turns[first].ref};
  if(!Object.values(fork)[0])return null;
  // The thread that is forked never saw the context hashes' later versions or the messages delivered in the removed turns: send them again.
  return {...base,...fork,turns:keep,seen:[...new Set(keep.flatMap(t=>t.got || []))].filter(i=>i<cut),
    contextHash:undefined,executionContextHash:undefined,projectSourceHash:undefined,focusHash:undefined,memoryIds:[]};
}
export function editMessage({session_id,task_id,text}) {
  if(typeof text!=='string' || !text.trim())throw new Error('请输入要做的事');
  const state=readState({sessions:[]}),session=state.sessions.find(s=>s.id===session_id);
  if(!session)throw new Error('未知会话');
  const queue=read('work/queue.json');
  if(session.task_ids.some(id=>['queued','active'].includes(queue.items.find(i=>i.id===id)?.status)))throw new Error('这个会话还有任务在排队或运行，请先停止');
  const cut=session.messages.findIndex(m=>m.role==='user' && m.task_id===task_id),item=queue.items.find(i=>i.id===task_id);
  if(cut<0 || !item)throw new Error('未找到要编辑的发言');
  if(item.merged_into || item.exploration)throw new Error('追加到上一轮的发言和探索任务不能单独编辑重生成');
  const kept=session.messages.slice(0,cut),tail=session.messages.slice(cut);
  if(tail.some(m=>m.inbox_reply))throw new Error('后面含卡片回复，不能从这里重新生成');
  const keptTasks=new Set(kept.map(m=>m.task_id).filter(Boolean));
  if(tail.some(m=>keptTasks.has(m.task_id)))throw new Error('这条发言夹在上一轮回复中间，不能从这里重新生成');
  const target=session.messages[cut],removed=new Set(tail.map(m=>m.task_id).filter(Boolean)),id=randomUUID(),at=new Date().toISOString();
  const continuations=Object.fromEntries(['codex','claude'].map(p=>{const {fileSnapshot,...c}=session[continuationKey(p)] || {};return [p,session[continuationKey(p)] ? c : null];}));
  write(`.runtime/agent/branches/${session.id}/${id}.json`,{id,session_id:session.id,at,cut_index:cut,replaced_task_id:task_id,task_ids:[...removed],
    continuations,messages:tail});
  session.messages=kept;session.task_ids=session.task_ids.filter(t=>!removed.has(t));
  session.questions=(session.questions || []).filter(q=>q.after<=cut && !removed.has(q.task_id)); // questions asked in the replaced branch go with it
  for(const p of ['codex','claude']) {
    const rewound=rewindContinuation(p,session[continuationKey(p)],cut,removed);
    if(rewound)session[continuationKey(p)]=rewound;else delete session[continuationKey(p)];
  }
  if(cut===0 && !session.title_manual && (session.title===target.text.trim() || session.title===target.text.trim().slice(0,40)))session.title=text.trim();
  session.activity=[...(session.activity || []),{type:'edit',name:'编辑发言并重新生成',detail:`从第 ${cut+1} 条起替换，旧分支 ${tail.length} 条已存档：${id}`,task_id,at}].slice(-ACTIVITY_KEEP);
  write(stateFile,state);
  const node=item.plan_node_id ? {project_id:session.project_ids[0],plan_node_id:item.plan_node_id} : {};
  const job=submit({text,session_id:session.id,model:item.model,effort:item.effort,...node});
  modifySession(session.id,s=>{
    const message=s.messages.find(m=>m.role==='user' && m.task_id===job.task_id);
    if(target.attachments?.length)message.attachments=target.attachments;
    message.edited={at,branch:id,replaced:tail.length};
  });
  return {...job,branch:id,replaced:tail.length};
}
// The mail task a reply card is about, with the evidence the program can read for it.
function focusMail(item,session,options) {
  const mail=replyChain(session,item.id).find(id=>id.startsWith('mail:'));
  return mail && taskEvidence(path.join(root,'.runtime/mail-flow'),mail.slice(5),options);
}
// Who said it matters once Codex and Claude share one conversation with the user.
const speakerName=m=>m.role==='user' ? '用户' : m.role==='error' ? '系统' : ({...assistantNames,program:'程序'}[m.provider] || '助手')+(m.role==='handoff' ? (m.handoff?.receipt ? ' · 交接回执' : ' · 发起交接') : '');
export {estimateTokens} from './context-breakdown.mjs';
// Keep the saved conversation verbatim: nothing is summarised or dropped from what a fresh thread is sent.
export function conversationRecord(messages) {
  return {lines:messages.map(m=>JSON.stringify({role:m.role,speaker:speakerName(m),
    ...(m.provider ? {provider:m.provider} : {}),...(m.handoff ? {handoff:m.handoff,source_ref:`${m.handoff.session_id}#${m.handoff.task_id}`} : {}),
    text:m.text,...(m.attachments?.length ? {attachments:attachmentContext(m)} : {})}))};
}
// A turn is one of two kinds. ask: the program wants one JSON reply (a card), no tools. work: every conversation turn, including one another AI
// handed over, as an ordinary agent with the user's own auto approver.
// What a model call is for, recorded in the usage ledger. A card is anything about an inbox card: the first judgement, a button reply, and later free follow-ups
// in that conversation (judged by the conversation's records, not by the task's current state). Otherwise a session made for a task is an automatic step.
export const purposeOf=(item,session)=>{
  const said=session.messages.filter(m=>m.role==='user');
  return item.mode==='card' || said.find(m=>m.task_id===item.id)?.inbox_reply || said[0]?.inbox_reply ? 'card' : session.origin==='task' ? 'auto' : 'chat';
};
// The inbox card a conversation last answered (a button reply or "让 agent 处理"), as of the given task's own message (default: the whole conversation).
export const askedCard=(session,taskId)=>{
  const said=session.messages.filter(m=>m.role==='user'),end=taskId ? said.findIndex(m=>m.task_id===taskId) : -1;
  return said.slice(0,end<0 ? undefined : end+1).reverse().map(m=>m.inbox_reply?.id || cardOrigin(m.text)).find(Boolean) || '';
};
const turnMode=item=>item.mode==='card' ? 'ask' : 'work';
function promptFor(item,session,{me,turn=0,previous='',continuation,pilot=false,fileNotice,code}={}) {
  if(item.mode==='card')return {prompt:cardPrompt(item.title,JSON.stringify(focusMail(item,session) || {}))};
  // Common instructions stay discoverable on demand. Interactive mail work additionally gets
  // the short mail brief (goal, material entry points, authorization floor) before acting; the full send mechanics stay on demand (`mail guide`).
  // Parsed cards above and background classification get neither.
  const zone=read('weekly/config.json').timezone;
  const profile=path.join(path.dirname(root),'PROFILE.md');
  const modules=Object.entries(read('automation/config.json').modules).filter(([,m])=>m.usage).map(([id])=>id).join('、');
  const today=`${new Date().toLocaleDateString('en-CA',{timeZone:zone})} ${new Date().toLocaleDateString('zh-CN',{timeZone:zone,weekday:'long'})}（${zone}）`;
  const context=item.operation_id ? read('work/queue.json').items.find(i=>i.id===item.operation_id) : item;
  const projects=read('projects/catalog.json').projects.filter(p=>context.project_ids.includes(p.id));
  const status=projectStatus(context.project_ids);
  const stageProject=context.plan_node_id && projects.find(p=>projectNode(p,context.plan_node_id));
  const stage=stageProject && projectNode(stageProject,context.plan_node_id);
  const queue=read('work/queue.json').items;
  const initiating=requestOf(session,item);
  const request=turnRequest(item,session,previous,queue);
  const goal=request?.text ?? item.goal;
  // A handoff continues the chronological conversation, including the user message
  // and all replies. Only a new direct request belongs at the end as current input.
  const current=item.handoff_resume ? session.task_ids.length-1 : session.task_ids.indexOf(item.id),seen=new Set(continuation?.seen || []);
  // Messages are append-only. Store a set of indices, never an end-of-run count:
  // later queued requests may be interleaved with this turn's own words and acknowledged steer inputs.
  // Child transcripts remain available in cards, but are not main-conversation history.
  // Native result delivery already gives the parent the material it needs.
  const eligible=session.messages.map((m,index)=>({m,index})).filter(({m})=>!m.subagent).filter(({m})=>!isRequest(m) || m===request ||
    queue.find(i=>i.id===m.task_id)?.merged_into===item.id ||
    (session.task_ids.indexOf(m.task_id)<=current && (queue.find(i=>i.id===m.task_id)?.status!=='queued' || queue.find(i=>i.id===m.task_id)?.handoff_resume)));
  const selected=eligible.filter(({m,index})=>(previous || m!==request) && (continuation ? !seen.has(index) : true));
  // Only generated operation envelopes have a stable-context identity. Never
  // deduplicate user prose. Reuse the native seen set, also while rebuilding a
  // fresh thread's chronological history; saved messages remain verbatim.
  const known=new Set(seen);
  const operationMessage=(m,index)=>{
    const context=m?.operation_prompt;
    let prior;
    if(context)for(let i=index-1;i>=0;i--) {
      const candidate=session.messages[i].operation_prompt;
      if(known.has(i) && candidate?.id===context.id){prior=candidate;break;}
    }
    known.add(index);
    return context && prior?.context_hash===context.context_hash ? {...m,text:context.update_text} : m;
  };
  const record=conversationRecord(selected.map(({m,index})=>operationMessage(m,index)));
  const currentRequest=operationMessage(request,session.messages.indexOf(request));
  const focus=focusMail(item,session,{complete:true});
  // Keep source chronology and exact normalized text. Folder labels identify prior
  // correspondence, not a new user instruction or authorization for this turn.
  const focusText=focus ? JSON.stringify({...focus,source_messages:focus.source_messages.map(m=>({
    correspondence_role:say.focusRole(m.folder),
    ...m,
  }))},null,2) : '';
  const focusHash=createHash('sha256').update(focusText).digest('hex');
  const origins=replyChain(session,item.id);
  const colleagues=assistants.filter(p=>p!==me).map(p=>assistantNames[p]);
  const projectContext=[
    say.projectList(projects),
    stage && say.stage(stage,stageProject.id,JSON.stringify((stage.files || []).map(f=>({name:f.title || f.path,file:path.join(root,'workspace/projects',stageProject.id,f.path)})))),
  ].filter(Boolean);
  const projectText=joinPrompt(projectContext);
  const contextHash=createHash('sha256').update(String(projectText)).digest('hex');
  const executionContext=status ? `执行事项摘录（不是研究事实的替代，邮件 action 只是后台建议）：\n${status}` : '';
  const executionContextHash=createHash('sha256').update(executionContext).digest('hex');
  const projectSourceHash=createHash('sha256').update(JSON.stringify(projects.map(p=>[p.id,frameworkRevision(p.id)]))).digest('hex');
  // Assistant replies can echo an injected memory. Do not turn those echoes into
  // fresh retrieval intent; handoffs use the same initiating user topic.
  const memory=memoryContextV2(me,goal);
  const source=(text,label,path='agent/run.mjs')=>promptSource(text,{path,label});
  const requestText=m=>joinPrompt([m?.handoff && (m.handoff.receipt ? say.handoffReceipt : say.handoffSource)(speakerName(m),`${m.handoff.session_id}#${m.handoff.task_id}`),source(String(m?.text ?? goal),m?.role==='handoff'?'助手交接':m?'用户消息':'任务目标',m?'.runtime/agent/sessions.json':'work/queue.json'),source(attachmentContext(m),'附件说明','agent/files.mjs')],'');
  const sections=[{kind:'office_context',content:joinPrompt([
    !continuation && say.surroundings(modules),
    !continuation && me && say.identity(assistantNames[me],colleagues.join('、')),
    !continuation && workingFolder(session.workdir,root) && say.workdir(workingFolder(session.workdir,root),root),
    (!continuation || continuation.contextHash!==contextHash) && source(projectText,'项目入口'),
  ].filter(Boolean))},
    {kind:'conversation_history',content:record.lines.length && say.record(record.lines.map((line,i)=>promptSource(line,{path:'.runtime/agent/sessions.json',label:'历史消息',message_index:selected[i].index})))},
    {kind:'run_context',content:joinPrompt([
    // Keep the stable office context and append-only history ahead of changing
    // date, recall and run notices. No evidence is shortened to get this prefix.
    say.intro(today,profile),
    source(memory.text,'本轮记忆','memory2/context.mjs'),
    continuation && continuation.executionContextHash!==executionContextHash && projects.length && say.executionChanged(),
    projects.length && (!continuation || continuation.projectSourceHash!==projectSourceHash) && say.sourceVersion(projectSourceHash,!!continuation),
    say.runDir(path.join(root,'.runtime/agent/runs',item.id)),
    say.subagents(read('agent/config.json').subagent_max_concurrency ?? 10, read('agent/config.json').queued_cards_per_turn ?? 10),
    code && runtimeCodeText(code),
    source(fileNotice?.text,'文件状态说明','automation/file-state.mjs'),
    origins.length && say.cardOrigin(origins[0]),
    (!continuation || continuation.focusHash!==focusHash) && (focusText ? say.focusEvidence(source(focusText,'邮件证据','mail-flow/flow.mjs')) : continuation?.focusHash && say.focusNone()),
    (item.kind==='mail' || focus) && source(mailBrief(),'邮件简报','mail-flow/MAIL-BRIEF.md'),
    dataAnalysisMode(context),
  ].filter(Boolean))},
    {kind:'current_request',content:!previous && say.request(requestText(currentRequest))}
  ].filter(s=>s.content);
  const prompt=joinPrompt(sections.map(s=>s.content));
  const inputParts=sections.map(s=>({kind:s.kind,text:String(s.content)}));
  return {prompt:String(prompt),inputParts,sources:promptMap(prompt),contextHash,executionContextHash,projectSourceHash,focusHash,memory:{...memory,text:String(memory.text)},seen:eligible.map(x=>x.index)};
}

// Each AI keeps its own native thread per conversation (codex_continuation / claude_continuation) and its own set of messages it has seen.
const continuationKey=provider=>provider+'_continuation';
// A native thread already saw its own output; retain the Workbench original without echoing it back on resume.
function appendReply(sessionId,message,threadId,defer=false) {
  modifySession(sessionId,s=>{
    const index=s.messages.push(message)-1,c=s[continuationKey(message.provider)];
    if(threadId && c?.threadId===threadId)c.seen=[...new Set([...c.seen,index])];
  },{defer});
}
// The two AIs share one contract (see native.mjs): the same options in, the same result shape out. This only picks the AI and keeps the prompt.
export async function invokeNative(provider,prompt,options={}) {
  const invoke={claude:invokeClaude,codex:invokeCodex,deepseek:invokeDeepSeek}[provider];
  if(!invoke)throw new Error('未知 AI 执行器');
  fs.mkdirSync(options.directory,{recursive:true});fs.writeFileSync(path.join(options.directory,'prompt.txt'),prompt);
  return invoke(prompt,options);
}
const controllers=new Map();
const liveTurns=new Map();
const openExecutionError=()=>Object.assign(new Error('事项已退回 open，执行已停止；未启动后续交接'),{code:'EXECUTION_OPEN'});
function assertExecutionAllowed(taskId) {
  if(read('work/queue.json').items.find(i=>i.id===taskId)?.status==='open')throw openExecutionError();
}
// The agent's own questions (Claude AskUserQuestion / Codex request_user_input). The turn waits on a promise; the workbench shows the record kept on the
// session (s.questions) and answers it through answerQuestion. Stopping the turn cancels it. The record keeps what was asked and answered, in place by `after`.
const waitingQuestions=new Map();
const closeQuestion=(sessionId,id,patch)=>{
  waitingQuestions.delete(id);
  try {modifySession(sessionId,s=>{const q=s.questions?.find(x=>x.id===id);if(q && q.status==='pending')Object.assign(q,patch,{closed_at:new Date().toISOString()});});} catch { /* session deleted meanwhile */ }
};
function askUser(sessionId,taskId,provider,items,signal) {
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error(STOP_MESSAGE));return;}
    modifySession(sessionId,s=>{s.questions=[...(s.questions || []),{id,task_id:taskId,provider,items,status:'pending',after:s.messages.length,asked_at:new Date().toISOString()}].slice(-30);});
    const abort=()=>{closeQuestion(sessionId,id,{status:'cancelled'});reject(new Error('本轮已停止'));};
    signal?.addEventListener('abort',abort,{once:true});
    waitingQuestions.set(id,{sessionId,taskId,items,done:answers=>{signal?.removeEventListener('abort',abort);resolve(answers);},cancel:abort});
  });
}
// answers: {questionItemId: [text,...]}, each entry a chosen option label or the user's own words.
export function answerQuestion({session_id,question_id,answers}) {
  const waiting=waitingQuestions.get(question_id);
  if(!waiting || waiting.sessionId!==session_id)throw new Error('这个问题已经结束或不存在');
  const clean={};
  for(const item of waiting.items) {
    const list=answers?.[item.id];
    if(!Array.isArray(list))throw new Error('还有问题没有回答');
    const texts=list.map(t=>String(t ?? '').trim()).filter(Boolean);
    if(!texts.length)throw new Error('还有问题没有回答');
    clean[item.id]=item.multi ? texts : texts.slice(0,1);
  }
  closeQuestion(session_id,question_id,{status:'answered',answers:clean});
  waiting.done(clean);
  return {question_id,status:'answered'};
}
// Native receipts record delivery; they do not schedule the next input.
function mergeInput(live,id) {
  const q=read('work/queue.json'),follow=q.items.find(i=>i.id===id);
  if(follow.status==='cancelled'){live.controller.abort();return;}
  follow.status='active';follow.merged_into=live.taskId;follow.execution_owner=q.items.find(i=>i.id===live.taskId)?.execution_owner;follow.updated_at=new Date().toISOString();write('work/queue.json',q);
  if(!live.followups.includes(id))live.followups.push(id);
}
// "@A @B …" sent while A is speaking: A takes the words now, through the live turn; the AIs named after A get their own queued
// turn (same words, run after the live chain ends), so neither the steer nor the rest of the order is lost.
function passOnSpeakers(sessionId,id,live) {
  const q=read('work/queue.json'),item=q.items.find(i=>i.id===id);
  if(!item?.speakers?.length || item.status==='cancelled')return;
  const at=item.speakers.indexOf(live.provider),rest=item.speakers.slice(at<0 ? 1 : at+1);
  if(!rest.length)return;
  const next=enqueue({title:item.title,goal:item.goal,kind:item.kind,status:'queued',actor:rest[0],project_ids:item.project_ids,plan_node_id:item.plan_node_id},{conversationTurn:true});
  const queue=read('work/queue.json'),queued=queue.items.find(i=>i.id===next.id);
  queued.executor=rest[0];queued.request_task_id=id;if(rest.length>1)queued.speakers=rest;
  write('work/queue.json',queue);
  modifySession(sessionId,s=>{s.task_ids.push(next.id);});
}
// User input has priority only while the colleague's initial input is unsent.
function queuedUserInput(session,queue) {
  return queue.find(i=>!i.handoff_resume && !i.merged_into && session.messages.some(m=>m.role==='user' && m.task_id===i.id) &&
    readiness(i,queue).ready && autonomousCanStart(i,queue));
}
// An assistant-created conversation may ask (notify_back) to report back: once its first turn is finished, the result is queued as a
// receipt turn in the conversation that started it, answered by the assistant who started it. A receipt itself never asks again.
function sendReceipt(childId,taskId,result,speaker,runner) {
  const child=readState({sessions:[]}).sessions.find(s=>s.id===childId),ask=child?.messages.find(m=>m.role==='handoff' && m.task_id===taskId && m.handoff?.return_receipt);
  if(!ask || ask.handoff.receipt_task_id)return null;
  const origin=ask.handoff,parent=readState({sessions:[]}).sessions.find(s=>s.id===origin.session_id);
  if(!parent)return null;
  const text=`${assistantNames[speaker] || '她'}在你交接的对话「${child.title}」（${childId}）里完成了一轮，以下是她的最终回复；需要原文时用 agent show ${childId.slice(0,8)} 读取。

${result.trim()}`;
  const item=enqueue({title:'回执：'+child.title,goal:text,kind:'framework',status:'queued',actor:origin.provider,project_ids:parent.project_ids},{modelDefaults:false,conversationTurn:true});
  modifySession(parent.id,s=>{
    s.messages.push({role:'handoff',provider:speaker,handoff:{provider:speaker,session_id:childId,task_id:taskId,receipt:true},text,at:new Date().toISOString(),task_id:item.id});
    s.task_ids.push(item.id);
  });
  modifySession(childId,s=>{const m=s.messages.find(x=>x.role==='handoff' && x.task_id===taskId);m.handoff.receipt_task_id=item.id;});
  const queue=read('work/queue.json');Object.assign(queue.items.find(i=>i.id===item.id),{executor:origin.provider,speakers:[origin.provider]});write('work/queue.json',queue);
  setImmediate(()=>{drain(runner).catch(e=>console.error('回执：'+e.message));});
  return item.id;
}
function deferHandoff(session,item,speakers,turn,response,completed,posted) {
  const text=parseHandoff(response.result).text;
  if(posted!==text)appendReply(session.id,{role:'assistant',text,provider:completed.speaker,at:new Date().toISOString(),task_id:item.id},completed.threadId);
  const queue=read('work/queue.json');
  Object.assign(queue.items.find(i=>i.id===item.id),{status:'queued',executor:speakers[0],speakers,
    handoff_resume:{turn,original_route:item.handoff_resume?.original_route || {executor:item.executor,speakers:item.speakers}},updated_at:new Date().toISOString()});
  write('work/queue.json',queue);
}
// Background maintenance must defer to actual execution, not every backlog
// item (user tasks and dependency-blocked work can remain queued for days).
export function agentWorkBusy() {
  if(controllers.size)return true;
  const queue=read('work/queue.json').items;
  const taskIds=new Set(readState({sessions:[]}).sessions.flatMap(s=>s.task_ids));
  return queue.some(item=>readiness(item,queue).ready &&
    (taskIds.has(item.id) || [...assistants,'program'].includes(item.actor)));
}
// Each ready message is written separately, without waiting for an earlier
// receipt or selecting a tool boundary. Context consumption belongs to the harness.
export async function sendChat(request) {
  const live=liveTurns.get(request.session_id);
  const job=submit(request,{last:live && (live.sent ? live.provider : live.defaultProvider)});
  const item=read('work/queue.json').items.find(i=>i.id===job.task_id);
  if(!live || job.provider!==live.provider)return {...job,delivery:'queued'};
  const receipt=read('work/queue.json');
  receipt.items.find(i=>i.id===job.task_id).input_delivery='pending';write('work/queue.json',receipt);
  const deliver=async()=>{
    const send=await live.ready;
    if(!send || live.controller.signal.aborted)return;
    const queued=read('work/queue.json').items;
    if(queued.find(i=>i.id===job.task_id)?.status!=='queued')return;
    const message=readState().sessions.find(s=>s.id===job.session_id).messages.find(m=>isRequest(m) && m.task_id===job.task_id);
    const snapshot=readState().sessions.find(s=>s.id===job.session_id);
    if(item.plan_node_id)await prefetchMemory(item,snapshot,live.provider);
    const framed=item.plan_node_id ? promptFor(item,snapshot,{me:live.provider,continuation:snapshot[continuationKey(live.provider)]}) : null;
    const text=framed ? framed.prompt : message.text+attachmentContext(message);
    try {await send(text,{model:item.model,effort:item.effort,mode:turnMode(item),...(framed ? {inputParts:framed.inputParts} : {})});}
    catch(error) {
      modifySession(job.session_id,s=>s.activity=[...(s.activity || []),{type:'delivery',detail:'追加未送入当前轮，已保留排队：'+error.message,task_id:job.task_id,at:new Date().toISOString()}].slice(-ACTIVITY_KEEP));
      return;
    }
    if(live.threadId)modifySession(job.session_id,s=>{
      const c=s[continuationKey(live.provider)];
      if(c?.threadId===live.threadId)c.seen=[...new Set([...c.seen,s.messages.findIndex(x=>x.task_id===message.task_id && isRequest(x))])];
    });
    mergeInput(live,message.task_id);passOnSpeakers(job.session_id,message.task_id,live);
  };
  const delivery=deliver().finally(()=>{
    const receipt=read('work/queue.json'),item=receipt.items.find(i=>i.id===job.task_id);
    if(item){delete item.input_delivery;write('work/queue.json',receipt);}
  });
  // Join deliveries for end-of-turn bookkeeping, without serialising their native writes.
  live.deliveries=Promise.all([live.deliveries,delivery]).catch(error=>console.error('追加消息记录失败：'+error.message));
  return {...job,delivery:'pending'};
}
export async function execute(taskId,runner=invokeNative) {
  const item=read('work/queue.json').items.find(i=>i.id===taskId),roundStartedAt=Date.now()-1000;
  const operation=item?.operation_id ? read('work/queue.json').items.find(i=>i.id===item.operation_id) : !item?.executor ? item : null;
  const submittedBefore=operation?.history?.length || 0;
  const session=readState({sessions:[]}).sessions.find(s=>s.task_ids.includes(taskId));
  if(!item || !session)throw new Error('未知 agent 任务');
  let goal=requestOf(session,item)?.text ?? item.goal;
  if(item.status!=='queued' || session.task_ids.some(id=>controllers.has(id)))return;
  if(!autonomousCanStart(item,read('work/queue.json').items))return;
  update({id:taskId,status:'active'},{executionOwner});
  const controller=new AbortController();controllers.set(taskId,controller);
  const directory=path.join(root,'.runtime/agent/runs',taskId);
  const followups=read('work/queue.json').items.filter(i=>i.merged_into===taskId && i.status==='active').map(i=>i.id);
  let response,speaker=item.executor || item.actor,answered=false,replyThreadId,responsePosted='',completed;
  try {
    // Preparing an operation belongs to its execution, not the shared dispatch.
    // A bad task prompt ends this task through the same completion path as any
    // other execution error; unrelated chats and steps keep running.
    if(operation) {
      const queue=read('work/queue.json');
      const owner=operation.parent_id && queue.items.find(i=>i.id===operation.parent_id);
      const returned=(item.after || []).map(id=>{
        const result=returnResult(id,queue.items),source=queue.items.find(i=>i.id===id);
        const handoff=result.outcome_handoff ?? (result.operation_id ? '' : result.handoff) ?? '';
        const explanation=result.handoff && result.handoff!==handoff ? '\n本轮说明：'+result.handoff : '';
        return `返回步骤：${source.title}（${id}）\n本轮结果状态：${result.outcome_status || result.status}\n${result.review_verdict ? '本版审查判定：'+result.review_verdict+'\n' : ''}已登记结果：${handoff}${explanation}\n数据/产出位置：\n${(result.outputs || []).join('\n')}`;
      });
      const inputs=[owner ? `所属操作：${owner.title}（${owner.id}）\n父操作目标：${owner.goal}\n父操作资料入口：\n${(owner.sources || []).join('\n')}\n父操作已有结果：${owner.handoff || ''}\n父操作成果位置：\n${(owner.outputs || []).join('\n')}` : '',
        operation.sources?.length ? '资料入口：\n'+operation.sources.join('\n') : '',...(operation.dependencies || []).filter(id=>id!==operation.review_target?.id).map(id=>{
        const p=queue.items.find(i=>i.id===id);
        return `前置步骤：${p.title}\n留言/结果：${p.handoff || ''}\n数据/产出位置：\n${p.outputs.length ? p.outputs.join('\n') : '（没有单独填写，位置在上面的留言里；先确认它真实存在再处理）'}`;
      })].filter(Boolean).join('\n\n');
      const context=String(taskPrompt(operation,inputs,logRequirementOf(operation)));
      const header=`本操作 ID：${operation.id}\n本次执行 ID：${item.id}\n`;
      const additions=[...returned,item.operation_id && item.goal ? '本次新增输入／方向：\n'+item.goal : ''].filter(Boolean).join('\n\n');
      goal=header+context+(additions ? '\n\n'+additions : '');
      const message={text:goal,operation_prompt:{id:operation.id,context_hash:createHash('sha256').update(context).digest('hex'),update_text:header+additions}};
      Object.assign(requestOf(session,item),message);
      modifySession(session.id,s=>{Object.assign(requestOf(s,item),message);});
    }
    const origins=replyChain(session,taskId);
    if(item.executor==='program') {
      const generated=exportWeek();
      update({id:taskId,outputs:[path.join(root,generated.files.plan),path.join(root,generated.files.review)]});
      response={result:`周计划和上周组会材料已按现有记录导出。\n周计划：${path.join(root,generated.files.plan)}\n组会材料：${path.join(root,generated.files.review)}`,toolCalls:0};
    } else {
      // One turn per AI the user named, then whoever a reply passes the turn to, at most MAX_TURNS in all. Only the last turn goes through the
      // result handling below; earlier ones are posted as plain talk. A turn that follows another is an ordinary work turn with the same permissions.
      const asked=item.speakers?.length ? item.speakers : [item.executor || item.actor];
      let waiting=asked.slice(1),previous=item.handoff_resume ? session.messages.findLast(m=>m.role==='assistant' && !m.interim && m.task_id===item.id)?.text || '' : '',
        turn=item.handoff_resume?.turn || 0,handed=false,defaultProvider=item.handoff_resume ? lastSpeaker(session) || asked[0] : asked[0];speaker=asked[0];
      for(;;) {
        // Admission can be withdrawn while another provider is still running.
        // Every colleague handoff is a new native execution, not the old admission.
        assertExecutionAllowed(taskId);
        const mode=turnMode(item);
        let ready;
        const live={taskId,provider:speaker,defaultProvider,sent:false,controller,followups,deliveries:Promise.resolve(),ready:new Promise(resolve=>{ready=resolve;})};
        if(mode==='work')liveTurns.set(session.id,live);
        try {
          const snapshot=readState().sessions.find(s=>s.id===session.id);
          const key=continuationKey(speaker);
          const pilot=mode==='work' && !!read('agent/config.json')[speaker+'_resume_sessions']?.some(id=>id==='*' || id===session.id);
          const turnDirectory=turn ? path.join(directory,String(turn+1)) : directory;
          const fileReport=path.join(turnDirectory,'file-changes.json');
          // Migrate the existing pilot baseline once; all work providers now share the same producer/lifecycle.
          const previousFiles=loadBaseline(snapshot.file_snapshots?.[speaker] || (speaker==='codex' ? snapshot.codex_continuation?.fileSnapshot : undefined));
          const fileNotice=mode==='work' ? prepareFileNotice(previousFiles,fileReport) : undefined;
          const promptOptions={me:speaker,turn,previous,handed,pilot,fileNotice,code:mode==='work' ? runtimeCodeStatus() : undefined};
          if(item.mode!=='card')await prefetchMemory(item,snapshot,speaker,previous);
          const [full,fullFragments]=traceFragments(()=>promptFor(item,snapshot,promptOptions),{sources:mode==='work'}),continuation=pilot ? snapshot[key] || {} : undefined;
          const [delta,deltaFragments]=pilot ? traceFragments(()=>promptFor(item,snapshot,{...promptOptions,continuation}),{sources:mode==='work'}) : [null,[]];
          const memory=delta?.memory || full.memory;
          if(mode==='work') {
            fs.mkdirSync(turnDirectory,{recursive:true});
            fs.writeFileSync(fileReport,JSON.stringify({...fileNotice.report,assistant:speaker,code:promptOptions.code})+'\n');
            const cfg=read('agent/config.json');
            fs.writeFileSync(path.join(turnDirectory,'memory-context.json'),JSON.stringify({owner:speaker,task_id:taskId,session_id:session.id,turn:turn+1,
              version:memoryVersion,enabled:!!memory?.text,ids:memory.ids,cue_ids:memory.cue_ids,recalled_ids:memory.recalled_ids,
              estimated_tokens:memory.estimated_tokens,omitted:memory.omitted,
              prompt_estimated_tokens:tokenEstimate(full.prompt),resume_prompt_estimated_tokens:delta ? tokenEstimate(delta.prompt) : null,
              native_memory:memory.text ? 'disabled-by-office' : 'not-overridden',
              model:item.model || cfg[speaker+'_model'],effort:item.effort || cfg[speaker+'_reasoning_effort'] || cfg.reasoning_effort,
              mode,pilot,context_hash:full.contextHash,
              fresh:turn===0&&!snapshot.messages.some(m=>m.task_id!==taskId)})+'\n');
          }
          // What this turn's agent was given: prompt hashes and the prompts/fragments used (the rest of the prompt is data, memory text and code-side wording).
          const manifest=(prompt,resume)=>({task_id:taskId,turn:turn+1,speaker,prompt_chars:prompt.length,prompt_sha256:createHash('sha256').update(prompt).digest('hex'),fragments:fullFragments,sources:full.sources,input_parts:full.inputParts.map(({kind,text})=>({kind,chars:text.length})),...(resume ? {resume_prompt_chars:resume.length,resume_prompt_sha256:createHash('sha256').update(resume).digest('hex'),resume_fragments:deltaFragments,resume_sources:delta.sources,resume_input_parts:delta.inputParts.map(({kind,text})=>({kind,chars:text.length}))} : {})});
          if(mode==='work')fs.writeFileSync(path.join(turnDirectory,'prompt-manifest.json'),JSON.stringify(manifest(full.prompt,delta?.prompt))+'\n');
          replyThreadId=undefined;
          response=await runner(speaker,full.prompt,{directory:turnDirectory,signal:controller.signal,purpose:purposeOf(item,session),workdir:workingFolder(session.workdir,root),
            inputParts:full.inputParts,
            beforeSubmit:()=>{
              assertExecutionAllowed(taskId);
              if((turn>0 || item.handoff_resume) && queuedUserInput(readState().sessions.find(s=>s.id===session.id),read('work/queue.json').items)){
                const error=new Error('用户新消息先处理，交接输入尚未发送');error.code='USER_INPUT_PRIORITY';throw error;
              }
              live.sent=true;defaultProvider=speaker;
            },
            // The native provider owns fresh-vs-resume: a fresh thread is sent the full prompt, a resumed one only the delta.
            ...(pilot ? {continuation,resumePrompt:delta.prompt,resumeInputParts:delta.inputParts,onContinuation:(state,info)=>{
              modifySession(session.id,s=>{
                if(info.phase==='turn') {
                  // One entry per native turn, so an edit can later cut the thread exactly before the first turn it removes (ref: Codex turn id / Claude prompt uuid).
                  if(s[key]?.threadId===state.threadId && s[key].turns)s[key].turns.push({task_id:taskId,ref:info.ref});
                  return;
                }
                if(info.phase==='start') {
                  live.threadId=replyThreadId=state.threadId;
                  // A continuation made before turns were recorded stays untracked (undefined): a partial list would hide the turns it never saw.
                  const turns=info.resumed ? s[key]?.turns && closeTurns(s[key]) : [];
                  s[key]={...s[key],...state,turns,seen:[...new Set([...(info.resumed ? s[key]?.seen || [] : []),...(info.resumed ? delta.seen : full.seen)])],contextHash:full.contextHash,executionContextHash:full.executionContextHash,projectSourceHash:full.projectSourceHash,focusHash:full.focusHash,memoryIds:[...new Set([...(info.resumed ? s[key]?.memoryIds || [] : []),...memory.ids])]};
                  delete s[key].forkAt;delete s[key].forkBefore; // the fork (if any) happened in this turn; state.threadId is the new thread
                  s.activity=[...(s.activity || []),{type:'continuation',name:`${speaker==='codex' ? 'Codex' : 'Claude'} ${info.resumed ? '恢复' : '新建'}原生 ${speaker==='codex' ? 'thread' : '会话'}`,detail:state.threadId,task_id:taskId,at:new Date().toISOString()}].slice(-ACTIVITY_KEEP);
                } else if(s[key]?.threadId===state.threadId)s[key].total=state.total;
              });
            }} : {}),
            onSubmitted:()=>{
              live.sent=true;defaultProvider=speaker;
              if(!fileNotice)return;
              modifySession(session.id,s=>{
                s.file_snapshots={...s.file_snapshots,[speaker]:saveBaseline(fileNotice.snapshot)};
                if(speaker==='codex' && s.codex_continuation)delete s.codex_continuation.fileSnapshot;
              });
            },
            onReady:send=>{if(send){live.sent=true;defaultProvider=speaker;}ready(send);},
            ...(mode==='work' ? {onQuestion:items=>askUser(session.id,taskId,speaker,items,controller.signal)} : {}),
            model:item.model,mode,effort:item.effort || (mode==='ask' ? undefined : read('agent/config.json')[speaker+'_reasoning_effort'] || read('agent/config.json').reasoning_effort),onEvent:event=>{
            // Main-agent midway @ messages use the same handoff chain as final
            // replies. Register now; the colleague starts after this native call.
            if(event.type==='text'){
              const next=mode==='work' && !event.sub && !controller.signal.aborted && turn+waiting.length+1<MAX_TURNS ? summoned(event.text,speaker,waiting) : null;
              appendReply(session.id,{role:'assistant',text:event.text,provider:speaker,interim:true,...(next ? {handoff_to:next} : {}),...(event.sub ? {subagent:true,...(event.parent ? {agent_call:event.parent} : {})} : {}),at:new Date().toISOString(),task_id:taskId},live.threadId,true);
              if(next)waiting.push(next);
              return;
            }
            if(event.type==='context'){
              // Live context length per speaker: kept on the session, not in the activity list.
              const at=new Date().toISOString(); // stamped when it happened, not when the batch is saved
              modifySession(session.id,s=>{const {type,...rest}=event;s.context={...s.context,[speaker]:{...s.context?.[speaker],...rest,at}};},{defer:true});return;
            }
            const at=new Date().toISOString();
            modifySession(session.id,s=>{
              s.activity ||= [];
              if(event.type==='subagent_call') {
                const runs=(s.subagent_runs ||= []),run=runs.findLast(r=>r.id===event.tool_id && r.task_id===taskId && r.provider===speaker);
                const info={title:event.title,prompt:event.prompt,kind:event.kind};
                if(run)Object.assign(run,info);
                else runs.push({id:event.tool_id,task_id:taskId,provider:speaker,...info,status:'running',at});
                return;
              }
              if(event.type==='subagent_result') {
                const run=(s.subagent_runs || []).findLast(r=>r.id===event.tool_id && r.task_id===taskId);
                if(run){
                  if(event.text!==undefined)run.text=event.text;
                  if(event.status){run.status=event.status;if(event.status==='running')delete run.finished_at;else run.finished_at=at;}
                }
                return;
              }
              if(event.type==='subagent') {
                const agent=s.activity.findLast(e=>e.type==='subagent' && e.task_id===taskId && e.provider===speaker && e.agent_id===event.agent_id);
                if(agent)Object.assign(agent,{status:event.status,updated_at:at});
                else s.activity.push({...event,provider:speaker,at,task_id:taskId});
              } else if(['tool_end','tool_progress'].includes(event.type)) {
                const tool=s.activity.findLast(e=>e.type==='tool' && e.task_id===taskId && e.provider===speaker && event.tool_id && e.tool_id===event.tool_id);
                if(!tool || tool.status!=='running')return;
                if(event.type==='tool_end')Object.assign(tool,{status:event.status,finished_at:at});
                else Object.assign(tool,{heartbeat_at:event.heartbeat ? at : tool.heartbeat_at,elapsed_seconds:event.elapsed_seconds});
              } else s.activity.push({...event,...(event.type==='tool' ? {status:'running'} : {}),provider:speaker,at,task_id:taskId});
              // Heartbeats update the original call, rather than evicting its start.
              s.activity=s.activity.filter((e,i,all)=>i>=all.length-ACTIVITY_KEEP || ['tool','subagent'].includes(e.type) && e.status==='running');
            },{defer:true});
          }});
          completed={speaker,threadId:replyThreadId};responsePosted='';
          // What fills the context now, from the native transcript (the live token count above only knows the total). No transcript or no usable figures: no breakdown.
          if(mode==='work' && response.sessionId) {
            let breakdown=null;try {breakdown=speaker==='deepseek' ? response.contextBreakdown : contextBreakdown(speaker,response.sessionId);} catch { /* an unreadable transcript just has no breakdown */ }
            modifySession(session.id,s=>{
              const c={...s.context?.[speaker]};
              if(breakdown){c.tokens=breakdown.total;c.parts=breakdown.parts;c.parts_at=new Date().toISOString();}else{delete c.parts;delete c.parts_at;}
              s.context={...s.context,[speaker]:c};
            });
          }
        } catch(error) {
          if(error.code!=='USER_INPUT_PRIORITY')throw error;
          if(!response){update({id:taskId,status:'queued'});return;}
          deferHandoff(session,item,[speaker,...waiting],turn,response,completed,responsePosted);
          return response;
        } finally {
          ready(null);
          for(const waiting of [...waitingQuestions.values()])if(waiting.taskId===taskId)waiting.cancel(); // a question left open when the native turn ended can no longer be answered
          // A stopped/finished native turn is not evidence of a tool return.
          // Do not keep its unconfirmed calls in the live-retention set forever.
          modifySession(session.id,s=>{for(const e of s.activity || [])if(e.task_id===taskId && e.provider===live.provider && e.status==='running')e.status='unknown';});
          await live.deliveries;
        }
        if(read('work/queue.json').items.find(i=>i.id===taskId)?.status==='open') {
          appendReply(session.id,{role:'assistant',text:parseHandoff(response.result).text,provider:speaker,at:new Date().toISOString(),task_id:taskId},replyThreadId);
          throw openExecutionError();
        }
        const open=item.mode!=='card' && turn+1<MAX_TURNS;
        const replyNext=open && turn+waiting.length+1<MAX_TURNS ? summoned(response.result,speaker,waiting) : null;
        if(replyNext)waiting.push(replyNext);
        if(open && waiting.length && queuedUserInput(readState().sessions.find(s=>s.id===session.id),read('work/queue.json').items)){
          deferHandoff(session,item,waiting,turn+1,response,completed,responsePosted);return response;
        }
        const next=open ? waiting.shift() : null;
        if(!next)break;
        handed=next===replyNext;
        previous=parseHandoff(response.result).text;const spoke=speaker;
        appendReply(session.id,{role:'assistant',text:previous,provider:spoke,at:new Date().toISOString(),task_id:taskId},replyThreadId);
        responsePosted=previous;
        speaker=next;turn++;
      }
    }
    if(item.handoff_resume){
      const queue=read('work/queue.json'),finished=queue.items.find(i=>i.id===taskId),route=finished.handoff_resume.original_route;
      for(const key of ['executor','speakers'])if(route[key]===undefined)delete finished[key];else finished[key]=route[key];
      delete finished.handoff_resume;write('work/queue.json',queue);
    }
    let result=response.result,brief=null;
    if(item.mode==='card') {
      let card=null;try {card=normalizeCard(extractJSON(result));} catch { /* A reply that is not a card falls back to the plain handoff below. */ }
      if(card){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'inbox.json'),JSON.stringify(card,null,2));result=card.message;}
    }
    // Delivery is a submitted work record, never prose paths or file-write events.
    const latest=read('work/queue.json').items.find(i=>i.id===taskId);
    const business=operation ? read('work/queue.json').items.find(i=>i.id===operation.id) : latest;
    const outputs=business.outputs || [];
    const submitted=operation && business.status==='done' && (business.history || []).slice(submittedBefore).some(h=>h.to==='done');
    const outcome=operation ? submitted ? 'done' : ['active','done'].includes(business.status) ? 'open' : business.status : latest.status==='active' ? 'done' : latest.status;
    const outcomeRecorded=operation && (business.history || []).slice(submittedBefore).some(h=>h.to===outcome);
    const incomplete=outcome==='waiting_user';
    const card=normalizeCard(readCard('work',taskId)) || {};
    const review=card.actions?.length ? {kind:card.kind,state:'pending',...(item.operation_id ? {run_id:item.id} : {})} : undefined;
    if(item.mode!=='card'){const parsed=parseHandoff(result);result=parsed.text;brief=parsed.brief;}
    // Free follow-ups have no origin line in their user's text. Preserve the unambiguous
    // chain we actually supplied to this turn before its new card can become a false sibling.
    const originGoal=card.origin && origins.includes(card.origin) && !cardOrigin(item.goal) ? `原事项：${card.origin}\n${item.goal}` : null;
    update({id:business.id,...(outcome!==business.status ? {status:outcome} : {}),
      handoff:operation ? business.handoff || result : result,...(originGoal && !operation ? {goal:originGoal} : {}),...(brief ? {brief} : {}),
      outputs,session_id:response.sessionId || '',...((review || business.review?.state==='pending') ? {review:review || {}} : {}),
      ...(operation && outcome==='open' ? {reason:'上一轮已结束，未提交完成'} : {})});
    if(operation)saveOperationTurn(operation,item,{status:'done',outcome_status:outcome,outcome_handoff:outcomeRecorded ? business.handoff : undefined,handoff:result,outputs,session_id:session.id,started:roundStartedAt});
    for(const id of followups)update({id,status:'done',handoff:result,outputs:[],session_id:response.sessionId || ''});
    // A card reply whose own card says the matter is settled closes the card it answered (and the card that one came from).
    // An already-settled ancestor is an idempotent no-op, not a reason to strand an open parent. No other branch of the conversation is closed.
    if(!incomplete && card.resolved===true)for(const id of origins)try {resolveInbox(id);} catch(e) {console.error(e.message);break;}
    // A free-text follow-up ("可以发") that answers a still-pending approval card withdraws that question even though the matter stays open and no
    // new card is raised. A button reply already hides its card; the matter's own mail card is left alone.
    else if(!incomplete && !review && origins[0]?.startsWith('work:') && !session.messages.find(m=>m.role==='user' && m.task_id===taskId)?.inbox_reply
      && read('work/queue.json').items.find(w=>w.id===origins[0].slice(5))?.review?.kind==='approval')try {resolveInbox(origins[0]);} catch(e) {console.error(e.message);}
    for(const id of item.project_ids)try {renderStatus(id);} catch(e) {console.error(e.message);}
    if(responsePosted!==result)appendReply(session.id,{role:'assistant',text:result,at:new Date().toISOString(),task_id:taskId,provider:speaker},replyThreadId);
    answered=true;
    try {sendReceipt(session.id,taskId,result,speaker,runner);} catch(e) {console.error('回执：'+e.message);}
  } catch(error) {
    const paused=read('work/queue.json').items.find(i=>i.id===taskId)?.status==='open';
    if(!paused)update({id:taskId,status:controller.signal.aborted ? 'cancelled' : 'failed',handoff:error.message,reason:error.message});
    if(operation)saveOperationTurn(operation,item,{status:paused || controller.signal.aborted ? 'cancelled' : 'failed',outcome_status:paused ? 'open' : 'failed',handoff:error.message,outputs:[],session_id:session.id,started:roundStartedAt});
    for(const id of followups)update({id,status:controller.signal.aborted ? 'cancelled' : 'failed',handoff:error.message,reason:error.message});
    modifySession(session.id,s=>s.messages.push({role:'error',text:error.message,at:new Date().toISOString(),task_id:taskId}));
  } finally {
    if(liveTurns.get(session.id)?.taskId===taskId)liveTurns.delete(session.id);
    controllers.delete(taskId);
  }
  if(answered && item.mode!=='card')await titleSession(session.id,runner);
  return response;
}
// One target, one provenance chain. A free follow-up can use an unambiguous open chain, but sharing a conversation is not sharing a matter.
function replyChain(session,taskId) {
  const work=read('work/queue.json').items,request=session.messages.find(m=>m.role==='user' && m.task_id===taskId);
  const explicit=request?.inbox_reply?.id || cardOrigin(request?.text);
  if(explicit)return cardChain(explicit,work);
  const prior=session.task_ids.slice(0,Math.max(session.task_ids.indexOf(taskId),0));
  const pending=prior.filter(id=>work.find(w=>w.id===id)?.review?.state==='pending' && readCard('work',id).message).map(id=>'work:'+id);
  const asked=askedCard(session,taskId);
  const candidates=[...new Set([...pending,...(asked ? [asked] : [])])].map(id=>cardChain(id,work));
  const leaves=candidates.filter(chain=>!candidates.some(other=>other!==chain && other.slice(1).includes(chain[0])));
  return leaves.length===1 ? leaves[0] : [];
}
// Conversations are independent. The active task controller owns the session's
// exclusion, so overlapping HTTP/clock drains cannot start duplicate turns.
// Call only after this backend has acquired its listening port. Recover only known dead backend owners;
// other CLI executors, live/reused PIDs, legacy/unknown owners and user experiment tasks are left alone.
export function recoverInterruptedWork() {
  const queue=read('work/queue.json'),dead=new Map();
  const lost=queue.items.filter(i=>{
    const owner=i.execution_owner;
    if(i.status!=='active' || owner?.host!=='dashboard' || !Number.isInteger(owner.pid) || owner.pid<=0 || owner.pid===process.pid)return false;
    if(!dead.has(owner.pid)) {
      try {process.kill(owner.pid,0);dead.set(owner.pid,false);}
      catch(e) {dead.set(owner.pid,e.code==='ESRCH');} // Permission/unknown errors must not mean dead.
    }
    return dead.get(owner.pid);
  });
  const message='执行进程已退出，本轮结果不完整／未知；任务已标为中断失败，保留消息和文件，不自动重跑。';
  for(const i of lost)update({id:i.id,status:'failed',reason:message,handoff:message});
  const roots=new Set(lost.map(i=>i.merged_into || i.id));
  for(const s of readState({sessions:[]}).sessions)for(const id of roots)if(s.task_ids.includes(id))modifySession(s.id,session=>{
    session.messages.push({role:'error',text:message,task_id:id,at:new Date().toISOString()});
  });
  return lost.map(i=>i.id);
}
export async function drain(runner=invokeNative) {
  // Reuse the existing dispatch beat, including changes written by another CLI.
  // No extra timer or model call; an open operation cannot retain a live runner.
  // Both whole stores (queue+turns, sessions) are ~10 MB each and this runs on every 10 s beat inside the dashboard process, so each synchronous
  // stretch below shares one parse per file (sharedReads; a write inside it drops the cached copy). Nothing awaits inside a stretch.
  const beat=sharedReads(()=>{
    const current=read('work/queue.json').items;
    for(const [id,controller] of controllers)if(current.find(i=>i.id===id)?.status==='open' && !controller.signal.aborted)controller.abort(openExecutionError());
    if(!read('agent/config.json').enabled)return null;
    try {planProgress();} catch(error) {console.error('自主规划：'+error.message);}
    startReadyWork();
    const sessions=readState({sessions:[]}).sessions;
    // Historical conversations cannot dispatch anything. Avoid rereading both whole
    // stores once per old session on every background beat (and every chat receipt).
    // Include blocked queued work: another session may finish its dependency here.
    const queued=new Set(read('work/queue.json').items.filter(i=>i.status==='queued').map(i=>i.id));
    return sessions.filter(s=>s.task_ids.some(id=>queued.has(id))).map(s=>s.id);
  });
  if(!beat)return;
  await Promise.all(beat.map(async id=>{
    while(read('agent/config.json').enabled) {
      const itemId=sharedReads(()=>{
        const session=readState({sessions:[]}).sessions.find(s=>s.id===id);
        if(!session || session.task_ids.some(taskId=>controllers.has(taskId)))return null;
        const queue=read('work/queue.json');
        const item=queuedUserInput(session,queue.items) || queue.items.find(i=>readiness(i,queue.items).ready && session.task_ids.includes(i.id) && autonomousCanStart(i,queue.items));
        if(!item || controllers.size>=(read('agent/config.json').max_active_agents ?? 10))return null; // at the cap the task stays queued; the next drain picks it up
        return item.id;
      });
      if(!itemId)return;
      await execute(itemId,runner);
    }
  }));
}
export function stop(taskId) {
  const merged=read('work/queue.json').items.find(i=>i.id===taskId)?.merged_into;
  if(merged && controllers.has(merged)){controllers.get(merged).abort();return;}
  if(controllers.has(taskId)){controllers.get(taskId).abort();return;}
  const item=read('work/queue.json').items.find(i=>i.id===taskId);
  if(item?.status==='queued')update({id:taskId,status:'cancelled',handoff:'用户取消'});
}
// The command line prints a digest by default: the full snapshot holds every message of every conversation (megabytes). `status full` prints it all;
// the workbench reads agentSnapshot() directly. One conversation's text: `show`; a keyword: `search`.
export function statusDigest(limit=8) {
  const {config,sessions}=agentSnapshot(),last=s=>s.messages.at(-1)?.at || s.created_at,queue={},active_tasks=[];
  // Not active_turns: that lives in the memory of the server process and is always [] when read from this command line.
  // The queue is the shared record; actor 'user' means the user's own task, not a running assistant.
  for(const i of read('work/queue.json').items) {
    queue[i.status]=(queue[i.status] || 0)+1;
    if(i.status==='active' && i.actor!=='user')active_tasks.push({task:i.id.slice(0,8),executor:i.executor || i.actor,session:i.session_id?.slice(0,8),title:i.title,updated_at:i.updated_at});
  }
  return {config,queue,active_tasks,session_count:sessions.length,
    recent_sessions:[...sessions].sort((a,b)=>last(b).localeCompare(last(a))).slice(0,limit).map(s=>({id:s.id.slice(0,8),title:s.title,messages:s.messages.length,last_at:last(s)})),
    note:'摘要；active_tasks 取自任务队列（正在跑的助手任务，updated_at 很久不动再怀疑卡住）；读某段对话用 agent show <会话id前缀>[#任务id前缀]，按词找用 agent search，全量快照用 agent status full（数 MB，先想清楚要查什么）。'};
}
export async function run(action,argument) {
  if(action==='status')console.log(JSON.stringify(argument==='full' ? agentSnapshot() : statusDigest()));
  else if(action==='handoff') {
    const request={...input(argument),handoff:handoffCaller()};
    const port=Number(process.env.PHD_DASHBOARD_PORT || 8787);
    const response=await fetch(`http://127.0.0.1:${port}/api/chat/handoff`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
    if(response.status===404)throw new Error('后端尚未加载助手交接入口；等任务结束后重载后端再交接，不以用户身份代发');
    const result=await response.json();if(!response.ok)throw new Error(result.error || '交接创建失败');
    if(!result.session?.messages?.some(m=>m.role==='handoff' && m.task_id===result.task_id))throw new Error('后端未加载助手交接入口，不能以用户身份创建；请等任务结束后重载后端');
    console.log(JSON.stringify({session_id:result.session_id,task_id:result.task_id,provider:result.provider,handoff:request.handoff}));
  }
  else if(action==='work')await drain();
  else if(action==='search')console.log(searchSessions(argument));
  else if(action==='show')console.log(showSession(argument));
  else if(action==='calls')console.log(callsReport(argument));
  else if(action==='title') {
    // No id: every chat still carrying its draft title. With an id: name that conversation again, whatever its title is now.
    const ids=argument ? [argument] : readState({sessions:[]}).sessions.filter(draftTitle).map(s=>s.id);
    for(const id of ids)console.log(id,'→',await titleSession(id,invokeNative,{force:!!argument}) || '（未改）');
  } else if(action==='ask') {
    const job=submit({text:argument});await drain();console.log(JSON.stringify(job));
  } else throw new Error('agent status|work|ask <text>|search <词>|show <会话>[#任务]|calls <任务id前缀>[#序号[:full]]|title [会话id]');
}
