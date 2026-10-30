// Explicit PMC-only batch: DOI conversion API -> official cloud metadata -> PDF.
// No publisher requests, browser, Zotero, model calls, paid service or network retries.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {root,read,input} from '../automation/files.mjs';
import {normalizeDOI,record} from './run.mjs';
import {validatePDF} from './fetch.mjs';

const cloud='https://pmc-oa-opendata.s3.amazonaws.com';
const converter='https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';
const yes=v=>v===true||v==='yes'||v==='true';
const no=v=>v===false||v==='no'||v==='false';
const hash=(data,algorithm='sha256')=>createHash(algorithm).update(data).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class ServiceError extends Error {}
class BatchStopped extends Error {}
const registrationFile=(directory,doi)=>path.join(directory,'pending-registration',hash(doi)+'.json');

// Retry only local registration, not download/validation. record() rereads the live
// catalog on every attempt, so another writer's intervening metadata is retained.
async function registerWhenReady(update,{directory,onRegistration,shouldStop,reused=false}) {
  const pending=registrationFile(directory,update.doi);
  fs.mkdirSync(path.dirname(pending),{recursive:true});
  if(!fs.existsSync(pending))fs.writeFileSync(pending,JSON.stringify({update,reused},null,2)+'\n',{flag:'wx'});
  let attempt=0;
  while(true){
    if(shouldStop())throw new BatchStopped('Stopped before registration; verified PDF and metadata preserved');
    let item;
    try{item=record(update);}
    catch(e){
      if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;
      attempt++;
      onRegistration({stage:'waiting_registration',registration_attempt:attempt,registration_error:e.code});
      // STOP remains responsive even during an indefinite local file-lock wait.
      const end=Date.now()+(attempt===1?2000:10000);
      while(Date.now()<end){
        if(shouldStop())throw new BatchStopped('Stopped while waiting for registration; verified PDF and metadata preserved');
        await pause(Math.min(250,end-Date.now()));
      }
      continue;
    }
    // A leftover receipt is harmless and permits recovery after a host interruption.
    try{fs.unlinkSync(pending);}catch(e){if(e.code!=='ENOENT')onRegistration({registration_cleanup_error:e.code});}
    onRegistration({stage:'registered',registration_error:null});
    return item;
  }
}

async function request(url) {
  // Deliberately do not follow even a redirect to a publisher or legacy service.
  let response;
  try{response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});}
  catch(e){throw new Error(`PMC network request failed (${e.cause?.code||e.name}); no retry`);}
  if([401,403,429].includes(response.status)||response.status>=500)
    throw new ServiceError(`PMC service HTTP ${response.status}; batch stopped without retry`);
  if(!response.ok&&response.status!==404)throw new ServiceError(`PMC service HTTP ${response.status}`);
  return response;
}

export async function convertDOIs(dois) {
  if(!dois.length||dois.length>100)throw Error('Provide 1..100 DOIs per conversion request');
  const ids=dois.map(normalizeDOI),url=new URL(converter);
  url.search=new URLSearchParams({ids:ids.join(','),idtype:'doi',format:'json',versions:'yes',tool:'piri-office'});
  const response=await request(url);
  if(!response.ok)throw new ServiceError('PMC conversion endpoint unavailable');
  const data=await response.json();
  if(data.status!=='ok'||!Array.isArray(data.records))throw new ServiceError('Unexpected PMC conversion response');
  return Object.fromEntries(ids.map(doi=>{
    const r=data.records.find(r=>String(r['requested-id']||r.doi).toLowerCase()===doi);
    if(!r)throw new ServiceError('PMC conversion response omitted a requested DOI');
    if(r.pmcid&&normalizeDOI(r.doi)!==doi)throw new ServiceError('PMC conversion DOI mismatch');
    return [doi,r];
  }));
}

export function cloudPDF(metadata) {
  const u=new URL(metadata.pdf_url);
  if(u.protocol!=='s3:'||u.hostname!=='pmc-oa-opendata'
    ||u.pathname!==`/${metadata.pmcid}.${metadata.version}/${metadata.pmcid}.${metadata.version}.pdf`)
    throw Error('PMC metadata PDF is not an article PDF in the official dataset');
  const md5=u.searchParams.get('md5');
  if(!/^[a-f0-9]{32}$/i.test(md5||''))throw Error('PMC PDF metadata is missing the MD5 checksum');
  return {url:cloud+u.pathname,md5:md5.toLowerCase()};
}

export async function acquirePMC(paper,mapping,{directory,onRegistration=()=>{},shouldStop=()=>fs.existsSync(path.join(directory,'STOP'))}) {
  const doi=normalizeDOI(paper.doi);
  const current=read('literature/catalog.json').papers.find(p=>p.doi===doi);
  if(!current||current.library_status&&current.library_status!=='active')
    return {status:'skipped',message:'Article no longer active in the library'};
  const output=path.join(root,'literature/fulltext','doi-'+hash(doi).slice(0,16)+'.pdf');
  const existing=current.fulltext_path&&fs.existsSync(current.fulltext_path)?current.fulltext_path:fs.existsSync(output)?output:null;
  if(existing){
    const pending=registrationFile(directory,doi);
    if(fs.existsSync(pending)){
      const receipt=input(pending),update=receipt.update;
      if(update.doi!==doi||path.resolve(update.fulltext_path)!==path.resolve(existing)||!update.fulltext_sha256)
        throw Error('Pending registration does not match the existing article PDF');
      const checked=validatePDF(existing,doi,update.fulltext_sha256,update.fulltext_identity,current.title);
      const item=await registerWhenReady(update,{directory,onRegistration,shouldStop,reused:receipt.reused});
      return {status:'available',reused:!!receipt.reused,recovered_pending:true,path:item.fulltext_path,source:item.fulltext_source,
        pmcid:item.pmcid,pmc_version:item.pmc_version,license:item.fulltext_license,version:item.fulltext_version,...checked};
    }
    const checked=validatePDF(existing,doi,current.fulltext_sha256,current.fulltext_identity,current.title);
    if(!current.fulltext_path)await registerWhenReady({doi,fulltext_path:existing,fulltext_sha256:checked.sha256,fulltext_identity:checked.identity||null},{directory,onRegistration,shouldStop,reused:true});
    return {status:'available',reused:true,path:existing,...checked};
  }
  if(!mapping?.pmcid)return {status:'not_in_pmc'};
  if(no(mapping.live))return {status:'embargoed'};
  if(!/^PMC\d+$/.test(mapping.pmcid)||normalizeDOI(mapping.doi)!==doi)throw Error('PMC mapping identity mismatch');
  // Use actual version identifiers from the official ID converter, never assume v1 is preferred.
  const versions=(mapping.versions||[]).filter(v=>new RegExp('^'+mapping.pmcid+'\\.\\d+$').test(v.pmcid)&&!no(v.live));
  if(!versions.length)return {status:'no_cloud_version'};
  const metadata=[];
  for(const version of versions){
    const response=await request(`${cloud}/metadata/${version.pmcid}.json`);
    if(response.status===404)continue;
    const m=await response.json().catch(e=>{
      throw new Error(`PMC article metadata read failed (${e.cause?.code||e.name}); no retry`);
    });
    if(m.pmcid!==mapping.pmcid||`${m.pmcid}.${m.version}`!==version.pmcid||normalizeDOI(m.doi)!==doi)
      throw Error('PMC cloud metadata identity mismatch');
    if(!yes(m.is_pmc_openaccess)||yes(m.is_retracted)||(!yes(m.is_manuscript)&&!no(m.is_manuscript)))continue;
    metadata.push({...m,current:yes(version.current)});
  }
  const candidates=metadata.filter(m=>m.pdf_url).sort((a,b)=>Number(yes(a.is_manuscript))-Number(yes(b.is_manuscript))||Number(b.current)-Number(a.current));
  if(!candidates.length)return {status:'no_cloud_pdf',message:'No eligible OA PDF in PMC cloud; XML is not counted as PDF'};
  const m=candidates[0],pdf=cloudPDF(m);
  const response=await request(pdf.url);
  if(response.status===404)return {status:'no_cloud_pdf',message:'Metadata PDF object is no longer present'};
  const maxBytes=150*1024*1024;
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body.cancel();throw Error('PMC article PDF exceeds 150 MiB');}
  const chunks=[];let size=0;
  try{
    for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('PMC article PDF exceeds 150 MiB');chunks.push(chunk);}
  }catch(e){
    // fetch() resolves at headers. Its timeout can still fire while reading the
    // body; DOMException.code is numeric and is not a shared filesystem failure.
    if(['AbortError','TimeoutError','TypeError'].includes(e.name)||e.cause?.code)
      throw new Error(`PMC article PDF transfer failed (${e.cause?.code||e.name}); no retry`);
    throw e;
  }
  const bytes=Buffer.concat(chunks);
  if(hash(bytes,'md5')!==pdf.md5)throw Error('PMC PDF MD5 differs from metadata; nothing registered');
  const staged=path.join(directory,`download-${randomUUID()}.pdf`);
  fs.writeFileSync(staged,bytes,{flag:'wx'});
  try{
    const checked=validatePDF(staged,doi,undefined,undefined,current.title);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.copyFileSync(staged,output,fs.constants.COPYFILE_EXCL);
    const item=await registerWhenReady({doi,fulltext_path:output,fulltext_sha256:checked.sha256,
      fulltext_source:pdf.url,fulltext_access:'pmc-open-access',fulltext_license:m.license_code||null,
      fulltext_version:yes(m.is_manuscript)?'acceptedVersion':'publishedVersion',fulltext_identity:checked.identity||null,
      pmcid:m.pmcid,pmc_version:m.version},{directory,onRegistration,shouldStop});
    return {status:'available',reused:false,path:item.fulltext_path,pmcid:m.pmcid,pmc_version:m.version,
      source:pdf.url,license:m.license_code,version:item.fulltext_version,...checked};
  }finally{fs.unlinkSync(staged);}
}

export async function runPMCBatch({directory,targets_file,concurrency=3,max=20000}) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(max)||max<1)throw Error('Use concurrency 1..4 and positive max');
  const dir=path.resolve(directory),targets=input(targets_file);
  if(!Array.isArray(targets)||targets.some(p=>!p.doi)||new Set(targets.map(p=>p.doi)).size!==targets.length)
    throw Error('targets_file must contain unique registered DOI records');
  fs.mkdirSync(dir,{recursive:true});
  const stopFile=path.join(dir,'STOP'),lock=path.join(dir,'RUNNING'),log=path.join(dir,'attempts.jsonl'),mapFile=path.join(dir,'id-map.json');
  if(fs.existsSync(stopFile))throw Error('STOP exists; explicit resume must move it aside');
  if(fs.existsSync(lock)){
    const pid=Number(fs.readFileSync(lock,'utf8'));let alive=true;
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw Error('This PMC batch already has a running process');
    fs.renameSync(lock,lock+'.stale-'+Date.now());
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
  const state={pid:process.pid,started_at:new Date().toISOString(),status:'running',total:targets.length,completed:0,
    available:0,newly_acquired:0,counts:{},current:[],concurrency,provider:'PMC official cloud only'};
  let progressPending=false;
  const save=()=>{
    const dest=path.join(dir,'progress.json'),tmp=dest+'.tmp';
    const waiting=state.status==='running'&&state.current.some(p=>p.stage==='waiting_registration');
    try{
      fs.writeFileSync(tmp,JSON.stringify({...state,...(waiting?{status:'waiting_registration',stage:'waiting_registration'}:{}),updated_at:new Date().toISOString()},null,2)+'\n');fs.renameSync(tmp,dest);
    }catch(e){
      if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;
      // This file is a display snapshot, not the DOI completion journal. A reader
      // briefly holding it open must not abort an otherwise registered article.
      if(!progressPending)say(`WAIT progress snapshot ${e.code}; downloads and DOI journal continue; next state update will publish again`);
      progressPending=true;return false;
    }
    if(progressPending)say('RESUMED progress snapshot publication');
    progressPending=false;return true;
  };
  const say=line=>{const message=new Date().toISOString()+' '+line;console.log(message);fs.appendFileSync(path.join(dir,'progress.log'),message+'\n');};
  const count=result=>{state.completed++;state.counts[result.status]=(state.counts[result.status]||0)+1;if(result.status==='available'){state.available++;if(!result.reused)state.newly_acquired++;}};
  const stopped=()=>state.status!=='running'||fs.existsSync(stopFile);
  let idMap=fs.existsSync(mapFile)?input(mapFile):{};
  try{
    const prior=fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
    const seen=new Set(prior.map(r=>r.doi));for(const p of prior)count(p.result);
    const todo=targets.filter(p=>!seen.has(p.doi)).slice(0,max);
    say(`RESUME ${state.completed} completed; ${todo.length} selected; PMC only; no macro or publisher requests`);save();
    for(let offset=0;offset<todo.length&&!stopped();offset+=100){
      const group=todo.slice(offset,offset+100),missing=group.filter(p=>!Object.hasOwn(idMap,p.doi));
      if(missing.length){
        state.stage='converting_dois';save();
        Object.assign(idMap,await convertDOIs(missing.map(p=>p.doi)));
        fs.writeFileSync(mapFile,JSON.stringify(idMap,null,2)+'\n');
        await pause(350); // serial converter calls, below the NCBI unauthenticated request rate
      }
      let cursor=0;
      async function worker(lane){
        while(cursor<group.length&&!stopped()){
          const p=group[cursor++],at=new Date().toISOString();
          state.current.push({lane,doi:p.doi,stage:'fetching_pdf'});state.stage='fetching_pdf';save();
          let result;
          try{result=await acquirePMC(p,idMap[p.doi],{directory:dir,shouldStop:stopped,
            onRegistration:event=>{
              Object.assign(state.current.find(p=>p.lane===lane),event);save();
              if(event.stage==='waiting_registration')say(`WAIT registration ${p.doi}: ${event.registration_error}; verified PDF retained; no network retry`);
            }});}
          catch(e){
            if(e instanceof BatchStopped)return;
            const systemic=e instanceof ServiceError||typeof e.code==='string'||['parser_unavailable','parser_permission_denied'].includes(e.pdf_reason)||[3221225794,3221226505].includes(e.parser_exit_code);
            if(systemic){state.status='stopping';state.reason=e.message;save();throw e;}
            result={status:'failed',message:e.message,...(e.pdf_reason?{pdf_reason:e.pdf_reason}:{}),
              ...(Number.isInteger(e.parser_exit_code)?{parser_exit_code:e.parser_exit_code}:{})};
          }
          fs.appendFileSync(log,JSON.stringify({doi:p.doi,source:p.source,at,finished_at:new Date().toISOString(),result})+'\n');
          count(result);state.current=state.current.filter(p=>p.lane!==lane);save();
          say(`[${state.completed}/${state.total}] ${p.doi} ${result.status} | new ${state.newly_acquired}`);
        }
      }
      const results=await Promise.allSettled(Array.from({length:concurrency},(_,i)=>worker(i+1)));
      const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
    }
    state.status=fs.existsSync(stopFile)?'stopped':state.completed>=targets.length?'complete':'paused';
    if(state.status==='stopped')state.reason='Requested with STOP file';
  }catch(e){state.status='failed';state.reason=e.message;
    if(e.pdf_reason)state.pdf_reason=e.pdf_reason;
    if(Number.isInteger(e.parser_exit_code))state.parser_exit_code=e.parser_exit_code;
    say(`STOP ${e.message}`);}
  finally{
    state.finished_at=new Date().toISOString();
    // Publish the terminal snapshot after a transient reader releases it. STOP
    // can still end this local-only wait; no article/network request is retried.
    while(!save()&&!fs.existsSync(stopFile))await pause(250);
    fs.unlinkSync(lock);
  }
  return state;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const state=await runPMCBatch(input(process.argv[2]));console.log(JSON.stringify(state));
  if(state.status==='failed')process.exitCode=1;
}
