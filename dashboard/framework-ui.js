import {esc} from './format.js';
// Interaction for the project framework page: state chips (a small menu per chip) and jumping between linked items.
// Rendering lives in workspace.js; the rules (which change needs a reason) are enforced by the server in projects/framework.mjs,
// this menu only asks for the text those rules will demand so the user is not bounced back with an error.
const options=[['done','完成'],['doing','正在进行'],['failed','失败'],['open','未开始／待定义']];

// Operating steps (work-queue items) use the same menu with their own four lamps. The server (work.update) owns every rule: predecessors,
// a note and, where the step asks for it, an existing output path before "done". Reopening notes are optional.
const stepOptions=[['open','未开始／待定义','open'],['queued','待办','todo'],['active','正在进行','doing'],['done','完成','done'],['failed','失败','failed']];
const operators=[['user','你'],['codex','Codex'],['claude','Claude']];

export function bindFramework({post,load,workItem}) {
  let menu=null,target=null,step=null;
  const close=()=>{menu?.remove();menu=null;target=null;step=null;};
  const fail=message=>{const box=menu?.querySelector('.fw-err');if(box)box.textContent=message;};
  async function send(status,extra={}) {
    try{await post('/api/projects/status',{project_id:target.project,id:target.id,status,...extra});close();await load();}
    catch(error){fail(error.message);}
  }
  function ask(status) {
    const leaving=['done','failed'].includes(target.from) && target.from!==status;
    if(status!=='open' && !leaving)return send(status);
    const note=status==='open' ? '<label>是「未开始」还是「待定义」？写一句话<input data-fw-note maxlength="300"></label>' : '';
    const reason=leaving ? `<label>原来是「${options.find(o=>o[0]===target.from)[1]}」，为什么改？（这会推翻已记的结论）<input data-fw-reason maxlength="300"></label>` : '';
    menu.innerHTML=`<div class="fw-ask">${note}${reason}<button class="secondary small" data-fw-confirm="${status}">确定</button><div class="fw-err"></div></div>`;
    menu.querySelector('input').focus();
  }
  function open(chip) {
    close();
    target={project:chip.dataset.fwProject,id:chip.dataset.fwChip,from:chip.dataset.fwStatus || null,kind:chip.dataset.fwKind || ''};
    menu=document.createElement('div');menu.id='fw-menu';
    menu.innerHTML=options.filter(([key])=>target.kind!=='attempt' || key==='done' || key==='failed').map(([key,label])=>`<button class="fw-opt st-${key}" data-fw-set="${key}"><i class="fw-dot"></i>${label}</button>`).join('')+(target.from ? '<button class="fw-opt" data-fw-set="none">清除状态</button>' : '')+'<div class="fw-err"></div>';
    document.body.appendChild(menu);
    const box=chip.getBoundingClientRect();
    menu.style.top=window.scrollY+box.bottom+4+'px';
    menu.style.left=Math.max(8,Math.min(window.scrollX+box.left,window.innerWidth-menu.offsetWidth-8))+'px';
  }
  function openStep(chip) {
    close();
    step={id:chip.dataset.stepChip,from:chip.dataset.stepStatus,actor:chip.dataset.stepActor,blocked:!!chip.dataset.stepBlocked,paths:!!chip.dataset.stepOutputs};
    menu=document.createElement('div');menu.id='fw-menu';
    menu.innerHTML=stepOptions.map(([key,label,lamp])=>{
      const locked=step.blocked && ['active','done'].includes(key);
      return `<button class="fw-opt st-${lamp}" data-step-set="${key}" ${locked ? 'disabled title="前置步骤还没完成"' : ''}><i class="fw-dot"></i>${label}</button>`;
    }).join('')+'<div class="fw-err"></div>';
    document.body.appendChild(menu);
    const box=chip.getBoundingClientRect();
    menu.style.top=window.scrollY+box.bottom+4+'px';
    menu.style.left=Math.max(8,Math.min(window.scrollX+box.left,window.innerWidth-menu.offsetWidth-8))+'px';
  }
  async function sendStep(status) {
    const value=name=>menu.querySelector(name)?.value.trim();
    const body={id:step.id,status};
    if(value('[data-step-actor]')!==undefined)body.actor=value('[data-step-actor]');
    if(value('[data-step-reason]')!==undefined)body.reason=value('[data-step-reason]');
    if(value('[data-step-note]')!==undefined)body.handoff=value('[data-step-note]');
    if(value('[data-step-paths]')!==undefined)body.outputs=value('[data-step-paths]').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    try{await post('/api/task-update',body);close();await load();}
    catch(error){fail(error.message);}
  }
  function askStep(status) {
    const item=workItem?.(step.id) || {};
    const leaving=['done','failed'].includes(step.from) && step.from!==status;
    const reason=leaving ? `<label>变更说明（选填）<input data-step-reason maxlength="300"></label>` : '';
    const operator=status==='queued' ? `<label>操作对象（必选）<select data-step-actor>${operators.map(([v,l])=>`<option value="${v}" ${v===(item.actor || step.actor) ? 'selected' : ''}>${l}</option>`).join('')}</select></label><small>选 Codex／Claude：设为待办后，前置都完成时工作台就会交给她，之前不会调用模型。</small>` : '';
    const takeover=['active','done','failed'].includes(status) && step.actor && step.actor!=='user' ? `<small>你手动标记，操作对象会由 ${operators.find(o=>o[0]===step.actor)?.[1] || step.actor} 改为你。</small>` : '';
    const note=['done','failed'].includes(status) ? `<label>留言${status==='done' ? '（必填）：写明数据放在哪里、测了什么、有什么要注意' : '（选填）：发生了什么'}<textarea data-step-note rows="3" maxlength="2000">${esc(item.handoff || '')}</textarea></label>` : '';
    const paths=status==='done' && step.paths ? `<label>数据/产出位置（每行一个，必须真实存在）<textarea data-step-paths rows="2">${esc((item.outputs || []).join('\n'))}</textarea></label>` : '';
    if(!reason && !note && !paths && !operator && !takeover)return sendStep(status);
    menu.innerHTML=`<div class="fw-ask">${operator}${takeover}${reason}${note}${paths}<button class="secondary small" data-step-confirm="${status}">确定</button><div class="fw-err"></div></div>`;
    menu.querySelector('input,textarea,select')?.focus();
  }
  function goto(id) {
    const element=document.querySelector(`[data-fw-id="${CSS.escape(id)}"]`);
    if(!element)return;
    for(let d=element;d;d=d.parentElement?.closest('details'))d.open=true;
    element.scrollIntoView({block:'start',behavior:'smooth'});
    element.classList.remove('fw-flash');void element.offsetWidth;element.classList.add('fw-flash');
  }
  document.addEventListener('click',event=>{
    const hit=selector=>event.target.closest(selector);
    if(hit('[data-step-chip]')){event.preventDefault();openStep(hit('[data-step-chip]'));return;}
    if(hit('[data-step-set]')){askStep(hit('[data-step-set]').dataset.stepSet);return;}
    if(hit('[data-step-confirm]')){sendStep(hit('[data-step-confirm]').dataset.stepConfirm);return;}
    if(hit('[data-fw-chip]')){event.preventDefault();open(hit('[data-fw-chip]'));return;}
    if(hit('[data-fw-goto]')){goto(hit('[data-fw-goto]').dataset.fwGoto);return;}
    if(hit('[data-fw-set]')){const key=hit('[data-fw-set]').dataset.fwSet;if(key==='none'){const reason=['done','failed'].includes(target.from);if(reason)ask('none');else send('none');}else ask(key);return;}
    if(hit('[data-fw-confirm]')){const value=name=>menu.querySelector(name)?.value.trim();send(hit('[data-fw-confirm]').dataset.fwConfirm,{note:value('[data-fw-note]'),reason:value('[data-fw-reason]')});return;}
    if(menu && !hit('#fw-menu'))close();
  });
  document.addEventListener('keydown',event=>{
    if(!menu)return;
    if(event.key==='Escape')close();
    if(event.key==='Enter' && event.target.matches?.('.fw-ask input'))menu.querySelector('[data-fw-confirm],[data-step-confirm]').click();
  });
}
