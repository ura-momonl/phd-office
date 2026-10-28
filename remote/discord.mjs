import fs from 'node:fs';
import path from 'node:path';
import { root,read,write } from '../automation/files.mjs';
import { enqueue,renderPlan } from '../work/run.mjs';
import { snapshot } from '../dashboard/server.mjs';
import { acknowledgeInbox } from '../dashboard/inbox.mjs';
import { weeklySnapshot, weekView } from '../weekly/run.mjs';
import { notificationTypes, baselineNotifications, notify, currentInboxAction } from './notifications.mjs';
export function acquireBridgeLock() {
  const lock=path.join(root,'.runtime/remote/bridge.lock');fs.mkdirSync(path.dirname(lock),{recursive:true});
  const create=()=>{const fd=fs.openSync(lock,'wx');try {fs.writeFileSync(fd,String(process.pid));} finally {fs.closeSync(fd);}};
  try {create();} catch(error) {
    if(error.code!=='EEXIST')throw error;
    throw new Error('Discord bridge already running or stale bridge.lock; inspect locally before removing the lock');
  }
  return ()=>{if(fs.existsSync(lock) && fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);};
}
const base=()=>`http://127.0.0.1:${Number(process.env.PHD_DASHBOARD_PORT || 18787)}`;
async function chat(args) {
  const previous=read('.runtime/remote/session.json',{});
  const r=await fetch(base()+'/api/chat',{method:'POST',headers:{'content-type':'application/json',origin:base()},signal:AbortSignal.timeout(15000),body:JSON.stringify({
    text:args.text || args.prompt,project_id:args.project,session_id:args.new || args.project ? undefined : previous.session_id})});
  const job=await r.json();if(!r.ok)throw new Error(job.error);
  write('.runtime/remote/session.json',{session_id:job.session_id});
  // GUI owns execution. A single notification beat observes completion, independent of the 15-minute interaction token.
  return `已接手。\n任务 ID：${job.task_id}\n对话 ID：${job.session_id}\n${notificationTypes(process.env.DISCORD_NOTIFY).includes('tasks') ? '结束或需要你决定时，会在本频道通知。' : '任务通知已关闭；用 /handoff 查询结果。'}`;
}
export const authorized=(interaction,env=process.env)=>interaction.user.id===env.DISCORD_OWNER_ID && interaction.channelId===env.DISCORD_CHANNEL_ID && interaction.guildId===env.DISCORD_GUILD_ID;
export async function respond(interaction) {
  const button=interaction.isButton?.() || false;
  if(!button && !interaction.isChatInputCommand())return;
  if(!authorized(interaction)){await interaction.reply({content:'此入口仅用于已配置的个人频道。',flags:64,allowedMentions:{parse:[]}});return;}
  await interaction.deferReply({flags:64});
  let answer;
  try {answer=String(button ? await handleInboxButton(interaction.customId) : await handle(interaction.commandName,Object.fromEntries(interaction.options.data.map(o=>[o.name,o.value]))));}
  catch(error) {answer=error.message==='fetch failed' || error.name==='TimeoutError' ? '未能确认接单：请检查电脑端工作助手。是否已接单未知，先查看工作台任务列表，不要重复提交。' : '命令未完成，请检查本地工作台与命令参数。';}
  await interaction.editReply({content:answer.length>1900 ? answer.slice(0,1800)+'\n（完整内容请在工作台查看。）' : answer,allowedMentions:{parse:[]}});
}
export async function handleInboxButton(customId) {
  const current=currentInboxAction(customId,snapshot().inbox);
  if(!current)return '事项已更新或已处理。旧按钮不再生效，请在工作台查看最新选项。';
  const {item,action}=current;
  if(action.type==='accept') {
    // Same synchronous owner used by the workbench; no HTTP wait between version check and acknowledgment.
    acknowledgeInbox(item);
    return `已记录「${action.label}」，事项已收起。`;
  }
  const r=await fetch(base()+'/api/inbox/respond',{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({id:item.id,fingerprint:item.fingerprint,action_id:action.id})});
  const result=await r.json();
  if(!r.ok)return '选项未执行：事项可能已更新或已处理，请在工作台确认。';
  return `已提交「${action.label}」。\n任务 ID：${result.id}\n后续若出现新的收件箱事项，会在本频道提醒。`;
}
export async function handle(command,args={}) {
  if(command==='status') {
    const s=snapshot();return `执行中 ${s.work.items.filter(i=>i.status==='active').length}；收件箱 ${s.inbox.length}；本周目标 ${s.weekly.plan?.intents?.length || 0}。\n最近收件模型轮次 ${s.mail.lastRun?.modelTurns ?? '未记录'}。`;
  }
  if(command==='tasks')return read('work/queue.json').items.filter(i=>!['done','cancelled'].includes(i.status)).slice(0,10)
    .map(i=>`${i.title} — ${i.actor}/${i.status}\n${i.id}`).join('\n') || '暂无开放任务。';
  if(command==='inbox')return snapshot().inbox.slice(0,10).map(i=>`${{urgent:'紧急',high:'优先',normal:'常规'}[i.priority]} / ${{approval:'审批',acceptance:'验收',decision:'判断'}[i.kind]}：${i.title}\n${i.detail}`).join('\n\n') || '收件箱已清空。';
  if(command==='weekly') {
    const w=weeklySnapshot().window,now=weekView(w.start),last=weekView(w.previous_start);
    return `本周 ${w.start} — ${w.end}\n${now.plan?.intents.map(i=>'· '+i.title).join('\n') || '研究目标待补充'}\n\n上周已记录交付 ${last.facts.completed.length}；截至现在待解决 ${now.current.blocked.length}。`;
  }
  if(command==='usage') {
    const u=snapshot().usage;const c=u.quota.codex?.limits?.rateLimits;
    return `Codex：${c?.primary ? '剩余 '+Math.max(0,100-c.primary.usedPercent)+'%（'+c.primary.windowDurationMins+' 分钟窗口）' : '未读取'}\nClaude：${u.quota.claude?.windows?.map(w=>w.label+' 剩余 '+w.remaining_percent+'%').join('；') || '账号余额尚未取得'}\n助手已记录 ${u.runs.length} 次调用。`;
  }
  if(command==='handoff') {
    const i=read('work/queue.json').items.find(i=>i.id===args.id);if(!i)throw new Error('未知任务');
    return JSON.stringify({id:i.id,title:i.title,project_ids:i.project_ids,outcome:i.handoff,outputs:i.outputs},null,2);
  }
  if(command==='task' && args.kind) {
    const i=enqueue({title:args.title,kind:args.kind,actor:args.actor,project_ids:args.project ? [args.project] : [],goal:args.goal});renderPlan();return `已保存：${i.title}\n${i.id}`;
  }
  if(['chat','ask','task'].includes(command))return chat({...args,text:args.text || args.prompt || args.title});
  throw new Error('未知命令');
}
export async function run(action) {
  const keys=['DISCORD_BOT_TOKEN','DISCORD_GUILD_ID','DISCORD_CHANNEL_ID','DISCORD_OWNER_ID'];
  if(action==='check'){console.log(JSON.stringify({configFile:'.runtime/discord.env',configured:keys.every(k=>!!process.env[k]),missing:keys.filter(k=>!process.env[k]),notifications:notificationTypes(process.env.DISCORD_NOTIFY),modelInvoked:false,connected:false}));return;}
  if(action!=='discord')throw new Error('remote check|discord');
  for(const key of keys)if(!process.env[key])throw new Error('Missing '+key+'; fill local .runtime/discord.env');
  const types=notificationTypes(process.env.DISCORD_NOTIFY);
  const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder}=await import('discord.js');
  const commands=[...['status','tasks','inbox','weekly','usage'].map(name=>new SlashCommandBuilder().setName(name).setDescription(({status:'查看助手状态',tasks:'查看执行任务',inbox:'查看需要你处理的事项',weekly:'查看周计划和复盘',usage:'查看额度与消耗'})[name])),
    new SlashCommandBuilder().setName('chat').setDescription('和 Codex、Claude 对话；可用 @ 指定对象')
      .addStringOption(o=>o.setName('text').setDescription('要说的话或要做的事').setRequired(true).setMaxLength(6000))
      .addStringOption(o=>o.setName('project').setDescription('相关项目 ID')).addBooleanOption(o=>o.setName('new').setDescription('开始新对话')),
    new SlashCommandBuilder().setName('task').setDescription('把一件事交给 agent，无需指定负责人').addStringOption(o=>o.setName('title').setDescription('要做的事').setRequired(true)),
    new SlashCommandBuilder().setName('handoff').setDescription('读取任务交接').addStringOption(o=>o.setName('id').setDescription('任务 ID').setRequired(true))];
  const client=new Client({intents:[GatewayIntentBits.Guilds],rest:{retries:0}});
  const release=acquireBridgeLock();
  const scope=[process.env.DISCORD_GUILD_ID,process.env.DISCORD_CHANNEL_ID,process.env.DISCORD_OWNER_ID,types.join(',')].join(':');
  process.once('exit',release);
  try {if(types.length)baselineNotifications(snapshot(),types,scope);} catch(error) {release();client.destroy();throw error;}
  let clock,busy=false;const controller=new AbortController();
  // Local reads only, no model, no per-request polling. Stop with the Discord client.
  const beat=async()=>{
    if(busy || controller.signal.aborted || !client.isReady() || !types.length)return;busy=true;
    try {
      const channel=await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
      if(channel?.guildId!==process.env.DISCORD_GUILD_ID || !channel.isTextBased() || typeof channel.send!=='function')throw new Error('Invalid notification channel');
      const result=await notify(snapshot(),{types,ownerId:process.env.DISCORD_OWNER_ID,
        scope,signal:controller.signal,send:payload=>channel.send(payload)});
      if(result.some(r=>r.status==='failed'))console.error('Discord notification failed; recorded locally, not automatically retried.');
    } catch {console.error('Discord notification check failed.');} finally {busy=false;}
  };
  client.once('clientReady',async()=>{
    try {
      await new REST({version:'10',retries:0}).setToken(process.env.DISCORD_BOT_TOKEN).put(Routes.applicationGuildCommands(client.user.id,process.env.DISCORD_GUILD_ID),{body:commands.map(c=>c.toJSON())});
      if(controller.signal.aborted)return;
      await beat();if(types.length && !controller.signal.aborted)clock=setInterval(()=>void beat(),15000);
      if(!controller.signal.aborted)console.log('Discord commands ready.');
    }
    catch{console.error('Discord command registration failed.');await close();}
  });
  client.on('interactionCreate',interaction=>void respond(interaction).catch(()=>console.error('Discord command response failed; do not resubmit without checking the workbench.')));
  // Keep the lock until process exit, including any already-started delivery. Do not start new sends during shutdown.
  const close=async()=>{controller.abort();clearInterval(clock);await client.destroy();};
  const shutdown=()=>void close().catch(()=>console.error('Discord shutdown failed.'));
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  client.on('error',()=>console.error('Discord connection error.'));
  try {await client.login(process.env.DISCORD_BOT_TOKEN);} catch {await close();throw new Error('Discord login failed; check the local token and network (token omitted).');}
}
