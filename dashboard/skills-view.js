import {esc,num} from './format.js';
// Skills page: a read-only view of the project's own skills (.agents/skills). It is fetched once per visit; the page never writes.
const CLAUDE={ok:['Claude 链接有效',''],missing:['Claude 未链接','bad'],broken:['Claude 链接失效','bad'],unknown:['无法核对','bad']};
function card(s,view) {
  const bad=s.issues.length>0 || s.claude!=='ok' || !s.content;
  return `<article class="skill-card${bad ? ' attention' : ''}"><div class="skill-head"><strong>${esc(s.name)}</strong><span class="badge">Codex 本体${s.content ? '在位' : '待修正'}</span><span class="badge ${CLAUDE[s.claude][1]}">${CLAUDE[s.claude][0]}</span></div>`
    +`<p class="skill-desc">${esc(s.description || '（没有 description）')}</p>`
    +s.issues.map(i=>`<p class="settings-error">${esc(i)}</p>`).join('')+(s.notes || []).map(n=>`<p class="skill-note">提示：${esc(n)}</p>`).join('')
    +`<div class="skill-meta"><span title="可发现索引中名称和 description 的文本估算；不是实际账单">常驻 ≈${num(s.always_tokens)} token</span><span title="按需读取的正文文本估算">正文估算 ≈${num(s.body_tokens)} token</span></div>`
    +`<code>${esc(view.location+'/'+s.dir+'/SKILL.md')}</code>`
    +(s.content ? `<details class="skill-content"><summary>查看正文与依据（只读）</summary><pre>${esc(s.content)}</pre></details>` : '')+`</article>`;
}
function paint(box,view) {
  const list=view.skills,attention=list.filter(s=>s.issues.length || s.claude!=='ok' || !s.content).length,always=list.reduce((a,s)=>a+(s.always_tokens || 0),0);
  const stats=`<div class="stat-grid skill-stats"><div class="stat"><span>自建技能</span><strong>${list.length}</strong></div><div class="stat"><span>需要处理</span><strong>${attention}</strong></div><div class="stat"><span>常驻开销估算</span><strong>≈${num(always)}</strong><small class="muted">名称与描述合计 token</small></div></div>`;
  box.className='';
  box.innerHTML=stats+(list.length ? `<div class="skill-grid">${list.map(s=>card(s,view)).join('')}</div>` : '<p class="muted">项目里目前没有自建 skill。</p>')
    +view.problems.map(p=>`<p class="settings-error">${esc(p)}</p>`).join('')
    +`<details class="panel skill-convention"><summary>新建约定与核对范围</summary><p class="muted">这里只核对目录、头部字段和链接，不代表当前助手会话已发现或加载，也不执行技能。新建后需通过原生入口核验。</p><p class="muted">新建约定：本体放 ${esc(view.location)}/&lt;名&gt;/SKILL.md（头部 name 与目录名一致，description 写清触发条件），正文开头写依据、适用条件和验证范围；在 ${esc(view.claude_location)}/ 建同名链接指向它。助手可自主创建和修订，覆盖前留旧版；具体约定见 AGENTS.md 的“项目内自建 skills”。</p></details>`;
}
export function bindSkills({root,body}) {
  let loaded=false,loading=false;
  async function load() {
    loading=true;
    try {
      const r=await fetch('/api/skills'),view=await r.json();if(!r.ok)throw new Error(view.error || '技能读取失败');
      paint(body,view);loaded=true;
    } catch(e) {body.className='settings-error';body.textContent=e.message;} finally {loading=false;}
  }
  return {
    // Called by the page render: read on the first view of a visit.
    ensure() {if(!loaded && !loading)void load();},
    // Called when the page is entered, so a visit always starts from disk.
    reset() {loaded=false;}
  };
}
