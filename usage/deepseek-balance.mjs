import {read,write} from '../automation/files.mjs';

// Official read-only balance endpoint; never call a model or forward the key to a redirect.
// API contract: https://api-docs.deepseek.com/api/get-user-balance/
export async function refreshDeepSeekBalance() {
  const attempted_at=new Date().toISOString();
  let snapshot;
  try {
    const credentials=read('.runtime/deepseek-harness/credentials.json',{});
    if(!credentials.api_key)throw new Error('未配置 DeepSeek API Key');
    let response;
    try {
      response=await fetch('https://api.deepseek.com/user/balance',{
        headers:{Authorization:'Bearer '+credentials.api_key,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.timeout(10000),
      });
    } catch { throw new Error('DeepSeek 余额查询网络失败或超时'); }
    if(!response.ok)throw new Error('DeepSeek 余额接口返回 '+response.status);
    const data=await response.json();
    const money=v=>typeof v==='string' && /^-?\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v));
    if(typeof data?.is_available!=='boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length ||
      !data.balance_infos.every(b=>['CNY','USD'].includes(b?.currency) && ['total_balance','granted_balance','topped_up_balance'].every(k=>money(b[k]))))
      throw new Error('DeepSeek 余额响应格式无效');
    snapshot={source:'DeepSeek /user/balance（只读）',checked_at:new Date().toISOString(),is_available:data.is_available,
      balance_infos:data.balance_infos.map(({currency,total_balance,granted_balance,topped_up_balance})=>({currency,total_balance,granted_balance,topped_up_balance}))};
  } catch(error) {
    // Keep the last successful value, explicitly marked as old. Never store raw HTTP bodies, headers, or credential parse errors.
    const safe=/^(未配置 DeepSeek API Key|DeepSeek 余额查询网络失败或超时|DeepSeek 余额接口返回 \d{3}|DeepSeek 余额响应格式无效)$/;
    snapshot={...read('.runtime/usage/quota.json',{}).deepseek,error:safe.test(error.message) ? error.message : 'DeepSeek 余额读取失败',attempted_at};
  }
  const quota=read('.runtime/usage/quota.json',{});quota.deepseek=snapshot;write('.runtime/usage/quota.json',quota);
  return snapshot;
}
