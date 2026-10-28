import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {reconcileRebuildWork} from './rebuild-work.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use scripts/run-tests.mjs --files=literature/rebuild-work.test.mjs');
const base='output/literature-rebuild-20261021/',id='pkg-deepseek-110';
const receiptPath=base+`coordinator/admissions/${id}/receipt.json`;
const ledgerPath=base+`coordinator/admissions/${id}/ledger.json`;
const manifest=base+`coordinator/${id}.json`,inputPath=base+'input.json';
const sha=x=>createHash('sha256').update(x).digest('hex');
const put=(p,v)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');};
const task=(taskId,status='open',extra={})=>({id:taskId,title:`DeepSeek 正式文献包：${id}`,executor:'deepseek',actor:'deepseek',status,
  goal:`用户要求完成此包，现成输入在 ${manifest}`,project_ids:[],outputs:[],dependencies:[],created_at:'2026-10-26T04:39:45.289Z',
  handoff:'原暂停说明',history:[{from:'queued',to:'open',reason:'原始暂停原因'}],...extra});
let source,decisions;
beforeEach(()=>{
  fs.rmSync(path.join(root,base),{recursive:true,force:true});
  source=[{id:'fixture-1',doi:'10.5555/fixture-1',title:'Fictional boundary transport',authors:['测试作者'],journal:'Fixture Physics',year:2020,date:'2020-01-02',
    abstract:'We calculate unusual boundary transport and verify the predicted scaling.',abstract_url:'https://example.org/fixture-1',abstract_from:'fixture'}];
  decisions=[{id:source[0].id,decision:'include',type:'theory',scope:'in',basis:'abstract',source_status:'full-abstract',direction:'new:transport',reason:'虚构边界输运机制',tags:['边界','输运'],evidence:'unusual boundary transport'}];
  put(inputPath,source);put(manifest,{input_sha256:sha(JSON.stringify(source))});
  put(base+'decisions.json',decisions);
  put(base+'audit.json',{owner:'deepseek',package:id,checked_include_ids:[source[0].id],checked_pending_ids:[],checked_exclude_ids:[],exclusion_audit:[]});
  put(base+'request.json',{owner:'deepseek',package:id,decisions:base+'decisions.json',audit:base+'audit.json'});
  put(base+'CONTINUE.json',{catalog:'literature/catalog.json',scope:{date_start:'2015-01-01',date_end:'2026-10-26'},journal_policy:{excluded:[]},work_items:[{id:'fixture-work',status:'accepted'}],
    packages:[{id,owner:'deepseek',manifest,input:inputPath,status:'accepted',work_item_ids:['fixture-work']}]});
  put(ledgerPath,decisions.map(d=>({...d,doi:source[0].doi})));
  put(receiptPath,{package:id,owner:'deepseek',records:1,added:1,added_records:[{id:source[0].id,doi:source[0].doi}],
    final_decisions_sha256:sha(JSON.stringify(decisions)),catalog_readback_verified:true,state_synced:true});
  write('literature/catalog.json',{papers:[{doi:source[0].doi}]});
  write('work/queue.json',{version:1,items:[task('old-open'),task('old-queued','queued'),task('failed','failed'),task('running','active'),task('cancelled','cancelled'),
    task('download','open',{title:'Codex 全文下载',actor:'codex',executor:'codex'}),task('multi','open',{title:'DeepSeek 文献尾项收尾'}),task('no-binding','open',{goal:'仅提及某个包名'}),
    task('wrong-owner','open',{actor:'codex',executor:'codex'})]});
});
test('previews without mutation; closes only the exact unstarted handoff, preserving failure history and outputs',()=>{
  const before=read('work/queue.json'),catalog=fs.readFileSync(path.join(root,'literature/catalog.json'));
  const preview=reconcileRebuildWork(id);
  assert.deepEqual(preview.results.map(r=>r.task),['old-open','old-queued']);
  assert.deepEqual(read('work/queue.json'),before);
  const result=reconcileRebuildWork(id,{apply:true});assert.equal(result.results.length,2);
  for(const t of read('work/queue.json').items){
    if(['old-open','old-queued'].includes(t.id)){
      assert.equal(t.status,'done');assert.match(t.handoff,/不表示本对话曾实际运行/);
      assert.ok(t.outputs.includes(receiptPath));assert.equal(t.history[0].reason,'原始暂停原因');
    }else assert.deepEqual(t,before.items.find(r=>r.id===t.id));
  }
  assert.deepEqual(fs.readFileSync(path.join(root,'literature/catalog.json')),catalog);
  const completed=fs.readFileSync(path.join(root,'work/turns.json'));
  assert.equal(reconcileRebuildWork('all',{apply:true}).results.length,0);
  assert.equal(reconcileRebuildWork('all',{apply:true}).results.length,0);
  assert.deepEqual(fs.readFileSync(path.join(root,'work/turns.json')),completed);
});
for(const [label,damage] of [
  ['missing catalog DOI',()=>write('literature/catalog.json',{papers:[]})],
  ['wrong ledger ID',()=>put(ledgerPath,[{...decisions[0],id:'foreign',doi:source[0].doi}])],
  ['wrong receipt owner',()=>put(receiptPath,{...read(receiptPath),owner:'claude'})],
  ['unverified receipt',()=>put(receiptPath,{...read(receiptPath),catalog_readback_verified:false})],
  ['unsynced receipt',()=>put(receiptPath,{...read(receiptPath),state_synced:false})],
])test(label+' leaves dispatch unfinished',()=>{
  damage();const before=read('work/queue.json');
  assert.equal(reconcileRebuildWork(id,{apply:true}).results[0].status,'error');
  assert.deepEqual(read('work/queue.json'),before);
});
test('accepted with unresolved pending is not silently called complete',()=>{
  put(ledgerPath,[{...decisions[0],decision:'pending',doi:source[0].doi}]);
  const before=read('work/queue.json');
  assert.equal(reconcileRebuildWork(id,{apply:true}).results[0].status,'pending');
  assert.deepEqual(read('work/queue.json'),before);
});
function admit(){
  const result=spawnSync(process.execPath,['.agents/skills/literature-backfill/scripts/admit-reviewed.mjs',base+'request.json'],{cwd:root,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);
}
test('actual admission and its idempotent resubmission both reconcile; the catalog is written only once',()=>{
  fs.rmSync(path.join(root,base+'coordinator/admissions'),{recursive:true,force:true});
  const state=read(base+'CONTINUE.json');state.packages[0].status='ready';put(base+'CONTINUE.json',state);
  write('literature/catalog.json',{papers:[]});
  assert.equal(admit().work_sync.results.filter(r=>r.status==='done').length,2);
  assert.equal(read('literature/catalog.json').papers.length,1);
  const catalog=fs.readFileSync(path.join(root,'literature/catalog.json'));
  const queue=read('work/queue.json');queue.items.push(task('later-handoff'));write('work/queue.json',queue);
  assert.equal(admit().work_sync.results[0].task,'later-handoff');
  assert.equal(read('work/queue.json').items.find(t=>t.id==='later-handoff').status,'done');
  assert.equal(admit().work_sync.results.length,0);
  assert.deepEqual(fs.readFileSync(path.join(root,'literature/catalog.json')),catalog);
});
test('queue sync failure is reported without undoing a successful admission',()=>{
  fs.rmSync(path.join(root,base+'coordinator/admissions'),{recursive:true,force:true});
  const state=read(base+'CONTINUE.json');state.packages[0].status='ready';put(base+'CONTINUE.json',state);
  write('literature/catalog.json',{papers:[]});
  const queue=read('work/queue.json');queue.items.find(t=>t.id==='old-open').dependencies=['nonexistent'];write('work/queue.json',queue);
  const result=admit();assert.equal(result.catalog_readback_verified,true);
  assert.ok(result.work_sync.results.some(r=>r.status==='error'));
  assert.equal(read('work/queue.json').items.find(t=>t.id==='old-open').status,'open');
  assert.equal(read('literature/catalog.json').papers.length,1);
});
