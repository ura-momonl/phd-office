// Single public source: didcodexreset.com's read-only JSON API (no key, 60 requests/hour), which parses Tibo's posts.
// It reports announced schedules only; a changed/unrecognized payload is an error, never "no reset is coming".
const source={id:'didcodexreset',name:'Did Codex Reset',url:'https://didcodexreset.com/',api:'https://didcodexreset.com/openapi/v1/status'};
const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))?new Date(s).toISOString():null;
const postUrl=s=>typeof s==='string'&&/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(s)?s:null;

export function parseResetStatus(body){
  const data=body?.data;
  if(body?.ok!==true||!data||typeof data!=='object'||!('nextScheduled' in data)||!('latestGlobal' in data))throw new Error('Reset status not recognized');
  const next=data.nextScheduled;
  const base={id:source.id,name:source.name,url:source.url};
  if(next===null)return {...base,status:'none'};
  if(typeof next!=='object'||next.kind!=='reset_scheduled')throw new Error('Reset status not recognized');
  if(next.scheduleState!=='pending')return {...base,status:'none'};
  const window_end=iso(next.scheduleWindow?.endAt),window_start=iso(next.scheduleWindow?.startAt);
  return {...base,status:window_end?'announced':'unknown',reset_type:next.resetType==='banked'?'banked':'global',
    window_start,window_end,announced_at:iso(next.announcedAt),precision:next.schedulePrecision==='date'?'date':'time',
    confidence:typeof next.confidence==='number'&&next.confidence>=0&&next.confidence<=1?next.confidence:null,
    original_url:postUrl(next.source?.url)};
}

export async function fetchExtraResets({fetchImpl=fetch,now=new Date()}={}){
  const checked_at=now.toISOString();
  try{
    const response=await fetchImpl(source.api,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return {checked_at,sources:[{...parseResetStatus(await response.json()),checked_at}]};
  }catch(e){return {checked_at,sources:[{...source,status:'error',checked_at,error:String(e.message||e).slice(0,180)}]};}
}

export function accountResetMessages(result,checked_at=new Date().toISOString()){
  return {checked_at,feature_enabled:result?.featureEnabled===true,
    messages:(Array.isArray(result?.messages)?result.messages:[]).filter(m=>!m.archivedAt&&/reset|重置|额度|usage/i.test(m.messageBody||''))
      .slice(0,5).map(m=>({text:String(m.messageBody).slice(0,1000),created_at:Number.isFinite(m.createdAt)?new Date(m.createdAt*1000).toISOString():null}))};
}
