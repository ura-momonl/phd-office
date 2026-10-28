// A user-authorized once-per-local-day job on the EXISTING office beat/queue.
// No timer, direct model API, automatic retries, or PDF downloads here.
import { read, root } from '../automation/files.mjs';
import { enqueue } from '../work/run.mjs';
import { literatureGoal } from '../prompts/templates.mjs';
import { localDay, recommendationDay } from './recommendations.mjs';
export const dailyJobId=date=>'literature-daily-'+date;
export function ensureDailyRecommendations({now=new Date(),enqueueJob=enqueue}={}) {
  const config=read('literature/sources.json').daily_recommendations;
  if(!config?.enabled || !read('agent/config.json').enabled)return {state:'disabled'};
  const date=localDay(now);
  if(recommendationDay(date).published)return {state:'published',date};
  const jobs=read('work/queue.json').items,existing=jobs.find(j=>j.id===dailyJobId(date));
  if(existing)return {state:existing.status,date,task_id:existing.id}; // Failed/cancelled is not an invitation to retry.
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Chicago',hour:'2-digit',hourCycle:'h23'}).format(new Date(now)));
  if(hour<(config.not_before_hour ?? 8))return {state:'not-due',date};
  if(jobs.some(j=>j.actor!=='user' && ['queued','active'].includes(j.status)))return {state:'busy',date};
  const lines=read('literature/sources.json').lines;
  const goal=literatureGoal.daily({date,rules:[lines.reading,lines.picks].join('\n\n'),file:`${root}/literature/recommendations/${date}.json`});
  const item=enqueueJob({title:'每日文献推荐 · '+date,kind:'literature',actor:config.actor || 'codex',status:'queued',project_ids:[],
    goal,sources:['用户2026-10-17：每天推荐一点，可多可少，不严格限定；本地文献页发布，不自动下载。'],require_outputs:true},{internalId:dailyJobId(date)});
  return {state:'queued',date,task_id:item.id};
}
