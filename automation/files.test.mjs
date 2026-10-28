import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('atomic JSON write preserves the old value while Windows replacement is briefly locked, then commits once',()=>{
  const relative='.runtime/file-write-fixture/value.json',file=path.join(root,relative);
  write(relative,{version:'old'});
  const rename=fs.renameSync;let attempts=0,staged;
  try {
    fs.renameSync=(from,to)=>{
      if(to!==file)return rename(from,to);
      attempts++;staged=from;
      assert.equal(read(relative).version,'old','target is never removed or partially overwritten');
      assert.equal(JSON.parse(fs.readFileSync(from,'utf8')).version,'new');
      assert.notEqual(from,file+'.tmp','another writer cannot overwrite this staged value');
      if(process.platform==='win32' && attempts<3)throw Object.assign(new Error('fixture replacement lock'),{code:attempts===1?'EPERM':'EBUSY'});
      return rename(from,to);
    };
    write(relative,{version:'new'});
    assert.equal(attempts,process.platform==='win32'?3:1);
    assert.deepEqual(read(relative),{version:'new'});assert.equal(fs.existsSync(staged),false);
  }finally{fs.renameSync=rename;fs.unlinkSync(file);}
});

test('persistent replacement permission error is bounded, preserves the original JSON, and never replays a write',()=>{
  const relative='.runtime/file-write-fixture/denied.json',file=path.join(root,relative);
  write(relative,{keep:true});const rename=fs.renameSync;let attempts=0,staged;
  const denied=Object.assign(new Error('fixture permanent permission error'),{code:'EPERM'});
  try {
    fs.renameSync=(from,to)=>{if(to!==file)return rename(from,to);attempts++;staged=from;throw denied;};
    assert.throws(()=>write(relative,{keep:false}),error=>error===denied);
    assert.equal(attempts,process.platform==='win32'?4:1);assert.deepEqual(read(relative),{keep:true});
    assert.equal(fs.existsSync(staged),false);
  }finally{fs.renameSync=rename;fs.unlinkSync(file);}
});

test('unrelated file replacement errors are not retried or masked',()=>{
  const relative='.runtime/file-write-fixture/unrelated.json',file=path.join(root,relative);
  write(relative,{keep:true});const rename=fs.renameSync;let attempts=0;
  const error=Object.assign(new Error('fixture I/O error'),{code:'EIO'});
  try {
    fs.renameSync=(from,to)=>{if(to!==file)return rename(from,to);attempts++;throw error;};
    assert.throws(()=>write(relative,{keep:false}),e=>e===error);assert.equal(attempts,1);assert.deepEqual(read(relative),{keep:true});
  }finally{fs.renameSync=rename;fs.unlinkSync(file);}
});
