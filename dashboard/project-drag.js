// Edit-mode drag for the project framework: re-order and re-parent columns, logs, steps and whole step lists.
// The checks below only decide whether to offer a drop target; projects/framework.mjs and work/run.mjs make the final decision.
let drag=null;
export const dragging=()=>!!drag;
const dropEl=el=>el?.closest('[data-drop-node]');
const parentOf=el=>dropEl(el.parentElement);
const isBoard=el=>el.classList.contains('fw-board');
const isEntry=el=>el.classList.contains('fw-entry');
const lineOf=el=>['timeline','logic','info'].find(t=>el.closest('.fw-board')?.classList.contains('fw-'+t));
function levelOf(el) {let n=2;for(let p=parentOf(el);p;p=parentOf(p))n++;return n;}
function heightOf(el) {return Math.max(0,...[...el.querySelectorAll('[data-drop-node]')].map(x=>levelOf(x)-levelOf(el)))+1;}
const zoneOf=(e,box,steps)=>{const r=box.getBoundingClientRect(),f=(e.clientY-r.top)/Math.max(1,r.height);return steps ? (f<.5 ? 'before' : 'after') : f<.3 ? 'before' : f>.7 ? 'after' : 'into';};
// Where a dragged column or log would land: {parent,before|after} for the move request, or null when it cannot go there.
function nodePlan(d,t,zone) {
  if(t===d || d.contains(t))return null;
  const parent=zone==='into' ? t : parentOf(t),plan={parent:parent?.dataset.dropNode ?? null};
  if(zone!=='into')plan[zone]=t.dataset.dropNode;
  if(isBoard(d))return !parent && zone!=='into' && isBoard(t) ? plan : null;
  if(!parent || isEntry(parent) || lineOf(parent)!==lineOf(d) || isEntry(d) && lineOf(parent)!=='timeline')return null;
  return levelOf(parent)+heightOf(d)<=6 ? plan : null;
}
// A whole step list goes onto any other time-log node (appended after its steps).
function stepsPlan(list,node) {
  const own=list.closest('[data-fw-unassigned-work]') ? null : dropEl(list);
  return node!==own && node.closest('.fw-board.fw-timeline') ? {plan_node_id:node.dataset.dropNode} : null;
}
// A step goes onto any node of a time-log board, or next to another step that already sits on one.
function stepPlan(s,target,zone) {
  const row=target.closest('.fw-step'),owner=dropEl(row || target);
  if(row===s || !owner || !owner.closest('.fw-board.fw-timeline') || row?.closest('[data-fw-unassigned-work]'))return null;
  return row ? {[zone]:row.dataset.stepRow} : {plan_node_id:owner.dataset.dropNode};
}
function target(e) {
  if(!drag)return null;
  if(drag.kind==='steps') {
    const summary=e.target.closest('summary'),node=summary?.parentElement;
    if(!node?.matches('[data-drop-node]'))return null;
    const plan=stepsPlan(drag.el,node);
    return plan ? {box:summary,zone:'into',plan,node} : null;
  }
  if(drag.kind==='step') {
    const row=e.target.closest('.fw-step'),summary=!row && e.target.closest('summary'),node=summary?.parentElement;
    const box=row || (node?.matches('[data-drop-node]') ? summary : null);
    if(!box)return null;
    const zone=row ? zoneOf(e,row,true) : 'into',plan=stepPlan(drag.el,box,zone);
    return plan ? {box,zone,plan,node} : null;
  }
  const summary=e.target.closest('summary'),node=summary && summary.parentElement;
  if(!node?.matches('[data-drop-node]'))return null;
  const zone=zoneOf(e,summary),plan=nodePlan(drag.el,node,zone);
  return plan ? {box:summary,zone,plan,node} : null;
}
function mark(hit) {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(el=>el.classList.remove('drop-before','drop-after','drop-into'));
  if(hit)hit.box.classList.add('drop-'+hit.zone);
}
function finish() {
  mark(null);document.querySelectorAll('.drag-source').forEach(el=>el.classList.remove('drag-source'));
  document.body.classList.remove('is-dragging');drag=null;
}
export function bindProjectDrag({post,load,error}) {
  // A click on the grip must not fold or unfold the row it sits in.
  document.addEventListener('click',e=>{if(e.target.closest('.fw-grip')){e.preventDefault();e.stopPropagation();}},true);
  document.addEventListener('dragstart',e=>{
    const grip=e.target.closest?.('.fw-grip');if(!grip)return;
    const kind=grip.dataset.dragSteps ? 'steps' : grip.dataset.dragStep ? 'step' : 'node',id=grip.dataset.dragSteps || grip.dataset.dragStep || grip.dataset.dragNode;
    const el=kind==='steps' ? grip.closest('.fw-steps') : kind==='step' ? grip.closest('.fw-step') : dropEl(grip);if(!el)return;
    drag={kind,id,project:grip.dataset.dragProject,el};
    e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id);
    e.dataTransfer.setDragImage(kind==='node' ? el.querySelector(':scope > summary') : el,12,12);
    el.classList.add('drag-source');document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover',e=>{
    const hit=target(e);mark(hit);
    if(hit){e.preventDefault();e.dataTransfer.dropEffect='move';}
  });
  document.addEventListener('drop',async e=>{
    const hit=target(e),current=drag;if(!hit || !current)return;
    e.preventDefault();finish();
    try {
      if(hit.zone==='into' && hit.node)hit.node.open=true;
      if(current.kind==='steps')await post('/api/work/move',{project_id:current.project,ids:current.id.split(','),...hit.plan});
      else if(current.kind==='step')await post('/api/work/move',{project_id:current.project,id:current.id,...hit.plan});
      else await post('/api/projects/edit',{project_id:current.project,id:current.id,action:'move',...hit.plan});
      error('');
    }catch(err){error(err.message);}
    await load();
  });
  document.addEventListener('dragend',finish);
}
