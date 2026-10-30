// Explicit Wiley TDM access. No article pages, browser, institutional proxy or retries.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root,read} from '../automation/files.mjs';
import {normalizeDOI,record} from './run.mjs';
import {validatePDF} from './fetch.mjs';
import {retryAfterMs} from './fetch-backoff.mjs';

export const WILEY_INTERVAL_MS=12000;
const endpoint=doi=>'https://api.wiley.com/onlinelibrary/tdm/v1/articles/'+encodeURIComponent(doi);
const hash=value=>createHash('sha256').update(value).digest('hex');
export const isWileyDOI=doi=>/^10\.(1002|1111)\//i.test(doi||'');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class WileyStopped extends Error {}

// One serial API lane owns the persisted start-to-start interval, across resumes.
export class WileyTDM {
  constructor({directory,token,intervalMs=WILEY_INTERVAL_MS,shouldStop=()=>false,onRequest=()=>{},transport=fetch,now=Date.now,sleep=pause}){
    if(!token)throw Error('Wiley TDM token is not configured');
    if(intervalMs<WILEY_INTERVAL_MS)throw Error('Wiley API interval must be at least 12 seconds');
    Object.assign(this,{directory,token,intervalMs,shouldStop,onRequest,transport,now,sleep});
    this.file=path.join(directory,'wiley-pace.json');
    this.next=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')).next_api_at||0:0;
    this.active=false;
  }
  defer(deadline){this.next=Math.max(this.next,deadline);fs.writeFileSync(this.file,JSON.stringify({next_api_at:this.next,interval_ms:this.intervalMs})+'\n');}
  async wait(){
    while(this.next>this.now()){
      if(this.shouldStop())throw new WileyStopped('User requested STOP');
      await this.sleep(Math.min(250,this.next-this.now()));
    }
    if(this.shouldStop())throw new WileyStopped('User requested STOP');
  }
  async pdf(value){
    const doi=normalizeDOI(value);
    if(!isWileyDOI(doi))return {error:{status:'skipped',message:'DOI is outside the explicitly selected Wiley prefixes'}};
    if(this.active)throw Error('Wiley TDM uses one serial lane');
    this.active=true;
    try{
      await this.wait();
      this.defer(this.now()+this.intervalMs);
      const url=endpoint(doi);
      this.onRequest({doi,host:'api.wiley.com',service:'Wiley TDM API',at:new Date(this.now()).toISOString()});
      let response=await this.transport(url,{headers:{'Wiley-TDM-Client-Token':this.token,Accept:'application/pdf'},redirect:'manual',signal:AbortSignal.timeout(60000)});
      if(response.status===302){
        const location=response.headers.get('location');
        await response.body?.cancel();
        let target;try{target=new URL(location);}catch{}
        if(!target||target.protocol!=='https:'||target.hostname!=='alm.wiley.com'||target.port||target.username||target.password)
          return {error:{status:'needs_attention',message:'Wiley API redirect is outside the verified official binary service; not followed'}};
        // Never forward the client token to the binary service or log its signed URL.
        this.onRequest({doi,host:target.hostname,service:'Wiley TDM binary',at:new Date(this.now()).toISOString()});
        response=await this.transport(target.href,{headers:{Accept:'application/pdf'},redirect:'manual',signal:AbortSignal.timeout(60000)});
      }
      if(!response.ok){
        const code=response.status;
        if(code===429)this.defer(this.now()+retryAfterMs(response.headers));
        await response.body?.cancel();
        return {error:{status:code===429?'rate_limited':[401,403].includes(code)?'access_denied':code===404?'not_accessible':'failed',
          http_status:code,message:`Wiley TDM returned HTTP ${code}; this article is not retried`,
          ...([401,403].includes(code)?{stop_api:true}:{}),...(code===429?{next_api_at:this.next}:{})}};
      }
      if(!/application\/pdf/i.test(response.headers.get('content-type')||'')){
        await response.body?.cancel();return {error:{status:'needs_attention',message:'Wiley TDM did not return a PDF; no article page or login followed'}};
      }
      const limit=150*1024*1024;
      if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();return {error:{status:'failed',message:'Wiley PDF exceeds 150 MiB'}};}
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit)throw Error('PDF exceeds size limit');chunks.push(chunk);}
      return {bytes:Buffer.concat(chunks),source:endpoint(doi)};
    }catch(e){
      if(e instanceof WileyStopped)throw e;
      return {error:{status:'failed',message:`Wiley API transfer failed (${e.cause?.code||e.name}); no retry`}};
    }finally{this.active=false;}
  }
}

export async function acquireWiley(value,client,{directory}){
  const doi=normalizeDOI(value),previous=read('literature/catalog.json').papers.find(p=>p.doi===doi);
  if(!previous||previous.library_status&&previous.library_status!=='active')return {status:'skipped',message:'Article is no longer active'};
  const output=path.join(root,'literature/fulltext','doi-'+hash(doi).slice(0,16)+'.pdf');
  const pending=path.join(directory,'wiley-pending-registration',hash(doi)+'.json');
  let staged,stage='download';
  try{
    if(previous.fulltext_path&&fs.existsSync(previous.fulltext_path)){
      stage='validate';const checked=validatePDF(previous.fulltext_path,doi,previous.fulltext_sha256,previous.fulltext_identity,previous.title);
      return {status:'available',reused:true,path:previous.fulltext_path,...checked};
    }
    if(fs.existsSync(output)&&!fs.existsSync(pending))return {status:'needs_attention',message:'Unregistered local PDF belongs to an earlier route; preserved without relabelling it as Wiley API output'};
    const receipt=fs.existsSync(pending)?JSON.parse(fs.readFileSync(pending,'utf8')).update:null;
    if(receipt&&(receipt.doi!==doi||path.resolve(receipt.fulltext_path)!==output||!receipt.fulltext_sha256))
      return {status:'needs_attention',message:'Wiley pending registration does not match the local PDF; not changed'};
    // Recover a verified local file left by a registration error without downloading again.
    if(!fs.existsSync(output)){
      const downloaded=await client.pdf(doi);if(downloaded.error)return downloaded.error;
      staged=path.join(directory,'wiley-download-'+randomUUID()+'.pdf');
      fs.writeFileSync(staged,downloaded.bytes,{flag:'wx'});
      stage='validate';validatePDF(staged,doi,undefined,undefined,previous.title);
      // Another lane may have completed this DOI while the network request was in flight.
      stage='store';fs.mkdirSync(path.dirname(output),{recursive:true});
      if(!fs.existsSync(output))fs.copyFileSync(staged,output,fs.constants.COPYFILE_EXCL);
    }
    stage='validate';const checked=validatePDF(output,doi,previous.fulltext_sha256||receipt?.fulltext_sha256,previous.fulltext_identity||receipt?.fulltext_identity,previous.title);
    const update={doi,fulltext_path:output,fulltext_sha256:checked.sha256,fulltext_identity:checked.identity||null,
      fulltext_source:endpoint(doi),fulltext_access:'wiley-tdm',fulltext_version:'publishedVersion',fulltext_license:null};
    stage='register';fs.mkdirSync(path.dirname(pending),{recursive:true});
    fs.writeFileSync(pending,JSON.stringify({update},null,2)+'\n');
    const item=record(update);fs.unlinkSync(pending);
    return {status:'available',reused:false,path:item.fulltext_path,access_route:'wiley-tdm',...checked};
  }catch(e){
    if(e instanceof WileyStopped)throw e;
    return {status:stage==='validate'?'validation_failed':'failed',stage,
      message:stage==='validate'?e.message:`Wiley ${stage} failed (${e.code||e.name}); article skipped; verified local files retained`,
      ...(e.pdf_reason?{pdf_reason:e.pdf_reason}:{}),...(Number.isInteger(e.parser_exit_code)?{parser_exit_code:e.parser_exit_code}:{})};
  }finally{if(staged&&fs.existsSync(staged))fs.unlinkSync(staged);}
}

const rows=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
export async function runWileyQueue({directory,shouldStop=()=>false,onProgress=()=>{},onRequest=()=>{},withDOI=async(doi,fn)=>fn()}){
  const targetsFile=path.join(directory,'wiley-targets.json'),attemptsFile=path.join(directory,'wiley-attempts.jsonl');
  if(!fs.existsSync(targetsFile)){
    const targets=read('literature/catalog.json').papers.filter(p=>(!p.library_status||p.library_status==='active')&&isWileyDOI(p.doi)
      &&(!p.fulltext_path||!fs.existsSync(p.fulltext_path))).map(p=>({doi:p.doi,title:p.title,source:p.source}));
    fs.writeFileSync(targetsFile,JSON.stringify(targets,null,2)+'\n',{flag:'wx'});
  }
  const targets=JSON.parse(fs.readFileSync(targetsFile,'utf8')),prior=rows(attemptsFile),done=new Set(prior.map(p=>p.doi));
  const state={status:'running',total:targets.length,completed:0,newly_acquired:0,available:0,counts:{},current:null,interval_ms:WILEY_INTERVAL_MS,scope:'All active Wiley papers lacking full text, including non-OA'};
  const notify=()=>onProgress({...state,counts:{...state.counts}});
  const count=r=>{state.completed++;state.counts[r.status]=(state.counts[r.status]||0)+1;if(r.status==='available'){state.available++;if(!r.reused)state.newly_acquired++;}};
  for(const r of prior)count(r.result);
  if(state.completed>=state.total){state.status='complete';notify();return state;}
  const credentialFile=path.join(root,'.runtime/literature/wiley.credentials.local.json');
  const token=process.env.WILEY_TDM_TOKEN||(fs.existsSync(credentialFile)?JSON.parse(fs.readFileSync(credentialFile,'utf8')).api_token:null);
  if(!token){state.status='blocked';state.reason='Wiley API token is missing';notify();return state;}
  const networkFile=path.join(directory,'wiley-network-requests.jsonl');
  const issued=new Set(rows(networkFile).filter(r=>r.service==='Wiley TDM API').map(r=>r.doi));
  const client=new WileyTDM({directory,token,shouldStop,onRequest:event=>{
    fs.appendFileSync(networkFile,JSON.stringify(event)+'\n');issued.add(event.doi);onRequest(event);
  }});
  notify();
  for(const p of targets){
    if(shouldStop())break;if(done.has(p.doi))continue;
    state.current={doi:p.doi,stage:'paced_api_or_local_cache'};notify();
    let result;
    try{
      result=await withDOI(p.doi,async()=>{
        if(shouldStop())throw new WileyStopped('User requested STOP');
        const current=read('literature/catalog.json').papers.find(r=>r.doi===p.doi);
        if(issued.has(p.doi)&&!current?.fulltext_path&&!fs.existsSync(path.join(directory,'wiley-pending-registration',hash(p.doi)+'.json')))
          return {status:'needs_attention',message:'Earlier API request has no terminal receipt; not automatically repeated'};
        return acquireWiley(p.doi,client,{directory});
      });
    }catch(e){
      if(e instanceof WileyStopped||shouldStop())break;
      result={status:'failed',message:`Wiley article failed (${e.code||e.name}); skipped without retry`};
    }
    if(result?.status==='stopped')break;
    fs.appendFileSync(attemptsFile,JSON.stringify({doi:p.doi,at:new Date().toISOString(),result})+'\n');
    done.add(p.doi);count(result);state.current=null;state.next_api_at=client.next;notify();
    if(result.stop_api){state.status='blocked';state.reason='Wiley API denied access; API lane stopped without retry, repository workers unaffected';break;}
  }
  state.current=null;if(state.status!=='blocked')state.status=shouldStop()?'stopped':'complete';notify();return state;
}
