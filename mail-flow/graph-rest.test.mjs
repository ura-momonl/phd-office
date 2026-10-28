import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startReadLogin,pollReadLogin,GraphRest,READ_CLIENT_ID} from './graph-rest.mjs';
import {listAttachments,downloadAttachment} from './downloads.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --mail');
const account='kliu377@wisc.edu';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mail-read-test-'));
  fs.mkdirSync(path.join(root,'.runtime/mail-flow'),{recursive:true});
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^mail-read-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
const json=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const idToken=name=>'e30.'+Buffer.from(JSON.stringify({preferred_username:name})).toString('base64url')+'.sig';
const deviceCode={device_code:'dc/secret',user_code:'AB12CD34',verification_uri:'https://login.microsoft.com/device',expires_in:900,interval:1};
const files=root=>({pending:path.join(root,'.runtime/mail-flow/graph-read-login.json'),token:path.join(root,'.runtime/mail-flow/graph-read-token.json')});
function loginServer({account:name=account,authorised=()=>true}={}) {
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const body=Object.fromEntries(options.body||[]);
    calls.push({url,body});
    if(url.endsWith('/oauth2/v2.0/devicecode'))return json(deviceCode);
    if(url.endsWith('/oauth2/v2.0/token')&&body.grant_type==='urn:ietf:params:oauth:grant-type:device_code')
      return authorised()?json({refresh_token:'rt-'+name,access_token:'at',scope:'https://graph.microsoft.com/Mail.Read',id_token:idToken(name)})
        :json({error:'authorization_pending'},400);
    if(url.endsWith('/oauth2/v2.0/token')&&body.grant_type==='refresh_token')
      return body.refresh_token==='rt-'+name?json({access_token:'access-1',refresh_token:'rt-'+name,expires_in:3600}):json({error:'invalid_grant'},400);
    if(url.startsWith('https://graph.microsoft.com/v1.0/me'))return json({mail:name,userPrincipalName:name});
    throw new Error('unexpected url '+url);
  };
  return {calls,fetchImpl};
}

test('device login asks for Mail.Read only, survives a pending turn, and stores just the refresh token',async t=>{
  const root=fixture(t),{calls,fetchImpl}=loginServer({authorised:()=>false});
  const started=await startReadLogin(root,account,{fetchImpl,now:()=>1000});
  assert.equal(started.state,'waiting_for_user');assert.equal(started.user_code,'AB12CD34');
  assert.equal(started.verification_uri,'https://login.microsoft.com/device');
  const first=calls.find(c=>c.url.endsWith('/devicecode'));
  assert.equal(first.body.client_id,READ_CLIENT_ID);
  assert.match(first.body.scope,/graph\.microsoft\.com\/Mail\.Read/);
  assert.doesNotMatch(first.body.scope,/Mail\.Send|ReadWrite/);
  const pending=JSON.parse(fs.readFileSync(files(root).pending,'utf8'));
  assert.equal(pending.account,account);assert.equal(pending.device_code,'dc/secret');

  const waiting=await pollReadLogin(root,account,{fetchImpl,now:()=>2000,sleep:async()=>{}});
  assert.equal(waiting.state,'waiting_for_user');assert.equal(waiting.user_code,'AB12CD34');

  const second=await startReadLogin(root,account,{fetchImpl,now:()=>3000});
  assert.equal(second.reused,true);assert.equal(second.user_code,'AB12CD34');
  assert.equal(calls.filter(c=>c.url.endsWith('/devicecode')).length,1);

  const {fetchImpl:approving}=loginServer({});
  const done=await pollReadLogin(root,account,{fetchImpl:approving,now:()=>4000,sleep:async()=>{}});
  assert.equal(done.state,'authenticated');assert.equal(done.account,account);
  const saved=JSON.parse(fs.readFileSync(files(root).token,'utf8'));
  assert.equal(saved.refresh_token,'rt-'+account);assert.equal(saved.account,account);
  assert.ok(!JSON.stringify(saved).includes('access'));assert.ok(!fs.existsSync(files(root).pending));
  assert.equal((await pollReadLogin(root,account,{fetchImpl:approving})).state,'authenticated');
});

test('a sign-in for another mailbox is discarded instead of becoming the office read token',async t=>{
  const root=fixture(t),{fetchImpl}=loginServer({account:'xining.liao@wisc.edu'});
  await startReadLogin(root,account,{fetchImpl});
  await assert.rejects(pollReadLogin(root,account,{fetchImpl,sleep:async()=>{}}),/not the configured mailbox/);
  assert.ok(!fs.existsSync(files(root).token));
});

test('the read transport only refreshes and only issues GET requests for the configured mailbox',async t=>{
  const root=fixture(t),{fetchImpl,calls}=loginServer({});
  await startReadLogin(root,account,{fetchImpl});
  await pollReadLogin(root,account,{fetchImpl,sleep:async()=>{}});
  const graph=new GraphRest(root,account,{fetchImpl});t.after(()=>graph.close());
  assert.deepEqual(await graph.start(),{account,scopes:['Mail.Read']});
  const message=await graph.request('GET','/me/messages/abc',undefined,{Prefer:'outlook.body-content-type="html"'});
  assert.equal(message.mail,account);
  await assert.rejects(graph.request('POST','/me/messages/abc/send',{x:1}),/cannot send or modify/);
  await assert.rejects(graph.request('GET','/users/other/messages'),/Unsupported Graph read path/);
  const refresh=calls.filter(c=>c.body.grant_type==='refresh_token');
  assert.equal(refresh.length,1);assert.equal(refresh[0].body.client_id,READ_CLIENT_ID);
  assert.match(refresh[0].body.scope,/Mail\.Read/);
  const other=new GraphRest(root,'someone.else@wisc.edu',{fetchImpl});
  await assert.rejects(other.start(),/not the configured mailbox/);
});

test('an expired or revoked read sign-in says what to run and does not read mail',async t=>{
  const root=fixture(t),{fetchImpl}=loginServer({});
  await assert.rejects(new GraphRest(root,account,{fetchImpl}).start(),/mail read-login/);
  await startReadLogin(root,account,{fetchImpl});
  await pollReadLogin(root,account,{fetchImpl,sleep:async()=>{}});
  fs.writeFileSync(files(root).token,JSON.stringify({account,refresh_token:'stale',scopes:['Mail.Read']}));
  await assert.rejects(new GraphRest(root,account,{fetchImpl}).start(),/mail read-login/);
  const broken=new GraphRest(root,account,{fetchImpl:async()=>json({error:'server_error'},500)});
  await assert.rejects(broken.start(),/refresh failed/);
});

test('attachments and inline images download through the node transport as readable files',async t=>{
  const root=fixture(t),{fetchImpl:login}=loginServer({});
  await startReadLogin(root,account,{fetchImpl:login});
  await pollReadLogin(root,account,{fetchImpl:login,sleep:async()=>{}});
  const attachment={id:'attachment/opaque=',name:'实验图.png',contentType:'image/png',isInline:true,contentId:'figure1',
    '@odata.type':'#microsoft.graph.fileAttachment',contentBytes:png.toString('base64')};
  const fetchImpl=async(url,options)=>{
    if(url.startsWith('https://graph.microsoft.com/v1.0/me?'))return json({mail:account,userPrincipalName:account});
    if(url.includes('/attachments?'))return json({value:[{...attachment,contentBytes:undefined}]});
    if(url.endsWith('/attachments/attachment%2Fopaque%3D'))return json(attachment);
    return login(url,options);
  };
  const graph=new GraphRest(root,account,{fetchImpl});await graph.start();t.after(()=>graph.close());
  const listed=await listAttachments(graph,'message/opaque=');
  assert.equal(listed.value[0].content_id,'figure1');assert.ok(!JSON.stringify(listed).includes('contentBytes'));
  const saved=await downloadAttachment(graph,root,{message_id:'message/opaque=',attachment_id:'attachment/opaque='});
  assert.deepEqual(fs.readFileSync(saved.path),png);
  assert.equal(saved.sha256,createHash('sha256').update(png).digest('hex'));
  assert.equal(path.basename(saved.path),'实验图.png');assert.equal(saved.content_id,'figure1');
  assert.ok(!JSON.stringify(saved).includes(png.toString('base64')));
});

test('the send transport has its own Mail.ReadWrite/Mail.Send login and only the reply paths',async t=>{
  const root=fixture(t),{fetchImpl,calls}=loginServer({});
  await startReadLogin(root,account,{fetchImpl,kind:'send'});
  const first=calls.find(c=>c.url.endsWith('/devicecode'));
  assert.match(first.body.scope,/Mail\.ReadWrite/);assert.match(first.body.scope,/Mail\.Send/);
  assert.equal((await pollReadLogin(root,account,{fetchImpl,kind:'send',sleep:async()=>{}})).state,'authenticated');
  assert.ok(fs.existsSync(path.join(root,'.runtime/mail-flow/graph-send-token.json')));
  assert.ok(!fs.existsSync(files(root).token));
  const seen=[];
  const wrapped=async(url,options)=>{
    if(url.includes('/me/messages/')){seen.push({url,method:options.method,body:options.body});return url.endsWith('/send')?{ok:true,status:202,json:async()=>{throw new Error('no body')}}:json({id:'draft1'});}
    return fetchImpl(url,options);
  };
  const graph=new GraphRest(root,account,{fetchImpl:wrapped,kind:'send'});await graph.start();t.after(()=>graph.close());
  assert.deepEqual(graph.status.scopes,['Mail.ReadWrite','Mail.Send']);
  assert.equal((await graph.request('POST','/me/messages/abc/createReply')).id,'draft1');
  await graph.request('PATCH','/me/messages/draft1',{body:{contentType:'HTML',content:'x'}});
  assert.deepEqual(await graph.request('POST','/me/messages/draft1/send'),{});
  assert.deepEqual(seen.map(r=>r.method),['POST','PATCH','POST']);
  assert.equal(JSON.parse(seen[1].body).body.content,'x');
  await assert.rejects(graph.request('DELETE','/me/messages/abc'),/Unsupported Graph send operation/);
  await assert.rejects(graph.request('POST','/me/sendMail',{}),/Unsupported Graph send operation/);
  await assert.rejects(graph.request('POST','/users/x/messages/abc/send'),/Unsupported Graph send operation/);
  const readOnly=new GraphRest(root,account,{fetchImpl:wrapped});
  await assert.rejects(readOnly.start(),/mail read-login/);
});
