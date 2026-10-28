import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const utf8Setup="$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);";

export function readEncodingPlan(command) {
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'agent/powershell-read-check.ps1')],
    {input:command,encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:65536});
  if(result.error || result.status!==0)throw new Error('TEXT_ENCODING_CHECK_FAILED');
  return JSON.parse(result.stdout);
}

export function rewritePowerShell(command,plan=readEncodingPlan(command)) {
  if(!plan.reads)return command;
  const edits=plan.edits.map(at=>({at,text:' -Encoding UTF8'}));
  if(!command.slice(plan.setupOffset).trimStart().startsWith(utf8Setup))edits.push({at:plan.setupOffset,text:'\n'+utf8Setup+'\n'});
  let out=command;
  for(const e of edits.sort((a,b)=>b.at-a.at))out=out.slice(0,e.at)+e.text+out.slice(e.at);
  return out;
}

export function codexUtf8Result(event,{platform=process.platform,rewrite=rewritePowerShell}={}) {
  if(platform!=='win32' || event?.hook_event_name!=='PreToolUse' || event.tool_name!=='Bash' || !event.cwd)return {};
  const relative=path.relative(root,path.resolve(event.cwd));
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))return {};
  const input=event.tool_input;
  if(typeof input?.command!=='string')return {};
  if(input.shell && !/(?:^|[/\\])(?:pwsh|powershell)(?:\.exe)?$/i.test(input.shell))return {};
  let command;
  try {command=rewrite(input.command);} catch {return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'TEXT_ENCODING_CHECK_FAILED'}};}
  if(command===input.command)return {};
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...input,command}}};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(codexUtf8Result(JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,'')))));}
  catch {console.error('TEXT_ENCODING_CHECK_FAILED');process.exitCode=2;}
}
