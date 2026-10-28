// Run tests only in sanitised throw-away copies, never against the real project.
// Default: discover all *.test.mjs except Docker's explicit --sandbox suite.
// --help lists focused modes; --list prints the selection without creating copies.
// --files=path.test.mjs,... reruns selected files, plus the runner's own checks.
// --jobs=N runs 1..8 files at once (default full=4, focused=1). Every file gets a
// fresh baseline copy and Node process. --keep retains copies; complete logs survive either way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { includeTestFile,freshTestCopy,removeTestCopy } from './test-copy.mjs';
import { pdfTextExecutable } from '../literature/pdf-tools.mjs';
import {selectTests,discoverTests,modes,testSummary,testPassed} from './test-suite.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const selection=selectTests(source,process.argv.slice(2));
const {files,keep}=selection;
if(selection.help) {
  console.log('Usage: node scripts/run-tests.mjs [--keep] [--jobs=1..8] [--list] [--files=path.test.mjs,... | focused mode]');
  console.log('Default: all discovered tests except --sandbox (requires Docker). No models or external services.');
  for(const [mode,[description]] of Object.entries(modes))console.log('  --'+mode+'  '+description);
  process.exit(0);
}
if(selection.list){console.log(files.join('\n'));console.log(`Selected ${files.length} files (${selection.mode}, jobs=${selection.jobs}); Docker is opt-in via --sandbox.`);process.exit(0);}
// Test copies and fixtures go beside the project (same drive), not C: Temp, which filled up on 2026-10-21.
// Children inherit these variables, so the whole run is redirected. Override with OFFICE_TEST_TMP.
const testTmp=path.resolve(process.env.OFFICE_TEST_TMP || path.join(source,'..','.test-tmp'));
fs.mkdirSync(testTmp,{recursive:true});
process.env.TEMP=process.env.TMP=process.env.TMPDIR=testTmp;
// Copies left by --keep or an interrupted run were never reclaimed; drop those untouched for a day (fresh --keep scenes stay).
for(const entry of fs.readdirSync(os.tmpdir(),{withFileTypes:true})) {
  const old=path.join(os.tmpdir(),entry.name);
  if(entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('phd-tests-') && Date.now()-fs.statSync(old).mtimeMs>864e5)fs.rmSync(old,{recursive:true,force:true});
}
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'phd-tests-'));
const started=performance.now();
const copiedPaths=[];
const extraCopies=[]; // one writable copy per file; the initial copy stays pristine
try {
  // 1. code, actual UI assets and project framework baselines; no payload/output history.
  fs.cpSync(source, copy, { recursive: true, filter: file => {
    const include=includeTestFile(source,file);
    if(include)copiedPaths.push(path.relative(source,file).split(path.sep).join('/'));
    return include;
  } });
  const copied=performance.now();
  console.log(`copy_ms: ${(copied-started).toFixed(1)}`);
  // workspace/inbox and workspace/outbox hold real drafts; the filter above skipped them by name
  const rj = f => JSON.parse(fs.readFileSync(path.join(copy, f), 'utf8').replace(/^﻿/, ''));
  const wj = (f, v) => fs.writeFileSync(path.join(copy, f), JSON.stringify(v, null, 2) + '\n');

  // 2. no real tasks, quotes, links or generated pages; fictional fixtures where a test needs a record
  const queue = rj('work/queue.json'); queue.items = []; wj('work/queue.json', queue);
  wj('work/turns.json', { version: queue.version, items: [] }); // tests run on the split queue the live office uses
  const catalog = rj('projects/catalog.json'); catalog.links = [];
  const clearFiles=owner=>{delete owner.files;for(const node of owner.plan || owner.children || [])clearFiles(node);};
  for(const project of catalog.projects)clearFiles(project);
  wj('projects/catalog.json', catalog);
  fs.rmSync(path.join(copy, 'calendar/events.json'), { force: true });
  const literature = rj('literature/catalog.json'); literature.papers = []; wj('literature/catalog.json', literature);
  const literatureSources=rj('literature/sources.json');if(literatureSources.daily_recommendations)literatureSources.daily_recommendations.enabled=false;wj('literature/sources.json',literatureSources);
  const vendor = (name, total) => ({ name, quote_number: 'F-1', currency: 'USD', quoted_total: total, shipping_included: null, tax_included: null, lead_time: null, valid_until: null, technical_match: '待核对', source: 'fixture' });
  const procurement = rj('procurement/catalog.json');
  procurement.requests = [
    { id: 'high-vac-pumps', title: '示例采购 A（虚构）', specifications: [], required_by: null, mail_task_id: 'fixture-a', vendors: [vendor('Vendor A', 4094.02)], notes: 'fixture' },
    { id: 'glenair-parts', title: '示例采购 B（虚构）', specifications: [], required_by: null, mail_task_id: 'fixture-b', vendors: [vendor('Vendor B', null)], notes: 'fixture' }];
  wj('procurement/catalog.json', procurement);
  const mailConfig = rj('mail-flow/config.json'); mailConfig.account = 'tests@example.org'; wj('mail-flow/config.json', mailConfig);
  fs.writeFileSync(path.join(copy, 'mail-flow/legacy-seeds.json'), '[]\n');
  for (const f of ['VERIFICATION.md', 'automation/CHANGELOG.md']) fs.rmSync(path.join(copy, f), { force: true });
  const projectsDir = path.join(copy, 'workspace/projects');
  if (fs.existsSync(projectsDir)) for (const d of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, d, 'STATUS.md'), { force: true });
  // The copy has no real tasks, so the task ids that real log entries point to (the node meta 'work' field) would dangle: drop only that field.
  if (fs.existsSync(projectsDir)) for (const d of fs.readdirSync(projectsDir)) {
    const file = path.join(projectsDir, d, 'FRAMEWORK.md'); if (!fs.existsSync(file)) continue;
    const eol = String.fromCharCode(10), cr = String.fromCharCode(13);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(eol).map(line => {
      const tail = line.endsWith(cr) ? cr : '', bare = tail ? line.slice(0, -1) : line;
      if (!bare.startsWith('<!--node {') || !bare.endsWith('}-->')) return line;
      const meta = JSON.parse(bare.slice(9, -3)); if (!('work' in meta)) return line;
      delete meta.work; return '<!--node ' + JSON.stringify(meta) + '-->' + tail;
    }).join(eol));
  }

  // 3. no model can be started from the copy
  const config = rj('agent/config.json'); Object.assign(config, { enabled: false, memory_v2: { ...config.memory_v2, enabled: false, auto: { ...config.memory_v2?.auto, enabled: false } }, automatic_mail_judgment: false, automatic_cards: false, automatic_codex_reset_credit:false }); wj('agent/config.json', config);

  // 4. empty runtime state with the real schema
  for (const d of ['mail-flow', 'agent/runs', 'inbox/cards', 'usage']) fs.mkdirSync(path.join(copy, '.runtime', d), { recursive: true });
  // Freeze the actual copy boundary before any tests create their own payloads.
  wj('.runtime/test-copy-manifest.json',{paths:copiedPaths});
  fs.writeFileSync(path.join(copy, '.runtime/agent/sessions.json'), '{"sessions":[]}\n');
  const { Flow } = await import(pathToFileURL(path.join(copy, 'mail-flow/flow.mjs')).href);
  new Flow(path.join(copy, '.runtime/mail-flow'), { account: 'tests@example.org', timezone: 'America/Chicago', initialLookbackHours: 24, overlapMinutes: 20,
    pageSize: 20, maxPagesPerRun: 6, maxBatchMessages: 8, maxPacketBytes: 8000 }).close();

  // 5. run the selection already validated before creating any copies.
  // Never inherit the live assistant identity or telemetry destination into the copy.
  const env={...process.env};delete env.OFFICE_MEMORY_OWNER;delete env.OFFICE_MEMORY_RUN_DIR;
  // Runtime payloads remain excluded; PDF tests use the same host executable as production.
  if(files.some(file=>file.startsWith('literature/')))env.PDFTOTEXT=pdfTextExecutable();
  for(const key of Object.keys(env))if(key.startsWith('DISCORD_'))delete env[key];
  console.log('isolated copy:',copy,'\ntest files:',files.join(', '));
  const testStarted=performance.now();
  console.log(`setup_ms: ${(testStarted-copied).toFixed(1)}`);
  const jobs=Math.min(selection.jobs,files.length);
  const testEnv=dir=>{
    // mkdtemp fixtures remain outside the office root (security tests exercise that boundary).
    const result={...env,NODE_DISABLE_COLORS:'1',MEMORY2_NO_GPU:'1',
      PHD_ISOLATED_TESTS:'1',WORKFLOW_CLAUDE_BIN:path.join(dir,'.runtime/no-claude-in-tests.exe'),
      PHD_TEST_PLAYWRIGHT:pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')),'index.mjs')).href};
    delete result.FORCE_COLOR;
    return result;
  };
  const nodeArgs=dir=>['--import',pathToFileURL(path.join(dir,'scripts/safe-ports.mjs')).href,
    '--test','--test-isolation=none','--test-reporter=spec','--test-timeout=240000'];
  const timingsFile=path.join(source,'.runtime/test-timings.json');
  let timings={};try{timings=JSON.parse(fs.readFileSync(timingsFile,'utf8'));}catch{/* first run: size estimates */}
  const weight=file=>timings[file] ?? fs.statSync(path.join(source,file)).size/2000;
  const pending=[...files].sort((a,b)=>weight(b)-weight(a));
  const logBase=path.join(source,'.runtime/test-results',new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid);
  fs.mkdirSync(path.dirname(logBase),{recursive:true});
  const log=logBase+'.log';
  fs.writeFileSync(log,`mode: ${selection.mode}\npristine template: ${copy}\nfiles: ${files.join(', ')}\n`);
  console.log(`workers: ${jobs}; fresh copy and separate process per file`);
  console.log('full test log:',log);
  if(keep)console.log('kept template:',copy,'; per-file copies are listed in the report');
  const results=[];
  const runFile=(dir,file)=>new Promise(resolve=>{
    const t0=performance.now();let output='';
    const fileLog=path.join(logBase,file.replaceAll('/','__')+'.log');
    fs.mkdirSync(logBase,{recursive:true});fs.writeFileSync(fileLog,`copy: ${dir}\n`);
    const child=spawn(process.execPath,[...nodeArgs(dir),file],{cwd:dir,env:testEnv(dir),windowsHide:true});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const append=d=>{output+=d;fs.appendFileSync(fileLog,d);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    child.on('error',error=>append(`\nRunner error: ${error.stack || error}\n`));
    child.on('close',(status,signal)=>resolve({file,status,signal,copy:dir,log:fileLog,text:output,seconds:(performance.now()-t0)/1000,summary:testSummary(output)}));
  });
  const workers=await Promise.allSettled(Array.from({length:jobs},async()=>{
    for(let file;(file=pending.shift());) {
      const dir=freshTestCopy(copy,os.tmpdir());extraCopies.push(dir);
      const result=await runFile(dir,file);results.push(result);
      fs.appendFileSync(log,`\n===== ${file} (exit ${result.status}, ${result.seconds.toFixed(1)}s) =====\n${result.text}`);
      console.log(`${testPassed(result) ? 'ok  ' : 'FAIL'} ${result.seconds.toFixed(1).padStart(6)}s  ${String(result.summary.tests).padStart(3)} tests  ${file} [${results.length}/${files.length}]`);
      if(!keep)removeTestCopy(dir,os.tmpdir());
    }
  }));
  // A copy/cleanup error in one worker must not delete another worker's live tree.
  const failedWorker=workers.find(result=>result.status==='rejected');
  if(failedWorker)throw failedWorker.reason;
  const total={tests:0,pass:0,fail:0,cancelled:0,skipped:0,todo:0};
  for(const result of results)for(const key of Object.keys(total))total[key]+=result.summary[key];
  const testMs=performance.now()-testStarted,passed=results.length===files.length && results.every(testPassed);
  console.log(`test_ms: ${testMs.toFixed(1)}`);
  for(const [key,value] of Object.entries(total))console.log(`ℹ ${key} ${value}`);
  for(const result of results)if(!testPassed(result))console.log(`\n===== ${result.file} (exit ${result.status}, signal ${result.signal}) =====\n${result.text.slice(-12000)}`);
  // Keep only current, successful timings; a failed/killed file must not alter scheduling.
  const currentTimings=Object.fromEntries(discoverTests(source).filter(file=>Number.isFinite(timings[file])).map(file=>[file,timings[file]]));
  for(const result of results)if(testPassed(result))currentTimings[result.file]=Math.round(result.seconds*10)/10;
  fs.writeFileSync(timingsFile,JSON.stringify(currentTimings,null,1)+'\n');
  fs.writeFileSync(logBase+'.json',JSON.stringify({mode:selection.mode,jobs,passed,total,test_ms:Math.round(testMs),
    results:results.map(({text,...result})=>result)},null,2)+'\n');
  console.log('test report:',logBase+'.json');
  console.log(passed ? 'ALL TESTS PASSED (in throw-away copies; live project data was not touched)' : 'TESTS FAILED');
  process.exitCode=passed ? 0 : 1;
} finally {
  if (keep) console.log('template kept at:', copy,'; test copies kept:',extraCopies.length);
  else {
    for(const dir of [copy,...extraCopies])removeTestCopy(dir,os.tmpdir());
  }
}
