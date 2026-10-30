import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {buildExplorer} from './build-explorer.mjs';
import {fileURLToPath} from 'node:url';

const fixture=()=>({channels:['other-sensor'],methods:[{id:'calibrated',label:'偏置校准',description:'当前输入的处理，不规定窗口'}],display_note:'说明 </script><img src=x onerror=alert(1)>',groups:[{id:'g1',source:'sample.txt',config:'配置 </option><img src=x>',condition:7,cols:['drive','xx','yy'],rows:[[1,2,3],[1,3,4]],steps:[{current:1,start:0,end:1,values:{'other-sensor':{calibrated:[2.5,3.5]}}}]}]});
const adapter='window.signalAdapter={rows(g){return g.rows.map((r,i)=>({i,current:r[0],rawx:r[1],rawy:r[2],x:r[1],y:r[2],amplitude:Math.hypot(r[1],r[2]),phase:0,delta:0}));}};';
const setup=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'grouped-explorer-'));fs.writeFileSync(path.join(dir,'data.json'),JSON.stringify(fixture()));fs.writeFileSync(path.join(dir,'adapter.js'),adapter);return dir;};
const unpack=html=>JSON.parse(gunzipSync(Buffer.from(html.match(/<script id="bundle" type="application\/octet-stream">([^<]+)<\/script>/)[1],'base64')).toString('utf8'));

test('CLI packs the complete data and its method metadata into an offline HTML without interpreting data as markup',()=>{
  const dir=setup();
  try {
    const output=path.join(dir,'view.html');
    const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./build-explorer.mjs',import.meta.url)),path.join(dir,'data.json'),path.join(dir,'adapter.js'),output],{encoding:'utf8'}));
    assert.deepEqual({groups:result.groups,rows:result.rows},{groups:1,rows:2});
    const html=fs.readFileSync(output,'utf8');
    assert.deepEqual(unpack(html),fixture(),'no measured rows, arbitrary labels or processing definitions are lost');
    assert.ok(!html.includes(fixture().display_note),'data with script-looking text stays inside encoded payload');
    assert.ok(!html.includes('__ADAPTER__')&&!html.includes('__BUNDLE__'));
    assert.ok(!/<script[^>]+src=/.test(html),'no external script service is needed');
    assert.ok(!html.includes('末30%')&&!html.includes('±5%'),'renderer does not impose experimental processing or matching choices');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('gzip input and absent processing results preserve raw rows; incompatible bundle and source overwrite are rejected',()=>{
  const dir=setup();
  try {
    const input=path.join(dir,'data.json'),adapterFile=path.join(dir,'adapter.js'),output=path.join(dir,'view.html');
    const data=fixture();data.groups[0].steps=[];
    fs.writeFileSync(path.join(dir,'data.json.gz'),gzipSync(JSON.stringify(data)));
    buildExplorer(path.join(dir,'data.json.gz'),adapterFile,output);
    assert.deepEqual(unpack(fs.readFileSync(output,'utf8')),data);
    assert.throws(()=>buildExplorer(input,adapterFile,input),/must not overwrite/);
    assert.deepEqual(JSON.parse(fs.readFileSync(input,'utf8')),fixture());
    data.groups[0].rows[0].pop();fs.writeFileSync(input,JSON.stringify(data));
    assert.throws(()=>buildExplorer(input,adapterFile,output),/row width/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('template markers inside the inserted adapter stay literal rather than being interpreted a second time',()=>{
  const dir=setup();
  try {
    const special=adapter+'\n// __ADAPTER__ __BUNDLE__ $& literal adapter text\n';
    fs.writeFileSync(path.join(dir,'adapter.js'),special);
    const output=path.join(dir,'literal.html');
    buildExplorer(path.join(dir,'data.json'),path.join(dir,'adapter.js'),output);
    const html=fs.readFileSync(output,'utf8');
    assert.ok(html.includes(special),'inserted source is not scanned as a second template');
    assert.deepEqual(unpack(html),fixture(),'the actual bundle slot is still replaced correctly');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
