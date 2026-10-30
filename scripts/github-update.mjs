#!/usr/bin/env node
// 从 GitHub 公开快照增量更新本地办公室代码（只用 Node 内置模块）。
//   node scripts/github-update.mjs            # 只看有哪些变化（不写文件）
//   node scripts/github-update.mjs --apply    # 应用更新
// 选项：--repo owner/name（默认 ura-momonl/phd-office） --branch main  --ref <提交sha>  --root <目录>
//
// 做法：读仓库里的 BACKUP-MANIFEST.json（每个文件的 sha256），与本地逐文件比较，只下载变化的文件，
// 并逐个校验 sha256。上次应用时的版本记在 .runtime/github-update/state.json：
//   本地没改、远端改了 → 覆盖；远端新增 → 添加；远端删除且本地没改 → 删除；
//   本地也改过的文件 → 不覆盖，远端版本放到 .runtime/github-update/incoming/ 供合并。
// 快照不含凭据、邮件、项目、任务、文献等个人数据，更新也不会碰这些。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
if (has('help') || has('h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const repo = opt('repo', 'ura-momonl/phd-office');
const branch = opt('branch', 'main');
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const apply = has('apply');
const stateDir = path.join(root, '.runtime', 'github-update');
const statePath = path.join(stateDir, 'state.json');
const incomingDir = path.join(stateDir, 'incoming');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Windows 上 git 可能把 LF 换成 CRLF，按 LF 也比一次
const matches = (buf, want) => sha256(buf) === want || sha256(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === want;

const headers = { 'User-Agent': 'phd-office-updater' };
if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;

async function get(url, extra = {}) {
  const r = await fetch(url, { headers: { ...headers, ...extra } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
const rawUrl = (sha, p) => `https://raw.githubusercontent.com/${repo}/${sha}/${p.split('/').map(encodeURIComponent).join('/')}`;

function safeTarget(base, rel) {
  if (!rel || path.isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '')) throw new Error('不安全的路径: ' + rel);
  if (/^(\.git|\.runtime|workspace|literature\/(records|pdf))(\/|$)/.test(rel)) throw new Error('受保护路径: ' + rel);
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error('路径越界: ' + rel);
  return full;
}

const readFile = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);

async function main() {
  const sha = opt('ref') || (await get(`https://api.github.com/repos/${repo}/commits/${branch}`, { Accept: 'application/vnd.github.sha' })).toString().trim();
  const manifest = JSON.parse((await get(rawUrl(sha, 'BACKUP-MANIFEST.json'))).toString('utf8'));
  const remote = new Map(manifest.source_files.map((f) => [f.path, f]));
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { commit: null, files: {}, pending: [] };
  const base = state.files || {};

  if (state.commit === sha && !(state.pending || []).length && !has('force')) {
    console.log(`已是最新：${repo}@${sha.slice(0, 7)}（快照生成于 ${manifest.created_at}）`);
    return;
  }

  const plan = { add: [], update: [], delete: [], conflict: [], same: 0, keptDeleted: [], keptRemoved: [] };
  for (const f of remote.values()) {
    const buf = readFile(safeTarget(root, f.path));
    const b = base[f.path];
    if (buf && matches(buf, f.sha256)) { plan.same++; continue; }
    if (!buf) {
      if (b === undefined) plan.add.push(f);
      else if (b === f.sha256) plan.keptDeleted.push(f.path); // 本地删过，远端没变，保持删除
      else plan.conflict.push({ ...f, why: '本地已删除，远端有更新' });
    } else if (b !== undefined && matches(buf, b)) plan.update.push(f);
    else plan.conflict.push({ ...f, why: b === undefined ? '本地已有且内容不同（无上次记录）' : '本地和远端都改过' });
  }
  for (const p of Object.keys(base)) {
    if (remote.has(p)) continue;
    const buf = readFile(safeTarget(root, p));
    if (!buf) continue;
    if (matches(buf, base[p])) plan.delete.push(p);
    else plan.keptRemoved.push(p);
  }

  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}（${list.length}）`);
    for (const x of list.slice(0, 40)) console.log('  ' + (typeof x === 'string' ? x : x.path + (x.why ? '  — ' + x.why : '')));
    if (list.length > 40) console.log(`  … 另有 ${list.length - 40} 个`);
  };
  console.log(`远端 ${repo}@${sha.slice(0, 7)}，快照生成于 ${manifest.created_at}；本地已一致 ${plan.same} 个文件`);
  show('新增', plan.add); show('更新', plan.update); show('删除', plan.delete);
  show('冲突（不覆盖，远端版本放到 incoming/）', plan.conflict);
  show('远端已删除但本地有改动（保留）', plan.keptRemoved);

  const changed = [...plan.add, ...plan.update].map((f) => f.path).concat(plan.delete);
  if (!apply) {
    console.log(changed.length || plan.conflict.length ? '\n以上是预览，加 --apply 应用。' : '\n没有需要更新的文件。');
    if (!changed.length && !plan.conflict.length && state.commit !== sha) saveState(sha, remote, plan, []);
    return;
  }

  // 先全部下载并校验，再写入，网络中断时不会留下半个更新
  const todo = [...plan.add, ...plan.update, ...plan.conflict];
  const bufs = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < todo.length) {
      const f = todo[next++];
      const buf = await get(rawUrl(sha, f.path));
      if (sha256(buf) !== f.sha256) throw new Error('校验失败: ' + f.path);
      bufs.set(f.path, buf);
    }
  }));
  const write = (full, buf) => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = full + '.update-tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, full);
  };
  for (const f of [...plan.add, ...plan.update]) write(safeTarget(root, f.path), bufs.get(f.path));
  for (const p of plan.delete) fs.rmSync(safeTarget(root, p));
  fs.rmSync(incomingDir, { recursive: true, force: true });
  for (const f of plan.conflict) write(safeTarget(incomingDir, f.path), bufs.get(f.path));
  saveState(sha, remote, plan, plan.conflict.map((f) => f.path));

  console.log(`\n已应用：新增 ${plan.add.length}、更新 ${plan.update.length}、删除 ${plan.delete.length}、冲突 ${plan.conflict.length}。`);
  if (plan.conflict.length) console.log(`冲突的远端版本在 ${incomingDir}，请合并后再运行一次。`);
  if (changed.some((p) => /^package(-lock)?\.json$/.test(p))) console.log('package.json 有变化：请运行 npm install。');
  if (changed.some((p) => /\.(mjs|js|py|ps1)$/.test(p))) console.log('代码有变化：如后端正在运行，需要重启后生效。');
}

function saveState(sha, remote, plan, pending) {
  // 已同步／已更新的文件以远端 sha 为新基线；冲突和保留的文件维持旧基线，下次仍会提示
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { files: {} };
  const old = state.files || {};
  const hold = new Set([...plan.conflict.map((f) => f.path), ...plan.keptRemoved]);
  const files = {};
  for (const f of remote.values()) {
    if (hold.has(f.path)) { if (old[f.path] !== undefined) files[f.path] = old[f.path]; continue; }
    files[f.path] = f.sha256;
  }
  for (const p of plan.keptRemoved) files[p] = old[p];
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ repo, branch, commit: sha, updated_at: new Date().toISOString(), pending, files }, null, 1));
}

main().catch((e) => { console.error('更新失败：' + e.message); process.exit(1); });
