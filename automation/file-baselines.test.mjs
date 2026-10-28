import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
import {loadBaseline,saveBaseline,migrateSessionBaselines} from '../agent/file-baselines.mjs';
import {backupData} from './backup.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --latency');

test('baseline references are lossless, deduplicated, validated and included in normal backups',()=>{
  const baseline={files:{'workspace/a.md':'first-hash'},errors:[]},ref=saveBaseline(baseline);
  assert.deepEqual(saveBaseline(baseline),ref);assert.deepEqual(loadBaseline(ref),baseline);
  assert.deepEqual(loadBaseline(baseline),baseline);assert.equal(loadBaseline(undefined),undefined);
  assert.throws(()=>loadBaseline({sha256:'../../outside'}),/Invalid/);
  const name=`.runtime/agent/file-baselines/${ref.sha256}.json`,file=path.join(root,name);
  const report=backupData({now:new Date('2098-10-14T00:00:00Z'),keep:10000});assert.equal(report.skipped,undefined);
  assert.deepEqual(read('.runtime/backups/2098-10-14/'+name),baseline);
  try {
    write(name,{files:{changed:true},errors:[]});assert.throws(()=>loadBaseline(ref),/missing or changed/);
    assert.throws(()=>saveBaseline(baseline),/missing or changed/,'never silently accept/overwrite a damaged existing object');
    fs.unlinkSync(file);assert.throws(()=>loadBaseline(ref),/missing or changed/);
  }finally{write(name,baseline);}
});

test('a backup holds the code tree and project frameworks, and links an unchanged file to the previous day',()=>{
  const day1='2097-02-01',day2='2097-02-02',base=path.join(root,'.runtime/backups'),readme=path.join(root,'prompts/README.md');
  const original=fs.readFileSync(readme);
  try{
    for(const day of [day1,day2])fs.rmSync(path.join(base,day),{recursive:true,force:true});
    backupData({now:new Date(day1+'T12:00:00Z'),keep:10000});
    for(const file of ['AGENTS.md','automation/backup.mjs','prompts/README.md','work/turns.json','projects/FRAMEWORK-RULES.md'])
      assert.deepEqual(fs.readFileSync(path.join(base,day1,file)),fs.readFileSync(path.join(root,file)),file);
    const frameworks=fs.readdirSync(path.join(root,'workspace/projects')).filter(p=>fs.existsSync(path.join(root,'workspace/projects',p,'FRAMEWORK.md')));
    for(const project of frameworks)assert.ok(fs.existsSync(path.join(base,day1,'workspace/projects',project,'FRAMEWORK.md')),project);
    for(const skipped of ['node_modules','output','.runtime/agent/runs'])assert.ok(!fs.existsSync(path.join(base,day1,skipped)),skipped+' stays out');
    backupData({now:new Date(day2+'T12:00:00Z'),keep:10000});
    assert.equal(fs.statSync(path.join(base,day2,'AGENTS.md')).ino,fs.statSync(path.join(base,day1,'AGENTS.md')).ino,'untouched file is a link to the previous day');
    fs.appendFileSync(readme,'\n<!-- edited between backups -->\n');
    backupData({now:new Date('2097-02-03T12:00:00Z'),keep:10000});
    assert.deepEqual(fs.readFileSync(path.join(base,'2097-02-03/prompts/README.md')),fs.readFileSync(readme),'edited file is copied with its new bytes');
  }finally{
    fs.writeFileSync(readme,original);
    for(const day of [day1,day2,'2097-02-03'])fs.rmSync(path.join(base,day),{recursive:true,force:true});
  }
});

test('migration preserves both assistants, legacy continuation and messages; failed commit retains original bytes',()=>{
  const file='.runtime/agent/sessions.json',original=fs.readFileSync(path.join(root,file)),rename=fs.renameSync;
  const baseline={files:Object.fromEntries(Array.from({length:40},(_,i)=>['workspace/中文'+i+'.md','hash-'+i])),errors:['unreadable-path']};
  const fixture={sessions:[{id:'migration',messages:[{role:'user',text:'Original 🌿'}],
    file_snapshots:{codex:baseline,claude:baseline},codex_continuation:{threadId:'kept',seen:[0],fileSnapshot:baseline}}]};
  try{
    write(file,fixture);const before=fs.readFileSync(path.join(root,file));
    fs.renameSync=(from,to)=>{if(to===path.join(root,file))throw new Error('fixture failed commit');return rename(from,to);};
    assert.throws(()=>migrateSessionBaselines(),/fixture failed commit/);assert.deepEqual(fs.readFileSync(path.join(root,file)),before);
    fs.renameSync=rename;assert.equal(migrateSessionBaselines(),3);const migrated=read(file).sessions[0];
    assert.deepEqual(migrated.messages,fixture.sessions[0].messages);assert.equal(migrated.codex_continuation.threadId,'kept');
    for(const value of [...Object.values(migrated.file_snapshots),migrated.codex_continuation.fileSnapshot]){
      assert.equal(value.files,undefined);assert.deepEqual(loadBaseline(value),baseline);
    }
    assert.equal(migrateSessionBaselines(),0,'restart migration is idempotent');
    assert.ok(fs.statSync(path.join(root,file)).size<before.length);
  }finally{fs.renameSync=rename;fs.writeFileSync(path.join(root,file),original);}
});
