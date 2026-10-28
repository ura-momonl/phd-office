import {read} from '../automation/files.mjs';
// Provenance is an explicit line, not a phrase quoted somewhere in a conversation.
export const cardOrigin=text=>/^[ \t]*原事项：[ \t]*(\S+)[ \t]*$/m.exec(text || '')?.[1] || '';
export function cardChain(id,work) {
  const ids=[];
  while(id && !ids.includes(id)) {
    ids.push(id);
    id=id.startsWith('work:') ? cardOrigin(work.find(w=>w.id===id.slice(5))?.goal) : '';
  }
  return id ? [] : ids; // A provenance cycle is not a valid matter chain: do not hide or close anything on it.
}
// The conversation already handling a card's matter: one holding the card's own task, or any task whose provenance chain reaches the card
// (a mail card has no task of its own, so its matter is found through the work cards raised from it). Newest activity wins.
export function sessionForCard(sessions,card,work) {
  const lastAt=s=>s.messages?.at(-1)?.at || s.created_at || '';
  return sessions.filter(s=>s.task_ids.some(t=>t===card.source_id || cardChain('work:'+t,work).includes(card.id)))
    .sort((a,b)=>lastAt(b).localeCompare(lastAt(a)))[0];
}
export function readCard(source,id) {
  const run=source==='work' ? read('work/queue.json').items.find(i=>i.id===id)?.review?.run_id || id : id;
  return read(source==='work' ? `.runtime/agent/runs/${run}/inbox.json` : `.runtime/inbox/cards/${source}-${id}.json`,{});
}
// A model reply that should be one JSON object (possibly fenced or surrounded by prose).
export function extractJSON(text) {
  const body = String(text || '').replace(/```(?:json)?/g, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(body.slice(start, end + 1));
}
// The program decides the available action types; card text and chosen replies are retained whole.
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = v => typeof v === 'string' ? v.trim() : '';
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).filter(a => a && text(a.label) && ['reply', 'accept'].includes(a.type)).slice(0, 3)
    .map((a, index) => ({ id: text(a.id).slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'option' + index, type: a.type, label: text(a.label), ...(a.type === 'reply' ? { reply: text(a.reply) || text(a.label) } : {}) }));
  const message = text(raw.message), resolved = raw.resolved === true;
  // A card that says the matter is settled needs no options; one that still asks the user something must have them.
  if (!message || (!actions.length && !resolved)) return null;
  return { category: text(raw.category) || '事项', kind: ['approval', 'acceptance', 'decision'].includes(raw.kind) ? raw.kind : 'decision', title: text(raw.title), message,
    actions: resolved ? [] : actions, ...(resolved ? { resolved: true } : {}),
    ...(typeof raw.origin==='string' && /^(?:work|mail):[^\s]+$/.test(raw.origin) ? {origin:raw.origin} : {}) };
}
export function cardActions(item,card={}) {
  const proposed=card.actions || item.actions;
  if(Array.isArray(proposed) && proposed.length) {
    const allowed=item.source==='link' ? ['link'] : item.source==='project' ? ['nav','accept'] : ['reply','review','accept'];
    const actions=proposed.filter(a=>a && typeof a.label==='string' && allowed.includes(a.type));
    if(actions.length)return actions.slice(0,3).map((a,index)=>({...a,id:String(a.id || index)}));
  }
  const actions=item.kind==='acceptance'
    ? [{id:'review',type:'review',label:'打开对照'},{id:'accept',type:'accept',label:'验收通过'},{id:'reply',type:'compose',label:'有问题，继续讨论'}]
    : [{id:'accept',type:'accept',label:item.kind==='approval' ? '同意方案' : '已处理'}];
  // User-requested handling is real work, not a second tool-less classification round.
  if(item.source==='mail' && item.kind==='decision')actions.unshift({id:'agent-handle',type:'reply',label:'让 agent 处理',
    reply:'按实际需要推进（读取、核对、记录、答复都可以），证据足够就交付；关键决定和对外动作先问我。发件须我批准具体动作和最终正文。'});
  return actions;
}
