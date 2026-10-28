import {esc} from './format.js';
const $=id=>document.getElementById(id);
const fields=[['name','仪器名称'],['model','型号'],['category','分类'],['location','位置'],['purpose','用途'],['connection','通信与接线'],['experience','实际使用记录'],['cautions','注意事项'],['control_notes','控制代码说明'],['reference_notes','参考优先级'],['source','资料来源'],['sop_url','SOP 链接'],['booking_url','预约链接']];
let items=[],projects=[],loaded=false,loading,editing,photo='',saving=false;
async function json(url,options) {const r=await fetch(url,options);const v=await r.json().catch(()=>({error:'仪器图鉴需要更新后端；请等活动任务结束后重启办公室。'}));if(!r.ok)throw new Error(v.error || '读取失败');return v;}
function message(text='') {$('instrument-message').textContent=text;}
export function renderInstruments(state) {
  projects=state.projects || [];
  if(!loaded && !loading)void reload();
}
async function reload() {
  if(loading)return loading;
  loading=(async()=>{try {items=(await json('/api/instruments')).items;loaded=true;paint();message();}catch(e){message(e.message);}})().finally(()=>loading=null);
  return loading;
}
function paint() {
  const category=$('instrument-category').value;
  $('instrument-category').innerHTML='<option value="">全部分类</option>'+[...new Set(items.map(i=>i.category).filter(Boolean))].sort().map(s=>`<option>${esc(s)}</option>`).join('');
  $('instrument-category').value=category;
  const query=$('instrument-search').value.trim().toLocaleLowerCase();
  const shown=items.filter(i=>(!category || i.category===category) && [i.name,i.model,i.location,i.purpose,i.connection,i.experience,i.control_notes].join('\n').toLocaleLowerCase().includes(query));
  $('instrument-count').textContent=`已收录 ${items.length} 台 · 当前显示 ${shown.length} 台`;
  const line=(name,value)=>value ? `<div class="instrument-note"><h3>${name}</h3><p>${esc(value)}</p></div>` : '';
  const link=(name,url)=>/^https?:\/\//i.test(url || '') ? `<a class="text-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name} ↗</a>` : '';
  $('instrument-grid').innerHTML=shown.map(i=>`<article class="instrument-card" data-instrument="${esc(i.id)}">
    <div class="instrument-photo">${i.photo ? `<img src="${esc(i.photo)}" alt="${esc(i.name)}的照片" loading="lazy">` : '<span aria-hidden="true">◇</span><small>实机照片待补</small>'}</div>
    <div class="instrument-body"><div class="instrument-title"><div><span class="eyebrow">${esc(i.category || '未分类')}</span><h2>${esc(i.name)}</h2><p class="muted">${esc(i.model || '型号待补')} · ${esc(i.location || '位置待补')}</p></div><button type="button" class="text-button" data-instrument-edit="${esc(i.id)}">编辑</button></div>
    <p class="instrument-purpose">${esc(i.purpose || '用途待补')}</p><p class="muted">${esc((i.project_ids || []).map(id=>projects.find(p=>p.id===id)?.name || id).join(' · '))}</p>
    ${line('通信与接线',i.connection)}${line('注意事项',i.cautions)}
    <details class="instrument-details"><summary>使用记录与参考</summary>${line('实际使用记录',i.experience)}${line('参考优先级',i.reference_notes)}${line('资料来源',i.source)}<div class="instrument-links">${link('SOP',i.sop_url)}${link('预约',i.booking_url)}</div></details>
    <section class="instrument-code"><h3>控制代码 <small>${i.code_paths.length} 个文件</small></h3><p>${esc(i.control_notes)}</p>
    ${i.code_paths.map((file,n)=>{const run=(i.run_paths || []).includes(file),name=esc(file.split('/').at(-1));return `<div class="instrument-code-file"><span>${run ? `<button type="button" class="text-button" data-code-run="${esc(i.id)}" data-code-index="${n}" title="用 Python 运行">▶ ${name}</button> <button type="button" class="text-button" data-code-open="${esc(i.id)}" data-code-index="${n}" title="用 VS Code 打开源码">VS Code</button>` : `<button type="button" class="text-button" data-code-open="${esc(i.id)}" data-code-index="${n}" title="用 VS Code 打开">${name} ↗</button>`}</span><small class="muted">${esc(file)}</small></div>`;}).join('') || '<p class="muted">尚未登记代码。</p>'}</section>
    <small class="muted">更新 ${esc(new Date(i.updated_at).toLocaleDateString('zh-CN'))}</small></div></article>`).join('') || '<div class="panel muted">没有匹配的仪器。可以换个关键词，或新增第一张卡片。</div>';
}
function openEditor(id) {
  editing=items.find(i=>i.id===id) || {};photo=editing.photo || '';
  $('instrument-editor-title').textContent=id ? '编辑仪器卡片' : '新增仪器卡片';
  $('instrument-fields').innerHTML=fields.map(([key,label])=>`<label class="${['name','model','category','location','sop_url','booking_url'].includes(key)?'':'instrument-wide'}">${label}${['purpose','connection','experience','cautions','control_notes','reference_notes','source'].includes(key) ? `<textarea name="${key}" rows="3" maxlength="6000">${esc(editing[key])}</textarea>` : `<input name="${key}" value="${esc(editing[key])}" ${key==='name'?'required maxlength="120"':'maxlength="6000"'}>`}</label>`).join('')+
    `<label class="instrument-wide">关联项目<select name="project_id"><option value="">无</option>${projects.map(p=>`<option value="${esc(p.id)}" ${editing.project_ids?.includes(p.id)?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label class="instrument-wide">代码文件路径 <small>每行一个，位于 instruments/programs；这里只登记路径，不修改代码</small><textarea name="code_paths" rows="4">${esc(editing.code_paths?.join('\n'))}</textarea></label><label class="instrument-wide">实机照片 <small>PNG / JPEG / WebP，最多 2 MB；不选则保留原照片</small><input name="photo" type="file" accept="image/png,image/jpeg,image/webp"></label>`;
  $('instrument-editor-error').textContent='';$('instrument-editor').showModal();
}
document.addEventListener('click',async e=>{
  const edit=e.target.closest('[data-instrument-edit]');if(edit)openEditor(edit.dataset.instrumentEdit);
  const open=e.target.closest('[data-code-open],[data-code-run]');
  if(open){const run=open.dataset.codeRun !== undefined;open.disabled=true;try{await json(run?'/api/instruments/run':'/api/instruments/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:run?open.dataset.codeRun:open.dataset.codeOpen,index:open.dataset.codeIndex})});message();}catch(err){message(err.message);}finally{open.disabled=false;}}
});
$('instrument-add').onclick=()=>openEditor();$('instrument-reload').onclick=()=>void reload();
$('instrument-search').oninput=paint;$('instrument-category').onchange=paint;
$('instrument-cancel').onclick=()=>{if(!saving)$('instrument-editor').close();};
$('instrument-editor').addEventListener('cancel',e=>{if(saving)e.preventDefault();});
$('instrument-form').onsubmit=async e=>{
  e.preventDefault();if(saving)return;saving=true;$('instrument-save').disabled=true;
  try {
    const f=new FormData(e.target),file=f.get('photo');
    if(file?.size){if(file.size>2*1024*1024)throw new Error('照片不能超过 2 MB');photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('照片读取失败'));reader.readAsDataURL(file);});}
    const project=f.get('project_id');const values=Object.fromEntries(fields.map(([key])=>[key,f.get(key)]));
    await json('/api/instruments/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,id:editing.id,revision:editing.revision,photo,project_ids:project?[project]:[],code_paths:f.get('code_paths').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)})});
    $('instrument-editor').close();await reload();
  }catch(err){$('instrument-editor-error').textContent=err.message;}finally{saving=false;$('instrument-save').disabled=false;}
};
