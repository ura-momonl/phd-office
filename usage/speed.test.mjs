import test from 'node:test';
import assert from 'node:assert/strict';
import {speedGroups,SPEED_MIN_OUTPUT} from './metrics.mjs';
import {usageSections} from '../dashboard/usage-view.js';
import {speedReport} from './run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const run=(o)=>({at:'2026-10-25T10:00:00Z',provider:'codex',model:'m',status:'completed',usage_known:true,input_tokens:1000,cached_input_tokens:0,output_tokens:600,tool_calls:0,duration_ms:10000,...o});

test('speed is output tokens over whole-call time, medians only tool-free completed long-output calls',()=>{
  const runs=[run({}),run({output_tokens:1200}),run({output_tokens:300,duration_ms:30000}), // 60, 120, 10 tok/s -> median 60
    run({tool_calls:3,output_tokens:30000,duration_ms:10000}),   // tools: not in the median
    run({output_tokens:SPEED_MIN_OUTPUT-1}),                      // too short
    run({status:'failed'}),run({usage_known:false,input_tokens:null,output_tokens:null}),run({duration_ms:0}),run({provider:'claude',model:'x'})];
  const g=speedGroups(runs),codex=g.find(x=>x.key==='codex|m');
  assert.equal(codex.samples,3);assert.equal(codex.median,60);
  assert.equal(codex.calls,5); // completed, known, timed calls: 3 samples + tools + short; failed/unknown/zero-time excluded
  assert.ok(codex.all_calls_rate>100); // the tool call inflates the reference figure, which is why it is not the headline
  assert.equal(g.find(x=>x.key==='claude|x').samples,1);
});

test('a model with no qualifying calls shows a dash, not zero; the page table and CLI report agree',()=>{
  const runs=[run({tool_calls:2}),run({}),run({}),run({}),run({provider:'deepseek',model:'deepseek/deepseek-v4.1-flash-fast',output_tokens:50})];
  const html=usageSections(runs).speed;
  assert.match(html,/60 tok\/s/);assert.match(html,/样本少/);
  assert.match(html,/deepseek\/deepseek-v4\.1-flash-fast[\s\S]*?<td>0<[\s\S]*?<td>—<\/td>/);
  const report=speedReport(0,{runs});
  assert.equal(report.rows.find(r=>r.model==='codex · m').median_tok_per_s,60);
  assert.equal(report.rows.find(r=>r.model.includes('flash-fast')).median_tok_per_s,null);
  assert.equal(usageSections([]).speed,'');
});
