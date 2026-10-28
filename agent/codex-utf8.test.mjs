import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root} from '../automation/files.mjs';
import {codexUtf8Result,readEncodingPlan,rewritePowerShell,utf8Setup} from './codex-utf8.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const windows={skip:process.platform!=='win32'};
const event=command=>({hook_event_name:'PreToolUse',tool_name:'Bash',cwd:root,tool_input:{command,description:'fixture',sandbox_permissions:'require_escalated',justification:'fixture approval',timeout_ms:10000}});
const ps=command=>spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true});
const q=s=>"'"+s.replaceAll("'","''")+"'";

test('only text command changes; scope, permissions and explicit shell fields are preserved',()=>{
  const e=event('Get-Content file.md'),opts={platform:'win32',rewrite:s=>'FIXED '+s};
  const out=codexUtf8Result(e,opts).hookSpecificOutput;
  assert.equal(out.permissionDecision,'allow');assert.deepEqual(out.updatedInput,{...e.tool_input,command:'FIXED '+e.tool_input.command});
  assert.deepEqual(codexUtf8Result(e,{...opts,rewrite:s=>s}),{});
  for(const item of [{...e,hook_event_name:'PermissionRequest'},{...e,cwd:path.dirname(root)},{...e,cwd:undefined},{...e,tool_input:{...e.tool_input,shell:'C:/Program Files/Git/bin/bash.exe'}}])assert.deepEqual(codexUtf8Result(item,opts),{});
  assert.deepEqual(codexUtf8Result(e,{...opts,platform:'linux'}),{});
  assert.equal(codexUtf8Result(e,{...opts,rewrite:()=>{throw new Error('parser failure');}}).hookSpecificOutput.permissionDecision,'deny');
});

test('AST inserts only omitted literal read encodings, leaving explicit encodings, splats and data intact',windows,()=>{
  for(const command of ['Get-Content file.md','gc file.md','cat file.md','Microsoft.PowerShell.Management\\Get-Content file.md','& "Get-Content" file.md']){
    assert.equal(readEncodingPlan(command).edits.length,1,command);
    assert.match(rewritePowerShell(command),/-Encoding UTF8/);
  }
  for(const command of ['Get-Content file.md -Encoding UTF8','gc file.md -enc Unicode','Get-Content file -Encoding Byte','Get-Content file -AsByteStream','Get-Content @options'])assert.equal(readEncodingPlan(command).edits.length,0,command);
  for(const command of ['"Get-Content file.md"','# Get-Content file.md\nnode --version',"node -e 'console.log(1)'"])assert.equal(rewritePowerShell(command),command);
  const mixed='Get-Content a -Encoding Unicode; Get-Content b';
  const rewritten=rewritePowerShell(mixed);
  assert.match(rewritten,/Get-Content a -Encoding Unicode; Get-Content -Encoding UTF8 b/);
});

test('rewrite is idempotent, handles existing transport setup, and uses UTF-16 AST offsets',windows,()=>{
  const command="$label='😀中文'; Get-Content file.md";
  const rewritten=rewritePowerShell(command);assert.equal(rewritePowerShell(rewritten),rewritten);
  assert.ok(rewritten.includes("$label='😀中文'; Get-Content -Encoding UTF8 file.md"));
  const existing=utf8Setup+'\nGet-Content file.md';
  const fixed=rewritePowerShell(existing);assert.equal(fixed.split(utf8Setup).length-1,1);assert.match(fixed,/Get-Content -Encoding UTF8 file.md/);
});

test('the actual installed launch syntax returns a rewrite under NoProfile',windows,()=>{
  const command='node "'+path.join(root,'agent/codex-utf8.mjs').replaceAll('\\','/')+'"';
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{input:JSON.stringify(event('Get-Content file.md')),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision,'allow');assert.match(out.updatedInput.command,/Get-Content -Encoding UTF8 file.md/);
});

test('real Windows reads and native pipes are corrected in one execution without changing source files',windows,()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'office-auto-utf8-'));
  try{
    const file=path.join(directory,'source.md'),consumer=path.join(directory,'consume.mjs'),text='文献 粗筛“二维材料” 😀';
    fs.writeFileSync(file,text,'utf8');fs.writeFileSync(consumer,"import fs from 'node:fs';console.log(JSON.stringify(fs.readFileSync(0,'utf8').trim()));");
    const original=fs.readFileSync(file),command=`Get-Content -Raw -LiteralPath ${q(file)} | & ${q(process.execPath)} ${q(consumer)}`;
    const bad=ps(command),good=ps(rewritePowerShell(command));
    assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout),text);assert.notEqual(bad.stdout,good.stdout);
    assert.ok(fs.readFileSync(file).equals(original));
    const bytes=ps(rewritePowerShell(`(Get-Content -Raw -Encoding Byte -LiteralPath ${q(file)}).Length`));
    assert.equal(bytes.status,0,bytes.stderr);assert.equal(Number(bytes.stdout.trim()),Buffer.byteLength(text));
    const unicode=path.join(directory,'utf16.txt');fs.writeFileSync(unicode,Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')]));
    const explicit=ps(rewritePowerShell(`Get-Content -Raw -Encoding Unicode -LiteralPath ${q(unicode)}`));
    assert.equal(explicit.status,0,explicit.stderr);assert.equal(explicit.stdout.trim(),text);
    for(const header of ['param($unused)\n','using namespace System\n']){
      const result=ps(rewritePowerShell(header+`Get-Content -Raw -LiteralPath ${q(file)}`));
      assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),text);
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
