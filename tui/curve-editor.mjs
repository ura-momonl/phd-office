import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import asset from './assets/mascot.json' with { type: 'json' };
import { BROWN_CURVES, curvePalette, fullRangeCurves } from './curves.mjs';
import { renderHero, heroLayout } from './hero.mjs';
import { THEMES } from './view.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CURVE_SELECTION = path.resolve(here, '../.runtime/tui-curves/selection.json');

export function createCurveEditor({ saveFile = CURVE_SELECTION, token = randomUUID() } = {}) {
  const L = heroLayout({ cols: 100, maxRows: 24, cw: 10, ch: 20 });
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: '仅允许本机调节页访问' });
      if (req.method === 'GET') {
        if (req.url === '/') return send(200, fs.readFileSync(path.join(here, 'curve-editor.html'), 'utf8'), 'text/html; charset=utf-8');
        if (req.url === '/curves.mjs') return send(200, fs.readFileSync(path.join(here, 'curves.mjs'), 'utf8'), 'text/javascript; charset=utf-8');
        if (req.url === '/asset') return send(200, asset);
        if (req.url === '/state') {
          const saved = fs.existsSync(saveFile) ? JSON.parse(fs.readFileSync(saveFile, 'utf8')) : null;
          return send(200, { token, curves: saved ? fullRangeCurves(saved.curves) : BROWN_CURVES, saveFile, savedAt: saved?.savedAt || null });
        }
        return send(404, { error: 'Not found' });
      }
      if (req.method !== 'POST' || !['/save', '/preview'].includes(req.url)) return send(404, { error: 'Not found' });
      if (req.headers['x-curve-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '请从调节页提交' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(413, { error: '参数过大' }); }
      const value = JSON.parse(body), curves = fullRangeCurves(value.curves);
      if (req.url === '/save') {
        const selection = { version: 2, interpolation: 'monotone-cubic', mode: 'max-channel-rgb-offset', highlightLock: null, curves, savedAt: new Date().toISOString() };
        fs.mkdirSync(path.dirname(saveFile), { recursive: true });
        fs.writeFileSync(saveFile, JSON.stringify(selection, null, 2) + '\n', 'utf8');
        return send(200, { savedAt: selection.savedAt, saveFile });
      }
      // The actual TUI renderer, with only the sprite palette substituted. No
      // live settings are changed; the title, background and CRT remain intact.
      const frame = value.frame ?? 3;
      if (!Number.isInteger(frame) || frame < 0 || frame >= asset.frames.length) throw new Error('动画帧无效');
      const pixels = renderHero(L, { now: frame * asset.frame_ms, themeKey: 'clay', theme: THEMES.clay, effects: value.effects !== false, palette: curvePalette(asset.palette, curves) });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Width': L.W, 'X-Height': L.H });
      res.end(pixels);
    } catch (e) { if (!res.headersSent) send(400, { error: e.message }); else res.end(); }
  });
  return server;
}

export async function startCurveEditor({ port = 23487 } = {}) {
  // A local restart can retain the open page's token, so unsaved edits can still
  // be saved before the user refreshes. It is never written to logs or settings.
  const server = createCurveEditor({ token: process.env.PIRI_CURVE_EDITOR_TOKEN });
  delete process.env.PIRI_CURVE_EDITOR_TOKEN;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const info = { url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, saveFile: CURVE_SELECTION };
  const infoFile = path.join(path.dirname(CURVE_SELECTION), 'editor.json');
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2) + '\n');
  console.log(JSON.stringify(info));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startCurveEditor();
