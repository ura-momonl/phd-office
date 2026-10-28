import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read} from '../automation/files.mjs';

// Only the ordinary Codex bucket, never another product's exhausted quota.
export function exhaustedCodexWindows(limits,now=Date.now()) {
  const bucket=limits?.rateLimitsByLimitId?.codex || limits?.rateLimits;
  if(!bucket || (bucket.limitId && bucket.limitId!=='codex'))return [];
  return ['primary','secondary'].flatMap(name=>{
    const w=bucket[name];
    return Number.isFinite(w?.usedPercent) && w.usedPercent>=100 && Number.isFinite(w.resetsAt) && w.resetsAt*1000>now
      ? [{name,resetsAt:w.resetsAt}] : [];
  });
}

const audit=entry=>{
  const file=path.join(root,'.runtime/usage/reset-credits.jsonl');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
};

// Official account RPC: https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt
// No model turn, purchase, timer, or task replay.
// Concurrent processes derive the SAME key for the SAME opaque credit. The
// service owns idempotency, including a response lost after a successful reset.
export async function resetExhaustedCodexQuota(rpc,limits) {
  if(read('agent/config.json').automatic_codex_reset_credit!==true)return {limits};
  const windows=exhaustedCodexWindows(limits),bank=limits?.rateLimitResetCredits;
  if(!windows.length || !(bank?.availableCount>0))return {limits};
  const now=Date.now()/1000;
  const credits=bank.credits?.filter(c=>c.status==='available' && c.resetType==='codexRateLimits' && typeof c.id==='string' && c.id && (c.expiresAt==null || c.expiresAt>now))
    .sort((a,b)=>(a.expiresAt ?? Infinity)-(b.expiresAt ?? Infinity) || a.id.localeCompare(b.id));
  // A fetched empty/expired detail list is not authority to select a different
  // credit. When only a count is provided, let the official service choose.
  if(credits && !credits.length)return {limits};
  const creditId=credits?.[0]?.id;
  const identity=JSON.stringify(['office-codex-reset-v1',limits.accountId || '',creditId || windows]);
  const hex=createHash('sha256').update(identity).digest('hex');
  const idempotencyKey=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  const attempt={idempotencyKey,...(creditId ? {creditId} : {}),windows};
  audit({...attempt,outcome:'submitted'}); // Fail before redemption if the local audit cannot be written.
  let outcome;
  try {
    const response=await rpc('account/rateLimitResetCredit/consume',{idempotencyKey,...(creditId ? {creditId} : {})});
    outcome=response?.outcome;
    if(!['reset','alreadyRedeemed','nothingToReset','noCredit'].includes(outcome))throw new Error('重置卡接口返回未知结果');
    audit({...attempt,outcome});
    // Never infer the new windows or remaining cards from a consume response.
    return {limits:await rpc('account/rateLimits/read'),automatic_reset:{...attempt,outcome,at:new Date().toISOString()}};
  } catch(error) {
    const automatic_reset={...attempt,outcome:outcome || 'unknown',error:error.message,at:new Date().toISOString()};
    audit(automatic_reset);
    return {limits,automatic_reset};
  }
}
