import {esc} from './format.js';
// Direct editing, without model calls. Load source prose on demand; preserve the draft while the page polls.
export function bindProjectEditor({post,load}) {
  let dialog=null,dirty=false,saving=false;
  function close(force=false) {
    if(saving || (!force && dirty && !confirm('放弃尚未保存的修改？')))return;
    dialog?.remove();dialog=null;dirty=false;
  }
  async function openStep(button) {
    const create=button.hasAttribute('data-step-add'),id=button.dataset.stepEdit,action=button.dataset.stepAction || 'content';
    const project=button.dataset.stepProject,node=button.dataset.stepAdd;
    dialog=document.createElement('dialog');dialog.className='project-editor';dialog.innerHTML='<p>正在读取步骤…</p>';
    document.body.appendChild(dialog);dialog.showModal();dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    try {
      const response=await fetch(create ? '/api/work/new?project='+encodeURIComponent(project)+'&node='+encodeURIComponent(node) : '/api/work/editor?id='+encodeURIComponent(id));if(!response.ok)throw new Error(await response.text());
      let snapshot=await response.json();const item=create ? {title:'',goal:'',actor:'user',dependencies:[]} : snapshot.item,remove=action==='delete';
      // Finished or failed steps are hidden unless already chosen, so saving never drops an existing prerequisite.
      const chosen=item.dependencies || [],shown=snapshot.choices.filter(c=>!['done','failed'].includes(c.status) || chosen.includes(c.id)),hidden=snapshot.choices.length-shown.length;
      const dependencies=shown.map(c=>`<label class="step-dependency"><input type="checkbox" name="dependency" value="${esc(c.id)}" ${chosen.includes(c.id) ? 'checked' : ''}>${esc(c.title)}</label>`).join('')+(hidden ? `<p class="muted">已隐藏 ${hidden} 个已完成／失败的步骤。</p>` : '');
      dialog.innerHTML=`<form><header><h2>${remove ? '删除操作步骤' : create ? '新增操作步骤' : '编辑操作步骤'}</h2><button type="button" class="text-button" data-editor-close>✕</button></header><p class="editor-context">${esc(create ? snapshot.owner.title : item.title)}</p>${remove ? '<p>从项目页移除这一步，后台保留原记录和交付文件。被其他步骤依赖或正在执行时不能删除，不会自动解除依赖。</p><label class="step-dependency"><input type="checkbox" name="confirm" required>我确认删除这一步</label>' : `<label>标题<input name="title" required value="${esc(item.title)}"></label><label>步骤说明<textarea name="goal" rows="5">${esc(item.goal)}</textarea></label><label>负责人<select name="actor">${[['user','你'],['codex','Codex'],['claude','Claude'],['deepseek','DeepSeek']].map(([v,l])=>`<option value="${v}" ${item.actor===v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${create ? '' : `<label>留言／交接<textarea name="handoff" rows="3">${esc(item.handoff)}</textarea></label>`}<details><summary>前置步骤（${item.dependencies?.length || 0}）</summary>${dependencies || '<p>没有其他步骤。</p>'}</details><p class="muted">${create ? '新步骤从待执行开始，保存只登记，不会调用模型。' : '状态、数据文件及自动执行设置不变。'}${item.actor!=='user' && item.status==='queued' ? '此步骤是「待办」，前置全部完成后工作台会交给所选助手。' : '此步骤不会因保存而自动执行；助手步骤要把状态设为「待办」才会开始。'}</p>`}<p class="editor-error" role="alert"></p><div class="editor-conflict"></div><footer><small class="muted">${create ? '直接归入当前日志板块；不自动执行或对外发送。' : '保存前备份，保留原任务 ID。'}</small><div><button type="button" class="secondary" data-editor-close>取消</button><button class="${remove ? 'danger' : 'primary'}" type="submit">${remove ? '确认删除' : '保存'}</button></div></footer></form>`;
      const form=dialog.querySelector('form'),err=form.querySelector('.editor-error');
      dialog.querySelectorAll('[data-editor-close]').forEach(b=>b.onclick=()=>close());
      form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});
      form.addEventListener('submit',async e=>{
        e.preventDefault();if(saving)return;saving=true;form.querySelector('[type=submit]').disabled=true;err.textContent='';
        const values=Object.fromEntries(new FormData(form)),payload=create ? {project_id:project,plan_node_id:node} : {id,action,revision:snapshot.revision};
        if(remove)payload.confirm=form.elements.confirm.checked;
        else Object.assign(payload,{title:values.title,goal:values.goal,handoff:values.handoff,actor:values.actor,dependencies:new FormData(form).getAll('dependency')});
        try{await post(create ? '/api/work/add' : '/api/work/edit',payload);saving=false;close(true);await load();}
        catch(error){
          err.textContent=error.message;saving=false;form.querySelector('[type=submit]').disabled=false;
          if(!create && !remove && error.message.includes('已被其他操作更新')) {
            try {
              const r=await fetch('/api/work/editor?id='+encodeURIComponent(id));if(!r.ok)return;
              const latest=await r.json(),n=latest.item,panel=form.querySelector('.editor-conflict');
              panel.innerHTML=`<details open><summary>步骤最新版（你的草稿仍在上方）</summary><p>${esc(n.title)} · ${esc(n.actor)} · ${esc(n.status)}</p><p class="message-text">${esc(n.goal)}</p><p class="message-text">${esc(n.handoff)}</p><p>前置：${esc((n.dependencies || []).map(d=>latest.choices.find(c=>c.id===d)?.title || d).join('、') || '无')}</p><button type="button" class="secondary" data-step-rebase>已核对，以最新版为基础继续保存我的草稿</button></details>`;
              panel.querySelector('[data-step-rebase]').onclick=()=>{snapshot=latest;panel.innerHTML='';err.textContent='保存基线已更新，请核对草稿后再保存。';};
            }catch{ /* keep draft and original conflict message */ }
          }
        }
      });
      dialog.querySelector('input,textarea')?.focus();
    }catch(error){dialog.innerHTML=`<p role="alert">${esc(error.message)}</p><button type="button">关闭</button>`;dialog.querySelector('button').onclick=()=>close(true);}
  }
  document.addEventListener('click',async event=>{
    const stepButton=event.target.closest('[data-step-edit],[data-step-add]');
    if(stepButton){event.preventDefault();event.stopPropagation();if(!dialog)await openStep(stepButton);return;}
    const button=event.target.closest('[data-fw-edit]');if(!button)return;
    event.preventDefault();event.stopPropagation();
    if(dialog)return;
    const project=button.dataset.editorProject,id=button.dataset.fwEdit,action=button.dataset.editorAction || 'content';
    dialog=document.createElement('dialog');dialog.className='project-editor';
    dialog.innerHTML='<p>正在读取最新内容…</p>';document.body.appendChild(dialog);dialog.showModal();
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    try {
      const response=await fetch('/api/projects/editor?project='+encodeURIComponent(project));
      if(!response.ok)throw new Error(await response.text());
      let snapshot=await response.json(),node=snapshot.nodes.find(n=>n.id===id);
      if(!dialog)return;
      if(id && !node)throw new Error('条目已移动或移除，请关闭后刷新项目页。');
      const create=action==='add-node' || action==='add-entry',remove=action==='delete';
      const name=remove ? '删除本栏' : action==='content' ? '编辑内容' : action==='add-entry' ? '新增日志' : id ? '新增子栏' : '新增大板块';
      const canTrack=node && !snapshot.nodes.filter(n=>node.ancestors.concat(node.id).includes(n.id)).some(n=>n.type==='info' || n.kind==='info');
      const kindField=action==='add-node' && id ? `<label class="step-dependency"><input type="checkbox" name="tracked" ${canTrack ? '' : 'disabled'}>带状态灯</label><small class="muted">默认只组织内容，不带灯。${canTrack ? '开启后可手动标阶段进展，不会自动执行任务。失败或试错经过可直接写日志。' : '所在说明板块不带研究状态；操作步骤仍可在日志内单独添加。'}</small>` : '';
      const typeField=action==='add-node' && !id ? '<label>板块内容线<select name="type"><option value="info">项目说明</option><option value="logic">研究逻辑</option><option value="timeline">时间日志</option></select></label>' : '';
      const prose=remove ? `<p>删除「${esc(node.title)}」及 ${snapshot.nodes.filter(n=>n.ancestors.includes(id)).length} 个下级条目（包括子栏和日志）。保存前保留完整备份；附件和操作步骤不会删除。相关关联、顺序引用和旧步骤绑定自动解除；其他正文中的引用保留为已删除记录的文字说明。</p><label class="step-dependency"><input type="checkbox" name="confirm" required>我确认删除本栏及全部下级内容</label>` : `<label>标题<input name="title" required value="${esc(create ? '' : node.title)}"></label><label>折叠时的摘要<input name="summary" value="${esc(create ? '' : node.summary)}"></label><label>正文<textarea name="body" rows="14" spellcheck="false">${esc(create ? '' : node.body)}</textarea></label><small class="muted">只编辑本栏文字，不包含子栏。支持 Markdown；结构用“新增子栏”，不要写 ## 标题。备注、评价等保留原标签，会继续分栏显示。实质更正请追加说明，不用今天的理解覆盖过去。</small>`;
      const dateField=action==='content' && node?.entry ? `<label>发生日期<input name="date" value="${esc(node.date)}" placeholder="YYYY、YYYY-MM、YYYY-MM-DD 或起止日期/日期"></label><label>日期确认<select name="date_confirmed"><option value="false" ${node.date_confirmed ? '' : 'selected'}>待确认</option><option value="true" ${node.date_confirmed ? 'selected' : ''}>已确认</option></select></label><small class="muted">改日期会清掉旧确认；只有重新选择“已确认”才确认新日期。留空表示日期待补；原日期依据保留并追加更正。</small>` : '';
      const backups=`<details class="editor-backups"><summary>保存前的备份（${snapshot.backups?.length || 0}）</summary><p class="muted">时间是备份保存时间，不是实验日期。恢复前先核对后续修改；这里不直接覆盖文件。</p>${(snapshot.backups || []).map(b=>`<p><time>${esc(new Date(b.saved_at).toLocaleString())}</time> · ${b.bytes} 字节<br><code>${esc(b.path)}</code></p>`).join('') || '<p>尚无编辑备份。</p>'}</details>`;
      dialog.innerHTML=`<form><header><div><p class="eyebrow">PROJECT EDITOR</p><h2>${name}</h2></div><button type="button" class="text-button" data-editor-close aria-label="关闭编辑器">✕</button></header>${node ? `<p class="editor-context">${esc(node.title)} <code>${esc(node.id)}</code></p>` : ''}${typeField}${kindField}${prose}${dateField}${backups}<p class="editor-error" role="alert"></p><div class="editor-conflict"></div><footer><small class="muted">保存前自动备份；${remove ? '关联自动解除，保留操作状态与附件。' : '不改变任务或状态。'}Ctrl + Enter 提交</small><div><button type="button" class="secondary" data-editor-close>取消</button><button class="${remove ? 'danger' : 'primary'}" type="submit">${remove ? '确认删除' : '保存'}</button></div></footer></form>`;
      const form=dialog.querySelector('form'),err=dialog.querySelector('.editor-error');
      dialog.querySelectorAll('[data-editor-close]').forEach(b=>b.onclick=()=>close());
      form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});
      form.querySelector('[name=date]')?.addEventListener('input',()=>{form.elements.date_confirmed.value='false';});
      form.addEventListener('keydown',e=>{if(e.key==='Enter' && e.ctrlKey){e.preventDefault();form.requestSubmit();}});
      form.addEventListener('submit',async e=>{
        e.preventDefault();if(saving)return;
        const values=Object.fromEntries(new FormData(form)),payload={project_id:project,id,action,revision:snapshot.revision,...values};
        if(node?.entry && action==='content') {
          delete payload.date;delete payload.date_confirmed;
          payload.fields={};
          if(values.date!==node.date)payload.fields.date=values.date || null;
          if(values.date_confirmed!==(node.date_confirmed ? 'true' : 'false') || values.date!==node.date)payload.fields.date_confirmed=values.date_confirmed==='true';
          if(!Object.keys(payload.fields).length)delete payload.fields;
        }
        if(create)payload.parent=id || null;
        if(action==='add-node' && id){payload.kind=form.elements.tracked.checked ? 'milestone' : 'info';delete payload.tracked;}
        if(remove)payload.confirm=form.elements.confirm.checked;
        saving=true;form.querySelector('[type=submit]').disabled=true;err.textContent='';
        try {
          try {await post('/api/projects/edit',payload);}
          catch(error) {
            if(action!=='content' || !error.message.includes('已被其他操作更新'))throw error;
            const response=await fetch('/api/projects/editor?project='+encodeURIComponent(project));
            if(!response.ok)throw error;
            const latest=await response.json(),current=latest.nodes.find(n=>n.id===id);
            const same=current && ['title','body','summary','date','date_confirmed','after'].every(k=>current[k]===node[k]);
            if(same) {
              snapshot=latest;node=current;payload.revision=latest.revision;
              await post('/api/projects/edit',payload); // one retry; server still enforces the revision
            } else {
              const panel=form.querySelector('.editor-conflict');
              panel.innerHTML=current ? `<details open><summary>该栏的最新版（你的草稿仍在上方）</summary><p>${esc(current.title)}</p><p>${esc(current.summary)}</p><p>日期：${esc(current.date || '待补')} · ${current.date_confirmed ? '已确认' : '待确认'}</p><label>最新正文<textarea readonly rows="8">${esc(current.body)}</textarea></label><button type="button" class="secondary" data-editor-rebase>已核对，以最新版为基础继续保存我的草稿</button></details>` : '<p>该栏已不存在，不能覆盖；请复制保留草稿。</p>';
              panel.querySelector('[data-editor-rebase]')?.addEventListener('click',()=>{
                snapshot=latest;node=current;panel.innerHTML='';err.textContent='已更新保存基线；请核对并修改上方草稿，再点保存。';
              });
              throw error;
            }
          }
          saving=false;close(true);await load();
        }
        catch(error){err.textContent=error.message;saving=false;if(dialog)form.querySelector('[type=submit]').disabled=false;}
      });
      dialog.querySelector('input,select,textarea')?.focus();
    }catch(error){if(dialog){dialog.innerHTML=`<p role="alert">${esc(error.message)}</p><button type="button">关闭</button>`;dialog.querySelector('button').onclick=()=>close(true);}}
  });
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
}
