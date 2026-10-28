// What the assistants did in this conversation, for the right-hand panel: tool calls, files touched, sub-agents, context use.
// Calls come from each turn's events.jsonl (the same parser as `agent calls`); everything here is read-only.
import fs from 'node:fs';
import path from 'node:path';
import { width, clip, pad, wrap } from './text.mjs';
import { R, BOLD, color, SPINNER, elapsed } from './view.mjs';
import { toolSummary } from '../agent/tool-summary.mjs';

const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|FileChange)$/;
const ICON = { Bash: '$', Shell: '$', PowerShell: '$', Read: '◇', Grep: '⌕', Glob: '⌕', Edit: '✎', MultiEdit: '✎', Write: '✚', FileChange: '✎', WebSearch: '⇣', WebFetch: '⇣', Agent: '⚑', Skill: '✦' };
const lineCount = s => (s ? String(s).split('\n').length : 0);

export function relPath(p, root) {
  const n = String(p).replace(/\\/g, '/'), r = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  return n.toLowerCase().startsWith(r.toLowerCase()) ? n.slice(r.length) : n.split('/').slice(-2).join('/');
}

// One parsed call -> {name, icon, text, files:[{path,adds,dels,write}], status}
export function describeCall(c, root) {
  let inp = null;
  try { inp = JSON.parse(c.input); } catch { /* shell commands and path lists are plain text */ }
  inp = inp && typeof inp === 'object' ? inp : {};
  const files = [];
  if (c.name === 'Edit') files.push({ path: inp.file_path, adds: lineCount(inp.new_string), dels: lineCount(inp.old_string) });
  else if (c.name === 'MultiEdit') files.push({ path: inp.file_path, adds: (inp.edits || []).reduce((a, e) => a + lineCount(e.new_string), 0), dels: (inp.edits || []).reduce((a, e) => a + lineCount(e.old_string), 0) });
  else if (c.name === 'Write') files.push({ path: inp.file_path, adds: lineCount(inp.content), dels: 0, write: true });
  else if (c.name === 'NotebookEdit') files.push({ path: inp.notebook_path, adds: 0, dels: 0 });
  else if (c.name === 'FileChange') for (const p of String(c.input || '').split(';').map(x => x.trim()).filter(Boolean)) files.push({ path: p, adds: 0, dels: 0 });
  const target = inp.file_path || inp.path || inp.notebook_path;
  const text = files.length ? files.map(f => relPath(f.path, root)).join('、')
    : /^(Bash|Shell|PowerShell)$/.test(c.name) ? toolSummary(c.name, { command: String(c.input || '') }) // "运行隔离测试", "语法检查 · file" instead of the raw command line
    : target ? relPath(target, root)
    : inp.description || inp.pattern || inp.query || inp.url || String(c.brief || c.input || '').split('\n')[0];
  return { name: c.name, icon: ICON[c.name] || '·', text: String(text).replace(/\s+/g, ' '), files: files.filter(f => f.path), status: c.status, ms: c.durationMs, task: c.task };
}

// Calls of one session, oldest first -> {feed, files}. `files` is the list of touched files, most recently touched first.
export function summarizeCalls(calls, root) {
  const feed = calls.map(c => describeCall(c, root)), byFile = new Map();
  feed.forEach((c, i) => {
    for (const f of c.files) {
      const key = relPath(f.path, root), e = byFile.get(key) || { path: key, edits: 0, adds: 0, dels: 0, write: false, last: 0 };
      e.edits++; e.adds += f.adds; e.dels += f.dels; e.write ||= !!f.write; e.last = i; byFile.set(key, e);
    }
  });
  return { feed, files: [...byFile.values()].sort((a, b) => b.last - a.last) };
}

// ---- Reading the event logs ---------------------------------------------------------------------------------------
// cache: Map(file -> {mtimeMs, size, calls}); only logs that changed since the last look are parsed again.
export async function loadSessionCalls(root, taskIds, cache) {
  const { parseEvents } = await import('../agent/calls.mjs');
  const runs = path.join(root, '.runtime', 'agent', 'runs'), calls = [];
  for (const id of taskIds) {
    const base = path.join(runs, id);
    if (!fs.existsSync(base)) continue;
    const dirs = [base, ...fs.readdirSync(base).filter(d => /^\d+$/.test(d)).sort((a, b) => a - b).map(d => path.join(base, d))];
    for (const dir of dirs) {
      const file = path.join(dir, 'events.jsonl');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file), hit = cache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, calls: parseEvents(file).calls });
      for (const c of cache.get(file).calls) calls.push({ ...c, task: id });
    }
  }
  return calls;
}

// ---- Panel --------------------------------------------------------------------------------------------------------
const tok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

// model: {summary:{feed,files}|null, runs:[subagent_runs], active:Set(taskId), context:{tokens,window,parts}|null, now, tick}
export function activityPanel(model, w, h, th) {
  const inner = w - 3, L = [], dim = s => color(th, 'dim', s);
  const title = t => { L.push(''); L.push(' ' + BOLD + color(th, 'accent', t) + R); };
  const { summary, runs, active, context, now, tick } = model, callRows = [];
  L.push(' ' + BOLD + '活动' + R + dim('  Ctrl+B 关闭'));

  // Reserve the bottom for the context block, the sub-agent and file blocks before the call feed gets what is left.
  const ctx = [];
  if (context?.window) {
    const pct = Math.min(100, Math.round(context.tokens / context.window * 100)), n = 14, fill = Math.round(pct / 100 * n);
    ctx.push(' ' + color(th, pct > 80 ? 'warn' : 'accent', '█'.repeat(fill)) + dim('░'.repeat(n - fill)) + ` ${pct}%  ${tok(context.tokens)}/${tok(context.window)}`);
    const parts = [...(context.parts || [])].filter(p => p.key !== 'fixed').sort((a, b) => b.tokens - a.tokens).slice(0, 3).map(p => `${p.label.replace(/（.*/, '')} ${Math.round(p.tokens / context.tokens * 100)}%`);
    if (parts.length) ctx.push(' ' + dim(clip(parts.join(' · '), inner)));
  }
  const sub = runs.slice(-3).map(r => {
    const running = r.status !== 'completed' && r.status !== 'failed' && !r.finished_at;
    const t = running ? elapsed(now - Date.parse(r.at)) : r.finished_at ? elapsed(Date.parse(r.finished_at) - Date.parse(r.at)) : '';
    const mark = running ? color(th, 'accent', SPINNER[tick % 4]) : r.status === 'failed' ? color(th, 'warn', '✗') : color(th, 'ok', '✓');
    const head = ' ' + mark + ' ', time = t ? ' ' + dim(t) : '';
    return head + clip(r.title || r.kind || '子 agent', inner - 2 - width(time)) + time;
  });
  const files = (summary?.files || []).slice(0, 6).map(f => {
    const plain = ` ×${f.edits}` + (f.adds || f.dels ? ` +${f.adds} −${f.dels}` : ''), p = clip(f.path, Math.max(8, inner - 3 - width(plain)));
    const tail = dim(` ×${f.edits}`) + (f.adds || f.dels ? ' ' + color(th, 'ok', `+${f.adds}`) + ' ' + color(th, 'bad', `−${f.dels}`) : '');
    return ' ' + color(th, f.write ? 'ok' : 'accent', f.write ? '✚' : '✎') + ' ' + p + tail;
  });

  if (sub.length) { title('子 agent'); L.push(...sub); }
  if (files.length) { title(`改动文件 ${summary.files.length}`); L.push(...files); }
  const used = L.length + (ctx.length ? 2 + ctx.length : 0) + 2;
  const room = Math.max(0, h - used);
  if (summary?.feed.length && room > 0) {
    title('最近调用');
    const last = summary.feed.length - 1;
    for (const [i, c] of summary.feed.slice(-room).entries()) {
      const idx = summary.feed.length - Math.min(room, summary.feed.length) + i;
      const ok = c.status === '完成', fail = c.status === '失败' || /^退出码/.test(c.status || '');
      const live = !ok && !fail && idx === last && active.has(c.task);
      const mark = live ? color(th, 'accent', SPINNER[tick % 4]) : ok ? color(th, 'ok', '✓') : fail ? color(th, 'warn', '✗') : dim('·');
      const ms = c.ms != null && c.ms >= 1500 ? ' ' + dim((c.ms / 1000).toFixed(1) + 's') : '';
      callRows.push({ line: L.length, i: idx });
      L.push(' ' + mark + ' ' + dim(c.icon) + ' ' + clip(`${c.name === 'Bash' || c.name === 'Shell' || c.name === 'PowerShell' ? '' : c.name + ' '}${c.text}`, inner - 5 - width(ms)) + ms);
    }
  }
  if (!summary?.feed.length && !sub.length) { L.push(''); L.push(' ' + dim('这个对话还没有工具调用')); }
  // Context block sits at the bottom of the panel.
  if (ctx.length) { while (L.length < h - ctx.length - 2) L.push(''); title('上下文'); L.push(...ctx); }
  const out = L.slice(0, h).map(l => pad(l, w));
  out.callRows = callRows.filter(r => r.line < h);
  return out;
}

// ---- Call detail screen --------------------------------------------------------------------------------------------
// What one call was given and what it returned, as ANSI lines of at most w cells. Edits are shown as a coloured diff.
export function callDetailLines(c, root, w, th, n, total) {
  const dim = s => color(th, 'dim', s), L = [], inner = Math.max(10, w - 4);
  const text = (s, prefix, tone, cap = 120) => {
    const rows = String(s ?? '').split('\n');
    rows.slice(0, cap).forEach(r => { for (const l of wrap(r || ' ', inner)) L.push(' ' + (tone ? color(th, tone, prefix + l) : prefix + l)); });
    if (rows.length > cap) L.push(' ' + dim(`… 省略 ${rows.length - cap} 行`));
  };
  const ms = c.durationMs != null ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : '';
  L.push(' ' + BOLD + color(th, 'accent', `#${n}/${total}  ${c.name}`) + R + dim(` · ${c.status}${ms}${c.chars != null ? ` · 返回 ${c.chars} 字符` : ''}`), '');
  let inp = null;
  try { inp = JSON.parse(c.input); } catch { /* shell commands and path lists are plain text */ }
  inp = inp && typeof inp === 'object' ? inp : null;
  if (inp && c.name === 'Edit') {
    L.push(' ' + dim(relPath(inp.file_path, root)));
    text(inp.old_string, '- ', 'bad'); text(inp.new_string, '+ ', 'ok');
  } else if (inp && c.name === 'MultiEdit') {
    L.push(' ' + dim(relPath(inp.file_path, root)));
    for (const e of inp.edits || []) { text(e.old_string, '- ', 'bad'); text(e.new_string, '+ ', 'ok'); L.push(''); }
  } else if (inp && c.name === 'Write') {
    L.push(' ' + dim(relPath(inp.file_path, root) + ' · 写入 ' + lineCount(inp.content) + ' 行'));
    text(inp.content, '+ ', 'ok', 60);
  } else if (/^(Bash|Shell|PowerShell)$/.test(c.name)) {
    text(c.input, '$ ', 'accent', 60);
  } else {
    text(inp ? JSON.stringify(inp, null, 2) : c.input, '', null, 60);
  }
  if (c.output) { L.push('', ' ' + dim('返回'), ''); text(c.output, '', null, 120); }
  return L;
}
