import {esc} from './format.js';
const scopes={
  daily:['DAILY PICKS','每日推荐','查看推荐理由，按需阅读。推荐篇数不固定。'],
  candidates:['DISCOVERY','最近候选','来源抓取的待筛选清单，不等于助手已经推荐。'],
  pool:['COLLECTION','资料积累','已积累的资料记录，不等于已读，也不代表喜欢。'],
  local:['FULL TEXT','本地全文','登记路径下已有文件的条目；选中后查看可用的 PDF 入口。'],
  nofull:['NO FULL TEXT','没有全文','只有记录或摘要、本地尚无全文文件的条目；不会自动联网补齐。']
};
export function bindLiterature(root) {
  const $=id=>root.querySelector('#'+id);
  let started=false,scope='daily',page=1,query='',selection='',listVersion=0,detailVersion=0,selectedDate='',today='';
  const request=async url=>{const r=await fetch(url);if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||'文献接口尚未就绪，请在任务结束后重启后端。');}return r.json();};
  const badges=p=>`${p.has_fulltext?'<span class="lit-local">全文已获取</span>':p.has_abstract?'<span class="lit-abstract-only">仅摘要 · 待核对全文</span>':'<span class="lit-missing">待补摘要与全文</span>'}${p.no_subscription&&!p.has_fulltext?'<span class="lit-missing">学校未订阅</span>':''}`;
  function markSelected(){root.querySelectorAll('[data-lit-doi]').forEach(b=>{const on=b.dataset.litDoi===selection;b.classList.toggle('selected',on);b.setAttribute('aria-expanded',String(on));});}
  function resetDetail(){
    selection='';detailVersion++;markSelected();$('lit-detail').classList.remove('has-paper');
    $('lit-detail').innerHTML='<div class="lit-detail-top"><span class="eyebrow">READING DESK</span><span class="lit-readonly">按需读取</span></div><div class="lit-detail-empty"><svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><path d="M24 12c-5-4-12-5-19-3v28c7-2 14-1 19 3m0-28c5-4 12-5 19-3v28c-7-2-14-1-19 3V12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M11 17h7m-7 7h7m12-7h7m-7 7h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><h2>选择一篇文献</h2><p>从左侧选一篇，在这里看推荐解读、摘要和原文入口。</p></div><ol class="lit-reading-guide"><li><span>01</span><div><b>推荐理由</b><p>查看研究问题和推荐依据。</p></div></li><li><span>02</span><div><b>区分摘要与全文</b><p>推荐依据和文件状态分别标明。</p></div></li><li><span>03</span><div><b>打开原文</b><p>直接打开已有 PDF 或论文页面。</p></div></li></ol><p class="lit-safety-note">只在选中后读取摘要，不自动下载或调用模型。</p>';
  }
  function returnToList(){const doi=selection;resetDetail();const row=[...root.querySelectorAll('[data-lit-doi]')].find(b=>b.dataset.litDoi===doi);row?.focus({preventScroll:false});}
  function renderRow(p,i){
    return `<button type="button" class="lit-row" data-lit-doi="${esc(p.doi)}" aria-controls="lit-detail" aria-expanded="false"><span class="lit-row-meta"><span class="lit-row-source">${scope==='daily'?'<span class="lit-number">'+String((page-1)*20+i+1).padStart(2,'0')+'</span>':''}${esc(p.source||'期刊未登记')}</span><span>${esc(p.date||'日期未登记')}</span></span><strong>${esc(p.title)}</strong><span class="lit-badges">${badges(p)}${p.basis?'<span>推荐依据：'+(p.basis==='fulltext'?'全文':'摘要')+'</span>':''}</span>${p.reason?'<span class="lit-reason"><b>为什么推荐</b>'+esc(p.reason)+'</span>':''}<span class="lit-row-footer"><span class="lit-row-doi">${esc(p.doi)}</span><span class="lit-row-action">${scope==='daily'?'查看解读':'查看摘要'} <span aria-hidden="true">↗</span></span></span></button>`;
  }
  async function loadList() {
    const version=++listVersion;$('literature-message').textContent='';$('lit-results').setAttribute('aria-busy','true');$('lit-prev').disabled=true;$('lit-next').disabled=true;
    // Never leave cards from the previous scope/date interactive during a pending request.
    $('lit-results').innerHTML='<p class="lit-empty">正在读取本地记录…</p>';
    const [kicker,title,description]=scopes[scope];$('lit-section-kicker').textContent=kicker;$('lit-section-title').textContent=title;$('lit-section-description').textContent=description;
    $('lit-date-controls').hidden=scope!=='daily';
    try {
      const params=new URLSearchParams({scope,page,q:query});if(selectedDate)params.set('date',selectedDate);
      const data=await request('/api/literature?'+params);if(version!==listVersion)return;
      today=data.today;selectedDate=data.daily.date;$('lit-day').value=selectedDate;$('lit-day').max=today;
      $('lit-history').innerHTML='<option value="">往日推荐</option>'+data.daily.days.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
      $('lit-stats').innerHTML=[['pool','资料记录','已保存的资料记录'],['local','已有全文','文件存在，不等于已读'],['nofulltext','没有全文','只有记录或摘要，尚无全文文件']].map(([key,label,note])=>`<div class="lit-stat"><span>${label}</span><strong>${esc(data.counts[key])}<small>篇</small></strong><p>${note}</p></div>`).join('');
      root.querySelectorAll('[data-lit-count]').forEach(el=>{el.textContent=data.counts[el.dataset.litCount];});
      $('lit-count').textContent=(scope==='daily'?`${selectedDate} · ${data.total} 篇推荐`:`${data.total} 条${query?'匹配记录':''}${scope==='candidates'&&data.latest?' · 批次 '+data.latest:''}`)+` · 第 ${page} / ${Math.max(1,data.pages)} 页`;
      $('lit-source-notice').textContent=scope==='daily'?(data.daily.published?data.daily.note || '篇数随内容变化，不凑数；推荐不代表你已读或喜欢。':data.daily.task_status?`本日推荐任务：${{queued:'待执行',active:'筛选中',failed:'未完成',cancelled:'已停止',done:'任务已结束但未发布'}[data.daily.task_status] || data.daily.task_status}。`:'这一天还没有推荐；后台每日空闲时筛选，页面不会自行调用模型。'):(data.errors.length?`最近一批候选有 ${data.errors.length} 个来源未完整取得；不代表当天全部新文。`:'页面仅展示本地已有记录，不会自动联网补齐。');
      $('lit-fetch-errors').textContent=data.errors.join('\n');$('lit-fetch-details').hidden=scope==='daily'||!data.errors.length;
      $('lit-results').innerHTML=data.items.length?data.items.map(renderRow).join(''):`<div class="lit-empty"><b>${query?'没有找到匹配的文献':scope==='daily'?'这一天暂无推荐。':'这里还没有文献。'}</b><p>${scope==='daily'?(data.daily.published?(query?'试试其他关键词，或清空搜索。':esc(data.daily.note)):'尚未发布这一天的推荐，不用候选池冒充。'):(query?'试试其他关键词，或清空搜索。':'没有匹配的本地记录。这里不会自动联网补齐。')}</p></div>`;
      $('lit-prev').disabled=page<=1;$('lit-next').disabled=page>=data.pages;markSelected();
    } catch(e){if(version===listVersion){$('literature-message').textContent=e.message;$('lit-results').innerHTML='<p class="lit-empty">本地记录读取失败，请点击上方“刷新本地记录”重试。</p>';}}
    finally{if(version===listVersion)$('lit-results').setAttribute('aria-busy','false');}
  }
  async function openPaper(doi) {
    selection=doi;markSelected();const version=++detailVersion;
    $('lit-detail').classList.add('has-paper');$('lit-detail').innerHTML='<p class="muted">正在读取这一篇的本地摘要…</p>';
    try {
      const params=new URLSearchParams({doi});if(scope==='daily')params.set('date',selectedDate);
      const p=await request('/api/literature/paper?'+params);if(version!==detailVersion)return;
      const authors=Array.isArray(p.authors)?p.authors.join(', '):p.authors;
      const assessment=p.recommendation?`<section class="lit-assessment"><h3>推荐解读</h3><p class="lit-evidence-note">${p.recommendation.basis==='abstract'?'推荐基于摘要，尚未核对全文证据。':'推荐记录注明已读全文。'}</p><dl>${[['question','研究问题'],['evidence','现有依据'],['inspiration','可借鉴之处'],['reach','阅读建议']].filter(([k])=>p.recommendation[k]).map(([k,label])=>`<div><dt>${label}</dt><dd>${esc(p.recommendation[k])}</dd></div>`).join('')}</dl></section>`:'';
      $('lit-detail').innerHTML=`<div class="lit-detail-top"><span class="eyebrow">READING DESK / 阅读核对</span><button type="button" id="lit-close" class="secondary small">收起 · 返回列表</button></div><h2 id="lit-paper-title">${esc(p.title)}</h2><p class="lit-byline">${esc([p.source,p.date,authors].filter(Boolean).join(' · '))}</p><p class="lit-doi">DOI ${esc(p.doi)}</p><div class="lit-badges">${badges(p)}</div><section class="lit-access"><h3>回到原文</h3><div class="lit-links">${p.fulltext.open_url?'<a class="primary" target="_blank" rel="noopener" href="'+esc(p.fulltext.open_url)+'">打开本地 PDF ↗</a>':''}<a class="${p.fulltext.open_url?'secondary':'primary'}" target="_blank" rel="noopener" href="${esc(p.publisher_url)}">论文页面 ↗</a>${p.preprint_url?'<a target="_blank" rel="noopener" href="'+esc(p.preprint_url)+'">已核对的预印本 ↗</a>':''}</div><p class="lit-file-note">${esc(p.fulltext.note)}</p></section>${p.pick_reason?'<div class="lit-detail-reason"><b>为什么推荐 / 选读理由</b><p>'+esc(p.pick_reason)+'</p></div>':''}<nav class="lit-detail-nav" aria-label="文献详情段落">${p.recommendation?'<button type="button" data-lit-jump="lit-assessment">推荐解读 ↓</button>':''}<button type="button" data-lit-jump="lit-abstract-section">原始摘要 ↓</button></nav>${assessment}<section class="lit-abstract-section"><h3>原始摘要</h3><p class="lit-provenance">${p.abstract?'来源：'+esc(p.abstract_from)+(p.abstract_version==='preprint'?' · 预印本版本，不等同最终期刊版':''):'暂缺'}</p><p class="lit-abstract">${esc(p.abstract||'尚缺摘要，不以题名代替。需要时由助手只为这一篇补取。')}</p></section>`;
      if(matchMedia('(max-width:900px)').matches){$('lit-detail').scrollIntoView({block:'start',behavior:'instant'});$('lit-detail').focus({preventScroll:true});}
    }catch(e){if(version===detailVersion)$('lit-detail').innerHTML='<button type="button" id="lit-close" class="secondary small">返回列表</button><p class="lit-message">'+esc(e.message)+'</p>';}
  }
  root.addEventListener('click',e=>{
    const row=e.target.closest('[data-lit-doi]');if(row){void openPaper(row.dataset.litDoi);return;}
    const tab=e.target.closest('[data-lit-scope]');if(tab){scope=tab.dataset.litScope;page=1;resetDetail();root.querySelectorAll('[data-lit-scope]').forEach(b=>{const on=b===tab;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});void loadList();}
    if(e.target.closest('#lit-reload')){resetDetail();void loadList();}
    if(e.target.closest('#lit-prev')){page--;resetDetail();void loadList();}
    if(e.target.closest('#lit-next')){page++;resetDetail();void loadList();}
    if(e.target.closest('#lit-close'))returnToList();
    const jump=e.target.closest('[data-lit-jump]');if(jump){const target=$('lit-detail').querySelector('.'+jump.dataset.litJump);target?.scrollIntoView({block:'start',behavior:'instant'});target?.setAttribute('tabindex','-1');target?.focus({preventScroll:true});}
  });
  function changeDate(date){selectedDate=date;page=1;resetDetail();void loadList();}
  $('lit-day').addEventListener('change',()=>{if($('lit-day').value)changeDate($('lit-day').value);});
  $('lit-today').addEventListener('click',()=>changeDate(today));
  $('lit-history').addEventListener('change',()=>{if($('lit-history').value)changeDate($('lit-history').value);});
  $('lit-search-form').addEventListener('submit',e=>{e.preventDefault();query=$('lit-search').value.trim();page=1;resetDetail();void loadList();});
  resetDetail();
  return {activate(){if(!started){started=true;void loadList();}}};
}
