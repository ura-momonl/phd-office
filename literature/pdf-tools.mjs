import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';

// Prefer the project's portable parser over unrelated MiKTeX installations.
// PDFTOTEXT also lets isolated tests use the same host binary without copying tools/data.
export function pdfTextExecutable() {
  if (process.env.PDFTOTEXT) return process.env.PDFTOTEXT;
  const local = path.join(root, '.runtime/tools/poppler/Library/bin/pdftotext.exe');
  return process.platform === 'win32' && fs.existsSync(local) ? local : 'pdftotext';
}

export function pdfInfoExecutable() {
  if (process.env.PDFINFO) return process.env.PDFINFO;
  const sibling = path.join(path.dirname(pdfTextExecutable()), process.platform === 'win32' ? 'pdfinfo.exe' : 'pdfinfo');
  return fs.existsSync(sibling) ? sibling : 'pdfinfo';
}
