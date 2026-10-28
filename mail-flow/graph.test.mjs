import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {graphLoginStatus,startGraphLogin} from './graph-login.mjs';
import {prependReply,sendNativeReply,GraphSession} from './graph.mjs';
import {calendarEventBody,createCalendarEvent,eventPath,verifyCalendarEvent} from './calendar-native.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --mail');
const quote='<html><head></head><body dir="ltr"><hr><div id="divRplyFwdMsg">From: original</div><div>Original &amp; full history.</div></body></html>';
const original={contentType:'html',content:quote};
const args={message_id:'original/opaque=',text_content:'Hello <sample> & "name" it\'s\n\nThanks.',to:[{email:'self@example.org'}],cc:[],bcc:[]};
const recipient=email=>({emailAddress:{address:email}});
function fixture(fault) {
  const calls=[];let persisted,sent=false;
  return {calls,async request(method,url,body,headers){
    calls.push({method,url,body:structuredClone(body),headers});
    if(url.endsWith('/createReply')||url.endsWith('/createReplyAll'))return {id:'draft/immutable=',isDraft:true,body:original,toRecipients:[recipient('original@example.org')],ccRecipients:[recipient('oldcc@example.org')],bccRecipients:[]};
    if(method==='PATCH'){persisted={id:'draft/immutable=',isDraft:true,...structuredClone(body)};return persisted;}
    if(method==='POST'&&url.endsWith('/send')){if(fault==='send-timeout')throw new Error('send timeout');sent=true;return null;}
    if(method==='GET'){
      if(sent&&fault==='readback')throw new Error('sent copy not yet available');
      const result=structuredClone(persisted);result.isDraft=!sent;
      if(!sent&&fault==='body')result.body.content+='changed';
      if(!sent&&fault==='recipient')result.ccRecipients=[recipient('unexpected@example.org')];
      return result;
    }
    throw new Error('unexpected request');
  }};
}
test('new text is escaped with paragraph breaks; native HTML quote is not reformatted or duplicated',()=>{
  const body=prependReply(original,args.text_content);
  assert.equal(body.content,quote.replace('<body dir="ltr">','<body dir="ltr"><div>Hello &lt;sample&gt; &amp; "name" it\'s<br><br>Thanks.</div><br>'));
  assert.equal(body.content.split('divRplyFwdMsg').length,2);
  for(const invalid of [{contentType:'text',content:'plain'}, {contentType:'html',content:'connector converted text'}])assert.throws(()=>prependReply(invalid,'reply'),/native HTML/);
});
test('native reply creates a reply draft, verifies persisted body and exact audience, sends once, then reads the immutable sent copy',async()=>{
  const graph=fixture(),drafts=[];const result=await sendNativeReply(graph,args,id=>drafts.push(id));
  assert.deepEqual(drafts,['draft/immutable=']);
  assert.deepEqual(graph.calls.map(c=>c.method),['POST','PATCH','GET','POST','GET']);
  assert.equal(graph.calls[0].url,'/me/messages/original%2Fopaque%3D/createReply');
  assert.equal(graph.calls[3].url,'/me/messages/draft%2Fimmutable%3D/send');
  assert.deepEqual(graph.calls[1].body.toRecipients,[recipient('self@example.org')]);
  assert.deepEqual(graph.calls[1].body.ccRecipients,[]);
  assert.ok(graph.calls.every(c=>c.headers.Prefer.includes('ImmutableId')));
  assert.equal(result.structuredContent.verification.status,'returned');
  assert.equal(result.structuredContent.verification.message.isDraft,false);
});
test('body or audience mismatch never reaches send; unknown send is never retried',async()=>{
  for(const fault of ['body','recipient','send-timeout']){
    const graph=fixture(fault);await assert.rejects(sendNativeReply(graph,args));
    assert.equal(graph.calls.filter(c=>c.url.endsWith('/send')).length,fault==='send-timeout'?1:0);
  }
});
test('successful send is preserved when the sent copy is not available yet',async()=>{
  const graph=fixture('readback'),result=await sendNativeReply(graph,args);
  assert.equal(result.structuredContent.status,'send_accepted');
  assert.equal(result.structuredContent.verification.status,'error');
  assert.equal(result.structuredContent.verification.no_automatic_retry,true);
  assert.equal(graph.calls.filter(c=>c.url.endsWith('/send')).length,1);
});
test('malformed final parameters cannot create a mailbox draft',async()=>{
  for(const bad of [{text_content:''},{message_id:null},{to:'self@example.org'},{cc:[{email:'bad\naddress'}]},{reply_all:'true'}]){
    const graph=fixture();await assert.rejects(sendNativeReply(graph,{...args,...bad}));assert.equal(graph.calls.length,0);
  }
});
test('real Graph authentication is disabled in isolated tests',async()=>{
  const graph=new GraphSession('unused','fixture@example.org');await assert.rejects(graph.start(),/disabled in isolated tests/);
});

test('login worker outlives its launching CLI; durable success survives parent exit and status never restarts login',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graph-login-lifetime-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^graph-login-lifetime-/);fs.rmSync(root,{recursive:true,force:true});});
  const helper=path.join(root,'fake-login.mjs'),parent=path.join(root,'fake-parent.mjs');
  fs.writeFileSync(helper,`import fs from 'node:fs';const file=process.argv[2];fs.writeFileSync(file,JSON.stringify({state:'starting'}));console.log('To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code FAKECODE123 to authenticate.');setTimeout(()=>fs.writeFileSync(file,JSON.stringify({state:'authenticated',account:'fixture@example.org'})),1200);`);
  fs.writeFileSync(parent,`import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {startGraphLogin} from ${JSON.stringify(pathToFileURL(path.resolve('mail-flow/graph-login.mjs')).href)};const result=await startGraphLogin(${JSON.stringify(root)},'fixture@example.org',{launch:async(root,account,folder)=>{const output=fs.openSync(path.join(folder,'output.txt'),'wx');const child=spawn(process.execPath,[${JSON.stringify(helper)},path.join(folder,'status.json')],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',output,'ignore']});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});fs.closeSync(output);child.unref();return child.pid;}});console.log(JSON.stringify(result));`);
  const launched=spawnSync(process.execPath,[parent],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(launched.status,0,launched.stderr);
  const first=JSON.parse(launched.stdout.trim());
  assert.equal(first.state,'waiting_for_user');assert.equal(first.user_code,'FAKECODE123');
  const same=await startGraphLogin(root,'fixture@example.org',{launch:()=>assert.fail('Must reuse the active worker')});
  assert.equal(same.id,first.id);
  await new Promise(resolve=>setTimeout(resolve,1500));
  const done=graphLoginStatus(root);assert.equal(done.state,'authenticated');assert.equal(done.id,first.id);assert.equal(done.user_code,undefined);
  assert.equal((await startGraphLogin(root,'fixture@example.org',{launch:()=>assert.fail('Must reuse authenticated result')})).id,done.id);
});
test('no durable login record means not started, never a claimed success',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graph-login-status-'));
  try{assert.deepEqual(graphLoginStatus(root),{state:'not_started'});}finally{fs.rmdirSync(root);}
});

const meeting={subject:'Fixture RRA',text_content:'Preview only.\nNo committee invitations.',location:'Fixture Room',
  start_utc:'2026-10-29T15:30:00Z',end_utc:'2026-10-29T17:00:00Z',attendees:[{email:'preview@example.org'}]};
function calendarFixture(fault) {
  const calls=[];let saved;
  return {calls,status:{scopes:fault==='permission'?[]:['Calendars.ReadWrite']},async request(method,url,body){
    calls.push({method,url,body:structuredClone(body)});
    if(method==='POST'){
      if(fault==='timeout')throw new Error('unknown create outcome');
      saved={...structuredClone(body),id:'meeting/opaque=',isOrganizer:true,isCancelled:false};return saved;
    }
    if(fault==='readback')throw new Error('readback unavailable');
    const event=structuredClone(saved);event.start.dateTime+='.0000000';event.end.dateTime+='.0000000';
    event.attendees.reverse();event.body.content=event.body.content.replace(/\n/g,'\r\n');
    if(fault==='audience')event.attendees.push({emailAddress:{address:'unapproved@example.org'},type:'required'});
    if(fault==='time')event.start.dateTime='2026-10-29T16:00:00';
    return event;
  }};
}
test('calendar creates one real meeting with the explicit attendee, UTC instant and responses; no attachment/send endpoint',async()=>{
  const g=calendarFixture(),out=await createCalendarEvent(g,meeting,'transaction-fixture');
  assert.deepEqual(g.calls.map(c=>[c.method,c.url]),[['POST','/me/events'],['GET','/me/events/meeting%2Fopaque%3D']]);
  const body=g.calls[0].body;
  assert.equal(body.responseRequested,true);assert.equal(body.isOnlineMeeting,false);
  assert.equal(body.transactionId,'transaction-fixture');
  assert.deepEqual(body.attendees,[{emailAddress:{address:'preview@example.org'},type:'required'}]);
  assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(meeting.start_utc)),'10:30');
  assert.equal((Date.parse(meeting.end_utc)-Date.parse(meeting.start_utc))/60000,90);
  assert.equal(out.structuredContent.verification.status,'verified');
});
test('calendar malformed or unconsented parameters cannot reach create; readback problems never trigger resend',async()=>{
  for(const bad of [{attendees:[]},{attendees:[{email:'bad\naddress'}]},{attendees:[{email:'a@example.org'},{email:'A@example.org'}]},
    {start_utc:'2026-10-29T10:30:00'},{start_utc:'2026-02-30T10:30:00Z'},{end_utc:meeting.start_utc},{subject:''}]) {
    const g=calendarFixture();await assert.rejects(createCalendarEvent(g,{...meeting,...bad},'t'));assert.equal(g.calls.length,0);
  }
  const noPermission=calendarFixture('permission');await assert.rejects(createCalendarEvent(noPermission,meeting,'t'),/permission missing/);assert.equal(noPermission.calls.length,0);
  for(const fault of ['audience','time','readback']){
    const g=calendarFixture(fault),r=await createCalendarEvent(g,meeting,'t');
    assert.equal(r.structuredContent.id,'meeting/opaque=');
    assert.equal(r.structuredContent.verification.status,fault==='readback'?'error':'mismatch');
    assert.equal(g.calls.filter(c=>c.method==='POST').length,1);
  }
  const timedOut=calendarFixture('timeout');await assert.rejects(createCalendarEvent(timedOut,meeting,'t'));assert.equal(timedOut.calls.length,1);
  assert.throws(()=>eventPath(''),/event_id/);
  for(const bad of ['..','../messages','https://example.org/id','%2e%2e'])assert.throws(()=>eventPath(bad),/opaque Graph ID/);
  assert.equal(calendarEventBody(meeting,'t').start.timeZone,'UTC');
});
test('calendar consent extends an existing mail login only on explicit calendar request; granted login is reused',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graph-calendar-consent-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^graph-calendar-consent-/);fs.rmSync(root,{recursive:true,force:true});});
  let launches=0;
  const launch=async(root,account,folder,{calendar})=>{launches++;fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({state:'authenticated',account,scopes:['Mail.Send',...(calendar?['Calendars.ReadWrite']:[])]}));return process.pid;};
  const mail=await startGraphLogin(root,'fixture@example.org',{launch});assert.equal(launches,1);
  assert.equal((await startGraphLogin(root,'fixture@example.org',{launch})).id,mail.id);assert.equal(launches,1);
  const calendar=await startGraphLogin(root,'fixture@example.org',{launch,calendar:true});assert.notEqual(calendar.id,mail.id);assert.equal(launches,2);
  assert.equal((await startGraphLogin(root,'fixture@example.org',{launch,calendar:true})).id,calendar.id);assert.equal(launches,2);
});

test('Exchange Text-to-HTML conversion verifies the full meeting body, without masking changed text or unapproved attendees',()=>{
  const args={...meeting,text_content:'Preview <sample> & check.\nNo committee invitations.'};
  const expected=calendarEventBody(args,'t');
  const event={...expected,isOrganizer:true,isCancelled:false,
    body:{contentType:'html',content:'<html><head><style>.EmailQuote {color:red}</style></head><body><font><div class="PlainText">Preview &lt;sample&gt; &amp; check.<br>\r\nNo committee invitations.</div></font></body></html>'}};
  assert.equal(verifyCalendarEvent(event,expected),true);
  assert.equal(verifyCalendarEvent({...event,bodyPreview:args.text_content,body:{...event.body,content:event.body.content.replace('No committee','Invite the committee')}},expected),false);
  assert.equal(verifyCalendarEvent({...event,attendees:[...event.attendees,{emailAddress:{address:'unapproved@example.org'},type:'required'}]},expected),false);
});
test('actual PowerShell transport policy allows opt-in calendar create/read only and preserves the mail boundary',()=>{
  const source=fs.readFileSync('mail-flow/graph-session.ps1','utf8');
  const policy=source.slice(source.indexOf('    $mailAllowed ='),source.indexOf('    $headers ='));assert.ok(policy.includes('$calendarAllowed'));
  const cases=[['POST','/me/events',true,true],['GET','/me/events/id%2Fopaque',true,true],['POST','/me/events',false,false],
    ['DELETE','/me/events/id',true,false],['PATCH','/me/events/id',true,false],['POST','/me/events/id/send',true,false],
    ['GET','/users/other/events/id',true,false],['GET','/me/events/id?x=1',true,false],['GET','/me/events/..',true,false],
    ['GET','/me/events/%2e%2e',true,false],['GET','/me/messages/id',false,true],
    ['GET','/me/messages/id%2Fopaque%3D/attachments?$select=id,name',false,true],['GET','/me/messages/id/attachments/a%2Bopaque%3D',false,true],
    ['POST','/me/messages/id/attachments',false,false],['PATCH','/me/messages/id/attachments/a',false,false],['DELETE','/me/messages/id/attachments/a',false,false],
    ['GET','/users/other/messages/id/attachments/a',false,false],['GET','/me/messages/%2e%2e/attachments/a',false,false],['GET','/me/messages/id/attachments/a/$value',false,false]];
  const script=cases.map(([method,url,calendar])=>`$request=@{method='${method}';path='${url}'};$Calendar=$${calendar};try {${policy};'allowed'} catch {'denied'}`).join('\n');
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(r.stdout.trim().split(/\r?\n/),cases.map(c=>c[3]?'allowed':'denied'));
});
