import { launchEdge } from '../automation/browser-launch.mjs';
import test from 'node:test';
// Writes the event ledger and the project catalog in the tree it lives in: only run in the throw-away copy made by scripts/run-tests.mjs.
if (process.env.PHD_ISOLATED_TESTS !== "1") throw new Error("这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行");
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { parseWhen, dueIso, calendarItems, calendarReminders, upcoming, addEvent, addEvents, updateEvent, removeEvent, ledgerTime } from './run.mjs';
import { inboxItems, acknowledgeInbox } from '../dashboard/inbox.mjs';

const at = iso => new Date(iso);
const task = (id, over = {}) => ({ id, title: 'T ' + id, status: 'waiting', action: 'a', check_at: null, deadline: null, ...over });
const stages = (mail, now, work = [], events = []) => calendarReminders({ mail, work, events, links: [] }, at(now)).map(r => [r.id, r.stage]);

test('A date is a Chicago day, not a UTC midnight; a time must carry its zone', () => {
  assert.equal(new Date(parseWhen('2026-10-16', 'end').ms).toISOString(), '2026-10-17T04:59:59.000Z');
  assert.equal(new Date(parseWhen('2026-12-30', 'end').ms).toISOString(), '2026-12-31T05:59:59.000Z');
  assert.equal(new Date(parseWhen('2026-11-01', 'start').ms).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(new Date(parseWhen('2026-11-01', 'end').ms).toISOString(), '2026-11-02T05:59:59.000Z');
  assert.equal(new Date(parseWhen('2026-03-08', 'start').ms).toISOString(), '2026-03-08T06:00:00.000Z');
  assert.deepEqual(parseWhen('2026-10-16T01:30:00Z'), { date: '2026-10-15', time: '20:30', all_day: false, ms: Date.parse('2026-10-16T01:30:00Z') });
  assert.equal(parseWhen('2026-10-16T01:30:00.000Z').date, '2026-10-15');
  for (const bad of ['next Friday', '2026-02-30', '2026-10-16 10:00', '2026-10-16T10:00:00', '', null, undefined, 5]) assert.throws(() => parseWhen(bad), /无法解析/);
  assert.equal(dueIso('2026-10-16'), '2026-10-17T04:59:59.000Z');
  assert.equal(dueIso('garbage'), 'garbage');
  assert.equal(dueIso(null), null);
});

test('Deadline reminders: five days ahead, then on the day, and never early because of UTC', () => {
  const mail = [task('a', { deadline: '2026-10-16' })];
  assert.deepEqual(stages(mail, '2026-10-10T15:00:00Z'), []);                      // 6 days left
  assert.deepEqual(stages(mail, '2026-10-11T15:00:00Z'), [['calendar:deadline:mail:a', 'ahead']]);
  assert.deepEqual(stages(mail, '2026-10-16T01:00:00Z'), [['calendar:deadline:mail:a', 'ahead']]); // still Oct 15 in Chicago
  assert.deepEqual(stages(mail, '2026-10-16T15:00:00Z'), [['calendar:deadline:mail:a', 'due']]);
  assert.deepEqual(stages(mail, '2026-10-17T04:00:00Z'), [['calendar:deadline:mail:a', 'due']]);   // 23:00 on the 16th in Chicago, not yet the 17th
  assert.deepEqual(stages(mail, '2026-10-20T15:00:00Z'), [['calendar:deadline:mail:a', 'due']]);   // overdue stays
});

test('Reminders skip what is done, what already has an inbox card, and dates nobody can read', () => {
  const now = '2026-10-16T15:00:00Z';
  const mail = [task('done', { status: 'done', deadline: '2026-10-16' }), task('todo', { status: 'todo', deadline: '2026-10-16' }), task('bad', { deadline: 'next Friday', check_at: 'soon' })];
  assert.deepEqual(stages(mail, now), []);
  const { items, problems } = calendarItems({ mail }, at(now));
  assert.deepEqual(items.map(i => i.source_id), ['todo']);
  assert.deepEqual(problems.map(p => [p.source_id, p.field]), [['bad', 'deadline'], ['bad', 'check_at']]);
  const work = [{ id: 'w1', title: 'W', status: 'queued', due_at: '2026-10-16T20:00:00Z', project_ids: [] }, { id: 'w2', title: 'W', status: 'waiting_user', due_at: '2026-10-16T20:00:00Z' },
    { id: 'w3', title: 'W', status: 'done', due_at: '2026-10-16T20:00:00Z' }, { id: 'w4', title: 'W', status: 'active', due_at: '2026-10-16T20:00:00Z', review: { state: 'pending' } }];
  assert.deepEqual(stages([], now, work), [['calendar:deadline:work:w1', 'due']]);
});

test('A follow-up time that has come is one reminder; a future one is not', () => {
  const mail = [task('f', { check_at: '2026-10-07T09:00:00-05:00' })];
  assert.deepEqual(stages(mail, '2026-10-07T13:59:00Z'), []);
  assert.deepEqual(stages(mail, '2026-10-07T14:00:00Z'), [['calendar:followup:mail:f', 'followup']]);
});

test('Acknowledging one stage hides it; the next stage, or a moved date, asks again', () => {
  const ackFile = path.join(root, '.runtime/inbox/acknowledged.json'), saved = fs.existsSync(ackFile) ? fs.readFileSync(ackFile) : null;
  try { acknowledgment(); } finally { if (saved) fs.writeFileSync(ackFile, saved); else fs.rmSync(ackFile, { force: true }); }
});
function acknowledgment() {
  const mail = id => [task(id, { deadline: '2026-10-16' })], find = (m, now, id) => inboxItems(m, [], [], at(now)).find(i => i.id === id);
  const id = 'calendar:deadline:mail:ack1', ahead = '2026-10-12T15:00:00Z';
  const card = find(mail('ack1'), ahead, id);
  assert.equal(card.source, 'calendar'); assert.equal(card.category, '日程'); assert.deepEqual(card.actions.map(a => a.type), ['accept']);
  assert.equal(card.priority, 'high');
  acknowledgeInbox(card);
  assert.equal(find(mail('ack1'), ahead, id), undefined);
  assert.equal(find(mail('ack1'), '2026-10-13T15:00:00Z', id), undefined);                  // later the same stage: not repeated
  assert.equal(find(mail('ack1'), '2026-10-16T15:00:00Z', id)?.priority, 'urgent');          // the day itself: asked once more
  assert.equal(find([task('ack1', { deadline: '2026-10-17' })], ahead, id)?.detail.includes('2026-10-17'), true); // moved date: asked again
}

test('The event ledger: one-off events and deadlines, validated, listed, reminded and removed', () => {
  const file = path.join(root, 'calendar/events.json');
  try {
    const meeting = addEvent({ title: '组会', start: '2026-10-14T14:00:00-05:00', end: '2026-10-14T15:00:00-05:00', note: '带 PPT' });
    const trip = addEvent({ title: '出差', start: '2026-10-20', end: '2026-10-22' });
    const submit = addEvent({ title: '论文提交', kind: 'deadline', start: '2026-10-16T17:00:00-05:00' });
    const past = addEvent({ title: '旧会议', start: '2026-10-01T10:00:00-05:00' });
    for (const bad of [{ title: '', start: '2026-10-20' }, { title: 'x', start: 'tomorrow' }, { title: 'x', kind: 'meeting', start: '2026-10-20' }, { title: 'x', start: '2026-10-20', end: '2026-10-19' },
      { title: 'x', kind: 'deadline', start: '2026-10-20', end: '2026-10-21' }, { title: 'x', start: '2026-10-20', project_id: 'no-such-project' }]) assert.throws(() => addEvent(bad));
    const events = JSON.parse(fs.readFileSync(file, 'utf8')).events, now = at('2026-10-11T15:00:00Z');
    assert.equal(events.length, 4);
    const view = upcoming({ events }, now);
    assert.deepEqual(view.items.map(i => i.title), ['组会', '论文提交', '出差']);           // the past meeting is gone
    assert.deepEqual([view.items[0].time, view.items[0].end_time, view.items[0].note], ['14:00', '15:00', '带 PPT']);
    assert.equal(view.items[2].all_day, true);
    assert.deepEqual(stages([], '2026-10-11T15:00:00Z', [], events), [[`calendar:deadline:calendar:${submit.id}`, 'ahead']]); // events themselves are not reminded
    assert.equal(upcoming({ events }, now, 3).items.length, 1);
    assert.deepEqual(upcoming({ events }, now, 14, true).items.map(i => [i.title, !!i.over]), [['旧会议', true], ['组会', false], ['论文提交', false], ['出差', false]]); // the calendar draws what is over, flagged
    removeEvent(past.id); removeEvent(meeting.id); removeEvent(trip.id); removeEvent(submit.id);
    assert.throws(() => removeEvent(meeting.id), /没有这个事件/);
  } finally { fs.rmSync(file, { force: true }); }
});

test('Editing a ledger entry: form-style Chicago times, partial updates, clearing fields, and a refused edit changes nothing', () => {
  const file = path.join(root, 'calendar/events.json');
  try {
    const e = addEvent({ title: '组会', start: '2026-10-14T14:00', end: '2026-10-14T15:30', note: 'PPT' });
    assert.deepEqual([e.start, e.end], ['2026-10-14T19:00:00.000Z', '2026-10-14T20:30:00.000Z']);          // Chicago daylight time, stored as instants
    assert.equal(addEvent({ title: '冬令', start: '2026-12-01T09:00' }).start, '2026-12-01T15:00:00.000Z');  // standard time
    assert.throws(() => addEvent({ title: '不存在的时刻', start: '2026-03-08T02:30' }), /无法换算/);          // skipped by the clock change
    const moved = updateEvent(e.id, { start: '2026-10-15T10:00', end: '', note: '' });
    assert.deepEqual([moved.id, moved.title, moved.start, 'end' in moved, 'note' in moved], [e.id, '组会', '2026-10-15T15:00:00.000Z', false, false]);
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of [{ end: '2026-10-14' }, { title: '' }, { kind: 'meeting' }, { start: 'tomorrow' }, { project_id: 'no-such-project' }]) assert.throws(() => updateEvent(e.id, bad));
    assert.throws(() => updateEvent(e.id, { kind: 'deadline', end: '2026-10-16' }), /截止只有 start/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);                                                     // refused edits leave the file untouched
    assert.equal(updateEvent(e.id, { kind: 'deadline' }).kind, 'deadline');
    assert.throws(() => updateEvent('ev-nope', { title: 'x' }), /没有这个事件/);
    const view = upcoming({ events: JSON.parse(fs.readFileSync(file, 'utf8')).events }, at('2026-10-11T15:00:00Z'));
    assert.deepEqual(view.items.map(i => [i.title, i.kind, i.date, i.time]), [['组会', 'deadline', '2026-10-15', '10:00']]);   // the December entry lies beyond two weeks
  } finally { fs.rmSync(file, { force: true }); }
});

test('Repeating series preserve Chicago wall time across DST, skip one occurrence persistently, and delete only their own series', () => {
  const file = path.join(root, 'calendar/events.json');
  try {
    const series = addEvent({ title: '重复组会', start: '2026-10-25T14:00', end: '2026-10-25T15:00', recurrence: { frequency: 'weekly', until: '2026-11-08' } });
    const other = addEvent({ title: '重复组会', start: '2026-11-01', recurrence: { frequency: 'daily', until: '2026-11-02' } });
    const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).events;
    const view = () => upcoming({ events: stored() }, at('2026-10-24T15:00:00Z'), 40, true).items.filter(i => i.series?.id === series.id);
    assert.deepEqual(view().map(i => [i.date, i.time, i.end_time, new Date(i.ms).toISOString()]), [
      ['2026-10-25', '14:00', '15:00', '2026-10-25T19:00:00.000Z'],
      ['2026-11-01', '14:00', '15:00', '2026-11-01T20:00:00.000Z'],
      ['2026-11-08', '14:00', '15:00', '2026-11-08T20:00:00.000Z']
    ]);
    assert.equal(new Set(view().map(i => i.source_id)).size, 3);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => removeEvent(series.id), /须选择/);
    assert.throws(() => removeEvent(series.id, { scope: 'one', occurrence_date: '2026-10-26' }), /不是该系列/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    removeEvent(series.id, { scope: 'one', occurrence_date: '2026-11-01' });
    removeEvent(series.id, { scope: 'one', occurrence_date: '2026-11-01' }); // no duplicate exceptions
    assert.deepEqual(stored().find(e => e.id === series.id).excluded_dates, ['2026-11-01']);
    assert.deepEqual(view().map(i => i.date), ['2026-10-25', '2026-11-08']);
    updateEvent(series.id, { title: '改名组会' });
    assert.deepEqual(view().map(i => [i.date, i.title]), [['2026-10-25', '改名组会'], ['2026-11-08', '改名组会']]);
    removeEvent(series.id, { scope: 'all' });
    assert.deepEqual(stored().map(e => e.id), [other.id]);
  } finally { fs.rmSync(file, { force: true }); }
});

test('Repeat rules: intervals, inclusive end, open end, multi-day spans, missing month dates, leap years, deadlines and refused input', () => {
  const file = path.join(root, 'calendar/events.json');
  try {
    const monthly = addEvent({ title: '月末', start: '2026-01-31', recurrence: { frequency: 'monthly', until: '2026-05-31' } });
    const dates = (event, now, days) => upcoming({ events: [event] }, at(now), days, true).items.map(i => i.date);
    assert.deepEqual(dates(monthly, '2026-01-01T12:00Z', 180), ['2026-01-31', '2026-03-31', '2026-05-31']);
    const leap = addEvent({ title: '闰年', start: '2024-02-29', recurrence: { frequency: 'yearly' } });
    assert.deepEqual(dates(leap, '2024-01-01T12:00Z', 1600), ['2024-02-29', '2028-02-29']);
    const daily = addEvent({ title: '隔天', start: '2026-10-17', end: '2026-10-18', recurrence: { frequency: 'daily', interval: 2, until: '2026-10-21' } });
    assert.deepEqual(upcoming({ events: [daily] }, at('2026-10-17T12:00Z'), 10, true).items.map(i => [i.date, i.end_date, i.all_day]), [
      ['2026-10-17', '2026-10-18', true], ['2026-10-19', '2026-10-20', true], ['2026-10-21', '2026-10-22', true]
    ]);
    const deadline = addEvent({ title: '周截止', kind: 'deadline', start: '2026-10-17', recurrence: { frequency: 'weekly' } });
    assert.deepEqual(dates(deadline, '2026-10-17T12:00Z', 15), ['2026-10-17', '2026-10-24', '2026-10-31']);
    assert.deepEqual(stages([], '2026-10-20T12:00:00Z', [], [deadline]).map(([, stage]) => stage), ['due', 'ahead']);
    assert.equal('recurrence' in updateEvent(deadline.id, { recurrence: null }), false);
    const before = fs.readFileSync(file, 'utf8');
    for (const recurrence of [{ frequency: 'bad' }, { frequency: 'daily', interval: 0 }, { frequency: 'daily', interval: 1.5 }, { frequency: 'daily', until: '2026-10-16' }, { frequency: 'daily', until: '2026-02-30' }])
      assert.throws(() => addEvent({ title: '拒绝', start: '2026-10-17', recurrence }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(file, { force: true }); }
});

test('Batch creation shares a rule across different starts, validates every row before writing, and leaves each series independently editable/deletable', () => {
  const file=path.join(root,'calendar/events.json');
  try {
    const existing=addEvent({title:'原有事项',start:'2026-10-17'}),before=fs.readFileSync(file,'utf8');
    const a={title:'课程',start:'2026-10-19T10:00',end:'2026-10-19T11:00',note:'教室 A'},b={title:'测量',start:'2026-10-21T14:00',end:'2026-10-21T15:30'};
    const recurrence={frequency:'weekly',interval:1,until:'2026-11-04'};
    for(const request of [{events:[]},{events:[a,{...b,end:'2026-10-20'}],recurrence},{events:[a,{...b,start:'2026-11-05',end:''}],recurrence},{events:[a,null],recurrence}]){
      assert.throws(()=>addEvents(request));assert.equal(fs.readFileSync(file,'utf8'),before,'a rejected batch never partly writes');
    }
    const added=addEvents({events:[a,b],recurrence});assert.equal(added.length,2);assert.notEqual(added[0].id,added[1].id);
    assert.deepEqual(added.map(e=>e.recurrence),[recurrence,recurrence]);
    const view=upcoming({events:added},at('2026-10-17T12:00Z'),30,true);
    assert.deepEqual(view.items.map(i=>[i.title,i.date,i.time]),[
      ['课程','2026-10-19','10:00'],['测量','2026-10-21','14:00'],['课程','2026-10-26','10:00'],['测量','2026-10-28','14:00'],['课程','2026-11-02','10:00'],['测量','2026-11-04','14:00']
    ]);
    removeEvent(added[0].id,{scope:'all'});updateEvent(added[1].id,{note:'独立修改'});
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).events.map(e=>e.id),[existing.id,added[1].id]);
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).events[1].note,'独立修改');
  } finally {fs.rmSync(file,{force:true});}
});

test('browser: the calendar sits on the weekly page, switches between week and month, and adds, edits and deletes ledger entries', async () => {
  const { createServer } = await import('../dashboard/server.mjs');
  const { chicagoDay } = await import('./run.mjs');
  const file = path.join(root, 'calendar/events.json'), tomorrow = chicagoDay(Date.now() + 86400000), stored = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).events : [];
  const catalogFile=path.join(root,'projects/catalog.json'), catalogBefore=fs.readFileSync(catalogFile,'utf8'), catalog=JSON.parse(catalogBefore), projectId=catalog.projects[0].id;
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`; let browser;
  try {
    browser = await launchEdge();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = []; page.on('pageerror', e => errors.push(e.message));
    const detail=page.locator('#cal-detail');
    const showEvent=async title=>{await page.locator('#calendar-grid .cal-chip',{hasText:title}).first().click();await detail.waitFor({state:'visible'});};
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.goto(base);
    assert.equal(await page.locator('button.nav[data-page=calendar]').count(), 0);           // no page of its own
    await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('#calendar-grid .cal-week').waitFor();                                  // week is the default view
    assert.equal(await page.locator('#calendar-grid .cal-cell').count(), 7);
    await page.locator('[data-cal-view=month]').click();
    assert.equal(await page.locator('#calendar-grid .cal-week').count(), 0); assert.ok(await page.locator('#calendar-grid .cal-cell').count() >= 28);
    await page.locator('[data-cal-view=week]').click(); await page.locator('#calendar-grid .cal-week').waitFor();
    await page.locator('#calendar-grid .cal-today').click();
    assert.equal(await page.locator('#calendar-grid .cal-selected').count(),1);
    await page.locator('[data-cal-nav="1"]').click();
    assert.equal(await page.locator('#calendar-grid .cal-selected').count(),0);
    assert.equal(await page.locator('#calendar-list,.cal-row').count(),0,'the duplicate agenda list is removed');
    await page.locator('[data-cal-nav="0"]').click();
    assert.equal(await page.locator('#calendar-grid .cal-today').count(), 1);                  // back on the week that holds today
    await page.locator('[data-cal-new]').first().click();
    assert.equal(await page.locator('#cal-dialog').evaluate(e => e.matches(':modal')), true);
    assert.equal(await page.locator('#cal-title').evaluate(e => e === document.activeElement), true);
    await page.locator('#cal-title').fill('未保存草稿');await page.keyboard.press('Escape');
    await page.locator('#cal-dialog').waitFor({state:'hidden'});assert.deepEqual(stored(), []);
    await page.locator('[data-cal-new]').first().click();
    await page.locator('#cal-title').fill('组会'); await page.locator('#cal-date').fill(tomorrow);
    await page.locator('#cal-time').fill('14:00'); await page.locator('#cal-end-time').fill('15:00'); await page.locator('#cal-note').fill('带 PPT'); await page.locator('#cal-project').selectOption(projectId);
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#cal-form').waitFor({ state: 'hidden' });
    await page.locator('#calendar-grid .cal-chip', { hasText: '14:00 – 15:00 组会' }).waitFor();
    assert.equal(stored().length, 1); assert.deepEqual([parseWhen(stored()[0].start).date, parseWhen(stored()[0].start).time, parseWhen(stored()[0].end).time], [tomorrow, '14:00', '15:00']);
    await showEvent('组会');assert.match(await detail.textContent(),/14:00 – 15:00/);assert.match(await detail.textContent(),/带 PPT/);
    assert.equal(await page.locator('.cal-chip[aria-expanded=true]').count(),1);
    const detailShots=path.join(root,'.runtime/calendar-review');fs.mkdirSync(detailShots,{recursive:true});
    await page.screenshot({path:path.join(detailShots,'event-detail-1440.png')});
    const selectedBefore=await page.locator('.cal-selected .cal-day-button').getAttribute('aria-label');
    await page.setViewportSize({width:390,height:844});await showEvent('组会');
    const detailBox=await detail.boundingBox();assert.ok(detailBox.x>=0 && detailBox.x+detailBox.width<=390 && detailBox.y>=0 && detailBox.y+detailBox.height<=844,'event card fits the narrow viewport');
    await page.screenshot({path:path.join(detailShots,'event-detail-390.png')});
    await detail.locator('[aria-label="关闭日程详情"]').click();await detail.waitFor({state:'hidden'});
    await page.setViewportSize({width:1440,height:1100});await showEvent('组会');
    assert.equal(await page.locator('.cal-selected .cal-day-button').getAttribute('aria-label'),selectedBefore,'clicking an event does not toggle the selected day');
    await page.keyboard.press('Escape');await detail.waitFor({state:'hidden'});
    const meetingButton=page.locator('.cal-chip',{hasText:'组会'}).first();await meetingButton.focus();await page.keyboard.press('Enter');await detail.waitFor({state:'visible'});
    await page.locator('#calendar-summary').click();await detail.waitFor({state:'hidden'});
    await page.locator('[data-cal-new]').first().click(); await page.locator('#cal-title').fill('出差'); await page.locator('#cal-date').fill(tomorrow); await page.locator('#cal-end-date').fill(chicagoDay(Date.now() + 3 * 86400000));
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#cal-form').waitFor({ state: 'hidden' });
    assert.equal(stored().length, 2);
    if (new Date(tomorrow).getUTCDay() !== 0) await page.locator('#calendar-grid .cal-chip', { hasText: '↳ 出差' }).first().waitFor(); // covers three days; the continuations are on screen unless the week ends right after the first
    await showEvent('出差');page.once('dialog', d => d.dismiss()); await detail.locator('[data-cal-delete]').click();
    assert.equal(stored().length,2); // cancel deletion must leave the ledger untouched
    await showEvent('出差');page.once('dialog', d => d.accept()); await detail.locator('[data-cal-delete]').click();
    await page.locator('#calendar-grid .cal-chip', { hasText: '出差' }).first().waitFor({ state: 'detached' }); assert.equal(stored().length, 1);
    catalog.projects[0].archived_at=new Date().toISOString();fs.writeFileSync(catalogFile,JSON.stringify(catalog));
    await page.reload(); await page.locator('button.nav[data-page=weekly]').click();
    await showEvent('组会');await detail.locator('[data-cal-edit]').click();
    assert.equal(await page.locator('#cal-project').inputValue(),projectId); // editing an event must retain even an archived project
    assert.equal(await page.locator('#cal-title').inputValue(), '组会'); assert.equal(await page.locator('#cal-time').inputValue(), '14:00'); assert.equal(await page.locator('#cal-end-time').inputValue(), '15:00');
    await page.locator('#cal-title').fill('组会（改）'); await page.locator('#cal-time').fill('10:00'); await page.locator('#cal-end-time').fill('');
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#cal-form').waitFor({ state: 'hidden' });
    await page.locator('#calendar-grid .cal-chip', { hasText: '10:00 · 事项 组会（改）' }).waitFor();
    assert.equal(stored().length, 1); assert.equal('end' in stored()[0], false); assert.equal(stored()[0].title, '组会（改）');
    assert.equal(stored()[0].project_id,projectId);
    await page.locator('[data-cal-new]').first().click(); await page.locator('#cal-title').fill('x'); await page.locator('#cal-date').fill(tomorrow); await page.locator('#cal-end-date').fill('2000-01-01');
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#error').getByText(/end 不能早于 start/).waitFor();
    assert.equal(stored().length, 1);                                                          // a refused entry stores nothing
    await page.locator('#cal-form .cal-form-actions [data-cal-cancel]').click(); await page.locator('#cal-form').waitFor({ state: 'hidden' });
    await showEvent('组会');page.once('dialog', d => d.accept()); await detail.locator('[data-cal-delete]').click();
    await page.locator('#calendar-grid .cal-chip', { hasText: '组会' }).waitFor({ state: 'detached' });
    assert.deepEqual(stored(), []);
    // Real modal -> HTTP -> rule ledger -> projected days -> one/all removal -> reload.
    const shift=(date,n)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10), second=shift(tomorrow,2), final=shift(tomorrow,4);
    const shots=path.join(root,'.runtime/calendar-review');fs.mkdirSync(shots,{recursive:true});
    await page.locator('[data-cal-new]').first().click();await page.locator('#cal-title').fill('隔天实验');await page.locator('#cal-date').fill(tomorrow);
    await page.locator('#cal-time').fill('09:00');await page.locator('#cal-end-time').fill('10:00');
    await page.locator('#cal-repeat').selectOption('daily');await page.locator('#cal-interval').fill('2');await page.locator('#cal-until').fill(final);
    const box=await page.locator('#cal-dialog').boundingBox();assert.ok(box.width<=640 && Math.abs(box.x+box.width/2-720)<2,'floating dialog is centered');
    await page.locator('#cal-dialog').screenshot({path:path.join(shots,'repeat-form-1440.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#cal-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true,'narrow dialog does not overflow horizontally');
    const mobile=await page.locator('#cal-dialog').boundingBox();assert.ok(mobile.x>=0 && mobile.x+mobile.width<=390 && mobile.y>=0 && mobile.y+mobile.height<=844);
    await page.screenshot({path:path.join(shots,'repeat-form-390.png')});await page.setViewportSize({width:1440,height:1100});
    await page.locator('#cal-form [type=submit]').click();await page.locator('#cal-dialog').waitFor({state:'hidden'});
    await showEvent('隔天实验');assert.equal(stored().length,1);assert.match(await detail.textContent(),/每 2 天重复/);
    assert.deepEqual(stored()[0].recurrence,{frequency:'daily',interval:2,until:final});
    await detail.locator('[data-cal-delete]').click();
    await page.locator('#cal-delete-dialog').waitFor();await page.locator('[data-cal-delete-cancel]').click();
    assert.equal(stored()[0].excluded_dates,undefined);
    await showEvent('隔天实验');await detail.locator('[data-cal-delete]').click();
    await page.locator('#cal-delete-dialog').screenshot({path:path.join(shots,'repeat-delete.png')});
    await page.locator('[data-cal-remove=one]').click();await page.locator('#cal-delete-dialog').waitFor({state:'hidden'});
    await detail.waitFor({state:'hidden'});
    assert.deepEqual(stored()[0].excluded_dates,[tomorrow]);
    await page.reload();await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('#calendar-grid .cal-week').waitFor();
    if(!await page.locator(`[data-cal-day="${second}"]`).count())await page.locator('[data-cal-nav="1"]').click();
    await page.locator(`[data-cal-day="${second}"] .cal-chip`,{hasText:'隔天实验'}).click();
    await detail.locator('[data-cal-edit]').click();
    assert.equal(await page.locator('#cal-form-title').textContent(),'修改整个重复系列');
    assert.equal(await page.locator('#cal-date').inputValue(),tomorrow,'series edit keeps anchor, not clicked occurrence date');
    await page.locator('#cal-note').fill('保留删除例外');await page.locator('#cal-form [type=submit]').click();await page.locator('#cal-dialog').waitFor({state:'hidden'});
    assert.deepEqual(stored()[0].excluded_dates,[tomorrow]);
    if(!await page.locator(`[data-cal-day="${second}"]`).count())await page.locator('[data-cal-nav="1"]').click();
    await page.locator(`[data-cal-day="${second}"] .cal-chip`,{hasText:'隔天实验'}).click();
    await detail.locator('[data-cal-delete]').click();
    await page.locator('[data-cal-remove=all]').click();await page.locator('#cal-delete-dialog').waitFor({state:'hidden'});
    await detail.waitFor({state:'hidden'});assert.deepEqual(stored(),[]);
    await page.reload();await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('#calendar-grid .cal-week').waitFor();assert.equal(await page.locator('.cal-chip',{hasText:'隔天实验'}).count(),0);
    // One shared subject, multiple time-only rows, atomic saving, and usable 24-hour clocks.
    await page.locator('[data-cal-new]').first().click();await page.locator('#cal-title').fill('课程旧名');await page.locator('#cal-note').fill('教室 A');
    await page.locator('#cal-date').fill(tomorrow);await page.locator('#cal-add-event').click();
    let cards=page.locator('[data-cal-event]'),nextDate=shift(tomorrow,1),batchUntil=shift(tomorrow,15);
    assert.equal(await page.locator('#cal-form [name=title]').count(),1,'subject is entered only once');
    assert.equal(await cards.locator('[name=title],[name=kind],[name=project_id],[name=note]').count(),0,'added rows contain only time fields');
    await cards.nth(1).locator('[name=date]').fill(nextDate);
    await cards.nth(1).locator('[name=time]').fill('1000');await cards.nth(1).locator('[name=end_time]').fill('11:00');
    await cards.first().locator('[data-cal-event-remove]').click();assert.equal(await cards.count(),1);
    assert.equal(await page.locator('#cal-title').inputValue(),'课程旧名');assert.equal(await page.locator('#cal-note').inputValue(),'教室 A');
    assert.equal(await page.locator('#cal-time').inputValue(),'10:00','compact time is normalised on blur');
    assert.equal(await page.locator('#cal-time').getAttribute('type'),'text');
    assert.equal(await page.locator('#cal-time').getAttribute('list'),'cal-time-options');
    assert.equal(await page.locator('#cal-time-options option').count(),48);
    await page.locator('#cal-time').fill('25:00');await page.locator('#cal-form [type=submit]').click();
    assert.equal(await page.locator('#cal-time').evaluate(e=>e.validity.valid),false);assert.deepEqual(stored(),[]);
    await page.locator('#cal-time').fill('930');await page.locator('#cal-end-time').focus();
    assert.equal(await page.locator('#cal-time').inputValue(),'09:30');
    await page.locator('#cal-time').fill('1000');
    await page.locator('#cal-add-event').click();await page.locator('#cal-title').fill('每周课程');
    await cards.nth(1).locator('[name=date]').fill(shift(tomorrow,2));await cards.nth(1).locator('[name=time]').fill('14:00');await cards.nth(1).locator('[name=end_time]').fill('1530');
    await page.locator('#cal-repeat').selectOption('weekly');await page.locator('#cal-until').fill(batchUntil);
    assert.match(await page.locator('#cal-save-summary').textContent(),/同一主题.*2 个时间段.*每 1 周重复/);
    await cards.nth(1).locator('[name=end_date]').fill('2000-01-01');
    await page.locator('#cal-form [type=submit]').click();await page.locator('#cal-error').getByText(/第 2 个事项.*end 不能早于 start/).waitFor();
    assert.deepEqual(stored(),[]);assert.equal(await cards.count(),2);assert.equal(await page.locator('#cal-title').inputValue(),'每周课程');
    await cards.nth(1).locator('[name=end_date]').fill('');
    assert.equal(await page.locator('#cal-error').isVisible(),false,'editing after an error clears stale feedback');
    assert.equal(await page.locator('#error').isVisible(),false);
    await page.locator('#cal-dialog').screenshot({path:path.join(shots,'batch-form-1440.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#cal-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    const footerBefore=await page.locator('#cal-form>.cal-form-actions').boundingBox();
    await page.locator('.cal-dialog-body').evaluate(e=>e.scrollTop=e.scrollHeight);
    const footerAfter=await page.locator('#cal-form>.cal-form-actions').boundingBox();assert.ok(Math.abs(footerBefore.y-footerAfter.y)<1,'save footer stays pinned while rows scroll');
    assert.ok(footerAfter.y>=0 && footerAfter.y+footerAfter.height<=844);
    await page.screenshot({path:path.join(shots,'batch-form-390.png')});await page.setViewportSize({width:1440,height:1100});
    await page.locator('#cal-form [type=submit]').click();await page.locator('#cal-dialog').waitFor({state:'hidden'});
    assert.deepEqual(stored().map(e=>[e.title,parseWhen(e.start).date,parseWhen(e.start).time,parseWhen(e.end).time,e.recurrence]),[
      ['每周课程',nextDate,'10:00','11:00',{frequency:'weekly',interval:1,until:batchUntil}],['每周课程',shift(tomorrow,2),'14:00','15:30',{frequency:'weekly',interval:1,until:batchUntil}]
    ]);
    assert.deepEqual(stored().map(e=>e.note),['教室 A','教室 A'],'shared details are applied at save, not stale per-row copies');
    const batchView=await (await page.request.get(base+'/api/state?scope=weekly')).json();
    for(const event of stored())assert.ok(batchView.calendar.items.filter(i=>i.series?.id===event.id).length>=2,'each time row actually repeats in the state consumer');
    await showEvent('每周课程');await detail.locator('[data-cal-edit]').click();assert.equal(await cards.count(),1);assert.equal(await page.locator('#cal-add-event').isVisible(),false);
    await page.keyboard.press('Escape');
    // Cleanup only fictional fixtures through the real remove API; earlier browser checks cover the choice buttons.
    for(const event of stored())await page.evaluate(async id=>{const r=await fetch('/api/calendar/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,scope:'all'})});if(!r.ok)throw new Error(await r.text());},event.id);
    await page.reload();await page.locator('button.nav[data-page=weekly]').click();await page.locator('#calendar-grid .cal-week').waitFor();
    await page.locator('[data-cal-new]').first().click();assert.equal(await cards.count(),1);assert.equal(await page.locator('#cal-title').inputValue(),'');
    await page.locator('[aria-label="关闭日程窗口"]').click();assert.deepEqual(stored(),[]);
    // A long event started >62 days ago is still shown on every visible day it covers.
    const today=chicagoDay(Date.now()), longStart=chicagoDay(Date.now()-90*86400000), longEnd=chicagoDay(Date.now()+5*86400000);
    await page.locator('[data-cal-new]').first().click(); await page.locator('#cal-title').fill('长期实验窗口');
    await page.locator('#cal-date').fill(longStart); await page.locator('#cal-end-date').fill(longEnd);
    await page.locator('#cal-form [type=submit]').click(); await page.locator('#cal-form').waitFor({state:'hidden'});
    await page.locator('[data-cal-nav="0"]').click();
    await page.locator(`[data-cal-day="${today}"] .cal-chip`,{hasText:'↳ 长期实验窗口'}).waitFor();
    await page.locator(`[data-cal-day="${today}"] .cal-chip`,{hasText:'长期实验窗口'}).click();
    assert.match(await detail.textContent(),new RegExp(longEnd));await page.keyboard.press('Escape');
    await page.locator('#calendar-panel').screenshot({path:path.join(shots,'week.png')});
    await page.locator('[data-cal-view=month]').click();
    await page.locator('#calendar-panel').screenshot({path:path.join(shots,'month.png')});
    await showEvent('长期实验窗口');await detail.locator('[data-cal-edit]').click(); await page.locator('#cal-kind').selectOption('deadline');
    assert.equal(await page.locator('label.cal-span').first().isVisible(),false); // hidden end controls must really be hidden despite label flex styling
    await page.locator('#cal-kind').selectOption('event'); assert.equal(await page.locator('label.cal-span').first().isVisible(),true);
    await page.locator('#cal-form').screenshot({path:path.join(shots,'form.png')});
    await page.locator('#cal-form .cal-form-actions [data-cal-cancel]').click();

    // Visual fixtures enter through the actual state API. No real plans or events are written.
    const { snapshot }=await import('../dashboard/server.mjs');
    const fixture=snapshot(),monday=fixture.weekly.window.start,day=n=>new Date(Date.parse(monday)+n*86400000).toISOString().slice(0,10);
    const event=(id,title,date,start,end)=>({id,title,start:start ? ledgerTime(date+'T'+start) : date,...(end ? {end:ledgerTime(date+'T'+end)} : {})});
    const longTitle='周一：四组样品基底 plasma 前处理并交接，保存完整实验条件';
    const mediumTitle='四组电阻测量：核对新旧墨水及压制前后样品，完整记录接触方式与测量条件。'.repeat(2);
    const tallTitle='圆盘数据核对：记录所有样品编号、角度、温度、磁场、接触配置及异常情况，保留原始数据路径供后续分析。'.repeat(3);
    const data={events:[event('morning','实验测量',monday,'08:30','10:00'),event('overlap','样品讨论',monday,'08:45','09:15'),
      event('later','数据整理',monday,'10:30','11:00'),event('meeting','组会',day(2),'14:00','15:00'),
      event('long-title',longTitle,monday,'10:30','11:00'),
      event('medium-title',mediumTitle,day(2),'14:00','15:00'),
      event('tall-title',tallTitle,day(1),'10:30','12:00'),event('tall-overlap','同时实验',day(1),'11:00','11:30'),
      event('allday','全天实验准备',day(1)),{...event('submit','提交摘要',day(4),'16:00'),kind:'deadline'}],
      mail:[{id:'follow',title:'跟进补印时间',status:'waiting',check_at:ledgerTime(day(3)+'T09:00')} ]};
    fixture.calendar=upcoming(data,new Date(),14,true);
    await page.route('**/api/state*',r=>r.fulfill({json:fixture}));
    await page.reload();await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('.cal-timed',{hasText:'实验测量'}).waitFor();
    assert.deepEqual(await page.locator('.cal-hours>span').allTextContents(),Array.from({length:11},(_,n)=>`${String(8+n).padStart(2,'0')}:00`));
    const first=page.locator(`[data-cal-day="${monday}"]`),timeline=await first.locator('.cal-timeline').boundingBox();
    const morning=await first.locator('.cal-timed',{hasText:'实验测量'}).boundingBox(),later=await first.locator('.cal-timed',{hasText:'数据整理'}).boundingBox();
    assert.ok(Math.abs(morning.y-timeline.y-1-32)<1,'08:30 sits half an hour below the 08:00 line');
    assert.ok(Math.abs(morning.height-96)<1,'a 90-minute appointment has a 90-minute height');
    assert.ok(Math.abs(later.y-morning.y-128)<1,'10:30 is two hours below 08:30');
    const overlap=await first.locator('.cal-timed',{hasText:'样品讨论'}).boundingBox();
    assert.ok(morning.x+morning.width<=overlap.x,'overlapping appointments remain side by side');
    assert.equal(await page.locator('.cal-allday .cal-chip',{hasText:'全天实验准备'}).count(),1);
    assert.equal(await page.locator('.cal-point.cal-followup',{hasText:'跟进补印时间'}).count(),1);
    assert.equal(await page.locator('.cal-point.cal-deadline',{hasText:'提交摘要'}).count(),1);
    await showEvent('跟进补印时间');assert.equal(await detail.locator('[data-cal-edit],[data-cal-delete]').count(),0,'source-owned mail dates are not deletable from the event card');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('#calendar-panel').evaluate(panel=>[panel,...panel.querySelectorAll('*')].filter(e=>getComputedStyle(e).backgroundImage.includes('gradient')).map(e=>e.className)),[],'calendar uses plain colours, not gradients');
    await page.locator('.cal-today .cal-day-button').click();assert.equal(await page.locator('.cal-selected .cal-day-button').getAttribute('aria-pressed'),'true');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1100});
      for(const [label,title,lines] of [['short',longTitle,1],['medium',mediumTitle,3],['tall',tallTitle,5]]){
        const chip=page.locator('.cal-timed',{hasText:title});
        const labelBox=await chip.evaluate(el=>{
          const title=el.querySelector('.cal-title'),text=title.getBoundingClientRect(),box=el.getBoundingClientRect(),css=getComputedStyle(title);
          return {whiteSpace:css.whiteSpace,clamp:css.webkitLineClamp,overflow:css.overflow,textHeight:text.height,scrollHeight:title.scrollHeight,clientHeight:title.clientHeight,textBottom:text.bottom,boxBottom:box.bottom,lineHeight:parseFloat(css.lineHeight)};
        });
        assert.equal(labelBox.whiteSpace,'normal','tall blocks retain multiline titles instead of forcing one line');
        assert.equal(Number(labelBox.clamp),lines,'line allowance follows the actual 30/60/90-minute block height');
        assert.equal(labelBox.overflow,'hidden');assert.ok(labelBox.scrollHeight>labelBox.clientHeight,'the fixture genuinely needs a final-line ellipsis');
        assert.ok(labelBox.textHeight<=lines*labelBox.lineHeight && labelBox.textBottom<=labelBox.boxBottom,'only complete title rows fit below the time: '+JSON.stringify(labelBox));
        if(lines>1)assert.ok(labelBox.textHeight>labelBox.lineHeight,'available title space must show multiple lines');
        await chip.scrollIntoViewIfNeeded();
        await chip.evaluate(el=>{
          const scroll=el.closest('.cal-scroll'),axis=scroll.querySelector('.cal-time-axis');
          const hiddenByAxis=axis.getBoundingClientRect().right+4-el.getBoundingClientRect().left;
          if(hiddenByAxis>0)scroll.scrollLeft-=hiddenByAxis;
        });
        await chip.screenshot({path:path.join(shots,`title-ellipsis-${label}-${width}.png`)});
        await showEvent(title);assert.ok((await detail.textContent()).includes(title),'clicking the clamped title still exposes the full original text');
        await page.keyboard.press('Escape');
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the page does not overflow horizontally');
      const scroll=page.locator('.cal-scroll');
      assert.equal(await scroll.evaluate(e=>e.scrollWidth>e.clientWidth),width===390,'only the narrow calendar scrolls horizontally');
      if(width===390){
        const axisX=(await page.locator('.cal-time-axis').boundingBox()).x;
        await scroll.evaluate(e=>e.scrollLeft=300);
        assert.ok(Math.abs((await page.locator('.cal-time-axis').boundingBox()).x-axisX)<1,'time labels stay visible while swiping days');
        await scroll.evaluate(e=>e.scrollLeft=0);
      }
      await page.evaluate(()=>window.scrollTo(0,0));
      if(width===390)await page.screenshot({path:path.join(shots,`time-week-${width}.png`),fullPage:true});
      else await page.locator('#calendar-panel').screenshot({path:path.join(shots,`time-week-${width}.png`)});
      await page.locator('[data-cal-view=month]').click();
      assert.equal(await page.locator('.cal-time-axis').count(),0,'month view remains a day overview');
      await page.evaluate(()=>window.scrollTo(0,0));
      if(width===390)await page.screenshot({path:path.join(shots,`time-month-${width}.png`),fullPage:true});
      else await page.locator('#calendar-panel').screenshot({path:path.join(shots,`time-month-${width}.png`)});
      await page.locator('[data-cal-view=week]').click();
    }
    // With no agenda below, the month overflow control must still expose every event.
    for(let n=0;n<4;n++)data.events.push(event('extra-'+n,'额外预约 '+n,monday,`${13+n}:00`,`${13+n}:30`));
    fixture.calendar=upcoming(data,new Date(),14,true);await page.reload();await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('[data-cal-view=month]').click();await page.locator(`[data-cal-more="${monday}"]`).click();
    await page.locator('#calendar-grid .cal-week').waitFor();await showEvent('额外预约 3');
    assert.match(await detail.textContent(),/16:00 – 16:30/);await page.keyboard.press('Escape');
    // Expand beyond work hours; preserve true per-day segments for overnight events.
    data.events.push({id:'overnight',title:'跨夜测量',start:ledgerTime(monday+'T23:00'),end:ledgerTime(day(1)+'T01:00')},
      event('latepoint','深夜复查',day(2),'23:59'));
    fixture.calendar=upcoming(data,new Date(),14,true);await page.reload();await page.locator('button.nav[data-page=weekly]').click();
    await page.locator('.cal-timed',{hasText:'跨夜测量'}).first().waitFor();
    assert.equal(await page.locator('.cal-hours>span').first().textContent(),'00:00');
    assert.equal(await page.locator('.cal-hours>span').last().textContent(),'24:00');
    const overnight=page.locator(`[data-cal-day="${day(1)}"] .cal-timed`,{hasText:'跨夜测量'});
    assert.match(await overnight.textContent(),/↳ 00:00 – 01:00/);
    assert.ok(Math.abs((await overnight.boundingBox()).height-64)<1);
    const late=page.locator('.cal-point',{hasText:'深夜复查'}),lateBox=await late.boundingBox(),lateTimeline=await late.locator('..').boundingBox();
    assert.ok(lateBox.y+lateBox.height<=lateTimeline.y+lateTimeline.height,'a 23:59 point is not clipped');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(file, { force: true }); fs.writeFileSync(catalogFile,catalogBefore); }
});
