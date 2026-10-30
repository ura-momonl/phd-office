// 项目框架 FRAMEWORK.md 的唯一读写入口。
// 文件本身是权威记录：标题层级就是板块嵌套，标题下一行的 <!--node {...}--> 是该板块/条目的结构化字段，其余是自由正文。
// 程序负责结构（编号、嵌套、状态、关联、校验）；正文怎么写由人和助手决定，可直接改文件。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { root, read, write } from '../automation/files.mjs';
import { fragment } from '../prompts/compose.mjs';

export const STATUSES = { done: '完成', doing: '正在进行', failed: '失败', open: '未开始／待定义' };
const KEYS = ['id', 'type', 'kind', 'summary', 'status', 'note', 'status_date', 'date', 'date_confirmed', 'after', 'links', 'corrects', 'work', 'files', 'history'];
// kind 用于研究标记：milestone 阶段（四种状态都可用）；attempt 日志主题中的一次已发生的尝试（只有完成或失败）；
// info 说明节点（动机、背景、参数说明等）：不带状态，页面也不给「＋ 状态」。
export const KINDS = { milestone: '阶段', attempt: '尝试', info: '说明' };
const ATTEMPT_STATES = ['done', 'failed'];
const TYPES = ['info', 'logic', 'timeline'];
const ID = /^[a-z0-9][a-z0-9-]*$/, ENTRY = /^T-(\d{8})-(\d+)(?=\s|$)/, MENTION = /\bT-\d{8}-\d+\b/g;
const DAY = String.raw`\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?`, DATE = new RegExp(`^${DAY}(?:/${DAY})?$`);
const META = /^<!--node (\{.*\})-->\s*$/;
const chicago = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
export const frameworkFile = projectId => path.join(root, 'workspace/projects', projectId, 'FRAMEWORK.md');
const sameProblem = p => p.replace(/第 \d+ 行/, '第 N 行');

export function parseFramework(text, { workIds } = {}) {
  const lines = text.split(/\r?\n/), nodes = [], problems = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    const h = !fence && /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (h) nodes.push({ level: h[1].length, heading: h[2], line: i, metaLine: -1, meta: {}, children: [], parent: null, ancestors: [] });
  });
  const stack = [];
  nodes.forEach((n, k) => {
    while (stack.length && stack.at(-1).level >= n.level) stack.pop();
    n.parent = stack.at(-1) || null; n.ancestors = stack.slice(); n.parent?.children.push(n); stack.push(n);
    const next = nodes[k + 1];
    n.bodyEnd = next ? next.line : lines.length;
    const m = META.exec(lines[n.line + 1] || '');
    if (m) {
      n.metaLine = n.line + 1;
      try { n.meta = JSON.parse(m[1]); } catch { problems.push(`「${n.heading.slice(0, 20)}」的 <!--node--> 不是合法 JSON`); }
      if (!n.meta || typeof n.meta !== 'object' || Array.isArray(n.meta)) { n.meta = {}; problems.push(`「${n.heading.slice(0, 20)}」的 <!--node--> 必须是对象`); }
    }
    const e = ENTRY.exec(n.heading);
    n.entry = !!e; n.date8 = e?.[1]; n.n = e ? Number(e[2]) : 0;
    n.id = e ? e[0] : n.meta.id || null;
    n.title = e ? n.heading.slice(e[0].length).trim() : n.heading;
    const from = n.metaLine >= 0 ? n.metaLine + 1 : n.line + 1;
    n.body = lines.slice(from, n.bodyEnd).join('\n').trim();
    n.tracked = !n.ancestors.concat(n).some(a => a.meta.type === 'info' || a.meta.kind === 'info');
  });
  const byId = new Map();
  for (const n of nodes) if (n.id) {
    if (byId.has(n.id)) problems.push('编号/ID 重复：' + n.id); else byId.set(n.id, n);
  }
  for (const n of nodes) {
    const m = n.meta, tag = n.id || n.heading.slice(0, 20);
    for (const k of Object.keys(m)) if (!KEYS.includes(k)) problems.push(`${tag}：未知字段 ${k}`);
    if (n.entry && m.id && m.id !== n.id) problems.push(`${tag}：meta.id 与标题编号不一致`);
    if (!n.entry && m.id !== undefined && !ID.test(String(m.id))) problems.push(`${tag}：id 只能用小写字母、数字和连字符`);
    if (m.type !== undefined && !TYPES.includes(m.type)) problems.push(`${tag}：type 只能是 ${TYPES.join('／')}`);
    if (m.type && n.level !== 2) problems.push(`${tag}：type 只用于一级板块（##）`);
    if (m.status !== undefined) {
      if (!STATUSES[m.status]) problems.push(`${tag}：status 只能是 ${Object.keys(STATUSES).join('／')}`);
      if (m.status === 'open' && !String(m.note || '').trim()) problems.push(`${tag}：状态为 open 时 note 必须写明是未开始还是待定义`);
      if (!n.id) problems.push(`${tag}：带状态的条目必须有 id`);
      if (!n.tracked) problems.push(`${tag}：说明性板块（type=info）或说明节点（kind=info）里的内容不带状态`);
    }
    if (m.kind !== undefined) {
      if (!KINDS[m.kind]) problems.push(`${tag}：kind 只能是 ${Object.keys(KINDS).join('／')}`);
      else if (n.entry) problems.push(`${tag}：时间记录不用 kind`);
      else if (m.kind === 'attempt' && n.ancestors.some(a => a.meta.type === 'logic')) problems.push(`${tag}：试错尝试属于时间日志，不属于逻辑论证`);
      else if (m.kind === 'attempt' && m.status && !ATTEMPT_STATES.includes(m.status)) problems.push(`${tag}：尝试（attempt）只能是完成或失败`);
    }
    if (m.after !== undefined) {
      const up = byId.get(m.after);
      if (!n.entry) problems.push(`${tag}：after 只用于时间记录`);
      else if (m.date) problems.push(`${tag}：已有 date 就不用 after`);
      else if (!up || !up.entry) problems.push(`${tag}：after 指向不存在的记录 ${m.after}`);
      else if (m.after === n.id) problems.push(`${tag}：after 指向自己`);
      else { const seen = new Set([n.id]); for (let x = up; x; x = x.meta.after ? byId.get(x.meta.after) : null) { if (seen.has(x.id)) { problems.push(`${tag}：after 形成循环`); break; } seen.add(x.id); } }
    }
    if (m.date !== undefined && m.date !== null && !DATE.test(String(m.date))) problems.push(`${tag}：date 格式应为 YYYY、YYYY-MM、YYYY-MM-DD 或用 / 连接的范围`);
    for (const k of ['links', 'work']) if (m[k] !== undefined && !(Array.isArray(m[k]) && m[k].every(x => typeof x === 'string'))) problems.push(`${tag}：${k} 必须是字符串数组`);
    for (const id of Array.isArray(m.links) ? m.links : []) {
      if (id === n.id) problems.push(`${tag}：links 指向自己`);
      else if (!byId.has(id)) problems.push(`${tag}：links 指向不存在的 ${id}`);
    }
    // corrects：后来的记录声明它更正了哪些更早的条目。旧条目一字不动，“已被更正”由程序从这条反向算出。
    if (m.corrects !== undefined) {
      if (!(Array.isArray(m.corrects) && m.corrects.every(x => typeof x === 'string'))) problems.push(`${tag}：corrects 必须是字符串数组`);
      else if (!n.entry) problems.push(`${tag}：corrects 只用于时间记录（更正由后来的记录声明）`);
      else for (const id of m.corrects) {
        const t = byId.get(id);
        if (id === n.id) problems.push(`${tag}：corrects 指向自己`);
        else if (!t) problems.push(`${tag}：corrects 指向不存在的 ${id}`);
        else if (t.entry && (t.date8 > n.date8 || (t.date8 === n.date8 && t.n >= n.n))) problems.push(`${tag}：corrects 只能指向更早的记录，${id} 不早于本条`);
      }
    }
    if (workIds) for (const id of Array.isArray(m.work) ? m.work : []) if (!workIds.has(id)) problems.push(`${tag}：work 里的 ${id} 不在任务队列`);
    for (const t of new Set([...(n.body.match(MENTION) || [])])) if (!byId.has(t) && t !== n.id) problems.push(`${tag}：正文提到不存在的记录 ${t}`);
  }
  // CommonMark: a closing ** after punctuation must be followed by space or punctuation (same for an opening ** before punctuation), else it shows literally.
  const punct = /[\s\p{P}\p{S}]/u;
  lines.forEach((line, i) => {
    const parts = line.split('**'); if (parts.length < 3) return;
    for (let k = 1; k + 1 < parts.length; k += 2) {
      const inner = parts[k], before = parts[k - 1].slice(-1), after = parts[k + 1].slice(0, 1);
      if (inner && ((punct.test(inner.slice(-1)) && after && !punct.test(after)) || (punct.test(inner[0]) && before && !punct.test(before)))) { problems.push('第 ' + (i + 1) + ' 行：加粗「' + inner.slice(0, 12) + '…」的 ** 紧贴相邻文字，页面会露出字面 **；在 ** 外侧加一个空格'); break; }
    }
  });
  const roots = nodes.filter(n => !n.parent), backlinks = new Map(), correctedBy = new Map(), mentions = new Map();
  for (const n of nodes) for (const id of Array.isArray(n.meta.links) ? n.meta.links : []) if (byId.has(id)) backlinks.set(id, [...(backlinks.get(id) || []), n.id].filter(Boolean));
  for (const n of nodes) {
    if (n.entry) for (const id of Array.isArray(n.meta.corrects) ? n.meta.corrects : []) if (byId.has(id) && id !== n.id) correctedBy.set(id, [...(correctedBy.get(id) || []), n.id]);
    for (const t of new Set(n.body.match(MENTION) || [])) if (n.id && n.id !== t && byId.has(t)) mentions.set(t, [...(mentions.get(t) || []), n.id]);
  }
  return { lines, nodes, roots, byId, backlinks, correctedBy, mentions, problems };
}

// 时间记录的排序键：有 date 用 date（范围取起点）；没有 date 但有 after，就排在 after 那条之后（键后加 ~）；都没有则为 null，排在最后。
// 键只用来在主题内排序，不是发生日期：页面用 date_inferred 标明它是推出来的。
function sortKey(n, byId, depth = 0) {
  const d = n.meta.date;
  if (d) return String(d).split('/')[0];
  const up = n.meta.after && depth < 50 ? byId.get(n.meta.after) : null;
  const base = up ? sortKey(up, byId, depth + 1) : null;
  return base ? base + '~' : null;
}

// 记录正文里按固定标签写的「- 缺项：」「- 助手备注：」等顶层条目，页面收进各自的折叠栏，不和事实挤在一起。
// 只拆顶层条目（含它下面缩进的内容），原文一字不改；不在表里的条目留在正文。
// 「用户说明」是用户讲的事实或理由，留在正文里；只有评价才进「用户评价」栏。助手一栏认「助手／Claude／Codex」开头的备注、核算、评价、解释、理解，以及「我对……的理解」。
const AUX = [['用户评价', '用户评价'], ['助手备注', '(?:助手|Claude|Codex)\\s*(?:备注|核算|评价|解释|理解)|我(?:对.{0,40}?)?的理解'], ['讨论', '讨论'], ['缺项', '缺项'], ['来源与性质', '来源与性质|来源|性质'], ['日期依据', '发生时间|日期更正'], ['关联说明', '关联|后续更正|关联／后续更正']]
  .map(([label, src]) => [label, new RegExp('^(?:' + src + ')(?:[（(][^）)]*[）)])?[：:]')]);
export function splitAux(body) {
  const main = [], aux = new Map();
  let current = null, fence = false;
  for (const line of String(body || '').split('\n')) {
    // 代码块（含围栏行）整块跟着它所在的位置走：块里的「- 缺项：」不是新条目，也不会把块拆开。
    const fenceLine = /^\s*```/.test(line), inside = fence || fenceLine;
    if (fenceLine) fence = !fence;
    const top = !inside && /^- (.*)$/.exec(line);
    if (top) current = AUX.find(([, re]) => re.test(top[1]))?.[0] || null;
    else if (!inside && current && line.trim() && !/^\s/.test(line)) current = null;
    if (current) aux.set(current, [...(aux.get(current) || []), line]); else main.push(line);
  }
  return { main: main.join('\n').trim(), aux: AUX.filter(([label]) => aux.has(label)).map(([label]) => ({ label, body: aux.get(label).join('\n').trim(), ...(label === '助手备注' ? noteAuthors(aux.get(label)) : {}) })) };
}
// 助手备注的署名只认条目标签里写明的 Claude／Codex（如「助手备注（Claude，2026-10-07）：」「Codex 备注：」）；没写的不猜作者，页面标「作者未核实」。
function noteAuthors(lines) {
  const authors = new Set(); let unsigned = 0, fence = false;
  for (const line of lines) {
    const f = /^\s*```/.test(line), inside = fence || f; if (f) fence = !fence;
    const top = !inside && /^- (.*)$/.exec(line); if (!top) continue;
    const head = top[1].split(/[：:]/)[0], names = head.match(/Claude|Codex/g);
    if (names) names.forEach(x => authors.add(x)); else unsigned++;
  }
  return { authors: [...authors], unsigned };
}

// What the dashboard receives: plain data, bodies with links flattened to text (relative paths and #anchors do not work in the page).
function plain(n, parsed) {
  const m = n.meta, sorted = n.meta.type === 'timeline' || n.children.some(c => c.entry);
  const flat = text => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const { main, aux } = n.id ? splitAux(flat(n.body)) : { main: flat(n.body), aux: [] };
  const key = n.entry ? sortKey(n, parsed.byId) : null;
  const out = {
    id: n.id, title: n.title, level: n.level, entry: n.entry, tracked: n.tracked && !!n.id,
    ...(m.type ? { type: m.type } : {}), ...(m.kind ? { kind: m.kind } : {}), ...(m.summary ? { summary: m.summary } : {}),
    ...(m.status ? { status: m.status, note: m.note || '', status_date: m.status_date || null } : {}), ...(m.history?.length ? { history: m.history } : {}),
    ...(n.entry || m.date !== undefined ? { date: m.date || null, date_confirmed: !!m.date_confirmed } : {}),
    ...(n.entry ? { sort_key: key, date_inferred: !m.date && !!key, ...(m.after ? { after: { id: m.after, title: parsed.byId.get(m.after)?.title || m.after } } : {}) } : {}),
    links: (m.links || []).map(id => ({ id, title: parsed.byId.get(id)?.title || id })),
    backlinks: (n.id && parsed.backlinks.get(n.id) || []).map(id => { const b = parsed.byId.get(id); return { id, title: b.title, entry: b.entry, date: b.meta.date || null, sort_key: b.entry ? sortKey(b, parsed.byId) : null }; }),
    work: m.work || [], files: m.files || [],
    body: main, aux,
    children: n.children.map(c => plain(c, parsed)),
  };
  if (sorted) out.children.sort((a, b) => {
    if (!!a.entry !== !!b.entry) return a.entry ? 1 : -1;       // 说明性小节在前，记录在后
    if (!a.entry) return 0;
    if (!a.sort_key !== !b.sort_key) return a.sort_key ? -1 : 1; // 有日期（或能推出先后）的在前，其余归到最后
    return String(a.sort_key).localeCompare(String(b.sort_key)) || a.id.localeCompare(b.id);
  });
  return out;
}

const workIds = () => new Set(read('work/queue.json', { items: [] }).items.map(i => i.id));
export function readFramework(projectId) {
  const file = frameworkFile(projectId);
  if (!fs.existsSync(file)) return null;
  const parsed = parseFramework(fs.readFileSync(file, 'utf8'), { workIds: workIds() });
  if (!parsed.roots.length) return null;
  return { boards: parsed.roots.map(n => plain(n, parsed)), problems: parsed.problems };
}
export function withFramework(projects) {
  return projects.map(p => { try { const framework = /^[a-z0-9-]+$/.test(p.id) && readFramework(p.id); return framework ? { ...p, framework } : p; } catch { return p; } });
}
// 更正关系只来自后来记录里的 corrects；索引里标出，让读者先看更正再引用旧条。
// 正文里原地写了「- 后续更正」的条目：没有记录声明时也要让读者先读更正，不猜是谁更正的。
export const hasCorrectionNote = n => /^- 后续更正/m.test(n.body);
const correctionTag = (n, parsed) => {
  const by = n.id && parsed.correctedBy.get(n.id), of = Array.isArray(n.meta.corrects) ? n.meta.corrects : [];
  const tag = [by?.length ? '已被 ' + by.join('、') + ' 更正' : hasCorrectionNote(n) && '正文含后续更正，先读', of.length && '更正 ' + of.join('、')].filter(Boolean).join('；');
  return tag ? '［' + tag + '］' : '';
};
// Project orientation and evidence access have one owner. Include every non-log
// node (also those nested in the timeline); keep a complete log index, not a
// recency lottery. Bodies are read explicitly through read-nodes after the work
// agent selects relevant topics; unrelated Methods and file metadata stay out.
export function frameworkDigest(projectId) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) return '';
  const source = fs.readFileSync(frameworkFile(projectId), 'utf8');
  const parsed = parseFramework(source);
  if (!parsed.roots.length) return '';
  const describe = n => [
    `${'#'.repeat(n.level)} ${n.id ? n.id + ' ' : ''}${n.title}${n.id ? '' : '（原文第 ' + (n.line + 1) + ' 行）'}${correctionTag(n, parsed)}`,
    `节点摘要：${n.meta.summary || '未记录摘要，按入口读取原文。'}`,
    Object.keys(n.meta).some(k => ['type','kind','status','status_date','date'].includes(k)) &&
      `节点属性：${JSON.stringify(Object.fromEntries(Object.entries(n.meta).filter(([k]) => ['type','kind','status','status_date','date'].includes(k))))}`,
    ...n.children.filter(c => !c.entry).flatMap(describe),
  ].filter(Boolean);
  const out = [
    fragment('framework/digest-header', { file: frameworkFile(projectId), project: projectId }),
    ...parsed.roots.filter(n => !n.entry).flatMap(describe),
  ];
  const entries = parsed.nodes.filter(n => n.entry);
  if (entries.length) {
    out.push(`历史日志完整索引（${entries.length} 条；这里只是索引，不是实验结论）：`);
    for (const n of entries) out.push(`- ${n.id} ${n.title}（日期：${n.meta.date || (n.meta.after ? '在 ' + n.meta.after + ' 之后' : '未记录')}；父节点：${n.parent?.id || '无'}）${correctionTag(n, parsed)}${n.meta.summary ? '：' + n.meta.summary : ''}`);
  }
  return out.join('\n');
}
// Raw evidence can change without changing orientation. Its revision is tracked
// separately so native continuations get a small invalidation notice, not a bulk resend.
export function frameworkRevision(projectId) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) return '';
  return createHash('sha256').update(fs.readFileSync(frameworkFile(projectId))).digest('hex');
}
// Exact source slices, including descendants, retain provenance and annotations.
// No ranking, summarisation or fallback guess silently changes what was requested.
export function readFrameworkNodes(projectId, ids) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) throw new Error('该项目没有 FRAMEWORK.md');
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('请提供节点 ID');
  const file = frameworkFile(projectId), source = fs.readFileSync(file, 'utf8'), parsed = parseFramework(source);
  const nodes = [...new Set(ids)].map(id => {
    const n = parsed.byId.get(id);
    if (!n) throw new Error('未找到项目节点：' + id);
    const end = parsed.nodes.find(x => x.line > n.line && x.level <= n.level)?.line ?? parsed.lines.length;
    return {id, title:n.title, start_line:n.line + 1, end_line:end, text:parsed.lines.slice(n.line, end).join('\n')};
  });
  return {project_id:projectId, source:file, revision:createHash('sha256').update(source).digest('hex'), nodes};
}
// 板块正文开头的“**目的…**”段（标题行加紧跟的列表）。步骤所在栏自己没写时，程序沿上级栏找最近的一段带给做事的人，不靠写的人记得引用。
export function purposeBlock(body) {
  const m = /^\*\*目的[^\n]*\*\*[ \t]*\n+((?:- [^\n]*(?:\n|$))+)/m.exec(body || '');
  return m ? `${m[0].trimEnd()}` : '';
}
export function inheritedPurpose(node) {
  for (const up of [node, ...[...node.ancestors].reverse()]) {
    const text = purposeBlock(up.body);
    if (text) return { text, from: up === node ? null : up.title };
  }
  return null;
}
// 项目的逻辑部分（type=logic 的板块）：各节点标题加摘要，由程序直接给做时间日志里步骤的人，背景不靠自己去读。节点本身在逻辑部分里时不重复。
export function logicOutline(parsed, node) {
  const roots = parsed.roots.filter(r => r.meta.type === 'logic');
  if (!roots.length || roots.some(r => r === node || node.ancestors.includes(r))) return '';
  const lines = [];
  const walk = (m, depth) => { if (m.id && m.meta.summary) lines.push(`${'  '.repeat(depth)}- ${m.title}：${m.meta.summary}`); for (const c of m.children) walk(c, depth + 1); };
  for (const r of roots) for (const c of r.children) walk(c, 0);
  return lines.length ? `研究理解（项目逻辑部分的节点标题与摘要）：\n${lines.join('\n')}` : '';
}
export function frameworkNode(projectId, nodeId) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) return null;
  const parsed = parseFramework(fs.readFileSync(frameworkFile(projectId), 'utf8'));
  const n = parsed.byId.get(nodeId);
  if (!n) return null;
  const purpose = inheritedPurpose(n);
  const description = [n.meta.summary || '', purpose ? `${purpose.from ? `（以下目的取自上级栏「${purpose.from}」）\n` : ''}${purpose.text}` : '', logicOutline(parsed, n)].filter(Boolean).join('\n\n');
  return { id: n.id, title: n.title, description, files: n.meta.files || [] };
}

// 只读：哪些条目已被后来的记录声明更正，谁直接引用它们（links 或正文提到编号）。引用者是复核候选，不是已证实受影响的依赖者，程序不替人判断，也不写任何标记。
// 不带 nodeId：列出全部已声明的更正，并单列「正文写了后续更正、但没有记录声明」的条目，供补声明。带 nodeId：只看这一条（没被更正也列出谁依赖它）。
// 只算直接引用：links 不分强弱，沿它传递会把大半个项目都卷进来。
export function impactReport(projectId, nodeId) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) throw new Error('该项目没有 FRAMEWORK.md');
  const parsed = parseFramework(fs.readFileSync(frameworkFile(projectId), 'utf8'));
  const brief = n => ({ id: n.id, title: n.title, date: n.meta.date || null });
  const targets = nodeId ? [find(parsed, nodeId)] : [...parsed.correctedBy.keys()].map(id => parsed.byId.get(id));
  const corrected = targets.map(t => {
    const by = parsed.correctedBy.get(t.id) || [];
    const ids = new Map();
    for (const [via, list] of [['links', parsed.backlinks.get(t.id)], ['mention', parsed.mentions.get(t.id)]]) for (const id of list || []) if (id !== t.id && !by.includes(id)) ids.set(id, [...(ids.get(id) || []), via]);
    const referrers = [...ids].map(([id, via]) => {
      const d = parsed.byId.get(id);
      return { ...brief(d), via, also_cites_corrector: by.some(c => (d.meta.links || []).includes(c) || (parsed.mentions.get(c) || []).includes(id)) };
    });
    return { ...brief(t), corrected_by: by.map(id => brief(parsed.byId.get(id))), referrers };
  });
  const out = { project_id: projectId, corrected };
  if (!nodeId) out.note_only = parsed.nodes.filter(n => n.id && !parsed.correctedBy.has(n.id) && hasCorrectionNote(n)).map(brief);
  return out;
}

function historicalEntries(projectId) {
  const dir=path.join(root,'.runtime/framework-edits',projectId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.md$/.test(f)).flatMap(f=>parseFramework(fs.readFileSync(path.join(dir,f),'utf8')).nodes.filter(n=>n.entry)) : [];
}
export function checkFramework(projectId, { today = chicago().replaceAll('-', ''), source } = {}) {
  const exists = fs.existsSync(frameworkFile(projectId));
  if (source === undefined && !exists) return { project_id: projectId, exists: false, problems: ['没有 FRAMEWORK.md'] };
  const parsed = parseFramework(source ?? fs.readFileSync(frameworkFile(projectId), 'utf8'), { workIds: source === undefined ? workIds() : undefined });
  const entries = parsed.nodes.filter(n => n.entry), problems = parsed.problems.slice();
  if (!parsed.roots.some(n => n.meta.type === 'timeline')) problems.push('没有 type=timeline 的一级板块，新记录无处追加');
  const used = Math.max(0, ...entries.concat(source===undefined ? historicalEntries(projectId) : []).filter(e => e.date8 === today).map(e => e.n));
  return { project_id: projectId, exists: true, boards: parsed.roots.map(n => n.id || n.title), nodes: parsed.nodes.filter(n => n.id).length,
    timeline_entries: entries.length, undated_entries: entries.filter(e => !e.meta.date).length,
    next_timeline_id: 'T-' + today + '-' + String(used + 1).padStart(2, '0'), problems, ok: !problems.length };
}

// ---- 写入：每次只改目标那几行，改完重新解析，若引入新问题就不写。 ----
function metaLine(meta) {
  const o = {};
  for (const k of KEYS) { const v = meta[k]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue; o[k] = v; }
  return '<!--node ' + JSON.stringify(o).replace(/-->/g, '--\\u003e') + '-->';
}
const revisionOf = text => createHash('sha256').update(text).digest('hex');
function edit(projectId, change, { revision, backup = false } = {}) {
  const file = frameworkFile(projectId);
  if (!/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(file)) throw new Error('该项目没有 FRAMEWORK.md');
  const text = fs.readFileSync(file, 'utf8'), eol = text.includes('\r\n') ? '\r\n' : '\n', ids = workIds();
  if (revision !== undefined && revision !== revisionOf(text)) throw new Error('内容已被其他操作更新，未覆盖。请保留草稿，核对最新版后再保存。');
  const before = parseFramework(text, { workIds: ids }), lines = before.lines.slice();
  const result = change(before, lines);
  const next = lines.join(eol), after = parseFramework(next, { workIds: ids });
  const known = new Set(before.problems.map(sameProblem)), fresh = after.problems.filter(p => !known.has(sameProblem(p)));
  if (fresh.length) throw new Error('改动会引入问题，未写入：' + fresh.join('；'));
  if (backup && next !== text) {
    const dir = path.join(root, '.runtime/framework-edits', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, revisionOf(text) + '.md');
    if (!fs.existsSync(copy)) fs.writeFileSync(copy, text);
  }
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, next); fs.renameSync(temp, file);
  return result;
}
const find = (parsed, id) => { const n = parsed.byId.get(id); if (!n) throw new Error('未找到 ' + id); return n; };
function setMeta(lines, node, meta) {
  const text = metaLine(meta);
  if (node.metaLine >= 0) lines[node.metaLine] = text; else lines.splice(node.line + 1, 0, text);
}
function insertAfterSubtree(parsed, lines, parent, block) {
  const siblingsEnd = parent ? (parsed.nodes.find(n => n.line > parent.line && n.level <= parent.level)?.line ?? lines.length) : lines.length;
  let at = siblingsEnd; while (at > 0 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, '', ...block);
}
const clean = v => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim() : '';
const bodyLines = body => typeof body === 'string' && body.trim() ? ['', ...body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().split(/\r?\n/)] : [];

// 改状态。离开「完成」或「失败」就是推翻一个结论，必须写原因；设为「未开始／待定义」必须说明是哪一种。
export function setStatus(projectId, id, status, { note, reason } = {}) {
  if (status !== 'none' && !STATUSES[status]) throw new Error('状态只能是 ' + Object.keys(STATUSES).join('、') + ' 或 none（清除）');
  return edit(projectId, (parsed, lines) => {
    const n = find(parsed, id);
    if (!n.tracked) throw new Error('说明性板块不带状态');
    const m = { ...n.meta }, from = m.status || null, to = status === 'none' ? null : status;
    const why = clean(reason), memo = clean(note);
    if (to && n.meta.kind === 'attempt' && !ATTEMPT_STATES.includes(to)) throw new Error('「尝试」是已发生的一次，只能标完成或失败；还没做的事请登记成 work 步骤');
    if (to === 'open' && !memo) throw new Error('「未开始／待定义」要写明是哪一种（note）');
    if (['done', 'failed'].includes(from) && from !== to && !why) throw new Error('从「' + STATUSES[from] + '」改成别的状态要写原因（reason）：这是在推翻一个已记的结论');
    if (from === to && (to !== 'open' || memo === (m.note || ''))) return { id, status: to, changed: false };
    if (to) { m.status = to; m.status_date = chicago(); if (memo) m.note = memo; else delete m.note; } else { delete m.status; delete m.status_date; delete m.note; }
    m.history = [...(m.history || []), [chicago(), from, to, why]];
    setMeta(lines, n, m);
    return { id, from, status: to, changed: true };
  });
}
// 改节点的几个简单字段（补日期、说明 after、改摘要、改 kind）。设了 date 就清掉 after；空值或 null 表示删除该字段。状态、关联、编号和正文不走这里。
const SETTABLE = ['date', 'date_confirmed', 'after', 'summary', 'kind'];
function updateFields(lines, n, fields) {
    const m = { ...n.meta }, keys = Object.keys(fields || {});
    if (!keys.length) throw new Error('没有要改的字段');
    for (const k of keys) {
      if (!SETTABLE.includes(k)) throw new Error('只能改 ' + SETTABLE.join('、') + '；状态用 node-status，关联用 node-link');
      const v = fields[k];
      if (v === null || v === '' || v === false && k !== 'date_confirmed') delete m[k]; else m[k] = k === 'summary' ? clean(v) : v;
    }
    if (m.date) delete m.after;
    // 日期变了，旧日期的「已确认」不能留给新日期；正文里原先写的日期依据也要明确更正，不让页面和详情各说一个日期。
    const was = n.meta.date || null, now = m.date || null;
    if (was !== now) {
      if (!keys.includes('date_confirmed')) delete m.date_confirmed;
      if (n.entry) {
        let at = n.bodyEnd; while (at > n.line + 1 && lines[at - 1].trim() === '') at--;
        const last = lines[at - 1] || '', note = '- 日期更正（' + chicago() + '，node-set）：发生时间由「' + (was || '待确认') + '」改为「' + (now || '待确认') + '」' + (m.date_confirmed ? '（已确认）' : '（待确认）') + '；以此处和结构化字段为准，上文「发生时间」中的旧日期仅作历史。';
        lines.splice(at, 0, ...(/^(\s|- )/.test(last) ? [] : ['']), note);
      }
    }
    setMeta(lines, n, m);
    return { id: n.id, fields: keys };
}
export function setFields(projectId, id, fields) {
  return edit(projectId, (parsed, lines) => updateFields(lines, find(parsed, id), fields));
}
// rel 缺省是普通关联（links）；rel:'corrects' 声明 from 这条后来的记录更正了更早的 to，只追加在 from 上，to 不动。
export function linkNodes(projectId, from, to, rel) {
  if (rel !== undefined && rel !== 'corrects') throw new Error("rel 只能是 'corrects'，或不填表示普通关联");
  const key = rel === 'corrects' ? 'corrects' : 'links';
  return edit(projectId, (parsed, lines) => {
    const a = find(parsed, from); find(parsed, to);
    if (a.meta[key]?.includes(to)) return { from, to, ...(rel ? { rel } : {}), changed: false };
    setMeta(lines, a, { ...a.meta, [key]: [...(a.meta[key] || []), to] });
    return { from, to, ...(rel ? { rel } : {}), changed: true };
  });
}
// 追加日志：parent 指定日志主题或尝试；不指定则写进 timeline 根部，页面提示尚未归类。
export function addEntry(projectId, { parent, title, date, date_confirmed, after, body, links, corrects, work, status, note, summary }, options) {
  return edit(projectId, (parsed, lines) => {
    const board = parsed.roots.find(n => n.meta.type === 'timeline');
    if (!board) throw new Error('没有 type=timeline 的板块');
    const up = parent ? find(parsed, parent) : board;
    if (up.entry || !up.ancestors.concat(up).some(n => n.meta.type === 'timeline')) throw new Error('parent 必须是时间日志中的主题或子板块，不能是逻辑节点或记录');
    if (up.level >= 6) throw new Error('嵌套已到最深一层');
    // Deleted logs remain in pre-edit backups; never recycle their stable IDs.
    const day = chicago().replaceAll('-', ''), prior=historicalEntries(projectId);
    const id = 'T-' + day + '-' + String(Math.max(0, ...parsed.nodes.concat(prior).filter(n => n.date8 === day).map(n => n.n)) + 1).padStart(2, '0');
    const t = clean(title); if (!t) throw new Error('缺少 title');
    const meta = { summary: clean(summary), date: date || null, date_confirmed: !!date_confirmed, after: date ? undefined : after, links, corrects, work };
    if (status) { if (status === 'open' && !clean(note)) throw new Error('open 要写 note'); Object.assign(meta, { status, note: clean(note), status_date: chicago(), history: [[chicago(), null, status, '']] }); }
    insertAfterSubtree(parsed, lines, up, ['#'.repeat(up.level + 1) + ' ' + id + ' ' + t, metaLine(meta), ...bodyLines(body)]);
    return { id, date: meta.date };
  }, options);
}
// 新增板块或子板块。parent 为 null 时新开一级板块（type 可选 info／logic／timeline）。
export function addNode(projectId, { parent, id, title, body, summary, type, kind, status, note }, options) {
  return edit(projectId, (parsed, lines) => {
    const up = parent ? find(parsed, parent) : null;
    if (up && up.level >= 6) throw new Error('嵌套已到最深一层');
    if (!ID.test(String(id))) throw new Error('id 只能用小写字母、数字和连字符');
    const t = clean(title); if (!t) throw new Error('缺少 title');
    const meta = { id, type, kind, summary: clean(summary) };
    if (status) { if (status === 'open' && !clean(note)) throw new Error('open 要写 note'); Object.assign(meta, { status, note: clean(note), status_date: chicago(), history: [[chicago(), null, status, '']] }); }
    insertAfterSubtree(parsed, lines, up, ['#'.repeat(up ? up.level + 1 : 2) + ' ' + t, metaLine(meta), ...bodyLines(body)]);
    return { id };
  }, options);
}

// Page and CLI share the same editor. Raw prose is loaded on demand, never reconstructed from display panels.
export function editorSnapshot(projectId) {
  if (!/^[a-z0-9-]+$/.test(projectId) || !fs.existsSync(frameworkFile(projectId))) throw new Error('该项目没有 FRAMEWORK.md');
  const text = fs.readFileSync(frameworkFile(projectId), 'utf8'), parsed = parseFramework(text);
  const dir = path.join(root, '.runtime/framework-edits', projectId);
  const backups = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.md$/.test(name)).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { revision: name.slice(0, -3), saved_at: stat.mtime.toISOString(), bytes: stat.size,
      path: '.runtime/framework-edits/' + projectId + '/' + name };
  }).sort((a,b) => b.saved_at.localeCompare(a.saved_at)) : [];
  return { revision: revisionOf(text), backups, nodes: parsed.nodes.filter(n => n.id).map(n => ({
    id: n.id, title: n.title, body: n.body, summary: n.meta.summary || '', level: n.level,
    parent: n.parent?.id || null, entry: n.entry, type: n.meta.type || null, kind: n.meta.kind || null,
    date: n.meta.date || '', date_confirmed: !!n.meta.date_confirmed, after: n.meta.after || '',
    line_type: n.ancestors.concat(n).find(a => a.meta.type)?.meta.type || null,
    ancestors: n.ancestors.map(a => a.id).filter(Boolean)
  })) };
}
function editorText(value, label) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(label + '格式不合适');
  return value;
}
function safeBody(value) {
  const body = editorText(value, '正文').replace(/\r\n/g, '\n');
  // Match the framework parser's fence boundary, not inline backticks. An open fence can hide subsequent nodes.
  if (body.split('\n').filter(line => /^\s*```/.test(line)).length % 2) throw new Error('正文的代码围栏未闭合，请补上结束的 ``` 再保存；文件未修改。');
  // Structure has its own controls. Permit ordinary H1/Markdown/code, but not new node headings or metadata.
  if (parseFramework(body).nodes.length || /<!--node\b/.test(body)) throw new Error('正文不能包含框架标题（## 到 ######）或 node 元数据；请用新增子栏来编辑结构。');
  return body;
}
function unlinkDeletedText(text, ids) {
  // Keep the surrounding research text, but remove live links to deleted logs.
  return text.replace(/\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (whole,label,target)=>{
    const local=/^(?:#|(?:\.\/)?FRAMEWORK\.md#)(.+)$/.exec(target);
    return local && ids.has(local[1]) ? label : whole;
  }).replace(MENTION,id=>ids.has(id)?'已删除记录（原编号 '+id.slice(2)+'）':id);
}
function detachDeletedReferences(projectId, ids) {
  const queue=read('work/queue.json',{items:[]});
  let changed=false;
  for(const item of queue.items) {
    if(item.project_ids?.includes(projectId)) {
      if(ids.has(item.plan_node_id)){delete item.plan_node_id;changed=true;}
      if(ids.has(item.log_requirement?.parent) || ids.has(item.log_requirement?.topic)){delete item.log_requirement;changed=true;}
    }
    if(item.sources) {
      const sources=item.sources.filter(source=>![...ids].some(id=>source===projectId+'#'+id ||
        item.project_ids?.includes(projectId) && source===id));
      if(sources.length!==item.sources.length){item.sources=sources;changed=true;}
    }
  }
  if(changed)write('work/queue.json',queue);
  const catalog=read('projects/catalog.json'),project=catalog.projects.find(p=>p.id===projectId);
  if(project && ids.has(project.active_node_id)){delete project.active_node_id;write('projects/catalog.json',catalog);}
}
export function editFramework(projectId, request) {
  const { action, revision } = request;
  // 移动只按条目 ID 和位置在当前文件上重算，不带正文，所以拖动可以不带版本；写入的内容仍由当前文件决定。
  if ((revision !== undefined || action !== 'move') && !/^[a-f0-9]{64}$/.test(revision || '')) throw new Error('缺少有效的编辑版本，请重新打开编辑器');
  const options = { revision, backup: true };
  if (action === 'add-node' || action === 'add-entry') {
    if (request.parent) {
      const up = editorSnapshot(projectId).nodes.find(n => n.id === request.parent);
      if (!up || up.entry) throw new Error('新增子栏或记录要选择板块，不能选择单条日志');
    }
    const title = editorText(request.title, '标题').trim(); if (!title || /\r|\n/.test(title)) throw new Error('标题不能为空或换行');
    const body = safeBody(request.body || '');
    const summary = editorText(request.summary || '', '摘要');
    if (action === 'add-entry') return addEntry(projectId, { parent: request.parent, title, body, summary }, options);
    const kind = request.parent ? request.kind || 'info' : undefined; if (kind && !KINDS[kind]) throw new Error('节点性质不合法');
    const type = request.type || undefined;
    if (!request.parent && !TYPES.includes(type)) throw new Error('新大板块要选择说明、逻辑或时间日志');
    return addNode(projectId, { parent: request.parent, id: 'n-' + randomUUID(), title, body, summary, kind, type: request.parent ? undefined : type }, options);
  }
  let deletedIds;
  const result=edit(projectId, (parsed, lines) => {
    const n = find(parsed, request.id);
    if(action==='delete') {
      if(request.confirm!==true)throw new Error('请确认删除本栏及全部子栏');
      const end=parsed.nodes.find(x=>x.line>n.line && x.level<=n.level)?.line ?? lines.length;
      const branch=parsed.nodes.filter(x=>x.line>=n.line && x.line<end),ids=new Set(branch.map(x=>x.id).filter(Boolean));
      if(n.meta.type==='timeline' && !parsed.roots.some(x=>x!==n && x.meta.type==='timeline'))throw new Error('不能删除最后一个时间日志板块');
      for(const other of parsed.nodes.filter(x=>x.line<n.line || x.line>=end)) {
        const meta={...other.meta};
        for(const key of ['links','corrects'])if(Array.isArray(meta[key]))meta[key]=meta[key].filter(id=>!ids.has(id));
        if(ids.has(meta.after))delete meta.after;
        if(JSON.stringify(meta)!==JSON.stringify(other.meta))setMeta(lines,other,meta);
        const from=other.metaLine>=0?other.metaLine+1:other.line+1;
        for(let at=from;at<other.bodyEnd;at++)lines[at]=unlinkDeletedText(lines[at],ids);
      }
      deletedIds=ids;
      lines.splice(n.line,end-n.line);return {deleted:n.id,count:branch.length};
    }
    const fields = request.fields;
    if (fields && (!n.entry || Object.keys(fields).some(k => !['date','date_confirmed','after'].includes(k)))) throw new Error('编辑器字段只用于日志的 date、date_confirmed、after');
    if (fields && fields.date_confirmed !== undefined && typeof fields.date_confirmed !== 'boolean') throw new Error('日期确认必须是布尔值');
    if (action === 'fields') return updateFields(lines, n, fields);
    if (action === 'content') {
      const title = editorText(request.title, '标题').trim(); if (!title || /\r|\n/.test(title)) throw new Error('标题不能为空或换行');
      if (!n.entry && ENTRY.test(title)) throw new Error('板块标题不能冒充 T- 记录编号');
      const body = safeBody(request.body), summary = editorText(request.summary || '', '摘要');
      const end = n.bodyEnd;
      lines.splice(n.line, end - n.line, '#'.repeat(n.level) + ' ' + (n.entry ? n.id + ' ' : '') + title,
        metaLine({ ...n.meta, summary: clean(summary) }), ...bodyLines(body), '');
      if (fields && Object.keys(fields).length) updateFields(lines, find(parseFramework(lines.join('\n')), n.id), fields);
      return { id: n.id };
    }
    if (action !== 'move') throw new Error('未知编辑动作');
    const up = request.parent ? find(parsed, request.parent) : null;
    if (up && (up === n || up.ancestors.includes(n))) throw new Error('不能移入自己或自己的子栏');
    if (up?.entry) throw new Error('不能把板块放进单条日志');
    if (!up && (n.entry || !n.meta.type)) throw new Error('子栏和记录必须选择所属板块');
    if (up && n.meta.type) throw new Error('一级大板块不能移入子栏');
    const lineType = x => x?.ancestors.concat(x).find(a => a.meta.type)?.meta.type;
    if (n.entry && lineType(up) !== 'timeline') throw new Error('记录只能移入时间日志');
    if (lineType(n) !== lineType(up || n)) throw new Error('移动只能在同一内容线内，逻辑论证与时间日志不能混搬');
    const end = parsed.nodes.find(x => x.line > n.line && x.level <= n.level)?.line ?? lines.length;
    const branch = parsed.nodes.filter(x => x.line >= n.line && x.line < end), delta = (up ? up.level + 1 : 2) - n.level;
    if (branch.some(x => x.level + delta > 6)) throw new Error('目标嵌套会超过六级，请选更上层的子栏');
    // before／after 指定同级中的位置；都不写则放到新父级的末尾。
    const subtreeEnd = x => parsed.nodes.find(y => y.line > x.line && y.level <= x.level)?.line ?? lines.length;
    if (request.before && request.after) throw new Error('只能指定 before 或 after 其中一个');
    const ref = request.before || request.after ? find(parsed, request.before || request.after) : null;
    if (ref && (ref === n || ref.parent !== up)) throw new Error('定位对象必须是目标位置里的其他同级条目');
    const at = ref ? (request.before ? ref.line : subtreeEnd(ref)) : up ? subtreeEnd(up) : lines.length;
    if (ref && delta === 0 && n.parent === up && (at === n.line || at === end)) return { id: n.id, parent: up?.id || null, changed: false };
    const block = lines.slice(n.line, end);
    for (const x of branch) block[x.line - n.line] = '#'.repeat(x.level + delta) + ' ' + x.heading;
    while (block.length && !block.at(-1).trim()) block.pop();
    lines.splice(n.line, end - n.line);
    let pos = at > n.line ? at - (end - n.line) : at;
    if (pos >= lines.length) { while (lines.length && !lines.at(-1).trim()) lines.pop(); pos = lines.length; }
    lines.splice(pos, 0, ...(pos > 0 && lines[pos - 1].trim() ? [''] : []), ...block, '');
    return { id: n.id, parent: up?.id || null, changed: true };
  }, options);
  if(deletedIds)detachDeletedReferences(projectId,deletedIds);
  return result;
}
export function appendFiles(projectId, nodeId, added) {
  return edit(projectId, (parsed, lines) => {
    const n = find(parsed, nodeId);
    setMeta(lines, n, { ...n.meta, files: [...(n.meta.files || []), ...added] });
  });
}
