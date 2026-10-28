import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root} from './files.mjs';
import {callsReport,parseEvents} from '../agent/calls.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const runs=path.join(root,'.runtime/agent/runs'),jsonl=rows=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const claudeRows=[
  {type:'assistant',message:{content:[{type:'thinking',thinking:'x'},{type:'text',text:'先看配置文件'},{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a/b.mjs',offset:5,limit:20}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'x'.repeat(5000)}]}},
  {type:'assistant',message:{content:[{type:'tool_use',id:'t2',name:'Bash',input:{command:'node nope.mjs'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t2',is_error:true,content:[{type:'text',text:'boom'},{type:'image',source:{}}]}]}},
  {type:'assistant',message:{content:[{type:'tool_use',id:'t3',name:'Grep',input:{pattern:'foo'}}]}},
  {type:'assistant',message:{content:[{type:'text',text:'结论在这里'}]}},
  'not json'];
const codexRows=[
  {method:'item/started',params:{item:{type:'commandExecution',id:'c1',command:'"C:\\Windows\\powershell.exe" -Command \'Get-Content x.md\'',aggregatedOutput:null}}},
  {method:'item/completed',params:{item:{type:'commandExecution',id:'c1',command:'"C:\\Windows\\powershell.exe" -Command \'Get-Content x.md\'',aggregatedOutput:'hello',exitCode:1,durationMs:1500}}},
  {method:'item/started',params:{item:{type:'webSearch',id:'w1',query:'q'}}},
  {method:'item/completed',params:{item:{type:'agentMessage',id:'m1',text:'说明一句'}}},
  {method:'item/completed',params:{item:{type:'reasoning',id:'r1'}}},
  {method:'item/completed',params:{item:{type:'contextCompaction',id:'k1'}}}];

function withRuns(fn){
  const ids=['aaaa1111-test-claude','aaaa2222-test-codex','aaaa3333-test-missing'],made=[];
  try{
    fs.mkdirSync(runs,{recursive:true});
    for(const id of ids){fs.mkdirSync(path.join(runs,id),{recursive:true});made.push(id);}
    fs.writeFileSync(path.join(runs,ids[0],'events.jsonl'),claudeRows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n');
    fs.writeFileSync(path.join(runs,ids[1],'events.jsonl'),jsonl(codexRows));
    fs.mkdirSync(path.join(runs,ids[1],'2'));fs.writeFileSync(path.join(runs,ids[1],'2','events.jsonl'),jsonl([codexRows[2]]));
    fs.mkdirSync(path.join(runs,ids[2],'2'));
    return fn();
  }finally{for(const id of made)fs.rmSync(path.join(runs,id),{recursive:true,force:true});}
}

test('calls timeline lists Claude calls in order with sizes, errors, images and the assistant words, and judges nothing',()=>withRuns(()=>{
  const out=callsReport('aaaa1111');
  assert.match(out,/#1 Read · 完成 · 返回 5000 字符\s+a\/b\.mjs \(offset 5, limit 20\)/);
  assert.match(out,/说：先看配置文件\n#1 /);
  assert.match(out,/#2 Bash · 返回错误 · 返回 4 字符 \+ 图片 1/);
  assert.match(out,/#3 Grep · 无返回记录/);
  assert.match(out,/说：结论在这里/);
  assert.match(out,/共 3 次调用，返回合计 5004 字符；推理 1 条/);
  assert.match(out,/无法解析/);
  assert.doesNotMatch(out,/浪费|无用分|score/);
}));

test('calls timeline reads Codex items, numbers across follow-up turns, and reports missing logs',()=>withRuns(()=>{
  const out=callsReport('aaaa2222');
  assert.match(out,/#1 Shell · 退出码 1 · 1\.5s · 返回 5 字符\s+Get-Content x\.md/);
  assert.match(out,/#2 WebSearch · 未完成/);
  assert.match(out,/#3 WebSearch · 未完成/);
  assert.match(out,/上下文压缩 1 次/);
  assert.match(out,/没有对应返回/);
  assert.match(callsReport('aaaa3333'),/缺事件日志：本轮、2/);
}));

test('call detail opens the complete input and result, and rejects bad references',()=>withRuns(()=>{
  const d=callsReport('aaaa1111#1');
  assert.match(d,/调用前的话：先看配置文件/);
  assert.doesNotMatch(d,/中间省略/);assert.match(d,/x{5000}/);
  assert.equal(callsReport('aaaa1111#1:full').includes('省略'),false);
  assert.match(callsReport('aaaa1111#1:full'),/x{5000}/);
  assert.throws(()=>callsReport('aaaa1111#9'),/没有第 9 次调用（共 3 次）/);
  assert.throws(()=>callsReport('aaa'),/至少 4 位/);
  assert.throws(()=>callsReport('zzzz'),/没有这个运行目录/);
  assert.throws(()=>callsReport('aaaa'),/前缀不唯一/);
}));

test('parseEvents skips non-call items and never expands thinking',()=>withRuns(()=>{
  const p=parseEvents(path.join(runs,'aaaa2222-test-codex','events.jsonl'));
  assert.equal(p.calls.length,2);assert.equal(p.says.length,1);assert.equal(p.thinking,1);
}));

test('images are counted not carried: MCP image blocks, encoded runs inside JSON text, generated images; web actions, sleep and image generation stay on the timeline',()=>{
  const b64='iVBORw0KGgo'+'A'.repeat(3000),id='bbbb1111-test-media',dir=path.join(runs,id);
  const item=(type,extra)=>[{method:'item/started',params:{item:{type,id:type+extra.k,...extra}}},{method:'item/completed',params:{item:{type,id:type+extra.k,...extra}}}];
  const rows=[
    ...item('mcpToolCall',{k:1,server:'windows-mcp',tool:'Screenshot',arguments:{},status:'completed',durationMs:266,
      result:{content:[{type:'text',text:'cursor (1,2)'},{type:'image',data:b64,mimeType:'image/png'}],structuredContent:null},error:null}),
    ...item('mcpToolCall',{k:2,server:'x',tool:'Snap',arguments:{},status:'completed',
      result:{content:[{type:'text',text:JSON.stringify({note:'ok',shot:b64})}],structuredContent:{extra:b64}},error:null}),
    ...item('webSearch',{k:3,query:'q',action:{type:'search',query:null,queries:['alpha','beta']},results:[]}),
    ...item('webSearch',{k:4,query:'https://a.example/',action:{type:'openPage',url:'https://a.example/'},results:[]}),
    ...item('webSearch',{k:5,query:"'needle'",action:{type:'findInPage',url:null,pattern:'needle'},results:[]}),
    ...item('imageGeneration',{k:6,status:'completed',revisedPrompt:'a pixel scene',result:b64,savedPath:'C:\gen\a.png',failure:null}),
    {method:'item/completed',params:{item:{type:'sleep',id:'sleep7',durationMs:90000}}}];
  try{
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'events.jsonl'),jsonl(rows));
    const p=parseEvents(path.join(dir,'events.jsonl'));
    assert.deepEqual(p.calls.map(c=>c.name),['MCP windows-mcp/Screenshot','MCP x/Snap','WebSearch','WebSearch','WebSearch','ImageGeneration','Sleep']);
    assert.deepEqual([p.calls[0].chars,p.calls[0].images],[12,1]);                 // text only; the image block is a count
    assert.equal(p.calls[1].images,2);assert.ok(p.calls[1].chars<200);              // encoded runs inside JSON text and structuredContent
    assert.deepEqual(p.calls.slice(2,5).map(c=>c.brief),['search: alpha | beta','openPage: https://a.example/','findInPage: needle']);
    assert.match(p.calls[5].brief,/a pixel scene[\s\S]*C:\gen\a\.png/);assert.deepEqual([p.calls[5].chars,p.calls[5].images],[0,1]);
    assert.equal(p.calls[6].brief,'等待 90 秒');assert.equal(p.calls[6].status,'完成');
    const out=callsReport(id);
    assert.match(out,/返回 12 字符 \+ 图片 1/);assert.doesNotMatch(out,/A{100}/);assert.equal(parseEvents(path.join(dir,'events.jsonl')).calls[0].images,1);
    assert.doesNotMatch(callsReport(id+'#2'),/A{100}/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('long ordinary text or tokens in a result are not mistaken for an image',()=>{
  const id='bbbb2222-test-plain',dir=path.join(runs,id),plain='x'.repeat(5000);
  try{
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'events.jsonl'),jsonl([{type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'min.js'}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:plain}]}}]));
    const c=parseEvents(path.join(dir,'events.jsonl')).calls[0];
    assert.deepEqual([c.chars,c.images],[5000,0]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
