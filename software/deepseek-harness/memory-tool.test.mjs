import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {root} from '../../automation/files.mjs';
import {maintenanceRequest,maintainMemory,apply} from './memory-tool.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const setup=t=>{
  const prior=process.env.OFFICE_MEMORY_OWNER;process.env.OFFICE_MEMORY_OWNER='deepseek';
  const directory=fs.mkdtempSync(path.join(root,'.runtime/maintenance-fixture-'));
  t.after(()=>{if(prior===undefined)delete process.env.OFFICE_MEMORY_OWNER;else process.env.OFFICE_MEMORY_OWNER=prior;fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
};
function fakeLaunch(report,{code=0,error,onSpawn=()=>{}}={}) {
  return (...args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    onSpawn(child,args);
    queueMicrotask(()=>{
      if(error)child.emit('error',Object.assign(new Error(error),{code:error}));
      if(report!==undefined)child.stdout.end(JSON.stringify(report));
      child.emit('close',code);
    });return child;
  };
}
test('maintenance only accepts own fixed operations and action-specific options',()=>{
  assert.deepEqual(maintenanceRequest({action:'ingest',limit:1,facts:false}),{action:'ingest',request:{owner:'deepseek',limit:1,facts:false}});
  for(const action of ['status','reflect','profile'])assert.equal(maintenanceRequest({action}).request.owner,'deepseek');
  assert.deepEqual(maintenanceRequest({action:'search',query:'之前的决定',maxRounds:1,topK:3,chars:100}),{action:'search',request:{owner:'deepseek',query:'之前的决定',topK:3,chars:100,method:'agentic',tune:{retries:0,maxRounds:1}}});
  assert.equal(maintenanceRequest({action:'search',query:'q'}).request.tune.retries,0);
  for(const args of [{action:'show'},{action:'ingest',owner:'claude'},{action:'reflect',command:'x'},{action:'status',maxCalls:1},{action:'ingest',limit:0},{action:'profile',maxCalls:1.2},{action:'ingest',since:'invalid'},{action:'ingest',facts:'yes'},{action:'search'},{action:'search',query:' '},{action:'search',query:'q',owner:'codex'},{action:'search',query:'q',method:'keyword'},{action:'search',query:'q',tune:{}},{action:'search',query:'q',maxRounds:4},{action:'search',query:'q',chars:0},{action:'status',query:'q'}])assert.throws(()=>maintenanceRequest(args));
});
test('tool uses pinned CLI, UTF-8 request and stripped environment; success keeps evidence',async t=>{
  const directory=setup(t);process.env.FIXTURE_API_KEY='not-for-the-child';t.after(()=>delete process.env.FIXTURE_API_KEY);
  const result=await maintainMemory({action:'profile',maxCalls:1},{directory,spawnImpl:fakeLaunch({calls:1,error:null,summary:'中文回环'}, {onSpawn:(_child,[exe,args,opts])=>{
    assert.equal(exe,process.execPath);assert.deepEqual(args.slice(0,3),[path.join(root,'automation/run.mjs'),'memory2','profile']);
    assert.deepEqual(JSON.parse(fs.readFileSync(args[3],'utf8')),{maxCalls:1,owner:'deepseek'});
    assert.equal(opts.shell,undefined);assert.equal(opts.env.OFFICE_MEMORY_OWNER,'deepseek');assert.equal(opts.env.FIXTURE_API_KEY,undefined);
  }})});
  assert.match(result.report,/中文回环/);assert.equal(JSON.parse(fs.readFileSync(result.resultFile,'utf8')).ok,true);
});
test('startup failure, CLI nonzero and zero-exit domain errors stay failures with no retry',async t=>{
  const directory=setup(t);
  for(const [report,options] of [[undefined,{error:'EPERM',code:-1}],[{calls:0},{code:1}],[{error:'model failed'},{}],[{failures:['bad']},{}],[{facts_backfill:{failures:['bad']}},{}],[{skipped:[{reason:'spawn EPERM'}]},{}],[{reports:[{fact_error:'model failed'}]},{}],[undefined,{}]]) {
    let calls=0;
    await assert.rejects(maintainMemory({action:'profile'},{directory,spawnImpl:fakeLaunch(report,{...options,onSpawn:()=>calls++})}),/记忆维护未完成/);
    assert.equal(calls,1);
  }
});

test('agentic search uses the existing CLI; fallback results remain a failed tool result with evidence',async t=>{
  const directory=setup(t);
  const result=await maintainMemory({action:'search',query:'中文回溯',maxRounds:1},{directory,spawnImpl:fakeLaunch({method:'agentic',failed_rounds:0,items:[{entry_id:'ep_fixture'}]},{onSpawn:(_child,[_exe,args])=>{
    assert.equal(args[2],'search');
    assert.deepEqual(JSON.parse(fs.readFileSync(args[3],'utf8')),{query:'中文回溯',owner:'deepseek',method:'agentic',tune:{retries:0,maxRounds:1}});
  }})});
  assert.equal(JSON.parse(result.report).items[0].entry_id,'ep_fixture');
  await assert.rejects(maintainMemory({action:'search',query:'q'},{directory,spawnImpl:fakeLaunch({failed_rounds:1,rounds:[{failed:true,error:'spawn EPERM'}],items:[{entry_id:'ep_fallback'}]})}),/spawn EPERM/);
  const reports=fs.readdirSync(path.join(directory,'memory-maintenance')).map(id=>JSON.parse(fs.readFileSync(path.join(directory,'memory-maintenance',id,'result.json'),'utf8')));
  const failed=reports.find(r=>!r.ok);assert.equal(failed.report.items[0].entry_id,'ep_fallback');
});
test('other owners, cancellation and simultaneous maintenance do not launch work',async t=>{
  const directory=setup(t);let calls=0;const spawnImpl=()=>{calls++;throw new Error('unexpected launch');};
  process.env.OFFICE_MEMORY_OWNER='codex';await assert.rejects(maintainMemory({action:'status'},{directory,spawnImpl}),/本人/);
  process.env.OFFICE_MEMORY_OWNER='deepseek';
  await assert.rejects(maintainMemory({action:'status'},{directory,spawnImpl,signal:AbortSignal.abort()}),/停止/);
  await assert.rejects(maintainMemory({action:'status'},{directory,spawnImpl,active:new Set([{}])}),/已有/);
  assert.equal(calls,0);
});
test('cancel stops the active process tree and records stopped instead of success',async t=>{
  const directory=setup(t),controller=new AbortController(),active=new Set();let stopped=0;
  await assert.rejects(maintainMemory({action:'profile'},{directory,active,signal:controller.signal,
    spawnImpl:fakeLaunch({calls:1},{onSpawn:()=>queueMicrotask(()=>controller.abort())}),stop:()=>stopped++}),/未完成/);
  assert.equal(stopped,1);assert.equal(active.size,0);
  const [job]=fs.readdirSync(path.join(directory,'memory-maintenance'));assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'memory-maintenance',job,'result.json'),'utf8')).stopped,true);
});
test('native plugin registers a visible tool with rendered report and lifecycle cleanup',t=>{
  const directory=setup(t);let tool,dispose;
  apply({on:(event,fn)=>{assert.equal(event,'dispose');dispose=fn;},tools:{register:value=>tool=value}},{runDirectory:directory});
  assert.equal(tool.name,'office_memory_maintain');assert.deepEqual(tool.parameters.required,['action']);
  assert.equal(tool.parameters.type,'object');assert.equal(tool.parameters.additionalProperties,false);
  assert.deepEqual(tool.output.schema.required,['report','resultFile']);
  assert.match(tool.output.render({}, {report:'实际报告',resultFile:'result.json'})[0].text,/实际报告/);dispose();
});
test('actual offline CLI crosses the host-tool boundary without accessing real memories',async t=>{
  const directory=setup(t);
  const result=await maintainMemory({action:'status'},{directory});
  const report=JSON.parse(result.report);assert.equal(report.owner,'deepseek');assert.equal(report.episodes,0);
});
