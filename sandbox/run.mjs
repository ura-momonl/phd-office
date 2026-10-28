import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
export const jobsRoot=path.resolve(here,'../.runtime/sandbox/jobs');
export const context=['--context','desktop-linux'];
export const image='office-sandbox:1';
const ownerLabel='local.office.sandbox';
export const within=(parent,child)=>{const r=path.relative(parent,child);return !r || (!r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r));};
export const json=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');

// One container recipe for one-shot jobs and sessions: offline, non-root, read-only input at /input, fresh /work.
export function createArgs(id,dir,runtimeId,entry) {
  return ['create','--pull=never','--name',`office-sbx-${id}`,'--label',`${ownerLabel}=${id}`,
    '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--pids-limit=128','--memory=1g','--cpus=2','--init','--user=1000:1000',
    '--workdir=/work','--env=HOME=/tmp','--tmpfs=/tmp:rw,noexec,nosuid,size=128m',
    '--mount',`type=bind,source=${path.join(dir,'input')},target=/input,readonly`,
    '--mount',`type=bind,source=${path.join(dir,'output')},target=/work`,
    '--entrypoint',entry[0],runtimeId,...entry.slice(1)];
}

export function docker(args,{check=true}={}) {
  const p=spawnSync('docker',[...context,...args],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
  if(check && (p.error || p.status!==0))throw Error(p.error?.message || p.stderr?.trim() || `docker exited ${p.status}`);
  return p;
}

export function plainPath(file) {
  const absolute=path.resolve(file);
  let part=absolute;
  while(true) {
    const s=fs.lstatSync(part);
    if(s.isSymbolicLink())throw Error(`Links/reparse paths are not accepted: ${part}`);
    const parent=path.dirname(part);
    if(parent===part)break;
    part=parent;
  }
  if(path.resolve(fs.realpathSync(absolute)).toLowerCase()!==absolute.toLowerCase())throw Error(`Path resolves elsewhere: ${absolute}`);
  return absolute;
}

export function copyInput(source,destination) {
  plainPath(source);
  const stat=fs.lstatSync(source);
  if(stat.isDirectory()) {
    fs.mkdirSync(destination);
    for(const item of fs.readdirSync(source))copyInput(path.join(source,item),path.join(destination,item));
  } else if(stat.isFile())fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);
  else throw Error(`Only ordinary files and directories are accepted: ${source}`);
}

export function readTask(file) {
  const task=JSON.parse(fs.readFileSync(plainPath(file),'utf8').replace(/^\uFEFF/,''));
  if(!task || Array.isArray(task) || Object.keys(task).some(k=>!['input','command','timeoutSeconds'].includes(k)))throw Error('Task fields: input, command, timeoutSeconds only');
  if(typeof task.input!=='string' || !task.input)throw Error('input must name an explicit input directory');
  if(!Array.isArray(task.command) || !task.command.length || task.command.some(s=>typeof s!=='string' || s.includes('\0')) || !task.command[0])throw Error('command must be a nonempty argv array');
  const timeoutSeconds=task.timeoutSeconds ?? 120;
  if(!Number.isInteger(timeoutSeconds) || timeoutSeconds<1 || timeoutSeconds>3600)throw Error('timeoutSeconds must be an integer from 1 to 3600');
  const input=plainPath(path.resolve(path.dirname(file),task.input));
  if(!fs.statSync(input).isDirectory())throw Error('input must be a directory');
  if(within(input,jobsRoot) || within(jobsRoot,input))throw Error('Input and private job storage must be separate');
  return {input,command:task.command,timeoutSeconds};
}

export function verifyEngine() {
  const endpoint=JSON.parse(docker(['context','inspect','desktop-linux','--format','{{json .Endpoints.docker.Host}}']).stdout);
  if(endpoint!=='npipe:////./pipe/dockerDesktopLinuxEngine')throw Error('Expected the local Docker Desktop Linux named pipe; refusing another engine');
  if(docker(['info','--format','{{.OSType}}']).stdout.trim()!=='linux')throw Error('Linux containers are required');
}

export function removeOwned(id,containerId) {
  if(!/^[a-f0-9]{64}$/.test(containerId))throw Error('Invalid container identity');
  const found=docker(['inspect',containerId],{check:false});
  if(found.status!==0) {
    // A missing container is already stopped; other engine errors must remain visible.
    if(/No such (object|container)/i.test(found.stderr))return;
    throw Error(found.error?.message || found.stderr || 'Cannot verify container ownership');
  }
  const container=JSON.parse(found.stdout)[0];
  if(container.Config.Labels?.[ownerLabel]!==id)throw Error('Container ownership does not match this job');
  docker(['rm','--force',containerId]);
}

export async function runTask(taskFile) {
  let existing=jobsRoot;
  while(!fs.existsSync(existing))existing=path.dirname(existing);
  plainPath(existing);
  fs.mkdirSync(jobsRoot,{recursive:true});
  plainPath(jobsRoot);
  const id=randomUUID(),dir=path.join(jobsRoot,id);
  fs.mkdirSync(dir);
  const result={id,startedAt:new Date().toISOString(),directory:dir,output:path.join(dir,'output'),stage:'preparing',exitCode:null,cleanedUp:false};
  const save=()=>json(path.join(dir,'result.json'),result);
  let containerId;
  const control=new AbortController();
  const interrupt=()=>control.abort();
  process.once('SIGINT',interrupt);
  process.once('SIGTERM',interrupt);
  try {
    save();
    const task=readTask(path.resolve(taskFile));
    copyInput(task.input,path.join(dir,'input'));
    fs.mkdirSync(result.output);
    verifyEngine();
    const runtime=JSON.parse(docker(['image','inspect',image]).stdout)[0];
    result.imageId=runtime.Id;
    json(path.join(dir,'task.json'),task);
    containerId=docker(createArgs(id,dir,runtime.Id,task.command)).stdout.trim();
    result.containerId=containerId;result.stage='created';save();
    console.error(`sandbox job ${id}\noutput: ${result.output}`);
    const logs={};
    for(const name of ['stdout','stderr'])logs[name]=fs.openSync(path.join(dir,name+'.log'),'wx');
    try {
      result.stage='running';save();
      result.exitCode=await new Promise((resolve,reject)=>{
        const child=spawn('docker',[...context,'start','--attach',containerId],{windowsHide:true,stdio:['ignore',logs.stdout,logs.stderr]});
        let timeout=false;
        const timer=setTimeout(()=>{timeout=true;child.kill();},task.timeoutSeconds*1000);
        const abort=()=>child.kill();
        control.signal.addEventListener('abort',abort,{once:true});
        const release=()=>{clearTimeout(timer);control.signal.removeEventListener('abort',abort);};
        child.once('error',e=>{release();reject(e);});
        child.once('close',code=>{release();resolve(control.signal.aborted?130:timeout?124:code ?? 1);});
      });
      result.stage='finished';
    } finally {for(const fd of Object.values(logs))fs.closeSync(fd);}
  } catch(e) {result.error=e.message;result.exitCode=1;result.stage='failed';}
  finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    try {if(containerId)removeOwned(id,containerId);result.cleanedUp=true;}
    catch(e){result.cleanupError=e.message;result.exitCode=1;}
    result.finishedAt=new Date().toISOString();save();
  }
  return result;
}

function stop(id) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Expected a job UUID');
  const dir=plainPath(path.join(jobsRoot,id));
  const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  if(result.id!==id || !result.containerId)throw Error('No owned container recorded');
  removeOwned(id,result.containerId);
  result.cleanedUp=true;result.stoppedAt=new Date().toISOString();delete result.cleanupError;
  if(result.exitCode===null){result.exitCode=130;result.stage='stopped';}
  json(path.join(dir,'result.json'),result);
  console.log('Stopped owned container; input, output and evidence retained.');
}

export async function main(args=process.argv.slice(2)) {
  const [action,file]=args;
  if(action==='run' && args.length===2) {
    const result=await runTask(file);console.log(JSON.stringify(result,null,2));process.exitCode=result.exitCode;
  } else if(action==='stop' && args.length===2)stop(file);
  else if(action==='build' && args.length===1) {
    verifyEngine();
    const p=spawnSync('docker',[...context,'build','--tag',image,here],{windowsHide:true,stdio:'inherit'});
    if(p.error)throw p.error;process.exitCode=p.status ?? 1;
  } else if(!action || action==='help')console.log('node sandbox/run.mjs build\nnode sandbox/run.mjs run <task.json>\nnode sandbox/run.mjs stop <job-uuid>');
  else throw Error('Use help; no host execution or alternate backend fallback is provided');
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
