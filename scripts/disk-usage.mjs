// Read-only disk usage tree: which folders take the space and how recently they changed. Deletes nothing, follows no links.
// Usage: node scripts/disk-usage.mjs [path=project root] [--depth=2] [--min=50]   (--min is in MB: smaller entries are summed into "others")
// For a whole drive or paths outside the office, WizTree is also installed (see the hint printed at run time).
// Also reports leftover test copies (phd-tests-*) in the system temp folder, which live outside the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const hit = args.find(a => a.startsWith(`--${name}=`)); return hit ? Number(hit.split('=')[1]) : fallback; };
const target = path.resolve(args.find(a => !a.startsWith('--')) ?? fileURLToPath(new URL('../', import.meta.url)));
const depth = option('depth', 2), minBytes = option('min', 50) * 1048576;

// Returns {bytes, files, newest}; children is filled only down to the requested depth.
function measure(dir, level) {
  const node = { name: path.basename(dir), bytes: 0, files: 0, newest: 0, children: [] };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // links and junctions would double count or leave the tree
    if (entry.isDirectory()) {
      const child = measure(full, level + 1);
      node.bytes += child.bytes; node.files += child.files; node.newest = Math.max(node.newest, child.newest);
      if (level < depth) node.children.push(child);
    } else if (entry.isFile()) {
      let stat; try { stat = fs.lstatSync(full); } catch { continue; }
      node.bytes += stat.size; node.files++; node.newest = Math.max(node.newest, stat.mtimeMs);
      if (level < depth) node.children.push({ name: entry.name, bytes: stat.size, files: 1, newest: stat.mtimeMs, children: [], file: true });
    }
  }
  return node;
}

const size = bytes => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
const day = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '-';

function show(node, indent) {
  const big = node.children.filter(c => c.bytes >= minBytes).sort((a, b) => b.bytes - a.bytes);
  const rest = node.children.filter(c => c.bytes < minBytes);
  for (const child of big) {
    console.log(`${' '.repeat(indent * 2)}${size(child.bytes).padStart(10)}  ${String(child.files).padStart(7)} files  ${day(child.newest)}  ${child.name}${child.file ? '' : '/'}`);
    show(child, indent + 1);
  }
  if (rest.length) {
    const bytes = rest.reduce((sum, c) => sum + c.bytes, 0);
    console.log(`${' '.repeat(indent * 2)}${size(bytes).padStart(10)}  ${String(rest.reduce((sum, c) => sum + c.files, 0)).padStart(7)} files             (${rest.length} smaller entries)`);
  }
}

// Whole drives and folders outside the office are slow here; WizTree reads the MFT directly. /admin=1 pops a UAC prompt only the user can accept.
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (path.relative(root, target).startsWith('..') || path.parse(target).root === target) {
  console.log('Hint: for a whole drive or folders outside the office, WizTree is faster: "D:\\Program Files\\WizTree\\WizTree64.exe" <path> /export=<out.csv> /admin=0  (/admin=1 = MFT scan, needs the user to accept UAC).\n');
}

const started = Date.now();
const tree = measure(target, 0);
console.log(`${target}  total ${size(tree.bytes)}, ${tree.files} files, newest ${day(tree.newest)}  (min ${minBytes / 1048576} MB, depth ${depth})`);
show(tree, 1);

// run-tests.mjs keeps its copies in <project parent>/.test-tmp (OFFICE_TEST_TMP); older runs left them in the system temp folder.
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.test-tmp');
for (const temp of new Set([path.resolve(process.env.OFFICE_TEST_TMP || here), os.tmpdir()])) {
  if (!fs.existsSync(temp)) continue;
  const copies = fs.readdirSync(temp, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('phd-tests-'));
  if (copies.length) {
    const sizes = copies.map(e => measure(path.join(temp, e.name), 99));
    console.log(`\nTest copies in ${temp}: ${copies.length} x phd-tests-*, ${size(sizes.reduce((s, c) => s + c.bytes, 0))}, newest ${day(Math.max(...sizes.map(c => c.newest)))} (run-tests.mjs removes copies older than a day at start)`);
  }
}
console.log(`\nscan ${((Date.now() - started) / 1000).toFixed(1)} s; read-only.`);
