import fs from 'node:fs';
import os from 'node:os';
import {toolSummary} from './tool-summary.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { root,read } from '../automation/files.mjs';
import { recordRun, refreshCodexQuota } from '../usage/run.mjs';
import { SYSTEM_PROMPT, STOP_MESSAGE, EMPTY_MESSAGE, stopProcess, nativeTextInput } from './native.mjs';
import {memoryEnabled} from '../memory2/owner.mjs';
import {runRelative} from '../memory2/telemetry.mjs';
import {overloadResumePrompt} from '../prompts/templates.mjs';

// Explicitly requested recovery of chat work only; never replay a failed request or retry an ambiguous RPC.
const OVERLOAD_DELAYS=[60000,180000];

// CAD tools live in their own folders, each with a .codex/config.toml that enables only that tool; at the project root they are all off.
// A request naming one tool runs Codex in that folder, with the project root kept writable so deliverables still land beside the project's files.
// Naming several tools: Codex starts in one folder and the other tools' servers are switched on from the command line (a plugin cannot be, which is
// why Fusion's folder is preferred as the home). A missing folder falls back to the project root with the servers switched on explicitly.
const CAD_TOOLS=[['autocad',/autocad/i,'autocad-mcp'],['fusion',/fusion/i,'fusion'],['altium',/altium/i,'altium']];
// A program-run, text-in/text-out ask (memory extraction, recall decisions) needs none of the office's files or tools. Started in an empty folder
// with plugins, MCP servers and built-in tools switched off, a call's fixed input drops from ~15.8k to ~6.2k tokens (measured on a two-word prompt, Codex 0.164).
// Server names are read from the user's Codex config so a newly added server is switched off too.
const LEAN_FEATURES=['plugins','multi_agent','image_generation','browser_use','browser_use_external','in_app_browser','computer_use','view_image','goals','skill_search','tool_suggest','shell_tool','unified_exec','sleep_tool','hooks','shell_snapshot'];
export function leanLaunch({home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),tmp=os.tmpdir()}={}) {
  let servers=[];try {servers=[...fs.readFileSync(path.join(home,'config.toml'),'utf8').matchAll(/^\[mcp_servers\.("[^"]+"|[^.\]\s]+)\]\s*$/gm)].map(m=>m[1]);} catch { /* no user config: nothing to switch off */ }
  const cwd=path.join(tmp,'office-llm-lean');fs.mkdirSync(cwd,{recursive:true});
  return {cwd,extraOverrides:[...LEAN_FEATURES.map(f=>`features.${f}=false`),...[...new Set(servers)].map(n=>`mcp_servers.${n}.enabled=false`),'web_search="disabled"','include_apply_patch_tool=false']};
}

export function codexLaunch(request,{apps=read('software/catalog.json').apps,exists=fs.existsSync,mode='work',purpose='chat',workdir}={}) {
  // Parsed asks may quote mail or documents naming CAD software. Those names are
  // evidence, not a request to switch working directory or start extra servers.
  const named=mode==='work' ? CAD_TOOLS.filter(([,re])=>re.test(request)) : [],projectRoot=root.replace(/\\/g,'/').replace(/\/$/,'');
  const overrides=['features.apps=false'];
  // Native enforcement, not just a prompt. Each invocation has its own app-server;
  // the override also changes continuationSignature so a saved limit cannot reuse stale settings.
  // https://learn.chatgpt.com/docs/config-file/config-reference (agents.max_concurrent_threads_per_session)
  if(mode==='work') {
    const limit=read('agent/config.json').subagent_max_concurrency ?? 10;
    if(!Number.isInteger(limit) || limit<1 || limit>10)throw new Error('Codex 子 agent 并发上限应为 1～10 的整数');
    overrides.push(`agents.max_concurrent_threads_per_session=${limit}`);
    // User-authorized office work networking; retain workspace-write and normal approvals.
    if(['chat','card'].includes(purpose))overrides.push('sandbox_workspace_write.network_access=true');
  }
  if(memoryEnabled('codex'))overrides.push('features.memories=false');
  // Only interactive work gets desktop control; parsed/read-only asks must not operate the real desktop.
  // Codex validates transports even when disabled: never create an enabled-only MCP entry.
  const computer=read('software/computer-use/mcp.json').mcpServers['windows-mcp'];
  overrides.push(`mcp_servers.windows-mcp.enabled=${mode==='work'}`);
  for(const key of ['command','args'])overrides.push(`mcp_servers.windows-mcp.${key}=${JSON.stringify(computer[key])}`);
  for(const [key,value] of Object.entries(computer.env))overrides.push(`mcp_servers.windows-mcp.env.${key}=${JSON.stringify(value)}`);
  // request_user_input (the agent's own questions) exists only in Plan mode unless this experimental flag is on; the server request is answered in invokeCodex.
  if(mode==='work')overrides.push('features.default_mode_request_user_input=true');
  const serverOn=tools=>tools.map(([,,server])=>`mcp_servers.${server}.enabled=true`);
  // The folder the user opened the terminal front end in is writable like the office root (Codex itself still starts in the root).
  const extra=mode==='work' && workdir ? [String(workdir).replace(/\\/g,'/')] : [];
  const writable=list=>`sandbox_workspace_write.writable_roots=${JSON.stringify([...list,...extra])}`;
  if(!named.length)return {cwd:root,overrides:extra.length ? [...overrides,writable([projectRoot])] : overrides};
  const home=named.find(([id])=>id==='fusion') || named[0],others=named.filter(t=>t!==home);
  const folder=apps.find(a=>a.id===home[0])?.working_directory;
  if(folder && exists(folder)) {
    const roots=[projectRoot,...others.map(([id])=>apps.find(a=>a.id===id)?.working_directory).filter(Boolean).map(d=>d.replace(/\\/g,'/'))];
    return {cwd:folder,overrides:[...overrides,writable(roots),...serverOn(others)]};
  }
  return {cwd:root,overrides:[...overrides,...(extra.length ? [writable([projectRoot])] : []),...serverOn(named)]};
}

// Codex compacts its own context inside a turn (lossy, otherwise invisible); show it in the session activity. The dashboard prints `name`.
export function compactionEvent(e) {
  if(e?.params?.item?.type!=='contextCompaction' || !['item/started','item/completed'].includes(e.method))return null;
  return {type:'compact',name:e.method==='item/started' ? 'Codex 正在压缩上下文' : 'Codex 已压缩上下文',detail:'Codex 原生压缩，本轮运行上下文被有损缩短；Workbench 会话原文不受影响'};
}

export const usageDelta=(total,baseline={})=>Object.fromEntries(Object.entries(total).map(([key,value])=>[key,Math.max(0,value-(baseline[key] || 0))]));
export const codexUsageFields=usage=>({input_tokens:usage.inputTokens ?? null,cached_input_tokens:usage.cachedInputTokens ?? null,output_tokens:usage.outputTokens ?? null});
export const continuationSignature=(launch,model,effort,baseInstructions=SYSTEM_PROMPT)=>createHash('sha256').update(JSON.stringify({launch,model,effort,baseInstructions})).digest('hex');

// The only fallback is before turn/start is sent. A rejected/timed-out model turn is never replayed.
export async function startCodexTurn(rpc,{params,signature,continuation,prompt,resumePrompt,inputParts,resumeInputParts,onThread=()=>{},beforeSubmit=()=>{},onSubmitted=()=>{},signal}) {
  let thread,resumed=false,fallbackReason;
  const check=t=>{if(params.sandbox==='workspace-write' && t.sandbox?.type!=='workspaceWrite')throw new Error('Codex 未获得任务工作目录的写入权限；尚未调用模型');};
  if(continuation?.threadId && continuation.signature===signature) {
    // Edit-and-regenerate: fork a copy of the thread without the edited turn and everything after it; the original thread is left untouched.
    try {thread=await (continuation.forkBefore ? rpc('thread/fork',{...params,threadId:continuation.threadId,beforeTurnId:continuation.forkBefore,ephemeral:false,excludeTurns:true})
      : rpc('thread/resume',{...params,threadId:continuation.threadId,excludeTurns:true}));check(thread);resumed=true;}
    catch(error) {if(signal?.aborted)throw error;fallbackReason=error.message;}
  }
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  if(!resumed){thread=await rpc('thread/start',{...params,ephemeral:!continuation});check(thread);}
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  const text=resumed ? resumePrompt : prompt;
  const input=nativeTextInput(text,resumed ? resumeInputParts : inputParts);
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  // Persist identity before submission; shared file baselines advance separately on acknowledgment.
  beforeSubmit();
  onThread({threadId:thread.thread.id,signature,total:resumed ? continuation.total || {} : {}},{resumed,text,thread,fallbackReason});
  const turn=await rpc('turn/start',{threadId:thread.thread.id,input});
  onSubmitted();
  return {thread,turn,resumed};
}

// item/tool/requestUserInput -> the workbench's generic questions. A secret question is declined here: the answer would be stored in the conversation.
export const codexQuestions=params=>(params.questions || []).map(q=>({id:q.id,header:q.header || '',question:q.question,
  options:(q.options || []).map(o=>({label:o.label,description:o.description || ''})),multi:false,other:q.isOther !== false || !q.options?.length}));

export async function invokeCodex(prompt,{mode='work',effort,systemPrompt=SYSTEM_PROMPT,model:requested,onEvent=()=>{},onReady=()=>{},beforeSubmit=()=>{},onSubmitted=()=>{},onQuestion,directory,signal,purpose,maxOutputChars,continuation,resumePrompt,inputParts,resumeInputParts,onContinuation=()=>{},workdir,cwd:forcedCwd,extraOverrides=[]}={}) {
  const cfg=read('agent/config.json');const started=Date.now();
  const bin=path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js');
  const request=inputParts?.find(p=>p.kind==='current_request')?.text ?? prompt.split('当前请求：').at(-1),launch0=codexLaunch(request,{mode,purpose,workdir}),launch=forcedCwd ? {...launch0,cwd:forcedCwd} : launch0; // forcedCwd: a program-run ask that needs no office files starts elsewhere, so Codex does not load the office AGENTS.md and skills
  const nativeArgs=[bin,'app-server','--listen','stdio://'];
  for(const override of [...launch.overrides,...extraOverrides])nativeArgs.push('-c',override);
  const child=spawn(process.execPath,nativeArgs,
    {cwd:launch.cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,OFFICE_MEMORY_OWNER:'codex',OFFICE_MEMORY_RUN_DIR:directory}});
  let errTail='';child.stderr.on('data',d=>{errTail=(errTail+d).slice(-2000);});child.stdin.on('error',()=>{}); // keep a bounded tail so a crash is diagnosable
  if(mode!=='work')continuation=undefined;
  let seq=0,result='',held='',usage={},model='Codex',sessionId=null,toolCalls=0,finish,finished=false,total={},baseline={},nativeState=null,turnId=null;
  let overloadAttempts=0,retryTimer=null;
  const childCards=new Map();
  const childCard=(id,title)=>{
    if(childCards.has(id) && (!title || childCards.get(id)===title))return;
    const label=title || id.slice(0,8);childCards.set(id,label);
    // Native activity supplies a path, not the delegated prompt. Do not invent it.
    onEvent({type:'subagent_call',tool_id:id,title:label,prompt:'',kind:'native'});
  };
  const trackedTurns=new Set();
  const trackTurn=id=>{
    if(trackedTurns.has(id))return;
    turnId=id;
    trackedTurns.add(id);
    if(nativeState)onContinuation({threadId:sessionId},{phase:'turn',ref:id});
  };
  const pending=new Map(),artifacts=[];
  const outputSizes=new Map();let outputChars=0;
  const boundedOutput=Number.isSafeInteger(maxOutputChars) && maxOutputChars>0;
  const completion=new Promise((resolve,reject)=>{finish=(error)=>{
    if(finished)return;finished=true;signal?.removeEventListener('abort',abort);
    clearTimeout(retryTimer);
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(error || new Error('任务会话已结束'));}pending.clear();
    if(nativeState)onContinuation({...nativeState,total:Object.keys(total).length ? total : baseline},{phase:'finish'});
    if(error?.code!=='USER_INPUT_PRIORITY')recordRun({id:path.basename(directory),run_dir:runRelative(directory),provider:'codex',model,feature:'agent',purpose,session_id:sessionId,status:error ? 'failed' : 'completed',usage_known:Object.keys(usage).length>0,
      ...codexUsageFields(usage),tool_calls:toolCalls,duration_ms:Date.now()-started});
    child.stdin.end();
    stopProcess(child);
    error ? reject(error) : resolve({result,usage,model,sessionId,toolCalls,artifacts,duration_ms:Date.now()-started});
  };});
  const abort=()=>finish(signal?.reason instanceof Error && signal.reason.name==='Error' ? signal.reason : new Error(STOP_MESSAGE));
  child.on('error',e=>finish(e));child.on('exit',code=>{if(finished)return;const tail=errTail.trim();if(tail)try{fs.writeFileSync(path.join(directory,'stderr.txt'),tail+'\n');}catch{}
    finish(new Error(`Codex 会话退出 (${code})`+(tail?`：${tail.split('\n').slice(-3).join(' | ').slice(-400)}`:'')));});
  signal?.addEventListener('abort',abort,{once:true});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    if(finished){reject(new Error('任务会话已结束'));return;}
    const id=++seq,deadline=setTimeout(()=>{pending.delete(id);reject(new Error(method+' 超时'));},30000);
    pending.set(id,{resolve,reject,timer:deadline});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const resumeOverloaded=error=>{
    const delay=OVERLOAD_DELAYS[overloadAttempts];
    if(mode!=='work' || purpose!=='chat' || error?.codexErrorInfo!=='serverOverloaded' || delay===undefined || signal?.aborted)return false;
    overloadAttempts++;
    // Finish the failed turn, keep its effects/history and wait under the original stop controller.
    turnId=null;
    if(held)onEvent({type:'text',text:held});
    result=held='';
    const text=overloadResumePrompt();
    const nextAt=new Date(Date.now()+delay).toISOString();
    fs.appendFileSync(path.join(directory,'events.jsonl'),JSON.stringify({method:'office/overloadResume',params:{attempt:overloadAttempts,delay_ms:delay,next_at:nextAt,error,input:text}})+'\n');
    retryTimer=setTimeout(async()=>{
      retryTimer=null;
      if(finished || signal?.aborted)return;
      try {
        onEvent({type:'text',text:`Codex 拥堵后自动续做（${overloadAttempts}/${OVERLOAD_DELAYS.length}），沿用同一模型和会话，不重放原任务。`});
        const opened=await rpc('turn/start',{threadId:sessionId,input:[{type:'text',text}]});
        if(!finished)trackTurn(opened.turn.id);
      } catch(error) {finish(error);} // A rejected/timed-out start is not submitted again.
    },delay);
    onEvent({type:'text',text:`Codex 模型拥堵，${delay/60000} 分钟后自动续做（${overloadAttempts}/${OVERLOAD_DELAYS.length}）。预计 ${nextAt}；可随时点“停止”。最多自动唤起两次，不切换模型。`});
    return true;
  };
  createInterface({input:child.stdout}).on('line',line=>{
    let e;try{e=JSON.parse(line);}catch{return;}
    if(pending.has(e.id)){const p=pending.get(e.id);pending.delete(e.id);clearTimeout(p.timer);e.error ? p.reject(new Error(e.error.message || 'Codex RPC 失败')) : p.resolve(e.result);return;}
    if(e.id!==undefined && e.method==='item/tool/requestUserInput' && onQuestion && mode==='work' && !e.params?.questions?.some(q=>q.isSecret)) {
      const answer=result=>{if(!finished)child.stdin.write(JSON.stringify({id:e.id,...result})+'\n');};
      onQuestion(codexQuestions(e.params)).then(answers=>answer({result:{answers:Object.fromEntries(Object.entries(answers).map(([id,list])=>[id,{answers:list}]))}}),
        error=>answer({error:{code:-32000,message:'用户没有回答这个问题：'+error.message}}));
      return;
    }
    if(e.id!==undefined && e.method){child.stdin.write(JSON.stringify({id:e.id,error:{code:-32000,message:'任务无法批准超出既定工作目录的操作'}})+'\n');return;}
    if(!e.method || finished)return;
    // Count streaming deltas before persisting complete messages. Reconcile the
    // authoritative completed text without counting its deltas a second time.
    if(boundedOutput) {
      const item=e.params?.item,id=e.params?.itemId || item?.id;
      const prior=outputSizes.get(id) || 0;
      let size=prior;
      if(e.method==='item/agentMessage/delta')size+=String(e.params?.delta || '').length;
      else if(e.method==='item/completed' && item?.type==='agentMessage')size=Math.max(prior,item.text?.length || 0);
      if(size>prior){outputSizes.set(id,size);outputChars+=size-prior;}
      if(outputChars>maxOutputChars){finish(new Error(`Codex 输出超过 ${maxOutputChars} 字符上限`));return;}
    }
    if(['item/started','item/completed','turn/started','turn/completed','thread/tokenUsage/updated'].includes(e.method))fs.appendFileSync(path.join(directory,'events.jsonl'),JSON.stringify(e)+'\n');
    const item=e.params?.item;
    // Native lifecycle items describe the agent, not the duration of its launch tool.
    if(e.method==='item/completed' && item?.type==='subAgentActivity' && sessionId && item.agentThreadId!==sessionId && ['started','completed','interrupted'].includes(item.kind)) {
      childCard(item.agentThreadId,item.agentPath);
      onEvent({type:'subagent',agent_id:item.agentThreadId,status:item.kind==='started' ? 'running' : item.kind});
      if(item.kind!=='started')onEvent({type:'subagent_result',tool_id:item.agentThreadId,status:item.kind==='completed' ? 'completed' : 'failed'});
    }
    // This app-server carries the root and its spawned threads on the same stream.
    // Child messages are interim reports, never the root's held/final response.
    // Before the thread/start|resume response sessionId is still null: those notifications belong to the root, never to a child.
    const sub=sessionId && e.params?.threadId && e.params.threadId!==sessionId ? {sub:true,parent:e.params.threadId} : {};
    if(sub.sub)childCard(sub.parent);
    if(sub.sub && ['turn/started','turn/completed'].includes(e.method)){
      const status=e.method==='turn/started' ? 'running' : e.params.turn?.status==='completed' ? 'completed' : 'failed';
      onEvent({type:'subagent',agent_id:sub.parent,status});
      onEvent({type:'subagent_result',tool_id:sub.parent,status});
    }
    if(e.method==='turn/started' && e.params?.threadId===sessionId)trackTurn(e.params.turn.id);
    if(e.method==='item/started' && /commandExecution|fileChange|mcpToolCall/.test(item?.type)) {
      if(held)onEvent({type:'text',text:held});held='';
      toolCalls++;onEvent({type:'tool',tool_id:item.id,name:item.tool || item.type,...sub,
        summary:toolSummary(item.tool || item.type,item.type==='mcpToolCall' ? item.arguments : {command:item.command,commandActions:item.commandActions,changes:item.changes}),detail:item.command || item.tool || ''});
    }
    if(e.method==='item/completed' && /commandExecution|fileChange|mcpToolCall/.test(item?.type))onEvent({type:'tool_end',tool_id:item.id,...sub,
      status:item.status==='failed' || item.error || (typeof item.exitCode==='number' && item.exitCode!==0) ? 'failed' : 'completed'});
    const compaction=compactionEvent(e);if(compaction)onEvent({...compaction,...sub});
    if(e.method==='item/completed' && item?.type==='agentMessage' && item.text?.trim()){
      if(held)onEvent({type:'text',text:held});held='';
      if(sub.sub){
        onEvent({type:'text',text:item.text,...sub});
        if(!item.phase || item.phase==='final_answer')onEvent({type:'subagent_result',tool_id:sub.parent,text:item.text});
      }
      else held=result=item.text;
    }
    if(e.method==='item/completed' && item?.type==='fileChange')for(const c of item.changes || [])if(c.path)artifacts.push(c.path);
    if(e.method==='thread/tokenUsage/updated' && e.params?.threadId===sessionId && e.params.tokenUsage?.last)onEvent({type:'context',tokens:e.params.tokenUsage.last.totalTokens,window:e.params.tokenUsage.modelContextWindow});
    // Resume also emits the PREVIOUS turn's usage. It is not a zero-token measurement of this turn.
    if(e.method==='thread/tokenUsage/updated' && e.params?.threadId===sessionId && turnId && e.params.turnId===turnId) {
      total=e.params?.tokenUsage?.total || total;usage=usageDelta(total,baseline);
    }
    if(e.method==='turn/completed' && e.params?.threadId===sessionId && e.params?.turn?.id===turnId) {
      const turn=e.params?.turn;
      if(turn?.status==='completed')finish(result ? null : new Error(EMPTY_MESSAGE));
      else if(turn?.status!=='failed' || !resumeOverloaded(turn.error))finish(new Error((turn?.error?.message || 'Codex 未完成当前任务')+
        (overloadAttempts===OVERLOAD_DELAYS.length && turn?.error?.codexErrorInfo==='serverOverloaded' ? '（已自动唤起两次，仍然拥堵，已停止续做）' : '')));
    }
  });
  (async()=>{
    try {
      await rpc('initialize',{clientInfo:{name:'phd-workflows-agent',version:'0.2.0'},capabilities:{experimentalApi:true}});
      child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
      if(read('agent/config.json').automatic_codex_reset_credit===true) {
        try {await refreshCodexQuota(rpc);}
        catch(error) {onEvent({type:'text',text:'自动重置额度检查失败（未重试任务）：'+error.message});}
      }
      // A conversation turn uses the user's own auto approver (Codex's auto_review): a request to go beyond the sandbox is reviewed and approved
      // automatically, and what the reviewer judges unsafe is refused. A program-parsed ask turn never asks and cannot write.
      const auto=mode==='work';
      const params={cwd:launch.cwd,approvalPolicy:auto ? 'on-request' : 'never',...(auto ? {approvalsReviewer:'auto_review'} : {}),sandbox:auto ? 'workspace-write' : 'read-only',model:requested || cfg.codex_model,
        baseInstructions:systemPrompt,config:{model_reasoning_effort:effort}};
      const opened=await startCodexTurn(rpc,{params,signature:continuationSignature(launch,params.model,effort,systemPrompt),continuation,prompt,resumePrompt,inputParts,resumeInputParts,signal,beforeSubmit,onSubmitted,
        onThread:(state,info)=>{
          sessionId=state.threadId;model=info.thread.model;baseline=state.total;
          if(continuation){
            nativeState=state;onContinuation(state,{phase:'start',resumed:info.resumed});
            fs.writeFileSync(path.join(directory,'native-prompt.txt'),info.text);
            fs.writeFileSync(path.join(directory,'continuation.json'),JSON.stringify({threadId:sessionId,resumed:info.resumed,fallbackReason:info.fallbackReason,sandbox:info.thread.sandbox,approvalPolicy:info.thread.approvalPolicy,approvalsReviewer:info.thread.approvalsReviewer,baseline},null,2));
          }
        }});
      if(!finished)trackTurn(opened.turn.turn.id);
      if(mode==='work' && !finished)onReady(async (text,options={})=>{
        if((options.model && options.model!==(requested || cfg.codex_model)) ||
          (options.effort && options.effort!==effort) || (options.mode && options.mode!==mode))
          throw new Error('原生运行配置不同，需新建原生轮');
        if(finished)throw new Error('当前轮已结束');
        if(!turnId){
          // New explicit intent supersedes the pending automatic wakeup. The workbench
          // already durably queued it and will continue with that latest input instead.
          const error=new Error('拥堵等待期间收到新的用户补充，已取消自动唤起；补充保留排队，由下一轮接续。');
          finish(error);throw error;
        }
        await rpc('turn/steer',{threadId:sessionId,expectedTurnId:turnId,input:nativeTextInput(text,options.inputParts)});
      });
    } catch(e){finish(e);}
  })();
  if(signal?.aborted)abort();
  return await completion;
}
