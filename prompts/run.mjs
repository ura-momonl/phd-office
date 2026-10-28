import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { cases } from './golden-cases.mjs';
import { fragment, fragmentIds, fragmentRefs, fragmentSource, fragmentsDir } from './compose.mjs';

// Inventory and local editing of prompt text. Never calls a model.
// Surfaces are listed in prompts/registry.json (facts only: where the text lives, who loads it).
export const registry = () => JSON.parse(fs.readFileSync(path.join(root, 'prompts/registry.json'), 'utf8').replace(/^﻿/, ''));
const resolve = p => p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.join(root, p);
const text = file => { try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const source = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const surfaces = () => registry().surfaces.map(s => ({ ...s, file: resolve(s.path), body: text(resolve(s.path)) }));
// Several surfaces can live in one file (agent/run.mjs); scans count each file once so a file never duplicates itself.
const files = () => [
  ...[...new Map(surfaces().filter(s => s.body !== null).map(s => [s.path, { path: s.path, ids: [], body: s.body }])).values()].map(f => ({ ...f, ids: surfaces().filter(s => s.path === f.path).map(s => s.id) })),
  ...fragmentIds().map(id => ({ path: `prompts/fragments/${id}.md`, ids: ['fragment:' + id], body: fragmentSource(id) })),
];
const cjk = s => (s.match(/[一-鿿]/g) || []).length;
const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;

export function layers() {
  const rows = surfaces().map(s => ({ id: s.id, kind: s.kind, path: s.path, bytes: s.body === null ? 'MISSING' : Buffer.byteLength(s.body), loaded_by: s.loaded_by, not_loaded_by: s.not_loaded_by, purposes: s.purposes }));
  const frag = fragmentIds();
  return [...rows, { id: 'fragments', kind: 'fragment', path: 'prompts/fragments', count: frag.length, chars: frag.reduce((n, id) => n + fragmentSource(id).length, 0) }];
}

// Normalised sentences that carry real instruction text (>= min CJK characters), found in at least two different surfaces.
export function dupes(min = 12) {
  const seen = new Map();
  for (const s of files()) {
    for (const raw of s.body.split(/[。！？；;\n]|\\n/)) {
      const norm = raw.replace(/[\s`*_>#\-|"'“”‘’（）()【】\[\]，,：:、.]/g, '');
      if (cjk(norm) < min) continue;
      (seen.get(norm) ?? seen.set(norm, new Map()).get(norm)).set(s.path, raw.trim().slice(0, 90));
    }
  }
  return [...seen.entries()].filter(([, m]) => m.size > 1).map(([, m]) => ({ sample: [...m.values()][0], in: [...m.keys()] })).sort((a, b) => b.in.length - a.in.length);
}

export function where(phrase) {
  if (!phrase) throw new Error('where <短语>：在已登记的提示词面里字面查找');
  return files().map(s => {
    const lines = s.body.split('\n').flatMap((line, i) => line.includes(phrase) ? [i + 1] : []);
    return lines.length ? { path: s.path, surfaces: s.ids, count: lines.length, lines: lines.slice(0, 8) } : null;
  }).filter(Boolean);
}

// Per background purpose: how many input tokens a call really consumed against how big the program-written prompt was.
// Only Codex runs record tokenUsage in events.jsonl; other runs are skipped, not guessed.
export function overhead(limit = 600, dir = path.join(root, '.runtime/agent/runs')) {
  const groups = {};
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, limit) : [];
  for (const { n } of names) {
    const events = text(path.join(dir, n, 'events.jsonl')), prompt = path.join(dir, n, 'prompt.txt');
    if (!events || !fs.existsSync(prompt)) continue;
    let usage = null;
    for (const line of events.split('\n')) if (line.includes('thread/tokenUsage/updated')) { try { usage = JSON.parse(line).params.tokenUsage.last; } catch { /* partial line */ } }
    if (!usage) continue;
    const key = /^([a-z]+)-/.exec(n)?.[1] ?? 'turn';
    (groups[key] ??= []).push({ promptBytes: fs.statSync(prompt).size, input: usage.inputTokens, cached: usage.cachedInputTokens });
  }
  return Object.entries(groups).map(([purpose, v]) => ({ purpose, runs: v.length, min_input_tokens: Math.min(...v.map(x => x.input)), median_input_tokens: median(v.map(x => x.input)), median_cached_tokens: median(v.map(x => x.cached)), median_prompt_bytes: median(v.map(x => x.promptBytes)) }));
}

// Program code (tests, runtime data, dependencies and vendored trees excluded). Found by walking the tree, not from a hand-kept list,
// so a new caller is checked without anyone remembering to register its file.
const SKIP_DIRS = new Set(['node_modules', '.runtime', '.git', '.claude', '.codex', 'workspace', 'vendor', 'output', 'tmp']);
export function codeFiles(base = root) {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); continue; }
      if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out;
}
// Static fragment/block calls, with any JavaScript quote style. Shared by viewing, lint and rename/delete.
const callPattern = () => /\b(fragment|block)(\s*\(\s*)(['"`])([a-z0-9][a-z0-9/_-]*)\3(?=\s*[,\)])/g;
const codeRefs = () => codeFiles().flatMap(f => [...source(path.join(root, f)).matchAll(callPattern())].map(m => ({ file: f, id: m[4] })));

// Long Chinese strings in code are discovery leads, not errors or judgements about prompt content.
// For a template literal only its fixed parts count, not the ${...} code.
// stringLiterals() is a small JavaScript lexer: it understands comments, regular expressions, quotes and nested template literals, so
// a quote inside a regex or a comment is not mistaken for the start of a string.
export function stringLiterals(src) {
  const out = [], REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^', frames = [{ kind: 'code', depth: 0 }];
  let i = 0, line = 1, prev = '', word = '';
  const top = () => frames[frames.length - 1];
  const nl = ch => { if (ch === '\n') line++; };
  while (i < src.length) {
    const c = src[i], f = top();
    if (f.kind === 'tpl') {
      if (c === '\\') { f.buf += src[i + 1] ?? ''; nl(src[i + 1]); i += 2; continue; }
      if (c === '`') { out.push({ text: f.buf, line: f.line }); frames.pop(); prev = '`'; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { frames.push({ kind: 'code', depth: 0, expr: true }); i += 2; prev = '{'; continue; }
      f.buf += c; nl(c); i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const stop = e < 0 ? src.length : e + 2; for (const ch of src.slice(i, stop)) nl(ch); i = stop; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, body = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { body += src[j + 1] ?? ''; j += 2; } else body += src[j++]; }
      out.push({ text: body, line }); i = j + 1; prev = c; word = ''; continue;
    }
    if (c === '`') { frames.push({ kind: 'tpl', buf: '', line }); i++; continue; }
    if (c === '/') {
      if (prev === '' || REGEX_AFTER.includes(prev) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(word)) {
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
        i = j + 1; while (/[a-z]/.test(src[i] ?? '')) i++; prev = '/'; word = ''; continue;
      }
      prev = '/'; word = ''; i++; continue;
    }
    if (c === '{') f.depth++;
    if (c === '}') { if (f.depth === 0 && f.expr) { frames.pop(); i++; continue; } f.depth--; }
    nl(c);
    if (!/\s/.test(c)) { prev = c; word = /[\w$]/.test(c) ? word + c : ''; } else word = '';
    i++;
  }
  return out;
}
const NOT_PROMPT = new Set(['prompts/golden-cases.mjs']);
export function inlineTexts(min = 80) {
  const hits = [];
  for (const f of codeFiles()) {
    if (NOT_PROMPT.has(f)) continue;
    for (const lit of stringLiterals(source(path.join(root, f)))) if (cjk(lit.text) >= min) hits.push({ file: f, line: lit.line, chars: cjk(lit.text), head: lit.text.replace(/\s+/g, ' ').slice(0, 24) });
  }
  return hits;
}

export function fragments() {
  const refs = codeRefs(), ids = fragmentIds(), found = new Map(ids.map(id => [id, fragmentRefs(id)]));
  return ids.map(id => {
    const r = found.get(id);
    return { id, chars: fragmentSource(id).length, values: r.values, includes: r.includes,
      included_by: ids.filter(o => found.get(o).includes.includes(id)), used_by_code: [...new Set(refs.filter(x => x.id === id).map(x => x.file))] };
  });
}

// Errors break a prompt (missing/looping fragment, code asking for a fragment that does not exist).
// Unused fragments and long inline strings are inventory only: new text may be saved before a caller is connected.
// Candidates are only leads: a rule sentence pasted verbatim outside its fragment, which a human decides to replace with an include.
// Every model call carries purpose:'<name>'. A name found in program code (tests excluded) must be declared in registry.json "purposes",
// which is where its mode and provider -- and so which standing prompts it receives -- are written down.
export function codePurposes() {
  const found = new Map();
  for (const f of codeFiles()) {
    for (const m of source(path.join(root, f)).matchAll(/purpose\s*:\s*'([a-z][a-z-]*)'/g)) (found.get(m[1]) ?? found.set(m[1], new Set()).get(m[1])).add(f);
  }
  return Object.fromEntries([...found].map(([k, v]) => [k, [...v]]));
}

export function lint() {
  const errors = [], candidates = [], ids = new Set(fragmentIds()), refs = codeRefs();
  for (const id of ids) {
    const { values, includes } = fragmentRefs(id);
    for (const inc of includes) if (!ids.has(inc)) errors.push(`${id}: 引用了不存在的片段 ${inc}`);
    try { fragment(id, Object.fromEntries(values.map(v => [v, '·']))); } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  for (const r of refs) if (!ids.has(r.id)) errors.push(`${r.file}: 代码引用了不存在的片段 ${r.id}`);
  const unused = fragments().filter(f => !f.included_by.length && !f.used_by_code.length).map(f => f.id);
  let scanned; // files() reads every code/standing file; once per lint, not once per rule
  for (const id of ids) {
    if (!id.startsWith('rule/')) continue;
    const sentence = fragmentSource(id).trim();
    if (sentence.length < 12) continue;
    for (const f of scanned ??= files()) if (!f.ids.includes('fragment:' + id) && f.body.includes(sentence)) candidates.push({ rule: id, pasted_in: f.path });
  }
  const declared = registry().purposes ?? {};
  for (const [name, where] of Object.entries(codePurposes())) if (!declared[name]) errors.push(`purpose '${name}' 出现在 ${where.join('、')}，但没有在 prompts/registry.json 的 purposes 里登记（写明 mode 和 provider，才能知道它拿到哪些常驻提示词）`);
  return { fragments: ids.size, errors, candidates, unused, inline_text: inlineTexts() };
}

// For each purpose and provider: which standing prompts that call receives. Facts come from registry.json (surfaces[].loaded_by, purposes) and the live config;
// the Claude flags behind them are checked against agent/claude.mjs by prompts.test.mjs. 'unverified' means nobody has measured it.
export function standing() {
  const cfg = JSON.parse(text(path.join(root, 'agent/config.json')) ?? '{}');
  const at = (obj, route) => route.split('.').reduce((xs, k) => k === '*' ? xs.flatMap(x => Object.values(x ?? {})) : xs.map(x => x?.[k]), [obj]);
  const loads = (id, key) => { const hit = (registry().surfaces.find(x => x.id === id)?.loaded_by ?? []).find(v => v === key || v.startsWith(key + '(')); return hit ? (hit.includes('(') ? 'unverified' : 'yes') : 'no'; };
  const rows = [];
  for (const [purpose, p] of Object.entries(registry().purposes ?? {})) {
    const providers = p.providers ?? [...new Set(at(cfg, p.providers_from).filter(Boolean))];
    for (const provider of providers) {
      const key = p.standing_key || provider + '-' + p.mode, override = p.system_prompt_override?.includes(provider);
      rows.push({ purpose, provider, mode: p.mode, system_prompt: override ? 'REPLACED' : loads('system-prompt', key), agents_md: loads('agents-md', key), claude_md: loads('claude-md', key), user_claude_md: loads('user-claude-md', key), note: p.note });
    }
  }
  return rows;
}

// The three things a person does to a fragment, each also fixing whatever points at it, so nobody has to chase references by hand.
// `base` is the office root (a temp copy in tests). Files that can point at a fragment: program code, other fragments ({{>id}}), registry.json.
const FRAG_ID = /^[a-z0-9][a-z0-9/_-]*$/;
const fragFile = (base, id) => path.join(base, 'prompts/fragments', id + '.md');
function pointersTo(id, base) {
  const hits = [];
  for (const f of codeFiles(base)) if ([...source(path.join(base, f)).matchAll(callPattern())].some(m => m[4] === id)) hits.push({ file: f, kind: 'code' });
  for (const other of fragmentIds(path.join(base, 'prompts/fragments'))) {
    if (other !== id && source(fragFile(base, other)).includes('{{>' + id + '}}')) hits.push({ file: 'prompts/fragments/' + other + '.md', kind: 'include' });
  }
  if (source(path.join(base, 'prompts/registry.json')).includes('prompts/fragments/' + id + '.md')) hits.push({ file: 'prompts/registry.json', kind: 'registry' });
  return hits;
}
const checkId = id => { if (!FRAG_ID.test(id ?? '')) throw new Error('片段 id 只能用小写字母、数字、- _ /：' + id); };
export function newFragment(id, body = '', base = root) {
  checkId(id);
  const file = fragFile(base, id);
  if (fs.existsSync(file)) throw new Error('片段已存在：' + id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { created: 'prompts/fragments/' + id + '.md' };
}
export function moveFragment(from, to, base = root) {
  checkId(from); checkId(to);
  if (!fs.existsSync(fragFile(base, from))) throw new Error('没有这个片段：' + from);
  if (fs.existsSync(fragFile(base, to))) throw new Error('目标已存在：' + to);
  const updated = [];
  for (const h of pointersTo(from, base)) {
    const file = path.join(base, h.file);
    let body = fs.readFileSync(file, 'utf8');
    if (h.kind === 'code') body = body.replace(callPattern(), (match, fn, gap, quote, id) => id === from ? fn + gap + quote + to + quote : match);
    else if (h.kind === 'include') body = body.split('{{>' + from + '}}').join('{{>' + to + '}}');
    else body = body.split('prompts/fragments/' + from + '.md').join('prompts/fragments/' + to + '.md');
    fs.writeFileSync(file, body);
    updated.push(h.file);
  }
  fs.mkdirSync(path.dirname(fragFile(base, to)), { recursive: true });
  fs.renameSync(fragFile(base, from), fragFile(base, to));
  return { renamed: [from, to], updated };
}
// Before a fragment is overwritten or deleted its old text goes to .runtime/prompt-history/<id>/<timestamp>.md, so an edit made in the UI can be taken back.
const historyDir = (base, id) => path.join(base, '.runtime/prompt-history', id.replaceAll('/', '__'));
function keepOld(base, id) {
  const old = text(fragFile(base, id));
  if (!old) return; // nothing worth keeping: missing or empty
  fs.mkdirSync(historyDir(base, id), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
  let name = stamp, n = 0;
  while (fs.existsSync(path.join(historyDir(base, id), name + '.md'))) name = stamp + '-' + ++n; // two saves in one millisecond must not overwrite each other
  fs.writeFileSync(path.join(historyDir(base, id), name + '.md'), old);
}
export function fragmentHistory(id, base = root, limit = 10) {
  checkId(id);
  const dir = historyDir(base, id);
  if (!fs.existsSync(dir)) return [];
  // YYYYMMDD-HHmmssSSS[-collision].md: within one timestamp the unsuffixed file is oldest.
  return fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort((a, b) => b.slice(0, 18).localeCompare(a.slice(0, 18)) || (parseInt(b.slice(19), 10) || 0) - (parseInt(a.slice(19), 10) || 0)).slice(0, limit).map(n => ({ version: n.slice(0, -3), body: text(path.join(dir, n)) }));
}
export function saveFragment(id, body, base = root) {
  checkId(id);
  if (!fs.existsSync(fragFile(base, id))) throw new Error('没有这个片段：' + id);
  if (typeof body !== 'string') throw new Error('正文必须是文字');
  if (text(fragFile(base, id)) === body) return { saved: id, changed: false };
  keepOld(base, id);
  fs.writeFileSync(fragFile(base, id), body);
  return { saved: id, changed: true };
}
export function removeFragment(id, base = root) {
  checkId(id);
  if (!fs.existsSync(fragFile(base, id))) throw new Error('没有这个片段：' + id);
  const refs = pointersTo(id, base);
  if (refs.length) throw new Error('还有地方在用「' + id + '」，先改掉这些引用再删：' + refs.map(r => r.file).join('、'));
  keepOld(base, id);
  fs.unlinkSync(fragFile(base, id));
  return { removed: id };
}

export function uses(id) {
  if (!id) throw new Error('uses <片段id>');
  const f = fragments().find(x => x.id === id);
  if (!f) throw new Error('没有这个片段：' + id);
  return { id, included_by: f.included_by, used_by_code: f.used_by_code, values: f.values, includes: f.includes };
}

const goldenFile = () => path.join(root, 'prompts/golden.json');
export const renderGolden = () => Object.fromEntries(cases.map(c => [c.name, c.render()]));
export function snapshot(accept = false) {
  const now = renderGolden(), before = JSON.parse(text(goldenFile()) ?? '{}');
  const changed = Object.keys({ ...before, ...now }).filter(k => before[k] !== now[k]);
  if (accept) fs.writeFileSync(goldenFile(), JSON.stringify(now, null, 2) + '\n');
  return { cases: Object.keys(now).length, changed, accepted: accept };
}

export function runInfo(prefix) {
  const base = path.join(root, '.runtime/agent/runs');
  const hits = fs.existsSync(base) ? fs.readdirSync(base).filter(n => n.startsWith(prefix || '\0')) : [];
  if (hits.length !== 1) throw new Error(hits.length ? `匹配到 ${hits.length} 个运行目录，请给更长的前缀` : 'run <运行目录名前缀>：未找到');
  const dir = path.join(base, hits[0]);
  return { run: hits[0], files: fs.readdirSync(dir).map(f => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size })) };
}

export async function run(action, argument) {
  const out = v => console.log(JSON.stringify(v, null, 2));
  if (action === 'layers') return out(layers());
  if (action === 'dupes') return out(dupes(argument ? Number(argument) : 12));
  if (action === 'where') return out(where(argument));
  if (action === 'overhead') return out(overhead(argument ? Number(argument) : 600));
  if (action === 'run') return out(runInfo(argument));
  if (action === 'snapshot') return out(snapshot(argument === 'accept'));
  if (action === 'fragments') return out(fragments());
  if (action === 'standing') return out(standing());
  if (action === 'uses') return out(uses(argument));
  if (action === 'show') return console.log(fragmentSource(argument));
  if (action === 'new') { const m = /^(\S+)(?:\s([\s\S]*))?$/.exec(String(argument ?? '')); return out(newFragment(m?.[1], m?.[2] ?? '')); }
  if (action === 'mv') { const [a, b] = String(argument ?? '').split(/\s+/); return out(moveFragment(a, b)); }
  if (action === 'rm') return out(removeFragment(argument));
  if (action === 'lint') { const r = lint(); out(r); if (r.errors.length) process.exitCode = 1; return; }
  throw new Error('prompt actions: fragments, uses <片段id>, show <片段id>, new <片段id> [正文], mv <旧id> <新id>, rm <片段id>, lint, standing, layers, dupes [最少汉字数], where <短语>, overhead [最近运行数], run <运行目录前缀>');
}
