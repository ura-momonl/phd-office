import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {discoverTests,modes,optInTests,selectTests,testSummary,testPassed} from './test-suite.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('full selection includes every eligible test exactly once, with Docker explicitly opt-in',()=>{
  const all=discoverTests(root),full=selectTests(root,[]);
  assert.deepEqual([...full.files].sort(),all.filter(f=>!optInTests.has(f)));
  assert.equal(full.files.length,new Set(full.files).size);
  assert.equal(full.focused,false);assert.equal(full.jobs,4);
  for(const file of ['dashboard/companion/tests/animation.test.mjs','dashboard/companion-notes.test.mjs','dashboard/companion.test.mjs'])assert.ok(full.files.includes(file));
  assert.ok(!full.files.includes('sandbox/sandbox.test.mjs'));
  assert.ok(selectTests(root,['--sandbox']).files.includes('sandbox/sandbox.test.mjs'));
});

test('new regression files are discovered without editing a runner manifest',()=>{
  const base=path.join(root,'.runtime/test-discovery-fixture');
  const kept=['feature/new.test.mjs','software/nested/other.test.mjs','dashboard/vendor/asset.test.mjs'];
  const omitted=['tmp/stale.test.mjs','.runtime/private.test.mjs','node_modules/pkg/library.test.mjs','vendor/pkg/library.test.mjs','literature/archive/old.test.mjs','workspace/projects/p/payload.test.mjs'];
  try {
    for(const name of [...kept,...omitted]){const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');}
    assert.deepEqual(discoverTests(base),kept.sort());
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test('focused modes are nonempty, valid and mutually exclusive, including usage',()=>{
  for(const mode of Object.keys(modes)) {
    const args=['--'+mode,'--keep','--jobs=2','--list'],selected=selectTests(root,args);
    assert.ok(selected.files.length>3);assert.equal(selected.jobs,2);assert.equal(selected.mode,mode);assert.equal(selected.keep,true);assert.equal(selected.list,true);
    assert.equal(selected.files.length,new Set(selected.files).size);
    for(const other of Object.keys(modes))assert.throws(()=>selectTests(root,['--'+mode,'--'+other]),/Choose one focused/);
  }
  assert.deepEqual(selectTests(root,['--usage']).files.slice(3),modes.usage[1].map(f=>f+'.test.mjs'));
  assert.deepEqual(selectTests(root,['--speech']).files.slice(3),['dashboard/speech.test.mjs']);
});

test('file reruns validate paths, reject option conflicts and preserve runner checks',()=>{
  const selected=selectTests(root,['--files=automation/files.test.mjs,automation/files.test.mjs','--jobs=1']);
  assert.equal(selected.focused,true);assert.equal(selected.jobs,1);
  assert.deepEqual(selected.files.slice(3),['automation/files.test.mjs']);
  for(const args of [['--files='],['--files=../outside.test.mjs'],['--files=automation/files.test.mjs','--usage'],['--usage','--files=automation/files.test.mjs'],['--jobs=0'],['--jobs=9'],['--jobs=1.5'],['--jobs=2','--jobs=3'],['--wat']])assert.throws(()=>selectTests(root,args));
  assert.equal(selectTests(root,['--keep','--jobs=1','--list']).focused,false);
});

test('a process must both exit successfully and report actual noncancelled tests',()=>{
  const summary=testSummary('✓ 中文用例\nℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n');
  assert.deepEqual(summary,{tests:3,pass:2,fail:0,cancelled:0,skipped:1,todo:0});
  assert.equal(testPassed({status:0,summary}),true);
  for(const result of [{status:null,summary},{status:1,summary},{status:0,summary:testSummary('')},{status:0,summary:{...summary,fail:1}},{status:0,summary:{...summary,cancelled:1}}])assert.equal(testPassed(result),false);
});
