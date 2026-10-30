// Pure rendering helpers: no I/O, so frames can be tested and snapshotted. Layout follows the dsh-TUI idea:
// launchpad home, a quiet transcript (user = tinted band, assistant = bullet), the input between two rules, one status bar.
import { width, wrap, clip, pad } from './text.mjs';
import { mascotPixels } from './mascot.mjs';

export const THEMES = {
  clay:  { name: '陶土', accent: [217, 119, 87], claude: [217, 119, 87], codex: [112, 176, 164], deepseek: [128, 148, 238], user: [232, 222, 202], dim: [128, 124, 118], ok: [140, 180, 120], bad: [214, 96, 88], warn: [222, 176, 90], band: [58, 50, 46], tagFg: [30, 28, 26] },
  night: { name: '夜',   accent: [140, 170, 255], claude: [235, 140, 110], codex: [110, 200, 190], deepseek: [150, 150, 255], user: [210, 214, 228], dim: [112, 116, 134], ok: [130, 200, 140], bad: [240, 112, 112], warn: [230, 190, 100], band: [36, 42, 62], tagFg: [18, 20, 30] },
};
export const PROVIDERS = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
export const SPINNER = ['✻', '✺', '✹', '✸'];
// Each assistant has its own mark, so a long transcript can be read by shape as well as by colour.
export const GLYPH = { claude: '✻', codex: '◆', deepseek: '◈' };

const fgc = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
export const bgc = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
export const R = '\x1b[0m', BOLD = '\x1b[1m', REV = '\x1b[7m', ITAL = '\x1b[3m';
export const color = (theme, name, s) => fgc(theme[name]) + s + R;
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// ---- Markdown-light ------------------------------------------------------------------------------------------------
function inline(line, theme) {
  return line.replace(/\*\*([^*]+)\*\*/g, (_, t) => BOLD + t + R).replace(/`([^`]+)`/g, (_, t) => fgc(theme.warn) + t + R);
}
// A colour part of the way from the dim grey to one of the theme's colours: rules and borders that hint rather than shout.
export const mix = (theme, name, t) => fgc(lerp(theme.dim, theme[name] || theme.accent, t));
// @Claude / @Codex / @DeepSeek / @all in the colour of whoever is named; `restore` brings the surrounding foreground back without resetting a background.
export function mentions(text, theme, restore = '\x1b[39m') {
  return String(text).replace(/@(Claude|Codex|DeepSeek|all)\b/gi, (m, n) => BOLD + fgc(theme[n.toLowerCase() === 'all' ? 'accent' : n.toLowerCase()]) + m + '\x1b[22m' + restore);
}

// Colour of a line inside a fenced block: added / removed / hunk lines of a diff, everything else as code.
export const codeTone = (lang, line) => {
  if (!/^(diff|patch)$/i.test(lang)) return 'warn';
  if (/^(\+\+\+|---) /.test(line)) return 'dim';
  return line.startsWith('+') ? 'ok' : line.startsWith('-') ? 'bad' : line.startsWith('@@') ? 'accent' : 'dim';
};

export function renderMarkdown(text, w, theme) {
  const out = []; let fence = false;
  for (const raw of String(text).split('\n')) {
    const open = /^\s*```\s*([\w-]*)/.exec(raw);
    if (open) {
      if (fence) { out.push(fgc(theme.dim) + '└' + R); fence = false; }
      else { fence = open[1] || 'text'; out.push(fgc(theme.dim) + '┌ ' + (open[1] || '') + R); }
      continue;
    }
    if (fence) { for (const l of wrap(raw, w - 2)) out.push(fgc(theme.dim) + '│ ' + R + fgc(theme[codeTone(fence, raw)]) + l + R); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) { for (const l of wrap(h[2], w)) out.push(BOLD + fgc(theme.accent) + l + R); continue; }
    const b = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (b) {
      const lead = b[1] + (/\d/.test(b[2]) ? b[2] : '•') + ' ', lines = wrap(b[3], w - width(lead));
      lines.forEach((l, i) => out.push((i ? ' '.repeat(width(lead)) : fgc(theme.dim) + lead + R) + inline(l, theme)));
      continue;
    }
    for (const l of wrap(raw, w)) out.push(inline(l, theme));
  }
  return out;
}

// ---- Transcript ----------------------------------------------------------------------------------------------------
const hhmm = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()}`; };
export const elapsed = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

export function ago(iso, now = Date.now()) {
  const d = Date.parse(iso); if (!d) return '';
  const m = Math.floor((now - d) / 60000);
  if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`; if (m < 2880) return '昨天';
  return dayOf(iso);
}

export const msgKey = m => `${m.task_id || ''}|${m.at || ''}|${m.role}`;

// tools: running tool calls [{provider,name,summary}] shown under the "正在回复" line; reveal: {key, chars} types a fresh reply out.
// margin: blank cells kept at the left and right of the text so the transcript is not jammed against the window edge.
export function conversationLines(session, w, theme, { running = new Set(), now = Date.now(), tick = 0, tools = [], reveal = null, margin = 0 } = {}) {
  const out = []; let lastDay = '';
  const M = ' '.repeat(margin), inner = Math.max(10, w - 2 * margin - 2);
  const band = (text, first) => bgc(theme.band) + M + fgc(theme.accent) + (first ? '❯ ' : '  ') + fgc(theme.user) + mentions(pad(text, w - margin - 2), theme, fgc(theme.user)) + R;
  const msgs = session?.messages || [];
  // How long a task took: from its first user message to the last finished reply of that task.
  const started = new Map(), lastReply = new Map();
  for (const m of msgs) {
    if (m.role === 'user' && m.task_id && !started.has(m.task_id)) started.set(m.task_id, m.at);
    if (m.role === 'assistant' && m.task_id && !m.interim) lastReply.set(m.task_id, m);
  }
  for (const m of msgs) {
    if (!m.text && !m.attachments?.length) continue;
    const day = dayOf(m.at);
    if (day && day !== lastDay) { lastDay = day; out.push('', M + fgc(theme.dim) + `── ${day} ──` + R); }
    out.push('');
    if (m.role === 'user') {
      wrap(m.text || '', inner).forEach((l, i) => out.push(band(l, i === 0)));
      for (const a of m.attachments || []) out.push(band(`[${a.kind === 'file' ? '文件' : '图片'} ${a.name}]`, false));
    } else {
      const who = PROVIDERS[m.provider] ? m.provider : 'accent', name = PROVIDERS[m.provider] || '助手';
      const t0 = started.get(m.task_id), took = t0 && lastReply.get(m.task_id) === m ? Date.parse(m.at) - Date.parse(t0) : 0;
      out.push(M + color(theme, who, (GLYPH[who] || '●') + ' ') + BOLD + fgc(theme[who]) + name + R + '  ' + fgc(theme.dim) + hhmm(m.at) + (took >= 1500 ? ' · 用时 ' + elapsed(took) : '') + R);
      const typed = reveal && reveal.key === msgKey(m) ? [...(m.text || '')].slice(0, reveal.chars).join('') + '▍' : m.text || '';
      for (const l of renderMarkdown(typed, inner, theme)) out.push(M + '  ' + l);
      for (const a of m.attachments || []) out.push(M + '  ' + fgc(theme.dim) + `[${a.kind === 'file' ? '文件' : '图片'} ${a.name}]` + R);
    }
  }
  if (running.size) {
    const since = [...msgs].reverse().find(m => m.role === 'user')?.at;
    for (const p of running) {
      const who = PROVIDERS[p] ? p : 'accent';
      out.push('', M + color(theme, who, SPINNER[tick % 4] + ' ') + fgc(theme.dim) + ITAL + `${PROVIDERS[p] || p} 正在回复 · ${since ? elapsed(now - Date.parse(since)) : ''}` + R);
      for (const t of tools.filter(x => x.provider === p).slice(-2)) out.push(M + '  ' + fgc(theme.dim) + '↳ ' + R + fgc(theme[who]) + t.name + R + fgc(theme.dim) + (t.summary ? ' · ' + clip(t.summary, Math.max(8, inner - 4 - width(t.name))) : '') + R);
    }
  }
  return out;
}

// ---- Launchpad logo ------------------------------------------------------------------------------------------------
export const GLYPHS = {
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  I: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  C: ['.XXXX', 'X....', 'X....', 'X....', 'X....', 'X....', '.XXXX'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
};
// Two pixel rows per text row using half blocks.
function pixels(grid) {
  const out = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < grid[0].length; x++) {
      const t = grid[y][x], b = grid[y + 1]?.[x];
      if (!t && !b) line += ' ';
      else if (t && b && t.join() === b.join()) line += fgc(t) + '█' + R;
      else if (t && b) line += fgc(t) + bgc(b) + '▀' + R;
      else if (t) line += fgc(t) + '▀' + R;
      else line += fgc(b) + '▄' + R;
    }
    out.push(line);
  }
  return out;
}

function titlePixels(text, theme, scale = 1) {
  const grid = [];
  for (let y = 0; y < 7; y++) {
    const c = lerp(theme.accent, theme.warn, y / 6), row = [];
    for (const ch of text) row.push(...[...GLYPHS[ch][y], '.'].flatMap(p => Array(scale).fill(p === 'X' ? c : null)));
    for (let i = 0; i < scale; i++) grid.push(row);
  }
  return pixels(grid);
}

export function logoLines(theme, cols, { now = 0, maxRows = 16 } = {}) {
  const plain = BOLD + fgc(theme.accent) + 'PIRI OFFICE' + R;
  if (maxRows < 8 || cols < 30) return [plain];
  // The sprite is drawn at its native 64 px: no 2x2 shrink keeps the face (mean-shrinking smears it, picking pixels turns to noise).
  // Less height than the full 32 text rows shows a window on the head and shoulders instead; x 6..54 is all the art there is.
  const crop = maxRows >= 12 && cols >= 87, size = maxRows >= 16 && cols >= 84 ? 32 : maxRows >= 12 && cols >= 63 ? 24 : 16;
  const n = Math.min(64, 2 * maxRows), start = Math.max(0, Math.min(64 - n, 8 - Math.round((n - 32) / 4)));
  const sprite = pixels(crop ? mascotPixels(64, now).slice(start, start + n).map(r => r.slice(6, 54)) : mascotPixels(size, now)), sw = crop ? 48 : size;
  const title = sprite.length >= 12 && cols >= sw + 51
    ? [...titlePixels('PIRI', theme, 2), '', ...titlePixels('OFFICE', theme)]
    : sprite.length >= 9 && cols >= sw + 39 ? [...titlePixels('PIRI', theme), '', ...titlePixels('OFFICE', theme)] : [plain];
  const offset = Math.floor((sprite.length - title.length) / 2);
  const lines = sprite.map((s, y) => s + '   ' + (title[y - offset] || ''));
  const left = ' '.repeat(Math.max(0, Math.floor((cols - Math.max(...lines.map(width))) / 2)));
  return lines.map(s => left + s);
}

// ---- Rows ----------------------------------------------------------------------------------------------------------
export function sessionRow(s, w, theme, { selected, unread, running, meta = '' }) {
  const mark = running ? color(theme, 'accent', '◐') : unread ? color(theme, 'accent', '●') : s.pinned ? color(theme, 'dim', '▪') : ' ';
  const m = meta ? '  ' + meta : '';
  const room = Math.max(4, w - 3 - width(m));
  const title = clip(s.title || '未命名对话', room);
  const row = ` ${mark} ${title}${' '.repeat(Math.max(0, room - width(title)))}${fgc(theme.dim)}${m}${R}`;
  return selected ? REV + pad(strip2(row), w) + R : pad(row, w);
}
const strip2 = s => s.replace(/\x1b\[[0-9;]*m/g, '');

export const tagStyle = (theme, who, label) => bgc(theme[who] || theme.accent) + fgc(theme.tagFg) + BOLD + ` ${label} ` + R;

// ---- Visual blocks ---------------------------------------------------------------------------------------------------
const BARS = '▁▂▃▄▅▆▇█';
export function sparkline(values) {
  const max = Math.max(...values, 1);
  // sqrt scale: one huge day should not flatten every other day to the lowest bar
  return values.map(v => BARS[Math.min(7, Math.floor(Math.sqrt(v / max) * 7.999))]).join('');
}

// Rounded box with a title; rows are {mark, tone, text}. Returns ANSI lines exactly `w` cells wide.
export function box(title, rows, w, theme) {
  const inner = w - 4, dim = s => fgc(theme.dim) + s + R;
  const top = dim('╭─ ') + BOLD + fgc(theme.accent) + title + R + dim(' ' + '─'.repeat(Math.max(0, w - width(title) - 5)) + '╮');
  const body = rows.map(r => dim('│ ') + pad(fgc(theme[r.tone || 'dim']) + r.mark + R + ' ' + clip(r.text, inner - 2), inner) + dim(' │'));
  return [top, ...body, dim('╰' + '─'.repeat(w - 2) + '╯')];
}
