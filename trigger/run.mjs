// Scheduled handoffs. An assistant leaves "at time T, open this new conversation"; the backend's
// existing 10-second beat (dashboard/server.mjs) fires it through the same sendChat() path as
// `agent handoff`. No extra timer, process, model call, retry or recurrence while waiting.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { read, write } from '../automation/files.mjs';
import { handoffCaller, sendChat } from '../agent/run.mjs';
import { tickPaper, paperStatus, paperMetrics } from '../workspace/shared/personal-quant/paper.mjs';

const file = '.runtime/trigger/triggers.json';
const MAX_PENDING = 20, DEFAULT_GRACE_MINUTES = 120, MIN_LEAD_MS = 20000, MAX_TEXT = 20000;
const load = () => read(file, { triggers: [] });
const view = t => ({ id: t.id, status: t.status, at: t.at, title: t.request.title || '', by: t.handoff.provider, ...(t.fired_at ? { fired_at: t.fired_at } : {}), ...(t.session_id ? { session_id: t.session_id, task_id: t.task_id } : {}), ...(t.error ? { error: t.error } : {}) });

// Called by `trigger add` from an assistant work turn. request = {text, title?, project_id?, model?, effort?}.
// when = {at: ISO timestamp with offset} or {in_minutes}; grace_minutes: how late a fire is still acceptable
// (e.g. backend was down at the due time); later than that it becomes "missed" and nothing is sent.
export function addTrigger({ at, in_minutes, grace_minutes = DEFAULT_GRACE_MINUTES, ...request }, { now = Date.now(), handoff = handoffCaller() } = {}) {
  let due;
  if (in_minutes !== undefined) {
    if (at !== undefined) throw new Error('at 与 in_minutes 只给一个');
    if (!(Number(in_minutes) > 0)) throw new Error('in_minutes 须为正数');
    due = now + Number(in_minutes) * 60000;
  } else {
    if (typeof at !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(at)) throw new Error('at 须为带时区的 ISO 时间，例如 2026-10-22T20:00:00-05:00');
    due = Date.parse(at);
  }
  if (!Number.isFinite(due) || due < now + MIN_LEAD_MS) throw new Error('触发时间须在 20 秒之后');
  if (!(Number(grace_minutes) >= 1)) throw new Error('grace_minutes 须不小于 1');
  if (typeof request.text !== 'string' || !request.text.trim()) throw new Error('text 必填：到点交给接手者的交接正文');
  if (request.text.length > MAX_TEXT) throw new Error(`text 不超过 ${MAX_TEXT} 字`);
  const state = load();
  if (state.triggers.filter(t => t.status === 'scheduled').length >= MAX_PENDING) throw new Error(`待触发的已有 ${MAX_PENDING} 条`);
  const clean = Object.fromEntries(['text', 'title', 'project_id', 'model', 'effort'].filter(k => request[k] !== undefined).map(k => [k, request[k]]));
  const trigger = { id: randomUUID().slice(0, 8), status: 'scheduled', at: new Date(due).toISOString(), grace_minutes: Number(grace_minutes), created_at: new Date(now).toISOString(), handoff, request: clean };
  state.triggers.push(trigger);
  write(file, state);
  return view(trigger);
}

export function cancelTrigger(id) {
  const state = load(), t = state.triggers.find(x => x.id === id || x.id.startsWith(id));
  if (!t) throw new Error('未找到触发：' + id);
  if (t.status !== 'scheduled') throw new Error(`触发 ${t.id} 已是 ${t.status}，不能取消`);
  t.status = 'cancelled';
  write(file, state);
  return view(t);
}

// One beat. Write-ahead: a trigger is marked "firing" before sending, so a crash in between can never
// send twice; it shows up as failed/interrupted instead. A failure is recorded, not retried.
let running = false;
export async function fireDue({ now = Date.now(), send = sendChat } = {}) {
  // This user-approved local paper job shares the existing beat, but never
  // enters sendChat/drain or starts a model. Its own date/busy guards do the work.
  void tickPaper({now: new Date(now)}).catch(e => console.error('纸面跟踪：' + e.message));
  if (running) return [];
  running = true;
  try { return await fireAll(now, send); } finally { running = false; }
}
async function fireAll(now, send) {
  const state = load(), fired = [];
  for (const t of state.triggers) {
    if (t.status === 'firing') { t.status = 'failed'; t.error = '发送中后端中断，未确认是否已创建对话'; write(file, state); continue; }
    if (t.status !== 'scheduled' || Date.parse(t.at) > now) continue;
    if (now - Date.parse(t.at) > t.grace_minutes * 60000) { t.status = 'missed'; t.error = `到点时后端未运行，超过 ${t.grace_minutes} 分钟宽限，未发送`; write(file, state); continue; }
    t.status = 'firing'; write(file, state);
    try {
      const job = await send({ ...t.request, handoff: t.handoff });
      Object.assign(t, { status: 'fired', fired_at: new Date().toISOString(), session_id: job.session_id, task_id: job.task_id });
    } catch (error) { Object.assign(t, { status: 'failed', error: error.message }); }
    write(file, state);
    fired.push(view(t));
  }
  return fired;
}

export function run(action, argument) {
  if (action === 'paper-status') {
    const state = paperStatus();
    console.log(JSON.stringify(state ? {enabled: state.enabled, sealedDate: state.sealedDate, next: state.next,
      metrics: paperMetrics(state), lastValuationDate: state.lastValuationDate, error: state.error ?? null,
      heartbeat: read('.runtime/personal-quant/heartbeat.json', null), activation: read('.runtime/personal-quant/activation.json', null),
      report: 'workspace/outbox/personal-quant/paper/LATEST.md'} : {enabled: false}, null, 2));
  } else if (action === 'add') {
    if (!argument) throw new Error('trigger add <UTF-8 JSON 文件路径>');
    console.log(JSON.stringify(addTrigger(JSON.parse(fs.readFileSync(argument, 'utf8').replace(/^\uFEFF/, '')))));
  } else if (action === 'list') {
    const all = argument === 'all', list = load().triggers.filter(t => all || t.status === 'scheduled');
    console.log(JSON.stringify({ triggers: list.map(view), ...(all ? {} : { note: '只列待触发；list all 看全部（已触发、失败、错过、取消）' }) }, null, 2));
  } else if (action === 'show') {
    const t = load().triggers.find(x => x.id.startsWith(argument || '\0'));
    if (!t) throw new Error('未找到触发：' + argument);
    console.log(JSON.stringify(t, null, 2));
  } else if (action === 'cancel') console.log(JSON.stringify(cancelTrigger(argument || '')));
  else throw new Error('trigger add <JSON路径>|list [all]|show <id>|cancel <id>|paper-status');
}
