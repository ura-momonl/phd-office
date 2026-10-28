// A user-authorized native host capability, not an unrestricted shell escape.
// Ordinary shell tools keep their existing sandbox. Only DeepSeek's own memory2
// maintenance is exposed here, using the same CLI, model configuration and ledger.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root} from '../../automation/files.mjs';
import {stopProcess} from '../../agent/native.mjs';

export const name='office-memory-maintenance';
export const inject=['tools'];
const actions=new Set(['status','ingest','reflect','profile','search']);

export function maintenanceRequest(args) {
  if(!args || typeof args!=='object' || Array.isArray(args) || !actions.has(args.action))throw new Error('action 须为 status、ingest、reflect、profile 或 search');
  const allowed=new Set(['action',...(args.action==='ingest'?['limit','since','facts']:args.action==='profile'?['maxCalls']:args.action==='search'?['query','topK','chars','maxRounds']:[])]);
  for(const key of Object.keys(args))if(!allowed.has(key))throw new Error(`不支持参数 ${key}`);
  for(const key of ['limit','maxCalls','topK','chars','maxRounds'])if(args[key]!==undefined && (!Number.isSafeInteger(args[key]) || args[key]<1))throw new Error(`${key} 须为正整数`);
  if(args.action==='search' && (typeof args.query!=='string' || !args.query.trim()))throw new Error('search 需要非空 query');
  if(args.maxRounds!==undefined && args.maxRounds>3)throw new Error('maxRounds 须为 1～3');
  if(args.since!==undefined && (typeof args.since!=='string' || !Number.isFinite(Date.parse(args.since))))throw new Error('since 须为 ISO 时间');
  if(args.facts!==undefined && typeof args.facts!=='boolean')throw new Error('facts 须为布尔值');
  const {action,maxRounds,...options}=args;
  return {action,request:{...options,owner:'deepseek',...(action==='search'?{method:'agentic',tune:{retries:0,...(maxRounds===undefined?{}:{maxRounds})}}:{})}};
}

export async function maintainMemory(args,{directory,signal,spawnImpl=spawn,stop=stopProcess,active=new Set()}={}) {
  const {action,request}=maintenanceRequest(args);
  if(signal?.aborted)throw new Error('记忆维护已停止');
  if(process.env.OFFICE_MEMORY_OWNER!=='deepseek')throw new Error('此工具只供 DeepSeek 本人使用');
  if(!directory || !path.isAbsolute(directory))throw new Error('缺少本轮运行目录');
  if(active.size)throw new Error('本轮已有记忆维护在运行，请等它返回结果');
  const job=path.join(directory,'memory-maintenance',randomUUID());
  fs.mkdirSync(job,{recursive:true});
  const requestFile=path.join(job,'request.json'),resultFile=path.join(job,'result.json');
  fs.writeFileSync(requestFile,JSON.stringify(request,null,2)+'\n');
  // Keep account secrets out of the CLI environment; native clients use their
  // existing user-home authentication, just as backend maintenance already does.
  const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp','userprofile','appdata','localappdata','homedrive','homepath','home','programfiles','programfiles(x86)','programw6432','pathext','processor_architecture','phd_isolated_tests']);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toLowerCase()))),OFFICE_MEMORY_OWNER:'deepseek',OFFICE_MEMORY_RUN_DIR:directory};
  let stdout='',stderr='',launchError;
  const exitCode=await new Promise(resolve=>{
    const child=spawnImpl(process.execPath,[path.join(root,'automation/run.mjs'),'memory2',action,requestFile],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    active.add(child);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const abort=()=>stop(child);
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',error=>{launchError=error.code || error.message;});
    child.once('close',code=>{active.delete(child);signal?.removeEventListener('abort',abort);resolve(code);});
  });
  fs.writeFileSync(path.join(job,'stdout.log'),stdout);fs.writeFileSync(path.join(job,'stderr.log'),stderr);
  let report;
  try {report=JSON.parse(stdout.trim());} catch { /* A failed CLI may not have returned JSON. */ }
  const failed=exitCode!==0 || !!launchError || !report || !!report.error || !!report.aborted || !!report.failed_rounds || !!report.failures?.length || !!report.facts_backfill?.failures?.length
    || !!report.skipped?.some(item=>item.reason!=='no live episodes') || !!report.reports?.some(item=>item.fact_error);
  const result={ok:!signal?.aborted && !failed,action,owner:'deepseek',exitCode,report:report ?? null,...(launchError?{error:launchError}:{}),stopped:signal?.aborted===true};
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
  if(!result.ok)throw new Error(`记忆维护未完成；结果 ${resultFile}；${launchError || report?.error || report?.aborted || stderr.slice(-1600) || JSON.stringify(report)}`);
  return {report:JSON.stringify(report),resultFile};
}

export function apply(ctx,config={}) {
  const active=new Set();
  ctx.on('dispose',()=>{for(const child of active)stopProcess(child);});
  ctx.tools.register({
    name:'office_memory_maintain',
    description:'你（DeepSeek）自己的记忆入口。action=status 只读；ingest 回填、reflect 聚类整理、profile 更新画像；search 加 query 做 agentic 回溯。需要模型的记忆操作直接使用本工具（包括 memory2 search method=agentic），避免 shell 内的 pipe EPERM；普通关键词检索和读取仍可用 CLI。复用既有模型与用量记录，不改变普通 shell 沙箱。ingest 可带 limit/since/facts；profile 可带 maxCalls；search 可带 topK/chars/maxRounds（1～3，默认3轮）。直接返回实际报告与结果文件；失败不重跑，检索降级也报失败并保留结果。',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:[...actions]},limit:{type:'integer',description:'仅 ingest，正整数'},since:{type:'string'},facts:{type:'boolean'},maxCalls:{type:'integer',description:'仅 profile，正整数'},query:{type:'string',description:'仅 search，必填，回溯问题'},topK:{type:'integer',description:'仅 search，返回条数，正整数'},chars:{type:'integer',description:'仅 search，每条正文长度，正整数'},maxRounds:{type:'integer',description:'仅 search，模型轮数1～3'}}},
    output:{schema:{type:'object',additionalProperties:false,required:['report','resultFile'],properties:{report:{type:'string'},resultFile:{type:'string'}}},render:(_args,value)=>[{type:'text',text:value.report+'\n结果文件：'+value.resultFile}]},
    execute:(args,exec)=>maintainMemory(args,{directory:config.runDirectory,signal:exec.signal,active}),
  });
}
