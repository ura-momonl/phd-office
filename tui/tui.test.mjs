import test from 'node:test';
import assert from 'node:assert/strict';
import { width, wrap, clip, strip } from './text.mjs';
import { createKeyParser } from './keys.mjs';
import { createApp, applyState, drawFrame, mentionAt, onKey, listItems, paletteItems } from './app.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const keys = input => { const out = []; const feed = createKeyParser(k => out.push(k)); [].concat(input).forEach(feed); return out; };

test('CJK counts two cells; wrap and clip respect it', () => {
  assert.equal(width('ab中文'), 6);
  assert.ok(wrap('中文'.repeat(20), 10).every(l => width(l) <= 10));
  assert.ok(width(clip('这是一个很长的标题'.repeat(3), 12)) <= 12);
});

test('key parser: arrows, ctrl, alt-enter, paste, mouse wheel, split sequences', () => {
  assert.deepEqual(keys('\x1b[A').map(k => k.key), ['up']);
  assert.deepEqual(keys('\x03').map(k => [k.key, k.ctrl, k.ch]), [['char', true, 'c']]);
  assert.equal(keys('\x1b\r')[0].alt, true);
  assert.equal(keys('\x1b[200~第一行\r\n第二行\x1b[201~')[0].text, '第一行\n第二行');
  assert.equal(keys('\x1b[<64;10;5M')[0].mouse.wheel, 'up');
  assert.deepEqual(keys(['\x1b[', '5~']).map(k => k.key), ['pageup']);
  assert.deepEqual(keys('中a').map(k => k.ch), ['中', 'a']);
});

const data = {
  agent_read_at: {},
  agent: {
    active_turns: [{ task_id: 't1', provider: 'claude' }],
    sessions: [
      { id: 's1', title: '一号对话', last_at: '2026-10-22T10:00:00Z', task_ids: ['t1'], messages: [
        { role: 'user', text: '你好 @Claude', at: '2026-10-22T09:00:00Z' },
        { role: 'assistant', provider: 'claude', text: '# 标题\n- 条目 **粗体** `code`\n```\nx=1\n```', at: '2026-10-22T09:01:00Z' }] },
      { id: 's2', title: '二号', last_at: '2026-10-21T10:00:00Z', task_ids: [], pinned: true },
      { id: 's3', title: '任务会话', origin: 'task', last_at: '2026-10-21T10:00:00Z' },
    ],
  },
};

const withApp = (cols, rows, screen) => {
  const app = createApp({ cols, rows, prefs: { session: 's1' } }); applyState(app, { ...data, projects: [{ id: 'p1', name: '项目一' }] });
  app.screen = screen; app.detail = data.agent.sessions[0]; app.now = Date.parse('2026-10-22T10:05:00Z');
  if (screen === 'sessions') { app.sw = { q: '', rail: 0, focus: 'list', sel: 0, extra: [] }; }
  return app;
};

test('every screen fits the terminal at several sizes', () => {
  for (const screen of ['home', 'chat', 'sessions']) for (const [cols, rows] of [[110, 30], [60, 20], [200, 50], [40, 12]]) {
    const app = withApp(cols, rows, screen), lines = drawFrame(app);
    assert.equal(lines.length, rows, screen + ' rows');
    assert.ok(lines.every(l => width(l) <= cols), screen + ' width ' + cols);
  }
});

test('chat shows band for user, bullet for assistant, running state; task sessions stay hidden', () => {
  const text = drawFrame(withApp(110, 30, 'chat')).map(strip).join('\n');
  assert.match(text, /❯ 你好 @Claude/); assert.match(text, /[✻◆◈] Claude/); assert.match(text, /正在回复/);
  assert.equal(/任务会话/.test(text), false);
  assert.match(drawFrame(withApp(110, 30, 'home')).map(strip).join('\n'), /Claude 剩余/);
});

test('sessions screen: rail by project, filter, new-conversation card', async () => {
  const app = withApp(100, 24, 'sessions');
  assert.equal(listItems(app).length, 2);
  app.sw.q = '二'; assert.deepEqual(listItems(app).map(r => r.id), ['s2']);
  const text = drawFrame(app).map(strip).join('\n'); assert.match(text, /新对话/); assert.match(text, /项目一/);
  await onKey(app, { key: 'escape' }); assert.notEqual(app.screen, 'sessions');
});

test('new command, shortcuts and sessions card all return to the home screen without the old conversation', async () => {
  for (const route of ['command', 'shortcut', 'card-enter', 'card-click', 'sessions-shortcut']) {
    const app = withApp(100, 24, route.startsWith('card-') || route === 'sessions-shortcut' ? 'sessions' : 'chat');
    app.scroll = 7;
    if (route === 'command') {
      app.input = '/new'; app.cursor = app.input.length;
      await onKey(app, { key: 'enter' });
    } else if (route === 'card-enter') {
      await onKey(app, { key: 'enter' });
    } else if (route === 'card-click') {
      drawFrame(app);
      const hit = app.hits.find(h => h.act.type === 'new');
      assert.ok(hit, 'the new-conversation card has a mouse target');
      for (const down of [true, false]) await onKey(app, { key: 'mouse', mouse: { x: hit.x0 + 2, y: hit.y, button: 0, down } });
    } else {
      await onKey(app, { key: 'char', ch: 'n', ctrl: true });
    }
    assert.equal(app.screen, 'home', route);
    assert.equal(app.sessionId, null, route);
    assert.equal(app.detail, null, route);
    assert.equal(app.sw, null, route);
    assert.equal(app.scroll, 0, route);
    assert.equal(app.sessions.length, 2, 'existing conversations remain available');
    assert.match(drawFrame(app).map(strip).join('\n'), /Claude 剩余/);
  }
  const app = withApp(100, 24, 'chat'); app.input = '/'; app.cursor = 1;
  const commands = paletteItems(app);
  assert.equal(commands.some(c => c.name === '/home'), false);
  assert.match(commands.find(c => c.name === '/new').desc, /回到主页/);
});

test('@ completion, slash palette, target and input editing', async () => {
  const app = withApp(100, 30, 'chat');
  for (const ch of '问 @Co') await onKey(app, { key: 'char', ch });
  assert.deepEqual(mentionAt(app).hits, ['Codex']);
  await onKey(app, { key: 'tab' }); assert.equal(app.input, '问 @Codex ');
  await onKey(app, { key: 'char', ch: 'j', ctrl: true }); assert.equal(app.input.endsWith('\n'), true);
  app.input = '/'; app.cursor = 1; assert.ok(paletteItems(app).length >= 8);
  app.input = '/th'; app.cursor = 3; assert.deepEqual(paletteItems(app).map(c => c.name), ['/theme']);
  assert.ok(drawFrame(app).every(l => width(l) <= 100));
  app.input = ''; app.cursor = 0;
  await onKey(app, { key: 'char', ch: '2', alt: true }); assert.equal(app.target, 'Codex');
});

import { copyLastReply } from './app.mjs';

test('arrow keys, PgUp and End scroll the transcript; scrollbar appears when it overflows', async () => {
  const app = withApp(80, 14, 'chat');
  app.detail = { ...data.agent.sessions[0], messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', provider: 'claude', text: `第 ${i} 条 ` + '内容'.repeat(10), at: '2026-10-22T09:0' + (i % 10) + ':00Z', task_id: 't' + i })) };
  drawFrame(app);
  await onKey(app, { key: 'up' }); assert.equal(app.scroll, 2);
  await onKey(app, { key: 'pageup' }); assert.ok(app.scroll > 2);
  const text = drawFrame(app).map(strip).join('\n'); assert.match(text, /┃/); assert.match(text, /回到底部/);
  await onKey(app, { key: 'end' }); assert.equal(app.scroll, 0);
  await onKey(app, { key: 'down' }); assert.equal(app.scroll, 0);
});

test('a reply that arrives in an open session is typed out; tool calls show while running', () => {
  const app = withApp(100, 30, 'chat'); app.seen.set('s1', 'old');
  applyState(app, { ...data, agent: { ...data.agent, sessions: data.agent.sessions.map(s => (s.id === 's1' ? { ...s, messages: s.messages } : s)), executions: [{ status: 'running', session_id: 's1', provider: 'claude', name: 'Bash', summary: '列出文件' }] } });
  assert.ok(app.reveal, 'reveal started');
  app.reveal.t0 = app.now = 1000; app.reveal.t0 = 1000 - 10; // just started: only a prefix is visible
  app.detail = data.agent.sessions[0];
  const text = drawFrame(app).map(strip).join('\n');
  assert.match(text, /↳ Bash · 列出文件/); assert.match(text, /▍/);
});

test('home stays quiet even with cards and work; copy emits OSC 52', () => {
  const app = withApp(100, 40, 'home');
  app.inbox = [{ title: '保全订阅', category: '邮件' }];
  app.work = [{ actor: 'user', status: 'active', title: '制样' }, { actor: 'claude', status: 'active', title: '别人的' }];
  app.usage = { quota: { codex: { activity: { summary: { currentStreakDays: 5 }, dailyUsageBuckets: [1, 5, 3, 9].map(tokens => ({ tokens })) } } } };
  const text = drawFrame(app).map(strip).join('\n');
  assert.doesNotMatch(text, /今天|保全订阅|制样|连续 5 天|Tip:|继续「|回答者/);
  assert.match(text, /Claude 剩余 —.*Codex 剩余 —.*DeepSeek 余额 —/);
  app.detail = data.agent.sessions[0]; copyLastReply(app);
  assert.match(app.osc, /\]52;c;/); assert.match(app.notice, /已复制/);
});

import { undoInput, snap, reloadBackend } from './app.mjs';

test('Ctrl+Z undoes typing in groups, restores a sent line, Alt+Z redoes', async () => {
  const app = withApp(100, 30, 'chat');
  for (const ch of 'hello') await onKey(app, { key: 'char', ch });
  app.lastEditAt = 0; // a pause starts a new undo step
  for (const ch of ' world') await onKey(app, { key: 'char', ch });
  await onKey(app, { key: 'char', ch: 'z', ctrl: true }); assert.equal(app.input, 'hello');
  await onKey(app, { key: 'char', ch: 'z', alt: true }); assert.equal(app.input, 'hello world');
  await onKey(app, { key: 'char', ch: 'z', ctrl: true }); await onKey(app, { key: 'char', ch: 'z', ctrl: true }); assert.equal(app.input, '');
  await onKey(app, { key: 'char', ch: 'z', ctrl: true }); assert.match(app.notice, /没有可撤销/);
  // a sent line comes back
  app.input = '发出去的话'; app.cursor = app.input.length; app.history = []; snap(app, 'send', true); app.input = ''; app.cursor = 0;
  undoInput(app); assert.equal(app.input, '发出去的话');
});

test('scrolled-up transcript shows the back-to-bottom pill and its click target resets the scroll', async () => {
  const app = withApp(80, 14, 'chat');
  app.detail = { ...data.agent.sessions[0], messages: Array.from({ length: 12 }, (_, i) => ({ role: 'assistant', provider: 'claude', text: '内容'.repeat(12) + i, at: '2026-10-22T09:00:00Z', task_id: 't' + i })) };
  drawFrame(app); assert.equal(app.hits.some(h => h.act.type === 'bottom'), false);
  await onKey(app, { key: 'mouse', mouse: { x: 5, y: 5, button: 0, wheel: 'up', down: true } });
  const text = drawFrame(app).map(strip).join('\n'); assert.match(text, /↓ 回到底部/);
  const hit = app.hits.find(h => h.act.type === 'bottom'); assert.ok(hit);
  await onKey(app, { key: 'mouse', mouse: { x: hit.x0, y: hit.y, button: 0, wheel: null, down: true } });
  await onKey(app, { key: 'mouse', mouse: { x: hit.x0, y: hit.y, button: 0, wheel: null, down: false } });
  assert.equal(app.scroll, 0);
});

test('/reload asks the backend to restart and waits for a new start time; refusal is shown', async () => {
  const app = withApp(100, 30, 'chat'), real = globalThis.fetch; let started = 'A', restarted = false;
  globalThis.fetch = async (url, opt = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).endsWith('/health')) return json({ started_at: restarted ? 'B' : started });
    if (String(url).endsWith('/api/backend/restart')) { restarted = true; return json({ started_at: 'A' }, 202); }
    return json({ agent: { sessions: [] } });
  };
  try {
    await reloadBackend(app, { wait: 5, limit: 2000 }); assert.match(app.notice, /重启中/);
    await new Promise(r => setTimeout(r, 80)); assert.match(app.notice, /已重启/);
    globalThis.fetch = async (url) => (String(url).endsWith('/health') ? { ok: true, status: 200, json: async () => ({ started_at: 'A' }) } : { ok: false, status: 409, json: async () => ({ error: '还有助手任务或后台工作正在运行' }) });
    await reloadBackend(app); assert.match(app.error, /重启被拒绝：还有助手任务/);
  } finally { globalThis.fetch = real; }
});

test('mouse parser: hover is dropped, legacy X10 wheel and click are understood', () => {
  assert.equal(keys('\x1b[<35;10;5M').length, 0);
  const up = keys('\x1b[M' + String.fromCharCode(32 + 64, 32 + 10, 32 + 5))[0];
  assert.deepEqual([up.key, up.mouse.wheel, up.mouse.x, up.mouse.y], ['mouse', 'up', 10, 5]);
  const down = keys('\x1b[M' + String.fromCharCode(32 + 65, 32 + 10, 32 + 5))[0]; assert.equal(down.mouse.wheel, 'down');
  const click = keys('\x1b[M' + String.fromCharCode(32 + 0, 32 + 3, 32 + 4))[0]; assert.deepEqual([click.mouse.button, click.mouse.down], [0, true]);
  assert.deepEqual(keys(['\x1b[M', String.fromCharCode(96, 42, 37)]).map(k => k.mouse?.wheel), ['up']); // split across chunks
});
