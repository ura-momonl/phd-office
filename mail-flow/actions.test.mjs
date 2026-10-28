import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { OutlookActions } from './actions.mjs';
import { OutlookReader } from './outlook.mjs';
import { quoteReply } from './reply.mjs';
import {readAttachment,uploadAttachment} from './attachments.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tool = (name, properties, required = [], readOnlyHint = false) => ({
  name: `microsoft_outlook_email.${name}`, inputSchema: { type: 'object', properties, required },
  ...(readOnlyHint === null ? {} : { annotations: { readOnlyHint } })
});
// Match the connector's actual distinctions, not a fake draft-only workflow.
const catalog = [
  tool('get_profile', {}, [], true),
  tool('list_messages', { folder_id: { type: 'string' } }, [], true),
  tool('fetch_message', { message_id: { type: 'string' } }, ['message_id'], true),
  tool('send_email', { to: {}, subject: {}, text_content: {} }, ['to', 'subject', 'text_content']),
  tool('create_reply_draft', { message_id: {}, comment: {}, reply_all: {}, cc: {} }, ['message_id']),
  tool('reply_to_email', { message_id: {}, to: {}, text_content: {} }, ['message_id', 'text_content']),
  tool('future_action', { value: {} }, [], null)
];
catalog.find(t=>t.name.endsWith('.send_email')).inputSchema.properties.attachment_files={type:'string'};
catalog.find(t=>t.name.endsWith('.send_email'))._meta={'openai/fileParams':['attachment_files'],connector_id:'fixture-connector'};
const quoteOriginal={id:'original',subject:'Fixture request',sender:{emailAddress:{name:'Prof. Fixture',address:'prof@example.org'}},
  toRecipients:[{emailAddress:{address:'student@example.org'}}],receivedDateTime:'2026-10-12T15:00:00Z',
  body:{contentType:'text',content:'Please return the papers at 4 PM.\nMira: 70\nChen: 48\n\nOn an earlier day, someone wrote:\nEarlier evidence must stay quoted.'}};
function fixture(t) {
  assert.equal(process.env.PHD_ISOLATED_TESTS, '1', 'Use scripts/run-tests.mjs, never run against the live office');
  // The isolated copy inherits the office's reply transport; these tests exercise the connector path, and real Graph is disabled in tests.
  const configFile = path.join(root, 'mail-flow/config.json');
  if (fs.existsSync(configFile)) { const config = JSON.parse(fs.readFileSync(configFile, 'utf8')); delete config.replyTransport; fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-tools-test-'));
  fs.mkdirSync(path.join(dir, 'workspace'));
  const bin = path.join(dir, 'native.mjs'), calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(bin, `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(catalog)};
const quoteOriginal = ${JSON.stringify(quoteOriginal)};
const parallel = []; let parallelTimer;
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(msg) + '\\n');
  let result;
  if (msg.method === 'initialize') result = {};
  else if (msg.method === 'thread/start') result = { thread: { id: 'fixture-thread' } };
  else if (msg.method === 'mcpServerStatus/list') result = {data:[{name:'codex_apps', tools:Object.fromEntries(tools.map(t=>[t.name,t]))}],nextCursor:null};
  else if (msg.method === 'mcpServer/tool/call') {
    if (msg.params.arguments.folder_id?.startsWith('parallel-')) {
      parallel.push(msg.id);
      const flush = id => { for (const rid of parallel.splice(0)) process.stdout.write(JSON.stringify({id:rid,result:{isError:false,structuredContent:{id},content:[]}}) + '\\n'); };
      if (parallel.length === 2) { clearTimeout(parallelTimer); flush('parallel-proven'); }
      else parallelTimer = setTimeout(() => flush('sequential'), 1000);
      return;
    }
    if (msg.params.arguments.subject === 'crash') { process.exit(2); return; }
    if (msg.params.arguments.folder_id === 'read-error') result = {isError:true,content:[{type:'text',text:'Readback unavailable'}]};
    else if (msg.params.arguments.subject === 'reject') result = {isError:true,content:[{type:'text',text:'Invalid recipient address from connector'}]};
    else if (msg.params.tool.endsWith('.fetch_message')) {
      const id=msg.params.arguments.message_id,message={...quoteOriginal,id:id==='mismatch'?'another-message':id};
      if(id==='long-original')message.body={contentType:'text',content:'Full long evidence: '+('alpha β 中文 preserved.\\n'.repeat(700))};
      if(id==='no-body'){delete message.body;message.bodyPreview='Partial preview only';}
      result=id==='read-error'?{isError:true,content:[{type:'text',text:'Original unavailable'}]}:{isError:false,structuredContent:message,content:[{type:'text',text:JSON.stringify(message)}]};
    }
    else if (msg.params.tool.endsWith('.get_profile')) result = {isError:false,structuredContent:{id:'fixture-message',email:'tests@example.org'},content:[]};
    else if (msg.params.tool.endsWith('.send_email') || msg.params.tool.endsWith('.reply_to_email')) result = {isError:false,content:[{type:'text',text:'Action completed'}]};
    else if (msg.params.tool.endsWith('.list_mail_folders')) result = {isError:false,structuredContent:{value:[{id:'inbox-id',display_name:'Inbox',well_known_name:null},{id:'sent-id',display_name:'已发送邮件',well_known_name:null}]},content:[]};
    else result = {isError:false,structuredContent:{id:'fixture-message',messages:[]},content:[]};
  } else throw new Error('Unexpected protocol method ' + msg.method);
  process.stdout.write(JSON.stringify({id:msg.id,result}) + '\\n');
});
`);
  const old = process.env.MAIL_FLOW_CODEX_BIN; process.env.MAIL_FLOW_CODEX_BIN = bin;
  let client;
  t.after(() => {
    // Windows refuses to remove a child's cwd. Close the owned child before removing its fixture.
    client?.close();
    if (old === undefined) delete process.env.MAIL_FLOW_CODEX_BIN; else process.env.MAIL_FLOW_CODEX_BIN = old;
    // Do not recursively delete live project state or another test's directory.
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('outlook-tools-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { dir, bin, own: c => (client = c), calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [],
    writes: () => fs.existsSync(path.join(dir, '.runtime/mail-flow/outlook-actions.jsonl')) ?
      fs.readFileSync(path.join(dir, '.runtime/mail-flow/outlook-actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
const send = (subject = 'fixture-subject') => ({ tool: 'send_email',
  args: { to: [{ email: 'self@example.org' }], subject, text_content: 'PRIVATE FIXTURE BODY' }, confirmed_by_user: true });

test('a different connector profile leaves schema and diagnostics available but stops requested mail reads and approved uploads/sends',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.dir,'mail-flow'));fs.writeFileSync(path.join(f.dir,'mail-flow/config.json'),JSON.stringify({account:'intended@example.org'}));
  let uploads=0;const c=f.own(new OutlookActions(f.dir,{attachmentUploader:async()=>{uploads++;assert.fail('No upload to an unverified mailbox');}}));await c.start();
  assert.equal((await c.tools('fetch_message'))[0].name,'fetch_message');
  assert.equal(f.calls().filter(r=>r.method==='mcpServer/tool/call').length,0,'schema discovery does not access account data');
  assert.equal((await c.call({tool:'get_profile',args:{}})).result.structuredContent.email,'tests@example.org');
  await assert.rejects(c.call({tool:'fetch_message',args:{message_id:'known-message'}}),/Mailbox identity is not verified/);
  const file=path.join(f.dir,'figure.png');fs.writeFileSync(file,'fixture');
  await assert.rejects(c.call({...send(),args:{...send().args,attachment_files:file}}),/Mailbox identity is not verified/);
  assert.equal(uploads,0);assert.deepEqual(f.writes(),[]);
  assert.ok(f.calls().filter(r=>r.method==='mcpServer/tool/call').every(r=>r.params.tool.endsWith('.get_profile')));
});

test('approved attachment paths become uploaded references once, with no model call or content/recipient rewrite',async t=>{
  const f=fixture(t),uploads=[],c=f.own(new OutlookActions(f.dir,{attachmentUploader:async(file)=>{
    uploads.push(file);return {file_name:file.name,mime_type:file.mime,file_id:'file-fixture',download_url:'https://example.org/signed-fixture'};
  }}));await c.start();
  const file=path.join(f.dir,'unicode-成绩.csv');fs.writeFileSync(file,'Student,Score\nFixture,70\n');
  const args={...send().args,attachment_files:file},request={...send(),args},before=structuredClone(request);
  assert.deepEqual((await c.tools('send_email'))[0].file_parameters,['attachment_files']);assert.equal((await c.tools('send_email'))[0].known_issue,undefined);
  await assert.rejects(c.call({...request,confirmed_by_user:false}),/needs user approval/);
  await assert.rejects(c.call({...request,verify:send()}),/read-only/);
  await assert.rejects(c.call({...request,args:{...args,attachment_files:[file,path.join(f.dir,'missing.csv')]}}),/ENOENT/);
  for(const attachment_files of ['relative.csv',[{file_name:'fixture.csv'}]])await assert.rejects(c.call({...request,args:{...args,attachment_files}}),/absolute local/);
  assert.equal(uploads.length,0);assert.deepEqual(f.writes(),[]);
  const outcome=await c.call(request),wire=f.calls().find(x=>x.method==='mcpServer/tool/call').params.arguments;
  assert.equal(uploads.length,1);assert.equal(uploads[0].bytes.toString(),'Student,Score\nFixture,70\n');
  assert.deepEqual(wire,{...args,attachment_files:[{file_name:'unicode-成绩.csv',mime_type:'text/csv',file_id:'file-fixture',download_url:'https://example.org/signed-fixture'}]});
  assert.deepEqual(request,before,'approved body and caller request stay unchanged');
  assert.equal(outcome.attachments[0].sha256,createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.ok(Number.isInteger(outcome.duration_ms));assert.equal(f.calls().some(x=>x.method==='turn/start'),false);
  assert.equal(JSON.stringify(f.writes()).includes('signed-fixture'),false,'signed URL is not written to action logs');
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','returned']);
});

test('file upload uses the native files endpoint, snapshots exact bytes, and never puts login credentials on the blob request',async t=>{
  const f=fixture(t),authPath=path.join(f.dir,'auth.json'),file=path.join(f.dir,'test.txt');
  fs.writeFileSync(authPath,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'FAKE-TOKEN',account_id:'fixture-account'}}));fs.writeFileSync(file,'Exact approved bytes.');
  const source=readAttachment(file),calls=[],fetchImpl=async(url,options)=>{
    calls.push({url,options});if(calls.length===1)return {ok:true,json:async()=>({file_id:'file-fixture',upload_url:'https://blob.example.org/upload?sig=FAKE'})};
    if(calls.length===2){fs.writeFileSync(file,'Later changed on disk');return {ok:true};}
    return {ok:true,json:async()=>({download_url:'https://files.example.org/download?sig=FAKE'})};
  };
  const ref=await uploadAttachment(source,catalog.find(t=>t.name.endsWith('.send_email')),{fetchImpl,authPath});
  assert.equal(calls[0].url,'https://chatgpt.com/backend-api/files');assert.equal(calls[2].url,'https://chatgpt.com/backend-api/files/file-fixture/uploaded');
  assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.body.toString(),'Exact approved bytes.');
  assert.equal(calls[0].options.headers.Authorization,'Bearer FAKE-TOKEN');
  assert.deepEqual(JSON.parse(calls[0].options.body),{file_name:'test.txt',file_size:21,use_case:'codex',codex_connector_id:'fixture-connector',codex_action_name:'send_email'});
  assert.deepEqual(ref,{file_id:'file-fixture',download_url:'https://files.example.org/download?sig=FAKE',file_name:'test.txt',mime_type:'text/plain'});
  const big=path.join(f.dir,'big.bin');fs.writeFileSync(big,Buffer.alloc(3*1024*1024));assert.throws(()=>readAttachment(big),/smaller than 3 MB/);
});

test('attachment upload failures stop before any email dispatch and do not retry a stage',async t=>{
  const f=fixture(t),authPath=path.join(f.dir,'auth.json'),file=path.join(f.dir,'test.txt');
  fs.writeFileSync(authPath,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'FAKE-TOKEN'}}));fs.writeFileSync(file,'Fixture');
  for(const failedStage of [1,2,3]){
    let calls=0;const fetchImpl=async()=>{calls++;return calls===failedStage?{ok:false,status:403}:{ok:true,json:async()=>calls===1?{file_id:'file-fixture',upload_url:'https://blob.example.org/upload'}:{download_url:'https://files.example.org/download'}};};
    await assert.rejects(uploadAttachment(readAttachment(file),catalog.find(t=>t.name.endsWith('.send_email')),{fetchImpl,authPath}),/HTTP 403.*no mail dispatched/);
    assert.equal(calls,failedStage);
  }
  const c=f.own(new OutlookActions(f.dir,{attachmentUploader:async()=>{throw new Error('Upload refused; no mail dispatched');}}));await c.start();
  await assert.rejects(c.call({...send(),args:{...send().args,attachment_files:file}}),/Upload refused/);
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,0);assert.deepEqual(f.writes(),[]);
});

test('Shared interactive tool discovery and approved direct sending do not require a draft', async t => {
  const f = fixture(t), c = f.own(new OutlookActions(f.dir)); await c.start();
  assert.equal((await c.tools()).length, catalog.length);
  assert.equal((await c.tools())[0].inputSchema, undefined, 'do not dump every schema into model context');
  assert.ok((await c.tools('reply_to_email'))[0].inputSchema.properties.to);
  assert.equal((await c.tools('future_action'))[0].requires_user_confirmation, true);
  const result = await c.call(send());
  assert.equal(result.result.content[0].text, 'Action completed', 'text-only success is not a failed send');
  assert.ok(result.action_id);
  const calls = f.calls();
  assert.deepEqual(calls.filter(x => x.method === 'mcpServer/tool/call').map(x => x.params.tool), ['microsoft_outlook_email.send_email']);
  assert.equal(calls.some(x => x.method === 'turn/start'), false, 'no model call');
  assert.deepEqual(f.writes().map(x => x.status), ['attempted', 'returned']);
  assert.equal(JSON.stringify(f.writes()).includes('PRIVATE FIXTURE BODY'), false);
  assert.equal(JSON.stringify(f.writes()).includes('self@example.org'), false);
  assert.equal(f.writes()[0].args_sha256.length, 64);
});

test('Unapproved writes, unknown tools and unsupported reply-draft recipient fail before dispatch', async t => {
  const f = fixture(t), c = f.own(new OutlookActions(f.dir)); await c.start();
  for (const confirmed_by_user of [undefined, false, 'true'])
    await assert.rejects(c.call({ ...send(), confirmed_by_user }), /needs user approval/);
  await assert.rejects(c.call({ tool: 'create_reply_draft', args: { message_id: 'm', to: [] }, confirmed_by_user: true }), /Unsupported argument: to/);
  await assert.rejects(c.call({ ...send(), args: { to: [] } }), /Missing argument: subject/);
  await assert.rejects(c.call({ ...send(), tool: 'not_registered' }), /Unknown Outlook tool/);
  await assert.rejects(c.call({ ...send(), approved: true }), /Request must/);
  assert.equal(f.calls().filter(x => x.method === 'mcpServer/tool/call').length, 0);
  assert.deepEqual(f.writes(), []);
  await c.call({ tool: 'get_profile', args: {} });
  await c.call({ tool: 'future_action', args: { value: 'specific approved action' }, confirmed_by_user: true });
  assert.equal(f.writes().at(-1).message_id, 'fixture-message');
});

test('Connector errors and ambiguous process failures remain visible and are not retried', async t => {
  const f = fixture(t), c = f.own(new OutlookActions(f.dir)); await c.start();
  await assert.rejects(c.call(send('reject')), /Invalid recipient address from connector.*no automatic retry/);
  await assert.rejects(c.call(send('crash')), /Native app-server exited/);
  assert.equal(f.calls().filter(x => x.method === 'mcpServer/tool/call').length, 2);
  assert.deepEqual(f.writes().map(x => x.status), ['attempted', 'error', 'attempted', 'unknown']);
});

test('Unattended OutlookReader retains the three-read boundary and has no public RPC bypass', async t => {
  const f = fixture(t), c = f.own(new OutlookReader(f.dir)); await c.start();
  assert.equal(c.rpc, undefined);
  await assert.rejects(c.call('send_email', send().args), /Only read-only/);
  await assert.rejects(c.call('microsoft_outlook_email.send_email', send().args), /Only read-only/);
  assert.deepEqual(await c.call('list_messages', { folder_id: 'inbox' }), { id: 'fixture-message', messages: [] });
  assert.equal(c.calls, 1);
  assert.deepEqual(f.calls().filter(x => x.method === 'mcpServer/tool/call').map(x => x.params.tool), ['microsoft_outlook_email.list_messages']);
});

test('Public mail CLI exposes schemas and calls the connector without touching collector state', t => {
  const f = fixture(t), request = path.join(f.dir, 'request.json'); fs.writeFileSync(request, JSON.stringify(send()));
  const ledger = path.join(root, '.runtime/mail-flow/mail.sqlite'), before = fs.readFileSync(ledger);
  const log = path.join(root, '.runtime/mail-flow/outlook-actions.jsonl');
  // Only in the isolated office: verify action CLI does not require the collector lock.
  const lock = path.join(root, '.runtime/mail-flow/run.lock'); fs.writeFileSync(lock, String(process.pid));
  t.after(() => { fs.rmSync(lock, { force: true }); fs.rmSync(log, { force: true }); });
  const invoke = args => spawnSync(process.execPath, ['automation/run.mjs', 'mail', ...args],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 10000 });
  let r = invoke(['outlook-tools', 'reply_to_email']); assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout)[0].inputSchema.properties.to);
  r = invoke(['outlook', request]); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).result.content[0].text, 'Action completed');
  const prepFile = path.join(f.dir, 'prepare.json');
  fs.writeFileSync(prepFile, JSON.stringify({tools:['reply_to_email','fetch_message','list_messages'],reads:[
    {tool:'fetch_message',args:{message_id:'original'}},{tool:'list_messages',args:{folder_id:'sent'}}]}));
  const beforePrep = f.calls().length;
  r = invoke(['outlook-prepare', prepFile]); assert.equal(r.status, 0, r.stderr);
  const prepared = JSON.parse(r.stdout);
  assert.equal(prepared.tools.length, 3); assert.equal(prepared.reads.length, 2);
  assert.ok(prepared.tools[0].inputSchema.properties.to);
  assert.equal(f.calls().slice(beforePrep).filter(x=>x.method==='thread/start').length, 1);
  fs.writeFileSync(prepFile,JSON.stringify({tools:[],reads:[],reply:{message_id:'original',text_content:'Hi Prof. Fixture,\n\nApproved body.'}}));
  const beforeQuote=f.calls().length;
  r=invoke(['outlook-prepare',prepFile]);assert.equal(r.status,0,r.stderr);
  const quoteOutput=JSON.parse(r.stdout),quoted=JSON.parse(fs.readFileSync(quoteOutput.reply_request_file,'utf8'));
  assert.equal(quoteOutput.reply_request,undefined,'do not echo the full quotation into model context');
  assert.equal(quoteOutput.reply_preview.text_content,'Hi Prof. Fixture,\n\nApproved body.');
  assert.equal(quoted.args.message_id,'original');assert.equal(quoted.confirmed_by_user,undefined);
  assert.equal(quoted.args.text_content,quoteReply(quoteOriginal,'Hi Prof. Fixture,\n\nApproved body.'));
  assert.deepEqual(f.calls().slice(beforeQuote).filter(x=>x.method==='mcpServer/tool/call').map(x=>x.params.tool),['microsoft_outlook_email.get_profile','microsoft_outlook_email.fetch_message']);
  const beforeUnapproved=f.calls().length;
  r=invoke(['outlook',quoteOutput.reply_request_file]);assert.equal(r.status,1);assert.match(r.stderr,/needs user approval/);
  assert.equal(f.calls().slice(beforeUnapproved).filter(x=>x.method==='mcpServer/tool/call').length,0);
  const reply={...quoted,args:{...quoted.args,to:[{email:'self@example.org'}]},confirmed_by_user:true,
    verify:{tool:'list_messages',args:{folder_id:'sent'}}};
  fs.writeFileSync(request, JSON.stringify(reply));
  const beforeVerified = f.calls().length;
  r = invoke(['outlook', request]); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verification.status, 'returned');
  assert.equal(JSON.parse(r.stdout).result.content[0].text, 'Action completed');
  const verifiedCalls = f.calls().slice(beforeVerified);
  assert.equal(verifiedCalls.filter(x=>x.method==='thread/start').length, 1);
  assert.deepEqual(verifiedCalls.filter(x=>x.method==='mcpServer/tool/call').map(x=>x.params.tool),
    ['microsoft_outlook_email.get_profile','microsoft_outlook_email.reply_to_email','microsoft_outlook_email.list_messages']);
  assert.deepEqual(verifiedCalls.find(x=>x.method==='mcpServer/tool/call'&&x.params.tool.endsWith('.reply_to_email')).params.arguments,reply.args,
    'the approved original message, recipient and body are forwarded exactly, not rewritten');
  assert.deepEqual(fs.readFileSync(ledger), before);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
});

test('Preparation combines schemas and parallel reads; a mixed or malformed group dispatches nothing', async t => {
  const f=fixture(t), c=f.own(new OutlookActions(f.dir)); await c.start();
  const read={tool:'get_profile',args:{}};
  for(const request of [
    {tools:['get_profile'],reads:[read,send()]},
    {tools:['get_profile'],reads:[read,{tool:'future_action',args:{value:'x'},confirmed_by_user:true}]},
    {tools:['get_profile'],reads:[read,{tool:'fetch_message',args:{}}]},
    {tools:['not_registered'],reads:[read]},
    {tools:['get_profile'],reads:[read],confirmed_by_user:true},
  ]) await assert.rejects(c.prepare(request));
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,0);
  const result=await c.prepare({tools:['reply_to_email','list_messages'],reads:[
    {tool:'list_messages',args:{folder_id:'parallel-a'}},{tool:'list_messages',args:{folder_id:'parallel-b'}}]});
  assert.equal(result.tools.length,2);
  assert.ok(result.reads.every(r=>r.result.structuredContent.id==='parallel-proven'));
  const partial=await c.prepare({tools:[],reads:[read,{tool:'list_messages',args:{folder_id:'read-error'}}]});
  assert.equal(partial.reads[0].result.structuredContent.id,'fixture-message');
  assert.match(partial.reads[1].error,/Readback unavailable/);
  assert.deepEqual(f.writes(),[]);
  assert.equal(f.calls().some(x=>x.method==='turn/start'),false);
});

test('Send plus readback validates before sending and preserves text-only success if readback fails', async t => {
  const f=fixture(t), c=f.own(new OutlookActions(f.dir)); await c.start();
  for(const verify of [send(),{tool:'future_action',args:{value:'x'},confirmed_by_user:true},
    {tool:'list_messages',args:{bad_field:'x'}},null]) await assert.rejects(c.call({...send(),verify}));
  await assert.rejects(c.call({...send(),confirmed_by_user:false,verify:{tool:'get_profile',args:{}}}),/needs user approval/);
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,0);
  const result=await c.call({...send(),verify:{tool:'list_messages',args:{folder_id:'read-error'}}});
  assert.equal(result.result.content[0].text,'Action completed');
  assert.ok(result.action_id);
  assert.equal(result.verification.status,'error');
  assert.match(result.verification.error,/Readback unavailable/);
  assert.equal(result.verification.no_automatic_retry,true);
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','returned']);
  assert.deepEqual(f.calls().filter(x=>x.method==='mcpServer/tool/call').map(x=>x.params.tool),
    ['microsoft_outlook_email.send_email','microsoft_outlook_email.list_messages']);
});

test('Rejected or unknown send does not run verification or replay the action', async t => {
  const f=fixture(t), c=f.own(new OutlookActions(f.dir)); await c.start();
  const verify={tool:'list_messages',args:{folder_id:'sent'}};
  await assert.rejects(c.call({...send('reject'),verify}),/no automatic retry/);
  await assert.rejects(c.call({...send('crash'),verify}),/Native app-server exited/);
  assert.deepEqual(f.calls().filter(x=>x.method==='mcpServer/tool/call').map(x=>x.params.tool),
    ['microsoft_outlook_email.send_email','microsoft_outlook_email.send_email']);
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','error','attempted','unknown']);
});

test('Quotation preserves the new reply, full original text and Outlook-style headers, without ">" prefixes or history clipping',()=>{
  const reply='Hi Prof. Fixture,\n\nApproved answer.\n',result=quoteReply(quoteOriginal,reply);
  assert.ok(result.startsWith('Hi Prof. Fixture,\n\nApproved answer.\n\n________________________________\nFrom: '));
  assert.match(result,/From: Prof\. Fixture <prof@example\.org>/);assert.match(result,/Received: Monday, October 12, 2026 10:00 AM/);
  assert.doesNotMatch(result,/\nSent:/,'received time must not be relabeled as sent time');
  assert.match(quoteReply({...quoteOriginal,sentDateTime:'2026-10-12T14:59:00Z'},reply),/Sent: Monday, October 12, 2026 9:59 AM/);
  assert.match(result,/To: student@example\.org/);assert.match(result,/Subject: Fixture request/);
  assert.doesNotMatch(result,/Original Message|^> /m);
  assert.ok(result.endsWith('\n\n'+quoteOriginal.body.content),'plain-text original is kept line for line');
  const long='x'.repeat(15000);assert.ok(quoteReply({...quoteOriginal,body:{contentType:'text',content:long}},'reply').endsWith('\n\n'+long));
  assert.throws(()=>quoteReply({bodyPreview:'preview'},'reply'),/Full original body/);
  assert.equal(quoteReply({...quoteOriginal,body:{contentType:'text',content:'literal &amp; <R> < 5'}},'reply').split('\n').at(-1),'literal &amp; <R> < 5');
});

test('HTML quotation keeps readable paragraphs, scores, entities and link targets without loading or executing anything',()=>{
  const html='<html><head><style>hidden rule</style></head><body><p>R&amp;D &#x3b1; &lt;sample&gt;</p><table><tr><td>Mira</td><td>70</td></tr><tr><td>Chen</td><td>48</td></tr></table><p><a href="https://example.org/poll?a=1&amp;b=2">Poll</a></p><script>hidden script</script></body></html>';
  const result=quoteReply({...quoteOriginal,body:{contentType:'html',content:html}},'answer');
  assert.match(result,/\nR&D α <sample>/);assert.match(result,/\nMira\t70/);assert.match(result,/\nChen\t48/);
  assert.match(result,/Poll \(https:\/\/example\.org\/poll\?a=1&b=2\)/);assert.doesNotMatch(result,/hidden rule|hidden script|<table>|<script>/);
  assert.throws(()=>quoteReply({...quoteOriginal,body:{contentType:'html',content:'<script>hidden</script>'}},'answer'),/no readable text/);
  const rendered='Already rendered\nFull original';
  assert.ok(quoteReply({...quoteOriginal,body:{contentType:'html',content:rendered}},'answer').endsWith('\n\nAlready rendered\nFull original'));
});

test('Connector-rendered HTML original: blank runs and trailing blanks tidied, hard wraps and hyphenated breaks rejoined, header labels and rules unmarked',()=>{
  const wrapped='Good question. Unfortunately I do not know of an annealing system like that\nright now. I do know that one group does some CO2 laser melting of aerosol-jet-\nprinted films.\n\n  \n\n\nMikhail\n\n* * *\n\n**From:** Kaimeng Liu <k@example.org>  \n**Sent:** Thursday, October 15, 2026 9:42 AM  \n- short item\n- another item';
  const result=quoteReply({...quoteOriginal,body:{contentType:'html',content:wrapped}},'answer'),body=result.split('\n\n').slice(2).join('\n\n');
  assert.equal(body,'Good question. Unfortunately I do not know of an annealing system like that right now. I do know that one group does some CO2 laser melting of aerosol-jet-printed films.\n\nMikhail\n\n________________________________\n\nFrom: Kaimeng Liu <k@example.org>\nSent: Thursday, October 15, 2026 9:42 AM\n- short item\n- another item');
  assert.doesNotMatch(result,/\*\*|\* \* \*|[ \t]+\n/);
});

test('Graph reply preparation saves only new text and approved audience; guard blocks unapproved and duplicate native sends',async t=>{
  const f=fixture(t),events=[],original={...quoteOriginal,from:quoteOriginal.sender,replyTo:[{emailAddress:{address:'reply-to@example.org'}}]};
  const launched=path.join(f.dir,'connector-started');
  fs.writeFileSync(f.bin,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(launched)},'started');process.exit(1);`);
  const draftBody={contentType:'html',content:'<html><body><hr><div id="divRplyFwdMsg">Native full quotation</div></body></html>'};
  let patched,sent=false;
  const graph={async start(){},close(){},async request(method,url,body){
    events.push({method,url,body});
    if(url.endsWith('/createReply'))return {id:'native-draft',isDraft:true,body:draftBody,toRecipients:original.replyTo,ccRecipients:[],bccRecipients:[]};
    if(method==='PATCH'){patched={id:'native-draft',isDraft:true,...body};return patched;}
    if(url.endsWith('/send')){sent=true;return null;}
    if(url.endsWith('/native-draft'))return {...patched,isDraft:!sent};
    return original;
  }};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  const reply={message_id:'original',text_content:'Approved new reply.\n\nSecond paragraph.'};
  const prepared=await c.prepare({tools:[],reads:[],reply});
  assert.equal(prepared.reply_error,undefined);
  assert.equal(prepared.reply_preview.quote_mode,'server_native');
  assert.equal(prepared.reply_preview.quote_verified,false,'native quote is generated later, not certified during local preparation');
  assert.equal(prepared.verification_mode,'immutable_sent_copy');
  assert.equal(prepared.verify_template,undefined,'do not require a connector folder search for Graph sent-copy verification');
  const action=JSON.parse(fs.readFileSync(prepared.reply_request_file,'utf8'));
  assert.equal(action.tool,'reply_native');assert.equal(action.args.text_content,reply.text_content);
  assert.deepEqual(action.args.to,[{email:'reply-to@example.org'}]);assert.deepEqual(action.args.cc,[]);assert.deepEqual(action.args.bcc,[]);
  assert.deepEqual(events.map(e=>e.method),['GET'],'preparation is read only');
  await assert.rejects(c.call(action),/needs user approval/);assert.equal(events.length,1);
  const approved={...action,confirmed_by_user:true};await c.call(approved);
  await assert.rejects(c.call(approved),/already returned/);
  assert.equal(events.filter(e=>e.url.endsWith('/send')).length,1);
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','drafted','returned']);
  assert.ok(f.writes().some(r=>r.message_id==='native-draft'));
  assert.equal(f.calls().some(r=>r.params?.tool==='microsoft_outlook_email.reply_to_email'),false);
  assert.equal(fs.existsSync(launched),false,'native prepare, approval checks, send and verification never start app-server');
});

test('native CLI schemas and read-only validation work with an unavailable connector, without Graph login',async t=>{
  const f=fixture(t),configFile=path.join(root,'mail-flow/config.json'),before=fs.readFileSync(configFile,'utf8');
  const config=JSON.parse(before);config.replyTransport='graph';fs.writeFileSync(configFile,JSON.stringify(config));
  t.after(()=>fs.writeFileSync(configFile,before));
  const launched=path.join(f.dir,'connector-started');
  fs.writeFileSync(f.bin,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(launched)},'started');process.exit(1);`);
  for(const name of ['fetch_native','reply_native','create_event_native','fetch_event_native']) {
    const r=spawnSync(process.execPath,['automation/run.mjs','mail','outlook-tools',name],{cwd:root,encoding:'utf8',env:process.env,timeout:10000});
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout)[0].name,name);
  }
  const graph={async start(){assert.fail('No authentication during metadata lookup or invalid preparation');},close(){},async request(){assert.fail('No Graph dispatch');}};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  await assert.rejects(c.prepare({tools:[],reads:[{tool:'fetch_native',args:{message_id:'original'}},{tool:'reply_native',args:{message_id:'original',text_content:'no'},confirmed_by_user:true}]}),/read-only/);
  await assert.rejects(c.call({tool:'reply_native',args:{message_id:'original',text_content:'no'}}),/needs user approval/);
  assert.equal(fs.existsSync(launched),false);assert.deepEqual(f.writes(),[]);
});

test('unknown native names fail locally across schema, prepare, action and verification, including mixed connector requests',async t=>{
  const f=fixture(t),launched=path.join(f.dir,'connector-started');
  fs.writeFileSync(f.bin,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(launched)},'started');process.exit(1);`);
  const graph={async start(){assert.fail('Invalid native name must not authenticate');},close(){},async request(){assert.fail('Invalid native name must not dispatch');}};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  const wrong={tool:'fetch_message_native',args:{message_id:'original'}},read={tool:'get_profile',args:{}};
  for(const invoke of [
    ()=>c.tools(wrong.tool),
    ()=>c.prepare({tools:[wrong.tool],reads:[]}),
    ()=>c.prepare({tools:[],reads:[read,wrong],reply:{message_id:'original',text_content:'Do not prepare'}}),
    ()=>c.prepare({tools:[],reads:[wrong,read]}),
    ()=>c.call(wrong),
    ()=>c.call({...send(),verify:wrong}),
    ()=>c.call({...wrong,verify:read})
  ])await assert.rejects(invoke,/Unknown or unavailable native Outlook tool: fetch_message_native; available native tools: .*fetch_native/);
  await assert.rejects(c.tools('reply_message_native'),/Unknown or unavailable native Outlook tool/);
  assert.equal(fs.existsSync(launched),false);
  assert.equal(fs.existsSync(c.replies),false);assert.deepEqual(f.writes(),[]);
  assert.equal((await c.tools('fetch_native'))[0].name,'fetch_native');
});

test('public CLI rejects unknown or disabled native names without starting a connector; dynamic connector names still work',async t=>{
  const f=fixture(t),configFile=path.join(root,'mail-flow/config.json'),before=fs.readFileSync(configFile,'utf8');
  t.after(()=>fs.writeFileSync(configFile,before));
  const originalBin=fs.readFileSync(f.bin,'utf8'),launched=path.join(f.dir,'connector-started');
  fs.writeFileSync(f.bin,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(launched)},'started');process.exit(1);`);
  const run=args=>spawnSync(process.execPath,['automation/run.mjs','mail',...args],{cwd:root,encoding:'utf8',env:process.env,timeout:10000});
  const config=JSON.parse(before);config.replyTransport='graph';fs.writeFileSync(configFile,JSON.stringify(config));
  for(const args of [
    ['outlook-tools','fetch_message_native'],
    ['outlook-prepare',JSON.stringify({tools:[],reads:[{tool:'fetch_message_native',args:{message_id:'original'}}]})],
    ['outlook',JSON.stringify({tool:'fetch_message_native',args:{message_id:'original'}})],
    ['outlook',JSON.stringify({...send(),verify:{tool:'fetch_message_native',args:{message_id:'original'}}})]
  ]) {
    const r=run(args);assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/Unknown or unavailable native Outlook tool: fetch_message_native; available native tools: .*fetch_native/);
    assert.doesNotMatch(r.stderr,/app-server exited|Graph login/);
  }
  delete config.replyTransport;fs.writeFileSync(configFile,JSON.stringify(config));
  // Reads stay available without replyTransport; only the send/calendar tools are disabled.
  assert.equal(run(['outlook-tools','fetch_native']).status,0);
  const disabled=run(['outlook-tools','reply_native']);assert.equal(disabled.status,1);assert.match(disabled.stderr,/Unknown or unavailable native Outlook tool: reply_native; available native tools: .*fetch_native/);
  assert.equal(fs.existsSync(launched),false);
  fs.writeFileSync(f.bin,originalBin);
  const dynamic=run(['outlook-tools','future_action']);assert.equal(dynamic.status,0,dynamic.stderr);assert.equal(JSON.parse(dynamic.stdout)[0].name,'future_action');
  const full=run(['outlook-tools']);assert.equal(full.status,0,full.stderr);assert.ok(JSON.parse(full.stdout).some(t=>t.name==='fetch_message'));
  const unknown=run(['outlook-tools','unknown_connector_tool']);assert.equal(unknown.status,1);assert.match(unknown.stderr,/Unknown Outlook tool: unknown_connector_tool/);
});

test('Graph login is lazy: connector reads still work if Graph is unavailable; native reply never falls back to text sending',async t=>{
  const f=fixture(t);let logins=0;
  const graph={async start(){logins++;throw new Error('Graph consent missing');},close(){},async request(){assert.fail('No Graph request before login');}};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  assert.equal(logins,0);await c.call({tool:'get_profile',args:{}});assert.equal(logins,0);
  await assert.rejects(c.call({tool:'reply_native',args:{message_id:'original',text_content:'Approved reply.'},confirmed_by_user:true}),/Graph consent missing/);
  assert.equal(logins,1);
  assert.equal(f.calls().some(r=>r.params?.tool==='microsoft_outlook_email.reply_to_email'),false);
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','unknown']);
});

test('calendar tools share approval, preparation, audit and duplicate guards; missing consent never logs an attempted invite',async t=>{
  const f=fixture(t),calls=[];let saved;
  const graph={status:{scopes:[]},async start(){},close(){},async request(method,url,body){
    calls.push({method,url,body});
    if(method==='POST'){saved={...structuredClone(body),id:'fixture-event',isOrganizer:true,isCancelled:false};return saved;}
    return saved;
  }};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  const action={tool:'create_event_native',args:{subject:'Fixture meeting',text_content:'Private fixture body',location:'Fixture Room',
    start_utc:'2026-10-29T15:30:00Z',end_utc:'2026-10-29T17:00:00Z',attendees:[{email:'preview@example.org'}]}};
  assert.equal((await c.tools('create_event_native'))[0].requires_user_confirmation,true);
  assert.equal((await c.tools('fetch_event_native'))[0].requires_user_confirmation,false);
  await assert.rejects(c.call(action),/needs user approval/);
  await assert.rejects(c.prepare({tools:[],reads:[{...action,confirmed_by_user:true}]}),/read-only/);
  const approved={...action,confirmed_by_user:true};
  await assert.rejects(c.call(approved),/permission missing/);assert.equal(calls.length,0);assert.deepEqual(f.writes(),[]);
  graph.status.scopes=['Calendars.ReadWrite'];
  const out=await c.call(approved);assert.equal(out.result.structuredContent.verification.status,'verified');
  await assert.rejects(c.call(approved),/already returned/);
  assert.deepEqual(calls.map(c=>c.method),['POST','GET']);assert.deepEqual(f.writes().map(r=>r.status),['attempted','returned']);
  assert.equal(calls[0].body.transactionId,out.action_id);assert.equal(JSON.stringify(f.writes()).includes('Private fixture body'),false);
  await c.call({tool:'fetch_event_native',args:{event_id:'fixture-event'}});assert.equal(calls.at(-1).method,'GET');
});

test('calendar create timeout is recorded as unknown and cannot be automatically repeated',async t=>{
  const f=fixture(t),calls=[];
  const graph={status:{scopes:['Calendars.ReadWrite']},async start(){},close(){},async request(method,url){calls.push({method,url});throw new Error('create outcome unknown');}};
  const c=f.own(new OutlookActions(f.dir,{nativeGraph:graph}));await c.start();
  const action={tool:'create_event_native',confirmed_by_user:true,args:{subject:'Fixture uncertain',text_content:'fixture',location:'Fixture Room',
    start_utc:'2026-10-29T15:30:00Z',end_utc:'2026-10-29T17:00:00Z',attendees:[{email:'preview@example.org'}]}};
  await assert.rejects(c.call(action),/outcome unknown/);await assert.rejects(c.call(action),/already unknown/);
  assert.equal(calls.length,1);assert.deepEqual(f.writes().map(r=>r.status),['attempted','unknown']);
});

test('Quoted reply preparation exposes the original once and saves the exact unapproved body for dispatch',async t=>{
  const f=fixture(t),c=f.own(new OutlookActions(f.dir));await c.start();
  const reply={message_id:'original',text_content:'Hi Prof. Fixture,\n\nApproved answer.'};
  const read={tool:'fetch_message',args:{message_id:'original'}};
  const prepared=await c.prepare({tools:[],reads:[read,read],reply});
  assert.equal(prepared.reply_error,undefined);assert.equal(prepared.reply_request,undefined);
  assert.equal(path.dirname(prepared.reply_request_file),path.join(f.dir,'.runtime/mail-flow/prepared-replies'));
  const saved=JSON.parse(fs.readFileSync(prepared.reply_request_file,'utf8'));
  assert.equal(saved.tool,'reply_to_email');assert.equal(saved.args.message_id,'original');
  assert.equal(saved.args.text_content,quoteReply(quoteOriginal,reply.text_content));
  assert.equal(saved.confirmed_by_user,undefined);
  assert.deepEqual(prepared.reads[0].result.structuredContent,quoteOriginal);
  assert.equal(prepared.reads.length,1);assert.equal(prepared.reads[0].result.content,undefined);
  assert.equal(prepared.reply_preview.text_content,reply.text_content);
  assert.equal(prepared.reply_preview.body_sha256,createHash('sha256').update(saved.args.text_content).digest('hex'));
  assert.equal(prepared.reply_preview.body_chars,saved.args.text_content.length);assert.equal(prepared.reply_preview.quote_verified,true);
  const observation=JSON.stringify(prepared),marker='Earlier evidence must stay quoted.';
  assert.equal(observation.split(marker).length-1,1,'the original is visible exactly once, including when MCP text duplicates it');
  assert.equal(observation.includes('> Please return the papers'),false,'full composed quotation stays out of model input');
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,1,'reuse the existing full-message read');
  assert.deepEqual(f.writes(),[]);
  await assert.rejects(c.call(saved),/needs user approval/);
  const action={...saved,confirmed_by_user:true};await c.call(action);
  const calls=f.calls().filter(x=>x.method==='mcpServer/tool/call');
  assert.deepEqual(calls.map(x=>x.params.tool),['microsoft_outlook_email.fetch_message','microsoft_outlook_email.reply_to_email']);
  assert.deepEqual(calls[1].params.arguments,action.args,'no content rewriting after approval');
  assert.deepEqual(f.writes().map(r=>r.status),['attempted','returned']);
});

test('Failed or wrong original never yields a sendable quoted reply; malformed preparation dispatches nothing',async t=>{
  const f=fixture(t),c=f.own(new OutlookActions(f.dir));await c.start();
  const reply={message_id:'original',text_content:'answer'};
  for(const bad of [null,{...reply,confirmed_by_user:true},{...reply,text_content:''}])
    await assert.rejects(c.prepare({tools:[],reads:[],reply:bad}));
  await assert.rejects(c.prepare({tools:[],reads:[send()],reply}),/read-only/);
  await assert.rejects(c.prepare({tools:[],reads:[{tool:'fetch_message',args:{message_id:'original'}},
    {tool:'fetch_message',args:{message_id:'original',bad_field:true}}],reply}),/Unsupported argument/);
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,0);
  for(const message_id of ['mismatch','no-body','read-error']){
    const prepared=await c.prepare({tools:[],reads:[],reply:{...reply,message_id}});
    assert.equal(prepared.reply_request_file,undefined);assert.equal(prepared.reply_preview,undefined);assert.ok(prepared.reply_error);
  }
  assert.deepEqual(f.writes(),[]);
  assert.ok(f.calls().filter(x=>x.method==='mcpServer/tool/call').every(x=>x.params.tool.endsWith('.fetch_message')));
});

test('Long original is retained once in the observation and fully quoted in independent local files',async t=>{
  const f=fixture(t),c=f.own(new OutlookActions(f.dir));await c.start();
  const reply={message_id:'long-original',text_content:'Approved answer.\n'},prepared=await c.prepare({tools:[],reads:[],reply});
  const saved=JSON.parse(fs.readFileSync(prepared.reply_request_file,'utf8')),original=prepared.reads[0].result.structuredContent;
  assert.ok(original.body.content.length>15000);assert.equal(saved.args.text_content,quoteReply(original,reply.text_content));
  const observation=JSON.stringify(prepared),oldObservation=JSON.stringify({guidance:prepared.guidance,tools:prepared.tools,reads:prepared.reads,reply_request:saved});
  assert.ok(Buffer.byteLength(observation)<Buffer.byteLength(oldObservation)*0.65,'remove the large repeated quotation, not required source evidence');
  assert.equal(observation.split('Full long evidence:').length-1,1);
  const second=await c.prepare({tools:[],reads:[],reply:{...reply,text_content:'Different answer.'}});
  assert.notEqual(second.reply_request_file,prepared.reply_request_file);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.reply_request_file,'utf8')),saved,'preparing another reply must not overwrite the first final body');
  assert.deepEqual(f.writes(),[]);assert.equal(f.calls().some(x=>x.method==='turn/start'),false);
});

test('Local reply file failure returns no sendable reference and never dispatches a write',async t=>{
  const f=fixture(t),c=f.own(new OutlookActions(f.dir));await c.start();
  const parent=path.join(f.dir,'.runtime/mail-flow');fs.mkdirSync(parent,{recursive:true});
  fs.writeFileSync(path.join(parent,'prepared-replies'),'not a directory');
  const prepared=await c.prepare({tools:[],reads:[],reply:{message_id:'original',text_content:'answer'}});
  assert.ok(prepared.reply_error);assert.equal(prepared.reply_request_file,undefined);assert.equal(prepared.reply_preview,undefined);
  assert.deepEqual(f.writes(),[]);assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call').length,1);
});

test('Preparing a reply or send also finds the sent folder and hands back a readback template; a connector without the folder tool still prepares', async t => {
  const f=fixture(t), c=f.own(new OutlookActions(f.dir)); await c.start();
  const without=await c.prepare({tools:[],reads:[],reply:{message_id:'original',text_content:'Hi.'}});
  assert.ok(without.reply_request_file);assert.match(without.sent_folder_error,/Unknown Outlook tool/);
  catalog.push(tool('list_mail_folders',{top:{}},[],true));t.after(()=>{catalog.pop();});
  const g=fixture(t), d=g.own(new OutlookActions(g.dir)); await d.start();
  const result=await d.prepare({tools:[],reads:[],sent:true});
  assert.deepEqual(result.sent_folder,{id:'sent-id',name:'已发送邮件'});
  assert.deepEqual(result.verify_template,{tool:'list_messages',args:{folder_id:'sent-id',order_by:'sentDateTime desc',top:3}});
  assert.match(result.guidance,/不再请示/);
  assert.equal(result.guidance,fs.readFileSync(new URL('./INTERACTIVE-GUIDE.md',import.meta.url),'utf8').trim(),'preparation uses the same guide as optional reading and prompt injection');
  const reply=await d.prepare({tools:[],reads:[],reply:{message_id:'original',text_content:'Hi.'}});
  assert.equal(reply.sent_folder.id,'sent-id');assert.ok(reply.reply_request_file);
  assert.equal(reply.reads.length,1,'the folder list is summarized, not echoed');
  assert.deepEqual(g.writes(),[]);
  await assert.rejects(d.prepare({tools:[],reads:[],sent:false}),/Preparation must be/);
});

test('An identical send is refused by the program unless the user asked to repeat it; an earlier error does not block', async t => {
  const f=fixture(t), c=f.own(new OutlookActions(f.dir)); await c.start();
  const sends=()=>f.calls().filter(x=>x.method==='mcpServer/tool/call'&&x.params.tool.endsWith('.send_email')).length;
  await c.call(send('once'));assert.equal(sends(),1);
  await assert.rejects(c.call(send('once')),/Identical send_email already returned/);
  assert.equal(sends(),1,'refused before any dispatch');
  await c.call({...send('once'),allow_repeat:true});assert.equal(sends(),2);
  await assert.rejects(c.call(send('reject')),/no automatic retry/);
  await assert.rejects(c.call(send('reject')),/no automatic retry/);
  assert.equal(sends(),4,'a rejected attempt is not a prior send');
  await assert.rejects(c.call(send('crash')),/Native app-server exited/);
  const d=f.own(new OutlookActions(f.dir)); await d.start();
  await assert.rejects(d.call(send('crash')),/Identical send_email already unknown/);
  await assert.rejects(c.call({tool:'get_profile',args:{},allow_repeat:true}),/allow_repeat/);
  await assert.rejects(c.call({...send('x'),allow_repeat:'yes'}),/allow_repeat/);
});

test('Public mail CLI accepts a request as inline JSON or standard input as well as a file', t => {
  const f=fixture(t),log=path.join(root,'.runtime/mail-flow/outlook-actions.jsonl');
  t.after(()=>fs.rmSync(log,{force:true}));
  const run=(args,input)=>spawnSync(process.execPath,['automation/run.mjs','mail',...args],{cwd:root,encoding:'utf8',env:process.env,timeout:10000,input});
  let r=run(['outlook',JSON.stringify({tool:'get_profile',args:{}})]);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).result.isError,false);
  r=run(['outlook-prepare','-'],JSON.stringify({tools:['get_profile'],reads:[{tool:'get_profile',args:{}}]}));assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).reads.length,1);
  r=run(['outlook','-'],'﻿'+JSON.stringify(send('stdin-subject')));assert.equal(r.status,0,r.stderr);
  r=run(['outlook','{bad json']);assert.equal(r.status,1);
  assert.equal(f.calls().filter(x=>x.method==='mcpServer/tool/call'&&x.params.tool.endsWith('.send_email')).length,1);
});

test('Windows PowerShell Unicode reaches the mail CLI intact via UTF-8 file or explicitly UTF-8 pipe', {skip:process.platform!=='win32'}, t=>{
  const f=fixture(t),log=path.join(root,'.runtime/mail-flow/outlook-actions.jsonl');
  t.after(()=>fs.rmSync(log,{force:true}));
  // Incident: Windows PowerShell 5.1's default ASCII pipe changed UW’s and I’m before Node read stdin.
  const body='I’m using UW’s library.\n中文 — café α μ ≤ 10 🟢';
  const quote=s=>"'"+s.replace(/'/g,"''")+"'";
  const run=script=>{
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {cwd:root,encoding:'utf8',env:process.env,timeout:15000,windowsHide:true});
    assert.equal(r.status,0,r.stderr);return r;
  };
  const echo="let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify([...s.trimEnd()].map(c=>c.codePointAt(0)))))";
  const pipe=`@'\n${body}\n'@ | & ${quote(process.execPath)} -e ${quote(echo)}`;
  const points=s=>[...s].map(c=>c.codePointAt(0));
  const broken=JSON.parse(run('$OutputEncoding=[Text.Encoding]::ASCII;\n'+pipe).stdout);
  assert.notDeepEqual(broken,points(body));assert.ok(broken.includes(63),'bad control must expose question-mark replacement');
  const utf8='$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n';
  assert.deepEqual(JSON.parse(run(utf8+pipe).stdout),points(body));
  const request={...send('unicode-file'),args:{...send().args,subject:'Unicode 文件 — UTF-8',text_content:body}};
  const file=path.join(f.dir,'request.json');fs.writeFileSync(file,JSON.stringify(request),'utf8');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).args.text_content,body);
  // The recommended public path must work even with the caller's lossy pipe defaults unchanged.
  run(`$OutputEncoding=[Text.Encoding]::ASCII; & ${quote(process.execPath)} automation/run.mjs mail outlook ${quote(file)}`);
  const sent=f.calls().filter(x=>x.method==='mcpServer/tool/call'&&x.params.tool.endsWith('.send_email'));
  assert.equal(sent.length,1);assert.deepEqual(sent[0].params.arguments,request.args);
});

test('Attachment MIME types follow the file extension and unknown types stay generic',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outlook-tools-test-mime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const types={};
  for(const name of ['a.pdf','b.PNG','c.xlsx','d.csv','e.bin']){const file=path.join(dir,name);fs.writeFileSync(file,'x');types[name]=readAttachment(file).mime;}
  assert.deepEqual(types,{'a.pdf':'application/pdf','b.PNG':'image/png','c.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','d.csv':'text/csv','e.bin':'application/octet-stream'});
});
