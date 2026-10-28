// One attended ECE purchase request: prepare -> explicit approval -> submit once.
// No scheduler, model calls, arbitrary continuation scripts or password logging.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, read, write, input } from '../automation/files.mjs';
import { inspectQuote } from './run.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';
import { createLibraryContext, ensureLibraryAccess, saveLibrarySession, resetLoginBlock } from '../literature/auth.mjs';
import { ECE, fillAndUpload, readPrepared, expectedPage, requestRows, submitOnce } from './ece-page.mjs';
import assert from 'node:assert/strict';

export const directory=path.join(root,'.runtime/procurement/ece');
const json=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):fallback;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function atomic(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,file);
}
function sessionDir(id) {
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id))throw new Error('Invalid ECE preparation ID');
  return path.join(directory,id);
}
const lockFile=id=>path.join(directory,'locks',id+'.json');
function catalogRequest(id) {
  if(typeof id!=='string'||!/^[a-z0-9-]+$/.test(id))throw new Error('Invalid procurement request ID');
  const request=read('procurement/catalog.json').requests.find(r=>r.id===id);
  if(!request)throw new Error('Unknown procurement request');return request;
}
const requireText=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new Error('Missing '+name);return value.trim();};

export function buildDraft(spec,{defaults=json(path.join(directory,'defaults.local.json'),{})}={}) {
  const request=catalogRequest(spec.request_id);
  if(request.purchase_request)throw new Error('This procurement already has a submitted purchase request; track it instead of preparing a duplicate');
  const vendor=request.vendors.find(v=>v.name===spec.vendor);
  if(!vendor)throw new Error('Choose an existing vendor by exact name');
  const checked=inspectQuote(vendor);
  if(checked.errors.length)throw new Error(checked.errors.join('; '));
  if(vendor.currency!=='USD'||!vendor.items?.length||!vendor.quote_number)throw new Error('ECE preparation needs a numbered USD quote with item details');
  const draft={request_id:request.id,vendor:vendor.name,quote_number:vendor.quote_number,currency:'USD',original_quote_total:vendor.quoted_total};
  for(const key of ['first_name','last_name','email','phone'])draft[key]=requireText(spec[key]??defaults[key],key);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)||draft.phone.replace(/\D/g,'').length!==10)throw new Error('Valid email and ten-digit phone required');
  for(const key of ['approver','spend_category','worktag','business_purpose','note_to_approver','approved_cost_basis'])draft[key]=requireText(spec[key],key);
  draft.shipping={};
  for(const key of ['street','room','city','state','zip'])draft.shipping[key]=key==='room'?(spec.shipping?.[key]??defaults.shipping?.[key]??''):requireText(spec.shipping?.[key]??defaults.shipping?.[key],'shipping.'+key);
  draft.shipping_rate=spec.shipping_rate??'Ground';
  if(!['Ground','2nd Day Air','Overnight'].includes(draft.shipping_rate))throw new Error('Choose a supported shipping rate');
  if(!Number.isFinite(spec.approved_cost)||spec.approved_cost<=0)throw new Error('Explicit positive approved_cost required; tax/tariff policy is not inferred');
  draft.approved_cost=spec.approved_cost;
  if(Math.round(draft.approved_cost*100)/100!==draft.approved_cost)throw new Error('approved_cost must have at most two decimal places');
  draft.additional_information=spec.additional_information??'';
  draft.items=vendor.items.map(i=>({quantity:i.quantity,part_number:i.part_number,description:i.description,unit_price:i.unit_price,link:spec.links?.[i.part_number]??i.link??''}));
  for(const item of draft.items)if(item.link&&!['https:','http:'].includes(new URL(item.link).protocol))throw new Error('Item links must be HTTP(S)');
  const file=path.resolve(requireText(spec.quote_attachment,'quote_attachment'));
  const bytes=fs.readFileSync(file);
  if(!file.toLowerCase().endsWith('.pdf')||bytes.subarray(0,5).toString()!=='%PDF-'||bytes.length>25*1024*1024)throw new Error('Quote must be a PDF no larger than 25 MB');
  draft.attachment={path:file,filename:path.basename(file),size:bytes.length,sha256:hash(bytes)};
  return draft;
}

export function approvalDigest(draft) {
  return hash(JSON.stringify({fields:expectedPage(draft),quote_number:draft.quote_number,request_id:draft.request_id,approved_cost_basis:draft.approved_cost_basis,attachment:{filename:draft.attachment.filename,sha256:draft.attachment.sha256,size:draft.attachment.size}}));
}

export function localStatus(id) {
  const dir=sessionDir(id),state=json(path.join(dir,'status.json'));
  if(!state)throw new Error('Unknown ECE preparation');
  let live=null;
  if(state.worker_pid)try{process.kill(state.worker_pid,0);live=true;}catch(error){if(error.code==='ESRCH')live=false;}
  const {worker_pid,...publicState}=state;
  return {preparation_id:id,...publicState,live};
}

export function queueAction(id,command) {
  const state=localStatus(id),dir=sessionDir(id);
  if(state.status!=='ready'||state.live===false||Date.parse(state.expires_at)<=Date.now())throw new Error('Preparation is not ready; inspect ece-status. Never recreate or re-upload automatically.');
  if(command.action==='submit') {
    if(command.confirmed_by_user!==true||!command.confirmation_source?.trim())throw new Error('Actual explicit user approval and its source are required');
    if(command.approval_digest!==state.approval_digest)throw new Error('Approval does not match this exact preview');
  }else if(command.action!=='close')throw new Error('Unknown ECE action');
  const destination=path.join(dir,'command.json');
  // Exclusive reservation also prevents two simultaneous callers from triggering
  // a second command. A failure must be inspected, never silently requeued.
  fs.writeFileSync(path.join(dir,'command-claimed.json'),JSON.stringify(command)+'\n',{flag:'wx'});
  atomic(destination,command);return {preparation_id:id,action:command.action,queued:true};
}

export async function startPrepare(spec,{spawnProcess=spawn}={}) {
  const draft=buildDraft(spec),id=crypto.randomUUID(),dir=sessionDir(id),lock=lockFile(draft.request_id);
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  fs.writeFileSync(lock,JSON.stringify({preparation_id:id,created_at:new Date().toISOString()})+'\n',{flag:'wx'});
  fs.mkdirSync(dir,{recursive:true});atomic(path.join(dir,'draft.json'),draft);
  atomic(path.join(dir,'status.json'),{status:'starting',request_id:draft.request_id});
  let child,log;
  try {
    log=fs.openSync(path.join(dir,'worker.log'),'a');
    child=spawnProcess(process.execPath,[fileURLToPath(new URL('./ece-worker.mjs',import.meta.url)),id],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log,'ipc']});
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const fail=error=>{if(settled)return;settled=true;atomic(path.join(dir,'status.json'),{status:'stopped',error:error.message,request_id:draft.request_id});if(fs.existsSync(lock))fs.unlinkSync(lock);reject(error);};
      child.once('error',fail);
      child.once('exit',code=>{if(!settled)fail(new Error('ECE worker exited before reporting a boundary: '+code));});
      child.once('message',()=>{if(settled)return;settled=true;const state=localStatus(id);child.disconnect();child.unref();resolve(state);});
    });
  }catch(error){if(fs.existsSync(lock))fs.unlinkSync(lock);throw error;}
  finally{if(log!=null)fs.closeSync(log);}
}

async function authenticate(page,target,notify) {
  if(new URL(page.url()).origin==='https://login.wisc.edu')await page.locator('#j_password').waitFor({state:'visible',timeout:15000});
  const result=await ensureLibraryAccess(page,target,{interactive:false});
  if(result.status==='ready')return;
  if(!new URL(page.url()).hostname.endsWith('.duosecurity.com'))throw new Error(result.message);
  notify({status:'needs_duo',message:'Complete Duo in the independent Edge window; waiting up to eight minutes. NetID already passed.'});
  await page.waitForURL(url=>url.origin===ECE.origin,{timeout:480000,waitUntil:'domcontentloaded'});
  resetLoginBlock();
}

function waitCommand(dir,timeout) {
  return new Promise(resolve=>{
    const file=path.join(dir,'command.json');
    const finish=value=>{clearTimeout(timer);watcher.close();resolve(value);};
    const watcher=fs.watch(dir,(event,name)=>{if(event==='rename'&&name==='command.json'&&fs.existsSync(file))finish(json(file));});
    const timer=setTimeout(()=>finish({action:'expire'}),timeout);
    if(fs.existsSync(file))finish(json(file));
  });
}

function recordSubmitted(draft,row,evidence) {
  const catalog=read('procurement/catalog.json'),request=catalog.requests.find(r=>r.id===draft.request_id);
  if(!request)throw new Error('Procurement disappeared after submission; preserve receipt and do not resubmit');
  if(request.purchase_request&&request.purchase_request.id!==row.id)throw new Error('Existing purchase request differs; preserve both receipts for review');
  request.purchase_request={id:row.id,url:row.url,submitted_at:new Date().toISOString(),approver:draft.approver,approved_cost:draft.approved_cost,currency:'USD',source_quote_number:draft.quote_number,evidence};
  write('procurement/catalog.json',catalog);
}

export async function runWorker(id,{launch=launchEdge,createContext=createLibraryContext,auth=authenticate,site=ECE,reviewMs=30*60*1000}={}) {
  const dir=sessionDir(id),draft=json(path.join(dir,'draft.json')),lock=lockFile(draft.request_id);
  let browser,boundarySent=false;
  const status=value=>{
    atomic(path.join(dir,'status.json'),{updated_at:new Date().toISOString(),request_id:draft.request_id,worker_pid:process.pid,...value});
    if(!boundarySent&&['needs_duo','ready','stopped'].includes(value.status)){
      boundarySent=true;if(process.connected)process.send({boundary:true});
    }
  };
  try {
    if(catalogRequest(draft.request_id).purchase_request)throw new Error('This procurement was already submitted');
    browser=await launch({headless:false});const context=await createContext(browser),page=await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(site.origin+site.form,{waitUntil:'domcontentloaded',timeout:30000});
    await auth(page,site.origin+site.form,status);
    // During preparation only, prevent unintended final form navigation. The
    // user's own manual click is not blocked once the ready page is presented.
    const guard=async route=>{
      const request=route.request();
      if(request.method()==='POST'&&request.isNavigationRequest())await route.abort('blockedbyclient');else await route.continue();
    };
    await context.route(site.origin+'/**',guard);
    if(hash(fs.readFileSync(draft.attachment.path))!==draft.attachment.sha256)throw new Error('Quote file changed before upload');
    const prepared=await fillAndUpload(page,draft,{
      onUploading:()=>{fs.writeFileSync(path.join(dir,'upload-attempt.json'),JSON.stringify({at:new Date().toISOString(),filename:draft.attachment.filename})+'\n',{flag:'wx'});status({status:'uploading',message:'One upload attempt; no automatic retry.'});},
      onUploadAccepted:value=>atomic(path.join(dir,'upload-accepted.json'),value)
    });
    atomic(path.join(dir,'prepared.json'),prepared);
    await page.screenshot({path:path.join(dir,'preview.png'),fullPage:true});
    await saveLibrarySession(context);
    const digest=approvalDigest(draft);
    // Install the event-based listener before announcing ready to the caller.
    const command=waitCommand(dir,reviewMs);
    await context.unroute(site.origin+'/**',guard);
    status({status:'ready',approval_digest:digest,vendor:draft.vendor,quote_number:draft.quote_number,approved_cost:draft.approved_cost,approved_cost_basis:draft.approved_cost_basis,approver:draft.approver,preview:path.join(dir,'preview.png'),attachment:prepared.attachment,expires_at:new Date(Date.now()+reviewMs).toISOString(),message:'Live page and temporary attachment retained; NOT submitted. Explicit final approval is required.'});
    const action=await command;
    if(action.action!=='submit'){status({status:action.action==='close'?'closed':'expired',submitted:false});return;}
    if(action.confirmed_by_user!==true||action.approval_digest!==digest||!action.confirmation_source?.trim())throw new Error('Invalid final approval');
    if(catalogRequest(draft.request_id).purchase_request)throw new Error('Another actor already recorded a submitted purchase request');
    assert.deepEqual(await readPrepared(page),expectedPage(draft),'Reviewed page changed');
    const tracking=await context.newPage();
    const before=await requestRows(tracking,site),beforeIDs=new Set(before.map(row=>row.id));
    await page.bringToFront();
    status({status:'submitting',approval_digest:digest});
    const receipt=await submitOnce(page,draft,{site,onAttempt:()=>fs.writeFileSync(path.join(dir,'submit-attempt.json'),JSON.stringify({at:new Date().toISOString(),approval:action,digest})+'\n',{flag:'wx'})});
    atomic(path.join(dir,'receipt.json'),receipt);
    await page.screenshot({path:path.join(dir,'receipt.png'),fullPage:true});
    if(!receipt.confirmed){status({status:'unconfirmed',receipt:path.join(dir,'receipt.json'),message:'One click only. Check persisted requests before any further action.'});return;}
    const after=await requestRows(tracking,site);
    const candidates=after.filter(row=>!beforeIDs.has(row.id)&&row.vendor===draft.vendor&&row.submitter===draft.email.split('@')[0]);
    receipt.new_records=candidates;atomic(path.join(dir,'receipt.json'),receipt);
    if(candidates.length!==1){status({status:'unconfirmed',confirmation:receipt.confirmation,message:'Page confirmed submission, but a unique persisted request was not identified. Do not resubmit.'});return;}
    recordSubmitted(draft,candidates[0],path.join(dir,'receipt.json'));
    status({status:'submitted',purchase_request:candidates[0],approved_cost:draft.approved_cost,confirmation:receipt.confirmation,receipt:path.join(dir,'receipt.json'),message:'Submitted for approval, not a vendor order or payment.'});
  }catch(error){status({status:'stopped',error:error.message,attempted:fs.existsSync(path.join(dir,'submit-attempt.json')),message:'No automatic retry; inspect this preparation before repeating any external effect.'});}
  finally {
    if(browser)await browser.close();
    const final=json(path.join(dir,'status.json'));
    if(!fs.existsSync(path.join(dir,'submit-attempt.json'))||final.status==='submitted'){
      if(json(lock)?.preparation_id===id)fs.unlinkSync(lock);
    }
  }
}

export async function trackRequest(requestID,{launch=launchEdge}={}) {
  const request=catalogRequest(requestID),record=request.purchase_request;
  if(!record)throw new Error('No submitted purchase request recorded');
  let browser;
  try {
    browser=await launch({headless:false});const context=await createLibraryContext(browser),page=await context.newPage();
    await page.goto(ECE.origin+ECE.status,{waitUntil:'domcontentloaded',timeout:30000});
    await authenticate(page,ECE.origin+ECE.status,value=>console.error(JSON.stringify(value)));
    const rows=await requestRows(page),row=rows.find(row=>row.id===record.id);
    if(!row)throw new Error('Recorded request not visible in current status page; no status change inferred');
    return {request_id:requestID,purchase_request:row,observed_at:new Date().toISOString(),note:'Read-only observation; approval and vendor ordering are separate.'};
  }finally{if(browser)await browser.close();}
}

export async function runECE(action,argument) {
  if(action==='ece-prepare')return startPrepare(input(argument));
  if(action==='ece-status')return localStatus(argument);
  if(action==='ece-submit'){const approval=input(argument);return queueAction(approval.preparation_id,{...approval,action:'submit'});}
  if(action==='ece-close')return queueAction(argument,{action:'close'});
  if(action==='ece-track')return trackRequest(argument);
  throw new Error('Unknown ECE procurement action');
}
