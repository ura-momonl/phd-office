import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {parseResetStatus,fetchExtraResets,accountResetMessages} from './extra-resets.mjs';
import {refreshQuota} from './run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const pending={id:'2111492673890824348',kind:'reset_scheduled',resetType:'global',announcedAt:'2026-10-17T16:20:57.000Z',effectiveAt:'2026-10-17T08:00:00.000Z',text:'Day 13/ Le limit reset',confidence:0.8,source:{url:'https://x.com/thsottiaux/status/2111492673890824348'},schedulePrecision:'date',scheduleState:'pending',scheduleWindow:{startAt:'2026-10-17T08:00:00.000Z',endAt:'2026-10-18T08:00:00.000Z'}};
const status=(nextScheduled=pending)=>({ok:true,data:{currentTime:'2026-10-17T19:29:25.732Z',latestGlobal:{kind:'reset_completed'},latestBanked:null,nextScheduled}});

test('status payload yields a pending announcement window, no announcement, or a rejection; it never fabricates a time',()=>{
  const a=parseResetStatus(status());
  assert.equal(a.status,'announced');assert.equal(a.reset_type,'global');assert.equal(a.window_end,'2026-10-18T08:00:00.000Z');
  assert.equal(a.announced_at,'2026-10-17T16:20:57.000Z');assert.equal(a.confidence,0.8);assert.equal(a.precision,'date');
  assert.equal(a.original_url,'https://x.com/thsottiaux/status/2111492673890824348');
  assert.equal(parseResetStatus(status(null)).status,'none');
  assert.equal(parseResetStatus(status({...pending,scheduleState:'fulfilled'})).status,'none');
  assert.equal(parseResetStatus(status({...pending,resetType:'banked'})).reset_type,'banked');
  const noWindow=parseResetStatus(status({...pending,scheduleWindow:null}));assert.equal(noWindow.status,'unknown');assert.equal(noWindow.window_end,null);
  assert.equal(parseResetStatus(status({...pending,source:{url:'javascript:alert(1)'}})).original_url,null);
  assert.equal(parseResetStatus(status({...pending,confidence:5})).confidence,null);
  for(const payload of [null,{},{ok:false,data:status().data},{ok:true,data:{}},{ok:true,data:{latestGlobal:null}},status({...pending,kind:'reset_completed'})])assert.throws(()=>parseResetStatus(payload),/not recognized/);
});

test('the single source is fetched without credentials or retries and failures become an error record',async()=>{
  for(const failed of [false,true]){
    const calls=[];
    const result=await fetchExtraResets({now:new Date('2026-10-17T19:30:00Z'),fetchImpl:async(url,opts)=>{
      calls.push({url,opts});return failed?{ok:false,status:503}:{ok:true,json:async()=>status()};
    }});
    assert.deepEqual(calls.map(c=>c.url),['https://didcodexreset.com/openapi/v1/status']);
    assert.ok(!('Authorization' in calls[0].opts.headers));assert.equal(calls[0].opts.headers.Accept,'application/json');
    assert.equal(result.sources.length,1);const [source]=result.sources;
    assert.equal(source.id,'didcodexreset');assert.equal(source.checked_at,'2026-10-17T19:30:00.000Z');
    assert.equal(source.status,failed?'error':'announced');
    if(failed)assert.match(source.error,/503/);
  }
  const garbled=await fetchExtraResets({fetchImpl:async()=>({ok:true,json:async()=>({ok:true,data:{}})})});
  assert.equal(garbled.sources[0].status,'error');
});

test('account notices remain untrusted text and do not grant resets, execute tools or expose unrelated messages',()=>{
  const result=accountResetMessages({featureEnabled:true,messages:[
    {messageBody:'Extra usage reset planned; <script>doNotRun()</script>',createdAt:1791870000},
    {messageBody:'unrelated workspace secret'},
    {messageBody:'old reset notice',archivedAt:1},
  ]},'2026-10-13T06:00:00Z');
  assert.equal(result.messages.length,1);assert.match(result.messages[0].text,/<script>/);
  assert.equal(accountResetMessages({featureEnabled:false,messages:[]}).feature_enabled,false);
});

test('the existing quota refresh writes account notices and the public announcement while preserving ordinary windows and the other provider',async()=>{
  const quotaFile=path.join(root,'.runtime/usage/quota.json'),before=fs.existsSync(quotaFile)?fs.readFileSync(quotaFile):null;
  const dir=path.join(root,'.runtime/extra-reset-native-fixture');fs.mkdirSync(dir,{recursive:true});
  const bin=path.join(dir,'native.mjs'),methods=path.join(dir,'methods.jsonl');
  fs.writeFileSync(bin,`import fs from 'node:fs';import {createInterface} from 'node:readline';const rl=createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(methods)},JSON.stringify(m.method)+'\\n');if(m.id===undefined)return;let result={};if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:8,windowDurationMins:10080,resetsAt:1792472850}},rateLimitResetCredits:{availableCount:1}};if(m.method==='account/workspaceMessages/read')result={featureEnabled:true,messages:[{messageBody:'Extra usage reset announced',createdAt:1791870000}]};console.log(JSON.stringify({id:m.id,result}));});`);
  const oldBin=process.env.MAIL_FLOW_CODEX_BIN,oldProfile=process.env.USERPROFILE,oldFetch=globalThis.fetch;
  const deepseekFile=path.join(root,'.runtime/deepseek-harness/credentials.json'),oldDeepseek=fs.existsSync(deepseekFile)?fs.readFileSync(deepseekFile):null;
  write('.runtime/deepseek-harness/credentials.json',{api_key:'fake-deepseek-balance-test'});
  const profile=path.join(dir,'profile');fs.mkdirSync(path.join(profile,'.claude'),{recursive:true});
  fs.writeFileSync(path.join(profile,'.claude/.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fake-isolated-test-token'}}));
  process.env.MAIL_FLOW_CODEX_BIN=bin;process.env.USERPROFILE=profile;
  globalThis.fetch=async url=>{if(url==='https://api.deepseek.com/user/balance')return {ok:true,json:async()=>({is_available:true,balance_infos:[{currency:'CNY',total_balance:'6.40',granted_balance:'0.00',topped_up_balance:'6.40'}]})};if(url.includes('anthropic'))return {ok:true,json:async()=>({five_hour:{utilization:9,resets_at:'2026-10-13T10:00:00Z'}})};assert.equal(url,'https://didcodexreset.com/openapi/v1/status');return {ok:true,json:async()=>status()};};
  try{
    write('.runtime/usage/quota.json',{unrelated:{preserve:true},claude:{old:true}});
    const result=await refreshQuota(),calls=fs.readFileSync(methods,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(m=>m==='account/workspaceMessages/read').length,1);
    assert.ok(!calls.some(m=>/consume|turn\/start|mcpServer\/tool\/call/.test(m)));
    assert.equal(result.codex.limits.rateLimits.primary.usedPercent,8);assert.equal(result.codex.limits.rateLimitResetCredits.availableCount,1);
    assert.equal(result.claude.windows[0].remaining_percent,91);assert.equal(result.unrelated.preserve,true);
    assert.equal(result.deepseek.balance_infos[0].total_balance,'6.40');assert.ok(result.deepseek.checked_at);
    assert.equal(result.extra_resets.account.messages[0].text,'Extra usage reset announced');assert.equal(result.extra_resets.sources.length,1);
    assert.equal(result.extra_resets.sources[0].id,'didcodexreset');assert.equal(result.extra_resets.sources[0].window_end,'2026-10-18T08:00:00.000Z');
    assert.deepEqual(read('.runtime/usage/quota.json').extra_resets,result.extra_resets);
  }finally{
    globalThis.fetch=oldFetch;
    for(const [key,value] of [['MAIL_FLOW_CODEX_BIN',oldBin],['USERPROFILE',oldProfile]])if(value===undefined)delete process.env[key];else process.env[key]=value;
    if(before===null)fs.rmSync(quotaFile,{force:true});else fs.writeFileSync(quotaFile,before);
    if(oldDeepseek===null)fs.rmSync(deepseekFile,{force:true});else fs.writeFileSync(deepseekFile,oldDeepseek);
  }
});
