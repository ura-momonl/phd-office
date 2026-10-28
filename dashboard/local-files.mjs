import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {canOpenInDefaultApp} from './local-file-types.js';

// Read-only access to files an assistant names in chat. The page is localhost-only (plus the tailnet
// forwarder) and requests are same-origin checked. 2026-10-20: the user lifted the folder limit, so any
// local drive path may be opened; credentials and the office's internal state stay closed.
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel==='' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));};
const DENIED_NAME=/(^\.env|\.env$|\.pem$|\.key$|\.pfx$|\.p12$|\.sqlite3?$|\.db$|^id_rsa|credential|secret|token)/i;
const INLINE={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf'};
const TEXT=new Set(['.txt','.md','.csv','.tsv','.json','.log','.py','.m','.mjs','.js','.ps1','.bat','.yaml','.yml','.toml','.ini','.tex','.bib','.xml']);

// This one registered credential may be edited locally, never served over HTTP.
const editableCredential=real=>real.toLowerCase()===path.join(fs.realpathSync.native(root),'.runtime/commandcode/credentials.json').toLowerCase();
export function resolveLocalFile(input,{nativeEdit=false}={}) {
  const raw=String(input ?? '').trim();
  if(!/^[A-Za-z]:[\\/]/.test(raw) || raw.includes('\0'))throw new Error('只能打开本机盘符下的绝对路径');
  const file=path.win32.resolve(raw);
  let real;
  try {real=fs.realpathSync.native(file);} catch {throw new Error('文件不存在：'+file);}
  // Check the real path (after junctions/symlinks) so a link cannot hide an internal folder.
  const segments=real.split(/[\\/]/).map(p=>p.toLowerCase());
  if(!(nativeEdit && editableCredential(real)) && !zoteroStoragePdf(real) && (segments.some(p=>p==='.runtime' || p==='.git' || p==='node_modules') || DENIED_NAME.test(path.basename(real))))throw new Error('出于安全，这类内部文件不提供打开');
  return real;
}

// Zotero's attachment store lives under .runtime and holds the registered fulltext PDFs of ~600 papers.
// Only PDFs inside that one folder are exempt; the Zotero database and everything else in .runtime stay closed.
function zoteroStoragePdf(real) {
  try {
    const storage=fs.realpathSync.native(path.join(root,'.runtime/zotero-pilot/data/storage')).toLowerCase();
    return path.extname(real).toLowerCase()==='.pdf' && inside(storage,real.toLowerCase()) && real.toLowerCase()!==storage;
  } catch {return false;}
}

// Inline only types that cannot run script in the dashboard's origin; everything else downloads.
export function localFileHeaders(file) {
  const ext=path.extname(file).toLowerCase(),name=encodeURIComponent(path.basename(file));
  // The browser's PDF viewer does not run under a sandbox CSP; a PDF cannot script this origin.
  const common={'X-Content-Type-Options':'nosniff',...(ext==='.pdf' ? {} : {'Content-Security-Policy':'sandbox'})};
  if(INLINE[ext])return {...common,'Content-Type':INLINE[ext],'Content-Disposition':`inline; filename*=UTF-8''${name}`};
  if(TEXT.has(ext))return {...common,'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`inline; filename*=UTF-8''${name}`};
  return {...common,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${name}`};
}

// A compatibility name, not a public static directory. Both reads and native
// opens still use the real-path/credential rules above, including symlinks.
export function resolveWorkspaceFile(urlPath) {
  const decoded=decodeURIComponent(String(urlPath));
  if(!decoded.startsWith('/workspace/') || /[\\\0]/.test(decoded))throw new Error('无效的工作区链接');
  const workspace=path.join(root,'workspace'),candidate=path.resolve(root,'.'+decoded);
  if(!inside(workspace,candidate))throw new Error('工作区链接不能越界');
  const real=resolveLocalFile(candidate);
  if(!inside(fs.realpathSync.native(workspace).toLowerCase(),real.toLowerCase()))throw new Error('工作区链接不能越界');
  return real;
}

// A click launches a document through the current user's Windows association.
// The constant script receives a literal filename via the environment, never
// cmd.exe, a command built from the filename, or an execution-policy bypass.
export async function openInDefaultApp(input,{run=execFile,platform=process.platform}={}) {
  if(platform!=='win32')throw new Error('默认软件打开仅支持 Windows');
  const real=resolveLocalFile(input,{nativeEdit:true});
  if(!fs.statSync(real).isFile() || !canOpenInDefaultApp(real))throw new Error('此文件类型不允许通过默认软件打开，请使用浏览器预览或下载');
  const target=editableCredential(real)
    ? "$s.FileName=Join-Path $env:SystemRoot 'System32\\notepad.exe'; $s.Arguments='\"'+$env:OFFICE_LOCAL_OPEN_PATH+'\"';"
    : '$s.FileName=$env:OFFICE_LOCAL_OPEN_PATH;';
  const script="$ErrorActionPreference='Stop'; $s=New-Object System.Diagnostics.ProcessStartInfo; "+target+" $s.UseShellExecute=$true; $s.Verb='open'; [void][System.Diagnostics.Process]::Start($s)";
  const exe=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((resolve,reject)=>run(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {cwd:path.dirname(real),windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,OFFICE_LOCAL_OPEN_PATH:real}},
    (error,stdout,stderr)=>error ? reject(new Error('默认软件打开失败：'+(String(stderr || '').trim() || error.message))) : resolve()));
  return {started:true,path:real}; // Association accepted, not proof of a visible app or completed work.
}

// The phone reaches the dashboard through the Tailscale forwarder on this machine: the connection is
// loopback, but the Host is the tailnet name (*.ts.net) or tailnet address (100.64.0.0/10). Only the
// tailnet owner controls those names, so a foreign web page (DNS rebinding) never matches.
export function tailnetHost(host) {
  const name=String(host ?? '').replace(/:\d+$/,'').toLowerCase();
  if(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name))return true;
  const ip=/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  return !!ip && Number(ip[1])>=64 && Number(ip[1])<=127;
}
// Same-origin links and address-bar visits only (this machine or the tailnet); cross-site requests are refused.
// Reading only: opening Explorer (localActionAllowed) stays limited to this machine.
export function localFileRequestAllowed(req,port) {
  const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const host=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(req.headers.host) || tailnetHost(req.headers.host);
  const site=req.headers['sec-fetch-site'];
  return loopback && host && (site===undefined || site==='same-origin' || site==='none');
}

// Show a file selected in Explorer, or open a folder. Same path rules as reading; the argument is one verbatim
// string handed to explorer.exe without a shell, so the path cannot add switches or commands.
export function revealInExplorer(input,{launch=spawn,platform=process.platform}={}) {
  if(platform!=='win32')throw new Error('资源管理器只在 Windows 上可用');
  const real=resolveLocalFile(input);
  if(real.includes('"'))throw new Error('路径含引号，无法打开');
  const arg=fs.statSync(real).isDirectory() ? `"${real}"` : `/select,"${real}"`;
  const child=launch(path.join(process.env.SystemRoot || 'C:\Windows','explorer.exe'),[arg],{detached:true,stdio:'ignore',windowsVerbatimArguments:true,windowsHide:false});
  child.on?.('error',()=>{});child.unref?.(); // explorer.exe exits quickly and with code 1 even on success; spawned is not proof of display.
  return {started:true,path:real};
}

// A state-changing local request: loopback, exact Host, and same-origin Origin (the form post of a listing page included).
export function localActionAllowed(req,port) {
  const host=req.headers.host;
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && [`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(host) && req.headers.origin===`http://${host}` && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']==='same-origin');
}
