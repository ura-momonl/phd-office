import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {root,read,write} from '../automation/files.mjs';
import {convertDOIs,cloudPDF,acquirePMC,runPMCBatch} from './pmc-batch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use scripts/run-tests.mjs');
const doi='10.5555/pmc-fixture',other='10.5555/pmc-second';
const dir=path.join(root,'.runtime/pmc-fixture'),targets_file=path.join(dir,'targets.json');
const out=d=>path.join(root,'literature/fulltext','doi-'+createHash('sha256').update(d).digest('hex').slice(0,16)+'.pdf');
const digest=b=>createHash('md5').update(b).digest('hex');
function pdf(d=doi){
  const content=`BT /F1 12 Tf 72 720 Td (${d}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let body='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(body+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const mapping=(d=doi)=>({doi:d,pmcid:'PMC123',versions:[{pmcid:'PMC123.1',current:true}]});
const meta=(bytes=pdf(),extra={})=>({doi,pmcid:'PMC123',version:1,is_pmc_openaccess:true,is_manuscript:false,is_retracted:false,
  license_code:'CC BY',pdf_url:`s3://pmc-oa-opendata/PMC123.1/PMC123.1.pdf?md5=${digest(bytes)}`,...extra});
beforeEach(()=>{
  fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
  for(const d of [doi,other])fs.rmSync(out(d),{force:true});
  write('literature/catalog.json',{papers:[doi,other].map(d=>({id:'doi-'+createHash('sha256').update(d).digest('hex').slice(0,16),doi:d,title:'Fictional article',source:'Science Advances'}))});
});
afterEach(()=>{for(const d of [doi,other])fs.rmSync(out(d),{force:true});});
function mockCloud(t,{bytes=pdf(),metadata=meta(bytes),status=200}={}){
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    url=String(url);calls.push(url);assert.equal(options.redirect,'error');
    assert.ok(['pmc.ncbi.nlm.nih.gov','pmc-oa-opendata.s3.amazonaws.com'].includes(new URL(url).hostname));
    if(url.includes('/idconv/')){const ids=new URL(url).searchParams.get('ids').split(',');return Response.json({status:'ok',records:ids.map(d=>({...mapping(d),'requested-id':d}))});}
    if(status!==200)return new Response('',{status});
    if(url.includes('/metadata/'))return Response.json(metadata);
    return new Response(bytes, {headers:{'content-type':'application/pdf'}});
  });return calls;
}
test('converter uses bounded official requests and refuses a mismatched or omitted DOI',async t=>{
  const calls=mockCloud(t);const r=await convertDOIs([doi]);assert.equal(r[doi].pmcid,'PMC123');assert.equal(calls.length,1);
  await assert.rejects(convertDOIs(Array(101).fill(doi)),/1..100/);
  t.mock.method(globalThis,'fetch',async()=>Response.json({status:'ok',records:[{'requested-id':doi,doi:other,pmcid:'PMC123'}]}));
  await assert.rejects(convertDOIs([doi]),/mismatch/);
  t.mock.method(globalThis,'fetch',async()=>Response.json({status:'ok',records:[]}));await assert.rejects(convertDOIs([doi]),/omitted/);
});
test('cloud PDF must be the observed main article object with an MD5, never a publisher or supplement',()=>{
  assert.equal(cloudPDF(meta()).url,'https://pmc-oa-opendata.s3.amazonaws.com/PMC123.1/PMC123.1.pdf');
  for(const pdf_url of ['https://science.org/paper.pdf','s3://other-bucket/PMC123.1/PMC123.1.pdf','s3://pmc-oa-opendata/PMC123.1/supplement.pdf'])
    assert.throws(()=>cloudPDF({...meta(),pdf_url}),/official dataset/);
  assert.throws(()=>cloudPDF({...meta(),pdf_url:'s3://pmc-oa-opendata/PMC123.1/PMC123.1.pdf'}),/MD5/);
});
test('real PDF validation and registration preserve source, license and publication version; second run is local',async t=>{
  const calls=mockCloud(t);const r=await acquirePMC({doi},mapping(),{directory:dir});assert.equal(r.status,'available');assert.equal(r.reused,false);
  const p=read('literature/catalog.json').papers.find(p=>p.doi===doi);assert.equal(p.fulltext_access,'pmc-open-access');assert.equal(p.fulltext_license,'CC BY');assert.equal(p.fulltext_version,'publishedVersion');
  assert.equal(p.fulltext_source,r.source);assert.equal(p.fulltext_sha256,r.sha256);assert.equal(p.pmcid,'PMC123');assert.ok(fs.existsSync(p.fulltext_path));
  const n=calls.length;const again=await acquirePMC({doi},mapping(),{directory:dir});assert.equal(again.reused,true);assert.equal(calls.length,n);
});
test('MD5 mismatch and wrong-article PDF never reach catalog or fulltext storage',async t=>{
  mockCloud(t,{metadata:meta(Buffer.from('different'))});await assert.rejects(acquirePMC({doi},mapping(),{directory:dir}),/MD5/);assert.ok(!fs.existsSync(out(doi)));
  mockCloud(t,{bytes:pdf(other)});await assert.rejects(acquirePMC({doi},mapping(),{directory:dir}),/Requested DOI/);
  assert.ok(!read('literature/catalog.json').papers[0].fulltext_path);assert.ok(!fs.existsSync(out(doi)));
});
test('no PDF, embargo, missing PMCID and retracted metadata are not counted as downloads',async t=>{
  mockCloud(t,{metadata:meta(pdf(),{pdf_url:null})});assert.equal((await acquirePMC({doi},mapping(),{directory:dir})).status,'no_cloud_pdf');
  mockCloud(t,{metadata:meta(pdf(),{is_retracted:true})});assert.equal((await acquirePMC({doi},mapping(),{directory:dir})).status,'no_cloud_pdf');
  assert.equal((await acquirePMC({doi},{},{directory:dir})).status,'not_in_pmc');
  assert.equal((await acquirePMC({doi},{...mapping(),live:false},{directory:dir})).status,'embargoed');
});
test('published PDF is preferred to a current manuscript without inventing version semantics',async t=>{
  const bytes=pdf(),m=mapping();m.versions.push({pmcid:'PMC123.2',current:true});m.versions[0].current=false;
  t.mock.method(globalThis,'fetch',async url=>String(url).endsWith('.json')?Response.json(String(url).includes('PMC123.2')?meta(bytes,{version:2,is_manuscript:true}):meta(bytes)):new Response(bytes));
  const r=await acquirePMC({doi},m,{directory:dir});assert.equal(r.pmc_version,1);assert.equal(r.version,'publishedVersion');
});
test('batch checkpoints, resumes only unfinished articles, isolates paper rejection and respects STOP',async t=>{
  mockCloud(t);fs.writeFileSync(targets_file,JSON.stringify([{doi},{doi:other}]));
  const cfg={directory:dir,targets_file,concurrency:1,max:1};const first=await runPMCBatch(cfg);assert.equal(first.status,'paused');assert.equal(first.available,1);
  const second=await runPMCBatch(cfg);assert.equal(second.status,'complete');assert.equal(second.completed,2);assert.equal(second.available,1);assert.equal(second.counts.failed,1);
  const third=await runPMCBatch(cfg);assert.equal(third.completed,2);assert.equal(third.available,1);assert.equal(third.status,'complete');
  fs.writeFileSync(path.join(dir,'STOP'),'stop');await assert.rejects(runPMCBatch(cfg),/STOP exists/);
});
test('PMC 429 stops the batch, never retries or changes provider, and leaves the DOI unfinished',async t=>{
  const calls=mockCloud(t,{status:429});fs.writeFileSync(targets_file,JSON.stringify([{doi},{doi:other}]));
  const s=await runPMCBatch({directory:dir,targets_file,concurrency:1});assert.equal(s.status,'failed');assert.match(s.reason,/HTTP 429/);assert.equal(s.completed,0);
  assert.equal(calls.length,2);assert.ok(!fs.existsSync(path.join(dir,'RUNNING')));
});
test('a single PDF network interruption is recorded once while the next article is still attempted',async t=>{
  const calls=mockCloud(t);const upstream=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).endsWith('.pdf'))throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});return upstream(url,options);});
  fs.writeFileSync(targets_file,JSON.stringify([{doi},{doi:other}]));
  const s=await runPMCBatch({directory:dir,targets_file,concurrency:1});assert.equal(s.status,'complete');assert.equal(s.completed,2);assert.equal(s.counts.failed,2);
  const log=fs.readFileSync(path.join(dir,'attempts.jsonl'),'utf8');assert.match(log,/ECONNRESET/);assert.equal(calls.filter(u=>u.includes('/metadata/')).length,2);
});

for(const stage of ['metadata','pdf'])test(`a ${stage} response-body timeout fails only that DOI; next PDF is registered and resume does not retry`,async t=>{
  const calls=[],mappingFor=d=>({...mapping(d),pmcid:d===doi?'PMC123':'PMC456',
    versions:[{pmcid:d===doi?'PMC123.1':'PMC456.1',current:true}]});
  t.mock.method(globalThis,'fetch',async url=>{
    url=String(url);calls.push(url);
    if(url.includes('/idconv/'))return Response.json({status:'ok',records:[doi,other].map(d=>({...mappingFor(d),'requested-id':d}))});
    const d=url.includes('PMC456')?other:doi,isMetadata=url.includes('/metadata/');
    if(d===doi&&(stage==='metadata'?isMetadata:!isMetadata))
      return new Response(new ReadableStream({start(controller){controller.error(new DOMException('fixture body timeout','TimeoutError'));}}));
    const bytes=pdf(d),pmcid=mappingFor(d).pmcid;
    return isMetadata?Response.json(meta(bytes,{doi:d,pmcid,pdf_url:`s3://pmc-oa-opendata/${pmcid}.1/${pmcid}.1.pdf?md5=${digest(bytes)}`})):new Response(bytes);
  });
  fs.writeFileSync(targets_file,JSON.stringify([{doi},{doi:other}]));
  const cfg={directory:dir,targets_file,concurrency:1};
  const s=await runPMCBatch(cfg);assert.equal(s.status,'complete');assert.equal(s.completed,2);
  assert.equal(s.counts.failed,1);assert.equal(s.available,1);
  assert.ok(!read('literature/catalog.json').papers.find(p=>p.doi===doi).fulltext_path);
  assert.ok(read('literature/catalog.json').papers.find(p=>p.doi===other).fulltext_path);
  const log=fs.readFileSync(path.join(dir,'attempts.jsonl'),'utf8');assert.match(log,/TimeoutError/);
  const n=calls.length,again=await runPMCBatch(cfg);assert.equal(again.status,'complete');assert.equal(again.completed,2);assert.equal(calls.length,n);
});

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('a real Windows progress-file lock does not abort registration; final snapshot catches up without a network retry',{skip:process.platform!=='win32'},async t=>{
  const calls=mockCloud(t),ready=path.join(dir,'PROGRESS_LOCK_READY'),release=path.join(dir,'PROGRESS_LOCK_RELEASE');
  const progress=path.join(dir,'progress.json'),helper=path.join(dir,'hold-progress.ps1');
  fs.writeFileSync(progress,JSON.stringify({status:'previous-snapshot'}));
  fs.writeFileSync(targets_file,JSON.stringify([{doi}]));
  fs.writeFileSync(helper,`param([string]$File,[string]$Ready,[string]$Release)\n$ErrorActionPreference='Stop'\n$stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry {[IO.File]::WriteAllText($Ready,'ready');for($i=0;$i -lt 400;$i++){if(Test-Path -LiteralPath $Release){break};Start-Sleep -Milliseconds 50}} finally {$stream.Dispose()}\n`);
  const holder=spawn('powershell.exe',['-NoProfile','-File',helper,'-File',progress,'-Ready',ready,'-Release',release],{windowsHide:true,stdio:'pipe'});
  let stderr='';holder.stderr.on('data',b=>stderr+=b);const closed=new Promise((resolve,reject)=>{holder.once('error',reject);holder.once('close',resolve);});
  t.after(async()=>{fs.writeFileSync(release,'release');await closed;});
  for(let i=0;i<250&&!fs.existsSync(ready);i++)await wait(20);
  assert.ok(fs.existsSync(ready),'Require the real replacement lock before starting: '+stderr);
  const append=fs.appendFileSync;let registeredWhileLocked=false;
  t.mock.method(fs,'appendFileSync',(file,...args)=>{
    const result=append(file,...args);
    if(file===path.join(dir,'attempts.jsonl')){
      assert.equal(JSON.parse(fs.readFileSync(progress,'utf8')).status,'previous-snapshot');
      assert.ok(read('literature/catalog.json').papers.find(p=>p.doi===doi).fulltext_path);
      registeredWhileLocked=true;fs.writeFileSync(release,'release');
    }
    return result;
  });
  const cfg={directory:dir,targets_file,concurrency:1},s=await runPMCBatch(cfg);await closed;
  assert.ok(registeredWhileLocked);assert.equal(s.status,'complete');assert.equal(s.available,1);
  const published=JSON.parse(fs.readFileSync(progress,'utf8'));assert.equal(published.status,'complete');assert.equal(published.completed,1);
  assert.match(fs.readFileSync(path.join(dir,'progress.log'),'utf8'),/WAIT progress snapshot/);
  assert.match(fs.readFileSync(path.join(dir,'progress.log'),'utf8'),/RESUMED progress snapshot/);
  const n=calls.length,again=await runPMCBatch(cfg);assert.equal(again.available,1);assert.equal(calls.length,n);
});

test('actual Windows replacement lock waits, then rereads changed catalog without downloading again',{skip:process.platform!=='win32'},async t=>{
  const calls=mockCloud(t),ready=path.join(dir,'LOCK_READY'),release=path.join(dir,'LOCK_RELEASE');
  const helper=path.join(dir,'hold-file.ps1');
  fs.writeFileSync(helper,`param([string]$Catalog,[string]$Ready,[string]$Release)\n$ErrorActionPreference='Stop'\n$stream=[IO.File]::Open($Catalog,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry {[IO.File]::WriteAllText($Ready,'ready');for($i=0;$i -lt 400;$i++){if(Test-Path -LiteralPath $Release){break};Start-Sleep -Milliseconds 50}} finally {$stream.Dispose()}\n`);
  const holder=spawn('powershell.exe',['-NoProfile','-File',helper,'-Catalog',path.join(root,'literature/catalog.json'),'-Ready',ready,'-Release',release],{windowsHide:true,stdio:'pipe'});
  let stderr='';holder.stderr.on('data',b=>stderr+=b);const closed=new Promise((resolve,reject)=>{holder.once('error',reject);holder.once('close',resolve);});
  t.after(async()=>{fs.writeFileSync(release,'release');await closed;});
  for(let i=0;i<250&&!fs.existsSync(ready);i++)await wait(20);
  assert.ok(fs.existsSync(ready),'The real file lock must exist before exercising registration: '+stderr);
  let waits=0,editDone=Promise.resolve();
  const r=await acquirePMC({doi},mapping(),{directory:dir,onRegistration:event=>{
    if(event.stage!=='waiting_registration')return;
    waits++;assert.ok(['EPERM','EACCES','EBUSY'].includes(event.registration_error));
    assert.ok(fs.existsSync(out(doi)));assert.ok(!read('literature/catalog.json').papers[0].fulltext_path);
    fs.writeFileSync(release,'release');
    editDone=closed.then(()=>{const c=read('literature/catalog.json');c.papers.find(p=>p.doi===other).title='Changed while waiting';write('literature/catalog.json',c);});
  }});
  await editDone;assert.ok(waits>=1);assert.equal(r.status,'available');assert.equal(calls.length,2);
  assert.equal(read('literature/catalog.json').papers.find(p=>p.doi===other).title,'Changed while waiting');
});

test('STOP during registration wait preserves a durable receipt; next run registers locally with provenance',async t=>{
  const calls=mockCloud(t),rename=fs.renameSync;
  const locked=t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(root,'literature/catalog.json'))throw Object.assign(new Error('fixture sharing violation'),{code:'EPERM'});return rename(from,to);});
  await assert.rejects(acquirePMC({doi},mapping(),{directory:dir,onRegistration:e=>{if(e.stage==='waiting_registration')fs.writeFileSync(path.join(dir,'STOP'),'stop');}}),/Stopped while waiting/);
  const receipts=fs.readdirSync(path.join(dir,'pending-registration'));assert.equal(receipts.length,1);assert.ok(fs.existsSync(out(doi)));assert.ok(!read('literature/catalog.json').papers[0].fulltext_path);
  locked.mock.restore();fs.unlinkSync(path.join(dir,'STOP'));const n=calls.length;
  const r=await acquirePMC({doi},mapping(),{directory:dir});assert.equal(r.recovered_pending,true);assert.equal(r.reused,false);assert.equal(calls.length,n);
  const p=read('literature/catalog.json').papers[0];assert.equal(p.fulltext_access,'pmc-open-access');assert.equal(p.fulltext_license,'CC BY');assert.equal(p.fulltext_sha256,r.sha256);
  assert.equal(fs.readdirSync(path.join(dir,'pending-registration')).length,0);
});

test('batch exposes waiting_registration, stops without marking the DOI failed, and resumes once',async t=>{
  const calls=mockCloud(t),rename=fs.renameSync;fs.writeFileSync(targets_file,JSON.stringify([{doi}]));
  const locked=t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(root,'literature/catalog.json'))throw Object.assign(new Error('fixture sharing violation'),{code:'EBUSY'});return rename(from,to);});
  const cfg={directory:dir,targets_file,concurrency:1};const running=runPMCBatch(cfg);
  let waiting;
  for(let i=0;i<500;i++){
    const file=path.join(dir,'progress.json');if(fs.existsSync(file)){const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.status==='waiting_registration'){waiting=s;break;}}
    await wait(10);
  }
  fs.writeFileSync(path.join(dir,'STOP'),'stop');const stopped=await running;assert.ok(waiting);assert.equal(waiting.current[0].stage,'waiting_registration');
  assert.equal(stopped.status,'stopped');assert.equal(stopped.completed,0);assert.ok(!fs.existsSync(path.join(dir,'attempts.jsonl')));
  locked.mock.restore();fs.unlinkSync(path.join(dir,'STOP'));const n=calls.length;
  const resumed=await runPMCBatch(cfg);assert.equal(resumed.status,'complete');assert.equal(resumed.available,1);assert.equal(resumed.newly_acquired,1);assert.equal(calls.length,n);
  const again=await runPMCBatch(cfg);assert.equal(again.available,1);assert.equal(calls.length,n);
});

test('modified PDF cannot use a pending registration receipt to bypass identity or hash validation',async t=>{
  mockCloud(t);const rename=fs.renameSync;
  const locked=t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(root,'literature/catalog.json'))throw Object.assign(new Error('fixture lock'),{code:'EPERM'});return rename(from,to);});
  await assert.rejects(acquirePMC({doi},mapping(),{directory:dir,onRegistration:e=>{if(e.stage==='waiting_registration')fs.writeFileSync(path.join(dir,'STOP'),'stop');}}),/Stopped while waiting/);
  locked.mock.restore();fs.unlinkSync(path.join(dir,'STOP'));fs.writeFileSync(out(doi),pdf(other));
  await assert.rejects(acquirePMC({doi},mapping(),{directory:dir}),/PDF hash differs/);assert.ok(!read('literature/catalog.json').papers[0].fulltext_path);
});
