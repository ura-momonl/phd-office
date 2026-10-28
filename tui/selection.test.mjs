import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyParser } from './keys.mjs';
import { createApp, drawFrame, crtLines, onKey, MOUSE_ON } from './app.mjs';
import { selectionText, selectionFrame } from './selection.mjs';
import { strip, width } from './text.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const appFor = (screen = 'chat') => {
  const app = createApp({ cols: 100, rows: 26, prefs: { crt: true } });
  const session = { id: 'fixture', title: 'Selection fixture', task_ids: [], messages: [
    { role: 'assistant', provider: 'codex', text: Array.from({ length: 35 }, (_, i) => `Line ${i}: alpha 中文😀 e\u0301 omega`).join('\n'), at: '2026-10-23T12:00:00Z' },
  ] };
  app.sessions = [session]; app.sessionId = session.id; app.detail = session; app.screen = screen;
  app.input = 'ab中文😀cd'; app.cursor = app.input.length;
  if (screen === 'sessions') app.sw = { q: '', rail: 0, focus: 'list', sel: 0, extra: [] };
  if (screen === 'call') { app.callView = { i: 0, scroll: 0 }; app.callsRaw = [{ name: 'Read', input: 'alpha 中文😀', output: 'fixture', status: '完成' }]; }
  drawFrame(app); return app;
};
const mouse = (app, x, y, extra = {}) => onKey(app, { key: 'mouse', mouse: { x, y, button: 0, down: true, wheel: null, ...extra } });
const rawMouse = async (app, chunks) => {
  let queue = Promise.resolve();
  const feed = createKeyParser(k => { queue = queue.then(() => onKey(app, k)); });
  for (const chunk of chunks) feed(chunk);
  await queue;
};

test('button-event mode requests drags; SGR and X10 preserve drag and release, ignore hover', () => {
  assert.match(MOUSE_ON, /\[\?1002h/);
  for (const chunks of [['\x1b[<32;9;', '5M\x1b[<0;9;5m\x1b[<35;9;5M'], ['\x1b[M', String.fromCharCode(64, 41, 37), '\x1b[M' + String.fromCharCode(35, 41, 37)]]) {
    const events = []; const feed = createKeyParser(k => events.push(k)); chunks.forEach(feed);
    assert.equal(events.length, 2); assert.equal(events[0].mouse.motion, true); assert.equal(events[1].mouse.down, false);
  }
});

test('selection is cell-based, inclusive, reversible and Unicode-safe across ANSI resets and lines', () => {
  const s = { frame: ['ab\x1b[31m中\x1b[0m文😀e\u0301 end', 'next line   '], anchor: { x: 4, y: 1 }, end: { x: 4, y: 2 }, dragged: true };
  assert.equal(selectionText(s), '中文😀e\u0301 end\nnext');
  assert.equal(selectionText({ ...s, anchor: s.end, end: s.anchor }), selectionText(s));
  const frame = selectionFrame(s);
  assert.deepEqual(frame.map(strip), s.frame.map(strip));
  assert.match(frame[0], /\x1b\[0m\x1b\[7m文/);
  assert.deepEqual(frame.map(width), s.frame.map(width));
  assert.equal(selectionText({ ...s, anchor: { x: 8, y: 1 }, end: { x: 8, y: 1 } }), '😀');
});

test('raw drag selects the displayed reply, survives streaming and copies only that region without quitting', async () => {
  const app = appFor(); const displayed = drawFrame(app), y = displayed.findIndex(l => strip(l).includes('alpha 中文')) + 1;
  assert.ok(y > 0);
  const x = width(strip(displayed[y - 1]).split('alpha')[0]) + 1;
  await rawMouse(app, [`\x1b[<0;${x};${y}M`, `\x1b[<32;${x + 9};`, `${y}M`, `\x1b[<0;${x + 9};${y}m`]);
  assert.equal(selectionText(app.selection), 'alpha 中文');
  app.detail = { ...app.detail, messages: [{ role: 'assistant', provider: 'codex', text: 'new streaming reply' }] };
  app.now += 5000;
  assert.deepEqual(crtLines(app, drawFrame(app)).map(strip), displayed.map(strip));
  let quit = false; const listener = () => { quit = true; }; process.once('tui-quit', listener);
  const copied = []; app.writeClipboard = text => copied.push(text);
  try { await onKey(app, { key: 'char', ctrl: true, ch: 'c' }); } finally { process.removeListener('tui-quit', listener); }
  assert.deepEqual(copied, ['alpha 中文']); assert.equal(quit, false); assert.equal(app.selection, null);
  assert.match(drawFrame(app).map(strip).join('\n'), /new streaming reply/);
});

test('input clicks still place the caret and insert; dragging does not move it repeatedly; wheel still scrolls', async () => {
  const app = appFor(); const hit = app.hits.find(h => h.act.type === 'input');
  await mouse(app, hit.x0 + 2, hit.y); await mouse(app, hit.x0 + 2, hit.y, { down: false });
  assert.equal(app.cursor, 2); assert.equal(app.selection, null);
  await onKey(app, { key: 'char', ch: '插' }); assert.equal(app.input, 'ab插中文😀cd');
  drawFrame(app);
  await mouse(app, hit.x0 + 2, hit.y); const cursor = app.cursor;
  await mouse(app, hit.x0 + 7, hit.y, { motion: true }); await mouse(app, hit.x0 + 7, hit.y, { down: false });
  assert.equal(app.cursor, cursor); assert.equal(selectionText(app.selection), '插中文');
  await mouse(app, 10, 5, { wheel: 'up' }); assert.equal(app.selection, null); assert.equal(app.scroll, 3);
  drawFrame(app); assert.match(app.frame.map(strip).join('\n'), /回到底部/);
  await mouse(app, 10, 5, { wheel: 'down' }); assert.equal(app.scroll, 0);
});

test('no-motion release can finish a fast drag, and X10 release cannot activate a dragged link', async () => {
  const app = appFor(); const hit = app.hits.find(h => h.act.type === 'sessions');
  await mouse(app, hit.x0, hit.y);
  await mouse(app, hit.x0 + 8, hit.y, { down: false, button: 3 });
  assert.equal(app.screen, 'chat'); assert.equal(app.selection.dragged, true);
  await onKey(app, { key: 'escape' }); assert.equal(app.selection, null); assert.equal(app.screen, 'chat');
  drawFrame(app);
  await mouse(app, hit.x0, hit.y); assert.equal(app.screen, 'chat');
  await mouse(app, hit.x0, hit.y, { down: false }); assert.equal(app.screen, 'sessions');
});

test('all screens support selection, non-Windows OSC52 stays UTF-8, copy failures retain selection', async () => {
  for (const screen of ['home', 'chat', 'sessions', 'call']) {
    const app = appFor(screen), frame = drawFrame(app);
    await mouse(app, 1, 1); await mouse(app, 10, 1, { motion: true }); await mouse(app, 10, 1, { down: false });
    assert.deepEqual(drawFrame(app).map(strip), frame.map(strip));
    const text = selectionText(app.selection);
    app.writeClipboard = () => { throw new Error('clipboard busy'); };
    await onKey(app, { key: 'char', ctrl: true, ch: 'c' }); assert.match(app.error, /clipboard busy/); assert.ok(app.selection);
    delete app.writeClipboard; await onKey(app, { key: 'char', ctrl: true, ch: 'c' });
    assert.equal(Buffer.from(app.osc.split(';')[2].slice(0, -1), 'base64').toString('utf8'), text);
  }
});
