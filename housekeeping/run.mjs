// Scheduled housekeeping: removes regenerable leftovers (raw run event logs, acceptance and test copies, scratch files, old rollback snapshots)
// so the project stops growing without bound. Pure program: no model, no network. It runs once per day from the backend's existing beat
// (dashboard/server.mjs automate(), next to backupData) and by hand through `housekeeping plan|run|log`.
// Only the rules below delete anything. Everything else that is large is reported, never removed.
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';

const DAY = 864e5;
const MIN_AGE_DAYS = 1;   // nothing touched within a day is ever removed, whatever a rule says
const rel = (...p) => path.join(root, ...p);
const testTmp = () => path.resolve(process.env.OFFICE_TEST_TMP || path.join(root, '..', '.test-tmp'));
const STATE = '.runtime/housekeeping/last.json', LEDGER = '.runtime/housekeeping/ledger.jsonl', POLICY = 'housekeeping/policy.json';

// kind 'file' removes named files inside each child directory; 'entry' removes whole children. keepNewest protects the newest N matches.
// Runs that restarted an attempt keep their files one folder down, in a numbered folder, hence `nested`.
export const RULES = [
  { id: 'run-events', note: '原始运行事件日志（会话文字、交接、报告保留）', base: () => rel('.runtime/agent/runs'), kind: 'file', file: 'events.jsonl', days: 10, nested: /^\d+$/ },
  { id: 'run-prompt-copies', note: '每次运行实际发给模型的提示词副本和拼装清单（对话在 sessions、逐条记录在交接和报告里；保留 30 天供提示词页面查实际用法）', base: () => rel('.runtime/agent/runs'), kind: 'file', files: ['prompt.txt', 'native-prompt.txt', 'prompt-manifest.json'], days: 30, nested: /^\d+$/ },
  { id: 'acceptance-copies', note: '验收时留下的整套项目副本', base: () => rel('.runtime/acceptance'), kind: 'entry', days: 14 },
  { id: 'scratch', note: '临时脚本和中间文件', base: () => rel('.runtime/tmp'), kind: 'entry', days: 7 },
  { id: 'test-results', note: '测试报告和日志', base: () => rel('.runtime/test-results'), kind: 'entry', days: 14 },
  { id: 'test-copies', note: '脱敏测试副本和浏览器测试会话', base: testTmp, kind: 'entry', days: 2, match: /^(phd-tests-|browser-session-|codex-output-fixture|office-sandbox-fixtures|playwright)/ },
  { id: 'skill-edit-backups', note: '改 skill/文档前的整份旧版备份', base: () => rel('.runtime/skill-edits'), kind: 'entry', days: 30, depth: 2 },
  { id: 'work-edits', note: '改队列前整份 queue.json 的备份（按内容存一份，保留最新 10 份）', base: () => rel('.runtime/work-edits'), kind: 'entry', days: 30, keepNewest: 10 },
  { id: 'catalog-snapshots', note: '入库前的 catalog 写前快照（保留最新 3 份）', base: () => rel('output/literature-rebuild-20261021/coordinator/admissions'), kind: 'file', file: 'catalog-before.json', days: 10, keepNewest: 3 },
  { id: 'library-snapshots', note: '文献全文库 sqlite 的操作前整库快照（约 800MB 一份，保留最新 1 份；同目录的 catalog.json、脚本等小文件不动）', base: () => rel('.runtime/literature-edits'), kind: 'file', pattern: /\.sqlite(\.[\w-]+)?$/, days: 3, keepNewest: 1 },
  { id: 'project-tmp', note: '项目根目录 tmp/ 里的一次性中间文件', base: () => rel('tmp'), kind: 'entry', days: 7 },
];
// Large things that look like leftovers but are not removed automatically; listed so the user can decide.
// depth counts folders below base and makes the entry list single files instead of whole children.
export const REPORT_ONLY = [
  { id: 'run-files', note: '运行目录里任务自己留下的文件（下载、附件、写前快照）：可能被某次结果的 outputs 引用，只报不删', base: () => rel('.runtime/agent/runs'), depth: 3, minBytes: 10 * 1048576, limit: 10, skip: /^(?:events\.jsonl|prompt\.txt|native-prompt\.txt|prompt-manifest\.json)$/ },
  { id: 'framework-edits', note: '项目 FRAMEWORK.md 每次编辑前的全文：项目版面唯一的回滚来源，只报不删', base: () => rel('.runtime/framework-edits'), limit: 8 },
  { id: 'idle-runtime-dirs', note: '一个月没改过的 .runtime 子目录（一次性实验、旧快照、缓存）：没有任何规则管它们，只报不删', base: () => rel('.runtime'), minBytes: 50 * 1048576, idleDays: 30, limit: 10, skip: /^(?:agent|memory2|usage|work-edits|backups|framework-edits|literature-edits|mail-flow|housekeeping|skill-edits|tmp)$/ },
];
// 两个只追加、每次读写都整份过一遍的存储。不归清理规则管（删了就是丢对话），plan 只报体积，超过 limit 时提示该做归档。
const STORES = [
  { file: '.runtime/agent/sessions.json', limit: 40 * 1048576, note: '对话存储：每次流式事件整份读改写，dashboard 轮询整份发出' },
  { file: 'work/turns.json', limit: 8 * 1048576, note: '对话轮日志：超过 8MB 时写入会把最老的轮次归档到 .runtime/work/archive' },
  { file: '.runtime/usage/runs.jsonl', limit: 16 * 1048576, note: '模型调用日志：超过 16MB 时丢弃最老的记录（页面只用最近一周）' },
  { file: '.runtime/memory2/claude/.index', limit: 200 * 1048576, note: '记忆向量索引：sync 每 6 小时合并一次并清掉旧版本，Markdown 是真源、可删后重建' },
  { file: '.runtime/memory2/deepseek/.index', limit: 200 * 1048576, note: '记忆向量索引：sync 每 6 小时合并一次并清掉旧版本，Markdown 是真源、可删后重建' },
];

function newestMtime(p, budget = { n: 5000 }) {
  const st = fs.lstatSync(p);
  let newest = st.mtimeMs;
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const name of fs.readdirSync(p)) {
      if (budget.n-- <= 0) return newest;
      const child = path.join(p, name), cst = fs.lstatSync(child);
      newest = Math.max(newest, cst.isDirectory() && !cst.isSymbolicLink() ? newestMtime(child, budget) : cst.mtimeMs);
    }
  }
  return newest;
}
function sizeOf(p, budget = { n: 200000 }) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(p)) { if (budget.n-- <= 0) break; total += sizeOf(path.join(p, name), budget); }
  return total;
}
function policy() { try { return JSON.parse(fs.readFileSync(rel(POLICY), 'utf8')); } catch { return {}; } }

// The named files of one child directory, plus the same names inside the numbered folders some runs keep their attempts in.
function namedFiles(dir, rule) {
  const dirs = [dir];
  if (rule.nested) for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name), st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink() && rule.nested.test(name)) dirs.push(p);
  }
  const found = [];
  for (const d of dirs) for (const name of rule.files || [rule.file]) {
    const file = path.join(d, name);
    if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) found.push(file);
  }
  return found;
}

// Dry run: what each rule would remove right now.
export function plan({ now = Date.now(), rules = RULES } = {}) {
  const overrides = policy().days || {};
  const actions = [];
  for (const rule of rules) {
    const base = rule.base();
    if (!fs.existsSync(base)) continue;
    const days = Math.max(MIN_AGE_DAYS, Number(overrides[rule.id] ?? rule.days));
    const found = [];
    const visit = (dir, level) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink()) continue;
          if (rule.kind === 'entry') {
            if (level < (rule.depth || 1)) { if (st.isDirectory()) visit(p, level + 1); continue; }
            if (rule.match && !rule.match.test(name)) continue;
            found.push({ path: p, mtime: newestMtime(p), dir: true });
          } else if (st.isDirectory() && rule.pattern) {
            for (const inner of fs.readdirSync(p)) {
              const target = path.join(p, inner), ist = fs.lstatSync(target);
              if (rule.pattern.test(inner) && ist.isFile()) found.push({ path: target, mtime: ist.mtimeMs, file: true });
            }
          } else if (st.isDirectory()) {
            for (const target of namedFiles(p, rule)) found.push({ path: target, mtime: newestMtime(p), file: true });
          }
        } catch { /* an entry this account cannot read has no age to judge: leave it alone and keep sweeping */ }
      }
    };
    visit(base, 1);
    found.sort((a, b) => b.mtime - a.mtime);
    for (const f of found.slice(rule.keepNewest || 0)) {
      if (now - f.mtime < days * DAY) continue;
      actions.push({ rule: rule.id, path: f.path, bytes: sizeOf(f.path), age_days: Math.floor((now - f.mtime) / DAY) });
    }
  }
  return actions;
}

function childSizes(rule) {
  const items = [];
  for (const name of fs.readdirSync(rule.base())) {
    if (rule.skip?.test(name)) continue;
    const p = path.join(rule.base(), name);
    try {
      // An idle rule asks "how old is this" first: sizing a 20GB toolchain tree is only worth it for a candidate.
      const days = Math.floor((Date.now() - newestMtime(p, { n: 2000 })) / DAY);
      if (rule.idleDays && days < rule.idleDays) continue;
      items.push({ name, bytes: sizeOf(p), days });
    } catch { items.push({ name, bytes: 0, days: 0 }); }
  }
  return items.filter(i => i.bytes >= (rule.minBytes || 0)).sort((a, b) => b.bytes - a.bytes);
}
function largeFiles(rule) {
  const found = [];
  const walk = (dir, level) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { if (level < rule.depth) walk(p, level + 1); continue; }
        if (rule.skip && rule.skip.test(name)) continue;
        if (st.size >= (rule.minBytes || 0)) found.push({ name: path.relative(rule.base(), p).replaceAll('\\', '/'), bytes: st.size });
      } catch { /* unreadable entry: nothing to report about it */ }
    }
  };
  walk(rule.base(), 1);
  return found.sort((a, b) => b.bytes - a.bytes);
}

export function report({ rules = REPORT_ONLY } = {}) {
  return rules.filter(r => fs.existsSync(r.base())).map(r => ({
    rule: r.id, note: r.note, path: r.base(),
    items: (r.depth ? largeFiles(r) : childSizes(r)).slice(0, r.limit || 8),
  }));
}

// 报告用，不删：会缓慢增长的存储的当前体积，和超过 limit 时的提示。
export function stores() {
  return STORES.flatMap(s => {
    const file = rel(s.file);
    if (!fs.existsSync(file)) return [];
    const st = fs.statSync(file), bytes = st.isDirectory() ? sizeOf(file) : st.size;
    return [{ file: s.file, size: mb(bytes), modified: new Date(st.mtimeMs).toISOString(), note: s.note,
      ...(s.limit ? { limit: mb(s.limit), over: bytes > s.limit } : {}) }];
  });
}

export function apply(actions, { now = Date.now() } = {}) {
  const ledger = rel(LEDGER);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  let removed = 0, bytes = 0;
  for (const a of actions) {
    try {
      const st = fs.lstatSync(a.path);
      if (st.isSymbolicLink()) continue;
      fs.rmSync(a.path, { recursive: true, force: true });
      fs.appendFileSync(ledger, JSON.stringify({ at: new Date(now).toISOString(), rule: a.rule, path: a.path, bytes: a.bytes, age_days: a.age_days }) + '\n');
      removed++; bytes += a.bytes;
    } catch (e) { fs.appendFileSync(ledger, JSON.stringify({ at: new Date(now).toISOString(), rule: a.rule, path: a.path, error: e.message }) + '\n'); }
  }
  return { removed, bytes };
}

// Called by the backend beat; does the work at most once per UTC day.
export function housekeepingDaily({ now = new Date() } = {}) {
  if (policy().enabled === false) return { skipped: 'disabled' };
  const day = now.toISOString().slice(0, 10), stateFile = rel(STATE);
  try { if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).day === day) return { skipped: 'done today' }; } catch { /* first run */ }
  const result = apply(plan({ now: now.getTime() }), { now: now.getTime() });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ day, ...result }) + '\n');
  return { day, ...result };
}

const mb = n => (n / 1048576).toFixed(1) + ' MB';
export async function run(action) {
  if (action === 'plan') {
    const actions = plan(), by = {};
    for (const a of actions) { const b = by[a.rule] = by[a.rule] || { items: 0, bytes: 0 }; b.items++; b.bytes += a.bytes; }
    console.log(JSON.stringify({ would_remove: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { items: v.items, size: mb(v.bytes) }])), total: mb(actions.reduce((s, a) => s + a.bytes, 0)), stores: stores(), report_only: report().map(r => ({ rule: r.rule, note: r.note, top: r.items.slice(0, 4).map(e => `${e.name} ${mb(e.bytes)}${e.days ? `（${e.days} 天没改）` : ''}`) })) }, null, 1));
  } else if (action === 'run') {
    const r = apply(plan());
    console.log(JSON.stringify({ removed: r.removed, size: mb(r.bytes) }));
  } else if (action === 'log') {
    const f = rel(LEDGER);
    console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').slice(-30).join('\n') : '尚无清理记录');
  } else throw new Error('housekeeping: plan, run, log');
}
