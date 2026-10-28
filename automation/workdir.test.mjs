import test from 'node:test';
// Writes queues and sessions in the tree it lives in: only in the throw-away copy made by scripts/run-tests.mjs.
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root,read,write } from './files.mjs';
import { codexLaunch } from '../agent/codex.mjs';
import { claudeArgs } from '../agent/claude.mjs';
import { submit,execute } from '../agent/run.mjs';
import { turn as say } from '../prompts/templates.mjs';
import { executeWithoutTitle } from './titleless.mjs';

const run=executeWithoutTitle(execute);
const roots=l=>l.overrides.find(o=>o.startsWith('sandbox_workspace_write.writable_roots='));

test('Codex gets the opened folder as an extra writable root (work turns only); without one nothing changes',()=>{
  const apps=[],all=()=>true,dir='D:\\Users\\me\\Downloads';
  const plain=codexLaunch('聊聊',{apps,exists:all});
  assert.equal(plain.cwd,root);assert.equal(roots(plain),undefined);
  const withDir=codexLaunch('聊聊',{apps,exists:all,workdir:dir});
  assert.equal(withDir.cwd,root);
  const list=JSON.parse(roots(withDir).split('=').slice(1).join('='));
  assert.ok(list.includes('D:/Users/me/Downloads'));assert.ok(list.some(p=>p.replace(/\\/g,'/')===root.replace(/\\/g,'/').replace(/\/$/,'')));
  assert.equal(roots(codexLaunch('聊聊',{apps,exists:all,workdir:dir,mode:'ask'})),undefined);
  // a CAD folder keeps its own roots and gains the opened folder
  const cad=codexLaunch('用 AutoCAD 画图',{apps:[{id:'autocad',working_directory:'D:/cad-ai'}],exists:all,workdir:dir});
  assert.equal(cad.cwd,'D:/cad-ai');assert.match(roots(cad),/D:\/cad-ai|Downloads/);assert.match(roots(cad),/Downloads/);
});

test('Claude gets the opened folder through --add-dir in work turns, never in ask turns',()=>{
  assert.ok(!claudeArgs('sonnet').includes('--add-dir'));
  const args=claudeArgs('sonnet',{addDirs:['D:\\Users\\me\\Downloads']});
  assert.equal(args[args.indexOf('--add-dir')+1],'D:\\Users\\me\\Downloads');
  assert.ok(!claudeArgs('sonnet',{mode:'ask',addDirs:['D:\\x']}).includes('--add-dir'));
});

test('the prompt names the folder and the office root',()=>{
  const text=String(say.workdir('D:/Users/me/Downloads','D:/Main/assistant'));
  assert.match(text,/D:\/Users\/me\/Downloads/);assert.match(text,/D:\/Main\/assistant/);
});

test('a conversation is bound to the folder it was created in; bad folders are refused; the office root is not a workdir; runs receive it',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'piri-workdir-')),other=fs.mkdtempSync(path.join(os.tmpdir(),'piri-other-'));
  const sessionOf=job=>read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id);
  try {
    const first=submit({text:'@Codex 看看这个文件夹',workdir:dir});
    assert.equal(sessionOf(first).workdir,path.resolve(dir));
    // later messages keep the original folder even if another is named
    const second=submit({text:'@Codex 继续',session_id:first.session_id,workdir:other});
    assert.equal(sessionOf(second).workdir,path.resolve(dir));
    assert.throws(()=>submit({text:'@Codex x',workdir:path.join(dir,'nope')}),/工作文件夹不存在/);
    assert.throws(()=>submit({text:'@Codex x',workdir:'relative/path'}),/工作文件夹不存在/);
    const file=path.join(dir,'a.txt');fs.writeFileSync(file,'x');
    assert.throws(()=>submit({text:'@Codex x',workdir:file}),/工作文件夹不存在或不是文件夹/);
    const atRoot=submit({text:'@Codex 在办公室',workdir:root});
    assert.equal(sessionOf(atRoot).workdir,undefined);
    // the runner is told the folder, and the turn prompt mentions it
    let seen;
    await run(first.task_id,async(provider,prompt,opts)=>{seen={workdir:opts.workdir,prompt};return {result:'ok'};});
    assert.equal(seen.workdir,path.resolve(dir));assert.ok(seen.prompt.includes(path.resolve(dir)));
    let plain;
    await run(atRoot.task_id,async(provider,prompt,opts)=>{plain={workdir:opts.workdir,prompt};return {result:'ok'};});
    assert.equal(plain.workdir,undefined);assert.ok(!plain.prompt.includes('工作文件夹'));
  } finally {
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);
    fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true});
  }
});

test('system launch folders are not bound; legacy sessions run without granting the system folder',async()=>{
  const windows=process.env.SystemRoot || process.env.WINDIR;
  if(!windows)return;
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const system=path.join(windows,'System32');
  try {
    const fresh=submit({text:'@Codex 查看办公室',workdir:system});
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===fresh.session_id).workdir,undefined);
    const legacy=submit({text:'@Codex 接续现有对话'});
    const state=read('.runtime/agent/sessions.json');
    state.sessions.find(s=>s.id===legacy.session_id).workdir=system;
    write('.runtime/agent/sessions.json',state);
    let seen;
    await run(legacy.task_id,async(provider,prompt,opts)=>{
      seen={prompt,workdir:opts.workdir,launch:codexLaunch('查看办公室',{apps:[],workdir:opts.workdir})};
      return {result:'ok'};
    });
    assert.equal(seen.workdir,undefined);
    assert.equal(roots(seen.launch),undefined);
    assert.ok(!seen.prompt.includes('工作文件夹'));
    // Historical session data is preserved; only its effective runtime directory changes.
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===legacy.session_id).workdir,system);
  } finally {
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);
  }
});
