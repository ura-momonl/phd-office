// One snapshot/diff mechanism, two baselines: process startup and each assistant's submitted work turn.
// No watcher, model call, file contents in telemetry, or automatic restart.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './files.mjs';
import {noticeText} from '../prompts/templates.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const relative=(base,file)=>path.relative(base,file).split(path.sep).join('/');
const inside=(base,file)=>{const p=path.relative(base,file);return p!=='..' && !p.startsWith('..'+path.sep) && !path.isAbsolute(p);};
const textTypes=/\.(mjs|js|json|md|txt|csv|tsv|py|ps1|cmd|vbs|cs|html|css|svg|yaml|yml|toml)$/i;

export function captureFiles(base,paths,{ignore=()=>false,contentOnly=false}={}) {
  const files=Object.create(null),errors=[];
  const visit=file=>{
    const name=relative(base,file);
    if(!inside(base,file) || ignore(name))return;
    try {
      const stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())return; // Never follow links into personal stores or another workspace.
      if(stat.isDirectory())for(const entry of fs.readdirSync(file).sort())visit(path.join(file,entry));
      else if(stat.isFile())files[name]=contentOnly || (textTypes.test(name) && stat.size<=1024*1024)
        ? hash(fs.readFileSync(file)) : `stat:${stat.size}:${stat.mtimeMs}`;
    } catch(error) {if(error.code!=='ENOENT')errors.push(name || '.');}
  };
  for(const p of paths)visit(path.resolve(base,p));
  return {files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))),errors:errors.sort()};
}
const affectedByError=(snapshot,file)=>snapshot.errors.some(p=>p==='.' || file===p || file.startsWith(p+'/'));
export function compareFiles(previous,current) {
  if(!previous)return [];
  return [...new Set([...Object.keys(previous.files),...Object.keys(current.files)])].sort().flatMap(file=>{
    if(affectedByError(previous,file) || affectedByError(current,file) || previous.files[file]===current.files[file])return [];
    return [{path:file,kind:!Object.hasOwn(previous.files,file) ? 'added' : !Object.hasOwn(current.files,file) ? 'deleted' : 'modified'}];
  });
}

// output/, tmp/ and workspace/archives hold bulk task output (tens of thousands of files); hashing them synchronously each work turn blocked the backend for seconds.
const ignoredDirs=new Set(['.runtime','node_modules','vendor','.git','.claude','.codex','NVIDIA Corporation']);
export function officeFiles() {
  return captureFiles(root,['.'],{ignore:name=>name.split('/').some(p=>ignoredDirs.has(p) || (p.startsWith('.') && p!=='.agents')) ||
    /^workspace\/(memory|inbox|outbox|archives)(\/|$)/.test(name) || /^(output|tmp)(\/|$)/.test(name) ||
    name==='workspace/MEMORY.md' || name==='work/queue.json' ||
    /(^|\/)STATUS\.md$/.test(name) || /(^|\/)\.env(?:\.|$)|\.(?:log|sqlite(?:-wal|-shm)?|tmp|bak|lock|local\.json)$/i.test(name) ||
    (!/\.(?:mjs|js|py|ps1|cs)$/i.test(name) && /(^|\/)(?:.*[._-])?(?:credentials?|secrets?|tokens?|auth)(?:[._-]|$)/i.test(name))});
}
const labels={added:'新增',modified:'修改',deleted:'删除'};
export function fileChangesText(previous,current,report) {
  if(!previous)return ''; // First encounter establishes a baseline, not a claim about past changes.
  const changes=compareFiles(previous,current),lines=changes.slice(0,12).map(c=>`${labels[c.kind]} ${JSON.stringify(c.path)}`);
  const unknown=current.errors.length || previous.errors.length;
  if(!lines.length && !unknown)return '';
  return noticeText.fileChanges({lines:lines.join('\n'),extra:changes.length>12 ? changes.length-12 : 0,report:report ? JSON.stringify(report) : '',unknown});
}

// Common work-turn interface: capture before work, publish paths only, commit snapshot only on native submission acknowledgment.
// The caller owns the independent session/assistant baseline and the per-turn report location.
export function prepareFileNotice(previous,report) {
  const snapshot=officeFiles();
  return {snapshot,text:previous ? fileChangesText(previous,snapshot,report) :
    noticeText.firstSnapshot(),
    report:{baseline:!!previous,changes:compareFiles(previous,snapshot),errors:snapshot.errors}};
}

// Follow the local literal ESM imports used by this office. Bare packages are represented by the lockfile;
// the CLI registry is loaded once, whereas business data/configs read by their owners remain live data.
export function backendFiles() {
  const paths=new Set(['automation/run.mjs','automation/config.json','package.json','package-lock.json','prompts/office-system.md']);
  const seen=new Set(),errors=[];
  const visit=file=>{
    if(seen.has(file))return;seen.add(file);paths.add(relative(root,file));
    try {
      const text=fs.readFileSync(file,'utf8');
      const imports=/(?:\b(?:import|export)\s+[^;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
      for(const [,ref] of text.matchAll(imports)) {
        const next=path.resolve(path.dirname(file),ref);
        if(inside(root,next) && next.endsWith('.mjs'))visit(next);
      }
    } catch(error) {if(error.code!=='ENOENT')errors.push(relative(root,file));}
  };
  visit(path.join(root,'dashboard/server.mjs'));
  const snapshot=captureFiles(root,[...paths],{contentOnly:true});
  snapshot.errors=[...new Set([...snapshot.errors,...errors])].sort();
  return snapshot;
}
const fingerprint=snapshot=>hash(JSON.stringify(snapshot.files));
const boot=backendFiles(); // Fixed for this process lifetime; never replaced with a later disk version.
export function runtimeCodeStatus() {
  const disk=backendFiles(),loaded=fingerprint(boot),current=fingerprint(disk);
  return {loaded,disk:current,state:boot.errors.length || disk.errors.length ? 'unknown' : loaded===current ? 'current' : 'stale',changed:compareFiles(boot,disk)};
}
export function runtimeCodeText(code) {
  const loaded=code.loaded.slice(0,10),disk=code.disk.slice(0,10);
  if(code.state==='current')return noticeText.codeCurrent(loaded,disk);
  if(code.state==='unknown')return noticeText.codeUnknown(loaded,disk);
  return noticeText.codeBehind(loaded,disk,code.changed.slice(0,6).map(c=>JSON.stringify(c.path)).join('、')+(code.changed.length>6 ? ' 等' : ''));
}
