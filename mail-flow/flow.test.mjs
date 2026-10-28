import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Flow, normalize, plain, taskEvidence } from './flow.mjs';
const config = { account: 'user@wisc.edu', timezone: 'America/Chicago', initialLookbackHours: 24,
  overlapMinutes: 20,
  pageSize: 20, maxPagesPerRun: 6, maxBatchMessages: 8, maxPacketBytes: 6000 };

test('a closed matter is exact-thread evidence, never an automatically reopened task',t=>{
  const f=setup(t);
  f.db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'done',?,?,?,'[]')")
    .run('closed','Scores sent','Enter and send scores',JSON.stringify(['person@wisc.edu']),JSON.stringify(['ECE 222 student grade']));
  f.ingest(mail('thanks','Re: ECE 222 student grade','Thank you for the scores.'),'inbox');
  const p=f.packet();assert.equal(p.tasks.find(t=>t.id==='closed').status,'done');
  const before=f.tasks()[0];
  assert.throws(()=>f.apply({packet_id:p.packet_id,decisions:[{message_id:'thanks',decision:'update',task_id:'closed',status:'todo',action:'Check the scores again',check_at:null}]}),/Completed task is evidence only/);
  assert.deepEqual(f.tasks()[0],before);
  f.apply({packet_id:p.packet_id,decisions:[{message_id:'thanks',decision:'ignore'}]});
  assert.equal(f.tasks()[0].status,'done');assert.equal(f.tasks().length,1);
  f.ingest(mail('new-action','Re: ECE 222 student grade','Please deliver the papers to class.'),'inbox');
  const next=f.packet();f.apply({packet_id:next.packet_id,decisions:[{message_id:'new-action',decision:'new',title:'Deliver papers',status:'todo',action:'Arrange classroom delivery only',check_at:null}]});
  assert.equal(f.tasks().find(t=>t.id==='closed').status,'done');assert.equal(f.tasks().filter(t=>t.status==='todo').length,1);
  assert.equal(f.related({subject:'Different request',sender:'person@wisc.edu',recipients:[],folder:'inbox',text:''}).some(t=>t.id==='closed'),false);
});
const mail = (id, subject = 'Please confirm exam arrangements', text = 'Please confirm tomorrow.') => ({
  id, subject, receivedDateTime: '2026-10-04T21:26:48Z', sender: { emailAddress: { address: 'person@wisc.edu' } },
  toRecipients: [{ emailAddress: { address: config.account } }], body: { content: text }, isRead: false });

test('interactive work receives original source identities and complete stored text, separate from suggestions and old local drafts',t=>{
  const f=setup(t),id='fixture-work-matter',artifact=path.join(f.dir,'old-local-draft.md');
  fs.writeFileSync(artifact,'DIRTY_ASSISTANT_DRAFT_NOT_A_SOURCE');
  f.db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,'todo',?,'[]','[]','[]')")
    .run(id,'Independent work matter','BACKGROUND_SUGGESTION_NOT_A_USER_DECISION');
  f.db.prepare('UPDATE tasks SET artifacts=? WHERE id=?').run(JSON.stringify([artifact]),id);
  for(let i=0;i<4;i++) {
    const m=mail('work-source-'+i,'Source '+i,i===0 ? 'x'.repeat(1800)+' IMPORTANT_OLD_SOURCE_TAIL' : 'Source fact '+i);
    m.receivedDateTime=`2026-10-0${i+1}T12:00:00Z`;m.hasAttachments=i===3;
    f.ingest(m,'inbox');
  }
  const p=f.packet();assert.equal(p.messages.length,4);
  f.apply({packet_id:p.packet_id,decisions:p.messages.map(m=>({message_id:m.id,decision:'update',task_id:id,status:'todo',action:'BACKGROUND_SUGGESTION_NOT_A_USER_DECISION',check_at:null}))});
  const preview=taskEvidence(f.dir,id);
  const work=taskEvidence(f.dir,id,{complete:true});
  assert.equal(preview.messages.length,3);
  assert.equal(work.source_messages.length,4);
  assert.match(work.source_messages[0].text,/IMPORTANT_OLD_SOURCE_TAIL$/);
  assert.equal(work.source_messages[0].id,'work-source-0');
  assert.equal(work.background_assessment.suggested_next_step,'BACKGROUND_SUGGESTION_NOT_A_USER_DECISION');
  assert.ok(!JSON.stringify(work.source_messages).includes('BACKGROUND_SUGGESTION'));
  assert.match(work.source_representation,/not the original MIME or attachment/);
  assert.ok(!('artifact_text' in work),'local assistant prose is not silently promoted into mail evidence');
  assert.ok(!JSON.stringify(work).includes('DIRTY_ASSISTANT_DRAFT_NOT_A_SOURCE'));
  assert.deepEqual(work.local_artifacts,[{path:artifact,origin:'local_artifact_not_independent_mail_evidence'}]);
});
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-flow-test-'));
  const f = new Flow(dir, config);
  t.after(() => {
    f.close(); const target = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(parent) && path.basename(target).startsWith('mail-flow-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }); return f;
}

test('forwarded paper evidence survives headers, signatures and mobile footers; ordinary replies still trim history',t=>{
  const title='Discerning Hall and non-Hall transverse currents in linear and nonlinear regimes';
  const body='FYI, I encourage you all to read this paper. Ying, discuss next week?\n\nBest, Jun\n-----\nSignature\nGet Outlook for Android\n\n**From:** Scholar Alerts\n**Subject:** new articles\n'+title+' https://example.org/paper\n'+'Evidence '.repeat(120);
  const f=setup(t);
  for(const [i,subject] of ['FW: new articles','Fwd: new articles','转发：new articles','RE: FW: new articles'].entries()){
    const m=mail('forward-'+i,subject,body),normalized=normalize(m,'inbox');
    assert.ok(normalized.text.includes(title),subject);assert.ok(normalized.text.includes('https://example.org/paper'));
    assert.ok(normalized.text.includes('**From:** Scholar Alerts'));
    assert.equal(f.ingest(m,'inbox'),'pending');
    const packet=f.packet({messageIds:[m.id]});assert.equal(packet.messages.length,1);assert.equal(packet.messages[0].truncated,true);
  }
  assert.equal(plain('New reply\nFrom: older evidence\nOld request'),'New reply');
  assert.equal(normalize(mail('reply','RE: discussion','New reply\nFrom: older evidence\nOld request'),'inbox').text,'New reply');
  assert.equal(plain('<script>bad()</script><style>.x{}</style><p>Safe &amp; sound</p>'),'Safe & sound');
});

test('targeted correction applies just the chosen source, restores the remaining queue and stays idempotent',t=>{
  const f=setup(t);
  f.ingest(mail('other','Please confirm room','Please confirm the room.'),'inbox');
  f.ingest(mail('paper','FW: paper','Read this paper\nFrom: Scholar\nPaper title and link'),'inbox');
  assert.throws(()=>f.packet({messageIds:['missing']}),/exist and be pending/);
  assert.throws(()=>f.packet({messageIds:['paper','paper']}),/Invalid targeted/);
  const packet=f.packet({messageIds:['paper']});assert.deepEqual(packet.messages.map(m=>m.id),['paper']);
  const decision={packet_id:packet.packet_id,decisions:[{message_id:'paper',decision:'new',title:'Read the forwarded paper',status:'todo',action:'Read only; no reply or scheduling obligation',check_at:null}]};
  assert.equal(f.apply(decision).applied,1);assert.equal(f.apply(decision).applied,0);
  assert.equal(f.tasks().length,1);assert.equal(f.tasks()[0].deadline,null);
  assert.deepEqual(f.packet().messages.map(m=>m.id),['other']);
  assert.throws(()=>f.packet({messageIds:['paper']}),/exist and be pending/);
});

test('targeted correction refuses a partial selection when packet limits cannot fit all requested mail',t=>{
  const f=setup(t);f.ingest(mail('a'),'inbox');f.ingest(mail('b'),'inbox');
  const before=f.config.maxBatchMessages;
  try{
    f.config.maxBatchMessages=1;
    assert.throws(()=>f.packet({messageIds:['a','b']}),/exceeds packet limits/);
    assert.equal(f.pending().length,2);
    assert.equal(fs.existsSync(path.join(f.dir,'review-packet.json')),false);
    assert.equal(f.packet().messages.length,1,'normal bounded batching remains supported');
  }finally{f.config.maxBatchMessages=before;}
});
test('Unread/read changes and reruns produce no new judgment or output rewrite', t => {
  const f = setup(t), m = mail('exact-ID=');
  assert.equal(f.ingest(m, 'inbox'), 'pending');
  const p = f.packet(); f.render(new Date('2026-10-05T03:00:00Z'));
  const before = fs.statSync(path.join(f.dir, 'today.md')).mtimeMs;
  assert.equal(f.ingest({ ...m, isRead: true, categories: ['changed'] }, 'sent'), 'unchanged');
  assert.equal(f.packet().packet_id, p.packet_id);
  assert.equal(f.render(new Date('2026-10-05T03:00:00Z')), false);
  assert.equal(fs.statSync(path.join(f.dir, 'today.md')).mtimeMs, before);
});
test('Piazza and mandatory training are retained even from no-reply addresses', t => {
  const f = setup(t);
  for (const [id, subject] of [['piazza', 'Piazza @15 formula sheet request'], ['laser', 'Mandatory laser safety training deadline']]) {
    const m = mail(id, subject); m.sender.emailAddress.address = 'no-reply@example.edu';
    assert.equal(f.ingest(m, 'inbox'), 'pending');
  }
  assert.equal(f.pending().length, 2);
});
test('Changed quote numbers suggest the existing vendor task without silently merging', t => {
  const f = setup(t);
  f.db.prepare(`INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts)
    VALUES('old','High Vac Depot 报价','todo','核对优惠','[]','[]','[]')`).run();
  const m = mail('new-quote', 'Your Quote Request #99999 from High Vac Depot', 'Same pump and fittings; updated quote.');
  assert.equal(f.ingest(m, 'inbox'), 'pending');
  const p = f.packet(); assert.deepEqual(p.messages[0].related_task_ids, ['old']);
  assert.equal(f.tasks().length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sources').get().n, 0);
});
test('Optional FOM availability alerts are filtered while own cancellations remain visible', t => {
  const f = setup(t);
  const opening = mail('opening', 'FOM: A session is cancelled on STEP Heidelberg laser writer',
    'A user has just cancelled a session. Please login and reserve your session before other users grab this time!');
  opening.sender.emailAddress.address = 'Fomsupport@engr.wisc.edu';
  assert.equal(f.ingest(opening, 'inbox'), 'filtered');
  assert.equal(f.ingest({ ...opening, id: 'own', subject: 'Your reservation is cancelled',
    body: { content: 'Your booked session was cancelled. Please contact support.' } }, 'inbox'), 'pending');
});
test('Coarse screening catches newsletters while preserving deadlines and personal requests', t => {
  const f = setup(t);
  const newsletter = mail('news', 'Weekly news digest', 'Research news this week. Manage your preferences or unsubscribe.');
  newsletter.sender.emailAddress.address = 'newsletter@example.com';
  assert.equal(f.ingest(newsletter, 'inbox'), 'filtered');
  assert.equal(f.ingest({ ...newsletter, id: 'deadline', subject: 'Weekly news digest - mandatory compliance deadline' }, 'inbox'), 'pending');
  assert.equal(f.ingest({ ...newsletter, id: 'reply', body: { content: 'Please confirm your appointment. You can unsubscribe from news.' } }, 'inbox'), 'pending');
  f.config.researchKeywords = ['TaIrTe4'];
  assert.equal(f.ingest({ ...newsletter, id: 'research', body: { content: 'New TaIrTe4 transport article. Unsubscribe here.' } }, 'inbox'), 'pending');
  f.render(); assert.match(fs.readFileSync(path.join(f.dir, 'notifications.md'), 'utf8'), /Weekly news digest/);
  assert.equal(f.pending().length, 3);
});
test('A page failure preserves the saved provider offset and incomplete watermark', async t => {
  const f = setup(t); f.set('folders', { inbox: 'IN', sent: 'SENT' });
  let calls = 0;
  const reader = { async call(name) {
    if (name === 'get_profile') return { email: config.account };
    if (++calls === 1) return { value: [mail('one')], has_more: true, next_from_index: 17 };
    throw new Error('offline');
  } };
  await assert.rejects(f.collect(reader, new Date('2026-10-05T03:00:00Z')), /offline/);
  assert.equal(f.get('scan').skip, 17); assert.equal(f.get('lastComplete'), null);
  const offsets = [];
  await f.collect({ async call(name, args) {
    if (name === 'get_profile') return { email: config.account };
    offsets.push([args.folder_id, args.skip]);
    return { value: [], has_more: false, next_from_index: null };
  } });
  assert.deepEqual(offsets, [['IN', 17], ['SENT', 0]]);
  assert.equal(f.get('scan'), null); assert.equal(f.get('lastComplete'), '2026-10-05T03:00:00.000Z');
});
test('Batch size bounds do not discard unbatched messages', t => {
  const f = setup(t);
  for (let i = 0; i < 30; i++) f.ingest(mail('id-' + i, 'Please confirm', '学术事务待确认。'.repeat(150)), 'inbox');
  const p = f.packet(); assert.ok(p.messages.length > 0 && p.messages.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 6000); assert.equal(f.pending().length, 30);
});
test('Frequent reads narrow the window and never rescan a day just because the day changed', async t => {
  const f = setup(t); f.set('folders', { inbox: 'IN', sent: 'SENT' });
  const requests = [], m = mail('already-seen');
  const reader = { async call(name, args) {
    if (name === 'get_profile') return { email: config.account };
    requests.push(args.filter);
    return { value: args.folder_id === 'IN' ? [m] : [], has_more: false, next_from_index: null };
  } };
  const first = await f.collect(reader, new Date('2026-10-05T03:00:00Z'));
  f.packet(); f.render(new Date('2026-10-05T03:00:00Z'));
  const packetTime = fs.statSync(path.join(f.dir, 'review-packet.json')).mtimeMs;
  assert.equal(first.mode, 'initial'); assert.equal(first.windowStart, '2026-10-04T03:00:00.000Z');
  const second = await f.collect(reader, new Date('2026-10-05T03:10:00Z'));
  assert.equal(second.mode, 'incremental'); assert.equal(second.windowStart, '2026-10-05T02:40:00.000Z');
  assert.equal(second.pending, 0); assert.equal(second.unchanged, 1);
  f.packet(); assert.equal(fs.statSync(path.join(f.dir, 'review-packet.json')).mtimeMs, packetTime);
  assert.equal(f.render(new Date('2026-10-05T03:10:00Z')), false);
  const daily = await f.collect(reader, new Date('2026-10-06T03:00:00Z'));
  assert.equal(daily.mode, 'incremental'); assert.equal(daily.windowStart, '2026-10-05T02:50:00.000Z');
  assert.equal(daily.pending, 0); assert.equal(daily.unchanged, 1); assert.equal(f.pending().length, 1);
  assert.equal(requests.length, 6);
});
test('A long offline gap keeps the unprocessed interval in the frequent scan', async t => {
  const f = setup(t); f.set('folders', { inbox: 'IN', sent: 'SENT' });
  f.set('lastComplete', '2026-10-05T03:00:00.000Z');
  const counts = await f.collect({ async call(name) {
    return name === 'get_profile' ? { email: config.account } : { value: [], has_more: false, next_from_index: null };
  } }, new Date('2026-10-05T13:00:00Z'));
  assert.equal(counts.mode, 'incremental'); assert.equal(counts.windowStart, '2026-10-05T02:40:00.000Z');
  const afterDaysOffline = await f.collect({ async call(name) {
    return name === 'get_profile' ? { email: config.account } : { value: [], has_more: false, next_from_index: null };
  } }, new Date('2026-10-08T13:00:00Z'));
  assert.equal(afterDaysOffline.mode, 'incremental');
  assert.equal(afterDaysOffline.windowStart, '2026-10-05T12:40:00.000Z');
});
test('Decisions are source-bound, applied once, and cannot send or auto-complete tasks', t => {
  const f = setup(t); f.ingest(mail('source'), 'inbox'); const p = f.packet();
  const base = { packet_id: p.packet_id, decisions: [{ message_id: 'source', decision: 'new',
    title: '确认补考', status: 'todo', action: '核实时间和房间', check_at: null }] };
  assert.throws(() => f.apply({ ...base, send_email: true }), /Invalid decision/);
  assert.throws(() => f.apply({ ...base, decisions: [{ ...base.decisions[0], message_id: 'invented' }] }), /Unknown/);
  assert.throws(() => f.apply({ ...base, decisions: [{ ...base.decisions[0], status: 'done' }] }), /Invalid task/);
  assert.equal(f.tasks().length, 0);
  assert.equal(f.apply(base).applied, 1); assert.equal(f.apply(base).applied, 0);
  assert.equal(f.tasks().length, 1); assert.equal(f.pending().length, 0);
  assert.equal(f.packet(), null); assert.equal(fs.existsSync(path.join(f.dir, 'review-packet.json')), false);
});
test('Model output based on old message contents cannot overwrite new evidence', t => {
  const f = setup(t), m = mail('source'); f.ingest(m, 'inbox'); const p = f.packet();
  f.ingest({ ...m, body: { content: 'Cancelled; revised arrangements attached.' } }, 'inbox');
  assert.throws(() => f.apply({ packet_id: p.packet_id, decisions: [{ message_id: 'source', decision: 'ignore' }] }), /Message changed/);
  assert.equal(f.pending().length, 1);
});

test('Open tasks the rules did not match are offered as bare titles, and subject backfill finds legacy tasks', t => {
  const f = setup(t);
  const add = (id, title, subjects, legacy) => f.db.prepare("INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts,legacy) VALUES(?,?,'todo','查看','[]',?,'[]',?)").run(id, title, subjects, legacy);
  const notes = ['账号: x', '主题: HW2 4.26', '下一步: 看'].join(String.fromCharCode(10));
  add('t-legacy', '核对 HW2 答疑', '[]', JSON.stringify({ notes }));
  add('t-other', '完成福利登记', '[]', null);
  add('t-done', '已完成事项', '[]', null); f.db.prepare("UPDATE tasks SET status='done' WHERE id='t-done'").run();
  f.ingest(mail('thread', 'Re: HW2 4.26', 'Please confirm the answer.'), 'inbox');
  assert.equal(f.related(normalize(mail('thread', 'Re: HW2 4.26'), 'inbox')).length, 0);
  assert.deepEqual(f.backfillSubjects(), { changed: 1 });
  assert.deepEqual(f.backfillSubjects(), { changed: 0 });
  assert.deepEqual(f.related(normalize(mail('thread', 'Re: HW2 4.26'), 'inbox')).map(x => x.id), ['t-legacy']);
  const p = f.packet();
  assert.deepEqual(p.tasks.map(x => x.id).sort(), ['t-legacy', 't-other']);
  const bare = p.tasks.find(x => x.id === 't-other');
  assert.deepEqual(Object.keys(bare).sort(), ['brief', 'id', 'revision', 'status', 'title']);
  assert.equal(f.apply({ packet_id: p.packet_id, decisions: [{ message_id: 'thread', decision: 'update', task_id: 't-other', status: 'todo', action: '并入福利登记', check_at: null }] }).applied, 1);
  assert.equal(f.tasks().find(x => x.id === 't-other').action, '并入福利登记');
});

test('A stated deadline is validated and stored, and a cut-off deferral gets exactly one longer retry', t => {
  const f = setup(t), long = 'x'.repeat(1500) + ' Deadline: Oct 30 4:30 pm CT.';
  f.ingest(mail('long', 'Open enrollment', long), 'inbox');
  const p1 = f.packet(); assert.equal(p1.messages[0].text.length, 700); assert.equal(p1.messages[0].truncated, true);
  const defer = id => ({ message_id: id, decision: 'defer', action: '正文被截断' });
  assert.equal(f.apply({ packet_id: p1.packet_id, decisions: [defer('long')] }).applied, 1);
  assert.equal(f.pending().length, 1);
  const p2 = f.packet(); assert.notEqual(p2.packet_id, p1.packet_id); assert.equal(p2.messages[0].text.length, 1529); assert.equal(p2.messages[0].truncated, false);
  assert.equal(f.apply({ packet_id: p2.packet_id, decisions: [defer('long')] }).applied, 1);
  assert.equal(f.pending().length, 0); assert.equal(f.db.prepare("SELECT state FROM messages WHERE id='long'").get().state, 'deferred');
  const g = setup(t); g.ingest(mail('d1'), 'inbox'); const p = g.packet();
  const base = { message_id: 'd1', decision: 'new', title: '确认补考', status: 'todo', action: '核实', check_at: null };
  assert.throws(() => g.apply({ packet_id: p.packet_id, decisions: [{ ...base, deadline: 'next Friday' }] }), /Invalid deadline/);
  assert.throws(() => g.apply({ packet_id: p.packet_id, decisions: [{ ...base, deadline: '2026-10-30' }] }), /Invalid deadline/);
  assert.equal(g.apply({ packet_id: p.packet_id, decisions: [{ ...base, deadline: '2026-10-30T16:30:00-05:00' }] }).applied, 1);
  const task = g.tasks()[0]; assert.equal(task.deadline, '2026-10-30T16:30:00-05:00');
  g.ingest(mail('d2', 'Re: Please confirm exam arrangements', 'Please confirm; nothing new.'), 'inbox'); const q = g.packet();
  assert.equal(g.apply({ packet_id: q.packet_id, decisions: [{ message_id: 'd2', decision: 'update', task_id: task.id, status: 'todo', action: '继续', check_at: null }] }).applied, 1);
  assert.equal(g.tasks()[0].deadline, '2026-10-30T16:30:00-05:00');
});
test('An update may rename its task; omitted keeps the title, invalid titles write nothing, same-batch updates apply in order', t => {
  const g = setup(t); g.ingest(mail('n1'), 'inbox');
  const first = g.packet();
  g.apply({ packet_id: first.packet_id, decisions: [{ message_id: 'n1', decision: 'new', title: '旧标题', status: 'todo', action: '旧请求', check_at: null }] });
  const id = g.tasks()[0].id, upd = (mid, extra) => ({ message_id: mid, decision: 'update', task_id: id, status: 'todo', action: '新旧合并', check_at: null, ...extra });
  g.ingest(mail('n2', 'Re: Please confirm exam arrangements', 'Another request.'), 'inbox'); g.ingest(mail('n3', 'Re: Please confirm exam arrangements', 'And one more.'), 'inbox');
  const p = g.packet(), before = g.tasks()[0];
  assert.equal(p.messages.length, 2);
  for (const title of ['', '   ', 'x'.repeat(181), 7, {}]) assert.throws(() => g.apply({ packet_id: p.packet_id, decisions: [upd('n2', { title }), upd('n3')] }), /Invalid title/);
  assert.deepEqual(g.tasks()[0], before); assert.equal(g.pending().length, 2);
  // Both messages target the same task: n2 renames, n3 omits the title (must not reset it); the last action wins.
  assert.equal(g.apply({ packet_id: p.packet_id, decisions: [upd('n2', { title: '  新标题  ' }), upd('n3', { action: '最终综合', title: null })] }).applied, 2);
  const after = g.tasks()[0];
  assert.equal(after.id, id); assert.equal(after.title, '新标题'); assert.equal(after.action, '最终综合'); assert.equal(after.revision, before.revision + 2);
  assert.equal(g.db.prepare('SELECT count(*) c FROM sources WHERE task_id=?').get(id).c, 3);
  g.render(new Date('2026-10-05T03:00:00Z'));
  assert.match(fs.readFileSync(path.join(g.dir, 'today.md'), 'utf8'), /\*\*新标题\*\*/);
  // Omitting the title leaves it alone.
  g.ingest(mail('n4', 'Re: Please confirm exam arrangements', 'More.'), 'inbox'); const q = g.packet();
  g.apply({ packet_id: q.packet_id, decisions: [upd('n4')] }); assert.equal(g.tasks()[0].title, '新标题');
});
test('packet scheduling uses full mail evidence; a hidden deadline and related research/teaching never wait',t=>{
  const f=setup(t);
  const make=(id,text,subject='General campus information',sender='news@wisc.edu')=>({id,subject,receivedDateTime:'2026-10-12T18:00:00Z',sender:{emailAddress:{address:sender}},body:{content:text}});
  f.ingest(make('normal','General information about campus life.'),'inbox');
  f.ingest(make('hidden','General campus information. '.repeat(40)+'Deadline tomorrow: submit the form.'),'inbox');
  f.ingest(make('teaching','General information.','Course update','notifications@instructure.com'),'inbox');
  f.config.researchKeywords=['graphene'];f.ingest(make('research','Graphene material update.'),'inbox');
  f.ingest(make('fee','Your reservation was cancelled; a fee may apply.'),'inbox');
  f.ingest(make('sent','General information.'),'sent');
  const p=f.packet(),byId=Object.fromEntries(p.messages.map(m=>[m.id,m]));
  assert.equal(byId.normal.batchable,true);
  assert.equal(byId.hidden.truncated,true);assert.doesNotMatch(byId.hidden.text,/Deadline/);assert.equal(byId.hidden.batchable,false,'deadline beyond excerpt still prevents waiting');
  for(const id of ['teaching','research','fee','sent'])assert.equal(byId[id].batchable,false,id);
  f.db.prepare("UPDATE messages SET reason='escalated' WHERE id='normal'").run();
  assert.equal(f.packet().messages.find(m=>m.id==='normal').batchable,false,'long-excerpt evidence retry must not wait');
});

test('Search finds filtered mail by any term set, newest first, and FOM alerts stay out of the notification digest', t => {
  const f = setup(t);
  const talk = mail('talk', 'Public lecture: Moire excitons', 'All welcome to the colloquium on moire excitons in twisted bilayers, Friday 4pm in Chamberlin 2241.');
  talk.sender.emailAddress.address = 'seminars@lists.wisc.edu';
  assert.equal(f.ingest(talk, 'inbox'), 'filtered');
  const opening = mail('opening', 'FOM: A session is cancelled on STEP Heidelberg laser writer',
    'A user has just cancelled a session. Please login and reserve your session before other users grab this time!');
  opening.sender.emailAddress.address = 'fomsupport@engr.wisc.edu';
  assert.equal(f.ingest(opening, 'inbox'), 'filtered');
  const hit = f.search('MOIRE chamberlin');
  assert.equal(hit.total, 1); assert.equal(hit.results[0].id, 'talk'); assert.equal(hit.results[0].state, 'filtered');
  assert.match(hit.results[0].snippet, /moire excitons/i);
  assert.equal(f.search('moire absent-word').total, 0);
  assert.equal(f.search('laser writer').results[0].reason, 'optional-fom-opening');
  assert.throws(() => f.search('  '));
  f.render(); const digest = fs.readFileSync(path.join(f.dir, 'notifications.md'), 'utf8');
  assert.match(digest, /Moire excitons/); assert.doesNotMatch(digest, /FOM:/);
});

test('Link targets do not use up the packet excerpt, so a quote after long safelinks is visible in the excerpt', t => {
  const f = setup(t), url = 'https://urldefense.com/v3/__https://example.com/' + 'a'.repeat(400) + '__;!!x$';
  const body = Array.from({ length: 4 }, (_, i) => `${i + 1}. Terms [link ${i}](${url}) apply.`).join(' ') + ' ## Request #1 Pump | $3,117.32 | 1 | Payment Total: $4,094.02';
  f.ingest(mail('quote', 'Your Quote Request #1', body), 'inbox');
  const stored = JSON.parse(f.db.prepare("SELECT data FROM messages WHERE id='quote'").get().data).text;
  assert.ok(stored.includes('urldefense'), 'stored text keeps the original links');
  const p1 = f.packet(); assert.doesNotMatch(p1.messages[0].text, /urldefense/); assert.equal(p1.messages[0].truncated, false);
  assert.match(p1.messages[0].text, /Payment Total: \$4,094\.02/);
});
