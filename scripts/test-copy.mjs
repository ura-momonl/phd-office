import path from 'node:path';
import fs from 'node:fs';

export function removeTestCopy(directory,tempRoot) {
  const target=path.resolve(directory);
  if(path.dirname(target)!==path.resolve(tempRoot) || !path.basename(target).startsWith('phd-tests-'))throw new Error('Unsafe test-copy cleanup target');
  // A copy may hold a junction to the real node_modules (see freshTestCopy): drop the link itself first, never recurse into the target.
  try {if(fs.lstatSync(path.join(target,'node_modules')).isSymbolicLink())fs.unlinkSync(path.join(target,'node_modules'));} catch {/* no link */}
  fs.rmSync(target,{recursive:true,force:true});
}

export function freshTestCopy(template,tempRoot) {
  const directory=fs.mkdtempSync(path.join(tempRoot,'phd-tests-'));
  try {
    fs.cpSync(template,directory,{recursive:true});
    // node_modules is not copied (large); packages that tests import (yaml, lancedb, jieba...) resolve through a junction to the real one.
    const modules=new URL('../node_modules',import.meta.url);
    if(fs.existsSync(modules) && !fs.existsSync(path.join(directory,'node_modules')))fs.symlinkSync(modules,path.join(directory,'node_modules'),'junction');
    return directory;
  }
  catch(error){removeTestCopy(directory,tempRoot);throw error;}
}

// Test fixtures create their own payloads. Keep the project identities and framework
// baseline, not real measurements/CAD/deliverables or generated-artifact history.
const skip=new Set(['.runtime','.probe-tmp','node_modules','vendor','.git','.claude','outbox','inbox']);
export function includeTestFile(source,file) {
  const relative=path.relative(source,file),parts=relative.split(path.sep),name=path.basename(file);
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))return false;
  if(relative.split(path.sep).join('/')==='dashboard/companion.local.json')return false;
  if(['output','tmp'].includes(parts[0]))return false;
  if(parts[0]==='workspace' && parts[1]==='archives')return false; // dated reset snapshots (12.9 GB on 2026-10-21); tests build their own
  if(parts[0]==='literature' && ['fulltext','archive'].includes(parts[1]))return false;
  if(parts[0]==='literature' && parts[1]==='recommendations')return false;
  if(parts[0]==='instruments' && parts[1]==='catalog.json')return false;
  if(parts[0]==='instruments' && parts[1]==='programs') {
    if(parts.some(p=>['data','__pycache__'].includes(p)))return false;
    if(parts.length>3)return /\.(py|md|m|txt)$/i.test(name);
  }
  if(parts[0]==='workspace' && parts[1]==='projects' && parts.length>3)
    return parts.length===4 && ['README.md','FRAMEWORK.md'].includes(name);
  return (!skip.has(name) || (name==='vendor' && path.dirname(file)===path.join(source,'dashboard'))) && !/\.(sqlite|log)$/.test(name);
}
