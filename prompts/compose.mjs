import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../automation/files.mjs';

// Prompt text lives in prompts/fragments/<id>.md. A fragment may use {{name}} (a value the caller passes) and {{>other-id}} (another fragment,
// rendered with the same values). Substitution is a single pass: inserted values and included text are never scanned again, so user or mail text
// containing "{{" cannot inject anything. A missing value or fragment throws instead of leaving a hole in a prompt.
export const fragmentsDir = path.join(root, 'prompts/fragments');
const ID = /^[a-z0-9][a-z0-9/_-]*$/;
const TOKEN = /\{\{(>?)([a-z0-9][a-z0-9/_-]*)\}\}/g;

export function fragmentSource(id, dir = fragmentsDir) {
  if (!ID.test(id)) throw new Error(`提示词片段 id 不合法：${id}`);
  const file = path.join(dir, id + '.md');
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`提示词片段不存在：${id}`); }
  return body.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
}

// Which fragments a piece of code rendered, so a run can record what its agent was given. Synchronous only: callers wrap one render call.
let collector = null;
export function traceFragments(fn, { sources = false } = {}) {
  const previous = collector, used = new Map();
  used.sources = sources; used.snapshots = new Map();
  collector = used;
  try { return [fn(), [...used].map(([id, uses]) => ({ id, uses }))]; } finally { collector = previous; }
}

// Only source-traced synchronous renders carry these string-compatible values. Explicit joins
// preserve their ranges; ordinary concatenation drops provenance rather than guessing it back.
class PromptText extends String {
  constructor(text, nodes) { super(text); this.nodes = nodes; }
}
const sha256 = text => createHash('sha256').update(text).digest('hex');
const shifted = (nodes, offset) => nodes.map(n => ({ ...n, start: n.start + offset, end: n.end + offset,
  ...(n.children ? { children: shifted(n.children, offset) } : {}) }));
const document = (text, nodes) => text ? new PromptText(text, nodes) : '';
export function joinPrompt(parts, separator = '\n') {
  if (!collector?.sources) return parts.join(separator);
  let text = ''; const nodes = [];
  parts.forEach((part, i) => {
    if (i) text += separator;
    if (part instanceof PromptText) nodes.push(...shifted(part.nodes, text.length));
    text += part == null ? '' : String(part);
  });
  return document(text, nodes);
}
export function promptSource(value, source) {
  if (!collector?.sources || value == null || value === false || value === '') return value;
  const text = String(value);
  return document(text, [{ kind: 'source', ...source, start: 0, end: text.length,
    children: value instanceof PromptText ? value.nodes : [] }]);
}
export function promptMap(value) {
  if (!collector?.sources) return null;
  const text = String(value);
  return { version: 1, sha256: sha256(text), nodes: value instanceof PromptText ? value.nodes : [],
    fragments: Object.fromEntries(collector.snapshots) };
}

export function fragment(id, values = {}, { dir = fragmentsDir, trail = [] } = {}) {
  if (trail.includes(id)) throw new Error(`提示词片段循环引用：${[...trail, id].join(' → ')}`);
  collector?.set(id, (collector.get(id) || 0) + 1);
  const source = fragmentSource(id, dir), children = [];
  let text = '', last = 0;
  for (const m of source.matchAll(TOKEN)) {
    text += source.slice(last, m.index);
    const name = m[2];
    if (!m[1] && (!(name in values) || values[name] === undefined || values[name] === null)) throw new Error(`提示词片段 ${id} 缺少值：${name}`);
    const value = m[1] ? fragment(name, values, { dir, trail: [...trail, id] }) : values[name];
    const at = text.length, body = String(value);
    if (collector?.sources) {
      const nodes = value instanceof PromptText ? shifted(value.nodes, at) : [];
      if (m[1]) children.push(...nodes);
      else if (body) children.push({ kind: 'value', name, start: at, end: at + body.length, children: nodes });
    }
    text += body; last = m.index + m[0].length;
  }
  text += source.slice(last);
  if (!collector?.sources) return text;
  const hash = sha256(source);
  collector.snapshots.set(id + '@' + hash, { id, sha256: hash, body: source });
  return document(text, [{ kind: 'fragment', id, sha256: hash, start: 0, end: text.length, children }]);
}

// The expanded text of a fragment as pieces that remember where they came from, with each {{value}} left as a named slot.
// For viewing only: `overrides` ({id: body}) previews unsaved edits; an include that does not exist shows up as a 'missing' piece.
export function fragmentSegments(id, { dir = fragmentsDir, overrides = {} } = {}, trail = []) {
  if (trail.includes(id)) throw new Error(`提示词片段循环引用：${[...trail, id].join(' → ')}`);
  const src = id in overrides ? String(overrides[id]).replace(/\r\n/g, '\n').replace(/\n$/, '') : fragmentSource(id, dir);
  const out = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    if (m.index > last) out.push({ from: id, kind: 'text', text: src.slice(last, m.index) });
    if (!m[1]) out.push({ from: id, kind: 'value', text: m[2] });
    else if (!(m[2] in overrides) && !fragmentIds(dir).includes(m[2])) out.push({ from: id, kind: 'missing', text: m[2] });
    else out.push(...fragmentSegments(m[2], { dir, overrides }, [...trail, id]));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ from: id, kind: 'text', text: src.slice(last) });
  return out;
}

// What a fragment refers to, for lint and "where used": its values and the fragments it includes.
export function fragmentRefs(id, dir = fragmentsDir) {
  const values = new Set(), includes = new Set();
  for (const [, include, name] of fragmentSource(id, dir).matchAll(TOKEN)) (include ? includes : values).add(name);
  return { values: [...values], includes: [...includes] };
}

export function fragmentIds(dir = fragmentsDir) {
  const out = [];
  const walk = (d, prefix) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '/');
    else if (e.name.endsWith('.md')) out.push(prefix + e.name.slice(0, -3));
  } };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}
