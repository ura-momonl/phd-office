import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {refreshCommandCodeQuota} from './commandcode-quota.mjs';
import {usageSnapshot,quotaView} from './run.mjs';
import {renderCommandCodeQuota} from '../dashboard/usage-view.js';
import {saveSettings,settingsView} from '../dashboard/settings.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const cc='.runtime/commandcode/credentials.json',official='.runtime/deepseek-harness/credentials.json',provider='.runtime/deepseek-harness/provider.json',quota='.runtime/usage/quota.json',config='agent/config.json';
const files=[cc,official,provider,quota,config,'.runtime/settings/changes.jsonl'];
async function fixture(fn) {
  const before=files.map(f=>fs.existsSync(path.join(root,f)) ? fs.readFileSync(path.join(root,f)) : null);
  try {await fn();} finally {files.forEach((f,i)=>{if(before[i]===null)fs.rmSync(path.join(root,f),{force:true});else fs.writeFileSync(path.join(root,f),before[i]);});}
}
const NOW=Date.parse('2026-10-25T17:00:00Z');
const reply={credits:{monthlyCredits:69.5,purchasedCredits:0},windowLimits:{fiveHour:{used:7,cap:14,resetAt:Date.parse('2026-10-25T20:00:00Z')},weekly:{used:3.5,cap:35,resetAt:Date.parse('2026-11-01T00:00:00Z')}}};

test('quota is a read-only GET with the Command Code key, keeps other providers, and renders both windows',()=>fixture(async()=>{
  const fetch=globalThis.fetch,urls=[];
  try {
    write(cc,{api_key:'fake-cc-secret',base_url:'https://api.commandcode.ai/provider/v1'});write(quota,{codex:{keep:true}});
    globalThis.fetch=async(url,options)=>{
      urls.push(url);assert.equal(options.method ?? 'GET','GET');assert.equal(options.headers.Authorization,'Bearer fake-cc-secret');assert.equal(options.redirect,'error');
      return {ok:true,json:async()=>url.endsWith('/credits') ? reply : {success:true,data:{planId:'individual-goat',currentPeriodEnd:'2026-11-25T16:19:29.000Z',userId:'must-not-persist'}}};
    };
    const q=await refreshCommandCodeQuota();
    assert.deepEqual(urls,['https://api.commandcode.ai/alpha/billing/credits','https://api.commandcode.ai/alpha/billing/subscriptions']);
    assert.equal(q.five_hour.remaining_percent,50);assert.equal(q.weekly.remaining_percent,90);assert.equal(q.plan,'individual-goat');assert.equal(q.monthly_credits,69.5);
    assert.deepEqual(read(quota).codex,{keep:true});assert.doesNotMatch(JSON.stringify(read(quota)),/fake-cc-secret|must-not-persist|Bearer/);
    const html=renderCommandCodeQuota(q,NOW);
    assert.match(html,/<b>50%<\/b>/);assert.match(html,/5小时 50% · 每周 90%/);assert.match(html,/width:50%/);assert.match(html,/已用 \$7\.00 \/ \$14\.00/);assert.match(html,/本月套餐余额 \$69\.50/);
    // After a window's reset time, the page shows it as started over instead of the old percentage.
    assert.match(renderCommandCodeQuota(q,Date.parse('2026-10-25T20:30:00Z')),/<b>90%<\/b>[\s\S]*5小时 100% · 每周 90%/);
    assert.match(renderCommandCodeQuota({...q,five_hour:{...q.five_hour,remaining_percent:10}},NOW),/class="crit"/);
  } finally {globalThis.fetch=fetch;}
}));

test('failure is not zero: last reading is kept and marked old; a missing key sends nothing',()=>fixture(async()=>{
  const fetch=globalThis.fetch;
  try {
    write(cc,{api_key:'fake-cc-secret',base_url:'https://api.commandcode.ai/provider/v1'});write(quota,{});
    globalThis.fetch=async()=>({ok:true,json:async()=>reply});const good=await refreshCommandCodeQuota();
    for(const response of [()=>{throw new Error('fake-cc-secret');},()=>({ok:false,status:401}),()=>({ok:true,json:async()=>({credits:{},windowLimits:{}})})]) {
      globalThis.fetch=async()=>response();const q=await refreshCommandCodeQuota();
      assert.ok(q.error);assert.equal(q.checked_at,good.checked_at);assert.equal(q.five_hour.remaining_percent,50);assert.doesNotMatch(JSON.stringify(q),/fake-cc-secret/);
      const html=renderCommandCodeQuota(q,NOW);
      assert.match(html,/<span>Command Code<\/span>/);
      assert.doesNotMatch(html,/上次读数/);
      assert.ok(html.includes(q.error),'query failure remains in the hover details');
    }
    // A subscription lookup that fails does not hide the credits.
    globalThis.fetch=async(url)=>url.endsWith('/credits') ? {ok:true,json:async()=>reply} : {ok:false,status:500};
    const noPlan=await refreshCommandCodeQuota();assert.equal(noPlan.error,undefined);assert.equal(noPlan.plan,null);
    fs.rmSync(path.join(root,cc));write(quota,{});globalThis.fetch=async()=>{assert.fail('missing key must not send a request');};
    const q=await refreshCommandCodeQuota();assert.equal(q.error,'未配置 Command Code API Key');assert.match(renderCommandCodeQuota(q,NOW),/不可用/);assert.match(renderCommandCodeQuota(),/>—</);
  } finally {globalThis.fetch=fetch;}
}));

test('settings switch the DeepSeek channel and fast model together; fast is refused on the official channel',()=>fixture(async()=>{
  write(official,{api_key:'fake-official',base_url:'https://api.deepseek.com/anthropic'});
  write(provider,{provider:'official'});
  const field=key=>settingsView().fields.find(f=>f.key===key);
  assert.equal(field('deepseek_provider').value,'official');
  assert.deepEqual(field('deepseek_model').options.map(o=>o.value),['deepseek-flash','deepseek-flash-fast']);
  // No Command Code key yet: refused, nothing written.
  fs.rmSync(path.join(root,cc),{force:true});
  assert.throws(()=>saveSettings({deepseek_provider:'commandcode'}),/凭据未配置/);assert.equal(read(provider).provider,'official');
  write(cc,{api_key:'fake-cc',base_url:'https://api.commandcode.ai/provider/v1'});
  // Fast needs the Command Code channel, whichever field is edited first.
  const model=read(config).deepseek_model;
  assert.throws(()=>saveSettings({deepseek_model:'deepseek-flash-fast'}),/只有 Command Code/);assert.equal(read(config).deepseek_model,model);
  saveSettings({deepseek_provider:'commandcode',deepseek_model:'deepseek-flash-fast'});
  assert.equal(read(provider).provider,'commandcode');assert.equal(read(config).deepseek_model,'deepseek-flash-fast');assert.equal(read(config).deepseek_provider,undefined);
  assert.equal(usageSnapshot().quota.deepseek_provider,'commandcode');assert.equal(quotaView().deepseek_provider,'commandcode'); // the page state on tabs without the usage view reads this
  assert.throws(()=>saveSettings({deepseek_provider:'official'}),/只有 Command Code/);assert.equal(read(provider).provider,'commandcode');
  saveSettings({deepseek_provider:'official',deepseek_model:'deepseek-flash'});
  assert.equal(read(provider).provider,'official');assert.equal(usageSnapshot().quota.deepseek_provider,'official');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,cc),'utf8')).api_key,'fake-cc');
}));
