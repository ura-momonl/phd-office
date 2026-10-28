import { launchEdge } from './browser-launch.mjs';
// Run only through scripts/run-tests.mjs (isolated copy). Provider calls are replaced at the existing runner seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root,read,write } from './files.mjs';
import { enqueue,update,readiness,workSnapshot,stepEditor,editStep,moveStep,addStep,setStepStatus,logRequirementOf,planProgress } from '../work/run.mjs';
import { drain,startReadyWork } from '../agent/run.mjs';
import { createServer } from '../dashboard/server.mjs';
import { checkFramework,addEntry,parseFramework,frameworkFile } from '../projects/framework.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');

async function isolated(fn) {
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json'),config=read('agent/config.json');
  write('work/queue.json',{...queue,items:[]});write('.runtime/agent/sessions.json',{sessions:[]});
  write('agent/config.json',{...config,enabled:true});
  try {await fn();} finally {write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);write('agent/config.json',config);}
}
function chain(measureOutputs=true) {
  const add=(title,actor,dependencies=[],extra={})=>enqueue({title,kind:'experiment',actor,dependencies,project_ids:['graphene-thz'],plan_node_id:'graphene-array-cell-plan',...extra});
  const wire=add('wirebonding','user');
  const measure=add('measurement','user',[wire.id],{require_outputs:measureOutputs});
  const process=add('process','claude',[measure.id],{status:'queued',require_outputs:true,log_requirement:null,goal:'处理测量数据并交付整理文件'});
  const email=add('email draft','claude',[process.id],{status:'queued',require_outputs:true,log_requirement:null,goal:'只起草邮件，不发送'});
  return {wire,measure,process,email};
}
const current=id=>read('work/queue.json').items.find(i=>i.id===id);
const outcome=name=>{const file=path.join(root,'.runtime',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture only');return file;};

// Only the throw-away copy is mutated. Existing history is restored between tests.
async function logDelivery(fn) {
  return isolated(async()=>{
    const file=frameworkFile('graphene-thz'),saved=fs.readFileSync(file);
    try {
      const steps=chain(false);
      const requirement={project_id:'graphene-thz',parent:'graphene-array-cell-plan',links:['T-20261007-26']};
      update({id:steps.process.id,log_requirement:requirement});
      update({id:steps.wire.id,status:'done',handoff:'fixture bond complete'});
      update({id:steps.measure.id,status:'done',handoff:'fixture data',outputs:[outcome('log-input.csv')]});
      await fn(steps,requirement,saved);
    } finally {fs.writeFileSync(file,saved);}
  });
}
const processingBody='- 输入数据：fixture log-input.csv\n- 方法与参数：fixture identity transform\n- 脚本/版本：fixture v1\n- 输出：fixture log-analysis.csv\n- 结果与限制：only synthetic data; no scientific conclusion';

test('processing completion requires a nonempty log at its home, linked to the source and original work ID',async()=>logDelivery(async({process},r,saved)=>{
  const finish=()=>update({id:process.id,status:'done',handoff:'fixture result',outputs:[outcome('log-analysis.csv')]});
  const rejected=()=>{const before=fs.readFileSync(path.join(root,'work/queue.json'));assert.throws(finish,/处理日志未交付/);assert.deepEqual(fs.readFileSync(path.join(root,'work/queue.json')),before);};
  rejected();
  const otherParent=parseFramework(saved.toString()).roots.find(n=>n.meta.type==='timeline').id;
  const log=extra=>addEntry(r.project_id,{parent:r.parent,title:'Fixture processing log',body:processingBody,work:[process.id],links:r.links,...extra});
  log({parent:otherParent});rejected();
  log({links:['T-20261007-25']});rejected();
  log({work:[]});rejected();
  log({body:''});rejected();
  const good=log({});
  assert.throws(()=>update({id:process.id,status:'done',handoff:'only the log',outputs:[frameworkFile(r.project_id)]}),/不能替代分析产出/);
  finish();assert.equal(current(process.id).status,'done');
  const entry=parseFramework(fs.readFileSync(frameworkFile(r.project_id),'utf8')).byId.get(good.id);
  assert.equal(entry.parent.id,r.parent);assert.ok(entry.meta.work.includes(process.id));assert.ok(entry.meta.links.includes(r.links[0]));
}));

test('invalid log contracts cannot be registered or overwrite task policy; normal manual steps still finish without logs',async()=>logDelivery(async({wire,process},r)=>{
  const invalid=[{...r,project_id:'bi-devices'},{...r,parent:'graphene-l-scalability'},{...r,links:['missing']},{...r,parent:r.links[0]}];
  for(const log_requirement of invalid) {
    const before=fs.readFileSync(path.join(root,'work/queue.json'));
    assert.throws(()=>enqueue({title:'bad contract',kind:'data',project_ids:['graphene-thz'],log_requirement}));
    assert.throws(()=>update({id:process.id,log_requirement}));
    assert.deepEqual(fs.readFileSync(path.join(root,'work/queue.json')),before);
  }
  assert.equal(current(wire.id).status,'done');
  const manual=enqueue({title:'ordinary manual work',kind:'experiment',actor:'user'});
  update({id:manual.id,status:'done',handoff:'done without processing'});assert.equal(current(manual.id).status,'done');
}));

test('a delivered processing log releases its successor despite an unrelated framework problem',async()=>logDelivery(async({process,email},r)=>{
  const file=frameworkFile(r.project_id);
  addEntry(r.project_id,{parent:r.parent,title:'Fixture processing complete',body:processingBody,work:[process.id],links:r.links});
  // The framework checker still owns this unrelated problem; it is not a missing delivery.
  fs.appendFileSync(file,'\n## Unrelated fixture\n<!--node {"id":"unrelated-fixture","status":"invalid"}-->\n');
  assert.ok(checkFramework(r.project_id).problems.some(p=>p.includes('unrelated-fixture')));
  let calls=0;
  await drain(async()=>{calls++;update({id:process.id,status:'done',handoff:'Processing complete; see the linked log.',outputs:[outcome('log-unrelated.csv')]});return {result:'Processing complete; see the linked log.'};});
  assert.equal(calls,1);assert.equal(current(process.id).status,'done');
  assert.equal(workSnapshot().items.find(i=>i.id===email.id).ready,true);
  assert.equal(checkFramework(r.project_id).ok,false,'completion does not hide or rewrite the unrelated issue');
}));

test('an unsubmitted processing reply returns open without releasing email, inventing a user decision or retrying',async()=>logDelivery(async({process,email})=>{
  let calls=0;
  const runner=async()=>{calls++;return {result:'处理完成（fixture）',artifacts:[outcome('log-no-record.csv')]};};
  await drain(runner);await drain(runner);await drain(runner);
  assert.equal(current(process.id).status,'open');assert.notEqual(current(process.id).review?.state,'pending');
  assert.equal(workSnapshot().items.find(i=>i.id===process.id).last_execution.outcome_status,'open');
  assert.equal(current(email.id).status,'queued');assert.equal(calls,1);
}));

test('automatic processing records a real log through entry-add before releasing the draft, repeats do not create more logs',async()=>logDelivery(async({process,email},r,saved)=>{
  const before=parseFramework(saved.toString()).nodes.filter(n=>n.entry).length;let calls=0,created;
  const runner=async(provider,prompt)=>{
    calls++;
    if(calls===1) {
      assert.ok(prompt.includes(process.id));assert.ok(prompt.includes(JSON.stringify(r)));assert.match(prompt,/projects entry-add/);
      created=addEntry(r.project_id,{parent:r.parent,title:'Fixture data processing',body:processingBody,work:[process.id],links:r.links});
      update({id:process.id,status:'done',handoff:'处理完成，日志 '+created.id,outputs:[outcome('log-analysis.csv')]});
      return {result:'处理完成，日志 '+created.id};
    }
    assert.match(prompt,/Fixture|处理完成/);
    update({id:email.id,status:'done',handoff:'草稿待用户确认，未发送',outputs:[outcome('log-draft.md')]});
    return {result:'草稿待用户确认，未发送'};
  };
  await drain(runner);assert.equal(current(process.id).status,'done');assert.equal(current(email.id).status,'queued');
  await drain(runner);await drain(runner);
  assert.equal(calls,2);assert.equal(current(email.id).status,'done');
  const parsed=parseFramework(fs.readFileSync(frameworkFile(r.project_id),'utf8'));
  assert.equal(parsed.nodes.filter(n=>n.entry).length,before+1);
  assert.equal(parsed.nodes.filter(n=>n.entry && n.meta.work?.includes(process.id)).length,1);
  assert.equal(parsed.byId.get(created.id).body,processingBody);assert.equal(checkFramework(r.project_id).ok,true);
}));

test('dragging a step re-files it and orders it among sibling steps without touching its state, and refuses what editing refuses',async()=>isolated(async()=>{
  const project_id='graphene-thz',mk=(title,node='graphene-array-cell-plan')=>addStep({project_id,plan_node_id:node,title,actor:'user'});
  const a=mk('move A'),b=mk('move B'),c=mk('move C'),order=()=>read('work/queue.json').items.map(i=>i.id);
  moveStep({project_id,id:a.id,after:c.id});assert.equal(order().indexOf(a.id),order().indexOf(c.id)+1);
  moveStep({project_id,id:c.id,before:b.id});assert.equal(order().indexOf(c.id)+1,order().indexOf(b.id));
  const original=current(b.id);moveStep({project_id,id:b.id,plan_node_id:'graphene-m-antenna'});
  const moved=current(b.id);assert.equal(moved.plan_node_id,'graphene-m-antenna');for(const k of ['id','status','actor','dependencies','title','goal','history'])assert.deepEqual(moved[k],original[k]);
  moveStep({project_id,id:a.id,before:b.id});assert.equal(current(a.id).plan_node_id,'graphene-m-antenna','next to a step means under the node that step belongs to');
  const stable=JSON.stringify(read('work/queue.json'));
  for(const bad of [{plan_node_id:'graphene-l-coupling'},{plan_node_id:'missing'},{before:a.id,after:c.id},{before:'missing'},{project_id:'other-project',plan_node_id:'graphene-m-antenna'}])
    assert.throws(()=>moveStep({project_id,id:c.id,...bad}));
  assert.throws(()=>moveStep({project_id,id:c.id,before:c.id}));assert.equal(JSON.stringify(read('work/queue.json')),stable);
  update({id:c.id,status:'active'});assert.throws(()=>moveStep({project_id,id:c.id,plan_node_id:'graphene-m-antenna'}),/正在执行/);update({id:c.id,status:'queued'});
  const sessions=read('.runtime/agent/sessions.json');write('.runtime/agent/sessions.json',{sessions:[{task_ids:[c.id]}]});
  assert.throws(()=>moveStep({project_id,id:c.id,plan_node_id:'graphene-m-antenna'}),/已交给助手/);write('.runtime/agent/sessions.json',sessions);
  editStep({id:a.id,action:'delete',revision:stepEditor(a.id).revision,confirm:true});assert.throws(()=>moveStep({project_id,id:a.id,plan_node_id:'graphene-m-antenna'}),/已不存在/);
}));

test('dragging a whole step list appends it to the target node in order, and one busy step keeps all of it where it is',async()=>isolated(async()=>{
  const project_id='graphene-thz',mk=(title,node)=>addStep({project_id,plan_node_id:node,title,actor:'user'}),titles=node=>read('work/queue.json').items.filter(i=>i.plan_node_id===node && i.title.startsWith('list ')).map(i=>i.title);
  const a=mk('list A','graphene-array-cell-plan'),b=mk('list B','graphene-array-cell-plan'),c=mk('list C','graphene-m-antenna'),d=mk('list D','graphene-array-cell-plan');
  const staysPut=()=>assert.deepEqual(titles('graphene-array-cell-plan'),['list A','list B','list D']);
  for(const bad of [{ids:[]},{ids:[a.id,a.id]},{ids:[a.id,'missing']},{ids:[a.id,b.id],before:c.id},{ids:[a.id,b.id],plan_node_id:'graphene-l-coupling'},{ids:[a.id],project_id:'other-project',plan_node_id:'graphene-m-antenna'}])
    assert.throws(()=>moveStep({project_id,plan_node_id:'graphene-m-antenna',...bad}));
  staysPut();
  update({id:b.id,status:'active'});assert.throws(()=>moveStep({project_id,ids:[a.id,b.id,d.id],plan_node_id:'graphene-m-antenna'}),/「list B」.*正在执行/);
  staysPut();update({id:b.id,status:'queued'});
  const original=[a,b,d].map(i=>current(i.id));
  moveStep({project_id,ids:[d.id,a.id,b.id],plan_node_id:'graphene-m-antenna'});
  assert.deepEqual(titles('graphene-m-antenna'),['list C','list A','list B','list D'],'appended after the existing steps, in their previous order');
  assert.deepEqual(titles('graphene-array-cell-plan'),[]);
  for(const o of original){const now=current(o.id);for(const k of ['status','actor','dependencies','title','goal','history'])assert.deepEqual(now[k],o[k]);}
  const settled=JSON.stringify(read('work/queue.json'));moveStep({project_id,ids:[a.id,b.id],plan_node_id:'graphene-m-antenna'});assert.equal(JSON.stringify(read('work/queue.json')),settled,'a drop that changes nothing writes nothing');
}));

test('step editing owns validation, stale protection and safe removal without losing identity or releasing dependents',async()=>isolated(async()=>{
  const {wire,measure,process:processing,email}=chain(false);
  const edit=(id,data)=>editStep({id,action:'content',revision:stepEditor(id).revision,...data});
  const before=JSON.stringify(current(wire.id));
  assert.throws(()=>edit(wire.id,{dependencies:[measure.id]}),/循环/);assert.equal(JSON.stringify(current(wire.id)),before);
  assert.throws(()=>edit(wire.id,{dependencies:[wire.id]}),/循环/);
  assert.throws(()=>edit(wire.id,{dependencies:['missing']}),/不存在/);
  const original=current(measure.id),snapshot=stepEditor(measure.id);
  edit(measure.id,{title:'cell A1 measurement',goal:'measure A1',handoff:'later',actor:'user',dependencies:[wire.id]});
  const changed=current(measure.id);for(const k of ['id','status','require_outputs','plan_node_id','outputs','history'])assert.deepEqual(changed[k],original[k]);
  assert.throws(()=>editStep({id:measure.id,action:'content',revision:snapshot.revision,title:'stale'}),/已被其他操作更新/);
  const remove=id=>editStep({id,action:'delete',revision:stepEditor(id).revision,confirm:true});
  assert.throws(()=>remove(wire.id),/依赖引用/);assert.equal(current(wire.id).status,'queued');
  update({id:wire.id,status:'active'});assert.throws(()=>edit(wire.id,{title:'while active'}),/正在执行/);
  update({id:wire.id,status:'queued'});
  const dispatched=read('.runtime/agent/sessions.json');write('.runtime/agent/sessions.json',{sessions:[{task_ids:[email.id]}]});
  assert.throws(()=>remove(email.id),/已交给助手/);write('.runtime/agent/sessions.json',dispatched);
  assert.throws(()=>editStep({id:email.id,action:'delete',revision:stepEditor(email.id).revision}),/确认/);
  remove(email.id);assert.ok(current(email.id).deleted_at);assert.equal(current(email.id).status,'cancelled');
  assert.ok(!workSnapshot().items.some(i=>i.id===email.id));assert.throws(()=>update({id:email.id,status:'queued'}),/已删除/);
  assert.deepEqual(startReadyWork(),[]);assert.ok(fs.readdirSync(path.join(root,'.runtime/work-edits')).length>0);
  edit(measure.id,{dependencies:[]});remove(wire.id);assert.equal(current(measure.id).status,'queued');
  assert.equal(workSnapshot().items.find(i=>i.id===measure.id).ready,true,'only explicit dependency edits can release a step');
}));

test('browser: edit operating steps and delete confirmed content, with blocked removal and draft retention',async()=>isolated(async()=>{
  const {editorSnapshot,editFramework}=await import('../projects/framework.mjs');
  const {wire,measure,email}=chain(false),file=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),saved=fs.readFileSync(file);
  const snap=()=>editorSnapshot('graphene-thz');
  const child=editFramework('graphene-thz',{revision:snap().revision,action:'add-node',parent:'graphene-array-cell-plan',title:'Disposable test subtree',body:'fixture',kind:'info'});
  const entry=editFramework('graphene-thz',{revision:snap().revision,action:'add-entry',parent:child.id,title:'Disposable child log',body:'fixture'});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
  try {
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.clock.install();const tickPoll=async()=>{const polled=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.clock.fastForward(5000);await polled;};await page.goto(base+'/#projects/graphene-thz');await page.locator('[data-project-edit-mode]').click();
    const dialog=page.locator('dialog.project-editor'),button=(id,action)=>page.locator(`[data-step-edit="${id}"]${action==='delete' ? '[data-step-action="delete"]' : ':not([data-step-action])'}`);
    await button(measure.id).click();await dialog.locator('[name=title]').fill('Cell A1 revised measurement');
    await dialog.locator('[name=goal]').fill('Measure at 111 Hz, save location in note');
    await dialog.locator('[name=handoff]').fill('Data path will be filled after measurement');
    await tickPoll();assert.equal(await dialog.locator('[name=title]').inputValue(),'Cell A1 revised measurement');
    if(process.env.PHD_TEST_ARTIFACTS){fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'step-editor-desktop.png')});}
    await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
    if(process.env.PHD_TEST_ARTIFACTS)await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'step-editor-mobile.png')});
    await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'detached'});
    assert.equal(current(measure.id).title,'Cell A1 revised measurement');assert.equal(current(measure.id).status,'queued');assert.deepEqual(current(measure.id).dependencies,[wire.id]);
    await page.setViewportSize({width:1440,height:1100});
    await button(measure.id).click();await dialog.locator('[name=goal]').fill('Draft after concurrent change');
    editStep({id:measure.id,action:'content',revision:stepEditor(measure.id).revision,goal:'Other writer changed step'});
    await dialog.locator('[type=submit]').click();await dialog.locator('[data-step-rebase]').waitFor();
    assert.equal(await dialog.locator('[name=goal]').inputValue(),'Draft after concurrent change');assert.equal(current(measure.id).goal,'Other writer changed step');
    await dialog.locator('[data-step-rebase]').click();await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'detached'});
    assert.equal(current(measure.id).goal,'Draft after concurrent change');
    await button(wire.id,'delete').click();await dialog.locator('[name=confirm]').check();await dialog.locator('[type=submit]').click();
    await dialog.locator('.editor-error').getByText(/依赖引用/).waitFor();assert.equal(current(wire.id).status,'queued');
    page.once('dialog',d=>d.accept());await dialog.locator('[data-editor-close]').last().click();await dialog.waitFor({state:'detached'});
    await button(email.id,'delete').click();
    assert.equal(await dialog.locator('[name=confirm]').isChecked(),false);assert.equal(current(email.id).status,'queued');
    await dialog.locator('[type=submit]').click();assert.equal(current(email.id).status,'queued');assert.ok(await dialog.isVisible(),'unconfirmed removal must not submit');
    await dialog.locator('[name=confirm]').check();await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'detached'});
    await button(email.id,'delete').waitFor({state:'detached'});assert.ok(current(email.id).deleted_at);assert.equal(current(measure.id).status,'queued');
    const openNode=async id=>page.evaluate(id=>{let el=document.querySelector(`[data-fw-id="${id}"]`);while(el){if(el.tagName==='DETAILS')el.open=true;el=el.parentElement;}},id);
    await openNode('graphene-array-cell-plan');await page.locator('[data-fw-edit="graphene-array-cell-plan"][data-editor-action="delete"]').click();
    await dialog.locator('[name=confirm]').check();await dialog.locator('[type=submit]').click();await dialog.locator('.editor-error').getByText(/绑定操作步骤/).waitFor();
    page.once('dialog',d=>d.accept());await dialog.locator('[data-editor-close]').last().click();
    await openNode(child.id);await page.locator(`[data-fw-edit="${child.id}"][data-editor-action="delete"]`).click();
    await dialog.getByText(/1 个下级条目/).waitFor();
    if(process.env.PHD_TEST_ARTIFACTS)await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-delete-confirm.png')});
    await dialog.locator('[name=confirm]').check();await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'detached'});
    assert.ok(!snap().nodes.some(n=>n.id===child.id || n.id===entry.id));assert.equal(checkFramework('graphene-thz').ok,true);
    assert.deepEqual(errors,[]);assert.equal(read('.runtime/agent/sessions.json').sessions.length,0,'editing/deletion must not dispatch a model');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(file,saved);}
}));

test('dependency gate blocks begin/complete; failure cascades and reopening the predecessor does not silently revive descendants',async()=>isolated(async()=>{
  const {wire,measure}=chain(),before=fs.readFileSync(path.join(root,'work/queue.json'),'utf8');
  assert.throws(()=>update({id:measure.id,status:'active'}),/前置/);
  assert.throws(()=>update({id:measure.id,status:'done',handoff:'x',outputs:[outcome('invalid-early.csv')]}),/前置/);
  assert.equal(fs.readFileSync(path.join(root,'work/queue.json'),'utf8'),before);
  update({id:wire.id,status:'failed',handoff:'bond failed'});
  assert.equal(readiness(current(measure.id),read('work/queue.json').items).ready,false);
  update({id:wire.id,status:'queued'});
  assert.equal(current(wire.id).history.at(-1).reason,'','reopening does not require a justification');
  update({id:wire.id,status:'done',handoff:'键合完成'});
  assert.equal(current(measure.id).status,'failed');
  assert.equal(workSnapshot().items.find(i=>i.id===measure.id).ready,false);
  update({id:measure.id,status:'queued',reason:'前置已修复，明确重新安排测量'});
  assert.equal(current(measure.id).history.at(-1).reason,'前置已修复，明确重新安排测量','supplied reasons are still recorded');
  assert.equal(workSnapshot().items.find(i=>i.id===measure.id).ready,true);
  assert.equal(current(wire.id).history.at(-1).to,'done');
}));

test('measurement location is filled at completion: note alone, missing path, or no note cannot release processing',async()=>isolated(async()=>{
  const {wire,measure}=chain();update({id:wire.id,status:'done',handoff:'done'});
  assert.throws(()=>update({id:measure.id,status:'done',handoff:'测完了'}),/位置和留言/);
  assert.throws(()=>update({id:measure.id,status:'done',handoff:'测完了',outputs:['.runtime/missing-data.csv']}),/不存在/);
  assert.throws(()=>update({id:measure.id,status:'done',outputs:[outcome('measurement.csv')]}),/位置和留言/);
  assert.equal(startReadyWork().length,0);
}));

test('filing an ordinary operation under a project topic does not require or create a project log',async()=>isolated(async()=>{
  const file=frameworkFile('graphene-thz'),saved=fs.readFileSync(file);
  const step=enqueue({title:'Fixture state repair',kind:'framework',actor:'claude',status:'queued',project_ids:['graphene-thz'],plan_node_id:'graphene-m-quality'});
  const next=enqueue({title:'Fixture next step',kind:'experiment',actor:'user',project_ids:['graphene-thz'],dependencies:[step.id]});
  assert.equal(logRequirementOf(step),null);
  const ordinaryLog=path.join(root,'logs','fixture-state-repair.md');
  try {
    await drain(async(_,prompt)=>{
      assert.doesNotMatch(prompt,/项目日志交付要求|使用 projects entry-add/);
      fs.mkdirSync(path.dirname(ordinaryLog),{recursive:true});
      fs.writeFileSync(ordinaryLog,'Fixture operation repaired; no research result.');
      update({id:step.id,status:'done',handoff:'Operation complete; see the ordinary log.',outputs:[ordinaryLog]});
      return {result:'Operation complete; see the ordinary log.'};
    });
    assert.equal(current(step.id).status,'done');
    assert.equal(workSnapshot().items.find(i=>i.id===next.id).ready,true);
    assert.deepEqual(fs.readFileSync(file),saved,'ordinary operations do not add research history');
    assert.match(fs.readFileSync(ordinaryLog,'utf8'),/operation repaired/);
    const requirement={project_id:'graphene-thz',parent:'graphene-m-quality',links:[]};
    assert.deepEqual(logRequirementOf({...step,log_requirement:requirement}),requirement,'explicit research-log requirements remain available');
    assert.equal(logRequirementOf({...step,log_requirement:null}),null);
  } finally {fs.rmSync(ordinaryLog,{force:true});}
}));

test('the status alone decides whether an assistant step starts; auto_start is retired and refused',async()=>isolated(async()=>{
  const held=enqueue({title:'held assistant step',kind:'data',actor:'claude',project_ids:['graphene-thz']});
  assert.equal(held.status,'open','registering an assistant step does not queue it');assert.deepEqual(startReadyWork(),[]);
  const mine=enqueue({title:'my to-do',kind:'data',actor:'user',project_ids:['graphene-thz']});
  assert.equal(mine.status,'queued');assert.deepEqual(startReadyWork(),[],'a to-do for the user never starts anything');
  update({id:held.id,status:'queued'});
  const started=startReadyWork();assert.equal(started.length,1);assert.equal(started[0].task_id,held.id);
  assert.deepEqual(startReadyWork(),[],'handed over once');
  let text;
  await drain(async(_provider,prompt)=>{text=prompt;update({id:held.id,status:'done',handoff:'Delivered.',outputs:[outcome('status-contract.csv')]});return {result:'Delivered.'};});
  assert.match(text,/做到交付为止，能自行补齐的信息自行查明/);assert.match(text,/一般细节可按合理假设继续/);assert.match(text,/确实缺少输入且无法自行取得/);assert.match(text,/waiting_user/);assert.match(text,/smallest-complete skill/);assert.match(text,/status":"done"/);
  assert.throws(()=>enqueue({title:'x',kind:'data',actor:'claude',auto_start:true}),/auto_start 已取消/);
  assert.throws(()=>update({id:mine.id,auto_start:true}),/auto_start 已取消/);
}));

test('five step states: registration starts 未开始 and runs nothing; 待办 needs an operator; manual progress makes the user the operator; a running assistant step is not hand-editable',async()=>isolated(async()=>{
  const step=addStep({project_id:'graphene-thz',plan_node_id:'graphene-array-cell-plan',title:'five-state fixture',actor:'claude'});
  assert.equal(step.status,'open');assert.equal(readiness(step,[step]).ready,false);
  // an assistant step in 未开始 is invisible to the executor
  assert.deepEqual(startReadyWork(),[]);
  assert.throws(()=>setStepStatus({id:step.id,status:'queued'}),/操作对象/);
  assert.throws(()=>setStepStatus({id:step.id,status:'running'}),/不合法/);
  assert.equal(setStepStatus({id:step.id,status:'queued',actor:'claude'}).status,'queued');
  assert.equal(workSnapshot().items.find(i=>i.id===step.id).ready,true);
  // moving back to 未开始 withdraws it; a 待办 step the user operates is just a to-do and never starts
  assert.equal(setStepStatus({id:step.id,status:'open'}).status,'open');
  assert.equal(setStepStatus({id:step.id,status:'queued',actor:'user'}).status,'queued');assert.deepEqual(startReadyWork(),[]);
  assert.equal(setStepStatus({id:step.id,status:'open'}).status,'open');
  assert.equal(setStepStatus({id:step.id,status:'queued',actor:'claude'}).status,'queued');
  assert.equal(setStepStatus({id:step.id,status:'open'}).status,'open');
  // marking progress by hand hands the step to the user; the old operator stays in history
  const taken=setStepStatus({id:step.id,status:'active'});
  assert.equal(taken.actor,'user');
  assert.equal(taken.history.at(-1).actor_from,'claude');
  assert.equal(setStepStatus({id:step.id,status:'active'}).actor,'user','same state is a no-op');
  // a step an assistant is actually running (active, or dispatched to a session) cannot be changed by hand; the executor's own update still works
  const running=enqueue({title:'running fixture',kind:'data',actor:'codex'});update({id:running.id,status:'active'});
  assert.throws(()=>setStepStatus({id:running.id,status:'failed'}),/不能手动改状态/);
  assert.equal(current(running.id).actor,'codex');
  assert.equal(update({id:running.id,status:'done',handoff:'assistant finished'}).actor,'codex','the executor finishing keeps the assistant as operator');
  const handed=enqueue({title:'dispatched fixture',kind:'data',actor:'claude',status:'queued'});
  write('.runtime/agent/sessions.json',{sessions:[{id:'fixture-session',task_ids:[handed.id]}]});
  assert.throws(()=>setStepStatus({id:handed.id,status:'open'}),/不能手动改状态/);
}));

test('fast end-to-end: HTTP completion → original-ID assistant context → artifact → draft; repeated ticks and controller reload do not duplicate',async()=>isolated(async()=>{
  const {wire,measure,process,email}=chain();
  const manual=enqueue({title:'not opted in',kind:'data',actor:'codex'});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async body=>{const res=await fetch(base+'/api/task-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const calls=[];
  try {
    assert.equal((await post({id:measure.id,status:'active'})).status,400);
    assert.equal((await post({id:wire.id,status:'done',handoff:'wire ready'})).status,200);
    const data=outcome('workflow-raw.csv');
    assert.equal((await post({id:measure.id,status:'done',handoff:'cell A1、A2；111 Hz；数据在已填写的位置',outputs:[data]})).status,200);
    const started=startReadyWork();assert.equal(started.length,1);assert.equal(started[0].task_id,process.id);
    assert.deepEqual(startReadyWork(),[]);
    const reloaded=await import('../agent/run.mjs?workflow-restart');assert.deepEqual(reloaded.startReadyWork(),[]);
    const runner=async(provider,prompt)=>{
      calls.push({provider,prompt});
      if(calls.length===1) {
        assert.match(prompt,/cell A1、A2/);assert.ok(prompt.includes(data));assert.match(prompt,/不对外发送邮件/);
        update({id:process.id,status:'done',handoff:'处理完成，已保存。',outputs:[outcome('workflow-analysis.csv')]});
        return {result:'处理完成，已保存。'};
      }
      assert.ok(prompt.includes(path.join(root,'.runtime/workflow-analysis.csv')));
      update({id:email.id,status:'done',handoff:'邮件草稿待用户确认，未发送。',outputs:[outcome('workflow-email.md')]});
      return {result:'邮件草稿待用户确认，未发送。'};
    };
    await drain(runner);assert.equal(current(process.id).status,'done');assert.equal(current(email.id).status,'queued');
    await drain(runner);await drain(runner);await drain(runner);
    assert.equal(calls.length,2);assert.ok(calls.every(c=>c.provider==='claude'));
    assert.equal(current(email.id).status,'done');assert.equal(current(manual.id).status,'open');
    assert.equal(workSnapshot().items.filter(i=>!i.turn).length,5,'execution history does not create shadow operations');
    assert.equal(workSnapshot().items.filter(i=>i.operation_id).length,2,'each actual execution appends its own history');
    const state=await (await fetch(base+'/api/state')).json();
    assert.deepEqual(state.work.items.find(i=>i.id===email.id).outputs,[path.join(root,'.runtime/workflow-email.md')]);
    assert.equal(read('.runtime/agent/sessions.json').sessions.length,2);
  } finally {await new Promise(r=>server.close(r));}
}));

test('an assistant can explicitly wait for actual input without releasing email or repeatedly calling the model',async()=>isolated(async()=>{
  const {wire,measure,process,email}=chain();update({id:wire.id,status:'done',handoff:'done'});
  update({id:measure.id,status:'done',handoff:'raw data',outputs:[outcome('workflow-incomplete.csv')]});
  let calls=0;const runner=async()=>{calls++;update({id:process.id,status:'waiting_user',handoff:'需要补充通道定义，暂时无法处理。'});return {result:'需要补充通道定义，暂时无法处理。'};};
  await drain(runner);await drain(runner);await drain(runner);
  assert.equal(current(process.id).status,'waiting_user');assert.equal(current(email.id).status,'queued');assert.equal(calls,1);
}));

// Natural incident, 2026-10-17: a disc data step had no require_outputs flag,
// said it had not started, and was nevertheless marked done by provider return.
test('an unfinished business operation is not completed merely because the provider reply ends',async()=>isolated(async()=>{
  const analysis=enqueue({title:'disc index incident fixture',kind:'data',actor:'claude',status:'queued',project_ids:['graphene-thz']});
  const after=enqueue({title:'must not run without index',kind:'framework',actor:'codex',status:'queued',dependencies:[analysis.id]});
  assert.equal(current(analysis.id).require_outputs,undefined,'reproduce the missing flag, not the already-protected path');
  let calls=0;
  const runner=async(_provider,prompt)=>{
    calls++;assert.match(prompt,/本操作交付实际文件/);assert.match(prompt,/waiting_user/);
    return {result:'我还没开始盘点，因为没有找到数据位置。我在这里停下，等你给路径。'};
  };
  await drain(runner);
  assert.equal(current(analysis.id).status,'open');assert.notEqual(current(analysis.id).review?.state,'pending');
  assert.deepEqual(current(analysis.id).outputs,[]);assert.equal(current(analysis.id).completed_at,undefined);
  assert.equal(current(after.id).status,'queued');assert.equal(readiness(current(after.id),read('work/queue.json').items).ready,false);
  await drain(runner);assert.equal(calls,1);
}));

test('queued index cannot start before its measurement prerequisite; real file delivery releases follow-up',async()=>isolated(async()=>{
  const measure=enqueue({title:'disc measurement fixture',kind:'experiment',actor:'user'});
  update({id:measure.id,status:'active'});
  const analysis=enqueue({title:'disc index fixture',kind:'data',actor:'claude',status:'queued',dependencies:[measure.id]});
  let calls=0;
  const file=outcome('disc-delivery-fixture.csv');
  const runner=async()=>{calls++;update({id:analysis.id,status:'done',handoff:'Index delivered.',outputs:[file]});return {result:'Index delivered.'};};
  await drain(runner);assert.equal(calls,0);assert.equal(current(analysis.id).status,'queued');
  update({id:measure.id,status:'done',handoff:'Synthetic measurement only.'});
  await drain(runner);assert.equal(calls,1);assert.equal(current(analysis.id).status,'done');
  assert.deepEqual(current(analysis.id).outputs,[file]);
}));

// 2026-10-26 disc stages 2/3: root + relative filenames in the final reply
// were not registered. The task ID and outputs receipt make delivery explicit;
// registration remains while active; only an explicit done releases the dependent.
test('active output registration survives a relative-path reply and an explicit finish reaches the next step',async()=>isolated(async()=>{
  const analysis=enqueue({title:'registered disc result',kind:'data',actor:'claude',status:'queued'});
  const after=enqueue({title:'read registered disc result',kind:'framework',actor:'codex',status:'queued',dependencies:[analysis.id]});
  const relative='.runtime/disc-registered.csv',file=outcome('disc-registered.csv');
  let calls=0;
  await drain(async(_provider,prompt)=>{
    calls++;assert.match(prompt,new RegExp(analysis.id));assert.match(prompt,/work update/);
    assert.equal(current(analysis.id).status,'active');
    update({id:analysis.id,outputs:[relative]});
    assert.equal(current(analysis.id).status,'active');
    assert.equal(readiness(current(after.id),read('work/queue.json').items).ready,false);
    update({id:analysis.id,status:'done',handoff:'Analysis complete.'});
    return {result:'Analysis complete; disc-registered.csv is in the output directory.'};
  });
  assert.equal(current(analysis.id).status,'done');assert.deepEqual(current(analysis.id).outputs,[relative]);
  assert.equal(readiness(current(after.id),read('work/queue.json').items).ready,true);
  await drain(async(_provider,prompt)=>{
    calls++;assert.ok(prompt.includes(relative),'the receiving step gets the registered path');
    assert.equal(fs.readFileSync(path.resolve(root,relative),'utf8'),fs.readFileSync(file,'utf8'));
    update({id:after.id,status:'done',handoff:'Read the delivered data.'});
    return {result:'Read the delivered data.'};
  });
  assert.equal(current(after.id).status,'done');assert.equal(calls,2);
}));

// Natural incident in this turn: a newly added fragment value was absent in the
// running backend. Global pre-rendering blocked every unrelated queued session.
test('one broken operation prompt does not block unrelated conversations or steps',async()=>isolated(async()=>{
  const fragment=path.join(root,'prompts/fragments/task/require-outputs.md'),before=fs.readFileSync(fragment);
  const broken=enqueue({title:'broken prompt fixture',kind:'data',actor:'claude',status:'queued'});
  const good=enqueue({title:'independent operation',kind:'framework',actor:'codex',status:'queued'});
  const {submit}=await import('../agent/run.mjs');
  const chat=submit({text:'@DeepSeek Answer the independent question.'});
  const calls=[];
  try {
    fs.writeFileSync(fragment,'{{missing_binding}}');
    await drain(async(provider,prompt,opts)=>{if(opts.purpose!=='title'){calls.push(provider);if(provider==='codex')update({id:good.id,status:'done',handoff:'Complete.'});}return {result:'Complete.'};});
    assert.equal(current(broken.id).status,'failed');assert.match(current(broken.id).handoff,/missing_binding/);
    assert.equal(current(good.id).status,'done');assert.equal(current(chat.task_id).status,'done');
    assert.deepEqual(calls.sort(),['codex','deepseek']);
    await drain(async()=>{throw new Error('completed and failed work must not restart');});
    assert.equal(current(broken.id).status,'failed');
  } finally {fs.writeFileSync(fragment,before);}
}));

test('explicit file-free steps still complete, while an explicit waiting state survives normal provider return',async()=>isolated(async()=>{
  const brief=enqueue({title:'file-free explanation',kind:'data',actor:'claude',status:'queued',require_outputs:false});
  await drain(async()=>{update({id:brief.id,status:'done',handoff:'This answer discusses a failure but is complete.'});return {result:'This answer discusses a failure but is complete.'};});
  assert.equal(current(brief.id).status,'done');
  const paused=enqueue({title:'explicitly paused explanation',kind:'framework',actor:'claude',status:'queued'});
  await drain(async()=>{
    update({id:paused.id,status:'waiting_user',handoff:'Need a specific input.'});
    return {result:'Checkpoint recorded.'};
  });
  assert.equal(current(paused.id).status,'waiting_user');assert.equal(current(paused.id).completed_at,undefined);
}));

test('assistant operation failure fails dependents and allows one topic replan, never retries the failed operation; disabled execution dispatches nothing',async()=>isolated(async()=>{
  const {wire,measure,process,email}=chain();update({id:wire.id,status:'done',handoff:'done'});
  update({id:measure.id,status:'done',handoff:'raw',outputs:[outcome('workflow-failure.csv')]});
  const config=read('agent/config.json');write('agent/config.json',{...config,enabled:false});assert.deepEqual(startReadyWork(),[]);
  write('agent/config.json',config);
  let calls=0;const runner=async()=>{calls++;throw new Error('fixture provider failure');};
  await drain(runner);
  planProgress(Date.now()+read('automation/config.json').autonomy.debounce_seconds*1000+1);
  await drain(runner);await drain(runner);
  assert.equal(current(process.id).status,'failed');assert.equal(current(email.id).status,'failed');assert.equal(calls,2);
  const plans=read('work/queue.json').items.filter(i=>i.autonomy?.type==='plan');
  assert.equal(plans.length,1);assert.equal(plans[0].status,'failed');
}));

test('page: 未开始 → 待办 asks for the operator; manual progress takes over from an assistant; a running assistant chip is locked',async()=>isolated(async()=>{
  write('agent/config.json',{...read('agent/config.json'),enabled:false}); // UI only: 待办 + assistant would otherwise start a real run
  const open=addStep({project_id:'graphene-thz',plan_node_id:'graphene-array-cell-plan',title:'ui open step',actor:'user'});
  const take=enqueue({title:'ui takeover step',kind:'data',actor:'claude',status:'queued',project_ids:['graphene-thz'],plan_node_id:'graphene-array-cell-plan'});
  const running=enqueue({title:'ui running step',kind:'data',actor:'codex',project_ids:['graphene-thz'],plan_node_id:'graphene-array-cell-plan'});update({id:running.id,status:'active'});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;let browser;
  try {
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1200}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base+'/#projects/graphene-thz');
    const chip=id=>page.locator(`[data-step-chip="${id}"]`);
    await chip(open.id).waitFor();
    assert.match(await chip(open.id).innerText(),/未开始／待定义/);
    assert.equal(await chip(running.id).isDisabled(),true,'a running assistant step cannot be hand-edited');
    assert.match(await page.locator(`[data-step-row="${running.id}"]`).innerText(),/助手正在执行/);
    await chip(open.id).click();
    assert.deepEqual(await page.locator('#fw-menu [data-step-set]').allInnerTexts(),['未开始／待定义','待办','正在进行','完成','失败'].map(t=>t));
    await page.locator('#fw-menu [data-step-set="queued"]').click();
    await page.locator('#fw-menu select[data-step-actor]').selectOption('codex');
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>document.querySelector(`[data-step-chip="${id}"]`)?.classList.contains('st-todo'),open.id);
    assert.equal(current(open.id).status,'queued');assert.equal(current(open.id).actor,'codex');
    await chip(take.id).click();await page.locator('#fw-menu [data-step-set="active"]').click();
    assert.match(await page.locator('#fw-menu .fw-ask').innerText(),/改为你/);
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>document.querySelector(`[data-step-chip="${id}"]`)?.classList.contains('st-doing'),take.id);
    assert.equal(current(take.id).actor,'user');
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
}));

test('page: steps under the cell measurement/repair plan, lamps write to work, location goes in the note; assistant steps run once via drain',async()=>isolated(async()=>{
  const {wire,measure,process:processing,email}=chain(false);
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;let browser;
  const note='cell A1、A2；111 Hz；数据在 D:/fixture/array-0001/（测试用，不存在也可以）';
  try {
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1200}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base+'/#projects/graphene-thz');
    const node=page.locator('[data-work-node="graphene-array-cell-plan"]'),row=id=>page.locator(`[data-step-row="${id}"]`),chip=id=>page.locator(`[data-step-chip="${id}"]`);
    await node.locator('> summary').waitFor();
    assert.equal(await node.evaluate(n=>n.open),true,'有未完成步骤的日志主题默认展开');
    assert.equal(await page.locator('.fw-board.fw-logic [data-step-chip]').count(),0,'current actions never appear in the argument map');
    assert.equal(await page.locator('[data-fw-execution]').count(),0,'no separate current-work board');
    assert.equal(await page.locator('.fw-timeline [data-step-row]').count(),4,'steps occur once inside the log');
    assert.equal(await page.locator('.fw-timeline [data-fw-id="graphene-array-cell-plan"][data-work-node]').count(),1,'steps belong to the cell plan sub-section');
    assert.equal(await page.locator('[data-fw-id="graphene-m-array"] > .fw-content-inner > .fw-steps').count(),0,'no steps at the outer array topic');
    assert.equal(await page.locator('[data-fw-id="graphene-m-array"]').evaluate(n=>n.open),true,'ancestor remains expanded so the plan is reachable');
    assert.ok(await node.locator('[data-fw-id="T-20261007-26"] > summary').isVisible(),'the original plan record is beside the operating steps');
    assert.equal(await node.locator('> .fw-content-inner > .fw-steps [data-step-row]').count(),4);
    assert.match(await node.locator('> summary .pill').first().innerText(),/步骤 0 \/ 4/);
    assert.match(await row(measure.id).innerText(),/等待前置/);assert.match(await row(wire.id).innerText(),/可做/);
    assert.equal(await page.locator('[data-expand="work:graphene-thz"]').count(),0,'steps are not repeated under "其他执行事项"');
    assert.equal(await page.locator('[data-fw-id="T-20261007-26"] > summary [data-fw-chip]').count(),0,'the plan record carries no operating lamp');
    // a blocked step cannot be started or completed from the menu
    await chip(measure.id).click();
    assert.equal(await page.locator('#fw-menu [data-step-set="done"]').isDisabled(),true);assert.equal(await page.locator('#fw-menu [data-step-set="active"]').isDisabled(),true);
    await page.keyboard.press('Escape');
    // done needs a note: error stays inline and typed text survives
    await chip(wire.id).click();await page.locator('#fw-menu [data-step-set="done"]').click();
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(()=>document.querySelector('#fw-menu .fw-err')?.textContent);
    assert.equal(await page.locator('#fw-menu [data-step-paths]').count(),0);
    await page.locator('#fw-menu [data-step-note]').fill('键合 A1、A2 到 fixture 板');
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>document.querySelector(`[data-step-chip="${id}"]`)?.classList.contains('st-done'),wire.id);
    assert.match(await row(measure.id).innerText(),/可做/);
    // reopening succeeds without a reason, and the successor waits again
    await chip(wire.id).click();await page.locator('#fw-menu [data-step-set="queued"]').click();
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>/等待前置/.test(document.querySelector(`[data-step-row="${id}"]`)?.innerText || ''),measure.id);
    assert.equal(current(wire.id).history.at(-1).reason,'');
    await chip(wire.id).click();await page.locator('#fw-menu [data-step-set="done"]').click();
    await page.locator('#fw-menu [data-step-note]').fill('重新键合完成');await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>/可做/.test(document.querySelector(`[data-step-row="${id}"]`)?.innerText || ''),measure.id);
    // measurement: the data location is written in the note; an empty note is refused
    await chip(measure.id).click();await page.locator('#fw-menu [data-step-set="done"]').click();
    await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(()=>document.querySelector('#fw-menu .fw-err')?.textContent);
    assert.equal(current(measure.id).status,'queued');assert.equal(startReadyWork().length,0);
    await page.locator('#fw-menu [data-step-note]').fill(note);await page.locator('#fw-menu [data-step-confirm]').click();
    await page.waitForFunction(id=>document.querySelector(`[data-step-chip="${id}"]`)?.classList.contains('st-done'),measure.id);
    assert.match(await row(measure.id).innerText(),/D:\/fixture\/array-0001/);
    assert.match(await node.locator('> summary .pill').first().innerText(),/步骤 2 \/ 4/);
    // the assistant steps are released by the existing drain, once each, under their original ids
    const calls=[];
    const runner=async(provider,prompt)=>{
      calls.push(prompt);
      if(calls.length===1){assert.ok(prompt.includes(note));assert.match(prompt,/没有单独填写/);update({id:processing.id,status:'done',handoff:'处理完成。',outputs:[outcome('page-analysis.csv')]});return {result:'处理完成。'};}
      update({id:email.id,status:'done',handoff:'邮件草稿待用户确认，未发送。',outputs:[outcome('page-email.md')]});
      return {result:'邮件草稿待用户确认，未发送。'};
    };
    await drain(runner);await drain(runner);await drain(runner);
    assert.equal(calls.length,2);assert.equal(current(processing.id).status,'done');assert.equal(current(email.id).status,'done');
    assert.equal(workSnapshot().items.filter(i=>!i.turn).length,4);
    await page.reload();
    const array=page.locator('[data-fw-id="graphene-m-array"]');
    await array.locator('> summary').waitFor();
    if(!await array.evaluate(n=>n.open))await array.locator('> summary').click();
    await node.locator('> summary').waitFor();
    if(!await node.evaluate(n=>n.open))await node.locator('> summary').click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-work-node="graphene-array-cell-plan"] > .fw-content-inner > .fw-steps .st-done').length===4);
    assert.match(await node.locator('> summary .pill').first().innerText(),/步骤 4 \/ 4/);
    assert.deepEqual(errors,[]);
    if(process.env.PHD_TEST_ARTIFACTS){fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});await node.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'array-steps.png')});}
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
}));
