import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read,write} from '../automation/files.mjs';
import {connectionStatus,selectConnection} from '../software/deepseek-harness/connection.mjs';

// Whitelisted settings keep their owning source: calls in agent/config.json,
// new-task defaults in work/policy.json. Saving never starts or rewrites a task.
const FILE='agent/config.json',LOG='.runtime/settings/changes.jsonl';
const POLICY='work/policy.json',TASK_KINDS=['mail','literature','presentation'];
const EFFORT=['low','medium','high','xhigh'];
const DEEPSEEK_EFFORT=['off','low','high','max'];
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,59}$/;
const SWITCH='更换模型或推理强度后，该助手已有对话的下一轮不再续接原生会话而是重开，历史记录不受影响。';
export const GROUPS=[
  {id:'models',title:'模型与推理',note:'对话和后台调用使用的模型。模型名不会联网校验，填错会在下一次调用时报错，改回即可。'},
  {id:'mail',title:'邮件与自动化',note:'后台收件判断会消耗额度；每日调用上限是安全网，不是额度规划。'},
  {id:'memory',title:'记忆与上下文',note:'被动记忆在对话闲置后整理；上下文压缩在对话过长时调用一次小模型。'}];
const GROUP_SECTIONS={models:['chat','tasks','title'],mail:['judge','batch','tiers','cap'],memory:['passive','extract']};
// section: a small heading inside a group. llm: the setting makes the office call a model (and so spends quota) when it takes effect.
const bool=(key,group,label,help,extra)=>({key,group,label,help,type:'bool',...extra});
const num=(key,group,label,help,min,max,unit,extra)=>({key,group,label,help,type:'int',min,max,unit,...extra});
const pick=(key,group,label,help,options,extra)=>({key,group,label,help,type:'enum',options,...extra});
// provider says whose model list applies: 'claude', 'codex', or 'title' (follows title_provider in the config).
const model=(key,group,label,help,provider,extra)=>({key,group,label,help,type:'model',provider,...extra});
const SECTIONS={
  chat:{id:'chat',title:'对话',note:'每位助手的模型后面可单独选择推理强度；越高通常越慢、越耗额度。'},
  title:{id:'title',title:'对话标题',note:'给新对话起标题的小调用。每个对话最多起两次：第一次几乎没内容，对话够长后再起一次。'},
  tasks:{id:'tasks',title:'新建任务默认模型',note:'邮件、文献、汇报分别选择模型，执行助手随模型切换。只影响之后新建的任务；已有任务、普通聊天和后台收件判断不变。保存不会启动任务。'},
  judge:{id:'judge',title:'收件判断',note:'新邮件进入账本后是否自动让模型看一遍。'},
  batch:{id:'batch',title:'攒批',note:'零星来信先等一等再合并判断，省调用次数。'},
  tiers:{id:'tiers',title:'判断分档',note:'先用便宜的模型粗筛，拿不准再升到判断档。'},
  cap:{id:'cap',title:'额度安全网',note:'防止后台自动调用失控；不是额度规划。'},
  passive:{id:'passive',title:'被动整理',note:'对话闲置后，由后台把经历整理进各自的办公室记忆。'},
  extract:{id:'extract',title:'整理用的模型',note:'整理记忆时调用的模型，只能选 Codex 一侧的模型（配置里的提供者固定为 Codex）。'}};
export const FIELDS=[
  pick('default_provider','models','默认回答者','没有点名且没有上一位时由谁回答。',['codex','claude','deepseek'],{section:'chat'}),
  model('claude_model','models','Claude 模型','别名（sonnet、opus）或完整模型名。'+SWITCH,'claude',{section:'chat',llm:true}),
  {...pick('claude_reasoning_effort','models','Claude 推理强度','',EFFORT),pair:'claude_model'},
  model('codex_model','models','Codex 模型','Codex 对话使用的模型 id。'+SWITCH,'codex',{section:'chat',llm:true}),
  {...pick('reasoning_effort','models','Codex 推理强度','',EFFORT),pair:'codex_model'},
  pick('deepseek_provider','models','DeepSeek 计费通道','决定下一次调用走哪家、扣哪边的额度；切换不发请求、不覆盖密钥，失败也不会自动换到另一家。',['official','commandcode'],{section:'chat',labels:{official:'官方 DeepSeek API（按余额计费）',commandcode:'Command Code GOAT（套餐额度）'}}),
  model('deepseek_model','models','DeepSeek 模型','deepseek-flash 是普通 V4.1 Flash；deepseek-flash-fast 是 Fast 版，只有 Command Code 通道有，输入和缓存读更贵。每轮完整历史，不新增自动调用。','deepseek',{section:'chat',llm:true}),
  {...pick('deepseek_reasoning_effort','models','DeepSeek 推理强度','',DEEPSEEK_EFFORT),pair:'deepseek_model'},
  num('max_active_agents','models','同时运行的 agent 上限','办公室里同时在跑的助手任务（对话轮、卡片、工作流步骤）最多几个，由程序强制：达到上限后新任务保持排队，有任务结束后下一次调度（约 10 秒内）自动接上。不含子 agent，子 agent 另受下面的并发上限约束。可设 1～10，默认 10；越高并行越多、越耗额度。改值立即对新调度生效，已在运行的任务不受影响。',1,10,'个',{section:'chat'}),
  num('subagent_max_concurrency','models','子 agent 并发上限','每个助手工作任务的子 agent 并发配置，不含主助手；可设 1～10，默认 10。Codex 由原生线程上限执行，Claude 由原生 Agent 新建上限执行（原生恢复旧 agent 等豁免路径不受此项约束），并关闭嵌套。下一次启动读取新值，不要求用满，不设每轮累计创建数。',1,10,'个',{section:'chat'}),
  num('queued_cards_per_turn','models','每轮新建排队卡片上限','用户发起的一轮对话里，助手新建或首次排队的卡片额度，由程序计数拒绝超额；open 不计。同一轮的交接共用额度，已排过的卡片取消或退回不会返还；与子 agent 数量互不占用。可设 1～50，默认 10。',1,50,'张',{section:'chat'}),
  ...TASK_KINDS.flatMap(kind=>[
    model('task_models.'+kind,'models',({mail:'邮件任务',literature:'文献任务',presentation:'汇报任务'})[kind]+'默认模型','模型和推理强度分别保存；单项任务仍可明确指定。','task',{section:'tasks',taskKind:kind}),
    {...pick('task_efforts.'+kind,'models',({mail:'邮件任务',literature:'文献任务',presentation:'汇报任务'})[kind]+'推理强度','',[...new Set([...EFFORT,...DEEPSEEK_EFFORT])]),pair:'task_models.'+kind,taskKind:kind}
  ]),
  pick('title_provider','models','对话标题由谁起','标题调用的助手。换提供者时，标题模型要同时换成对应一侧的模型，页面会自动切换清单。',['claude','codex'],{section:'title'}),
  model('title_model','models','对话标题模型','为对话起标题的小模型。','title',{section:'title',llm:true}),
  {...pick('title_effort','models','标题推理强度','',EFFORT),pair:'title_model'},
  num('title_again_at','models','第二次起标题的时机','对话里你说到第几条时，重新起一次标题；0 表示不再重起。',0,50,'条',{section:'title'}),
  bool('automatic_mail_judgment','mail','自动判断新邮件','关闭后新邮件只入账本，不再自动调用模型判断。',{section:'judge',llm:true}),
  bool('automatic_cards','mail','自动准备卡片选项','为没有选项的收件箱卡片自动准备选项，每张卡一次。',{section:'judge',llm:true}),
  num('mail_batch_wait_minutes','mail','攒批等待','零星来信先等这么久再合并判断；0 表示立即。',0,240,'分钟',{section:'batch'}),
  num('mail_batch_min_messages','mail','攒批条数','攒到这个条数就不再等待。',1,20,'封',{section:'batch'}),
  model('mail_screen_model','mail','邮件粗筛模型','先看一遍，判断是否值得细看。','codex',{section:'tiers',llm:true}),
  {...pick('mail_screen_effort','mail','粗筛推理强度','',EFFORT),pair:'mail_screen_model'},
  model('mail_judgment_model','mail','邮件判断模型','粗筛拿不准时升级到这一档。','codex',{section:'tiers',llm:true}),
  {...pick('mail_judgment_effort','mail','判断推理强度','',EFFORT),pair:'mail_judgment_model'},
  num('automation_daily_calls','mail','每日自动调用上限','后台判断与卡片准备每天最多调用模型的次数。',0,500,'次',{section:'cap'}),
  bool('automatic_codex_reset_credit','mail','自动使用 Codex 重置卡','额度刷新或新 Codex 任务启动时，普通额度用尽且有可用卡才兑换；每次消耗一张已有卡，不购买额度，不重跑失败任务。',{section:'cap'}),
  bool('memory_v2.auto.enabled','memory','被动记忆整理','对话闲置后，由后台把经历整理进办公室记忆。',{section:'passive',llm:true}),
  num('memory_v2.auto.idle_minutes','memory','闲置多久后整理','对话停多久算闲置。',1,1440,'分钟',{section:'passive'}),
  num('memory_v2.auto.ingest_hours','memory','整理最小间隔','两次对话提取之间至少隔多久。',1,8760,'小时',{section:'passive'}),
  num('memory_v2.auto.consolidate_hours','memory','聚类与画像间隔','合并记忆、更新画像与遗忘的间隔。',1,8760,'小时',{section:'passive'}),
  model('memory_extract.claude.model','memory','整理 Claude 记忆的模型','整理 Claude 的经历时调用。','codex',{section:'extract',llm:true}),
  {...pick('memory_extract.claude.effort','memory','整理 Claude 记忆的强度','',EFFORT),pair:'memory_extract.claude.model'},
  model('memory_extract.codex.model','memory','整理 Codex 记忆的模型','整理 Codex 的经历时调用。','codex',{section:'extract',llm:true}),
  {...pick('memory_extract.codex.effort','memory','整理 Codex 记忆的强度','',EFFORT),pair:'memory_extract.codex.model'}];
const byKey=new Map(FIELDS.map(f=>[f.key,f]));
const get=(config,key)=>key.split('.').reduce((v,k)=>v?.[k],config);
function put(config,key,value) {
  const parts=key.split('.'),last=parts.pop();let target=config;
  for(const part of parts)target=target[part] ??= {};
  target[last]=value;
}
// Model choices. Codex keeps its own list of models this account can use in ~/.codex/models_cache.json (only slugs and display names are read;
// entries it marks as hidden are left out). Claude has no such list, so CLAUDE_MODELS below is maintained by hand. The configured value is always an
// option too, and the page lets the user type any other name, so a stale list never blocks a model.
// Claude has no list file like Codex's, so this one is written down by hand. Sources, as of 2026-10-16: the model list this account's Claude Code reports
// at startup, and the model overview on platform.claude.com (current IDs; the older IDs are the ones the CLI still lists). An alias follows Anthropic's
// newest model of that line; a full ID is pinned. A model not listed here can still be typed through the manual entry.
const CLAUDE_MODELS=[
  {value:'sonnet',label:'sonnet（别名，现为 Sonnet 5.5）'},{value:'opus',label:'opus（别名，现为 Opus 5.5）'},
  {value:'haiku',label:'haiku（别名，现为 Haiku 5.5）'},{value:'fable',label:'fable（别名，现为 Fable 5.1）'},
  {value:'claude-sonnet-5-5',label:'claude-sonnet-5-5（Sonnet 5.5）'},{value:'claude-opus-5-5',label:'claude-opus-5-5（Opus 5.5）'},
  {value:'claude-haiku-5-5',label:'claude-haiku-5-5（Haiku 5.5）'},{value:'claude-fable-5-1',label:'claude-fable-5-1（Fable 5.1）'},
  {value:'claude-sonnet-5',label:'claude-sonnet-5（Sonnet 5，旧版）'},{value:'claude-opus-5',label:'claude-opus-5（Opus 5，旧版）'},
  {value:'claude-fable-5',label:'claude-fable-5（Fable 5，旧版）'},{value:'claude-opus-4-8',label:'claude-opus-4-8（Opus 4.8，旧版）'},
  {value:'claude-opus-4-7',label:'claude-opus-4-7（Opus 4.7，旧版）'},{value:'claude-opus-4-6',label:'claude-opus-4-6（Opus 4.6，旧版）'},
  {value:'claude-sonnet-4-6',label:'claude-sonnet-4-6（Sonnet 4.6，旧版）'},{value:'claude-haiku-4-5-20251001',label:'claude-haiku-4-5-20251001（Haiku 4.5，旧版）'}];
function codexModels() {
  try {
    const file=process.env.PHD_CODEX_MODELS_CACHE || path.join(os.homedir(),'.codex','models_cache.json');
    return (JSON.parse(fs.readFileSync(file,'utf8')).models || []).filter(m=>m.visibility==='list' && typeof m.slug==='string' && MODEL.test(m.slug))
      .map(m=>({value:m.slug,label:m.display_name ? `${m.slug}（${m.display_name}）` : m.slug}));
  } catch {return [];}
}
// Which side a model name belongs to: Claude's aliases and claude-* IDs, anything else is Codex's.
const providerOf=value=>/^deepseek-/i.test(value) ? 'deepseek' : /^(claude-|(sonnet|opus|haiku|fable|default)(\[[^\]]*\])?$)/i.test(value) ? 'claude' : 'codex';
const effortsFor=provider=>provider==='deepseek' ? DEEPSEEK_EFFORT : EFFORT;
const defaultEffort=(config,provider)=>config[provider+'_reasoning_effort'] || config.reasoning_effort;
const TITLE_DEFAULTS={claude:'claude-haiku-5-5',codex:'gpt-6-luna'};
function modelsFor(provider,current) {
  const list=provider==='claude' ? CLAUDE_MODELS : provider==='codex' ? codexModels() : provider==='deepseek' ? [{value:'deepseek-flash',label:'deepseek-flash（普通）'},{value:'deepseek-flash-fast',label:'deepseek-flash-fast（Fast）'}] : [];
  return typeof current==='string' && current && providerOf(current)===provider && !list.some(o=>o.value===current) ? [...list,{value:current,label:current+'（当前）'}] : list;
}
function modelOptions(field,config) {
  if(field.provider==='task') {
    const names={codex:'Codex',claude:'Claude',deepseek:'DeepSeek'},current=get(config,field.key);
    const options=Object.keys(names).flatMap(provider=>modelsFor(provider,providerOf(current)===provider?current:config[provider+'_model']).map(o=>({...o,label:names[provider]+' · '+o.label})));
    return options;
  }
  const provider=field.provider==='title' ? config.title_provider : field.provider,current=get(config,field.key);
  const options=modelsFor(provider,current);
  // A model of the other side is not offered, but a configured one (a mismatch made by hand) must stay visible rather than vanish.
  return typeof current==='string' && current && !options.some(o=>o.value===current) ? [...options,{value:current,label:current+'（当前）'}] : options;
}
// The title model follows title_provider: the page switches lists as soon as the provider is changed, before saving.
function followers(field,config) {
  if(field.provider!=='title')return {};
  const current=get(config,field.key);
  return {follows:'title_provider',options_by:{claude:modelsFor('claude',current),codex:modelsFor('codex',current)},defaults_by:TITLE_DEFAULTS};
}
// The last few saved changes, newest first, so a surprising behaviour can be traced to a setting. Unknown keys (older log lines) are skipped.
function recentChanges(limit=12) {
  try {
    const lines=fs.readFileSync(path.join(root,LOG),'utf8').split(/\r?\n/).filter(Boolean).slice(-200),out=[];
    for(const line of lines.reverse()) {
      let c;try {c=JSON.parse(line);} catch {continue;}
      const f=byKey.get(c.key);if(!f)continue;
      out.push({at:c.at,key:c.key,label:f.label,group:f.group,from:c.from ?? null,to:c.to ?? null,actor:c.actor || ''});
      if(out.length>=limit)break;
    }
    return out;
  } catch {return [];}
}
export function settingsView() {
  const config=settingsConfig();
  return {groups:GROUPS.map(g=>({...g,sections:GROUP_SECTIONS[g.id].map(id=>SECTIONS[id])})),recent:recentChanges(),fields:FIELDS.map(f=>({...f,value:get(config,f.key) ?? null,
    ...(f.key.startsWith('task_efforts.') ? {options:effortsFor(providerOf(get(config,f.pair))),effort_for:f.pair,efforts_by:{codex:EFFORT,claude:EFFORT,deepseek:DEEPSEEK_EFFORT},defaults_by:Object.fromEntries(['codex','claude','deepseek'].map(p=>[p,defaultEffort(config,p)]))} : {}),
    ...(f.type==='model' ? {options:modelOptions(f,config),...followers(f,config)} : {})}))};
}
function settingsConfig() {
  const config=read(FILE),policy=read(POLICY);
  // Presentation only; do not persist a second copy in agent/config.json.
  return {...config,deepseek_provider:connectionStatus().transport,claude_reasoning_effort:defaultEffort(config,'claude'),task_models:Object.fromEntries(TASK_KINDS.map(kind=>{
    const route=policy.defaults.find(p=>p.kind===kind);
    return [kind,route.model || config[route.actor+'_model']];
  })),task_efforts:Object.fromEntries(TASK_KINDS.map(kind=>{
    const route=policy.defaults.find(p=>p.kind===kind);
    return [kind,route.effort || defaultEffort(config,route.actor)];
  }))};
}
function normalise(field,value) {
  const bad=message=>{throw new Error(`${field.label}：${message}`);};
  if(field.type==='bool'){if(typeof value!=='boolean')bad('需要开或关');return value;}
  if(field.type==='int'){
    if(!Number.isInteger(value))bad('需要整数');
    if(value<field.min || value>field.max)bad(`应在 ${field.min}～${field.max} ${field.unit} 之间`);return value;
  }
  if(field.type==='enum'){if(!field.options.includes(value))bad('可选 '+field.options.join(' / '));return value;}
  if(typeof value!=='string' || !MODEL.test(value.trim()))bad('只允许字母、数字和 . _ : - [ ]，不超过 60 个字符');
  return value.trim();
}
// changes: {key: newValue}. Validates every change plus the cross-field rules before writing anything; returns the fresh view.
export function saveSettings(changes,{actor='dashboard',now=new Date()}={}) {
  if(!changes || typeof changes!=='object' || Array.isArray(changes))throw new Error('没有可保存的修改');
  const config=structuredClone(settingsConfig()),applied=[];
  for(const [key,raw] of Object.entries(changes)) {
    const field=byKey.get(key);if(!field)throw new Error('不能修改的设置项：'+key);
    const value=normalise(field,raw),old=get(config,key);
    if(old===value)continue;
    put(config,key,value);applied.push({key,from:old ?? null,to:value});
  }
  // Validate against the final model, independent of the order of keys in the request.
  for(const kind of TASK_KINDS) {
    const key='task_efforts.'+kind,modelKey='task_models.'+kind,provider=providerOf(get(config,modelKey)),allowed=effortsFor(provider),value=get(config,key);
    if(Object.hasOwn(changes,key) && !allowed.includes(value))throw new Error(byKey.get(key).label+'：可选 '+allowed.join(' / '));
    if(Object.hasOwn(changes,modelKey) && !allowed.includes(value)) {
      const next=defaultEffort(config,provider);put(config,key,next);applied.push({key,from:value,to:next});
    }
  }
  // A model must belong to the side that calls it. Titles fail quietly (only an activity note), so a mismatch would otherwise just stop titles.
  const touched=new Set(applied.map(c=>c.key));if(touched.has('title_provider'))touched.add('title_model');
  for(const f of FIELDS.filter(x=>x.type==='model' && x.provider && x.provider!=='task' && touched.has(x.key))) {
    const want=f.provider==='title' ? config.title_provider : f.provider,value=get(config,f.key),side=name=>({claude:'Claude',codex:'Codex',deepseek:'DeepSeek'}[name]);
    if(providerOf(value)!==want)throw new Error(`${f.label}：「${value}」是 ${side(providerOf(value))} 一侧的模型，而这一项由 ${side(want)} 调用${f.provider==='title' ? '；改标题提供者时要同时改标题模型' : ''}`);
  }
  // Fast exists only on Command Code; the official API would reject it at the next call. Check the final pair, whichever was edited.
  if(touched.has('deepseek_provider') && !connectionStatus(config.deepseek_provider).credential_configured)throw new Error(`DeepSeek 计费通道：${config.deepseek_provider} 的本地凭据未配置或格式无效`);
  if(config.deepseek_provider==='official' && config.deepseek_model==='deepseek-flash-fast' && (touched.has('deepseek_provider') || touched.has('deepseek_model')))throw new Error('DeepSeek 模型：deepseek-flash-fast 只有 Command Code 通道提供，官方通道请用 deepseek-flash');
  if(applied.length) {
    const taskChanges=applied.filter(c=>byKey.get(c.key).taskKind);
    if(taskChanges.length) {
      const policy=read(POLICY);
      for(const c of taskChanges){const route=policy.defaults.find(p=>p.kind===byKey.get(c.key).taskKind);if(c.key.startsWith('task_models.')){route.actor=providerOf(c.to);route.model=c.to;}else route.effort=c.to;}
      write(POLICY,policy);
    }
    const agentChanges=applied.filter(c=>!byKey.get(c.key).taskKind && c.key!=='deepseek_provider');
    if(agentChanges.length){const agentConfig=read(FILE);for(const c of agentChanges)put(agentConfig,c.key,c.to);write(FILE,agentConfig);}
    if(touched.has('deepseek_provider'))selectConnection(config.deepseek_provider);
    const file=path.join(root,LOG);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.appendFileSync(file,applied.map(c=>JSON.stringify({at:now.toISOString(),actor,...c})).join('\n')+'\n');
  }
  return {changed:applied.map(c=>c.key),...settingsView()};
}

// Project skills only. Follow Hermes' metadata-first / on-demand-body split, but keep native discovery and editing with each assistant.
// References: https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py
// The badges below are filesystem checks, NOT proof that a running assistant has loaded a skill. No native/model process is started here.
const SKILLS='.agents/skills',CLAUDE_SKILLS='.claude/skills';
function inside(parent,file) {
  const relative=path.relative(fs.realpathSync(parent),fs.realpathSync(file));
  return relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}
// Read just the two conventional scalar fields, including quoted and block descriptions; this is not a general YAML validator.
function skillField(head,key) {
  const match=head.match(new RegExp('^'+key+':[ \\t]*(.*)$','m'));if(!match)return '';
  const value=match[1].trim();
  if(/^[>|][-+]?\s*$/.test(value)) {
    const lines=head.slice(match.index+match[0].length).split(/\r?\n/).slice(1),block=[];
    for(const line of lines){if(line && !/^\s/.test(line))break;block.push(line.trim());}
    return block.join(value.startsWith('>') ? ' ' : '\n').trim();
  }
  if(value.startsWith('"')){try{const parsed=JSON.parse(value);return typeof parsed==='string' ? parsed : '';}catch{return '';}}
  if(value.startsWith("'"))return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1,-1).replace(/''/g,"'") : '';
  return value.replace(/[ \t]+#.*$/,'').trim();
}
// Advisory checks, in the spirit of Hermes' non-blocking skill linter: plain text rules, no model call, and nothing here blocks a write.
// Invisible control characters are different: skills are instruction text that gets injected again and again, so they are reported as an issue.
const HIDDEN=/[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;
const TEXT_FILE=/\.(md|txt|py|m?js|json|ya?ml|sh|ps1)$/i;
function skillFiles(dir,limit=200) {
  const found=[];
  const walk=(current,depth)=>{
    for(const entry of fs.readdirSync(current,{withFileTypes:true})) {
      if(found.length>=limit)return;
      const full=path.join(current,entry.name);
      if(entry.isDirectory() && depth<3)walk(full,depth+1);
      else if(entry.isFile())found.push(full);
    }
  };
  walk(dir,0);return found;
}
function skillNotes({body,bodyTokens,extraFiles}) {
  const notes=[],lead=body.slice(0,800),dated=(body.match(/^\s*(?:[-*]\s*)?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/gm) || []).length;
  if(!(/依据|基于|根据|evidence|based on/i.test(lead) && /适用|适合|when to use|applies/i.test(lead)))notes.push('正文开头没有看到依据与适用条件；约定要求写明依据、适用条件和验证范围');
  if(dated>=5)notes.push(`有 ${dated} 行以日期开头，像按时间记的流水账；skill 写做法，不写经过`);
  if(bodyTokens>5000)notes.push(`正文估算 ${bodyTokens} token，较长；步骤细节可拆到附属文件按需读取`);
  if(extraFiles>15)notes.push(`附属文件 ${extraFiles} 个，较多；确认都值得按需读取`);
  return notes;
}
export async function skillsView() {
  const {estimateTokens}=await import('../agent/run.mjs');
  const base=path.join(root,SKILLS),links=path.join(root,CLAUDE_SKILLS);
  const problems=[];
  if(fs.existsSync(base) && !inside(root,base))return {location:SKILLS,claude_location:CLAUDE_SKILLS,skills:[],problems:['项目 skill 目录指向办公室外，未读取']};
  const localLinks=!fs.existsSync(links) || inside(root,links);
  if(!localLinks)problems.push('.claude/skills 指向办公室外，未扫描；这里只管理项目内 skill');
  const dirs=fs.existsSync(base) ? fs.readdirSync(base,{withFileTypes:true}).filter(d=>!d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink())).map(d=>d.name).sort() : [];
  const skills=dirs.map(dir=>{
    const file=path.join(base,dir,'SKILL.md'),issues=[];
    const empty=message=>({dir,name:dir,description:'',content:'',always_tokens:0,body_tokens:0,body_bytes:0,claude:'unknown',issues:[message],notes:[]});
    if(!fs.existsSync(file))return empty('缺少 SKILL.md');
    if(!inside(base,file))return empty('SKILL.md 指向项目 skill 目录外，未读取');
    let text;try{text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}catch{return empty('SKILL.md 无法读取');}
    const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),head=front?.[1] || '',body=text.slice(front?.[0].length || 0);
    const name=skillField(head,'name'),description=skillField(head,'description');
    if(!name)issues.push('头部缺 name');else if(name!==dir)issues.push(`name「${name}」与目录名「${dir}」不一致`);
    if(!description)issues.push('头部缺 description（它就是触发条件）');
    const skillDir=path.join(base,dir),files=skillFiles(skillDir),hidden=[];
    for(const f of files) {
      if(!TEXT_FILE.test(f))continue;
      try{if(fs.statSync(f).size<=262144 && HIDDEN.test(fs.readFileSync(f,'utf8').replace(/^﻿/,'')))hidden.push(path.relative(skillDir,f).split(path.sep).join('/'));}catch{/* unreadable file: nothing to scan */}
    }
    if(hidden.length)issues.push(`含不可见控制字符：${hidden.join('、')}；可能夹带隐藏指令，请核对来源后清除`);
    const link=path.join(links,dir);let claude='missing';
    if(!localLinks)claude='unknown';
    else try{fs.lstatSync(link);claude=fs.existsSync(link) && fs.realpathSync(link)===fs.realpathSync(path.join(base,dir)) ? 'ok' : 'broken';}catch{/* no link */}
    const userClaude=path.join(process.env.OFFICE_BASE_HOME || os.homedir(),'.claude/skills',dir,'SKILL.md');
    const hasUserClaude=claude==='missing' && fs.existsSync(userClaude);
    if(claude==='missing' && !hasUserClaude)issues.push('.claude/skills 里没有同名链接，项目发现入口未就绪；也未找到同名用户级文件');
    if(claude==='broken')issues.push('.claude/skills 里的链接失效，或没有指向本体');
    const bodyTokens=estimateTokens(body);
    return {dir,name:name || dir,description,content:text,always_tokens:estimateTokens(name+' '+description),body_tokens:bodyTokens,body_bytes:Buffer.byteLength(body),claude,issues,
      notes:[...skillNotes({body,bodyTokens,extraFiles:files.length-1}),...(hasUserClaude ? ['项目链接缺省；已有 Claude 用户级同名文件，不表示技能不可发现（当前会话是否已发现或读取需另核对）'] : [])]};
  });
  if(localLinks && fs.existsSync(links))problems.push(...fs.readdirSync(links).filter(n=>!n.startsWith('.') && !dirs.includes(n)).map(n=>`.claude/skills/${n} 没有对应的 .agents/skills 本体`));
  return {location:SKILLS,claude_location:CLAUDE_SKILLS,skills,problems};
}
// Base skills: what each assistant already carries outside this project (user level, officially synced, Codex system skills). Read-only filesystem
// scan; nothing is started or edited. Built-in skills that have no file on disk cannot be listed here, and plugin directories are only counted
// because a downloaded plugin is not necessarily enabled. OFFICE_BASE_HOME replaces the home directory (tests).
function baseSkillsIn(parent,source,estimateTokens,skip=[]) {
  if(!fs.existsSync(parent))return [];
  const found=[];
  for(const d of fs.readdirSync(parent,{withFileTypes:true})) {
    if(d.name.startsWith('.') || skip.includes(d.name) || !(d.isDirectory() || d.isSymbolicLink()))continue;
    const file=path.join(parent,d.name,'SKILL.md');let text;
    try{text=fs.readFileSync(file,'utf8').replace(/^﻿/,'');}catch{continue;}
    const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),head=front?.[1] || '',body=text.slice(front?.[0].length || 0);
    const name=skillField(head,'name') || d.name,description=skillField(head,'description'),issues=[];
    if(!description)issues.push('头部缺 description');
    if(HIDDEN.test(text))issues.push('含不可见控制字符');
    found.push({name,dir:d.name,source,description,always_tokens:estimateTokens(name+' '+description),body_tokens:estimateTokens(body),
      hash:createHash('sha256').update(text).digest('hex').slice(0,12),issues});
  }
  return found.sort((a,b)=>a.name.localeCompare(b.name));
}
function countSkillFiles(dir,depth=0) {
  if(!fs.existsSync(dir) || depth>9)return 0;
  let n=0;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
    if(e.isDirectory())n+=countSkillFiles(path.join(dir,e.name),depth+1);
    else if(e.isFile() && e.name==='SKILL.md')n++;
  }
  return n;
}
export async function baseSkillsView() {
  const {estimateTokens}=await import('../agent/run.mjs');
  const home=process.env.OFFICE_BASE_HOME || os.homedir(),claudeDir=path.join(home,'.claude/skills'),codexDir=path.join(home,'.codex/skills');
  const synced=fs.existsSync(path.join(claudeDir,'synced')) ? fs.readdirSync(path.join(claudeDir,'synced'),{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(claudeDir,'synced',d.name)) : [];
  const assistants=[
    {id:'claude',skills:[...baseSkillsIn(claudeDir,'用户级',estimateTokens,['synced']),...synced.flatMap(d=>baseSkillsIn(d,'官方同步',estimateTokens))],
      plugin_skill_files:countSkillFiles(path.join(home,'.claude/plugins/marketplaces'))},
    {id:'codex',skills:[...baseSkillsIn(codexDir,'用户级',estimateTokens),...baseSkillsIn(path.join(codexDir,'.system'),'系统自带',estimateTokens)],
      plugin_skill_files:countSkillFiles(path.join(home,'.codex/plugins/cache'))}];
  for(const a of assistants)a.always_tokens=a.skills.reduce((sum,s)=>sum+s.always_tokens,0);
  // Only user-level skills are compared: the synced / system ones are each vendor's own copy and are expected to differ.
  const [claude,codex]=assistants,own=a=>a.skills.filter(s=>s.source==='用户级'),shared=own(claude).filter(s=>own(codex).some(c=>c.name===s.name))
    .map(s=>({name:s.name,same:own(codex).find(c=>c.name===s.name).hash===s.hash}));
  const projectDir=path.join(root,SKILLS),project=fs.existsSync(projectDir) ? fs.readdirSync(projectDir,{withFileTypes:true}).filter(d=>!d.name.startsWith('.')).map(d=>d.name) : [];
  const overlap=[...new Set(assistants.flatMap(a=>a.skills.map(s=>s.name)))].filter(n=>project.includes(n));
  return {assistants,shared,overlap_with_project:overlap};
}
// Command-line entry for the assistants: node automation/run.mjs settings show | set <JSON文件路径> | skills
export async function run(action,argument) {
  if(action==='skills') {
    const view=await skillsView();
    if(!view.skills.length)console.log('项目里没有自建 skill（'+view.location+'）。');
    for(const s of view.skills)console.log(`${s.name}  名称与描述估算 ${s.always_tokens} token，正文估算 ${s.body_tokens} token；Claude 链接：${s.claude}${s.issues.length ? '；问题：'+s.issues.join('；') : ''}${s.notes.length ? '；提示：'+s.notes.join('；') : ''}`);
    for(const p of view.problems)console.log('问题：'+p);
    const base=await baseSkillsView(),names={claude:'Claude',codex:'Codex'};
    console.log('\n底座技能（各助手在项目外自带的，只读盘点，不修改）');
    for(const a of base.assistants) {
      console.log(`${names[a.id]}：${a.skills.length} 个，名称与描述合计估算 ${a.always_tokens} token；另有插件目录里的 SKILL.md ${a.plugin_skill_files} 个（只计数，下载不等于启用）`);
      for(const s of a.skills)console.log(`  ${s.name}  [${s.source}] 名称与描述 ${s.always_tokens} token，正文 ${s.body_tokens} token${s.issues.length ? '；问题：'+s.issues.join('；') : ''}`);
    }
    for(const s of base.shared)console.log(`两边同名：${s.name}，${s.same ? '内容相同' : '内容不同，请核对是否该一致'}`);
    if(base.overlap_with_project.length)console.log('与项目 skill 同名：'+base.overlap_with_project.join('、')+'（不代表自动覆盖或合并；各原生入口的选择和禁用配置需另核对）');
    console.log('底座盘点只看文件：助手内置、不以文件形式存在的技能不在其中；也不代表当前会话已加载。');
    console.log('仅核对项目目录与链接，不代表当前会话已加载；token 为文本估算，不是实际账单。');
    return;
  }
  if(action==='show') {
    const view=settingsView();
    for(const g of view.groups) {
      console.log(`\n【${g.title}】${g.note}`);
      for(const f of view.fields.filter(x=>x.group===g.id)) {
        const rule=f.type==='int' ? `${f.min}～${f.max}${f.unit}` : f.type==='enum' ? f.options.join('|') : f.type==='bool' ? 'true|false' : '模型名';
        console.log(`  ${f.key} = ${JSON.stringify(f.value)}  # ${f.label}（${rule}）`);
      }
    }
    return;
  }
  if(!argument)throw new Error('settings set <JSON文件路径>：内容为 {"changes":{"键":新值}}，键见 settings show');
  const {input}=await import('../automation/files.mjs');
  const request=input(argument),result=saveSettings(request.changes ?? request,{actor:'assistant'});
  console.log(result.changed.length ? '已保存：'+result.changed.join('、')+'（下一次调用起生效）' : '没有变化');
}
