import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp, applyState, onKey, submit, refresh } from './app.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const state = { agent: { sessions: [{ id: 's1', title: 'Send fixture', task_ids: [], messages: [] }] } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = body => ({ ok: true, json: async () => body });
const appWithDraft = () => {
  const app = createApp({ cols: 110, rows: 30, prefs: { session: 's1' } });
  applyState(app, state); app.screen = 'chat'; app.input = '原始消息'; app.cursor = app.input.length;
  return app;
};

test('failed send restores the original draft, or keeps newer typing and retains the original in history', async () => {
  const real = globalThis.fetch;
  try {
    for (const newerDraft of ['', '新草稿']) {
      const gate = deferred(), app = appWithDraft();
      globalThis.fetch = () => gate.promise;
      const done = submit(app);
      if (newerDraft) await onKey(app, { key: 'paste', text: newerDraft });
      gate.reject(new Error('offline')); await done;
      assert.equal(app.input, newerDraft || '原始消息');
      assert.equal(app.cursor, app.input.length);
      assert.equal(app.sending, false);
      assert.match(app.error, /发送失败：offline/);
      assert.deepEqual(app.history, ['原始消息']);
      if (newerDraft) {
        assert.match(app.error, /Ctrl\+P/);
        await onKey(app, { key: 'char', ch: 'p', ctrl: true });
        assert.equal(app.input, '原始消息');
        await onKey(app, { key: 'char', ch: 'z', ctrl: true });
        assert.equal(app.input, newerDraft, 'history retrieval does not lose the newer draft');
      }
    }
  } finally { globalThis.fetch = real; }
});

test('late send results do not switch back after the user starts a new conversation', async () => {
  const real = globalThis.fetch;
  try {
    for (const fresh of [false, true]) for (const failed of [false, true]) {
      const app = appWithDraft(), gate = deferred();
      if (fresh) { app.sessionId = null; app.screen = 'home'; }
      globalThis.fetch = () => gate.promise;
      const done = submit(app);
      await onKey(app, { key: 'char', ch: 'n', ctrl: true });
      await onKey(app, { key: 'paste', text: '另一个对话的草稿' });
      if (failed) gate.reject(new Error('offline')); else gate.resolve(response({ session_id: 'sent-session' }));
      await done;
      assert.equal(app.sessionId, null);
      assert.equal(app.screen, 'home');
      assert.equal(app.input, '另一个对话的草稿');
      assert.equal(app.sending, false);
    }
  } finally { globalThis.fetch = real; }
});

test('successful send keeps a newly selected answerer and the scroll position changed during the wait', async () => {
  const real = globalThis.fetch, gate = deferred(), app = appWithDraft();
  app.target = 'Codex';
  globalThis.fetch = url => String(url).endsWith('/api/chat') ? gate.promise : Promise.resolve(response(state));
  try {
    const done = submit(app);
    await onKey(app, { key: 'char', ch: '1', alt: true });
    app.scroll = 5;
    gate.resolve(response({ session_id: 's1', delivery: 'queued' })); await done;
    assert.equal(app.target, 'Claude');
    assert.equal(app.scroll, 5);
    assert.match(app.notice, /已排队/);
  } finally { globalThis.fetch = real; }
});

test('an old state response cannot discard a newer conversation or its draft', async () => {
  const real = globalThis.fetch, gate = deferred(), app = appWithDraft();
  globalThis.fetch = () => gate.promise;
  try {
    const done = refresh(app);
    await onKey(app, { key: 'char', ch: 'n', ctrl: true });
    app.sessionId = 'new-session'; app.screen = 'chat'; app.input = '新会话草稿';
    gate.resolve(response(state)); await done;
    assert.equal(app.sessionId, 'new-session');
    assert.equal(app.screen, 'chat');
    assert.equal(app.input, '新会话草稿');
  } finally { globalThis.fetch = real; }
});

test('TUI runtime paints typing and wheel input before delayed HTTP send and state responses finish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-send-'));
  try {
    const fixture = path.join(dir, 'fixture.mjs'), result = path.join(dir, 'result.json');
    fs.writeFileSync(fixture, `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import ${JSON.stringify(new URL('../scripts/safe-ports.mjs', import.meta.url).href)};
      import { run } from ${JSON.stringify(new URL('./app.mjs', import.meta.url).href)};
      process.env.PHD_TUI_NO_PREFS = '1'; process.env.WT_SESSION = 'fixture';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'columns', { value: 110 });
      Object.defineProperty(process.stdout, 'rows', { value: 26 });
      process.stdin.setRawMode = () => {};
      let phase = 'start', posts = 0, statePending = false, releaseSend, releaseState;
      const writes = [], bodies = [];
      process.stdout.write = text => { writes.push({ phase, text: String(text) }); return true; };
      const session = { id: 's1', title: 'Send fixture', task_ids: [], messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', text: 'Transcript row ' + i })) };
      const state = { agent: { sessions: [session], active_turns: [] } };
      const server = createServer(async (req, res) => {
        if (req.url === '/api/chat') {
          posts++; let body = ''; for await (const chunk of req) body += chunk;
          bodies.push(JSON.parse(body));
          await new Promise(resolve => { releaseSend = resolve; });
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ session_id: 's1' })); return;
        }
        if (posts && req.url.startsWith('/api/state')) {
          statePending = true; await new Promise(resolve => { releaseState = resolve; });
          session.messages.push({ role: 'user', text: 'ORIGINAL' });
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.PHD_DASHBOARD_PORT = String(server.address().port);
      const wait = async pred => { const until = Date.now() + 3000; while (!pred()) { assert.ok(Date.now() < until, 'timed out in phase ' + phase); await new Promise(r => setTimeout(r, 10)); } };
      const painted = text => writes.some(w => w.phase === phase && w.text.includes(text));
      const input = text => process.stdin.emit('data', text);
      run('start');
      await wait(() => writes.some(w => /\\x1b\\[\\d+;\\d+H/.test(w.text)));
      phase = 'open'; input('\\x0b\\x1b[B\\r'); await wait(() => painted('Send fixture'));
      phase = 'sending'; input('ORIGINAL\\r'); await wait(() => releaseSend && painted('发送中'));
      phase = 'typing-before-send'; input('NEXT_DRAFT'); await wait(() => painted('NEXT_DRAFT'));
      phase = 'wheel-before-send'; input('\\x1b[<64;10;5M'); await wait(() => painted('回到底部'));
      phase = 'repeat-enter'; input('\\r'); await wait(() => painted('草稿已保留')); assert.equal(posts, 1);
      phase = 'refresh'; releaseSend(); await wait(() => statePending);
      phase = 'typing-before-state'; input('+'); await wait(() => painted('NEXT_DRAFT+'));
      phase = 'done'; input('\\x1b[F'); releaseState(); await wait(() => painted('ORIGINAL'));
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ writes, posts, bodies }));
      process.emit('tui-quit');
    `);
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || String(child.error || 'runtime fixture failed'));
    const evidence = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(evidence.posts, 1);
    assert.equal(evidence.bodies[0].text, 'ORIGINAL');
    assert.equal(evidence.bodies[0].session_id, 's1');
    for (const phase of ['sending', 'typing-before-send', 'wheel-before-send', 'repeat-enter', 'typing-before-state', 'done']) {
      assert.ok(evidence.writes.some(w => w.phase === phase), phase + ' produced terminal output');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
