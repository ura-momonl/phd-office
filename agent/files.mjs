import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {root} from '../automation/files.mjs';
import {imageContext} from './images.mjs';
import {noticeText} from '../prompts/templates.mjs';
import {joinPrompt,promptSource} from '../prompts/compose.mjs';

export const FILE_LIMITS={count:10,each:20*1024*1024,total:30*1024*1024};
// Only uploaded bytes are accepted; a filename never chooses the destination.
export function decodeFiles(files=[]) {
  if(!Array.isArray(files) || files.length>FILE_LIMITS.count)throw new Error('每条消息最多 10 个文件（图片另计）');
  let total=0;
  return files.map(file=>{
    const match=typeof file?.data_url==='string' && file.data_url.match(/^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/);
    if(!match || match[2].length%4)throw new Error('文件数据无效，请重新选择文件');
    if(match[2].length>Math.ceil(FILE_LIMITS.each/3)*4)throw new Error('单个文件不能超过 20 MB');
    const bytes=Buffer.from(match[2],'base64');total+=bytes.length;
    if(bytes.toString('base64')!==match[2])throw new Error('文件数据无效，请重新选择文件');
    if(bytes.length>FILE_LIMITS.each)throw new Error('单个文件不能超过 20 MB');
    if(total>FILE_LIMITS.total)throw new Error('文件总大小不能超过 30 MB（图片另计）');
    const name=String(file.name || '附件').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180) || '附件';
    const ext=path.extname(name),suffix=/^\.[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : '';
    const id=randomUUID();
    return {id,kind:'file',name,mime:'application/octet-stream',size:bytes.length,path:`.runtime/agent/files/${id}${suffix}`,bytes};
  });
}
export function saveFiles(files) {
  if(files.length)fs.mkdirSync(path.join(root,'.runtime/agent/files'),{recursive:true});
  return files.map(({bytes,...file})=>{fs.writeFileSync(path.join(root,file.path),bytes);return file;});
}
export function attachmentContext(message) {
  const files=message?.attachments?.filter(a=>a.kind==='file') || [];
  return joinPrompt([imageContext(message),files.length ? joinPrompt(['',noticeText.files(promptSource(files.map(a=>JSON.stringify({name:a.name,file:path.join(root,a.path),size:a.size})).join('\n'),{path:'.runtime/agent/sessions.json',label:'上传文件记录'}))]) : ''],'');
}
