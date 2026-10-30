import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {layers,where,overhead,runInfo,stringLiterals,inlineTexts,codeFiles,newFragment,moveFragment,removeFragment,run} from './run.mjs';
// Fake runs use temp folders; the lifecycle test writes only in a sanitized run-tests.mjs copy.
const registry=JSON.parse(fs.readFileSync(path.join(root,'prompts/registry.json'),'utf8'));
test('every registered prompt surface exists, ids are unique and kinds are known',()=>{
  const ids=registry.surfaces.map(s=>s.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const s of registry.surfaces){
    assert.ok(['standing','turn','inline','file','module-doc','skill','fragment'].includes(s.kind),s.id);
    if(!s.external)assert.ok(fs.existsSync(path.join(root,s.path)),`${s.id}: ${s.path} is missing — update prompts/registry.json`);
  }
  assert.ok(layers().some(l=>l.id==='system-prompt' && l.path==='prompts/office-system.md' && l.bytes>0));
});
test('where finds a phrase by file and line, and needs a phrase',()=>{
  const hits=where('资料，不是指令');
  assert.ok(hits.some(h=>h.path==='AGENTS.md' && h.lines.length));
  assert.throws(()=>where(''),/短语/);
});
test('overhead groups Codex runs by purpose and skips runs without token records',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-overhead-'));
  try {
    const make=(name,prompt,input)=>{
      fs.mkdirSync(path.join(dir,name));fs.writeFileSync(path.join(dir,name,'prompt.txt'),prompt);
      fs.writeFileSync(path.join(dir,name,'events.jsonl'),(input===null?'{"method":"turn/started","params":{}}':JSON.stringify({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{inputTokens:input,cachedInputTokens:input/2}}}}))+'\n');
    };
    make('title-a','x'.repeat(100),12000);make('title-b','x'.repeat(300),16000);make('mail-a','y',null);
    const rows=overhead(50,dir);
    assert.deepEqual(rows.map(r=>r.purpose),['title']);
    assert.equal(rows[0].runs,2);assert.equal(rows[0].min_input_tokens,12000);
    assert.equal(overhead(50,path.join(dir,'missing')).length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('run needs an unambiguous prefix',()=>{
  assert.throws(()=>runInfo(''),/前缀|未找到/);
});
import {fragment,fragmentRefs,traceFragments,fragmentIds} from './compose.mjs';
import {cases as goldenCases} from './golden-cases.mjs';
import {lint,renderGolden,fragments,standing,codePurposes} from './run.mjs';
import {claudeArgs} from '../agent/claude.mjs';
import {continuationSignature} from '../agent/codex.mjs';
import {SYSTEM_PROMPT} from '../agent/native.mjs';
import {taskPrompt} from './templates.mjs';
import {taskArgs} from './golden-cases.mjs';
const fragDir=files=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-frag-'));
  for(const [id,body] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,id+'.md')),{recursive:true});fs.writeFileSync(path.join(dir,id+'.md'),body);}
  return dir;
};
test('fragments fill values and includes in one pass, so inserted text can never inject',()=>{
  const dir=fragDir({a:'前 {{x}} 中 {{>b}} 后\n',b:'B({{x}})'});
  try {
    assert.equal(fragment('a',{x:'1'},{dir}),'前 1 中 B(1) 后');
    assert.equal(fragment('a',{x:'{{>b}} ${y} $&'},{dir}),'前 {{>b}} ${y} $& 中 B({{>b}} ${y} $&) 后');
    assert.deepEqual(fragmentRefs('a',dir),{values:['x'],includes:['b']});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing values, missing fragments, loops and unsafe ids fail loudly instead of leaving a hole',()=>{
  const dir=fragDir({a:'{{x}}',loop1:'{{>loop2}}',loop2:'{{>loop1}}',gone:'{{>nope}}'});
  try {
    assert.throws(()=>fragment('a',{},{dir}),/缺少值：x/);
    assert.throws(()=>fragment('a',{x:undefined},{dir}),/缺少值/);
    assert.equal(fragment('a',{x:''},{dir}),'');
    assert.throws(()=>fragment('loop1',{},{dir}),/循环引用/);
    assert.throws(()=>fragment('gone',{},{dir}),/不存在/);
    assert.throws(()=>fragment('../x',{},{dir}),/不合法/);
    assert.throws(()=>fragment('A',{},{dir}),/不合法/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('the shipped fragments have no structural lint errors',()=>{
  const result=lint();
  assert.deepEqual(result.errors,[]);
});
test('templates still render exactly what prompts/golden.json records (run `prompt snapshot` after reading a deliberate change)',()=>{
  const golden=JSON.parse(fs.readFileSync(path.join(root,'prompts/golden.json'),'utf8'));
  const now=renderGolden();
  assert.deepEqual(Object.keys(now),Object.keys(golden));
  for(const [name,text] of Object.entries(now))assert.equal(text,golden[name],name);
});

test('the static project entry and no-preread rules are carried once, by AGENTS.md',()=>{
  // These were fragments (turn/project/entry, turn/project/no-preread) rendered into every bound-project turn while AGENTS.md said the same
  // thing in the standing prompt. Keep the single copy in AGENTS.md; the per-turn fragments now carry only the project-specific commands.
  const agents=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');
  assert.match(agents,/projects <动作>/);assert.match(agents,/默认不整份读取 FRAMEWORK\.md/);
  for(const guide of ['help handoff','help card','help review'])assert.ok(agents.includes(guide),guide);
  const ids=fragmentIds();
  assert.ok(!ids.includes('turn/project/entry')&&!ids.includes('turn/project/no-preread'));
});
test('every fragment is rendered by at least one golden case, so `prompt snapshot` notices an edit to it',()=>{
  const seen=new Set();
  for(const testCase of goldenCases){const [,used]=traceFragments(()=>testCase.render());for(const f of used)seen.add(f.id);}
  assert.deepEqual(fragmentIds().filter(id=>!seen.has(id)),[],'add a case in prompts/golden-cases.mjs for these fragments');
});
test('the office system text has one registered source for all three colleagues',()=>{
  const body=fs.readFileSync(path.join(root,'prompts/office-system.md'),'utf8').replace(/\r\n/g,'\n').trimEnd();
  assert.equal(SYSTEM_PROMPT,body);
  const surface=registry.surfaces.find(s=>s.id==='system-prompt');
  assert.equal(surface.path,'prompts/office-system.md');
  assert.deepEqual(surface.loaded_by,['claude-work','claude-ask','codex-work','codex-ask','deepseek-work','deepseek-ask']);
  assert.deepEqual(where('你是用户的科研工作助手').map(hit=>hit.path),['prompts/office-system.md']);
});

test('operation mechanics stay in the shared system prompt, while task-specific inputs stay in the request',()=>{
  assert.match(SYSTEM_PROMPT,/已获授权、输入标有「本操作 ID」的 work 操作/);
  assert.match(SYSTEM_PROMPT,/普通聊天和 ask 判断保持各自的任务与输出格式/);
  for(const phrase of ['用 work update <UTF-8 JSON文件路径> 一次提交','本操作一旦调用子 DCG','"after":["子操作ID或执行ID"]','waiting_user','最终回复简要说明']) {
    assert.ok(SYSTEM_PROMPT.includes(phrase),phrase);
    for(const args of Object.values(taskArgs))assert.ok(!taskPrompt(...args).includes(phrase),phrase);
  }
  for(const args of Object.values(taskArgs)) {
    const text=taskPrompt(...args);
    assert.ok(text.includes(args[0].title));assert.ok(text.includes(args[0].goal));
  }
  const authorized=taskPrompt(...taskArgs['task-authorized-outputs-log']);
  for(const phrase of [taskArgs['task-authorized-outputs-log'][1],'不对外发送邮件','本操作交付实际文件','项目日志交付要求','"parent":"example-project"','自主来源'])assert.ok(authorized.includes(phrase),phrase);
  assert.ok(SYSTEM_PROMPT.includes('~/.codex/skills/smallest-complete/SKILL.md'));
});

test('traceFragments lists every fragment a render used, including includes, and nothing outside the call',()=>{
  const dir=fragDir({a:'{{>b}}{{>b}}',b:'B',c:'C'});
  try {
    fragment('c',{},{dir});
    const [text,used]=traceFragments(()=>fragment('a',{},{dir}));
    assert.equal(text,'BB');
    assert.deepEqual(used,[{id:'a',uses:1},{id:'b',uses:2}]);
    assert.deepEqual(traceFragments(()=>0)[1],[]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('the registry statements about standing prompts match the Claude launch flags and the Codex source',()=>{
  const surface=id=>registry.surfaces.find(x=>x.id===id);
  const ask=claudeArgs('m',{mode:'ask'}),work=claudeArgs('m',{mode:'work'});
  // ask: every customisation off (no AGENTS.md / CLAUDE.md), work: loads them; both pass the office system prompt.
  assert.ok(ask.includes('--safe-mode') && !work.includes('--safe-mode'));
  assert.ok(ask.includes('--system-prompt') && work.includes('--system-prompt'));
  assert.ok(surface('agents-md').not_loaded_by.some(v=>v.startsWith('claude-ask')) && surface('agents-md').loaded_by.includes('claude-work'));
  assert.ok(surface('claude-md').loaded_by.includes('claude-work') && !surface('claude-md').loaded_by.some(v=>v.startsWith('claude-ask')));
  assert.ok(['claude-work','claude-ask','codex-work','codex-ask'].every(k=>surface('system-prompt').loaded_by.includes(k)));
  assert.match(fs.readFileSync(path.join(root,'agent/codex.mjs'),'utf8'),/systemPrompt=SYSTEM_PROMPT[\s\S]*baseInstructions:systemPrompt/);
});
test('every purpose used by program code is declared, and standing lists each declared purpose on every provider it can run on',()=>{
  const declared=Object.keys(registry.purposes);
  for(const name of Object.keys(codePurposes()))assert.ok(declared.includes(name),name);
  const rows=standing();
  for(const name of declared)assert.ok(rows.some(r=>r.purpose===name),name+' has no standing row (providers_from may be empty)');
  const row=(purpose,provider)=>rows.find(r=>r.purpose===purpose && r.provider===provider);
  assert.equal(row('chat','claude').agents_md,'yes');assert.equal(row('card','claude').agents_md,'no');
  assert.equal(row('chat','deepseek').agents_md,'yes');assert.equal(row('card','deepseek').agents_md,'no');
  assert.equal(row('deepseek-delegate','deepseek').agents_md,'no');
  assert.equal(row('companion-note','claude').system_prompt,'REPLACED');assert.equal(row('companion-note','codex').system_prompt,'REPLACED');
});

test('Codex honours a caller-supplied systemPrompt as base instructions, like Claude, and the continuation signature follows it',()=>{
  const source=fs.readFileSync(path.join(root,'agent/codex.mjs'),'utf8');
  assert.match(source,/systemPrompt=SYSTEM_PROMPT/);assert.match(source,/baseInstructions:systemPrompt/);
  const launch={cwd:'x',overrides:[]};
  assert.equal(continuationSignature(launch,'M','high'),continuationSignature(launch,'M','high',SYSTEM_PROMPT),'default is unchanged');
  assert.notEqual(continuationSignature(launch,'M','high'),continuationSignature(launch,'M','high','另一套系统提示'));
  assert.ok(claudeArgs('m',{mode:'ask',systemPrompt:'另一套系统提示'}).includes('另一套系统提示'));
});
test('the inline-text scanner reads strings, templates and regexes like JavaScript does',()=>{
  const lits=src=>stringLiterals(src).map(l=>l.text);
  // a quote or backtick inside a regex, a comment or a string must not open a string
  assert.deepEqual(lits("const r=/['\"`]/g; // it's a comment with a `tick\nconst a='x';"),['x']);
  assert.deepEqual(lits("/* don't */ const b=\"y\";"),['y']);
  // only the fixed parts of a template count (joined: a+b+e, c+d); code inside ${} is scanned as code, nesting included
  assert.deepEqual(lits("const t=`a${f('in')}b${`c${1}d`}e`;").sort(),['abe','cd','in']);
  // division is not a regex
  assert.deepEqual(lits("const q=a/b+'k'/2;"),['k']);
  // escapes and line numbers
  assert.deepEqual(stringLiterals("a\n'one\\'s'\n").map(l=>[l.text,l.line]),[["one's",2]]);
});
test('new, mv and rm change a fragment and fix every pointer to it, and rm refuses while something still uses it',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-edit-'));
  const put=(f,body)=>{fs.mkdirSync(path.dirname(path.join(base,f)),{recursive:true});fs.writeFileSync(path.join(base,f),body);};
  put('prompts/fragments/a/x.md','正文 {{v}}');
  put('prompts/fragments/a/y.md','引用：{{>a/x}}');
  put('prompts/registry.json','{"surfaces":[{"path":"prompts/fragments/a/x.md"}]}');
  put('work/c.mjs',"const t=fragment('a/x',{v:1});const u=block('a/x');const keep=fragment('a/xx');\nconst d=fragment ( \"a/x\" ,{});const b=block(`a/x`);");
  assert.throws(()=>removeFragment('a/x',base),/还有地方在用/);
  assert.throws(()=>moveFragment('a/x','a/y',base),/目标已存在/);
  assert.throws(()=>newFragment('Bad Id',' ',base),/只能用/);
  const moved=moveFragment('a/x','b/z',base);
  assert.deepEqual(moved.updated.sort(),['prompts/fragments/a/y.md','prompts/registry.json','work/c.mjs']);
  assert.equal(fs.readFileSync(path.join(base,'prompts/fragments/a/y.md'),'utf8'),'引用：{{>b/z}}');
  assert.match(fs.readFileSync(path.join(base,'work/c.mjs'),'utf8'),/fragment\('b\/z',\{v:1\}\).*block\('b\/z'\).*fragment\('a\/xx'\)/);
  assert.ok(fs.readFileSync(path.join(base,'work/c.mjs'),'utf8').includes('fragment ( "b/z" ,{});const b=block(`b/z`)'));
  assert.ok(fs.existsSync(path.join(base,'prompts/fragments/b/z.md'))&&!fs.existsSync(path.join(base,'prompts/fragments/a/x.md')));
  assert.equal(newFragment('c/n','hello',base).created,'prompts/fragments/c/n.md');
  assert.deepEqual(removeFragment('c/n',base),{removed:'c/n'});
  assert.ok(!fs.existsSync(path.join(base,'prompts/fragments/c/n.md')));
  fs.rmSync(base,{recursive:true,force:true});
});
test('inline text is discoverable without an exemption registry',()=>{
  assert.ok(codeFiles().includes('work/run.mjs') && !codeFiles().some(f=>f.endsWith('.test.mjs')||f.startsWith('.runtime/')));
  assert.ok(inlineTexts().some(h=>h.file==='projects/run.mjs'));
  assert.equal(registry.inline_text_allowed,undefined);
});
test('new preserves whitespace, and unused fragments and long strings are inventory rather than lint errors',async()=>{
  assert.equal(process.env.PHD_ISOLATED_TESTS,'1','Run in a sanitized run-tests.mjs copy');
  const id='test-unused-'+process.pid, file=path.join(root,'prompts','test-inline-'+process.pid+'.mjs');
  const body='第一行  两个空格\n\n第二行\t缩进 $& {{v}}\n';
  const log=console.log;
  try {
    console.log=()=>{};
    await run('new',id+' '+body);
    console.log=log;
    assert.equal(fs.readFileSync(path.join(root,'prompts/fragments',id+'.md'),'utf8'),body);
    fs.writeFileSync(file,'const label='+JSON.stringify('界面'.repeat(45))+';', {flag:'wx'});
    const inventory=lint();
    assert.deepEqual(inventory.errors,[]);
    assert.ok(inventory.unused.includes(id));
    assert.ok(inventory.inline_text.some(h=>h.file==='prompts/'+path.basename(file)));
  } finally {
    console.log=log;
    fs.rmSync(path.join(root,'prompts/fragments',id+'.md'),{force:true});
    fs.rmSync(file,{force:true});
  }
});
import {fragmentSegments} from './compose.mjs';
import {saveFragment,fragmentHistory} from './run.mjs';
import {promptOverview,promptFragment,promptPreview} from './view.mjs';
test('fragmentSegments keeps where each piece came from, leaves values as slots and previews unsaved drafts',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-seg-'));
  const put=(id,body)=>{fs.mkdirSync(path.dirname(path.join(dir,id+'.md')),{recursive:true});fs.writeFileSync(path.join(dir,id+'.md'),body);};
  try {
    put('a/top','开头 {{who}}，{{>a/inner}} 结尾');put('a/inner','内层');
    assert.deepEqual(fragmentSegments('a/top',{dir}).map(s=>[s.from,s.kind,s.text]),[['a/top','text','开头 '],['a/top','value','who'],['a/top','text','，'],['a/inner','text','内层'],['a/top','text',' 结尾']]);
    assert.ok(fragmentSegments('a/top',{dir,overrides:{'a/inner':'新{{x}}'}}).some(s=>s.from==='a/inner'&&s.kind==='value'&&s.text==='x'),'an override replaces the saved text');
    assert.ok(fragmentSegments('a/top',{dir,overrides:{'a/top':'{{>a/gone}}'}}).some(s=>s.kind==='missing'&&s.text==='a/gone'),'a missing include is shown, not thrown');
    put('a/loop','{{>a/loop}}');
    assert.throws(()=>fragmentSegments('a/loop',{dir}),/循环/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('saveFragment keeps the old text as history, also for back-to-back saves, and removal keeps it too',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T12:00:00.123Z')});
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-save-'));
  try {
    newFragment('a/b','',base);
    fs.writeFileSync(path.join(base,'prompts/registry.json'),'{}');
    assert.deepEqual(saveFragment('a/b','一',base),{saved:'a/b',changed:true});
    assert.deepEqual(fragmentHistory('a/b',base),[],'an empty old text is not worth keeping');
    assert.equal(saveFragment('a/b','一',base).changed,false);
    saveFragment('a/b','二',base);saveFragment('a/b','三',base);
    assert.deepEqual(fragmentHistory('a/b',base).map(h=>h.body),['二','一'],'newest first, nothing overwritten');
    assert.throws(()=>saveFragment('a/none','x',base),/没有这个片段/);
    removeFragment('a/b',base);
    assert.equal(fragmentHistory('a/b',base)[0].body,'三');
    newFragment('a/numbers','0',base);
    for(let i=1;i<=12;i++)saveFragment('a/numbers',String(i),base);
    assert.deepEqual(fragmentHistory('a/numbers',base).map(h=>h.body),Array.from({length:10},(_,i)=>String(11-i)),'numeric collision suffixes stay newest first before applying the limit');
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('the prompt page data lists scenarios with their standing prompts and follows real code to the fragments each one can reach',()=>{
  const o=promptOverview();
  const chat=o.scenarios.find(s=>s.purpose==='chat'&&s.provider==='claude');
  assert.equal(chat.agents_md,'yes');assert.ok(chat.surfaces.length);
  assert.equal(o.scenarios.find(s=>s.purpose==='card'&&s.provider==='claude').agents_md,'no','Claude ask does not read AGENTS.md');
  const reach=id=>o.fragments.find(f=>f.id===id).purposes;
  assert.deepEqual(reach('card'),['card']);assert.deepEqual(reach('title'),['title']);
  assert.ok(reach('turn/intro').includes('chat'));assert.ok(reach('rule/no-mail-send').includes('auto'),'reached through the fragments that include it');
  assert.deepEqual(reach('companion/note'),['companion-note']);
  assert.deepEqual(o.lint.errors,[]);
  const f=promptFragment('rule/no-mail-send');
  assert.equal(f.body,fragmentSource('rule/no-mail-send'));assert.ok(f.included_by.length&&f.segments.length&&Array.isArray(f.history));
});
test('promptPreview expands unsaved text and reports a broken draft instead of throwing',()=>{
  assert.ok(promptPreview('rule/no-mail-send','草稿 {{>turn/record}}').segments.some(s=>s.from==='turn/record'));
  assert.match(promptPreview('rule/no-mail-send','{{>rule/no-mail-send}}').error,/循环/);
});
import {fragmentSource} from './compose.mjs';
import {createHash} from 'node:crypto';
import {joinPrompt,promptSource,promptMap} from './compose.mjs';
import {promptRuns,promptRun} from './runs.mjs';

test('source tracing records actual nesting and offsets without changing text, parsing inserted data, or guessing string provenance',()=>{
  const dir=fragDir({top:'开头 {{data}} / {{>inner}} / {{rendered}}',inner:'内层 {{name}}'});
  const render=()=>joinPrompt([promptSource('# 普通正文',{path:'fixture.mjs',label:'程序文字'}),fragment('top',{data:'内层 同文 {{>inner}}',name:'小绿',rendered:fragment('inner',{name:'第二次'},{dir})},{dir}),'末尾普通文字'],'\n\n');
  try {
    const expected=render();let map;
    const [actual,used]=traceFragments(()=>{const doc=render();map=promptMap(doc);return String(doc);},{sources:true});
    assert.equal(actual,expected);assert.equal(map.sha256,createHash('sha256').update(expected).digest('hex'));
    assert.ok(used.some(f=>f.id==='inner'&&f.uses===2));
    const node=map.nodes.find(n=>n.kind==='fragment');assert.equal(node.id,'top');assert.equal(actual.slice(node.start,node.end),expected.split('\n\n')[1]);
    const data=node.children.find(n=>n.kind==='value'&&n.name==='data');assert.deepEqual(data.children,[],'identical fragment-looking data is not attributed to a fragment');assert.match(actual.slice(data.start,data.end),/\{\{>inner\}\}/,'data is never reparsed');
    const include=node.children.find(n=>n.kind==='fragment');assert.equal(actual.slice(include.start,include.end),'内层 小绿');
    const rendered=node.children.find(n=>n.name==='rendered');assert.equal(rendered.children[0].id,'inner');assert.equal(actual.slice(rendered.start,rendered.end),'内层 第二次');
    const saved=map.fragments['top@'+node.sha256].body;fs.writeFileSync(path.join(dir,'top.md'),'后来改过');assert.match(saved,/开头/);assert.notEqual(saved,fragmentSource('top',dir));
    assert.equal(typeof fragment('inner',{name:'普通'},{dir}),'string','tracing does not leak into later renders');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('run inspection preserves exact historical text, distinguishes native deltas from compiled drafts, and never guesses fragment positions',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-inspect-'));
  const id='11111111-1111-4111-8111-111111111111',dir=path.join(base,'.runtime/agent/runs',id);
  const put=(name,value)=>fs.writeFileSync(path.join(dir,name),typeof value==='string'?value:JSON.stringify(value));
  const full='完整稿\r\n中文 <script> 不解析 {{value}}\n',delta='只有本轮增量\n';
  const hash=s=>createHash('sha256').update(s).digest('hex');
  try {
    assert.deepEqual(promptRuns(base),{runs:[]});fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(base,'.runtime/agent/sessions.json'),JSON.stringify({sessions:[{id:'s',title:'历史验收',task_ids:[id],messages:[{role:'assistant',provider:'codex',task_id:id,at:'2026-10-20T12:00:00Z'}]}]}));
    put('prompt.txt',full);
    let r=promptRun(id,base);assert.equal(r.body,full);assert.equal(r.source,'prompt.txt');assert.equal(r.fragments.length,0);assert.ok(r.warnings.length);
    put('prompt-manifest.json',{speaker:'codex',prompt_sha256:hash(full),fragments:[{id:'turn/intro',uses:1}],resume_prompt_chars:delta.length,resume_fragments:[{id:'turn/request',uses:2}]});
    r=promptRun(id,base);assert.equal(r.fragments[0].id,'turn/intro');assert.equal(r.provider,'codex');
    put('native-prompt.txt',delta);put('continuation.json',{resumed:true});
    r=promptRun(id,base);assert.equal(r.body,delta);assert.equal(r.source,'native-prompt.txt');assert.equal(r.resumed,true);assert.deepEqual(r.fragments,[{id:'turn/request',uses:2}]);assert.match(r.warnings.join(' '),/字数/);
    put('native-prompt.txt',delta+'extra');assert.deepEqual(promptRun(id,base).fragments,[],'mismatched records are not attributed');
    put('native-prompt.txt',full);put('continuation.json',{resumed:false});
    assert.equal(promptRun(id,base).fragments[0].id,'turn/intro');
    fs.mkdirSync(path.join(dir,'2'));fs.writeFileSync(path.join(dir,'2/prompt.txt'),'第二轮');
    fs.mkdirSync(path.join(base,'.runtime/agent/runs/title-probe'));fs.writeFileSync(path.join(base,'.runtime/agent/runs/title-probe/prompt.txt'),'后台不列出');
    const listed=promptRuns(base).runs;assert.equal(listed.length,2);assert.ok(listed.some(r=>r.id===id));assert.ok(listed.every(r=>r.turn===1&&!('body' in r)));
    assert.equal(promptRun(id+'/2',base).turn,1,'a handoff does not become a second conversation round');assert.equal(promptRun(id+'/2',base).handoff_turn,2);
    assert.equal(promptRun(id+'/2',base).body,'第二轮');
    for(const bad of ['../work',id+'/../x',id+'\\2',id+'/prompt.txt',id+'/01','C:/Windows'])assert.throws(()=>promptRun(bad,base),/id 不合法/);
    fs.symlinkSync(dir,path.join(dir,'3'),'junction');assert.throws(()=>promptRun(id+'/3',base),/链接/);assert.equal(promptRuns(base).runs.length,2);
    put('prompt-manifest.json','{broken');assert.deepEqual(promptRun(id,base).fragments,[]);assert.equal(promptRuns(base).runs.find(r=>r.id===id).has_manifest,false);
    assert.equal(fs.readFileSync(path.join(dir,'prompt.txt'),'utf8'),full,'inspection never rewrites artifacts');
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test('conversation rounds include every retained input and handoff without relabeling missing or orphaned records',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-rounds-'));
  const ids=[1,2,3,4].map(n=>`${n}${'0'.repeat(7)}-0000-4000-8000-000000000000`),home=path.join(base,'.runtime/agent/runs');
  const put=(id,speaker)=>{const d=path.join(home,id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'prompt.txt'),'固定验收正文');fs.writeFileSync(path.join(d,'prompt-manifest.json'),JSON.stringify({speaker,turn:1}));};
  try {
    for(const id of ids)put(id,'claude');
    put(ids[0]+'/2','codex');
    fs.writeFileSync(path.join(base,'.runtime/agent/sessions.json'),JSON.stringify({sessions:[{id:'conversation',title:'连续对话',task_ids:ids.slice(0,3),messages:ids.slice(0,3).flatMap(task_id=>[{role:'assistant',provider:'claude',task_id,interim:true},{role:'assistant',provider:'claude',task_id}])}]}));
    assert.deepEqual(ids.slice(0,3).map(id=>promptRun(id,base).turn),[1,2,3],'all manifests say turn=1 but session rounds are distinct');
    assert.equal(promptRun(ids[0]+'/2',base).turn,1);assert.equal(promptRun(ids[0]+'/2',base).handoff_turn,2);
    assert.deepEqual(promptRuns(base).runs.map(r=>r.id).sort(),[...ids.slice(0,3),ids[0]+'/2'].sort());
    assert.equal(promptRun(ids[3],base).turn,null,'an orphan is not mislabeled as round 1');
    fs.unlinkSync(path.join(home,ids[0],'prompt.txt'));
    assert.deepEqual(promptRuns(base).runs.map(r=>r.id).sort(),[ids[0]+'/2',ids[1],ids[2]].sort());
    assert.equal(promptRuns(base).runs.find(r=>r.id===ids[1]).turn,2,'a missing first input does not renumber later rounds');
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test('more than thirty rounds remain listed, including repeated handoffs by the same provider',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-all-rounds-'));
  const ids=Array.from({length:35},(_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000000`);
  const home=path.join(base,'.runtime/agent/runs');
  try{
    for(const id of [...ids,ids[0]+'/2',ids[0]+'/3']){
      const dir=path.join(home,id);fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'native-prompt.txt'),'retained input');
      fs.writeFileSync(path.join(dir,'prompt-manifest.json'),JSON.stringify({speaker:'codex'}));
    }
    fs.writeFileSync(path.join(base,'.runtime/agent/sessions.json'),JSON.stringify({sessions:[{id:'all',task_ids:ids,messages:[]}]}));
    const rows=promptRuns(base).runs;
    assert.equal(rows.length,37);
    assert.deepEqual(new Set(rows.map(r=>r.turn)),new Set(Array.from({length:35},(_,i)=>i+1)));
    assert.equal(rows.find(r=>r.id===ids[0]+'/3').handoff_turn,3);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('all three providers and later DeepSeek inputs remain visible when an earlier input is missing',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-deepseek-'));
 const ids=[1,2,3,4].map(n=>`${n}${'1'.repeat(7)}-0000-4000-8000-000000000000`),home=path.join(base,'.runtime/agent/runs');
 try {
  for(const [i,id] of ids.entries()){
   const d=path.join(home,id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'native-prompt.txt'),'实际输入 '+i);
  }
  const providers=['codex','claude','deepseek','deepseek'];
  fs.writeFileSync(path.join(base,'.runtime/agent/sessions.json'),JSON.stringify({sessions:[{id:'three',title:'三位',task_ids:ids,messages:ids.map((task_id,i)=>({role:'assistant',provider:providers[i],task_id}))}]}));
  const listed=promptRuns(base).runs;
  assert.equal(listed.find(r=>r.id===ids[2]).provider,'deepseek');assert.ok(listed.some(r=>r.id===ids[3]));
  fs.rmSync(path.join(home,ids[2]),{recursive:true});
  assert.equal(promptRuns(base).runs.find(r=>r.provider==='deepseek').id,ids[3]);
  assert.equal(promptRuns(base).runs.find(r=>r.id===ids[3]).turn,4);
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
