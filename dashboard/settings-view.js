import {esc} from './format.js';
import {mountAvatarTuner} from './avatar-tuner.js';
// Settings page: the form is fetched once per visit and edited locally. The state poll only asks for a refresh of the connection cards,
// so an open form (and any unsaved edit) is never overwritten. Saving sends only the changed keys of one group.
// A model field is a list with a last entry that reveals a text box, so a model the list does not know can still be typed.
const OTHER='__other__';
const valueOf=el=>el.type==='checkbox' ? el.checked : el.type==='number' ? el.valueAsNumber : el.dataset.settingOther!==undefined && el.value===OTHER ? el.nextElementSibling.value.trim() : el.value;
function setValue(el,v) {
  if(el.type==='checkbox'){el.checked=v;return;}
  if(el.dataset.settingOther===undefined){el.value=v;return;}
  const known=[...el.options].some(o=>o.value===v && o.value!==OTHER);
  el.value=known ? v : OTHER;el.nextElementSibling.value=known ? '' : String(v ?? '');el.nextElementSibling.hidden=known;
}
const same=el=>JSON.stringify(valueOf(el))===el.dataset.original;
function control(f) {
  const id=`set-${esc(f.key)}`,key=`data-setting-key="${esc(f.key)}" id="${id}"${f.pair ? ` aria-label="${esc(f.label)}" title="${esc(f.label)}"` : ''}`;
  if(f.type==='bool')return `<input type="checkbox" ${key} ${f.value===true ? 'checked' : ''}>`;
  if(f.type==='enum')return `<select ${key}${f.effort_for ? ` data-effort-for="${esc(f.effort_for)}" data-efforts-by="${esc(JSON.stringify(f.efforts_by))}" data-defaults-by="${esc(JSON.stringify(f.defaults_by))}"` : ''}>${f.options.map(o=>`<option value="${esc(o)}" ${o===f.value ? 'selected' : ''}>${esc(f.labels?.[o] ?? o)}</option>`).join('')}</select>`;
  if(f.type==='int')return `<input type="number" step="1" min="${f.min}" max="${f.max}" ${key} value="${esc(f.value)}">${f.unit ? `<span class="muted">${esc(f.unit)}</span>` : ''}`;
  if(f.type==='model' && f.options?.length)return `<select class="model-select" ${key} data-setting-other${f.follows ? ` data-follows="${esc(f.follows)}" data-options-by="${esc(JSON.stringify(f.options_by))}" data-defaults-by="${esc(JSON.stringify(f.defaults_by))}"` : ''}>${f.options.map(o=>`<option value="${esc(o.value)}" ${o.value===f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}<option value="${OTHER}">其他（手动输入）…</option></select><input type="text" class="model-other" spellcheck="false" maxlength="60" aria-label="${esc(f.label)}（手动输入）" hidden>`;
  return `<input type="text" spellcheck="false" maxlength="60" ${key} value="${esc(f.value)}">`;
}
// The title model's list follows the provider select: rebuild it for the chosen side, keeping the model if that side lists it, else its default.
function rebuildModels(select,provider) {
  const list=JSON.parse(select.dataset.optionsBy)[provider] || [],keep=valueOf(select),preferred=JSON.parse(select.dataset.defaultsBy)[provider];
  const choice=list.some(o=>o.value===keep) ? keep : list.some(o=>o.value===preferred) ? preferred : list[0]?.value;
  select.innerHTML=list.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')+`<option value="${OTHER}">其他（手动输入）…</option>`;
  setValue(select,choice ?? '');
}
function rebuildEffort(select,model) {
  const provider=/^deepseek-/i.test(model) ? 'deepseek' : /^(claude-|(sonnet|opus|haiku|fable|default)(\[[^\]]*\])?$)/i.test(model) ? 'claude' : 'codex';
  const list=JSON.parse(select.dataset.effortsBy)[provider],keep=select.value,preferred=JSON.parse(select.dataset.defaultsBy)[provider];
  select.innerHTML=list.map(value=>`<option value="${value}">${value}</option>`).join('');
  select.value=list.includes(keep) ? keep : preferred;
}
export function bindSettings({root,tabs,body,connections,post,fail}) {
  let data=null,loading=false,tab='connections';
  function sync(section) {
    let dirty=0;
    section.querySelectorAll('.setting-row').forEach(row=>{
      const changed=[...row.querySelectorAll('[data-setting-key]')].filter(el=>!same(el)).length;row.classList.toggle('dirty',changed>0);dirty+=changed;
    });
    section.querySelector('.settings-actions').classList.toggle('dirty',dirty>0);
    section.querySelector('[data-settings-save]').disabled=!dirty;section.querySelector('[data-settings-reset]').disabled=!dirty;
    section.querySelector('.settings-status').textContent=dirty ? `${dirty} 项未保存` : '';
    tabs.querySelector(`[data-settings-tab="${section.dataset.settingsSection}"]`)?.classList.toggle('dirty',dirty>0);
  }
  // Switching tabs only toggles visibility; rebuilding the form would discard unsaved edits.
  function showTab() {
    tabs.querySelectorAll('[data-settings-tab]').forEach(b=>{const on=b.dataset.settingsTab===tab;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
    body.querySelectorAll('[data-settings-section]').forEach(s=>{s.hidden=s.dataset.settingsSection!==tab;});
    connections.hidden=tab!=='connections';
  }
  // A field with `pair` is shown beside the field it names (a model and its reasoning effort), not as a row of its own.
  // Rows are grouped under small section headings; `llm` marks a setting that makes the office call a model.
  function rows(g) {
    const fields=data.fields.filter(f=>f.group===g.id),paired=new Map(fields.filter(f=>f.pair).map(f=>[f.pair,f]));
    const row=f=>{
      const beside=paired.get(f.key);
      return `<div class="setting-row${beside ? ' pair' : ''}"><div><label for="set-${esc(f.key)}">${esc(f.label)}${f.llm ? '<span class="setting-llm" title="生效后会调用模型，消耗额度">调用模型</span>' : ''}</label>${f.help ? `<p class="muted">${esc(f.help)}</p>` : ''}</div><div class="setting-control">${control(f)}${beside ? control(beside) : ''}</div></div>`;
    };
    const sections=g.sections,known=new Set(sections.map(x=>x.id)),loose=fields.filter(f=>!f.pair && !known.has(f.section));
    return sections.map(x=>{
      const list=fields.filter(f=>!f.pair && f.section===x.id);
      return list.length ? `<section class="setting-section"><header><h3>${esc(x.title)}</h3>${x.note ? `<p class="muted">${esc(x.note)}</p>` : ''}</header><div class="setting-rows">${list.map(row).join('')}</div></section>` : '';
    }).join('')+(loose.length ? `<div class="setting-rows">${loose.map(row).join('')}</div>` : '');
  }
  const show=(v,f)=>v===null || v===undefined ? '未设置' : typeof v==='boolean' ? (v ? '开' : '关') : String(v)+(f?.unit ? ' '+f.unit : '');
  // The newest saved changes of this group, so a surprising behaviour can be traced back to a setting.
  function recent(g) {
    const list=data.recent.filter(c=>c.group===g.id).slice(0,6);
    if(!list.length)return '<p class="muted">还没有保存过修改。</p>';
    return `<ul>${list.map(c=>{const f=data.fields.find(x=>x.key===c.key);return `<li><time>${esc(new Date(c.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</time><span>${esc(c.label)}</span><code>${esc(show(c.from,f))} → ${esc(show(c.to,f))}</code></li>`;}).join('')}</ul>`;
  }
  // 设置 → 外观: palette (row shown once more than one exists) and font. Choices apply at once and are kept in this browser.
  const themeChoices=()=>{
    const th=window.officeTheme;if(!th)return '<p class="muted">主题脚本未加载，请刷新页面。</p>';
    const cur=th.get(),o=th.options;
    const opt=(axis,id,inner,label)=>`<button type="button" role="radio" class="theme-opt${cur[axis]===id ? ' on' : ''}" aria-checked="${cur[axis]===id}" data-theme-set="${axis}:${id}" title="${esc(label)}">${inner}</button>`;
    const row=(title,items)=>`<div class="theme-row"><span class="theme-label">${title}</span><div class="theme-opts" role="radiogroup" aria-label="${title}">${items}</div></div>`;
    return (o.palettes.length>1 ? row('配色',o.palettes.map(([id,n,sw])=>opt('palette',id,`<span class="theme-swatch">${sw.map(c=>`<i style="background:${c}"></i>`).join('')}</span><span>${n}</span>`,n)).join('')) : '')
      +row('字体',o.fonts.map(([id,n])=>opt('font',id,`<span class="font-sample" style="font-family:${id==='default' ? 'inherit' : `var(--font-${id})`}">Aa 字体 0123</span><small>${esc(n)}</small>`,n)).join(''));
  };
  function render() {
    tabs.innerHTML=[{id:'connections',title:'连接'},...data.groups,{id:'avatars',title:'外观'},{id:'update',title:'更新'}].map(t=>`<button type="button" role="tab" class="settings-tab${t.id===tab ? ' active' : ''}" aria-selected="${t.id===tab}" data-settings-tab="${esc(t.id)}">${esc(t.title)}</button>`).join('');
    body.innerHTML=data.groups.map(g=>`<article class="panel" data-settings-section="${esc(g.id)}" ${g.id===tab ? '' : 'hidden'}><div class="panel-heading"><h2>${esc(g.title)}</h2></div><p class="muted">${esc(g.note)}</p>${rows(g)}<details class="setting-recent"><summary>最近修改</summary><div data-settings-recent="${esc(g.id)}">${recent(g)}</div></details><div class="settings-actions"><span class="settings-status muted" role="status"></span><button type="button" class="secondary" data-settings-reset disabled>放弃修改</button><button type="button" class="secondary primary" data-settings-save disabled>保存</button></div></article>`).join('')+`<article class="panel" data-settings-section="avatars" ${tab==='avatars' ? '' : 'hidden'}><div class="panel-heading"><h2>配色与字体</h2></div><p class="muted">只改外观，不影响功能；选择立即生效，保存在这台浏览器里。</p><div class="theme-picker">${themeChoices()}</div><div class="panel-heading"><h2>头像</h2></div><p class="muted">点“更换”上传图片，在弹出的窗口里拖动和缩放来取景，确定后聊天里立刻更新；“还原默认”可换回原来的头像。</p><div id="avatar-tuner"></div></article><article class="panel" data-settings-section="update" ${tab==='update' ? '' : 'hidden'}><div class="panel-heading"><h2>从 GitHub 更新</h2></div><p class="muted">只下载 GitHub 上有变化的文件并逐个校验；本地改过的文件不会被覆盖，GitHub 版本放到 .runtime/github-update/incoming/ 供合并。点按钮才联网，没有自动检查。应用后代码要重启后端才生效。</p><div class="settings-actions"><span class="settings-status muted" role="status" data-update-status></span><button type="button" class="secondary" data-update-check>检查更新</button><button type="button" class="secondary primary" data-update-apply disabled>应用更新</button></div><pre class="update-output" data-update-output hidden></pre></article>`;
    mountAvatarTuner(body.querySelector('#avatar-tuner')).catch(e=>fail(e.message));
    body.querySelectorAll('[data-setting-key]').forEach(el=>{el.dataset.original=JSON.stringify(valueOf(el));});
    showTab();
  }
  async function load() {
    loading=true;
    try {
      const r=await fetch('/api/settings'),next=await r.json();
      if(!r.ok)throw new Error(next.error || '设置读取失败');
      data=next;render();
    } catch(e) {fail(e.message);} finally {loading=false;}
  }
  root.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.themeSet){const [axis,val]=b.dataset.themeSet.split(':');window.officeTheme?.set({[axis]:val});root.querySelector('.theme-picker').innerHTML=themeChoices();return;}
    if(b.dataset.settingsTab){tab=b.dataset.settingsTab;showTab();return;}
    if(b.dataset.updateCheck!==undefined || b.dataset.updateApply!==undefined) {
      // 先预览，预览出有可应用的变化才亮出“应用更新”；应用是单独的一次点击。
      const box=b.closest('[data-settings-section]'),apply=b.dataset.updateApply!==undefined,out=box.querySelector('[data-update-output]'),status=box.querySelector('[data-update-status]'),applyBtn=box.querySelector('[data-update-apply]'),checkBtn=box.querySelector('[data-update-check]');
      checkBtn.disabled=applyBtn.disabled=true;status.classList.remove('settings-error');status.textContent=apply ? '正在更新…' : '正在检查…';
      try {
        const r=await post(apply ? '/api/update/apply' : '/api/update/check',{});
        out.textContent=r.output;out.hidden=!r.output;
        if(!r.ok)throw new Error('更新没有完成，详情见下方输出');
        const pending=!apply && /加 --apply 应用/.test(r.output);
        status.textContent=apply ? '已应用；如有代码变化，请重启后端' : pending ? '有可应用的更新' : '没有需要更新的文件';
        applyBtn.disabled=!pending;
      } catch(err) {status.textContent=err.message;status.classList.add('settings-error');}
      checkBtn.disabled=false;return;
    }
    const section=b.closest('[data-settings-section]');
    if(!section || (b.dataset.settingsSave===undefined && b.dataset.settingsReset===undefined))return;
    const controls=[...section.querySelectorAll('[data-setting-key]')],status=section.querySelector('.settings-status');
    if(b.dataset.settingsReset!==undefined) {
      controls.filter(el=>!el.dataset.follows && !el.dataset.effortFor).forEach(el=>setValue(el,JSON.parse(el.dataset.original)));
      for(const el of controls.filter(x=>x.dataset.follows)) {rebuildModels(el,section.querySelector('#set-'+el.dataset.follows).value);setValue(el,JSON.parse(el.dataset.original));}
      for(const el of controls.filter(x=>x.dataset.effortFor)) {rebuildEffort(el,valueOf(document.getElementById('set-'+el.dataset.effortFor)));setValue(el,JSON.parse(el.dataset.original));}
      status.classList.remove('settings-error');sync(section);return;
    }
    const changes={};for(const el of controls)if(!same(el))changes[el.dataset.settingKey]=valueOf(el);
    b.disabled=true;
    try {
      const result=await post('/api/settings',{changes});data=result;
      for(const el of controls)el.dataset.original=JSON.stringify(result.fields.find(f=>f.key===el.dataset.settingKey).value);
      status.classList.remove('settings-error');sync(section);
      const group=data.groups.find(x=>x.id===section.dataset.settingsSection),box=section.querySelector('[data-settings-recent]');if(group && box)box.innerHTML=recent(group);
      status.textContent=result.changed.length ? `已保存 ${result.changed.length} 项，下一次调用起生效` : '没有变化';
    } catch(err) {status.textContent=err.message;status.classList.add('settings-error');b.disabled=false;}
  });
  root.addEventListener('input',e=>{
    const target=e.target,section=target.closest('[data-settings-section]');
    if(target.dataset.settingKey)root.querySelectorAll(`select[data-follows="${target.dataset.settingKey}"]`).forEach(s=>rebuildModels(s,target.value));
    if(target.matches('select[data-setting-other]')){const other=target.nextElementSibling;other.hidden=target.value!==OTHER;if(!other.hidden)other.focus();}
    const model=target.matches('.model-other') ? target.previousElementSibling : target;
    if(model.dataset.settingKey)root.querySelectorAll(`select[data-effort-for="${model.dataset.settingKey}"]`).forEach(s=>rebuildEffort(s,valueOf(model)));
    if(section && (target.dataset.settingKey || target.matches('.model-other'))){section.querySelector('.settings-status').classList.remove('settings-error');sync(section);}
  });
  return {
    // Called by the page render: fetch on first view of a visit.
    ensure() {if(!data && !loading)void load();},
    // Refresh clean visits from disk, but a visit elsewhere must not discard a draft.
    // Remove the old clean controls while loading so they cannot be edited just before replacement.
    reset() {if(body.querySelector('.setting-row.dirty'))return;data=null;tabs.replaceChildren();body.replaceChildren();}
  };
}
