import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {root,read,write,checkProjects} from '../automation/files.mjs';
import {sniffImageMime} from '../agent/images.mjs';

const catalog='instruments/catalog.json';
export const instrumentCatalog=()=>read(catalog,{version:1,items:[]});
const inside=(base,file)=>{const rel=path.relative(base,file);return !!rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);};
function codePath(relative) {
  if(typeof relative!=='string' || !/^instruments\/programs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(py|m|md|txt)$/i.test(relative))throw new Error('代码必须位于 instruments/programs，且为 Python、MATLAB、Markdown 或文本文件');
  const base=fs.realpathSync(path.join(root,'instruments/programs')),file=fs.realpathSync(path.join(root,relative));
  if(!inside(path.join(root,'instruments'),base) || !inside(base,file) || !fs.statSync(file).isFile())throw new Error('不允许访问代码库以外的文件');
  if(fs.statSync(file).size>512*1024)throw new Error('单个代码文件不能超过 512 KB');
  return file;
}
export function instrumentCode(id,index) {
  const item=instrumentCatalog().items.find(i=>i.id===id);
  if(!/^\d+$/.test(String(index)) || !item?.code_paths?.[Number(index)])throw new Error('未找到已登记代码');
  const relative=item.code_paths[Number(index)],file=codePath(relative),bytes=fs.readFileSync(file);
  return {name:path.basename(file),path:relative,text:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex'),modified_at:fs.statSync(file).mtime.toISOString()};
}
function vscodeExe() {
  const dirs=(process.env.PATH || '').split(path.delimiter),found=dirs.map(d=>path.join(d,'code.cmd')).find(f=>fs.existsSync(f));
  const candidates=[found && path.join(path.dirname(found),'..','Code.exe'),process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe')].filter(Boolean);
  const exe=candidates.find(f=>fs.existsSync(f));
  if(!exe)throw new Error('找不到 VS Code（Code.exe）');
  return exe;
}
// Resolves once the process has started, rejects if it cannot start (a bare spawn would raise an unhandled 'error' event).
const start=(exe,args,cwd)=>new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,detached:true,stdio:'ignore'});
  child.once('error',e=>reject(new Error('无法启动 '+path.basename(exe)+'：'+e.message)));child.once('spawn',()=>{child.unref();resolve();});
});
function registered(id,index) {
  const item=instrumentCatalog().items.find(i=>i.id===id);
  if(!/^\d+$/.test(String(index)) || !item?.code_paths?.[Number(index)])throw new Error('未找到已登记代码');
  return {item,relative:item.code_paths[Number(index)]};
}
// Opens a registered file in the editor only; nothing is executed. The path must pass the same check as code reading.
export async function openInstrumentCode(id,index,launch=file=>start(vscodeExe(),[file],path.dirname(file))) {
  const file=codePath(registered(id,index).relative);await launch(file);
  return {opened:path.basename(file)};
}
// Starts a Python file that the card itself lists in run_paths (a GUI tool such as VISA Lite). Nothing else can be run from the page.
export async function runInstrumentCode(id,index,launch=file=>start('pythonw.exe',[file],path.dirname(file))) {
  const {item,relative}=registered(id,index);
  if(!item.run_paths?.includes(relative))throw new Error('这个文件没有被设置为可从图鉴运行');
  const file=codePath(relative);await launch(file);
  return {started:path.basename(file)};
}
export function saveInstrument(request) {
  const data=instrumentCatalog(),existing=request.id && data.items.find(i=>i.id===request.id);
  if(request.id && !existing)throw new Error('仪器不存在');
  if(existing && request.revision!==existing.revision)throw new Error('这张卡片已被更新，请关闭后重新打开编辑');
  const item={id:existing?.id || randomUUID()};
  for(const field of ['name','model','category','location','purpose','connection','experience','cautions','control_notes','reference_notes','source','sop_url','booking_url']) {
    if(request[field]!==undefined && typeof request[field]!=='string')throw new Error('字段必须为文本');
    item[field]=(request[field] || '').trim();
    if(item[field].length>6000)throw new Error('单个字段不能超过 6000 字符');
  }
  if(!item.name || item.name.length>120)throw new Error('请填写仪器名称（最多 120 字）');
  for(const field of ['sop_url','booking_url'])if(item[field] && !/^https?:\/\/[^\s]+$/i.test(item[field]))throw new Error('链接必须以 http:// 或 https:// 开头');
  item.project_ids=checkProjects(request.project_ids || []);
  if(!Array.isArray(request.code_paths) || request.code_paths.length>20)throw new Error('最多登记 20 个代码文件');
  item.code_paths=[...new Set(request.code_paths)];item.code_paths.forEach(codePath);
  item.run_paths=[...new Set(request.run_paths ?? existing?.run_paths ?? [])].filter(p=>item.code_paths.includes(p));
  if(item.run_paths.some(p=>!p.endsWith('.py')))throw new Error('只有 Python 文件可以设置为从图鉴运行');
  item.photo=request.photo || '';
  if(item.photo) {
    const match=typeof item.photo==='string' && item.photo.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match || match[2].length%4 || match[2].length>Math.ceil(2*1024*1024/3)*4)throw new Error('照片限 2 MB 的 PNG、JPEG 或 WebP');
    const bytes=Buffer.from(match[2],'base64');
    if(bytes.length>2*1024*1024 || sniffImageMime(bytes)!==match[1])throw new Error('照片内容或大小不符合要求');
  }
  item.created_at=existing?.created_at || new Date().toISOString();item.updated_at=new Date().toISOString();item.revision=randomUUID();
  if(existing)data.items[data.items.indexOf(existing)]=item;else data.items.push(item);
  write(catalog,data);return item;
}
