import { launchEdge } from '../automation/browser-launch.mjs';
import test from 'node:test';
// The page tests write the plan, the review, the queue and a project's log in the tree they live in: only run them in the throw-away copy.
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, read, write } from '../automation/files.mjs';
import { weekWindow, planningWeek, exportWeek, addIntent, updateIntent, removeIntent, tick, weekView, weeklySnapshot, saveReview, markdown, planningContext, previewPlan, applyPlan } from './run.mjs';
import { route } from '../agent/run.mjs';
import { update } from '../work/run.mjs';
import { chicagoDay, addEvent, calendarData, calendarItems } from '../calendar/run.mjs';

test('DeepSeek project goals become assistant todos without occupying the user calendar',()=>{
 const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),queue=read('work/queue.json');
 const file=path.join(root,`.runtime/weekly/${week}/plan.json`),before=fs.existsSync(file)?fs.readFileSync(file):null;
 const framework=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),original=fs.readFileSync(framework);
 try {
  fs.writeFileSync(framework,'## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261008-99 虚构分析记录\n<!--node {"date":"2026-10-08","date_confirmed":true}-->\n');
  write('work/queue.json',{...queue,items:[]});
  const request={week,availability:[],goals:[{key:'deepseek-work',project_id:'graphene-thz',node_id:'T-20261008-99',kind:'data',actor:'deepseek',title:'分析虚构数据',reason:'用户交给 DeepSeek'}]};
  const preview=previewPlan(request,now);assert.equal(preview.allocation[0].status,'assistant');
  assert.equal(read('work/queue.json').items.length,0,'preview never queues');
  const applied=applyPlan(request,now),task=read('work/queue.json').items.find(t=>t.id===applied.plan.intents[0].task_id);
  assert.equal(task.actor,'deepseek');assert.equal(task.status,'queued');
  assert.equal(applied.allocation[0].schedule,null);assert.equal(applied.capacity.requested_minutes,0);
  assert.ok(weekView(week).facts.ai_usage.some(u=>u.provider==='deepseek'));
 } finally {write('work/queue.json',queue);fs.writeFileSync(framework,original);if(before)fs.writeFileSync(file,before);else fs.rmSync(file,{force:true});}
});

test('only bare weekly export commands bypass the assistant, never changes to planning rules',()=>{
  for(const command of ['生成周计划','整理组会材料','更新周复盘！'])assert.equal(route(command).provider,'program');
  for(const message of ['周末生成的周计划应该是下周的，这个改改','修改周计划生成规则','生成下周周计划','生成周计划？']) {
    assert.equal(route(message,{last:'claude'}).provider,'claude',message);
  }
  assert.equal(route('@Codex 生成周计划').provider,'codex');
});

test('weekend planning selects next Monday in Chicago across midnight, DST and year boundaries',()=>{
  for(const [instant,expected] of [
    ['2026-10-17T04:59:59Z','2026-10-12'], // Still Friday in Chicago, despite UTC Saturday.
    ['2026-10-17T05:00:00Z','2026-10-19'],
    ['2026-10-18T21:00:00Z','2026-10-19'],
    ['2026-10-19T04:59:59Z','2026-10-19'],
    ['2026-10-19T05:00:00Z','2026-10-19'],
    ['2026-11-01T07:30:00Z','2026-11-02'], // DST fallback Sunday.
    ['2026-03-08T08:30:00Z','2026-03-09'], // DST spring-forward Sunday.
    ['2027-01-02T18:00:00Z','2027-01-04']
  ])assert.equal(planningWeek(new Date(instant)).start,expected,instant);
  assert.equal(weekWindow(new Date('2026-10-17T21:00:00Z')).start,'2026-10-12','actual-week accounting does not move');
});

test('weekend export files, planning context and HTTP defaults agree, explicit weeks and stored records stay unchanged',async t=>{
  const {createServer}=await import('../dashboard/server.mjs');
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-17T21:00:00Z')});
  const weeks=['2026-10-05','2026-10-12','2026-10-19'],server=createServer();
  try {
    for(const week of weeks){addIntent({week,title:'目标 '+week,project_ids:[]});saveReview({week,summary:'总结 '+week});}
    const files=weeks.flatMap(week=>['plan.json','review.json'].map(name=>path.join(root,'.runtime/weekly',week,name)));
    const before=files.map(file=>fs.readFileSync(file));
    assert.equal(planningContext().week.start,'2026-10-19');
    assert.equal(planningContext('2026-10-12').week.start,'2026-10-12');
    for(const instant of ['2026-10-17T21:00:00Z','2026-10-18T21:00:00Z']) {
      const generated=exportWeek(new Date(instant));
      assert.equal(generated.files.plan,'.runtime/weekly/2026-10-19/plan.md');
      assert.match(fs.readFileSync(path.join(root,generated.files.plan),'utf8'),/^# 周计划 · 2026-10-19 — 2026-10-25/);
      assert.equal(generated.files.review,'.runtime/weekly/2026-10-05/meeting-outline.md','review convention is unchanged');
    }
    assert.equal(exportWeek(new Date('2026-10-16T21:00:00Z')).files.plan,'.runtime/weekly/2026-10-12/plan.md');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const [url,title] of [['/api/export/plan','# 周计划 · 2026-10-19 — 2026-10-25'],['/api/export/plan?week=2026-10-12','# 周计划 · 2026-10-12 — 2026-10-18'],['/api/export/review','# 组会材料 · 2026-10-05 — 2026-10-11']]) {
      const response=await fetch(base+url);assert.equal(response.status,200);assert.ok((await response.text()).startsWith(title),url);
    }
    files.forEach((file,i)=>assert.ok(fs.readFileSync(file).equals(before[i]),'exports never rewrite '+file));
  } finally {
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    t.mock.timers.reset();
    for(const week of weeks)fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('project proposal becomes one weekly plan and calendar projection: avoids bookings, repeated runs preserve edits, and refusal writes nothing',()=>{
  const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),file=`.runtime/weekly/${week}/plan.json`,queue=read('work/queue.json');
  const ledger=path.join(root,'calendar/events.json'),ledgerBefore=fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
  try {
    const task={id:'planning-fixture',title:'整理实际项目资料',project_ids:['graphene-thz'],status:'queued',due_at:'2026-10-12T10:30:00-05:00'};
    write('work/queue.json',{...queue,items:[task,{...task,id:'blocked-fixture',dependencies:['absent-fixture']}]});
    const manual=addIntent({week,title:'保留手动目标',project_ids:[]});saveReview({week,summary:'保留人工总结'});
    const before=fs.readFileSync(path.join(root,file)),queueBefore=fs.readFileSync(path.join(root,'work/queue.json'));
    addEvent({title:'已有预约',start:'2026-10-12T09:00',end:'2026-10-12T10:00'});
    const eventsBefore=fs.readFileSync(ledger),reviewBefore=fs.readFileSync(path.join(root,`.runtime/weekly/${week}/review.json`));
    const goals=[{key:'organise',project_id:'graphene-thz',task_id:task.id,title:'整理资料',expected:'对照图',reason:'来源于当前任务',minutes:30},
      {key:'blocked',project_id:'graphene-thz',task_id:'blocked-fixture',title:'下一步',reason:'待前置',minutes:30}];
    const request={week,availability:[{start:'2026-10-12T09:00',end:'2026-10-12T12:00'}],goals};
    planningContext(week);const preview=previewPlan(request,now);
    assert.ok(fs.readFileSync(path.join(root,file)).equals(before),'context/preview do not write');
    assert.deepEqual(preview.allocation.map(a=>a.status),['scheduled','unscheduled']);
    assert.match(preview.allocation[1].reason,/前置步骤/);
    const applied=applyPlan(request,now),scheduled=applied.plan.intents.find(i=>i.task_id===task.id);
    assert.equal(scheduled.schedule.start,'2026-10-12T15:00:00.000Z');
    assert.equal(scheduled.schedule.end,'2026-10-12T15:30:00.000Z');
    assert.ok(applied.plan.intents.some(i=>i.id===manual.id));
    assert.equal(calendarItems(calendarData([],[],[])).items.filter(i=>i.source==='weekly' && i.week===week).length,1);
    applyPlan(request,now);assert.equal(read(file).intents.length,3,'second run creates no duplicates');
    updateIntent({week,id:scheduled.id,title:'手改目标',schedule:{start:'2026-10-12T11:00',end:'2026-10-12T11:30'}});
    applyPlan(request,now);assert.equal(read(file).intents.find(i=>i.id===scheduled.id).title,'手改目标');
    assert.equal(read(file).intents.find(i=>i.id===scheduled.id).schedule.start,'2026-10-12T16:00:00.000Z');
    updateIntent({week,id:scheduled.id,schedule:null});applyPlan(request,now);
    assert.equal(calendarItems(calendarData([],[],[])).items.filter(i=>i.source==='weekly' && i.week===week).length,0,'third run respects cancelled time');
    updateIntent({week,id:scheduled.id,schedule:'auto'});applyPlan(request,now);
    assert.ok(read(file).intents.find(i=>i.id===scheduled.id).schedule.start);
    const accepted=fs.readFileSync(path.join(root,file));
    for(const bad of [{...request,goals:[...goals,{...goals[0],key:'different'}]}, {...request,goals:[{...goals[0],task_id:null,node_id:'absent'}]},
      {...request,availability:[...request.availability,...request.availability]}])assert.throws(()=>applyPlan(bad,now));
    assert.throws(()=>updateIntent({week,id:scheduled.id,schedule:{start:'2026-10-12T09:30',end:'2026-10-12T10:30'}}),/冲突/);
    assert.throws(()=>applyPlan({...request,goals:[{...goals[0],task_id:'blocked-fixture'}]},now),/改绑/);
    addEvent({title:'结束时间未确认的预约',start:'2026-10-12T10:45'});
    assert.throws(()=>applyPlan(request,now),/缺少结束时间/);
    fs.writeFileSync(ledger,eventsBefore);
    assert.ok(fs.readFileSync(path.join(root,file)).equals(accepted));
    assert.ok(fs.readFileSync(ledger).equals(eventsBefore));assert.ok(fs.readFileSync(path.join(root,'work/queue.json')).equals(queueBefore));
    assert.ok(fs.readFileSync(path.join(root,`.runtime/weekly/${week}/review.json`)).equals(reviewBefore));
    assert.match(markdown(week,'plan',now),/工作块/);
    const carried=tick(new Date('2026-10-19T14:00:00Z')).plan;
    assert.ok(carried.intents.some(i=>i.id===scheduled.id));assert.ok(carried.intents.every(i=>!i.schedule),'carry goals without old dates');
    const absentTime=previewPlan({...request,availability:[]},now);assert.equal(absentTime.allocation[0].status,'unscheduled');
  } finally {
    write('work/queue.json',queue);
    ledgerBefore ? fs.writeFileSync(ledger,ledgerBefore) : fs.rmSync(ledger,{force:true});
    for(const start of [week,'2026-10-19'])fs.rmSync(path.join(root,'.runtime/weekly',start),{recursive:true,force:true});
  }
});

test('reading a legacy generated review gives editable user fields without rewriting the old file',()=>{
  const week='2026-09-28',file=path.join(root,'.runtime/weekly',week,'review.json');
  try {
    write(`.runtime/weekly/${week}/review.json`,{week,end:'2026-10-04',generated_at:'2026-10-05T14:00:00Z',completed:[],blocked:[]});
    const before=fs.readFileSync(file),view=weekView(week);
    assert.deepEqual(view.review,{week,summary:'',next_adjust:'',included:[],updated_at:null});
    markdown(week,'review');assert.ok(fs.readFileSync(file).equals(before));
    saveReview({week,summary:'后来写的总结',next_adjust:'下周调整'});
    assert.equal(weekView(week).review.summary,'后来写的总结');
    assert.equal(weekView(week).review.next_adjust,'下周调整');
  } finally {fs.rmSync(path.dirname(file),{recursive:true,force:true});}
});

test('weekly completion facts include unplanned deliveries, use Chicago week boundaries, and exclude unfinished or unconfirmed work and plain chat',()=>{
  const queue=read('work/queue.json'),week='2026-10-12';
  const done=(id,completed_at,extra={})=>({id,title:id,project_ids:['graphene-thz'],status:'done',actor:'user',handoff:'实测结果',outputs:[],completed_at,...extra});
  try {
    write('work/queue.json',{...queue,items:[
      done('monday','2026-10-12T05:00:00Z'),done('sunday','2026-10-19T04:59:59Z'),
      done('previous','2026-10-12T04:59:59Z'),done('next','2026-10-19T05:00:00Z'),
      done('pending','2026-10-14T12:00:00Z',{review:{state:'pending',kind:'acceptance'}}),
      done('queued','2026-10-14T12:00:00Z',{status:'queued'}),done('no-time',null),
      done('chat-output','2026-10-14T12:00:00Z',{actor:'codex',executor:'codex',outputs:['fixture/result.svg']}),
      done('plain-chat','2026-10-14T12:00:00Z',{actor:'codex',executor:'codex'})
    ]});
    const before=fs.readFileSync(path.join(root,'work/queue.json')),facts=weekView(week).facts;
    assert.deepEqual(facts.completed.map(i=>i.id),['monday','sunday']);
    assert.deepEqual(facts.other.map(i=>i.id),['chat-output']);
    assert.equal(facts.handled,1);
    assert.ok(fs.readFileSync(path.join(root,'work/queue.json')).equals(before),'viewing completions never writes task data');
  } finally {write('work/queue.json',queue);}
});

test('carry-over preserves different projects and expected outputs, but never duplicates a renamed stable id',()=>{
  const weeks=['2026-09-28','2026-10-05'],queue=read('work/queue.json');
  try {
    write('work/queue.json',{...queue,items:[]});
    const first=addIntent({week:weeks[0],title:'测量',project_ids:['graphene-thz'],expected:'响应图'});
    const other=addIntent({week:weeks[0],title:'测量',project_ids:['bi-devices'],expected:'电阻图'});
    const different=addIntent({week:weeks[0],title:'测量',project_ids:['graphene-thz'],expected:'噪声图'});
    const renamed=addIntent({week:weeks[0],title:'原名称',project_ids:[]});
    addIntent({week:weeks[1],title:first.title,project_ids:first.project_ids,expected:first.expected});
    write(`.runtime/weekly/${weeks[1]}/plan.json`,{week:weeks[1],intents:[...read(`.runtime/weekly/${weeks[1]}/plan.json`).intents,{...renamed,title:'新名称'}]});
    const opened=tick(new Date('2026-10-05T14:00:00Z')).plan;
    assert.equal(opened.carried,2);
    assert.ok(opened.intents.some(i=>i.id===other.id));assert.ok(opened.intents.some(i=>i.id===different.id));
    assert.equal(opened.intents.filter(i=>i.id===renamed.id).length,1);
    assert.equal(opened.intents.find(i=>i.id===renamed.id).title,'新名称');
    assert.equal(tick(new Date('2026-10-05T15:00:00Z')),null);
    updateIntent({week:weeks[1],id:renamed.id,title:'又改名称'});
    assert.equal(tick(new Date('2026-10-06T15:00:00Z')),null);
  } finally {
    write('work/queue.json',queue);
    for(const week of weeks)fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('research record numbers are project-local: matching T ids both appear and selecting one exports only that project',()=>{
  const projects=['graphene-thz','bi-devices'],files=projects.map(p=>path.join(root,'workspace/projects',p,'FRAMEWORK.md'));
  const before=files.map(f=>fs.existsSync(f) ? fs.readFileSync(f) : null),week='2026-10-05';
  try {
    for(const [n,file] of files.entries()) {
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,`## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261006-01 Result ${projects[n]}\n<!--node {"date":"2026-10-06","date_confirmed":true}-->\n- 来源与性质：用户转述，未核原始数据\n`);
    }
    const candidates=weekView(week).research.candidates.filter(c=>c.id==='T-20261006-01');
    assert.deepEqual(candidates.map(c=>c.key).sort(),projects.map(p=>p+':T-20261006-01').sort());
    saveReview({week,included:['bi-devices:T-20261006-01']});
    const report=markdown(week,'review');
    assert.match(report,/Result bi-devices/);assert.ok(!report.includes('Result graphene-thz'));
    assert.throws(()=>saveReview({week,included:['T-20261006-01']}),/须带项目/);
  } finally {
    files.forEach((file,n)=>before[n] ? fs.writeFileSync(file,before[n]) : fs.rmSync(file,{force:true}));
    fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('the plan total is checked against the calendar: free time after existing events, a reported shortfall, goals outside the proposal, and minutes kept on the goal',()=>{
  const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),file=`.runtime/weekly/${week}/plan.json`,queue=read('work/queue.json');
  const ledger=path.join(root,'calendar/events.json'),ledgerBefore=fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
  try {
    const task=id=>({id,title:'任务 '+id,project_ids:['graphene-thz'],status:'queued'});
    write('work/queue.json',{...queue,items:['a','b','c','d'].map(task)});
    addEvent({title:'已有预约',start:'2026-10-12T10:00',end:'2026-10-12T10:30'});
    const left=addIntent({week,title:'此前顺延的目标',project_ids:['graphene-thz']});
    const goal=(id,minutes)=>({key:'goal-'+id,project_id:'graphene-thz',task_id:id,title:'目标 '+id,reason:'测试',...(minutes ? {minutes} : {})});
    // 09:00–12:00 is 180 minutes, the 10:00–10:30 booking takes 30: 150 are free in gaps of 60 and 90. Three goals of 60 ask for 180.
    const request={week,availability:[{start:'2026-10-12T09:00',end:'2026-10-12T12:00'}],goals:[goal('a',60),goal('b',60),goal('c',60)]};
    const preview=previewPlan(request,now),c=preview.capacity;
    assert.deepEqual([c.available_minutes,c.free_minutes,c.largest_free_gap_minutes,c.requested_minutes,c.scheduled_minutes,c.shortfall_minutes],[180,150,90,180,120,30]);
    assert.deepEqual(preview.allocation.map(a=>a.status),['scheduled','scheduled','unscheduled']);
    assert.match(preview.allocation[2].reason,/不足/);
    assert.ok(preview.warnings.some(w=>/缺 30 分钟/.test(w)),'the shortfall is stated, with its size');
    assert.deepEqual(c.not_in_proposal.map(i=>i.id),[left.id],'a goal this proposal does not mention is listed, not left hanging');
    assert.ok(preview.warnings.some(w=>/不在这次方案里/.test(w)));
    assert.ok(read(file).intents.every(i=>i.minutes===undefined),'preview stores no estimate');
    const applied=applyPlan(request,now);
    assert.deepEqual(applied.plan.intents.filter(i=>i.minutes).map(i=>i.minutes),[60,60,60],'the estimate is kept on each goal');
    // A later proposal that leaves the estimate out reuses the stored one instead of treating the goal as unestimated.
    const again=previewPlan({...request,goals:[{...goal('a')},goal('b',60)]},now);
    assert.equal(again.allocation[0].status,'scheduled');assert.equal(again.capacity.requested_minutes,120);assert.equal(again.capacity.shortfall_minutes,0);
    assert.equal(previewPlan({...request,availability:[],goals:[goal('a',60)]},now).capacity.available_minutes,0);
    assert.equal(previewPlan({...request,goals:[goal('d',60)]},now).capacity.not_in_proposal.length,4,'earlier goals count as outside a proposal that omits them');
  } finally {
    write('work/queue.json',queue);
    ledgerBefore ? fs.writeFileSync(ledger,ledgerBefore) : fs.rmSync(ledger,{force:true});
    fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('abnormal paths: a finished, cancelled or deleted goal hands its time back and is not carried; a failed one is carried and named; a due date before every window is named; a skipped week drops nothing',()=>{
  const W1='2026-10-12',W2='2026-10-19',W4='2026-11-02',now=new Date('2026-10-09T15:00:00Z'),queue=read('work/queue.json');
  const task=id=>({id,title:'任务 '+id,project_ids:['graphene-thz'],status:'open'});
  const patch=(id,extra)=>write('work/queue.json',{...read('work/queue.json'),items:read('work/queue.json').items.map(i=>i.id===id ? {...i,...extra} : i)});
  const goal=id=>({key:'g-'+id,project_id:'graphene-thz',task_id:id,title:'目标 '+id,reason:'测试',minutes:60});
  const win=(d,a,b)=>({start:`${d}T${a}`,end:`${d}T${b}`}),look=(week,d,goals=[])=>previewPlan({week,availability:[win(d,'09:00','12:00')],goals},now);
  try {
    write('work/queue.json',{...queue,items:['a','b','c'].map(task)});
    applyPlan({week:W1,availability:[win('2026-10-12','09:00','12:00')],goals:['a','b','c'].map(goal)},now);
    assert.equal(look(W1,'2026-10-12').capacity.free_minutes,0,'three 60-minute blocks fill the window');
    patch('a',{status:'done'});assert.equal(look(W1,'2026-10-12').capacity.free_minutes,60,'a finished goal hands its hour back');
    patch('b',{deleted_at:new Date().toISOString()});assert.equal(look(W1,'2026-10-12').capacity.free_minutes,120,'so does a deleted one');
    patch('c',{status:'cancelled'});assert.equal(look(W1,'2026-10-12').capacity.free_minutes,180,'and a cancelled one');
    assert.equal(tick(new Date('2026-10-19T14:30:00Z')).plan.carried,0,'finished, deleted and cancelled goals are not carried');
    // a failed task is carried on purpose and planning names it
    fs.rmSync(path.join(root,'.runtime/weekly',W2),{recursive:true,force:true});
    patch('c',{status:'failed'});
    assert.deepEqual(tick(new Date('2026-10-19T14:30:00Z')).plan.intents.map(i=>i.title),['目标 c']);
    assert.ok(look(W2,'2026-10-19').warnings.some(w=>/已不在或已失败：目标 c/.test(w)));
    // a deadline that falls before every working window is the stated reason, not a shortage of long gaps
    patch('c',{status:'open',due_at:'2026-10-19T08:00:00-05:00'});
    const due=look(W2,'2026-10-19',[goal('c')]);
    assert.equal(due.allocation[0].status,'unscheduled');assert.match(due.allocation[0].reason,/早于所有可工作时段/);
    assert.ok(!due.warnings.some(w=>/最大的连续空闲/.test(w)),'the shortage warning is not blamed for a deadline');
    // a week that was never opened: the next one carries from the latest plan that exists
    patch('c',{due_at:null});
    assert.equal(tick(new Date('2026-11-02T15:30:00Z')).plan.carried,1);
    // a goal whose task was deleted gets an actionable refusal
    assert.throws(()=>applyPlan({week:W1,availability:[],goals:[goal('b')]},now),/请先移除该目标/);
  } finally {
    write('work/queue.json',queue);
    for(const week of [W1,W2,'2026-10-26',W4])fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('the plan holds todos only: applying promotes a not-started task, an assistant task is announced as running, a started one is left alone, and removing a goal gives back an unstarted todo',()=>{
  const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),queue=read('work/queue.json');
  const task=(id,actor,status)=>({id,title:'任务 '+id,project_ids:['graphene-thz'],actor,status});
  const items=()=>read('work/queue.json').items,statuses=()=>Object.fromEntries(items().map(t=>[t.id,t.status])),plan=()=>read(`.runtime/weekly/${week}/plan.json`);
  const goal=id=>({key:'g-'+id,project_id:'graphene-thz',task_id:id,title:'目标 '+id,reason:'测试',minutes:30}),request={week,availability:[],goals:[goal('u'),goal('x')]};
  try {
    write('work/queue.json',{...queue,items:[task('u','user','open'),task('x','codex','open'),task('s','codex','active')]});
    const preview=previewPlan(request,now);
    assert.deepEqual(preview.queueing.promoted_to_todo.map(t=>t.id),['u','x']);
    assert.deepEqual(preview.queueing.will_run,['任务 x'],'only the assistant task is announced as running; the user task is just listed');
    assert.ok(preview.warnings.some(w=>/立刻开跑/.test(w)));
    assert.deepEqual(statuses(),{u:'open',x:'open',s:'active'},'a preview queues nothing');
    applyPlan(request,now);
    assert.deepEqual(statuses(),{u:'queued',x:'queued',s:'active'});
    assert.ok(plan().intents.every(i=>i.queued_by_plan));
    applyPlan({...request,goals:[goal('s')]},now);
    assert.equal(statuses().s,'active','a task that already runs is left alone');
    assert.equal(plan().intents.find(i=>i.task_id==='s').queued_by_plan,undefined,'and the plan did not queue it');
    // leaving the plan: an unstarted todo that the plan queued goes back to not-started; a started one, or one the plan did not queue, stays
    const by=id=>plan().intents.find(i=>i.task_id===id).id;
    assert.equal(removeIntent({week,id:by('u')}).released,true);assert.equal(statuses().u,'open');
    write('work/queue.json',{...read('work/queue.json'),items:items().map(t=>t.id==='x' ? {...t,status:'active'} : t)});
    assert.equal(removeIntent({week,id:by('x')}).released,false);assert.equal(statuses().x,'active','a started task keeps running');
    assert.equal(removeIntent({week,id:by('s')}).released,false);assert.equal(statuses().s,'active');
  } finally {
    write('work/queue.json',queue);
    fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('with many not-started tasks: an assistant takes no calendar time, a blocked chain names its root, immediate and later runs are told apart, and an autonomous step is refused before anything is written',()=>{
  const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),queue=read('work/queue.json');
  const task=(id,actor,status,extra={})=>({id,title:'任务 '+id,project_ids:['graphene-thz'],actor,status,...extra});
  const goal=(id,minutes=60)=>({key:'g-'+id,project_id:'graphene-thz',task_id:id,title:'目标 '+id,reason:'测试',minutes});
  const queueBytes=()=>fs.readFileSync(path.join(root,'work/queue.json')),win={start:'2026-10-12T09:00',end:'2026-10-12T17:00'};
  try {
    write('work/queue.json',{...queue,items:[task('root','user','failed'),task('mid','user','open',{dependencies:['root']}),task('tail','claude','open',{dependencies:['mid']}),
      task('free','claude','open'),task('mine','user','open'),task('idle','user','open'),task('after-idle','claude','open',{dependencies:['idle']}),
      task('auto','user','open',{autonomy:{type:'step'}})]});
    // The assistant's goal is neither placed nor counted: 480 free minutes, one 60-minute task of the user's, one 240-minute task of the assistant's.
    const p=previewPlan({week,availability:[win],goals:[goal('mine'),goal('free',240)]},now);
    assert.deepEqual(p.allocation.map(a=>a.status),['scheduled','assistant']);
    assert.deepEqual([p.capacity.requested_minutes,p.capacity.scheduled_minutes,p.capacity.free_minutes],[60,60,480],'only the user\'s time is counted');
    assert.deepEqual(p.queueing.starts_now,['任务 free']);
    // A chain whose root failed: the root is named, and the reason shows titles with states, not bare ids.
    const chain=previewPlan({week,availability:[win],goals:[goal('mid'),goal('tail')]},now);
    assert.ok(chain.warnings.some(w=>/永远不会就绪：任务 root（failed）/.test(w)));
    assert.match(chain.allocation[0].reason,/任务 root（failed）/);
    assert.deepEqual(chain.queueing.after_prerequisites,['任务 tail'],'an assistant step behind a prerequisite is queued but does not start yet');
    assert.deepEqual(chain.queueing.starts_now,[]);
    // A prerequisite that is not started and not in the proposal will not start by itself.
    const idle=previewPlan({week,availability:[win],goals:[goal('after-idle')]},now);
    assert.ok(idle.warnings.some(w=>/不会自己开始：任务 idle/.test(w)));
    assert.ok(!previewPlan({week,availability:[win],goals:[goal('idle'),goal('after-idle')]},now).warnings.some(w=>/不会自己开始/.test(w)),'with the prerequisite in the plan there is nothing to warn');
    // A step from the autonomous planner can only be queued from the user's own chat: refused up front, nothing half-done.
    const before=queueBytes();
    assert.throws(()=>applyPlan({week,availability:[win],goals:[goal('mine'),goal('auto')]},now),/来自自主规划/);
    assert.ok(queueBytes().equals(before),'no task was promoted before the refusal');
    assert.ok(!fs.existsSync(path.join(root,`.runtime/weekly/${week}/plan.json`)));
  } finally {
    write('work/queue.json',queue);
    fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('the planning context carries each project\'s index, not its text: ids and titles are there for the goals to cite, bodies are read on demand',()=>{
  const framework=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),before=fs.existsSync(framework) ? fs.readFileSync(framework) : null;
  try {
    fs.mkdirSync(path.dirname(framework),{recursive:true});
    fs.writeFileSync(framework,'## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261008-90 今天测到的结果\n<!--node {"date":"2026-10-08","date_confirmed":true}-->\n- 正文独有的一句：BODY-ONLY-MARKER\n');
    const context=planningContext('2026-10-12'),graphene=context.projects.find(p=>p.id==='graphene-thz');
    assert.ok(!('framework' in graphene),'the whole tree is not sent');
    assert.match(graphene.framework_digest,/T-20261008-90 今天测到的结果/,'the log index names the record, so a goal can cite its node id');
    assert.match(graphene.framework_digest,/projects read-nodes graphene-thz#/,'and says how to read the text when it is needed');
    assert.ok(!JSON.stringify(context).includes('BODY-ONLY-MARKER'),'the record body stays out until it is asked for');
  } finally {before ? fs.writeFileSync(framework,before) : fs.rmSync(framework,{force:true});}
});

test('a goal without a task gets one todo filed by the program, once; a refused plan writes nothing; the goal state and calendar tick follow the task',()=>{
  const week='2026-10-12',now=new Date('2026-10-08T15:00:00Z'),planPath=path.join(root,`.runtime/weekly/${week}/plan.json`),queue=read('work/queue.json');
  const framework=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),frameworkBefore=fs.existsSync(framework) ? fs.readFileSync(framework) : null;
  const ledger=path.join(root,'calendar/events.json'),ledgerBefore=fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
  const queueBytes=()=>fs.readFileSync(path.join(root,'work/queue.json')),items=()=>read('work/queue.json').items,state=id=>weekView(week).plan.intents.find(i=>i.id===id).task_status;
  try {
    write('work/queue.json',{...queue,items:[]});
    fs.mkdirSync(path.dirname(framework),{recursive:true});
    fs.writeFileSync(framework,'## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261008-90 今天测到的结果\n<!--node {"date":"2026-10-08","date_confirmed":true}-->\n- 来源与性质：用户转述\n');
    const goal={key:'new-goal',project_id:'graphene-thz',node_id:'T-20261008-90',kind:'experiment',title:'测 THz 响应',expected:'响应图',reason:'来自日志',minutes:30};
    const request={week,availability:[{start:'2026-10-12T09:00',end:'2026-10-12T12:00'}],goals:[goal]};
    const before=queueBytes();
    const preview=previewPlan(request,now);
    assert.equal(preview.queueing.new_todos.length,1);assert.equal(preview.queueing.new_todos[0].actor,'user','the policy gives an experiment to the user');assert.deepEqual(preview.queueing.will_run,[],'a todo of the user is only listed, never run');
    assert.ok(queueBytes().equals(before) && !fs.existsSync(planPath),'preview writes nothing');
    for(const bad of [{...request,goals:[{...goal,kind:'nope'}]},{...request,goals:[{...goal,kind:undefined}]},{...request,goals:[{...goal,actor:'robot'}]},
      {...request,goals:Array.from({length:31},(_,n)=>({...goal,key:'g'+n}))}])assert.throws(()=>applyPlan(bad,now),/kind|actor|最多 30/);
    assert.ok(queueBytes().equals(before) && !fs.existsSync(planPath),'a refused plan writes neither a task nor a plan');
    const applied=applyPlan(request,now),intent=applied.plan.intents[0],task=items().find(t=>t.id===intent.task_id);
    assert.equal(items().length,1);
    assert.equal(task.status,'queued','filed as a todo: the plan holds todos only');
    assert.deepEqual([task.kind,task.actor,task.project_ids],['experiment','user',['graphene-thz']]);
    assert.ok(task.sources.includes('weekly:graphene-thz:new-goal'));assert.match(task.goal,/预期产出：响应图/);
    assert.equal(state(intent.id),'queued');
    assert.ok(read(`.runtime/weekly/${week}/plan.json`).intents.every(i=>!('task_status' in i)),'the state is read from the task, never stored in the plan');
    applyPlan(request,now);assert.equal(items().length,1,'a rerun reuses the step');assert.equal(read(`.runtime/weekly/${week}/plan.json`).intents[0].task_id,task.id);
    fs.rmSync(planPath);applyPlan(request,now);assert.equal(items().length,1,'a step left by an interrupted run is reused');assert.equal(read(`.runtime/weekly/${week}/plan.json`).intents[0].task_id,task.id);
    const block=()=>calendarItems(calendarData([],items(),[])).items.find(i=>i.source==='weekly' && i.intent_id===intent.id);
    assert.equal(block().done,false);
    update({id:task.id,status:'active'});assert.equal(state(intent.id),'active','the goal carries its task own status');
    update({id:task.id,status:'done',handoff:'已测完'});assert.equal(state(intent.id),'done');assert.equal(block().done,true);
    write('work/queue.json',{...queue,items:[]});assert.equal(state(intent.id),'missing');
    const legacy=addIntent({week,title:'旧的自由文字目标',project_ids:[]});assert.equal(state(legacy.id),null);
    assert.equal(weeklySnapshot(new Date('2026-10-13T15:00:00Z')).plan.intents.find(i=>i.id===intent.id).task_status,'missing','the project page reads the same projection');
  } finally {
    write('work/queue.json',queue);
    frameworkBefore ? fs.writeFileSync(framework,frameworkBefore) : fs.rmSync(framework,{force:true});
    ledgerBefore ? fs.writeFileSync(ledger,ledgerBefore) : fs.rmSync(ledger,{force:true});
    fs.rmSync(path.join(root,'.runtime/weekly',week),{recursive:true,force:true});
  }
});

test('browser: the weekly page shows the calendar and the chat-made plan, opens seeded chats for the plan and the Monday PPT, and keeps goal edits by id', async () => {
  const { createServer } = await import('../dashboard/server.mjs');
  const start = weekWindow().start, today = chicagoDay(Date.now());
  const previous = new Date(Date.parse(start + 'T12:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const planFile = path.join(root, '.runtime/weekly', start, 'plan.json');
  const nextWeek = path.join(root, '.runtime/weekly', new Date(Date.parse(start + 'T12:00:00Z') + 7 * 86400000).toISOString().slice(0, 10));
  const plan = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const queue = read('work/queue.json'), sessions = read('.runtime/agent/sessions.json', { sessions: [] }), framework = path.join(root, 'workspace/projects/graphene-thz/FRAMEWORK.md');
  const frameworkBefore = fs.existsSync(framework) ? fs.readFileSync(framework) : null, runEnv = process.env.OFFICE_MEMORY_RUN_DIR;
  const turn = status => ({ id: 'chat-task-fixture', title: '生成周计划的对话轮', kind: 'framework', actor: 'claude', executor: 'claude', project_ids: [], goal: 'g', sources: [], dependencies: [],
    status, created_at: new Date().toISOString(), due_at: null, handoff: 'ok', outputs: [], session_id: null, ...(status === 'done' ? { completed_at: new Date().toISOString() } : {}) });
  fs.mkdirSync(path.dirname(framework), { recursive: true });
  fs.writeFileSync(framework, `## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261008-90 今天测到的结果\n<!--node {"date":"${today}","date_confirmed":true}-->\n- 发生时间：${today}\n- 来源与性质：用户转述，未核原始数据\n`);
  const server = createServer(); let browser, base;
  try {
    // A goal made while an assistant chat turn is running remembers that turn; a goal made by hand has none.
    const chatSession = { sessions: [{ id: 'weekly-chat-fixture', title: '生成周计划的对话', project_ids: [], created_at: new Date().toISOString(), origin: 'chat', task_ids: ['chat-task-fixture'],
      messages: [{ role: 'user', text: '排一下这周', at: new Date().toISOString(), task_id: 'chat-task-fixture' }] }] };
    write('.runtime/agent/sessions.json', chatSession);
    write('work/queue.json', { ...queue, items: [turn('active')] });
    process.env.OFFICE_MEMORY_RUN_DIR = path.join(root, '.runtime/agent/runs', 'chat-task-fixture', 'run');
    addIntent({ week: start, title: '测 THz 响应', expected: '响应图', project_ids: ['graphene-thz'] });
    applyPlan({ week: start, availability: [], goals: [{ key: 'chat-made', project_id: 'graphene-thz', node_id: 'T-20261008-90', kind: 'data', actor: 'user', title: '对话里生成的目标', reason: '来自对话' }] });
    if (runEnv === undefined) delete process.env.OFFICE_MEMORY_RUN_DIR; else process.env.OFFICE_MEMORY_RUN_DIR = runEnv;
    assert.equal(plan().intents[0].origin, undefined);
    assert.equal(plan().intents[1].origin.chat_task, 'chat-task-fixture');
    assert.equal(read('work/queue.json').items.find(i => i.id === plan().intents[1].task_id).status, 'queued', 'the program filed a todo for the goal');
    const filed = read('work/queue.json'); write('work/queue.json', { ...filed, items: [...filed.items.map(i => i.id === 'chat-task-fixture' ? turn('done') : i),
      {...turn('done'),id:'weekly-unplanned',title:'未排进计划的完成项 <样品>',executor:undefined,actor:'user',project_ids:['graphene-thz'],handoff:'结果 <已核对>',outputs:['fixture/'+('long-path-'.repeat(12))+'result.svg']},
      {...turn('done'),id:'weekly-chat-output',title:'对话留下的交付',outputs:['fixture/report.md']},
      {...turn('done'),id:'weekly-pending',title:'尚待验收的交付',review:{state:'pending',kind:'acceptance'}},
      ...Array.from({length:5},(_,n)=>({...turn('done'),id:'weekly-older-'+n,title:'更早完成项 '+n,executor:undefined,actor:'user',completed_at:start+'T05:00:00Z'}))
    ] });
    chatSession.sessions[0].task_ids.push('weekly-unplanned');write('.runtime/agent/sessions.json',chatSession);
    await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
    browser = await launchEdge();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.clock.install(); // keep the app's real 5 s poll, but jump to its next tick
    await page.goto(base);
    await page.locator('button.nav[data-page=weekly]').click();
    const chatMade = page.locator('#weekly-body .week-item:not(.completed-item)', { hasText: '对话里生成的目标' }); await chatMade.waitFor();
    const completed=page.locator('.weekly-completed');
    await completed.getByRole('heading',{name:'本周看板交付 · 6',exact:true}).waitFor();
    const other=completed.locator('.completed-other');
    assert.equal(await other.evaluate(el=>el.open),false,'off-board deliveries are collapsed by default');
    assert.equal(await other.locator('summary').first().textContent(),'看板外的其他真实交付 · 1');
    assert.equal(await other.locator('.completed-item').count(),1);
    assert.equal(await other.locator('.completed-item').isVisible(),false);
    assert.equal(await completed.locator(':scope > .completed-item',{hasText:'对话留下的交付'}).count(),0,'chat outputs never enter the board list or count');
    assert.equal(await completed.locator('.completed-handled').textContent(),'仅文字的对话轮 · 1（只计数，不逐条列出）');
    assert.equal(await completed.locator('.completed-item:visible').count(),5,'only the latest five are expanded by default');
    await completed.locator('.completed-overflow > summary').click();
    assert.equal(await completed.locator('.completed-item:visible').count(),6,'older deliveries remain available');
    await completed.locator('.completed-overflow > summary').click();
    await other.locator('summary').first().click();
    assert.equal(await other.locator('.completed-item').isVisible(),true,'off-board file deliveries are available on expansion');
    assert.match(await other.textContent(),/fixture\/report.md/);
    await other.locator('summary').first().click();
    assert.match(await completed.textContent(),/未排进计划的完成项 <样品>/);
    assert.match(await completed.textContent(),/对话留下的交付/);
    assert.doesNotMatch(await completed.textContent(),/生成周计划的对话轮|尚待验收/);
    const delivery=completed.locator('.completed-item',{hasText:'未排进计划的完成项 <样品>'});
    await delivery.locator('summary').click();
    assert.equal(await delivery.locator('.message-text').textContent(),'结果 <已核对>');
    assert.match(await delivery.locator('.file-name').textContent(),/result.svg$/);
    assert.equal(await delivery.locator('样品').count(),0,'titles and outcomes are text, not HTML');
    await delivery.locator('[data-session]').click();await page.locator('#page-chat').waitFor({state:'visible'});
    await page.locator('button.nav[data-page=weekly]').click();await completed.waitFor();
    const nothingElse = ['#intent-add', '[data-week-tab]', '#office-review', '[data-pool-add]', '#review-form', '[data-research]'];
    for (const selector of nothingElse) assert.equal(await page.locator(selector).count(), 0, `${selector} is gone from the weekly page`);
    assert.ok(await page.locator('#calendar-grid').isVisible(), 'the calendar keeps the first screen');
    assert.ok((await page.locator('#calendar-panel').boundingBox()).y < (await page.locator('#weekly-body').boundingBox()).y, 'the calendar sits above the plan');
    assert.match(await chatMade.textContent(), /待办/, 'the goal shows its task state');
    const filedTask = plan().intents[1].task_id;
    update({ id: filedTask, status: 'done', handoff: '完成' }); await page.clock.fastForward(5000);
    await completed.getByRole('heading',{name:'本周看板交付 · 7',exact:true}).waitFor();
    assert.equal(await other.locator('summary').first().textContent(),'看板外的其他真实交付 · 1','finishing a board step changes only the board count');
    assert.equal(await delivery.locator('details').getAttribute('open'),'','expanded results survive refresh');
    await page.locator('#weekly-body .goal-done', { hasText: '对话里生成的目标' }).waitFor(); // finishing the task ticks the goal
    assert.equal(await page.locator('#weekly-body .goal-done .goal-lamp.st-done').count(), 1, 'the goal wears the same done lamp as a step chip');
    fs.mkdirSync(path.join(root, '.runtime/test-artifacts'), { recursive: true });
    await page.locator('#weekly-body').screenshot({ path: path.join(root, '.runtime/test-artifacts/weekly-plan-body.png') });
    assert.equal(await page.locator('[data-intent-chat]').count(), 1, 'only the chat-made goal can open its conversation');
    await page.locator('[data-intent-chat]').click(); await page.locator('#page-chat').waitFor({ state: 'visible' });
    await page.locator('button.nav[data-page=weekly]').click(); await chatMade.waitFor();

    // edit by id, keep a project-only edit as an unsaved draft through a refresh
    const id = plan().intents[0].id, manual = page.locator('#weekly-body .week-item', { hasText: '测 THz 响应' });
    await manual.locator('[data-intent-edit]').click();
    const projectBox = page.locator('[data-intent-form] [name=project][value=graphene-thz]');
    await projectBox.uncheck();
    const projectRefresh = page.waitForResponse(r => r.url().includes('/api/weekly/week'));
    await projectRefresh; // Wait for the real 5-second data refresh; #refresh now restarts the backend.
    assert.equal(await projectBox.isChecked(), false, 'a project-only edit is also an unsaved draft');
    await projectBox.check();
    await page.locator('[data-intent-form] [name=title]').fill('测 THz 响应（改）');
    await page.locator('[data-intent-form] [type=submit]').click(); await page.locator('.week-item', { hasText: '测 THz 响应（改）' }).waitFor();
    assert.equal(plan().intents[0].id, id); assert.equal(plan().intents[0].title, '测 THz 响应（改）');

    // another week: the calendar follows, nothing is created by looking
    const label = await page.locator('#week-label').textContent();
    await page.locator('[data-week-nav="1"]').click();
    await page.locator('#weekly-body', { hasText: '这一周还没有计划' }).waitFor();
    assert.match(await completed.textContent(),/这一周还没有已确认的看板交付/);
    assert.equal(await other.locator('summary').first().textContent(),'看板外的其他真实交付 · 0');
    assert.equal(await completed.locator('.completed-handled').textContent(),'仅文字的对话轮 · 0（只计数，不逐条列出）');
    assert.equal(await completed.locator('.completed-item').count(),0,'another week does not inherit this week’s deliveries');
    assert.notEqual(await page.locator('#week-label').textContent(), label);
    const monday = new Date(Date.parse(start + 'T12:00:00Z') + 7 * 86400000).toISOString().slice(5, 10);
    assert.match(await page.locator('#calendar-grid .cal-cell').first().textContent(), new RegExp(`${+monday.slice(0, 2)}/${+monday.slice(3)}`), 'the calendar shows the selected week');
    assert.equal(fs.existsSync(nextWeek), false);
    await page.locator('[data-week-nav="0"]').click(); await page.locator('.week-item', { hasText: '测 THz 响应（改）' }).waitFor();
    await completed.getByRole('heading',{name:'本周看板交付 · 7',exact:true}).waitFor();

    // the plan and the Monday PPT open a new chat with a ready first message; nothing is sent or queued by clicking
    const itemsBefore = read('work/queue.json').items.length, sessionsBefore = read('.runtime/agent/sessions.json').sessions.length;
    assert.deepEqual(await page.locator('#weekly-body [data-weekly-chat]').evaluateAll(els => els.map(el => el.dataset.weeklyChat)), ['plan', 'meeting']);
    const message = page.locator('#message');
    for (const [key, expected] of [['meeting', `weekly view ${previous}`], ['meeting', `weekly view ${start}`], ['plan', `weekly context ${start}`]]) {
      await page.locator(`[data-weekly-chat="${key}"]`).click(); await page.locator('#page-chat').waitFor({ state: 'visible' });
      assert.match(await message.inputValue(), new RegExp(expected), key);
      await page.locator('button.nav[data-page=weekly]').click(); await page.locator(`[data-weekly-chat="${key}"]`).waitFor();
    }
    assert.equal(read('work/queue.json').items.length, itemsBefore, 'opening a chat creates no task');
    assert.equal(read('.runtime/agent/sessions.json').sessions.length, sessionsBefore, 'opening a chat sends nothing');

    // The assistant's real planning entry feeds the calendar; a user's time edits and cancellation survive regeneration.
    const proposal = { week: start, availability: [{ start: today + 'T21:00', end: today + 'T22:30' }], goals: [{
      key: 'browser-project-plan', project_id: 'graphene-thz', node_id: 'T-20261008-90', kind: 'data', actor: 'user', title: '从项目生成的工作块', reason: '根据当天研究记录安排整理', minutes: 30
    }] }, clock = new Date(start + 'T00:00:00Z');
    const generated = applyPlan(proposal, clock).allocation[0].id;
    await page.locator('.cal-chip', { hasText: '从项目生成的工作块' }).waitFor();
    const planningArtifacts = path.join(root, '.runtime/test-artifacts'); fs.mkdirSync(planningArtifacts, { recursive: true });
    await page.screenshot({ path: path.join(planningArtifacts, 'weekly-project-workblock.png') });
    await page.locator('.cal-chip', { hasText: '从项目生成的工作块' }).click();
    let block = page.locator('#cal-detail');
    await block.locator('[data-cal-edit]').click();
    assert.equal(await page.locator('#cal-title').isDisabled(), true, 'the work-block editor does not duplicate goal content');
    await page.locator('#cal-time').fill('21:30'); await page.locator('#cal-end-time').fill('22:00');
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#cal-form').waitFor({ state: 'hidden' });
    assert.equal(plan().intents.find(i => i.id === generated).schedule.locked, true);
    assert.equal(applyPlan(proposal, clock).allocation[0].status, 'preserved');
    await page.locator('.cal-chip', { hasText: '从项目生成的工作块' }).click();
    page.once('dialog', d => d.accept()); await block.locator('[data-cal-delete]').click(); await block.waitFor({ state: 'hidden' });
    assert.ok(plan().intents.some(i => i.id === generated), 'cancel the work block without removing the goal');
    applyPlan(proposal, clock); assert.equal(plan().intents.find(i => i.id === generated).schedule.start, undefined);
    const generatedCard = page.locator('#weekly-body .week-item', { hasText: '从项目生成的工作块' });
    await generatedCard.locator('[data-intent-auto]').click();
    await generatedCard.locator('[data-intent-auto]').waitFor({ state: 'detached' });
    assert.equal(applyPlan(proposal, clock).allocation[0].status, 'scheduled');
    page.once('dialog', d => d.accept()); await generatedCard.locator('[data-intent-remove]').click(); await generatedCard.waitFor({ state: 'detached' });
    assert.equal(calendarItems(calendarData([], [], [])).items.some(i => i.intent_id === generated), false);

    // after a reload the plan is still there and fits both widths; removing a goal asks first and leaves the task alone
    await page.reload(); await page.locator('button.nav[data-page=weekly]').click(); await page.locator('.week-item', { hasText: '测 THz 响应（改）' }).waitFor();
    const artifacts = path.join(root, '.runtime/test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      if(!await delivery.locator('details').evaluate(el=>el.open))await delivery.locator('summary').click();
      assert.equal(await page.locator('#page-weekly').evaluate(el => el.scrollWidth <= el.clientWidth), true, `weekly page fits ${width}px`);
      await page.screenshot({ path: path.join(artifacts, `weekly-page-${width}.png`) });
      await completed.screenshot({path:path.join(artifacts,`weekly-completed-${width}.png`)});
    }
    page.once('dialog', d => d.accept()); await page.locator('.week-item', { hasText: '测 THz 响应（改）' }).locator('[data-intent-remove]').click();
    await page.locator('.week-item', { hasText: '测 THz 响应（改）' }).waitFor({ state: 'detached' });
    assert.deepEqual(plan().intents.map(i => i.title), ['对话里生成的目标']); assert.equal(read('work/queue.json').items.length, itemsBefore + 1, 'the later generated goal filed one step; removing goals deletes no task');
    assert.deepEqual(errors, []);
  } finally {
    if (runEnv === undefined) delete process.env.OFFICE_MEMORY_RUN_DIR; else process.env.OFFICE_MEMORY_RUN_DIR = runEnv;
    if (browser) await browser.close(); if (base) await new Promise(r => server.close(r));
    write('work/queue.json', queue); write('.runtime/agent/sessions.json', sessions);
    frameworkBefore ? fs.writeFileSync(framework, frameworkBefore) : fs.rmSync(framework, { force: true });
    fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
  }
});
