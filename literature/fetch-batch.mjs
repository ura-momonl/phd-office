import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, read } from '../automation/files.mjs';
import { fetch_paper } from './fetch.mjs';
import { pdfTextExecutable } from './pdf-tools.mjs';
import { FetchBackoff } from './fetch-backoff.mjs';

// One writer, concurrent single-paper fetches. The journal is the resume cursor:
// unavailable articles are recorded once, not implicitly retried.
export async function runFetchBatch({ directory, concurrency = 6, fetchPaper = fetch_paper }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
  const dir = path.resolve(directory);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'RUNNING');
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const state = { pid: process.pid, started_at: new Date().toISOString(), status: 'starting', concurrency,
    total: 0, completed: 0, available: 0, unavailable: 0, counts: {}, current: [] };
  const log = path.join(dir, 'attempts.jsonl');
  const save = () => fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2) + '\n');
  const say = message => {
    const line = `${new Date().toLocaleTimeString()} ${message}`;
    console.log(line);
    fs.appendFileSync(path.join(dir, 'progress.log'), line + '\n');
  };
  function stop(reason) {
    if (state.reason) return;
    state.status = 'stopping'; state.reason = reason; save();
    say(`STOPPING (letting in-flight papers finish): ${reason}`);
  }
  function userStopped() {
    if (fs.existsSync(path.join(dir, 'STOP'))) stop('Requested with STOP file');
    return state.status !== 'running';
  }
  try {
    // A 429 says nothing about the article, so it stays in the journal as evidence but is retried on the next run.
    const prior = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [])
      .filter(p => p.result.status !== 'rate_limited');
    const backoff = new FetchBackoff(path.join(dir, 'source-limits.json'));
    const seen = new Set(prior.map(p => p.doi));
    state.completed = prior.length;
    for (const { result } of prior) {
      state.counts[result.status] = (state.counts[result.status] || 0) + 1;
      if (result.status === 'available') state.available++; else state.unavailable++;
    }
    const parser = spawnSync(pdfTextExecutable(), ['-v'], { encoding: 'utf8', windowsHide: true });
    if (parser.status !== 0) throw new Error(`PDF validator cannot start (exit ${parser.status}, ${parser.error?.code || 'no error code'})`);
    const targets = read('literature/catalog.json').papers.filter(p => (!p.library_status || p.library_status === 'active')
      && p.doi && !seen.has(p.doi) && (!p.fulltext_path || !fs.existsSync(path.resolve(root, p.fulltext_path))));
    state.total = prior.length + targets.length; state.status = 'running'; save();
    if (!fs.existsSync(path.join(dir, 'targets.json'))) fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(targets.map(p => ({ doi: p.doi, title: p.title, source: p.source })), null, 2) + '\n');
    say(`RESUME: ${prior.length} already attempted, ${targets.length} remaining; concurrency ${concurrency}, Zotero serialized. Zotero / public sources only; NO mouse macro, NO NetID login, NO prepaid spending.`);
    say(`Progress: ${dir}`);
    say('Unavailable articles are skipped. HTTP 429 skips requests to that host until Retry-After; other articles continue immediately. STOP or Ctrl+C stops the batch.');
    let cursor = 0;
    async function worker(lane) {
      while (cursor < targets.length && !userStopped()) {
        if (userStopped() || cursor >= targets.length) return;
        const p = targets[cursor++], at = new Date().toISOString();
        state.current.push({ lane, doi: p.doi, title: p.title, started_at: at }); save();
        say(`[lane ${lane}, active ${state.current.length}/${concurrency}] FETCH ${p.doi} | ${p.title}`);
        const result = await fetchPaper(p.doi, { backoff });
        fs.appendFileSync(log, JSON.stringify({ at, finished_at: new Date().toISOString(), doi: p.doi, title: p.title, result }) + '\n');
        state.completed++; state.counts[result.status] = (state.counts[result.status] || 0) + 1;
        if (result.status === 'available') state.available++; else state.unavailable++;
        state.current = state.current.filter(p => p.lane !== lane);
        if (result.status === 'rate_limited') {
          say(`SKIPPED ${p.doi}: rate limited; continuing next article without batch wait. That host's Retry-After is respected by skipping requests, not by stopping workers.`);
        }
        say(`[${state.completed}/${state.total}] ${result.status} | obtained ${state.available} | unavailable ${state.unavailable}${result.message ? ' | ' + result.message : ''}`);
        save();
        if (result.status === 'validation_failed' && (result.parser_exit_code === 3221225794 || ['parser_unavailable', 'parser_permission_denied'].includes(result.pdf_reason))) stop('Local PDF validator unavailable');
      }
    }
    const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, i) => worker(i + 1).catch(error => { stop(error.message); throw error; })));
    const rejected = results.find(r => r.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (state.status === 'stopping') state.status = 'stopped';
    if (state.status === 'running') { state.status = 'complete'; say(`COMPLETE: ${state.completed} attempted; ${state.available} obtained; ${state.unavailable} unavailable.`); }
  } catch (error) {
    state.status = 'failed'; state.reason = error.message; say(`FAILED: ${error.message}`);
  } finally {
    state.finished_at = new Date().toISOString(); save(); fs.unlinkSync(lock);
  }
  return state;
}
