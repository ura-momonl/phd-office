import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {root,input,read} from '../../automation/files.mjs';
import {recordRun} from '../../usage/run.mjs';
import {sdkPython} from './python.mjs';
import {DEEPSEEK_MAX_OUTPUT_TOKENS} from './limits.mjs';
import {checkUpdates,updateStatus} from './updates.mjs';
import {connectionStatus,selectConnection} from './connection.mjs';

const runtime=path.join(root,'.runtime/deepseek-harness');
const python=path.join(runtime,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const dsh=path.join(runtime,'npm/node_modules/.bin',process.platform==='win32'?'dsh.cmd':'dsh');
const script=path.join(root,'software/deepseek-harness/delegate.py');
const policy={profile:'sdk',sandbox:'workspace-write',approval:'never',automatic_retry:false,subagents:false,telemetry:false,session_log_upload:false};

export function prepare(file) {
  if(!file)throw new Error('deepseek prepare|run <request.json>');
  const request=input(file),keys=['prompt_file','model','reasoning_effort','max_tokens'];
  if(!request || Array.isArray(request) || typeof request!=='object' || Object.keys(request).some(k=>!keys.includes(k)))throw new Error('Only prompt_file, model, reasoning_effort, max_tokens are accepted; no credentials or arbitrary cwd in a task');
  if(typeof request.prompt_file!=='string' || !request.prompt_file.trim())throw new Error('prompt_file is required');
  const prompt_file=path.resolve(path.dirname(path.resolve(file)),request.prompt_file);
  const prompt=fs.readFileSync(prompt_file,'utf8').replace(/^\uFEFF/,'');
  if(!prompt.trim())throw new Error('Empty task prompt');
  const model=request.model ?? 'deepseek-flash',max_tokens=request.max_tokens ?? DEEPSEEK_MAX_OUTPUT_TOKENS;
  if(typeof model!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))throw new Error('Invalid model id');
  if(!Number.isInteger(max_tokens) || max_tokens<1)throw new Error('max_tokens must be a positive integer');
  if(request.reasoning_effort!==undefined && (typeof request.reasoning_effort!=='string' || !request.reasoning_effort.trim()))throw new Error('reasoning_effort must be a non-empty string');
  return {purpose:'deepseek-delegate',mode:'work',provider:'deepseek',model,max_tokens,
    ...(request.reasoning_effort===undefined?{}:{reasoning_effort:request.reasoning_effort}),
    prompt,prompt_file,prompt_sha256:createHash('sha256').update(prompt).digest('hex'),...policy};
}

// Do not forward unrelated office/cloud tokens, account connectors or custom DSH profiles.
function childEnvironment() {
  const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp','userprofile','appdata','localappdata','homedrive','homepath','home','programfiles','programfiles(x86)','programw6432','pathext','processor_architecture']);
  return {...Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k.toLowerCase()))),PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
}

export async function delegate(file) {
  if(process.env.PHD_ISOLATED_TESTS==='1' || read('agent/config.json',{}).enabled===false)throw new Error('Real DeepSeek calls disabled in this environment');
  const task=prepare(file);
  if(!fs.existsSync(python) || !fs.existsSync(dsh))throw new Error('DeepSeek SDK and npm runtime are not installed; see software/deepseek-harness/README.md');
  if(!connectionStatus().credential_configured)throw new Error('Missing local DeepSeek credentials; see software/deepseek-harness/README.md');
  const host=sdkPython(path.join(runtime,'venv'));
  const id=randomUUID(),directory=path.join(runtime,'jobs',id);
  fs.mkdirSync(path.join(directory,'workspace'),{recursive:true});
  fs.writeFileSync(path.join(directory,'task.json'),JSON.stringify({...task,id},null,2)+'\n');
  const started=Date.now();let launchError=null;
  const code=await new Promise(resolve=>{
    const child=spawn(host.executable,[script,path.join(directory,'task.json')],{cwd:root,env:{...childEnvironment(),...host.environment},windowsHide:true,stdio:['ignore','ignore','pipe']});
    // Python writes redacted diagnostics to result.json. Never dump an unfiltered native traceback.
    child.stderr.resume();
    const interrupt=()=>{
      if(child.exitCode!==null || !child.pid)return;
      if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      else child.kill('SIGTERM');
    };
    process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    child.once('error',e=>{launchError=e.code || e.name;});
    child.once('close',code=>{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);resolve(code);});
  });
  const resultFile=path.join(directory,'result.json');
  const produced=fs.existsSync(resultFile);
  const result=produced?input(resultFile):{id,status:'failed',error:launchError || `Runtime exited ${code} without a result`,usage_known:false};
  if(!produced)fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
  recordRun({id,provider:'deepseek',model:result.model || task.model,transport:result.transport,purpose:'deepseek-delegate',mode:'work',feature:'delegation',status:result.status,
    duration_ms:Date.now()-started,usage_known:result.usage_known===true,usage_partial:result.usage_partial===true,input_tokens:result.usage?.input_tokens??null,
    cached_input_tokens:result.usage?.cached_input_tokens??null,output_tokens:result.usage?.output_tokens??null,
    cache_creation_tokens:result.usage?.cache_creation_tokens??null,
    tool_calls:result.tool_calls??null,result_file:resultFile});
  return {...result,result_file:resultFile,workspace:path.join(directory,'workspace')};
}

export async function run(action,argument) {
  if(action==='status') {
    console.log(JSON.stringify({installed:fs.existsSync(python)&&fs.existsSync(dsh),...connectionStatus(),...policy,automatic:false,
      jobs:path.join(runtime,'jobs'),permissions:'use_default; normal tool approval if denied',updates:updateStatus()}));
  } else if(action==='provider') {
    console.log(JSON.stringify(argument ? selectConnection(argument) : connectionStatus()));
  } else if(action==='updates') {
    const result=await checkUpdates({force:true});console.log(JSON.stringify(result));
    if(result.error)process.exitCode=1;
  } else if(action==='prepare') {
    const {prompt,...preview}=prepare(argument);
    console.log(JSON.stringify({...preview,prompt_bytes:Buffer.byteLength(prompt),model_invoked:false}));
  } else if(action==='run') {
    const result=await delegate(argument);console.log(JSON.stringify(result));
    if(result.status!=='completed')process.exitCode=1;
  } else throw new Error('deepseek: status, provider [official|commandcode], updates, prepare <request.json>, run <request.json>');
}
