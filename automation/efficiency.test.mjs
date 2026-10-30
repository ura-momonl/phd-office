import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {root,read,write} from './files.mjs';
import {workDigest,workSnapshot,workOverview,workDetail} from '../work/run.mjs';
import {usageDigest} from '../usage/run.mjs';
import {known,billed,usageGroups,purposeOf} from '../usage/metrics.mjs';
import {usageGroups as viewGroups,usageBreakdown} from '../dashboard/usage-view.js';
import {startCodexTurn,codexLaunch} from '../agent/codex.mjs';

import {submit,execute as executeAgent} from '../agent/run.mjs';
import {executeWithoutTitle} from './titleless.mjs';
import {mailGuide,mailBrief} from '../mail-flow/guide.mjs';
import {createServer} from '../dashboard/server.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const execute=executeWithoutTitle(executeAgent);
async function fixture(fn){
  const paths=['work/queue.json','.runtime/agent/sessions.json','agent/config.json','.runtime/usage/runs.jsonl'];
  const originals=new Map(paths.map(p=>[p,fs.existsSync(path.join(root,p))?fs.readFileSync(path.join(root,p)):null]));
  try{return await fn();}finally{for(const [p,b] of originals){if(b===null)fs.rmSync(path.join(root,p),{force:true});else fs.writeFileSync(path.join(root,p),b);}}
}

test('a real inbox click delegates work while keeping the generated assessment distinct from user-confirmed facts',()=>fixture(async()=>{
  write('agent/config.json',{...read('agent/config.json'),enabled:false,memory_v2:{enabled:false}});
  const id='input-boundary-'+randomUUID(),db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'todo',?,'[]','[]','[]')")
    .run(id,'Fixture matter, not a reply obligation','BACKGROUND_ACTION_WITNESS');
  const mid='input-boundary-message-'+id,thread={id:mid,subject:'Re: Printed array patching',sender:'partner@example.org',folder:'inbox',received:'2026-10-15T18:00:00Z',text:'Hello, can we talk about the plan?'};
  db.prepare('INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,?,?,?)').run(mid,mid,JSON.stringify(thread),'reviewed','fixture',0);
  db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run(mid,id);
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(method,url,value)=>new Promise((resolve,reject)=>{
    const body=value?JSON.stringify(value):'';
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{Connection:'close',...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',d=>text+=d);res.on('end',()=>{try{assert.equal(res.statusCode,200,text);resolve(JSON.parse(text));}catch(error){reject(error);}});
    });req.on('error',reject);req.end(body);
  });
  try {
    const state=await request('GET','/api/state?page=inbox'),card=state.inbox.find(c=>c.id==='mail:'+id);assert.ok(card);
    const job=await request('POST','/api/inbox/respond',{id:card.id,fingerprint:card.fingerprint,action_id:'agent-handle'});
    const session=read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id),text=session.messages[0].text;
    assert.match(text,/跟进这段往来：partner@example\.org，邮件主题「Printed array patching」/);
    assert.doesNotMatch(text,/后台对事项的初步判断|BACKGROUND_ACTION_WITNESS|Fixture matter/,'the click names the correspondence, not the background judgment');
    assert.ok(session.title.startsWith('跟进 · partner@example.org · Printed'),'session title names the correspondence (titles are capped at 40 characters)');
    await execute(job.task_id,async(_,prompt,opts)=>{
      assert.equal(opts.mode,'work');assert.match(prompt,/background_assessment/);assert.match(prompt,/source_messages/);
      assert.match(prompt,/BACKGROUND_ACTION_WITNESS/);assert.ok(!prompt.includes(mailGuide()));
      return {result:'Explained the matter without a send or a whole-matter completion claim.'};
    });
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'todo','one work turn is not proof the underlying matter is complete');
    const extra=[];
    const matter=(suffix,messages)=>{
      const tid=id+suffix;extra.push(tid);
      db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'todo',?,'[]','[]','[]')").run(tid,'Background task name '+suffix,'BACKGROUND_ACTION_'+suffix);
      messages.forEach(([folder,sender,received],n)=>{const m={id:tid+'-m'+n,subject:'Re: Thread '+suffix,sender,folder,received,text:'text'+n};
        db.prepare('INSERT INTO messages(id,fingerprint,data,state,reason,priority) VALUES(?,?,?,?,?,?)').run(m.id,m.id,JSON.stringify(m),'reviewed','fixture',0);
        db.prepare('INSERT INTO sources(id,task_id) VALUES(?,?)').run(m.id,tid);});
      return tid;
    };
    const mine='researcher@example.org';
    const a=matter('-A',[['inbox','colleague@example.org','2026-10-10T10:00:00Z'],['sent',mine,'2026-10-11T10:00:00Z'],['sent',mine,'2026-10-12T10:00:00Z'],['sent',mine,'2026-10-13T10:00:00Z']]);
    const b=matter('-B',[['sent',mine,'2026-10-11T10:00:00Z'],['sent',mine,'2026-10-12T10:00:00Z']]);
    const cards=(await request('GET','/api/state?page=inbox')).inbox;
    const firstText=async tid=>{const card=cards.find(c=>c.id==='mail:'+tid),job=await request('POST','/api/inbox/respond',{id:card.id,fingerprint:card.fingerprint,action_id:'agent-handle'});
      return read('.runtime/agent/sessions.json').sessions.find(s=>s.id===job.session_id).messages[0].text;};
    const withEarlierIncoming=await firstText(a);
    assert.match(withEarlierIncoming,/跟进这段往来：colleague@example\.org，邮件主题「Thread -A」/,'three newer sent messages must not hide the real counterpart');
    assert.doesNotMatch(withEarlierIncoming,/researcher@example\.org|Background task name|BACKGROUND_ACTION/);
    const onlySent=await firstText(b);
    assert.match(onlySent,/跟进这段往来：邮件主题「Thread -B」。/,'no incoming mail: neutral entry, no guessed counterpart');
    assert.doesNotMatch(onlySent,/researcher@example\.org|Background task name|BACKGROUND_ACTION/);
  } finally {await new Promise(resolve=>server.close(resolve));for(const tid of [id,id+'-A',id+'-B']){db.prepare('DELETE FROM messages WHERE id IN (SELECT id FROM sources WHERE task_id=?)').run(tid);db.prepare('DELETE FROM sources WHERE task_id=?').run(tid);db.prepare('DELETE FROM tasks WHERE id=?').run(tid);}db.prepare('DELETE FROM sources WHERE task_id=?').run(id);db.prepare('DELETE FROM messages WHERE id=?').run('input-boundary-message-'+id);db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.close();}
}));

test('every agent can read the same mail guide without connecting to Outlook or changing the ledger',()=>{
  const files=['.runtime/mail-flow/mail.sqlite','.runtime/mail-flow/outlook-actions.jsonl','.runtime/usage/quota.json'];
  const before=files.map(f=>fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null);
  const guide=execFileSync(process.execPath,['automation/run.mjs','mail','guide'],{cwd:root,encoding:'utf8',env:{...process.env,MAIL_FLOW_CODEX_BIN:path.join(root,'no-native-connector-for-guide.mjs')}}).trim();
  assert.equal(guide,mailGuide());
  assert.match(guide,/body_sha256/);assert.match(guide,/已发邮件不能为补引用擅自重发/);
  assert.match(guide,/confirmed_by_user:true/);assert.match(guide,/forward_email/);assert.match(guide,/核对发件人、时间、主题/);assert.match(guide,/行尾加两个空格/);assert.match(guide,/不自动重试写操作/);
  for(const [i,f] of files.entries())assert.deepEqual(fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null,before[i]);
  const brief=mailBrief();
  assert.notEqual(brief,guide,'work guidance and send mechanics have different responsibilities, not a fixed length ratio');
  assert.match(brief,/回复只是可能的产出之一/);assert.match(brief,/mail guide/);assert.match(brief,/明确批准/);
  assert.match(brief,/用户在这段合作里的代表/);assert.match(brief,/每个问题、提议和邀请都要有去向/);assert.match(brief,/交器件、见面、寄样品/);assert.match(brief,/还没结果的也接上/);assert.match(brief,/我方具体接哪一步/);assert.match(brief,/谁掌握信息、谁在负责/);assert.match(brief,/设想按设想看/);
  assert.match(brief,/简短/);assert.match(brief,/先简短问用户/);assert.match(brief,/instruments note/);
  for(const mechanic of ['body_sha256','confirmed_by_user','reply_request_file','allow_repeat'])assert.ok(!brief.includes(mechanic)&&guide.includes(mechanic),mechanic+' stays on demand only');
  const shared=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
  assert.match(shared,/mail guide/);assert.ok(!shared.includes('完整含引用请求存为本地'));
});

test('mail work gets the short brief (not the send mechanics) before either provider acts; unrelated work and parsed cards do not',()=>fixture(async()=>{
  write('agent/config.json',{...read('agent/config.json'),memory_v2:{enabled:false}});
  for(const provider of ['Codex','Claude']){
    for(const [text,wanted] of [['帮我写邮件给教授',true],['帮我写信给教授',true],['检查数据单位',false]]){
      const job=submit({text:`@${provider} ${text}`});let calls=0;
      await execute(job.task_id,async(who,prompt,opts)=>{
        calls++;assert.equal(who,provider.toLowerCase());assert.equal(opts.mode,'work');
        assert.equal(prompt.includes(mailBrief()),wanted);assert.ok(!prompt.includes(mailGuide()),'full mechanics are never injected');
        if(wanted){assert.ok(prompt.indexOf(mailBrief())<prompt.indexOf('当前请求：'));assert.equal(prompt.split(mailBrief()).length-1,1);assert.ok(!prompt.includes('当前项目：'),'no-project mail work still gets the brief, which says how to find project state itself');}
        return {result:'本地验收，无真实发送。'};
      });assert.equal(calls,1);
    }
    const job=submit({text:`@${provider} 判断这张邮件卡`,inbox_reply:{id:'mail:guide-fixture',fingerprint:'fixture',action_id:'agent-check',label:'核对'}});
    await execute(job.task_id,async(who,prompt,opts)=>{
      assert.equal(opts.mode,'ask');assert.ok(!prompt.includes(mailGuide())&&!prompt.includes(mailBrief()));
      return {result:JSON.stringify({category:'邮件',kind:'decision',title:'验收',message:'不发送',actions:[]})};
    });
  }
}));

test('native mail continuation and fresh fallback both receive the current brief before acting',()=>fixture(async()=>{
  write('agent/config.json',{...read('agent/config.json'),memory_v2:{enabled:false},codex_resume_sessions:['*']});
  const native=async(provider,prompt,opts)=>{
    assert.ok(prompt.includes(mailBrief()));assert.ok(opts.resumePrompt.includes(mailBrief()));assert.ok(!prompt.includes(mailGuide()));
    opts.onContinuation({threadId:'mail-guide-native',signature:'fixture'},{phase:'start'});
    return {result:'邮件拟稿仍未发送。'};
  };
  const first=submit({text:'@Codex 帮我写邮件'});await execute(first.task_id,native);
  const second=submit({text:'@Codex 修改邮件语气',session_id:first.session_id});await execute(second.task_id,native);
}));
test('work digest keeps every unfinished task, dependencies and review; full and single-task CLI retain originals',()=>fixture(()=>{
  const task=(id,status)=>({id,title:id,actor:'user',status,project_ids:[],dependencies:[],created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-02T00:00:00Z',goal:'original request',handoff:'full outcome',outputs:['data.csv'],history:[{text:'original history'}]});
  const items=[task('done','done'),task('queued','queued'),task('failed','failed'),task('waiting','waiting_user'),task('deleted','cancelled')];
  items[1].dependencies=['failed'];items[2].review={state:'pending'};items[4].deleted_at='2026-10-03';
  write('work/queue.json',{...read('work/queue.json'),items});
  const snapshot=workSnapshot(),before=JSON.stringify(snapshot),d=workDigest(snapshot);
  assert.deepEqual(d.unfinished.map(x=>x.id),['queued','failed','waiting']);assert.deepEqual(d.unfinished[0].blocked_by,['failed']);assert.equal(d.unfinished[0].ready,false);assert.equal(d.unfinished[1].review,'pending');
  assert.equal(d.total_items,4);assert.equal(JSON.stringify(snapshot),before);assert.ok(d.unfinished.every(i=>!('goal' in i)&&!('history' in i)&&!('handoff' in i)));
  const cli=(...args)=>JSON.parse(execFileSync(process.execPath,['automation/run.mjs','work',...args],{cwd:root,encoding:'utf8'}));
  assert.deepEqual(cli('list','all'),d);assert.deepEqual(cli('list','full'),snapshot);assert.equal(cli('list').end,'work list 总览结束');assert.deepEqual(cli('list','failed').unfinished.map(x=>x.id),['failed']);assert.equal(cli('handoff','queued').goal,'original request');assert.deepEqual(cli('handoff','queued').history,items[1].history);
}));
test('work overview stays size-capped and complete however long the queue is, and names chains stuck behind a failed task',()=>{
  const items=Array.from({length:300},(_,n)=>({id:'t'+n.toString().padStart(3,'0')+'-'+'x'.repeat(30),title:'很长的标题'.repeat(30),status:'waiting_user',project_ids:['p'+(n%3)],dependencies:[],ready:false,blocked_by:[],created_at:'2026-10-01'}));
  items[0].status='failed';items[1].dependencies=[items[0].id];items[1].status='open';items[1].blocked_by=[items[0].id];items[2].dependencies=[items[1].id];items[2].status='open';items[2].blocked_by=[items[1].id];
  const o=workOverview({items}),text=JSON.stringify(o,null,2);
  assert.ok(text.length<6000,'overview size is bounded by caps, not by queue length: '+text.length);
  assert.equal(Object.keys(o).at(-1),'end');assert.equal(Object.keys(o)[0],'coverage');assert.ok(o.coverage.includes('未结束 300 条'));
  assert.equal(o.needs_attention.length,13);assert.ok(o.needs_attention.at(-1).startsWith('另有 '));
  assert.equal(o.blocked_by_failed.length,1);assert.ok(o.blocked_by_failed[0].includes('卡住 2 条'));
  assert.equal(o.by_project.p1['前置已失败或取消'],1);
});
test('work overview keeps chat-turn records out of the step list but never hides a turn awaiting review',()=>{
  const base={project_ids:[],dependencies:[],ready:false,blocked_by:[],created_at:'2026-10-01'};
  const items=[{...base,id:'step',status:'open'},{...base,id:'turn-failed',status:'failed',executor:'codex',updated_at:new Date().toISOString()},{...base,id:'turn-old-failed',status:'failed',executor:'codex'},{...base,id:'turn-wait',status:'waiting_user',executor:'claude'},{...base,id:'turn-review',status:'done',executor:'claude',review:{state:'pending'}}];
  const o=workOverview({items});
  assert.ok(o.coverage.includes('任务步骤未结束 2 条')&&o.coverage.includes('对话轮 2 条')&&o.coverage.includes('更早失败的对话轮 1 条'));assert.deepEqual(o.turns,{failed:1,waiting_user:1});
  assert.ok(o.needs_attention.some(l=>l.startsWith('turn-rev')&&l.includes('待验收')));
  assert.deepEqual(workDetail('turns',{items}).unfinished.map(x=>x.id),['turn-failed','turn-old-failed','turn-wait']);assert.deepEqual(workDetail('failed',{items}).unfinished.map(x=>x.id),[]);
});
test('work list <filter> accepts a status or a known project and rejects anything else',()=>{
  const items=[{id:'a',status:'open',project_ids:['graphene-thz'],ready:false,blocked_by:[]},{id:'b',status:'failed',project_ids:[],ready:false,blocked_by:[]}];
  assert.deepEqual(workDetail('failed',{items}).unfinished.map(x=>x.id),['b']);assert.deepEqual(workDetail('graphene-thz',{items}).unfinished.map(x=>x.id),['a']);
  assert.throws(()=>workDetail('no-such-project',{items}));
});
test('work digest caps only finished previews, never hides outstanding tasks',()=>{
  const items=Array.from({length:24},(_,n)=>({id:String(n),status:n<12?'done':'open',created_at:`2026-10-${String(n+1).padStart(2,'0')}`,ready:false,blocked_by:[]}));
  items[0].review={state:'pending'};
  const d=workDigest({items});assert.equal(d.recent_finished.length,8);assert.equal(d.unfinished.length,13);assert.equal(d.recent_finished[0].id,'11');
  assert.equal(d.unfinished.find(i=>i.id==='0').review,'pending','old completed work awaiting review must not disappear behind eight previews');
});
test('CLI, weekly and UI share ledger calculation; unknown usage is not a fabricated zero-cost success',()=>{
  const rows=[{at:'2026-10-12T00:00:00Z',provider:'codex',status:'completed',input_tokens:100,cached_input_tokens:80,output_tokens:10,tool_calls:2,duration_ms:1250,purpose:'memory-extract'},
    {at:'2026-10-12T01:00:00Z',provider:'codex',status:'failed',input_tokens:50,cached_input_tokens:20,output_tokens:5,duration_ms:500},
    {at:'2026-10-12T02:00:00Z',provider:'codex',status:'completed',input_tokens:999,output_tokens:999,usage_known:false},
    {at:'2026-10-12T03:00:00Z',provider:'codex',status:'completed',input_tokens:null,output_tokens:null}];
  assert.equal(viewGroups,usageGroups);const [g]=usageGroups(rows,r=>r.provider);
  assert.equal(g.calls,4);assert.equal(g.unknown,2);assert.equal(g.failed,1);assert.equal(g.input,150);assert.equal(g.cached,100);assert.equal(g.output,15);assert.equal(g.billed,65);assert.equal(g.failedBilled,35);assert.equal(known(rows[3]),false);assert.equal(billed(rows[2]),0);
  const snap={runs:rows,quota:{fixture:true},scope:'fixture',subscriptionMonthlyUSD:40},d=usageDigest(snap),aggregate=Object.values(d.recent_days).reduce((s,x)=>s+x.input_tokens,0);
  assert.equal(aggregate,150);assert.equal(Object.values(d.recent_days)[0].unknown_usage,2);assert.deepEqual(d.quota,snap.quota);
  assert.equal(purposeOf({id:'mail-judge-fixture'}),'mail');assert.equal(purposeOf({feature:'quota-probe'}),'quota-probe');
  const html=usageBreakdown(rows);assert.match(html,/不是计费 token/);assert.match(html,/缓存仍可能计费/);assert.match(html,/记忆整理/);
});
const permissions={sandbox:'workspace-write',approvalPolicy:'on-request'},thread=id=>({thread:{id},sandbox:{type:'workspaceWrite'},model:'fixture'});
test('native resume sends the delta; a fresh or fallback thread sends the full prompt; failed turns never replay',async()=>{
  for(const route of ['resume','fresh','fallback','turn-error']){
    let submitted=0;const calls=[];
    const rpc=async(method,p)=>{calls.push({method,p});if(method==='thread/resume'){if(route==='fallback')throw new Error('missing');return thread('old');}if(method==='thread/start')return thread('new');submitted++;if(route==='turn-error')throw new Error('ambiguous turn failure');return {turn:{id:'turn'}};};
    const job=startCodexTurn(rpc,{params:permissions,signature:'S',continuation:route==='fresh'?{}:{threadId:'old',signature:'S'},prompt:'FULL ORIGINAL',resumePrompt:'DELTA'});
    if(route==='turn-error')await assert.rejects(job,/ambiguous/);else await job;
    assert.equal(submitted,1);
    assert.equal(calls.at(-1).p.input[0].text,['fresh','fallback'].includes(route)?'FULL ORIGINAL':'DELTA');
  }
});
test('quoted CAD software in a parsed ask cannot select an application directory or enable its servers',()=>{
  const ask=codexLaunch('Mail mentions AutoCAD Fusion Altium',{mode:'ask',apps:[],exists:()=>true});assert.equal(ask.cwd,root);assert.ok(!ask.overrides.some(v=>/autocad|fusion|altium/.test(v)&&v.endsWith('=true')));
  const work=codexLaunch('AutoCAD',{mode:'work',apps:[{id:'autocad',working_directory:'D:/fixture-autocad'}],exists:()=>true});assert.equal(work.cwd,'D:/fixture-autocad');
});
test('the actual HTTP receiver serves the shared pure module as JavaScript without exposing account/runtime files',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=p=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:p,headers:{Connection:'close'}},res=>{let text='';res.setEncoding('utf8');res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],text}));}).on('error',reject));
  try {const response=await get('/usage/metrics.mjs');assert.equal(response.status,200);assert.match(response.type,/javascript/);assert.equal(response.text,fs.readFileSync(path.join(root,'usage/metrics.mjs'),'utf8'));assert.equal((await get('/usage/run.mjs')).status,404);assert.equal((await get('/usage/../.runtime/usage/quota.json')).status,404);}finally{await new Promise(resolve=>server.close(resolve));}
});
