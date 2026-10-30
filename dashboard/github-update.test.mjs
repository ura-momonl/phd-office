import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runGithubUpdate} from './github-update.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('settings update button runs the updater script: preview vs --apply, failure reported, one run at a time',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phd-gh-update-'));
  const script=path.join(dir,'fake.mjs');
  fs.writeFileSync(script,"const a=process.argv.slice(2);console.log(a.includes('--apply')?'APPLIED':'PREVIEW');await new Promise(r=>setTimeout(r,200));if(process.env.FAKE_FAIL)process.exit(1);");
  try {
    const first=runGithubUpdate(false,{script,cwd:dir});
    await assert.rejects(runGithubUpdate(false,{script,cwd:dir}),/正在进行/);
    assert.deepEqual(await first,{ok:true,apply:false,output:'PREVIEW'});
    assert.deepEqual(await runGithubUpdate(true,{script,cwd:dir}),{ok:true,apply:true,output:'APPLIED'});
    process.env.FAKE_FAIL='1';
    const failed=await runGithubUpdate(false,{script,cwd:dir});
    assert.equal(failed.ok,false);
  } finally {delete process.env.FAKE_FAIL;fs.rmSync(dir,{recursive:true,force:true});}
});
