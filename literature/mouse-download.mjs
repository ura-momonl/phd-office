// Local I/O for the explicit desktop macro. No network, models, or desktop polling.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {root, read, input} from '../automation/files.mjs';
import {normalizeDOI} from './run.mjs';
import {registerDownload} from './register-download.mjs';

export function macroStatus(directory) {
  const dir=path.resolve(directory), file=path.join(dir,'progress.json');
  if(!fs.existsSync(file)) return {status:'not_started',directory:dir};
  const state=input(file);
  let alive=false;
  try {process.kill(state.pid,0);alive=true;} catch(e) {if(e.code==='EPERM') alive=true;}
  const active=['running','starting','waiting_focus','waiting_browser','waiting_error','waiting_access','retrying'];
  const age_seconds=Math.max(0,(Date.now()-Date.parse(state.updated_at))/1000);
  return {...state,...(active.includes(state.status)&&!alive?{status:'interrupted',last_status:state.status}:{}),
    alive,heartbeat_age_seconds:Math.round(age_seconds),...(active.includes(state.status)&&alive&&age_seconds>120?{stalled:true}:{}),directory:dir};
}
export function macroStop(directory) {
  const dir=path.resolve(directory);
  if(!fs.existsSync(path.join(dir,'progress.json'))) throw Error('No macro run at this directory');
  fs.writeFileSync(path.join(dir,'STOP'),'User requested stop\n');
  return {...macroStatus(dir),stop_requested:true};
}
export function localPaper(value,file) {
  const doi=normalizeDOI(value), p=read('literature/catalog.json').papers.find(p=>p.doi===doi);
  if(!p) throw Error('DOI is not registered in the library');
  if(file) return registerDownload(doi,file,'publisher site (browser macro, existing browser access)');
  // Reuse even an orphan created before a crash; registration rechecks identity and never overwrites.
  const canonical=path.join(root,'literature/fulltext',p.id+'.pdf');
  const existing=p.fulltext_path&&fs.existsSync(p.fulltext_path)?p.fulltext_path:fs.existsSync(canonical)?canonical:null;
  return existing?registerDownload(doi,existing,p.fulltext_source||'verified existing local PDF before browser macro'):{doi,status:'missing'};
}
// Keep a rejected paper separate from shared I/O/parser failures. Both still
// refuse registration; only the latter should hold the queue for recovery.
export function macroLocalError(error) {
  const infrastructure=error?.code || ['parser_unavailable','parser_permission_denied'].includes(error?.pdf_reason)
    || [3221225794,3221226505].includes(error?.parser_exit_code);
  const paper=!infrastructure && (error?.pdf_reason || /^(File is not a complete PDF|PDF hash differs|Requested DOI is not verified|arXiv PDF ID\/version|DOI is not registered)/.test(error?.message||''));
  return {status:paper?'validation_failed':'error',message:error?.message||String(error),
    ...(error?.code?{code:error.code}:{}),...(error?.pdf_reason?{pdf_reason:error.pdf_reason}:{}),
    ...(Number.isInteger(error?.parser_exit_code)?{parser_exit_code:error.parser_exit_code}:{})};
}
export function macroCommand(request) {
  if(request.action==='status') return macroStatus(request.directory);
  if(request.action==='stop') return macroStop(request.directory);
  throw Error('macro <JSON file>: {action:"status"|"stop",directory}; start/resume with powershell -NoProfile -File literature/mouse-download.ps1 -RequestFile <JSON file>');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,arg,file]=process.argv.slice(2);
    const result=action==='local'?localPaper(arg,file):action==='status'?macroStatus(arg):action==='stop'?macroStop(arg):macroCommand(input(arg));
    console.log(JSON.stringify(result));
  } catch(e) {console.log(JSON.stringify(macroLocalError(e)));process.exitCode=1;}
}
