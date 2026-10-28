import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../dashboard/server.mjs';
import { read,write } from './files.mjs';
import { access,normalizeDOI } from '../literature/run.mjs';
import { compare } from '../procurement/run.mjs';
import { handle } from '../remote/discord.mjs';

test('workbench request persists project and owner; missing outcome cannot become done; Discord reads same queue',async()=>{
  const server=createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`; let created;
  try {
    const original=await (await fetch(base+'/api/state')).json();
    const post=(route,data)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    const bad=await post('/api/tasks',{title:'[validation] invalid',kind:'data',project_ids:['unknown']}); assert.equal(bad.status,400);
    assert.equal(read('work/queue.json').items.length,original.work.items.length);
    const response=await post('/api/tasks',{title:'[validation] shared task',kind:'data',project_ids:['bi-devices'],goal:'UI/Discord integration check; not real research'});
    created=await response.json(); assert.equal(response.status,200); assert.equal(created.actor,'codex');
    assert.deepEqual(created.project_ids,['bi-devices']); assert.equal(created.status,'open');
    assert.ok((await handle('tasks')).includes(created.id));
    assert.equal((await post('/api/task-update',{id:created.id,status:'done'})).status,400);
    assert.equal(read('work/queue.json').items.find(i=>i.id===created.id).status,'open');
    await post('/api/task-update',{id:created.id,status:'done',handoff:'Validation complete; no AI called.'});
    assert.equal(read('work/queue.json').items.find(i=>i.id===created.id).status,'done');
  } finally {
    if(created?.id) { const queue=read('work/queue.json'); queue.items=queue.items.filter(i=>i.id!==created.id); write('work/queue.json',queue); }
    await new Promise(resolve=>server.close(resolve));
  }
});
test('campus fulltext link preserves DOI punctuation without claiming downloaded evidence',()=>{
  assert.equal(normalizeDOI('https://doi.org/10.1103/PhysRevB.100.123456'),'10.1103/physrevb.100.123456');
  const route=access('10.1103/PhysRevB.100.123456');
  const url=new URL(route.campus_fulltext); assert.equal(url.hostname,'ezproxy.library.wisc.edu');
  assert.equal(url.searchParams.get('qurl'),'https://doi.org/10.1103/physrevb.100.123456');
  assert.throws(()=>normalizeDOI('paper title'));
});
test('received quote with unresolved specifications and fees is not a comparable all-in offer',()=>{
  const result=compare('high-vac-pumps'); assert.equal(result.comparison[0].quoted_total,4094.02);
  assert.equal(result.comparison[0].comparable,false); assert.ok(result.comparison[0].missing.includes('lead_time'));
  assert.equal(compare('glenair-parts').comparison[0].quoted_total,null);
});
