import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Locate inline Node source whose template/expansion syntax crosses shell quotes.
// Include escaped backticks: the incident used several layers of escaping and
// still lost its templates. Do not guess the intended code by re-quoting it.
function words(command) {
  const out=[],heredocs=[];
  let value='',started=false,quote='',expands=false;
  const flush=()=>{if(started)out.push({value,expands});value='';started=false;expands=false;};
  for(let i=0;i<command.length;i++) {
    const c=command[i];
    if(quote==="'") {if(c==="'")quote='';else value+=c;continue;}
    // A here-document body is data, not more shell commands. Keep checking
    // commands after its terminator, including multiple documents on one line.
    if(!quote && command[i-1]!=='<' && command.startsWith('<<',i) && command[i+2]!=='<') {
      const m=command.slice(i).match(/^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([\w]+))/);
      if(m){flush();out.push(null);heredocs.push({delimiter:m[2] ?? m[3] ?? m[4],tabs:!!m[1]});i+=m[0].length-1;continue;}
    }
    if(c==='\\' && quote!=="'") {
      const next=command[i+1];
      // In double quotes Bash only consumes backslashes before these characters.
      if(next!==undefined && (!quote || /[$`"\\\n]/.test(next))) {
        if(next==='`' || next==='$')expands=true;
        if(next!=='\n')value+=next;started=true;i++;continue;
      }
    }
    if(c==='"') {quote=quote ? '' : '"';started=true;continue;}
    if(!quote && c==="'") {quote="'";started=true;continue;}
    if(!quote && c==='#' && !started) {while(i<command.length && command[i]!=='\n')i++;i--;continue;}
    if(!quote && c==='\n' && heredocs.length) {
      flush();out.push(null);
      for(const doc of heredocs.splice(0)) {
        while(i<command.length) {
          const begin=i+1,end=command.indexOf('\n',begin),stop=end<0 ? command.length : end;
          const line=command.slice(begin,stop).replace(/\r$/,'');i=stop;
          if((doc.tabs ? line.replace(/^\t+/,'') : line)===doc.delimiter)break;
        }
      }
      continue;
    }
    if(!quote && /[\s;|&()<>]/.test(c)) {
      flush();if(!/[ \t\r]/.test(c))out.push(null);continue;
    }
    if(c==='`' || (c==='$' && /[\w{([?@*#!$-]/.test(command[i+1] || '')))expands=true;
    value+=c;started=true;
  }
  flush();return out;
}

export function shellSourceProblem(command) {
  const tokens=words(String(command || ''));
  for(let start=0;start<tokens.length;) {
    let end=start;while(end<tokens.length && tokens[end])end++;
    const segment=tokens.slice(start,end);start=end+1;
    let n=0;
    while(/^[A-Za-z_][\w]*=/.test(segment[n]?.value || ''))n++;
    if(['env','command'].includes(segment[n]?.value)) {
      n++;while(segment[n] && (/^[A-Za-z_][\w]*=/.test(segment[n].value) || segment[n].value.startsWith('-')))n++;
    }
    if(!/(?:^|[/\\])node(?:\.exe)?$/i.test(segment[n]?.value || ''))continue;
    for(let i=n+1;i<segment.length;i++) {
      const arg=segment[i].value;
      if(arg==='--' || !arg.startsWith('-'))break; // a script filename is not inline source
      let source;
      if(['-e','--eval','-p','--print'].includes(arg))source=segment[i+1];
      else if(/^(?:--eval=|--print=|-e.|-p.)/.test(arg))source=segment[i];
      if(source) {
        if(source.expands)return 'SHELL_SOURCE_QUOTING: Node 内联源码引用不安全，命令未执行。';
        break;
      }
    }
  }
  return null;
}

export function shellGuardResult(event) {
  if(event?.hook_event_name!=='PreToolUse' || event.tool_name!=='Bash')return {};
  const reason=shellSourceProblem(event.tool_input?.command);
  if(reason)return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};
  if(typeof event.tool_input?.command!=='string')return {};
  // Preserve the original arguments and the normal permission decision. A later
  // grep/tail must not turn an earlier failed edit or pipeline into success.
  return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...event.tool_input,command:'set -e -o pipefail\n'+event.tool_input.command}}};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(shellGuardResult(JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,'')))));}
  catch {console.error('Shell 源码检查没有读到有效的工具请求；原命令未执行。');process.exitCode=2;}
}
