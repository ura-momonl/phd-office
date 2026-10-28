import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root, read, write } from '../automation/files.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';
import { buildDraft, approvalDigest, startPrepare, localStatus, queueAction, runWorker, directory } from './ece-workflow.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --procurement');

const baseline=read('procurement/catalog.json');
const quoteFile=path.join(root,'.runtime/fixture-quote.pdf');
fs.writeFileSync(quoteFile,'%PDF-1.4\nFictional fixture only\n');
const vendor=()=>({name:'Vendor Q',source:'fixture',quote_number:'F-Q1',currency:'USD',quoted_total:30.2,
  items:[{description:'Valve',part_number:'V1',quantity:2,unit_price:10,line_total:20},{description:'Adapter',part_number:'A1',quantity:1,unit_price:3,line_total:3},{description:'Pump',part_number:'P1',quantity:1,unit_price:4,line_total:4}],
  charges:{subtotal:27,shipping:0.5,tariff:2.7,tax:0},technical_match:'confirmed',shipping_included:true,tax_included:true});
const spec=id=>({request_id:id,vendor:'Vendor Q',first_name:'Ada',last_name:'Lovelace',email:'ada@example.org',phone:'(555) 123-4567',
  approver:'PI, Example',spend_category:'SC00083 Laboratory - Supplies',worktag:'GR000000001 - Fixture',business_purpose:'Sample-loading evacuation and venting in the fictional laboratory.',note_to_approver:'Please review fixture quotation F-Q1. Excludes the quoted tariff.',
  approved_cost:27.5,approved_cost_basis:'Items plus shipping, excluding tariff per fixture user decision.',quote_attachment:quoteFile,
  shipping:{street:'Example Street',room:'Room 1',city:'Madison',state:'Wisconsin',zip:'53706'},links:{V1:'https://example.org/valve'}});
function addRequest(id){const c=read('procurement/catalog.json');c.requests.push({id,title:'Fictional purchase',vendors:[vendor()]});write('procurement/catalog.json',c);}
function fakeSpawn(){const child=new EventEmitter();child.connected=true;child.disconnect=()=>{child.connected=false;};child.unref=()=>{};queueMicrotask(()=>child.emit('message',{boundary:true}));return child;}
function awaitReady(id,wanted='ready'){
  const dir=path.join(directory,id);
  return new Promise((resolve,reject)=>{
    const finish=(error,state)=>{clearTimeout(timer);watcher.close();error?reject(error):resolve(state);};
    const check=()=>{const state=localStatus(id);if(state.status===wanted)finish(null,state);else if(state.status==='stopped')finish(new Error(state.error));};
    const watcher=fs.watch(dir,(event,name)=>{if(name==='status.json')try{check();}catch(error){finish(error);}});
    const timer=setTimeout(()=>finish(new Error('Fixture worker did not reach ready')),20000);check();
  });
}

test('draft validation preserves explicit cost policy, source quote and attachment identity',()=>{
  const id='ece-business-fixture';addRequest(id);
  try {
    const d=buildDraft(spec(id));assert.equal(d.approved_cost,27.5);assert.equal(d.original_quote_total,30.2);
    assert.equal(d.attachment.size,fs.statSync(quoteFile).size);assert.equal(d.items.length,3);
    const moved=structuredClone(d);moved.attachment.path='another-location.pdf';assert.equal(approvalDigest(d),approvalDigest(moved));
    const changed=structuredClone(d);changed.worktag='Another project';assert.notEqual(approvalDigest(d),approvalDigest(changed));
    for(const patch of [{worktag:''},{approved_cost:null},{approved_cost_basis:''},{business_purpose:''},{quote_attachment:'missing.pdf'}])assert.throws(()=>buildDraft({...spec(id),...patch}));
  }finally{write('procurement/catalog.json',baseline);}
});

function formHTML(){
  const input=(id,name,value='',style='')=>`<input id="${id}" name="${name}" value="${value}" style="${style}">`;
  const select=(id,name,labels)=>`<select id="${id}" name="${name}">${labels.map(t=>`<option>${t}</option>`).join('')}</select>`;
  const placeholder='Spend Category (example: SC00083 Laboratory - Supplies)';
  return `<!doctype html><title>Fictional purchase form</title><form id="gform_2" action="/form" method="post">
  ${input('input_2_2_3','input_2.3')}${input('input_2_2_6','input_2.6')}${input('input_2_3','input_3','ada@example.org','display:none')}
  ${input('input_2_40','input_40')}${input('input_2_26','input_26')}${input('input_2_13','input_13')}${input('input_2_29','input_29')}
  <textarea id="input_2_14" name="input_14"></textarea>
  ${select('input_2_38','input_38',['Choose approver','PI, Example'])}
  <select id="input_2_27" name="input_27" style="display:none"><option>${placeholder}</option><option>SC00083 Laboratory - Supplies</option></select>
  <div id="input_2_27_chosen"><a class="chosen-single" href="#"><span>${placeholder}</span></a><div class="chosen-drop" style="display:none"><div class="chosen-search"><input></div><ul class="chosen-results"><li>${placeholder}</li><li>SC00083 Laboratory - Supplies</li></ul></div></div>
  ${select('input_2_6','input_6',['Choose account','GR000000001 - Fixture'])}${select('input_2_50','input_50',['N/A'])}
  ${input('input_2_39_1','input_39.1')}${input('input_2_39_2','input_39.2')}${input('input_2_39_3','input_39.3','Madison')}${select('input_2_39_4','input_39.4',['Wisconsin'])}${input('input_2_39_5','input_39.5','53706')}
  <label><input type="radio" name="input_21" value="Ground" checked>Ground</label>
  <div id="field_2_30"><textarea id="input_2_30" name="input_30" style="display:none"></textarea><iframe srcdoc="<body contenteditable='true'></body>"></iframe></div>
  <div id="field_2_11"><div id="items"><div class="row">${Array.from({length:5},()=>'<input name="input_11[]">').join('')}</div></div><button type="button" aria-label="Add another row">Add</button></div>
  <div id="field_2_41"><input type="file"></div><div id="gform_preview_2_41"></div><input type="hidden" id="uploaded-name" name="quote_filename">
  <button type="submit" id="gform_submit_button_2">Submit Purchase Request</button></form>
  <script>
  window.tinymce={triggerSave(){document.querySelector('#input_2_30').value=document.querySelector('iframe').contentDocument.body.innerHTML;}};
  document.querySelector('.chosen-single').onclick=e=>{e.preventDefault();document.querySelector('.chosen-drop').style.display='block';};
  document.querySelectorAll('.chosen-results li').forEach(li=>li.onclick=()=>{document.querySelector('#input_2_27').value=li.textContent;document.querySelector('.chosen-single span').textContent=li.textContent;document.querySelector('.chosen-drop').style.display='none';});
  document.querySelector('[aria-label="Add another row"]').onclick=()=>{const row=document.querySelector('.row').cloneNode(true);row.querySelectorAll('input').forEach(i=>i.value='');document.querySelector('#items').append(row);};
  document.querySelector('input[type=file]').onchange=async e=>{const file=e.target.files[0],data=new FormData();data.append('file',file);const response=await fetch('/upload',{method:'POST',body:data});const result=await response.json();if(result.status==='ok'){document.querySelector('#uploaded-name').value=file.name;const p=document.querySelector('#gform_preview_2_41');const name=document.createElement('span');name.className='gfield_fileupload_filename';name.textContent=file.name;p.append(name);const deletion=document.createElement('span');deletion.className='screen-reader-text';deletion.textContent='Delete this file: '+file.name;p.append(deletion);}};
  document.querySelector('#input_2_13').onblur=e=>{e.target.value='$'+Number(e.target.value.replace(/[^0-9.]/g,'')).toFixed(2);};
  document.querySelector('form').onsubmit=()=>window.tinymce.triggerSave();
  </script>`;
}

test('attended workflow crosses real browser, uploader, explicit approval, one POST and persisted request; no duplicate or changed-form submit',async()=>{
  let uploads=0,submits=0,mode='success';const rows=[],received=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      if(url.pathname==='/upload'){uploads++;res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',data:{uploaded_filename:'fixture-quote.pdf'}}));return;}
      if(url.pathname==='/form'){
        submits++;const data=new URLSearchParams(body.toString());received.push(data);
        if(mode==='validation'){res.end('<div class="gform_validation_errors">Fixture validation failure</div>');return;}
        const id=String(4700+rows.length+1);rows.push({id,vendor:data.get('input_26'),submitter:'ada'});
        res.end('<div id="gform_confirmation_message_2">Your purchase request was submitted for approval to PI, Example.</div>');return;
      }
    }
    res.setHeader('content-type','text/html');
    if(url.pathname==='/status'){res.end('<table>'+rows.map(row=>`<tr><td><a href="/status?lid=${row.id}">${row.id}</a></td><td>now</td><td>${row.submitter}</td><td>Purchase Approval</td><td>Pending</td><td>${row.vendor}</td></tr>`).join('')+'</table>');return;}
    res.end(formHTML());
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const site={origin:`http://127.0.0.1:${server.address().port}`,form:'/form',status:'/status'};
  const browser=await launchEdge();
  const create=async(id,options={})=>{
    addRequest(id);const started=await startPrepare(spec(id),{spawnProcess:fakeSpawn});
    let context;const ready=awaitReady(started.preparation_id);
    const worker=runWorker(started.preparation_id,{launch:async()=>({close:async()=>{}}),createContext:async()=>{context=await browser.newContext();return context;},auth:async()=>{},site,...options});
    return {id:started.preparation_id,state:await ready,worker,get page(){return context.pages()[0];},close:()=>context.close()};
  };
  try {
    const good=await create('ece-browser-success');
    assert.equal(uploads,1);assert.equal(submits,0);assert.equal(good.state.attachment.ui_verified,true);
    assert.throws(()=>queueAction(good.id,{action:'submit',approval_digest:good.state.approval_digest}),/approval/);
    assert.throws(()=>queueAction(good.id,{action:'submit',confirmed_by_user:true,confirmation_source:'fixture user',approval_digest:'old-preview'}),/preview/);
    const approval={action:'submit',confirmed_by_user:true,confirmation_source:'explicit fixture user approval',approval_digest:good.state.approval_digest};
    queueAction(good.id,approval);assert.throws(()=>queueAction(good.id,approval));await good.worker;
    assert.equal(submits,1);assert.equal(uploads,1);assert.equal(localStatus(good.id).status,'submitted');
    const purchase=read('procurement/catalog.json').requests.find(r=>r.id==='ece-browser-success').purchase_request;
    assert.equal(purchase.id,'4701');assert.equal(purchase.approved_cost,27.5);
    assert.equal(received[0].get('input_26'),'Vendor Q');assert.equal(received[0].get('input_13'),'$27.50');
    assert.equal(received[0].getAll('input_11[]').length,15);assert.equal(received[0].get('quote_filename'),'fixture-quote.pdf');
    assert.match(received[0].get('input_30'),/Please review fixture quotation/);
    assert.throws(()=>buildDraft(spec('ece-browser-success')),/already/);
    await good.close();

    const changed=await create('ece-browser-changed');
    await changed.page.locator('#input_2_26').fill('Unapproved vendor');
    queueAction(changed.id,{...approval,approval_digest:changed.state.approval_digest});await changed.worker;
    assert.equal(localStatus(changed.id).status,'stopped');assert.equal(submits,1);assert.equal(localStatus(changed.id).attempted,false);await changed.close();

    mode='validation';const invalid=await create('ece-browser-validation');
    queueAction(invalid.id,{...approval,approval_digest:invalid.state.approval_digest});await invalid.worker;
    assert.equal(localStatus(invalid.id).status,'unconfirmed');assert.equal(submits,2);assert.equal(rows.length,1);
    assert.throws(()=>queueAction(invalid.id,{...approval,approval_digest:invalid.state.approval_digest}),/not ready/);
    await assert.rejects(startPrepare(spec('ece-browser-validation'),{spawnProcess:fakeSpawn}),/EEXIST/);await invalid.close();

    const expired=await create('ece-browser-expired',{reviewMs:100});await expired.worker;
    assert.equal(localStatus(expired.id).status,'expired');assert.throws(()=>queueAction(expired.id,{...approval,approval_digest:expired.state.approval_digest}),/not ready/);await expired.close();
    assert.equal(submits,2);
  }finally{write('procurement/catalog.json',baseline);await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('worker start failure is surfaced, not left awaiting a nonexistent IPC message',async()=>{
  addRequest('ece-spawn-failure');
  try {
    await assert.rejects(startPrepare(spec('ece-spawn-failure'),{spawnProcess:()=>{const c=new EventEmitter();queueMicrotask(()=>c.emit('error',Object.assign(new Error('spawn EPERM'),{code:'EPERM'})));return c;}}),/EPERM/);
    assert.equal(fs.existsSync(path.join(directory,'locks/ece-spawn-failure.json')),false);
  }finally{write('procurement/catalog.json',baseline);}
});

test('detached IPC worker survives its launching CLI and accepts one later local command',async()=>{
  const id='ece-parent-exit';addRequest(id);
  const temp=path.join(root,'.runtime/ece-ipc-fixture');fs.mkdirSync(temp,{recursive:true});
  const moduleURL=pathToFileURL(path.join(root,'procurement/ece-workflow.mjs')).href;
  const child=path.join(temp,'child.mjs'),parent=path.join(temp,'parent.mjs');
  fs.writeFileSync(child,`import fs from 'node:fs';import path from 'node:path';import {directory} from ${JSON.stringify(moduleURL)};
const dir=path.join(directory,process.argv[2]);const state={status:'ready',worker_pid:process.pid,approval_digest:'fixture',expires_at:new Date(Date.now()+10000).toISOString()};
const save=()=>{fs.writeFileSync(path.join(dir,'status.tmp'),JSON.stringify(state));fs.renameSync(path.join(dir,'status.tmp'),path.join(dir,'status.json'));};
const timer=setTimeout(()=>process.exit(1),10000);const watcher=fs.watch(dir,(event,name)=>{if(event==='rename'&&name==='command.json'){state.status='closed';save();clearTimeout(timer);watcher.close();process.exit(0);}});save();process.send({boundary:true});`);
  fs.writeFileSync(parent,`import {spawn} from 'node:child_process';import {startPrepare} from ${JSON.stringify(moduleURL)};
const state=await startPrepare(${JSON.stringify(spec(id))},{spawnProcess:(exe,args,options)=>spawn(exe,[${JSON.stringify(child)},args[1]],options)});console.log(JSON.stringify(state));`);
  try {
    const state=JSON.parse(execFileSync(process.execPath,[parent],{cwd:root,encoding:'utf8',timeout:10000}));
    assert.equal(state.status,'ready');assert.equal(localStatus(state.preparation_id).live,true);
    const ended=awaitReady(state.preparation_id,'closed');queueAction(state.preparation_id,{action:'close'});await ended;
    assert.equal(localStatus(state.preparation_id).status,'closed');
  }finally{write('procurement/catalog.json',baseline);}
});
