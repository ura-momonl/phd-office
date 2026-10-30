import fs from 'node:fs';
import path from 'node:path';
import {root} from '../automation/files.mjs';

// An optional local resource package, not part of the distributed office code.
// Only public web assets are served; configuration, notes and tests stay private.
export function companionPackage(officeRoot=root) {
  let directory;
  try {
    const config=JSON.parse(fs.readFileSync(path.join(officeRoot,'dashboard/companion.local.json'),'utf8'));
    if(typeof config.directory!=='string' || !config.directory.trim())return null;
    directory=path.resolve(officeRoot,config.directory);
    if(!fs.statSync(path.join(directory,'index.html')).isFile())return null;
  } catch {return null;}
  const assets=new Map();
  const visit=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.name.startsWith('.') || entry.name==='tests' || entry.isSymbolicLink())continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())visit(file);
      else if(entry.isFile() && /\.(html|js|css|png)$/.test(entry.name)) {
        const rel=path.relative(directory,file).split(path.sep).join('/');
        assets.set('/companion/'+rel,file);
      }
    }
  };
  visit(directory);
  return {directory,assets};
}
