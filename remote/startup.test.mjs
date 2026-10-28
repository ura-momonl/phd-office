import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Discord Windows background launch, duplicate reuse, stop and later start in isolated copy',{timeout:60000},()=>{
  assert.equal(process.env.PHD_ISOLATED_TESTS,'1','Use the sanitized test runner');
  if(process.platform!=='win32')return;
  const result=spawnSync('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./Test-Startup.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:55000,env:process.env});
  assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout,/DISCORD LIFECYCLE PASSED/);
});
