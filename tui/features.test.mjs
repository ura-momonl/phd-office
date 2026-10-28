import test from 'node:test';
import assert from 'node:assert/strict';
import { width, strip } from './text.mjs';
import { createApp, applyState, drawFrame, onKey, submit, stopRunning, openCall, currentContext, inputTone, answerer, capacityLabels, MOUSE_OFF, MOUSE_ON } from './app.mjs';
import { callDetailLines, summarizeCalls } from './activity.mjs';
import { THEMES, GLYPH, conversationLines, renderMarkdown } from './view.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const ROOT = 'D:\\Main\\assistant';
const state = {
  agent_read_at: {},
  agent: {
    active_turns: [{ task_id: 't1', provider: 'claude' }], executions: [],
    sessions: [{
      id: 's1', title: '当前对话', last_at: '2026-10-22T10:00:00Z', task_ids: ['t1'],
      context: { claude: { tokens: 850000, window: 1000000, parts: [] } },
      messages: [{ role: 'user', text: '你好', at: '2026-10-22T09:00:00Z' }, { role: 'assistant', provider: 'claude', text: '好', at: '2026-10-22T09:01:00Z' }],
    }],
  },
};
const raw = [
  { name: 'Edit', input: JSON.stringify({ file_path: ROOT + '\\tui\\app.mjs', old_string: 'a\nb', new_string: 'a\nB\nc' }), status: '完成', durationMs: 40, chars: 12, output: 'ok', task: 't1' },
  { name: 'Bash', input: 'node scripts/disk-usage.mjs', status: '完成', durationMs: 2500, chars: 30, output: 'line1\nline2', task: 't1' },
  { name: 'Write', input: JSON.stringify({ file_path: ROOT + '\\x.txt', content: '1\n2' }), status: '完成', task: 't1' },
];
const make = (cols = 130, rows = 34, panel = true) => {
  const a = createApp({ cols, rows, prefs: { session: 's1', panel } }); applyState(a, state); a.screen = 'chat';
  a.detail = state.agent.sessions[0]; a.now = Date.parse('2026-10-22T10:05:00Z'); a.callsRaw = raw; a.calls = summarizeCalls(raw, ROOT); return a;
};
const withFetch = async (handler, fn) => {
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, opt = {}) => { seen.push({ url: String(url), body: opt.body ? JSON.parse(opt.body) : null, headers: opt.headers }); const r = await handler(String(url), opt); return { ok: true, status: 200, json: async () => r }; };
  try { await fn(seen); } finally { globalThis.fetch = real; }
};

test('capacity uses the tightest account windows and API balance, not context; expired Claude windows are unknown', () => {
  const app = make();
  app.usage = { quota: {
    claude: { windows: [{ remaining_percent: 0, resets_at: '2026-10-21T00:00:00Z' }, { remaining_percent: 41, resets_at: '2026-10-23T00:00:00Z' }, { remaining_percent: 66 }] },
    codex: { limits: { rateLimitsByLimitId: { a: { primary: { usedPercent: 30 }, secondary: { usedPercent: 49 } }, b: { primary: { usedPercent: 88 } } } } },
    deepseek: { balance_infos: [{ currency: 'CNY', total_balance: '18.52' }] },
  } };
  assert.deepEqual(capacityLabels(app).map(c => c.text), ['Claude 剩余 41%', 'Codex 剩余 12%', 'DeepSeek 余额 ¥18.52']);
  app.screen = 'home';
  assert.match(drawFrame(app).map(strip).join('\n'), /Claude 剩余 41%.*Codex 剩余 12%.*DeepSeek 余额 ¥18.52/);
  app.usage.quota.claude.windows = [{ remaining_percent: 20, resets_at: '2026-10-21T00:00:00Z' }];
  app.usage.quota.codex.limits = { rateLimits: { primary: { usedPercent: 100 }, secondary: { usedPercent: 15 } } };
  app.usage.quota.deepseek.error = 'offline';
  assert.deepEqual(capacityLabels(app).map(c => c.text), ['Claude 剩余 —', 'Codex 剩余 0%', 'DeepSeek 上次余额 ¥18.52']);
});

test('automatic answerer ignores old sticky preferences, follows arrivals, and leaves routing to the backend', async () => {
  const app = createApp({ cols: 110, rows: 30, prefs: { target: 'Codex', session: 's1' } });
  applyState(app, state); app.screen = 'chat';
  assert.equal(app.target, ''); assert.equal(answerer(app), 'Claude');
  const changed = { ...state, agent: { ...state.agent, config: { default_provider: 'codex' }, sessions: [{ ...state.agent.sessions[0], messages: [...state.agent.sessions[0].messages, { role: 'assistant', provider: 'deepseek', text: '接着聊', at: '2026-10-22T10:01:00Z' }] }] } };
  applyState(app, changed);
  assert.equal(answerer(app), 'DeepSeek'); assert.equal(inputTone(app), 'deepseek');
  assert.match(strip(drawFrame(app).at(-1)), /DeepSeek · 自动/);
  app.input = '继续'; app.cursor = app.input.length;
  await withFetch(url => url.endsWith('/api/chat') ? { session_id: 's1' } : changed, async seen => {
    await submit(app); assert.equal(seen[0].body.text, '继续');
  });
  await onKey(app, { key: 'char', ch: '2', alt: true });
  assert.equal(answerer(app), 'Codex');
  app.input = '这条请你答'; app.cursor = app.input.length;
  await withFetch(url => url.endsWith('/api/chat') ? { session_id: 's1' } : changed, async seen => {
    await submit(app); assert.equal(seen[0].body.text, '@Codex 这条请你答');
  });
  assert.equal(app.target, ''); assert.equal(answerer(app), 'DeepSeek');
  app.input = '@Claude 显式点名优先'; app.cursor = app.input.length;
  await onKey(app, { key: 'char', ch: '2', alt: true });
  await withFetch(url => url.endsWith('/api/chat') ? { session_id: 's1' } : changed, async seen => {
    await submit(app); assert.equal(seen[0].body.text, '@Claude 显式点名优先');
  });
  app.screen = 'home'; assert.equal(answerer(app), 'Codex', 'new conversation uses configured default, not the open session');
});

test('wheel and clicks are enabled by default; Alt+M and /mouse retain native selection without losing the draft', async () => {
  const app = make(); app.input = '中文草稿'; app.cursor = app.input.length;
  const modes = []; app.syncMouse = () => modes.push(app.mouseCapture ? MOUSE_OFF + MOUSE_ON : MOUSE_OFF);
  assert.equal(app.mouseCapture, true);
  await onKey(app, { key: 'char', ch: 'm', alt: true });
  assert.equal(app.mouseCapture, false); assert.equal(app.input, '中文草稿');
  await onKey(app, { key: 'char', ch: 'm', alt: true });
  assert.equal(app.mouseCapture, true); assert.equal(app.input, '中文草稿');
  assert.deepEqual(modes, [MOUSE_OFF, MOUSE_OFF + MOUSE_ON]);
  app.input = '/mouse'; app.cursor = app.input.length; await submit(app);
  assert.equal(app.mouseCapture, false);
});

test('clicking the draft positions insertion at the clicked cell, including CJK, emoji and padding', async () => {
  for (const screen of ['home', 'chat']) for (const panel of [false, true]) {
    const app = make(130, 34, panel); app.screen = screen; app.active = [];
    app.input = 'ab中文😀cd'; app.cursor = app.input.length;
    drawFrame(app);
    const row = app.cursorXY[0], x0 = app.cursorXY[1] - width(app.input);
    for (const [cell, offset] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 3], [6, 4], [7, 6], [20, app.input.length]]) {
      await onKey(app, { key: 'mouse', mouse: { x: x0 + cell, y: row, button: 0, wheel: null, down: true } });
      assert.equal(app.cursor, offset, `${screen}, panel=${panel}, cell=${cell}`);
    }
    await onKey(app, { key: 'mouse', mouse: { x: x0 + 2, y: row, button: 0, wheel: null, down: true } });
    await onKey(app, { key: 'char', ch: '插' });
    assert.equal(app.input, 'ab插中文😀cd');
    assert.equal(app.cursor, 3);
    drawFrame(app); assert.deepEqual(app.cursorXY, [row, x0 + width('ab插')]);
  }
});

test('click mapping retains multiline and wrapped draft offsets and moves the viewport with the caret', async () => {
  for (const screen of ['home', 'chat']) for (const cols of [40, 60, 130]) {
    const app = make(cols, 30, false); app.screen = screen; app.active = [];
    app.input = 'first line\n中文 two  spaces\n' + '中文 a  😀 '.repeat(35); app.cursor = app.input.length;
    let frame = drawFrame(app).map(strip);
    const visible = app.hits.filter(h => h.act.type === 'input');
    assert.equal(visible.length, 5);
    for (const hit of visible) {
      const line = hit.act.line;
      assert.equal(app.input.slice(line.start, line.end), line.text);
      assert.equal(frame[hit.y - 1].includes(line.text), true);
      await onKey(app, { key: 'mouse', mouse: { x: hit.x0, y: hit.y, button: 0, wheel: null, down: true } });
      assert.equal(app.cursor, line.start);
    }
    await onKey(app, { key: 'char', ch: 'a', ctrl: true });
    frame = drawFrame(app).map(strip);
    const first = app.hits.find(h => h.act.type === 'input');
    assert.equal(first.act.line.start, 0);
    assert.equal(frame[app.cursorXY[0] - 1].includes('first line'), true);
    const second = app.hits.filter(h => h.act.type === 'input')[1];
    await onKey(app, { key: 'mouse', mouse: { x: second.x0 + 4, y: second.y, button: 0, wheel: null, down: true } });
    await onKey(app, { key: 'char', ch: 'X' });
    assert.equal(app.input.startsWith('first line\n中文X two  spaces\n'), true);
    const cursor = app.cursor;
    await onKey(app, { key: 'mouse', mouse: { x: second.x0 - 1, y: second.y, button: 0, wheel: null, down: true } });
    await onKey(app, { key: 'mouse', mouse: { x: second.x0, y: second.y, button: 0, wheel: null, down: false } });
    assert.equal(app.cursor, cursor, 'border and release must not move the insertion point');
  }
});

test('status bar shows the open conversation\'s context use, warning colour above 80%', () => {
  const app = make(), line = drawFrame(app).at(-1);
  assert.match(strip(line), /ctx 85%/);
  assert.ok(line.includes(`\x1b[38;2;${THEMES.clay.warn.join(';')}mctx 85%`));
  assert.deepEqual([currentContext(app).tokens, currentContext(app).window], [850000, 1000000]);
  app.screen = 'home'; assert.equal(strip(drawFrame(app).at(-1)).includes('ctx'), false);
});

test('Ctrl+X stops the running turn of this conversation; nothing running says so', async () => {
  const app = make();
  await withFetch(() => ({ stopped: true }), async seen => {
    await onKey(app, { key: 'char', ch: 'x', ctrl: true });
    assert.deepEqual(seen.map(s => [s.url.endsWith('/api/stop'), s.body]), [[true, { task_id: 't1' }]]);
    assert.match(app.notice, /已请求停止 Claude/);
  });
  const idle = make(); idle.active = [];
  await withFetch(() => ({}), async seen => { await stopRunning(idle); assert.equal(seen.length, 0); assert.match(idle.notice, /没有正在运行/); });
});

test('the notice after sending says whether the message was appended, queued or simply sent', async () => {
  for (const [delivery, want] of [['steered', /已追加/], ['pending', /已追加/], ['queued', /已排队/], [undefined, /已发送/]]) {
    const app = make(); app.input = '再补充一点'; app.cursor = app.input.length;
    await withFetch(url => (url.endsWith('/api/chat') ? { session_id: 's1', task_id: 't2', delivery } : state), async seen => {
      await submit(app);
      assert.equal(seen[0].headers['x-phd-client'], 'tui');
      assert.match(app.notice, want);
    });
  }
});

test('call detail: Edit shows a red/green diff, shell shows command and output; arrows move, Esc returns', () => {
  const th = THEMES.clay, edit = callDetailLines(raw[0], ROOT, 100, th, 1, 3), text = edit.map(strip).join('\n');
  assert.match(text, /#1\/3  Edit/); assert.match(text, /tui\/app\.mjs/);
  assert.ok(edit.some(l => l.includes(`\x1b[38;2;${th.bad.join(';')}m- b`)) && edit.some(l => l.includes(`\x1b[38;2;${th.ok.join(';')}m+ B`)));
  const sh = callDetailLines(raw[1], ROOT, 100, th, 2, 3).map(strip).join('\n');
  assert.match(sh, /\$ node scripts\/disk-usage\.mjs/); assert.match(sh, /返回[\s\S]*line1\n.*line2/);
});

test('call detail screen: Ctrl+O opens the latest call, ↑↓ browse, wheel/PgDn scroll, Esc returns; every size fits', async () => {
  const app = make();
  await onKey(app, { key: 'char', ch: 'o', ctrl: true });
  assert.equal(app.screen, 'call'); assert.equal(app.callView.i, 2);
  assert.match(drawFrame(app).map(strip).join('\n'), /#3\/3  Write/);
  await onKey(app, { key: 'up' }); assert.equal(app.callView.i, 1);
  await onKey(app, { key: 'up' }); await onKey(app, { key: 'up' }); assert.equal(app.callView.i, 0);
  await onKey(app, { key: 'down' }); assert.equal(app.callView.i, 1);
  for (const [c, r] of [[130, 34], [60, 12], [200, 50]]) { app.cols = c; app.rows = r; assert.ok(drawFrame(app).every(l => width(l) <= c)); }
  await onKey(app, { key: 'escape' }); assert.equal(app.screen, 'chat');
});

test('clicking a call row in the panel opens that call', async () => {
  const app = make(); drawFrame(app);
  const hit = app.hits.find(h => h.act.type === 'call' && h.act.i === 1); assert.ok(hit, 'panel row is clickable');
  await onKey(app, { key: 'mouse', mouse: { x: hit.x0 + 2, y: hit.y, button: 0, wheel: null, down: true } });
  await onKey(app, { key: 'mouse', mouse: { x: hit.x0 + 2, y: hit.y, button: 0, wheel: null, down: false } });
  assert.equal(app.screen, 'call'); assert.equal(app.callView.i, 1);
});

test('rounded input frame follows the recipient in every theme; mentions override the default answerer', () => {
  const rgb = c => `\x1b[38;2;${c.join(';')}m`;
  for (const theme of Object.keys(THEMES)) {
    const app = make(110, 30, false); app.themeKey = theme; app.active = [];
    for (const target of ['Claude', 'Codex', 'DeepSeek', 'all', '']) {
      app.target = target; app.input = '写一段中文'; app.cursor = app.input.length;
      const tone = target === '' ? 'claude' : target !== 'all' ? target.toLowerCase() : 'accent';
      assert.equal(inputTone(app), tone);
      const lines = drawFrame(app), row = lines.findIndex(l => strip(l).includes('❯ 写一段中文'));
      assert.ok(row > 0);
      assert.ok(lines[row].includes(rgb(app.theme()[tone]) + '❯ '));
      assert.match(strip(lines[row - 1]).trim(), /^╭─+╮$/);
      assert.match(strip(lines[row + 1]).trim(), /^╰─+╯$/);
      assert.match(strip(lines[row]).trim(), /^│ ❯ 写一段中文\s+│$/);
      assert.deepEqual(app.cursorXY, [row + 1, width('  │ ❯ 写一段中文') + 1]);
    }
    app.target = 'Claude'; app.input = '请 @Codex 看看，再请 @DeepSeek 核对'; app.cursor = app.input.length;
    assert.equal(inputTone(app), 'codex');
    const line = drawFrame(app).find(l => strip(l).includes('请 @Codex'));
    assert.ok(line.includes(rgb(app.theme().codex) + '@Codex'));
    assert.ok(line.includes(rgb(app.theme().deepseek) + '@DeepSeek'));
  }
});

test('input distinguishes appending to a live chat, new messages and slash commands without changing the draft', () => {
  const app = make(110, 30, false);
  assert.match(drawFrame(app).map(strip).join('\n'), /↳ 追加一句给正在回复的助手/);
  app.input = '补充实验参数'; app.cursor = app.input.length;
  assert.match(drawFrame(app).map(strip).join('\n'), /↳ 补充实验参数/);
  app.active = [];
  assert.match(drawFrame(app).map(strip).join('\n'), /❯ 补充实验参数/);
  app.input = '/calls'; app.cursor = app.input.length;
  assert.match(drawFrame(app).map(strip).join('\n'), /⌘ \/calls/);
  assert.equal(app.input, '/calls');
  app.screen = 'home'; app.input = ''; app.cursor = 0; app.active = state.agent.active_turns;
  const text = drawFrame(app).map(strip).join('\n');
  assert.match(text, /❯ 写点什么/);
  assert.equal(text.includes('追加一句给正在回复的助手'), false, 'home always starts a new conversation');
});

test('assistant marks and elapsed time belong to the completed task, not interim updates', () => {
  const messages = Object.keys(GLYPH).flatMap((provider, i) => [
    { role: 'user', task_id: 't' + i, text: '开始', at: '2026-10-22T09:00:00Z' },
    { role: 'assistant', provider, task_id: 't' + i, interim: true, text: '正在检查', at: '2026-10-22T09:00:02Z' },
    { role: 'assistant', provider, task_id: 't' + i, text: '完成', at: '2026-10-22T09:01:04Z' },
    { role: 'system', task_id: 't' + i, text: '系统通知', at: '2026-10-22T09:02:00Z' },
  ]);
  const lines = conversationLines({ messages }, 80, THEMES.clay).map(strip);
  for (const [provider, name] of [['claude', 'Claude'], ['codex', 'Codex'], ['deepseek', 'DeepSeek']]) {
    const heads = lines.filter(l => l.startsWith(GLYPH[provider] + ' ' + name));
    assert.equal(heads.length, 2);
    assert.equal(heads[0].includes('用时'), false);
    assert.ok(heads[1].endsWith('用时 1m 04s'));
  }
  assert.ok(lines.filter(l => l.startsWith('● 助手')).every(l => !l.includes('用时')), 'system notices are not assistant replies');
});

test('code blocks show a language label and border without consuming code or swallowing following prose', () => {
  const lines = renderMarkdown('```js\nconst x = 1;\n```\n继续说明\n```\n中文\n```', 40, THEMES.clay).map(strip);
  assert.deepEqual(lines, ['┌ js', '│ const x = 1;', '└', '继续说明', '┌ ', '│ 中文', '└']);
});

test('styled drafts and replies stay within narrow and wide frames with the panel on or off', () => {
  for (const screen of ['home', 'chat']) for (const [cols, rows] of [[40, 12], [60, 20], [110, 30], [200, 50]]) for (const panel of [true, false]) {
    const app = make(cols, rows, panel); app.screen = screen;
    app.input = '@Codex ' + '中文草稿 '.repeat(12) + '\n第二行'; app.cursor = app.input.length;
    app.detail = { ...app.detail, messages: [...app.detail.messages, { role: 'assistant', provider: 'codex', text: '```diff\n+新增内容\n-删除内容\n```', task_id: 't1', at: '2026-10-22T09:01:04Z' }] };
    const lines = drawFrame(app);
    assert.equal(lines.length, rows);
    assert.ok(lines.every(l => width(l) <= cols));
    assert.ok(app.cursorXY[0] >= 1 && app.cursorXY[0] < rows);
    assert.ok(app.cursorXY[1] >= 1 && app.cursorXY[1] <= cols);
  }
});

test('rounded input stays three rows when empty, encloses multiline drafts and leaves cursor room at a full line', () => {
  for (const screen of ['home', 'chat']) for (const cols of [40, 60, 110]) {
    const app = make(cols, 30, false); app.screen = screen; app.active = [];
    const empty = drawFrame(app).map(strip), row = app.cursorXY[0] - 1;
    assert.match(empty[row - 1].trim(), /^╭─+╮$/);
    assert.match(empty[row].trim(), /^│ ❯ .*│$/);
    assert.match(empty[row + 1].trim(), /^╰─+╯$/);
    app.input = '第一行\n第二行'; app.cursor = app.input.length;
    const multi = drawFrame(app).map(strip), last = app.cursorXY[0] - 1;
    assert.match(multi[last - 1].trim(), /^│ ❯ 第一行\s+│$/);
    assert.match(multi[last].trim(), /^│\s+第二行\s+│$/);
    assert.match(multi[last + 1].trim(), /^╰─+╯$/);
    assert.equal(width(multi[last - 2]), width(multi[last + 1]));
    // The insertion cursor must sit inside the frame, including at the wrap boundary.
    const mainW = screen === 'home' ? Math.min(cols, 100) : cols, margin = screen === 'home' ? 0 : cols >= 60 ? 2 : 1;
    app.input = 'x'.repeat(mainW - 2 * margin - 7); app.cursor = app.input.length;
    const full = drawFrame(app).map(strip), line = full[app.cursorXY[0] - 1];
    assert.equal(line[app.cursorXY[1] - 1], ' ');
    assert.ok(app.cursorXY[1] < line.lastIndexOf('│') + 1);
  }
});

