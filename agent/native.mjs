import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// What Codex and Claude have in common. Each AI has its own module (codex.mjs, claude.mjs) with the same contract:
//
//   invokeX(prompt, { mode, effort, onEvent, onReady?, onSubmitted?, directory, signal, model? }) -> { result, usage, model, sessionId, toolCalls, duration_ms }
// onReady(send) exposes the native input transport; send(text, {model?,effort?,mode?})
// writes immediately. Its promise is a receipt, not permission to write another input.
// onSubmitted() acknowledges the initial prompt (Codex turn/start response; Claude replayed initial user UUID), once per invocation.
// beforeSubmit() runs synchronously at the initial-send boundary; a thrown error
// leaves the input unsent. Native context-consumption rules are unchanged.
//
// mode  'ask'  one reply, no tools (cards, mail judgement: the program parses the reply)
//       'work'  every conversation turn, whoever asked for it: full access inside the project folder (read, write, run commands, use the modules)
// model a per-call override on both sides (a Claude alias such as sonnet, or a Codex model id); Codex without one uses codex_model from agent/config.json.
// Both write events to <directory>/events.jsonl, record one run in the usage ledger, and fail with the messages below.
export const STOP_MESSAGE = '已停止本次任务';
// No run has a time or model-turn limit. The stop button ends a run. MAX_TURNS
// caps colleague handoffs; native launch and work own concurrency/card counts.
export const EMPTY_MESSAGE = '模型未返回完成结果；执行记录已保留';

// Keep the Workbench's source boundaries as native text blocks. These are all
// user-input content, not fabricated system/assistant messages. Joining their
// text reproduces the inspectable prompt exactly, including separator newlines.
export function nativeTextInput(prompt, parts) {
  if(!parts)return [{type:'text',text:prompt}];
  if(!Array.isArray(parts) || !parts.length || parts.some(p=>typeof p.text!=='string') || parts.map(p=>p.text).join('\n')!==prompt)
    throw new Error('原生输入分块与提示词正文不一致；尚未提交');
  return parts.map(({text},i)=>({type:'text',text:(i ? '\n' : '')+text}));
}

// The user's accepted standing prompt (Codex baseInstructions, Claude --system-prompt).
// Keep this established invocation scheme; history completeness is handled in run.mjs.
export const SYSTEM_PROMPT = readFileSync(new URL('../prompts/office-system.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd();

export function stopProcess(child) {
  if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
}
