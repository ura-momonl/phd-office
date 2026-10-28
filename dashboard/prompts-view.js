import {esc} from './format.js';
// Prompt page: where every piece of model-facing text lives and who receives it. Read-only: the text is edited as files / with the `prompt` command.
// A thin view over prompts/view.mjs and the same functions the `prompt` command uses. It keeps no prompt rules of its own.
const $ = id => document.getElementById(id);
const PROVIDER = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
const STANDING = [['system_prompt', 'SYSTEM_PROMPT', 'agent/native.mjs'], ['agents_md', 'AGENTS.md', 'AGENTS.md'], ['claude_md', 'CLAUDE.md', 'CLAUDE.md'], ['user_claude_md', '用户级 CLAUDE.md', '~/.claude/CLAUDE.md']];
const REQUEST = { chat: '你发的那条消息（含附件）', auto: '任务的目标和当前这一步', card: '邮件的标题和依据（值槽 title、evidence）' };
const STATE_TEXT = { yes: '载入', no: '不载入', REPLACED: '被替换', unverified: '未实测' };

let data, loading, snapshotInfo, runsData, runDetail, runsError = '';
let mode = 'scenario', query = '', sel = null, detail = null, tab = 'expanded', diffBase = 'saved', busy = false;
const collapsed = new Set();
let runView = 'sources';
const expandedSources = new Set();
let runMarkdown, runMarkdownLoading;
function ensureRunMarkdown() {
  if (runMarkdown || runMarkdownLoading) return;
  runMarkdownLoading = import('./markdown.js').then(m => {
    runMarkdown = m.renderMarkdown;
    if (sel?.type === 'run') { const body=$('pv-run-sources'),scroll=body?.scrollTop || 0;paintMain();$('pv-run-sources').scrollTop=scroll; }
  }).catch(e => say('来源分块暂用普通文字显示：' + e.message, true));
}

async function api(url, body) {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const v = await r.json().catch(() => ({ error: '提示词页面需要更新后端；请等活动任务结束后重启办公室。' }));
  if (!r.ok) throw new Error(v.error || '操作失败');
  return v;
}
const say = (text = '', bad = false) => { const el = $('pv-msg'); if (el) { el.textContent = text; el.className = 'pv-msg' + (bad ? ' bad' : ''); } };
const kb = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
const hue = id => { let h = 0; for (const c of id.split('/')[0]) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const fragOf = id => data?.fragments.find(f => f.id === id);
const roundLabel = r => (Number.isInteger(r.turn) ? '对话第 ' + r.turn + ' 轮' : '对话轮次未知') + (r.handoff_turn > 1 ? ' · 交接 ' + r.handoff_turn : '');

export function renderPrompts() {
  const root = $('page-prompts');
  if (!root.dataset.ready) {
    root.dataset.ready = '1';
    root.innerHTML = `<div class="pv"><aside class="pv-left"><div class="pv-find"><div class="pv-find-row"><input id="pv-q" type="search" placeholder="搜索片段 id 或正文…" aria-label="搜索提示词"><button id="pv-reload" type="button" class="secondary" title="刷新" aria-label="刷新">↻</button></div><span id="pv-msg" class="pv-msg" role="status"></span><div class="pv-seg" role="tablist" aria-label="浏览方式"><button type="button" data-mode="scenario" class="active">按场景</button><button type="button" data-mode="domain">按目录</button><button type="button" data-mode="run">按运行</button></div></div><div id="pv-list" class="pv-list"></div></aside><main class="pv-main" id="pv-main"></main><aside class="pv-right" id="pv-right"></aside></div>
      <dialog id="pv-dialog" class="pv-dialog"><form method="dialog" id="pv-form"><h2 id="pv-dialog-title"></h2><label>片段 id<input id="pv-dialog-id" autocomplete="off" spellcheck="false"></label><p class="muted" id="pv-dialog-hint"></p><p class="pv-msg bad" id="pv-dialog-error" role="alert"></p><div class="pv-actions"><button type="button" id="pv-dialog-cancel" class="secondary">取消</button> <button type="submit" id="pv-dialog-ok" class="primary">确定</button></div></form></dialog>`;
    bind(root);
  }
  // The app calls this on every state refresh; repainting then would rebuild the editor under the user's caret.
  if (!data && !loading) void reload();
}

async function reload() {
  if (loading) return loading;
  say('读取中…');
  loading = (async () => {
    try {
      data = await api('/api/prompts');
      if (!sel) sel = { type: 'scenario', key: data.scenarios[0] ? data.scenarios[0].purpose + '|' + data.scenarios[0].provider : '' };
      if (sel.type === 'fragment') await openFragment(sel.id, { keepTab: true });
      if (mode === 'run') await loadRuns();
      say(); paintAll();
    } catch (e) { say(e.message, true); }
  })().finally(() => loading = null);
  return loading;
}

async function openFragment(id, { keepTab = false } = {}) {
  sel = { type: 'fragment', id };
  if (!keepTab) { tab = 'expanded'; diffBase = 'saved'; }
  try { detail = await api('/api/prompts/fragment?id=' + encodeURIComponent(id)); }
  catch (e) { detail = null; sel = { type: 'scenario', key: data.scenarios[0] ? data.scenarios[0].purpose + '|' + data.scenarios[0].provider : '' }; say(e.message, true); }
  void refreshSnapshot();
  paintAll();
}

async function refreshSnapshot() {
  try { snapshotInfo = await api('/api/prompts/snapshot'); } catch { snapshotInfo = null; }
  paintRight();
}

function paintAll() { paintLeft(); paintMain(); paintRight(); }

async function loadRuns() {
  runsError = ''; runsData = null; paintLeft();
  try { runsData = (await api('/api/prompts/runs')).runs; }
  catch (e) { runsError = e.message; }
  paintLeft();
  if (sel?.type === 'run') await openRun(sel.id);
}
async function openRun(id) {
  if (sel?.type !== 'run' || sel.id !== id) { runView = 'sources'; expandedSources.clear(); }
  sel = { type: 'run', id }; runDetail = null; paintAll();
  try {
    const result = await api('/api/prompts/run?id=' + encodeURIComponent(id));
    if (sel?.type !== 'run' || sel.id !== id) return;
    runDetail = result; say();
  } catch (e) { if (sel?.type === 'run' && sel.id === id) say(e.message, true); }
  paintAll();
}
async function browseRuns() {
  mode = 'run'; query = ''; $('pv-q').value = ''; paintLeft();
  if (!runsData) await loadRuns();
}

/* ---------- left: scenarios / directory / search ---------- */
function standingDots(s) {
  return STANDING.map(([key, label]) => `<i class="pv-dot ${esc(s[key])}" title="${esc(label)}：${esc(STATE_TEXT[s[key]] || s[key])}"></i>`).join('');
}
function paintLeft() {
  const list = $('pv-list'); if (!list || !data) return;
  document.querySelectorAll('.pv-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const q = query.trim().toLocaleLowerCase();
  if (q) {
    const hits = data.fragments.filter(f => f.id.toLowerCase().includes(q) || f.body.toLowerCase().includes(q));
    list.innerHTML = `<p class="pv-hint">${hits.length} 个片段匹配</p>` + hits.map(f => {
      const at = f.body.toLowerCase().indexOf(q), snip = at < 0 ? '' : f.body.slice(Math.max(0, at - 18), at + q.length + 30).replace(/\s+/g, ' ');
      return `<button type="button" class="pv-item ${sel?.type === 'fragment' && sel.id === f.id ? 'active' : ''}" data-frag="${esc(f.id)}"><span class="pv-bar" style="--h:${hue(f.id)}"></span><span class="pv-id">${esc(f.id)}</span>${snip ? `<small>${esc(snip)}</small>` : ''}</button>`;
    }).join('') || '<p class="pv-hint">没有匹配。</p>';
    return;
  }
  if (mode === 'run') {
    list.innerHTML = `<p class="pv-hint">最近 100 段对话的全部保留输入，含后续轮次和任务内交接；对话轮次与交接序号分别显示。</p>` + (runsError ? `<p class="pv-hint">${esc(runsError)} 请等活动任务结束后重启办公室，再刷新。</p>` : !runsData ? '<p class="pv-hint">读取中…</p>' : runsData.map(r => `<button type="button" class="pv-item ${sel?.type === 'run' && sel.id === r.id ? 'active' : ''}" data-run="${esc(r.id)}"><span class="pv-id">${esc(PROVIDER[r.provider] || '未知提供方')} · ${roundLabel(r)}</span><small>${esc(r.session_title || r.id.slice(0,8))}</small><small>${esc(new Date(r.at).toLocaleString())} · ${kb(r.bytes)}</small></button>`).join('') || '<p class="pv-hint">没有保留提示词记录的对话。</p>');
    return;
  }
  if (mode === 'scenario') {
    const groups = [];
    for (const s of data.scenarios) { let g = groups.find(x => x.purpose === s.purpose); if (!g) groups.push(g = { purpose: s.purpose, note: s.note, rows: [] }); g.rows.push(s); }
    list.innerHTML = `<p class="pv-legend"><span>常驻层</span>${STANDING.map(([, label]) => `<b>${esc(label.replace('用户级 ', '用户 '))}</b>`).join('')}<span class="pv-hint">实心 = 载入</span></p>` + groups.map(g => `<section class="pv-group"><h3><code>${esc(g.purpose)}</code><small>${esc(g.note || '')}</small></h3>${g.rows.map(s => {
      const key = s.purpose + '|' + s.provider;
      return `<button type="button" class="pv-item ${sel?.type === 'scenario' && sel.key === key ? 'active' : ''}" data-scenario="${esc(key)}"><span class="pv-id">${esc(PROVIDER[s.provider] || s.provider)} · ${esc(s.mode)}</span><span class="pv-dots">${standingDots(s)}</span><small>${s.fragments.length} 个片段</small></button>`;
    }).join('')}</section>`).join('');
    return;
  }
  const byDomain = new Map();
  for (const f of data.fragments) (byDomain.get(f.domain || '（顶层）') ?? byDomain.set(f.domain || '（顶层）', []).get(f.domain || '（顶层）')).push(f);
  list.innerHTML = [...byDomain].map(([d, fs]) => {
    const total = fs.reduce((n, f) => n + f.chars, 0), open = !collapsed.has(d);
    return `<section class="pv-group"><h3 data-toggle="${esc(d)}" class="pv-fold" aria-expanded="${open}"><span>${open ? '▾' : '▸'} ${esc(d)}</span><small>${fs.length} 个 · ${total} 字</small></h3>${open ? fs.map(f => {
      const orphan = !f.included_by.length && !f.used_by_code.length;
      return `<button type="button" class="pv-item ${sel?.type === 'fragment' && sel.id === f.id ? 'active' : ''}" data-frag="${esc(f.id)}"><span class="pv-bar" style="--h:${hue(f.id)}"></span><span class="pv-id">${esc(f.id.includes('/') ? f.id.slice(f.id.indexOf('/') + 1) : f.id)}${orphan ? ' <em class="pv-note" title="没有被引用">未引用</em>' : ''}</span><small>${f.chars}</small></button>`;
    }).join('') : ''}</section>`;
  }).join('');
}

/* ---------- centre ---------- */
function paintMain() {
  const main = $('pv-main'); if (!main || !data) return;
  main.classList.toggle('pv-run', sel?.type === 'run');
  if (sel?.type === 'fragment' && detail) return paintFragment(main);
  if (sel?.type === 'run') {
    if (!runDetail) { main.innerHTML = '<p class="pv-hint">正在读取运行记录；若读取失败，可从左侧重新选择。</p>'; return; }
    const r = runDetail;
    if (r.sources && runView === 'sources') ensureRunMarkdown();
    main.innerHTML = `<div class="pv-head"><div><h2>${esc(PROVIDER[r.provider] || '未知提供方')} · ${roundLabel(r)} <small>${r.body.length} 字</small></h2><code class="pv-file">${esc(r.id)}</code></div></div>
      ${r.warnings.map(w => `<p class="pv-state warn">${esc(w)}</p>`).join('')}
      <div class="pv-tabs" role="tablist" aria-label="运行正文视图"><button type="button" data-run-view="sources" class="${r.sources && runView === 'sources' ? 'active' : ''}" ${r.sources ? '' : 'disabled'}>来源分块</button><button type="button" data-run-view="raw" class="${!r.sources || runView === 'raw' ? 'active' : ''}">原样全文</button></div>
      <pre class="pv-expanded" id="pv-run-body" ${r.sources && runView === 'sources' ? 'hidden' : ''}>${esc(r.body)}</pre>
      <div id="pv-run-sources" ${!r.sources || runView !== 'sources' ? 'hidden' : ''}>${r.sources ? paintRunSources(r) : ''}</div>
      ${r.sources ? '' : '<p class="pv-hint">这个旧运行没有可用的来源位置记录，只显示原文，不用当前片段猜测历史来源。</p>'}`;
    return;
  }
  const [purpose, provider] = (sel?.key || '').split('|'), s = data.scenarios.find(x => x.purpose === purpose && x.provider === provider);
  if (!s) { main.innerHTML = '<p class="pv-hint">选择左侧的一个场景或片段。</p>'; return; }
  const frs = s.fragments.map(fragOf).filter(Boolean), total = frs.reduce((n, f) => n + f.chars, 0), peak = Math.max(1, ...frs.map(f => f.chars));
  const byDomain = new Map();
  for (const f of frs) (byDomain.get(f.domain || '（顶层）') ?? byDomain.set(f.domain || '（顶层）', []).get(f.domain || '（顶层）')).push(f);
  const file = key => data.standing_files.find(x => x.id === key.replace(/_/g, '-'));
  const frag = x => { const m = /^prompts\/fragments\/(.+)\.md$/.exec(x.path || ''); return m && fragOf(m[1]) ? m[1] : null; };
  main.innerHTML = `<div class="pv-head"><div><p class="eyebrow">拼装栈</p><h2><code>${esc(s.purpose)}</code> · ${esc(PROVIDER[s.provider] || s.provider)} · ${esc(s.mode)}</h2><p class="muted">${esc(s.note || '')}</p></div></div>
    <div class="pv-flow">
      <p class="pv-flow-cap">发给模型的输入，自上而下大致按这个先后拼成；片段入口可以点开。</p>
      <section class="pv-layer"><header><b>① 常驻层</b><span>由 Claude / Codex 的原生入口先带上。这里只能看到载入与否和大小，原文在各自的文件里。</span></header>
      <ol class="pv-stack">${STANDING.map(([key, label, where]) => {
        const f = file(key), st = s[key];
        return `<li class="${esc(st)}"><span class="pv-dot ${esc(st)}"></span><b>${esc(label)}</b><code>${esc(where)}</code><span class="pv-sp"></span>${f?.bytes ? `<small>${kb(f.bytes)}</small>` : ''}<span class="pv-state ${esc(st)}">${esc(STATE_TEXT[st] || st)}</span></li>`;
      }).join('')}</ol></section>
      <div class="pv-arrow" aria-hidden="true">↓</div>
      <section class="pv-layer"><header><b>② 本轮拼装</b><span>每次调用时由下列程序入口现场拼出；其中的固定文字存放在片段库，运行时的值（值槽）由程序填入。</span></header>
      <ol class="pv-stack">${s.surfaces.map(x => { const id = frag(x), inner = `<span class="pv-kind">${esc(x.kind)}</span><b>${esc(x.id)}</b><code>${esc(x.path)}</code><span class="pv-sp"></span>${x.bytes ? `<small>${kb(x.bytes)}</small>` : ''}`; return id ? `<li><button type="button" class="pv-surface" data-frag="${esc(id)}" title="打开这个片段">${inner}</button></li>` : `<li>${inner}</li>`; }).join('') || '<li class="muted">没有登记。</li>'}</ol>
      <p class="pv-from">↳ 固定文字来自片段库：这个场景可能用到 <b>${frs.length}</b> 段、合计 <b>${total}</b> 字，列在本图下方。</p></section>
      <div class="pv-arrow" aria-hidden="true">↓</div>
      <section class="pv-layer pv-layer-req"><header><b>③ 本轮请求</b><span>${esc(REQUEST[s.purpose] || '本轮运行时传入的具体内容')}。运行时才有，不在这里编辑。</span></header></section>
    </div>
    <h3 class="pv-sec">片段库 · 本场景可能出现的片段 <small>${frs.length} 个，合计 ${total} 字；部分按条件才出现</small></h3>
    ${[...byDomain].map(([d, fs]) => `<div class="pv-dom"><h4>${esc(d)}</h4>${fs.map(f => `<button type="button" class="pv-row" data-frag="${esc(f.id)}"><span class="pv-bar" style="--h:${hue(f.id)}"></span><span class="pv-id">${esc(f.id)}</span><span class="pv-meter"><i style="width:${Math.max(2, Math.round(f.chars / peak * 100))}%;--h:${hue(f.id)}"></i></span><small>${f.chars} 字</small></button>`).join('')}</div>`).join('') || '<p class="pv-hint">这个用途没有来自片段库的文字。</p>'}
    <p class="pv-hint">片段到场景的对应由代码里的实际引用推出（谁导入、谁渲染），是“可能到达”，不保证每次都出现。</p>`;
}

function paintRunSources(r) {
  const map = r.sources;
  const plain = text => text.trim() ? `<div class="pv-run-text${runMarkdown ? '' : ' pv-run-plain'}">${runMarkdown ? runMarkdown(text) : esc(text)}</div>` : '';
  const range = (start,end,nodes,path = '') => {
    let at = start, html = '';
    nodes.forEach((n,i) => {
      const key = path ? path + '.' + i : String(i), dom = 'pv-origin-' + key.replaceAll('.','-');
      html += plain(r.body.slice(at,n.start));
      const text = r.body.slice(n.start,n.end), children = n.children || [], inside = () => range(n.start,n.end,children,key);
      if (n.kind === 'fragment') {
        const exists = !!fragOf(n.id), title = `<span class="pv-bar"></span><code>${esc(n.id)}</code>`;
        html += `<section class="pv-origin${exists ? ' can-open' : ''}" id="${dom}" data-origin="${esc(n.id)}" style="--h:${hue(n.id)}"><header>${exists ? `<button type="button" class="pv-origin-title" data-fragdir="${esc(n.id)}" title="在按目录中查看当前片段详情">${title}</button>` : `<span class="pv-origin-title">${title}</span>`}<small>${text.length} 字</small>${children.length ? `<button type="button" class="pv-origin-toggle" data-origin-parts="${key}" aria-expanded="${expandedSources.has(key)}">${expandedSources.has(key) ? '收起内部来源' : '内部来源'}</button>` : ''}</header>
          <div class="pv-origin-content">${expandedSources.has(key) ? inside() : plain(text)}</div></section>`;
      } else if (n.kind === 'source') {
        html += `<section class="pv-run-source" id="${dom}"><p class="pv-origin-meta">${esc(n.label || '运行时内容')} <code>${esc(n.path || '')}</code>${n.message_index != null ? ` · 消息 ${esc(n.message_index)}` : ''}${n.entry_id ? ` · ${esc(n.entry_id)}` : ''}</p>${children.length ? inside() : plain(text)}</section>`;
      } else {
        html += `<section class="pv-run-value"><p class="pv-origin-meta">填入 <code>{{${esc(n.name)}}}</code> · ${text.length} 字</p>${children.length ? inside() : plain(text)}</section>`;
      }
      at = n.end;
    });
    return html + plain(r.body.slice(at,end));
  };
  return range(0,r.body.length,map.nodes);
}

// Actual occurrences, including hidden nested fragments, in source order. Keep duplicate ids:
// a sidebar link targets this occurrence rather than guessing from its visible text.
function runOrigins() {
  const out = [];
  const walk = (nodes, path = '', ancestors = []) => nodes.forEach((n,i) => {
    const key = path ? path + '.' + i : String(i);
    if (n.kind === 'fragment') out.push({ id:n.id, key, ancestors, chars:n.end-n.start });
    walk(n.children || [], key, n.kind === 'fragment' ? [...ancestors,key] : ancestors);
  });
  walk(runDetail?.sources?.nodes || []);
  return out;
}
function jumpToOrigin(key) {
  const target = runOrigins().find(n => n.key === key); if (!target) return;
  target.ancestors.forEach(k => expandedSources.add(k));
  runView = 'sources'; paintMain();
  $('pv-origin-' + key.replaceAll('.','-'))?.scrollIntoView({behavior:'smooth',block:'start'});
}
async function openDirectoryFragment(id) {
  if (!fragOf(id)) return;
  mode = 'domain'; query = ''; $('pv-q').value = '';
  collapsed.delete(fragOf(id).domain || '（顶层）');
  await openFragment(id);
  $('pv-list')?.querySelector('.pv-item.active')?.scrollIntoView({block:'nearest'});
}

function paintFragment(main) {
  const f = detail;
  main.innerHTML = `<div class="pv-head"><div><p class="eyebrow">${esc(f.id.includes('/') ? f.id.slice(0, f.id.lastIndexOf('/')) : '片段')}</p><h2><code>${esc(f.id)}</code> <small>${f.body.length} 字</small></h2></div>
    <div class="pv-actions"><button id="pv-rename" type="button" class="secondary">改名</button><button id="pv-remove" type="button" class="secondary danger">删除</button></div></div>
    <div class="pv-tabs" role="tablist">${[['expanded', '展开'], ['diff', '差异']].map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${tab === k ? 'active' : ''}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
    <div id="pv-pane" class="pv-pane"></div>`;
  paintPane();
}

function paintPane() {
  const pane = $('pv-pane'); if (!pane || !detail) return;
  if (tab === 'diff') paintDiff(pane); else paintExpanded(pane);
}

function paintExpanded(pane) {
  const segs = detail.segments;
  const sources = [], seen = new Map();
  for (const g of segs) if (g.kind !== 'value' && g.kind !== 'missing') seen.set(g.from, (seen.get(g.from) || 0) + g.text.length);
  for (const [id, n] of seen) sources.push({ id, n });
  const slots = segs.filter(g => g.kind === 'value').length, total = segs.filter(g => g.kind === 'text').reduce((n, g) => n + g.text.length, 0);
  pane.innerHTML = `<div class="pv-sources"><span class="muted">固定文字 ${total} 字 · ${slots} 个槽位</span>${sources.map(s => `<button type="button" class="pv-chip" data-hl="${esc(s.id)}" style="--h:${hue(s.id)}" ${s.id === detail.id ? 'disabled' : `data-frag="${esc(s.id)}"`}>${esc(s.id)} <small>${s.n}</small></button>`).join('')}</div>
    <pre class="pv-expanded">${segs.map(g => g.kind === 'value' ? `<span class="slot" title="调用方传入的值">⟨${esc(g.text)}⟩</span>` : g.kind === 'missing' ? `<span class="slot bad" title="没有这个片段">缺少 ${esc(g.text)}</span>` : `<span class="seg ${g.from === detail.id ? '' : 'inc'}" data-from="${esc(g.from)}" style="--h:${hue(g.from)}" title="${esc(g.from)}">${esc(g.text)}</span>`).join('')}</pre>
    <p class="pv-hint">⟨名⟩ 是运行时才填的值。有底色的文字来自被引用的片段，点上方标签可跳转。</p>`;
}

function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
  while (i < n) out.push(['-', x[i++]]); while (j < m) out.push(['+', y[j++]]);
  return out;
}
function paintDiff(pane) {
  const versions = detail.history || [];
  if (diffBase !== 'saved' && !versions.some(v => v.version === diffBase)) diffBase = 'saved';
  const base = diffBase === 'saved' ? detail.body : versions.find(v => v.version === diffBase).body, now = detail.body;
  const rows = lineDiff(base, now), plus = rows.filter(r => r[0] === '+').length, minus = rows.filter(r => r[0] === '-').length;
  const label = v => v.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\d*$/, '$1-$2-$3 $4:$5:$6');
  pane.innerHTML = `<div class="pv-sources"><label class="pv-base">对比基准 <select id="pv-base"><option value="saved">当前已保存</option>${versions.map(v => `<option value="${esc(v.version)}" ${diffBase === v.version ? 'selected' : ''}>历史 ${esc(label(v.version))}</option>`).join('')}</select></label><span class="muted">与当前文字相比 · <b class="add">+${plus}</b> <b class="del">−${minus}</b></span></div>
    ${plus + minus ? `<pre class="pv-diff">${rows.map(([k, l]) => `<div class="${k === '+' ? 'add' : k === '-' ? 'del' : ''}"><i>${k === ' ' ? '' : k}</i>${esc(l) || ' '}</div>`).join('')}</pre>` : '<p class="pv-hint">没有差异。</p>'}
    ${versions.length ? '' : '<p class="pv-hint">还没有历史版本；每次保存前的旧文字会留在这里。</p>'}`;
  $('pv-base').onchange = e => { diffBase = e.target.value; paintDiff($('pv-pane')); };
}

/* ---------- right: structure, reach, snapshot, lint ---------- */
function link(id) { const f = fragOf(id); return `<button type="button" class="pv-link" data-frag="${esc(id)}"><span class="pv-bar" style="--h:${hue(id)}"></span>${esc(id)}${f ? `<small>${f.chars}</small>` : ''}</button>`; }
function paintRight() {
  const box = $('pv-right'); if (!box || !data) return;
  const snap = snapshotInfo ? (snapshotInfo.changed.length ? `<p class="pv-state warn">${snapshotInfo.changed.length} 个固定案例的渲染结果与快照不同</p><ul class="pv-plain">${snapshotInfo.changed.map(c => `<li><code>${esc(c)}</code></li>`).join('')}</ul><button id="pv-accept" type="button" class="secondary" ${busy ? 'disabled' : ''}>接受为新快照</button>` : `<p class="pv-state ok">${snapshotInfo.cases} 个固定案例与快照一致</p>`) : '<p class="pv-hint">快照状态读取中…</p>';
  const lintBox = data.lint.errors.length ? `<p class="pv-state bad">${data.lint.errors.length} 个结构错误</p><ul class="pv-plain">${data.lint.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : `<p class="pv-state ok">${data.lint.fragments} 个片段，没有结构错误</p>`;
  let body = '';
  if (sel?.type === 'run' && runDetail) {
    const origins = runOrigins(), located = new Set(origins.map(n => n.id)), missing = runDetail.fragments.filter(f => !located.has(f.id));
    const fallback = missing.map(f => `<p>${fragOf(f.id) ? link(f.id) : `<code class="pv-file">${esc(f.id)}（当前已不存在）</code>`}<small class="muted">渲染 ${esc(f.uses)} 次</small></p>`).join('');
    body = `<section><h3>本轮片段清单</h3><p class="pv-hint">${runDetail.sources ? '按实际出现顺序排列；点击色签定位正文，嵌套片段会自动展开。点击彩色框可在“按目录”查看当前片段详情。' : '旧记录没有来源位置；以下链接仅打开当前片段版本。'}</p>${origins.map(n => `<button type="button" class="pv-link" data-origin-jump="${n.key}" data-origin-id="${esc(n.id)}" title="定位本次出现的片段"><span class="pv-bar" style="--h:${hue(n.id)}"></span>${esc(n.id)}<small>${n.chars} 字</small></button>`).join('')}${missing.length && runDetail.sources ? '<h4>未记录位置 · 查看当前版本</h4>' : ''}${fallback}${!origins.length && !missing.length ? '<p class="pv-hint">没有可核对的片段清单。</p>' : ''}</section>`;
    box.innerHTML = `<div class="pv-card">${body}</div>`;
    return;
  }
  if (sel?.type === 'fragment' && detail) {
    const f = detail, ps = f.purposes || [];
    body = `<section><h3>值槽</h3>${(f.values || []).length ? `<p>${f.values.map(v => `<span class="pv-slot">{{${esc(v)}}}</span>`).join(' ')}</p>` : '<p class="pv-hint">没有，是固定文字。</p>'}</section>
      <section><h3>引用了</h3>${(f.includes || []).length ? f.includes.map(link).join('') : '<p class="pv-hint">无</p>'}</section>
      <section><h3>被引用</h3>${(f.included_by || []).length ? f.included_by.map(link).join('') : '<p class="pv-hint">没有片段引用它</p>'}${(f.used_by_code || []).length ? `<h4>代码</h4>${f.used_by_code.map(c => `<code class="pv-file">${esc(c)}</code>`).join('')}` : ''}${!(f.included_by || []).length && !(f.used_by_code || []).length ? '<p class="pv-hint">目前没有任何地方用到它（可先存着）。</p>' : ''}</section>
      <section><h3>会抵达</h3>${ps.length ? `<p>${ps.map(p => `<button type="button" class="pv-chip" data-goto="${esc(p)}">${esc(p)}</button>`).join(' ')}</p>` : '<p class="pv-hint">暂未接入任何调用。</p>'}</section>
      <section><h3>历史</h3><p class="muted">${(f.history || []).length} 个旧版本</p></section>`;
  }
  box.innerHTML = `<div class="pv-card">${body}<section><h3>快照</h3>${snap}</section><section><h3>结构检查</h3>${lintBox}</section></div>`;
}

/* ---------- actions ---------- */
async function reloadAll(id) {
  data = await api('/api/prompts');
  if (id && fragOf(id)) await openFragment(id, { keepTab: true }); else paintAll();
}
function askName(title, value, hint, run) {
  const dlg = $('pv-dialog'), input = $('pv-dialog-id'); $('pv-dialog-title').textContent = title; input.value = value; $('pv-dialog-hint').textContent = hint; $('pv-dialog-error').textContent = '';
  $('pv-form').onsubmit = async e => { e.preventDefault(); try { await run(input.value.trim()); dlg.close(); } catch (err) { $('pv-dialog-error').textContent = err.message; } };
  dlg.showModal(); input.focus(); input.select();
}
let removeArmed = 0;

function bind(root) {
  $('pv-q').oninput = e => { query = e.target.value; paintLeft(); };
  $('pv-reload').onclick = () => { data = null; detail = null; void reload(); };
  $('pv-dialog-cancel').onclick = () => $('pv-dialog').close();
  root.addEventListener('click', async e => {
    const origin = e.target.closest('.pv-origin.can-open');
    if (origin && !e.target.closest('button,a,input,select,textarea,details') && window.getSelection()?.isCollapsed !== false) {
      await openDirectoryFragment(origin.dataset.origin); return;
    }
    const t = e.target.closest('button,h3[data-toggle]'); if (!t) return;
    if (t.dataset.runView) { runView = t.dataset.runView; paintMain(); return; }
    if (t.dataset.originParts) { const key=t.dataset.originParts,body=$('pv-run-sources'),scroll=body.scrollTop; expandedSources.has(key) ? expandedSources.delete(key) : expandedSources.add(key); paintMain();$('pv-run-sources').scrollTop=scroll;return; }
    if (t.dataset.originJump) { jumpToOrigin(t.dataset.originJump);return; }
    if (t.dataset.fragdir) { await openDirectoryFragment(t.dataset.fragdir);return; }
    if (t.dataset.mode) { if (t.dataset.mode === 'run') await browseRuns(); else { mode = t.dataset.mode; query = ''; $('pv-q').value = ''; paintLeft(); } return; }
    if (t.dataset.run) { await openRun(t.dataset.run); return; }
    if (t.dataset.toggle) { collapsed.has(t.dataset.toggle) ? collapsed.delete(t.dataset.toggle) : collapsed.add(t.dataset.toggle); paintLeft(); return; }
    if (t.dataset.scenario) { sel = { type: 'scenario', key: t.dataset.scenario }; detail = null; paintAll(); return; }
    if (t.dataset.goto) { const s = data.scenarios.find(x => x.purpose === t.dataset.goto); if (s) { sel = { type: 'scenario', key: s.purpose + '|' + s.provider }; detail = null; mode = 'scenario'; paintAll(); } return; }
    if (t.dataset.frag) { if (sel?.type === 'run') await openDirectoryFragment(t.dataset.frag);else await openFragment(t.dataset.frag); return; }
    if (t.dataset.tab) { tab = t.dataset.tab; document.querySelectorAll('.pv-tabs button').forEach(b => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', String(b === t)); }); paintPane(); return; }
    if (t.id === 'pv-rename') {
      const from = detail.id;
      askName('改名', from, '代码、其他片段和登记表里指向它的引用会一起改。', async to => { if (to === from) return; const r = await api('/api/prompts/mv', { from, to }); await reloadAll(to); say('已改名，同步更新 ' + r.updated.length + ' 处引用'); });
      return;
    }
    if (t.id === 'pv-remove') {
      if (Date.now() - removeArmed > 4000) { removeArmed = Date.now(); t.textContent = '再点一次确认删除'; setTimeout(() => { if (t.isConnected) t.textContent = '删除'; }, 4000); return; }
      removeArmed = 0; const id = detail.id;
      try { await api('/api/prompts/rm', { id }); const fresh = await api('/api/prompts'); data = fresh; detail = null; sel = { type: 'scenario', key: data.scenarios[0].purpose + '|' + data.scenarios[0].provider }; say('已删除，旧文字留在历史里'); paintAll(); void refreshSnapshot(); }
      catch (err) { say(err.message, true); t.textContent = '删除'; }
      return;
    }
    if (t.id === 'pv-accept') { busy = true; paintRight(); try { await api('/api/prompts/snapshot-accept', {}); say('快照已更新'); await refreshSnapshot(); } catch (err) { say(err.message, true); } finally { busy = false; paintRight(); } }
  });
  root.addEventListener('mouseover', e => {
    const c = e.target.closest('.pv-chip[data-hl]'); const pre = root.querySelector('.pv-expanded'); if (!pre) return;
    pre.classList.toggle('dim', !!c); pre.querySelectorAll('.seg').forEach(s => s.classList.toggle('hot', !!c && s.dataset.from === c.dataset.hl));
  });
}
