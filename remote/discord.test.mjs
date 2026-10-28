import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { root,read,write } from '../automation/files.mjs';
import { createServer,snapshot } from '../dashboard/server.mjs';
import { update,enqueue } from '../work/run.mjs';
import { respond,authorized,acquireBridgeLock } from './discord.mjs';
import { baselineNotifications,notificationEvents,notificationTypes,notify,inboxButtons,inboxButtonId } from './notifications.mjs';

assert.equal(process.env.PHD_ISOLATED_TESTS,'1','Use node scripts/run-tests.mjs --remote; never test against the real office');
const scope='fictional-guild:fictional-channel:fictional-owner:tasks,inbox';
const types=notificationTypes('tasks,inbox');
const data=(items=[],inbox=[])=>({work:{items},inbox});
const task=(id,status='done',at='2026-10-10T10:00:00Z')=>({id,title:'Fixture '+id,actor:'codex',status,created_at:at,history:[{at,to:status}],handoff:'PRIVATE BODY DO NOT PUSH'});
const card=(id,version='v1')=>({id,source:'mail',source_id:id,title:'Fixture decision',detail:'PRIVATE MAIL BODY',fingerprint:version,kind:'approval',actions:[]});
const clearLedger=()=>fs.rmSync(path.join(root,'.runtime/remote/notifications.json'),{force:true});

test('notification baseline is quiet; only new inbox IDs ping across updates and restart',async()=>{
  clearLedger();const sent=[];const options={types,scope,ownerId:'fictional-owner',send:async payload=>{sent.push(payload);return {id:'message-'+sent.length};}};
  const old=data([task('old')],[card('old-mail')]);baselineNotifications(old,types,scope);
  assert.deepEqual(await notify(old,options),[]);assert.equal(sent.length,0);
  const next=data([task('old'),task('new')],[card('old-mail'),card('new-mail')]);
  assert.equal((await notify(next,options)).length,2);assert.equal(sent.length,2);
  for(const payload of sent) {
    assert.ok(payload.content.startsWith('<@fictional-owner>'));
    assert.ok(!JSON.stringify(payload).includes('PRIVATE'));assert.ok(payload.content.length<=1900);
    assert.deepEqual(payload.allowedMentions,{parse:[],users:['fictional-owner']});
  }
  baselineNotifications(next,types,scope);await notify(next,options);await notify(next,options);assert.equal(sent.length,2);
  next.inbox[1]=card('new-mail','v2');await notify(next,options);assert.equal(sent.length,2);
  // Completion already notified: editing a handoff does not create a new completion.
  next.work.items[1].updated_at='later';next.work.items[1].handoff='changed';await notify(next,options);assert.equal(sent.length,2);
  // A deliberately reopened task completing later is a genuinely new result.
  next.work.items[1]=task('new','done','2026-10-10T12:00:00Z');await notify(next,options);assert.equal(sent.length,3);
});

test('failed or uncertain external sends are recorded before send and never automatically retried',async()=>{
  clearLedger();baselineNotifications(data(),types,scope);let attempts=0;
  const state=data([task('failed-send')]);
  const options={types,scope,ownerId:'fictional-owner',send:async()=>{
    attempts++;assert.equal(read('.runtime/remote/notifications.json').records['task:failed-send'].status,'attempted');
    throw new Error('Secret provider failure');
  }};
  assert.equal((await notify(state,options))[0].status,'failed');
  await notify(state,options);baselineNotifications(state,types,scope);await notify(state,options);assert.equal(attempts,1);
});

test('notification choices, late acceptance and shared task cards preserve one useful notification',async()=>{
  clearLedger();baselineNotifications(data(),types,scope);const sent=[];
  const options={types,scope,ownerId:'fictional-owner',send:async p=>{sent.push(p);return {id:'fixture'};}};
  const state=data([task('accept')],[{...card('work:accept'),source:'work',source_id:'accept',kind:'acceptance',status:'done'}]);
  await notify(state,options);assert.equal(sent.length,1);assert.match(sent[0].embeds[0].description,/任务已完成，等待你验收/);
  state.inbox=[];await notify(state,options);assert.equal(sent.length,1,'accepting a card must not replay completion');
  state.inbox=[{...card('work:accept','new-question'),source:'work',source_id:'accept'}];
  await notify(state,options);assert.equal(sent.length,1,'an existing inbox ID must not ping again for an update');
  assert.deepEqual(notificationTypes(''),[]);assert.deepEqual(notificationEvents(state,[]),[]);
  assert.ok(notificationEvents(state,['tasks']).every(e=>e.id.startsWith('task:')));
  assert.ok(notificationEvents(state,['inbox']).every(e=>e.id.startsWith('inbox:')));
  assert.throws(()=>notificationTypes('everything'));
  assert.equal(notificationEvents(data([{...task('internal'),mode:'card'},{...task('user'),actor:'user'},{...task('deleted'),deleted_at:'now'},task('active','active'),task('cancel','cancelled')]),types).length,0);
});

test('inbox-only default sends bounded rich cards, not standalone task outcomes or private details',async()=>{
  clearLedger();const inboxTypes=notificationTypes();assert.deepEqual(inboxTypes,['inbox']);
  const inboxScope='fixture:inbox',sent=[];
  const options={types:inboxTypes,scope:inboxScope,ownerId:'fictional-owner',send:async p=>{sent.push(p);return {id:'embed-'+sent.length};}};
  const old=data([task('completed')],[card('old')]);baselineNotifications(old,inboxTypes,inboxScope);
  await notify(old,options);assert.equal(sent.length,0);
  const next=data([task('completed'),task('another-completed')],[card('old'),{...card('new'),title:'材料采购审批',category:'采购',priority:'urgent',due_at:'2026-10-12',reason:'PRIVATE REASON',outputs:['PRIVATE FILE']}]);
  await notify(next,options);assert.equal(sent.length,1);
  const payload=sent[0],embed=payload.embeds[0];
  assert.equal(payload.content,'<@fictional-owner> 📬 收件箱提醒');
  assert.deepEqual(payload.allowedMentions,{parse:[],users:['fictional-owner']});
  assert.equal(embed.author.name,'📥 科研办公室 · 收件箱');assert.equal(embed.title,'材料采购审批');
  assert.equal(embed.color,0xDC5A5A);
  assert.deepEqual(embed.fields.map(x=>[x.name,x.value]),[['需要你','审批'],['分类','采购'],['优先级','紧急'],['日期','2026-10-12']]);
  assert.equal(embed.footer.text,'事项 ID · new');assert.ok(!JSON.stringify(payload).includes('PRIVATE'));
  await notify(next,options);baselineNotifications(next,inboxTypes,inboxScope);await notify(next,options);assert.equal(sent.length,1);
  next.inbox[1]={...next.inbox[1],fingerprint:'v2',priority:'high',title:'更新审批'};
  await notify(next,options);assert.equal(sent.length,1);
  assert.equal(notificationEvents(next,inboxTypes)[1].embed.color,0xD49A32);
  next.inbox=[];await notify(next,options);assert.equal(sent.length,1);
  const bounded=notificationEvents(data([],[{...card('x'.repeat(2000)),title:'标题'.repeat(1000),category:'采购'.repeat(1000),due_at:'日期'.repeat(1000)}]),inboxTypes)[0].embed;
  assert.ok(bounded.title.length<=256);assert.ok(bounded.description.length<=4096);assert.ok(bounded.footer.text.length<=2048);
  assert.ok(bounded.fields.every(f=>f.name.length<=256 && f.value.length>0 && f.value.length<=1024));
  assert.ok(JSON.stringify(bounded).length<6000);assert.equal(bounded.color,0x10A37F);
});

test('generated options mirror labels and types but exclude navigation and conversation controls',()=>{
  const item={...card('fixture'),actions:[{id:'yes',type:'reply',label:'已有账号，尚未加入'},{id:'no',type:'reply',label:'还没有账号'},
    {id:'joined',type:'accept',label:'已加入频道'},{id:'chat',type:'nav',label:'进入对话'},{id:'compose',type:'compose',label:'继续讨论'}]};
  const row=inboxButtons(item)[0];assert.equal(row.type,1);
  assert.deepEqual(row.components.map(b=>b.label),['已有账号，尚未加入','还没有账号','已加入频道']);
  assert.ok(row.components.every(b=>b.custom_id.length<=100 && !b.url));
  assert.equal(new Set(row.components.map(b=>b.custom_id)).size,3);
  assert.notEqual(inboxButtonId(item,item.actions[0]),inboxButtonId({...item,fingerprint:'changed'},item.actions[0]));
});

test('Discord options use actual workbench reply API and acknowledgment owner; stale and repeated clicks do nothing',async()=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const originals={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const names=['PHD_DASHBOARD_PORT','DISCORD_GUILD_ID','DISCORD_CHANNEL_ID','DISCORD_OWNER_ID'];
  const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  Object.assign(process.env,{PHD_DASHBOARD_PORT:String(server.address().port),DISCORD_GUILD_ID:'fixture-guild',DISCORD_CHANNEL_ID:'fixture-channel',DISCORD_OWNER_ID:'fixture-owner'});
  const replies=[],interaction=customId=>({isButton:()=>true,isChatInputCommand:()=>false,user:{id:'fixture-owner'},guildId:'fixture-guild',channelId:'fixture-channel',customId,
    deferReply:async p=>assert.equal(p.flags,64),editReply:async p=>replies.push(p),reply:async()=>assert.fail('unexpected rejection')});
  const make=type=>{
    const t=enqueue({title:'Fixture generated option',kind:'decision',actor:'user'});
    update({id:t.id,status:'waiting_user',review:{state:'pending',kind:'decision'}});
    write('.runtime/agent/runs/'+t.id+'/inbox.json',{title:'Fixture choice',category:'示例',kind:'decision',message:'Fictional context',actions:[{id:'choice',type,label:'Fixture option',reply:'Fictional follow-up'}]});
    return snapshot().inbox.find(c=>c.source_id===t.id);
  };
  try {
    const first=make('reply'),key=inboxButtons(first)[0].components[0].custom_id,before=read('work/queue.json').items.length;
    await respond(interaction(key));assert.match(replies.at(-1).content,/已提交/);
    assert.equal(read('work/queue.json').items.length,before+1);
    const follow=read('work/queue.json').items.at(-1);assert.equal(follow.status,'queued');
    assert.ok(read('.runtime/agent/sessions.json').sessions.some(s=>s.messages.some(m=>m.inbox_reply?.action_id==='choice')));
    await respond(interaction(key));assert.match(replies.at(-1).content,/旧按钮/);assert.equal(read('work/queue.json').items.length,before+1);
    const second=make('accept'),oldKey=inboxButtons(second)[0].components[0].custom_id;
    write('.runtime/agent/runs/'+second.source_id+'/inbox.json',{title:'Updated',message:'Updated context',actions:[{id:'choice',type:'accept',label:'New option'}]});
    await respond(interaction(oldKey));assert.match(replies.at(-1).content,/旧按钮/);
    assert.ok(snapshot().inbox.some(x=>x.id===second.id));
    const now=snapshot().inbox.find(x=>x.id===second.id);
    await respond(interaction(inboxButtons(now)[0].components[0].custom_id));assert.match(replies.at(-1).content,/事项已收起/);
    assert.ok(!snapshot().inbox.some(x=>x.id===second.id));
    const rejected={...interaction(key),user:{id:'someone-else'},reply:async p=>assert.equal(p.flags,64),deferReply:async()=>assert.fail('unauthorized click')};
    await respond(rejected);
  } finally {
    write('work/queue.json',originals.queue);write('.runtime/agent/sessions.json',originals.sessions);
    for(const [name,value] of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;
    await new Promise(resolve=>server.close(resolve));
  }
});

test('failed rich inbox send is attempted once and retains its exact notification version',async()=>{
  clearLedger();const inboxTypes=['inbox'],inboxScope='fixture:embed-failure';baselineNotifications(data(),inboxTypes,inboxScope);
  let calls=0;const state=data([],[card('embed-failure')]);
  const options={types:inboxTypes,scope:inboxScope,ownerId:'owner',send:async p=>{
    calls++;assert.equal(p.embeds.length,1);assert.equal(read('.runtime/remote/notifications.json').records['inbox:embed-failure'].status,'attempted');throw Error('provider failure');}};
  assert.equal((await notify(state,options))[0].status,'failed');await notify(state,options);assert.equal(calls,1);
});

test('slash command crosses the real workbench API, reuses session and returns without waiting for completion',async()=>{
  clearLedger();const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const originalQueue=read('work/queue.json'),originalSessions=read('.runtime/agent/sessions.json'),originalRemote=read('.runtime/remote/session.json',null);
  const names=['PHD_DASHBOARD_PORT','DISCORD_GUILD_ID','DISCORD_CHANNEL_ID','DISCORD_OWNER_ID','DISCORD_NOTIFY'];
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]));
  Object.assign(process.env,{PHD_DASHBOARD_PORT:String(server.address().port),DISCORD_GUILD_ID:'fixture-guild',DISCORD_CHANNEL_ID:'fixture-channel',DISCORD_OWNER_ID:'fixture-owner',DISCORD_NOTIFY:'tasks,inbox'});
  const replies=[];
  const interaction=(command,text,extra=[])=>({isChatInputCommand:()=>true,user:{id:'fixture-owner'},channelId:'fixture-channel',guildId:'fixture-guild',commandName:command,
    options:{data:[{name:command==='task' ? 'title' : 'text',value:text},...extra]},deferReply:async p=>{assert.equal(p.flags,64);},
    reply:async()=>assert.fail('authorized command rejected'),editReply:async p=>replies.push(p)});
  try {
    baselineNotifications(snapshot(),types,scope);
    await respond(interaction('chat','@Codex Fixture remote request',[{name:'new',value:true}]));
    const first=read('.runtime/remote/session.json').session_id;
    const q=read('work/queue.json').items.at(-1);assert.equal(q.status,'queued');assert.match(replies[0].content,new RegExp(q.id));
    assert.ok(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===first).task_ids.includes(q.id));
    await respond(interaction('chat','@Claude Fixture follow-up'));
    assert.equal(read('.runtime/remote/session.json').session_id,first);assert.equal(read('work/queue.json').items.at(-1).actor,'claude');
    // A long-running job completes after the command reply; the independent path still delivers it.
    update({id:q.id,status:'done',handoff:'Fixture completed without invoking a model.'});
    const sent=[];await notify(snapshot(),{types,scope,ownerId:'fixture-owner',send:async p=>{sent.push(p);return {id:'fixture-result'};}});
    assert.equal(sent.filter(p=>p.content.includes(q.id)).length,1);
    await respond(interaction('task','Fixture task trigger'));assert.match(replies.at(-1).content,/已接手/);
    await respond(interaction('chat','Fixture independent project',[{name:'project',value:'bi-devices'}]));
    const last=read('.runtime/remote/session.json').session_id;assert.notEqual(last,first);
    assert.deepEqual(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===last).project_ids,['bi-devices']);
  } finally {
    write('work/queue.json',originalQueue);write('.runtime/agent/sessions.json',originalSessions);
    if(originalRemote)write('.runtime/remote/session.json',originalRemote);else fs.rmSync(path.join(root,'.runtime/remote/session.json'),{force:true});
    for(const [n,v] of Object.entries(old))if(v===undefined)delete process.env[n];else process.env[n]=v;
    await new Promise(resolve=>server.close(resolve));
  }
});

test('wrong owner, channel or guild never submits work; non-slash messages are ignored',async()=>{
  const env={DISCORD_OWNER_ID:'owner',DISCORD_CHANNEL_ID:'channel',DISCORD_GUILD_ID:'guild'};
  const valid={user:{id:'owner'},channelId:'channel',guildId:'guild'};assert.ok(authorized(valid,env));
  for(const invalid of [{...valid,user:{id:'other'}},{...valid,channelId:'other'},{...valid,guildId:'other'},{...valid,guildId:null}])assert.equal(authorized(invalid,env),false);
  const before=read('work/queue.json').items.length;let rejected=false;
  await respond({...valid,user:{id:'unconfigured'},isChatInputCommand:()=>true,reply:async p=>{rejected=true;assert.equal(p.flags,64);},deferReply:async()=>assert.fail('must not defer unapproved command')});
  assert.ok(rejected);await respond({isChatInputCommand:()=>false});assert.equal(read('work/queue.json').items.length,before);
});

test('one bridge owns sending; duplicate start is rejected and release permits a new start',()=>{
  const release=acquireBridgeLock();try {assert.throws(()=>acquireBridgeLock(),/already running/);} finally {release();}
  const next=acquireBridgeLock();next();assert.equal(fs.existsSync(path.join(root,'.runtime/remote/bridge.lock')),false);
});

test('a stale bridge lock fails closed instead of risking two senders',()=>{
  const lock=path.join(root,'.runtime/remote/bridge.lock');fs.writeFileSync(lock,'2147483647');
  try {assert.throws(()=>acquireBridgeLock(),/stale bridge.lock/);assert.equal(fs.readFileSync(lock,'utf8'),'2147483647');}
  finally {fs.rmSync(lock);}
});

test('stopping a bridge finishes an already-started send but does not consume or send remaining events',async()=>{
  clearLedger();baselineNotifications(data(),types,scope);const controller=new AbortController();const sent=[];
  const state=data([task('first'),task('second')]);
  const options={types,scope,ownerId:'owner',send:async p=>{sent.push(p);controller.abort();return {id:'one'};}};
  await notify(state,{...options,signal:controller.signal});assert.equal(sent.length,1);
  assert.equal(read('.runtime/remote/notifications.json').records['task:second'],undefined);
  await notify(state,options);assert.equal(sent.length,2,'new run may deliver an event never previously attempted');
});
