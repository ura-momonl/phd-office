import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root} from '../../automation/files.mjs';
import {prepare,delegate} from './run.mjs';
import {sdkPython} from './python.mjs';
import {connectionStatus,selectConnection} from './connection.mjs';

const cli=(...args)=>spawnSync(process.execPath,[path.join(root,'automation/run.mjs'),...args],{cwd:root,encoding:'utf8',windowsHide:true});

test('DeepSeek public discovery and status never start a runtime or expose credentials',()=>{
  const runtime=path.join(root,'.runtime/deepseek-harness');
  const entries=()=>fs.existsSync(runtime) ? fs.readdirSync(runtime,{recursive:true}).sort() : null;
  const before=entries();
  const help=cli('help','deepseek');assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/prepare/);
  const r=cli('deepseek','status');assert.equal(r.status,0,r.stderr);
  const status=JSON.parse(r.stdout);assert.equal(status.installed,false);assert.equal(status.credential_configured,false);
  assert.equal(status.automatic,false);assert.equal(status.session_log_upload,false);assert.equal(status.approval,'never');
  assert.deepEqual(entries(),before,'discovery cannot create or modify runtime entries, even after another fixture used the directory');
});

test('prepare preserves Unicode and relative task content, but exposes only metadata',()=>{
  assert.equal(process.env.PHD_ISOLATED_TESTS,'1');
  const dir=fs.mkdtempSync(path.join(root,'.runtime/deepseek-fixture-'));
  try {
    fs.writeFileSync(path.join(dir,'task.txt'),'\uFEFF中文任务：只分析，不发送。');
    const file=path.join(dir,'request.json');fs.writeFileSync(file,JSON.stringify({prompt_file:'task.txt'}));
    const task=prepare(file);assert.equal(task.prompt,'中文任务：只分析，不发送。');assert.equal(task.model,'deepseek-flash');
    const r=cli('deepseek','prepare',file);assert.equal(r.status,0,r.stderr);const preview=JSON.parse(r.stdout);
    assert.equal(preview.prompt_sha256,task.prompt_sha256);assert.equal(preview.model_invoked,false);assert.ok(!Object.hasOwn(preview,'prompt'));
    assert.equal(preview.automatic_retry,false);assert.equal(preview.subagents,false);
    for(const bad of [{prompt_file:'task.txt',cwd:'C:/'},{prompt_file:'task.txt',api_key:'fixture-secret'},
      {prompt_file:'task.txt',max_tokens:0},{prompt_file:'task.txt',reasoning_effort:''},{prompt_file:'task.txt',model:'bad model'},{}]) {
      fs.writeFileSync(file,JSON.stringify(bad));assert.throws(()=>prepare(file));
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('provider selection uses separate credentials, never echoes keys and never silently falls back',()=>{
  const selected=path.join(root,'.runtime/deepseek-harness/provider.json');
  const key=path.join(root,'.runtime/commandcode/credentials.json');
  try {
    assert.equal(connectionStatus().transport,'official');
    assert.throws(()=>selectConnection('commandcode'),/凭据/);
    fs.mkdirSync(path.dirname(key),{recursive:true});
    fs.writeFileSync(key,JSON.stringify({api_key:'fixture-commandcode-secret',base_url:'https://api.commandcode.ai/provider/v1'}));
    const r=cli('deepseek','provider','commandcode');assert.equal(r.status,0,r.stderr);
    assert.doesNotMatch(r.stdout,/fixture-commandcode-secret/);
    assert.equal(connectionStatus().transport,'commandcode');
    fs.rmSync(key);assert.equal(connectionStatus().credential_configured,false);
    assert.equal(connectionStatus().transport,'commandcode');
    assert.throws(()=>selectConnection('unknown'),/provider/);
  } finally {fs.rmSync(key,{force:true});fs.rmSync(selected,{force:true});}
});

test('real calls are refused in isolated test copies before credentials or runtime access',async()=>{
  await assert.rejects(delegate('does-not-exist.json'),/disabled/);
  const r=cli('deepseek','run','does-not-exist.json');assert.notEqual(r.status,0);assert.match(r.stderr,/disabled/);
});

test('SDK result handling, failure evidence and redaction without installing or invoking a model',()=>{
  const r=spawnSync('python',['-m','unittest','discover','-s',path.join(root,'software/deepseek-harness'),'-p','test_delegate.py'],
    {cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(r.status,0,r.stderr || r.error?.message);assert.match(r.stderr,/Ran \d+ tests/);
});

test('formal chat uses native user-global home and separates persona from office requirements',()=>{
  const chat=fs.readFileSync(path.join(root,'software/deepseek-harness/chat.py'),'utf8');
  const patch=fs.readFileSync(path.join(root,'software/deepseek-harness/chat.patch.yml'),'utf8');
  assert.match(chat,/dsh_home=Path\.home\(\) \/ "\.dsh"/);
  assert.match(chat,/prompts\/office-system\.md/);
  assert.doesNotMatch(patch,/personaPrefix/);
  const system=fs.readFileSync(path.join(root,'prompts/office-system.md'),'utf8');
  assert.match(system,/科研工作助手/);
  assert.doesNotMatch(system,/大肥鱼|小鲸鱼娘|QQ群友/);
  assert.match(fs.readFileSync(path.join(root,'software/deepseek-harness/ask.patch.yml'),'utf8'),/id: agent-instructions\s+disabled: true/);
});

test('Windows SDK host uses the venv base interpreter and the exact installed packages, not its Low-labelled launcher',()=>{
  const dir=fs.mkdtempSync(path.join(root,'.runtime/python-host-fixture-'));
  try {
    const base=path.join(dir,'base-python.exe');fs.writeFileSync(base,'fixture');
    fs.writeFileSync(path.join(dir,'pyvenv.cfg'),`home = fixture\nexecutable = ${base}\n`);
    assert.deepEqual(sdkPython(dir,{platform:'win32'}),{executable:base,environment:{PYTHONPATH:path.join(dir,'Lib/site-packages'),VIRTUAL_ENV:dir}});
    assert.deepEqual(sdkPython(dir,{platform:'linux'}),{executable:path.join(dir,'bin/python'),environment:{}});
    fs.writeFileSync(path.join(dir,'pyvenv.cfg'),'home = fixture\n');assert.throws(()=>sdkPython(dir,{platform:'win32'}),/missing/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('ask keeps the installed OPS tool components disabled without changing work mode',()=>{
  const ask=fs.readFileSync(path.join(root,'software/deepseek-harness/ask.patch.yml'),'utf8');
  const work=fs.readFileSync(path.join(root,'software/deepseek-harness/chat.patch.yml'),'utf8');
  for(const id of ['dsh-ops-shell','dsh-ops-file','dsh-ops-ptc','dsh-ops-discovery']) {
    assert.match(ask,new RegExp(`id: ${id}\\s+disabled: true`));
    assert.doesNotMatch(work,new RegExp(`id: ${id}\\s+disabled: true`));
  }
});
