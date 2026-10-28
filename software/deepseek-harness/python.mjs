import fs from 'node:fs';
import path from 'node:path';

// The Windows workspace grant labels its tree Low, including the venv launcher.
// Starting that image lowers the SDK host token before it can manage the sandbox.
// Use the SAME venv's base interpreter and packages; the SDK still owns every
// model/tool policy, including workspace-write and native restricted-token spawn.
export function sdkPython(venv,{platform=process.platform}={}) {
  if(platform!=='win32')return {executable:path.join(venv,'bin/python'),environment:{}};
  const config=fs.readFileSync(path.join(venv,'pyvenv.cfg'),'utf8');
  const executable=/^executable\s*=\s*(.+)$/mi.exec(config)?.[1].trim();
  if(!executable || !path.isAbsolute(executable) || !fs.existsSync(executable))throw new Error('DeepSeek venv base Python is missing; recreate the installed venv');
  return {executable,environment:{PYTHONPATH:path.join(venv,'Lib/site-packages'),VIRTUAL_ENV:venv}};
}
