// One-shot timer: node scripts/handoff-at.mjs <UTF-8 schedule JSON>.
// {at: ISO timestamp with offset, request: {title?, text}}.
// Keeps no model running while waiting. The machine must stay awake and the
// office backend must be running at the scheduled time. No retries or recurrence.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
const file=path.resolve(process.argv[2]);
const {at,request}=JSON.parse(fs.readFileSync(file,'utf8'));
const due=Date.parse(at),delay=due-Date.now();
if(!/(Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(due) || delay<=0 || delay>2147483647)
  throw new Error('at must be a future ISO timestamp with timezone, within 24 days');
if(!request?.text?.trim())throw new Error('request.text is required');
if(!['codex','claude'].includes(process.env.OFFICE_MEMORY_OWNER) || !process.env.OFFICE_MEMORY_RUN_DIR)
  throw new Error('Start this timer from the originating assistant work turn');
const stateFile=file+'.state.json',requestFile=file+'.request.json';
const state={at:new Date(due).toISOString(),pid:process.pid,status:'scheduled',
  source:process.env.OFFICE_MEMORY_RUN_DIR,created_at:new Date().toISOString()};
fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n',{encoding:'utf8',flag:'wx'});
const save=patch=>{Object.assign(state,patch);fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n','utf8');};
try {
  fs.writeFileSync(requestFile,JSON.stringify(request,null,2)+'\n','utf8');
  await sleep(Math.max(0,due-Date.now()));
  save({status:'triggered',triggered_at:new Date().toISOString()});
  const child=spawn(process.execPath,['automation/run.mjs','agent','handoff',requestFile],
    {cwd:root,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  if(code!==0)throw new Error(stderr.trim() || `agent handoff exited ${code}`);
  save({status:'queued',queued_at:new Date().toISOString(),job:JSON.parse(stdout)});
} catch(error) {
  save({status:'failed',failed_at:new Date().toISOString(),error:error.message});
  console.error(error.message);process.exitCode=1;
}
