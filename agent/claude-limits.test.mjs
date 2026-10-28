import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {read,write} from '../automation/files.mjs';
import {claudeEnvironment,invokeClaude} from './claude.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

function fakeLaunches(t) {
  const launches=[];
  t.mock.method(childProcess,'spawn',(_bin,args,options)=>{
    launches.push({args,env:{...options.env}});
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    const work=args.includes('--input-format');
    child.stdin=new Writable({write(chunk,_encoding,done){
      const request=work ? JSON.parse(chunk.toString()) : null;done();
      setImmediate(()=>{
        child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'limits-fixture',model:'fixture'})+'\n');
        if(request)child.stdout.write(JSON.stringify({...request,type:'user'})+'\n');
        child.stdout.write(JSON.stringify({type:'result',session_id:'limits-fixture',result:'fixture only',usage:{input_tokens:1,output_tokens:1}})+'\n');
      });
    }});
    child.stdin.on('finish',()=>setImmediate(()=>{child.stdout.end();child.emit('close',0);}));
    return child;
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return launches;
}

function fixture(t) {
  const saved=read('agent/config.json'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-limits-'));
  let seq=0;
  t.after(()=>{write('agent/config.json',saved);fs.rmSync(dir,{recursive:true,force:true});});
  return {saved,run:async(mode='work')=>{
    const directory=path.join(dir,String(++seq));fs.mkdirSync(directory);
    return invokeClaude('LIMITS FIXTURE',{directory,mode,model:'fixture',effort:'high'});
  }};
}

test('work passes the configured native concurrent cap and depth to each actual spawn',async t=>{
  const {saved,run}=fixture(t),launches=fakeLaunches(t);
  // A subsequent launch must read the changed setting, rather than a module-load value.
  for(const limit of [1,10,3]) {
    write('agent/config.json',{...saved,subagent_max_concurrency:limit});
    await run();
    const {env,args}=launches.at(-1);
    assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,String(limit));
    assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH,'1');
    assert.equal(env.OFFICE_MEMORY_OWNER,'claude');
    assert.ok(env.OFFICE_MEMORY_RUN_DIR);
    assert.equal(args[args.indexOf('--permission-mode')+1],'auto','limits do not change approvals');
  }
  const withoutLimit={...saved};delete withoutLimit.subagent_max_concurrency;
  write('agent/config.json',withoutLimit);await run();
  assert.equal(launches.at(-1).env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,'10');
  assert.equal(launches.length,4,'only fake processes, no model calls or retries');
});

test('invalid work concurrency settings fail before spawning a native process',async t=>{
  const {saved,run}=fixture(t),launches=fakeLaunches(t);
  for(const limit of [0,-1,11,1.5,'2',false]) {
    write('agent/config.json',{...saved,subagent_max_concurrency:limit});
    await assert.rejects(run(),/Claude 子 agent 并发上限应为 1～10 的整数/);
  }
  assert.equal(launches.length,0);
});

test('ask and existing no-argument environment consumers keep inherited limits unchanged',async t=>{
  const {saved,run}=fixture(t),launches=fakeLaunches(t);
  const names=['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS','CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'];
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const name of names)if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];});
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS='17';
  process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='2';
  write('agent/config.json',{...saved,subagent_max_concurrency:0});
  await run('ask');
  for(const name of names) {
    assert.equal(launches[0].env[name],process.env[name]);
    assert.equal(claudeEnvironment()[name],process.env[name]);
  }
  assert.equal(launches[0].args[launches[0].args.indexOf('--tools')+1],'');
  delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
  delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  await run('ask');
  for(const name of names) {
    assert.equal(Object.hasOwn(launches[1].env,name),false);
    assert.equal(Object.hasOwn(claudeEnvironment(),name),false);
  }
});
