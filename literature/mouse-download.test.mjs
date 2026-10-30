import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,write} from '../automation/files.mjs';
import {macroStatus,macroStop,localPaper,macroCommand,macroLocalError} from './mouse-download.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use scripts/run-tests.mjs');
const directory=path.join(root,'.runtime/mouse-status-fixture');fs.mkdirSync(directory,{recursive:true});
const save=s=>fs.writeFileSync(path.join(directory,'progress.json'),JSON.stringify({pid:process.pid,updated_at:new Date().toISOString(),...s}));
test('production PowerShell focus and recovery logic survives transient focus and STOP',()=>{
  const r=spawnSync('powershell.exe',['-NoProfile','-File',path.join(root,'literature/mouse-focus-regression.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/PASS:/);
});
test('production queue keeps paper faults local and shared faults alive through recovery and restart',()=>{
  const r=spawnSync('powershell.exe',['-NoProfile','-File',path.join(root,'literature/mouse-queue-regression.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/PASS:/);
});
test('local PDF rejection is not confused with unavailable shared storage or parser',()=>{
  for(const e of [new Error('Requested DOI is not verified by a first-page identifier or title-bound publication DOI evidence; nothing registered'),new Error('File is not a complete PDF'),Object.assign(new Error('damaged'),{pdf_reason:'pdf_structure_invalid'})]) {
    assert.equal(macroLocalError(e).status,'validation_failed');
  }
  for(const e of [Object.assign(new Error('locked'),{code:'EBUSY'}),Object.assign(new Error('parser'),{pdf_reason:'parser_unavailable'}),Object.assign(new Error('parser'),{parser_exit_code:3221225794}),new SyntaxError('Unexpected token in catalog')]) {
    assert.equal(macroLocalError(e).status,'error');
  }
});
test('worker and focus module parse with the actual PowerShell host',()=>{
  for(const name of ['mouse-download.ps1','mouse-focus.ps1']) {
    const file=path.join(root,'literature',name).replaceAll("'","''");
    const r=spawnSync('powershell.exe',['-NoProfile','-Command',`$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e)|Out-Null;if($e.Count){$e;exit 1}`],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  }
});
test('status differentiates paused, dead, stale and complete instead of reporting every run as running',()=>{
  save({status:'waiting_focus',foreground:{title:'Other app'}});assert.equal(macroStatus(directory).status,'waiting_focus');
  save({status:'running',pid:2147483647});assert.equal(macroStatus(directory).status,'interrupted');
  save({status:'running',updated_at:'2020-01-01T00:00:00Z'});assert.equal(macroStatus(directory).stalled,true);
  for(const status of ['waiting_error','waiting_access','waiting_browser']) {
    save({status});assert.equal(macroStatus(directory).status,status);assert.equal(macroStatus(directory).alive,true);
    save({status,pid:2147483647});assert.equal(macroStatus(directory).status,'interrupted');
  }
  save({status:'complete',pid:2147483647});assert.equal(macroStatus(directory).status,'complete');
});
test('stop writes a durable request and macro CLI reports the actual status',()=>{
  save({status:'waiting_focus'});assert.equal(macroStop(directory).stop_requested,true);
  assert.equal(fs.existsSync(path.join(directory,'STOP')),true);
  assert.equal(macroCommand({action:'status',directory}).status,'waiting_focus');
});
test('local reuse never downloads or silently accepts unregistered DOI',()=>{
  write('literature/catalog.json',{papers:[{id:'doi-fixture',doi:'10.5555/missing',title:'Fixture'}]});
  assert.deepEqual(localPaper('10.5555/missing'),{doi:'10.5555/missing',status:'missing'});
  assert.throws(()=>localPaper('10.5555/unknown'),/not registered/);
});
