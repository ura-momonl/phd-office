import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {root,read} from '../automation/files.mjs';
import {recordRun} from '../usage/run.mjs';
import {STOP_MESSAGE,EMPTY_MESSAGE,stopProcess} from './native.mjs';
import {deepseekTracker} from './context-breakdown.mjs';
import {sdkPython} from '../software/deepseek-harness/python.mjs';
import {DEEPSEEK_MAX_OUTPUT_TOKENS} from '../software/deepseek-harness/limits.mjs';
import {connectionStatus} from '../software/deepseek-harness/connection.mjs';

const runtime=path.join(root,'.runtime/deepseek-harness');
export function deepseekEnvironment(directory) {
  // Native tools need the office owner/run context, not unrelated account secrets.
  const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp','userprofile','appdata','localappdata','homedrive','homepath','home','programfiles','programfiles(x86)','programw6432','pathext','processor_architecture','dsh_initialize_timeout_seconds']);
  return {...Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k.toLowerCase()))),
    PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OFFICE_MEMORY_OWNER:'deepseek',OFFICE_MEMORY_RUN_DIR:directory};
}

export function deepseekEvent(notification) {
  if(notification.method!=='session.event')return [];
  const e=notification.payload?.event,d=e?.data || {};
  if(e?.type==='agent/inbox/spliced')return [{type:'submitted'}];
  if(e?.type==='tool/call') {
    let args;try{args=JSON.parse(d.arguments);}catch{args={raw:d.arguments};}
    return [{type:'tool',tool_id:d.callId,name:d.name,detail:String(args.command ?? args.file_path ?? args.path ?? args.pattern ?? d.arguments ?? '')}];
  }
  if(e?.type==='tool/result')return [{type:'tool_end',tool_id:d.message?.toolCallId,status:d.message?.isError ? 'failed' : 'completed'}];
  if(e?.type==='request/context')return Number.isInteger(d.contextWindow) && d.contextWindow>0 ? [{type:'context',window:d.contextWindow}] : [];
  if(e?.type==='assistant/message') {
    const text=(d.message?.content || []).filter(b=>b.type==='text').map(b=>b.text || '').join('');
    const u=d.usage,context=u && [u.inputTokens,u.outputTokens].every(Number.isFinite)
      ? [{type:'context',tokens:u.inputTokens+u.outputTokens+(u.cacheReadTokens || 0)+(u.cacheWriteTokens || 0)}] : [];
    return [...context,...(text ? [{type:'text',text}] : [])];
  }
  return [];
}

// A single SDK stream carries the root and its workflow children. Only the root
// may affect held chat text, submission receipts or the root context meter.
export function deepseekStream(sessionId,{onEvent=()=>{},onSubmitted=()=>{}}={}) {
  const children=new Map(),tracker=deepseekTracker();let submitted=false,held='';
  const card=(id,info={})=>{
    const prior=children.get(id);
    const child={id,title:'子 agent',prompt:'',...prior,...info};children.set(id,child);
    if(!prior || child.title!==prior.title || child.prompt!==prior.prompt)
      onEvent({type:'subagent_call',tool_id:id,title:child.title,prompt:child.prompt,kind:'workflow'});
    return child;
  };
  return {
    push(notice) {
      const p=notice.payload || {};
      if(['subagent.started','subagent.finished'].includes(notice.method)) {
        if(p.parentSessionId!==sessionId || !p.childSessionId)return;
        const id=p.childSessionId;card(id);
        if(notice.method==='subagent.started')onEvent({type:'subagent',agent_id:id,status:'running'});
        else {
          const status=p.status==='ok' ? 'completed' : ['cancelled','interrupted','stopped'].includes(p.status) ? 'stopped' : 'failed';
          const text=(p.lastAssistantMessage || []).filter(b=>b.type==='text').map(b=>b.text || '').join('');
          onEvent({type:'subagent',agent_id:id,status});
          onEvent({type:'subagent_result',tool_id:id,status,text});
        }
        return;
      }
      if(notice.method!=='session.event' || !p.sessionId)return;
      const e=p.event,d=e?.data || {},sub=p.sessionId!==sessionId;
      if(!sub && ['subagent/catalog','tool-workflow/agent-start'].includes(e?.type) && d.childId) {
        card(d.childId,{...(d.label ? {title:String(d.label)} : {})});return;
      }
      if(sub) {
        const id=p.sessionId;
        const first=!children.has(id);card(id);
        if(first)onEvent({type:'subagent',agent_id:id,status:'running'});
        if(e?.type==='user/message') {
          const prompt=(d.content || []).filter(b=>b.type==='text').map(b=>b.text || '').join('');
          if(prompt)card(id,{prompt});
        }
        for(const event of deepseekEvent(notice)) {
          if(!['text','tool','tool_end'].includes(event.type))continue;
          onEvent({...event,...(event.tool_id ? {tool_id:id+':'+event.tool_id} : {}),sub:true,parent:id});
        }
        return;
      }
      tracker.push(e);
      for(const event of deepseekEvent(notice)) {
        if(event.type==='submitted'){if(!submitted){submitted=true;onSubmitted();}}
        else if(event.type==='text'){if(held)onEvent({type:'text',text:held});held=event.text;}
        else {if(event.type==='tool' && held){onEvent({type:'text',text:held});held='';}onEvent(event);}
      }
    },
    contextBreakdown:()=>tracker.result(),
  };
}

// Each message goes straight to this native inbox. Receipts only record delivery.
export function deepseekInput(child,{mode,model,effort,onReady=()=>{}}={}) {
  const pending=new Map();let closed=false;
  const close=()=>{closed=true;for(const p of pending.values())p.reject(new Error('当前轮已结束，消息保留排队'));pending.clear();};
  child.stdin?.on('error',close);
  return {
    push(notice) {
      if(notice.method==='office.ready' && !closed)onReady((text,options={})=>new Promise((resolve,reject)=>{
        if((options.model && options.model!==model) || (options.effort && options.effort!==effort) || (options.mode && options.mode!==mode))
          return reject(new Error('原生运行配置不同，需新建原生轮'));
        if(closed || child.stdin.destroyed || child.stdin.writableEnded)return reject(new Error('当前轮已结束'));
        const id=randomUUID();pending.set(id,{resolve,reject});
        child.stdin.write(JSON.stringify({id,text})+'\n',error=>{if(error){pending.delete(id);reject(error);}});
      }));
      if(notice.method==='office.input') {
        const p=notice.payload || {},receipt=pending.get(p.id);if(!receipt)return;
        pending.delete(p.id);
        if(p.accepted)receipt.resolve();else receipt.reject(new Error(p.error || '原生输入未送达'));
      }
    },close,
  };
}

// Fresh full-history turns: no hidden resume/fork state, no retries or background calls.
export async function invokeDeepSeek(prompt,{mode='work',model,effort,directory,signal,onEvent=()=>{},beforeSubmit=()=>{},onSubmitted=()=>{},onReady=()=>{},purpose='chat'}={}) {
  if(process.env.PHD_ISOLATED_TESTS==='1' || read('agent/config.json').enabled===false)throw new Error('Real DeepSeek calls disabled in this environment');
  if(effort && !['off','low','high','max'].includes(effort))throw new Error('DeepSeek 推理强度须为 off、low、high 或 max');
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  const python=path.join(runtime,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const dsh=path.join(runtime,'npm/node_modules/.bin',process.platform==='win32'?'dsh.cmd':'dsh');
  if(!fs.existsSync(python) || !fs.existsSync(dsh))throw new Error('DeepSeek SDK 未安装；见 software/deepseek-harness/README.md');
  if(!connectionStatus().credential_configured)throw new Error('DeepSeek 本地凭据未配置');
  const host=sdkPython(path.join(runtime,'venv'));
  fs.mkdirSync(directory,{recursive:true});
  const id=randomUUID(),started=Date.now(),chosen=model || read('agent/config.json').deepseek_model || 'deepseek-flash';
  const task={id,mode,model:chosen,max_tokens:DEEPSEEK_MAX_OUTPUT_TOKENS,prompt,...(effort ? {reasoning_effort:effort} : {})};
  const request=path.join(directory,'deepseek-task.json'),resultFile=path.join(directory,'deepseek-result.json');
  fs.writeFileSync(request,JSON.stringify(task,null,2)+'\n');
  fs.writeFileSync(path.join(directory,'native-prompt.txt'),prompt);
  if(mode==='ask')onReady(null);
  let launchError;
  const stream=deepseekStream(id,{onEvent,onSubmitted});
  beforeSubmit(); // The task file is handed to the harness synchronously below.
  const exitCode=await new Promise(resolve=>{
    const child=spawn(host.executable,[path.join(root,'software/deepseek-harness/chat.py'),request],{cwd:root,env:{...deepseekEnvironment(directory),...host.environment},windowsHide:true,stdio:[mode==='work'?'pipe':'ignore','pipe','pipe']});
    const input=deepseekInput(child,{mode,model:chosen,effort,onReady});
    child.stderr.resume(); // The redacted result, not a raw native traceback, is the public error.
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      let notice;try{notice=JSON.parse(line);}catch{return;}
      input.push(notice);
      stream.push(notice);
    });
    const abort=()=>stopProcess(child);
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',e=>{launchError=e.code || e.name;});
    child.once('close',code=>{input.close();onReady(null);signal?.removeEventListener('abort',abort);lines.close();resolve(code);});
  });
  let result;
  try{result=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch{result={status:'failed',error:launchError || `DeepSeek runtime exited ${exitCode} without a result`,usage_known:false};}
  const status=signal?.aborted ? 'stopped' : result.status;
  recordRun({id,provider:'deepseek',model:result.model || chosen,transport:result.transport,purpose,mode,status,duration_ms:Date.now()-started,run_dir:path.relative(root,directory).replaceAll('\\','/'),
    usage_known:result.usage_known===true,usage_partial:result.usage_partial===true,input_tokens:result.usage?.input_tokens ?? null,
    cached_input_tokens:result.usage?.cached_input_tokens ?? null,output_tokens:result.usage?.output_tokens ?? null,
    cache_creation_tokens:result.usage?.cache_creation_tokens ?? null,tool_calls:result.tool_calls ?? null});
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  if(status!=='completed')throw new Error(result.error || EMPTY_MESSAGE);
  return {result:result.final_response,usage:result.usage,model:result.model || chosen,transport:result.transport,sessionId:id,toolCalls:result.tool_calls,contextBreakdown:stream.contextBreakdown(),duration_ms:Date.now()-started};
}
