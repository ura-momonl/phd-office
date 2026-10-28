import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import asset from './assets/mascot.json' with { type: 'json' };
import { mascotFrame, mascotPixels, MASCOT_FRAME_MS, MASCOT_FRAMES } from './mascot.mjs';
import { logoLines, THEMES } from './view.mjs';
import { createApp, drawFrame } from './app.mjs';
import { width, strip } from './text.mjs';

test('latest user sheet is preserved; nine row-major frames loop slowly', () => {
  const png = fs.readFileSync(new URL('./assets/mascot-sheet.png', import.meta.url));
  assert.equal(crypto.createHash('sha256').update(png).digest('hex'), 'c60cf7b042c4939c9e28e9784d8fd047437b325236c457c7c7f475e30061abda');
  assert.equal(MASCOT_FRAMES, 9);
  assert.equal(MASCOT_FRAME_MS, 500);
  assert.equal(new Set(asset.frames).size, 9);
  for (let i = 0; i < 9; i++) {
    assert.equal(Buffer.from(asset.frames[i], 'base64').length, 4096);
    assert.equal(mascotFrame(i * 500), i);
    assert.equal(mascotFrame(i * 500 + 499), i);
  }
  assert.equal(mascotFrame(4500), 0);
});

test('all rendered frames fit, preserve transparency and are stable inside each half second', () => {
  for (const theme of Object.values(THEMES)) for (const [cols, maxRows, size] of [[100, 16, 32], [70, 12, 24], [40, 8, 16]]) {
    const variants = [];
    for (let i = 0; i < 9; i++) {
      const grid = mascotPixels(size, i * 500);
      assert.equal(grid.length, size);
      assert.ok(grid.every(row => row.length === size));
      assert.equal(grid[0][0], null);
      assert.ok(grid.flat().some(p => p && p.every(Number.isFinite)));
      const lines = logoLines(theme, cols, { maxRows, now: i * 500 });
      assert.ok(lines.length <= maxRows);
      assert.ok(lines.every(l => width(l) <= cols));
      assert.deepEqual(lines, logoLines(theme, cols, { maxRows, now: i * 500 + 499 }));
      variants.push(lines.join('\n'));
    }
    assert.ok(new Set(variants).size > 1, 'animation changes even when idle');
  }
});

test('home animation changes with time while drafts, caret and capacity remain usable at small heights', () => {
  for (const [cols, rows] of [[110, 30], [70, 24], [60, 20], [40, 12], [100, 16]]) {
    const app = createApp({ cols, rows }); app.input = '中文草稿 a 😀 '.repeat(10); app.cursor = 4; app.now = 0;
    const initial = app.input;
    const a = drawFrame(app), caret = [...app.cursorXY], hits = structuredClone(app.hits);
    app.now = 1500; const b = drawFrame(app);
    assert.equal(app.input, initial); assert.deepEqual(app.cursorXY, caret); assert.deepEqual(app.hits, hits);
    assert.equal(b.length, rows); assert.ok(b.every(l => width(l) <= cols));
    assert.ok(app.hits.filter(h => h.act.type === 'input').every(h => h.y < rows));
    assert.match(b.map(strip).join('\n'), /Claude 剩余/);
    assert.ok(app.cursorXY[0] < rows);
    if (rows === 30) assert.notDeepEqual(a, b);
  }
});

test('CRT pass keeps geometry, protects typing rows, is deterministic and switchable', async () => {
  const { crtFrame } = await import('./crt.mjs');
  const { crtLines } = await import('./app.mjs');
  for (const [cols, rows, screen] of [[110, 30, 'home'], [60, 20, 'home'], [40, 12, 'home'], [100, 30, 'chat']]) {
    const app = createApp({ cols, rows }); app.screen = screen; app.input = '中文草稿 a 😀'; app.cursor = 2; app.now = 12345;
    const raw = drawFrame(app), fx = crtLines(app, raw);
    assert.equal(fx.length, rows);
    assert.ok(fx.every(l => width(l) <= cols), 'rows fit the screen width');
    if (screen !== 'home') assert.deepEqual(fx, raw, 'non-home screens have no CRT treatment');
    assert.deepEqual(fx, crtLines(app, raw), 'same time, same picture');
    raw.forEach((line, y) => { const a = [...strip(line)], b = [...strip(fx[y])]; a.forEach((ch, i) => { if (ch !== ' ') assert.equal(b[i], ch === '█' ? '▀' : ch, `row ${y} col ${i}`); }); }); // static only lands on empty cells; full blocks become half blocks for the pixel scanline
    app.crt = false; assert.deepEqual(crtLines(app, raw), raw);
  }
  // power-on: collapsed rows are blank, fully open equals the normal frame
  const app = createApp({ cols: 80, rows: 24 }); app.now = 5000; app.crtBoot = 5000;
  const boot = crtLines(app, drawFrame(app)); assert.ok(boot.slice(0, 4).every(l => !strip(l).trim()));
  // glitch and boot windows never break wide characters or row width
  for (let t = 0; t < 40000; t += 137) { app.crtBoot = null; app.now = t; assert.ok(crtLines(app, drawFrame(app)).every(l => width(l) === 80)); }
});

test('the sprite is drawn at native 64 px as a window on the head when height is short', () => {
  for (const [cols, maxRows] of [[130, 32], [110, 26], [100, 16], [90, 12]]) {
    const lines = logoLines(THEMES.clay, cols, { maxRows, now: 0 });
    assert.equal(lines.length, maxRows >= 32 ? 32 : maxRows);
    assert.ok(lines.every(l => width(l) <= cols));
  }
  assert.ok(logoLines(THEMES.clay, 80, { maxRows: 16, now: 0 }).length <= 16); // narrow: old shrunken sprite
});

test('sixel path: terminal replies are parsed, hero picture round-trips through the encoder and fits its cells', async () => {
  const { createKeyParser } = await import('./keys.mjs');
  const { encodeSixel } = await import('./sixel.mjs');
  const { heroLayout, renderHero, timeState } = await import('./hero.mjs');
  const keys = []; const feed = createKeyParser(k => keys.push(k));
  feed('\x1b[?61;4;6;7c\x1b[6;20;10t'); feed('\x1b[?62;'); feed('1;4c');
  assert.deepEqual(keys, [{ key: 'da1', params: [61, 4, 6, 7] }, { key: 'cellsize', h: 20, w: 10 }, { key: 'da1', params: [62, 1, 4] }]);
  assert.equal(heroLayout({ cols: 40, maxRows: 5, cw: 10, ch: 20 }), null);
  for (const [cols, maxRows] of [[120, 23], [100, 16], [90, 12]]) {
    const L = heroLayout({ cols, maxRows, cw: 10, ch: 20 });
    if (!L) continue;
    assert.ok(L.cellsW <= cols - 2 && L.cellsH <= maxRows && L.W === L.cellsW * 10 && L.H === L.cellsH * 20);
    const px = renderHero(L, { now: 3300, themeKey: 'clay', theme: THEMES.clay }), six = encodeSixel(px, L.W, L.H);
    assert.equal(px.length, L.W * L.H * 3);
    // minimal sixel decode: palette + bands -> index per pixel; every pixel must be painted and close to the source colour
    const body = six.slice(six.indexOf('"') + 1, -2), pal = {}, [, , , w, h] = /^(\d+);(\d+);(\d+);(\d+)/.exec(body).map(Number);
    assert.equal(w, L.W); assert.equal(h, L.H);
    let cur = 0, x = 0, band = 0, painted = new Uint8Array(w * Math.ceil(h / 6) * 6), err = 0;
    for (const m of body.slice(body.indexOf('#')).matchAll(/#(\d+);2;(\d+);(\d+);(\d+)|#(\d+)|!(\d+)(.)|(\$)|(-)|([?-~])/g)) {
      if (m[1] !== undefined) pal[m[1]] = [m[2], m[3], m[4]].map(v => v * 2.55);
      else if (m[5] !== undefined) cur = Number(m[5]);
      else if (m[8]) x = 0; else if (m[9]) { x = 0; band++; }
      else { const n = m[6] ? Number(m[6]) : 1, bits = (m[7] || m[10]).charCodeAt(0) - 63; for (let i = 0; i < n; i++, x++) for (let k = 0; k < 6; k++) if (bits >> k & 1) { const y = band * 6 + k, o = y * w + x; painted[o] = 1; if (y < h) for (let c = 0; c < 3; c++) err += Math.abs(pal[cur][c] - px[o * 3 + c]) / (w * h * 3); } }
    }
    assert.ok(painted.subarray(0, w * h).every(Boolean), 'every pixel painted');
    assert.ok(err < 6, 'mean colour error of the 96-colour palette: ' + err);
  }
  assert.notEqual(timeState(0).key, timeState(500).key); // sprite frame advances
  assert.equal(timeState(1234, false).key, timeState(1234 + 100, false).key); // effects off: only the frame matters
});
