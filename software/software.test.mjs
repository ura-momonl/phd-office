import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,read} from '../automation/files.mjs';
import {codexLaunch} from '../agent/codex.mjs';

const cli=(...args)=>spawnSync(process.execPath,[path.join(root,'automation/run.mjs'),'software',...args],{cwd:root,encoding:'utf8',windowsHide:true});
const success=(...args)=>{const r=cli(...args);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};

test('public list discovers every asset in one line without dumping long routes',()=>{
  const apps=read('software/catalog.json').apps,lines=success('list').split(/\r?\n/);
  assert.equal(lines.length,apps.length);
  for(const app of apps){
    const line=lines.find(l=>l.startsWith(app.id+' ('));assert.ok(line,app.id);
    for(const token of [app.name,`operator=${app.operator}`,`cwd=${app.working_directory}`,'connector=','requires_running=','executable=','verified_at='])assert.ok(line.includes(token),token);
    assert.ok(!line.includes(app.route));
  }
  assert.ok(!success('list').includes('undefined'));
});

test('show and full retain the original complete records and executable existence semantics',()=>{
  const apps=read('software/catalog.json').apps,full=JSON.parse(success('list','full'));
  assert.equal(full.length,apps.length);
  for(const app of apps){
    const expected={...app,executable_present:app.executable ? fs.existsSync(app.executable) : null};
    assert.deepEqual(full.find(a=>a.id===app.id),expected);
    assert.deepEqual(JSON.parse(success('show',app.id)),expected);
  }
});

test('unknown ids and list arguments fail rather than silently select an asset',()=>{
  for(const args of [['show'],['show','not-an-asset'],['list','typo']])assert.notEqual(cli(...args).status,0);
});

test('plan preserves explicit goal, inputs, outputs and never claims execution',()=>{
  assert.equal(process.env.PHD_ISOLATED_TESTS,'1','run via scripts/run-tests.mjs --software');
  const request={app:'fusion',goal:'readonly fixture plan',inputs:['D:/fixture/input.step'],outputs:['D:/fixture/output.step']};
  const file=path.join(root,'.runtime/software-request.json');fs.writeFileSync(file,JSON.stringify(request));
  try {
    const result=JSON.parse(success('plan',file));
    assert.deepEqual(result.app,read('software/catalog.json').apps.find(a=>a.id==='fusion'));
    for(const key of ['goal','inputs','outputs'])assert.deepEqual(result[key],request[key]);
    assert.equal(result.executed,false);
    fs.writeFileSync(file,JSON.stringify({...request,app:'not-an-asset'}));assert.notEqual(cli('plan',file).status,0);
  } finally {fs.unlinkSync(file);}
});

test('catalog ownership and verification evidence use the current schema without freezing the kind of past verification',()=>{
  for(const app of read('software/catalog.json').apps){
    assert.equal(app.operator,['computer-use','deepseek-harness'].includes(app.id)?'codex / claude':'codex');
    assert.ok(app.working_directory);assert.ok(!Object.hasOwn(app,'invoke_in'));
    if(app.verified_at){assert.ok(Number.isFinite(Date.parse(app.verified_at)));assert.match(app.verification.result,/^passed_[a-z_]+$/);assert.ok(app.verification.scope);assert.ok(app.verification.source);}
    else assert.equal(app.verified_at,null);
  }
});

test('documented single-software handoffs cross the existing directory selection boundary',()=>{
  const apps=read('software/catalog.json').apps;
  for(const [id,name] of [['autocad','AutoCAD'],['fusion','Fusion'],['altium','Altium']]){
    const app=apps.find(a=>a.id===id);
    const request=`Please use ${name}. working_directory=${app.working_directory}; input=D:/fixture/in; output=D:/fixture/out`;
    assert.equal(codexLaunch(request,{apps,exists:()=>true}).cwd,app.working_directory);
    assert.equal(codexLaunch(request,{mode:'ask',apps,exists:()=>true}).cwd,root);
  }
  assert.equal(codexLaunch('COMSOL working_directory=D:/comsol-ai',{apps,exists:()=>true}).cwd,root);
  assert.equal(codexLaunch('Fusion and AutoCAD',{apps,exists:()=>true}).cwd,apps.find(a=>a.id==='fusion').working_directory);
  const missing=codexLaunch('AutoCAD',{apps,exists:()=>false});assert.equal(missing.cwd,root);assert.ok(missing.overrides.includes('mcp_servers.autocad-mcp.enabled=true'));
});
