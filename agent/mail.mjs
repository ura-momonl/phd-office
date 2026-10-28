import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, read, write } from '../automation/files.mjs';
import { invokeNative } from './run.mjs';
import { extractJSON } from '../dashboard/cards.mjs';
import { mailJudgePrompt } from '../prompts/templates.mjs';

// Owner of "when and how the model reviews new mail". The collector stays model-free; mail-flow validates and writes every decision.
const mailDirectory = path.join(root, '.runtime/mail-flow');
let judging = false;
const MAIL_TIMEOUT_MS = 120000;
const MAIL_MAX_OUTPUT_CHARS = 16000;

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

function applyViaCli(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['mail-flow/run.mjs', 'apply', file], { cwd: root, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `apply exited ${code}`));
      try { resolve(JSON.parse(out.trim().split('\n').at(-1))); } catch { reject(new Error('apply returned no result')); }
    });
  });
}

export const parseDecisions = extractJSON;

// Opaque Outlook IDs remain owned by the program. Each model sees short refs
// from this one packet; decoded decisions still pass Flow's final validation.
function modelPacket(packet, body) {
  const messages = new Map(packet.messages.map((m, i) => [m.id, `m${i + 1}`]));
  const tasks = new Map((packet.tasks || []).map((t, i) => [t.id, `t${i + 1}`]));
  return {
    body: {...body, packet_id:'batch', messages:body.messages.map(({id, fingerprint, related_task_ids, ...m}) =>
      ({...m, id:messages.get(id), related_task_ids:(related_task_ids || []).map(id => tasks.get(id))})),
      tasks:(body.tasks || []).map(t => ({...t, id:tasks.get(t.id)}))},
    messages:new Map(body.messages.map(m => [messages.get(m.id), m.id])),
    tasks:new Map([...tasks].map(([id, ref]) => [ref, id]))
  };
}

function decodeDecisions(text, view, tier) {
  if (typeof text !== 'string' || text.length > MAIL_MAX_OUTPUT_CHARS) throw new Error('Mail output exceeds character limit');
  const result = parseDecisions(text);
  if (!result || result.packet_id !== 'batch' || Object.keys(result).some(k => !['packet_id','decisions'].includes(k))) throw new Error('Invalid mail tier envelope');
  if (!Array.isArray(result.decisions) || result.decisions.length !== view.messages.size) throw new Error('Mail tier must cover every input message exactly once');
  const seen = new Set();
  return result.decisions.map(d => {
    if (!d || !view.messages.has(d.message_id) || seen.has(d.message_id)) throw new Error('Unknown or duplicate mail message reference');
    seen.add(d.message_id);
    if (!['ignore','defer','update','new',...(tier === 'screen' ? ['escalate'] : [])].includes(d.decision)) throw new Error('Invalid mail tier decision');
    if (d.task_id !== undefined && !view.tasks.has(d.task_id)) throw new Error('Unknown mail task reference');
    return {...d, message_id:view.messages.get(d.message_id), ...(d.task_id !== undefined ? {task_id:view.tasks.get(d.task_id)} : {})};
  });
}

const dayOf = at => new Date(at).toLocaleDateString('en-CA');
const judgeLines = directory => {
  const log = path.join(directory, 'judge.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

// A safety net, not a quota plan: model calls the unattended loop may make per day (judging attempts plus prepared cards).
export function automationBudget({ directory = mailDirectory, config = read('agent/config.json'), now = Date.now() } = {}) {
  const cap = Number.isFinite(config.automation_daily_calls) ? config.automation_daily_calls : 60;
  const prepared = Object.values(read('.runtime/inbox/auto-prepared.json', {})).filter(v => dayOf(v.at) === dayOf(now)).length;
  const used = judgeLines(directory).filter(l => dayOf(l.at) === dayOf(now)).reduce((n, l) => n + (l.calls ?? 1), 0) + prepared;
  return { used, cap, left: Math.max(0, cap - used) };
}

// One merged review per pending packet (one or two model tiers). A packet that
// keeps failing is retried at most three times, five minutes apart.
export async function judgePending({ directory = mailDirectory, invoke = invokeNative, apply = applyViaCli, config = read('agent/config.json'), now = Date.now() } = {}) {
  if (!config.automatic_mail_judgment) return { skipped: 'off' };
  const packetFile = path.join(directory, 'review-packet.json');
  if (judging || !fs.existsSync(packetFile)) return { skipped: 'none' };
  if (automationBudget({ directory, config, now }).left <= 0) return { skipped: 'cap' };
  const packet = readJSON(packetFile);
  const stateFile = path.join(directory, 'judge-state.json');
  const state = fs.existsSync(stateFile) ? readJSON(stateFile) : {};
  const same = state.packet_id === packet.packet_id;
  if (same && (state.attempts >= 3 || now - state.at < 5 * 60000)) return { skipped: 'backoff' };
  // Reuse the minute beat; no timer, paid pre-screen or waiting-state copy.
  // Arrival time bounds the wait even across restarts/new packets. Missing
  // scheduling evidence (including old packets) means review immediately.
  const wait = Math.max(0, Number(config.mail_batch_wait_minutes) || 0) * 60000;
  const min = Math.max(1, Number(config.mail_batch_min_messages) || 4);
  if (!same && wait && packet.messages.length && packet.messages.length < min
      && packet.messages.every(m => m.batchable === true && Number.isFinite(Date.parse(m.received)) && Date.parse(m.received) <= now)) {
    const until = Math.min(...packet.messages.map(m => Date.parse(m.received))) + wait;
    if (now < until) return { skipped: 'batch', messages: packet.messages.length, until: new Date(until).toISOString() };
  }
  const attempts = same ? state.attempts + 1 : 1;
  let calls = 0;
  const stats = { related: 0, screen_decided: 0, screen_escalated: 0, judgment_decided: 0, ms: {} };
  const record = extra => {
    fs.writeFileSync(stateFile, JSON.stringify({ packet_id: packet.packet_id, attempts, at: now, ...extra }));
    fs.appendFileSync(path.join(directory, 'judge.log'), JSON.stringify({ at: new Date(now).toISOString(), packet_id: packet.packet_id, messages: packet.messages.length, attempts, calls, ...stats, ...extra }) + '\n');
  };
  // Two tiers, both Codex. The screen model (Luna) decides the small independent mail and passes the rest up as 'escalate'; the judgment model
  // (Sol) decides everything the rules already tied to an open task plus whatever the screen passed up. Their decisions are merged and applied once,
  // each tagged with the tier that made it: that tier's agent later prepares the task's card.
  const ask = async (tier, promptFile, body) => {
    const instructions = promptFile.map(f => fs.readFileSync(path.join(root, 'mail-flow', f), 'utf8')).join('\n');
    const view = modelPacket(packet, body);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('后台邮件判断超过 120 秒时限')), MAIL_TIMEOUT_MS);
    calls++;
    const t0 = Date.now();
    try {
      const output = await invoke('codex', mailJudgePrompt(instructions, JSON.stringify(view.body)), {
        directory:path.join(root, '.runtime/agent/runs', `mail-judge-${packet.packet_id.slice(0, 12)}-${attempts}-${tier}`),
        mode:'ask', purpose:'mail', model:config[`mail_${tier}_model`], effort:config[`mail_${tier}_effort`],
        signal:controller.signal, maxOutputChars:MAIL_MAX_OUTPUT_CHARS});
      return decodeDecisions(output.result, view, tier);
    } finally { clearTimeout(deadline); stats.ms[tier] = Date.now() - t0; }
  };
  judging = true;
  try {
    const up = new Set(packet.messages.filter(m => m.related_task_ids?.length).map(m => m.id)), decisions = [];
    stats.related = up.size;
    const light = packet.messages.filter(m => !up.has(m.id));
    if (light.length) for (const d of await ask('screen', ['REVIEW-PROMPT.md', 'SCREEN-PROMPT.md'], { ...packet, messages: light })) {
      if (d.decision === 'escalate') { up.add(d.message_id); stats.screen_escalated++; } else { stats.screen_decided++; decisions.push({ ...d, handler: 'screen' }); }
    }
    if (up.size) decisions.push(...(await ask('judgment', ['REVIEW-PROMPT.md'], { ...packet, messages: packet.messages.filter(m => up.has(m.id)) })).map(d => ({ ...d, handler: 'judgment' })));
    stats.judgment_decided = decisions.filter(d => d.handler === 'judgment').length;
    const decisionsFile = path.join(directory, 'decisions.json');
    fs.writeFileSync(decisionsFile, JSON.stringify({ packet_id: packet.packet_id, decisions }));
    const result = await apply(decisionsFile);
    record({ applied: result.applied });
    return { packet_id: packet.packet_id, applied: result.applied };
  } catch (error) {
    record({ error: error.message });
    return { error: error.message };
  } finally { judging = false; }
}

// Cards the agent has not seen yet (no AI-written options). Each card fingerprint is tried once, so a failing run cannot loop.
export function pickBareCards(inbox, { limit = 2, triedFile = '.runtime/inbox/auto-prepared.json', busy = false } = {}) {
  if (busy) return [];
  const tried = read(triedFile, {});
  const picked = inbox.filter(card => card.source === 'mail' && card.actions?.[0]?.id === 'agent-check' && tried[card.id]?.fingerprint !== card.fingerprint).slice(0, limit);
  for (const card of picked) tried[card.id] = { fingerprint: card.fingerprint, at: new Date().toISOString() };
  if (picked.length) write(triedFile, tried);
  return picked;
}

// Numbers for the "handled automatically today" panel; only counts what the program itself recorded.
export function automationToday(now = new Date(), { directory = mailDirectory } = {}) {
  const lines = judgeLines(directory), today = at => dayOf(at) === dayOf(now);
  const stateFile = path.join(directory, 'judge-state.json');
  const state = fs.existsSync(stateFile) && fs.existsSync(path.join(directory, 'review-packet.json')) ? readJSON(stateFile) : {};
  const budget = automationBudget({ directory, now: +new Date(now) });
  // Failures stay visible while the packet that failed is still waiting; a later success clears it.
  const issue = state.error ? (state.attempts >= 3 ? `自动判断连续 3 次失败，已停止重试：${state.error}` : `自动判断第 ${state.attempts} 次失败，稍后重试：${state.error}`) : null;
  return {
    judged: lines.filter(l => today(l.at) && Number.isFinite(l.applied)).reduce((n, l) => n + l.messages, 0),
    prepared: Object.values(read('.runtime/inbox/auto-prepared.json', {})).filter(v => today(v.at)).length,
    calls: budget.used, cap: budget.cap, issue
  };
}
