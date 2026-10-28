import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { codeFiles, fragments, fragmentHistory, lint, registry, snapshot, standing } from './run.mjs';
import { fragmentSegments, fragmentSource } from './compose.mjs';

// Read-only data for the dashboard's prompt page: the same facts the `prompt` commands print, shaped for one screen.
// It stores nothing and decides nothing; editing goes through saveFragment / newFragment / moveFragment / removeFragment in run.mjs.
const resolve = p => path.join(root, p);
const read = p => fs.readFileSync(resolve(p), 'utf8');
const size = p => { try { return fs.statSync(resolve(p)).size; } catch { return null; } };
const CALL = /\b(?:fragment|block)\s*\(\s*(['"`])([a-z0-9][a-z0-9/_-]*)\1/g;

// Which fragments each export of prompts/templates.mjs renders: the text between one top-level `export` and the next.
function templateExports() {
  const out = {};
  let name = null;
  for (const line of read('prompts/templates.mjs').split('\n')) {
    const m = /^export (?:const|function) (\w+)/.exec(line);
    if (m) name = m[1];
    if (name) for (const c of line.matchAll(CALL)) (out[name] ??= new Set()).add(c[2]);
  }
  return out;
}

// Which call purposes a fragment can reach. Followed from the code: a fragment rendered by a templates.mjs export reaches the purposes of the
// files that import that export (registry "surfaces"; "template_exports" settles files that serve several purposes). A fragment registered
// as its own surface, or rendered directly by a registered file, uses that registration. Then up through {{>includes}}.
function purposesOf(frags, reg) {
  const byFile = file => reg.surfaces.filter(s => s.path === file).flatMap(s => s.purposes ?? []);
  const own = new Map(frags.map(f => [f.id, new Set()]));
  const give = (id, ps) => ps.forEach(p => own.get(id)?.add(p));
  for (const s of reg.surfaces) { const m = /^prompts\/fragments\/(.+)\.md$/.exec(s.path); if (m) give(m[1], s.purposes ?? []); }
  for (const f of frags) for (const file of f.used_by_code) if (file !== 'prompts/templates.mjs') give(f.id, byFile(file));
  const exportsOf = templateExports(), exportPurposes = {};
  for (const file of codeFiles()) {
    for (const imp of read(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*prompts\/templates\.mjs['"]/g)) {
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) (exportPurposes[name] ??= new Set()).add(file);
      }
    }
  }
  for (const [name, ids] of Object.entries(exportsOf)) {
    const ps = reg.template_exports?.[name] ?? [...(exportPurposes[name] ?? [])].flatMap(byFile);
    for (const id of ids) give(id, ps);
  }
  const parents = new Map(frags.map(f => [f.id, f.included_by]));
  const reach = (id, seen = new Set()) => {
    if (seen.has(id)) return new Set();
    seen.add(id);
    const out = new Set(own.get(id));
    for (const parent of parents.get(id)) reach(parent, seen).forEach(p => out.add(p));
    return out;
  };
  return Object.fromEntries(frags.map(f => [f.id, [...reach(f.id)].sort()]));
}

export function promptOverview() {
  const frags = fragments(), reg = registry(), reach = purposesOf(frags, reg);
  const scenarios = standing().map(r => ({
    ...r,
    surfaces: reg.surfaces.filter(s => (s.purposes ?? []).includes(r.purpose)).map(s => ({ id: s.id, kind: s.kind, path: s.path, bytes: size(s.path), note: s.note })),
    fragments: frags.filter(f => reach[f.id].includes(r.purpose)).map(f => f.id),
  }));
  const l = lint();
  return {
    fragments: frags.map(f => ({ ...f, domain: f.id.includes('/') ? f.id.split('/')[0] : '', purposes: reach[f.id], body: fragmentSource(f.id) })),
    scenarios,
    standing_files: reg.surfaces.filter(s => s.kind === 'standing').map(s => ({ id: s.id, path: s.path, bytes: size(s.path), note: s.note })),
    lint: { errors: l.errors, fragments: l.fragments },
  };
}

export function promptFragment(id) {
  const body = fragmentSource(id), frags = fragments();
  return { ...frags.find(f => f.id === id), id, body, segments: fragmentSegments(id), purposes: purposesOf(frags, registry())[id], history: fragmentHistory(id) };
}

// Preview an unsaved edit: expand `id` with `body` in place of the saved text. A broken draft returns the problem instead of throwing.
export function promptPreview(id, body) {
  try { return { segments: fragmentSegments(id, { overrides: { [id]: String(body ?? '') } }) }; }
  catch (e) { return { error: e.message }; }
}

export const promptSnapshot = () => snapshot(false);
