import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {refreshDeepSeekBalance} from './deepseek-balance.mjs';
import {renderDeepSeekBalance,deepseekPricePeriod} from '../dashboard/usage-view.js';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const credentials='.runtime/deepseek-harness/credentials.json',quota='.runtime/usage/quota.json';
const infos=[{currency:'CNY',total_balance:'6.40',granted_balance:'0.00',topped_up_balance:'6.40'},{currency:'USD',total_balance:'0.00',granted_balance:'0.00',topped_up_balance:'0.00'}];
async function fixture(fn) {
  const files=[credentials,quota],directory=path.dirname(path.join(root,credentials)),existed=fs.existsSync(directory);
  const before=files.map(file=>fs.existsSync(path.join(root,file)) ? fs.readFileSync(path.join(root,file)) : null);
  try {await fn();} finally {
    files.forEach((file,i)=>{if(before[i]===null)fs.rmSync(path.join(root,file),{force:true});else fs.writeFileSync(path.join(root,file),before[i]);});
    if(!existed && fs.existsSync(directory) && fs.readdirSync(directory).length===0)fs.rmdirSync(directory);
  }
}

test('peak/off-peak follows Beijing boundaries and holidays, not the balance timestamp or the host timezone',()=>{
  for(const [time,expected] of [
    ['2026-10-21T08:59:59+08:00','谷值'],['2026-10-21T09:00:00+08:00','峰值'],
    ['2026-10-21T11:59:59+08:00','峰值'],['2026-10-21T12:00:00+08:00','谷值'],
    ['2026-10-21T13:59:59+08:00','谷值'],['2026-10-21T14:00:00+08:00','峰值'],
    ['2026-10-21T17:59:59+08:00','峰值'],['2026-10-21T18:00:00+08:00','谷值'],
    ['2026-10-24T10:00:00+08:00','谷值'],['2026-10-10T10:00:00+08:00','谷值'],
    ['2026-10-21T20:00:00-05:00','峰值'],['2026-11-04T19:00:00-06:00','峰值'],
    ['2027-01-04T10:00:00+08:00','时段待核'],['2027-01-04T20:00:00+08:00','谷值'],
    ...['01-02','02-16','04-06','05-04','06-19','09-25','10-05'].map(day=>[`2026-${day}T10:00:00+08:00`,'谷值']),
    ['2026-10-08T10:00:00+08:00','峰值'],
  ])assert.equal(deepseekPricePeriod(Date.parse(time)),expected,time);
  const html=renderDeepSeekBalance({checked_at:'2026-10-21T02:00:00Z',balance_infos:infos},Date.parse('2026-10-21T18:00:00+08:00'));
  assert.match(html,/余额 · <span data-price-period>谷值<\/span>/);
  assert.doesNotMatch(html,/<small|header-reset|更新 10/);
});

test('balance query is read-only, uses the configured key only at the official endpoint, and preserves other providers',()=>fixture(async()=>{
  const fetch=globalThis.fetch;let calls=0;
  try {
    write(credentials,{api_key:'fake-test-secret',base_url:'https://api.deepseek.com/anthropic'});
    write(quota,{codex:{keep:true},claude:{keep:true}});
    globalThis.fetch=async(url,options)=>{
      calls++;assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(options.method ?? 'GET','GET');
      assert.equal(options.headers.Authorization,'Bearer fake-test-secret');assert.equal(options.redirect,'error');
      // Simulate another provider writing during the request.
      write(quota,{...read(quota,{}),claude:{newer:true}});
      return {ok:true,json:async()=>({is_available:true,balance_infos:infos,secret:'must-not-persist'})};
    };
    const q=await refreshDeepSeekBalance();assert.equal(calls,1);assert.deepEqual(q.balance_infos,infos);
    assert.deepEqual(read(quota).codex,{keep:true});assert.deepEqual(read(quota).claude,{newer:true});
    assert.ok(q.checked_at);assert.ok(!q.error);assert.doesNotMatch(JSON.stringify(read(quota)),/secret|Bearer/);
    const html=renderDeepSeekBalance(q);assert.match(html,/¥6.40 \/ \$0.00/);assert.match(html,/赠金 0.00/);
    assert.doesNotMatch(html,/meter|%|重置/);
  }finally{globalThis.fetch=fetch;}
}));

test('failure is not zero: retains last success as old, redacts errors, and recovers on a later refresh',()=>fixture(async()=>{
  const fetch=globalThis.fetch;
  try {
    write(credentials,{api_key:'fake-test-secret'});
    const last={checked_at:'2026-10-21T20:00:00Z',balance_infos:infos,is_available:true};write(quota,{deepseek:last});
    for(const response of [()=>{throw new Error('fake-test-secret');},()=>({ok:false,status:401}),()=>({ok:true,json:async()=>({is_available:true,balance_infos:[{...infos[0],total_balance:null}]})})]){
      globalThis.fetch=async()=>response();const q=await refreshDeepSeekBalance();
      assert.ok(q.error);assert.ok(q.attempted_at);assert.deepEqual(q.balance_infos,infos);assert.equal(q.checked_at,last.checked_at);
      assert.doesNotMatch(JSON.stringify(q),/fake-test-secret/);assert.match(renderDeepSeekBalance(q),/余额（上次）/);
    }
    globalThis.fetch=async()=>({ok:true,json:async()=>({is_available:false,balance_infos:[{currency:'USD',total_balance:'0.00',granted_balance:'0.00',topped_up_balance:'0.00'}]})});
    const recovered=await refreshDeepSeekBalance();assert.equal(recovered.error,undefined);assert.equal(recovered.is_available,false);
    assert.match(renderDeepSeekBalance(recovered),/\$0.00/);assert.match(renderDeepSeekBalance(recovered),/账号当前不可调用/);
    fs.rmSync(path.join(root,credentials));write(quota,{});globalThis.fetch=async()=>{assert.fail('missing key must not send a request');};
    assert.equal((await refreshDeepSeekBalance()).error,'未配置 DeepSeek API Key');assert.match(renderDeepSeekBalance(read(quota).deepseek),/余额不可用/);
    assert.match(renderDeepSeekBalance(),/>—</);assert.doesNotMatch(renderDeepSeekBalance(),/\$0|¥0/);
  }finally{globalThis.fetch=fetch;}
}));
