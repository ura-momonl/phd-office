import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {graphLoginStatus} from './graph-login.mjs';

// One SDK session per explicit operation. No model calls, scheduled jobs or retries.
export class GraphSession {
  constructor(root,account,{calendar=false}={}) { this.root=root;this.account=account;this.calendar=calendar;this.pending=new Map();this.next=0; }
  async start() {
    if(process.env.PHD_ISOLATED_TESTS)throw new Error('Real Graph login is disabled in isolated tests');
    if(this.calendar) {
      const login=graphLoginStatus(this.root);
      if(login.state!=='authenticated'||login.account?.toLowerCase()!==this.account.toLowerCase()||!login.scopes?.includes('Calendars.ReadWrite'))
        throw new Error('Calendar permission has not been authorized; run node automation/run.mjs mail graph-login calendar and finish Microsoft consent; no meeting created');
    }
    const executable=path.join(this.root,'.runtime/mail-flow/graph-sdk/powershell-7.6.7/pwsh.exe');
    this.child=spawn(executable,['-NoProfile','-NonInteractive','-File',path.join(this.root,'mail-flow/graph-session.ps1'),
      '-Root',this.root,'-Account',this.account,...(this.calendar?['-Calendar']:[])],{cwd:this.root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume();
    const fail=message=>{this.failed=message;this.onReady?.reject(new Error(message));for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.pending.clear();};
    this.child.on('error',()=>fail('Cannot start official Graph SDK session'));
    this.child.on('exit',code=>fail(`Graph SDK process exited (${code}); this does not establish login expiry. Check host launch permissions or request normal tool authorization when restricted; inspect mailbox state before repeating a write`));
    this.child.stdin.on('error',()=>fail('Graph SDK input closed; inspect mailbox state before repeating a write'));
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      let row;try{row=JSON.parse(line);}catch{if(line.trim())fail('Graph needs interactive sign-in; run mail graph-login, then retry preparation (not sending)');return;}
      if(row.ready){this.status=row.status;this.onReady?.resolve(row.status);return;}
      const p=this.pending.get(row.id);if(!p)return;
      clearTimeout(p.timer);this.pending.delete(row.id);
      row.error?p.reject(new Error(`Graph request failed${row.error.status?' (HTTP '+row.error.status+')':''}; no automatic retry; inspect mailbox state`)):p.resolve(row.result);
    });
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Graph SDK startup did not become ready within 60 seconds; no requested mail operation dispatched. A saved login status is not a live connection check; inspect the SDK session/sign-in before trying again.')),60000);
      this.onReady={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};if(this.failed)this.onReady.reject(new Error(this.failed));});
  }
  request(method,url,body,headers={}) {
    if(this.failed)return Promise.reject(new Error(this.failed));
    return new Promise((resolve,reject)=>{
      const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Graph request timed out; outcome unknown; no automatic retry'));},55000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,path:url,body,headers})+'\n');
    });
  }
  close(){this.lines?.close();this.child?.stdin.end();if(this.child?.exitCode===null)this.child.kill();}
}

const messagePath=id=>'/me/messages/'+encodeURIComponent(id);
// Element text needs only & < >. Exchange rewrites &#39; and &quot; back to ' and " on save, which would fail the persisted-body comparison below.
const html=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function prependReply(original,text) {
  if(typeof text!=='string'||!text.trim())throw new Error('Reply text is required');
  if(String(original?.contentType).toLowerCase()!=='html'||!/<body\b[^>]*>/i.test(original.content||''))
    throw new Error('Graph did not provide a native HTML reply body; draft retained, nothing sent');
  const added='<div>'+html(text.replace(/\r\n?/g,'\n')).replace(/\n/g,'<br>')+'</div><br>';
  // Preserve the server-generated quote and its markup byte for byte.
  return {contentType:'HTML',content:original.content.replace(/<body\b[^>]*>/i,match=>match+added)};
}
const recipients=list=>list.map(r=>({emailAddress:{address:r.email,...(r.name?{name:r.name}:{})}}));
const addresses=list=>(list||[]).map(r=>r.emailAddress.address.toLowerCase()).sort();
export async function sendNativeReply(graph,args,onDraft=()=>{}) {
  if(typeof args.message_id!=='string'||!args.message_id.trim()||typeof args.text_content!=='string'||!args.text_content.trim())throw new Error('Original message ID and reply text are required');
  if(args.reply_all!=null&&typeof args.reply_all!=='boolean')throw new Error('reply_all must be boolean');
  for(const key of ['to','cc','bcc'])if(args[key]!=null&&(!Array.isArray(args[key])||args[key].some(r=>!r||typeof r.email!=='string'||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(r.email)||r.name!=null&&typeof r.name!=='string')))
    throw new Error('Invalid approved recipient list: '+key);
  const base=messagePath(args.message_id),headers={Prefer:'IdType="ImmutableId", outlook.body-content-type="html", outlook.timezone="Central Standard Time"'};
  // Create a reply, never a new message with a copied subject. This preserves native threading.
  const draft=await graph.request('POST',base+(args.reply_all?'/createReplyAll':'/createReply'),undefined,headers);
  if(!draft?.id||draft.isDraft!==true)throw new Error('No reply draft returned; nothing sent');
  onDraft(draft.id);
  const body=prependReply(draft.body,args.text_content),patch={body};
  for(const [input,field] of [['to','toRecipients'],['cc','ccRecipients'],['bcc','bccRecipients']])
    if(args[input]!=null)patch[field]=recipients(args[input]);
  const target=messagePath(draft.id);
  await graph.request('PATCH',target,patch,headers);
  // Verify the persisted draft, not just the locally assembled HTML or PATCH success.
  const actual=await graph.request('GET',target,undefined,headers);
  if(actual.isDraft!==true||actual.body?.content!==body.content||String(actual.body?.contentType).toLowerCase()!=='html')
    throw new Error('Persisted reply body differs; draft retained, nothing sent');
  for(const field of ['toRecipients','ccRecipients','bccRecipients']) {
    const expected=patch[field]??draft[field]??[];
    if(JSON.stringify(addresses(actual[field]))!==JSON.stringify(addresses(expected)))throw new Error('Reply recipients differ; draft retained, nothing sent');
  }
  if(!actual.toRecipients?.length)throw new Error('Reply has no recipient; draft retained, nothing sent');
  await graph.request('POST',target+'/send',undefined,headers);
  let verification;
  try {const sent=await graph.request('GET',target,undefined,headers);verification={status:sent.isDraft===false?'returned':'pending',message:sent};}
  catch(error){verification={status:'error',error:error.message,no_automatic_retry:true};}
  return {isError:false,structuredContent:{id:draft.id,status:'send_accepted',verification},content:[]};
}
