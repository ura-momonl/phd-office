import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {WileyTDM,WileyStopped,WILEY_INTERVAL_MS,acquireWiley,runWileyQueue} from './wiley-tdm.mjs';
import {root,read,write} from '../automation/files.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use scripts/run-tests.mjs');
const doi='10.1002/fictional-wiley';
function pdf(text){
  const content=`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let body='%PDF-1.4\n';const offsets=[];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);
  return Buffer.from(body+'xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function sandbox(t){
  fs.mkdirSync(path.join(root,'.runtime'),{recursive:true});
  const directory=fs.mkdtempSync(path.join(root,'.runtime/wiley-test-'));
  const before=read('literature/catalog.json');
  const output=value=>path.join(root,'literature/fulltext/doi-'+createHash('sha256').update(value).digest('hex').slice(0,16)+'.pdf');
  const ids=[doi,'10.1111/fictional-subscription'];
  t.after(()=>{write('literature/catalog.json',before);for(const id of ids)fs.rmSync(output(id),{force:true});fs.rmSync(directory,{recursive:true,force:true});});
  write('literature/catalog.json',{papers:ids.map(doi=>({doi,id:'doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16),title:'Fictional article',is_oa:false}))});
  return {directory,output};
}
const clock=()=>{let time=100000;return {now:()=>time,sleep:async ms=>{time+=ms;}};};

test('API starts are at least twelve seconds apart, persisted across resume; token never reaches binary host',async t=>{
  const {directory}=sandbox(t),timing=clock(),calls=[];
  const transport=async(url,options)=>{
    calls.push({url,time:timing.now(),headers:options.headers,redirect:options.redirect});
    return new URL(url).hostname==='api.wiley.com'?new Response(null,{status:302,headers:{location:'https://alm.wiley.com/file?signature=do-not-log'}}):
      new Response(pdf(doi),{headers:{'content-type':'application/pdf'}});
  };
  const make=()=>new WileyTDM({directory,token:'fake-secret',transport,...timing});
  const client=make();await client.pdf(doi);await client.pdf(doi+'-two');await make().pdf(doi+'-three');
  assert.deepEqual(calls.filter(c=>new URL(c.url).hostname==='api.wiley.com').map(c=>c.time),[100000,112000,124000]);
  assert.ok(calls.every(c=>c.redirect==='manual'));
  assert.ok(calls.filter(c=>new URL(c.url).hostname==='alm.wiley.com').every(c=>!c.headers['Wiley-TDM-Client-Token']));
  assert.equal(WILEY_INTERVAL_MS,12000);assert.throws(()=>new WileyTDM({directory,token:'x',intervalMs:10000}),/12 seconds/);
});

test('unapproved redirects never receive a request or token',async t=>{
  const {directory}=sandbox(t),timing=clock();
  for(const location of ['https://onlinelibrary.wiley.com/article','https://login.wisc.edu/','https://other.example/pdf','https://alm.wiley.com@other.example/pdf']){
    let calls=0;const client=new WileyTDM({directory,token:'fake-secret',...timing,transport:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}});
    const result=await client.pdf(doi);assert.equal(result.error.status,'needs_attention');assert.equal(calls,1);
  }
});

test('Retry-After longer than a minute is respected for the next DOI, no retry of the failed DOI',async t=>{
  const {directory}=sandbox(t),timing=clock(),calls=[];
  const client=new WileyTDM({directory,token:'fake-secret',...timing,transport:async url=>{
    calls.push({url,time:timing.now()});return calls.length===1?new Response(null,{status:429,headers:{'retry-after':'120'}}):new Response(null,{status:404});
  }});
  assert.equal((await client.pdf(doi)).error.status,'rate_limited');
  assert.equal((await client.pdf(doi+'-next')).error.status,'not_accessible');
  assert.deepEqual(calls.map(c=>c.time),[100000,220000]);assert.notEqual(calls[0].url,calls[1].url);
});

test('access denial blocks API lane; user STOP interrupts pacing without making another request',async t=>{
  const {directory}=sandbox(t),timing=clock();let stopped=false,calls=0;
  const client=new WileyTDM({directory,token:'fake-secret',...timing,shouldStop:()=>stopped,transport:async()=>{calls++;return new Response(null,{status:403});}});
  assert.equal((await client.pdf(doi)).error.stop_api,true);stopped=true;
  await assert.rejects(client.pdf(doi+'-next'),WileyStopped);assert.equal(calls,1);
});

test('actual PDF identity and hash validation precede registration, repeat uses cache',async t=>{
  const {directory,output}=sandbox(t);let calls=0;
  const client={pdf:async()=>{calls++;return {bytes:pdf(doi)};}};
  const result=await acquireWiley(doi,client,{directory});assert.equal(result.status,'available',JSON.stringify(result));assert.equal(result.reused,false);
  const saved=read('literature/catalog.json').papers.find(p=>p.doi===doi);
  assert.equal(saved.fulltext_access,'wiley-tdm');assert.equal(saved.fulltext_sha256,createHash('sha256').update(fs.readFileSync(output(doi))).digest('hex'));
  assert.equal((await acquireWiley(doi,client,{directory})).reused,true);assert.equal(calls,1);
});

test('wrong-paper PDF is neither stored nor registered',async t=>{
  const {directory,output}=sandbox(t);
  const result=await acquireWiley(doi,{pdf:async()=>({bytes:pdf('10.1002/a-different-paper')})},{directory});
  assert.equal(result.status,'validation_failed');assert.equal(fs.existsSync(output(doi)),false);
  assert.equal(read('literature/catalog.json').papers.find(p=>p.doi===doi).fulltext_path,undefined);
});

test('queue includes subscription papers, does not select other publishers, and resume makes no duplicate API requests',async t=>{
  const {directory}=sandbox(t),original=globalThis.fetch,token=process.env.WILEY_TDM_TOKEN;let calls=0;
  process.env.WILEY_TDM_TOKEN='fake-secret';
  t.after(()=>{globalThis.fetch=original;if(token===undefined)delete process.env.WILEY_TDM_TOKEN;else process.env.WILEY_TDM_TOKEN=token;});
  // One non-OA Wiley paper and one non-Wiley paper. No OA metadata is consulted.
  const baseline=read('literature/catalog.json');write('literature/catalog.json',{papers:[baseline.papers[0],{doi:'10.5555/other',is_oa:true}]});
  globalThis.fetch=async()=>{calls++;return new Response(pdf(doi),{headers:{'content-type':'application/pdf'}});};
  const first=await runWileyQueue({directory});assert.equal(first.total,1);assert.equal(first.status,'complete');assert.equal(first.newly_acquired,1,fs.readFileSync(path.join(directory,'wiley-attempts.jsonl'),'utf8'));
  const second=await runWileyQueue({directory});assert.equal(second.completed,1);assert.equal(calls,1);
  const targets=JSON.parse(fs.readFileSync(path.join(directory,'wiley-targets.json'),'utf8'));assert.deepEqual(targets.map(p=>p.doi),[doi]);
  assert.ok(!fs.readFileSync(path.join(directory,'wiley-network-requests.jsonl'),'utf8').includes('fake-secret'));
});
