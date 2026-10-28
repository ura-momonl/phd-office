import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncToFiles } from './test-spawn.mjs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('hidden VBS launchers run both downloaded entry and sourced helper without an R prompt', {timeout:30000}, async()=>{
  assert.equal(process.env.PHD_ISOLATED_TESTS,'1','Use the sanitized test runner');
  if(process.platform!=='win32')return;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phd-launch-warning-'));
  const zone='[ZoneTransfer]\r\nZoneId=3\r\n';
  try {
    for(const [folder,entry] of [['dashboard','Start-Dashboard'],['remote','Start-Discord']]) {
      const fixture=path.join(dir,folder);fs.mkdirSync(fixture);
      fs.copyFileSync(fileURLToPath(new URL(`../${folder}/${entry}.vbs`,import.meta.url)),path.join(fixture,entry+'.vbs'));
      fs.writeFileSync(path.join(fixture,'Backend.ps1'),"$helperRan = 'helper-ran'\n");
      fs.writeFileSync(path.join(fixture,entry+'.ps1'),`. (Join-Path $PSScriptRoot 'Backend.ps1')\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'receipt.txt'), ($helperRan + ':' + (Get-ExecutionPolicy)))\n`);
      for(const name of [entry+'.ps1','Backend.ps1']) {
        const stream=path.join(fixture,name)+':Zone.Identifier';
        fs.writeFileSync(stream,zone);assert.equal(fs.readFileSync(stream,'utf8'),zone,'fixture really carries the Internet download mark');
      }
      const result=spawnSyncToFiles('wscript.exe',[path.join(fixture,entry+'.vbs')],{windowsHide:true,timeout:5000});
      assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
      const receipt=path.join(fixture,'receipt.txt'),deadline=Date.now()+10000;
      while(!fs.existsSync(receipt) && Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
      assert.ok(fs.existsSync(receipt),entry+' must complete without interactive input');
      assert.equal(fs.readFileSync(receipt,'utf8'),'helper-ran:Bypass');
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Windows hidden backend and single-instance tray lifecycle (isolated copy)', {timeout:120000}, async () => {
  assert.equal(process.env.PHD_ISOLATED_TESTS, '1', 'Use node scripts/run-tests.mjs; never run against the real office');
  if (process.platform !== 'win32') return;
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const result = spawnSyncToFiles('powershell.exe', ['-NoProfile','-STA','-File',fileURLToPath(new URL('./Test-Startup.ps1', import.meta.url))], {
    encoding:'utf8', timeout:110000, windowsHide:true, env:{...process.env,PHD_DASHBOARD_PORT:String(port)}
  });
  assert.equal(result.status, 0, [result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout, /LIFECYCLE PASSED/);
});
