import test from 'node:test';
// These tests write queues, plans, sessions and the mail ledger in the tree they live in. Run against the real project they once left fixtures in
// the user's weekly records, so they refuse to start anywhere but the throw-away copy made by scripts/run-tests.mjs.
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { root,read,write } from './files.mjs';
import { weekWindow, weekOf, weekView, markdown, exportWeek, tick, addIntent, updateIntent, removeIntent, saveReview, startIntent, weeklySnapshot, weeklySources } from '../weekly/run.mjs';
import { inboxItems,acknowledgeInbox,undoAcknowledgment,inboxActivity } from '../dashboard/inbox.mjs';
import { reviewDetails } from '../dashboard/review.mjs';
import { cardActions, normalizeCard,cardOrigin,cardChain,sessionForCard } from '../dashboard/cards.mjs';
import { codexLaunch,compactionEvent } from '../agent/codex.mjs';import { recordClaudeLimits, recordClaudeUsage, recordRun } from '../usage/run.mjs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { claudeArgs, newRun, foldEvent } from '../agent/claude.mjs';
import { SYSTEM_PROMPT, stopProcess } from '../agent/native.mjs';
import { backupData } from './backup.mjs';
import { Flow, taskHandler } from '../mail-flow/flow.mjs';
import { judgePending, pickBareCards, parseDecisions, automationToday } from '../agent/mail.mjs';
import { focusProject, resolveLink, proposeLinks, renderStatus, setProjectArchived } from '../projects/run.mjs';
import { enqueue,update,parseHandoff } from '../work/run.mjs';
import { submit,execute as executeAgent,agentSnapshot,drain,startReadyWork,route,summoned,markCardTasks,deleteSession,purposeOf,askedCard,titleSession,cleanTitle,draftTitle,searchSessions,showSession } from '../agent/run.mjs';
import { executeWithoutTitle } from './titleless.mjs';
const execute=executeWithoutTitle(executeAgent);

test('Let agent handle enters real work once, without an automatic cosmetic card or result acceptance',async()=>{
  const id='handle-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  const savedQueue=read('work/queue.json'),savedSessions=read('.runtime/agent/sessions.json');
  const file=path.join(root,'workspace/outbox',id+'.md');
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'todo',?,'[]','[]','[]')").run(id,'Reply to professor','Prepare a simple reply');
  try {
    const mail=db.prepare('SELECT id,title,status,action FROM tasks WHERE id=?').all(id),entry=inboxItems(mail,[],[]).find(i=>i.source_id===id);
    const action=entry.actions.find(a=>a.label==='让 agent 处理');assert.equal(action.id,'agent-handle');
    assert.deepEqual(pickBareCards([entry]),[],'classification already provided the action; do not prepare another paid card');
    const job=submit({text:'@Codex '+action.reply,inbox_reply:{id:entry.id,fingerprint:entry.fingerprint,action_id:action.id,label:action.label}});
    markCardTasks();assert.notEqual(read('work/queue.json').items.find(t=>t.id===job.task_id).mode,'card');
    const calls=[];await execute(job.task_id,async(provider,prompt,opts)=>{
      calls.push(opts);assert.equal(opts.mode,'work');assert.match(prompt,/Prepare a simple reply/);
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Approved fixture draft only');update({id:job.task_id,outputs:[file]});return {result:'Draft ready: '+file};
    });
    assert.equal(calls.length,1);const done=read('work/queue.json').items.find(t=>t.id===job.task_id);
    assert.equal(done.status,'done');assert.ok(done.outputs.includes(file));assert.notEqual(done.review?.state,'pending');
    assert.equal(fs.existsSync(path.join(root,'.runtime/agent/runs',job.task_id,'inbox.json')),false);
    assert.equal(inboxItems(mail,read('work/queue.json').items,[]).some(i=>i.source_id===job.task_id),false);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'todo','drafting grants no send permission or whole-matter completion');
  } finally {db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();fs.rmSync(file,{force:true});write('work/queue.json',savedQueue);write('.runtime/agent/sessions.json',savedSessions);}
});

test('Monday morning uses Chicago time across the DST boundary',()=>{
  assert.equal(weekWindow(new Date('2026-10-05T13:59:00Z')).due,false);
  const monday=weekWindow(new Date('2026-10-05T14:00:00Z'));
  assert.equal(monday.start,'2026-10-05');assert.equal(monday.previous_start,'2026-09-28');assert.equal(monday.due,true);
  const dst=weekWindow(new Date('2026-11-02T14:59:00Z'));assert.equal(dst.start,'2026-11-02');assert.equal(dst.due,false);
  assert.equal(weekWindow(new Date('2026-11-02T15:00:00Z')).due,true);
  assert.equal(weekWindow(new Date('2026-10-05T03:00:00Z')).start,'2026-09-28');
});
const planPath=start=>path.join(root,'.runtime/weekly',start,'plan.json'),reviewPath=start=>path.join(root,'.runtime/weekly',start,'review.json');
const dropWeeks=(...starts)=>starts.forEach(s=>fs.rmSync(path.join(root,'.runtime/weekly',s),{recursive:true,force:true}));
test('weekWindow-based weeks must be addressed by a real Monday',()=>{
  assert.equal(weekOf('2026-10-05').end,'2026-10-11');
  for(const bad of ['2026-10-06','2026-02-30','10-05','']) assert.throws(()=>weekOf(bad),/周一/);
});
test('the Monday opening happens once and carries only unfinished goals over, without doubling goals already in the week',()=>{
  const queue=read('work/queue.json');
  try {
    write('work/queue.json',{...queue,items:[{id:'finished-fixture',title:'done thing',status:'done',project_ids:[],completed_at:'2026-10-01T15:00:00Z'},
      {id:'open-fixture',title:'open thing',status:'queued',project_ids:[]}]});
    const last=addIntent({week:'2026-09-28',title:'free text goal'}),done=addIntent({week:'2026-09-28',task_id:'finished-fixture'}),open=addIntent({week:'2026-09-28',task_id:'open-fixture'});
    addIntent({week:'2026-10-05',title:'free text goal'});   // already written into the new week before Monday 09:00
    assert.equal(tick(new Date('2026-10-05T13:59:00Z')),null,'before 09:00 Chicago nothing opens');
    const opened=tick(new Date('2026-10-05T14:00:00Z'));assert.ok(opened);
    assert.deepEqual(opened.plan.intents.map(i=>i.task_id || i.title),['free text goal','open-fixture']);assert.equal(opened.plan.carried,1);
    assert.equal(tick(new Date('2026-10-05T14:10:00Z')),null,'the week opens once');
    assert.ok(last.id && done.task_id==='finished-fixture' && open.task_id==='open-fixture');
  } finally {write('work/queue.json',queue);dropWeeks('2026-09-28','2026-10-05');}
});
test('weekly research targets create project work without making mail the primary plan',async()=>{
  try {
    const intent=addIntent({week:'2026-10-05',title:'[validation] Bi 薄膜：测量样品'});assert.deepEqual(intent.project_ids,['bi-devices']);
    const started=await startIntent(intent.id,'2026-10-05');
    const item=read('work/queue.json').items.find(i=>i.id===started.task_id);
    assert.equal(item.actor,'user');assert.equal(item.status,'waiting_user');assert.equal(started.source,'weekly-plan');
    const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==item.id);write('work/queue.json',q);
    assert.equal(read('.runtime/weekly/2026-10-05/plan.json').intents[0].task_id,item.id,'the goal remembers its task');
  } finally {dropWeeks('2026-10-05');}
});
test('research-log records join a week only by a date confirmed to the day, stay candidates until the user selects them, and carry their own evidence note',()=>{
  const file=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),before=fs.existsSync(file) ? fs.readFileSync(file) : null;
  const entry=(id,title,date,confirmed,extra='')=>`### ${id} ${title}\n<!--node {"date":"${date}","date_confirmed":${confirmed}}-->\n- 发生时间：${date}\n${extra}\n`;
  try {
    fs.rmSync(file,{force:true});const otherUnplaced=weekView('2026-10-05').research.unplaced; // other projects' real baselines have their own unconfirmed dates
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,'## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n'+
      entry('T-20261006-01','Measured in week','2026-10-06',true,'- 来源与性质：用户转述，未核原始数据\n')+entry('T-20261001-01','Earlier week','2026-10-01',true)+
      entry('T-20261007-01','Date still unconfirmed','2026-10-07',false)+entry('T-20261005-01','No signal found','2026-10-05/2026-10-07',true)+entry('T-20261006-02','Only a month','2026-10',true));
    const ids=week=>weekView(week).research.candidates.filter(c=>c.project_id==='graphene-thz').map(c=>c.id);
    assert.deepEqual(ids('2026-10-05'),['T-20261005-01','T-20261006-01'],'a range counts in the week it starts; an attempt that found nothing is a record too');
    assert.deepEqual(ids('2026-09-28'),['T-20261001-01']);assert.deepEqual(ids('2026-10-12'),[]);
    const view=weekView('2026-10-05');
    assert.equal(view.research.unplaced-otherUnplaced,2,'an unconfirmed date and a month-only date are counted, never placed');
    assert.match(view.research.candidates.find(c=>c.id==='T-20261006-01').evidence,/用户转述，未核原始数据/);
    assert.ok(!markdown('2026-10-05','review').includes('Measured in week'),'a candidate is not in the report until it is chosen');
    saveReview({week:'2026-10-05',included:['graphene-thz:T-20261006-01']});
    const report=markdown('2026-10-05','review');
    assert.ok(report.includes('Measured in week') && report.includes('来源与性质：用户转述，未核原始数据'));assert.ok(!report.includes('No signal found'));
  } finally {before ? fs.writeFileSync(file,before) : fs.rmSync(file,{force:true});dropWeeks('2026-10-05');}
});
test('what the user wrote is edited by id and never touched by refreshing, exporting or opening the week',()=>{
  const queue=read('work/queue.json'),week='2026-10-05';
  try {
    write('work/queue.json',{...queue,items:[{id:'pool-fixture',title:'pool task',status:'queued',project_ids:['bi-devices'],goal:'g'}]});
    const linked=addIntent({week,task_id:'pool-fixture',expected:'a plot'});
    assert.equal(linked.title,'pool task');assert.deepEqual(linked.project_ids,['bi-devices']);assert.equal(read('work/queue.json').items.length,1,'linking copies nothing');
    assert.throws(()=>addIntent({week,task_id:'pool-fixture'}),/已经在本周计划/);assert.throws(()=>addIntent({week,task_id:'nope'}),/未知任务/);
    assert.throws(()=>addIntent({week,title:'  '}),/不能为空/);assert.throws(()=>addIntent({week,title:'x',project_ids:['nope']}),/未知项目/);
    // Renaming keeps the link to the task and the project assignment: that is what matching by title lost.
    const renamed=updateIntent({week,id:linked.id,title:'pool task, reworded'});
    assert.equal(renamed.task_id,'pool-fixture');assert.deepEqual(renamed.project_ids,['bi-devices']);assert.equal(renamed.expected,'a plot');
    assert.equal(updateIntent({week,id:linked.id,expected:''}).expected,'','the expected output can be cleared');
    assert.throws(()=>updateIntent({week,id:linked.id,title:''}),/不能为空/);assert.throws(()=>updateIntent({week,id:'nope',title:'x'}),/未知周目标/);
    const view=weekView(week);
    assert.equal(view.pool.work.find(t=>t.id==='pool-fixture').planned,true);
    saveReview({week,summary:'my summary',next_adjust:'my adjustment',included:['graphene-thz:T-20261001-01']});
    assert.equal(saveReview({week,summary:'edited'}).next_adjust,'my adjustment','fields not sent are kept');
    assert.throws(()=>saveReview({week,included:['../x']}),/不合法/);assert.throws(()=>saveReview({week:'2026-10-06',summary:'x'}),/周一/);
    const bytes=[planPath(week),reviewPath(week)].map(f=>fs.readFileSync(f));
    for(const now of [new Date('2026-10-08T12:00:00Z'),new Date('2026-10-12T14:00:00Z')]) {weekView(week,now);weekView('2026-09-28',now);markdown(week,'plan',now);markdown(week,'review',now);}
    exportWeek(new Date('2026-10-08T12:00:00Z'));
    assert.ok(!fs.existsSync(planPath('2026-09-28')) && !fs.existsSync(reviewPath('2026-09-28')),'looking at another week creates nothing');
    const after=[planPath(week),reviewPath(week)].map(f=>fs.readFileSync(f));
    assert.ok(after[0].equals(bytes[0]) && after[1].equals(bytes[1]),'viewing and exporting do not rewrite the user files');
    // Opening the week adds its bookkeeping and nothing else: the goals the user wrote stay as they are.
    assert.deepEqual(tick(new Date('2026-10-08T12:00:00Z')).plan.intents.map(i=>i.id),[linked.id]);
    removeIntent({week,id:linked.id});
    assert.equal(read('work/queue.json').items.length,1,'removing a goal leaves its task alone');
    assert.throws(()=>removeIntent({week,id:linked.id}),/未知周目标/);
    assert.equal(read('.runtime/weekly/2026-10-05/review.json').summary,'edited');
  } finally {write('work/queue.json',queue);dropWeeks('2026-10-05','2026-10-12');}
});
test('one human inbox ranks approvals, deliverable acceptance and mail decisions; supplier waiting stays outside',()=>{
  const now=new Date('2026-10-05T12:00:00Z');
  const items=inboxItems([{id:randomUUID(),title:'mail',status:'todo',action:'judge'},{id:randomUUID(),title:'supplier',status:'waiting',action:'wait'}],
    [{id:randomUUID(),title:'approval',status:'waiting_user',review:{kind:'approval',state:'pending'},due_at:'2026-10-05T13:00:00Z',outputs:[],project_ids:[]},
      {id:randomUUID(),title:'output',status:'done',review:{kind:'acceptance',state:'pending'},outputs:['result.csv'],project_ids:[]}],[],now).filter(i=>i.source!=='project');
  assert.equal(items.length,3);assert.equal(items[0].kind,'approval');assert.equal(items[0].priority,'urgent');
  assert.ok(items.some(i=>i.kind==='acceptance'));assert.ok(!items.some(i=>i.title==='supplier'));
});
test('execution failures and waits are not inbox questions; pending reviews survive and merged inputs never duplicate them',()=>{
  const base={outputs:[],project_ids:[]},primary=randomUUID(),merged=randomUUID();
  const work=[
    {...base,id:randomUUID(),title:'[memory-v2-smoke] paraphrase',status:'failed'},
    {...base,id:randomUUID(),title:'interrupted chat',status:'failed'},
    {...base,id:randomUUID(),title:'waiting without a question',status:'waiting_user'},
    {...base,id:randomUUID(),title:'cancelled old question',status:'cancelled',review:{kind:'decision',state:'pending'}},
    {...base,id:primary,title:'explicit question',status:'waiting_user',review:{kind:'decision',state:'pending'}},
    {...base,id:merged,title:'merged input',merged_into:primary,status:'failed',review:{kind:'decision',state:'pending'}},
    {...base,id:randomUUID(),title:'failed but still needs approval',status:'failed',review:{kind:'approval',state:'pending'}}];
  for(const includeAcknowledged of [false,true]) {
    const cards=inboxItems([],work,[],new Date(),includeAcknowledged).filter(i=>i.source==='work');
    assert.deepEqual(cards.map(i=>i.title),['explicit question','failed but still needs approval']);
  }
});

test('one explicit mail matter shows its latest question, not ancestor/sibling cards; unrelated matters survive',()=>{
  const base={status:'done',outputs:[],project_ids:[],review:{kind:'decision',state:'pending'}};
  const a=randomUUID(),b=randomUUID(),c=randomUUID(),other=randomUUID();
  const work=[{...base,id:a,title:'old draft',goal:'原事项：mail:fixture-one',updated_at:'2026-10-12T10:00:00Z'},
    {...base,id:b,title:'new approval',goal:'原事项：work:'+a,updated_at:'2026-10-12T11:00:00Z'},
    {...base,id:c,title:'current mail question',goal:'原事项：mail:fixture-one',updated_at:'2026-10-12T12:00:00Z'},
    {...base,id:other,title:'unrelated approval',goal:'原事项：mail:fixture-two',updated_at:'2026-10-12T09:00:00Z'}];
  const mail=[{id:'fixture-one',title:'original aggregate',status:'todo',action:'current'},
    {id:'fixture-two',title:'other aggregate',status:'todo',action:'other'}];
  assert.deepEqual(inboxItems(mail,work,[],new Date(),false,[]).map(i=>i.title),['current mail question','unrelated approval']);
  assert.equal(inboxItems(mail,work,[],new Date(),true,[]).filter(i=>i.source==='work').length,4,'close/undo can still reach superseded ancestors');
  const cyclic=[{...base,id:a,title:'cycle A',goal:'原事项：work:'+b},{...base,id:b,title:'cycle B',goal:'原事项：work:'+a}];
  assert.equal(inboxItems([],cyclic,[],new Date(),false,[]).length,2,'invalid provenance must not hide questions');
});

test('a closed mail matter retires its leftover cards from every branch, and a mail card reopens its own conversation',()=>{
  const base={status:'done',outputs:[],project_ids:[],review:{kind:'decision',state:'pending'}};
  const a=randomUUID(),b=randomUUID(),c=randomUUID();
  const work=[{...base,id:a,title:'branch one',goal:'原事项：mail:closed-one',updated_at:'2026-10-12T10:00:00Z'},
    {...base,id:b,title:'branch two follow-up',goal:'原事项：work:'+a,updated_at:'2026-10-12T11:00:00Z'},
    {...base,id:c,title:'other matter',goal:'原事项：mail:open-two',updated_at:'2026-10-12T09:00:00Z'}];
  const mail=[{id:'closed-one',title:'t',status:'done',action:'a'},{id:'open-two',title:'t2',status:'todo',action:'a2'}];
  assert.deepEqual(inboxItems(mail,work,[],new Date(),false,[]).filter(i=>i.source==='work').map(i=>i.title),['other matter']);
  assert.equal(inboxItems(mail,work,[],new Date(),true,[]).filter(i=>i.source==='work').length,3,'close/undo still reach them');
  const sessions=[{id:'s1',task_ids:[a],messages:[{at:'2026-10-12T10:00:00Z'}]},{id:'s2',task_ids:[b],messages:[{at:'2026-10-12T12:00:00Z'}]},{id:'s3',task_ids:[c],messages:[]}];
  assert.equal(sessionForCard(sessions,{id:'mail:closed-one',source_id:'closed-one'},work).id,'s2','newest conversation on the same matter');
  assert.equal(sessionForCard(sessions,{id:'mail:open-two',source_id:'open-two'},work).id,'s3');
  assert.equal(sessionForCard(sessions,{id:'work:'+c,source_id:c},work).id,'s3');
  assert.equal(sessionForCard(sessions,{id:'mail:none',source_id:'none'},work),undefined);
});

test('a free follow-up that raises another card persists its known chain so the final resolution closes it',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json'),ack:read('.runtime/inbox/acknowledged.json',{})};
  try {
    const first=submit({text:'@Codex [validation] prepare a proposal'});
    const question={kind:'approval',message:'Send the proposal?',actions:[{id:'send',type:'reply',label:'Send',reply:'Send this version'}]};
    await execute(first.task_id,async()=>{write(`.runtime/agent/runs/${first.task_id}/inbox.json`,question);return {result:'proposal ready'};});
    const second=submit({text:'@Codex 发送',session_id:first.session_id});
    await execute(second.task_id,async()=>{write(`.runtime/agent/runs/${second.task_id}/inbox.json`,{...question,origin:'work:'+first.task_id,message:'Connector failed; user will handle it'});return {result:'not sent'};});
    const item=read('work/queue.json').items.find(w=>w.id===second.task_id);
    assert.equal(cardOrigin(item.goal),'work:'+first.task_id);
    assert.deepEqual(cardChain('work:'+second.task_id,read('work/queue.json').items),['work:'+second.task_id,'work:'+first.task_id]);
    const third=submit({text:'@Codex 我已发送，无需检测，标记完成',session_id:first.session_id});
    await execute(third.task_id,async()=>{write(`.runtime/agent/runs/${third.task_id}/inbox.json`,{message:'User confirms completion',resolved:true});return {result:'closed; no mailbox query'};});
    for(const id of [first.task_id,second.task_id])assert.equal(read('work/queue.json').items.find(w=>w.id===id).review.state,'accepted');
    assert.equal(inboxItems([],read('work/queue.json').items,[],new Date(),false,read('.runtime/agent/sessions.json').sessions).length,0);
  } finally {write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);write('.runtime/inbox/acknowledged.json',saved.ack);}
});

test('normal answers and missing prose artifacts do not create user work, but explicit action cards do',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const made=[];
  const run=async(result,{card,require_outputs=false,goal='解释现有模块'}={})=>{
    const job=submit({text:'@Codex [validation] '+goal});made.push(job);
    if(require_outputs)update({id:job.task_id,require_outputs:true});
    await execute(job.task_id,async()=>{
      if(card)write(`.runtime/agent/runs/${job.task_id}/inbox.json`,card);
      return {result,sessionId:'fake'};
    });
    return read('work/queue.json').items.find(i=>i.id===job.task_id);
  };
  try {
    for(const answer of [
      '| **被动写入** | 有互斥锁，失败不自动重试 |',
      '旧版写入.*(?:拒绝|失败) 会误判；这是一份诊断报告。',
      '测试描述包含任务未完成、操作未完成、需要用户权限和重试，但本轮问答已回答。']) {
      const item=await run(answer);assert.equal(item.status,'done');assert.equal(item.review,undefined);
      assert.equal(inboxItems([],read('work/queue.json').items,[]).some(c=>c.source_id===item.id),false);
    }
    const question=await run('仍缺权限，等你决定。',{card:{kind:'decision',message:'请授权具体操作。',actions:[{id:'go',label:'讨论授权',type:'reply',reply:'核对需要什么权限'}]}});
    assert.equal(question.review.state,'pending');
    assert.ok(inboxItems([],read('work/queue.json').items,[]).some(c=>c.source_id===question.id));
    const missing=await run('没有产出，只说明情况。',{require_outputs:true});
    assert.equal(missing.status,'done');assert.notEqual(missing.review?.state,'pending');
    assert.equal(inboxItems([],read('work/queue.json').items,[]).some(c=>c.source_id===missing.id),false,'a chat reply does not invent an unasked delivery decision');
    const target=path.join(root,'.runtime',`missing-${randomUUID()}.csv`);
    for(const goal of ['不要生成 '+target+'，只解释方案。','说明如何保存 '+target+'，这次只讨论。','输入示例是 '+target+'，请生成一段解释而不是文件。']) {
      const explained=await run('方案说明已完成，本轮没有写文件。',{goal});
      assert.equal(explained.status,'done','mentioning a missing path does not create a delivery requirement');
      assert.equal(explained.review,undefined);
      assert.equal(inboxItems([],read('work/queue.json').items,[]).some(c=>c.source_id===explained.id),false);
    }
  } finally {
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);
    for(const job of made)fs.rmSync(path.join(root,'.runtime/agent/runs',job.task_id),{recursive:true,force:true});
  }
});

test('routing is decided by @ alone: the AIs named in order, @all means both, no @ means the last speaker, then the default',()=>{
  assert.equal(route('@Claude 创建文件').provider,'claude');assert.equal(route('@Codex 读论文').provider,'codex');
  assert.deepEqual(route('@Claude @Codex 讨论').speakers,['claude','codex']);
  assert.deepEqual(route('@all 讨论').speakers,['codex','claude','deepseek']);assert.deepEqual(route('@大家 看看').speakers,['codex','claude','deepseek']);
  assert.equal(route('画一个 AutoCAD 图',{last:'claude'}).provider,'claude');
  assert.equal(route('提到 codex 这个词',{last:'claude'}).provider,'claude');
  assert.equal(route('随便聊聊',{fallback:'codex'}).provider,'codex');
  assert.equal(route('@你 再看看',{last:'claude'}).provider,'claude');
  assert.equal(route('生成周计划').provider,'program');
  assert.notEqual(route('我现在看周计划里问题与下一步堆了很多东西，这样好吗').provider,'program');
  assert.equal(route('画一个 AutoCAD 图',{fallback:'claude'}).kind,'cad');
});
test('a reply passes the turn on only with a line that starts with the other AI name',()=>{
  assert.equal(summoned('结论\n@Codex 请核查第二点','claude'),'codex');
  assert.equal(summoned('  @claude 看一下','codex'),'claude');
  assert.equal(summoned('我同意 @Codex 的看法','claude'),null);
  assert.equal(summoned('@Claude 自己','claude'),null);
  assert.equal(summoned('@Codex x','claude',['codex']),null);
  assert.equal(summoned('@Codexa x','claude'),null);
});
test('a reply that @-names the other AI hands the turn over; every turn in the chain is an ordinary agent, and the chain stops at ten turns',async()=>{
  const made=[];
  try {
    const job=submit({text:'@Claude [validation] 你好',project_id:'bi-devices'});made.push(job);
    const seen=[];
    await execute(job.task_id,async(provider,prompt,opts)=>{seen.push({provider,prompt,opts});return {result:`第${seen.length}句\n${seen.length%2 ? '@Codex' : '@Claude'} 接着说\n交接：{"summary":"摘要${seen.length}","next":"下一步"}`,sessionId:'fake'};});
    assert.deepEqual(seen.map(x=>x.provider),['claude','codex','claude','codex','claude','codex','claude','codex','claude','codex']);
    assert.ok(seen.every((x,i)=>x.opts.model===undefined&&x.opts.mode==='work'&&x.opts.effort===read('agent/config.json').reasoning_effort));
    assert.match(seen[0].prompt,/你是 Claude/);assert.match(seen[0].prompt,/@Codex、@Claude 或 @DeepSeek/);assert.match(seen[1].prompt,/你是 Codex/);
    assert.doesNotMatch(seen[0].prompt,/同事回复（引文）/);
    assert.ok(seen[0].prompt.endsWith('当前请求：@Claude [validation] 你好'));
    for(const [i,x] of seen.slice(1).entries()){
      const record=x.opts.inputParts.find(p=>p.kind==='conversation_history').text.split('\n').slice(1).map(JSON.parse);
      assert.equal(record[0].role,'user');assert.equal(record[0].text,'@Claude [validation] 你好');
      assert.deepEqual(record.slice(1).map(m=>m.text.split('\n')[0]),Array.from({length:i+1},(_,n)=>`第${n+1}句`));
      assert.doesNotMatch(x.prompt,/当前请求：|同事回复（引文）/);
    }
    assert.ok(seen.every(x=>!x.prompt.includes('已回应过，不要当成新输入重答')));
    assert.ok(seen.every(x=>!/inbox\.json/.test(x.prompt)));
    assert.match(seen[0].prompt,/模块 [^\n]*procurement/);assert.match(seen[0].prompt,/来回别太久/);
    const spoken=read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id).messages.filter(m=>m.task_id===job.task_id&&m.role==='assistant');
    assert.deepEqual(spoken.map(m=>m.provider),['claude','codex','claude','codex','claude','codex','claude','codex','claude','codex']);
    assert.ok(spoken.every(m=>!m.text.includes('交接：')));assert.match(spoken[0].text,/第1句/);
    assert.equal(read('work/queue.json').items.find(i=>i.id===job.task_id).brief.summary,'摘要10');
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('the per-run directory sits after the conversation record, so two turns of one session share a prompt prefix for cache hits',async()=>{
  const made=[];
  try {
    const a=submit({text:'@claude [validation] 第一轮'});made.push(a);
    const seen=[],inputs=[];const runner=async(provider,prompt,opts)=>{seen.push(prompt);inputs.push(opts.inputParts);return {result:`回复${seen.length}`,sessionId:'fake'};};
    await execute(a.task_id,runner);
    const b=submit({text:'@claude [validation] 第二轮',session_id:a.session_id});made.push(b);
    await execute(b.task_id,runner);
    assert.equal(seen.length,2);
    const dir=id=>`本次运行目录：${path.join(root,'.runtime/agent/runs',id)}`;
    for(const [prompt,job] of [[seen[0],a],[seen[1],b]]){
      assert.ok(prompt.includes(dir(job.task_id)));
      const opening=prompt.split('\n').find(l=>l.startsWith('周围有：'));
      assert.ok(opening && !read('projects/catalog.json').projects.some(p=>opening.includes(p.name)),'the opening line lists modules, not project names');
      assert.ok(prompt.indexOf(dir(job.task_id))>prompt.indexOf('周围有：')&&prompt.indexOf(dir(job.task_id))<prompt.indexOf('当前请求：'));
    }
    const office=inputs[0].find(p=>p.kind==='office_context').text;
    assert.equal(inputs[1].find(p=>p.kind==='office_context').text,office);
    assert.ok(seen.every(p=>p.startsWith(office)));
    assert.doesNotMatch(office,/今天是|本轮相关记忆|本次运行目录/);
    assert.ok(seen[1].indexOf('今天是')>seen[1].indexOf('对话记录（逐条引文，JSONL）：'));
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('@all asks three colleagues in turn, all are ordinary work turns, and a completed task is not run again',async()=>{
  const made=[];
  try {
    const job=submit({text:'@all [validation] 读取 D:/x/y.txt 然后聊聊',project_id:'bi-devices'});made.push(job);
    const seen=[];const runner=async(provider,prompt,opts)=>{seen.push({provider,prompt,opts});return {result:`发言${seen.length}`,sessionId:'fake'};};
    await execute(job.task_id,runner);await execute(job.task_id,runner);
    assert.deepEqual(seen.map(x=>x.provider),['codex','claude','deepseek']);
    assert.ok(seen.every(x=>x.opts.mode==='work'));
    assert.match(seen[1].prompt,/@all[^]*发言1/);assert.doesNotMatch(seen[1].prompt,/当前请求：|同事回复（引文）|递来的话/);
    assert.equal(read('work/queue.json').items.find(i=>i.id===job.task_id).status,'done');
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('a message with no @ goes to whoever answered last in that session, a new session to the default',async()=>{
  const made=[];
  try {
    const first=submit({text:'@Claude [validation] 你好',project_id:'bi-devices'});made.push(first);
    await execute(first.task_id,async()=>({result:'好的',sessionId:'fake'}));
    const next=submit({text:'[validation] 接着说，写个脚本分析数据',session_id:first.session_id});made.push(next);
    assert.equal(next.provider,'claude');
    const fresh=submit({text:'[validation] 另起一个',project_id:'bi-devices'});made.push(fresh);
    assert.equal(fresh.provider,read('agent/config.json').default_provider);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('an explicit business completion rejects a missing file, while its unsubmitted reply remains open',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json'),config:read('agent/config.json')};
  write('agent/config.json',{...saved.config,enabled:true});
  const missing=`D:/Main/assistant/.runtime/diagnostics/missing-${randomUUID()}.txt`;
  const operation=enqueue({title:'Create the actual artifact',goal:`创建文件 ${missing}`,kind:'data',actor:'codex',status:'queued',project_ids:['bi-devices'],require_outputs:true});
  const job={task_id:operation.id,session_id:startReadyWork().find(j=>j.task_id===operation.id).session_id};
  try {
    await execute(job.task_id,async()=>{
      assert.throws(()=>update({id:job.task_id,status:'done',handoff:'claimed delivery',outputs:[missing]}),/不存在/);
      return {result:`文件已创建：${missing}`,sessionId:'fake'};
    });
    const i=read('work/queue.json').items.find(i=>i.id===job.task_id);
    assert.equal(i.status,'open');assert.equal(i.outputs.length,0);assert.notEqual(i.review?.state,'pending');
  }finally{
    write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);write('agent/config.json',saved.config);
  }
});
test('neither prose paths nor native file changes infer delivery or acceptance; explicit records and cards do',async()=>{
  const real=path.join(root,'AGENTS.md'),scratch=path.join(root,'.runtime/agent/runs',`scratch-${randomUUID()}.mjs`);
  fs.mkdirSync(path.dirname(scratch),{recursive:true});fs.writeFileSync(scratch,'');
  const made=[];
  const review=async(text,artifacts,{card,origin,inbox_reply,result='整理好了。',registered}={})=>{const job=submit({text,project_id:'bi-devices',inbox_reply});made.push(job);
    if(origin){const state=read('.runtime/agent/sessions.json');state.sessions.find(s=>s.id===job.session_id).origin=origin;write('.runtime/agent/sessions.json',state);}
    await execute(job.task_id,async()=>{if(card)write(`.runtime/agent/runs/${job.task_id}/inbox.json`,card);if(registered)update({id:job.task_id,outputs:registered});return {result,sessionId:'fake',artifacts};});
    return read('work/queue.json').items.find(i=>i.id===job.task_id);};
  try {
    assert.equal((await review('@Codex [validation] 整理这批数据',[real])).review,undefined);
    assert.deepEqual((await review('@Codex [validation] 整理这批数据，需要验收',[scratch])).outputs,[]);
    assert.equal((await review('@Codex [validation] 不需要验收这些数据',[real])).review,undefined);
    assert.equal((await review('@Codex [validation] 整理这批数据，需要验收',[real])).review,undefined,'natural wording alone is not an action card');
    assert.equal((await review('@Codex [validation] 按卡片继续处理数据',[real],{inbox_reply:{id:'work:fixture',action_id:'go'}})).review,undefined,'card conversations are interactive, not automatic project steps');
    const card={kind:'acceptance',message:'请核对交付物。',actions:[{id:'ok',type:'accept',label:'验收通过'}]};
    assert.equal((await review('@Codex [validation] 整理数据',[real],{card})).review.kind,'acceptance');
    assert.equal((await review('@Codex [validation] 后台数据步骤',[real],{origin:'task'})).review,undefined,'origin and writes do not invent an acceptance question');
    assert.equal((await review('@Codex [validation] 后台数据步骤',[scratch],{origin:'task'})).review,undefined);
    assert.equal((await review('@Codex [validation] 后台数据步骤',[real],{origin:'task',card:{kind:'decision',message:'已办完。',resolved:true}})).review,undefined,'resolved does not raise a fresh acceptance card');
    assert.deepEqual((await review('@Codex [validation] 仅提到临时路径',[],{result:scratch})).outputs,[],'prose paths are not delivery receipts');
    assert.deepEqual((await review('@Codex [validation] 交付明确登记的临时路径',[],{result:'Registered.',registered:[scratch]})).outputs,[scratch],'work update preserves explicit receipts');
  } finally {
    fs.rmSync(scratch,{force:true});
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('an acceptance can be undone without completing a supplier or losing the pending review',()=>{
  const task=enqueue({title:'[validation] acceptance undo',kind:'data'});
  update({id:task.id,status:'done',handoff:'fixture output',review:{kind:'acceptance',state:'pending'}});
  const get=()=>read('work/queue.json').items;
  const entry=inboxItems([],get(),[]).find(i=>i.source_id===task.id);acknowledgeInbox(entry);
  assert.equal(inboxItems([],get(),[]).some(i=>i.id===entry.id),false);
  assert.ok(inboxActivity().undoable.some(i=>i.id===entry.id));
  undoAcknowledgment(entry.id,[],get(),[]);
  assert.equal(get().find(i=>i.id===task.id).review.state,'pending');
  assert.equal(inboxItems([],get(),[]).some(i=>i.id===entry.id),true);
  const mail={id:randomUUID(),title:'supplier decision',status:'todo',action:'verify'};
  const decision=inboxItems([mail],[],[])[0];acknowledgeInbox(decision);undoAcknowledgment(decision.id,[mail],[],[]);
  assert.equal(mail.status,'todo');
  const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==task.id);write('work/queue.json',q);
});

test('confirming a mail item closes the task for the inbox and weekly plan, and undo reopens it',()=>{
  const id='validation-'+randomUUID(),file=path.join(root,'.runtime/mail-flow/mail.sqlite');
  const db=new DatabaseSync(file);
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all();
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(id,'[validation] close mail','todo','verify');
  try {
    const entry=inboxItems(rows(),[],[]).find(i=>i.source_id===id);assert.ok(entry);
    assert.ok(weekView().pool.mail.some(i=>i.id===id));
    acknowledgeInbox(entry);
    assert.equal(db.prepare('SELECT status,revision FROM tasks WHERE id=?').get(id).status,'done');
    assert.equal(db.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision,2);
    assert.equal(inboxItems(rows(),[],[]).some(i=>i.id===entry.id),false);
    assert.equal(weekView().pool.mail.some(i=>i.id===id),false);
    undoAcknowledgment(entry.id,rows(),[],[]);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'todo');
    assert.equal(inboxItems(rows(),[],[]).some(i=>i.id===entry.id),true);
  } finally { db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close(); }
});

test('a bare mail decision offers a one-click agent check; other cards and agent-written options are unchanged',()=>{
  const bare=cardActions({source:'mail',kind:'decision'});
  assert.deepEqual(bare.map(a=>a.type),['reply','accept']);assert.match(bare[0].reply,/按实际需要推进/);assert.doesNotMatch(bare[0].reply,/后台 action|不预设|focus_mail/,"the button does not hand the background judgment to the agent as the task");assert.doesNotMatch(bare[0].reply,/不发送|不联络/);
  assert.deepEqual(cardActions({source:'work',kind:'decision'}).map(a=>a.type),['accept']);
  assert.deepEqual(cardActions({source:'work',kind:'acceptance'}).map(a=>a.type),['review','accept','compose']);
  assert.deepEqual(cardActions({source:'mail',kind:'decision'},{actions:[{id:'x',type:'accept',label:'确认'}]}).map(a=>a.label),['确认']);
});

test('every card about a mail carries the link to the original mail, whether it comes from stored messages, old-board notes, or the mail a work card was raised from',()=>{
  const a='validation-'+randomUUID(),b='validation-'+randomUUID(),url='https://outlook.office365.com/owa/?ItemID=STORED%3D&exvsurl=1',old='https://outlook.office365.com/owa/?ItemID=LEGACY%3D&exvsurl=1';
  const db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),ids=[];
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(a,'[validation] stored','todo','verify');
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts,legacy) VALUES(?,?,?,?,'[]',?,'[]',?)").run(b,'[validation] legacy','todo','verify',JSON.stringify(['Old subject']),JSON.stringify({notes:'邮件链接: '+old+'\n主题: S'}));
  db.prepare('INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,?,?,?)').run('msg-'+a,'f',JSON.stringify({id:'msg-'+a,subject:'Stored subject',sender:'x',recipients:[],received:'2026-10-01T00:00:00Z',folder:'Inbox',text:'t',link:url}),'judged','',0);
  db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run('msg-'+a,a);
  try {
    const card=enqueue({title:'[validation] raised from mail',kind:'mail',goal:'原事项：mail:'+a});ids.push(card.id);
    const again=enqueue({title:'[validation] raised from that card',kind:'mail',goal:'原事项：work:'+card.id});ids.push(again.id);
    const plain=enqueue({title:'[validation] no origin',kind:'data'});ids.push(plain.id);
    for(const id of ids)update({id,status:'done',handoff:'fixture',review:{kind:'decision',state:'pending'}});
    const current=inboxItems(rows(),read('work/queue.json').items,[]);
    assert.equal(current.some(i=>i.source_id===card.id),false,'superseded parent is not an extra inbox question');
    assert.deepEqual(current.find(i=>i.source_id===again.id).mail_links.map(l=>l.url),[url]);
    const shown=inboxItems(rows(),read('work/queue.json').items,[],new Date(),true),link=id=>shown.find(i=>i.source_id===id)?.mail_links;
    assert.deepEqual(link(a).map(l=>l.url),[url]);
    assert.deepEqual(link(b).map(l=>l.url),[old]);assert.equal(link(b)[0].subject,'Old subject');
    assert.deepEqual(link(card.id).map(l=>l.url),[url]);
    assert.deepEqual(link(again.id).map(l=>l.url),[url]);
    assert.deepEqual(link(plain.id),[]);
    assert.deepEqual(reviewDetails('work',card.id).messages.map(m=>m.link),[url]);
    const legacyView=reviewDetails('mail',b);assert.equal(legacyView.messages.length,0);assert.deepEqual(legacyView.links.map(l=>l.url),[old]);
  } finally {
    db.prepare('DELETE FROM sources WHERE task_id=?').run(a);db.prepare('DELETE FROM messages WHERE id=?').run('msg-'+a);
    db.prepare('DELETE FROM tasks WHERE id IN (?,?)').run(a,b);db.close();
    const q=read('work/queue.json');q.items=q.items.filter(i=>!ids.includes(i.id));write('work/queue.json',q);
  }
});

test('an inbox reply on a mail card hands the agent that task\'s evidence, keeps a short title, and a failed run brings the card back',async()=>{
  const id='validation-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  const legacy=JSON.stringify({notes:'账号: me@example.org\n最新消息ID: AAMkSECRET\n主题: S\n下一步: 核对证据XYZ',metadata:{comments:[{body:'评论ABC'}]}});
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts,legacy) VALUES(?,?,?,?,'[]','[]','[]',?)").run(id,'[validation] evidence','todo','verify',legacy);
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),work=()=>read('work/queue.json').items;
  const entry=inboxItems(rows(),[],[]).find(i=>i.source_id===id);let job,prompt;
  try {
    job=submit({title:'让 agent 先核对 · evidence',text:'针对邮件「evidence」，我选择：让 agent 先核对。',
      inbox_reply:{id:entry.id,fingerprint:entry.fingerprint,action_id:'agent-check',label:'让 agent 先核对'}});
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.id===entry.id),false);
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(x=>x.id===job.session_id).origin,'task');
    await execute(job.task_id,async(provider,text)=>{prompt=text;throw new Error('fake failure');});
    assert.match(prompt,/核对证据XYZ/);assert.match(prompt,/评论ABC/);assert.doesNotMatch(prompt,/AAMkSECRET|me@example\.org/);
    const item=work().find(i=>i.id===job.task_id);assert.equal(item.status,'failed');assert.equal(item.title,'让 agent 先核对 · evidence');
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.id===entry.id),true);
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.source_id===job.task_id),false,'a failed agent reply restores the original question, not an extra failure card');
    assert.ok(agentSnapshot().sessions.find(s=>s.id===job.session_id).messages.some(m=>m.role==='error' && /fake failure/.test(m.text)),'failure evidence stays available in the conversation');
  } finally {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();
    if(job){
      const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==job.task_id);write('work/queue.json',q);
      const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==job.session_id);write('.runtime/agent/sessions.json',s);
    }
  }
});

test('Claude Code limit events become remaining-percent windows without touching other quota keys',()=>{
  const file='.runtime/usage/quota.json',before=read(file,null);
  try {
    write(file,{codex:{marker:'keep'}});
    const saved=recordClaudeLimits({status:'allowed',unifiedWindows:{five_hour:{utilization:0.11,resetsAt:1791222600},seven_day:{utilization:0.02,resetsAt:1791414000}}});
    assert.deepEqual(saved.windows.map(w=>[w.label,w.remaining_percent]),[['5 小时窗口',89],['7 天窗口',98]]);
    assert.equal(saved.windows[0].resets_at,new Date(1791222600*1000).toISOString());
    assert.equal(read(file).codex.marker,'keep');
    assert.equal(recordClaudeLimits({status:'allowed'}),null);
    assert.equal(recordClaudeLimits({unifiedWindows:{five_hour:{utilization:'x'}}}),null);
  } finally { before ? write(file,before) : fs.rmSync(path.join(root,file),{force:true}); }
});

test('the account usage response (already in percent) maps to remaining windows and rejects changed fields',()=>{
  const file='.runtime/usage/quota.json',before=read(file,null);
  try {
    const saved=recordClaudeUsage({five_hour:{utilization:14,resets_at:'2026-10-05T17:50:00+00:00'},seven_day:{utilization:3.4,resets_at:'bad'},extra:1});
    assert.deepEqual(saved.windows.map(w=>[w.label,w.remaining_percent,w.resets_at]),[['5 小时窗口',86,'2026-10-05T17:50:00.000Z'],['7 天窗口',97,null]]);
    assert.equal(recordClaudeUsage({five_hour:{percent:14}}),null);assert.equal(recordClaudeUsage(null),null);
  } finally { before ? write(file,before) : fs.rmSync(path.join(root,file),{force:true}); }
});

test('the unattended mail judge makes one model call per packet, validates through Flow, and stops retrying a bad packet',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-judge-test-'));
  const flow=new Flow(dir,{account:'user@wisc.edu',timezone:'America/Chicago',initialLookbackHours:24,overlapMinutes:20,pageSize:20,maxPagesPerRun:6,maxBatchMessages:8,maxPacketBytes:6000});
  try {
    flow.ingest({id:'m1',subject:'Please confirm exam arrangements',receivedDateTime:'2026-10-04T21:26:48Z',sender:{emailAddress:{address:'p@wisc.edu'}},toRecipients:[{emailAddress:{address:'user@wisc.edu'}}],body:{content:'Please confirm tomorrow.'},isRead:false},'inbox');
    const packet=flow.packet(),on={automatic_mail_judgment:true,mail_screen_model:'luna-x',mail_screen_effort:'low',mail_judgment_model:'sol-x',mail_judgment_effort:'medium'},apply=file=>{const result=flow.apply(JSON.parse(fs.readFileSync(file,'utf8')));flow.packet();return result;};
    assert.deepEqual(await judgePending({directory:dir,config:{}}),{skipped:'off'});
    let calls=[];const bad=async(...args)=>{calls.push(args);return {result:'无法判断'};};
    const t0=Date.parse('2026-10-05T10:00:00Z'),at=min=>t0+min*60000;
    assert.match((await judgePending({directory:dir,config:on,invoke:bad,apply,now:at(0)})).error,/JSON/);
    assert.deepEqual(await judgePending({directory:dir,config:on,invoke:bad,apply,now:at(1)}),{skipped:'backoff'});
    assert.ok((await judgePending({directory:dir,config:on,invoke:bad,apply,now:at(6)})).error);
    assert.ok((await judgePending({directory:dir,config:on,invoke:bad,apply,now:at(12)})).error);
    assert.deepEqual(await judgePending({directory:dir,config:on,invoke:bad,apply,now:at(60)}),{skipped:'backoff'});
    assert.equal(calls.length,3);
    assert.equal(calls[0][0],'codex');assert.equal(calls[0][2].model,'luna-x');assert.equal(calls[0][2].effort,'low');assert.equal(calls[0][2].mode,'ask');assert.ok(!calls[0][1].includes(packet.packet_id));assert.ok(calls[0][2].signal);assert.equal(calls[0][2].maxOutputChars,16000);
    const nl=String.fromCharCode(10),fence=String.fromCharCode(96).repeat(3);
    const good=async()=>({result:fence+'json'+nl+JSON.stringify({packet_id:'batch',decisions:[{message_id:'m1',decision:'new',title:'确认补考',status:'todo',action:'核实时间和房间',check_at:null}]})+nl+fence});
    // The same packet is exhausted; removing the state file stands in for a changed packet, which gets a fresh budget.
    fs.rmSync(path.join(dir,'judge-state.json'));
    const done=await judgePending({directory:dir,config:on,invoke:good,apply,now:at(90)});
    assert.equal(done.applied,1);assert.equal(flow.tasks().length,1);assert.equal(flow.tasks()[0].status,'todo');
    assert.equal(taskHandler(dir,flow.tasks()[0].id),'screen');assert.equal(taskHandler(dir,'no-such-task'),null);
    assert.deepEqual(await judgePending({directory:dir,config:on,invoke:good,apply,now:at(100)}),{skipped:'none'});
    const log=fs.readFileSync(path.join(dir,'judge.log'),'utf8').trim().split(nl).map(l=>JSON.parse(l));
    assert.deepEqual(log.map(l=>l.attempts),[1,2,3,1]);assert.equal(log.at(-1).applied,1);assert.ok(log.slice(0,3).every(l=>l.error));
    assert.deepEqual(parseDecisions('前言 {"a":1} 后记'),{a:1});
  } finally { flow.close();fs.rmSync(dir,{recursive:true,force:true}); }
});

test('ordinary arrivals share a bounded batch without resetting its oldest arrival or losing mail',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-batch-test-'));
  const flow=new Flow(dir,{account:'user@wisc.edu',maxBatchMessages:8,maxPacketBytes:6000});
  t.after(()=>{flow.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^mail-batch-test-/);fs.rmSync(dir,{recursive:true,force:true});});
  const base=Date.parse('2026-10-12T18:00:00Z'),config={automatic_mail_judgment:true,mail_batch_wait_minutes:15,mail_batch_min_messages:4,mail_screen_model:'luna-x'};
  const add=(id,minutes)=>flow.ingest({id,subject:'General campus update '+id,receivedDateTime:new Date(base+minutes*60000).toISOString(),sender:{emailAddress:{address:'news@wisc.edu'}},body:{content:'General information about campus life.'}},'inbox');
  let calls=0;
  const invoke=async(_,prompt)=>{calls++;const p=JSON.parse(prompt.split('判断包：\n')[1]);return {result:JSON.stringify({packet_id:p.packet_id,decisions:p.messages.map(m=>({message_id:m.id,decision:'ignore'}))})};};
  const apply=file=>{const result=flow.apply(JSON.parse(fs.readFileSync(file,'utf8')));flow.packet();return result;};
  const judge=minutes=>judgePending({directory:dir,config,invoke,apply,now:base+minutes*60000});
  add('one',0);const first=flow.packet();assert.equal(first.messages[0].batchable,true);
  assert.deepEqual(await judge(1),{skipped:'batch',messages:1,until:new Date(base+15*60000).toISOString()});
  assert.equal(calls,0);assert.equal(fs.existsSync(path.join(dir,'judge-state.json')),false);assert.equal(flow.pending().length,1);
  add('two',5);const second=flow.packet();assert.notEqual(second.packet_id,first.packet_id);
  assert.equal((await judge(14)).until,new Date(base+15*60000).toISOString(),'new arrival must not restart the wait');
  assert.equal((await judge(15)).applied,2);assert.equal(calls,1);assert.equal(flow.pending().length,0);
  assert.deepEqual(await judge(16),{skipped:'none'});assert.equal(calls,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'judge.log'),'utf8')).messages,2);
});

test('batch fullness, urgent/unknown evidence, old mail and disabled batching all review immediately',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-batch-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^mail-batch-test-/);fs.rmSync(dir,{recursive:true,force:true});});
  const base=Date.parse('2026-10-12T18:00:00Z'),config={automatic_mail_judgment:true,mail_batch_wait_minutes:15,mail_batch_min_messages:4,mail_screen_model:'luna-x'};
  let calls=0;
  for(const [name,messages,cfg] of [
    ['full',Array.from({length:4},(_,n)=>({id:String(n),batchable:true,received:new Date(base).toISOString()})),config],
    ['urgent',[{id:'normal',batchable:true},{id:'urgent',batchable:false}],config],
    ['legacy',[{id:'missing-flag'}],config],
    ['invalid-time',[{id:'bad',batchable:true,received:'unknown'}],config],
    ['future-time',[{id:'future',batchable:true,received:new Date(base+60000).toISOString()}],config],
    ['old',[{id:'old',batchable:true,received:new Date(base-15*60000).toISOString()}],config],
    ['disabled',[{id:'off',batchable:true,received:new Date(base).toISOString()}],{...config,mail_batch_wait_minutes:0}]
  ]) {
    fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify({packet_id:name,messages,tasks:[]}));
    const before=calls;
    const result=await judgePending({directory:dir,config:cfg,now:base,invoke:async(_,prompt)=>{calls++;const p=JSON.parse(prompt.split('判断包：\n')[1]);return {result:JSON.stringify({packet_id:p.packet_id,decisions:p.messages.map(m=>({message_id:m.id,decision:'ignore'}))})};},apply:()=>({applied:messages.length})});
    assert.equal(result.applied,messages.length,name);assert.equal(calls,before+1,name);
  }
});

test('mail judging screens with the small model, sends task-related and escalated mail to the large one, and applies one merged result',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-tier-test-'));
  try {
    const msg=id=>({id,fingerprint:id,related_task_ids:id==='rel'?['t1']:[]});
    fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify({packet_id:'p2',messages:['spam','hard','rel'].map(msg),tasks:[{id:'t1'}]}));
    const calls=[];let applied;
    const invoke=async(provider,prompt,o)=>{
      const p=JSON.parse(prompt.split('判断包：\n')[1]);
      calls.push({purpose:o.purpose,provider,model:o.model,effort:o.effort,ids:p.messages.map(m=>m.id),screen:prompt.includes('第一道粗筛')});
      const out=o.model==='luna-x' ? [{message_id:'m1',decision:'ignore'},{message_id:'m2',decision:'escalate'}] : [{message_id:'m2',decision:'new',title:'T',status:'todo',action:'A',check_at:null},{message_id:'m3',decision:'ignore'}];
      return {result:JSON.stringify({packet_id:p.packet_id,decisions:out})};
    };
    const config={automatic_mail_judgment:true,mail_screen_model:'luna-x',mail_screen_effort:'low',mail_judgment_model:'sol-x',mail_judgment_effort:'medium'};
    const r=await judgePending({directory:dir,config,invoke,apply:file=>{applied=JSON.parse(fs.readFileSync(file,'utf8'));return {applied:applied.decisions.length};}});
    assert.equal(r.applied,3);
    assert.deepEqual(calls.map(c=>[c.provider,c.model,c.effort,c.screen,c.ids]),[['codex','luna-x','low',true,['m1','m2']],['codex','sol-x','medium',false,['m2','m3']]]);
    assert.deepEqual(calls.map(c=>c.purpose),['mail','mail'],'both mail tiers are recorded as mail judging');
    assert.deepEqual(applied.decisions.map(d=>d.message_id).sort(),['hard','rel','spam']);
    assert.deepEqual(Object.fromEntries(applied.decisions.map(d=>[d.message_id,d.handler])),{spam:'screen',hard:'judgment',rel:'judgment'});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'judge.log'),'utf8')).calls,2);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('the unattended loop stops at its daily cap and shows a failed packet instead of failing silently',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mail-cap-test-'));
  try {
    fs.writeFileSync(path.join(dir,'review-packet.json'),JSON.stringify({packet_id:'p1',messages:[{id:'m'}],tasks:[]}));
    let calls=0;const invoke=async()=>{calls++;return {result:'无法判断'};};
    assert.deepEqual(await judgePending({directory:dir,config:{automatic_mail_judgment:true,automation_daily_calls:0},invoke}),{skipped:'cap'});assert.equal(calls,0);
    const now=new Date('2026-10-05T18:00:00Z');
    assert.match((await judgePending({directory:dir,config:{automatic_mail_judgment:true,automation_daily_calls:999},invoke,now:+now})).error,/JSON/);
    const view=automationToday(now,{directory:dir});assert.match(view.issue,/第 1 次失败/);assert.ok(view.cap>=1);
    fs.writeFileSync(path.join(dir,'judge-state.json'),JSON.stringify({packet_id:'p1',attempts:3,at:+now,error:'坏'}));
    assert.match(automationToday(now,{directory:dir}).issue,/连续 3 次失败/);
    fs.rmSync(path.join(dir,'review-packet.json'));assert.equal(automationToday(now,{directory:dir}).issue,null);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('card normalisation retains complete text and limits options to three reply/accept buttons',()=>{
  const long='长'.repeat(900);
  const card=normalizeCard({category:'教学事务-待处理-很长很长很长',kind:'weird',title:long,message:long,actions:[
    {id:'a b!',type:'reply',label:'一',reply:long},{id:'x',type:'review',label:'打开'},{type:'accept',label:'确认'},{id:'c',type:'reply',label:'三'},{id:'d',type:'reply',label:'四'}]});
  assert.equal(card.kind,'decision');assert.equal(card.category,'教学事务-待处理-很长很长很长');assert.equal(card.title,long);assert.equal(card.message,long);
  assert.deepEqual(card.actions.map(a=>a.type),['reply','accept','reply']);assert.equal(card.actions[0].id,'ab');assert.equal(card.actions[0].reply,long);
  assert.equal(normalizeCard({message:'结论',actions:[]}),null);assert.equal(normalizeCard({actions:[{type:'reply',label:'x'}]}),null);assert.equal(normalizeCard('x'),null);
});

test('a card task runs as one tool-less turn on the chosen model with program-read evidence, and the program writes the card',async()=>{
  const id='validation-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  const note=path.join(os.tmpdir(),'card-note-'+randomUUID()+'.md');fs.writeFileSync(note,'DRAFTNOTE 草稿内容');
  const legacy=JSON.stringify({notes:'账号: me@example.org\n主题: S\n下一步: 核对证据XYZ',metadata:{comments:[]}});
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts,legacy) VALUES(?,?,?,?,'[]','[]',?,?)").run(id,'[validation] card','todo','verify',JSON.stringify([note]),legacy);
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),work=()=>read('work/queue.json').items;
  const entry=inboxItems(rows(),[],[]).find(i=>i.source_id===id);const jobs=[];
  const reply=json=>async(provider,prompt,opts)=>{runs.push({provider,prompt,opts});return {result:json,sessionId:'fake'};};const runs=[];
  try {
    const first=submit({title:'t1',text:'x',model:'sonnet',inbox_reply:{id:entry.id,fingerprint:entry.fingerprint,action_id:'agent-check',label:'l'}});jobs.push(first);
    assert.equal(work().find(i=>i.id===first.task_id).mode,'card');assert.equal(work().find(i=>i.id===first.task_id).model,'sonnet');
    const fence=String.fromCharCode(96).repeat(3),long='长'.repeat(900);
    await execute(first.task_id,reply(fence+'json\n'+JSON.stringify({category:'邮件',kind:'decision',title:'T',message:long,actions:[{id:'a',type:'reply',label:'甲',reply:'做甲'},{id:'b',type:'review',label:'丙'},{id:'c',type:'accept',label:'乙'},{id:'d',type:'reply',label:'丁'},{id:'e',type:'reply',label:'戊'}]})+'\n'+fence));
    const {prompt,opts}=runs[0];
    assert.equal(opts.mode,'ask');assert.equal(opts.model,'sonnet');assert.equal(opts.effort,undefined);assert.ok(prompt.length<2600);
    assert.match(prompt,/核对证据XYZ/);assert.match(prompt,/DRAFTNOTE/);assert.doesNotMatch(prompt,/me@example\.org|工作目录|Write/);
    const item=work().find(i=>i.id===first.task_id),card=read('.runtime/agent/runs/'+first.task_id+'/inbox.json');
    assert.equal(item.review.state,'pending');assert.equal(item.handoff,card.message);assert.equal(card.message,long);assert.deepEqual(card.actions.map(a=>a.type),['reply','accept','reply']);
    const shown=inboxItems(rows(),work(),[]).find(i=>i.source_id===first.task_id);assert.deepEqual(shown.actions.map(a=>a.label),['甲','乙','丁']);
    // A reply that is not a card keeps the plain handoff and writes no card file.
    const second=submit({title:'t2',text:'x',model:'sonnet',inbox_reply:{id:entry.id,fingerprint:entry.fingerprint,action_id:'agent-check',label:'l'}});jobs.push(second);
    await execute(second.task_id,reply('我无法判断，请补充信息。'));
    assert.equal(fs.existsSync(path.join(root,'.runtime/agent/runs',second.task_id,'inbox.json')),false);assert.equal(work().find(i=>i.id===second.task_id).handoff,'我无法判断，请补充信息。');
  } finally {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();fs.rmSync(note,{force:true});
    const q=read('work/queue.json');q.items=q.items.filter(i=>!jobs.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!jobs.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});

test('card judgment carries contextual defaults, assistant-owned lookup and authorization boundaries without changing mail facts',async()=>{
  const db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite')),jobs=[],ids=[];
  const cases=[
    {name:'contextual-yes',reply:'Yes, Oct 29 works for me.',oracle:'Accept the reply in the context of the 10-12 proposal; prepare a draft, do not ask the user to repeat the time or send without approval.'},
    {name:'real-conflict',reply:'I am not available at 10-12. I can only do 13-14.',oracle:'Keep the actual time conflict visible; do not treat 10-12 as accepted or promise a changed schedule.'},
    {name:'lookup-gap',reply:'Could you resend the scheduling poll link? I cannot find it.',oracle:'Have the assistant look up the original link and prepare a reply; do not ask the user to search first, invent a link, or send without approval.'},
  ];
  const directory=path.join(root,'.runtime/behavior-cases');fs.mkdirSync(directory,{recursive:true});
  try {
    for(const c of cases) {
      const id='validation-default-'+randomUUID();ids.push(id);
      const legacy=JSON.stringify({notes:'旧摘要：时段尚未确认，投票情况未知，需用户重新提供资料。'});
      db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts,legacy) VALUES(?,?,?,?,'[]','[]','[]',?)")
        .run(id,'[validation] 报告排期','todo','协调报告；尚未批准发送或更改时间。',legacy);
      const messages=[{folder:'sent',sender:'student@example.org',received:'2026-10-09T19:38:01Z',subject:'Schedule',
        text:'Would you be available on Oct 29 from 10 a.m. to 12 p.m.? The other participants have confirmed this time.'},
        {folder:'inbox',sender:'professor@example.org',received:'2026-10-09T22:22:16Z',subject:'Re: Schedule',text:c.reply}];
      messages.forEach((m,n)=>{const mid=id+'-'+n;
        db.prepare("INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,'judged','fixture',0)").run(mid,mid,JSON.stringify(m));
        db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run(mid,id);
      });
      const job=submit({title:'检查排期',text:'判断当前进展',inbox_reply:{id:'mail:'+id,fingerprint:'fixture',action_id:'agent-check',label:'让 agent 处理'}});jobs.push(job);
      let captured;
      await execute(job.task_id,async(_provider,prompt,opts)=>{
        captured=prompt;assert.equal(opts.mode,'ask');
        return {result:JSON.stringify({title:'检查',message:'测试占位，不是模型判断',actions:[{id:'next',type:'reply',label:'下一步',reply:'继续检查'}]})};
      });
      assert.ok(captured.includes(messages[0].text));assert.ok(captured.includes(c.reply));assert.match(captured,/旧摘要/);
      fs.writeFileSync(path.join(directory,c.name+'.json'),JSON.stringify({name:c.name,prompt:captured,oracle:c.oracle},null,2));
      assert.match(captured,/先判断助手能做什么/);
      assert.match(captured,/不能用继续检查代替交付/);
      assert.match(captured,/原信上下文/);assert.match(captured,/具体原文.*旧摘要/);
      assert.match(captured,/真正冲突/);assert.match(captured,/不能.*发送授权/);
    }
    assert.equal(ids.length,3);
  } finally {
    for(const id of ids){db.prepare('DELETE FROM sources WHERE task_id=?').run(id);db.prepare('DELETE FROM messages WHERE id LIKE ?').run(id+'-%');db.prepare('DELETE FROM tasks WHERE id=?').run(id);}db.close();
    const q=read('work/queue.json');q.items=q.items.filter(i=>!jobs.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!jobs.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});

test('a proposed project link is a one-click inbox card applied by the projects module, and aliases only ever propose',()=>{
  const file=path.join(root,'projects/catalog.json'),raw=fs.readFileSync(file);
  const a='validation-'+randomUUID(),b='validation-'+randomUUID(),c='validation-'+randomUUID();
  try {
    const catalog=read('projects/catalog.json');
    catalog.links.push({module:'mail',item_id:a,project_ids:['graphene-thz'],basis:'测试依据',status:'proposed'},{module:'mail',item_id:b,project_ids:['bi-devices'],basis:'测试依据',status:'proposed'});
    write('projects/catalog.json',catalog);
    const mail=[a,b].map(id=>({id,title:'[validation] '+id.slice(-4),status:'todo',action:'x'}));
    const cards=inboxItems(mail,[],read('projects/catalog.json').links).filter(i=>i.source==='link');
    assert.equal(cards.length,2);assert.deepEqual(cards[0].actions.map(x=>x.decision),['confirm','decline']);assert.equal(cards[0].category,'归属');assert.match(cards[0].detail,/测试依据/);
    resolveLink('mail',a,'confirm');resolveLink('mail',b,'decline');
    const links=read('projects/catalog.json').links;
    assert.equal(links.find(l=>l.item_id===a).status,'recorded');
    assert.deepEqual(links.find(l=>l.item_id===b),{module:'mail',item_id:b,project_ids:[],basis:'测试依据',status:'unassigned'});
    assert.equal(inboxItems(mail,[],links).filter(i=>i.source==='link').length,0);
    assert.throws(()=>resolveLink('mail',a,'confirm'),/没有待确认/);
    const added=proposeLinks([{id:c,title:'核对 ECE222 的请求',action:'看'},{id:'validation-none',title:'无关事项',action:'无'},{id:'validation-two',title:'ECE222 与 printed array',action:'x'},{id:a,title:'ECE222',action:'已有链接不再提议'}]);
    assert.equal(added.added,1);
    const proposed=read('projects/catalog.json').links.find(l=>l.item_id===c);
    assert.deepEqual([proposed.status,proposed.project_ids],['proposed',['teaching-ece222']]);
    assert.equal(proposeLinks([{id:c,title:'ECE222',action:''}]).added,0);
  } finally { fs.writeFileSync(file,raw); }
});


test("Codex's own context compaction becomes a session activity; other events do not",()=>{
  const started=compactionEvent({method:'item/started',params:{item:{type:'contextCompaction'}}}),done=compactionEvent({method:'item/completed',params:{item:{type:'contextCompaction'}}});
  assert.equal(started.type,'compact');assert.match(started.name,/正在压缩/);assert.match(done.name,/已压缩/);
  assert.equal(compactionEvent({method:'item/started',params:{item:{type:'commandExecution'}}}),null);
  assert.equal(compactionEvent({method:'turn/completed',params:{}}),null);
});

test('a CAD request runs Codex in the folder that holds that tool, several tools use Fusion as home, and a missing folder falls back to the root',()=>{
  const apps=[{id:'autocad',working_directory:'D:/cad-ai'},{id:'fusion',working_directory:'D:/fusion-ai'},{id:'altium',working_directory:'D:/Altium-ai'}];
  const all=()=>true,none=()=>false,roots=l=>l.overrides.find(o=>o.startsWith('sandbox_workspace_write.writable_roots='));
  const plain=codexLaunch('聊聊分工',{apps,exists:all});
  assert.equal(plain.cwd,root);assert.ok(!plain.overrides.some(o=>/autocad|altium|fusion/.test(o)));
  const cad=codexLaunch('用 AutoCAD 画一个矩形',{apps,exists:all});
  assert.equal(cad.cwd,'D:/cad-ai');assert.ok(roots(cad));assert.ok(!cad.overrides.some(o=>o.includes('autocad-mcp.enabled')));
  const multi=codexLaunch('把 AutoCAD 图导入 Fusion',{apps,exists:all});
  assert.equal(multi.cwd,'D:/fusion-ai');assert.ok(multi.overrides.includes('mcp_servers.autocad-mcp.enabled=true'));assert.ok(!multi.overrides.includes('mcp_servers.fusion.enabled=true'));
  assert.match(roots(multi),/D:\/cad-ai/);
  const missing=codexLaunch('用 AutoCAD 画图',{apps,exists:none});
  assert.equal(missing.cwd,root);assert.ok(missing.overrides.includes('mcp_servers.autocad-mcp.enabled=true'));
  // An always-off switch for a tool would override that folder's own enabled=true, so none may be passed.
  assert.ok(![plain,cad,multi,missing].some(l=>l.overrides.some(o=>/^mcp_servers\.(autocad-mcp|fusion|altium)\.enabled=false$/.test(o))));
});

test('user-approved networking applies only to interactive Codex work and preserves other launch settings',()=>{
  const network='sandbox_workspace_write.network_access=true';
  const apps=[{id:'fusion',working_directory:'D:/fusion-ai'}];
  for(const request of ['ordinary work','Fusion']) {
    const launch=codexLaunch(request,{apps,exists:()=>true});
    assert.equal(launch.overrides.filter(o=>o===network).length,1);
    assert.ok(!launch.overrides.some(o=>/danger-full-access|approval_policy|approvals_reviewer/.test(o)));
  }
  assert.ok(!codexLaunch('parse mail',{mode:'ask'}).overrides.some(o=>o.includes('network_access')));
  assert.ok(!codexLaunch('background task',{mode:'work',purpose:'auto'}).overrides.some(o=>o.includes('network_access')));
  assert.ok(!codexLaunch('unknown task',{mode:'work',purpose:'other'}).overrides.some(o=>o.includes('network_access')));
  assert.ok(codexLaunch('interactive card follow-up',{mode:'work',purpose:'card'}).overrides.includes(network));
});

test('desktop MCP is shared by work agents, never by parsed asks, and exposes only GUI tools',()=>{
  const config=read('software/computer-use/mcp.json'),computer=config.mcpServers['windows-mcp'];
  assert.deepEqual(Object.keys(config.mcpServers),['windows-mcp']);
  assert.equal(computer.env.ANONYMIZED_TELEMETRY,'false');
  const allowed=computer.args[computer.args.indexOf('--tools')+1].split(',');
  assert.ok(['Snapshot','Screenshot','Click','Type','Shortcut'].every(t=>allowed.includes(t)));
  assert.ok(!['PowerShell','Registry','Process','FileSystem','Scrape'].some(t=>allowed.includes(t)));
  assert.equal(computer.args[computer.args.indexOf('--transport')+1],'stdio');
  const work=codexLaunch('普通工作'),ask=codexLaunch('只判断邮件',{mode:'ask'});
  assert.ok(work.overrides.includes('mcp_servers.windows-mcp.enabled=true'));
  assert.ok(work.overrides.includes(`mcp_servers.windows-mcp.command=${JSON.stringify(computer.command)}`));
  assert.ok(work.overrides.includes(`mcp_servers.windows-mcp.args=${JSON.stringify(computer.args)}`));
  assert.ok(ask.overrides.includes('mcp_servers.windows-mcp.enabled=false'));
  assert.ok(ask.overrides.includes(`mcp_servers.windows-mcp.command=${JSON.stringify(computer.command)}`),'disabled servers still need a valid transport');
  assert.ok(ask.overrides.includes(`mcp_servers.windows-mcp.args=${JSON.stringify(computer.args)}`));
  assert.ok(!ask.overrides.some(o=>o.includes('node_repl')),'obsolete MCP entries must not be manufactured');
  const claudeWork=claudeArgs('sonnet'),claudeAsk=claudeArgs('haiku',{mode:'ask'});
  assert.equal(claudeWork[claudeWork.indexOf('--mcp-config')+1],path.join(root,'software/computer-use/mcp.json'));
  assert.ok(!claudeAsk.includes('--mcp-config'));
});

test('installed Codex accepts the actual ask launch configuration before any model turn',async()=>{
  if(process.platform!=='win32')return;
  const launch=codexLaunch('只判断邮件',{mode:'ask'});
  const bin=path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js');
  const child=spawn(process.execPath,[bin,'app-server','--listen','stdio://',...launch.overrides.flatMap(o=>['-c',o])],{
    cwd:launch.cwd,windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  // Startup only: no thread/start, turn/start, desktop call or real mailbox access.
  child.stderr.resume();child.stdin.on('error',()=>{});
  const lines=createInterface({input:child.stdout});
  try {
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Codex initialization timed out')),15000);
      const finish=(error,result)=>{clearTimeout(timer);error ? reject(error) : resolve(result);};
      child.once('error',error=>finish(error));
      child.once('exit',code=>finish(new Error(`Codex exited before initialization (${code})`)));
      lines.on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return;}if(msg.id===1)finish(msg.error ? new Error('Codex initialization rejected') : null,msg.result);});
      // Keep stdin open until the acknowledgment; EOF can stop the server before it processes the request.
      child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'mail-startup-test',version:'1'}}})+'\n');
    });
    assert.ok(response?.userAgent);
  } finally {
    stopProcess(child);lines.close();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
});

test('a handoff block preserves its text and sources and stays apart from the readable reply',()=>{
  const long='长'.repeat(400);
  const block=JSON.stringify({summary:long,facts:[{text:'事实一',source:'a.csv'},{text:'',source:'无文字'},{text:long,source:long}],open:['问题一','','问题二','问题三','问题四'],next:long,extra:'丢弃'});
  const parsed=parseHandoff('已整理完成。\n交接：'+block);
  assert.equal(parsed.text,'已整理完成。');
  assert.equal(parsed.brief.summary,long);assert.equal(parsed.brief.facts.length,2);assert.equal(parsed.brief.facts[1].text,long);assert.equal(parsed.brief.facts[1].source,long);
  assert.deepEqual(parsed.brief.open,['问题一','问题二','问题三','问题四']);assert.equal(parsed.brief.next,long);assert.equal('extra' in parsed.brief,false);
  assert.deepEqual(parseHandoff('没有块'),{text:'没有块',brief:null});
  assert.deepEqual(parseHandoff('结果\n交接：不是 JSON'),{text:'结果\n交接：不是 JSON',brief:null});
  assert.equal(parseHandoff('结果\n交接：{"summary":"","facts":[],"open":[],"next":""}').brief,null);
});

test('a project status entry leads to a task handoff with a complete openable source',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const relative='workspace/projects/bi-devices/analysis/'+ 'long-source-'.repeat(8) + 'verified.json';
  const file=path.join(root,relative),statusFile=path.join(root,'workspace/projects/bi-devices/STATUS.md');
  const statusBefore=fs.existsSync(statusFile) ? fs.readFileSync(statusFile) : null;
  try {
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{"verified":true}\n');
    assert.ok(relative.length>120);
    const job=submit({text:'@Codex [validation] deliver the existing result',project_id:'bi-devices'});
    await execute(job.task_id,async()=>({result:'Result ready.\n交接：'+JSON.stringify({summary:'已交付',facts:[{text:'结果已核对',source:relative}],open:[],next:''})}));
    const stored=read('work/queue.json').items.find(i=>i.id===job.task_id).brief.facts[0].source;
    assert.equal(stored,relative);assert.equal(JSON.parse(fs.readFileSync(path.resolve(root,stored),'utf8')).verified,true);
    assert.ok(fs.readFileSync(statusFile,'utf8').includes(job.task_id.slice(0,8)),'the project status page points to the completed task');
    const handoff=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work','handoff',job.task_id],{cwd:root,encoding:'utf8'}));
    assert.equal(handoff.brief.facts[0].source,relative,'the actual work handoff command preserves the full source');
  } finally {
    fs.rmSync(file,{force:true});write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);
    if(statusBefore)fs.writeFileSync(statusFile,statusBefore);else fs.rmSync(statusFile,{force:true});
  }
});

test('a new completion without a question clears an old pending decision, but explicit questions remain',async()=>{
  const saved={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  try {
    const job=submit({text:'@Codex [validation] finish registered work'});
    update({id:job.task_id,status:'waiting_user',handoff:'Earlier delivery was not registered.',review:{kind:'decision',state:'pending'}});
    update({id:job.task_id,status:'queued'});
    await execute(job.task_id,async()=>({result:'The work is finished; nothing to decide.'}));
    const item=read('work/queue.json').items.find(i=>i.id===job.task_id);
    assert.equal(item.status,'done');assert.notEqual(item.review?.state,'pending');
    assert.equal(inboxItems([],read('work/queue.json').items,[]).some(c=>c.source_id===job.task_id),false);
    const asked=submit({text:'@Codex [validation] finish with an actual question'});
    update({id:asked.task_id,review:{kind:'decision',state:'pending'}});
    await execute(asked.task_id,async()=>{
      write(`.runtime/agent/runs/${asked.task_id}/inbox.json`,{kind:'decision',message:'Which input should be used?',actions:[{id:'a',type:'reply',label:'A',reply:'Use A'}]});
      return {result:'A specific decision is needed.'};
    });
    assert.equal(read('work/queue.json').items.find(i=>i.id===asked.task_id).review.state,'pending');
  } finally {write('work/queue.json',saved.queue);write('.runtime/agent/sessions.json',saved.sessions);}
});

test('a finished task keeps its structured handoff, and the project status page carries it to the next task',async()=>{
  const project=read('projects/catalog.json').projects.find(p=>p.id==='bi-devices'),file=path.join(root,'workspace/projects/bi-devices/STATUS.md');
  const existed=fs.existsSync(file);let job;
  try {
    renderStatus('bi-devices');
    job=submit({text:'[validation] 整理 Bi 数据',project_id:'bi-devices'});const runs=[];
    const brief={summary:'已整理 3 组数据',facts:[{text:'3 组均有单位',source:'data/a.csv'}],open:['第 3 组温度缺失'],next:'补测第 3 组'};
    await execute(job.task_id,async(provider,prompt,opts)=>{runs.push(prompt);return {result:'整理完成。\n交接：'+JSON.stringify(brief),sessionId:'fake'};});
    assert.match(runs[0],/当前项目：/);
    assert.match(runs[0],/projects context bi-devices/);assert.ok(!runs[0].includes(project.name+' · 状态'),'state page stays on demand');
    const item=read('work/queue.json').items.find(i=>i.id===job.task_id);
    assert.equal(item.handoff,'整理完成。');assert.deepEqual(item.brief,brief);
    const page=fs.readFileSync(file,'utf8');
    assert.match(page,/已整理 3 组数据/);assert.match(page,/下一步：补测第 3 组/);assert.match(page,/未决：第 3 组温度缺失/);
    // A fresh task can read the handoff via the state page, without preloading it into unrelated requests.
    const second=submit({text:'[validation] 继续',project_id:'bi-devices'});jobs2.push(second);
    await execute(second.task_id,async(provider,prompt)=>{
      runs.push(prompt);assert.doesNotMatch(prompt,/已整理 3 组数据/);
      const context=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','projects','context','bi-devices'],{cwd:root,encoding:'utf8'}));
      assert.ok(JSON.stringify(context).includes('已整理 3 组数据'),'the current handoff remains accessible');
      return {result:'好',sessionId:'fake'};
    });
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!jobs2.concat(job ? [job] : []).some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!jobs2.concat(job ? [job] : []).some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
    if(existed)renderStatus('bi-devices');else fs.rmSync(file,{force:true});
  }
});
const jobs2=[];

test('project conversations start with resource entry points and can fetch complete research evidence on demand',async()=>{
  const file=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md');
  assert.ok(fs.existsSync(file),'fixture: graphene-thz has a FRAMEWORK.md');
  const job=submit({text:'[validation] 这个项目的样品为什么不稳定',project_id:'graphene-thz'}),runs=[];
  try {
    await execute(job.task_id,async(provider,prompt)=>{runs.push(prompt);return {result:'好',sessionId:'fake'};});
    const prompt=runs[0];
    assert.match(prompt,/projects outline graphene-thz/);
    assert.match(prompt,/projects search "graphene-thz#关键词"/);
    assert.doesNotMatch(prompt,/文件目录 .*workspace[\\/]projects/,'storage paths are not the default research entry point');
    assert.doesNotMatch(prompt,/graphene-l-material|graphene-m-ink|历史日志完整索引|graphene-m-press-test/);
    const outline=execFileSync(process.execPath,['automation/run.mjs','projects','outline','graphene-thz'],{cwd:root,encoding:'utf8'});
    assert.match(outline,/graphene-l-material 印刷材料与工艺/);assert.match(outline,/graphene-m-ink 全印刷单元与工艺排障/);
    assert.match(outline,/历史日志完整索引（\d+ 条/);assert.match(outline,/graphene-m-press-test/);
    assert.match(outline,/节点摘要：方案：同一块样品压前测两遍/);
    const evidence=JSON.parse(execFileSync(process.execPath,['automation/run.mjs','projects','read-nodes','graphene-thz#graphene-m-press-test'],{cwd:root,encoding:'utf8'}));
    assert.match(evidence.nodes[0].text,/同一套键合线/,'the advertised CLI reaches the complete selected evidence');
    assert.match(prompt,/read-nodes graphene-thz#/);
    assert.ok(!prompt.includes(fs.readFileSync(file,'utf8')),'historical bodies remain explicit source reads');
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==job.task_id);write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==job.session_id);write('.runtime/agent/sessions.json',s);
  }
});

test('a meeting request in a FRAMEWORK project does not preload research or the status page',async()=>{
  const status=path.join(root,'workspace/projects/graphene-thz/STATUS.md'),saved=fs.existsSync(status)?fs.readFileSync(status):null;
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json'),cfg=read('agent/config.json');
  try {
    write('agent/config.json',{...cfg,memory_v2:{enabled:false}});
    fs.writeFileSync(status,'UNRELATED_RESEARCH_EXECUTION_WITNESS');
    const job=submit({text:'[validation] 这封普通会议邀请只需帮我核对时间。',project_id:'graphene-thz'});
    await execute(job.task_id,async(_,prompt)=>{
      assert.match(prompt,/当前项目：/);assert.match(prompt,/projects outline graphene-thz/);
      assert.doesNotMatch(prompt,/历史日志完整索引|节点摘要：|graphene-m-press-test|执行事项摘录|UNRELATED_RESEARCH_EXECUTION_WITNESS/);
      const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'meeting-project-context.json'),JSON.stringify({prompt_chars:prompt.length,research_not_preloaded:true,status_not_preloaded:true,project_entry_preserved:true}));
      return {result:'No model called; prompt assembly observed.'};
    });
  } finally {
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);write('agent/config.json',cfg);
    if(saved)fs.writeFileSync(status,saved);else fs.rmSync(status,{force:true});
  }
});

test('the project status page is short, honest about placeholders, and unchanged when the facts are unchanged',()=>{
  const catalog=read('projects/catalog.json'),fixture=structuredClone(catalog);
  fixture.projects.find(p=>p.id==='bi-devices').plan_is_example=true;
  write('projects/catalog.json',fixture);
  const file=path.join(root,'workspace/projects/bi-devices/STATUS.md'),existed=fs.existsSync(file);
  const item=enqueue({title:'[validation] 状态页',kind:'data',project_ids:['bi-devices']});
  try {
    update({id:item.id,status:'done',handoff:'结果文字',brief:{summary:'汇总一句',facts:[],open:[],next:'下一步一句'}});
    assert.equal(renderStatus('bi-devices'),true);
    const page=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(page,/未填写/);assert.match(page,/示意内容，不能当作真实进展/);assert.match(page,/汇总一句/);assert.ok(page.length<1800);assert.doesNotMatch(page,/20\d\d-\d\d-\d\dT/);
    assert.equal(renderStatus('bi-devices'),false);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==item.id);write('work/queue.json',q);
    write('projects/catalog.json',catalog);
    if(existed)renderStatus('bi-devices');else fs.rmSync(file,{force:true});
  }
});

test('card work is kept out of project status, older card tasks are marked once, and raw JSON never becomes a summary',()=>{
  const file=path.join(root,'workspace/projects/bi-devices/STATUS.md'),existed=fs.existsSync(file);
  const real=enqueue({title:'[validation] 真实工作',kind:'data',project_ids:['bi-devices']});
  const cardTask=enqueue({title:'[validation] 让 agent 处理 · 卡片后台任务',kind:'data',project_ids:['bi-devices']});
  const rawJson=enqueue({title:'[validation] 旧格式',kind:'data',project_ids:['bi-devices']});
  const sessionId=randomUUID(),sessions=read('.runtime/agent/sessions.json');
  try {
    update({id:real.id,status:'done',handoff:'真实结果',brief:{summary:'真实汇总',facts:[],open:[],next:''}});
    update({id:cardTask.id,status:'done',handoff:'卡片任务结果'});
    update({id:rawJson.id,status:'done',handoff:'`'.repeat(3)+'json\n'+JSON.stringify({message:'卡片里的结论',actions:[]})+'\n'+'`'.repeat(3)});
    sessions.sessions.push({id:sessionId,title:'t',project_ids:['bi-devices'],messages:[{role:'user',text:'x',task_id:cardTask.id,inbox_reply:{id:'mail:x',fingerprint:'f',action_id:'agent-check',label:'l'}}],task_ids:[cardTask.id]});
    write('.runtime/agent/sessions.json',sessions);
    assert.ok(markCardTasks()>=1);assert.equal(markCardTasks(),0);
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(x=>x.id===sessionId).origin,'task','older card sessions are stamped as task sessions once');
    assert.equal(read('work/queue.json').items.find(i=>i.id===cardTask.id).mode,'card');assert.equal(read('work/queue.json').items.find(i=>i.id===real.id).mode,undefined);
    renderStatus('bi-devices');const page=fs.readFileSync(file,'utf8');
    assert.match(page,/真实汇总/);assert.doesNotMatch(page,/卡片任务结果|卡片后台任务/);assert.match(page,/卡片里的结论/);assert.doesNotMatch(page,/"actions"|```/);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>![real.id,cardTask.id,rawJson.id].includes(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==sessionId);write('.runtime/agent/sessions.json',s);
    if(existed)renderStatus('bi-devices');else fs.rmSync(file,{force:true});
  }
});
test('session origin is fixed at creation: an ordinary chat stays a chat when its task later changes, and old sessions are stamped from creation-time evidence',()=>{
  const queue0=read('work/queue.json'),ids=[];
  const ordinary=submit({text:'@Codex [validation] 普通对话'});
  const legacy=(messages,taskId)=>{const id=randomUUID();ids.push(id);const s=read('.runtime/agent/sessions.json');s.sessions.push({id,title:'t',project_ids:[],messages,task_ids:[taskId]});write('.runtime/agent/sessions.json',s);return id;};
  try {
    const origin=id=>read('.runtime/agent/sessions.json').sessions.find(x=>x.id===id).origin;
    assert.equal(origin(ordinary.session_id),'chat','a new ordinary session records its origin explicitly');
    update({id:ordinary.task_id,require_outputs:true});
    const plainOld=enqueue({title:'[validation] 旧普通',kind:'data',project_ids:['bi-devices']}),autoOld=enqueue({title:'[validation] 旧自动',kind:'data',project_ids:['bi-devices']});
    update({id:plainOld.id,status:'queued'});
    const plain=legacy([{role:'user',text:'随便聊聊',task_id:plainOld.id}],plainOld.id);
    const auto=legacy([{role:'user',text:'@Claude 执行已获授权的项目步骤：测量\n目标',task_id:autoOld.id}],autoOld.id);
    const card=legacy([{role:'user',text:'x',inbox_reply:{id:'mail:x',fingerprint:'f',action_id:'agent-check',label:'l'}}],plainOld.id);
    markCardTasks();
    assert.equal(origin(ordinary.session_id),'chat','changing the task afterwards does not turn an ordinary chat into a task session');
    assert.equal(origin(plain),'chat','an old plain session is not reclassified by its task\'s current state');
    assert.equal(origin(auto),'task','an old auto-started session is recognised by its creation-time prompt');
    assert.equal(origin(card),'task');
    assert.equal(markCardTasks(),0,'stamping happens once');
  } finally {
    const keep=new Set(queue0.items.map(i=>i.id)),q=read('work/queue.json');q.items=q.items.filter(i=>keep.has(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(x=>x.id!==ordinary.session_id && !ids.includes(x.id));write('.runtime/agent/sessions.json',s);
  }
});

test('every model call is recorded with what it was for; a card conversation stays a card, and a session made for a task is an automatic step',async()=>{
  const made=[],seen=[],run=async(provider,prompt,opts)=>{seen.push(opts.purpose);return {result:'好的',sessionId:'fake'};};
  const sessions=()=>read('.runtime/agent/sessions.json').sessions;
  try {
    const chat=submit({text:'@Codex [validation] 普通聊天'});made.push(chat);
    await execute(chat.task_id,run);
    // a card judgement asked by the card's own button, then a button reply and a free follow-up in the same conversation
    const asked=submit({text:'@Codex [validation] 判断这张卡',inbox_reply:{id:'mail:x',fingerprint:'f',action_id:'agent-check',label:'l'}});made.push(asked);
    await execute(asked.task_id,run);
    const reply=submit({text:'@Codex 继续',session_id:asked.session_id,inbox_reply:{id:'work:'+asked.task_id,fingerprint:'g',action_id:'units',label:'l'}});made.push(reply);
    await execute(reply.task_id,run);
    const talk=submit({text:'@Codex 再问一句',session_id:asked.session_id});made.push(talk);
    await execute(talk.task_id,run);
    // a button reply inside an ordinary chat is still about a card
    const inChat=submit({text:'@Codex 按钮',session_id:chat.session_id,inbox_reply:{id:'work:'+chat.task_id,fingerprint:'h',action_id:'units',label:'l'}});made.push(inChat);
    await execute(inChat.task_id,run);
    assert.deepEqual(seen,['chat','card','card','card','card']);
    // an automatic step is told by the session's recorded origin, not by the task's current state
    const item=read('work/queue.json').items.find(i=>i.id===chat.task_id);
    assert.equal(purposeOf({...item,status:'queued'},{origin:'chat',messages:[{role:'user',task_id:item.id}]}),'chat');
    assert.equal(purposeOf({...item,status:'open'},{origin:'task',messages:[{role:'user',task_id:item.id,text:'@Claude 执行已获授权的项目步骤：x'}]}),'auto');
  } finally {
    const ids=new Set(made.map(m=>m.task_id)),q=read('work/queue.json');q.items=q.items.filter(i=>!ids.has(i.id));write('work/queue.json',q);
    const sids=new Set(made.map(m=>m.session_id)),st=read('.runtime/agent/sessions.json');st.sessions=st.sessions.filter(x=>!sids.has(x.id));write('.runtime/agent/sessions.json',st);
  }
});
test('the weekly view splits that week\'s calls by purpose: old records are told apart only by id prefix, and the parts add up',()=>{
  const file=path.join(root,'.runtime/usage/runs.jsonl'),before=fs.existsSync(file) ? fs.readFileSync(file) : null;
  const day='2026-10-08T15:00:00Z';
  try {
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');
    for(const r of [
      {id:'mail-judge-a-1-screen',provider:'codex',feature:'agent',status:'completed',input_tokens:1000,cached_input_tokens:900,output_tokens:100},
      {id:'u1',provider:'claude',feature:'agent',purpose:'card',status:'completed',input_tokens:3000,cached_input_tokens:1000,output_tokens:200},
      {id:'u2',provider:'claude',feature:'agent',purpose:'card',status:'failed',input_tokens:1000,cached_input_tokens:0,output_tokens:0},
      {id:'u3',provider:'claude',feature:'agent',status:'completed',input_tokens:500,cached_input_tokens:0,output_tokens:50},
      {id:'p',provider:'claude',feature:'quota-probe',status:'completed',input_tokens:10,cached_input_tokens:0,output_tokens:5},
      {id:'u4',provider:'codex',feature:'agent',purpose:'chat',status:'completed',usage_known:false}])recordRun({at:day,...r});
    const view=weekView('2026-10-05',new Date('2026-10-12T14:00:00Z')),rows=view.facts.purpose_usage;
    const by=Object.fromEntries(rows.map(u=>[u.purpose,u]));
    assert.deepEqual(Object.keys(by).sort(),['card','chat','mail','quota-probe','unlabeled']);
    assert.equal(by.mail.calls,1);assert.equal(by.mail.cached_input_tokens,900);assert.equal(by.card.calls,2);assert.equal(by.card.failed,1);
    assert.equal(by.card.billed_tokens,(3000-1000)+200+1000,'billed = input minus cache hits, plus output');
    assert.equal(by.chat.unknown,1);assert.equal(by.chat.billed_tokens,0,'a call with no usage is not counted as zero tokens');
    assert.equal(rows.reduce((n,u)=>n+u.calls,0),view.office.calls);
    assert.equal(by.card.billed_tokens+by.mail.billed_tokens+by.unlabeled.billed_tokens+by['quota-probe'].billed_tokens+by.chat.billed_tokens,rows.reduce((n,u)=>n+u.billed_tokens,0));
    assert.equal(by.card.input_tokens,4000);assert.equal(by.card.cached_input_tokens,1000,'card: cache hits 1000 of 4000 input');
    assert.equal(by.mail.billed_tokens,200,'mail: 1000 input minus 900 cached, plus 100 output');
    assert.equal(weekView('2026-10-12',new Date('2026-10-12T14:00:00Z')).office.calls,0,'calls are counted in the week they happened');
  } finally { before ? fs.writeFileSync(file,before) : fs.rmSync(file,{force:true}); }
});

test('bare mail cards are prepared at most once per card version, within a limit, and never while work is running',()=>{
  const tried='.runtime/inbox/auto-prepared-test-'+randomUUID()+'.json';
  const card=(id,fp)=>({id,fingerprint:fp,source:'mail',actions:[{id:'agent-check'},{id:'accept'}]});
  const inbox=[card('mail:a','1'),card('mail:b','1'),card('mail:c','1'),{id:'work:x',fingerprint:'1',source:'work',actions:[{id:'accept'}]},{id:'mail:d',fingerprint:'1',source:'mail',actions:[{id:'reply-x'}]}];
  try {
    assert.deepEqual(pickBareCards(inbox,{triedFile:tried,busy:true}),[]);
    assert.deepEqual(pickBareCards(inbox,{triedFile:tried,limit:2}).map(c=>c.id),['mail:a','mail:b']);
    assert.deepEqual(pickBareCards(inbox,{triedFile:tried,limit:2}).map(c=>c.id),['mail:c']);
    assert.deepEqual(pickBareCards(inbox,{triedFile:tried}),[]);
    assert.deepEqual(pickBareCards([card('mail:a','2')],{triedFile:tried}).map(c=>c.id),['mail:a']);
  } finally { fs.rmSync(path.join(root,tried),{force:true}); }
});

test('changed evidence and an expired window cannot be undone over newer work',()=>{
  const mail={id:randomUUID(),title:'original',status:'todo',action:'verify'};
  const entry=inboxItems([mail],[],[])[0];acknowledgeInbox(entry);
  assert.throws(()=>undoAcknowledgment(entry.id,[mail],[],[],new Date(Date.now()+6*60000)),/窗口/);
  assert.throws(()=>undoAcknowledgment(entry.id,[{...mail,action:'new evidence'}],[],[]),/已更新/);
  undoAcknowledgment(entry.id,[mail],[],[]);
});

test('changing the current project node does not invent completed work',()=>{
  const catalog=read('projects/catalog.json'),before=read('work/queue.json');
  try {
    const fixture=structuredClone(catalog);
    fixture.projects.find(p=>p.id==='graphene-thz').plan=[{id:'array-printing',title:'fixture stage'}];
    write('projects/catalog.json',fixture);
    focusProject('graphene-thz','array-printing');
    assert.equal(read('projects/catalog.json').projects.find(p=>p.id==='graphene-thz').active_node_id,'array-printing');
    assert.deepEqual(read('work/queue.json'),before);
    assert.throws(()=>focusProject('graphene-thz','unknown-node'),/未找到/);
  }finally{write('projects/catalog.json',catalog);}
});

test('office review uses real work records and excludes illustrative project progress',()=>{
  const queue=read('work/queue.json');
  try {
    write('work/queue.json',{...queue,items:[
      {id:'done-fixture',title:'real output',status:'done',project_ids:[],handoff:'actual record',outputs:['out.csv'],completed_at:'2026-10-05T15:00:00Z'},
      {id:'review-fixture',title:'acceptance',status:'done',project_ids:[],handoff:'await review',outputs:[],completed_at:'2026-10-05T16:00:00Z',review:{kind:'acceptance',state:'pending'}},
      {id:'decision-fixture',title:'decision',status:'waiting_user',project_ids:[],goal:'judge',review:{kind:'decision',state:'pending'}},
      {id:'failed-fixture',title:'failure',status:'failed',project_ids:[],goal:'fix',updated_at:'2026-10-05T17:00:00Z'}]});
    const view=weekView('2026-10-05',new Date('2026-10-12T14:00:00Z'));
    assert.equal(view.office.delivered,2);assert.equal(view.current.awaiting_acceptance,1);
    assert.equal(view.office.unsuccessful,1);assert.equal(view.facts.completed.length,1);assert.equal(view.facts.handled,0);
    assert.deepEqual(view.current.blocked.map(i=>i.id).sort(),['decision-fixture','failed-fixture','review-fixture'],'what is stuck is stated as of now, not as of that week');
    assert.equal('hours_saved' in view.office,false);
  }finally{write('work/queue.json',queue);}
});

test('AI chooses card category and button labels; a human choice becomes a bounded follow-up',async()=>{
  const job=submit({text:'@Codex [validation] choose next step',project_id:'bi-devices'});
  const card={category:'数据',kind:'decision',title:'先检查哪一项？',message:'请选择下一步',actions:[
    {id:'units',type:'reply',label:'先检查单位',reply:'先检查输入单位'},
    {id:'source',type:'review',label:'打开原始记录'}]};
  const next=()=>read('work/queue.json').items;
  let followup;
  try {
    await execute(job.task_id,async()=>{write(`.runtime/agent/runs/${job.task_id}/inbox.json`,card);return {result:'请选择下一步。',sessionId:'fake'};});
    const item=inboxItems([],next(),[]).find(i=>i.source_id===job.task_id);
    assert.equal(item.category,'数据');assert.equal(item.title,'先检查哪一项？');
    assert.deepEqual(item.actions.map(a=>a.label),['先检查单位','打开原始记录']);
    followup=submit({text:'@Codex 先检查输入单位',session_id:job.session_id,inbox_reply:{id:item.id,fingerprint:item.fingerprint,action_id:'units'}});
    assert.equal(inboxItems([],next(),[]).some(i=>i.id===item.id),false);
    update({id:followup.task_id,status:'cancelled',handoff:'fixture cancellation'});
    assert.equal(inboxItems([],next(),[]).some(i=>i.id===item.id),true);
  }finally{
    const q=read('work/queue.json');q.items=q.items.filter(i=>![job.task_id,followup?.task_id].includes(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==job.session_id);write('.runtime/agent/sessions.json',s);
  }
});
test('the default prompt gives identity, conversation and project navigation without pasting whole reference documents',async()=>{
  const made=[];
  try {
    const plain=submit({text:'@Claude [validation] 你好'});made.push(plain);
    const withProject=submit({text:'@Claude [validation] 项目怎么样',project_id:'bi-devices'});made.push(withProject);
    const seen=[];const runner=async(provider,prompt,opts)=>{seen.push({prompt,opts});return {result:'好',sessionId:'fake'};};
    await execute(plain.task_id,runner);await execute(withProject.task_id,runner);
    assert.match(seen[0].prompt,/你们是来帮我上班的搭档/);assert.match(seen[0].prompt,/博士生/);
    assert.doesNotMatch(seen[0].prompt,/当前项目|weekly_targets|active_work|"projects"/);
    assert.match(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),/help <模块>/);
    assert.match(seen[1].prompt,/当前项目：Bi 薄膜及器件工艺（bi-devices）/);
    assert.match(seen[0].prompt,/今天是 \d{4}-\d{2}-\d{2} 星期.（America\/Chicago）/);assert.doesNotMatch(seen[0].prompt,/Bi 薄膜及器件工艺/);assert.doesNotMatch(seen[0].prompt,/规矩|交接：\{|inbox\.json/);assert.doesNotMatch(seen[0].prompt,/不发送邮件|不下订单|用中文简洁回答|不联络/);assert.match(seen[0].prompt,/PROFILE\.md/);
    for(const file of ['AGENTS.md','projects/FRAMEWORK-RULES.md','mail-flow/INTERACTIVE-GUIDE.md'])
      for(const {prompt} of seen)assert.ok(!prompt.includes(fs.readFileSync(path.join(root,file),'utf8').trim()),file+' is referenced, not pasted');
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('every conversation turn is a working turn whatever the words, and a card is an ask turn',async()=>{
  const made=[];
  try {
    const job=submit({text:'@Claude [validation] 把这条记进采购',project_id:'bi-devices'});made.push(job);
    const seen=[];await execute(job.task_id,async(provider,prompt,opts)=>{seen.push({prompt,opts});return {result:'已记录',sessionId:'fake'};});
    assert.equal(seen[0].opts.mode,'work');
    const card=submit({title:'c',text:'x',model:'sonnet',inbox_reply:{id:'x',fingerprint:'y',action_id:'agent-check',label:'l'}});made.push(card);
    const cardSeen=[];await execute(card.task_id,async(provider,prompt,opts)=>{cardSeen.push(opts);return {result:'{}',sessionId:'fake'};});
    assert.equal(cardSeen[0].mode,'ask');assert.equal(cardSeen[0].effort,undefined);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('every module that takes arguments describes them, and help prints that description',()=>{
  const modules=read('automation/config.json').modules;
  for(const id of ['work','procurement','literature','software','projects'])assert.ok(modules[id].usage&&modules[id].usage.length>40,id);
  const out=(...a)=>execFileSync(process.execPath,[path.join(root,'automation/run.mjs'),...a],{encoding:'utf8'});
  assert.match(out('help','procurement'),/record <JSON文件路径>[^]*vendors/);assert.match(out('help','work'),/kind\(/);
  assert.match(out('help'),/help <模块>/);assert.match(out('help','agent'),/agent: status, work, ask/);assert.match(out('help','handoff'),/状态摘要：/);assert.match(out('help','card'),/inbox\.json/);assert.match(out('help','review'),/review\.json/);
});
test('a daily backup copies the edited data and a consistent ledger, runs once a day, and keeps only the newest days',()=>{
  const base=path.join(root,'.runtime/backups');fs.rmSync(base,{recursive:true,force:true});
  try {
    for(let i=1;i<=20;i++)fs.mkdirSync(path.join(base,`2026-09-${String(i).padStart(2,'0')}`),{recursive:true});
    const first=backupData({now:new Date('2026-10-05T12:00:00Z')});
    assert.equal(first.day,'2026-10-05');assert.ok(first.copied>=6);
    const dir=path.join(base,'2026-10-05');
    for(const file of ['work/queue.json','projects/catalog.json','procurement/catalog.json','.runtime/agent/sessions.json'])assert.equal(fs.readFileSync(path.join(dir,file),'utf8'),fs.readFileSync(path.join(root,file),'utf8'),file);
    const copy=new DatabaseSync(path.join(dir,'.runtime/mail-flow/mail.sqlite'),{readOnly:true});
    try{assert.ok(copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n>0);}finally{copy.close();}
    assert.equal(backupData({now:new Date('2026-10-05T18:00:00Z')}).skipped,true);
    const days=fs.readdirSync(base).filter(n=>/^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    assert.equal(days.length,14);assert.equal(days.at(-1),'2026-10-05');assert.equal(days[0],'2026-09-08');
    assert.ok(!fs.readdirSync(base).some(n=>n.endsWith('.partial')));
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test('deleting a conversation removes its messages but keeps its tasks, and is refused while a task in it is still running',()=>{
  const made=[];
  try {
    const job=submit({text:'@Claude [validation] 你好',project_id:'bi-devices'});made.push(job);
    assert.throws(()=>deleteSession(job.session_id),/任务在排队或运行/);
    update({id:job.task_id,status:'done',handoff:'好'});
    const out=deleteSession(job.session_id);
    assert.equal(out.deleted,job.session_id);assert.equal(out.tasks_kept,1);
    assert.ok(!read('.runtime/agent/sessions.json').sessions.some(s=>s.id===job.session_id));
    assert.ok(read('work/queue.json').items.some(i=>i.id===job.task_id));
    assert.throws(()=>deleteSession(job.session_id),/未知会话/);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('an archived project leaves the lists, the weekly plan, link suggestions, keeps its data, and comes back on restore',async()=>{
  const file=path.join(root,'projects/catalog.json'),raw=fs.readFileSync(file,'utf8'),statusFile=path.join(root,'workspace/projects/bi-devices/STATUS.md'),hadStatus=fs.existsSync(statusFile);
  const made=[];
  try {
    // a known starting point whatever the real catalog holds: one alias
    const catalog=read('projects/catalog.json'),project=catalog.projects.find(p=>p.id==='bi-devices');
    project.aliases=['archive-probe-alias'];write('projects/catalog.json',catalog);
    assert.ok(weeklySources().projects.some(p=>p.id==='bi-devices'));

    assert.deepEqual(setProjectArchived('bi-devices',true),{project_id:'bi-devices',archived:true});
    const archived=read('projects/catalog.json').projects.find(p=>p.id==='bi-devices');
    assert.ok(archived.archived_at);assert.deepEqual({...archived,archived_at:undefined},{...project,archived_at:undefined});
    assert.ok(!weeklySources().projects.some(p=>p.id==='bi-devices'));
    assert.equal(proposeLinks([{id:'archived-probe',title:'archive-probe-alias',action:''}]).added,0);
    assert.equal(JSON.parse(execFileSync(process.execPath,[path.join(root,'automation/run.mjs'),'projects','list'],{encoding:'utf8'})).find(p=>p.id==='bi-devices').archived,true);

    assert.deepEqual(setProjectArchived('bi-devices',false),{project_id:'bi-devices',archived:false});
    assert.equal(read('projects/catalog.json').projects.find(p=>p.id==='bi-devices').archived_at,undefined);
    assert.ok(weeklySources().projects.some(p=>p.id==='bi-devices'));
    assert.throws(()=>setProjectArchived('no-such-project',true),/Unknown project/);
  } finally {
    fs.writeFileSync(file,raw);if(!hadStatus)fs.rmSync(statusFile,{force:true});
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});
test('a conversation turn is an ordinary Claude agent on the user own auto approver; an ask turn has nothing; neither has a limit',()=>{
  const at=(args,flag)=>args[args.indexOf(flag)+1];
  const work=claudeArgs('sonnet',{mode:'work',effort:'high'});
  assert.equal(at(work,'--tools'),'default');assert.equal(at(work,'--permission-mode'),'auto');assert.equal(at(work,'--effort'),'high');assert.equal(at(work,'--system-prompt'),SYSTEM_PROMPT);assert.ok(!work.includes('--append-system-prompt'));
  assert.ok(work.includes('--strict-mcp-config'));assert.ok(!work.includes('--safe-mode'));assert.ok(!work.includes('--max-turns'));assert.ok(!work.includes('--allowedTools'));
  assert.ok(!work.some(a=>/bypass|dangerously/i.test(a)));
  assert.equal(at(work,'--input-format'),'stream-json');assert.ok(work.includes('--replay-user-messages'));
  const ask=claudeArgs('sonnet',{mode:'ask'});
  assert.equal(at(ask,'--tools'),'');assert.equal(at(ask,'--system-prompt'),SYSTEM_PROMPT);assert.ok(ask.includes('--safe-mode'));assert.equal(at(ask,'--max-turns'),'1');
  assert.ok(!ask.includes('--input-format'));assert.ok(!ask.includes('--replay-user-messages'));
  const cfg=read('agent/config.json');
  for(const key of ['approval','claude_skills_off','claude_max_turns','task_timeout_minutes','ask_timeout_minutes','work_timeout_minutes'])assert.equal(cfg[key],undefined,key);
  const codex=fs.readFileSync(path.join(root,'agent/codex.mjs'),'utf8');
  assert.match(codex,/approvalsReviewer:'auto_review'/);assert.doesNotMatch(codex,/danger-full-access|dangerFullAccess/);
});
test('Claude initial prompt acknowledgment is UUID-matched, once-only, and independent of readiness/output',()=>{
  const run=newRun('sonnet');run.promptId='INITIAL';let submitted=0;
  const options={onSubmitted:()=>submitted++};
  for(const e of [{type:'system',subtype:'init'},{type:'user',uuid:'STEER'},{type:'assistant',message:{content:[]}}])foldEvent(run,e,options);
  assert.equal(submitted,0);
  foldEvent(run,{type:'user',uuid:'INITIAL'},options);assert.equal(submitted,1);
  foldEvent(run,{type:'user',uuid:'INITIAL'},options);assert.equal(submitted,1);
  const ask=newRun('sonnet');foldEvent(ask,{type:'user'},options);assert.equal(submitted,1);
});

test('one Claude run is folded from its events: tool calls, the result, and a real error',()=>{
  const fold=events=>{const run=newRun('sonnet');const seen=[];for(const e of events)foldEvent(run,e,{onEvent:x=>seen.push(x.name)});return {run,seen};};
  const tool=name=>({type:'assistant',message:{content:[{type:'tool_use',name,input:{command:'x'}}]}});
  const ok=fold([{type:'system',subtype:'init',session_id:'S',model:'claude-sonnet-5-5'},tool('PowerShell'),tool('Read'),{type:'result',subtype:'success',is_error:false,result:'好的。',session_id:'S',usage:{output_tokens:9}}]);
  assert.equal(ok.run.result,'好的。');assert.equal(ok.run.error,null);assert.equal(ok.run.toolCalls,2);assert.deepEqual(ok.seen,['PowerShell','Read']);assert.equal(ok.run.model,'claude-sonnet-5-5');assert.equal(ok.run.usage.output_tokens,9);
  const bad=fold([{type:'result',subtype:'error_during_execution',is_error:true,errors:['boom'],session_id:'S',usage:{}}]);
  assert.equal(bad.run.error,'boom');
});
test('Claude cumulative model usage snapshots are diffed per model without summing repeated results',async()=>{
  const {claudeModelDelta,claudeModelUsageBaseline}=await import('../agent/claude.mjs');
  const {modelUsageRuns}=await import('../usage/metrics.mjs');
  const u=(inputTokens,outputTokens)=>({inputTokens,outputTokens,cacheReadInputTokens:0,cacheCreationInputTokens:0});
  const before={'claude-sonnet':u(10,4),'claude-haiku':u(20,8)};
  const after={'claude-sonnet':u(13,5),'claude-haiku':u(30,12)};
  assert.deepEqual(claudeModelDelta(after,before),{'claude-sonnet':u(3,1),'claude-haiku':u(10,4)});
  assert.deepEqual(claudeModelDelta(after,after),{'claude-sonnet':u(0,0),'claude-haiku':u(0,0)});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-cost-state-')),sid=randomUUID();
  try {
    fs.mkdirSync(path.join(dir,'projects','p'),{recursive:true});
    fs.writeFileSync(path.join(dir,'projects','p',sid+'.jsonl'),[{type:'cost-state',sessionId:sid,modelUsage:before}].map(JSON.stringify).join('\n')+'\n');
    assert.deepEqual(claudeModelUsageBaseline(sid,dir),before);
    assert.equal(claudeModelUsageBaseline(sid,dir,'fork-point'),null,'fork baseline is not assumed');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  const projections=modelUsageRuns([{provider:'claude',purpose:'chat',model:'sonnet',input_tokens:43,output_tokens:17,model_usage:after}]);
  assert.equal(projections.length,2);assert.equal(projections.reduce((n,r)=>n+r.input_tokens+r.output_tokens,0),60);
  assert.ok(projections.every(r=>r.duration_ms===null&&r.tool_calls===null));
  const legacy={provider:'codex',model:'legacy-codex',input_tokens:100,output_tokens:10,status:'completed'};
  assert.equal(modelUsageRuns([legacy,{model_usage:after}]).length,3,'mixed old and new records all remain visible');
  const {usageSections}=await import('../dashboard/usage-view.js');
  const view=usageSections([legacy,{provider:'claude',model:'sonnet',purpose:'chat',input_tokens:43,output_tokens:17,status:'completed',model_usage:after}]);
  assert.match(view.use,/legacy-codex/);assert.match(view.use,/claude-haiku/);assert.match(view.use,/<td>—<\/td><td>—<\/td>/);
  assert.match(view.note,/跨模型不能相加/);
});
test('Claude context length is the last main-thread request plus its answer; the window comes from the result',()=>{
  const run=newRun('claude-sonnet-5-5'),seen=[];
  const turn=(usage,extra={})=>({type:'assistant',message:{model:'claude-sonnet-5-5',content:[],usage},...extra});
  for(const e of [turn({input_tokens:2,cache_read_input_tokens:39417,cache_creation_input_tokens:830,output_tokens:16}),
    turn({input_tokens:9,output_tokens:9},{parent_tool_use_id:'T'}),turn({input_tokens:0,output_tokens:0}),
    {type:'result',is_error:false,result:'好',usage:{},modelUsage:{'claude-sonnet-5-5':{contextWindow:1000000}}}])foldEvent(run,e,{onEvent:x=>seen.push(x)});
  assert.deepEqual(seen,[{type:'context',tokens:40265},{type:'context',window:1000000}]);
});
test('words said midway are reported once; the final reply is left to the caller',()=>{
  const run=newRun('sonnet'),said=[];const text=t=>({type:'assistant',message:{content:[{type:'text',text:t}]}});
  for(const e of [text('先看一下。'),{type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{}}]}},text('找到了。'),text('结论如下。'),{type:'result',is_error:false,result:'结论如下。',usage:{}}])foldEvent(run,e,{onEvent:x=>said.push(x.type+':'+(x.text||x.name))});
  assert.deepEqual(said,['text:先看一下。','tool:Read','text:找到了。']);assert.equal(run.result,'结论如下。');
});

test('what a sub-agent says or runs is flagged sub; the main thread is not',()=>{
  const run=newRun('sonnet'),seen=[];const text=(t,extra={})=>({type:'assistant',message:{content:[{type:'text',text:t}]},...extra});
  for(const e of [text('我派个子 agent。'),text('子 agent 的发现。',{parent_tool_use_id:'T'}),{type:'assistant',parent_tool_use_id:'T',message:{content:[{type:'tool_use',name:'Read',input:{}}]}},text('子 agent 收尾。',{parent_tool_use_id:'T'}),text('最终结论。'),{type:'result',is_error:false,result:'最终结论。',usage:{}}])foldEvent(run,e,{onEvent:x=>seen.push(x.type+':'+(x.text||x.name)+(x.sub?':sub':''))});
  assert.deepEqual(seen,['text:我派个子 agent。','text:子 agent 的发现。:sub','tool:Read:sub','text:子 agent 收尾。:sub']);assert.equal(run.result,'最终结论。');
});

test('conversation record keeps every message and attachment verbatim beyond one million characters',async()=>{
  const {conversationRecord}=await import('../agent/run.mjs');
  const messages=Array.from({length:240},(_,i)=>({role:i%2?'assistant':'user',provider:i%3?'claude':'codex',text:`第${i}条\n`+'字'.repeat(5000)+`\n第${i}条的最后决定`}));
  messages[2].attachments=[{kind:'file',name:'raw.csv',path:'x/raw.csv'}];
  const r=conversationRecord(messages);
  assert.ok(r.lines.join('\n').length>1000000);
  assert.equal(r.lines.length,messages.length);
  for(let i=0;i<messages.length;i++)assert.equal(JSON.parse(r.lines[i]).text,messages[i].text,`message ${i}: retain newlines and its final decision`);
  const attachments=JSON.parse(r.lines[2]).attachments;
  assert.match(attachments,/"name":"raw.csv"/);assert.ok(attachments.includes(JSON.stringify(path.join(root,'x/raw.csv'))));
  assert.equal(JSON.parse(r.lines[0]).speaker,'用户');assert.equal(JSON.parse(r.lines[1]).speaker,'Claude');assert.equal(JSON.parse(r.lines[3]).speaker,'Codex');
  assert.deepEqual(conversationRecord([]).lines,[]);
});

test('full-context conversation delivers long current requests and all earlier handoff replies to both providers',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in an isolated copy');
  const made=[],config=read('agent/config.json');
  try {
    const text='@all [validation] '+ '细节\n'.repeat(4000)+'必须保留的请求末尾';
    const job=submit({text});made.push(job);
    assert.ok(text.length>10000);
    assert.equal(read('work/queue.json').items.find(i=>i.id===job.task_id).goal,text,'the queue also retains the complete original requirement');
    const state=read('.runtime/agent/sessions.json'),session=state.sessions.find(s=>s.id===job.session_id);
    const history=Array.from({length:180},(_,i)=>({role:i%2?'assistant':'user',provider:i%3?'claude':'codex',task_id:'prior-'+i,text:`历史${i}\n`+'字'.repeat(6000)+`\n历史${i}末尾决定`}));
    history[84].interim=true;
    history[85].interim=true;
    history[85].attachments=[{kind:'file',name:'old-data.csv',path:'x/old-data.csv'}];
    session.messages.unshift(...history);write('.runtime/agent/sessions.json',state);
    const firstReply='第一轮\n'+'解释'.repeat(2600)+'\n第一轮末尾决定',secondReply='第二轮\n'+'核查'.repeat(2600)+'\n第二轮末尾决定\n@Codex 请确认';
    const seen=[];
    await execute(job.task_id,async(provider,prompt,opts)=>{
      seen.push(provider);assert.equal(opts.mode,'work');
      const record=opts.inputParts.find(p=>p.kind==='conversation_history').text.split('\n').slice(1).map(line=>JSON.parse(line));
      const allTexts=record.map(m=>m.text);
      assert.ok(prompt.includes(text)||allTexts.includes(text),'the full saved user message survives both direct input and chronological handoff history');
      for(const message of history)assert.ok(allTexts.includes(message.text),'every historical message is intact');
      assert.ok(prompt.includes('old-data.csv'));
      if(seen.length>=2)assert.ok(prompt.includes('首轮工具间的说明：保留样品对应关系'),'interim text from a preceding turn remains visible');
      if(seen.length>=2)assert.ok(allTexts.includes(firstReply),'long first reply is still visible');
      if(seen.length>=3)assert.ok(allTexts.includes(secondReply),'long handoff is still visible');
      if(seen.length===1)opts.onEvent({type:'text',text:'首轮工具间的说明：保留样品对应关系'});
      return {result:seen.length===1 ? firstReply : seen.length===2 ? secondReply : '完成',sessionId:'fake'};
    });
    assert.deepEqual(seen,['codex','claude','deepseek','codex'],'the explicit confirmation handoff follows the already-named colleagues');
    assert.equal(read('work/queue.json').items.find(i=>i.id===job.task_id).status,'done');
  } finally {
    write('agent/config.json',config);
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});

test('resolved closes its approval/decision chain without executing anything, with undo',async()=>{
  const id='validation-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(id,'[validation] resolve chain','todo','verify');
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),work=()=>read('work/queue.json').items;
  const made=[],sessionIds=new Set();
  const track=job=>{made.push(job.task_id);sessionIds.add(job.session_id);return job;};
  const reply=async(origin,kind,settle)=>{
    // The mail is checked by an agent, who raises a card; the user picks an option; the answering agent writes its own card.
    const first=track(submit({title:'让 agent 处理 · resolve',text:`@Codex 针对邮件，我选择：让 agent 处理。\n原事项：${origin}`,model:'sonnet',inbox_reply:{id:origin,fingerprint:'f',action_id:'agent-check',label:'l'}}));
    await execute(first.task_id,async()=>{write(`.runtime/agent/runs/${first.task_id}/inbox.json`,{category:'实验',kind,title:'确认',message:'是否有安排？',actions:[{id:'none',type:'reply',label:'没有安排',reply:'记录'}]});return {result:'请确认。',sessionId:'fake'};});
    const card=inboxItems(rows(),work(),[]).find(i=>i.source_id===first.task_id);assert.ok(card);
    const second=track(submit({title:'没有安排',text:`@Codex 针对实验安排「确认」，我选择：没有安排。\n原事项：${card.id}`,session_id:first.session_id,model:'sonnet',inbox_reply:{id:card.id,fingerprint:card.fingerprint,action_id:'none',label:'没有安排'}}));
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.id===card.id),false);
    await execute(second.task_id,async()=>{write(`.runtime/agent/runs/${second.task_id}/inbox.json`,settle);return {result:'已记录。',sessionId:'fake'};});
    return card;
  };
  try {
    // An approval card the user has already dealt with is withdrawn like any other; closing it grants nothing.
    const approval=await reply('mail:'+id,'approval',{category:'实验',kind:'approval',title:'已确认',message:'无需调整。',resolved:true});
    assert.equal(work().find(i=>i.id===approval.source_id).review.state,'accepted');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
    db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(id);
    const closed=await reply('mail:'+id,'decision',{category:'实验',kind:'decision',title:'已确认',message:'无需调整。',resolved:true});
    assert.equal(work().find(i=>i.id===closed.source_id).review.state,'accepted');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.source_id===closed.source_id),false);
    assert.ok(inboxActivity().undoable.some(i=>i.id===closed.id));
    undoAcknowledgment(closed.id,rows(),work(),[]);
    assert.equal(work().find(i=>i.id===closed.source_id).review.state,'pending');
    assert.equal(normalizeCard({message:'已办完',resolved:true}).resolved,true);assert.deepEqual(normalizeCard({message:'已办完',resolved:true}).actions,[]);
    assert.equal(normalizeCard({message:'已办完',resolved:'yes'}),null);
  } finally {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.includes(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!sessionIds.has(i.id));write('.runtime/agent/sessions.json',s);
    const ack=read('.runtime/inbox/acknowledged.json',{});for(const key of Object.keys(ack))if(ack[key].title==='确认'||key.includes(id))delete ack[key];write('.runtime/inbox/acknowledged.json',ack);
  }
});

test('a free follow-up in a card conversation closes the card too, the prompt says how, and a rewritten handoff does not bring a replied card back',async()=>{
  const id='validation-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(id,'[validation] free follow-up','todo','verify');
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),work=()=>read('work/queue.json').items;
  const made=[],sessionIds=new Set();
  const track=job=>{made.push(job.task_id);sessionIds.add(job.session_id);return job;};
  try {
    const first=track(submit({title:'让 agent 处理 · free',text:`@Codex 针对邮件，我选择：让 agent 处理。\n原事项：mail:${id}`,model:'sonnet',inbox_reply:{id:'mail:'+id,fingerprint:'f',action_id:'agent-check',label:'l'}}));
    await execute(first.task_id,async()=>{write(`.runtime/agent/runs/${first.task_id}/inbox.json`,{category:'实验',kind:'decision',title:'确认',message:'是否有安排？',actions:[{id:'none',type:'reply',label:'没有安排',reply:'记录'}]});return {result:'请确认。',sessionId:'fake'};});
    const card=inboxItems(rows(),work(),[]).find(i=>i.source_id===first.task_id);assert.ok(card);
    // the user picks a button; the item's own handoff is then rewritten by the answering agent (the original incident)
    const second=track(submit({title:'没有安排',text:`@Codex 针对实验安排「确认」，我选择：没有安排。\n原事项：${card.id}`,session_id:first.session_id,model:'sonnet',inbox_reply:{id:card.id,fingerprint:card.fingerprint,key:card.key,action_id:'none',label:'没有安排'}}));
    update({id:first.task_id,handoff:'agent 改写了这件事的 handoff'});
    assert.equal(inboxItems(rows(),work(),[]).some(i=>i.id===card.id),false);
    const prompts=[];
    // the answering agent raises a new card of its own (the Qolaboration incident): the card on screen is this one, not the card that was answered
    await execute(second.task_id,async(p,prompt)=>{prompts.push(prompt);write(`.runtime/agent/runs/${second.task_id}/inbox.json`,{category:'实验',kind:'decision',title:'仍待确认',message:'还缺一项。',actions:[{id:'go',type:'reply',label:'继续',reply:'继续'}]});return {result:'已记录。',sessionId:'fake'};});
    assert.equal(work().find(i=>i.id===second.task_id).review.state,'pending');
    assert.match(prompts[0],/这条对话来自收件箱卡片（原事项：work:/);assert.match(prompts[0],/resolved/);
    // a free follow-up: no 原事项 line, no inbox_reply, the card was not closed yet
    const third=track(submit({text:'@Codex 其实这件事我已经办完了',session_id:first.session_id,model:'sonnet'}));
    assert.equal(askedCard(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===first.session_id),third.task_id),card.id);
    await execute(third.task_id,async()=>{write(`.runtime/agent/runs/${third.task_id}/inbox.json`,{category:'实验',kind:'decision',title:'已办完',message:'无需再处理。',resolved:true});return {result:'好。',sessionId:'fake'};});
    assert.equal(work().find(i=>i.id===first.task_id).review.state,'accepted');
    assert.equal(work().find(i=>i.id===second.task_id).review.state,'accepted');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
    // a conversation that never answered a card gets neither the prompt line nor a card to close
    const plain=track(submit({text:'@Codex 随便聊聊',model:'sonnet'}));const seen=[];
    await execute(plain.task_id,async(p,prompt)=>{seen.push(prompt);return {result:'好。',sessionId:'fake'};});
    assert.doesNotMatch(seen[0],/来自收件箱卡片/);
  } finally {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.includes(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!sessionIds.has(i.id));write('.runtime/agent/sessions.json',s);
    const ack=read('.runtime/inbox/acknowledged.json',{});for(const key of Object.keys(ack))if(ack[key].title==='确认'||key.includes(id))delete ack[key];write('.runtime/inbox/acknowledged.json',ack);
  }
});

test('a pending approval is retired by a plain follow-up answer or by a newer mail; decisions without a live replacement and acceptances stay',async()=>{
  const id='validation-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,'[]','[]','[]')").run(id,'[validation] stale approval','todo','verify');
  const rows=()=>db.prepare('SELECT id,title,status,action,check_at,deadline FROM tasks').all(),work=()=>read('work/queue.json').items,shown=()=>inboxItems(rows(),work(),[]).map(i=>i.id);
  const made=[],sessionIds=new Set(),mids=[];
  const track=job=>{made.push(job.task_id);sessionIds.add(job.session_id);return job;};
  const asked=async(kind)=>{
    const first=track(submit({title:'让 agent 处理 · stale',text:`@Codex 针对邮件，我选择：让 agent 处理。\n原事项：mail:${id}`,model:'sonnet',inbox_reply:{id:'mail:'+id,fingerprint:'f',action_id:'agent-check',label:'l'}}));
    await execute(first.task_id,async()=>{write(`.runtime/agent/runs/${first.task_id}/inbox.json`,{category:'实验',kind,title:'是否发送？',message:'按草稿发送？',actions:[{id:'go',type:'reply',label:'发送',reply:'发送'}]});return {result:'草稿已拟好。',sessionId:'fake'};});
    return first;
  };
  const arrive=(at)=>{const m='validation-msg-'+randomUUID();mids.push(m);
    db.prepare('INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,?,?,?)').run(m,'f',JSON.stringify({id:m,subject:'S',sender:'x',recipients:[],received:at,folder:'Inbox',text:'t'}),'reviewed','update',0);
    db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run(m,id);};
  try {
    // 1. the user answers in plain text ("可以发"), no button, and the agent raises no new card: the answered approval goes, the matter's own card stays
    const first=await asked('approval');
    assert.ok(shown().includes('work:'+first.task_id));
    const free=track(submit({text:'@Codex 可以发',session_id:first.session_id,model:'sonnet'}));
    await execute(free.task_id,async()=>({result:'已发送，等对方回复。',sessionId:'fake'}));
    assert.equal(work().find(w=>w.id===first.task_id).review.state,'accepted');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'todo','withdrawing the question does not close the matter');
    assert.ok(shown().includes('mail:'+id));
    // 2. a decision card is not retired by chat alone
    const decision=await asked('decision');
    const chat=track(submit({text:'@Codex 顺便问一句',session_id:decision.session_id,model:'sonnet'}));
    await execute(chat.task_id,async()=>({result:'好。',sessionId:'fake'}));
    assert.equal(work().find(w=>w.id===decision.task_id).review.state,'pending');
    // 3. a newer mail replaces the old approval/decision with the live mail card, but only while that card exists, and never an acceptance
    arrive('2026-10-01T00:00:00Z');
    assert.ok(shown().includes('work:'+decision.task_id),'older mail changes nothing');
    arrive(new Date(Date.now()+3600000).toISOString());
    assert.ok(!shown().includes('work:'+decision.task_id));assert.ok(shown().includes('mail:'+id));
    db.prepare("UPDATE tasks SET status='waiting' WHERE id=?").run(id);
    assert.ok(shown().includes('work:'+decision.task_id),'no live mail card to take over: keep the question');
    db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(id);
    const q=read('work/queue.json');q.items.find(w=>w.id===decision.task_id).review={kind:'acceptance',state:'pending'};write('work/queue.json',q);
    assert.ok(shown().includes('work:'+decision.task_id),'an acceptance is about a delivered file, not the thread');
  } finally {
    for(const m of mids)db.prepare('DELETE FROM sources WHERE id=?').run(m),db.prepare('DELETE FROM messages WHERE id=?').run(m);
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.includes(i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!sessionIds.has(i.id));write('.runtime/agent/sessions.json',s);
    const ack=read('.runtime/inbox/acknowledged.json',{});for(const key of Object.keys(ack))if(ack[key].title==='是否发送？'||key.includes(id))delete ack[key];write('.runtime/inbox/acknowledged.json',ack);
  }
});

const sessionsFile='.runtime/agent/sessions.json';
test('card provenance is line-bound, cycle-safe and not limited to five hops',()=>{
  assert.equal(cardOrigin('资料说原事项：mail:wrong'),'');
  assert.equal(cardOrigin('说明\n原事项：mail:correct\n'),'mail:correct');
  const chain=Array.from({length:8},(_,n)=>({id:'node-'+n,goal:'原事项：'+(n===7 ? 'mail:source' : 'work:node-'+(n+1))}));
  assert.equal(cardChain('work:node-0',chain).at(-1),'mail:source');
  assert.deepEqual(cardChain('work:a',[{id:'a',goal:'原事项：work:b'},{id:'b',goal:'原事项：work:a'}]),[]);
  const session={messages:[{role:'user',task_id:'now',text:'原事项：mail:current'},{role:'user',task_id:'later',text:'原事项：mail:future'}]};
  assert.equal(askedCard(session,'now'),'mail:current','later messages cannot redirect the current turn');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  try {
    const text='@Codex 继续处理\n'+'长资料'.repeat(2000)+'\n原事项：mail:long-detail';
    const job=submit({text});
    assert.equal(cardOrigin(read('work/queue.json').items.find(w=>w.id===job.task_id).goal),'mail:long-detail','the queue summary must keep provenance past 4000 characters');
    assert.equal(read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id).messages[0].text,text,'the user message stays verbatim');
  } finally {write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);}
});

test('resolved selects one matter, never all cards in a shared conversation; settled ancestors are idempotent',async()=>{
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json'),ack=read('.runtime/inbox/acknowledged.json',{});
  const item=id=>read('work/queue.json').items.find(w=>w.id===id);
  const raise=async(text,session_id)=>{
    const original=inboxItems([],read('work/queue.json').items,[]).find(i=>i.id===cardOrigin(text));
    const inbox_reply=original && {id:original.id,fingerprint:original.fingerprint,key:original.key,action_id:'discuss',label:'和 agent 交流'};
    const job=submit({text,session_id,inbox_reply});
    await execute(job.task_id,async()=>{write(`.runtime/agent/runs/${job.task_id}/inbox.json`,{kind:'approval',message:'请确认。',actions:[{id:'go',type:'reply',label:'继续'}]});return {result:'请确认。'};});
    return job;
  };
  const settle=async(text,session_id,result='已记录用户自行完成。',waitForInput=false)=>{
    const job=submit({text,session_id});let prompt;
    await execute(job.task_id,async(_,p)=>{
      prompt=p;
      if(waitForInput)update({id:job.task_id,status:'waiting_user',handoff:result});
      else write(`.runtime/agent/runs/${job.task_id}/inbox.json`,{message:'已办完。',resolved:true});
      return {result};
    });
    return {job,prompt};
  };
  try {
    const a=await raise('@Codex [validation] 事项 A');
    const child=await raise(`@Codex [validation] 事项 A 后续\n原事项：work:${a.task_id}`,a.session_id);
    const b=await raise('@Codex [validation] 独立事项 B',a.session_id);
    const visible=inboxItems([],read('work/queue.json').items,[]);
    assert.equal(visible.some(i=>i.id==='work:'+a.task_id),false,'the explicit descendant is the current question, not an extra copy');
    for(const job of [child,b])assert.ok(visible.some(i=>i.id==='work:'+job.task_id),'independent chains remain visible');
    const ambiguous=await settle('@Codex 已经办完了',a.session_id);
    assert.doesNotMatch(ambiguous.prompt,/这条对话来自收件箱卡片/);
    for(const job of [a,child,b])assert.equal(item(job.task_id).review.state,'pending','an ambiguous free reply must leave independent matters alone');
    await settle(`@Codex A 已自行发出\n原事项：work:${child.task_id}`,a.session_id);
    assert.equal(item(a.task_id).review.state,'accepted');assert.equal(item(child.task_id).review.state,'accepted');
    assert.equal(item(b.task_id).review.state,'pending');
    const settled=read('.runtime/inbox/acknowledged.json');
    await settle(`@Codex A 已自行发出\n原事项：work:${child.task_id}`,a.session_id);
    assert.deepEqual(read('.runtime/inbox/acknowledged.json'),settled,'repeat resolution must not replace acknowledgment or undo timestamps');
    update({id:a.task_id,review:{kind:'approval',state:'pending'}});
    await settle(`@Codex A 整条事项已办完\n原事项：work:${child.task_id}`,a.session_id);
    assert.equal(item(a.task_id).review.state,'accepted','a settled child must not strand the open parent');
    const incomplete=await settle(`@Codex B 继续\n原事项：work:${b.task_id}`,a.session_id,'操作未完成，需要补充证据。',true);
    assert.equal(item(incomplete.job.task_id).status,'waiting_user');assert.equal(item(b.task_id).review.state,'pending');
    assert.equal(item(incomplete.job.task_id).handoff,'操作未完成，需要补充证据。','the assistant explicitly waits; the executor does not infer it from prose');
  } finally {
    write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);write('.runtime/inbox/acknowledged.json',ack);
  }
});
const dropSessions=ids=>{const s=read(sessionsFile);s.sessions=s.sessions.filter(x=>!ids.includes(x.id));write(sessionsFile,s);};
test('agent search needs every word in one conversation, lists the newest first, and show reads a turn in full',()=>{
  const sid=['aaaa1111-0000-4000-8000-000000000001','aaaa2222-0000-4000-8000-000000000002','bbbb3333-0000-4000-8000-000000000003','cccc4444-0000-4000-8000-000000000004'];
  const say=(role,text,at,task,extra={})=>({role,text,at,task_id:task,...(role==='assistant' ? {provider:'claude'} : {}),...extra});
  const make=(id,title,created,messages,extra={})=>({id,title,project_ids:[],created_at:created,origin:'chat',messages,task_ids:[],...extra});
  try {
    const s=read(sessionsFile);
    s.sessions.push(
      make(sid[0],'旧的 CDW 对话','2026-09-01T15:00:00Z',[say('user','应变下 CDW 相变温度怎么变','2026-09-01T15:00:00Z','t1111111-x'),say('assistant','温度随应变升高。'+'很长的铺垫。'.repeat(40)+'结论 UNIQUEMARK 在这里','2026-09-01T15:05:00Z','t1111111-x')]),
      make(sid[1],'新的 CDW 对话','2026-09-20T15:00:00Z',[say('user','CDW 的拉曼','2026-09-20T15:00:00Z','t2222222-x'),say('assistant','说明','2026-09-20T15:05:00Z','t2222222-x'),
        say('assistant','过程性的话 UNIQUEINTERIM','2026-09-20T15:04:00Z','t2222222-x',{interim:true})]),
      make(sid[2],'别的事','2026-09-10T15:00:00Z',[say('user','只有应变','2026-09-10T15:00:00Z','t3333333-x')]),
      make(sid[3],'应变记录','2026-08-01T15:00:00Z',[say('user','随便一句','2026-08-01T15:00:00Z','t4444444-x')]));
    write(sessionsFile,s);
    const both=searchSessions('cdw 应变');
    assert.match(both,/找到 1 条对话/);assert.ok(both.includes(sid[0]) && !both.includes(sid[1]) && !both.includes(sid[2]),'every word must appear in the same conversation');
    assert.match(both,/UNIQUEMARK|…/,'the hit is shown as a snippet around the word');
    const one=searchSessions('CDW'),ids=[sid[0],sid[1]].map(id=>one.indexOf(id));
    assert.ok(ids.every(i=>i>=0) && ids[1]<ids[0],'the most recently active conversation comes first');
    assert.match(searchSessions('zqxjv'),/找到 0 条对话/);
    assert.ok(!searchSessions('UNIQUEINTERIM').includes(sid[1]),'interim words are not searched');
    assert.throws(()=>searchSessions('  '),/agent search/);
    const byName=searchSessions('应变'),at=id=>byName.indexOf(id);
    assert.ok(at(sid[3])>=0 && at(sid[3])<at(sid[2]) && at(sid[2])<at(sid[0]),'a conversation named by the words comes first, the rest newest first');
    const loose=searchSessions('cdw 别的事');
    assert.match(loose,/没有对话同时包含全部词/);assert.ok(loose.includes(sid[0]) && loose.includes(sid[2]) && /近似度 [0-9]+%/.test(loose),'with no full match, approximate candidates are offered');
    assert.ok(!searchSessions('cdw 应变').includes('近似'),'a full match is not labelled approximate');
    {const q=read('work/queue.json');q.items.push({id:'t3333333-x',status:'active'});write('work/queue.json',q);}
    try {assert.match(searchSessions('只有应变'),/找到 0 条对话/,'the turn running now is not searched, or it would find itself');}
    finally {const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!=='t3333333-x');write('work/queue.json',q);}
    assert.ok(searchSessions('只有应变').includes(sid[2]),'a finished turn is searched');
    // A whole remembered sentence (one long word with punctuation inside) has no literal match; pieces of it still find the conversation, and rare pieces count for more.
    const sentence=searchSessions('你还记得我们谈过‘应变下的CDW相变温度怎么变’吗，当时说了很多'),at2=id=>{const k=sentence.indexOf(id);return k<0 ? Infinity : k;};
    assert.match(sentence,/近似匹配/);assert.ok(at2(sid[0])<Infinity,'the conversation holding most pieces is found');
    assert.ok(at2(sid[0])<at2(sid[1]) && at2(sid[0])<at2(sid[3]),'it ranks above conversations that share one common piece only');
    assert.match(sentence,/应变下 CDW 相变温度怎么变/,'the snippet shows the message that was found');
    assert.match(searchSessions('的了是我你他她它们这那有过吗么什怎'),/找到 0 条对话/,'function characters alone match nothing');
    const turns=showSession(sid[0].slice(0,8));
    assert.match(turns,/#t1111111 2026-09-01 用户：应变下 CDW 相变温度怎么变/);assert.ok(turns.includes('UNIQUEMARK'),'listed messages are complete, not prefix fragments');
    const turn=showSession(sid[0].slice(0,8)+'#t1111');
    assert.ok(turn.includes('UNIQUEMARK') && turn.includes('应变下 CDW 相变温度怎么变'),'one turn is given in full');
    assert.throws(()=>showSession('aaaa'),/不唯一/);assert.throws(()=>showSession('zzzz9999'),/没有这条对话/);assert.throws(()=>showSession('abc'),/至少 4 位/);
    assert.throws(()=>showSession(sid[0].slice(0,8)+'#nope'),/没有该任务/);
  } finally {dropSessions(sid);}
});
test('a chat is named once by a small model after its first answer; failure, cards and automatic steps never retry or break the turn',async()=>{
  assert.equal(cleanTitle('标题：「CDW 应变测量计划。」\n多余的解释'),'CDW 应变测量计划');
  assert.equal(cleanTitle('@Claude 整理数据'),'整理数据');assert.equal(cleanTitle('x'.repeat(80)),'x'.repeat(80));assert.equal(cleanTitle(''),'');assert.equal(cleanTitle('WorkBench上下文压缩 તપાસ'),'WorkBench上下文压缩','letters of unrelated scripts are dropped');assert.equal(cleanTitle('TaIrTe₄ 应变 α 相'),'TaIrTe₄ 应变 α 相','symbols and Greek stay');
  const made=[],calls=[];
  const model=title=>async(provider,prompt,opts)=>{if(opts.purpose==='title'){calls.push({provider,prompt,opts});if(title instanceof Error)throw title;return {result:title};}return {result:'好的',sessionId:'fake'};};
  const sessionOf=job=>read(sessionsFile).sessions.find(s=>s.id===job.session_id);
  try {
    const chat=submit({text:'@Claude [validation] 帮我看看这周的计划怎么排'});made.push(chat);
    assert.equal(draftTitle(sessionOf(chat)),true,'a new chat starts with its first words as a draft');
    await executeAgent(chat.task_id,model('标题：本周计划排期。'));
    assert.equal(calls.length,1);assert.equal(sessionOf(chat).title,'本周计划排期');assert.equal(draftTitle(sessionOf(chat)),false);
    assert.deepEqual([calls[0].provider,calls[0].opts.mode,calls[0].opts.model,calls[0].opts.effort],[read('agent/config.json').title_provider,'ask',read('agent/config.json').title_model,read('agent/config.json').title_effort]);
    assert.ok(calls[0].prompt.includes('帮我看看这周的计划怎么排') && calls[0].prompt.includes('好的'),'the model sees the question and the first answer');
    const next=submit({text:'@Claude [validation] 再问一句',session_id:chat.session_id});made.push(next);
    await executeAgent(next.task_id,model('不该用到'));
    assert.equal(calls.length,1,'a named conversation is not named again');assert.equal(sessionOf(chat).title,'本周计划排期');
    // a failing model: the turn still completes, the failure is recorded, and nothing tries again
    const failing=submit({text:'@Claude [validation] 另一个新话题'});made.push(failing);
    await executeAgent(failing.task_id,model(new Error('quota exhausted')));
    assert.equal(read('work/queue.json').items.find(i=>i.id===failing.task_id).status,'done');
    assert.ok(sessionOf(failing).title_tried && sessionOf(failing).activity.some(a=>a.type==='title' && /quota exhausted/.test(a.detail)));
    assert.equal(draftTitle(sessionOf(failing)),false);
    assert.equal(await titleSession(failing.session_id,model('第二次'),{}),null);assert.equal(calls.length,2,'a failed try is not repeated on its own');
    assert.equal(sessionOf(failing).title.includes('另一个新话题'),true);
    // explicit renaming ignores the earlier try
    assert.equal(await titleSession(failing.session_id,model('重新起的名'),{force:true}),'重新起的名');assert.equal(sessionOf(failing).title,'重新起的名');
    // an empty answer changes nothing
    assert.equal(await titleSession(chat.session_id,model(''),{force:true}),null);assert.equal(sessionOf(chat).title,'本周计划排期');
    // a card conversation keeps its card title and is never sent to the title model
    const before=calls.length,card=submit({text:'@Codex [validation] 判断这张卡',inbox_reply:{id:'mail:t',fingerprint:'f',action_id:'agent-check',label:'l'}});made.push(card);
    await executeAgent(card.task_id,model('不该用到'));
    assert.equal(calls.length,before);assert.equal(sessionOf(card).origin,'task');
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);dropSessions(made.map(j=>j.session_id));
  }
});
test('a long chat is named once more at its title_again_at-th user message, from its start and latest messages, and never after that',async()=>{
  const every=read('agent/config.json').title_again_at;assert.ok(every>=3);
  const made=[],calls=[];
  const model=title=>async(provider,prompt,opts)=>{if(opts.purpose==='title'){calls.push({provider,prompt,opts});if(title instanceof Error)throw title;return {result:title};}return {result:'好的',sessionId:'fake'};};
  const sessionOf=job=>read(sessionsFile).sessions.find(s=>s.id===job.session_id);
  const turn=async(first,n,title)=>{const job=submit({text:`@Claude [validation] 第${n}问`,session_id:first.session_id});made.push(job);await executeAgent(job.task_id,model(title));};
  try {
    const chat=submit({text:'@Claude [validation] 第1问'});made.push(chat);
    await executeAgent(chat.task_id,model('开头标题'));
    assert.equal(calls.length,1);assert.equal(sessionOf(chat).title,'开头标题');assert.equal(sessionOf(chat).title_turns,1);
    for(let n=2;n<every;n++)await turn(chat,n,'不该用到');
    assert.equal(calls.length,1,'not named again before the chosen message');
    await turn(chat,every,'后来标题');
    assert.equal(calls.length,2);assert.equal(sessionOf(chat).title,'后来标题');assert.equal(sessionOf(chat).title_turns,every);
    assert.ok(calls[1].prompt.includes('第1问') && calls[1].prompt.includes(`第${every}问`) && !calls[1].prompt.includes('第5问'),'the middle of a long chat is left out');
    // that was the last automatic naming, however long the chat goes on
    for(let n=every+1;n<=2*every+1;n++)await turn(chat,n,'不该用到');
    assert.equal(calls.length,2);assert.equal(sessionOf(chat).title,'后来标题');
    // a chat already past that message when it is first named (or named by hand before) is not named a second time
    const old=submit({text:'@Claude [validation] 旧对话第1问'});made.push(old);
    {const s=read(sessionsFile);const x=s.sessions.find(y=>y.id===old.session_id);x.title_tried=true;x.title_turns=every+3;write(sessionsFile,s);}
    for(let n=2;n<=every+4;n++)await turn(old,n,'不该用到');
    assert.equal(calls.length,2);
    // a failed second try is not repeated either
    const flaky=submit({text:'@Claude [validation] 第1问'});made.push(flaky);
    await executeAgent(flaky.task_id,model('开头'));
    for(let n=2;n<every;n++)await turn(flaky,n,'不该用到');
    await turn(flaky,every,new Error('quota exhausted'));
    assert.equal(calls.length,4);assert.equal(sessionOf(flaky).title,'开头');assert.ok(sessionOf(flaky).activity.some(a=>a.type==='title' && /quota exhausted/.test(a.detail)));
    await turn(flaky,every+1,'不该用到');assert.equal(calls.length,4);
  } finally {
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);dropSessions(made.map(j=>j.session_id));
  }
});

test('context breakdown: parts add up to the reported total; fixed overhead and scale come from two requests; sidechains and pre-compaction history are left out',async()=>{
  const {claudeBreakdown,codexBreakdown,claudeTranscript,codexTranscript}=await import('../agent/context-breakdown.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctx-breakdown-')),id=randomUUID();
  try {
    const j=lines=>lines.map(l=>JSON.stringify(l)).join('\n')+'\n';
    const usage=(cache_creation,cache_read,output)=>({input_tokens:1,cache_creation_input_tokens:cache_creation,cache_read_input_tokens:cache_read,output_tokens:output});
    const claude=[
      {type:'user',message:{role:'user',content:'你好，请读一下这个文件'}},
      {type:'assistant',message:{usage:usage(5000,0,50),content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a.txt'}}]}},
      {type:'assistant',isSidechain:true,message:{usage:usage(999999,0,1),content:[{type:'text',text:'sub-agent noise'.repeat(5000)}]}},
      {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'x'.repeat(20000)}]}},
      {type:'assistant',message:{usage:usage(8100,5000,100),content:[{type:'text',text:'好的，读完了'}]}}];
    const file=path.join(dir,'claude.jsonl');fs.writeFileSync(file,j(claude));
    const r=claudeBreakdown(file),by=Object.fromEntries(r.parts.map(p=>[p.key,p.tokens]));
    assert.equal(r.total,13201);assert.equal(r.parts.reduce((a,p)=>a+p.tokens,0),13201,'parts always add up to the reported total');
    assert.ok(by.fixed>4800 && by.fixed<5100,'fixed overhead is what the first request carried beyond the transcript: '+by.fixed);
    assert.ok(by.read>7500 && by.read<8500,'the Read result is the bulk: '+by.read);
    assert.ok(by.user>0 && by.call>0 && by.assistant>0);assert.equal(by.cmd,undefined);
    // a compaction boundary drops what came before; the summary is its own part
    const after=[...claude,{type:'system',subtype:'compact_boundary'},
      {type:'user',isCompactSummary:true,message:{role:'user',content:'摘要：'+'要点'.repeat(500)}},
      {type:'assistant',message:{usage:usage(6000,0,30),content:[{type:'text',text:'继续'}]}}];
    fs.writeFileSync(file,j(after));
    const c=claudeBreakdown(file),cb=Object.fromEntries(c.parts.map(p=>[p.key,p.tokens]));
    assert.equal(c.total,6031);assert.ok(cb.summary>0 && cb.read===undefined,'only the summary and what follows remain');assert.equal(c.parts.reduce((a,p)=>a+p.tokens,0),6031);
    fs.writeFileSync(file,j([{type:'user',message:{content:'没有回答'}}]));assert.equal(claudeBreakdown(file),null,'nothing reported yet: no breakdown');
    // Codex: developer text is fixed overhead, outputs are matched by call, token_count gives the reported totals
    const item=payload=>({type:'response_item',payload}),count=(input,total)=>({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:input,total_tokens:total}}}});
    const codex=[item({type:'message',role:'developer',content:[{type:'input_text',text:'D'.repeat(4000)}]}),
      item({type:'message',role:'user',content:[{type:'input_text',text:'问题'}]}),
      item({type:'function_call',name:'shell',arguments:'{"cmd":"ls"}',call_id:'c1'}),count(3000,3050),
      item({type:'function_call_output',call_id:'c1',output:'y'.repeat(30000)}),
      item({type:'message',role:'assistant',content:[{type:'output_text',text:'完成'}]}),count(15000,15100)];
    const rollout=path.join(dir,'sessions','2026','10','19',`rollout-2026-10-19T10-00-00-${id}.jsonl`);fs.mkdirSync(path.dirname(rollout),{recursive:true});fs.writeFileSync(rollout,j(codex));
    const x=codexBreakdown(rollout),xb=Object.fromEntries(x.parts.map(p=>[p.key,p.tokens]));
    assert.equal(x.total,15100);assert.equal(x.parts.reduce((a,p)=>a+p.tokens,0),15100);
    assert.ok(xb.fixed>2900 && xb.fixed<3100,'fixed: '+xb.fixed);assert.ok(xb.output>11000 && xb.output<12500,'tool output: '+xb.output);assert.equal(xb.reasoning,undefined);
    fs.writeFileSync(rollout,j([...codex,{type:'compacted',payload:{replacement_history:[item({type:'message',role:'user',content:[{type:'input_text',text:'压缩后的开头'}]}).payload]}},count(2000,2100)]));
    const y=codexBreakdown(rollout);assert.equal(y.total,2100);assert.ok(!y.parts.some(p=>p.key==='output'),'history before a compaction is not counted');
    // locating the transcripts
    const projects=path.join(dir,'projects','p');fs.mkdirSync(projects,{recursive:true});fs.writeFileSync(path.join(projects,id+'.jsonl'),'{}\n');
    assert.equal(claudeTranscript(id,dir),path.join(projects,id+'.jsonl'));assert.equal(claudeTranscript('not-an-id',dir),null);assert.equal(claudeTranscript(randomUUID(),dir),null);
    assert.equal(codexTranscript(id,dir),rollout);assert.equal(codexTranscript(randomUUID(),dir),null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('after a work turn the session keeps the native transcript breakdown; a missing transcript clears it',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run in an isolated copy');
  const made=[],id=randomUUID(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctx-session-')),old=process.env.CLAUDE_CONFIG_DIR;
  const sessionOf=job=>read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id);
  try {
    process.env.CLAUDE_CONFIG_DIR=dir;fs.mkdirSync(path.join(dir,'projects','p'),{recursive:true});
    const usage=(c,r,o)=>({input_tokens:1,cache_creation_input_tokens:c,cache_read_input_tokens:r,output_tokens:o});
    fs.writeFileSync(path.join(dir,'projects','p',id+'.jsonl'),[{type:'user',message:{content:'问'}},{type:'assistant',message:{usage:usage(3000,0,20),content:[{type:'text',text:'答'}]}}].map(l=>JSON.stringify(l)).join('\n')+'\n');
    const job=submit({text:'@claude 看看上下文构成'});made.push(job);
    await execute(job.task_id,async()=>({result:'好',sessionId:id}));
    const c=sessionOf(job).context.claude;assert.equal(c.tokens,3021);assert.equal(c.parts.reduce((a,p)=>a+p.tokens,0),3021);assert.ok(c.parts_at);
    const again=submit({text:'@claude 再来一轮',session_id:job.session_id});made.push(again);
    await execute(again.task_id,async()=>({result:'好',sessionId:randomUUID()}));
    const d=sessionOf(job).context.claude;assert.equal(d.parts,undefined,'a turn without a readable transcript leaves no stale breakdown');
  } finally {
    if(old===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=old;fs.rmSync(dir,{recursive:true,force:true});
    const q=read('work/queue.json');q.items=q.items.filter(i=>!made.some(j=>j.task_id===i.id));write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>!made.some(j=>j.session_id===i.id));write('.runtime/agent/sessions.json',s);
  }
});

test('live stream events are saved in batches: a burst causes no per-event store write, and nothing is lost, reordered or re-timed',async()=>{
  const sessionsFile=path.join(root,'.runtime/agent/sessions.json');
  const job=submit({title:'事件合并落盘',text:'@Codex 事件合并落盘验收',model:'sonnet'});
  const before=read('.runtime/agent/sessions.json');
  const realRename=fs.renameSync;let renames=0;
  fs.renameSync=function(from,to,...rest){if(path.resolve(String(to))===sessionsFile)renames++;return realRename.call(this,from,to,...rest);};
  try {
    let atBurst;
    await execute(job.task_id,async(provider,prompt,opts)=>{
      const start=renames;
      for(let i=0;i<300;i++){
        opts.onEvent({type:'tool',tool_id:'t'+i,name:'Bash',summary:'命令'+i});
        opts.onEvent({type:'tool_progress',tool_id:'t'+i,elapsed_seconds:i});
        opts.onEvent({type:'tool_end',tool_id:'t'+i,status:'completed'});
        opts.onEvent({type:'context',tokens:1000+i});
        opts.onEvent({type:'text',text:'中途说明'+i});
      }
      atBurst=renames-start; // a synchronous burst of 1500 events must not write the store per event
      return {result:'完成',sessionId:'fake'};
    });
    assert.ok(atBurst<=1,`1500 events caused ${atBurst} store writes`);
    const saved=read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id);
    const interim=saved.messages.filter(m=>m.interim).map(m=>m.text);
    assert.deepEqual(interim,Array.from({length:300},(_,i)=>'中途说明'+i),'interim text keeps every message in order');
    assert.equal(saved.context.codex.tokens,1299,'latest context length wins');
    assert.equal(saved.activity.filter(e=>e.type==='tool').length,12,'activity keeps only the newest 12 entries the board can show');
    const last=saved.activity.findLast(e=>e.type==='tool');assert.equal(last.tool_id,'t299');assert.equal(last.status,'completed');
    assert.ok(Date.parse(last.at)<=Date.now()&&Date.parse(last.at)>=Date.parse(saved.created_at||'2000-01-01'),'events keep the time they happened');
  } finally {
    fs.renameSync=realRename;
    const q=read('work/queue.json');q.items=q.items.filter(i=>i.id!==job.task_id);write('work/queue.json',q);
    const s=read('.runtime/agent/sessions.json');s.sessions=s.sessions.filter(i=>i.id!==job.session_id);write('.runtime/agent/sessions.json',s);
  }
});

test('a launched sub-agent becomes a call and a result event, and its midway words carry the call id', () => {
  const events=[],run=newRun('sonnet'),options={onEvent:e=>events.push(e)};
  foldEvent(run,{type:'assistant',message:{content:[{type:'tool_use',id:'toolu_A',name:'Agent',input:{description:'查文件',prompt:'读 a.txt 并概括',subagent_type:'general-purpose'}}]}},options);
  foldEvent(run,{type:'assistant',parent_tool_use_id:'toolu_A',message:{content:[{type:'text',text:'我先看看'}]}},options);
  foldEvent(run,{type:'assistant',parent_tool_use_id:'toolu_A',message:{content:[{type:'tool_use',id:'toolu_B',name:'Read',input:{file_path:'a.txt'}}]}},options);
  foldEvent(run,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_A',content:[{type:'text',text:'概括：很短'}]}]}},options);
  const call=events.find(e=>e.type==='subagent_call');
  assert.deepEqual([call.tool_id,call.title,call.prompt,call.kind],['toolu_A','查文件','读 a.txt 并概括','general-purpose']);
  assert.deepEqual(events.find(e=>e.type==='text'),{type:'text',text:'我先看看',sub:true,parent:'toolu_A'});
  assert.equal(events.filter(e=>e.type==='subagent_call').length,1,'its own tool calls are not sub-agent calls');
  assert.deepEqual(events.find(e=>e.type==='subagent_result'),{type:'subagent_result',tool_id:'toolu_A',status:'completed',text:'概括：很短'});
});

test('a background sub-agent stays running after its launch receipt and finishes on its completion notice', () => {
  const events=[],run=newRun('sonnet'),options={onEvent:e=>events.push(e)};
  foldEvent(run,{type:'assistant',message:{content:[{type:'tool_use',id:'toolu_BG',name:'Agent',input:{description:'后台筛选',prompt:'筛 chunk 10',run_in_background:true}}]}},options);
  foldEvent(run,{type:'system',subtype:'task_started',task_type:'local_agent',task_id:'agent-1',tool_use_id:'toolu_BG',is_backgrounded:true},options);
  foldEvent(run,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_BG',content:'Async agent launched successfully. (internal)'}]}},options);
  assert.equal(events.filter(e=>e.type==='subagent_result').length,0,'the launch receipt is not a result');
  foldEvent(run,{type:'system',subtype:'task_notification',task_id:'agent-1',tool_use_id:'toolu_BG',status:'completed',summary:'筛完 100 篇'},options);
  assert.deepEqual(events.find(e=>e.type==='subagent_result'),{type:'subagent_result',tool_id:'toolu_BG',status:'completed',text:'筛完 100 篇'});
});

test('max_active_agents caps simultaneously running agent tasks; the rest stay queued and start once a slot frees',async()=>{
  const config=read('agent/config.json'),files=['work/queue.json','.runtime/agent/sessions.json'],before=Object.fromEntries(files.map(f=>[f,read(f)]));
  try {
    write('agent/config.json',{...config,enabled:true,max_active_agents:2});
    const jobs=[1,2,3,4].map(n=>submit({text:'@Claude cap fixture '+n}));
    let running=0,peak=0,started=0,release;const gate=new Promise(r=>{release=r;setTimeout(r,5000).unref();}); // never wait forever if an assertion fails first
    const runner=async(_,prompt,opts)=>{
      if(opts.purpose==='title')return {result:''};
      started++;running++;peak=Math.max(peak,running);await gate;running--;return {result:'ok'};
    };
    const first=drain(runner);
    // Turn start awaits the asynchronous memory retrieval, so wait for the slots to fill, then leave time for a third task to wrongly start.
    for(const end=Date.now()+30000;started<2 && Date.now()<end;)await new Promise(r=>setTimeout(r,50));
    await new Promise(r=>setTimeout(r,300));
    assert.equal(started,2,'only two tasks may run at the cap');
    const status=id=>read('work/queue.json').items.find(i=>i.id===id).status;
    assert.equal(jobs.filter(j=>status(j.task_id)==='queued').length,2);
    release();await first;
    assert.ok(peak<=2);
    await drain(runner);await drain(runner);
    assert.equal(jobs.filter(j=>status(j.task_id)==='done').length,4,'queued tasks run after slots free');
    assert.ok(peak<=2);
  } finally {for(const [f,data] of Object.entries(before))write(f,data);write('agent/config.json',config);}
});
