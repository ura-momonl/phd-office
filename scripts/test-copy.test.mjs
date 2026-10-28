import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {includeTestFile,freshTestCopy,removeTestCopy} from './test-copy.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('each test file starts from the pristine baseline, not another file\'s queue, config or runtime',()=>{
  const base=path.join(root,'.runtime/test-worker-fixture'),template=path.join(base,'template');
  fs.mkdirSync(template,{recursive:true});
  fs.writeFileSync(path.join(template,'config.json'),'{"enabled":false,"items":[]}');
  let first,second;
  try {
    first=freshTestCopy(template,base);
    fs.writeFileSync(path.join(first,'config.json'),'{"enabled":true,"items":["leftover"]}');
    fs.mkdirSync(path.join(first,'runtime'));fs.writeFileSync(path.join(first,'runtime/leftover'),'fixture');
    second=freshTestCopy(template,base);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second,'config.json'),'utf8')),{enabled:false,items:[]});
    assert.equal(fs.existsSync(path.join(second,'runtime')),false);
    assert.equal(fs.readFileSync(path.join(template,'config.json'),'utf8'),'{"enabled":false,"items":[]}');
    assert.throws(()=>removeTestCopy(template,base),/Unsafe/);
  } finally {
    for(const dir of [first,second])if(dir)removeTestCopy(dir,base);
    fs.rmSync(base,{recursive:true,force:true});
  }
});

test('isolated copy retains code/assets/frameworks but never copies real project payloads or output history',()=>{
  const base=path.join(root,'.runtime/test-copy-fixture'),source=path.join(base,'source'),target=path.join(base,'copy');
  const kept=['scripts/run-tests.mjs','dashboard/vendor/renderer.js','dashboard/companion/assets/chars/sol/f0.png',
    'workspace/AGENTS.md','workspace/templates/review.example.json','workspace/projects/fictional/README.md','workspace/projects/fictional/FRAMEWORK.md'];
  const omitted=['literature/fulltext/paper.pdf','literature/archive/old/fulltext/paper.pdf','literature/archive/old/catalog.json','tmp/research-preview.png','output/history/screenshot.png','workspace/archives/old/catalog.json','workspace/projects/fictional/STATUS.md','workspace/projects/fictional/data/raw.csv',
    'workspace/projects/fictional/cad/source.dwg','workspace/projects/fictional/experiments/program.py',
    'workspace/projects/fictional/deliverables/report.pdf','workspace/inbox/message.md','workspace/outbox/draft.md',
    '.runtime/mail.sqlite','node_modules/pkg/index.js','vendor/pkg/index.js','.claude/skills/link.md','mail-flow/history.sqlite','agent/private.log',
    'instruments/catalog.json','instruments/programs/example/data/raw.csv','instruments/programs/example/__pycache__/driver.pyc'];
  try {
    for(const file of [...kept,...omitted]){const p=path.join(source,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,file);}
    fs.cpSync(source,target,{recursive:true,filter:file=>includeTestFile(source,file)});
    for(const file of kept)assert.equal(fs.readFileSync(path.join(target,file),'utf8'),file,file);
    for(const file of omitted)assert.equal(fs.existsSync(path.join(target,file)),false,file);
    for(const file of [...kept,...omitted])assert.equal(fs.readFileSync(path.join(source,file),'utf8'),file,'source must remain unchanged');
    assert.equal(includeTestFile(source,path.join(source,'..','outside')),false);
  } finally {
    assert.equal(path.dirname(base),path.join(root,'.runtime'));
    fs.rmSync(base,{recursive:true,force:true});
  }
});

test('runner copy keeps each catalogued project baseline and excludes live output and payload directories',()=>{
  const paths=JSON.parse(fs.readFileSync(path.join(root,'.runtime/test-copy-manifest.json'),'utf8')).paths;
  assert.ok(paths.every(p=>p!=='output' && !p.startsWith('output/')));
  assert.ok(paths.every(p=>p!=='literature/fulltext' && !p.startsWith('literature/fulltext/')));
  for(const dir of ['tmp','literature/archive','workspace/archives'])assert.ok(paths.every(p=>p!==dir && !p.startsWith(dir+'/')),dir+' must not be copied');
  assert.ok(!paths.includes('instruments/catalog.json'),'real instrument cards and photos must not be copied');
  assert.ok(paths.filter(p=>p.startsWith('instruments/programs/')).every(p=>!p.split('/').some(part=>['data','__pycache__'].includes(part))),'real instrument measurement payloads must not be copied');
  const projects=JSON.parse(fs.readFileSync(path.join(root,'projects/catalog.json'),'utf8')).projects;
  for(const project of projects) {
    const dir='workspace/projects/'+project.id;
    assert.ok(paths.includes(dir+'/README.md'),project.id+' README must exist');
    assert.ok(paths.filter(p=>p.startsWith(dir+'/')).every(p=>[dir+'/README.md',dir+'/FRAMEWORK.md'].includes(p)),project.id+' must not contain real payloads');
  }
  assert.ok(paths.includes('dashboard/companion/assets/hall/bg.png'),'real local UI assets are still exercised');
});
