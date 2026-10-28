import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, read, write } from '../automation/files.mjs';
import { literatureList, literaturePaper } from './view.mjs';
import { createServer } from '../dashboard/server.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';
import { localDay, saveRecommendations, recommendationDir } from './recommendations.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs --literature in a sanitized copy');
const dir=path.join(root,'.runtime/literature'),pdf=path.join(root,'literature/fulltext/fixture-view.pdf'),blocked=path.join(dir,'blocked.pdf');
async function fixture(fn) {
  const files=['literature/catalog.json','.runtime/literature/intake.json','.runtime/literature/candidates-2026-10-17.json'];
  const before=Object.fromEntries(files.map(f=>[f,fs.existsSync(path.join(root,f))?fs.readFileSync(path.join(root,f)):null]));
  const today=localDay(),past='2020-01-01',days=[today,past];
  const dayBefore=Object.fromEntries(days.map(d=>{const f=path.join(recommendationDir,d+'.json');return[f,fs.existsSync(f)?fs.readFileSync(f):null];}));
  const candidates=Array.from({length:23},(_,i)=>({doi:'10.5555/fixture-'+i,title:i===0?'Fixture <img src=x onerror=alert(1)> noise measurement':'Fixture paper '+i,source:'Fixture Journal',date:'2026-10-17',authors:'Example',
    abstract:i===1?'':'HIDDEN_ABSTRACT_'+i+' '+('Fictional complete abstract. '.repeat(90)),abstract_from:'fixture'}));
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(pdf),{recursive:true});
  fs.writeFileSync(pdf,'%PDF-1.4\nFictional read-only file boundary fixture.\n%%EOF');fs.writeFileSync(blocked,'%PDF-1.4\nnot public\n%%EOF');
  write('literature/catalog.json',{version:1,papers:[{...candidates[0],fulltext_path:pdf,pick_reason:'Fictional reading reason.'},{doi:'10.5555/internal',title:'Internal PDF record',fulltext_path:blocked}]});
  fs.writeFileSync(path.join(dir,'intake.json'),JSON.stringify(Object.fromEntries(candidates.map(p=>[p.doi,p]))));
  fs.writeFileSync(path.join(dir,'candidates-2026-10-17.json'),JSON.stringify({candidates,errors:['Fixture source: HTTP 429']}));
  saveRecommendations({date:today,items:[0,2,3].map(i=>({doi:candidates[i].doi,reason:'Fictional daily reason '+i,basis:'abstract',question:'Fictional scientific question.',evidence:'Abstract only, not full-text verification.'})),note:'篇数随内容变化，不凑数。',replace:true});
  saveRecommendations({date:past,items:[],note:'这一天没有合适的推荐。',replace:true});
  try{return await fn(candidates);}finally{
    for(const [f,bytes]of Object.entries(before)){const target=path.join(root,f);if(bytes)fs.writeFileSync(target,bytes);else fs.rmSync(target,{force:true});}
    fs.rmSync(pdf,{force:true});fs.rmSync(blocked,{force:true});
    for(const[f,b]of Object.entries(dayBefore))if(b)fs.writeFileSync(f,b);else fs.rmSync(f,{force:true});
  }
}
async function serverFor(fn) {
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{return await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}
}
test('missing candidate file is an empty shortlist, not an empty library',()=>fixture(async()=>{
  fs.rmSync(path.join(dir,'candidates-2026-10-17.json'));
  const result=literatureList();
  assert.equal(result.latest,null);assert.equal(result.total,0);assert.deepEqual(result.errors,[]);
  assert.equal(result.counts.pool,24);assert.equal(literatureList({scope:'pool'}).total,24);
  assert.ok(literaturePaper('10.5555/fixture-0').abstract.includes('HIDDEN_ABSTRACT_0'));
}));
test('title index is paged, searchable and never includes abstracts, file paths or fake recommendation status',()=>fixture(async()=>{
  const first=literatureList(),second=literatureList({page:2});
  assert.equal(first.items.length,20);assert.equal(second.items.length,3);assert.equal(first.total,23);assert.equal(first.latest,'2026-10-17');
  assert.equal(first.pages,2);assert.equal(first.counts.pool,24);assert.equal(first.counts.local,2);
  assert.ok(!JSON.stringify(first).includes('HIDDEN_ABSTRACT_'));assert.ok(!JSON.stringify(first).includes('fixture-view.pdf'));
  assert.equal(first.items[1].has_abstract,false);assert.equal(first.items[0].has_fulltext,true);
  assert.equal(literatureList({q:'fixture-22'}).total,1);assert.equal(literatureList({scope:'local'}).total,2);
  assert.equal(first.counts.nofulltext,22);assert.equal(literatureList({scope:'nofull'}).total,22);assert.ok(literatureList({scope:'nofull'}).items.every(p=>!p.has_fulltext));
  assert.throws(()=>literatureList({scope:'../secret'}));assert.throws(()=>literatureList({page:0}));assert.throws(()=>literatureList({limit:51}));
}));
test('publication-deferred records stay hidden across intake, candidates, daily, local, detail, CLI and HTTP without deleting PDFs',()=>fixture(async()=>{
  const catalog=read('literature/catalog.json');catalog.papers[0].library_status='deferred-publication';
  // Published papers may legitimately use an arXiv author manuscript.
  catalog.papers[1].source='Fixture Journal';catalog.papers[1].preprint_url='https://arxiv.org/abs/2601.12345';
  write('literature/catalog.json',catalog);
  for(const scope of ['pool','candidates','daily','local','nofull'])assert.ok(!literatureList({scope}).items.some(p=>p.doi==='10.5555/fixture-0'),scope);
  const counts=literatureList().counts;assert.equal(counts.deferred,1);assert.equal(counts.registered,1);assert.equal(counts.pool,23);assert.equal(counts.local,1);assert.equal(counts.daily,2);
  assert.equal(literaturePaper('10.5555/fixture-0'),null);assert.ok(literaturePaper('10.5555/internal'));assert.ok(fs.existsSync(pdf));
  const result=spawnSync(process.execPath,['automation/run.mjs','literature','list'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const list=JSON.parse(result.stdout);assert.equal(list.papers.length,1);assert.equal(list.deferred_count,1);
  await serverFor(async base=>{assert.equal((await fetch(base+'/api/literature/paper?doi=10.5555/fixture-0')).status,404);const body=await(await fetch(base+'/api/literature?scope=local')).json();assert.equal(body.total,1);});
  catalog.papers[0].library_status='active';write('literature/catalog.json',catalog);assert.ok(literaturePaper('10.5555/fixture-0'));assert.equal(literatureList().counts.local,2);
}));

test('paper detail preserves complete abstract and reason; internal files and arbitrary URL schemes are never linked',()=>fixture(async()=>{
  const p=literaturePaper('https://doi.org/10.5555/FIXTURE-0');
  assert.ok(p.abstract.length>1500);assert.equal(p.pick_reason,'Fictional reading reason.');assert.match(p.fulltext.open_url,/api\/local-file/);
  assert.equal(literaturePaper('10.5555/internal').fulltext.open_url,null);assert.equal(literaturePaper('../../secret'),null);
  const file=path.join(dir,'intake.json'),intake=JSON.parse(fs.readFileSync(file));intake['10.5555/fixture-2'].preprint_url='javascript:alert(1)';fs.writeFileSync(file,JSON.stringify(intake));
  assert.equal(literaturePaper('10.5555/fixture-2').preprint_url,null);
}));
test('CLI browse and show follow the same local-only disclosure boundary',()=>fixture(async()=>{
  const call=args=>{const r=spawnSync(process.execPath,['automation/run.mjs','literature',...args],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const a=call(['browse','candidates','2']);assert.equal(a.items.length,3);assert.ok(!JSON.stringify(a).includes('HIDDEN_ABSTRACT_'));
  const b=call(['show','10.5555/fixture-0']);assert.ok(b.abstract.includes('HIDDEN_ABSTRACT_0'));
}));
test('HTTP lists disclose no abstract, details disclose one paper, and PDF uses existing safe file transport',()=>fixture(async()=>serverFor(async base=>{
  const before=fs.readFileSync(path.join(dir,'intake.json'));
  let r=await fetch(base+'/api/literature');const a=await r.json();assert.equal(r.status,200);assert.equal(a.items.length,20);assert.ok(!JSON.stringify(a).includes('HIDDEN_ABSTRACT_'));
  r=await fetch(base+'/api/literature/paper?doi=10.5555/fixture-0');const p=await r.json();assert.ok(p.abstract.includes('HIDDEN_ABSTRACT_0'));assert.ok(!p.abstract.includes('HIDDEN_ABSTRACT_1'));
  r=await fetch(base+p.fulltext.open_url);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/application\/pdf/);assert.equal(await r.text(),fs.readFileSync(pdf,'utf8'));
  assert.equal((await fetch(base+'/api/literature/paper?doi=../secret')).status,404);assert.equal((await fetch(base+'/api/literature?scope=bad')).status,400);
  assert.equal((await fetch(base+'/api/state?page=literature')).status,200);assert.deepEqual(fs.readFileSync(path.join(dir,'intake.json')),before);
}))); 
test('sidebar page lazily opens one abstract, supports paging/search/local PDF and preserves chat drafts; desktop/mobile QA', {timeout:60000},()=>fixture(async()=>serverFor(async base=>{
  let browser;const errors=[],requests=[];
  try {
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/literature'))requests.push(r.url());});
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));await page.route('**/api/companion/notes',r=>r.fulfill({json:{enabled:false,messages:[]}}));
    await page.goto(base+'/#literature');await page.locator('.lit-row').first().waitFor();
    const qa=path.join(root,'.runtime/test-artifacts');fs.mkdirSync(qa,{recursive:true});
    assert.equal(await page.locator('.lit-stat').count(),3);
    assert.equal((await page.locator('[data-lit-count="pool"]').textContent()).trim(),'24');
    assert.equal(await page.locator('.lit-detail-empty').isVisible(),true);
    assert.equal((await page.locator('#lit-section-title').textContent()).trim(),'每日推荐');
    await page.screenshot({path:path.join(qa,'literature-overview.png')});
    assert.equal(await page.locator('.nav[data-page="projects"]').getAttribute('class'),'nav active');
    assert.equal((await page.locator('.nav[data-page="projects"]').textContent()).trim(),'资料库');
    assert.equal(await page.locator('.nav[data-page="literature"]').count(),0);
    assert.equal(await page.locator('#library-tabs').isVisible(),true);
    assert.equal(await page.locator('#library-tabs [data-page="literature"]').getAttribute('aria-current'),'page');
    await page.locator('#library-tabs [data-page="projects"]').click();await page.locator('#page-projects').waitFor();
    assert.equal(await page.locator('#library-tabs [data-page="projects"]').getAttribute('aria-current'),'page');
    assert.equal(await page.locator('#library-tabs [data-page="literature"]').getAttribute('aria-current'),null);
    assert.equal(await page.evaluate(()=>location.hash),'#projects');
    // Project overview now uses an action-only heading; the shared library tabs
    // remain the navigation anchor at desktop, tablet and phone widths.
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.locator('#project-search').isVisible(),true);
      assert.equal(await page.locator('#project-overview h1').count(),0);
      assert.equal(await page.locator('#library-tabs').isVisible(),true);
      await page.locator('#library-tabs [data-page="literature"]').click();
      await page.locator('#page-literature').waitFor();
      assert.equal(await page.locator('#library-tabs').isVisible(),true);
      assert.equal(await page.locator('#library-tabs [data-page="literature"]').getAttribute('aria-current'),'page');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`library fits at ${width}px`);
      await page.screenshot({path:path.join(qa,`literature-title-${width}.png`)});
      await page.locator('#library-tabs [data-page="projects"]').click();
      await page.locator('#page-projects').waitFor();
      await page.screenshot({path:path.join(qa,`projects-title-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:1000});
    const project=page.locator('#project-grid [data-project-open]').first();
    await project.click();await page.locator('#project-detail').waitFor();
    assert.equal(await page.locator('#library-tabs').isVisible(),true);
    assert.match(await page.evaluate(()=>location.hash),/^#projects\//);
    await page.screenshot({path:path.join(root,'.runtime/library-project-detail.png')});
    await page.locator('#library-tabs [data-page="literature"]').click();await page.locator('#page-literature').waitFor();
    assert.equal(await page.evaluate(()=>location.hash),'#literature');
    assert.equal(await page.locator('[data-lit-scope="daily"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.lit-row').count(),3);assert.equal(requests.filter(u=>u.includes('/paper?')).length,0);
    assert.ok((await page.locator('#lit-results').textContent()).includes('Fictional daily reason'));
    assert.ok((await page.locator('.lit-row').first().textContent()).includes('为什么推荐'));
    assert.ok((await page.locator('.lit-row').first().textContent()).includes('全文已获取'));
    assert.ok((await page.locator('.lit-row').first().textContent()).includes('推荐依据：摘要'));
    assert.ok((await page.locator('.lit-row').nth(1).textContent()).includes('仅摘要'));
    assert.ok(!(await page.locator('#page-literature').textContent()).includes('HIDDEN_ABSTRACT_'));
    await page.locator('.lit-row').first().click();await page.locator('.lit-abstract').filter({hasText:'HIDDEN_ABSTRACT_0'}).waitFor();
    assert.equal(requests.filter(u=>u.includes('/paper?')).length,1);assert.equal(await page.locator('#lit-results img').count(),0);
    assert.equal(await page.locator('#lit-detail a').filter({hasText:'打开本地 PDF'}).count(),1);
    assert.ok((await page.locator('.lit-evidence-note').textContent()).includes('尚未核对全文'));
    assert.equal(await page.locator('.lit-assessment').isVisible(),true);
    assert.ok((await page.locator('.lit-access').textContent()).includes('打开本地 PDF'));
    await page.screenshot({path:path.join(qa,'literature-desktop.png')});
    await page.locator('[data-lit-jump="lit-abstract-section"]').click();
    assert.equal(await page.locator('.lit-abstract-section').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('.lit-abstract').isVisible(),true);
    await page.locator('#lit-close').click();
    assert.equal(await page.locator('.lit-row').first().evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#lit-detail.has-paper').count(),0);
    const n=requests.length;await page.waitForTimeout(5200);assert.equal(requests.length,n,'shared state polling must not re-fetch literature');
    await page.locator('#lit-history').selectOption('2020-01-01');
    await page.locator('#lit-results').filter({hasText:'没有合适'}).waitFor(); // Loading also clears the rows; wait for the completed empty result.
    assert.equal(await page.locator('.lit-row').count(),0);
    assert.ok((await page.locator('#lit-results').textContent()).includes('没有合适'));assert.ok(!(await page.locator('#lit-detail').textContent()).includes('HIDDEN_ABSTRACT_0'));
    await page.locator('#lit-today').click();await page.waitForFunction(()=>document.querySelectorAll('.lit-row').length===3);
    await page.locator('[data-lit-scope="candidates"]').click();await page.waitForFunction(()=>document.querySelectorAll('.lit-row').length===20);
    assert.equal((await page.locator('#lit-section-title').textContent()).trim(),'最近候选');
    assert.equal(await page.locator('#lit-date-controls').isVisible(),false);
    assert.ok((await page.locator('[data-lit-doi="10.5555/fixture-1"]').textContent()).includes('待补摘要与全文'));
    await page.locator('#lit-fetch-details summary').click();
    assert.ok((await page.locator('#lit-fetch-errors').textContent()).includes('HTTP 429'));
    await page.locator('#lit-next').click();await page.waitForFunction(()=>document.querySelectorAll('.lit-row').length===3);
    await page.locator('#lit-search').fill('fixture-1');await page.locator('#lit-search-form button').click();await page.waitForFunction(()=>document.querySelectorAll('.lit-row').length===11);
    await page.locator('[data-lit-scope="local"]').click();await page.waitForFunction(()=>document.querySelector('#lit-count').textContent.includes('0 条'));
    await page.locator('#lit-search').fill('');await page.locator('#lit-search-form button').click();await page.waitForFunction(()=>document.querySelectorAll('.lit-row').length===2);
    for(const width of [1024,768,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(qa,'literature-mobile-cards.png')});
    await page.locator('[data-lit-doi="10.5555/fixture-0"]').click();await page.locator('#lit-paper-title').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(qa,'literature-mobile.png')});
    assert.equal(await page.locator('#lit-detail').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#lit-detail').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.sidebar').getBoundingClientRect().bottom),true,'reading header and close button must clear the sticky mobile office navigation');
    await page.locator('#lit-close').click();
    assert.equal(await page.locator('[data-lit-doi="10.5555/fixture-0"]').evaluate(el=>el===document.activeElement),true);
    await page.locator('.lit-storage summary').click();
    assert.equal(await page.locator('.lit-pipeline>div').count(),4);
    assert.ok((await page.locator('.lit-storage').textContent()).includes('不是入库任务队列'));
    await page.reload();await page.locator('.lit-row').first().waitFor();assert.equal(await page.locator('#page-literature').isVisible(),true);
    await page.locator('.nav[data-page="chat"]').click();await page.locator('#message').fill('UNSENT-LITERATURE-DRAFT');
    assert.equal(await page.locator('#library-tabs').isVisible(),false);
    await page.locator('.nav[data-page="projects"]').click();await page.locator('#library-tabs [data-page="literature"]').click();await page.locator('#page-literature').waitFor();await page.locator('.nav[data-page="chat"]').click();assert.equal(await page.locator('#message').inputValue(),'UNSENT-LITERATURE-DRAFT');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();}
}))); 
