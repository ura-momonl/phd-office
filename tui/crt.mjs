// Animal Well style CRT, applied to a finished frame: pure function of (lines, time), no I/O.
// The picture stays readable: a deep dark ground, light that blooms softly around bright pixels, faint pixel scanlines,
// a soft vignette, a slow brightness roll and rare flicker/wobble. Only home uses this pass;
// other screens bypass it in app.mjs. Cells resolve to explicit colours independent of the terminal background.
import { cw } from './text.mjs';

export const CRT_BG = { clay: [27, 25, 23], night: [15, 18, 29], paper: [242, 234, 218] };
const SGR = /\x1b\[([0-9;:]*)m/g;
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const mul = (c, k) => c.map(v => clamp(v * k));
const toward = (c, t, k) => c.map((v, i) => clamp(v + (t[i] - v) * k));
// Stable pseudo-random in [0,1) from integers (no state, so snapshots are reproducible).
const hash = (a, b = 0, c = 0) => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return ((h >>> 0) % 100000) / 100000; };

// Frame line -> cells [{ch, w, fg, bg, bold, ital}], following the SGR state across the line.
function parse(line, defFg, defBg) {
  const cells = []; let fg = null, bg = null, bold = false, ital = false, rev = false, last = 0, m;
  const text = part => {
    for (const ch of part) {
      const w = cw(ch.codePointAt(0));
      if (w === 0 && cells.length) { cells.at(-1).ch += ch; continue; }
      const f = fg || defFg, b = bg || defBg;
      cells.push({ ch, w: Math.max(1, w), fg: rev ? b : f, bg: rev ? f : b, bold, ital });
    }
  };
  SGR.lastIndex = 0;
  while ((m = SGR.exec(line))) {
    text(line.slice(last, m.index)); last = SGR.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = null; bold = ital = rev = false; }
      else if (c === 1) bold = true; else if (c === 22) bold = false;
      else if (c === 3) ital = true; else if (c === 23) ital = false;
      else if (c === 7) rev = true; else if (c === 27) rev = false;
      else if (c === 39) fg = null; else if (c === 49) bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const rgb = codes.slice(i + 2, i + 5).map(v => v | 0); if (c === 38) fg = rgb; else bg = rgb; i += 4; }
    }
  }
  text(line.slice(last));
  return cells;
}

function emit(cells) {
  let out = '', pf = '', pb = '', pbold = false, pital = false;
  for (const c of cells) {
    const f = `38;2;${c.fg.join(';')}`, b = `48;2;${c.bg.join(';')}`, codes = [];
    if (f !== pf) { codes.push(f); pf = f; }
    if (b !== pb) { codes.push(b); pb = b; }
    if (c.bold !== pbold) { codes.push(c.bold ? 1 : 22); pbold = c.bold; }
    if (c.ital !== pital) { codes.push(c.ital ? 3 : 23); pital = c.ital; }
    out += (codes.length ? `\x1b[${codes.join(';')}m` : '') + c.ch;
  }
  return out + '\x1b[0m';
}

const blank = bg => ({ ch: ' ', w: 1, fg: bg, bg, bold: false, ital: false });
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const HW = [1, 0.55, 0.3, 0.14], VW = [1, 0.5, 0.2]; // bloom kernel: wider than tall, since a cell is about twice as tall as wide

// opts: now (ms), theme key/colours, full (bool), protect (Set of 0-based rows left plain: input box, status bar), boot (ms since start)
export function crtFrame(lines, cols, { now = 0, themeKey = 'clay', theme, full = true, protect = new Set(), boot = Infinity } = {}) {
  const rows = lines.length, bg0 = CRT_BG[themeKey], light = bg0[0] > 128;
  const defFg = theme?.user || [220, 214, 204];
  const sec = now / 1000, half = rows / 2;

  // Brightness steps: constant most of the time, with a short faint dip every few seconds.
  const slot = Math.floor(sec / 4.1), dip = sec - slot * 4.1 - hash(slot, 1) * 3.4;
  const flick = dip >= 0 && dip < 0.12 ? 0.93 : 1;
  const barRow = Math.floor((sec % 11) / 11 * (rows + 10)) - 5; // slow brightness roll, one row at a time
  const gSlot = Math.floor(sec / 8.7), gOn = sec - gSlot * 8.7 - hash(gSlot, 2) * 7.5; // rare one-row wobble
  const glitch = full && gOn >= 0 && gOn < 0.14 ? { row: 2 + Math.floor(hash(gSlot, 3) * Math.max(1, rows - 6)), dx: hash(gSlot, 4) < 0.5 ? -1 : 1 } : null;
  const open = boot < 520 ? Math.pow(boot / 520, 2) * half : Infinity; // power-on: a bright line opens from the middle

  // 1. Cells on a column grid (the second column of a wide character is null).
  const grid = lines.map((line, y) => {
    const cells = parse(line, defFg, bg0), row = [];
    for (const c of cells) { row.push(c); for (let i = 1; i < c.w; i++) row.push(null); }
    while (row.length < cols) row.push(blank(bg0));
    return row.slice(0, cols);
  });
  const hidden = y => !protect.has(y) && Math.abs(y + 0.5 - half) > open;

  // 2. Bloom: light that spills from bright pixels into the dark around them.
  const E = grid.map((row, y) => row.map(c => {
    if (!c || protect.has(y) || hidden(y) || c.ch === ' ') return null;
    const lit = [c.fg, c.bg].filter(v => !same(v, bg0)), solid = '▀▄█'.includes(c.ch);
    if (!lit.length) return null;
    if (!solid) return same(c.fg, bg0) ? null : c.fg.map(v => v * 0.3);
    const a = c.ch === '█' ? c.fg : lit.reduce((s, v) => s.map((k, i) => k + v[i] / lit.length), [0, 0, 0]);
    return a.map(v => v * (c.ch === '█' ? 1 : lit.length / 2));
  }));
  const H = E.map(row => row.map((_, x) => { const s = [0, 0, 0]; for (let k = -3; k <= 3; k++) { const e = row[x + k]; if (e) for (let i = 0; i < 3; i++) s[i] += e[i] * HW[Math.abs(k)]; } return s; }));
  const glow = H.map((row, y) => row.map((_, x) => { const s = [0, 0, 0]; for (let k = -2; k <= 2; k++) { const h = H[y + k]?.[x]; if (h) for (let i = 0; i < 3; i++) s[i] += h[i] * VW[Math.abs(k)]; } return s; }));
  const lift = (bg, g, k) => bg.map((v, i) => clamp(v + Math.min(34, g[i] * k)));


  const out = [];
  for (let y = 0; y < rows; y++) {
    if (hidden(y)) { out.push(emit(Array.from({ length: cols }, () => blank(mul(bg0, 0.6))))); continue; }
    const plain = protect.has(y), dist = Math.abs(y + 0.5 - half), edgeY = Math.pow(dist / half, 2);
    const bar = Math.max(0, 1 - Math.abs(y - barRow - 1.5) / 3.5);
    const rowK = plain ? 1 : flick * (open !== Infinity && dist > open - 1.4 ? 1.7 : 1) * (1 + (light ? -0.04 : 0.05) * bar);
    let next = [];
    for (let x = 0; x < cols; x++) {
      const src = grid[y][x]; if (!src) continue;
      const c = { ...src };
      if (plain) { next.push(c); continue; }
      let fg = c.fg, bg = c.bg;
      const ground = same(bg, bg0); // the plain background is never dimmed or banded: one flat colour edge to edge
      if (full) {
        const edgeX = Math.pow(Math.abs(x + c.w / 2 - cols / 2) / (cols / 2), 2), vig = 1 - 0.2 * Math.min(1, (edgeX + edgeY) * 0.75);
        const g = glow[y][x], lightBg = !light && same(bg, bg0);
        if (!light && g) { if (lightBg) bg = lift(bg, g, 0.022); if (c.ch === ' ') fg = bg; else if (same(fg, bg0)) fg = lift(fg, g, 0.022); }
        // Faint pixel scanline: the lower pixel row of each half-block cell, only where there is picture.
        if (c.ch === '▀') bg = same(bg, bg0) ? bg : mul(bg, 0.93);
        else if (c.ch === '▄') fg = mul(fg, 0.93);
        else if (c.ch === '█') { c.ch = '▀'; bg = mul(fg, 0.93); }
        fg = mul(fg, vig); if (!ground) bg = mul(bg, vig);
      }
      c.fg = mul(fg, rowK); c.bg = ground ? bg : mul(bg, rowK);
      next.push(c);
    }
    if (glitch && !plain && y === glitch.row) { // clip at the screen edge; a wide character cut in half becomes a blank
      const flat = next.flatMap(c => [c, ...Array(c.w - 1).fill(null)]), b = blank(bg0);
      const shifted = (glitch.dx > 0 ? [b, ...flat] : [...flat.slice(1), b]).slice(0, cols);
      next = []; let wide = false;
      shifted.forEach((c, j) => { if (c) { next.push(c.w === 2 && shifted[j + 1] !== null ? b : c); wide = c.w === 2; } else { if (!wide) next.push(b); wide = false; } });
    }
    out.push(emit(next));
  }
  return out;
}
