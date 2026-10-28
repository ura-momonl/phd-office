import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const downloadTools = [
  {name:'microsoft_outlook_email.list_attachments_native',description:'List all attachment metadata, including inline images, through the configured Graph mailbox. Does not rely on hasAttachments or return file payloads.',
    inputSchema:{type:'object',properties:{message_id:{type:'string'}},required:['message_id']},annotations:{readOnlyHint:true}},
  {name:'microsoft_outlook_email.download_attachment_native',description:'Save one file attachment or inline image to a new local office file. Returns path, bytes, SHA256 and content_id for cid: matching, never base64. No mailbox writes, remote-image loading, or automatic retries.',
    inputSchema:{type:'object',properties:{message_id:{type:'string'},attachment_id:{type:'string'}},required:['message_id','attachment_id']},annotations:{readOnlyHint:true}}
];
const opaque = value => {
  if(typeof value!=='string'||!value.trim())throw new Error('A non-empty exact message/attachment ID is required');
  return encodeURIComponent(value);
};
const attachmentPath = id => '/me/messages/'+opaque(id)+'/attachments';
const metadata = a => ({id:a.id,name:a.name,content_type:a.contentType,size:a.size,is_inline:a.isInline===true,
  content_id:a.contentId??null,type:a['@odata.type']??null});

export async function listAttachments(graph,messageId) {
  const base=attachmentPath(messageId),value=[],seen=new Set();
  let target=base+'?$select=id,name,contentType,size,isInline';
  while(target) {
    if(seen.has(target))throw new Error('Attachment pagination repeated; no automatic retry');
    seen.add(target);
    const page=await graph.request('GET',target);
    if(!Array.isArray(page?.value))throw new Error('Graph returned no attachment list');
    value.push(...page.value.map(metadata));
    target=null;
    if(page['@odata.nextLink']) {
      const next=new URL(page['@odata.nextLink']);
      if(next.origin!=='https://graph.microsoft.com'||next.pathname!=='/v1.0'+base||next.hash||next.username||next.password)
        throw new Error('Unexpected attachment pagination target');
      target=base+next.search;
    }
  }
  return {message_id:messageId,value};
}

function downloadDirectory(root) {
  // Check each existing parent before creating descendants; never follow a junction outside the office.
  const office=fs.realpathSync(root);
  let dir=office;
  for(const name of ['output','mail-attachments']) {
    const next=path.join(dir,name);
    if(!fs.existsSync(next))fs.mkdirSync(next);
    const actual=fs.realpathSync(next),relative=path.relative(office,actual);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Mail download directory is outside the office');
    dir=actual;
  }
  return fs.mkdtempSync(path.join(dir,'attachment-'));
}
function safeName(name) {
  const base=path.win32.basename(path.posix.basename(String(name||'attachment.bin')))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,160).replace(/[. ]+$/g,'');
  return !base||/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(base)?'file-'+(base||'attachment.bin'):base;
}
export async function downloadAttachment(graph,root,{message_id,attachment_id}) {
  const target=attachmentPath(message_id)+'/'+opaque(attachment_id);
  const a=await graph.request('GET',target);
  if(a?.id!==attachment_id)throw new Error('Attachment ID does not match; no local file saved');
  if(a['@odata.type']!=='#microsoft.graph.fileAttachment')throw new Error('Only file attachments and inline file images can be downloaded; linked/reference and item attachments are not file bytes');
  if(typeof a.contentBytes!=='string')
    throw new Error('Graph returned no valid attachment content; no local file saved');
  const bytes=Buffer.from(a.contentBytes,'base64'),sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.toString('base64')!==a.contentBytes)throw new Error('Graph returned invalid attachment base64; no local file saved');
  // Graph size is the attachment record size, not necessarily the exact payload length.
  const file=path.join(downloadDirectory(root),safeName(a.name));
  fs.writeFileSync(file,bytes,{flag:'wx'});
  const saved=fs.readFileSync(file);
  if(saved.length!==bytes.length||createHash('sha256').update(saved).digest('hex')!==sha256)throw new Error('Downloaded file readback differs');
  return {...metadata(a),message_id,path:file,bytes:saved.length,sha256};
}
