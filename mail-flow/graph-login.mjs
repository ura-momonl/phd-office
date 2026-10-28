import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const directory=root=>path.join(root,'.runtime/mail-flow/graph-login');
const literal=text=>"'"+text.replace(/'/g,"''")+"'";
async function launchWindowsLogin(root,account,folder,{calendar=false}={}) {
  const executable=path.join(root,'.runtime/mail-flow/graph-sdk/powershell-7.6.7/pwsh.exe');
  const args=['-NoProfile','-NonInteractive','-File',path.join(root,'mail-flow/graph-session.ps1'),'-Mode','login','-Root',path.resolve(root),'-Account',account,'-StatusFile',path.join(folder,'status.json')];
  if(calendar)args.push('-Calendar');
  // Direct Node detached=true makes this pwsh build exit without executing its script.
  // Use Windows' owning launch API instead: an independent, hidden Start-Process.
  const argumentsLiteral=args.map(arg=>literal('"'+arg.replace(/"/g,'\\"')+'"')).join(',');
  const command="$ErrorActionPreference='Stop'; $child=Start-Process -FilePath "+literal(executable)+
    ' -ArgumentList @('+argumentsLiteral+') -WorkingDirectory '+literal(root)+
    ' -WindowStyle Hidden -RedirectStandardOutput '+literal(path.join(folder,'output.txt'))+
    ' -RedirectStandardError '+literal(path.join(folder,'startup-error.txt'))+' -PassThru; $child.Id';
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',part=>output+=part);child.stderr.resume();
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const pid=Number(output.trim());if(code!==0||!Number.isInteger(pid)||pid<1)throw new Error('Windows could not start the hidden Graph login worker; no new login confirmed');
  return pid;
}
function current(root) {
  const base=directory(root),pointer=path.join(base,'current.json');
  if(!fs.existsSync(pointer))return null;
  const record=JSON.parse(fs.readFileSync(pointer,'utf8'));
  if(!/^[a-f0-9-]{36}$/.test(record.id))throw new Error('Invalid Graph login reference');
  return {...record,folder:path.join(base,record.id)};
}
export function graphLoginStatus(root) {
  const record=current(root);if(!record)return {state:'not_started'};
  const statusFile=path.join(record.folder,'status.json');
  let status=fs.existsSync(statusFile)?JSON.parse(fs.readFileSync(statusFile,'utf8')):{state:'starting'};
  if(!['authenticated','failed'].includes(status.state)) {
    let alive=true;try{process.kill(record.pid,0);}catch(error){alive=error.code==='EPERM';}
    if(!alive)return {state:'interrupted',id:record.id,account:record.account,reason:'Login worker exited without a success record; do not infer authorization'};
    const out=path.join(record.folder,'output.txt'),text=fs.existsSync(out)?fs.readFileSync(out,'utf8'):'';
    const matches=[...text.matchAll(/code\s+([A-Z0-9]{6,})\s+to authenticate/g)];
    if(matches.length)status={...status,state:'waiting_for_user',device_url:'https://login.microsoft.com/device',user_code:matches.at(-1)[1]};
  }
  return {id:record.id,account:record.account,...status};
}
export async function startGraphLogin(root,account,{launch=launchWindowsLogin,calendar=false}={}) {
  if(process.env.PHD_ISOLATED_TESTS&&launch===launchWindowsLogin)throw new Error('Real Graph login is disabled in isolated tests');
  const previous=graphLoginStatus(root);
  // Reuse a live login; never issue a new code merely because the assistant turn changed.
  if(previous.account?.toLowerCase()===account.toLowerCase()&&
    (['starting','waiting_for_user'].includes(previous.state)||previous.state==='authenticated'&&(!calendar||previous.scopes?.includes('Calendars.ReadWrite'))))return previous;
  const id=randomUUID(),folder=path.join(directory(root),id);fs.mkdirSync(folder,{recursive:true});
  const pid=await launch(root,account,folder,{calendar});
  fs.writeFileSync(path.join(directory(root),'current.json'),JSON.stringify({id,pid,account,started_at:new Date().toISOString()})+'\n');
  // Only a short bounded startup wait, not a background poller or an automatic retry.
  for(let n=0;n<40;n++) {
    const status=graphLoginStatus(root);if(status.state!=='starting')return status;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return graphLoginStatus(root);
}
