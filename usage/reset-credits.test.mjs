import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {resetExhaustedCodexQuota} from './reset-credits.mjs';
import {refreshCodexQuota} from './run.mjs';
import {invokeCodex} from '../agent/codex.mjs';
import {saveSettings,settingsView} from '../dashboard/settings.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const fixture=(used=100)=>({accountId:'fixture-account',rateLimits:{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}},
  rateLimitResetCredits:{availableCount:1,credits:[{id:'fixture-credit',resetType:'codexRateLimits',status:'available',expiresAt:Math.floor(Date.now()/1000)+86400}]}});
async function isolated(fn) {
  const files=['agent/config.json','.runtime/usage/quota.json','.runtime/usage/reset-credits.jsonl','.runtime/settings/changes.jsonl'];
  const saved=files.map(f=>fs.existsSync(path.join(root,f)) ? fs.readFileSync(path.join(root,f)) : null);
  try {write('agent/config.json',{...read('agent/config.json'),automatic_codex_reset_credit:true});await fn();}
  finally {files.forEach((f,i)=>{if(saved[i]===null)fs.rmSync(path.join(root,f),{force:true});else fs.writeFileSync(path.join(root,f),saved[i]);});}
}

test('no redemption when disabled, below 100%, no credit, expired window/card, or a different product is exhausted',()=>isolated(async()=>{
  const cases=[fixture(83),fixture(99.9),{...fixture(),rateLimitResetCredits:{availableCount:0}},
    {...fixture(),rateLimits:{primary:{usedPercent:100,resetsAt:1}}},
    {...fixture(),rateLimits:{limitId:'other',primary:{usedPercent:100,resetsAt:Date.now()/1000+100}}},
    {...fixture(),rateLimitResetCredits:{availableCount:1,credits:[{...fixture().rateLimitResetCredits.credits[0],expiresAt:1}]}},
    {...fixture(10),rateLimitsByLimitId:{codex:fixture(10).rateLimits,other:fixture().rateLimits}}];
  for(const limits of cases)assert.deepEqual(await resetExhaustedCodexQuota(()=>{throw new Error('must not send');},limits),{limits});
  write('agent/config.json',{...read('agent/config.json'),automatic_codex_reset_credit:false});
  assert.deepEqual(await resetExhaustedCodexQuota(()=>{throw new Error('disabled');},fixture()),{limits:fixture()});
}));

test('uses the earliest-expiring eligible card once and reads official limits afterwards; the other provider is preserved',()=>isolated(async()=>{
  const before=fixture(),after=fixture(0);after.rateLimitResetCredits={availableCount:0,credits:[]};
  before.rateLimitResetCredits.credits.push({...before.rateLimitResetCredits.credits[0],id:'later-credit',expiresAt:Math.floor(Date.now()/1000)+172800});
  write('.runtime/usage/quota.json',{claude:{keep:true},codex:{activity:{keep:true}}});
  const calls=[];
  const rpc=async(method,params)=>{calls.push({method,params});return method==='account/rateLimitResetCredit/consume' ? {outcome:'reset'} : calls.length===1 ? before : after;};
  const result=await refreshCodexQuota(rpc);
  assert.deepEqual(calls.map(c=>c.method),['account/rateLimits/read','account/rateLimitResetCredit/consume','account/rateLimits/read']);
  assert.equal(calls[1].params.creditId,'fixture-credit');
  assert.match(calls[1].params.idempotencyKey,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(result.automatic_reset.outcome,'reset');assert.equal(result.limits.rateLimits.primary.usedPercent,0);
  assert.equal(read('.runtime/usage/quota.json').claude.keep,true);assert.equal(result.activity.keep,true);
  assert.ok(fs.readFileSync(path.join(root,'.runtime/usage/reset-credits.jsonl'),'utf8').includes('"outcome":"reset"'));
}));

test('concurrent observations and a lost response reuse the same redemption key, never a second logical attempt',()=>isolated(async()=>{
  const limits=fixture(),keys=[],redeemed=new Set();let spent=0;
  const rpc=async(method,params)=>{
    if(method==='account/rateLimits/read')return fixture(0);
    keys.push(params.idempotencyKey);
    if(redeemed.has(params.idempotencyKey))return {outcome:'alreadyRedeemed'};
    redeemed.add(params.idempotencyKey);spent++;throw new Error('response lost after reset');
  };
  const results=await Promise.all([resetExhaustedCodexQuota(rpc,limits),resetExhaustedCodexQuota(rpc,limits)]);
  assert.equal(spent,1);assert.equal(new Set(keys).size,1);
  assert.match(results[0].automatic_reset.error,/response lost/);assert.equal(results[1].automatic_reset.outcome,'alreadyRedeemed');
  await resetExhaustedCodexQuota(rpc,limits);assert.equal(spent,1);
  const next=fixture();next.rateLimitResetCredits.credits[0].id='next-credit';
  await resetExhaustedCodexQuota(rpc,next);assert.equal(spent,2,'a genuinely different card is a new operation');
}));

test('count-only cards and secondary windows work; official noCredit/nothingToReset outcomes never cause a consume loop',()=>isolated(async()=>{
  for(const outcome of ['noCredit','nothingToReset','alreadyRedeemed']) {
    const limits=fixture(20);limits.rateLimits.secondary=limits.rateLimits.primary;limits.rateLimits.primary={...limits.rateLimits.primary,usedPercent:20};limits.rateLimits.secondary={...limits.rateLimits.secondary,usedPercent:100};
    limits.rateLimitResetCredits={availableCount:1,credits:null};
    const calls=[];
    const result=await resetExhaustedCodexQuota(async(method,params)=>{calls.push({method,params});return method.endsWith('/consume') ? {outcome} : fixture(12);},limits);
    assert.equal(result.automatic_reset.outcome,outcome);assert.equal(result.limits.rateLimits.primary.usedPercent,12);
    assert.equal(calls.length,2);assert.ok(!('creditId' in calls[0].params));
  }
}));

test('the actual native adapter checks and redeems before turn/start, without replaying the model task',()=>isolated(async()=>{
  const dir=path.join(root,'.runtime/reset-native-fixture'),appdata=path.join(dir,'appdata'),bin=path.join(appdata,'npm/node_modules/@openai/codex/bin/codex.js');
  fs.mkdirSync(path.dirname(bin),{recursive:true});const calls=path.join(dir,'calls.jsonl');
  fs.writeFileSync(bin,`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});let redeemed=false;rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\n');if(m.id===undefined)return;let result={};if(m.method==='account/rateLimits/read')result=redeemed?${JSON.stringify(fixture(0))}:${JSON.stringify(fixture())};if(m.method==='account/rateLimitResetCredit/consume'){redeemed=true;result={outcome:'reset'};}if(m.method==='thread/start')result={thread:{id:'fixture-thread'},model:'fixture',sandbox:{type:'workspaceWrite'}};if(m.method==='turn/start')result={turn:{id:'fixture-turn'}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start')setTimeout(()=>{console.log(JSON.stringify({method:'item/completed',params:{item:{type:'agentMessage',text:'fixture done'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}}));},20);});`.replace("JSON.stringify(m)+'\n'","JSON.stringify(m)+'\\n'"));
  const old=process.env.APPDATA;process.env.APPDATA=appdata;
  try {
    const result=await invokeCodex('fixture request',{directory:dir,effort:'low'});
    assert.equal(result.result,'fixture done');
    const methods=fs.readFileSync(calls,'utf8').trim().split('\n').map(l=>JSON.parse(l).method);
    assert.equal(methods.filter(m=>m==='turn/start').length,1);
    assert.equal(methods.filter(m=>m==='account/rateLimitResetCredit/consume').length,1);
    assert.ok(methods.indexOf('account/rateLimitResetCredit/consume')<methods.indexOf('turn/start'));
    assert.equal(read('.runtime/usage/quota.json').codex.limits.rateLimits.primary.usedPercent,0);
  } finally {if(old===undefined)delete process.env.APPDATA;else process.env.APPDATA=old;}
}));

test('the user can turn automatic card spending off and on through the existing settings owner',()=>isolated(()=>{
  assert.equal(settingsView().fields.find(f=>f.key==='automatic_codex_reset_credit').type,'bool');
  saveSettings({automatic_codex_reset_credit:false});assert.equal(read('agent/config.json').automatic_codex_reset_credit,false);
  saveSettings({automatic_codex_reset_credit:true});assert.equal(read('agent/config.json').automatic_codex_reset_credit,true);
  assert.throws(()=>saveSettings({automatic_codex_reset_credit:'yes'}),/开或关/);
}));
