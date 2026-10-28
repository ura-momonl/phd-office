import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {root} from '../automation/files.mjs';
import {claudeArgs} from './claude.mjs';
import {shellSourceProblem,shellGuardResult} from './shell-guard.mjs';

const event=command=>({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command}});
const settings=args=>JSON.parse(args[args.indexOf('--settings')+1]);
const bash=()=>{
  if(process.platform!=='win32')return 'bash';
  const git=spawnSync('where.exe',['git'],{encoding:'utf8'}).stdout.trim().split(/\r?\n/)[0];
  const bin=path.resolve(path.dirname(git),'../bin/bash.exe');
  assert.ok(fs.existsSync(bin),'real Git Bash is required for the Windows quote regression');return bin;
};

test('original escaped nested-template incident is refused before touching the test file',()=>{
  const incident=JSON.parse(fs.readFileSync(new URL('./fixtures/shell-template-incident.json',import.meta.url),'utf8'));
  const result=shellGuardResult(event(incident.command));
  assert.equal(result.hookSpecificOutput.permissionDecision,'deny');
  assert.equal(result.hookSpecificOutput.permissionDecisionReason,'SHELL_SOURCE_QUOTING: Node 内联源码引用不安全，命令未执行。');
  assert.doesNotMatch(result.hookSpecificOutput.permissionDecisionReason,/请|Write\/Edit|改用|单引号/);
  assert.match(incident.command,/page\.goto/);
});

test('live expansion in inline Node source is detected without blocking ordinary shell use',()=>{
  for(const cmd of [
    'node -e "console.log(`hello`)"',
    'node --input-type=module --eval "console.log(`${name}`)"',
    'cd /d/Main/assistant && node -e "console.log(\'$NAME\')"',
    'env FIXTURE=1 node.exe --print="`${value}`"',
    'node -e "console.log(\'$(printf hi)\')"',
    '"D:/Program Files/nodejs/node.exe" -p"`hello`"',
    'node -e "console.log(\'\\\\`hello`\')"',
    'node -e "console.log(\\`hello\\`)"',
    'node -e "console.log(\'\\$NAME\')"',
    'cat <<\'EOF\'\nnode -e "`data`"\nEOF\nnode -e "`actually executed`"',
    'cat <<<\'data\'\nnode -e "`actually executed`"',
  ])assert.ok(shellSourceProblem(cmd),cmd);
  for(const cmd of [
    'node scripts/run-tests.mjs --files=automation/chat.test.mjs',
    'node --check automation/chat.test.mjs',
    'node -e \'console.log(`你好${1+1}`)\'',
    'node -e "console.log(1+1)"',
    'node script.mjs -e "$DATA"',
    'echo "$HOME"; printf "`date`"',
    'printf \'%s\' \'node -e "`data`"\'',
    '# node -e "`example`"\nnode --version',
    'cat <<\'EOF\'\nnode -e "`example`"\nEOF',
  ])assert.equal(shellSourceProblem(cmd),null,cmd);
  assert.deepEqual(shellGuardResult({...event('node -e "`hello`"'),tool_name:'Read'}),{});
});

test('work and resume load the shell hook without granting permissions; tool-free asks keep their existing settings',()=>{
  for(const args of [claudeArgs('sonnet'),claudeArgs('sonnet',{resume:'fixture-session'})]) {
    const config=settings(args),rule=config.hooks.PreToolUse[0];
    assert.equal(rule.matcher,'Bash');assert.equal(rule.hooks[0].type,'command');
    assert.ok(rule.hooks[0].command.includes(path.join(root,'agent/shell-guard.mjs').replace(/\\/g,'/')));
    assert.equal(args[args.indexOf('--permission-mode')+1],'auto');
    assert.deepEqual(Object.keys(config),['hooks']);
  }
  assert.ok(!claudeArgs('sonnet',{mode:'ask'}).includes('--settings'));
});

test('safe inputs retain every tool argument and normal approval while preserving shell failures',()=>{
  const input={command:'python edit.py; grep result file.txt',description:'Edit then inspect',timeout:120000,run_in_background:true};
  const result=shellGuardResult({...event(input.command),tool_input:input}).hookSpecificOutput;
  assert.equal(result.permissionDecision,undefined,'input transformation must not auto-approve the action');
  assert.deepEqual(result.updatedInput,{...input,command:'set -e -o pipefail\n'+input.command});
  assert.deepEqual(input.command,'python edit.py; grep result file.txt','do not mutate the requested arguments');
});

test('real Bash no longer masks failed edits or pipelines behind a successful final command',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shell-status-'));
  const run=command=>spawnSync(bash(),['-c',command],{cwd:dir,encoding:'utf8',windowsHide:true});
  const hook=settings(claudeArgs('sonnet')).hooks.PreToolUse[0].hooks[0];
  const transformed=command=>{
    const r=spawnSync(bash(),['-c',hook.command],{cwd:dir,input:JSON.stringify(event(command)),encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision,undefined);return out.updatedInput.command;
  };
  try {
    fs.writeFileSync(path.join(dir,'edit.py'),'raise AssertionError("original edit did not match")\n');
    const edit='python edit.py; printf "WRONGLY_COMPLETED\\n"';
    const before=run(edit);assert.equal(before.status,0);assert.match(before.stderr,/AssertionError/);assert.match(before.stdout,/WRONGLY_COMPLETED/);
    const after=run(transformed(edit));assert.notEqual(after.status,0);assert.match(after.stderr,/AssertionError/);assert.doesNotMatch(after.stdout,/WRONGLY_COMPLETED/);
    const pipe='node -e \'process.exit(7)\' | cat; printf "WRONGLY_COMPLETED\\n"';
    assert.equal(run(pipe).status,0);const failed=run(transformed(pipe));assert.equal(failed.status,7);assert.doesNotMatch(failed.stdout,/WRONGLY_COMPLETED/);
    // Non-zero statuses which the command deliberately handles remain valid.
    const handled=run(transformed('printf "needle\\n" | grep absent || true; printf "HANDLED\\n"'));
    assert.equal(handled.status,0,handled.stderr);assert.match(handled.stdout,/HANDLED/);
    const ordinary=run(transformed('printf "中文\\n"; node -e \'console.log("done")\''));
    assert.equal(ordinary.status,0,ordinary.stderr);assert.match(ordinary.stdout,/中文[\s\S]*done/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('real Bash reproduces source damage; the deployed stdin hook prevents it and safe source survives',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shell-source-'));
  const unsafe="node -e \"require('fs').writeFileSync('victim.mjs', 'page.goto(`printf eaten`);')\"";
  const safe='node -e \'require("fs").writeFileSync("victim.mjs", "page.goto(`printf eaten`); // 中文 ${value}")\'';
  const run=command=>spawnSync(bash(),['-c',command],{cwd:dir,encoding:'utf8',windowsHide:true});
  const hook=settings(claudeArgs('sonnet')).hooks.PreToolUse[0].hooks[0];
  const check=command=>{
    const r=spawnSync(bash(),['-c',hook.command],{cwd:dir,input:JSON.stringify(event(command)),encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  try {
    // Bad control: without the hook Bash silently changes syntactically valid JS.
    assert.equal(run(unsafe).status,0);
    assert.equal(fs.readFileSync(path.join(dir,'victim.mjs'),'utf8'),'page.goto(eaten);');
    fs.writeFileSync(path.join(dir,'victim.mjs'),'untouched');
    const blocked=check(unsafe);
    assert.equal(blocked.hookSpecificOutput.permissionDecision,'deny');
    assert.equal(fs.readFileSync(path.join(dir,'victim.mjs'),'utf8'),'untouched');
    // A correct alternative representation must not be rejected.
    const allowed=check(safe).hookSpecificOutput;assert.equal(allowed.permissionDecision,undefined);
    assert.equal(run(allowed.updatedInput.command).status,0);
    assert.equal(fs.readFileSync(path.join(dir,'victim.mjs'),'utf8'),'page.goto(`printf eaten`); // 中文 ${value}');
    fs.writeFileSync(path.join(dir,'source.mjs'),'import fs from "node:fs"; fs.writeFileSync("victim.mjs", `冷青 ${1+1}`);');
    const script=check('node source.mjs').hookSpecificOutput;assert.equal(script.permissionDecision,undefined);assert.equal(run(script.updatedInput.command).status,0);
    assert.equal(fs.readFileSync(path.join(dir,'victim.mjs'),'utf8'),'冷青 2');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
