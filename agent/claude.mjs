import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { root, read } from '../automation/files.mjs';
import { recordRun, recordClaudeLimits } from '../usage/run.mjs';
import { SYSTEM_PROMPT, STOP_MESSAGE, EMPTY_MESSAGE, stopProcess, nativeTextInput } from './native.mjs';
import {memoryEnabled} from '../memory2/owner.mjs';
import {runRelative} from '../memory2/telemetry.mjs';
import {toolSummary} from './tool-summary.mjs';

export function claudeEnvironment({mode,config}={}) {
  const env={...process.env,OFFICE_MEMORY_OWNER:'claude',...(memoryEnabled('claude') ? {CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'} : {})};
  if(mode==='work') {
    const limit=(config || read('agent/config.json')).subagent_max_concurrency ?? 10;
    if(!Number.isInteger(limit) || limit<1 || limit>10)throw new Error('Claude 子 agent 并发上限应为 1～10 的整数');
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=String(limit);
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1';
  }
  return env;
}

// Two ways to start Claude.
// A conversation turn (work) is an ordinary Claude Code agent: its default tools and skills, the user's own instruction files (persona, the project's
// CLAUDE.md / AGENTS.md), and the user's own auto approver (--permission-mode auto, as set in ~/.claude/settings.json): requests are approved
// automatically, what that approver judges unsafe is still refused. No turn limit and no time limit. Only the claude.ai connectors are switched off
// (--strict-mcp-config): they add tools nobody asked for. The office desktop MCP is explicitly supplied for work turns only.
// An 'ask' turn is parsed by the program (cards, mail judgement): one reply, no tools, every customisation off (--safe-mode), so nothing can change
// the shape of a JSON reply.
export function claudeArgs(model, { mode = 'work', effort, systemPrompt = SYSTEM_PROMPT, resume, forkAt, addDirs = [] } = {}) {
  const ask = mode === 'ask';
  const args = ['-p', ask ? '--safe-mode' : '--strict-mcp-config', '--model', model, ...(ask ? ['--max-turns', '1'] : []),
    '--output-format', 'stream-json', '--verbose', '--permission-mode', ask ? 'acceptEdits' : 'auto', '--tools', ask ? '' : 'default', '--system-prompt', systemPrompt];
  if (effort) args.push('--effort', effort);
  if (resume && !ask) args.push('--resume', resume);
  // Edit-and-regenerate: continue from a copy of the session cut after this message (the original session is left untouched; the new id is reported in init).
  if (resume && forkAt && !ask) args.push('--resume-session-at', forkAt, '--fork-session');
  // --permission-prompt-tool stdio is what makes AskUserQuestion exist in a headless session (without it the tool is absent): the CLI then sends the
  // question as a can_use_tool control request, which invokeClaude answers from the workbench. Ordinary tools are not routed there (verified 2026-10-20).
  if (!ask) {
    args.push('--input-format', 'stream-json', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--mcp-config', path.join(root,'software/computer-use/mcp.json'));
    // Reject shell-sensitive inline source and preserve failures in command
    // chains. Modified inputs still use the normal approver, fresh or resumed.
    const command=[process.execPath,path.join(root,'agent/shell-guard.mjs')].map(p=>'"'+p.replace(/\\/g,'/')+'"').join(' ');
    args.push('--settings',JSON.stringify({hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command,timeout:5}]}]}}));
  }
  // The folder the user opened the terminal front end in: Claude's file tools work there as in the office folder (the process itself still starts in the office root).
  if (!ask) for (const dir of addDirs) args.push('--add-dir', dir);
  return args;
}

// AskUserQuestion's input -> the workbench's generic questions, and the generic answers -> the tool's `answers` map (question text -> chosen labels / free text).
export const claudeQuestions = input => (input?.questions || []).map((q, i) => ({ id: String(i), header: String(q.header || ''), question: String(q.question || ''),
  options: (q.options || []).map(o => ({ label: String(o.label || ''), description: String(o.description || '') })), multi: !!q.multiSelect, other: true }));
export const claudeAnswers = (input, answers) => Object.fromEntries((input.questions || []).map((q, i) => [q.question, (answers[i] || []).join(', ')]));

// Native continuation: a conversation's Claude work turns resume one Claude Code session (same session id; the process still ends every turn).
// The transcript lives under the Claude config dir. If it is gone (cleanup) or the launch signature changed, start fresh with the full prompt. That is
// decided before the model is called; a turn that has started is never replayed.
export const claudeSignature = (model, effort, systemPrompt = SYSTEM_PROMPT) => createHash('sha256').update(JSON.stringify({ model, effort, systemPrompt })).digest('hex');
export function claudeSessionExists(id, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return false;
  const projects = path.join(configDir, 'projects');
  try { return fs.readdirSync(projects).some(d => fs.existsSync(path.join(projects, d, id + '.jsonl'))); } catch { return false; }
}
export function claudeModelUsageBaseline(id, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), forkAt) {
  if (forkAt || !/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  try {
    const projects = path.join(configDir, 'projects');
    const file = fs.readdirSync(projects).map(d=>path.join(projects,d,id+'.jsonl')).find(f=>fs.existsSync(f));
    if (!file) return null;
    const lines = fs.readFileSync(file,'utf8').trimEnd().split('\n');
    for (let i=lines.length-1;i>=0;i--) try {
      const e=JSON.parse(lines[i]);
      if(e.type==='cost-state' && e.sessionId===id && e.modelUsage && typeof e.modelUsage==='object') return e.modelUsage;
    } catch {}
  } catch {}
  return null;
}

// The assistant message to cut a session after so that the user message `promptUuid` and everything later fall away: walk up from that prompt to the
// nearest assistant entry. null when the transcript is gone or nothing precedes the prompt (then there is nothing to keep; the caller starts fresh).
export function claudeForkPoint(id, promptUuid, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  const projects = path.join(configDir, 'projects');
  try {
    const dir = fs.readdirSync(projects).find(d => fs.existsSync(path.join(projects, d, id + '.jsonl')));
    if (!dir) return null;
    const entries = new Map();
    for (const line of fs.readFileSync(path.join(projects, dir, id + '.jsonl'), 'utf8').split('\n')) {
      try { const e = JSON.parse(line); if (e.uuid) entries.set(e.uuid, e); } catch { /* a torn or non-message line */ }
    }
    for (let e = entries.get(promptUuid)?.parentUuid && entries.get(entries.get(promptUuid).parentUuid); e; e = e.parentUuid && entries.get(e.parentUuid)) if (e.type === 'assistant') return e.uuid;
  } catch { /* unreadable transcript */ }
  return null;
}

// One Claude run, folded from its stream-json events. Kept apart from the process handling so it can be tested with recorded events.
export function newRun(model) { return { result: '', usage: {}, model, sessionId: null, error: null, toolCalls: 0, held: '' }; }
const modelCounters = ['inputTokens','cacheReadInputTokens','cacheCreationInputTokens','outputTokens'];
export function claudeModelDelta(current, previous = {}) {
  const out = {};
  for (const [model, values] of Object.entries(current || {})) {
    const old = previous?.[model] || {}, delta = {};
    for (const key of modelCounters) if (Number.isFinite(values?.[key]) && Number.isFinite(old?.[key])) delta[key] = Math.max(0, values[key] - old[key]);
    else if (Number.isFinite(values?.[key]) && !previous?.[model]) delta[key] = values[key];
    if (Object.keys(delta).length) out[model] = delta;
  }
  return out;
}
// A text block is held until something follows it (a tool call or another text block): then it was said midway and goes out as a 'text' event.
// The block still held when the run ends is the final reply, which the caller posts itself.
export function foldEvent(run, e, { onEvent = () => {}, onSubmitted = () => {} } = {}) {
  if(e.type==='user' && run.promptId && e.uuid===run.promptId && !run.submitted) {run.submitted=true;onSubmitted();}
  if (e.type === 'system' && e.subtype === 'init') { run.sessionId = e.session_id; run.model = e.model || run.model; }
  if(e.type==='system' && e.subtype==='task_started' && e.task_type==='local_agent') {
    (run.subagents ||= new Set()).add(e.task_id);
    if(e.tool_use_id){(run.subTask ||= new Map()).set(e.task_id,e.tool_use_id);if(e.is_backgrounded)(run.subBg ||= new Set()).add(e.tool_use_id);}
    onEvent({type:'subagent',agent_id:e.task_id,status:'running'});
  }
  if(e.type==='system' && e.subtype==='task_notification' && run.subagents?.has(e.task_id)) {
    onEvent({type:'subagent',agent_id:e.task_id,status:e.status==='completed' ? 'completed' : 'stopped'});
    // A background sub-agent's launch returns at once; the card stays running until this notice says it ended.
    const call=e.tool_use_id || run.subTask?.get(e.task_id);
    if(call && run.subBg?.has(call))onEvent({type:'subagent_result',tool_id:call,status:e.status==='completed' ? 'completed' : 'failed',text:String(e.summary || '')});
  }
  // Events with parent_tool_use_id come from a sub-agent the assistant launched; they carry sub:true so the conversation can mark them.
  const sub = e.parent_tool_use_id ? { sub: true } : {};
  const say = () => { if (run.held) onEvent({ type: 'text', text: run.held, ...(run.heldSub ? { sub: true, ...(run.heldParent ? { parent: run.heldParent } : {}) } : {}) }); run.held = ''; run.heldSub = false; run.heldParent = ''; };
  // Context length now = the last request's whole input plus what it answered (the next request carries both). Sub-agent traffic is a different context.
  const ctx = e.type === 'assistant' && !e.parent_tool_use_id && e.message?.usage;
  const tokens = ctx ? (ctx.input_tokens || 0) + (ctx.cache_read_input_tokens || 0) + (ctx.cache_creation_input_tokens || 0) + (ctx.output_tokens || 0) : 0;
  if (tokens) onEvent({ type: 'context', tokens });
  if (e.type === 'assistant') for (const c of e.message?.content || []) {
    if (c.type === 'text' && c.text?.trim()) { say(); run.held = c.text.trim(); run.heldSub = !!sub.sub; run.heldParent = e.parent_tool_use_id || ''; }
    // A sub-agent the assistant launches (Agent/Task tool) is recorded as its own card: what it was asked, what it said, what it returned.
    if (c.type === 'tool_use' && ['Agent', 'Task'].includes(c.name) && !e.parent_tool_use_id) { (run.subCalls ||= new Set()).add(c.id); onEvent({ type: 'subagent_call', tool_id: c.id, title: String(c.input?.description || c.input?.subagent_type || '子 agent'), prompt: String(c.input?.prompt || ''), kind: c.input?.subagent_type || '' }); }
    if (c.type === 'tool_use') { say(); run.toolCalls++; onEvent({ type: 'tool', tool_id:c.id, name: c.name, summary:toolSummary(c.name,c.input), detail: JSON.stringify(c.input), ...sub }); }
  }
  if(e.type==='user')for(const c of Array.isArray(e.message?.content) ? e.message.content : []){
    if(c.type==='tool_result')onEvent({type:'tool_end',tool_id:c.tool_use_id,status:c.is_error ? 'failed' : 'completed'});
    if(c.type==='tool_result' && run.subCalls?.has(c.tool_use_id)){const out=typeof c.content==='string' ? c.content : (c.content || []).map(x=>x.text || '').join(String.fromCharCode(10));if(/^Async agent launched/.test(out))(run.subBg ||= new Set()).add(c.tool_use_id);if(!run.subBg?.has(c.tool_use_id))onEvent({type:'subagent_result',tool_id:c.tool_use_id,status:c.is_error ? 'failed' : 'completed',text:out.trim()});}
  }
  if(e.type==='tool_progress')onEvent({type:'tool_progress',tool_id:e.heartbeat ? e.parent_tool_use_id || e.tool_use_id.replace(/-heartbeat-\d+$/,'') : e.tool_use_id,
    heartbeat:!!e.heartbeat,elapsed_seconds:e.elapsed_time_seconds});
  if (e.type === 'rate_limit_event') recordClaudeLimits(e.rate_limit_info);
  if (e.type === 'result') {
    const usage = e.modelUsage || {}, window = (usage[run.model] || Object.values(usage)[0])?.contextWindow;
    if (window) onEvent({ type: 'context', window });
    if (e.modelUsage && Object.keys(e.modelUsage).length) run.modelUsage = e.modelUsage;
    run.usage = e.usage || {}; run.sessionId = e.session_id || run.sessionId; run.result = e.result || '';
    if (e.is_error) run.error = e.errors?.join('; ') || run.result || e.subtype;
  }
}

export async function invokeClaude(prompt, { mode = 'work', effort, systemPrompt = SYSTEM_PROMPT, onEvent = () => {}, onReady = () => {}, beforeSubmit = () => {}, onSubmitted = () => {}, onQuestion, directory, signal, model: chosenModel, purpose, continuation, resumePrompt, inputParts, resumeInputParts, onContinuation = () => {}, workdir } = {}) {
  const cfg = read('agent/config.json'), started = Date.now();
  // Model selection belongs to explicit options/configuration, never the text being discussed.
  const requestedModel = chosenModel || cfg.claude_model;
  if (mode !== 'work') continuation = undefined;
  const signature = claudeSignature(requestedModel, effort, systemPrompt);
  let fallbackReason;
  if (continuation?.threadId && continuation.signature !== signature) fallbackReason = '启动配置（模型／推理强度／系统提示）已变';
  else if (continuation?.threadId && !claudeSessionExists(continuation.threadId)) fallbackReason = '原生会话文件已不存在';
  const resumeId = continuation?.threadId && !fallbackReason ? continuation.threadId : undefined;
  const modelBaseline = resumeId ? (continuation?.forkAt ? null : claudeModelUsageBaseline(resumeId) || continuation?.total?.modelUsage || null) : {};
  if(signal?.aborted)throw new Error(STOP_MESSAGE);
  if (resumeId) prompt = resumePrompt;
  const parts=resumeId ? resumeInputParts : inputParts;
  const initialContent=parts ? nativeTextInput(prompt,parts) : prompt;
  const bin = process.env.WORKFLOW_CLAUDE_BIN || path.join(process.env.USERPROFILE, '.local/bin/claude.exe');
  beforeSubmit(); // No await between this decision and the initial stdin write.
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, claudeArgs(requestedModel, { mode, effort, systemPrompt, resume: resumeId, forkAt: continuation?.forkAt, addDirs: workdir ? [workdir] : [] }), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],env:{...claudeEnvironment({mode,config:cfg}),OFFICE_MEMORY_RUN_DIR:directory} });
    const run = newRun(requestedModel);
    if(mode==='work')run.promptId=randomUUID();
    const acknowledgments = new Map(), totals = {};
    let modelUsageLatest = modelBaseline && structuredClone(modelBaseline), modelUsageDelta = {}, modelSession = resumeId;
    let sawModelUsage=false, modelUsageKnown=modelBaseline!==null;
    let settled = false, accepting = mode === 'work', announced = false, backgroundTasks = false, atResult = false, handedOff = false;
    const closeInputIfIdle = () => {
      if (mode === 'work' && run.submitted && atResult && !backgroundTasks && !acknowledgments.size) {
        accepting = false; child.stdin.end();
      }
    };
    const eventsFile = path.join(directory, 'events.jsonl');
    const finish = error => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      for (const ack of acknowledgments.values()) ack.reject(error || new Error('当前轮已结束'));
      acknowledgments.clear();
      if (error) reject(error); else resolve({ result: run.result, usage: run.usage, model: run.model, sessionId: run.sessionId, toolCalls: run.toolCalls, duration_ms: Date.now() - started });
    };
    const abort = () => { stopProcess(child); finish(new Error(STOP_MESSAGE)); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', finish);
    createInterface({ input: child.stdout }).on('line', line => {
      let e; try { e = JSON.parse(line); } catch { return; }
      fs.appendFileSync(eventsFile, JSON.stringify(e) + '\n');
      if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
        const input = e.request.input, reply = response => { if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response } }) + '\n'); };
        if (e.request.tool_name === 'AskUserQuestion' && onQuestion && input?.questions?.length) {
          onQuestion(claudeQuestions(input)).then(answers => reply({ behavior: 'allow', updatedInput: { ...input, answers: claudeAnswers(input, answers) } }),
            error => reply({ behavior: 'deny', message: '用户没有回答这个问题：' + error.message }));
        } else reply({ behavior: 'deny', message: '这里不能向用户提问或另行批准该请求' });
        return;
      }
      // Background hand-backs can wake the main agent without a new stdin message.
      // Its previous result no longer means idle once that new turn has begun.
      // Child output alone must not change the main turn's completion state.
      if (!e.parent_tool_use_id && (e.type === 'assistant' || e.type === 'user')) atResult = false;
      if (e.type === 'user' && acknowledgments.has(e.uuid)) {
        acknowledgments.get(e.uuid).resolve(); acknowledgments.delete(e.uuid);
      }
      foldEvent(run, e, { onEvent, onSubmitted });
      // Identity is stored only once Claude has echoed the prompt back, so a crash before that never marks messages as seen.
      if (mode === 'work' && !announced && run.submitted && run.sessionId) {
        announced = true;
        onContinuation({ threadId: run.sessionId, signature, total: { ...(resumeId && !continuation?.forkAt ? continuation?.total || {} : {}), ...(modelBaseline ? { modelUsage: modelBaseline } : {}) } }, { phase: 'start', resumed: !!resumeId });
        onContinuation({ threadId: run.sessionId }, { phase: 'turn', ref: run.promptId });
        fs.writeFileSync(path.join(directory, 'native-prompt.txt'), prompt);
        fs.writeFileSync(path.join(directory, 'continuation.json'), JSON.stringify({ threadId: run.sessionId, resumed: !!resumeId, requested: continuation?.threadId, fallbackReason }, null, 2));
      }
      if (e.type === 'system' && e.subtype === 'background_tasks_changed') {
        backgroundTasks = !!e.tasks?.length;
        closeInputIfIdle();
      }
      if (e.type === 'result') {
        // Result modelUsage is cumulative across the native session, including children.
        // A new session resets its counters; previously accumulated work in this call stays.
        if(e.session_id && modelSession && e.session_id!==modelSession && !(continuation?.forkAt && !sawModelUsage))modelUsageLatest={};
        modelSession=e.session_id || modelSession;
        if (e.modelUsage && Object.keys(e.modelUsage).length) {
          sawModelUsage=true;
          for(const [model,values] of Object.entries(e.modelUsage))for(const key of modelCounters){
            const old=modelUsageLatest?.[model]?.[key];
            if(!Number.isFinite(values?.[key]) || values[key]<0 || (modelUsageLatest?.[model] && !Number.isFinite(old)) || (Number.isFinite(old) && values[key]<old))modelUsageKnown=false;
          }
          const delta = modelBaseline!==null ? claudeModelDelta(e.modelUsage, modelUsageLatest) : {};
          for (const [model, values] of Object.entries(delta)) {
            const target = modelUsageDelta[model] ||= {};
            for (const [key, value] of Object.entries(values)) target[key] = (target[key] || 0) + value;
          }
          // Keep high water marks if a crashed result zeroes fields or a partial snapshot omits a model.
          for(const [model,values] of Object.entries(e.modelUsage)){
            const target=(modelUsageLatest ||= {})[model] ||= {};
            for(const key of modelCounters)if(Number.isFinite(values?.[key]))target[key]=Math.max(target[key]||0,values[key]);
          }
          if(mode==='work')onContinuation({ threadId: run.sessionId, total: { modelUsage:structuredClone(modelUsageLatest) } }, { phase: 'finish' });
        }
        for (const key of ['input_tokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
          if (typeof e.usage?.[key] === 'number') totals[key] = (totals[key] || 0) + e.usage[key];
        }
        run.usage = { ...run.usage, ...totals };
        // The CLI can stay alive after a result while background tools run. Keep the
        // same input transport usable instead of leaving an active but deaf office turn.
        // A resume startup result before our initial replay is not our completed request.
        if(mode==='work'){atResult = !!run.submitted;closeInputIfIdle();}
        // A result that passes the turn to Codex (a line starting with @Codex) ends this turn even while a background task keeps the CLI alive:
        // otherwise later user messages are steered into a finished turn and a later result overwrites the one that carried the handoff.
        if(mode==='work' && atResult && !acknowledgments.size && backgroundTasks && /^[ 	]*@codex\b/im.test(run.result)){
          handedOff = true; accepting = false; finish(); stopProcess(child);
        }
      }
    });
    child.on('close', code => {
      const u = run.usage, input = u.input_tokens || 0, cacheRead = u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens || 0;
      const failed = run.error || (code !== 0 && !handedOff);
      const sum=key=>Object.values(modelUsageDelta).reduce((n,v)=>n+(v[key]||0),0);
      const fields=sawModelUsage ? {input_tokens:sum('inputTokens')+sum('cacheReadInputTokens')+sum('cacheCreationInputTokens'),cached_input_tokens:sum('cacheReadInputTokens'),cache_creation_tokens:sum('cacheCreationInputTokens'),output_tokens:sum('outputTokens'),model_usage:modelUsageDelta} : {input_tokens:input+cacheRead+cacheWrite,cached_input_tokens:cacheRead,cache_creation_tokens:cacheWrite,output_tokens:u.output_tokens||0};
      recordRun({ id: path.basename(directory), run_dir:runRelative(directory), provider: 'claude', model: run.model, feature: 'agent', purpose, session_id: run.sessionId, status: failed ? 'failed' : 'completed',
        usage_known:sawModelUsage ? modelUsageKnown : Number.isFinite(u.input_tokens)&&Number.isFinite(u.output_tokens),
        ...fields,
        ...(sawModelUsage && !modelUsageKnown ? {model_usage_known:false} : {}),
        tool_calls: run.toolCalls, duration_ms: Date.now() - started });
      if (failed) finish(new Error(run.error || `claude 退出 (${code})`));
      else if (!run.result) finish(new Error(EMPTY_MESSAGE)); else finish();
    });
    if (mode !== 'work') child.stdin.end(prompt);
    else {
      const writeMessage = (content, uuid) => child.stdin.write(JSON.stringify({type:'user',uuid,session_id:run.sessionId || '',message:{role:'user',content},parent_tool_use_id:null})+'\n');
      writeMessage(initialContent, run.promptId);
      onReady((text, options={}) => new Promise((resolve, reject) => {
        if ((options.model && options.model!==requestedModel) ||
          (options.effort && options.effort!==effort) || (options.mode && options.mode!==mode)) {
          reject(new Error('原生运行配置不同，需新建原生轮')); return;
        }
        if (!accepting || settled || signal?.aborted) { reject(new Error('当前轮已结束')); return; }
        atResult = false;
        const uuid = randomUUID(); acknowledgments.set(uuid, {resolve, reject});
        writeMessage(options.inputParts ? nativeTextInput(text,options.inputParts) : text, uuid);
      }));
    }
  });
}
