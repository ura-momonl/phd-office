// Session bridge: one offline container per run, one MCP tool `sandbox_exec`.
// Usage (spawned by an agent host):  node sandbox/mcp.mjs <input-dir>
// The model runs on the host; command execution is confined to this tool's container.
// Other host tools remain the host's responsibility; do not claim full agent isolation here.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {context,image,jobsRoot,json,docker,createArgs,copyInput,plainPath,verifyEngine,removeOwned,within} from './run.mjs';

const MAX_SESSION_SECONDS=3600,MAX_CALL_SECONDS=300,CAP=30000;

const alive=pid=>{try {process.kill(pid,0);return true;} catch(e) {return e.code==='EPERM';}};

// Agent hosts may kill this process without letting it clean up. Remove only containers whose recorded
// session process is gone (a reused pid just delays cleanup); `sleep` already bounds their lifetime.
function sweepAbandoned() {
  for(const name of fs.readdirSync(jobsRoot)) {
    try {
      const file=path.join(jobsRoot,name,'result.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));
      if(r.kind!=='session' || r.cleanedUp || !r.containerId || !r.pid || r.id!==name || alive(r.pid))continue;
      removeOwned(r.id,r.containerId);
      r.cleanedUp=true;r.stage='abandoned';r.finishedAt=new Date().toISOString();json(file,r);
    } catch {}
  }
}

export async function openSession(inputDir) {
  const input=plainPath(path.resolve(inputDir));
  if(!fs.statSync(input).isDirectory())throw Error('input must be a directory');
  if(within(input,jobsRoot) || within(jobsRoot,input))throw Error('Input and private job storage must be separate');
  fs.mkdirSync(jobsRoot,{recursive:true});plainPath(jobsRoot);
  const id=randomUUID(),dir=path.join(jobsRoot,id);
  fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'output'));
  const result={id,kind:'session',pid:process.pid,startedAt:new Date().toISOString(),directory:dir,output:path.join(dir,'output'),stage:'preparing',exitCode:null,cleanedUp:false};
  const save=()=>json(path.join(dir,'result.json'),result);
  save();
  let containerId;
  try {
    copyInput(input,path.join(dir,'input'));
    verifyEngine();
    sweepAbandoned();
    const runtime=JSON.parse(docker(['image','inspect',image]).stdout)[0];
    result.imageId=runtime.Id;
    // `sleep` bounds the session even if the host dies; it is not a task command.
    containerId=docker(createArgs(id,dir,runtime.Id,['sleep',String(MAX_SESSION_SECONDS)])).stdout.trim();
    result.containerId=containerId;result.stage='created';save();
    docker(['start',containerId]);
    result.stage='running';save();
  } catch(e) {
    result.error=e.message;result.exitCode=1;result.stage='failed';
    try {if(containerId)removeOwned(id,containerId);result.cleanedUp=true;} catch(c){result.cleanupError=c.message;}
    save();throw e;
  }
  const calls=path.join(dir,'calls.jsonl');
  const exec=(argv,seconds)=>new Promise(resolve=>{
    const started=Date.now();
    // `timeout` runs inside the container, so a timed-out command does not outlive the call.
    const child=spawn('docker',[...context,'exec','--workdir=/work',containerId,'timeout','-k','2',String(seconds),...argv],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const out={stdout:'',stderr:''};
    for(const name of ['stdout','stderr'])child[name].on('data',d=>{if(out[name].length<CAP*4)out[name]+=d;});
    const done=(exitCode,error)=>{
      const entry={argv,exitCode,error,ms:Date.now()-started,stdout:out.stdout,stderr:out.stderr};
      fs.appendFileSync(calls,JSON.stringify(entry)+'\n');
      const clip=s=>s.length>CAP?s.slice(0,CAP/2)+`\n…[${s.length-CAP} chars omitted]…\n`+s.slice(-CAP/2):s;
      resolve({exitCode,error,stdout:clip(out.stdout),stderr:clip(out.stderr)});
    };
    child.once('error',e=>done(1,e.message));
    child.once('close',code=>done(code ?? 1));
  });
  let closed=false;
  const close=()=>{
    if(closed)return;closed=true;
    try {removeOwned(id,containerId);result.cleanedUp=true;} catch(e){result.cleanupError=e.message;result.exitCode=1;}
    result.exitCode ??= 0;result.stage='finished';result.finishedAt=new Date().toISOString();save();
  };
  return {id,dir,exec,close};
}

const TOOL={
  name:'sandbox_exec',
  description:'Run one command inside an offline Linux container (Node 24, Python 3.11, bash/coreutils). This tool explicitly permits writes to /work and /tmp; the host read-only policy does NOT make this container tool read-only. /input is immutable source data. To edit office records, copy /input to /work/office once and run the existing modules there. No host files, credentials or network are mounted. Pass argv as an array (no host shell), e.g. ["bash","-lc","cp -a /input /work/office && cd /work/office && ls"]. Returns actual exit code, stdout and stderr; report a permission denial only when an attempted operation actually returns one.',
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  inputSchema:{type:'object',properties:{argv:{type:'array',items:{type:'string'},minItems:1},timeoutSeconds:{type:'integer',minimum:1,maximum:MAX_CALL_SECONDS}},required:['argv'],additionalProperties:false}
};

export async function serve(inputDir) {
  const session=openSession(inputDir);session.catch(()=>{});
  const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  const rl=createInterface({input:process.stdin});
  const work=new Set();
  rl.on('line',line=>{
    let m;try {m=JSON.parse(line);} catch {return;}
    if(m.id===undefined)return; // notifications need no reply
    const task=(async()=>{
      if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:m.params?.protocolVersion || '2025-06-18',capabilities:{tools:{}},serverInfo:{name:'office-sandbox',version:'1'}}});
      if(m.method==='ping')return send({id:m.id,result:{}});
      if(m.method==='tools/list')return send({id:m.id,result:{tools:[TOOL]}});
      if(m.method==='tools/call') {
        const a=m.params?.arguments || {},seconds=a.timeoutSeconds ?? 60;
        if(m.params?.name!==TOOL.name || !Array.isArray(a.argv) || !a.argv.length || a.argv.some(s=>typeof s!=='string' || s.includes('\0')) || !Number.isInteger(seconds) || seconds<1 || seconds>MAX_CALL_SECONDS)
          return send({id:m.id,result:{isError:true,content:[{type:'text',text:'Invalid call: argv must be a nonempty string array; timeoutSeconds 1-'+MAX_CALL_SECONDS}]}});
        try {
          const r=await (await session).exec(a.argv,seconds);
          const text=`exit code: ${r.exitCode}${r.exitCode===124?' (timed out)':''}${r.error?`\nerror: ${r.error}`:''}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
          return send({id:m.id,result:{isError:r.exitCode!==0,content:[{type:'text',text}]}});
        } catch(e) {return send({id:m.id,result:{isError:true,content:[{type:'text',text:'Sandbox session unavailable: '+e.message}]}});}
      }
      send({id:m.id,error:{code:-32601,message:'Method not found'}});
    })();
    work.add(task);task.finally(()=>work.delete(task));
  });
  await new Promise(resolve=>rl.once('close',resolve));
  await Promise.allSettled([...work]);
  try {(await session).close();} catch {}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3){console.error('Usage: node sandbox/mcp.mjs <input-dir>');process.exitCode=2;}
  else serve(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
