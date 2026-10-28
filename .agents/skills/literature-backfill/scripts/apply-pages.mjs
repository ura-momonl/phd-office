// Apply reader pages produced outside api-screen (e.g. subagent fallback) to a task in order.
// Validates each record against the task input, repairs drifted evidence quotes, then appends via reader-work.mjs.
// Usage: node apply-pages.mjs <TASK> <PAGE1.json> [PAGE2.json ...]
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {local,read,loadTask,prefix} from './records.mjs';

const args = process.argv.slice(2);
const taskPath = args[0];
const pages = args.slice(1);
if (!taskPath || !pages.length) throw Error('Usage: apply-pages.mjs <TASK> <PAGE1.json> [...]');
const {t, data} = loadTask(taskPath);
const worker = fileURLToPath(new URL('./reader-work.mjs', import.meta.url));
const nz = x => String(x || '').replace(/\s+/g, ' ').trim();

function fixEvidence(e, abs) {
  const a = nz(abs), w = nz(e).split(' ').filter(Boolean);
  if (!w.length || !a) return e;
  if (w.length <= 20 && a.includes(w.join(' '))) return w.join(' ');
  for (let n = Math.min(20, w.length); n >= 5; n--)
    for (let i = 0; i + n <= w.length; i++) {
      const c = w.slice(i, i + n).join(' ');
      if (a.includes(c)) return c;
    }
  return e;
}

const briefFile = local(t.chunk_file.replace(/\.json$/, '') + '.briefed.json');
if (!fs.existsSync(briefFile))
  fs.writeFileSync(briefFile, JSON.stringify({task: taskPath, at: new Date().toISOString(), by: 'subagent-reader'}) + '\n');

const report = [];
for (const page of pages) {
  const recs = read(page);
  if (!Array.isArray(recs) || !recs.length) throw Error('page is not a non-empty array: ' + page);
  recs.forEach(x => {
    const p = data.find(d => d.id === x.id);
    if (p) x.e = fixEvidence(x.e, p.abstract);
  });
  const chunkPath = local(t.chunk_file);
  fs.writeFileSync(chunkPath, JSON.stringify(recs));
  const logFd = fs.openSync(chunkPath.replace(/\.json$/, '') + '.append.log', 'w');
  try {
    execFileSync(process.execPath, [worker, 'append', taskPath, t.chunk_file], {stdio: ['ignore', logFd, logFd]});
    const now = prefix(t.output, data);
    report.push({page, records: recs.length, saved: now.length, total: data.length});
  } catch (e) {
    const log = fs.readFileSync(chunkPath.replace(/\.json$/, '') + '.append.log', 'utf8') || e.message;
    fs.closeSync(logFd);
    throw Error(page + ' 追加失败：' + log.slice(0, 2000));
  }
  fs.closeSync(logFd);
}
console.log(JSON.stringify({task: taskPath, pages: report, remaining: data.length - report[report.length - 1].saved}, null, 1));
