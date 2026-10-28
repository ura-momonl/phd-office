import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from './files.mjs';
import {addEvent,updateEvent} from '../calendar/run.mjs';
import {addIntent,updateIntent,saveReview,weekView,applyPlan} from '../weekly/run.mjs';
import {addNode,addEntry,setFields,setStatus,parseFramework,editorSnapshot,editFramework} from '../projects/framework.mjs';
import {normalizeCard} from '../dashboard/cards.mjs';
import {inboxItems} from '../dashboard/inbox.mjs';
import {createServer} from '../dashboard/server.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const long=(n,tail)=>'完整资料'.repeat(n)+tail;
async function preserve(files,fn) {
  const before=new Map(files.map(f=>[f,fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null]));
  try{return await fn();}finally{for(const [f,body] of before){const file=path.join(root,f);if(body===null)fs.rmSync(file,{force:true});else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}}}
}

test('calendar create and update retain complete titles and notes beyond the former character caps',()=>preserve(['calendar/events.json'],()=>{
  const title=long(40,'日程标题末尾'),note=long(130,'D:/results/中文备注末尾.csv');
  const event=addEvent({title,note,start:'2026-10-26T09:00',end:'2026-10-26T10:00'});
  assert.equal(event.title,title);assert.equal(event.note,note);
  assert.equal(read('calendar/events.json').events.find(e=>e.id===event.id).note,note);
  const edited=updateEvent(event.id,{title:title+'编辑',note:note+'编辑'});
  assert.equal(edited.title,title+'编辑');assert.equal(read('calendar/events.json').events.find(e=>e.id===event.id).note,note+'编辑');
}));

test('weekly records and task generation retain complete goals, rationale, reviews and multi-line blockers',()=>preserve([
  '.runtime/weekly/2026-10-26/plan.json','.runtime/weekly/2026-10-26/review.json',
  'work/queue.json','work/turns.json','workspace/projects/bi-devices/FRAMEWORK.md'
],()=>{
  const week='2026-10-26',now=new Date('2026-10-25T17:00:00Z');
  write('work/queue.json',{version:1,items:[]});
  write(`.runtime/weekly/${week}/plan.json`,{week,intents:[]});
  const title=long(90,'目标末尾'),expected=long(150,'预期结果末尾'),reason=long(300,'选择依据末尾');
  const intent=addIntent({week,title,expected,project_ids:['bi-devices']});
  assert.equal(intent.title,title);assert.equal(intent.expected,expected);
  updateIntent({week,id:intent.id,title:title+'编辑',expected:expected+'编辑'});
  const review=long(2100,'复盘末尾'),next=long(2100,'下周调整末尾');
  const included=Array.from({length:205},(_,n)=>'bi-devices:T-20261026-'+String(n+1).padStart(2,'0'));
  saveReview({week,summary:review,next_adjust:next,included});
  const view=weekView(week,now);
  assert.equal(view.plan.intents[0].title,title+'编辑');assert.equal(view.plan.intents[0].expected,expected+'编辑');
  assert.equal(view.review.summary,review);assert.equal(view.review.next_adjust,next);assert.deepEqual(view.review.included,included);
  fs.writeFileSync(path.join(root,'workspace/projects/bi-devices/FRAMEWORK.md'),'## Results\n<!--node {"id":"results","type":"timeline"}-->\n');
  const applied=applyPlan({week,availability:[],goals:[{key:'complete-goal',project_id:'bi-devices',node_id:'results',kind:'experiment',actor:'user',title,expected,reason}]},now);
  const goal=applied.plan.intents.find(i=>i.origin?.key==='bi-devices:complete-goal');
  assert.equal(goal.title,title);assert.equal(goal.expected,expected);assert.equal(goal.origin.reason,reason);
  const queue=read('work/queue.json'),task=queue.items.find(i=>i.id===goal.task_id);
  assert.equal(task.title,title);assert.ok(task.goal.includes(expected));assert.ok(task.goal.includes(reason));
  const handoff='阻塞原因第一段\n'+long(60,'第二段末尾 D:/results/完整路径.csv');
  task.status='waiting_user';task.handoff=handoff;write('work/queue.json',queue);
  assert.equal(weekView(week,now).current.blocked.find(i=>i.id===task.id).next,handoff);
}));

test('project record headings, summaries, state notes and rationale round-trip without silent cuts',()=>preserve(['workspace/projects/bi-devices/FRAMEWORK.md'],()=>{
  const file=path.join(root,'workspace/projects/bi-devices/FRAMEWORK.md');
  fs.writeFileSync(file,'## Results\n<!--node {"id":"results","type":"timeline"}-->\n');
  const title=long(60,'研究标题末尾'),summary=long(90,'研究摘要末尾'),note=long(95,'状态说明末尾'),reason=long(100,'改动理由末尾');
  addNode('bi-devices',{parent:'results',id:'complete-node',title,summary,kind:'milestone',status:'open',note});
  let node=parseFramework(fs.readFileSync(file,'utf8')).byId.get('complete-node');
  assert.equal(node.title,title);assert.equal(node.meta.summary,summary);assert.equal(node.meta.note,note);
  setFields('bi-devices','complete-node',{summary:summary+'更新'});
  setStatus('bi-devices','complete-node','done');setStatus('bi-devices','complete-node','failed',{reason});
  node=parseFramework(fs.readFileSync(file,'utf8')).byId.get('complete-node');
  assert.equal(node.meta.summary,summary+'更新');assert.equal(node.meta.history.at(-1)[3],reason);
  const entry=addEntry('bi-devices',{title,summary,body:'完整研究正文 D:/results/中文.csv',date:'2026-10-26',date_confirmed:true});
  const recorded=parseFramework(fs.readFileSync(file,'utf8')).byId.get(entry.id);
  assert.equal(recorded.title,title);assert.equal(recorded.meta.summary,summary);
  const before=editorSnapshot('bi-devices');
  editFramework('bi-devices',{action:'content',id:'complete-node',revision:before.revision,title,summary,body:'完整编辑正文。'.repeat(18000)+'尾部 D:/research/完整编辑.csv'});
  const edited=parseFramework(fs.readFileSync(file,'utf8')).byId.get('complete-node');
  assert.equal(edited.title,title);assert.equal(edited.meta.summary,summary);
  assert.ok(edited.body.endsWith('尾部 D:/research/完整编辑.csv'));
}));

test('choosing a card reply submits the complete action text and material through the real HTTP route',()=>preserve([
  'work/queue.json','work/turns.json','.runtime/agent/sessions.json','.runtime/agent/runs/complete-card-fixture/inbox.json'
],async()=>{
  assert.equal(read('agent/config.json').enabled,false,'model dispatch stays disabled by the isolated runner');
  const reply=long(130,'回复末尾 D:/results/完整回复.md'),detail=long(520,'事项材料末尾');
  const title=long(20,'卡片标题末尾'),label=long(10,'按钮末尾'),category=long(5,'分类末尾');
  const card=normalizeCard({category,title,message:detail,kind:'decision',actions:[{id:'continue',type:'reply',label,reply}]});
  assert.equal(card.title,title);assert.equal(card.category,category);assert.equal(card.message,detail);assert.equal(card.actions[0].label,label);assert.equal(card.actions[0].reply,reply);
  write('work/queue.json',{version:1,items:[{id:'complete-card-fixture',title,goal:detail,handoff:detail,kind:'framework',actor:'codex',status:'done',project_ids:[],outputs:[],review:{state:'pending',kind:'decision'},created_at:'2026-10-26T17:00:00Z'}]});
  write('.runtime/agent/runs/complete-card-fixture/inbox.json',card);
  const item=inboxItems([],read('work/queue.json').items,[]).find(i=>i.id==='work:complete-card-fixture');
  assert.ok(item,'fixture exposes an actionable card');
  const server=createServer();
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/inbox/respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,fingerprint:item.fingerprint,action_id:'continue'})});
    const result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));
    const received=read('.runtime/agent/sessions.json').sessions.flatMap(s=>s.messages).find(m=>m.inbox_reply?.id===item.id);
    assert.ok(received?.text.includes(reply),'the clicked action is sent whole, not only its displayed label');
    assert.ok(received.text.includes(detail),'the task receives the complete card material');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
