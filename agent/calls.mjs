import fs from 'node:fs';
import path from 'node:path';
import { root, read } from '../automation/files.mjs';
import { usageSnapshot } from '../usage/run.mjs';

// Read-only review of what one turn actually called. The program lays out the request, the calls in order (what was asked, how much came back) and lets
// one call be opened in full. It does not judge any call "useless", does not score size, and does not read thinking: that judgement belongs to the reader,
// who knows the user's question. Sources are the run's own events.jsonl (Claude stream-json or Codex app-server items) and the usage ledger.
const runsDir = path.join(root, '.runtime/agent/runs');
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const asText = v => v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
const USAGE = 'agent calls <任务id前缀，至少 4 位>[#调用序号[:full]]（任务 id 来自 agent show <会话>）';

// "C:\...\powershell.exe" -Command '...'  ->  the script itself.
const shellBody = command => { const m = String(command || '').match(/^"[^"]*powershell\.exe"\s+-Command\s+(['"])([\s\S]*)\1\s*$/i); return m ? m[2] : String(command || ''); };

function claudeBrief(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') return input.command;
  if (name === 'Read') return `${input.file_path}${input.offset || input.limit ? ` (offset ${input.offset ?? 0}, limit ${input.limit ?? '全'})` : ''}`;
  if (name === 'Grep') return `${input.pattern} @ ${input.path || '.'}${input.glob ? ` glob=${input.glob}` : ''}`;
  if (name === 'Glob') return `${input.pattern} @ ${input.path || '.'}`;
  if (name === 'Edit' || name === 'Write') return input.file_path;
  return JSON.stringify(input);
}

// Result size as recorded; images are only counted, never expanded.
// A long base64 run that starts like a PNG/JPEG/GIF/WebP file (or sits in a data:image URI) is an image serialised into text, e.g. a screenshot inside a JSON string.
// Count it, do not carry it. Plain long tokens or ordinary text are left alone, so a legitimate result is never mistaken for an image.
const ENCODED = /(?:data:image\/[a-z+.-]+;base64,|iVBORw0KGgo|\/9j\/|R0lGOD[hl]|UklGR)[A-Za-z0-9+/]{1000,}={0,2}/g;
const withoutEncoded = text => { let images = 0; const t = String(text ?? '').replace(ENCODED, () => { images++; return '[图像编码已省略]'; }); return { text: t, images }; };
const resultOf = content => {
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: asText(content) }];
  let images = blocks.filter(b => b?.type === 'image').length;
  const text = blocks.filter(b => b?.type !== 'image').map(b => { const r = withoutEncoded(b?.type === 'text' ? b.text : asText(b)); images += r.images; return r.text; }).join('\n');
  return { text, images };
};
// Codex MCP result: { content: [text | image blocks], structuredContent } or an error.
const mcpResultOf = it => {
  if (it.error) return withoutEncoded(asText(it.error));
  const res = it.result;
  if (!res || typeof res !== 'object') return resultOf(res);
  const r = resultOf(res.content ?? []);
  if (res.structuredContent == null) return r;
  const x = withoutEncoded(asText(res.structuredContent));
  return { text: r.text + (r.text ? '\n' : '') + x.text, images: r.images + x.images };
};
// What a web action actually asked for (search queries, the page opened, the pattern looked for), not just the first query string.
const searchBrief = it => {
  const a = it.action || {};
  if (a.type === 'search') return `search: ${(a.queries?.length ? a.queries : [a.query || it.query]).filter(Boolean).join(' | ')}`;
  if (a.type === 'openPage') return `openPage: ${a.url || it.query}`;
  if (a.type === 'findInPage') return `findInPage: ${a.pattern ?? it.query}${a.url ? ` @ ${a.url}` : ''}`;
  return `${a.type || '?'}: ${it.query || asText(it.action)}`;
};

// One events.jsonl -> { calls, says, thinking, compactions, lines, bad }. calls[i].after = number of says before the call.
export function parseEvents(file) {
  const out = { calls: [], says: [], thinking: 0, compactions: 0, lines: 0, bad: 0 };
  const byId = new Map();
  const add = c => { c.order = out.calls.length; out.calls.push(c); byId.set(c.id, c); return c; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { out.bad++; continue; }
    out.lines++;
    // Official DeepSeek Harness notifications (chat and explicit delegation).
    if(e.method==='session.event' && e.payload?.event) {
      const native=e.payload.event,d=native.data || {};
      if(native.type==='tool/call')add({id:d.callId,name:d.name,input:asText(d.arguments),brief:asText(d.arguments),status:'无返回记录'});
      else if(native.type==='tool/result' && byId.has(d.message?.toolCallId)) {
        const c=byId.get(d.message.toolCallId),r=resultOf(d.message.content);
        Object.assign(c,{output:r.text,chars:r.text.length,images:r.images,status:d.message.isError?'返回错误':'完成'});
      } else if(native.type==='assistant/message')for(const b of d.message?.content || []) {
        if(b.type==='text')out.says.push({at:out.calls.length,text:b.text});
        else if(b.type==='reasoning')out.thinking++;
      }
      if(native.type==='compaction/end')out.compactions++;
      continue;
    }
    const ev = e.event || e;
    // Claude stream-json
    if (Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'text' && ev.type === 'assistant') out.says.push({ at: out.calls.length, text: b.text });
        else if (b.type === 'thinking') out.thinking++;
        else if (b.type === 'tool_use') add({ id: b.id, name: b.name, input: asText(b.input?.command ?? JSON.stringify(b.input || {})), brief: claudeBrief(b.name, b.input), status: '无返回记录' });
        else if (b.type === 'tool_result' && byId.has(b.tool_use_id)) {
          const c = byId.get(b.tool_use_id), r = resultOf(b.content);
          Object.assign(c, { output: r.text, chars: r.text.length, images: r.images, status: b.is_error ? '返回错误' : '完成' });
        }
      }
      continue;
    }
    // Codex app-server items: the started record fixes the order, the completed record carries the result.
    const it = e.params?.item;
    if (!it || !['item/started', 'item/completed'].includes(e.method)) continue;
    const done = e.method === 'item/completed';
    if (it.type === 'agentMessage') { if (done) out.says.push({ at: out.calls.length, text: it.text }); continue; }
    if (it.type === 'reasoning') { if (done) out.thinking++; continue; }
    if (it.type === 'contextCompaction') { if (done) out.compactions++; continue; }
    if (it.type === 'userMessage') continue;
    const kind = { commandExecution: 'Shell', mcpToolCall: 'MCP', webSearch: 'WebSearch', fileChange: 'FileChange', imageView: 'ImageView', imageGeneration: 'ImageGeneration', sleep: 'Sleep' }[it.type];
    if (!kind) continue;
    const c = byId.get(it.id) || add({ id: it.id, status: '未完成' });
    if (it.type === 'commandExecution') Object.assign(c, { name: 'Shell', input: shellBody(it.command), brief: shellBody(it.command) });
    else if (it.type === 'mcpToolCall') Object.assign(c, { name: `MCP ${it.server}/${it.tool}`, input: asText(it.arguments), brief: asText(it.arguments) });
    else if (it.type === 'webSearch') Object.assign(c, { name: 'WebSearch', input: searchBrief(it), brief: searchBrief(it) });
    else if (it.type === 'imageGeneration') { const p = `${it.revisedPrompt || ''}${it.savedPath ? `\n→ 保存到 ${it.savedPath}` : ''}`; Object.assign(c, { name: 'ImageGeneration', input: p, brief: p }); }
    else if (it.type === 'sleep') { const w = `等待 ${(it.durationMs ?? 0) / 1000} 秒`; Object.assign(c, { name: 'Sleep', input: w, brief: w }); }
    else if (it.type === 'fileChange') Object.assign(c, { name: 'FileChange', input: (it.changes || []).map(x => x.path).join('; '), brief: (it.changes || []).map(x => x.path).join('; ') });
    else Object.assign(c, { name: 'ImageView', input: asText(it.path), brief: asText(it.path) });
    if (!done) continue;
    // Only a shell's own stdout is carried as-is; MCP, web and generated-image results go through the image-aware splitters.
    const r = it.type === 'commandExecution' ? { text: asText(it.aggregatedOutput), images: 0 } : it.type === 'mcpToolCall' ? mcpResultOf(it) : it.type === 'webSearch' ? withoutEncoded(asText(it.results))
      : { text: '', images: it.type === 'imageView' || (it.type === 'imageGeneration' && it.result) ? 1 : 0 };
    Object.assign(c, { output: r.text, chars: r.text.length, images: r.images, durationMs: it.durationMs ?? undefined,
      status: it.type === 'commandExecution' ? (it.exitCode === 0 || it.exitCode == null ? '完成' : `退出码 ${it.exitCode}`) : it.status === 'failed' || it.error || it.failure ? '失败' : '完成' });
  }
  return out;
}

// Task id prefix -> run directories (the turn itself, then numbered follow-up turns inside it).
export function resolveRun(prefix) {
  if (!prefix || prefix.length < 4) throw new Error(USAGE);
  const hits = fs.readdirSync(runsDir).filter(d => d.startsWith(prefix));
  if (hits.length !== 1) throw new Error(hits.length ? `前缀不唯一，匹配 ${hits.length} 个运行，请多写几位` : '没有这个运行目录（任务 id 前缀不对，或记录已清理）');
  const name = hits[0], base = path.join(runsDir, name);
  const dirs = [base, ...fs.readdirSync(base).filter(d => /^\d+$/.test(d)).sort((a, b) => a - b).map(d => path.join(base, d))];
  return { name, base, dirs };
}

const sessionOf = taskId => read('.runtime/agent/sessions.json', { sessions: [] }).sessions?.find(s => s.messages?.some(m => m.task_id === taskId));

function load(prefix) {
  const run = resolveRun(prefix);
  const parts = run.dirs.map(d => { const f = path.join(d, 'events.jsonl'); return { dir: d, file: f, ok: fs.existsSync(f) }; });
  const parsed = parts.filter(p => p.ok).map(p => ({ ...p, ...parseEvents(p.file) }));
  // One numbering across all turns of the run, so "#N" is unambiguous.
  const calls = [], says = [];
  for (const p of parsed) {
    const offset = calls.length;
    p.calls.forEach(c => calls.push({ ...c, n: calls.length + 1, turn: p.dir === run.base ? 1 : Number(path.basename(p.dir)) }));
    p.says.forEach(s => says.push({ at: offset + s.at, text: s.text }));
  }
  return { run, parts, parsed, calls, says };
}

const ledgerLines = name => {
  const rel = `.runtime/agent/runs/${name}`;
  return usageSnapshot().runs.filter(r => String(r.run_dir || '').replace(/\\/g, '/').startsWith(rel)).map(r =>
    `  ${r.provider}/${r.model || '?'} · ${r.purpose || '无用途标签'} · ${r.status} · 输入 ${r.input_tokens ?? '?'}（缓存 ${r.cached_input_tokens ?? 0}）输出 ${r.output_tokens ?? '?'} · 工具 ${r.tool_calls ?? '?'} 次 · ${Math.round((r.duration_ms || 0) / 1000)} 秒`);
};

const callLine = c => `#${c.n} ${c.name} · ${c.status}${c.durationMs != null ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ''} · 返回 ${c.chars ?? '无'} 字符${c.images ? ` + 图片 ${c.images}` : ''}\n    ${flat(c.brief)}`;

export function callsTimeline(prefix) {
  const { run, parts, parsed, calls, says } = load(prefix);
  const taskId = run.name, session = sessionOf(taskId);
  const msgs = (session?.messages || []).filter(m => m.task_id === taskId);
  const ask = msgs.find(m => ['user','handoff'].includes(m.role)), reply = [...msgs].reverse().find(m => !['user','handoff'].includes(m.role));
  const head = [`[运行 ${run.name}] ${session ? `对话 ${session.id.slice(0, 8)}「${flat(session.title)}」` : '（对话记录里找不到这个任务）'}`,
    ask ? `${ask.role==='handoff' ? ask.provider+' 发起交接' : '用户请求'}：${ask.text}` : '', ...ledgerLines(run.name)];
  const lines = [];
  calls.forEach((c, i) => {
    // The assistant's own words between calls, so the stated intent is visible next to what it did.
    says.filter(s => s.at === i).forEach(s => lines.push(`  说：${s.text}`));
    lines.push(callLine(c));
  });
  says.filter(s => s.at >= calls.length).forEach(s => lines.push(`  说：${s.text}`));
  const total = calls.reduce((a, c) => a + (c.chars || 0), 0);
  const notes = [`共 ${calls.length} 次调用，返回合计 ${total} 字符；推理 ${parsed.reduce((a, p) => a + p.thinking, 0)} 条（未展开）${parsed.some(p => p.compactions) ? `；期间发生上下文压缩 ${parsed.reduce((a, p) => a + p.compactions, 0)} 次` : ''}。`,
    parts.some(p => !p.ok) ? `缺事件日志：${parts.filter(p => !p.ok).map(p => path.relative(run.base, p.dir) || '本轮').join('、')}。` : '',
    parsed.some(p => p.bad) ? `有 ${parsed.reduce((a, p) => a + p.bad, 0)} 行无法解析，已跳过。` : '',
    calls.some(c => c.status === '无返回记录' || c.status === '未完成') ? '标“无返回记录／未完成”的调用在日志里没有对应返回，可能被中断。' : '',
    '字符数是事件日志里记录的体积，不是 token；日志是否截断无法从记录判断；图片只计个数。程序不判断哪次调用有用——需结合上面的用户请求。',
    reply ? `末条回复：${reply.text}` : ''].filter(Boolean);
  return [...head.filter(Boolean), '', ...lines, '', ...notes, `展开某次调用：agent calls ${prefix}#<序号>[:full]`].join('\n');
}

export function callDetail(prefix, ref) {
  const [idx] = ref.split(':');
  const n = Number(idx);
  const { calls, says } = load(prefix);
  const c = calls[n - 1];
  if (!Number.isInteger(n) || !c) throw new Error(`没有第 ${idx} 次调用（共 ${calls.length} 次）`);
  const before = [...says].reverse().find(s => s.at <= n - 1), after = says.find(s => s.at >= n);
  const body = c.output ?? '', input = c.input;
  return [`#${c.n} ${c.name} · ${c.status}${c.durationMs != null ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ''} · 第 ${c.turn} 轮`,
    before ? `调用前的话：${before.text}` : '', `输入：\n${input}`, `返回（${c.chars ?? 0} 字符${c.images ? `，另有图片 ${c.images}` : ''}）：\n${body}`,
    after ? `调用后的话：${after.text}` : ''].filter(Boolean).join('\n');
}

export function callsReport(arg) {
  const [prefix, ref] = String(arg || '').split('#');
  if (!prefix) throw new Error(USAGE);
  return ref ? callDetail(prefix, ref) : callsTimeline(prefix);
}
