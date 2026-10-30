import fs from 'node:fs';
import path from 'node:path';
import {includeTestFile} from './test-copy.mjs';

// Focused modes are explicit consumer sets. The default suite discovers tests so
// adding a regression cannot silently leave it outside the full run.
export const modes = {
  activity: ['Task/tool rail and provider consumers', ['dashboard/activity','automation/agent','automation/continuation','automation/codex-output','dashboard/ui-state','dashboard/performance']],
  autonomy: ['Queue and dispatch consumers', ['work/autonomy','automation/agent','automation/workflow','automation/open-execution']],
  'result-review': ['Outer data delivery review, dynamic child DCG and parent return', ['work/result-review','work/graph','work/autonomy','automation/data-analysis-mode','automation/continuation','dashboard/project-steps','prompts/prompts']],
  'dcg-orchestrator': ['Parent orchestration skill, discovery, current-result decisions and existing DCG return', ['automation/dcg-orchestrator','work/graph','work/result-review','automation/data-analysis-mode','automation/continuation','dashboard/skills-lint','prompts/prompts']],
  'browser-safety': ['Two controlled Edge launches', ['automation/browser-launch','automation/markdown']],
  changes: ['File deltas, versions and native handoff', ['automation/files','automation/file-state','automation/file-baselines','automation/continuation','automation/agent','dashboard/restart','dashboard/startup']],
  lifecycle: ['Agent completion, backend restart and Windows tray lifecycle', ['agent/lifecycle','dashboard/restart','dashboard/startup']],
  memory2: ['EverOS-style memory: markdown store, index, search, extraction, reflection, profile, context (offline; fake embedder and LLM)', ['memory2/md','memory2/index','memory2/search','memory2/embedder','memory2/extract','memory2/reflect','memory2/profile','memory2/context','memory2/inject','memory2/auto','memory2/ledger','memory2/agentic','memory2/llm','memory2/cli','memory2/retirement']],
  remote: ['Offline Discord trigger/notification fixtures', ['remote/discord','remote/startup','automation/framework']],
  'weekly-ui': ['Calendar and weekly plan/review', ['calendar/calendar','weekly/weekly']],
  'unread-ui': ['Final-reply unread and project read boundary', ['dashboard/unread']],
  'board-ui': ['Board navigation and unread UI', ['dashboard/board','dashboard/unread']],
  'companion-ui': ['Optional external scenes, assets, notes and UI', ['dashboard/companion/tests/animation','dashboard/companion-assets','dashboard/companion-notes','dashboard/companion','dashboard/performance','dashboard/ui-state']],
  latency: ['Conversation I/O, baselines and UI', ['automation/files','automation/file-baselines','automation/file-state','automation/agent','automation/continuation','dashboard/ui-state','dashboard/performance','dashboard/restart']],
  'state-ui': ['Scoped transport and UI consumers', ['dashboard/ui-state','automation/chat','automation/markdown','automation/project-framework','calendar/calendar','dashboard/unread','dashboard/board','dashboard/performance','dashboard/restart','dashboard/settings','dashboard/skills-lint','dashboard/project-related','automation/handoff','dashboard/handoff-tree','projects/docs']],
  literature: ['Offline literature fixtures and real PDF parser', ['literature/wos','literature/fetch','literature/fetch-batch','literature/fetch-backoff','literature/publication','literature/abstracts','literature/view','literature/daily','literature/library','literature/rebuild-routing','literature/rebuild-work','software/zotero/native-fetch/plugin']],
  instruments: ['Instrument cards, notes and code boundary', ['instruments/library','instruments/note']],
  'local-files': ['Local-file HTTP/security and actual chat links', ['dashboard/local-files','automation/markdown']],
  'powershell-ui': ['Two harmless interactive PowerShell consoles', ['dashboard/powershell','automation/markdown']],
  prompts: ['Prompt architecture and page API', ['prompts/prompts','dashboard/prompts-view']],
  mail: ['Offline connectors, downloads, ledger and card consumers', ['mail-flow/flow','mail-flow/actions','mail-flow/graph','mail-flow/graph-rest','mail-flow/downloads','projects/context','automation/agent','automation/mail-bounds','automation/codex-output','automation/continuation','instruments/note']],
  procurement: ['Offline quote/CLI and ECE UI workflow', ['procurement/procurement','procurement/ece-workflow','automation/framework']],
  sandbox: ['Opt-in real offline Linux containers (Docker required)', ['sandbox/sandbox']],
  software: ['Software discovery and existing directory routing', ['software/software','software/deepseek-harness/deepseek','software/deepseek-harness/memory-tool','software/deepseek-harness/updates','agent/deepseek','dashboard/deepseek-chat']],
  handoff: ['Assistant-origin conversations, nested state and UI', ['automation/handoff','dashboard/handoff-tree','trigger/trigger']],
  speech: ['Speech UI and local fixtures', ['dashboard/speech']],
  usage: ['Quota announcements, reports and settings UI', ['usage/extra-resets','usage/reset-credits','usage/deepseek-balance','usage/commandcode-quota','usage/speed','usage/tokens','dashboard/reset-notices','dashboard/settings']],
};

export const optInTests = new Set(['sandbox/sandbox.test.mjs']);
const guards = ['scripts/test-copy.test.mjs','scripts/safe-ports.test.mjs','scripts/test-suite.test.mjs'];

export function discoverTests(source) {
  const found=[];
  const visit=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink() || !includeTestFile(source,file))continue;
      if(entry.isDirectory())visit(file);
      else if(entry.name.endsWith('.test.mjs'))found.push(path.relative(source,file).split(path.sep).join('/'));
    }
  };
  visit(source);
  return found.sort();
}

export function selectTests(source,args) {
  let mode=null,jobs=null,files=null,keep=false,list=false,help=false;
  for(const arg of args) {
    if(arg==='--keep')keep=true;
    else if(arg==='--list')list=true;
    else if(arg==='--help')help=true;
    else if(arg.startsWith('--jobs=')) {
      if(jobs!==null)throw new Error('Choose --jobs once');
      jobs=Number(arg.slice(7));
      if(!Number.isInteger(jobs) || jobs<1 || jobs>8)throw new Error('--jobs must be an integer from 1 to 8');
    } else if(arg.startsWith('--files=')) {
      if(mode || files)throw new Error('Choose one focused test mode or --files');
      files=arg.slice(8).split(',');
    } else if(Object.hasOwn(modes,arg.slice(2)) && arg.startsWith('--')) {
      if(mode || files)throw new Error('Choose one focused test mode or --files');
      mode=arg.slice(2);
    } else throw new Error('Unknown test option: '+arg);
  }
  const available=discoverTests(source),known=new Set(available);
  const selected=files ?? (mode ? modes[mode][1].map(f=>f+'.test.mjs') : available.filter(f=>!optInTests.has(f)));
  for(const file of selected)if(!known.has(file))throw new Error('Unknown test file: '+file);
  const result=[...new Set([...guards,...selected])];
  for(const file of result)if(!known.has(file))throw new Error('Missing test file: '+file);
  if(result.includes('automation/agent.test.mjs'))for(const file of ['automation/efficiency.test.mjs','automation/codex-output.test.mjs'])if(!result.includes(file))result.push(file);
  return {files:result,focused:Boolean(mode || files),mode:mode ?? (files ? 'files' : 'full'),jobs:jobs ?? (mode || files ? 1 : 4),keep,list,help};
}

export function testSummary(output) {
  const number=key=>Number(output.match(new RegExp('^ℹ '+key+' (\\d+)','m'))?.[1] ?? 0);
  return {tests:number('tests'),pass:number('pass'),fail:number('fail'),cancelled:number('cancelled'),skipped:number('skipped'),todo:number('todo')};
}

export function testPassed(result) {
  return result.status===0 && result.summary.tests>0 && result.summary.fail===0 && result.summary.cancelled===0;
}
