import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const limit=3*1024*1024;
const mimeTypes={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.zip':'application/zip','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
// Local paths are the public input; fileParams tools need uploaded OpenAI file references on the wire.
export function readAttachment(file) {
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Attachment must be an absolute local file path');
  const stat=fs.statSync(file);
  if(!stat.isFile()||!stat.size||stat.size>=limit)throw new Error('Attachment must be a nonempty file smaller than 3 MB');
  const bytes=fs.readFileSync(file);
  if(!bytes.length||bytes.length>=limit)throw new Error('Attachment must be nonempty and smaller than 3 MB');
  const name=path.basename(file),mime=mimeTypes[path.extname(name).toLowerCase()]||'application/octet-stream';
  return {name,mime,bytes,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function uploadAttachment(file,tool,{fetchImpl=fetch,authPath=path.join(process.env.CODEX_HOME||path.join(process.env.USERPROFILE,'.codex'),'auth.json')}={}) {
  const auth=JSON.parse(fs.readFileSync(authPath,'utf8'));
  if(auth.auth_mode!=='chatgpt'||!auth.tokens?.access_token)throw new Error('Native ChatGPT login is required for attachment upload; no mail dispatched');
  const headers={Authorization:`Bearer ${auth.tokens.access_token}`,'Content-Type':'application/json',
    ...(auth.tokens.account_id?{'ChatGPT-Account-Id':auth.tokens.account_id}:{})};
  const base='https://chatgpt.com/backend-api/files';
  const request=async(url,options,stage)=>{
    const r=await fetchImpl(url,{...options,signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new Error(`Attachment ${stage} failed (HTTP ${r.status}); no mail dispatched, no automatic retry`);
    return r;
  };
  const created=await (await request(base,{method:'POST',headers,body:JSON.stringify({file_name:file.name,file_size:file.size,use_case:'codex',
    codex_connector_id:tool._meta?.connector_id,codex_action_name:tool.name.split('.').at(-1)})},'creation')).json();
  if(!created.file_id||typeof created.upload_url!=='string'||!created.upload_url.startsWith('https://'))throw new Error('Attachment creation returned no valid upload reference; no mail dispatched');
  await request(created.upload_url,{method:'PUT',headers:{'x-ms-blob-type':'BlockBlob','Content-Type':file.mime},body:file.bytes},'blob upload');
  const done=await (await request(`${base}/${encodeURIComponent(created.file_id)}/uploaded`,{method:'POST',headers,body:'{}'},'finalization')).json();
  if(typeof done.download_url!=='string'||!done.download_url.startsWith('https://'))throw new Error('Attachment finalization returned no download URL; no mail dispatched');
  return {file_id:created.file_id,download_url:done.download_url,file_name:file.name,mime_type:file.mime};
}
