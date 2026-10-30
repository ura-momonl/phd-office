// Terminal front end for the Workbench chat. `tui start` runs it; `tui snapshot [宽x高] [home|chat|sessions]` prints one frame (no TTY needed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { workingFolder } from '../automation/workdir.mjs';
import { createKeyParser } from './keys.mjs';
import { selectionFrame, selectionText, moveSelection } from './selection.mjs';
import { width, wrap, clip, pad, strip, cut } from './text.mjs';
import * as api from './api.mjs';
import { activityPanel, summarizeCalls, loadSessionCalls, callDetailLines } from './activity.mjs';
import { mascotFrame } from './mascot.mjs';
import { crtFrame, CRT_BG } from './crt.mjs';
import { heroLayout, renderHero, timeState } from './hero.mjs';
import { encodeSixel } from './sixel.mjs';
import { THEMES, PROVIDERS, R, BOLD, REV, color, conversationLines, SPINNER, mix, mentions, sessionRow, logoLines, tagStyle, ago, msgKey, bgc } from './view.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFS = path.join(root, '.runtime', 'tui', 'prefs.json');
const MENTIONS = ['Claude', 'Codex', 'DeepSeek', 'all'];
const COMMANDS = [
  { name: '/new', desc: '回到主页，开始新对话（Ctrl+N）' }, { name: '/sessions', desc: '对话与项目（Ctrl+K）' },
  { name: '/pin', desc: '置顶或取消置顶当前对话' }, { name: '/theme', desc: '切换主题（Ctrl+T）' },
  { name: '/who', desc: '下一条回答者：/who Claude|Codex|DeepSeek|all|-（默认跟随上一位）', arg: true },
  { name: '/crt', desc: '开关首页老电视效果（默认开）；其他页面不加屏闪或滚动亮带' },
  { name: '/sixel', desc: '开关首页真像素图（需要支持 sixel 的终端，如 Windows Terminal 1.22+）' },
  { name: '/mouse', desc: '切换鼠标模式（Alt+M）：默认拖选/滚轮/点击，关闭后原生拖选' },
  { name: '/project', desc: '本次对话关联项目：/project <项目id>', arg: true },
  { name: '/panel', desc: '开关右侧活动面板：工具调用、改动文件、子 agent（Ctrl+B）' }, { name: '/reload', desc: '重启 Workbench 后端（有助手在运行时会被拒绝）' },
  { name: '/stop', desc: '停止这个对话里正在运行的助手（Ctrl+X）' }, { name: '/calls', desc: '查看最近一次工具调用的输入和返回（Ctrl+O）' },
  { name: '/keys', desc: '诊断：状态栏显示终端实际发来的输入（查滚轮用）' },
  { name: '/help', desc: '快捷键' }, { name: '/quit', desc: '退出' },
];
const KEYS_HELP = ['Enter 发送　Ctrl+J / Alt+Enter 换行　Ctrl+P / Alt+↑↓ 取回输入历史', '↑↓ / PgUp PgDn 滚动对话（滚轮与点击需开启鼠标捕获）　End 回到底部　Ctrl+Y 复制最后一条回复　Ctrl+Z 撤销输入（Alt+Z 重做）',
  'Ctrl+X 停止正在运行的助手　Ctrl+O 或点面板里的调用 看工具调用详情', 'Ctrl+K 对话与项目　Ctrl+N 新对话　Ctrl+B 活动面板　Ctrl+T 主题', 'Alt+1…4 下一条回答者（Claude/Codex/DeepSeek/all）　Alt+0 自动跟随上一位　Alt+R 继续最近对话', '直接拖选，Ctrl+C 复制选区，Esc 取消；滚轮和输入框点击定位同时可用；Alt+M 切换原生拖选', '@ 后按 Tab 补全　/ 打开命令　/reload 重启后端　Ctrl+C 无选区时退出'];

const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch { return {}; } };
const savePrefs = app => { if (process.env.PHD_TUI_NO_PREFS === '1') return; try { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify({ theme: app.themeKey, panel: app.panel, session: app.sessionId, crt: app.crt, sixel: !app.sixelOff })); } catch { /* prefs are a convenience */ } };

// Office/system launcher directories need no additional project binding.
export const launchFolder = (cwd, officeRoot = root) => workingFolder(cwd, officeRoot) ?? null;
const folderName = p => path.basename(p) || p;

export function createApp({ cols, rows, prefs = {}, launchDir = null }) {
  const s = {
    launchDir,
    cols, rows, prefs, themeKey: THEMES[prefs.theme] ? prefs.theme : 'clay', panel: !!prefs.panel, crt: prefs.crt !== false, crtBoot: null, sixelOff: prefs.sixel === false, img: null, hero: null, target: '', defaultProvider: '', mouseCapture: true,
    screen: 'home', sessions: [], projects: [], readAt: {}, active: [], sessionId: prefs.session || null, detail: null,
    input: '', cursor: 0, history: [], histIdx: -1, scroll: 0, error: '', notice: '', tick: 0, now: Date.now(), sending: false, navigation: 0,
    pal: 0, helpOpen: false, projectId: null, hits: [], cursorXY: [1, 1], selection: null, frame: [],
    executions: [], inbox: [], work: [], usage: null, seen: new Map(), reveal: null, bell: false, osc: '',
    undo: [], redo: [], lastKind: '', lastEditAt: 0, calls: null, callsRaw: [], callView: null, callCache: new Map(),
    sw: null, // sessions screen: {q, rail, focus:'list'|'rail', sel, extra:[]}
  };
  s.theme = () => THEMES[s.themeKey];
  return s;
}

const sortSessions = list => [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || Date.parse(b.last_at || 0) - Date.parse(a.last_at || 0));
const isUnread = (s, readAt) => Date.parse(s.last_at || 0) > Number(readAt[s.id] || 0);
const isRunning = (app, s) => app.active.some(t => (s.task_ids || []).includes(t.task_id));

export function applyState(app, data) {
  app.sessions = sortSessions((data.agent?.sessions || []).filter(x => x.origin !== 'task'));
  app.projects = data.projects || [];
  app.readAt = data.agent_read_at || {};
  const before = app.active.length;
  app.active = data.agent?.active_turns || [];
  app.executions = data.agent?.executions || [];
  app.inbox = data.inbox || [];
  app.work = data.work?.items || [];
  app.usage = data.usage || null;
  app.defaultProvider = data.agent?.config?.default_provider || '';
  if (before > app.active.length) app.bell = true; // a turn finished: ring once
  const full = (data.agent?.sessions || []).find(x => x.messages);
  if (full && full.id === app.sessionId) {
    app.detail = full;
    // A reply that arrives while the session is open is typed out; the first look at a session is shown whole.
    const last = [...(full.messages || [])].reverse().find(m => m.role === 'assistant' && m.text), key = last && msgKey(last);
    if (key && app.seen.has(full.id) && app.seen.get(full.id) !== key) app.reveal = { key, t0: Date.now(), total: [...last.text].length };
    if (key) app.seen.set(full.id, key); else if (!app.seen.has(full.id)) app.seen.set(full.id, '');
  }
  if (app.sessionId && !app.sessions.some(x => x.id === app.sessionId)) { app.sessionId = null; app.detail = null; }
}

const runningIn = (app, session) => {
  if (!session) return new Set();
  const ids = new Set(session.task_ids || []);
  return new Set(app.active.filter(t => ids.has(t.task_id)).map(t => t.provider));
};
const projectName = (app, id) => app.projects.find(p => p.id === id)?.name || id;

// ---- Completion ----------------------------------------------------------------------------------------------------
export function mentionAt(app) {
  const m = /(?:^|\s)@([A-Za-z]*)$/.exec(app.input.slice(0, app.cursor));
  if (!m) return null;
  const hits = MENTIONS.filter(x => x.toLowerCase().startsWith(m[1].toLowerCase()) && x.toLowerCase() !== m[1].toLowerCase());
  return hits.length ? { prefix: m[1], hits } : null;
}
export const paletteItems = app => (/^\/\S*$/.test(app.input) ? COMMANDS.filter(c => c.name.startsWith(app.input)) : []);

// ---- Drawing -------------------------------------------------------------------------------------------------------
const rule = (w, th) => color(th, 'dim', '─'.repeat(w));
const join = (a, b, w) => pad(a, w - width(b)) + b;

// Context use of the open conversation: the provider that spoke last, else any.
export function currentContext(app) {
  if (app.detail?.id !== app.sessionId) return null;
  const who = [...(app.detail.messages || [])].reverse().find(m => m.role === 'assistant' && m.provider)?.provider, ctxs = app.detail.context || {};
  const c = ctxs[who] || ctxs[Object.keys(ctxs)[0]] || null;
  return c?.window ? c : null;
}

// Mirror the backend's automatic choice; only a next-message override is sent as @name.
export function answerer(app) {
  if (app.target) return app.target;
  const session = app.screen === 'home' ? null : app.detail?.id === app.sessionId ? app.detail : app.sessions.find(s => s.id === app.sessionId);
  const last = [...(session?.messages || [])].reverse().find(m => m.role === 'assistant' && PROVIDERS[m.provider]);
  return PROVIDERS[last?.provider || app.defaultProvider] || '';
}

function statusBar(app, w) {
  const th = app.theme(), unread = app.sessions.filter(s => isUnread(s, app.readAt) && s.id !== app.sessionId).length;
  const name = answerer(app), who = name.toLowerCase() || 'accent', tag = tagStyle(th, who, app.target ? '@' + name + ' · 下一条' : (name || '上一位') + ' · 自动');
  const d = new Date(app.now), clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ctx = app.screen === 'chat' ? currentContext(app) : null, pct = ctx ? Math.round(ctx.tokens / ctx.window * 100) : 0;
  const homeHints = '/ 命令  Ctrl+K 对话  ' + (app.mouseCapture ? '拖选后 Ctrl+C 复制' : 'Alt+M 鼠标捕获'), hintsRight = app.screen === 'home' && w >= 80, lp = app.screen === 'home' ? 1 : 0; // home: hints sit bottom-right, the pill gets one cell of margin
  const segs = (app.screen === 'home' ? (hintsRight ? [{ t: homeHints, tone: 'dim' }] : []) : [ctx && { t: `ctx ${pct}%`, tone: pct > 80 ? 'warn' : pct > 60 ? 'accent' : 'dim' }, app.active.length && { t: `${app.active.length} 运行`, tone: 'dim' }, unread && { t: `${unread} 未读`, tone: 'dim' }, { t: clock, tone: 'dim' }]).filter(Boolean);
  const right = ' ' + segs.map(x => x.t).join(' · ') + ' ';
  const rightColored = ' ' + segs.map(x => color(th, x.tone, x.t)).join(color(th, 'dim', ' · ')) + ' ';
  const diag = app.debugKeys ? `输入 ${app.rawCount || 0} 次 · 鼠标 ${app.mouseCount || 0} 次 · 最后 ${app.rawLast || '无'} · WT=${process.env.WT_SESSION ? '是' : '否'} · 控制台 ${app.consoleMode || '…'}` : '';
  const msg = diag || app.error || app.notice || (app.screen === 'home' && app.launchDir ? '工作文件夹 ' + app.launchDir : app.screen === 'sessions' ? '↑↓ 选择  ←→ 切换分组  Enter 打开  Ctrl+P 置顶  Esc 返回' : hintsRight ? '' : homeHints);
  const mid = clip(msg, Math.max(0, w - lp - width(tag) - width(right) - 2));
  const midColored = app.error ? color(th, 'warn', mid) : app.notice ? color(th, 'ok', mid) : color(th, 'dim', mid);
  return ' '.repeat(lp) + tag + ' ' + pad(midColored, w - lp - width(tag) - width(right) - 1) + rightColored;
}

// Framed input shared by home and chat; cursor offsets include the top border.
// The input box takes the colour of whoever the message is for: an @name in the text, else the default answerer, else the accent.
export function inputTone(app) {
  const m = /@(Claude|Codex|DeepSeek|all)\b/i.exec(app.input), who = (m ? m[1] : answerer(app)).toLowerCase();
  return !who || who === 'all' ? 'accent' : who;
}
function inputBlock(app, w, m = 0) {
  // ↳ instead of ❯ while an assistant is replying in this conversation: what you send now is appended to that turn.
  const th = app.theme(), tone = inputTone(app), live = app.screen !== 'home' && runningIn(app, app.sessions.find(x => x.id === app.sessionId)).size > 0;
  const first = app.input.startsWith('/') ? '⌘ ' : live ? '↳ ' : '❯ ', P = ' '.repeat(m), boxW = w - 2 * m, textW = Math.max(1, boxW - 6), tw = Math.max(1, textW - 1);
  const edge = s => mix(th, tone, 0.3) + s + R;
  const top = P + edge('╭' + '─'.repeat(Math.max(0, boxW - 2)) + '╮');
  const bottom = P + edge('╰' + '─'.repeat(Math.max(0, boxW - 2)) + '╯');
  const rowLine = (text, i = 0) => P + edge('│') + ' ' + color(th, tone, i ? '  ' : first) + pad(text, textW) + ' ' + edge('│');
  // Draft wrapping preserves every character and its UTF-16 offset. Word wrapping for
  // replies intentionally trims spaces, so it cannot map a clicked cell back to input.
  const all = []; let text = '', start = 0, offset = 0;
  for (const ch of app.input) {
    if (ch === '\n') { all.push({ text, start, end: offset }); text = ''; start = offset + 1; }
    else {
      if (text && width(text) + width(ch) > tw) { all.push({ text, start, end: offset }); text = ''; start = offset; }
      text += ch;
    }
    offset += ch.length;
  }
  all.push({ text, start, end: offset });
  const row = all.findLastIndex(l => l.start <= app.cursor), firstRow = Math.max(0, Math.min(all.length - 5, row - 4));
  const visible = all.slice(firstRow, firstRow + 5), col = m + 4 + width(app.input.slice(all[row].start, app.cursor));
  const content = app.input ? visible.map((l, i) => rowLine(mentions(l.text, th), i))
    : [rowLine(color(th, 'dim', clip(live ? '追加一句给正在回复的助手…' : '写点什么…（@ 指定谁来回答）', textW)))];
  return { lines: [top, ...content, bottom], cur: [row - firstRow + 1, col], visible, textX: m + 4, textW };
}

// The rendered layout owns both caret placement and input hit regions (one-based terminal cells).
function placeInput(app, ib, top, left = 0) {
  app.cursorXY = [top + ib.cur[0] + 1, left + ib.cur[1] + 1];
  ib.visible.forEach((line, i) => app.hits.push({ y: top + i + 2, x0: left + ib.textX + 1, x1: left + ib.textX + ib.textW, act: { type: 'input', line } }));
}

function popupLines(app, w, maxLines = 6) {
  const th = app.theme(), pal = paletteItems(app);
  if (pal.length) {
    app.pal = Math.min(app.pal, pal.length - 1);
    const n = Math.max(0, Math.min(6, maxLines, pal.length)), start = Math.max(0, Math.min(app.pal - n + 1, pal.length - n)); // the window follows the selection
    return pal.slice(start, start + n).map((c, i) => {
      const row = ` ${c.name.padEnd(10)} ${clip(c.desc, w - 14)}`;
      return start + i === app.pal ? REV + pad(row, w) + R : color(th, 'dim', row);
    });
  }
  const m = mentionAt(app);
  if (m) return [' ' + color(th, 'dim', 'Tab 补全  ') + m.hits.map(h => color(th, h === 'all' ? 'accent' : h.toLowerCase(), '@' + h)).join('  ')];
  return [];
}

function helpBox(app, w) {
  const th = app.theme(), lines = [BOLD + '快捷键' + R, '', ...KEYS_HELP.flatMap(l => wrap(l, w - 6))];
  return lines.map(l => ' ' + pad(l, w - 2));
}

export function drawFrame(app) {
  if (app.selection?.dragged) return selectionFrame(app.selection);
  app.hits = []; app.hero = null;
  const out = app.screen === 'sessions' ? drawSessions(app) : app.screen === 'call' ? drawCall(app) : app.screen === 'home' ? drawHome(app) : drawChat(app);
  return app.frame = out.map(l => cut(l, app.cols)); // narrow terminals: never let a line wrap
}

// Old-television pass over the finished frame. The input box and the status bar stay untouched so typing is always crisp.
export function crtLines(app, frame) {
  if (app.selection?.dragged) return frame;
  if (!app.crt || app.screen !== 'home') return frame;
  const inputs = app.hits.filter(h => h.act.type === 'input').map(h => h.y - 1), protect = new Set([frame.length - 1]);
  if (inputs.length) for (let y = Math.min(...inputs) - 1; y <= Math.max(...inputs) + 1; y++) protect.add(y);
  const booted = app.crtBoot == null || app.now - app.crtBoot >= 560;
  if (booted && app.screen === 'home' && /\S/.test(strip(frame[0] || ''))) protect.add(0); // the date tab keeps its own colours (after power-on)
  if (app.hero) for (let y = app.hero.top; y < app.hero.top + app.hero.L.cellsH; y++) protect.add(y); // the picture owns these cells
  return crtFrame(frame, app.cols, { now: app.now, themeKey: app.themeKey, theme: app.theme(), full: app.screen === 'home', protect, boot: app.crtBoot == null ? Infinity : app.now - app.crtBoot });
}

export function capacityLabels(app) {
  const q = app.usage?.quota || {};
  const limits = q.codex?.limits, buckets = limits?.rateLimitsByLimitId || { codex: limits?.rateLimits };
  const codex = Object.values(buckets).flatMap(b => ['primary', 'secondary'].map(k => b?.[k]?.usedPercent)).filter(Number.isFinite).map(v => Math.max(0, 100 - v));
  const claude = (q.claude?.windows || []).filter(w => !w.resets_at || Date.parse(w.resets_at) > app.now).map(w => w.remaining_percent).filter(Number.isFinite);
  const pct = values => values.length ? Math.round(Math.min(...values)) + '%' : '—';
  const infos = q.deepseek?.balance_infos || [], funded = infos.filter(b => Number(b.total_balance) > 0); // a currency at zero is noise next to a funded one
  const balance = (funded.length ? funded : infos).map(b => (b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : b.currency + ' ') + b.total_balance).join(' / ');
  const live = w => (w && !(w.resets_at && Date.parse(w.resets_at) <= app.now)) ? w.remaining_percent : 100; // a passed reset means the window started over
  const cc = q.commandcode?.five_hour && q.commandcode?.weekly ? [q.commandcode.five_hour, q.commandcode.weekly].map(w => live(w)) : null;
  return [
    { who: 'claude', text: 'Claude 剩余 ' + pct(claude) },
    { who: 'codex', text: 'Codex 剩余 ' + pct(codex) },
    q.deepseek_provider === 'commandcode' ? { who: 'deepseek', text: 'DeepSeek 剩余 ' + (cc ? Math.min(...cc) + '%' : '—') }
      : { who: 'deepseek', text: 'DeepSeek ' + (q.deepseek?.error && balance ? '上次余额 ' : '余额 ') + (balance || '—') },
  ];
}

// A small tab in the top-left corner of the home screen: accent bar, today's date and weekday on a panel, then a quip that changes daily.
const QUIPS = ['今天也要和 reviewer 2 和平共处', '数据不会骗人，只会让人心碎', '能跑就别动，能跑通才叫科研', '离毕业又近了一个 commit', '咖啡因含量：待补充', '拟合不好，先怪仪器', '先存盘，再自信', '显示器亮着，不等于在工作', '组会前的最后一杯咖啡', '这个 bug 是特性的早期形态', '图不好看？加个置信区间', '导师说“简单看看”的时候，别信', '没有噪声的数据，多半是编的', '再跑一遍，万一这次不一样呢', '参考文献比正文先写完才是真本事'];
const FRIDAY_QUIPS = ['周五不改代码，周五只祈祷', '周五了，今天的 deadline 是下周', '周五的 git push，周一的冷汗'];
export function quipOf(d) {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); // stable all day, new one tomorrow
  return d.getDay() === 5 && day % 2 === 0 ? FRIDAY_QUIPS[Math.floor(day / 2) % FRIDAY_QUIPS.length] : QUIPS[day % QUIPS.length];
}
export function dateTab(app, th, withQuip = true) {
  const d = new Date(app.now), pad2 = n => String(n).padStart(2, '0'), text = ` ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}  周${'日一二三四五六'[d.getDay()]} `;
  return color(th, 'accent', '▌') + bgc(th.band) + color(th, 'user', text).replace(/\x1b\[0m$/, '') + R + (withQuip ? '  ' + color(th, 'dim', quipOf(d)) : '');
}

function drawHome(app) {
  const { cols, rows } = app, th = app.theme(), w = Math.min(cols, 100), pad0 = ' '.repeat(Math.floor((cols - w) / 2));
  const ib = inputBlock(app, w);
  const capacities = capacityLabels(app), together = capacities.map(c => color(th, c.who, c.text)).join(color(th, 'dim', '   ·   '));
  const centre = l => ' '.repeat(Math.max(0, Math.floor((w - width(l)) / 2))) + l; // the quota line sits in the middle of the block, under the picture
  const capacityRows = (width(together) <= w ? [together] : capacities.flatMap(c => wrap(c.text, w).map(l => color(th, c.who, l)))).map(centre);
  const gapA = rows >= 28 ? 2 : rows >= 16 ? 1 : 0, gapB = rows >= 40 ? 2 : rows >= 16 ? 1 : 0; // spacer rows under the picture and under the quota line
  const avail = rows - 1 - ib.lines.length - capacityRows.length - (rows >= 16 ? 1 : 0) - gapA - gapB; // 1 = the date tab's row
  const maxRows = rows >= 16 ? Math.max(1, Math.floor(avail * 0.8)) : avail; // the mascot and logo take about 80% of the free height; the extra room stays as air
  // Sixel terminals get the hero as one true-pixel picture drawn over blank rows; everything else gets the character-cell logo.
  const heroL = app.img?.sixel && !app.sixelOff && app.img.cw > 0 ? heroLayout({ cols, maxRows, cw: app.img.cw, ch: app.img.ch }) : null;
  const logo = heroL ? Array(heroL.cellsH).fill('') : logoLines(th, cols, { now: app.now, maxRows }), block = [];
  logo.forEach(l => block.push(l)); for (let i = 0; i < gapA; i++) block.push('');
  block.push(...capacityRows);
  for (let i = 0; i < gapB; i++) block.push('');
  const helpLines = app.helpOpen ? ['', ...helpBox(app, w)] : [], head = block.length + ib.lines.length;
  // The block is centred as if the command list (up to 6 rows) were always there, so typing "/" or "@" never moves the picture.
  const top = Math.max(rows >= 16 ? 1 : 0, Math.floor((rows - 1 - head - helpLines.length - (rows >= 20 ? 6 : 0)) / 2));
  const popup = popupLines(app, w, Math.max(0, rows - 1 - top - head)).slice(0, Math.max(0, rows - 1 - top - head)); // shorter windows show fewer rows, scrolled to the selection
  const inputTop = block.length; ib.lines.forEach(l => block.push(l));
  popup.forEach(l => block.push(l));
  block.push(...helpLines);
  const out = [];
  for (let i = 0; i < rows - 1; i++) out.push(i >= top && block[i - top] !== undefined ? (i - top < logo.length ? '' : pad0) + block[i - top] : '');
  out.push(statusBar(app, cols));
  if (top > 0 && rows >= 16) out[0] = ' ' + dateTab(app, th); // top-left corner, on the empty first row
  placeInput(app, ib, top + inputTop, Math.floor((cols - w) / 2));
  if (heroL) app.hero = { L: heroL, top, left: Math.max(0, Math.floor((cols - heroL.cellsW) / 2)) };
  return out;
}

function drawChat(app) {
  const { cols, rows } = app, th = app.theme();
  const panelW = app.panel && cols >= 100 ? (cols >= 150 ? 44 : 38) : 0, mainW = cols - (panelW ? panelW + 1 : 0);
  const M = mainW >= 60 ? 2 : 1, pad0 = ' '.repeat(M); // breathing room at the left and right edge
  const cur = app.sessions.find(x => x.id === app.sessionId), running = runningIn(app, cur);
  const ib = inputBlock(app, mainW, M), popup = popupLines(app, mainW);
  const gap = rows >= 24 ? 1 : 0; // one empty row under the header when the window is tall enough
  const bodyH = Math.max(1, rows - 2 - gap - popup.length - ib.lines.length);

  let reveal = null;
  if (app.reveal) {
    const dur = Math.min(2500, Math.max(600, app.reveal.total / 150 * 1000)), f = (app.now - app.reveal.t0) / dur;
    if (f >= 1) app.reveal = null; else reveal = { key: app.reveal.key, chars: Math.floor(f * app.reveal.total) };
  }
  const tools = app.executions.filter(e => e.status === 'running' && e.session_id === app.sessionId).map(e => ({ provider: e.provider, name: e.name, summary: e.summary }));
  const bodyW = mainW - 1; // last column is the scrollbar
  const lines = conversationLines(app.detail?.id === app.sessionId ? app.detail : null, bodyW, th, { running, now: app.now, tick: app.tick, tools, reveal, margin: M });
  const maxScroll = Math.max(0, lines.length - bodyH);
  app.scroll = Math.min(Math.max(0, app.scroll), maxScroll);
  const end = lines.length - app.scroll, shown = lines.slice(Math.max(0, end - bodyH), end);
  while (shown.length < bodyH) shown.unshift('');
  // Scrollbar: thumb size = visible share, position = how far from the bottom we are.
  const thumb = Math.max(1, Math.round(bodyH * Math.min(1, bodyH / Math.max(1, lines.length)))), top = maxScroll ? Math.round((maxScroll - app.scroll) / maxScroll * (bodyH - thumb)) : bodyH - thumb;
  for (let i = 0; i < shown.length; i++) {
    let row = pad(shown[i], bodyW);
    if (app.scroll && i === shown.length - 1) { // clickable "back to bottom" pill on the last body row
      const label = ' ↓ 回到底部 ', pw = width(label);
      row = pad(cut(row, bodyW - pw - M), bodyW - pw - M) + REV + label + R + pad0.slice(0, M);
      app.hits.push({ y: 1 + gap + bodyH, x0: bodyW - pw - M + 1, x1: bodyW - M, act: { type: 'bottom' } });
    }
    shown[i] = row + (maxScroll ? (i >= top && i < top + thumb ? color(th, 'accent', '┃') : color(th, 'dim', '│')) : ' ');
  }

  const folder = app.sessionId ? cur?.workdir : app.launchDir;
  const proj = (cur?.project_ids?.[0] ? ' · ' + projectName(app, cur.project_ids[0]) : '') + (folder ? ' · ▣ ' + folderName(folder) : '');
  const left = pad0 + color(th, 'accent', '⌸ ') + BOLD + clip(cur?.title || '新对话', mainW - 2 * M - 8 - width(proj)) + R + color(th, 'dim', proj);
  app.hits.push({ y: 1, x0: M + 1, x1: M + 3, act: { type: 'sessions' } });
  const head = app.scroll ? join(left, color(th, 'dim', `↑ ${app.scroll} 行 · End 回到底部 `), mainW) : left;

  const main = [head, ...(gap ? [''] : []), ...shown, ...popup];
  const inputTop = main.length; ib.lines.forEach(l => main.push(l));
  const panel = panelW ? statusPanel(app, panelW, rows - 1) : [];
  for (const r of panel.callRows || []) app.hits.push({ y: r.line + 1, x0: mainW + 2, x1: cols, act: { type: 'call', i: r.i } });
  const out = [];
  for (let i = 0; i < rows - 1; i++) {
    let l = pad(main[i] ?? '', mainW);
    if (panelW) l += (maxScroll ? ' ' : color(th, 'dim', '│')) + pad(panel[i] ?? '', panelW); // the scrollbar already draws a divider when it is visible
    out.push(l);
  }
  out.push(statusBar(app, cols));
  if (app.helpOpen) {
    const hb = helpBox(app, Math.min(mainW, 90)); hb.forEach((l, i) => { out[2 + i] = pad(REV + l + R, mainW) + (out[2 + i] ? '' : ''); });
  }
  placeInput(app, ib, inputTop);
  return out;
}

// Right-hand panel (Ctrl+B): what the assistants did in this conversation - sub-agents, files touched, recent tool calls, context use.
function statusPanel(app, w, h) {
  const cur = app.sessions.find(x => x.id === app.sessionId);
  return activityPanel({
    summary: cur ? app.calls : null, runs: app.detail?.id === app.sessionId ? app.detail.subagent_runs || [] : [],
    active: new Set(app.active.map(t => t.task_id)), context: currentContext(app), now: app.now, tick: app.tick,
  }, w, h, app.theme());
}

// ---- Sessions screen -----------------------------------------------------------------------------------------------
export function railItems(app) {
  const items = [{ key: 'all', label: '全部', n: app.sessions.length }, { key: 'pin', label: '置顶', n: app.sessions.filter(s => s.pinned).length }];
  for (const p of app.projects) items.push({ key: 'p:' + p.id, label: p.name, n: app.sessions.filter(s => (s.project_ids || []).includes(p.id)).length });
  items.push({ key: 'none', label: '无项目', n: app.sessions.filter(s => !(s.project_ids || []).length).length });
  return items;
}

export function listItems(app) {
  const sw = app.sw, rail = railItems(app)[sw.rail]?.key || 'all', k = sw.q.trim().toLowerCase();
  let list = app.sessions.filter(s => rail === 'all' || (rail === 'pin' ? s.pinned : rail === 'none' ? !(s.project_ids || []).length : (s.project_ids || []).includes(rail.slice(2))));
  if (k) list = list.filter(s => (s.title || '').toLowerCase().includes(k) || (s.preview || '').toLowerCase().includes(k));
  const rows = list.map(s => ({ id: s.id, s }));
  if (k && rail === 'all') for (const e of sw.extra) if (!rows.some(r => r.id === e.id)) rows.push({ id: e.id, s: { id: e.id, title: e.title }, snippet: e.snippet });
  return rows;
}

function drawSessions(app) {
  const { cols, rows } = app, th = app.theme(), sw = app.sw, railW = Math.min(24, Math.floor(cols * 0.3));
  const rail = railItems(app), items = listItems(app), listW = cols - railW - 1, H = rows - 4;
  sw.sel = Math.max(0, Math.min(sw.sel, items.length)); // row 0 = new conversation card
  const head = join(color(th, 'accent', '⌸ ') + BOLD + '对话与项目' + R, color(th, 'dim', 'Esc 返回 '), cols);
  const filter = color(th, 'accent', '› ') + (sw.q || color(th, 'dim', '输入筛选，也会搜索历史全文'));
  const out = [head, filter, rule(cols, th)];
  const start = Math.max(0, Math.min(sw.sel - Math.floor(H / 2), items.length + 1 - H));
  for (let i = 0; i < H; i++) {
    const r = rail[i];
    let left = '';
    if (r) {
      const on = i === sw.rail, label = `${r.label}`, n = String(r.n);
      const row = ` ${clip(label, railW - 3 - n.length)}`, cell = pad(row, railW - n.length - 1) + color(th, 'dim', n) + ' ';
      left = on ? (sw.focus === 'rail' ? REV + strip(cell) + R : BOLD + color(th, 'accent', strip(cell)) + R) : cell;
      app.hits.push({ y: 4 + i, x0: 1, x1: railW, act: { type: 'rail', i } });
    }
    const idx = start + i; let right = '';
    if (idx === 0) {
      right = (sw.sel === 0 && sw.focus === 'list' ? REV : '') + pad(color(th, 'accent', ' ＋ ') + '新对话', listW) + R;
      app.hits.push({ y: 4 + i, x0: railW + 2, x1: cols, act: { type: 'new' } });
    }
    else {
      const it = items[idx - 1];
      if (it) {
        const meta = it.snippet ? clip(it.snippet, 24) : [(it.s.project_ids || []).length ? clip(projectName(app, it.s.project_ids[0]), 12) : '', ago(it.s.last_at, app.now)].filter(Boolean).join(' · ');
        right = sessionRow(it.s, listW, th, { selected: sw.sel === idx && sw.focus === 'list', unread: isUnread(it.s, app.readAt), running: isRunning(app, it.s), meta });
        app.hits.push({ y: 4 + i, x0: railW + 2, x1: cols, act: { type: 'open', id: it.id } });
      }
    }
    out.push(pad(left, railW) + color(th, 'dim', '│') + right);
  }
  out.push(statusBar(app, cols));
  app.cursorXY = [2, 3 + width(sw.q)];
  return out;
}

// ---- Actions -------------------------------------------------------------------------------------------------------
export async function refresh(app) {
  const { sessionId, navigation } = app;
  try {
    const data = await api.getState(sessionId);
    if (app.sessionId !== sessionId || app.navigation !== navigation) return;
    applyState(app, data); app.error = '';
  } catch (e) { app.error = '读取失败：' + e.message; return; }
  await refreshCalls(app);
}

// Tool calls of the open conversation (last four turns), from the turns' event logs; only while the panel is shown.
export async function refreshCalls(app, force = false) {
  const s = app.sessions.find(x => x.id === app.sessionId);
  if (!s || !(app.panel || force || app.screen === 'call')) { app.calls = null; app.callsRaw = []; return; }
  try { app.callsRaw = await loadSessionCalls(root, (s.task_ids || []).slice(-4), app.callCache); app.calls = summarizeCalls(app.callsRaw, root); }
  catch (e) { app.error = '读取调用记录失败：' + e.message; }
}

export async function openSession(app, id) {
  app.navigation++;
  app.sessionId = id; app.detail = null; app.scroll = 0; app.screen = 'chat'; app.sw = null;
  await refresh(app);
  api.markRead({ [id]: Date.now() }).then(r => Object.assign(app.readAt, r)).catch(() => {});
  savePrefs(app);
}

const newConversation = app => { app.navigation++; app.sessionId = null; app.detail = null; app.scroll = 0; app.screen = 'home'; app.sw = null; };

// What the backend did with a message sent while an assistant is replying.
const DELIVERY = { steered: '已追加给正在回复的助手', pending: '已追加给正在回复的助手', queued: '已排队，当前回合结束后处理' };

export async function submit(app) {
  let text = app.input.trim(); if (!text) return;
  const isCommand = text.startsWith('/');
  if (!isCommand && app.sending) { app.notice = '上一条仍在发送，草稿已保留'; return; }
  snap(app, 'send', true); // Ctrl+Z brings the sent text back into the box
  app.history.push(text); app.histIdx = -1; app.input = ''; app.cursor = 0;
  if (isCommand) return command(app, text);
  const draft = text, { sessionId, screen, navigation, target } = app;
  const sameView = () => app.sessionId === sessionId && app.screen === screen && app.navigation === navigation;
  if (app.target && !/@(claude|codex|deepseek|all)\b/i.test(text)) text = `@${app.target} ${text}`;
  app.sending = true; app.scroll = 0; app.notice = '发送中…'; app.error = ''; app.dirty?.();
  try {
    const fresh = screen === 'home' || !sessionId;
    const job = await api.sendChat({ text, session_id: fresh ? null : sessionId, project_id: app.projectId, workdir: fresh ? app.launchDir : undefined });
    app.notice = DELIVERY[job.delivery] || '已发送'; app.error = '';
    if (sameView()) {
      if (app.target === target) app.target = ''; // do not erase a new next-message override
      app.sessionId = job.session_id; app.screen = 'chat'; app.dirty?.();
      await refresh(app); savePrefs(app);
    }
  } catch (e) {
    app.notice = ''; app.error = '发送失败：' + e.message;
    if (sameView() && !app.input) { snap(app, 'restore', true); app.input = draft; app.cursor = draft.length; }
    else app.error += '（原文可用 Ctrl+P 从历史取回）';
  } finally { app.sending = false; app.dirty?.(); }
}

async function command(app, text) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/), arg = rest.join(' ');
  if (cmd === 'new') newConversation(app);
  else if (cmd === 'sessions' || cmd === 'search' || cmd === 's') openSessions(app, arg);
  else if (cmd === 'pin') { const s = app.sessions.find(x => x.id === app.sessionId); if (s) { await api.pin(s.id, !s.pinned); await refresh(app); app.notice = s.pinned ? '已取消置顶' : '已置顶'; } }
  else if (cmd === 'theme') cycleTheme(app);
  else if (cmd === 'who') setTarget(app, MENTIONS.find(m => m.toLowerCase() === arg.toLowerCase()) || '');
  else if (cmd === 'mouse') toggleMouse(app);
  else if (cmd === 'sixel') { app.sixelOff = !app.sixelOff; app.notice = app.img?.sixel ? (app.sixelOff ? '首页真像素图：关（用字符画）' : '首页真像素图：开') : '这个终端没有报告支持 sixel，仍用字符画'; savePrefs(app); }
  else if (cmd === 'crt') { app.crt = !app.crt; app.notice = app.crt ? '老电视效果：开' : '老电视效果：关'; savePrefs(app); }
  else if (cmd === 'project') { app.projectId = arg || null; app.notice = app.projectId ? '本次对话关联项目 ' + app.projectId : '已取消项目关联'; }
  else if (cmd === 'panel') { app.panel = !app.panel; savePrefs(app); await refreshCalls(app); }
  else if (cmd === 'reload') await reloadBackend(app);
  else if (cmd === 'stop') await stopRunning(app);
  else if (cmd === 'calls') await openCall(app);
  else if (cmd === 'keys') { app.debugKeys = !app.debugKeys; app.rawCount = app.mouseCount = 0; app.rawLast = ''; if (app.debugKeys) probeConsole(app); }
  else if (cmd === 'help') app.helpOpen = true;
  else if (cmd === 'q' || cmd === 'quit') process.emit('tui-quit');
  else app.error = `未知命令 /${cmd}`;
}

// Uses the office's installed Python to call Win32 directly on the inherited console.
// No PowerShell script, trust prompt or execution-policy override is involved.
function consoleScript(...flags) {
  if (process.platform !== 'win32') return '';
  const r = spawnSync('python', [path.join(root, 'tui', 'console-mode.py'), ...flags], { stdio: ['inherit', 'pipe', 'ignore'], timeout: 15000 });
  return (r.stdout || '').toString().trim();
}

// /keys also reads the console input mode (Windows) so "no mouse events" can be told apart from "console not in VT input mode".
function probeConsole(app, ...flags) {
  if (process.platform !== 'win32') return;
  const child = spawn('python', [path.join(root, 'tui', 'console-mode.py'), ...flags], { stdio: ['inherit', 'pipe', 'ignore'] });
  let text = ''; child.stdout.on('data', d => { text += d; });
  child.on('close', () => { app.consoleMode = text.trim() || '未知'; app.dirty?.(); });
  setTimeout(() => child.kill(), 15000).unref();
}

// /reload: ask the backend to restart itself (it refuses while assistants are running), then wait until it answers with a new start time.
export async function reloadBackend(app, { wait = 1500, limit = 90000 } = {}) {
  const before = await api.health().catch(() => null);
  try { await api.restartBackend(); } catch (e) { app.error = '重启被拒绝：' + e.message; return; }
  app.notice = '后端重启中…'; app.error = '';
  const t0 = Date.now();
  const watch = async () => {
    while (Date.now() - t0 < limit) {
      await new Promise(r => setTimeout(r, wait));
      const h = await api.health().catch(() => null);
      if (h?.started_at && h.started_at !== before?.started_at) { app.notice = '后端已重启，代码已更新'; await refresh(app); app.dirty?.(); return; }
    }
    app.error = '后端 90 秒内没有恢复，请看一下 Workbench'; app.dirty?.();
  };
  void watch();
}

export function cycleTheme(app) {
  const keys = Object.keys(THEMES); app.themeKey = keys[(keys.indexOf(app.themeKey) + 1) % keys.length];
  app.notice = '主题：' + THEMES[app.themeKey].name; savePrefs(app);
}
function setTarget(app, t) { app.target = t; app.notice = t ? `下一条回答者：${t}` : '自动跟随上一位回复者'; }

export const MOUSE_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h';
function toggleMouse(app) {
  app.mouseCapture = !app.mouseCapture;
  app.notice = app.mouseCapture ? '拖选后 Ctrl+C 复制；滚轮/点击已开；Alt+M 切换原生拖选' : '可原生拖选文本；Alt+M 恢复拖选/滚轮/点击';
  app.syncMouse?.();
}
export function openSessions(app, q = '') { app.sw = { q, rail: 0, focus: 'list', sel: 0, extra: [] }; app.prevScreen = app.screen === 'sessions' ? app.prevScreen : app.screen; app.screen = 'sessions'; scheduleSearch(app); }

function scheduleSearch(app) {
  const sw = app.sw; clearTimeout(sw.timer);
  if (sw.q.trim().length < 2) { sw.extra = []; return; }
  sw.timer = setTimeout(async () => {
    try {
      const r = await api.search(sw.q.trim(), 8);
      if (app.sw === sw) { sw.extra = (r.rows || []).map(row => ({ id: row.id, title: row.title || '未命名对话', snippet: row.snippets?.[0]?.text?.replace(/\s+/g, ' ') })); app.dirty?.(); }
    } catch { /* the local list stays usable */ }
  }, 350);
}

// Ctrl+X / /stop: ask the backend to stop the turn that is running in this conversation.
export async function stopRunning(app) {
  const ids = new Set(app.sessions.find(x => x.id === app.sessionId)?.task_ids || []), turns = app.active.filter(t => ids.has(t.task_id));
  if (!turns.length) { app.notice = '这个对话里没有正在运行的助手'; return; }
  try { await Promise.all(turns.map(t => api.stop(t.task_id))); app.notice = `已请求停止 ${turns.map(t => PROVIDERS[t.provider] || t.provider).join('、')}`; app.error = ''; }
  catch (e) { app.error = '停止失败：' + e.message; }
}

// ---- Call detail screen: click a call in the panel, or Ctrl+O for the latest one ----
export async function openCall(app, i) {
  if (!app.callsRaw?.length) await refreshCalls(app, true);
  const n = app.callsRaw?.length || 0;
  if (!n) { app.notice = '这个对话还没有工具调用记录'; return; }
  app.callView = { i: Math.min(Math.max(0, i ?? n - 1), n - 1), scroll: 0 }; app.prevScreen = 'chat'; app.screen = 'call';
}

function drawCall(app) {
  const { cols, rows } = app, th = app.theme(), cv = app.callView, raw = app.callsRaw;
  cv.i = Math.min(Math.max(0, cv.i), Math.max(0, raw.length - 1));
  const lines = raw.length ? callDetailLines(raw[cv.i], root, cols - 2, th, cv.i + 1, raw.length) : [];
  const H = rows - 3, maxScroll = Math.max(0, lines.length - H);
  cv.scroll = Math.min(Math.max(0, cv.scroll), maxScroll);
  const out = [join(color(th, 'accent', ' ⌸ ') + BOLD + '工具调用详情' + R, color(th, 'dim', 'Esc 返回 '), cols), rule(cols, th)];
  for (let i = 0; i < H; i++) out.push(lines[cv.scroll + i] ?? '');
  out.push(color(th, 'dim', ' ↑↓ 上一条 / 下一条   PgUp PgDn 滚动' + (maxScroll ? `   (${cv.scroll + 1}-${Math.min(lines.length, cv.scroll + H)}/${lines.length} 行)` : '')));
  out.push(statusBar(app, cols));
  app.cursorXY = [rows, 1];
  return out;
}

async function callKey(app, k) {
  const cv = app.callView, n = app.callsRaw?.length || 0, H = Math.max(1, app.rows - 4);
  if (k.key === 'escape' || k.key === 'enter' || (k.ctrl && k.ch === 'c')) { app.screen = 'chat'; return; }
  if (k.key === 'up') { cv.i = Math.max(0, cv.i - 1); cv.scroll = 0; return; }
  if (k.key === 'down') { cv.i = Math.min(n - 1, cv.i + 1); cv.scroll = 0; return; }
  if (k.key === 'pageup') { cv.scroll = Math.max(0, cv.scroll - (H - 2)); return; }
  if (k.key === 'pagedown') { cv.scroll += H - 2; return; }
  if (k.key === 'home') { cv.scroll = 0; return; }
  if (k.key === 'end') cv.scroll = 1e9;
}

// ---- Keys ----------------------------------------------------------------------------------------------------------
function historyStep(app, d) {
  if (!app.history.length) return;
  if (d < 0) app.histIdx = app.histIdx < 0 ? app.history.length - 1 : Math.max(0, app.histIdx - 1);
  else if (app.histIdx >= 0) { app.histIdx++; if (app.histIdx >= app.history.length) app.histIdx = -1; } else return;
  snap(app, 'hist', true);
  app.input = app.histIdx < 0 ? '' : app.history[app.histIdx]; app.cursor = app.input.length;
}

// The runtime supplies native Windows clipboard I/O; other terminals use OSC 52.
function copyText(app, text) {
  if (app.writeClipboard) app.writeClipboard(text);
  else app.osc += `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}
export function copyLastReply(app) {
  const m = [...(app.detail?.messages || [])].reverse().find(x => x.role === 'assistant' && x.text);
  if (!m) { app.error = '当前对话还没有助手回复可复制'; return; }
  copyText(app, m.text);
  app.notice = `已复制 ${PROVIDERS[m.provider] || '助手'} 的回复（${[...m.text].length} 字）`;
}

// Undo for the input box. Typing runs are grouped (a pause or a different kind of edit starts a new step).
export function snap(app, kind, always = false) {
  const t = Date.now();
  if (always || kind !== app.lastKind || t - app.lastEditAt > 800) {
    app.undo.push({ input: app.input, cursor: app.cursor }); if (app.undo.length > 100) app.undo.shift();
  }
  app.lastKind = kind; app.lastEditAt = t; app.redo = [];
}
export function undoInput(app, redo = false) {
  const from = redo ? app.redo : app.undo, to = redo ? app.undo : app.redo, s = from.pop();
  if (!s) { app.notice = redo ? '没有可重做的内容' : '没有可撤销的内容'; return; }
  to.push({ input: app.input, cursor: app.cursor });
  app.input = s.input; app.cursor = Math.min(s.cursor, s.input.length); app.lastKind = ''; app.notice = redo ? '已重做' : '已撤销';
}

function insert(app, text) { snap(app, text.length > 1 ? 'paste' : 'type'); app.input = app.input.slice(0, app.cursor) + text + app.input.slice(app.cursor); app.cursor += text.length; app.pal = 0; }

export async function onKey(app, k) {
  app.notice = k.key === 'char' || k.key === 'paste' ? '' : app.notice;
  if (k.key === 'mouse') return onMouse(app, k.mouse);
  if (app.selection?.dragged && k.ctrl && k.ch === 'c') {
    const text = selectionText(app.selection);
    try { copyText(app, text); app.notice = `已复制选区（${[...text].length} 字）`; app.error = ''; app.selection = null; }
    catch (e) { app.error = '复制失败：' + e.message; }
    return;
  }
  const selected = app.selection?.dragged;
  app.selection = null;
  if (selected && k.key === 'escape') return;
  if (app.helpOpen && (k.key === 'escape' || k.key === 'enter')) { app.helpOpen = false; return; }
  if (app.screen === 'sessions') return sessionsKey(app, k);
  if (app.screen === 'call') return callKey(app, k);
  const body = Math.max(1, app.rows - 6), pal = paletteItems(app);

  if (k.alt && k.key === 'char') {
    if (k.ch === 'm') return toggleMouse(app);
    if ('1234'.includes(k.ch)) return setTarget(app, MENTIONS[Number(k.ch) - 1]);
    if (k.ch === '0') return setTarget(app, '');
    if (k.ch === 'z') return undoInput(app, true);
    if (k.ch === 'r') { const s = app.sessions[0]; if (s) await openSession(app, s.id); return; }
  }
  if (k.ctrl && k.key === 'char') {
    switch (k.ch) {
      case 'c': process.emit('tui-quit'); return;
      case 'k': openSessions(app); return;
      case 'b': app.panel = !app.panel; savePrefs(app); void refreshCalls(app).then(() => app.dirty?.()); return;
      case 'n': newConversation(app); return;
      case 't': cycleTheme(app); return;
      case 'j': insert(app, '\n'); return;
      case 'z': return undoInput(app);
      case 'u': snap(app, 'cut', true); app.input = app.input.slice(app.cursor); app.cursor = 0; return;
      case 'w': { snap(app, 'cut', true); const head = app.input.slice(0, app.cursor).replace(/\S+\s*$/, ''); app.input = head + app.input.slice(app.cursor); app.cursor = head.length; return; }
      case 'a': app.cursor = 0; return;
      case 'e': app.cursor = app.input.length; return;
      case 'p': return historyStep(app, -1);
      case 'y': return copyLastReply(app);
      case 'x': return stopRunning(app);
      case 'o': return openCall(app);
      default: return;
    }
  }
  switch (k.key) {
    case 'ctrl-j': insert(app, '\n'); return;
    case 'enter':
      if (k.alt) { insert(app, '\n'); return; }
      if (pal.length && app.input !== pal[app.pal].name) { const c = pal[app.pal]; app.input = c.name + (c.arg ? ' ' : ''); app.cursor = app.input.length; if (c.arg) return; }
      // Slash commands retain their sequencing; chat transport must not hold typing or scrolling.
      if (app.input.trim().startsWith('/')) await submit(app);
      else void submit(app);
      return;
    case 'char':
      if (k.ch === '?' && !app.input) { app.helpOpen = true; return; }
      insert(app, k.ch); return;
    case 'paste': insert(app, k.text); return;
    case 'backspace': if (app.cursor) { snap(app, 'del'); const prev = [...app.input.slice(0, app.cursor)].slice(0, -1).join(''); app.input = prev + app.input.slice(app.cursor); app.cursor = prev.length; app.pal = 0; } return;
    case 'delete': { snap(app, 'del'); const rest = [...app.input.slice(app.cursor)]; rest.shift(); app.input = app.input.slice(0, app.cursor) + rest.join(''); return; }
    case 'left': app.cursor = Math.max(0, app.cursor - ([...app.input.slice(0, app.cursor)].pop()?.length || 1)); return;
    case 'right': app.cursor = Math.min(app.input.length, app.cursor + ([...app.input.slice(app.cursor)][0]?.length || 1)); return;
    case 'home': app.cursor = 0; return;
    case 'end': app.cursor = app.input.length; app.scroll = 0; return;
    case 'tab': {
      if (pal.length) { const c = pal[app.pal]; app.input = c.name + (c.arg ? ' ' : ''); app.cursor = app.input.length; return; }
      const m = mentionAt(app); if (m) insert(app, m.hits[0].slice(m.prefix.length) + ' ');
      return;
    }
    case 'pageup': app.scroll += body - 2; return;
    case 'pagedown': app.scroll = Math.max(0, app.scroll - (body - 2)); return;
    // Up/Down scroll the transcript (the terminal turns the mouse wheel into these keys); input history is Alt+Up / Alt+Down.
    case 'up':
      if (pal.length) { app.pal = Math.max(0, app.pal - 1); return; }
      if (k.alt) return historyStep(app, -1);
      app.scroll += 2; return;
    case 'down':
      if (pal.length) { app.pal = Math.min(pal.length - 1, app.pal + 1); return; }
      if (k.alt) return historyStep(app, 1);
      app.scroll = Math.max(0, app.scroll - 2); return;
    case 'escape':
      app.error = '';
      if (app.input) { app.input = ''; app.cursor = 0; } else openSessions(app);
      return;
    default:
  }
}

async function sessionsKey(app, k) {
  const sw = app.sw, rail = railItems(app), items = listItems(app);
  const back = () => { app.screen = app.prevScreen === 'sessions' ? 'home' : app.prevScreen; if (app.screen === 'chat' && !app.sessionId) app.screen = 'home'; app.sw = null; };
  if (k.key === 'escape') return back();
  if (k.key === 'enter') {
    if (sw.focus === 'rail') { sw.focus = 'list'; sw.sel = 0; return; }
    if (sw.sel === 0) { newConversation(app); return; }
    const it = items[sw.sel - 1]; if (it) await openSession(app, it.id); return;
  }
  if (k.ctrl && k.key === 'char') {
    if (k.ch === 'c') return back();
    if (k.ch === 'n') { newConversation(app); return; }
    if (k.ch === 'p') { const it = items[sw.sel - 1]; if (it) { await api.pin(it.id, !it.s.pinned); await refresh(app); } return; }
    if (k.ch === 't') return cycleTheme(app);
    return;
  }
  if (k.key === 'up') { if (sw.focus === 'rail') sw.rail = Math.max(0, sw.rail - 1); else sw.sel = Math.max(0, sw.sel - 1); return; }
  if (k.key === 'down') { if (sw.focus === 'rail') sw.rail = Math.min(rail.length - 1, sw.rail + 1); else sw.sel = Math.min(items.length, sw.sel + 1); return; }
  if (k.key === 'left') { sw.focus = 'rail'; return; }
  if (k.key === 'right' || k.key === 'tab') { sw.focus = 'list'; return; }
  if (k.key === 'pageup') { sw.sel = Math.max(0, sw.sel - 10); return; }
  if (k.key === 'pagedown') { sw.sel = Math.min(items.length, sw.sel + 10); return; }
  if (k.key === 'backspace') sw.q = [...sw.q].slice(0, -1).join('');
  else if (k.key === 'char' && !k.ctrl && !k.alt) sw.q += k.ch;
  else if (k.key === 'paste') sw.q += k.text.replace(/\s+/g, ' ');
  else return;
  sw.sel = 0; sw.focus = 'list'; scheduleSearch(app);
}

async function onMouse(app, m) {
  if (!app.mouseCapture) return;
  if (m.wheel) {
    app.selection = null;
    if (app.screen === 'call') { app.callView.scroll = Math.max(0, app.callView.scroll + (m.wheel === 'up' ? -3 : 3)); return; }
    if (app.screen === 'sessions') { const n = listItems(app).length; app.sw.sel = Math.max(0, Math.min(n, app.sw.sel + (m.wheel === 'up' ? -3 : 3))); }
    else app.scroll = Math.max(0, app.scroll + (m.wheel === 'up' ? 3 : -3));
    return;
  }
  if (m.motion) { if (m.button === 0) moveSelection(app, m); return; }
  if (!m.down) {
    const s = app.selection;
    if (!s?.down || (m.button !== 0 && m.button !== 3)) return;
    moveSelection(app, m); s.down = false;
    if (s.dragged) return;
    app.selection = null;
    if (s.hit && s.hit.act.type !== 'input') await activateHit(app, s.hit, m);
    return;
  }
  if (m.button !== 0) return;
  const hit = app.hits.find(h => h.y === m.y && m.x >= h.x0 && m.x <= h.x1);
  const point = { x: m.x, y: m.y };
  app.selection = { anchor: point, end: point, down: true, dragged: false, frame: app.frame, hit };
  // Input caret follows a single press immediately; links activate on release,
  // so dragging their text does not navigate away.
  if (hit?.act.type === 'input') await activateHit(app, hit, m);
}

async function activateHit(app, hit, m) {
  const a = hit.act;
  if (a.type === 'input') {
    let cell = 0, offset = a.line.start;
    for (const ch of a.line.text) {
      const w = width(ch);
      if (m.x - hit.x0 < cell + w / 2) break;
      cell += w; offset += ch.length;
    }
    app.cursor = offset; app.lastKind = '';
  }
  else if (a.type === 'new') newConversation(app);
  else if (a.type === 'open') await openSession(app, a.id);
  else if (a.type === 'call') await openCall(app, a.i);
  else if (a.type === 'sessions') openSessions(app);
  else if (a.type === 'bottom') app.scroll = 0;
  else if (a.type === 'rail') { app.sw.rail = a.i; app.sw.focus = 'rail'; app.sw.sel = 0; }
}

// ---- Entry ---------------------------------------------------------------------------------------------------------
export async function run(action, argument, view) {
  if (action === 'curves') {
    const { startCurveEditor } = await import('./curve-editor.mjs');
    await startCurveEditor();
    return;
  }
  if (action === 'snapshot') {
    const [c, r] = (argument || '110x32').split('x').map(Number);
    const app = createApp({ cols: c, rows: r, prefs: loadPrefs() });
    await refresh(app);
    const screen = process.argv[5] || view || 'home';
    if (screen === 'chat' && app.sessions[0]) { app.sessionId = app.sessions[0].id; await refresh(app); app.screen = 'chat'; }
    if (screen === 'sessions') openSessions(app);
    process.stdout.write(crtLines(app, drawFrame(app)).join('\n') + '\n');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('tui start 需要在终端（PowerShell / Windows Terminal）里运行；只想看一帧用 tui snapshot');
  const app = createApp({ cols: process.stdout.columns, rows: process.stdout.rows, prefs: loadPrefs(), launchDir: launchFolder(process.cwd()) });
  const out = process.stdout;
  if (process.platform === 'win32') app.writeClipboard = text => {
    const r = spawnSync('clip.exe', [], { input: Buffer.from(text, 'utf16le'), windowsHide: true, timeout: 5000 });
    if (r.error || r.status !== 0) throw new Error(r.error?.message || 'clip.exe 返回 ' + r.status);
  };
  let prev = [], dirty = true, heroShown = false, heroKey = '', heroSix = '', heroCache = new Map();
  app.dirty = () => { dirty = true; };
  app.crtBoot = Date.now();
  const paint = () => {
    dirty = false; app.now = Date.now();
    const frame = crtLines(app, drawFrame(app)), hero = app.hero, booted = app.crtBoot == null || app.now - app.crtBoot >= 560;
    let buf = '';
    // Reassert the padding colour on every existing repaint: the host can reset its
    // default background independently, leaving explicit CRT cells beside black padding.
    const wantBg = app.crt || hero ? app.themeKey : ''; // the picture's ground must match even with /crt off
    const c = CRT_BG[wantBg]; buf += c ? `\x1b]11;rgb:${c.map(v => v.toString(16).padStart(2, '0')).join('/')}\x07` : '\x1b]111\x07';
    if (!!hero !== heroShown) { buf += '\x1b[2J'; prev = []; heroShown = !!hero; heroKey = ''; } // a picture is only removed by clearing its cells
    let touched = false;
    frame.forEach((line, i) => {
      if (line === prev[i]) return;
      buf += `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`;
      if (hero && i >= hero.top && i < hero.top + hero.L.cellsH) touched = true;
    });
    prev = frame;
    if (hero && booted) { // true-pixel hero: re-encoded only when its animation step changes, re-sent if its cells were rewritten
      const st = timeState(app.now, app.crt), key = `${st.key}|${hero.L.W}x${hero.L.H}|${app.themeKey}`;
      if (key !== heroKey) { // pictures repeat (9 frames x rare flicker/wobble states), so keep the encoded ones
        if (!heroCache.has(key)) { if (heroCache.size >= 24) heroCache.delete(heroCache.keys().next().value); heroCache.set(key, encodeSixel(renderHero(hero.L, { now: app.now, themeKey: app.themeKey, theme: app.theme(), effects: app.crt }), hero.L.W, hero.L.H, 160, CRT_BG[app.themeKey])); }
        heroSix = heroCache.get(key); heroKey = key; touched = true;
      }
      if (touched) buf += `\x1b[${hero.top + 1};${hero.left + 1}H` + heroSix;
    }
    buf += `\x1b[${app.cursorXY[0]};${app.cursorXY[1]}H`;
    if (app.osc) { buf += app.osc; app.osc = ''; }
    if (app.bell) { buf += '\x07'; app.bell = false; }
    out.write(buf);
  };
  // Capture mouse input by default; Alt+M restores native selection, including Quick Edit in conhost.
  const classicConsole = process.platform === 'win32' && !process.env.WT_SESSION;
  const originalMode = classicConsole ? /(?:^|\s)(0x[0-9A-F]+)/.exec(consoleScript())?.[1] : null;
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  process.once('exit', () => { try { out.write('\x1b]111\x07'); } catch { /* terminal already gone */ } }); // a crash must not leave the terminal recoloured
  app.syncMouse = () => {
    out.write(MOUSE_OFF + (app.mouseCapture ? MOUSE_ON : ''));
    if (classicConsole) app.consoleMode = consoleScript(app.mouseCapture ? '-Mouse' : '-QuickEdit');
    dirty = true;
  };
  out.write('\x1b]0;PIRI Office\x07\x1b[?1049h\x1b[?25h\x1b[?2004h\x1b[2J');
  app.syncMouse();
  const done = new Promise(res => process.once('tui-quit', res));
  let queue = Promise.resolve();
  const feed = createKeyParser(k => {
    // answers to the startup query: DA1 lists sixel as attribute 4; "CSI 16 t" returns the cell size in pixels
    if (k.key === 'da1') { app.img = { cw: 0, ch: 0, ...app.img, sixel: k.params.includes(4) && process.env.PHD_TUI_NO_SIXEL !== '1' }; heroKey = ''; dirty = true; return; }
    if (k.key === 'cellsize') { app.img = { sixel: false, ...app.img, cw: k.w, ch: k.h }; heroKey = ''; dirty = true; return; }
    queue = queue.then(() => onKey(app, k)).then(() => { dirty = true; }).catch(e => { app.error = e.message; dirty = true; }); });
  process.stdin.on('data', d => {
    if (app.debugKeys) { // /keys: show what the terminal actually sends, to tell "no wheel events arrive" from "events arrive but are ignored"
      app.rawCount = (app.rawCount || 0) + 1; app.mouseCount = (app.mouseCount || 0) + (/\x1b\[<\d+;\d+;\d+[Mm]/.test(d) ? 1 : 0);
      app.rawLast = JSON.stringify(d).slice(0, 60);
    }
    feed(d);
  });
  out.on('resize', () => { app.selection = null; app.cols = out.columns; app.rows = out.rows; prev = []; heroKey = ''; out.write('\x1b[2J\x1b[16t'); dirty = true; });
  out.write('\x1b[c\x1b[16t'); // ask what the terminal can draw (sixel) and how big a cell is; answers arrive through the key parser
  await refresh(app);
  const poll = setInterval(async () => { await refresh(app); dirty = true; }, 5000); // same cadence as web; do not recapture the mouse
  let lastMascot = mascotFrame(Date.now());
  let lastSpin = 0;
  const anim = setInterval(() => {
    if (app.active.length && Date.now() - lastSpin >= 250) { lastSpin = Date.now(); app.tick++; dirty = true; }
    if (app.crt && app.screen === 'home') dirty = true; // CRT animation belongs only to home
    const frame = mascotFrame(Date.now());
    if (app.screen === 'home' && frame !== lastMascot) dirty = true;
    lastMascot = frame;
  }, 100);
  const typer = setInterval(() => { if (app.reveal) dirty = true; }, 50);
  const draw = setInterval(() => { if (dirty) paint(); }, 33);
  await done;
  clearInterval(poll); clearInterval(anim); clearInterval(draw); clearInterval(typer);
  out.write('\x1b]111\x07\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?1049l\x1b[?25h');
  process.stdin.setRawMode(false); process.stdin.pause();
  if (originalMode) consoleScript('-Restore', originalMode);
  process.exit(0);
}
