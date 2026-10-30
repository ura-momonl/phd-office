import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from '../dashboard/server.mjs';
import {parseFramework,readFramework} from './framework.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run through scripts/run-tests.mjs in an isolated copy');

// User requirement: containment defines deletion; links in either direction do not.
test('project delete API removes only the subtree, detaches links and preserves the other ends and their descendants',async()=>{
  const project='zz-delete-links',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  assert.ok(!fs.existsSync(dir));
  const catalog=read('projects/catalog.json'),queue=read('work/queue.json');
  const original=`## Logic
<!--node {"id":"logic","type":"logic"}-->

### Outside
<!--node {"id":"outside","links":["branch","child","peer"],"summary":"keep summary"}-->
Outside research stays.

#### Outside child
<!--node {"id":"outside-child","links":["child"]}-->
Outside descendant stays.

### Peer
<!--node {"id":"peer","links":["outside"]}-->
Peer research stays.

## Log
<!--node {"id":"log","type":"timeline"}-->

### Branch
<!--node {"id":"branch","links":["outside"]}-->
Delete this branch.

#### Child
<!--node {"id":"child","links":["outside-child","peer"]}-->
Delete this child.

### Sibling
<!--node {"id":"sibling","links":["branch","outside"]}-->
Sibling stays.
`;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,original);
  write('projects/catalog.json',{...catalog,projects:[...catalog.projects,{id:project,name:project}]});
  const step={id:'linked-step',title:'Keep this step',project_ids:[project],plan_node_id:'outside-child',status:'done',outputs:['data.csv']};
  write('work/queue.json',{...queue,items:[...queue.items,step]});
  const server=createServer();
  try {
    assert.deepEqual(parseFramework(original).problems,[]);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const snapshot=await (await fetch(base+'/api/projects/editor?project='+project)).json();
    const response=await fetch(base+'/api/projects/edit',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({project_id:project,revision:snapshot.revision,action:'delete',id:'branch',confirm:true})});
    assert.equal(response.status,200,await response.text());
    const after=parseFramework(fs.readFileSync(file,'utf8')),before=parseFramework(original);
    const remaining=['logic','outside','outside-child','peer','log','sibling'];
    assert.deepEqual(after.nodes.map(n=>n.id),remaining);
    assert.deepEqual(after.problems,[]);
    for(const id of remaining) {
      assert.equal(after.byId.get(id).body,before.byId.get(id).body,id+' body retained');
      const expected={...before.byId.get(id).meta};
      if(expected.links)expected.links=expected.links.filter(x=>!['branch','child'].includes(x));
      if(!expected.links?.length)delete expected.links;
      assert.deepEqual(after.byId.get(id).meta,expected,id+' only links to deleted subtree removed');
    }
    const refreshed=await (await fetch(base+'/api/projects/editor?project='+project)).json();
    assert.deepEqual(refreshed.nodes.map(n=>n.id),remaining,'editor readback retains link targets');
    assert.deepEqual(read('work/queue.json').items.find(i=>i.id===step.id),step);
    const flat=nodes=>nodes.flatMap(n=>[n,...flat(n.children)]);
    assert.deepEqual(flat(readFramework(project).boards).map(n=>n.id),remaining,'dashboard data retains link targets');
  } finally {
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('projects/catalog.json',catalog);write('work/queue.json',queue);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('deleting a log through the page keeps linked columns, their children and their own edit controls',async()=>{
  const project='zz-delete-log-ui',dir=path.join(root,'workspace/projects',project),file=path.join(dir,'FRAMEWORK.md');
  assert.ok(!fs.existsSync(dir));
  const catalog=read('projects/catalog.json');
  const original=`## Logic
<!--node {"id":"logic","type":"logic"}-->

### Linked column
<!--node {"id":"linked","links":["T-20261027-01"]}-->
Column prose stays.

#### Linked column child
<!--node {"id":"linked-child"}-->
Child prose stays.

## Log
<!--node {"id":"log","type":"timeline"}-->

### Measurement
<!--node {"id":"measurement","kind":"info"}-->
Measurement introduction stays.

#### T-20261027-01 Log to delete
<!--node {"date":"2026-10-27","links":["linked","linked-child","processing"]}-->
Delete only this log.

### Processing
<!--node {"id":"processing","kind":"info"}-->
Processing introduction stays.

#### Processing child
<!--node {"id":"processing-child"}-->
Processing child stays.
`;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,original);
  write('projects/catalog.json',{...catalog,projects:[...catalog.projects,{id:project,name:project,kind:'research'}]});
  const server=createServer();let browser;
  try {
    assert.deepEqual(parseFramework(original).problems,[]);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[];
    await page.clock.install();
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    page.on('request',request=>{if(request.url()===base+'/api/projects/edit')requests.push(request.postDataJSON());});
    await page.goto(base+'/#projects/'+project);
    await page.locator('[data-project-edit-mode]').click();
    const log=page.locator('[data-fw-id="T-20261027-01"]');
    await log.evaluate(el=>{for(let n=el;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;});
    await log.locator('[data-editor-action="delete"]').click();
    const dialog=page.locator('dialog.project-editor');
    await dialog.locator('[name="confirm"]').check();
    await dialog.locator('[type="submit"]').click();
    await dialog.waitFor({state:'detached'});
    assert.equal(requests.length,1,'one delete action only');
    assert.equal(requests[0].id,'T-20261027-01','the log, not a linked column, is the deletion target');
    const remaining=['logic','linked','linked-child','log','measurement','processing','processing-child'];
    const parsed=parseFramework(fs.readFileSync(file,'utf8'));
    assert.deepEqual(parsed.nodes.map(n=>n.id),remaining);
    assert.deepEqual(parsed.problems,[]);
    for(const id of remaining.filter(id=>!['logic','log'].includes(id))) {
      const node=page.locator(`[data-fw-id="${id}"]`);
      await node.waitFor({state:'attached'});
      assert.equal(parsed.byId.get(id).body,parseFramework(original).byId.get(id).body);
      assert.equal(await node.locator(`:scope > summary [data-fw-edit="${id}"]`).count(),1);
    }
    assert.equal(await log.count(),0);
  } finally {
    await browser?.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    write('projects/catalog.json',catalog);fs.rmSync(dir,{recursive:true,force:true});
  }
});
