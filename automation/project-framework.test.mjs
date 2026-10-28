import { launchEdge } from './browser-launch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {projectsView} from '../dashboard/workspace.js';
import {createServer} from '../dashboard/server.mjs';
import {resolveProjectFile,projectNode} from '../projects/run.mjs';
import {checkFramework} from '../projects/framework.mjs';
import {root,read,write} from './files.mjs';
import {submit,execute} from '../agent/run.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');

// Real mouse drag with both ends on screen: Playwright's dragTo scrolls the target into view only after the button is down, so a long page never starts the drag.
// A polling re-render can replace the element between waitFor() and boundingBox(), which then returns null; wait for a real box instead.
async function boxOf(page,locator) {
  for(let i=0;i<50;i++){const box=await locator.boundingBox();if(box)return box;await page.waitForTimeout(100);}
  throw new Error('element never had a bounding box: '+locator);
}
async function dragBetween(page,source,target,position) {
  await source.waitFor();await target.waitFor();
  const s=await boxOf(page,source),t=await boxOf(page,target);
  await page.evaluate(dy=>window.scrollBy(0,dy),(s.y+t.y)/2-500);
  const a=await boxOf(page,source),b=await boxOf(page,target);
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(b.x+(position?.x ?? b.width/2),b.y+(position?.y ?? b.height/2),{steps:12});await page.mouse.up();
}
const flatNodes=boards=>boards.flatMap(n=>[n,...flatNodes(n.children || [])]);
const state=project=>({projects:[project],work:{items:[]},weekly:{plan:null},links:[],mail:{tasks:[]},literature:{papers:[]}});

test('page-created steps validate log ownership and dependencies and cannot grant model dispatch',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'isolated runner only');
  const {addStep,newStepEditor,enqueue}=await import('../work/run.mjs');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const project_id='graphene-thz',plan_node_id='graphene-array-cell-plan';
  try {
    const a=addStep({project_id,plan_node_id,title:'Fixture step',actor:'user'});
    const b=addStep({project_id,plan_node_id,title:'Fixture assistant',actor:'codex',dependencies:[a.id]});
    assert.equal(b.auto_start,undefined);assert.equal(b.status,'open');assert.equal(a.status,'open');assert.deepEqual(b.dependencies,[a.id]);
    assert.equal(newStepEditor(project_id,plan_node_id).owner.id,plan_node_id);
    const longGoal='Full instructions. '.repeat(400)+'FINAL_REQUIREMENT';
    assert.equal(addStep({project_id,plan_node_id,title:'Long instructions',goal:longGoal}).goal,longGoal);
    const other=enqueue({title:'Other project',kind:'experiment',actor:'user',project_ids:['bi-devices']});
    const before=fs.readFileSync(path.join(root,'work/queue.json'));
    for(const bad of [{plan_node_id:'does-not-exist'},{plan_node_id:'graphene-l-coupling'},{dependencies:['missing']},{dependencies:[other.id]},{actor:'program'}]) {
      assert.throws(()=>addStep({project_id,plan_node_id,title:'Reject',...bad}));
      assert.deepEqual(fs.readFileSync(path.join(root,'work/queue.json')),before);
    }
    assert.deepEqual(read('.runtime/agent/sessions.json'),sessions,'no model task or session created');
  }finally{write('work/queue.json',queue);}
});

test('prerequisites exclude chat turns and cancelled steps while preserving existing references',async()=>{
  const {addStep,newStepEditor,stepEditor,editStep,update}=await import('../work/run.mjs');
  const queue=read('work/queue.json'),sessions=read('.runtime/agent/sessions.json');
  const project_id='graphene-thz',plan_node_id='graphene-array-cell-plan';
  try {
    write('work/queue.json',{...queue,items:[]});
    const chat=submit({text:'快快',project_id});
    const cancelledChat=submit({text:'先跑起来再说',project_id});update({id:cancelledChat.task_id,status:'cancelled'});
    const cancelled=addStep({project_id,plan_node_id,title:'Cancelled step'});update({id:cancelled.id,status:'cancelled'});
    const valid=addStep({project_id,plan_node_id,title:'Real step'});
    const target=addStep({project_id,plan_node_id,title:'Target step',dependencies:[valid.id]});
    const ids=snapshot=>snapshot.choices.map(i=>i.id);
    assert.deepEqual(ids(newStepEditor(project_id,plan_node_id)),[valid.id,target.id]);
    assert.deepEqual(ids(stepEditor(target.id)),[valid.id]);
    const before=fs.readFileSync(path.join(root,'work/queue.json'));
    for(const id of [chat.task_id,cancelledChat.task_id,cancelled.id]) {
      assert.throws(()=>addStep({project_id,plan_node_id,title:'Reject',dependencies:[id]}),/前置步骤/);
      assert.throws(()=>editStep({id:target.id,revision:stepEditor(target.id).revision,action:'content',dependencies:[id]}),/前置步骤/);
      assert.deepEqual(fs.readFileSync(path.join(root,'work/queue.json')),before);
    }
    // Historical references to a chat or cancelled step must survive an unrelated title edit.
    const q=read('work/queue.json');q.items.find(i=>i.id===target.id).dependencies=[chat.task_id,cancelled.id,valid.id];write('work/queue.json',q);
    const snapshot=stepEditor(target.id);assert.deepEqual(ids(snapshot),[chat.task_id,cancelled.id,valid.id]);
    editStep({id:target.id,revision:snapshot.revision,action:'content',title:'Renamed target',dependencies:snapshot.item.dependencies});
    assert.deepEqual(stepEditor(target.id).item.dependencies,snapshot.item.dependencies);
  } finally {write('work/queue.json',queue);write('.runtime/agent/sessions.json',sessions);}
});

test('delete editor unlinks references and task bindings, preserves backup/files, and retains confirmation and revision behavior',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const {editorSnapshot,editFramework,parseFramework}=await import('../projects/framework.mjs');
  const project='zz-editor-delete',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  const original='## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### Branch\n<!--node {"id":"branch"}-->\n\n#### Child\n<!--node {"id":"child","files":[{"path":"keep.csv"}]}-->\n\nchild\n\n### Refer\n<!--node {"id":"refer","links":["child"]}-->\n\nref\n';
  fs.writeFileSync(file,original);fs.writeFileSync(path.join(dir,'keep.csv'),'original data');
  const queue=read('work/queue.json');
  const snap=()=>editorSnapshot(project),del=(id,extra={})=>editFramework(project,{action:'delete',revision:snap().revision,id,confirm:true,...extra});
  try {
    assert.throws(()=>del('branch',{confirm:false}),/确认/);
    assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(snap().backups.length,0);
    assert.throws(()=>del('log'),/最后一个/);
    const old=snap();
    write('work/queue.json',{...queue,items:[...queue.items,{id:'bound-step',status:'open',project_ids:[project],plan_node_id:'child',sources:[project+'#child','other-project#child'],outputs:['keep.csv']}]});
    const result=del('branch');assert.equal(result.count,2);assert.deepEqual(snap().nodes.map(n=>n.id),['log','refer']);
    const detached=read('work/queue.json').items.find(i=>i.id==='bound-step');
    assert.equal(detached.plan_node_id,undefined);assert.equal(detached.status,'open');assert.deepEqual(detached.outputs,['keep.csv']);
    assert.deepEqual(detached.sources,['other-project#child']);
    assert.deepEqual(parseFramework(fs.readFileSync(file,'utf8')).byId.get('refer').meta.links,undefined);
    assert.equal(fs.readFileSync(path.join(dir,'keep.csv'),'utf8'),'original data');
    assert.ok(snap().backups.some(b=>fs.readFileSync(path.join(root,b.path),'utf8')===original));
    assert.throws(()=>editFramework(project,{action:'delete',id:'log',revision:old.revision,confirm:true}),/已被其他操作更新/);
    const entry=editFramework(project,{action:'add-entry',revision:snap().revision,parent:'log',title:'first',body:'body'});
    del(entry.id);
    const expected=checkFramework(project).next_timeline_id;assert.notEqual(expected,entry.id);
    const next=editFramework(project,{action:'add-entry',revision:snap().revision,parent:'log',title:'next',body:'body'});
    assert.equal(next.id,expected,'CLI checker and writer agree after deletion');
    assert.notEqual(next.id,entry.id,'deletion must not recycle stable log IDs');
    assert.equal(parseFramework(fs.readFileSync(file,'utf8')).problems.length,0);
    // Removing a reference does not remove the referring research sentence.
    editFramework(project,{action:'content',revision:snap().revision,id:'log',title:'Log',body:'Observation stays. See [prior evidence](#'+next.id+') and '+next.id});
    del(next.id);
    const remaining=fs.readFileSync(file,'utf8');
    assert.match(remaining,/Observation stays\. See prior evidence and 已删除记录/);
    assert.equal(parseFramework(remaining).problems.length,0);
  }finally{write('work/queue.json',queue);fs.rmSync(dir,{recursive:true,force:true});}
});

test('editor rejects unclosed code fences without references; content/add writes cannot hide later nodes',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const {editorSnapshot,editFramework,parseFramework}=await import('../projects/framework.mjs');
  const project='zz-editor-fence',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  const original='## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### First\n<!--node {"id":"first"}-->\n\nfirst\n\n### Last\n<!--node {"id":"last"}-->\n\nlast\n';
  fs.writeFileSync(file,original);
  try {
    for(const action of ['content','add-node','add-entry'])for(const body of ['```\ntext','text\n  ```js\ntext']) {
      assert.throws(()=>editFramework(project,{revision:editorSnapshot(project).revision,action,id:'first',parent:'log',title:'First',body}),/代码围栏未闭合/);
      assert.equal(fs.readFileSync(file,'utf8'),original);
      assert.deepEqual(parseFramework(original).nodes.map(n=>n.id),['log','first','last']);
    }
    assert.deepEqual(editorSnapshot(project).backups,[],'rejected writes must not create backups');
    editFramework(project,{revision:editorSnapshot(project).revision,action:'content',id:'first',title:'First',body:'inline `code`\n```js\n## literal code heading\n```'});
    const parsed=parseFramework(fs.readFileSync(file,'utf8'));
    assert.deepEqual(parsed.nodes.map(n=>n.id),['log','first','last']);assert.equal(parsed.byId.get('last').body,'last');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('editor date edits are atomic, retain prior evidence, reset confirmation and expose timestamped backups',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const {editorSnapshot,editFramework,parseFramework}=await import('../projects/framework.mjs');
  const project='zz-editor-dates',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  const original='## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### T-20261007-01 First\n<!--node {"date":"2026-01-11","date_confirmed":true}-->\n\n- 发生时间：2026-01-11\n\n### T-20261007-02 Second\n<!--node {"after":"T-20261007-01"}-->\n\nsecond\n';
  fs.writeFileSync(file,original);
  try {
    const snap=()=>editorSnapshot(project),invoke=data=>editFramework(project,{revision:snap().revision,...data});
    invoke({action:'content',id:'T-20261007-01',title:'Edited first',body:snap().nodes[1].body,fields:{date:'2026-02-01'}});
    let n=parseFramework(fs.readFileSync(file,'utf8')).byId.get('T-20261007-01');
    assert.equal(n.title,'Edited first');assert.equal(n.meta.date,'2026-02-01');assert.equal(n.meta.date_confirmed,undefined);
    assert.ok(n.body.includes('2026-01-11'));assert.ok(n.body.includes('日期更正'));assert.ok(n.body.includes('2026-02-01'));
    invoke({action:'fields',id:'T-20261007-02',fields:{date:'2026-02-02',date_confirmed:true}});
    n=parseFramework(fs.readFileSync(file,'utf8')).byId.get('T-20261007-02');assert.equal(n.meta.after,undefined);assert.equal(n.meta.date_confirmed,true);
    const stable=fs.readFileSync(file);
    assert.throws(()=>invoke({action:'content',id:n.id,title:'must not save',body:'changed',fields:{date:'garbage'}}),/date 格式/);assert.deepEqual(fs.readFileSync(file),stable);
    assert.throws(()=>invoke({action:'fields',id:n.id,fields:{status:'done'}}),/编辑器字段/);
    const backups=snap().backups;assert.equal(backups.length,2);assert.ok(backups.every(b=>!isNaN(Date.parse(b.saved_at)) && b.bytes>0));
    assert.ok(backups.some(b=>fs.readFileSync(path.join(root,b.path),'utf8')===original));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('project editor preserves raw prose, children, IDs, states and bindings; rejects stale or structural writes',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run via the isolated test runner');
  const {editorSnapshot,editFramework,parseFramework}=await import('../projects/framework.mjs');
  const project='zz-project-editor',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  const original='# Project\n\n## Logic\n<!--node {"id":"logic","type":"logic"}-->\n\n## Log\n<!--node {"id":"log","type":"timeline"}-->\n\n### Topic\n<!--node {"id":"topic","kind":"milestone","status":"done","history":[["2026-10-07",null,"done",""]]}-->\n\n[original](https://example.org)\n- 助手备注（Codex，2026-10-07）：unchanged\n\n#### Child\n<!--node {"id":"child","kind":"info"}-->\n\nchild text\n\n### Other\n<!--node {"id":"other"}-->\n\n#### T-20261007-01 Entry\n<!--node {"date":"2026-01-11","date_confirmed":true,"links":["topic"]}-->\n\nentry text\n';
  fs.writeFileSync(file,original);
  try {
    const snapshot=()=>editorSnapshot(project),invoke=data=>editFramework(project,{revision:snapshot().revision,...data});
    const initial=snapshot(),topic=initial.nodes.find(n=>n.id==='topic');
    assert.ok(topic.body.includes('[original](https://example.org)'),'editor must not load the flattened display body');
    assert.ok(topic.body.includes('助手备注（Codex'));
    invoke({action:'content',id:'topic',title:'Renamed',summary:'Short',body:topic.body+'\nNew paragraph'});
    let parsed=parseFramework(fs.readFileSync(file,'utf8'));
    assert.equal(parsed.byId.get('child').body,'child text');assert.equal(parsed.byId.get('topic').meta.status,'done');
    assert.deepEqual(parsed.byId.get('topic').meta.history,[['2026-10-07',null,'done','']]);
    const stable=fs.readFileSync(file);
    assert.throws(()=>editFramework(project,{revision:initial.revision,action:'content',id:'topic',title:'Stale',body:'lost'}),/已被其他操作更新/);
    for(const bad of [
      {action:'content',id:'topic',title:'Oops',body:'## Hidden node'},
      {action:'content',id:'topic',title:'Oops',body:'<!--node {"id":"hidden"}-->'},
      {action:'content',id:'topic',title:'T-20261007-99 fake',body:'text'},
      {action:'move',id:'topic',parent:'child'},
      {action:'move',id:'T-20261007-01',parent:'logic'},
      {action:'move',id:'topic',parent:'logic'},
      {action:'move',id:'topic',parent:null},
      {action:'move',id:'child',parent:'T-20261007-01'}
    ]){assert.throws(()=>invoke(bad));assert.deepEqual(fs.readFileSync(file),stable);}
    invoke({action:'move',id:'topic',parent:'other'});
    parsed=parseFramework(fs.readFileSync(file,'utf8'));assert.equal(parsed.byId.get('topic').parent.id,'other');assert.equal(parsed.byId.get('child').level,5);
    assert.equal(parsed.byId.get('T-20261007-01').meta.date,'2026-01-11');assert.deepEqual(parsed.byId.get('T-20261007-01').meta.links,['topic']);
    // Position inside the new parent: before/after a sibling, roots included; a drop that changes nothing leaves the file byte-identical.
    const order=parent=>{const p=parseFramework(fs.readFileSync(file,'utf8'));return p.nodes.filter(n=>(n.parent?.id||null)===parent).map(n=>n.id);};
    invoke({action:'move',id:'topic',parent:'other',before:'T-20261007-01'});assert.deepEqual(order('other'),['topic','T-20261007-01']);
    invoke({action:'move',id:'topic',parent:'other',after:'T-20261007-01'});assert.deepEqual(order('other'),['T-20261007-01','topic']);
    assert.equal(parseFramework(fs.readFileSync(file,'utf8')).byId.get('child').level,5,'subtree levels follow the column');
    invoke({action:'move',id:'log',parent:null,before:'logic'});assert.deepEqual(order(null),['log','logic']);
    const settled=fs.readFileSync(file);assert.equal(invoke({action:'move',id:'log',parent:null,before:'logic'}).changed,false);assert.deepEqual(fs.readFileSync(file),settled);
    for(const bad of [
      {action:'move',id:'topic',parent:'logic',before:'T-20261007-01'},
      {action:'move',id:'topic',parent:'other',before:'topic'},
      {action:'move',id:'topic',parent:'other',before:'T-20261007-01',after:'T-20261007-01'},
      {action:'move',id:'log',parent:null,before:'other'},
      {action:'move',id:'topic',parent:'other',before:'missing'}
    ]){assert.throws(()=>invoke(bad));assert.deepEqual(fs.readFileSync(file),settled);}
    assert.equal(editFramework(project,{action:'move',id:'topic',parent:'other',after:'T-20261007-01'}).parent,'other','a drag carries no revision: ids and position are resolved on the current file');
    assert.equal(checkFramework(project).ok,true);
    const created=invoke({action:'add-node',parent:'other',kind:'milestone',title:'Created',body:'Only prose'});
    assert.ok(created.id.startsWith('n-'));
    const entry=invoke({action:'add-entry',parent:created.id,title:'New log',body:'- 缺项：later'});
    assert.equal(snapshot().nodes.find(n=>n.id===entry.id).parent,created.id);
    assert.equal(checkFramework(project).ok,true);
    const backups=fs.readdirSync(path.join(root,'.runtime/framework-edits',project));assert.ok(backups.length>=3);
    assert.ok(backups.some(name=>fs.readFileSync(path.join(root,'.runtime/framework-edits',project,name),'utf8')===original));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('project descriptions and registered files appear without inventing completion, and escape text',()=>{
  const project={id:'example',name:'Example',kind:'research',plan:[{id:'fabrication',title:'制备',description:'海报报告 <script>alert(1)</script>'}],files:[{title:'原件 <img>',path:'inbox/source.pdf',description:'资料，不是实时进度'}]};
  const {detail}=projectsView(state(project),project.id);
  assert.ok(detail.includes('海报报告 &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(detail.includes('原件 &lt;img&gt;'));
  assert.ok(detail.includes('项目文件 <span>1</span>'));
  assert.ok(detail.includes('/api/projects/file?project=example&amp;index=0'));
  assert.ok(detail.includes('0 / 1 个环节已完成'));
  assert.ok(detail.includes('待推进'));
  assert.ok(!detail.includes('<script>'));
});
test('projects without descriptions or files retain their plan and actions',()=>{
  const project={id:'example',name:'Example',kind:'research',plan:[{id:'step',title:'原阶段'}]};
  const {detail}=projectsView(state(project),project.id);
  assert.ok(detail.includes('原阶段'));
  assert.ok(detail.includes('data-node-chat="step"'));
  assert.ok(detail.includes('暂无项目文件。'));
  assert.ok(!detail.includes('node-description'));
});
test('project file resolver only permits registered files inside the owning project',()=>{
  const project={id:'graphene-thz',files:[{path:'README.md'}]};
  assert.equal(fs.statSync(resolveProjectFile(project,0)).isFile(),true);
  for(const index of [-1,0.5,NaN,1])assert.throws(()=>resolveProjectFile(project,index));
  for(const path of ['../bi-devices/README.md','../../../projects/catalog.json','D:/Main/assistant/projects/catalog.json','.']){
    assert.throws(()=>resolveProjectFile({...project,files:[{path}]},0));
  }
  assert.throws(()=>resolveProjectFile({id:'../graphene-thz',files:project.files},0));
});
test('registered project files cross the HTTP download boundary byte for byte; invalid lookups fail',async()=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const project of read('projects/catalog.json').projects){
      for(let index=0;index<(project.files || []).length;index++){
        const response=await fetch(`${base}/api/projects/file?project=${project.id}&index=${index}`);
        assert.equal(response.status,200);
        assert.match(response.headers.get('content-disposition'),/^attachment;/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(resolveProjectFile(project,index)));
      }
    }
    for(const query of ['project=missing&index=0','project=graphene-thz','project=graphene-thz&index=','project=graphene-thz&index=-1','project=graphene-thz&index=0.5','project=graphene-thz&index=99999','project=graphene-thz&index=..%2FREADME.md']){
      assert.equal((await fetch(`${base}/api/projects/file?${query}`)).status,400);
    }
    assert.equal((await fetch(base+'/api/projects/file?project=missing&index=0&path=projects/catalog.json')).status,400);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('graphene framework: three boards, six research modules plus the main setup, poster nodes kept, records sorted by date or "after" (original records 06–26 kept; 01–05 retired by the user), lamps only where the user set them',async()=>{
  const {readFramework}=await import('../projects/framework.mjs');
  const project=read('projects/catalog.json').projects.find(p=>p.id==='graphene-thz');
  assert.deepEqual(project.plan,[]);
  const fw=readFramework('graphene-thz');assert.deepEqual(fw.problems,[]);
  assert.deepEqual(fw.boards.map(b=>[b.title,b.type]),[['项目说明','info'],['逻辑组织','logic'],['时间日志','timeline']]);
  const [info,logic,timeline]=fw.boards,all=flatNodes(fw.boards),node=id=>all.find(n=>n.id===id);
  assert.match(info.body,/Joseph Andrews/);assert.match(info.body,/Aerosol Jet Printing/);
  assert.deepEqual(logic.children.filter(c=>c.id).map(c=>c.id),['graphene-l-motivation','graphene-l-mechanism','graphene-l-coupling','graphene-l-material','graphene-l-performance','graphene-l-scalability','graphene-l-setup','graphene-l-methods']);
  // 热响应模型（2026-02-09）排在 2 月 16 日之前，归入“初始器件与测量方法建立”；2026-10-13 起新增响应度重处理主题
  assert.deepEqual(timeline.children.filter(c=>c.id).map(c=>c.id),['graphene-m-baseline','graphene-m-antenna','graphene-m-performance','graphene-m-ink','graphene-m-array','graphene-m-quality','graphene-m-reprocess']);
  assert.ok(node('graphene-m-baseline').children.some(c=>c.id==='graphene-m-thermal'),'热响应模型排在 2 月 16 日之前');
  assert.ok(!flatNodes([logic]).some(n=>n.kind==='attempt' || n.id==='graphene-ant-fab1'),'attempts are log history, not argument');
  assert.ok(node('graphene-l-mechanism').backlinks.some(n=>n.id==='T-20261007-10'),'argument cites the existing log as evidence');
  // 海报五节点：id 不变，收在末尾的草稿小节里
  const poster=logic.children.find(c=>c.title.startsWith('海报版本'));
  assert.deepEqual(poster.children.map(c=>c.id),['graphene-printing','graphene-characterization','graphene-antenna','graphene-single-cell','graphene-array-readout']);
  for(const c of poster.children){assert.ok(c.body.length>60,c.id);assert.ok(!c.body.includes(']('),c.id);assert.ok(c.summary,c.id);}
  // 用户口述的天线树：灯只在用户说过的地方
  const antenna=node('graphene-m-antenna');
  assert.deepEqual(antenna.children.map(c=>c.id),['graphene-ant-motive','graphene-ant-design','graphene-ant-fab1','graphene-ant-anneal','graphene-ant-batch1','graphene-ant-devices']);
  const lamps=Object.fromEntries(all.filter(n=>n.status && !n.entry).map(n=>[n.id,n.status]));
  assert.deepEqual(lamps,{'graphene-m-antenna':'done','graphene-ant-design':'done','graphene-ant-sketch':'done','graphene-ant-sim':'done','graphene-ant-final':'done','graphene-ant-fab1':'failed'});
  assert.equal(node('graphene-ant-fab1').kind,'attempt');assert.equal(node('graphene-ant-motive').status,undefined);
  assert.equal(node('graphene-m-antenna').history[0][3].includes('用户'),true,'状态记录写明依据');
  // 时间记录
  const entries=flatNodes([timeline]).filter(c=>c.entry);
  // T-20261007-01..05 (阶段骨架) were retired by the user on 2026-10-11; 06..26 are the original records that stay.
  // 2026-10-13 并入的占位记录：16→17（同一句话里的两项测量）、19→T-20261008-11（NEP）、24→T-20261008-19（同一次阵列设计）；编号不再复用。
  for(let n=6;n<=26;n++)if(![16,19,24].includes(n))assert.ok(entries.some(e=>e.id==='T-20261007-'+String(n).padStart(2,'0')),'original record '+n+' kept');
  assert.ok(!entries.some(e=>e.id==='T-20261007-19') && entries.some(e=>e.id==='T-20261008-11'));
  for(const group of flatNodes([timeline])){
    const siblings=group.children.filter(c=>c.entry),keyed=siblings.filter(e=>e.sort_key);
    assert.deepEqual(siblings.slice(0,keyed.length),keyed,'每个主题内有日期或 after 的在前');
    assert.deepEqual(keyed.map(e=>e.sort_key),[...keyed.map(e=>e.sort_key)].sort());
  }
  assert.ok(!timeline.children.some(c=>c.entry),'真实日志归入主题，而非单独按月份铺开');
  const rec=id=>entries.find(e=>e.id==='T-20261007-'+id);
  assert.equal(rec(22).date,null);assert.equal(rec(22).date_inferred,true);assert.equal(rec(22).after.id,'T-20261007-21');
  assert.ok(entries.indexOf(rec(22))>entries.indexOf(rec(21)) && entries.indexOf(rec(23))>entries.indexOf(rec(22)));
  assert.ok(!entries.filter(e=>e.date_inferred).some(e=>e.date),'推出来的先后不冒充日期');
  // 逻辑节点列出引用它的记录；记录正文按标签拆栏，缺项和助手备注不在主文里
  assert.deepEqual(node('graphene-ant-fab1').backlinks.map(b=>b.id),['T-20261007-12']);
  assert.ok(node('graphene-printing').backlinks.some(b=>b.id==='T-20261007-15'));
  assert.ok(rec(15).links.some(l=>l.id==='graphene-ant-devices') && rec(15).links.every(l=>l.title));
  assert.ok(rec(10).aux.some(a=>a.label==='助手备注'),'助手备注仍按标签拆出');
  assert.ok(!rec(12).body.includes('缺项：') && rec(12).body.includes('太细'));
  assert.match(rec(12).body,/约 1 µm/);
});
test('frameworkDigest includes all orientation nodes and an untruncated historical evidence index',async()=>{
  const {frameworkDigest,parseFramework,readFrameworkNodes}=await import('../projects/framework.mjs');
  const d=frameworkDigest('graphene-thz');
  assert.ok(!d.includes('目录过长'),'project evidence access is not silently truncated');
  assert.match(d,/graphene-info/);
  assert.match(d,/graphene-l-methods Methods/);
  const selected=readFrameworkNodes('graphene-thz',['graphene-info','graphene-l-methods']);
  assert.match(selected.nodes[0].text,/Joseph Andrews/);
  assert.match(selected.nodes[1].text,/√\(R² − R_blocked²\)/); // Details remain available, not injected into unrelated work.
  assert.match(d,/graphene-l-mechanism/);assert.match(d,/bolometric/);
  const timelineAt=d.indexOf('graphene-timeline');assert.ok(timelineAt>0);
  const tail=d.slice(timelineAt);
  assert.match(tail,/graphene-m-array/);assert.match(tail,/graphene-m-press-test/);assert.match(tail,/历史日志完整索引/);
  const parsed=parseFramework(fs.readFileSync(path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),'utf8'));
  const historical=parsed.nodes.find(n=>n.entry && n.title.includes('Tidy3D'));
  assert.ok(historical && historical.body.length>100,'fixture: a historical log has a real body');
  assert.ok(d.includes(historical.title),'the full index must expose historical titles');
  assert.ok(!d.includes(historical.body),'the index does not silently attach the historical body');
  assert.equal(frameworkDigest('no-such-project'),'');
});
test('splitAux moves only labelled top-level bullets into panels and loses no line',async()=>{
  const {splitAux}=await import('../projects/framework.mjs');
  const body=['- 发生时间：x','- 内容：事实一','- 助手备注（不是用户的结论）：','  - 嵌套甲','','  - 嵌套乙','- 缺项：','  - 缺一','段落：不缩进，结束上一栏','- 来源：甲','- 性质：乙','- **用户的判断：** 保持在正文','- 用户评价：好'].join('\n');
  const {main,aux}=splitAux(body);
  assert.deepEqual(aux.map(a=>a.label),['用户评价','助手备注','缺项','来源与性质','日期依据']);
  assert.equal(main,['- 内容：事实一','段落：不缩进，结束上一栏','- **用户的判断：** 保持在正文'].join('\n'));
  assert.match(aux[1].body,/嵌套甲[^]*嵌套乙/);assert.equal(aux[3].body,'- 来源：甲\n- 性质：乙');
  const lines=s=>s.split('\n').filter(x=>x.trim()).sort();
  assert.deepEqual(lines([main,...aux.map(a=>a.body)].join('\n')),lines(body));
  assert.deepEqual(splitAux('').aux,[]);
});
test('entry-add places records under a chosen log topic without guessing from links; invalid parents leave bytes unchanged',async()=>{
  const {addEntry,readFramework}=await import('../projects/framework.mjs');
  const id='zz-log-parent-test',dir=path.join(root,'workspace/projects',id),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(file,'## 论证\n<!--node {"id":"logic","type":"logic"}-->\n\n## 日志\n<!--node {"id":"log","type":"timeline"}-->\n\n### 天线\n<!--node {"id":"antenna"}-->\n\n#### 制造尝试\n<!--node {"id":"fabrication","kind":"attempt"}-->\n\n##### 子节\n<!--node {"id":"sub"}-->\n\n###### 最深\n<!--node {"id":"deep"}-->\n');
  try{
    const e=addEntry(id,{parent:'fabrication',title:'失败细节',date:'2026-03-16',body:'原始经过',links:['logic']});
    let nodes=flatNodes(readFramework(id).boards),fabrication=nodes.find(n=>n.id==='fabrication');
    assert.equal(fabrication.children.find(n=>n.id===e.id).level,5);
    const next=addEntry(id,{parent:'antenna',title:'日期不记得',after:e.id,body:'后来重做'});
    nodes=flatNodes(readFramework(id).boards);
    assert.equal(nodes.find(n=>n.id==='antenna').children.find(n=>n.id===next.id).date,null);
    assert.equal(nodes.find(n=>n.id===next.id).after.id,e.id);
    for(const parent of ['logic',e.id,'deep','missing']){
      const before=fs.readFileSync(file);
      assert.throws(()=>addEntry(id,{parent,title:'不该写入'}));
      assert.deepEqual(fs.readFileSync(file),before);
    }
    const rootEntry=addEntry(id,{title:'尚待归类'});
    assert.ok(readFramework(id).boards[1].children.some(n=>n.id===rootEntry.id));
    assert.equal(checkFramework(id).ok,true);
  }finally{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(root,'workspace/projects'));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('framework check: rules the page and the commands rely on',async()=>{
  const {checkFramework,parseFramework}=await import('../projects/framework.mjs');
  assert.equal(checkFramework('graphene-thz',{today:'20261006'}).ok,true);
  const nextId=checkFramework('graphene-thz',{today:'20261007'}).next_timeline_id;
  assert.match(nextId,/^T-20261007-\d+$/);assert.ok(Number(nextId.split('-').at(-1))>=27,'retained editor backups can reserve IDs beyond the 26 current logs');
  const bad=[
    '# t','## 说明','<!--node {"id":"info","type":"info"}-->','## 逻辑','<!--node {"id":"a"}-->','### 子','<!--node {"id":"a","status":"open"}-->',
    '### 越界','<!--node {"id":"b","status":"doing","links":["nope","b"],"oops":1}-->','提到 T-20261006-09。','**注意：**这行会露出星号。 和 **普通加粗**，没问题。',
    '### 坏尝试','<!--node {"id":"e","kind":"attempt","status":"doing"}-->','### 坏类型','<!--node {"id":"f","kind":"x"}-->',
    '## 说明二','<!--node {"id":"c","type":"info"}-->','### 不该有状态','<!--node {"id":"d","status":"done"}-->',
    '## 时间','<!--node {"id":"tl","type":"timeline"}-->','### T-20261006-01 甲','<!--node {"date":"2026-13"}-->','### T-20261006-01 乙','### T-20261006-02 丙','<!--node {"date":"二月"}-->',
    '### T-20261006-03 丁','<!--node {"after":"T-20261006-04"}-->','### T-20261006-04 戊','<!--node {"after":"T-20261006-03"}-->','### T-20261006-05 己','<!--node {"after":"T-20261006-99"}-->'].join('\n');
  const r=checkFramework('graphene-thz',{today:'20261006',source:bad}),text=r.problems.join('\n');
  assert.equal(r.next_timeline_id,'T-20261006-06');
  for(const expected of ['ID 重复：a','a：status 为 open 时|a：状态为 open 时 note','b：links 指向不存在的 nope','b：links 指向自己','b：未知字段 oops','正文提到不存在的记录 T-20261006-09','加粗「注意：…」','d：说明性板块','编号/ID 重复：T-20261006-01','T-20261006-01：date 格式','T-20261006-02：date 格式','e：尝试（attempt）只能是完成或失败','f：kind 只能是','T-20261006-03：after 形成循环','T-20261006-05：after 指向不存在的记录'])
    assert.match(text,new RegExp(expected.replace(/[.*+?^${}()[\]\\]/g,'\\$&').replace('\\|','|')),expected);
  assert.equal(r.problems.filter(p=>p.includes('加粗「普通加粗')).length,0);
  assert.equal(parseFramework('# 空\n\n只有一段话').roots.length,0);
  const fenced=parseFramework('## 板块\n```\n# 不是标题\n```\n');assert.equal(fenced.nodes.length,1);
});
test('framework edits change only the target lines, enforce the reason rules, and refuse writes that add problems',async()=>{
  const {setStatus,setFields,linkNodes,addEntry,addNode,checkFramework,readFramework}=await import('../projects/framework.mjs');
  const id='zz-framework-edit-test',dir=path.join(root,'workspace/projects',id),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  const original=['# 夹具','','## 逻辑组织','<!--node {"id":"logic"}-->','','### 表征','<!--node {"id":"characterization","summary":"AFM、STM 等"}-->','','表征的自由正文，**不被命令改动**。','','## 时间顺序','<!--node {"id":"timeline","type":"timeline"}-->','','### T-20260101-01 旧记录','<!--node {"date":"2026-01-01"}-->','','旧正文。',''].join('\r\n');
  fs.writeFileSync(file,original);
  try{
    const lines=()=>fs.readFileSync(file,'utf8').split('\r\n');
    // status: set, reasons, history
    assert.throws(()=>setStatus(id,'characterization','open'),/note/);
    assert.deepEqual(setStatus(id,'characterization','open',{note:'未开始，等样品'}).changed,true);
    assert.equal(setStatus(id,'characterization','open',{note:'未开始，等样品'}).changed,false,'重复设置不留记录');
    setStatus(id,'characterization','doing');
    setStatus(id,'characterization','done');
    assert.throws(()=>setStatus(id,'characterization','failed'),/原因/);
    assert.throws(()=>setStatus(id,'characterization','none'),/原因/);
    setStatus(id,'characterization','doing',{reason:'重新测量后发现 Raman 峰位不符'});
    const node=readFramework(id).boards[0].children[0];
    assert.equal(node.status,'doing');assert.equal(node.history.length,4);
    assert.deepEqual(node.history.map(h=>[h[1],h[2]]),[[null,'open'],['open','doing'],['doing','done'],['done','doing']]);
    assert.match(node.history[3][3],/Raman/);
    assert.throws(()=>setStatus(id,'nope','doing'),/未找到/);
    assert.throws(()=>setStatus(id,'characterization','blue'),/状态只能是/);
    // links
    addEntry(id,{title:'占位',body:'x'});
    const entry=readFramework(id).boards[1].children.find(c=>c.title==='占位');
    assert.deepEqual(linkNodes(id,entry.id,'characterization'),{from:entry.id,to:'characterization',changed:true});
    assert.equal(linkNodes(id,entry.id,'characterization').changed,false);
    assert.throws(()=>linkNodes(id,entry.id,'missing'),/未找到/);
    assert.deepEqual(readFramework(id).boards[0].children[0].backlinks.map(b=>b.id),[entry.id]);
    // entries: numbering continues today's sequence, appended inside the timeline board, undated sorts last
    const today=checkFramework(id).next_timeline_id.slice(2,10);
    assert.equal(entry.id,`T-${today}-01`);
    const second=addEntry(id,{title:'带日期',date:'2026-02-03',date_confirmed:true,links:['characterization'],status:'open',note:'计划，未开始',body:'第一行\n第二行'});
    assert.equal(second.id,`T-${today}-02`);
    assert.throws(()=>addEntry(id,{title:'坏日期',date:'二月'}),/date/);
    assert.throws(()=>addEntry(id,{title:'坏链接',links:['nope']}),/nope/);
    assert.throws(()=>addEntry(id,{title:'无说明的 open',status:'open'}),/note/);
    assert.deepEqual(readFramework(id).boards[1].children.filter(c=>c.entry).map(c=>c.date),['2026-01-01','2026-02-03',null]);
    // nested boards
    addNode(id,{parent:'characterization',id:'afm',title:'AFM',summary:'形貌',body:'待补'});
    addNode(id,{parent:'afm',id:'afm-tip',title:'针尖',status:'failed'});
    addNode(id,{parent:null,id:'notes',title:'新的一级板块',type:'info'});
    assert.throws(()=>addNode(id,{parent:'afm',id:'afm',title:'重复'}),/重复/);
    assert.throws(()=>addNode(id,{parent:'notes',id:'x',title:'X',status:'done'}),/说明性/);
    const tree=readFramework(id).boards;
    assert.deepEqual(tree[0].children[0].children.map(c=>[c.id,c.level]),[['afm',4]]);
    assert.equal(tree[0].children[0].children[0].children[0].status,'failed');
    assert.equal(tree.at(-1).id,'notes');
    // kind: 尝试只有完成或失败；after 和 setFields
    addNode(id,{parent:'afm',id:'afm-try',title:'试一次',kind:'attempt'});
    assert.throws(()=>setStatus(id,'afm-try','doing'),/尝试/);
    assert.throws(()=>setStatus(id,'afm-try','open',{note:'计划'}),/尝试/);
    assert.equal(setStatus(id,'afm-try','failed').changed,true);
    assert.throws(()=>addNode(id,{parent:'afm',id:'afm-bad',title:'坏',kind:'purple'}),/kind/);
    const third=addEntry(id,{title:'日期待补',after:second.id,body:'x'});
    const sorted=()=>readFramework(id).boards[1].children.filter(c=>c.entry);
    assert.equal(sorted().find(c=>c.id===third.id).after.id,second.id);
    assert.ok(sorted().findIndex(c=>c.id===third.id)>sorted().findIndex(c=>c.id===second.id) && sorted().find(c=>c.id===third.id).date_inferred===true);
    assert.throws(()=>addEntry(id,{title:'坏 after',after:'T-20200101-99'}),/after/);
    assert.throws(()=>setFields(id,third.id,{status:'done'}),/只能改/);
    assert.throws(()=>setFields(id,third.id,{after:third.id}),/after/);
    setFields(id,third.id,{date:'2026-02-10',date_confirmed:true});
    const filled=sorted().find(c=>c.id===third.id);
    assert.equal(filled.date,'2026-02-10');assert.equal(filled.after,undefined,'补了日期就清掉 after');
    setFields(id,'characterization',{summary:'改过的摘要'});
    assert.equal(readFramework(id).boards[0].children[0].summary,'改过的摘要');
    // untouched prose and line endings
    const text=fs.readFileSync(file,'utf8');
    assert.ok(text.includes('表征的自由正文，**不被命令改动**。\r\n') && !text.replace(/\r\n/g,'').includes('\n'));
    assert.equal(checkFramework(id).ok,true,JSON.stringify(checkFramework(id).problems));
    // a write that would introduce a problem leaves the file byte for byte unchanged
    const before=fs.readFileSync(file);
    assert.throws(()=>addNode(id,{parent:'afm',id:'BAD ID',title:'x'}));
    assert.deepEqual(fs.readFileSync(file),before);
    assert.equal(fs.readdirSync(dir).filter(f=>f.includes('.tmp-')).length,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('projects commands edit FRAMEWORK.md through the CLI contract and reject unknown projects',async()=>{
  const {run}=await import('../projects/run.mjs');
  const file=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),saved=fs.readFileSync(file);
  const spec=path.join(os.tmpdir(),'fw-spec-'+process.pid+'.json'),logs=[],log=console.log;
  const call=async(action,data)=>{fs.writeFileSync(spec,JSON.stringify(data));logs.length=0;console.log=m=>logs.push(m);try{await run(action,spec);}finally{console.log=log;}return JSON.parse(logs.join(''));};
  try{
    assert.equal((await call('node-status',{project_id:'graphene-thz',id:'graphene-m-baseline',status:'doing'})).changed,true);
    const added=await call('entry-add',{project_id:'graphene-thz',title:'命令测试',date:'2026-10-08',links:['graphene-antenna'],body:'x'});
    assert.match(added.id,/^T-\d{8}-\d+$/);
    assert.equal((await call('node-link',{project_id:'graphene-thz',from:added.id,to:'T-20261007-26'})).changed,true);
    assert.equal((await call('node-add',{project_id:'graphene-thz',parent:'graphene-logic',id:'graphene-afm',title:'AFM',body:'待补'})).id,'graphene-afm');
    assert.deepEqual((await call('node-set',{project_id:'graphene-thz',id:'T-20261007-26',date_confirmed:true})).fields,['date_confirmed']);
    await assert.rejects(()=>call('node-set',{project_id:'graphene-thz',id:'T-20261007-26',status:'done'}),/只能改/);
    await assert.rejects(()=>call('node-status',{project_id:'missing',id:'x',status:'doing'}),/Unknown project/);
    assert.equal(checkFramework('graphene-thz').ok,true);
  }finally{console.log=log;fs.rmSync(spec,{force:true});fs.writeFileSync(file,saved);}
});
test('status endpoint: changes a chip, enforces the reason rule, and rejects bad input without touching the file',async()=>{
  const file=path.join(root,'workspace/projects/graphene-thz/FRAMEWORK.md'),saved=fs.readFileSync(file);
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=data=>fetch(base+'/api/projects/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:'graphene-thz',...data})});
  try{
    assert.equal((await post({id:'graphene-m-ink',status:'done'})).status,200);
    const state=await (await fetch(base+'/api/state')).json();
    const node=flatNodes(state.projects.find(p=>p.id==='graphene-thz').framework.boards).find(c=>c.id==='graphene-m-ink');
    assert.equal(node.status,'done');
    const afterDone=fs.readFileSync(file);
    for(const bad of [{id:'graphene-m-ink',status:'failed'},{id:'graphene-m-ink',status:'purple'},{id:'nope',status:'doing'},{id:'graphene-info',status:'doing'},{id:'graphene-antenna',status:'open'},{id:'graphene-ant-anneal',status:'doing'},{id:'graphene-ant-anneal',status:'open',note:'计划'},{project_id:'missing',id:'x',status:'doing'}]){
      assert.equal((await post(bad)).status,400,JSON.stringify(bad));
    }
    assert.deepEqual(fs.readFileSync(file),afterDone);
    assert.equal((await post({id:'graphene-m-ink',status:'failed',reason:'重新核对后失败'})).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));fs.writeFileSync(file,saved);}
});
test('review fixes: 说明节点不带状态；用户说明留在正文；代码块不被拆；只知先后的记录不挂月份；改日期不留旧确认；清除状态后历史仍在',async()=>{
  const {splitAux,setStatus,setFields,addNode,addEntry,checkFramework:check,readFramework}=await import('../projects/framework.mjs');
  // splitAux: 用户说明是正文，用户评价才进栏；助手解释按含义归栏；围栏里的标签行不抽出
  const body=['- 用户说明：动机是 A','- 我对“80nm”的理解（待确认）：可能是承接上一步','- Claude 备注（2026-10-07）：x','- 用户评价：好','- 内容：事实','```','- 缺项：这是代码块里的示例','```','- 缺项：','  - 真缺项'].join('\n');
  const {main,aux}=splitAux(body);
  assert.deepEqual(aux.map(a=>a.label),['用户评价','助手备注','缺项']);
  assert.ok(main.includes('用户说明：动机是 A') && main.includes('```\n- 缺项：这是代码块里的示例\n```'),main);
  assert.ok(aux.find(a=>a.label==='助手备注').body.includes('我对“80nm”的理解') && aux.find(a=>a.label==='缺项').body==='- 缺项：\n  - 真缺项');
  // 名字后带空格的署名也要归栏；署名只认标签里的 Claude／Codex，没写的计为作者未核实，不猜
  const spaced=splitAux('- Claude 备注（2026-10-07）：x');
  assert.deepEqual(spaced.aux.map(a=>a.label),['助手备注']);assert.equal(spaced.main,'');
  assert.deepEqual([spaced.aux[0].authors,spaced.aux[0].unsigned],[['Claude'],0]);
  const notes=splitAux(['- 助手备注（Codex，2026-10-07）：甲','- 助手备注：乙','- 助手备注（不是用户的结论）：丙','- 内容：事实'].join('\n')).aux[0];
  assert.deepEqual([notes.authors,notes.unsigned],[['Codex'],2]);
  const fenced=splitAux(['- 缺项：','```','- 来源：块内','```'].join('\n'));
  assert.equal(fenced.main,'');assert.equal(fenced.aux.length,1,'围栏跟着所在栏走，不被拆开');
  // 页面：说明节点没有 ＋状态；日期和相对顺序是记录属性，不按月份分类
  const entry=(id,extra)=>({id,title:id,level:3,entry:true,tracked:true,body:'',links:[],backlinks:[],work:[],files:[],children:[],...extra});
  const project={id:'ex',name:'Ex',kind:'research',plan:[],framework:{boards:[
    {id:'logic',title:'逻辑',level:2,body:'',links:[],backlinks:[],work:[],files:[],children:[
      {id:'motive',title:'动机',level:3,kind:'info',tracked:false,body:'正文',children:[],links:[],backlinks:[],work:[],files:[]},
      {id:'stage',title:'阶段',level:3,tracked:true,body:'',children:[],links:[],backlinks:[],work:[],files:[]}]},
    {id:'tl',title:'时间',level:2,type:'timeline',body:'',links:[],backlinks:[],work:[],files:[],children:[
      entry('T-20261007-01',{date:'2026-06-18',date_confirmed:true,sort_key:'2026-06-18'}),
      entry('T-20261007-02',{date:null,sort_key:'2026-06-18~',date_inferred:true,after:{id:'T-20261007-01',title:'一'}}),
      entry('T-20261007-03',{date:null,sort_key:null})]}]}};
  const {detail}=projectsView(state(project),'ex','',t=>`<p>${t}</p>`);
  const motive=detail.slice(detail.indexOf('data-fw-id="motive"'),detail.indexOf('data-fw-id="stage"'));
  assert.ok(motive.includes('说明') && !motive.includes('data-fw-chip'),'说明节点没有状态按钮');
  assert.ok(detail.slice(detail.indexOf('data-fw-id="stage"')).includes('data-fw-chip="stage"'));
  assert.ok(!detail.includes('fw-month') && !detail.includes('fw-relative') && !detail.includes('fw-undated'));
  assert.ok(detail.includes('日期待补：按用户叙述排在') && detail.includes('之后，不是确切日期。'));
  assert.ok(detail.includes('data-fw-id="T-20261007-03"'),'日期完全未知的记录也保留');
  // 命令：说明节点拒绝状态；改日期清掉旧确认并在正文留更正；清除状态后历史仍在
  const id='zz-review-fix-test',dir=path.join(root,'workspace/projects',id),file=path.join(dir,'FRAMEWORK.md');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(file,['# 夹具','','## 逻辑','<!--node {"id":"logic"}-->','','### 动机','<!--node {"id":"motive","kind":"info"}-->','','说明','','### 阶段','<!--node {"id":"stage"}-->','','## 时间','<!--node {"id":"tl","type":"timeline"}-->','','### T-20260101-01 旧','<!--node {"date":"2026-01-01","date_confirmed":true}-->','','- 发生时间：2026-01-01（用户确认）','- 内容：x',''].join('\n'));
  try{
    assert.throws(()=>setStatus(id,'motive','done'),/说明性/);
    assert.throws(()=>addNode(id,{parent:'motive',id:'kid',title:'子',status:'done'}),/说明性/);
    assert.throws(()=>setFields(id,'stage',{kind:'info'}) && setStatus(id,'stage','done'),/说明性/);
    setFields(id,'stage',{kind:null});
    setStatus(id,'stage','done');
    assert.throws(()=>setFields(id,'stage',{kind:'info'}),/说明性/,'已有状态的节点不能改成说明节点');
    setStatus(id,'stage','doing',{reason:'重做'});setStatus(id,'stage','none');
    const stage=readFramework(id).boards[0].children.find(c=>c.id==='stage');
    assert.equal(stage.status,undefined);assert.equal(stage.history.length,3,'清除状态后历史仍可读');
    setFields(id,'T-20260101-01',{date:'2026-02-02'});
    let t=readFramework(id).boards[1].children[0];
    assert.equal(t.date,'2026-02-02');assert.equal(t.date_confirmed,false,'新日期不继承旧确认');
    assert.match(t.aux.find(a=>a.label==='日期依据').body,/日期更正[^]*由「2026-01-01」改为「2026-02-02」[^]*待确认/);
    setFields(id,'T-20260101-01',{date:'2026-02-03',date_confirmed:true});
    t=readFramework(id).boards[1].children[0];assert.equal(t.date_confirmed,true);
    setFields(id,'T-20260101-01',{summary:'只改摘要'});
    assert.equal((fs.readFileSync(file,'utf8').match(/日期更正/g) || []).length,2,'日期没变就不追加更正');
    assert.equal(check(id).ok,true,JSON.stringify(check(id).problems));
    assert.ok(fs.readFileSync(file,'utf8').includes('- 内容：x'),'原文保留');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('compact overview counts actual yellow chips, distinguishes live agents, and uses only related final updates',()=>{
  const node=(id,status)=>({id,title:id,status,level:3,tracked:true,body:'',links:[],backlinks:[],work:[],children:[]});
  const project={id:'fixture',name:'Fixture <safe>',kind:'research',plan:[],framework:{boards:[{...node('board','doing'),type:'timeline',level:2,children:[node('doing','doing'),node('open','open'),node('failed','failed')]}]}};
  const step=(id,actor,status,project_ids=['fixture'])=>({id,title:id,actor,status,project_ids,outputs:[],dependencies:[],plan_node_id:'doing'});
  const s={...state(project),work:{items:[step('agent','codex','active'),step('user','user','active'),step('queued','claude','queued'),step('other','codex','done',['other'])]},agent:{active_turns:[{task_id:'agent',provider:'claude'}],sessions:[{id:'s',project_ids:['fixture'],messages:[
    {role:'assistant',provider:'codex',task_id:'agent',at:'2026-10-07T23:00:00Z',text:'final'},
    {role:'assistant',provider:'claude',task_id:'agent',interim:true,at:'2026-10-08T01:00:00Z'},
    {role:'assistant',provider:'codex',task_id:'other',at:'2026-10-09T01:00:00Z'},
    {role:'user',at:'2026-10-10T01:00:00Z'}]}]}};
  const {cards,detail}=projectsView(s,project.id);
  assert.ok(cards.includes('Fixture &lt;safe&gt;'));
  assert.ok(cards.includes('data-project-doing="4"'));
  assert.equal((detail.match(/class="fw-chip st-doing[ "]/g)||[]).length,4,'overview count equals real detail chips');
  assert.ok(cards.includes('Claude 工作中'));assert.ok(!cards.includes('Codex 工作中'));
  const chat={...step('chat-root','claude','active'),executor:'claude',turn:true};
  const chatState={...s,work:{items:[...s.work.items,chat,{...chat,id:'chat-supplement',merged_into:chat.id}]}};
  const chatView=projectsView(chatState,project.id);
  assert.ok(chatView.cards.includes('data-project-doing="4"'),'chat root and supplements do not increase step counts');
  assert.ok(chatView.cards.includes('Claude 工作中'),'live conversation still reports the working agent');
  assert.ok(!chatView.detail.includes('data-step-chip="chat-root"') && !chatView.detail.includes('data-step-chip="chat-supplement"'));
  assert.ok(cards.includes('1 条新更新'));assert.ok(cards.includes('data-session="s"'));
  assert.ok(detail.includes('project-new-updates'));
  assert.equal((detail.match(/class="project-update-entry"/g)||[]).length,1,'detail identifies exactly the same unread final replies');
  assert.ok(detail.includes('>新</span>'));assert.ok(detail.includes('>final</span>'));
  const seen=projectsView(s,project.id,'',undefined,{s:Date.parse('2026-10-07T23:00:00Z')}).cards;
  assert.ok(seen.includes('无新更新'));assert.ok(!seen.includes('条新更新'));
  assert.ok(!projectsView(s,project.id,'',undefined,{s:Date.parse('2026-10-07T23:00:00Z')}).detail.includes('project-new-updates'));
  s.agent.sessions[0].messages.push({role:'assistant',provider:'claude',task_id:'agent',at:'2026-10-08T02:00:00Z'});
  assert.ok(projectsView(s,project.id,'',undefined,{s:Date.parse('2026-10-07T23:00:00Z')}).cards.includes('1 条新更新'));
  for(const removed of ['project-question','project-progress','project-footer','真实交付','周目标','展开项目'])assert.ok(!cards.includes(removed),removed);
  const empty=projectsView(state({id:'empty',name:'Empty',plan:[]}),'').cards;
  assert.ok(empty.includes('data-project-doing="0"'));assert.ok(empty.includes('无 agent 工作中'));assert.ok(empty.includes('暂无 agent 更新'));
  assert.ok(projectsView({...state(project),projects:[{...project,archived_at:'2026-10-07'}]},'').cards.includes('已归档（1）'));
  assert.ok(projectsView(state(project),'','does-not-match').cards.includes('没有匹配的项目'));
});

test('detail reminders escape source text, exclude unrelated and interim replies, and remove the goal form without mutating data',()=>{
  const project={id:'fixture',name:'Fixture',plan:[],goal:'Keep original goal',current_question:'Keep original question'};
  const s={...state(project),agent:{sessions:[{id:'s',title:'Source <safe>',project_ids:['fixture'],messages:[
    {role:'assistant',provider:'claude',at:'2026-10-07T23:00:00Z',text:'A <script>reply</script>'},
    {role:'assistant',provider:'codex',at:'2026-10-08T00:00:00Z',text:'Only interim',interim:true},
    {role:'user',at:'2026-10-08T01:00:00Z',text:'User text'}]},
    {id:'other',title:'Other project',project_ids:['other'],messages:[{role:'assistant',provider:'codex',at:'2026-10-08T02:00:00Z',text:'Other reply'}]}]}};
  const original=JSON.stringify(s),html=projectsView(s,project.id).detail;
  assert.equal((html.match(/class="project-update-entry"/g)||[]).length,1);
  assert.ok(html.includes('Source &lt;safe&gt;'));assert.ok(html.includes('A &lt;script&gt;reply&lt;/script&gt;'));
  assert.ok(html.includes('Claude'));assert.ok(html.includes('data-session="s"'));
  for(const removed of ['Only interim','Other reply','goal-panel','profile-form','目标与当前问题'])assert.ok(!html.includes(removed),removed);
  assert.equal(JSON.stringify(s),original,'removing UI does not remove stored project fields or alter research data');
});

test('compact project overview preserves title navigation, search and mobile layout in the browser',async()=>{
  assert.equal(read('agent/config.json').enabled,false,'only run via isolated test runner');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;let browser,page;
  try{
    browser=await launchEdge();
    page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];
    // Keep the app's real 5 s poll; jump the page clock to the next tick instead of idling for it.
    await page.clock.install();const poll=()=>page.clock.fastForward(5000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base+'/#projects');
    const cards=page.locator('#project-grid .project-summary');await cards.first().waitFor();
    assert.equal(await cards.count(),5);
    const first=cards.first(),name=await first.locator('h2 button').innerText();
    await first.locator('h2 button').click();await page.locator('#project-detail h1').waitFor();
    assert.equal(await page.locator('#project-detail h1').innerText(),name);
    assert.equal(await page.locator('#project-detail .goal-panel, #project-detail .profile-form').count(),0);
    await page.locator('[data-project-back]').click();await page.locator('#project-overview').waitFor();
    await page.locator('#project-search').fill(name);assert.equal(await cards.count(),1);
    await page.locator('#project-search').fill('no-such-project');await page.getByText('没有匹配的项目。',{exact:true}).waitFor();
    await page.locator('#project-search').fill('');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1100});
      assert.equal(await page.locator('#project-overview').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      for(const card of await cards.all()){
        assert.equal(await card.evaluate(el=>el.scrollWidth<=el.clientWidth && el.getBoundingClientRect().height<190),true);
        assert.equal(await card.evaluate(el=>getComputedStyle(el).backgroundImage),'none','original flat palette, no added gradients');
      }
      if(process.env.PHD_TEST_ARTIFACTS){fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-overview-'+width+'.png')});}
    }
    // A project open is not a read. Each conversation has its own reading boundary.
    const fixture=await (await fetch(base+'/api/state')).json(),pid=fixture.projects[0].id;
    const reply=(at,text)=>({role:'assistant',provider:'codex',at,text});
    fixture.agent.sessions=[{id:'updates-one',title:'Updates one',project_ids:[pid],task_ids:[],messages:[reply('2026-10-07T23:00:00Z','First final')]},
      {id:'updates-two',title:'Updates two',project_ids:[pid],task_ids:[],messages:[reply('2026-10-08T00:00:00Z','Second final'),{...reply('2026-10-08T01:00:00Z','Progress only'),interim:true}]}];
    await page.route('**/api/state*',route=>route.fulfill({json:fixture}));
    await page.goto(base+'/#projects');
    const projectCard=page.locator('#project-grid .project-summary').filter({has:page.locator('[data-project-open="'+pid+'"]')});
    await projectCard.getByText('2 条新更新',{exact:true}).waitFor();
    await projectCard.locator('h2 button').click();
    const reminders=page.locator('#project-detail .project-new-updates'),entries=reminders.locator('.project-update-entry');
    await reminders.waitFor();assert.equal(await entries.count(),2);
    assert.equal(await entries.locator('.pill').first().innerText(),'新');
    assert.ok((await entries.first().innerText()).includes('Second final'));
    assert.ok(!(await reminders.innerText()).includes('Progress only'));
    await page.reload();await reminders.waitFor();assert.equal(await entries.count(),2,'opening or reloading detail is not reading the conversation');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1100});
      assert.equal(await reminders.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'reminders fit desktop and mobile');
      if(process.env.PHD_TEST_ARTIFACTS)await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-detail-updates-'+width+'.png')});
    }
    await page.locator('[data-project-back]').click();
    await projectCard.getByText('2 条新更新',{exact:true}).waitFor();
    await projectCard.locator('h2 button').click();
    await reminders.locator('[data-session="updates-two"]').click();await page.locator('#transcript').getByText('Second final',{exact:true}).waitFor();
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('1 条新更新',{exact:true}).waitFor();
    await projectCard.locator('h2 button').click();await reminders.waitFor();assert.equal(await entries.count(),1);
    assert.ok((await reminders.innerText()).includes('First final'));assert.ok(!(await reminders.innerText()).includes('Second final'));
    await reminders.locator('[data-session="updates-one"]').click();await page.locator('#transcript').getByText('First final',{exact:true}).waitFor();
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('无新更新',{exact:true}).waitFor();
    await projectCard.locator('h2 button').click();assert.equal(await reminders.count(),0,'read updates leave no stale internal markers');
    await page.locator('[data-project-back]').click();
    await page.goto(base+'/#projects');await projectCard.getByText('无新更新',{exact:true}).waitFor();
    // Polling while viewing projects must leave the new reply unread, including in the remembered session.
    fixture.agent.sessions[0].messages.push(reply('2026-10-08T02:00:00Z','New final after read'));
    await poll();await projectCard.getByText('1 条新更新',{exact:true}).waitFor({timeout:12000});
    await page.reload();await projectCard.getByText('1 条新更新',{exact:true}).waitFor();
    await projectCard.locator('h2 button').click();await reminders.waitFor();assert.equal(await entries.count(),1);
    assert.ok((await reminders.innerText()).includes('New final after read'));
    await page.locator('[data-project-back]').click();
    if(process.env.PHD_TEST_ARTIFACTS)await page.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-overview-unread.png')});
    await projectCard.locator('[data-session="updates-one"]').click();await page.locator('#transcript').getByText('New final after read',{exact:true}).waitFor();
    // New visible replies read automatically only while following the bottom of that conversation.
    fixture.agent.sessions[0].messages.push(reply('2026-10-08T03:00:00Z','Visible final'));
    await poll();await page.locator('#transcript').getByText('Visible final',{exact:true}).waitFor({timeout:12000});
    await page.locator('.nav[data-page="projects"]').click();await projectCard.getByText('无新更新',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }catch(error){
    const dir=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(dir,{recursive:true});
    if(page){
      fs.writeFileSync(path.join(dir,'compact-overview-failure.html'),await page.content());
      fs.writeFileSync(path.join(dir,'compact-overview-failure.json'),JSON.stringify({error:error.stack,url:page.url(),localStorage:await page.evaluate(()=>({...localStorage}))},null,2));
      await page.screenshot({path:path.join(dir,'compact-overview-failure.png'),fullPage:true});
    }
    throw error;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
