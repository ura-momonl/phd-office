import fs from 'node:fs';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {decodeImages} from '../agent/images.mjs';

// An avatar the user uploaded (already cropped in the browser) replaces the shipped one for that person. The shipped files in
// dashboard/avatars are never touched, so "还原默认" just deletes the upload. dashboard/avatars/view.json remembers who has one.
const FILE='dashboard/avatars/view.json',CUSTOM='dashboard/avatars/custom';
export const WHO=['user','codex','claude','deepseek'];
export function avatarView() {
  let saved={};try {saved=JSON.parse(fs.readFileSync(path.join(root,FILE),'utf8'));} catch {/* nothing uploaded yet */}
  return Object.fromEntries(WHO.map(who=>[who,saved[who]?.custom ? {custom:saved[who].custom,v:saved[who].v} : {}]));
}
export const customFile=who=>{const ext=avatarView()[who]?.custom;return ext ? path.join(root,CUSTOM,`${who}.${ext}`) : null;};
export function setCustomAvatar(who,dataUrl) {
  if(!WHO.includes(who))throw new Error('未知头像：'+who);
  const view=avatarView(),old=customFile(who);
  if(old)fs.rmSync(old,{force:true});
  if(dataUrl===null)view[who]={};
  else {
    const [image]=decodeImages([{data_url:dataUrl,name:'avatar'}]);
    if(!['image/png','image/jpeg','image/webp'].includes(image.mime))throw new Error('头像请用 PNG、JPEG 或 WebP');
    const ext=image.mime==='image/png' ? 'png' : image.mime==='image/webp' ? 'webp' : 'jpg';
    fs.mkdirSync(path.join(root,CUSTOM),{recursive:true});
    fs.writeFileSync(path.join(root,CUSTOM,`${who}.${ext}`),image.bytes);
    view[who]={custom:ext,v:Date.now()};
  }
  fs.writeFileSync(path.join(root,FILE),JSON.stringify(view,null,2)+'\n');
  return view;
}
// Pages show an avatar through <img data-who="..."> with its shipped src; this stylesheet swaps in the upload.
export function avatarCss() {
  const view=avatarView();
  return WHO.filter(who=>view[who].custom).map(who=>`img[data-who="${who}"]{content:url(/avatars/custom/${who}?v=${view[who].v})}`).join('\n')+'\n';
}
