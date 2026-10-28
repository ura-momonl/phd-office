import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { root, read, write, input, isTurnRecord } from '../automation/files.mjs';
import { extractJSON } from '../dashboard/cards.mjs';
import {decodeFiles} from '../agent/files.mjs';
import {sniffImageMime} from '../agent/images.mjs';
import {frameworkDigest,readFrameworkNodes,frameworkNode,appendFiles,setStatus,linkNodes,setFields,addEntry,addNode,checkFramework,withFramework,editorSnapshot,editFramework,impactReport} from './framework.mjs';
import {searchKnowledge} from './search.mjs';
export {checkFramework,withFramework,frameworkDigest};
const catalogURL = new URL('./catalog.json', import.meta.url);
// Project file paths are relative to their own workspace, never arbitrary downloads.
export function resolveProjectFile(project,index,nodeId) {
  if(!project || !/^[a-z0-9-]+$/.test(project.id) || !Number.isSafeInteger(index) || index<0)throw new Error('未找到项目文件');
  const owner=nodeId ? projectNode(project,nodeId) : project;
  const entry=owner?.files?.[index];
  if(!entry || typeof entry.path!=='string' || path.isAbsolute(entry.path))throw new Error('未找到项目文件');
  const base=fs.realpathSync(path.join(root,'workspace/projects',project.id));
  const file=fs.realpathSync(path.resolve(base,entry.path)),relative=path.relative(base,file);
  if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || !fs.statSync(file).isFile())throw new Error('项目文件必须在本项目目录内');
  return file;
}
// Files belong either to a project or one stage. No model call and no completion inference.
export function attachProjectFiles(projectId,nodeId,files) {
  const catalog=read('projects/catalog.json'),project=catalog.projects.find(p=>p.id===projectId && !p.archived_at);
  if(!project || !/^[a-z0-9-]+$/.test(project.id))throw new Error('未找到项目');
  const owner=nodeId ? projectNode(project,nodeId) : project;
  if(!owner)throw new Error('未找到项目阶段');
  const inFramework=nodeId && !planNode(project,nodeId);
  const decoded=decodeFiles(files);
  if(!decoded.length)throw new Error('请选择文件');
  const directory=path.join(root,'workspace/projects',project.id,'inbox');
  fs.mkdirSync(directory,{recursive:true});
  const base=fs.realpathSync(path.join(root,'workspace/projects',project.id));
  const relative=path.relative(base,fs.realpathSync(directory));
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw new Error('项目文件必须在本项目目录内');
  const added=[],created=[];
  try {
    for(const file of decoded) {
      const name=file.id+path.extname(file.path),target=path.join(directory,name);
      fs.writeFileSync(target,file.bytes,{flag:'wx'});created.push(target);
      added.push({title:file.name,name:file.name,path:'inbox/'+name,size:file.size,mime:sniffImageMime(file.bytes) || 'application/octet-stream'});
    }
    if(inFramework)appendFiles(project.id,nodeId,added);
    else{owner.files=[...(owner.files || []),...added];project.updated_at=new Date().toISOString();write('projects/catalog.json',catalog);}
  } catch(error) {for(const file of created)fs.unlinkSync(file);throw error;}
  return {project_id:projectId,node_id:nodeId || null,files:added};
}
// A stage of the project plan in catalog.json, or else a section/entry of the project's FRAMEWORK.md.
function planNode(project,nodeId) {
  const visit=nodes=>{for(const node of nodes || []){if(node.id===nodeId)return node;const found=visit(node.children);if(found)return found;}return null;};
  return visit(project?.plan);
}
export function projectNode(project,nodeId) {return planNode(project,nodeId) || frameworkNode(project?.id,nodeId);}
function knownProject(id) {
  if(!read('projects/catalog.json').projects.some(p=>p.id===id))throw new Error('Unknown project');
  return id;
}
// The dashboard chip and the node-status command share this one entry.
export function setNodeStatus(projectId,id,status,options) {return setStatus(knownProject(projectId),id,status,options);}
export const projectEditor = projectId => editorSnapshot(knownProject(projectId));
export const editProjectFramework = request => editFramework(knownProject(request.project_id),request);
export function focusProject(projectId,nodeId) {
  const catalog=read('projects/catalog.json'),project=catalog.projects.find(p=>p.id===projectId);
  if(!project || !projectNode(project,nodeId))throw new Error('未找到项目步骤');
  project.active_node_id=nodeId;project.updated_at=new Date().toISOString();write('projects/catalog.json',catalog);
  return {project_id:projectId,active_node_id:nodeId};
}
// One short page per project: the background a new task or session needs. A generated view, never a source; the facts live in
// projects/catalog.json, work/queue.json and the mail ledger. No timestamp inside, so it only changes when the facts change.
export function renderStatus(projectId) {
  const catalog = read('projects/catalog.json'), project = catalog.projects.find(p => p.id === projectId);
  if (!project) throw new Error('Unknown project');
  const one = v => String(v || '').replace(/\s+/g, ' ').trim();
  // Card work (a button press that asked the agent to prepare a card) is not project work; its mail item is listed below instead.
  const work = read('work/queue.json', { items: [] }).items.filter(i => i.project_ids?.includes(projectId) && i.mode !== 'card');
  const plain = text => { const t = String(text || '').trim(); if (!t.startsWith('{') && !t.startsWith('`')) return t; try { return extractJSON(t).message || ''; } catch { return ''; } };
  const node = project.active_node_id ? projectNode(project, project.active_node_id) : null;
  // An operation's explicit result is enough for the status view; no second copy
  // in brief is needed. Arbitrary conversation replies are still not summaries.
  const summaryOf = i => i.brief?.summary || (!i.executor || /^[{`]/.test(String(i.handoff || '').trim()) ? plain(i.handoff) : '');
  const finished = work.filter(i => i.status === 'done' && i.review?.state !== 'pending').sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const seenSummary = new Set(), done = finished.filter(i => { const s = summaryOf(i); if (!s || seenSummary.has(s)) return false; seenSummary.add(s); return true; }).slice(0, 3);
  // Open work lists operation steps only: a chat turn that ended as failed or still runs is not an undone task. A turn that left a summary still shows under finished.
  const pending = work.filter(i => !isTurnRecord(i) && (['queued', 'active', 'waiting_user', 'failed'].includes(i.status) || i.review?.state === 'pending'));
  const open = pending.slice(0, 5);
  const lines = ['# ' + project.name + ' · 状态', '', '> 由程序生成，不要手改。事实来源：projects/catalog.json、work/queue.json、邮箱账本。研究内容看 projects outline。'];
  if (node) lines.push('', '当前步骤：' + node.title);
  else if (project.plan_is_example) lines.push('', '当前步骤：未记录（计划为示意内容，不能当作真实进展）');
  if (open.length) { lines.push('', '## 进行中 / 待处理'); for (const i of open) lines.push('- ' + one(i.title) + '（' + (i.review?.state === 'pending' ? '待验收' : i.status) + (i.due_at ? '，截止 ' + i.due_at.slice(0, 10) : '') + '）'); }
  if (pending.length > open.length) lines.push('', '另有 ' + (pending.length - open.length) + ' 项待处理；work list ' + projectId + ' 看完整索引。');
  if (done.length) {
    lines.push('', '## 最近完成');
    for (const i of done) {
      lines.push('- ' + one(summaryOf(i)) + (i.brief?.next ? ' → 下一步：' + one(i.brief.next) : '') + ' [' + i.id.slice(0, 8) + ']');
      for (const q of i.brief?.open || []) lines.push('  - 未决：' + one(q));
    }
  }
  if (finished.length > done.length) lines.push('', '另有 ' + (finished.length - done.length) + ' 项完成记录未在此列出；work list 看索引，work handoff <完整id> 读详情。');
  const file = path.join(root, '.runtime/mail-flow/mail.sqlite');
  const linked = new Set(catalog.links.filter(l => l.module === 'mail' && l.status !== 'proposed' && l.project_ids.includes(projectId)).map(l => l.item_id));
  if (linked.size && fs.existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tasks = db.prepare("SELECT id,title,action,deadline FROM tasks WHERE status!='done' ORDER BY deadline IS NULL, deadline").all().filter(t => linked.has(t.id)).slice(0, 6);
      if (tasks.length) { lines.push('', '## 关联邮件事项（未完成；后台建议，不是已核实的研究进展）'); for (const t of tasks) lines.push('- ' + one(t.title) + '：' + one(t.action) + (t.deadline ? '（截止 ' + t.deadline.slice(0, 10) + '）' : '')); }
    } finally { db.close(); }
  }
  const target = path.join(root, 'workspace/projects', projectId, 'STATUS.md'), text = lines.join('\n') + '\n';
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return true;
}
export function renderAllStatus() { return read('projects/catalog.json').projects.filter(p => !p.archived_at && renderStatus(p.id)).length; }
// Complete generated pages; the caller decides whether it needs their contents
// or only a version fingerprint. Never silently drop a bound project.
export function projectStatus(ids = []) {
  return ids.map(id => { const f = path.join(root, 'workspace/projects', id, 'STATUS.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }).filter(Boolean).join('\n');
}
// Archiving a finished project takes it out of the lists, the weekly plan, the chat selector and link suggestions. Nothing is deleted: its tasks,
// papers, mail links and files stay, and restoring puts it back as it was.
export function setProjectArchived(projectId,archived=true) {
  const catalog=read('projects/catalog.json'),project=catalog.projects.find(p=>p.id===projectId);
  if(!project)throw new Error('Unknown project');
  if(archived)project.archived_at=project.archived_at || new Date().toISOString();else delete project.archived_at;
  write('projects/catalog.json',catalog);
  if(!archived)renderStatus(projectId);
  return {project_id:projectId,archived:!!project.archived_at};
}
// A proposed project link becomes a fact only after the user confirms it; declining leaves the item shared.
export function resolveLink(moduleName,itemId,decision) {
  const catalog=read('projects/catalog.json');
  const link=catalog.links.find(l=>l.module===moduleName && l.item_id===itemId && l.status==='proposed');
  if(!link)throw new Error('没有待确认的归属');
  if(decision==='confirm')link.status='recorded';
  else if(decision==='decline'){link.status='unassigned';link.project_ids=[];}
  else throw new Error('未知选择');
  write('projects/catalog.json',catalog);return link;
}
// Program-only suggestion from project aliases: exactly one matching project, no existing link, always 'proposed'.
export function proposeLinks(items) {
  const catalog=read('projects/catalog.json');let added=0;
  for(const item of items) {
    if(catalog.links.some(l=>l.module==='mail' && l.item_id===item.id))continue;
    const text=(item.title+' '+item.action).toLowerCase();
    const hits=catalog.projects.filter(p=>!p.archived_at).map(p=>({p,alias:(p.aliases || []).find(a=>a && text.includes(a.toLowerCase()))})).filter(h=>h.alias);
    if(hits.length!==1)continue;
    catalog.links.push({module:'mail',item_id:item.id,project_ids:[hits[0].p.id],basis:'标题或下一步里含「'+hits[0].alias+'」',status:'proposed'});added++;
  }
  if(added)write('projects/catalog.json',catalog);
  return {added};
}
export async function run(action = 'list', id) {
  const catalog = JSON.parse(fs.readFileSync(catalogURL, 'utf8'));
  if (action === 'outline') {
    const projectId=knownProject(id),digest=frameworkDigest(projectId);
    console.log(digest || `项目 ${projectId} 没有可用的 FRAMEWORK.md；不假设研究现状，按当前任务使用原信、用户说明和其他已登记资料。`);return;
  }
  if (action === 'read-nodes') {
    const [projectId, selection, extra] = String(id || '').split('#');
    if (!selection || extra !== undefined) throw new Error('用法：projects read-nodes 项目ID#节点ID,节点ID');
    console.log(JSON.stringify(readFrameworkNodes(knownProject(projectId), selection.split(',')), null, 2)); return;
  }
  if (action === 'search') {
    // 「项目ID#查询词」只搜一个项目；不写项目ID就搜全部。
    const text = String(id || ''), cut = text.indexOf('#'), scoped = cut > 0 && catalog.projects.some(p => p.id === text.slice(0, cut));
    console.log(JSON.stringify(searchKnowledge(scoped ? text.slice(cut + 1) : text, scoped ? { project: text.slice(0, cut) } : {}), null, 2)); return;
  }
  if (action === 'impact') {
    const [projectId, nodeId, extra] = String(id || '').split('#');
    if (!projectId || extra !== undefined) throw new Error('用法：projects impact 项目ID[#节点ID]');
    console.log(JSON.stringify(impactReport(knownProject(projectId), nodeId || undefined), null, 2)); return;
  }
  if (action === 'list') { console.log(JSON.stringify(catalog.projects.map(({id,name,kind,scope,archived_at})=>({id,name,kind,scope,...(archived_at ? {archived:true} : {})})), null, 2)); return; }
  if (action === 'archive' || action === 'restore') { console.log(JSON.stringify(setProjectArchived(id, action === 'archive'))); return; }
  if (action === 'scaffold') {
    const selected = id ? catalog.projects.filter(p=>p.id===id) : catalog.projects;
    if (!selected.length) throw new Error('Unknown project');
    for (const project of selected) {
      if (!/^[a-z0-9-]+$/.test(project.id)) throw new Error('Invalid project folder ID');
      const directory = path.join(root,'workspace/projects',project.id);
      for (const folder of ['inbox','experiments','data/raw','data/processed','analysis','literature-notes','cad','deliverables']) fs.mkdirSync(path.join(directory,folder),{recursive:true});
      const overview = path.join(directory,'README.md');
      if (!fs.existsSync(overview)) fs.writeFileSync(overview,`# ${project.name}\n\n项目 ID：${project.id}。任务状态以 work 队列和 STATUS.md 为准，这里不复制状态。\n\n原始数据放 data/raw，处理结果放 data/processed，脚本放 analysis；实验记录引用样品与批次，图纸放 cad，图与汇报放 deliverables。文献全文由 Zotero/已登记的原文件保存，literature-notes 放带来源和页码的笔记。\n\n模板见 ../../../templates/；已有外部软件工程保留原位，软件登记表记其实际路径。\n`);
    }
    fs.mkdirSync(path.join(root,'workspace/shared'),{recursive:true});
    console.log(JSON.stringify({created:selected.map(p=>'workspace/projects/'+p.id),existing_files_preserved:true})); return;
  }
  if (action === 'framework') { console.log(JSON.stringify(checkFramework(id), null, 2)); return; }
  if (action === 'editor') { console.log(JSON.stringify(projectEditor(id), null, 2)); return; }
  // Structured edits of FRAMEWORK.md; the prose itself is written directly in the file.
  const edits={
    'node-edit':a=>editProjectFramework(a),
    'node-status':a=>setNodeStatus(a.project_id,a.id,a.status,a),
    'node-link':a=>linkNodes(knownProject(a.project_id),a.from,a.to,a.rel),
    'node-set':a=>{const {project_id,id,...fields}=a;return setFields(knownProject(project_id),id,fields);},
    'entry-add':a=>addEntry(knownProject(a.project_id),a),
    'node-add':a=>addNode(knownProject(a.project_id),a)};
  if (edits[action]) { console.log(JSON.stringify(edits[action](input(id)), null, 2)); return; }
  if (action !== 'context') throw new Error('Projects actions: list, outline <id>, context <id>, archive <id>, restore <id>, scaffold [id], framework <id>, impact <id>[#node], search [id#]<query>, node-status|node-link|node-set|entry-add|node-add <json file>');
  const project = catalog.projects.find(p => p.id === id);
  if (!project && id !== 'unassigned') throw new Error('Unknown project');
  const links = catalog.links.filter(l => id === 'unassigned' ? !l.project_ids.length : l.project_ids.includes(id));
  const db = new DatabaseSync(fileURLToPath(new URL('../.runtime/mail-flow/mail.sqlite', import.meta.url)), { readOnly: true });
  try {
    const items = links.map(link => {
      const row = db.prepare('SELECT id,title,status,action,check_at,artifacts FROM tasks WHERE id=?').get(link.item_id);
      return { link, item: row ? { ...row, artifacts: JSON.parse(row.artifacts) } : null };
    });
    const match = record => id === 'unassigned' ? !(record.project_ids || []).length : record.project_ids?.includes(id);
    const procurement = read('procurement/catalog.json',{requests:[]}).requests.filter(r =>
      links.some(l=>l.item_id===r.mail_task_id) || catalog.links.some(l=>l.module==='procurement' && l.item_id===r.id && (id==='unassigned' ? !l.project_ids.length : l.project_ids.includes(id))));
    console.log(JSON.stringify({ project: project || { id: 'unassigned', name: '待关联事项' },
      source: catalog.source, items,
      workspace: id === 'unassigned' ? 'workspace/shared' : 'workspace/projects/'+id,
      procurement, literature:read('literature/catalog.json',{papers:[]}).papers.filter(match),
      work:read('work/queue.json',{items:[]}).items.filter(match),
      dependencies: catalog.dependencies.filter(d => d.project_ids?.includes(id)) }, null, 2));
  } finally { db.close(); }
}
