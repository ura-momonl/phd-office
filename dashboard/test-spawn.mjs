import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Test helper for scripts that leave a hidden backend running. With stdout/stderr pipes the
// background process inherits the pipe, so spawnSync keeps waiting after the script exits until
// its timeout. Files let spawnSync return as soon as the script itself exits.
export function spawnSyncToFiles(command,args,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phd-spawn-')),out=path.join(dir,'out.txt'),err=path.join(dir,'err.txt');
  const stdout=fs.openSync(out,'w'),stderr=fs.openSync(err,'w');
  try {
    const result=spawnSync(command,args,{...options,encoding:undefined,stdio:['ignore',stdout,stderr]});
    fs.closeSync(stdout);fs.closeSync(stderr);
    return {...result,stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')};
  } finally {
    try{fs.closeSync(stdout);}catch{}try{fs.closeSync(stderr);}catch{}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
