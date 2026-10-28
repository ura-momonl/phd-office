import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../automation/files.mjs';

// Read-only work-turn artifacts. Never reconstruct historical text from today's fragments:
// manifests record an inventory, not source offsets. Native continuation can send only a delta.
const TASK = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TURN = /^[2-9]\d*$|^1\d+$/;
const RUN = new RegExp(`^${TASK.source.slice(1,-1)}(?:/(?:[2-9]\\d*|1\\d+))?$`, 'i');
const home = base => path.join(base, '.runtime/agent/runs');
function directory(id, base) {
  if (!RUN.test(id)) throw new Error('运行 id 不合法');
  let dir = home(base);
  for (const part of id.split('/')) {
    dir = path.join(dir, part);
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('运行目录不能是链接');
  }
  return dir;
}
function artifact(dir, name) {
  const file = path.join(dir, name);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('运行文件不能是链接');
    return { file, stat: st };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function json(dir, name) {
  const f = artifact(dir, name);
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f.file, 'utf8')); }
  catch (e) { if (e instanceof SyntaxError) return null; throw e; }
}
function metadata(id, dir) {
  const native = artifact(dir, 'native-prompt.txt'), compiled = artifact(dir, 'prompt.txt');
  if (!native && !compiled) return null;
  const m = json(dir, 'prompt-manifest.json');
  return { id, provider: m?.speaker || null, turn: null, handoff_turn: Number(id.split('/')[1] || 1),
    at: (native || compiled).stat.mtime.toISOString(), bytes: (native || compiled).stat.size,
    source: native ? 'native-prompt.txt' : 'prompt.txt', has_manifest: !!m };
}

function conversations(base) {
  const file = path.join(base,'.runtime/agent/sessions.json');
  if (!fs.existsSync(file)) return { sessions:[], tasks:new Map() };
  const sessions = JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).sessions || [];
  const tasks = new Map();
  for (const s of sessions) (s.task_ids || []).forEach((id,i) => tasks.set(id,{session:s,turn:i+1}));
  return { sessions, tasks };
}
function inConversation(row, context) {
  const ref = context.tasks.get(row.id.split('/')[0]);
  if (!ref) return row; // Unowned old artifacts must not all pretend to be turn 1.
  const s = ref.session, providers = [...new Set((s.messages || []).filter(m => m.task_id === row.id.split('/')[0] && m.role === 'assistant').map(m=>m.provider).filter(p=>['claude','codex','deepseek'].includes(p)))];
  return {...row,provider:row.provider || (providers.length===1?providers[0]:null),turn:ref.turn,session_id:s.id,session_title:s.title || '',session_at:s.messages?.at(-1)?.at || s.created_at || row.at};
}

// A source map is useful only for these exact historical bytes, with ordered, nested ranges.
// Damaged/old records stay readable as plain text; today's templates never fill the gaps.
function checkedSources(map, body) {
  if (!map || map.version !== 1 || map.sha256 !== createHash('sha256').update(body).digest('hex') || !map.fragments || typeof map.fragments !== 'object') return null;
  const walk = (nodes, start, end, depth = 0) => {
    if (!Array.isArray(nodes) || depth > 64) return false;
    let at = start;
    for (const n of nodes) {
      if (!n || !['fragment','source','value'].includes(n.kind) || !Number.isInteger(n.start) || !Number.isInteger(n.end) || n.start < at || n.end < n.start || n.end > end) return false;
      if (n.kind === 'fragment') {
        if (typeof n.id !== 'string' || !/^[a-z0-9][a-z0-9/_-]*$/.test(n.id) || typeof n.sha256 !== 'string') return false;
        const f = map.fragments[n.id + '@' + n.sha256];
        if (!f || f.id !== n.id || typeof f.body !== 'string' || createHash('sha256').update(f.body).digest('hex') !== n.sha256) return false;
      }
      if (!walk(n.children ?? [], n.start, n.end, depth + 1)) return false;
      at = n.end;
    }
    return true;
  };
  return walk(map.nodes, 0, body.length) ? map : null;
}

// All retained work inputs from the latest 100 conversations, including handoffs.
// Session task order is the conversation round; numbered run subdirectories are only handoffs.
export function promptRuns(base = root) {
  const dir = home(base);
  if (!fs.existsSync(dir)) return { runs: [] };
  const context = conversations(base);
  const sessions = [...context.sessions].sort((a,b)=>(b.messages?.at(-1)?.at || b.created_at || '').localeCompare(a.messages?.at(-1)?.at || a.created_at || '')).slice(0,100);
  const rows = [];
  for (const s of sessions) {
    for (const task of s.task_ids || []) {
      if (!TASK.test(task)) continue;
      if (fs.existsSync(path.join(dir,task))) {
        const d = directory(task,base);
        const ids = [task,...fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&TURN.test(e.name)).sort((a,b)=>Number(a.name)-Number(b.name)).map(e=>task+'/'+e.name)];
        for (const id of ids) {
          const raw = metadata(id,directory(id,base)); if (!raw) continue;
          const row = inConversation(raw,context);
          rows.push(row);
        }
      }
    }
  }
  return { runs: rows.sort((a,b)=>b.session_at.localeCompare(a.session_at)||b.at.localeCompare(a.at)) };
}

export function promptRun(id, base = root) {
  const dir = directory(id, base), raw = metadata(id, dir);
  if (!raw) throw new Error('这个运行没有提示词记录');
  const info = inConversation(raw,conversations(base));
  const body = fs.readFileSync(artifact(dir, info.source).file, 'utf8');
  const manifest = json(dir, 'prompt-manifest.json'), continuation = json(dir, 'continuation.json');
  const native = info.source === 'native-prompt.txt', resumed = native && continuation?.resumed === true;
  const warnings = [];
  let inventory = null;
  if (!native) warnings.push('没有原生发送记录；这里只是应用层拼装稿，不能确认本轮实际发送了全稿还是续接增量。');
  if (!manifest) warnings.push('没有可读的 manifest；无法列出本轮使用的片段。');
  else if (!native && createHash('sha256').update(body).digest('hex') === manifest.prompt_sha256) inventory = manifest.fragments;
  else if (native && resumed && (manifest.resume_prompt_sha256 ? createHash('sha256').update(body).digest('hex') === manifest.resume_prompt_sha256 : body.length === manifest.resume_prompt_chars)) {
    inventory = manifest.resume_fragments;
    warnings.push(manifest.resume_prompt_sha256 ? '本轮为原生续接，仅显示这轮发送的增量（已核对 SHA-256），不是完整线程历史。' : '本轮为原生续接，仅显示这轮发送的增量；片段清单按续接记录选择，只核对了字数（旧记录没有增量哈希）。');
  } else if (native && createHash('sha256').update(body).digest('hex') === manifest.prompt_sha256) inventory = manifest.fragments;
  else warnings.push('正文与 manifest 无法核对，暂不关联片段清单。');
  if (manifest && !Array.isArray(inventory) && !warnings.some(w => w.includes('无法核对'))) warnings.push('manifest 没有与这份正文对应的片段清单。');
  const candidate = resumed ? manifest?.resume_sources : manifest?.sources;
  const sources = checkedSources(candidate, body);
  if (candidate && !sources) warnings.push('来源位置记录未通过正文哈希或范围核对，已退回原样全文。');
  return { ...info, body, resumed, warnings, sources,
    fragments: Array.isArray(inventory) ? inventory.filter(f => typeof f?.id === 'string' && /^[a-z0-9][a-z0-9/_-]*$/.test(f.id)).map(f => ({ id: f.id, uses: f.uses })) : [] };
}
