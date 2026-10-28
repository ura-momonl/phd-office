import test from 'node:test';
import assert from 'node:assert/strict';
import {read,write} from '../automation/files.mjs';
import {submit,drain} from './run.mjs';
import {saveSettings} from '../dashboard/settings.mjs';
import {withoutTitle} from '../automation/titleless.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');

const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async(check,message)=>{
  const end=Date.now()+10000;
  while(!check() && Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.ok(check(),message);
};

// User requirement: lowering concurrency mid-work must not cancel existing work,
// even while the running count exceeds the newly saved cap.
test('lowering the live cap preserves active turns and queues new work until below the new cap',async()=>{
  const files=['agent/config.json','work/queue.json','.runtime/agent/sessions.json'];
  const saved=new Map(files.map(file=>[file,read(file)]));
  const slots=Array.from({length:5},()=>({entered:false,signal:null,done:gate()}));
  const drains=[];
  try {
    write('agent/config.json',{...saved.get('agent/config.json'),enabled:true,memory_v2:{enabled:false},max_active_agents:3});
    const jobs=slots.map((_,n)=>submit({text:'@Claude LIVE_CAP_FIXTURE_'+n}));
    const status=n=>read('work/queue.json').items.find(i=>i.id===jobs[n].task_id).status;
    let running=0,peakAfterShrink=0,shrunk=false;
    const runner=withoutTitle(async(_,prompt,opts)=>{
      const n=Number(prompt.match(/LIVE_CAP_FIXTURE_(\d+)/)[1]),slot=slots[n];
      assert.equal(slot.entered,false,'an existing task must not be restarted');
      slot.entered=true;slot.signal=opts.signal;running++;
      if(shrunk)peakAfterShrink=Math.max(peakAfterShrink,running);
      await slot.done.promise;
      assert.equal(opts.signal.aborted,false,'saving a lower cap must not abort active work');
      running--;
      return {result:'PRESERVED_RESULT_'+n};
    });
    const dispatch=()=>{const promise=drain(runner);drains.push(promise);return promise;};
    dispatch();
    await until(()=>slots.filter(s=>s.entered).length===3,'three tasks started before shrinking');
    assert.deepEqual(slots.map((_,n)=>status(n)),['active','active','active','queued','queued']);

    saveSettings({max_active_agents:1});shrunk=true;
    await dispatch();
    assert.equal(running,3,'all three existing turns remain running above the new cap');
    assert.ok(slots.slice(0,3).every(s=>!s.signal.aborted));
    assert.deepEqual(slots.map((_,n)=>status(n)),['active','active','active','queued','queued']);

    for(const n of [0,1]) {
      slots[n].done.resolve();
      await until(()=>status(n)==='done','existing work finishes normally');
      await dispatch();
      assert.equal(slots.filter(s=>s.entered).length,3,'no queued task starts while at or above the new cap');
    }
    slots[2].done.resolve();await drains[0];
    for(const n of [3,4]) {
      const pending=dispatch();
      await until(()=>slots[n].entered,'queued work starts after running count falls below the new cap');
      assert.equal(running,1);
      assert.equal(slots.filter(s=>s.entered).length,n+1,'only one new task is admitted');
      slots[n].done.resolve();await pending;
    }
    assert.equal(peakAfterShrink,1);
    assert.ok(slots.every((_,n)=>status(n)==='done'));
    const sessions=read('.runtime/agent/sessions.json').sessions;
    for(const [n,job] of jobs.entries())assert.ok(sessions.find(s=>s.id===job.session_id).messages.some(m=>m.text==='PRESERVED_RESULT_'+n),'every original result is retained');
  } finally {
    slots.forEach(s=>s.done.resolve());
    await Promise.allSettled(drains);
    for(const [file,data] of saved)write(file,data);
  }
});
