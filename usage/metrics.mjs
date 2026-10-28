// One owner for local ledger interpretation. These are observed token indicators,
// not account quota, dollars, or invoiced tokens. Keep legacy aggregate field names
// for existing weekly/UI consumers; cached input must not be mistaken for free.
export const purposes={mail:'邮件判断',card:'卡片处理',auto:'自动步骤',chat:'对话',adventure:'文字冒险（已停用）','companion-note':'每日留言',title:'对话起标题','quota-probe':'额度探测','memory-extract':'记忆整理',review:'审批复核',unlabeled:'未标注（旧记录）'};
export const purposeOf=r=>r.purpose || (String(r.id || '').startsWith('mail-judge-') ? 'mail' : r.feature==='quota-probe' ? 'quota-probe' : 'unlabeled');
export const known=r=>r.usage_known!==false && Number.isFinite(r.input_tokens) && Number.isFinite(r.output_tokens);
export const observed=r=>known(r) || r.usage_partial===true && Number.isFinite(r.input_tokens) && Number.isFinite(r.output_tokens);
export const billed=r=>observed(r) ? Math.max(0,r.input_tokens-(r.cached_input_tokens || 0))+r.output_tokens : 0;
// View-only projections: one original task may contribute to several model rows.
// Never feed these rows to provider/weekly call totals.
export function modelUsageRuns(runs) {
  return runs.flatMap(r=>!Object.keys(r.model_usage || {}).length ? [r] : Object.entries(r.model_usage).map(([model,u])=>({
    ...r, model, input_tokens:[u.inputTokens,u.cacheReadInputTokens,u.cacheCreationInputTokens].every(Number.isFinite) ? u.inputTokens+u.cacheReadInputTokens+u.cacheCreationInputTokens : null,
    cached_input_tokens:Number.isFinite(u.cacheReadInputTokens)?u.cacheReadInputTokens:null, cache_creation_tokens:Number.isFinite(u.cacheCreationInputTokens)?u.cacheCreationInputTokens:null,
    output_tokens:Number.isFinite(u.outputTokens)?u.outputTokens:null, duration_ms:null, tool_calls:null, model_projection:true
  })));
}
export function usageGroups(runs,keyOf) {
  const groups=new Map();
  for(const r of runs) {
    const key=keyOf(r),g=groups.get(key) || {key,calls:0,failed:0,unknown:0,partial:0,billed:0,input:0,cached:0,output:0,failedBilled:0,ms:0,tools:0};
    g.calls++;g.ms+=r.duration_ms || 0;g.tools+=r.tool_calls || 0;
    if(r.status!=='completed')g.failed++;
    if(observed(r)){g.billed+=billed(r);g.input+=r.input_tokens;g.output+=r.output_tokens;g.cached+=r.cached_input_tokens || 0;if(!known(r))g.partial++;if(r.status!=='completed')g.failedBilled+=billed(r);}else g.unknown++;
    groups.set(key,g);
  }
  return [...groups.values()].sort((a,b)=>b.billed-a.billed);
}

// Effective output speed per model, read from the existing ledger (no new recording needed): output tokens / wall time of the whole call.
// That includes queueing, reading the context and thinking, so it is a practical "how fast do I get an answer" figure, not the pure decoding speed.
// Calls with tool use are mostly waiting on tools (and subagent tokens are added to the parent), so the headline figure uses only completed,
// tool-free calls with enough output (>=300 tokens) for the start-up delay not to dominate; the all-calls figure is kept for reference.
export const SPEED_MIN_OUTPUT=300;
export function speedGroups(runs,keyOf=r=>r.provider+'|'+r.model) {
  const groups=new Map(),median=v=>{const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2 ? s[m] : (s[m-1]+s[m])/2;};
  for(const r of runs) {
    if(r.model_projection || r.status!=='completed' || !known(r) || !(r.duration_ms>0))continue;
    const key=keyOf(r),g=groups.get(key) || {key,rates:[],allOut:0,allMs:0,calls:0};
    g.calls++;g.allOut+=r.output_tokens;g.allMs+=r.duration_ms;
    if(r.tool_calls===0 && r.output_tokens>=SPEED_MIN_OUTPUT)g.rates.push(r.output_tokens/(r.duration_ms/1000));
    groups.set(key,g);
  }
  return [...groups.values()].map(g=>({key:g.key,samples:g.rates.length,median:g.rates.length ? median(g.rates) : null,calls:g.calls,all_calls_rate:g.allMs ? g.allOut/(g.allMs/1000) : null}))
    .sort((a,b)=>b.samples-a.samples || b.calls-a.calls);
}
