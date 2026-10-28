// Bridge for synchronous promptFor(): retrieve memory2 in a child process.
// The turn calls prefetchMemoryV2() first (asynchronous child, backend event loop stays free: the retrieval takes ~6 s and a synchronous wait froze every page),
// and promptFor()'s memoryContextV2() then reads that result; without a prefetch it falls back to the old synchronous child.
// Disabled owners get no memory block. Failures are logged and explicitly reported,
// never replaced with the retired memory store or mistaken for no relevant memory.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { root, read } from '../automation/files.mjs';
import { ownerOn } from './owner.mjs';
import { fragment } from '../prompts/compose.mjs';
import { estimateTokens } from './extract.mjs';
export { ownerOn } from './owner.mjs';

export const memoryV2Enabled = owner => ownerOn(read('agent/config.json').memory_v2, owner);
const empty = () => ({text:'',ids:[],cue_ids:[],recalled_ids:[],estimated_tokens:0,omitted:0,integrity:'v2',mode:'disabled'});
export const unavailableMemory = () => { const text=fragment('memory/v2-unavailable'); return {...empty(),text,estimated_tokens:estimateTokens(text),mode:'unavailable'}; };

const dir = () => path.join(root, '.runtime/memory2');
const MAX_BUFFER = 8 * 1024 * 1024;
const FRESH_MS = 30000; // a prefetch serves the full and delta prompts of the same turn, not a later turn
const prefetched = new Map();
const keyOf = (owner, query) => owner + '\0' + query;

const shape = ctx => ({ text: ctx.text, ids: ctx.ids, cue_ids: [], recalled_ids: ctx.ids, estimated_tokens: ctx.estimated_tokens, omitted: ctx.omitted, integrity: 'v2', mode: ctx.mode });
const parse = stdout => shape(JSON.parse(String(stdout).trim().split('\n').pop()));
function logFailure(owner, e) {
  try { fs.appendFileSync(path.join(dir(), 'inject-errors.log'), `${new Date().toISOString()} ${owner} ${String(e.message).replace(/\s+/g, ' ').slice(0, 400)}\n`); } catch { /* log is best effort */ }
}
const args = file => [path.join(root, 'automation/run.mjs'), 'memory2', 'context', file];
const environment = owner => ({ ...process.env, OFFICE_MEMORY_OWNER: owner });

export async function prefetchMemoryV2(owner, query) {
  const cfg = read('agent/config.json').memory_v2;
  if (!ownerOn(cfg, owner)) return;
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `ctx-${randomUUID()}.json`);
  let result = unavailableMemory();
  try {
    fs.writeFileSync(file, JSON.stringify({ owner, query }));
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args(file), { env: environment(owner), windowsHide: true });
      let stdout = '', stderr = '', size = 0, done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('memory2 context timeout')); }, cfg.timeout_ms ?? 90000);
      child.stdout.on('data', d => { size += d.length; if (size > MAX_BUFFER) { child.kill(); finish(new Error('memory2 context output too large')); } else stdout += d; });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-400); });
      child.on('error', finish);
      child.on('close', code => code === 0 ? finish(null, stdout) : finish(new Error(String(stderr || stdout).slice(-400) || 'exit ' + code)));
    });
    result = parse(out);
  } catch (e) { logFailure(owner, e); }
  finally { fs.rmSync(file, { force: true }); }
  const now = Date.now();
  for (const [k, v] of prefetched) if (now - v.at > FRESH_MS) prefetched.delete(k);
  prefetched.set(keyOf(owner, query), { at: now, result });
}

export function memoryContextV2(owner, query) {
  const cfg = read('agent/config.json').memory_v2;
  if (!ownerOn(cfg, owner)) return empty();
  const hit = prefetched.get(keyOf(owner, query));
  if (hit && Date.now() - hit.at <= FRESH_MS) return hit.result;
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `ctx-${randomUUID()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ owner, query }));
    const r = spawnSync(process.execPath, args(file),
      { encoding: 'utf8', timeout: cfg.timeout_ms ?? 90000, maxBuffer: MAX_BUFFER, env: environment(owner) });
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || r.error).slice(-400));
    return parse(r.stdout);
  } catch (e) {
    logFailure(owner, e);
    return unavailableMemory();
  } finally { fs.rmSync(file, { force: true }); }
}
