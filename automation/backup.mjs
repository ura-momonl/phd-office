import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root } from './files.mjs';

// A dated copy of everything people and models edit. The project is not under git, so this is the only way back from a wrong write.
// Once per UTC day, the newest KEEP days are kept. No model is involved.
// Retired text-adventure saves remain protected; removing its code did not authorize deleting user data.
//
// Copy by exclusion: every top-level entry of the office is taken except the folders below, which hold tens of GB. A new module, a new
// note file or a new data file is therefore in the next backup without anyone editing a list first.
const SKIP = ['.runtime', 'literature', 'node_modules', 'output', 'tmp', 'workspace'];
// Inside the skipped folders, what cannot be rebuilt: the literature index, the conversation history, the retired adventure saves.
const FILES = ['literature/catalog.json', '.runtime/agent/sessions.json', '.runtime/adventure/saves.json'];
// Inside them, the running data and the pre-edit copies people roll back to.
const DIRECTORIES = ['.runtime/weekly', '.runtime/inbox', '.runtime/work', '.runtime/companion-notes', '.runtime/agent/file-baselines', '.runtime/skill-edits', 'literature/recommendations', 'workspace/outbox'];
// Project frameworks are rewritten by the assistants daily and live in the skipped workspace, so they are copied one file at a time.
const GLOBS = ['workspace/projects/*/FRAMEWORK.md'];
const LEDGER = '.runtime/mail-flow/mail.sqlite';
const KEEP = 14;

// Backup files are never edited, so a file unchanged since the previous day's backup (same size and mtime) is hard-linked instead of copied again.
// A link is not the data: its target is backed up where it really lives, or is outside the office.
function copyInto(from, to, previous) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const name of fs.readdirSync(from)) copyInto(path.join(from, name), path.join(to, name), previous && path.join(previous, name)); return; }
  const old = previous && fs.existsSync(previous) ? fs.statSync(previous) : null;
  // The copy's own mtime is written back from the source, so a file untouched since the previous day matches to within timestamp
  // resolution (a fraction of a millisecond); anything a person or a model edited is older by far more than that.
  if (old && old.size === stat.size && Math.abs(old.mtimeMs - stat.mtimeMs) < 1) { fs.linkSync(previous, to); return; }
  fs.copyFileSync(from, to); fs.utimesSync(to, stat.atime, stat.mtime);
}

// `*` matches one path segment, which is all the patterns above need.
function glob(pattern) {
  let paths = [root];
  for (const part of pattern.split('/')) paths = paths.flatMap(dir => part === '*' ? fs.readdirSync(dir).map(name => path.join(dir, name)) : [path.join(dir, part)]);
  return paths.filter(p => fs.existsSync(p)).map(p => path.relative(root, p).replaceAll('\\', '/'));
}

export function backupData({ now = new Date(), keep = KEEP } = {}) {
  const base = path.join(root, '.runtime/backups'), day = now.toISOString().slice(0, 10), target = path.join(base, day), staging = target + '.partial';
  if (fs.existsSync(target)) return { day, skipped: true };
  fs.rmSync(staging, { recursive: true, force: true });
  let copied = 0;
  const earlier = fs.existsSync(base) ? fs.readdirSync(base).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < day).sort().at(-1) : null;
  const previous = relative => earlier ? path.join(base, earlier, relative) : null;
  const place = relative => { const to = path.join(staging, relative); fs.mkdirSync(path.dirname(to), { recursive: true }); return to; };
  const put = relative => { copyInto(path.join(root, relative), place(relative), previous(relative)); copied++; };
  for (const file of FILES) if (fs.existsSync(path.join(root, file))) put(file);
  for (const directory of DIRECTORIES) if (fs.existsSync(path.join(root, directory))) put(directory);
  for (const pattern of GLOBS) for (const relative of glob(pattern)) put(relative);
  for (const name of fs.readdirSync(root)) if (!SKIP.includes(name)) put(name);
  // The ledger is open in other processes: VACUUM INTO writes a consistent copy where a file copy could catch it mid-write.
  if (fs.existsSync(path.join(root, LEDGER))) {
    const db = new DatabaseSync(path.join(root, LEDGER), { readOnly: true });
    try { db.exec(`VACUUM INTO '${place(LEDGER).replace(/'/g, "''")}'`); copied++; } finally { db.close(); }
  }
  fs.renameSync(staging, target);
  const days = fs.readdirSync(base).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - keep))) fs.rmSync(path.join(base, old), { recursive: true, force: true });
  return { day, copied };
}
