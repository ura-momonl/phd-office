import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OutlookActions} from './actions.mjs';
import {listAttachments,downloadAttachment} from './downloads.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --mail');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mail-download-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^mail-download-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
const attachment=overrides=>({id:'attachment/opaque=',name:'实验图.png',contentType:'image/png',isInline:false,
  '@odata.type':'#microsoft.graph.fileAttachment',contentBytes:png.toString('base64'),...overrides});

test('public native tools save normal and CID images as readable local files without connector discovery or mailbox writes',async t=>{
  const root=fixture(t),calls=[];
  const graph={async start(){},close(){},async request(method,url){
    calls.push({method,url});
    if(url.includes('?'))return {value:[attachment({contentBytes:undefined}),attachment({id:'inline',isInline:true,contentId:'figure1'})]};
    return url.endsWith('/inline')?attachment({id:'inline',isInline:true,contentId:'figure1'}):attachment();
  }};
  const c=new OutlookActions(root,{nativeGraph:graph});await c.start();t.after(()=>c.close());
  for(const name of ['list_attachments_native','download_attachment_native'])assert.equal((await c.tools(name))[0].requires_user_confirmation,false);
  const list=await c.prepare({tools:[],reads:[{tool:'list_attachments_native',args:{message_id:'message/opaque='}}]});
  assert.equal(list.reads[0].result.structuredContent.value.length,2);
  assert.equal(list.reads[0].result.structuredContent.value[1].is_inline,true);
  assert.ok(!JSON.stringify(list.reads).includes('contentBytes'));
  const paths=[];
  for(const attachment_id of ['attachment/opaque=','inline']) {
    const out=await c.call({tool:'download_attachment_native',args:{message_id:'message/opaque=',attachment_id}}),saved=out.result.structuredContent;
    assert.equal(out.action_id,null);assert.deepEqual(fs.readFileSync(saved.path),png);
    assert.equal(saved.bytes,png.length);assert.equal(saved.sha256,createHash('sha256').update(png).digest('hex'));
    assert.equal(saved.content_id,attachment_id==='inline'?'figure1':null);
    assert.equal(path.basename(saved.path),'实验图.png');paths.push(saved.path);
    assert.ok(!JSON.stringify(saved).includes(png.toString('base64')));
  }
  assert.notEqual(paths[0],paths[1],'same original filenames must not overwrite');
  assert.ok(calls.every(c=>c.method==='GET'));assert.ok(calls[1].url.includes('message%2Fopaque%3D/attachments/attachment%2Fopaque%3D'));
  assert.equal(c.connector,undefined);assert.equal(fs.existsSync(c.log),false);
});

test('attachment pagination stays with the selected message and never follows a remote link',async()=>{
  const calls=[],g={async request(method,url){calls.push(url);return calls.length===1?{value:[attachment()],
    '@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages/m/attachments?$skiptoken=page2'}:{value:[]};}};
  assert.equal((await listAttachments(g,'m')).value.length,1);assert.equal(calls.length,2);
  for(const link of ['https://evil.example/v1.0/me/messages/m/attachments','https://graph.microsoft.com/v1.0/me/messages/other/attachments']) {
    let n=0;await assert.rejects(listAttachments({async request(){n++;return {value:[],'@odata.nextLink':link};}},'m'),/pagination target/);assert.equal(n,1);
  }
});

test('missing, malformed, mismatched and non-file content never produces a claimed download',async t=>{
  const root=fixture(t);
  for(const bad of [attachment({id:'wrong'}),attachment({'@odata.type':'#microsoft.graph.referenceAttachment'}),attachment({contentBytes:undefined}),attachment({contentBytes:'not base64!!!'})]) {
    let calls=0;await assert.rejects(downloadAttachment({async request(){calls++;return bad;}},root,{message_id:'m',attachment_id:'attachment/opaque='}));assert.equal(calls,1);
  }
  assert.equal(fs.existsSync(path.join(root,'output')),false);
  await assert.rejects(listAttachments({request(){assert.fail('Invalid ID cannot dispatch');}},''),/non-empty/);
});

test('untrusted attachment names remain under a new office download directory; existing output junctions cannot escape',async t=>{
  const root=fixture(t),outside=fixture(t);
  for(const name of ['../../evil.png','C:\\somewhere\\图.png','CON.png','name:stream.png']) {
    const result=await downloadAttachment({async request(){return attachment({name});}},root,{message_id:'m',attachment_id:'attachment/opaque='});
    assert.ok(path.relative(root,result.path).startsWith('output'+path.sep));
    assert.deepEqual(fs.readFileSync(result.path),png);
    assert.ok(!path.basename(result.path).includes(':'));
  }
  const linkedRoot=fixture(t);fs.symlinkSync(outside,path.join(linkedRoot,'output'),'junction');
  try {await assert.rejects(downloadAttachment({async request(){return attachment();}},linkedRoot,{message_id:'m',attachment_id:'attachment/opaque='}),/outside the office/);}
  finally {fs.unlinkSync(path.join(linkedRoot,'output'));}
  assert.deepEqual(fs.readdirSync(outside),[]);
});
