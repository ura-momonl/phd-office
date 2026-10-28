import test from 'node:test';
import assert from 'node:assert/strict';
import { strip } from './text.mjs';
import { createApp, applyState, drawFrame, submit, launchFolder, openSession, onKey } from './app.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const OFFICE = 'D:/Main/assistant', DL = 'D:/Users/me/Downloads';
const state = {
  agent_read_at: {},
  agent: { active_turns: [], executions: [], sessions: [{ id: 's1', title: '当前对话', workdir: DL, last_at: '2026-10-22T10:00:00Z', task_ids: ['t1'], messages: [{ role: 'user', text: '你好', at: '2026-10-22T09:00:00Z' }] }] },
};
const withFetch = async (handler, fn) => {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, opt = {}) => { seen.push({ url: String(url), body: opt.body ? JSON.parse(opt.body) : null }); return { ok: true, status: 200, json: async () => handler(String(url)) }; };
  try { await fn(seen); } finally { globalThis.fetch = real; }
};

test('the folder the TUI starts in: none for the office folder itself (any spelling), the folder otherwise', () => {
  assert.equal(launchFolder('D:/Main/assistant', OFFICE), null);
  assert.equal(launchFolder('d:/main/assistant/', OFFICE), null);
  assert.equal(launchFolder('D:/Main/assistant/tui', OFFICE) !== null, true);
  assert.equal(launchFolder(DL, OFFICE).replace(/\\/g, '/'), DL);
});

test('Windows launcher directories are not project folders, including mixed case and nested system directories', () => {
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows) return;
  for (const cwd of [windows, `${windows}/System32`, `${windows}/sYsTeM32/WindowsPowerShell/v1.0/`, `${windows}/SysWOW64`]) {
    assert.equal(launchFolder(cwd, OFFICE), null, cwd);
  }
  assert.notEqual(launchFolder(`${windows}-research`, OFFICE), null);
});

test('home names the folder; a new conversation carries it; later messages do not; the header shows it', async () => {
  const app = createApp({ cols: 130, rows: 34, prefs: { session: 's1' }, launchDir: DL });
  applyState(app, state); app.detail = state.agent.sessions[0]; app.now = Date.parse('2026-10-22T10:05:00Z'); app.screen = 'home';
  assert.match(drawFrame(app).map(strip).join('\n'), /工作文件夹 .*Downloads/);

  app.input = '看看这个文件夹'; app.cursor = app.input.length;
  const createdState = { ...state, agent: { ...state.agent, sessions: [{ ...state.agent.sessions[0], id: 'new1' }] } };
  await withFetch(url => (url.endsWith('/api/chat') ? { session_id: 'new1', task_id: 't9' } : createdState), async seen => {
    await submit(app);
    assert.equal(seen[0].body.workdir.replace(/\\/g, '/'), DL);
    assert.equal(seen[0].body.session_id, undefined);
  });
  assert.match(strip(drawFrame(app)[0]), /▣ Downloads/);

  app.screen = 'chat'; app.sessionId = 's1'; app.input = '继续'; app.cursor = app.input.length;
  await withFetch(url => (url.endsWith('/api/chat') ? { session_id: 's1', task_id: 't10' } : state), async seen => {
    await submit(app);
    assert.equal(seen[0].body.workdir, undefined); assert.equal(seen[0].body.session_id, 's1');
  });

  assert.match(strip(drawFrame(app)[0]), /▣ Downloads/);

  const office = createApp({ cols: 130, rows: 34, launchDir: null }); applyState(office, state);
  assert.equal(drawFrame(office).map(strip).join('\n').includes('工作文件夹'), false);
});

test('restoring and switching sessions use backend folders, not stale prefs or the launch folder; new keeps the launch folder', async () => {
  const launchDir = 'D:/research/NewProject';
  const folder = state.agent.sessions[0], office = { ...folder, id: 'office', workdir: undefined };
  const app = createApp({ cols: 130, rows: 34, launchDir, prefs: { session: 's1', workdirs: { s1: 'D:/wrong/Stale', office: DL } } });
  const selected = id => ({ ...state, agent: { ...state.agent, sessions: [folder, office].map(s => s.id === id ? s : { ...s, messages: undefined }) } });
  await withFetch(url => url.includes('/api/state') ? selected(new URL(url).searchParams.get('session')) : {}, async () => {
    await openSession(app, 's1');
    assert.match(strip(drawFrame(app)[0]), /▣ Downloads/);
    assert.doesNotMatch(strip(drawFrame(app)[0]), /Stale|NewProject/);
    await openSession(app, 'office');
    assert.doesNotMatch(strip(drawFrame(app)[0]), /▣|Downloads|NewProject/);
    await openSession(app, 's1');
    assert.match(strip(drawFrame(app)[0]), /▣ Downloads/);
  });
  await onKey(app, { key: 'char', ch: 'n', ctrl: true });
  assert.equal(app.sessionId, null);
  assert.equal(app.screen, 'home');
  assert.match(drawFrame(app).map(strip).join('\n'), /工作文件夹 .*NewProject/);
  app.input = '新项目'; app.cursor = app.input.length;
  const fresh = { ...folder, id: 'new2', workdir: launchDir };
  await withFetch(url => url.endsWith('/api/chat') ? { session_id: fresh.id, task_id: 't11' } : { ...state, agent: { ...state.agent, sessions: [fresh] } }, async seen => {
    await submit(app);
    assert.equal(seen[0].body.workdir, launchDir);
    assert.equal(seen[0].body.session_id, undefined);
  });
  assert.match(strip(drawFrame(app)[0]), /▣ NewProject/);
  assert.equal(folder.workdir, DL);
});
