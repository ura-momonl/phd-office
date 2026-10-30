import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {parseFramework} from '../projects/framework.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run through scripts/run-tests.mjs in an isolated copy');

test('one mouse drag lifts a nested column after its expanded parent, preserving its subtree and existing header drops',async()=>{
  const project='zz-drag-outdent',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  const catalog=read('projects/catalog.json'),queue=read('work/queue.json');
  assert.ok(!fs.existsSync(dir));
  const original=`## Timeline
<!--node {"id":"timeline","type":"timeline"}-->

### Parent column
<!--node {"id":"parent","kind":"info"}-->
Parent prose.

#### Nested column
<!--node {"id":"nested","kind":"info","links":["other"]}-->
Nested prose.

##### Grandchild
<!--node {"id":"grandchild","kind":"info"}-->
Grandchild prose.

###### T-20261027-01 Measurement
<!--node {"date":"2026-10-27","links":["other"]}-->
Measurement data stays.

### Other column
<!--node {"id":"other","kind":"info","links":["nested"]}-->
Other prose.
`;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,original);
  write('projects/catalog.json',{...catalog,projects:[...catalog.projects,{id:project,name:project,kind:'research'}]});
  const step={id:'drag-bound-step',title:'Bound step',actor:'user',kind:'data',status:'done',project_ids:[project],plan_node_id:'grandchild',dependencies:[],outputs:[]};
  write('work/queue.json',{...queue,items:[...queue.items,step]});
  const server=createServer();let browser;
  try {
    assert.deepEqual(parseFramework(original).problems,[]);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1600}}),requests=[];
    await page.clock.install();
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    page.on('request',r=>{if(r.url()===base+'/api/projects/edit')requests.push(r.postDataJSON());});
    await page.goto(base+'/#projects/'+project);
    await page.locator('[data-project-edit-mode]').click();
    const node=id=>page.locator(`[data-fw-id="${id}"]`),grip=id=>node(id).locator(':scope > summary .fw-grip');
    await node('parent').locator(':scope > summary').click();
    const end=node('parent').locator(':scope > [data-drop-after="parent"]');
    assert.equal(await end.count(),1,'an expanded parent has a same-level drop target below its content');
    const drag=async(id,target,fraction=.5)=>{
      const a=await grip(id).boundingBox(),b=await target.boundingBox();
      assert.ok(a && b);
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
      await page.mouse.move(a.x+a.width/2+8,a.y+a.height/2+8,{steps:4});
      await page.mouse.move(b.x+b.width/2,b.y+b.height*fraction,{steps:15});
      await page.mouse.up();
    };
    const move=async(id,target,fraction)=>{
      const response=page.waitForResponse(r=>r.url()===base+'/api/projects/edit');
      await drag(id,target,fraction);const r=await response;assert.equal(r.status(),200,await r.text());
      await page.waitForFunction(()=>!document.body.classList.contains('is-dragging'));
      const snapshot=await (await fetch(base+'/api/projects/editor?project='+project)).json();
      await page.waitForFunction(({id,parent})=>{
        const el=document.querySelector(`[data-fw-id="${id}"]`);
        return el && el.parentElement.closest('[data-drop-node]')?.dataset.dropNode===parent;
      },{id,parent:snapshot.nodes.find(n=>n.id===id).parent});
    };
    await move('nested',end);
    assert.deepEqual(requests[0],{project_id:project,id:'nested',action:'move',parent:'timeline',after:'parent'});
    let after=parseFramework(fs.readFileSync(file,'utf8')),before=parseFramework(original);
    assert.deepEqual(after.byId.get('timeline').children.map(n=>n.id),['parent','nested','other']);
    for(const id of ['nested','grandchild','T-20261027-01']) {
      assert.equal(after.byId.get(id).level,before.byId.get(id).level-1);
      assert.equal(after.byId.get(id).body,before.byId.get(id).body);
      assert.deepEqual(after.byId.get(id).meta,before.byId.get(id).meta);
    }
    assert.deepEqual(read('work/queue.json').items.find(i=>i.id===step.id),step);
    // Existing title-row targets still support nesting and sibling ordering.
    await move('nested',node('parent').locator(':scope > summary'),.5);
    assert.equal(parseFramework(fs.readFileSync(file,'utf8')).byId.get('nested').parent.id,'parent');
    await move('nested',node('other').locator(':scope > summary'),.9);
    assert.deepEqual(parseFramework(fs.readFileSync(file,'utf8')).byId.get('timeline').children.map(n=>n.id),['parent','other','nested']);
    await move('nested',node('parent').locator(':scope > summary'),.1);
    after=parseFramework(fs.readFileSync(file,'utf8'));
    assert.deepEqual(after.byId.get('timeline').children.map(n=>n.id),['nested','parent','other']);
    assert.deepEqual(after.problems,[]);
    assert.equal(requests.length,4,'each mouse drag is a single move, not an intermediate relocation');
  } finally {
    await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('projects/catalog.json',catalog);write('work/queue.json',queue);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
