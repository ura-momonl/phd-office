import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Flow, readJSON } from './flow.mjs';
import { GraphReader } from './outlook.mjs';
import { OutlookActions } from './actions.mjs';
import {mailGuide} from './guide.mjs';
import {startGraphLogin,graphLoginStatus} from './graph-login.mjs';
import {startReadLogin,pollReadLogin} from './graph-rest.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.runtime/mail-flow');
const config = readJSON(fileURLToPath(new URL('./config.json', import.meta.url)));
const policy = readJSON(fileURLToPath(new URL('../automation/config.json', import.meta.url)));
config.maxPacketBytes = policy.ai.maxReviewPacketBytes;
config.maxBatchMessages = policy.ai.maxItemsPerReview;
const projects = readJSON(fileURLToPath(new URL('../projects/catalog.json', import.meta.url)));
config.researchKeywords = projects.projects.filter(p => p.kind === 'research').flatMap(p => p.aliases);
if (policy.ai.automatic) throw new Error('Automatic AI is not implemented; use explicit packet review');
// A request is a JSON file path, inline JSON starting with '{', or '-' for stdin: no file round trip needed for a one-off action.
function requestInput(argument = '') {
  const text = argument === '-' ? fs.readFileSync(0, 'utf8') : argument.trimStart().startsWith('{') ? argument : null;
  return text === null ? readJSON(path.resolve(argument)) : JSON.parse(text.replace(/^﻿/, ''));
}
export async function run(command = 'status', argument) {
if(command==='guide'){console.log(mailGuide());return;}
if(command==='graph-login') {
  if(argument!=null&&argument!=='calendar')throw new Error('Use graph-login [calendar]; calendar explicitly requests Calendars.ReadWrite');
  console.log(JSON.stringify(await startGraphLogin(root,config.account,{calendar:argument==='calendar'}),null,2));return;
}
if(command==='graph-status') {
  // Inspect the durable result; status never starts another login or consumes a code.
  console.log(JSON.stringify(graphLoginStatus(root),null,2));return;
}
if(command==='read-login'||command==='read-status'||command==='send-login'||command==='send-status') {
  // Read-only mail over Node's TLS stack: works in the confined shell where the SDK login cannot
  // even print a code, and asks for Mail.Read only. Bounded wait, no background poller.
  const wait=Math.min(Number(argument||0)||0,600),kind=command.startsWith('send')?'send':'read';
  if(command.endsWith('-status')){console.log(JSON.stringify(await pollReadLogin(root,config.account,{waitSeconds:wait,kind}),null,2));return;}
  const login=await startReadLogin(root,config.account,{kind});
  const state=await pollReadLogin(root,config.account,{waitSeconds:wait,kind});
  console.log(JSON.stringify({...login,...state,...(state.state==='authenticated'?{user_code:undefined,verification_uri:undefined}:{})},null,2));return;
}
// Interactive actions neither open the mail ledger nor compete for the collector lock.
if (command === 'outlook-tools' || command === 'outlook-prepare' || command === 'outlook') {
  let client;
  try {
    const request = command !== 'outlook-tools' ? requestInput(argument) : null;
    client = new OutlookActions(root); await client.start();
    console.log(JSON.stringify(command === 'outlook-tools' ? await client.tools(argument) :
      command === 'outlook-prepare' ? await client.prepare(request) : await client.call(request), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  // The action result is already printed: a cleanup failure must not turn a completed request into a crash that invites a repeat.
  finally { try { client?.close(); } catch (e) { console.error('Warning: ' + e.message + '. The printed result is unaffected; do not repeat a write.'); } }
  return;
}
fs.mkdirSync(directory, { recursive: true });
const lock = path.join(directory, 'run.lock');
let locked = false, flow, reader;
try {
  try { const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); locked = true; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lock, 'utf8')); if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock; inspect locally');
    let alive = true; try { process.kill(pid, 0); } catch (x) { if (x.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another mail-flow process is running');
    fs.unlinkSync(lock); const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); locked = true;
  }
  flow = new Flow(directory, config);
  if (command === 'init') {
    console.log(JSON.stringify(flow.importLegacy(path.join(root, '.runtime/diagnostics/workboard-after-mail-validation.json'),
      readJSON(fileURLToPath(new URL('./legacy-seeds.json', import.meta.url))))));
    flow.render();
  } else if (command === 'collect') {
    reader = new GraphReader(root, config.account); await reader.start();
    const counts = await flow.collect(reader); const packet = flow.packet(); flow.render();
    console.log(JSON.stringify({ ...counts, connectorCalls: reader.calls, packet: packet ? path.join(directory, 'review-packet.json') : null }));
  } else if (command === 'packet') {
    const p = flow.packet(); console.log(JSON.stringify({ messages: p?.messages.length || 0,
      bytes: p ? Buffer.byteLength(JSON.stringify(p)) : 0, path: p ? path.join(directory, 'review-packet.json') : null }));
  } else if (command === 'apply') {
    if (!argument) throw new Error('Supply a local decisions JSON file');
    console.log(JSON.stringify(flow.apply(readJSON(path.resolve(argument))))); flow.packet(); flow.render();
  } else if (command === 'requeue') {
    const id = argument;
    if (!id) throw new Error('Supply the exact message ID to reconsider');
    const row = flow.db.prepare("UPDATE messages SET state='pending' WHERE id=? AND state IN ('deferred','filtered')").run(id);
    console.log(JSON.stringify({ requeued: Number(row.changes) })); flow.packet(); flow.render();
  } else if (command === 'search') {
    console.log(JSON.stringify(flow.search(argument), null, 2));
  } else if (command === 'backfill') {
    console.log(JSON.stringify(flow.backfillSubjects())); flow.packet(); flow.render();
  } else if (command === 'status') { console.log(JSON.stringify(flow.status(), null, 2)); flow.render(); }
  else throw new Error('Commands: init, collect, status, packet, apply <file>, requeue <message-id>, search <keywords>, backfill');
} catch (e) {
  if (flow) { flow.set('lastError', { at: new Date().toISOString(), message: e.message }); flow.render(); }
  console.error(e.message); process.exitCode = 1;
} finally {
  if (reader) reader.close(); if (flow) flow.close(); if (locked) fs.unlinkSync(lock);
}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await run(process.argv[2] || 'status', process.argv[3]);
