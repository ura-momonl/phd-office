import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runTask,jobsRoot,readTask} from './run.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use node scripts/run-tests.mjs --sandbox --keep');
const cli=fileURLToPath(new URL('./run.mjs',import.meta.url));
const fixtures=fs.mkdtempSync(path.join(os.tmpdir(),'office-sandbox-fixtures-'));
const write=(p,v)=>fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));
const docker=(args)=>spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:15000});
// Containers created by THIS test copy only: another agent's live session on the same Docker engine must not fail these tests.
const owned=()=>{
  const r=docker(['ps','--all','--filter','label=local.office.sandbox','--format','{{.ID}} {{.Label "local.office.sandbox"}}']);
  assert.equal(r.status,0,r.stderr);
  const mine=new Set(fs.existsSync(jobsRoot)?fs.readdirSync(jobsRoot):[]);
  return r.stdout.split('\n').map(l=>l.trim().split(' ')).filter(([id,label])=>id&&mine.has(label)).map(([id])=>id);
};
const hostPath=p=>'/run/desktop/mnt/host/'+p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>d.toLowerCase());

test('real independent sandbox: boundaries, reuse, failure, timeout and stopping',{timeout:120000},async()=>{
  const outside=path.join(fixtures,'outside.txt');
  write(outside,'KNOWN_HOST_ONLY_CANARY');
  assert.equal(fs.readFileSync(outside,'utf8'),'KNOWN_HOST_ONLY_CANARY');
  const make=(name,script,command=['python3','/input/task.py'],timeoutSeconds=20)=>{
    const input=path.join(fixtures,name);fs.mkdirSync(input);
    write(path.join(input,'task.py'),script);
    write(path.join(input,'private.txt'),name);
    const file=path.join(fixtures,name+'.json');write(file,{input,command,timeoutSeconds});return {input,file};
  };
  const first=make('first',`
import json, os, pathlib, socket, subprocess
p=pathlib.Path
assert p('/input/private.txt').read_text() == 'first'
checks={}
def unreadable(file):
    try: p(file).read_bytes(); return False
    except OSError: return True
checks['host_file_denied']=unreadable(${JSON.stringify(hostPath(outside))})
try: p(${JSON.stringify(hostPath(outside))}).write_text('changed'); checks['host_write_denied']=False
except OSError: checks['host_write_denied']=True
checks['host_auth_unmounted']=unreadable('/run/desktop/mnt/host/c/Users/24193/.codex/auth.json')
checks['docker_socket_unmounted']=unreadable('/var/run/docker.sock')
checks['env_not_inherited']='OFFICE_SANDBOX_CANARY' not in os.environ
try: p('/input/private.txt').write_text('changed'); checks['input_readonly']=False
except OSError: checks['input_readonly']=True
try: p('/etc/office-write').write_text('changed'); checks['root_readonly']=False
except OSError: checks['root_readonly']=True
p('/work/host-link').symlink_to(${JSON.stringify(hostPath(outside))})
checks['container_link_cannot_reach_host']=unreadable('/work/host-link')
checks['node_child']=subprocess.check_output(['node','-e','process.stdout.write(String(6*7))'],text=True)=='42'
for name,host in [('internet','1.1.1.1'),('host_gateway','192.168.65.2')]:
    try:
        s=socket.create_connection((host,443),timeout=1); s.close(); checks[name+'_denied']=False
    except OSError: checks[name+'_denied']=True
checks['only_loopback']=all(line.split(':')[0].strip()=='lo' for line in p('/proc/net/dev').read_text().splitlines()[2:])
p('/work/checks.json').write_text(json.dumps(checks,indent=2))
print(json.dumps(checks))
assert all(checks.values()), checks
`);
  process.env.OFFICE_SANDBOX_CANARY='HOST_ONLY_ENV';
  const a=await runTask(first.file);
  delete process.env.OFFICE_SANDBOX_CANARY;
  assert.equal(a.exitCode,0,JSON.stringify(a));assert.equal(a.cleanedUp,true);
  const checks=JSON.parse(fs.readFileSync(path.join(a.output,'checks.json'),'utf8'));
  assert.equal(Object.values(checks).every(Boolean),true);
  assert.equal(fs.readFileSync(path.join(first.input,'private.txt'),'utf8'),'first');
  const second=make('second',`
from pathlib import Path
assert Path('/input/private.txt').read_text()=='second'
assert not Path(${JSON.stringify(hostPath(path.join(a.directory,'input/private.txt')))}).exists()
assert not Path(${JSON.stringify(hostPath(path.join(a.output,'checks.json')))}).exists()
Path('/work/answer.txt').write_text('second task, clean input')
`);
  const b=await runTask(second.file);assert.equal(b.exitCode,0,JSON.stringify(b));assert.equal(b.cleanedUp,true);
  const bad=make('failure',"import subprocess, sys\nsubprocess.Popen(['node','-e','setInterval(()=>{},1000)'])\nsys.exit(23)\n");
  const failed=await runTask(bad.file);assert.equal(failed.exitCode,23,JSON.stringify(failed));assert.equal(failed.cleanedUp,true);
  const after=await runTask(second.file);assert.equal(after.exitCode,0,JSON.stringify(after));assert.notEqual(after.id,b.id);
  const slow=make('timeout',"import time\ntime.sleep(60)\n",undefined,1);
  const timed=await runTask(slow.file);assert.equal(timed.exitCode,124,JSON.stringify(timed));assert.equal(timed.cleanedUp,true);
  const linked=make('junction','');
  fs.symlinkSync(first.input,path.join(linked.input,'escape'),'junction');
  const rejected=await runTask(linked.file);assert.equal(rejected.exitCode,1);assert.match(rejected.error,/Links|resolves elsewhere/);assert.equal(rejected.containerId,undefined);
  const alias=path.join(fixtures,'alias');fs.symlinkSync(first.input,alias,'junction');
  const invalid=path.join(fixtures,'invalid.json');write(invalid,{input:alias,command:['node','--version']});
  assert.throws(()=>readTask(invalid),/Links|resolves elsewhere/);
  write(invalid,{input:first.input,command:['node','--version'],network:true});assert.throws(()=>readTask(invalid),/Task fields/);
  write(invalid,{input:path.resolve(jobsRoot,'../../..'),command:['node','--version']});assert.throws(()=>readTask(invalid),/separate/);
  const stoppable=make('stop',"import time\ntime.sleep(60)\n");
  const started=Date.now();
  let text='',errors='';
  const child=spawn(process.execPath,[cli,'run',stoppable.file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>errors+=b);
  const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  while(!errors.match(/sandbox job ([a-f0-9-]{36})/)) {
    if(Date.now()-started>15000)throw Error('Stoppable job did not start: '+errors);
    await new Promise(r=>setTimeout(r,50));
  }
  const id=errors.match(/sandbox job ([a-f0-9-]{36})/)[1];
  const stop=spawnSync(process.execPath,[cli,'stop',id],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(stop.status,0,stop.stderr);
  assert.notEqual(await finished,0);const stopped=JSON.parse(text);assert.equal(stopped.cleanedUp,true);
  assert.deepEqual(owned(),[]);
  const report={checks,runs:[a,b,failed,after,timed,rejected,stopped],hostCanaryUnchanged:fs.readFileSync(outside,'utf8')==='KNOWN_HOST_ONLY_CANARY'};
  assert.equal(report.hostCanaryUnchanged,true);
  write(path.join(fixtures,'acceptance.json'),report);
  console.log('sandbox acceptance:',path.join(fixtures,'acceptance.json'));
});

test('session bridge: one tool, offline, read-only input, timeout, cleanup on close',{timeout:120000},async t=>{
  const input=path.join(fixtures,'session-input');fs.mkdirSync(input);
  write(path.join(input,'note.txt'),'SESSION_INPUT');
  const mcp=fileURLToPath(new URL('./mcp.mjs',import.meta.url));
  const child=spawn(process.execPath,[mcp,input],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(()=>child.stdin.end()); // Failed assertions must also close the bridge, not leave the test runner waiting.
  let buffer='';const waiting=new Map();let seq=0;
  child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);waiting.get(m.id)?.(m);}});
  const call=(method,params)=>new Promise(resolve=>{const id=++seq;waiting.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const exec=async(argv,timeoutSeconds)=>(await call('tools/call',{name:'sandbox_exec',arguments:{argv,timeoutSeconds}})).result;
  const text=r=>r.content[0].text;
  assert.equal((await call('initialize',{protocolVersion:'2025-06-18'})).result.serverInfo.name,'office-sandbox');
  const listed=(await call('tools/list')).result.tools;assert.deepEqual(listed.map(t=>t.name),['sandbox_exec']);
  assert.deepEqual(listed[0].annotations,{readOnlyHint:false,destructiveHint:false,openWorldHint:false});
  assert.match(listed[0].description,/host read-only policy does NOT make this container tool read-only/);
  const first=await exec(['bash','-c','cat /input/note.txt; touch /input/x 2>&1; echo kept > /work/f; python3 -c "import socket;socket.create_connection((\'1.1.1.1\',443),3)" 2>&1 | tail -1; id -u']);
  assert.match(text(first),/SESSION_INPUT/);assert.match(text(first),/Read-only file system/);assert.match(text(first),/unreachable|refused|timed out/i);assert.match(text(first),/\n1000\n/);
  assert.match(text(await exec(['cat','/work/f'])),/kept/); // state persists across calls in one session
  const copied=await exec(['bash','-lc','cp -a /input /work/office && printf "updated" > /work/office/note.txt && cat /work/office/note.txt && printf "\\nsource:" && cat /input/note.txt']);
  assert.match(text(copied),/updated\nsource:SESSION_INPUT/,'writable module copy and immutable source are different permission scopes');
  const timed=await exec(['sleep','30'],2);assert.equal(timed.isError,true);assert.match(text(timed),/exit code: 124/);
  assert.match(text(await exec(['echo','after-timeout'])),/after-timeout/);
  const bad=await exec([]);assert.equal(bad.isError,true);
  assert.equal(owned().length,1);
  child.stdin.end();await new Promise(r=>child.once('close',r));
  assert.deepEqual(owned(),[]);
  const job=fs.readdirSync(jobsRoot).map(n=>path.join(jobsRoot,n)).filter(d=>fs.existsSync(path.join(d,'result.json'))&&JSON.parse(fs.readFileSync(path.join(d,'result.json'),'utf8')).kind==='session').at(-1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(job,'result.json'),'utf8')).cleanedUp,true);
  assert.ok(fs.readFileSync(path.join(job,'calls.jsonl'),'utf8').split('\n').filter(Boolean).length>=4);
});

test('session bridge: a killed session is swept by the next one, nothing else is touched',{timeout:120000},async t=>{
  const input=path.join(fixtures,'sweep-input');fs.mkdirSync(input);write(path.join(input,'a.txt'),'a');
  const mcp=fileURLToPath(new URL('./mcp.mjs',import.meta.url));
  const open=async()=>{
    const child=spawn(process.execPath,[mcp,input],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    t.after(()=>child.stdin.end());
    let buffer='';const done=new Promise(resolve=>child.stdout.on('data',b=>{buffer+=b;if(buffer.includes('"id":2'))resolve();}));
    const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
    send({id:1,method:'initialize',params:{}});send({id:2,method:'tools/call',params:{name:'sandbox_exec',arguments:{argv:['true']}}});
    await done;return child;
  };
  const ids=owned;
  const dead=await open();assert.equal(ids().length,1);
  dead.kill();await new Promise(r=>dead.once('close',r));
  assert.equal(ids().length,1,'a killed host leaves its container behind until the next session');
  const next=await open();assert.equal(ids().length,1,'only the new session remains');
  next.stdin.end();await new Promise(r=>next.once('close',r));
  assert.equal(ids().length,0);
});
