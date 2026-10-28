import {read,write} from '../automation/files.mjs';

// Command Code's own CLI reads /alpha/billing/credits with the API key (the same numbers as its /usage command).
// It is not in the public API docs, so a changed format shows as an error and the last good reading is kept, marked old.
// Read-only GET; never calls a model and never forwards the key to a redirect.
const BASE='https://api.commandcode.ai/alpha/billing/';
const get=async(path,key)=>{
  let response;
  try {
    response=await fetch(BASE+path,{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
  } catch { throw new Error('Command Code 额度查询网络失败或超时'); }
  if(!response.ok)throw new Error('Command Code 额度接口返回 '+response.status);
  return response.json();
};
const num=v=>typeof v==='number' && Number.isFinite(v);
const windowOf=w=>num(w?.used) && num(w?.cap) && w.cap>0 ? {used:w.used,cap:w.cap,remaining_percent:Math.max(0,Math.min(100,Math.round(100*(1-w.used/w.cap)))),
  resets_at:num(w.resetAt) ? new Date(w.resetAt).toISOString() : null} : null;

export async function refreshCommandCodeQuota() {
  const attempted_at=new Date().toISOString();
  let snapshot;
  try {
    const credentials=read('.runtime/commandcode/credentials.json',{});
    if(!credentials.api_key || credentials.base_url!=='https://api.commandcode.ai/provider/v1')throw new Error('未配置 Command Code API Key');
    const data=await get('credits',credentials.api_key);
    const five=windowOf(data?.windowLimits?.fiveHour),week=windowOf(data?.windowLimits?.weekly);
    if(!num(data?.credits?.monthlyCredits) || !five || !week)throw new Error('Command Code 额度响应格式无效');
    // The plan name is optional decoration: its failure must not hide the numbers above.
    let plan=null,period_end=null;
    try {
      const sub=(await get('subscriptions',credentials.api_key))?.data;
      plan=typeof sub?.planId==='string' ? sub.planId : null;
      period_end=Number.isFinite(Date.parse(sub?.currentPeriodEnd)) ? new Date(sub.currentPeriodEnd).toISOString() : null;
    } catch { /* keep the credits reading */ }
    snapshot={source:'Command Code /alpha/billing/credits（只读）',checked_at:new Date().toISOString(),
      monthly_credits:data.credits.monthlyCredits,purchased_credits:num(data.credits.purchasedCredits) ? data.credits.purchasedCredits : 0,
      five_hour:five,weekly:week,plan,period_end};
  } catch(error) {
    // Keep the last good value, marked old. Never store raw bodies, headers or credential parse errors.
    const safe=/^(未配置 Command Code API Key|Command Code 额度查询网络失败或超时|Command Code 额度接口返回 \d{3}|Command Code 额度响应格式无效)$/;
    snapshot={...read('.runtime/usage/quota.json',{}).commandcode,error:safe.test(error.message) ? error.message : 'Command Code 额度读取失败',attempted_at};
  }
  const quota=read('.runtime/usage/quota.json',{});quota.commandcode=snapshot;write('.runtime/usage/quota.json',quota);
  return snapshot;
}
