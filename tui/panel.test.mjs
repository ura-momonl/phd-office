import test from 'node:test';
import assert from 'node:assert/strict';
import { width, strip } from './text.mjs';
import { createApp, applyState, drawFrame } from './app.mjs';
import { describeCall, summarizeCalls, relPath } from './activity.mjs';

process.env.PHD_TUI_NO_PREFS = '1';
const ROOT = 'D:\\Main\\assistant';
const edit = (file, oldS, newS) => ({ name: 'Edit', input: JSON.stringify({ file_path: file, old_string: oldS, new_string: newS }), brief: file, status: '完成', durationMs: 20 });
const calls = [
  { name: 'Read', input: JSON.stringify({ file_path: ROOT + '\\tui\\app.mjs' }), brief: 'x', status: '完成', task: 't1' },
  edit(ROOT + '\\tui\\app.mjs', 'a\nb', 'a\nb\nc\nd'),
  edit(ROOT + '\\tui\\app.mjs', 'x', 'y'),
  { name: 'Write', input: JSON.stringify({ file_path: ROOT + '\\tui\\activity.mjs', content: '1\n2\n3' }), brief: 'x', status: '完成' },
  { name: 'FileChange', input: ROOT + '\\a.txt; ' + ROOT + '\\b.txt', brief: 'x', status: '完成' },
  { name: 'Bash', input: 'node scripts/run-tests.mjs --keep', brief: 'x', status: '完成', durationMs: 3200 },
  { name: 'Bash', input: 'node scripts/disk-usage.mjs', brief: 'x', status: '未完成', task: 't1' },
].map(c => ({ task: 't1', ...c }));

test('calls are described and files aggregated with edit counts and line changes', () => {
  assert.equal(relPath(ROOT + '\\tui\\app.mjs', ROOT), 'tui/app.mjs');
  assert.equal(describeCall(calls[1], ROOT).text, 'tui/app.mjs');
  assert.equal(describeCall(calls[5], ROOT).text, '运行隔离测试 · --keep');
  assert.equal(describeCall({ name: 'Bash', input: 'node -e "\nx"' }, ROOT).text, '执行内嵌脚本');
  const { feed, files } = summarizeCalls(calls, ROOT);
  assert.equal(feed.length, 7);
  const app = files.find(f => f.path === 'tui/app.mjs');
  assert.deepEqual([app.edits, app.adds, app.dels], [2, 5, 3]);
  assert.equal(files.find(f => f.path === 'tui/activity.mjs').write, true);
  assert.deepEqual(files.map(f => f.path).slice(0, 3), ['a.txt', 'b.txt', 'tui/activity.mjs']); // newest call first; two files of one call keep their order
});

const data = {
  agent_read_at: {},
  agent: {
    active_turns: [{ task_id: 't1', provider: 'claude' }],
    executions: [],
    sessions: [
      { id: 's1', title: '当前对话', last_at: '2026-10-22T10:00:00Z', task_ids: ['t1'], context: { claude: { tokens: 365000, window: 1000000, parts: [{ key: 'fixed', label: '固定开销（系统提示）', tokens: 30000 }, { key: 'call', label: '工具调用', tokens: 140000 }, { key: 'user', label: '用户消息', tokens: 42000 }] } },
        subagent_runs: [{ id: 'r1', title: 'Read dsh-TUI repo', status: 'completed', at: '2026-10-22T09:00:00Z', finished_at: '2026-10-22T09:01:04Z' }, { id: 'r2', title: '查文档', status: 'running', at: '2026-10-22T10:04:00Z' }],
        messages: [{ role: 'user', text: '你好', at: '2026-10-22T09:00:00Z' }, { role: 'assistant', provider: 'claude', text: '好', at: '2026-10-22T09:01:00Z' }] },
      { id: 's2', title: '另一个历史对话', last_at: '2026-10-21T10:00:00Z', task_ids: [] },
    ],
  },
};
const make = (cols, rows, panel) => {
  const a = createApp({ cols, rows, prefs: { session: 's1', panel } }); applyState(a, data); a.screen = 'chat';
  a.detail = data.agent.sessions[0]; a.now = Date.parse('2026-10-22T10:05:00Z'); a.calls = summarizeCalls(calls, ROOT); return a;
};

test('panel shows sub-agents, touched files, recent calls and context use - not the conversation history', () => {
  const lines = drawFrame(make(130, 34, true)), text = lines.map(strip).join('\n');
  for (const want of ['活动', '子 agent', 'Read dsh-TUI repo', '1m 04s', '查文档', '改动文件 4', 'tui/app.mjs', '×2 +5 −3', '最近调用', '运行隔离测试 · --keep', '上下文', '37%', '365k/1.0M', '工具调用 38%']) assert.ok(text.includes(want), want);
  assert.equal(text.includes('另一个历史对话'), false);
  assert.ok(lines.every(l => width(l) <= 130));
});

test('the unfinished last call of a running turn is marked live; a panel needs a wide window; transcript has margins', () => {
  const wide = drawFrame(make(130, 34, true)).map(strip).join('\n');
  assert.match(wide, /[✻✺✹✸] .*运行脚本 · scripts/);
  assert.equal(drawFrame(make(90, 30, true)).map(strip).join('\n').includes('子 agent'), false);
  const lines = drawFrame(make(100, 30, false)).map(strip);
  assert.ok(lines[0].startsWith('  ⌸ ')); assert.equal(lines[1].trim(), '');
  assert.ok(lines.some(l => l.startsWith('  ❯ 你好')));
});

test('small windows still fit: the panel keeps within its height', () => {
  for (const [c, r] of [[100, 12], [120, 20], [200, 50]]) assert.ok(drawFrame(make(c, r, true)).every(l => width(l) <= c));
});

import { renderMarkdown, codeTone, THEMES } from './view.mjs';
const rgb = c => `\x1b[38;2;${c.join(';')}m`;

test('diff fences colour added lines green, removed lines red, hunks accent; other fences stay code-coloured', () => {
  const th = THEMES.clay, out = renderMarkdown('```diff\n+新增\n-删除\n@@ -1 +1 @@\n 上下文\n--- a/x\n```\n```js\n+not a diff\n```', 60, th);
  assert.ok(out[1].includes(rgb(th.ok) + '+新增'));
  assert.ok(out[2].includes(rgb(th.bad) + '-删除'));
  assert.ok(out[3].includes(rgb(th.accent) + '@@'));
  assert.ok(out[4].includes(rgb(th.dim) + ' 上下文') && out[5].includes(rgb(th.dim) + '--- a/x'));
  assert.ok(out[8].includes(rgb(th.warn) + '+not a diff'));
  assert.equal(codeTone('js', '+x'), 'warn');
  for (const t of Object.values(THEMES)) assert.ok(Array.isArray(t.bad), 'every theme has a red');
});

test('the panel colours +N green and −N red', () => {
  const app = make(130, 34, true), line = drawFrame(app).find(l => strip(l).includes('tui/app.mjs') && strip(l).includes('×2'));
  assert.ok(line.includes(rgb(app.theme().ok) + '+5') && line.includes(rgb(app.theme().bad) + '−3'));
});
