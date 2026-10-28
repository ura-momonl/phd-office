import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root} from '../automation/files.mjs';
import {frameworkDigest,frameworkRevision,readFrameworkNodes,parseFramework,frameworkFile} from './framework.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

test('project orientation exposes every topic and complete summary without injecting unrelated bodies',()=>{
  const source=fs.readFileSync(frameworkFile('graphene-thz'),'utf8'),parsed=parseFramework(source),d=frameworkDigest('graphene-thz');
  for(const n of parsed.nodes.filter(n=>!n.entry && !n.ancestors.some(a=>a.entry))){
    if(n.id)assert.ok(d.includes(n.id),n.id+' is discoverable');
    if(n.id && n.body)assert.ok(readFrameworkNodes('graphene-thz',[n.id]).nodes[0].text.includes(n.body),n.id+' body is accessible at its exact entry');
    if(n.meta.summary)assert.ok(d.includes(n.meta.summary),n.id+' summary is not truncated');
  }
  for(const n of parsed.nodes.filter(n=>n.entry))assert.ok(d.includes(n.id),n.id+' is discoverable regardless of date or recency');
  assert.match(d,/graphene-m-press-test/);assert.match(d,/graphene-m-array/);
  assert.ok(d.length<16000,'orientation remains a navigable index, not a full project dump');
  const methods=parsed.byId.get('graphene-l-methods');assert.ok(methods.body.length>100);
  assert.ok(!d.includes(methods.body),'full Methods stays on demand');
  assert.match(d,/不是正文/);assert.match(d,/无 ID/);
  assert.ok(!d.includes('目录过长已截断'));assert.match(d,/read-nodes graphene-thz#/);
  assert.equal(frameworkDigest('no-such-project'),'');
  const outline=execFileSync(process.execPath,['automation/run.mjs','projects','outline','graphene-thz'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(outline,d,'the on-demand CLI exposes the same complete index');
});

test('exact project node reading crosses the CLI boundary and keeps source lines and descendants',()=>{
  const selected=['graphene-m-press-test','graphene-m-array'];
  const fromCLI=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','projects','read-nodes','graphene-thz#'+selected.join(',')],{cwd:root,encoding:'utf8'}));
  const result=readFrameworkNodes('graphene-thz',selected);
  assert.deepEqual(fromCLI,result);assert.deepEqual(result.nodes.map(n=>n.id),selected);
  const lines=fs.readFileSync(frameworkFile('graphene-thz'),'utf8').split(/\r?\n/);
  for(const n of result.nodes)assert.equal(n.text,lines.slice(n.start_line-1,n.end_line).join('\n'));
  assert.match(result.nodes[0].text,/1→5→25 MPa/);
  assert.match(result.nodes[1].text,/T-20261012-03/);
  assert.throws(()=>readFrameworkNodes('graphene-thz',['graphene-m-array','missing-node']),/未找到项目节点/);
  assert.throws(()=>readFrameworkNodes('../graphene-thz',['graphene-m-array']),/FRAMEWORK/);
});

test('historical body edits change evidence revision, not the unchanged orientation or its compact log index',()=>{
  const file=frameworkFile('graphene-thz'),original=fs.readFileSync(file),before=frameworkDigest('graphene-thz'),revision=frameworkRevision('graphene-thz');
  const parsed=parseFramework(original.toString('utf8')),entry=parsed.nodes.find(n=>n.entry);
  assert.ok(entry);const lines=parsed.lines.slice();
  lines.splice(entry.bodyEnd,0,'CONTEXT_BODY_ONLY_REVISION_WITNESS');
  try {
    fs.writeFileSync(file,lines.join('\n'));
    const after=frameworkDigest('graphene-thz');
    assert.equal(after,before,'unchanged orientation does not need a bulk resend');
    assert.notEqual(frameworkRevision('graphene-thz'),revision,'historical evidence edits still invalidate cached source reads');
    assert.ok(!after.includes('CONTEXT_BODY_ONLY_REVISION_WITNESS'),'index does not claim to contain historical bodies');
    assert.ok(readFrameworkNodes('graphene-thz',[entry.id]).nodes[0].text.includes('CONTEXT_BODY_ONLY_REVISION_WITNESS'));
  } finally {fs.writeFileSync(file,original);}
});

test('historical index omits file payload metadata but exact source reads retain it',()=>{
  const d=frameworkDigest('graphene-thz'),tail=d.slice(d.indexOf('历史日志完整索引'));
  assert.ok(!tail.includes('"files"')&&!tail.includes('"links"')&&!tail.includes('"history"'));
  const parsed=parseFramework(fs.readFileSync(frameworkFile('graphene-thz'),'utf8'));
  const n=parsed.nodes.find(n=>n.entry&&n.meta.files?.length);assert.ok(n);
  assert.ok(readFrameworkNodes('graphene-thz',[n.id]).nodes[0].text.includes(JSON.stringify(n.meta.files[0]).slice(0,30)));
});

test('topic body edits invalidate source reads without resending unchanged summaries',()=>{
  const file=frameworkFile('graphene-thz'),original=fs.readFileSync(file),before=frameworkDigest('graphene-thz'),revision=frameworkRevision('graphene-thz');
  const parsed=parseFramework(original.toString('utf8')),n=parsed.byId.get('graphene-m-press-test'),lines=parsed.lines.slice();
  lines.splice(n.bodyEnd,0,'TOPIC_BODY_ONLY_REVISION_WITNESS');
  try {
    fs.writeFileSync(file,lines.join('\n'));
    assert.equal(frameworkDigest('graphene-thz'),before);
    assert.notEqual(frameworkRevision('graphene-thz'),revision);
    assert.match(readFrameworkNodes('graphene-thz',[n.id]).nodes[0].text,/TOPIC_BODY_ONLY_REVISION_WITNESS/);
  } finally {fs.writeFileSync(file,original);}
});
