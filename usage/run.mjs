import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { root, read, write } from '../automation/files.mjs';
import {usageGroups,speedGroups,SPEED_MIN_OUTPUT} from './metrics.mjs';
import {fetchExtraResets,accountResetMessages} from './extra-resets.mjs';
import {resetExhaustedCodexQuota} from './reset-credits.mjs';
import {refreshDeepSeekBalance} from './deepseek-balance.mjs';
import {refreshCommandCodeQuota} from './commandcode-quota.mjs';

// Which account DeepSeek calls are billed to now (official balance or Command Code plan); the header shows only that one.
// quota.json plus the live channel, so every reader (page state, snapshot, refresh result) sees the same selection.
export const quotaView=()=>({...read('.runtime/usage/quota.json',{}),deepseek_provider:deepseekChannel()});
const deepseekChannel=()=>read('.runtime/deepseek-harness/provider.json',{provider:'official'}).provider==='commandcode' ? 'commandcode' : 'official';

// Used by the existing refresh and before native Codex turns. Each caller reads
// fresh official limits; a stale on-disk percentage can never spend a card.
export async function refreshCodexQuota(rpc) {
  const result=await resetExhaustedCodexQuota(rpc,await rpc('account/rateLimits/read'));
  const quota=read('.runtime/usage/quota.json',{});
  quota.codex={source:'Codex account/rateLimits/read',checked_at:new Date().toISOString(),activity:quota.codex?.activity ?? null,...result};
  write('.runtime/usage/quota.json',quota);
  return quota.codex;
}

// The call log only ever grows (one line per model call, ~200KB/day) and both the page state and `calls` parse it whole.
// Pages read at most the last week, so it is rolled over by size: past 16MB the oldest lines are dropped until 12MB remains.
const RUNS_KEEP_BYTES = 12 * 1048576, RUNS_MAX_BYTES = 16 * 1048576;
export function recordRun(run) {
  const file = path.join(root, '.runtime/usage/runs.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.appendFileSync(file, JSON.stringify({at:new Date().toISOString(), ...run})+'\n');
  if (fs.statSync(file).size > RUNS_MAX_BYTES) rollRuns(file);
}
function rollRuns(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let bytes = 0, keep = lines.length;
  for (let n = lines.length - 1; n >= 0; n--) {
    bytes += Buffer.byteLength(lines[n]) + 1;
    if (bytes > RUNS_KEEP_BYTES) break;
    keep = n;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.slice(keep).join('\n') + '\n');
  fs.renameSync(temporary, file);
}
export function usageSnapshot() {
  const file=path.join(root,'.runtime/usage/runs.jsonl');
  const runs=fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
  return {runs, quota:quotaView(), scope:'本机助手记录的调用', subscriptionMonthlyUSD:40};
}
// Native account RPC does not start a thread/model turn or export credentials.
// With automatic_codex_reset_credit enabled, an exhausted window may redeem a card.
export async function refreshQuota() {
  // Reuse the existing quota-refresh cadence; no extra timer, model, or authenticated public request.
  const community=fetchExtraResets();
  const deepseek=deepseekChannel()==='commandcode' ? refreshCommandCodeQuota() : refreshDeepSeekBalance();
  let announcements={checked_at:new Date().toISOString(),error:'账号公告未读取'};
  const bin=process.env.MAIL_FLOW_CODEX_BIN || path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js');
  const child=spawn(process.execPath,[bin,'app-server','--listen','stdio://'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let seq=0; const pending=new Map();
  child.stderr.resume();
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('原生 Codex 额度查询不可用；登录未改变'));}pending.clear();};
  child.on('error',fail); child.on('exit',fail); child.stdin.on('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{
    let msg; try {msg=JSON.parse(line);} catch {return;}
    const p=pending.get(msg.id); if(!p)return;
    pending.delete(msg.id);clearTimeout(p.timer);
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.code}`)) : p.resolve(msg.result);
  });
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('额度查询超时'));},20000);
    pending.set(id,{resolve,reject,timer,method}); child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const quota=read('.runtime/usage/quota.json',{});
  try {
    await rpc('initialize',{clientInfo:{name:'phd-workflows-usage',version:'0.2.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const codex=await refreshCodexQuota(rpc);
    const [activity,notice]=await Promise.all([
      rpc('account/usage/read').catch(()=>null),
      rpc('account/workspaceMessages/read').then(r=>accountResetMessages(r)).catch(e=>({checked_at:new Date().toISOString(),error:e.message})),
    ]);
    announcements=notice;
    quota.codex={...codex,activity};
  } catch(error) {
    quota.codex={...quota.codex,error:error.message,attempted_at:new Date().toISOString()};
  } finally {
    child.stdin.end();
    if(process.platform==='win32' && child.pid && child.exitCode===null)spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else child.kill();
  }
  const extra_resets={...await community,account:announcements};
  const current=read('.runtime/usage/quota.json',{});current.codex=quota.codex;current.extra_resets=extra_resets;write('.runtime/usage/quota.json',current);
  await Promise.all([refreshClaudeQuota(),deepseek]);return quotaView();
}
// Claude Code reports the account windows on every run (utilization is the used fraction 0-1), which costs nothing extra.
// This is the only writer of quota.claude; the file is re-read so a concurrent writer of another key is not overwritten.
export function recordClaudeLimits(info) {
  const names={five_hour:'5 小时窗口',seven_day:'7 天窗口'};
  const windows=Object.entries(info?.unifiedWindows || {}).filter(([key,w])=>names[key] && Number.isFinite(w?.utilization)).map(([key,w])=>({
    label:names[key],remaining_percent:Math.max(0,Math.min(100,Math.round((1-w.utilization)*100))),resets_at:w.resetsAt ? new Date(w.resetsAt*1000).toISOString() : null}));
  if(!windows.length)return null;
  const quota=read('.runtime/usage/quota.json',{});
  quota.claude={source:'Claude Code 运行时返回的账号额度',checked_at:new Date().toISOString(),windows};
  write('.runtime/usage/quota.json',quota);return quota.claude;
}
// Direct account query (not a public, stable API): the Claude Code login token is read for this one request only and never stored,
// logged or returned. utilization here is already a percentage. Any failure falls back to the one-turn probe below.
export function recordClaudeUsage(data) {
  const names={five_hour:'5 小时窗口',seven_day:'7 天窗口'};
  const windows=Object.entries(names).filter(([key])=>Number.isFinite(data?.[key]?.utilization)).map(([key,label])=>({
    label,remaining_percent:Math.max(0,Math.min(100,Math.round(100-data[key].utilization))),
    resets_at:Number.isFinite(Date.parse(data[key].resets_at)) ? new Date(data[key].resets_at).toISOString() : null}));
  if(!windows.length)return null;
  const quota=read('.runtime/usage/quota.json',{});
  quota.claude={source:'Claude 账号额度接口（只读）',checked_at:new Date().toISOString(),windows};
  write('.runtime/usage/quota.json',quota);return quota.claude;
}
async function fetchClaudeUsage() {
  const token=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.claude/.credentials.json'),'utf8')).claudeAiOauth?.accessToken;
  if(!token)throw new Error('未找到 Claude 登录令牌');
  const response=await fetch('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+token,'anthropic-beta':'oauth-2025-04-20',Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('额度接口返回 '+response.status);
  return await response.json();
}
export async function refreshClaudeQuota() {
  try {
    if(recordClaudeUsage(await fetchClaudeUsage()))return read('.runtime/usage/quota.json',{}).claude;
  } catch { /* Fall through to the probe; error text never carries the token. */ }
  return await probeClaudeQuota();
}
// A one-turn, tool-less haiku call (about 800 tokens) is the cheapest way to make Claude Code report the account windows.
export async function probeClaudeQuota() {
  const bin=process.env.WORKFLOW_CLAUDE_BIN || path.join(process.env.USERPROFILE,'.local/bin/claude.exe');
  const started=Date.now();let usage={},failure=null;
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn(bin,['-p','--safe-mode','--model','haiku','--max-turns','1','--output-format','stream-json','--verbose','--tools','','--system-prompt','ok'],
        {cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Claude 额度探测超时'));},30000);
      child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',reject);
      createInterface({input:child.stdout}).on('line',line=>{
        let e;try {e=JSON.parse(line);}catch{return;}
        if(e.type==='rate_limit_event')recordClaudeLimits(e.rate_limit_info);
        if(e.type==='result')usage=e.usage || {};
      });
      child.on('close',code=>{clearTimeout(timer);code===0 ? resolve() : reject(new Error('Claude 额度探测失败 ('+code+')'));});
      child.stdin.end('ok');
    });
  } catch(error) {
    failure=error.message;
    const quota=read('.runtime/usage/quota.json',{});quota.claude={...quota.claude,error:failure,attempted_at:new Date().toISOString()};write('.runtime/usage/quota.json',quota);
  }
  recordRun({provider:'claude',model:'claude-haiku-4-5-20251001',feature:'quota-probe',status:failure ? 'failed' : 'completed',usage_known:Object.keys(usage).length>0,
    input_tokens:(usage.input_tokens || 0)+(usage.cache_read_input_tokens || 0)+(usage.cache_creation_input_tokens || 0),cached_input_tokens:usage.cache_read_input_tokens || 0,
    output_tokens:usage.output_tokens || 0,tool_calls:0,duration_ms:Date.now()-started});
  return read('.runtime/usage/quota.json',{}).claude;
}
// The command line prints a digest by default: the full run ledger is hundreds of KB and a conversation rarely needs all of it.
// `status full` prints everything; the workbench reads usageSnapshot() directly.
export function usageDigest(snapshot=usageSnapshot(),days=3) {
  const zone=read('weekly/config.json').timezone,day=at=>new Date(at).toLocaleDateString('en-CA',{timeZone:zone});
  const recent=[...new Set(snapshot.runs.map(r=>day(r.at)))].sort().slice(-days);
  const table=Object.fromEntries(usageGroups(snapshot.runs.filter(r=>recent.includes(day(r.at))),r=>day(r.at)+' '+r.provider)
    .map(g=>[g.key,{calls:g.calls,input_tokens:g.input,cached_input_tokens:g.cached,output_tokens:g.output,tool_calls:g.tools,duration_s:g.ms/1000,failed:g.failed,unknown_usage:g.unknown,partial_usage:g.partial}]));
  return {quota:snapshot.quota,scope:snapshot.scope,subscriptionMonthlyUSD:snapshot.subscriptionMonthlyUSD,total_runs:snapshot.runs.length,recent_days:table,
    note:'默认只给摘要和最近几天按日期、提供方的合计；逐条调用记录用 usage status full（体量很大，先想清楚要查什么）。'};
}
// Effective output speed per model from the ledger (see speedGroups): `usage speed [天数，默认 7，0 为全部]`.
export function speedReport(days=7,snapshot=usageSnapshot()) {
  const cutoff=days>0 ? Date.now()-days*86400000 : 0;
  const rows=speedGroups(snapshot.runs.filter(r=>Date.parse(r.at)>=cutoff)).map(g=>({model:g.key.replace('|',' · '),samples:g.samples,median_tok_per_s:g.median===null ? null : +g.median.toFixed(1),completed_calls:g.calls,all_calls_tok_per_s:g.all_calls_rate===null ? null : +g.all_calls_rate.toFixed(1)}));
  return {window:days>0 ? `最近 ${days} 天` : '全部记录',rows,
    note:`输出速率 = 输出 token ÷ 整次调用耗时（含排队、读上下文、推理），不是纯生成速度；中位数只统计完成的、无工具调用且输出 ≥ ${SPEED_MIN_OUTPUT} token 的调用；all_calls 含工具等待，仅参考。`};
}
export async function run(action,argument) {
  if(action==='speed'){const d=argument===undefined ? 7 : Number(argument);if(!Number.isFinite(d) || d<0)throw new Error('usage speed [天数]');console.log(JSON.stringify(speedReport(d)));return;}
  if(action==='status')console.log(JSON.stringify(argument==='full' ? usageSnapshot() : usageDigest()));
  else if(action==='refresh')console.log(JSON.stringify(await refreshQuota()));
  else throw new Error('usage status|refresh|speed [天数]');
}
