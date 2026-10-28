import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root, read, write, input, checkProjects } from '../automation/files.mjs';
// Dates in this office are America/Chicago wall time. A date without a clock time is a whole day there, never a UTC midnight.
const ZONE = 'America/Chicago', EVENTS = 'calendar/events.json';
export const REMIND_DAYS = 5;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const parts = ms => Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
export const chicagoDay = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const shiftDay = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
// The instant of a Chicago wall-clock time: one of the two UTC offsets (daylight or standard time) reads back as exactly that time.
function instantOf(date, hour, minute, second) {
  for (const offset of [5, 6]) {
    const ms = Date.parse(date + 'T00:00:00Z') + ((hour + offset) * 60 + minute) * 60000 + second * 1000, p = parts(ms);
    if (`${p.year}-${p.month}-${p.day}` === date && p.hour === String(hour).padStart(2, '0')) return ms;
  }
  throw new Error('无法换算为芝加哥时间：' + date);
}
const DATE = /^\d{4}-\d\d-\d\d$/, STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
// A date alone is the whole day (a deadline on it falls at the end of the day, a start at its beginning); a time must carry its zone. Anything else is an error.
export function parseWhen(value, edge = 'start') {
  if (typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value))
    return { date: value, time: null, all_day: true, ms: edge === 'end' ? instantOf(value, 23, 59, 59) : instantOf(value, 0, 0, 0) };
  if (typeof value === 'string' && STAMP.test(value) && Number.isFinite(Date.parse(value))) {
    const ms = Date.parse(value), p = parts(ms);
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, all_day: false, ms };
  }
  throw new Error(`无法解析的日期：${JSON.stringify(value)}（需要 YYYY-MM-DD，或带时区的 ISO 时间）`);
}
// A deadline as a full instant for the inbox, which sorts and colours cards by it; a value that cannot be read is left as it was.
export function dueIso(value) {
  if (!value) return null;
  try { return new Date(parseWhen(value, 'end').ms).toISOString(); } catch { return value; }
}
export const dueMs = value => { try { return value ? parseWhen(value, 'end').ms : NaN; } catch { return NaN; } };

// Everything dated, computed from the places that own the dates; nothing is copied. Values that cannot be read are reported, not guessed.
export function calendarItems({ mail = [], work = [], events = [], blocks = [], links = [] }, now = new Date(), days = 400) {
  const items = [], problems = [];
  const add = (spec, field, value, edge, end) => {
    try {
      const when = parseWhen(value, edge);
      // Only ledger entries have an end: the moment they are over. Dates owned by mail and work stay listed until their owner closes them.
      const until = !['calendar', 'weekly'].includes(spec.source) ? null : end ? parseWhen(end, 'end').ms : when.all_day ? instantOf(when.date, 23, 59, 59) : when.ms;
      const last = end ? parseWhen(end, 'end') : null;
      items.push({ ...spec, ...when, ...(last ? { end_date: last.date, end_time: last.time } : {}), until });
    } catch { problems.push({ source: spec.source, source_id: spec.source_id, title: spec.title, field, value: String(value) }); }
  };
  for (const t of mail.filter(t => t.status !== 'done')) {
    // A todo mail task already has its own inbox card; a waiting one does not.
    const spec = { source: 'mail', source_id: t.id, title: t.title, status: t.status, in_inbox: t.status === 'todo', project_ids: links.find(l => l.module === 'mail' && l.item_id === t.id)?.project_ids || [] };
    if (t.deadline) add({ ...spec, kind: 'deadline' }, 'deadline', t.deadline, 'end');
    if (t.check_at) add({ ...spec, kind: 'followup' }, 'check_at', t.check_at, 'start');
  }
  for (const w of work.filter(w => w.due_at && !['done', 'cancelled'].includes(w.status)))
    add({ source: 'work', source_id: w.id, title: w.title, status: w.status, kind: 'deadline', project_ids: w.project_ids || [],
      in_inbox: w.review?.state === 'pending' || ['waiting_user', 'failed'].includes(w.status) }, 'due_at', w.due_at, 'end');
  for (const e of events) {
    const spec = { source: 'calendar', source_id: e.id, title: e.title, status: 'scheduled', kind: e.kind === 'deadline' ? 'deadline' : 'event', note: e.note || '', project_ids: e.project_id ? [e.project_id] : [], in_inbox: false };
    if (!e.recurrence) { add(spec, 'start', e.start, e.kind === 'deadline' ? 'end' : 'start', e.end); continue; }
    try {
      const from = parseWhen(e.start), last = e.end ? parseWhen(e.end, 'end') : null;
      const series = { id: e.id, date: from.date, time: from.time, end_date: last?.date, end_time: last?.time, recurrence: e.recurrence };
      for (const date of recurrenceDates(e, shiftDay(chicagoDay(now.getTime()), days))) {
        if (e.excluded_dates?.includes(date)) continue;
        try {
          // Shift calendar days, not UTC durations: a 14:00 meeting stays at 14:00 across DST.
          const start = occurrenceTime(e.start, date), end = last ? occurrenceTime(e.end, shiftDay(date, dayDiff(last.date, from.date))) : undefined;
          add({ ...spec, source_id: `${e.id}@${date}`, series, occurrence_date: date }, 'start', start, e.kind === 'deadline' ? 'end' : 'start', end);
        } catch { problems.push({ ...spec, field: 'recurrence', value: date }); }
      }
    } catch { problems.push({ ...spec, field: 'recurrence', value: String(e.start) }); }
  }
  for (const b of blocks)
    add({ source: 'weekly', source_id: b.id, week: b.week, intent_id: b.intent_id, task_id: b.task_id || null, title: b.title, kind: 'event', status: 'scheduled',
      project_ids: b.project_ids, note: '周目标工作块', in_inbox: false, done: !!b.task_id && work.some(w => w.id === b.task_id && w.status === 'done') }, 'start', b.start, 'start', b.end);
  return { items: items.sort((a, b) => a.ms - b.ms), problems };
}
// What lies ahead (default two weeks), plus anything dated that is already due and still open. Ledger entries drop out once over, unless the caller
// draws a calendar and asks to keep them (flagged over).
export function upcoming(data, now = new Date(), days = 14, keepOver = false) {
  const { items, problems } = calendarItems(data, now, days), today = chicagoDay(now.getTime());
  return { today, problems, items: items.filter(i => dayDiff(i.date, today) <= days && (keepOver || i.until === null || i.until >= now.getTime()))
    .map(i => ({ ...i, due: i.kind !== 'event' && i.ms <= now.getTime(), ...(i.until !== null && i.until < now.getTime() ? { over: true } : {}) })) };
}
const PLACE = { deadline: '截止', followup: '复查时间' };
// Reminders for the inbox: a deadline REMIND_DAYS ahead and on its day (it stays after that until acknowledged), and a follow-up time that has come.
// One card per item whose fingerprint carries the stage and the date, so acknowledging one stage never hides the next, and a moved date asks again.
export function calendarReminders(data, now = new Date()) {
  const today = chicagoDay(now.getTime());
  return calendarItems(data, now, REMIND_DAYS).items.flatMap(i => {
    if (i.in_inbox || i.kind === 'event') return [];
    const left = dayDiff(i.date, today), stage = i.kind === 'followup' ? (i.ms <= now.getTime() ? 'followup' : null) : left <= 0 ? 'due' : left <= REMIND_DAYS ? 'ahead' : null;
    if (!stage) return [];
    const at = `${PLACE[i.kind]} ${i.date}${i.time ? ' ' + i.time : ''}`;
    const detail = { ahead: `${at}，${REMIND_DAYS} 天内到期，未标记完成。`, due: `${at}，已到截止日，未标记完成。`, followup: `${at} 已到，这件事还在等对方。` }[stage];
    return [{ id: `calendar:${i.kind}:${i.source}:${i.source_id}`, source: 'calendar', source_id: `${i.kind}-${i.source}-${i.source_id}`, title: i.title, detail, category: '日程', kind: 'decision',
      project_ids: i.project_ids, due_at: i.kind === 'deadline' ? new Date(i.ms).toISOString() : null, outputs: [], stage,
      actions: [{ id: 'ack', type: 'accept', label: '知道了' }] }];
  });
}

const events = () => read(EVENTS, { events: [] }).events;
// Weekly owns goal work blocks. The calendar is a read-only projection of those records, not another copy in events.json.
export function weeklyBlocks() {
  const dir = path.join(root, '.runtime/weekly');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(week => DATE.test(week)).flatMap(week =>
    (read(`.runtime/weekly/${week}/plan.json`, { intents: [] }).intents || []).filter(i => i.schedule?.start).map(i => ({
      id: `${week}:${i.id}`, week, intent_id: i.id, task_id: i.task_id || null, title: i.title, project_ids: i.project_ids || [], ...i.schedule
    })));
}
export const calendarData = (mail, work, links) => ({ mail, work, links, events: events(), blocks: weeklyBlocks() });
// The ledger is typed in Chicago wall time: a clock time without a zone (what a form field gives) is read there and stored as an instant.
export function ledgerTime(value) {
  const m = typeof value === 'string' && /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(value);
  if (!m) return value;
  return new Date(instantOf(m[1], +m[2], +m[3], +(m[4] || 0))).toISOString();
}
function occurrenceTime(value, date) {
  const when = parseWhen(value);
  return when.all_day ? date : ledgerTime(`${date}T${when.time}`);
}
// The ledger owns one rule plus omitted dates; occurrences are a read-only projection.
// Months/years without the original day (31st, leap day) are skipped, never moved.
function* recurrenceDates(event, through) {
  const from = parseWhen(event.start).date, rule = event.recurrence, step = rule.interval || 1;
  const limit = rule.until && rule.until < through ? rule.until : through;
  for (let n = 0; ; n++) {
    const date = new Date(from);
    if (rule.frequency === 'daily' || rule.frequency === 'weekly') date.setUTCDate(date.getUTCDate() + n * step * (rule.frequency === 'weekly' ? 7 : 1));
    else if (rule.frequency === 'monthly') date.setUTCMonth(date.getUTCMonth() + n * step);
    else if (rule.frequency === 'yearly') date.setUTCFullYear(date.getUTCFullYear() + n * step);
    else throw new Error('未知重复频率');
    if (!Number.isFinite(date.getTime())) return;
    const day = date.toISOString().slice(0, 10);
    if (day > limit) return;
    if (['monthly', 'yearly'].includes(rule.frequency) && day.slice(8) !== from.slice(8)) continue;
    yield day;
  }
}
// One validation for a new entry and an edited one, so an edit can never store what a new entry would refuse.
function buildEvent(request, id) {
  const text = v => typeof v === 'string' ? v.trim() : '';
  const title = text(request.title), kind = request.kind ?? 'event', end = ledgerTime(request.end || undefined), start = ledgerTime(request.start);
  if (!title) throw new Error('需要 title');
  if (!['event', 'deadline'].includes(kind)) throw new Error('kind 只能是 event 或 deadline');
  const from = parseWhen(start, kind === 'deadline' ? 'end' : 'start');
  if (kind === 'deadline' && end) throw new Error('截止只有 start，没有 end');
  if (end && parseWhen(end, 'end').ms < from.ms) throw new Error('end 不能早于 start');
  let recurrence;
  if (request.recurrence != null) {
    const r = request.recurrence;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.frequency)) throw new Error('重复频率只能是 daily、weekly、monthly 或 yearly');
    const interval = r.interval ?? 1;
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('重复间隔需要 1–365 的整数');
    if (r.until && (!DATE.test(r.until) || parseWhen(r.until).date < from.date)) throw new Error('重复结束日期不能早于开始日期，且须为 YYYY-MM-DD');
    recurrence = { frequency: r.frequency, interval, ...(r.until ? { until: r.until } : {}) };
  }
  return { id, title, kind, start, ...(end ? { end } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(request.project_id ? { project_id: checkProjects([request.project_id])[0] } : {}), ...(text(request.note) ? { note: text(request.note) } : {}) };
}
export function addEvent(request) {
  return addEvents({ events: [request], recurrence: request.recurrence })[0];
}
// Validate the entire shared-rule batch before one ledger write: never leave half a batch saved.
export function addEvents(request) {
  if (!Array.isArray(request.events) || !request.events.length) throw new Error('需要至少一个事项 events');
  const added = request.events.map((item, index) => {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('事项需要是对象');
      return buildEvent({ ...item, recurrence: request.recurrence }, 'ev-' + randomUUID().slice(0, 8));
    } catch (error) { throw new Error(`第 ${index + 1} 个事项：${error.message}`); }
  });
  write(EVENTS, { events: [...events(), ...added] });
  return added;
}
// Fields that are sent replace the old ones; end, project_id and note are cleared by sending them empty.
export function updateEvent(id, patch) {
  const all = events(), old = all.find(e => e.id === id);
  if (!old) throw new Error('没有这个事件：' + id);
  const event = buildEvent({ ...old, ...patch }, id);
  if (event.recurrence && old.excluded_dates?.length) event.excluded_dates = old.excluded_dates;
  write(EVENTS, { events: all.map(e => e.id === id ? event : e) });
  return event;
}
export function removeEvent(id, { scope, occurrence_date } = {}) {
  const all = events(), event = all.find(e => e.id === id);
  if (!event) throw new Error('没有这个事件：' + id);
  if (event.recurrence) {
    if (!['one', 'all'].includes(scope)) throw new Error('删除重复事件须选择 scope: one 或 all');
    if (scope === 'one') {
      if (!DATE.test(occurrence_date) || ![...recurrenceDates(event, occurrence_date)].includes(occurrence_date)) throw new Error('这一天不是该系列的一次事件');
      const updated = { ...event, excluded_dates: [...new Set([...(event.excluded_dates || []), occurrence_date])] };
      write(EVENTS, { events: all.map(e => e.id === id ? updated : e) });
      return updated;
    }
  } else if (scope && scope !== 'all') throw new Error('该事件不是重复事件');
  write(EVENTS, { events: all.filter(e => e.id !== id) });
  return event;
}
export async function run(action, argument) {
  if (action === 'add') { const request = input(argument); return void console.log(JSON.stringify(Object.hasOwn(request, 'events') ? addEvents(request) : addEvent(request), null, 2)); }
  if (action === "update") { const request = input(argument); return void console.log(JSON.stringify(updateEvent(request.id, request), null, 2)); }
  if (action === "remove") {
    const request = typeof argument === 'string' && argument.startsWith('ev-') ? { id: argument } : input(argument);
    return void console.log(JSON.stringify(removeEvent(request.id, request), null, 2));
  }
  const file = path.join(root, '.runtime/mail-flow/mail.sqlite'); let mail = [];
  if (fs.existsSync(file)) { const db = new DatabaseSync(file, { readOnly: true }); try { mail = db.prepare('SELECT id,title,status,check_at,deadline FROM tasks').all(); } finally { db.close(); } }
  const catalog = read('projects/catalog.json'), view = upcoming(calendarData(mail, read('work/queue.json').items, catalog.links), new Date(), Number(argument) || 14);
  console.log(JSON.stringify(view, null, 2));
}
