// Breakdown of the local call ledger, so the expensive spots are visible at a glance.
// Ledger calculations belong to usage; this module only formats the public view.
import {purposes,purposeOf,observed,billed,usageGroups,modelUsageRuns,speedGroups,SPEED_MIN_OUTPUT} from '../usage/metrics.mjs';
import {esc,int as num,when} from './format.js';
export {purposes,purposeOf,observed,billed,usageGroups,modelUsageRuns} from '../usage/metrics.mjs';
const who={claude:'Claude',codex:'Codex',deepseek:'DeepSeek'};
const seconds=ms=>ms>=60000 ? (ms/60000).toFixed(1)+' 分' : (ms/1000).toFixed(0)+' 秒';

// Official pricing (checked 2026-10-21): Beijing Mon–Fri 09–12 / 14–18,
// excluding Chinese public holidays; weekends remain off-peak even on make-up workdays.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// 2026 holiday schedule: https://www.gov.cn/zhengce/content/202511/content_7047090.htm
const deepseekHolidays2026=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function deepseekPricePeriod(now=Date.now()) {
  const beijing=new Date(now+8*3600000),weekday=beijing.getUTCDay(),hour=beijing.getUTCHours();
  if(weekday===0 || weekday===6 || !(hour>=9 && hour<12 || hour>=14 && hour<18))return '谷值';
  // Do not silently treat an unmaintained holiday calendar as a known peak day.
  if(beijing.getUTCFullYear()!==2026)return '时段待核';
  const day=beijing.toISOString().slice(5,10);
  return deepseekHolidays2026.some(([start,end])=>day>=start && day<=end) ? '谷值' : '峰值';
}

// Cash balance is not a subscription percentage: no invented meter or reset time.
export function renderDeepSeekBalance(q,now=Date.now()) {
  const balances=q?.balance_infos || [];
  const amount=b=>`${b.currency==='CNY' ? '¥' : '$'}${b.total_balance}`;
  const value=balances.length ? balances.map(amount).join(' / ') : '—';
  const label=q?.error ? (balances.length ? '余额（上次）' : '余额不可用') : '余额';
  const details=[...balances.map(b=>`${b.currency} 总余额 ${b.total_balance}；赠金 ${b.granted_balance}；充值 ${b.topped_up_balance}`),
    q?.is_available===false ? '账号当前不可调用 API' : '',q?.error || '',q?.checked_at ? '上次成功查询：'+when(q.checked_at) : '尚未查询余额',
    '这是 DeepSeek 官方账户余额，不包含 Command Code 套餐额度；点击打开 DeepSeek 开放平台充值页','峰谷按北京时间：周一至周五 09:00–12:00、14:00–18:00 为峰值；其余时间、周末及中国法定节假日为谷值（半价）。节假日表覆盖 2026 年，未覆盖年份的高峰候选时段显示待核'].filter(Boolean).join('。');
  return `<button class="header-quota header-balance" data-provider="deepseek" data-open-url="https://platform.deepseek.com/top_up" title="${esc(details)}"><div><span>DeepSeek · ${label} · <span data-price-period>${deepseekPricePeriod(now)}</span></span></div><b>${esc(value)}</b></button>`;
}

// Command Code plan: two rolling windows in credit value (USD), plus the month's remaining credits. Same numbers as its /usage command.
// Windows as the usage page's cards want them; one that has passed its reset time counts as started over.
export const commandCodeWindows=(q,now=Date.now())=>[['5 小时窗口',q?.five_hour],['每周窗口',q?.weekly]].filter(([,w])=>w)
  .map(([label,w])=>{const over=w.resets_at && Date.parse(w.resets_at)<=now;return {label,remaining:over ? 100 : w.remaining_percent,resetsAt:over ? null : w.resets_at,used:w.used,cap:w.cap};});
export function renderCommandCodeQuota(q,now=Date.now()) {
  const chicago=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const live=w=>w && !(w.resets_at && Date.parse(w.resets_at)<=now); // a window whose reset time has passed has started over; the page refreshes soon
  const left=w=>!w ? null : live(w) ? w.remaining_percent : 100;
  const five=left(q?.five_hour),week=left(q?.weekly),have=five!==null && week!==null,min=have ? Math.min(five,week) : null;
  const money=v=>'$'+Number(v).toFixed(2);
  const row=(label,w)=>w ? `${label}：已用 ${money(w.used)} / ${money(w.cap)}，${live(w) ? '重置 '+(w.resets_at ? chicago(w.resets_at)+' Chicago' : '时间未记录') : '已重置，待刷新'}` : '';
  const details=[row('5 小时窗口',q?.five_hour),row('每周窗口',q?.weekly),
    Number.isFinite(q?.monthly_credits) ? `本月套餐余额 ${money(q.monthly_credits)}${q.purchased_credits ? '；另有充值 '+money(q.purchased_credits) : ''}${q.plan ? '（'+q.plan+'）' : ''}${q.period_end ? '，计费周期至 '+chicago(q.period_end) : ''}` : '',
    q?.error || '',q?.checked_at ? '上次成功查询：'+when(q.checked_at) : '尚未查询额度',
    '这是 Command Code 套餐额度（按用量金额计，不是 token 数）；点击打开用量页。官方 DeepSeek 余额在使用官方通道时显示'].filter(Boolean).join('。');
  const label=q?.error && !have ? ' · 不可用' : '';
  const value=have ? `${min}%` : '—';
  const cls=min===null ? '' : min<20 ? 'crit' : min<45 ? 'warn' : '';
  return `<button class="header-quota" data-provider="deepseek" data-open-url="https://commandcode.ai/usage" title="${esc(details)}"><div><span>Command Code${label}</span><b>${value}</b></div><div class="meter">${have ? `<i class="${cls}" style="width:${min}%"></i>` : ''}</div><small class="header-reset">${have ? `剩余 · 5小时 ${five}% · 每周 ${week}%` : '5小时 / 每周窗口'}</small></button>`;
}

const share=(value,total)=>total ? `<div class="meter"><i class="tone-ok" style="width:${Math.round(100*value/total)}%"></i></div><small>${(100*value/total).toFixed(0)}%</small>` : '—';
const header=cols=>`<thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>`;
const table=(label,html)=>`<div class="usage-table-scroll" tabindex="0" role="region" aria-label="${esc(label)}，可左右滑动">${html}</div>`;

// The three tables and the footnote, as separate pieces so the page can keep each one in its own fold (a re-render must not reset what the user opened).
export function usageSections(runs,titleOf=()=>'') {
  if(!runs.length)return {provider:'',use:'',speed:'',top:'',note:''};
  const total=runs.reduce((s,r)=>s+billed(r),0);
  const row=(label,g,modelOnly=false)=>`<tr><td>${label}</td><td>${g.calls}${g.unknown ? `<br><span class="muted">${g.unknown} 次无用量</span>` : ''}${g.partial ? `<br><span class="muted">${g.partial} 次仅部分用量</span>` : ''}</td><td>${g.failed ? `${g.failed}<br><span class="muted">耗 ${num(g.failedBilled)}</span>` : '0'}</td><td>${num(g.input)}</td><td>${num(g.output)}</td><td>${num(g.billed)}</td><td class="share">${share(g.billed,total)}</td><td>${num(g.cached)}</td><td>${num(g.billed/Math.max(1,g.calls-g.unknown))}</td><td>${modelOnly ? '—' : seconds(g.ms/g.calls)}</td><td>${modelOnly ? '—' : (g.tools/g.calls).toFixed(1)}</td></tr>`;
  const cols=['调用','失败','总输入（含缓存）','总输出','非缓存输入＋输出','指标占比','缓存输入','每次指标','平均耗时','每次工具'];
  const byProvider=usageGroups(runs,r=>r.provider).map(g=>row(esc(who[g.key] || g.key),g)).join('');
  const byUse=usageGroups(modelUsageRuns(runs),r=>[r.provider,purposeOf(r),r.model].join('|')).map(g=>{
    const [p,f,m]=g.key.split('|');return row(`${esc(who[p] || p)} · ${esc(purposes[f] || f)}<br><span class="muted">${esc(m)}</span>`,g,true);
  }).join('');
  const top=runs.filter(observed).sort((a,b)=>billed(b)-billed(a)).slice(0,8).map(r=>
    `<tr><td>${when(r.at)}</td><td>${esc(who[r.provider] || r.provider)}<br><span class="muted">${esc(purposes[purposeOf(r)])}</span></td><td class="wrap">${esc(titleOf(r.id) || '—')}</td><td>${r.usage_partial ? '≥ ' : ''}${num(billed(r))}</td><td>${seconds(r.duration_ms || 0)}</td><td>${r.tool_calls || 0}</td><td>${r.status==='completed' ? '完成' : '未完成'}${r.usage_partial ? ' · 部分用量' : ''}</td></tr>`).join('');
  const rate=v=>v===null ? '—' : v.toFixed(v<10 ? 1 : 0)+' tok/s';
  const speedRows=speedGroups(runs).map(g=>{const [p,m]=g.key.split('|');return `<tr><td>${esc(who[p] || p)}<br><span class="muted">${esc(m)}</span></td><td>${g.samples}${g.samples<3 ? '<br><span class="muted">样本少</span>' : ''}</td><td>${rate(g.median)}</td><td>${g.calls}</td><td>${rate(g.all_calls_rate)}</td></tr>`;}).join('');
  const speed=table('输出速率（按模型）',`<table class="usage-table">${header(['模型','样本','输出速率（中位）','完成调用','全部调用均值'])}<tbody>${speedRows}</tbody></table><p class="muted footnote">输出速率 = 输出 token ÷ 整次调用耗时，含排队、读入上下文和推理，不是纯生成速度。中位数只统计完成的、没有工具调用且输出不少于 ${SPEED_MIN_OUTPUT} token 的调用（样本）；有工具的调用大半在等工具，子 agent 的 token 还会记到主调用上，所以“全部调用均值”只作参考。</p>`);
  return {
    speed,
    provider:table('按执行者',`<table class="usage-table">${header(['执行者',...cols])}<tbody>${byProvider}</tbody></table>`),
    use:table('按用途与模型（每模型调用数不能跨模型相加；耗时与工具不可按模型归因）',`<table class="usage-table">${header(['用途 · 模型',...cols])}<tbody>${byUse}</tbody></table>`),
    top:table('最多的 8 次调用',`<table class="usage-table">${header(['时间','执行者','任务','非缓存输入＋输出','耗时','工具','状态'])}<tbody>${top}</tbody></table>`),
    note:'总输入包含缓存命中，缓存输入是其中一部分，不要再次相加；总输入和总输出按已观测记录汇总。DeepSeek 包含本轮子助手；仅部分用量仍计入已发生的消耗，汇总是下界，无用量不当作零消耗。指标 = 输入扣除缓存命中 + 输出，不是计费 token、美元费用或账号扣额，缓存仍可能计费。各家 token 口径不同，只在各自内部比较；失败行仍保留用量，但不把它自动等同于无效工作。用途与模型表的调用数指参与该模型的任务数，跨模型不能相加；耗时和工具不按模型归因，显示为 —。'};
}
// Same content as one block (kept for callers that want a single string).
export function usageBreakdown(runs,titleOf=()=>'') {
  const v=usageSections(runs,titleOf);
  return runs.length ? `<div class="usage-breakdown"><h3>按执行者</h3>${v.provider}<h3>按用途与模型</h3>${v.use}<h3>非缓存输入＋输出最多的 8 次调用</h3>${v.top}<p class="muted footnote">${v.note}</p></div>` : '';
}
// Large token counts read better in 万 / 亿; the exact figure stays in the tooltip.
export const big=n=>{const v=Math.round(Number(n || 0));return v>=1e8 ? (v/1e8).toFixed(2)+' 亿' : v>=1e4 ? (v/1e4).toFixed(1)+' 万' : v.toLocaleString('zh-CN');};

// Extra reset notices share the already-published quota view module.
const extraDate=s=>Number.isFinite(Date.parse(s))?new Date(s).toLocaleString('zh-CN',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未记录';

function resetOutlook(snapshot,now){
  const url='https://didcodexreset.com/';
  const f=snapshot?.sources?.find(s=>s.id==='didcodexreset');
  if(!f)return {text:'额外：待刷新',url,title:'尚未取得公开预告；不是没有下一次重置'};
  if(f.status==='error')return {text:'额外：暂不可用',url,title:'公开预告读取失败，不能据此判断是否会重置'};
  const age=now-Date.parse(f.checked_at);
  // The local quota refresh runs about every 10 minutes; older data is not shown as current.
  if(!Number.isFinite(age)||age>20*60000||age< -5*60000)return {text:'额外：预告过期',url,title:'预告数据超过有效期，请更新额度；不显示旧预告'};
  if(!['announced','unknown','none'].includes(f.status))return {text:'额外：暂不可用',url,title:'预告数据格式无效'};
  if(f.status==='none')return {text:'额外：暂无已公布预告',url,title:'Did Codex Reset 当前没有待执行的 Tibo 预告；不代表不会重置'};
  const link=/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(f.original_url)?f.original_url:url,kind=f.reset_type==='banked'?'储备重置':'全局重置';
  const end=Date.parse(f.window_end);
  if(f.status==='unknown'||!Number.isFinite(end))return {text:`额外预告：${kind}（时间未解析）`,url:link,title:'站点读到一条待执行预告，但没有解析出时间窗口；点击看原帖'};
  if(end<=now)return {text:'额外：暂无已公布预告',url,title:'最近一条预告的窗口已过，站点尚未标记完成或取消；以原帖和账号额度为准'};
  const conf=typeof f.confidence==='number'?`；站点解析置信度 ${Math.round(f.confidence*100)}%`:'';
  return {announced:true,end,kind,text:`额外预告：${extraDate(f.window_end)}前`,url:link,
    title:`${kind}，来自 Tibo 帖子，由 Did Codex Reset 解析：${f.precision==='date'?'只精确到日期，实际时刻以原帖为准':'含具体时间'}${conf}；发布 ${extraDate(f.announced_at)} Chicago。不是个人到账保证；点击看原帖。`};
}

// A current, unexpired announcement (the same one the quota page prints), or null. Callers decide how to show it; it is an announced window, not a guarantee.
export function announcedReset(snapshot,now=Date.now()){
  const view=resetOutlook(snapshot,now);
  return view.announced ? {end:view.end,kind:view.kind,url:view.url,title:view.title,until:extraDate(new Date(view.end).toISOString())} : null;
}

export function extraResetSummary(snapshot,now=Date.now()){
  return resetOutlook(snapshot,now).text;
}

export function renderExtraResets(snapshot,{now=Date.now()}={}){
  const view=resetOutlook(snapshot,now);
  return ` <span class="quota-reset-extra" data-extra-reset>｜<a href="${view.url}" target="_blank" rel="noopener noreferrer" title="${esc(view.title)}">${esc(view.text)}</a></span>`;
}
