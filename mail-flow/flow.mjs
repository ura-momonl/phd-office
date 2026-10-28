import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { screen, canBatch } from './screen.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  const temp = file + '.tmp'; fs.writeFileSync(temp, text, 'utf8'); fs.renameSync(temp, file); return true;
}
export function plain(text = '', { keepForwarded = false } = {}) {
  const body = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  // Forwarded material is the evidence being sent, not disposable reply history.
  // Keep ordinary replies' existing history trimming and packet size bounds.
  const content = keepForwarded ? body : body
    .split(/\n\s*(?:\*\s*\*\s*\*|_{5,}|-{5,}|On .+wrote:|\*?\*?From:\*?\*?)/i)[0]
    .replace(/Get \[?Outlook for (?:iOS|Android)[\s\S]*$/i, '');
  return content.replace(/\s+/g, ' ').trim();
}
// Link targets (safelinks, tracking URLs) can fill the excerpt before any real content; the model only needs the visible link text.
// Used for the packet copy only, so stored text and fingerprints stay unchanged.
export const packetText = text => String(text).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
function address(x) { return x?.emailAddress?.address || x?.email_address?.address || ''; }
export function normalize(raw, folder) {
  if (!raw.id || !(raw.receivedDateTime || raw.received_date_time)) throw new Error('Mail lacks an exact ID/time');
  const m = { id: raw.id, subject: raw.subject || '', sender: address(raw.sender),
    recipients: [...(raw.toRecipients || []), ...(raw.ccRecipients || [])].map(address).filter(Boolean),
    received: raw.receivedDateTime || raw.received_date_time, folder,
    text: plain(raw.body?.content || raw.bodyPreview || raw.body_preview || '',
      {keepForwarded:/^\s*(?:(?:re|回复|答复)\s*[:：]\s*)*(?:fw|fwd|转发)\s*[:：]/i.test(raw.subject || '')}),
    link: raw.web_link || raw.webLink || raw.display_url || '', attachments: !!(raw.has_attachments || raw.hasAttachments) };
  // Reading/marking an email, categories, and folder placement do not change its meaning.
  m.fingerprint = hash(JSON.stringify([m.subject, m.sender, m.recipients, m.received, m.text, m.attachments]));
  return m;
}
// The user closing a task from the inbox is the only writer of 'done'; classifier decisions stay limited to todo/waiting.
// The revision bump makes any packet exported before the close fail as stale instead of reviving the task.
function moveTask(directory, id, from, to) {
  const file = path.join(directory, 'mail.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(id);
      const moved = row && from.includes(row.status);
      if (moved) db.prepare('UPDATE tasks SET status=?,revision=revision+1 WHERE id=?').run(to, id);
      db.exec('COMMIT');
      return moved ? row.status : null;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
}
// Read-only facts for one task, so an agent never has to guess where mail evidence is stored.
// Account, message-ID and link lines are noise for judgment and stay out of the prompt; action-note.md only restates the task action.
export function taskEvidence(directory, id, {complete = false} = {}) {
  const file = path.join(directory, 'mail.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) return null;
    const legacy = t.legacy ? JSON.parse(t.legacy) : {};
    const noise = /^(账号|conversation_id|最新消息ID|邮件链接)\s*[:：]/;
    const stored = db.prepare('SELECT m.data FROM sources s JOIN messages m ON m.id=s.id WHERE s.task_id=?').all(id)
      .map(r => JSON.parse(r.data)).sort((a, b) => String(a.received).localeCompare(String(b.received)) || String(a.id).localeCompare(String(b.id)));
    if (complete) return {
      matter: {id:t.id, title:t.title, status:t.status, check_at:t.check_at, deadline:t.deadline},
      background_assessment: {origin:'background_mail_review', suggested_next_step:t.action},
      source_messages: stored.map(m=>({id:m.id, sender:m.sender, recipients:m.recipients, folder:m.folder, received:m.received, subject:m.subject, text:m.text, has_attachments:m.attachments, link:m.link})),
      source_representation:'Stored normalized message text, without additional work-prompt truncation. This is not the original MIME or attachment contents. Use message IDs with outlook-prepare for full original messages and attachments when needed.',
      legacy_context: {origin:'imported_context_with_mixed_provenance', notes:legacy.notes || '', comments:legacy.metadata?.comments || []},
      local_artifacts: JSON.parse(t.artifacts).map(file=>({path:file, origin:'local_artifact_not_independent_mail_evidence'})),
    };
    const messages = stored.slice(-3).reverse()
      .map(m => ({ sender: m.sender, folder: m.folder, received: m.received, subject: m.subject, text: String(m.text).slice(0, 1200) }));
    return { title: t.title, action: t.action, status: t.status, check_at: t.check_at, deadline: t.deadline,
      notes: String(legacy.notes || '').split('\n').filter(l => !noise.test(l)).join('\n').slice(0, 1500),
      comments: (legacy.metadata?.comments || []).map(c => String(c.body).slice(0, 600)).slice(-3),
      artifacts: JSON.parse(t.artifacts), messages,
      artifact_text: JSON.parse(t.artifacts).filter(p => /\.(md|txt)$/i.test(p) && !/action-note\.md$/i.test(p) && fs.existsSync(p)).slice(0, 2).map(p => ({ path: p, text: fs.readFileSync(p, 'utf8').slice(0, 1500) })) };
  } finally { db.close(); }
}
// Which tier ('screen' or 'judgment') last decided a task; null for tasks decided before tiers were recorded.
export function taskHandler(directory, id) {
  const file = path.join(directory, 'mail.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='handlers'").get();
    return (row && JSON.parse(row.value)[id]) || null;
  } finally { db.close(); }
}
// Received time of the newest mail linked to a task; null when none is linked. A saved card older than this was written without that mail.
export function latestSourceAt(directory, id) {
  const file = path.join(directory, 'mail.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT max(json_extract(m.data,'$.received')) t FROM sources s JOIN messages m ON m.id=s.id WHERE s.task_id=?").get(id).t || null;
  } finally { db.close(); }
}
export const closeTask =(directory, id) => moveTask(directory, id, ['todo', 'waiting'], 'done');
export const reopenTask = (directory, id, status) => moveTask(directory, id, ['done'], status);
export class Flow {
  constructor(directory, config) {
    this.dir = directory; this.config = config; fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'mail.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        action TEXT NOT NULL, check_at TEXT, deadline TEXT, contacts TEXT NOT NULL, subjects TEXT NOT NULL,
        artifacts TEXT NOT NULL, legacy TEXT, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT NOT NULL, priority INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS packets(id TEXT PRIMARY KEY, data TEXT NOT NULL, applied TEXT);`);
    const account = this.get('account');
    if (account && account !== config.account) throw new Error('Store belongs to a different mailbox');
    if (!account) this.set('account', config.account);
  }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY check_at,id').all(); }
  importLegacy(exportFile, seeds) {
    if (this.get('legacyImported')) return { imported: 0 };
    const cards = readJSON(exportFile).cards;
    return this.transaction(() => {
      for (const seed of seeds) {
        const c = cards.find(c => c.id === seed.id); if (!c) throw new Error('Missing legacy task ' + seed.id);
        const text = [c.notes, ...(c.metadata?.comments || []).map(c => c.body)].join('\n');
        const ids = new Set([...text.matchAll(/\bAAMk[A-Za-z0-9+/=_-]{80,}(?![A-Za-z0-9+/=_%\-])/g)].map(m => m[0]));
        for (const match of text.matchAll(/https:\/\/[^\s<>]+/g)) {
          try { const id = new URL(match[0]).searchParams.get('ItemID'); if (id) ids.add(id); } catch { /* Preserve raw IDs above. */ }
        }
        const checks = [...text.matchAll(/nextCheckAt[^\n]*?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d)/g)];
        const subjects = [...text.matchAll(/AAMk[^\s]+\s*\|\s*([^\n|]+)\s*\|/g)].map(m => m[1].trim());
        const contacts = [...new Set(text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [])].filter(x => x !== this.config.account);
        const artifacts = (c.metadata?.artifacts || []).map(a => a.path).filter(p => fs.existsSync(p));
        this.db.prepare(`INSERT INTO tasks(id,title,status,action,check_at,deadline,contacts,subjects,artifacts,legacy)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(c.id, seed.title || c.title, c.status === 'blocked' ? 'waiting' : 'todo',
          seed.action, checks.at(-1)?.[1] || null, seed.deadline || null, JSON.stringify(contacts),
          JSON.stringify(subjects), JSON.stringify(artifacts), JSON.stringify(c));
        for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?)').run(id, c.id);
      }
      this.set('legacyImported', true); return { imported: seeds.length };
    });
  }
  // One-off and idempotent: legacy tasks whose notes name the mail subject but whose subjects column is empty, so subject matching can find them.
  backfillSubjects() {
    let changed = 0;
    for (const t of this.tasks()) {
      if (JSON.parse(t.subjects).length || !t.legacy) continue;
      const subjects = [...String(JSON.parse(t.legacy).notes || '').matchAll(/^主题[:：]\s*(.+)$/gm)].map(m => m[1].trim().slice(0, 200)).filter(Boolean);
      if (!subjects.length) continue;
      this.db.prepare('UPDATE tasks SET subjects=? WHERE id=?').run(JSON.stringify([...new Set(subjects)]), t.id); changed++;
    }
    return { changed };
  }
  related(m) {
    const subject = s => s.replace(/^(?:(?:re|fw|fwd):\s*)+/gi, '').trim().toLowerCase();
    const words = (m.subject + ' ' + m.text).toLowerCase();
    return this.tasks().map(t => {
      let score = 0;
      const sameSubject=JSON.parse(t.subjects).some(s => subject(s) === subject(m.subject));
      // Completion is evidence too. Only an exact subject match may bring a closed matter back as context;
      // sharing a sender alone must not resurrect unrelated completed work.
      if(t.status==='done' && !sameSubject)return {...t,score};
      if (JSON.parse(t.contacts).some(c => c === m.sender || (m.folder === 'sent' && m.recipients.includes(c)))) score += 3;
      if (sameSubject) score += 4;
      if (/high\s*vac\s*depot/i.test(t.title) && /high\s*vac\s*depot|highvacdepot\.com/.test(words + ' ' + m.sender)) score += 3;
      return { ...t, score };
    }).filter(t => t.score >= 3).sort((a, b) => b.score - a.score).slice(0, 2);
  }
  ingest(raw, folder) {
    const m = normalize(raw, folder);
    const previous = this.db.prepare('SELECT fingerprint FROM messages WHERE id=?').get(m.id);
    if (previous?.fingerprint === m.fingerprint) return 'unchanged';
    const source = this.db.prepare('SELECT task_id FROM sources WHERE id=?').get(m.id);
    const actionable = /deadline|required|mandatory|please|confirm|exam|training|compliance|quote|invoice|付款|截止|培训|报价/i.test(m.subject + ' ' + m.text);
    const related = this.related(m);
    const rule = screen(m, related, this.config.researchKeywords || []);
    // Sent mail is evidence, never proof that a task was completed. Ambiguous incoming mail stays visible.
    const state = !previous && source ? 'reviewed' : rule ? 'filtered' : 'pending';
    const priority = (related.length ? 5 : 0) + (actionable ? 3 : 0) + (/urgent|earliest|tomorrow|明天/i.test(m.text) ? 3 : 0);
    this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      fingerprint=excluded.fingerprint,data=excluded.data,state=excluded.state,reason=excluded.reason,priority=excluded.priority`)
      .run(m.id, m.fingerprint, JSON.stringify(m), state, source ? 'legacy-source' : rule || 'needs-judgment', priority);
    return state;
  }
  async collect(reader, now = new Date()) {
    const profile = await reader.call('get_profile');
    if ((profile.email || '').toLowerCase() !== this.config.account.toLowerCase()) throw new Error(`Outlook get_profile reports ${profile.email||'an unverified identity'}, expected ${this.config.account}; mailbox identity is not verified, scan stopped before reading mail`);
    let folders = this.get('folders');
    if (!folders) {
      const response = await reader.call('list_mail_folders', { top: 200 });
      const list = response.value || response.folders || (Array.isArray(response) ? response : null);
      if (!list) throw new Error('Unknown folder response shape');
      const find = names => list.find(f => names.includes((f.displayName || f.display_name || f.name || '').toLowerCase()));
      const inbox = find(['inbox', '收件箱']); const sent = find(['sent items', 'sentitems', '已发送邮件']);
      if (!inbox?.id || !sent?.id) throw new Error('Inbox/Sent folders not identified; scan stopped');
      folders = { inbox: inbox.id, sent: sent.id }; this.set('folders', folders);
    }
    let scan = this.get('scan');
    if (!scan) {
      const since = this.get('lastComplete');
      const start = since ? Date.parse(since) - this.config.overlapMinutes * 60000
        : now - this.config.initialLookbackHours * 3600000;
      scan = { start: new Date(start).toISOString(), end: now.toISOString(), folder: 'inbox', skip: 0,
        mode: since ? 'incremental' : 'initial' };
      this.set('scan', scan);
    }
    const counts = { pages: 0, pending: 0, reviewed: 0, filtered: 0, unchanged: 0, modelTurns: 0, complete: false,
      mode: scan.mode || 'initial', windowStart: scan.start, windowEnd: scan.end };
    while (scan && counts.pages < this.config.maxPagesPerRun) {
      const page = await reader.call('list_messages', { folder_id: folders[scan.folder], top: this.config.pageSize,
        skip: scan.skip, filter: `receivedDateTime ge ${scan.start} and receivedDateTime lt ${scan.end}`, order_by: 'receivedDateTime desc' });
      if (!Array.isArray(page.value) || typeof page.has_more !== 'boolean') throw new Error('Unknown pagination response; cursor not advanced');
      if (page.has_more && (!Number.isInteger(page.next_from_index) || page.next_from_index <= scan.skip)) throw new Error('Pagination did not advance');
      this.transaction(() => {
        for (const raw of page.value) counts[this.ingest(raw, scan.folder)]++;
        scan = page.has_more ? { ...scan, skip: page.next_from_index } : scan.folder === 'inbox' ? { ...scan, folder: 'sent', skip: 0 } : null;
        if (!scan) {
          const finished = this.get('scan'); this.set('lastComplete', finished.end);
          counts.complete = true;
        }
        this.set('scan', scan);
      });
      counts.pages++;
    }
    this.set('lastRun', { at: now.toISOString(), ...counts }); this.set('lastError', null); return counts;
  }
  pending() { return this.db.prepare("SELECT * FROM messages WHERE state='pending' ORDER BY priority DESC,json_extract(data,'$.received') DESC,id").all(); }
  packet({ messageIds } = {}) {
    let pending = this.pending();
    if (messageIds !== undefined) {
      if (!Array.isArray(messageIds) || !messageIds.length || messageIds.some(id => typeof id !== 'string' || !id) || new Set(messageIds).size !== messageIds.length) throw new Error('Invalid targeted mail IDs');
      const selected = new Set(messageIds);
      pending = pending.filter(m => selected.has(m.id));
      if (pending.length !== selected.size) throw new Error('Targeted mail must exist and be pending');
    }
    const body = { version: 1, account: this.config.account, messages: [], tasks: [] };
    for (const row of pending) {
      if (body.messages.length >= this.config.maxBatchMessages) break;
      // A message deferred only because its text was cut gets one retry with a longer excerpt (reason 'escalated', set in apply).
      const m = JSON.parse(row.data), candidates = this.related(m), limit = row.reason === 'escalated' ? 3000 : 700, shown = packetText(m.text);
      const addedTasks = candidates.filter(t => !body.tasks.some(x => x.id === t.id)).map(t => ({ id: t.id, revision: t.revision,
        title: t.title, status: t.status, action: t.action.slice(0, 800), check_at: t.check_at }));
      const next = { ...body, messages: [...body.messages, { id: m.id, fingerprint: m.fingerprint, sender: m.sender,
        subject: m.subject.slice(0, 180), received: m.received, folder: m.folder, text: shown.slice(0, limit), truncated: shown.length > limit,
        related_task_ids: candidates.map(t => t.id), batchable: row.reason !== 'escalated' && canBatch(m, candidates, this.config.researchKeywords || []) }], tasks: [...body.tasks, ...addedTasks] };
      if (Buffer.byteLength(JSON.stringify(next)) + 150 > this.config.maxPacketBytes) continue;
      body.messages = next.messages; body.tasks = next.tasks;
    }
    if (messageIds !== undefined && body.messages.length !== pending.length) throw new Error('Targeted mail exceeds packet limits');
    // Open tasks the rules did not match still go in as bare titles, so a model can recognise the same matter under a different subject.
    if (body.messages.length) for (const t of this.tasks().filter(t => t.status !== 'done' && !body.tasks.some(x => x.id === t.id))) {
      const next = { ...body, tasks: [...body.tasks, { id: t.id, revision: t.revision, title: t.title.slice(0, 50), status: t.status, brief: t.action.replace(/\s+/g, ' ').slice(0, 60) }] };
      if (Buffer.byteLength(JSON.stringify(next)) + 150 > this.config.maxPacketBytes) break;
      body.tasks = next.tasks;
    }
    if (!body.messages.length) {
      const file = path.join(this.dir, 'review-packet.json'); if (fs.existsSync(file)) fs.unlinkSync(file);
      return null;
    }
    const packet = { packet_id: hash(JSON.stringify(body)), ...body };
    this.db.prepare('INSERT OR IGNORE INTO packets(id,data) VALUES(?,?)').run(packet.packet_id, JSON.stringify(packet));
    writeChanged(path.join(this.dir, 'review-packet.json'), JSON.stringify(packet) + '\n');
    return packet;
  }
  apply(result) {
    if (!result || Object.keys(result).some(k => !['packet_id', 'decisions'].includes(k))) throw new Error('Invalid decision envelope');
    const row = this.db.prepare('SELECT * FROM packets WHERE id=?').get(result.packet_id);
    if (!row) throw new Error('Unknown packet');
    const digest = hash(JSON.stringify(result));
    if (row.applied) { if (row.applied !== digest) throw new Error('Packet already applied with different decisions'); return { applied: 0 }; }
    const packet = JSON.parse(row.data);
    if (!Array.isArray(result.decisions) || result.decisions.length !== packet.messages.length) throw new Error('One decision per packet message required');
    const ids = new Set();
    for (const d of result.decisions) {
      if (Object.keys(d).some(k => !['message_id', 'decision', 'task_id', 'title', 'action', 'check_at', 'status', 'deadline', 'handler'].includes(k))) throw new Error('Unsupported operation');
      if (d.handler !== undefined && !['screen', 'judgment'].includes(d.handler)) throw new Error('Unknown handler');
      const m = packet.messages.find(m => m.id === d.message_id);
      if (!m || ids.has(d.message_id)) throw new Error('Unknown or duplicate message'); ids.add(d.message_id);
      const current = this.db.prepare('SELECT * FROM messages WHERE id=?').get(d.message_id);
      if (current?.state !== 'pending' || current.fingerprint !== m.fingerprint) throw new Error('Message changed; export a fresh packet');
      if (!['ignore', 'defer', 'update', 'new'].includes(d.decision)) throw new Error('Unknown decision');
      if (d.decision === 'defer' && d.action !== undefined && (typeof d.action !== 'string' || d.action.length > 400)) throw new Error('Invalid evidence request');
      if (d.decision === 'update') {
        const t = packet.tasks.find(t => t.id === d.task_id);
        if (!t || this.db.prepare('SELECT revision FROM tasks WHERE id=?').get(t.id)?.revision !== t.revision) throw new Error('Unknown or stale task');
        if(t.status==='done')throw new Error('Completed task is evidence only; do not reopen it. A genuinely new request needs its own task.');
      }
      if (['update', 'new'].includes(d.decision)) {
        if (!['todo', 'waiting'].includes(d.status) || typeof d.action !== 'string' || !d.action.trim() || d.action.length > 800) throw new Error('Invalid task action/status');
        if (d.check_at !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(d.check_at || '') || !Number.isFinite(Date.parse(d.check_at)))) throw new Error('Invalid next check time');
        // new needs a title; update may carry one (omitted or null keeps the stored title) when the old one no longer names the current to-do.
        if ((d.decision === 'new' || (d.title !== undefined && d.title !== null)) && (typeof d.title !== 'string' || !d.title.trim() || d.title.length > 180)) throw new Error('Invalid title');
        // Optional: only a deadline the mail states, with a time zone, so inbox priority and the weekly plan can rely on it.
        if (d.deadline !== undefined && d.deadline !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(d.deadline) || !Number.isFinite(Date.parse(d.deadline)))) throw new Error('Invalid deadline');
      }
    }
    return this.transaction(() => {
      for (const d of result.decisions) {
        const m = JSON.parse(this.db.prepare('SELECT data FROM messages WHERE id=?').get(d.message_id).data);
        if (d.decision === 'defer') {
          const wasCut = packet.messages.find(x => x.id === m.id)?.truncated && this.db.prepare('SELECT reason FROM messages WHERE id=?').get(m.id).reason !== 'escalated';
          if (wasCut) this.db.prepare("UPDATE messages SET state='pending',reason='escalated' WHERE id=?").run(m.id);
          else this.db.prepare("UPDATE messages SET state='deferred',reason=? WHERE id=?").run(d.action || '需查看完整内容以确认下一步', m.id);
          continue;
        }
        if (d.decision === 'update' || d.decision === 'new') {
          const id = d.decision === 'new' ? 'mail-' + hash(this.config.account + '\0' + m.id).slice(0, 24) : d.task_id;
          if (d.decision === 'new') this.db.prepare(`INSERT INTO tasks(id,title,status,action,check_at,deadline,contacts,subjects,artifacts)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(id, d.title, d.status, d.action, d.check_at, d.deadline ?? null, JSON.stringify([m.sender, ...m.recipients].filter(x => x !== this.config.account)), JSON.stringify([m.subject]), '[]');
          // Several updates to one task in a batch apply in order: the last action wins, so each must carry the combined next step (see REVIEW-PROMPT.md).
          else this.db.prepare('UPDATE tasks SET title=COALESCE(?,title),status=?,action=?,check_at=?,deadline=COALESCE(?,deadline),revision=revision+1 WHERE id=?').run(d.title?.trim() ?? null, d.status, d.action, d.check_at, d.deadline ?? null, id);
          this.db.prepare('INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id').run(m.id, id);
          // The tier that last decided this task; its card goes to that tier's agent (see taskHandler).
          if (d.handler) this.set('handlers', { ...this.get('handlers'), [id]: d.handler });
        }
        this.db.prepare("UPDATE messages SET state='reviewed',reason=? WHERE id=?").run(d.decision, m.id);
      }
      this.db.prepare('UPDATE packets SET applied=? WHERE id=?').run(digest, packet.packet_id);
      return { applied: result.decisions.length };
    });
  }
  render(now = new Date()) {
    const dates = new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const day = dates.format(now);
    const lines = [`# 邮箱事务 · ${day}`, '', '本页由程序维护。邮件只读；草稿仅保存在本地。', ''];
    const scan = this.get('scan');
    lines.push(this.get('lastComplete') ? `最近完整读取日期：${dates.format(new Date(this.get('lastComplete')))}（具体时间见 mail status）。` : '尚未完成第一次读取。');
    if (scan) lines.push(`读取尚未完成；下一次从 ${scan.folder} 的已保存位置继续。`);
    const error = this.get('lastError'); if (error) lines.push(`最近读取/处理失败：${error.message}（${error.at}）；已保存的事项仍可查看。`);
    lines.push(`待判断 ${this.pending().length} 封；待补证据 ${this.db.prepare("SELECT count(*) n FROM messages WHERE state='deferred'").get().n} 封。`, '');
    const notifications = this.db.prepare("SELECT * FROM messages WHERE state='filtered' AND reason<>'optional-fom-opening' ORDER BY json_extract(data,'$.received') DESC LIMIT 50").all();
    const digest = ['# 通知摘要', '', '程序识别的可选通知和群发资讯，保留来源供查看。未删除、移动或标记邮箱邮件。', ''];
    for (const row of notifications) {
      const m = JSON.parse(row.data), title = m.subject.replace(/[\[\]]/g, '');
      digest.push(`- ${m.link ? `[${title}](${m.link})` : title}（${m.received}）`);
    }
    if (!notifications.length) digest.push('暂无程序筛出的通知。');
    writeChanged(path.join(this.dir, 'notifications.md'), digest.join('\n') + '\n');
    if (notifications.length) lines.push(`[通知摘要](notifications.md)：${notifications.length} 条近期通知未进入 AI 队列。`, '');
    const waitingEvidence = this.db.prepare("SELECT * FROM messages WHERE state IN ('pending','deferred') ORDER BY priority DESC LIMIT 10").all();
    if (waitingEvidence.length) {
      lines.push('## 新邮件与待核实内容', '');
      for (const row of waitingEvidence) {
        const m = JSON.parse(row.data);
        const title = m.subject.replace(/[\[\]]/g, '');
        lines.push(`- ${m.link ? `[${title}](${m.link})` : title}：${row.state === 'deferred' ? row.reason.replace(/。$/, '') : '待判断是否需要行动'}。`);
      }
      lines.push('');
    }
    for (const [status, title] of [['todo', '需要我处理'], ['waiting', '等待或核实进展']]) {
      lines.push(`## ${title}`, '');
      for (const t of this.tasks().filter(t => t.status === status)) {
        const due = t.check_at && Date.parse(t.check_at) <= now.getTime();
        lines.push(`- **${t.title}**${due ? ' · 到复查时间' : ''}：${t.action.replace(/\s+/g, ' ')}`);
        if (t.check_at) lines.push(`  下次复查：${t.check_at}${t.deadline ? `；截止：${t.deadline}` : ''}。`);
        for (const p of JSON.parse(t.artifacts)) lines.push(`  [${path.basename(p)}](<${p.replace(/\\/g, '/')}> )`.replace('> )', '>)'));
      }
      lines.push('');
    }
    return writeChanged(path.join(this.dir, 'today.md'), lines.join('\n'));
  }
  // Read-only lookup across every state (including filtered). Space-separated terms must all appear in subject, sender or body.
  search(query, limit = 20) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('Supply a keyword to search');
    const hits = [];
    for (const row of this.db.prepare('SELECT id,data,state,reason FROM messages').all()) {
      const m = JSON.parse(row.data), hay = `${m.subject} ${m.sender} ${m.text}`.toLowerCase();
      if (!terms.every(term => hay.includes(term))) continue;
      const at = Math.max(0, m.text.toLowerCase().indexOf(terms[0]) - 60);
      hits.push({ id: row.id, subject: m.subject, sender: m.sender, received: m.received, folder: m.folder,
        state: row.state, reason: row.reason, link: m.link || null, snippet: m.text.slice(at, at + 200) });
    }
    hits.sort((a, b) => Date.parse(b.received) - Date.parse(a.received));
    return { total: hits.length, shown: Math.min(hits.length, limit), results: hits.slice(0, limit) };
  }
  status() { return { tasks: this.tasks().length, pending: this.pending().length,
    lastComplete: this.get('lastComplete'), partialScan: this.get('scan'), lastRun: this.get('lastRun') }; }
  close() { this.db.close(); }
}
