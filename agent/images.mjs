import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {root} from '../automation/files.mjs';
import {noticeText} from '../prompts/templates.mjs';
import {joinPrompt,promptSource} from '../prompts/compose.mjs';

export const IMAGE_LIMITS={count:4,each:6*1024*1024,total:12*1024*1024};
const formats={
  'image/png':{ext:'png',matches:b=>b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))},
  'image/jpeg':{ext:'jpg',matches:b=>b[0]===255 && b[1]===216 && b[2]===255},
  'image/webp':{ext:'webp',matches:b=>b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP'},
  'image/gif':{ext:'gif',matches:b=>/^GIF8[79]a$/.test(b.toString('ascii',0,6))}
};
export const sniffImageMime=bytes=>Object.entries(formats).find(([,format])=>format.matches(bytes))?.[0] || null;
// Accept bytes, not client-supplied paths. Validate the entire batch before writing anything.
export function decodeImages(images=[]) {
  if(!Array.isArray(images) || images.length>IMAGE_LIMITS.count)throw new Error('每条消息最多 4 张图片');
  let total=0;
  return images.map(image=>{
    const match=typeof image?.data_url==='string' && image.data_url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match || match[2].length%4)throw new Error('图片格式无效，请使用 PNG、JPEG、WebP 或 GIF');
    if(match[2].length>Math.ceil(IMAGE_LIMITS.each/3)*4)throw new Error('单张图片不能超过 6 MB');
    const mime=match[1],bytes=Buffer.from(match[2],'base64');total+=bytes.length;
    if(!bytes.length || bytes.length>IMAGE_LIMITS.each)throw new Error('单张图片不能超过 6 MB');
    if(total>IMAGE_LIMITS.total)throw new Error('图片总大小不能超过 12 MB');
    if(!formats[mime].matches(bytes))throw new Error('图片内容与格式不符');
    const id=randomUUID(),name=String(image.name || '剪贴板图片').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,120);
    return {id,name,mime,size:bytes.length,path:`.runtime/agent/images/${id}.${formats[mime].ext}`,bytes};
  });
}
export function saveImages(images) {
  if(images.length)fs.mkdirSync(path.join(root,'.runtime/agent/images'),{recursive:true});
  return images.map(({bytes,...image})=>{fs.writeFileSync(path.join(root,image.path),bytes);return image;});
}
export function imageContext(message) {
  const images=message?.attachments?.filter(a=>a.kind!=='file') || [];
  return images.length ? joinPrompt(['',noticeText.images(promptSource(images.map(a=>JSON.stringify({name:a.name,file:path.join(root,a.path)})).join('\n'),{path:'.runtime/agent/sessions.json',label:'上传图片记录'}))]) : '';
}
