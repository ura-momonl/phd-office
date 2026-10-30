import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetch_paper, selectPDF, validatePDF } from './fetch.mjs';
import { runFetchBatch } from './fetch-batch.mjs';
import { FetchBackoff } from './fetch-backoff.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ensureLibraryAccess, authStatus, resetLoginBlock, createLibraryContext, saveLibrarySession } from './auth.mjs';
import { saveCredential } from '../browser/session.mjs';
import { root, read, write } from '../automation/files.mjs';
import { run as runLiterature } from './run.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use node scripts/run-tests.mjs --literature');
const doi = '10.5555/test-fetch';
const output = path.join(root, 'literature/fulltext', 'doi-' + createHash('sha256').update(doi).digest('hex').slice(0,16) + '.pdf');
const baseline = read('literature/catalog.json');
const baselineFetchConfig = read('literature/config.json');
const authDirectory = path.join(root, '.runtime/browser/uw-library');
const credentialsFile = path.join(root, '.runtime/browser/credentials.local.json');
const originalCredentials = fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile) : null;
beforeEach(() => {
  write('literature/catalog.json', { ...baseline, papers: [] });
  // Old fixtures explicitly exercise the read-only contract; native-operation
  // tests opt in without relying on whether the user's plugin is installed.
  write('literature/config.json', { ...baselineFetchConfig, zotero_native: false });
});
afterEach(() => {
  write('literature/catalog.json', baseline);
  write('literature/config.json', baselineFetchConfig);
  if (fs.existsSync(output)) fs.unlinkSync(output);
  for (const file of ['session.local.json', 'blocked.local.json']) {
    const target = path.join(authDirectory, file); if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  if (originalCredentials) fs.writeFileSync(credentialsFile, originalCredentials);
  else if (fs.existsSync(credentialsFile)) fs.unlinkSync(credentialsFile);
});

// Independent, searchable one-page fixture: no publisher PDF or personal data.
function pdf(text = doi) {
  const content = text.split('\n').map((line,i)=>`BT /F1 12 Tf 72 ${720-i*20} Td (${line}) Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(body + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function fixture(t, { bytes = pdf(), links, login = false, status = 200, resolverStatus = 302, error,
  oaWork = openWork({pdf_url:null,landing_page_url:'https://journals.example.org/article/42'}), oaStatus = 200, pdfStatus = 200, redirect, challenged = false,
  arxivMeta, arxivStatus = 200, retryAfter, quota, quotaStatus = 200,
  hostedStatus = 200, hostedBytes = bytes, storageRedirect, openResponses = {}, zotero } = {}) {
  const article = 'https://journals.example.org/article/42';
  const proxied = 'https://journals-example-org.ezproxy.library.wisc.edu/article/42';
  const open = oaWork.open_access?.is_oa || oaWork.best_oa_location?.is_oa;
  const pageURL = open ? article : proxied;
  let current = login ? 'https://login.wisc.edu/idp/SSO' : pageURL;
  const log = { metadata: 0, openURLs: [], resolved: 0, launched: 0, downloads: 0, closed: 0, saved: 0, zotero: [] };
  const rateHeaders = retryAfter === undefined ? {} : { 'retry-after': retryAfter };
  if (arxivMeta !== undefined) {
    const originalTimeout=globalThis.setTimeout;
    t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
      if(ms===3100){log.arxivWaits=(log.arxivWaits||0)+1;queueMicrotask(()=>fn(...args));return 0;}
      return originalTimeout(fn,ms,...args);
    });
  }
  const snapshot = { url: pageURL, pdfMeta: [], title: 'Fictional article', authors: ['Fictional Author'], year: 2026, challenged,
    links: links ?? [{ href: pageURL+'.pdf', text: 'Download PDF' }] };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    url = String(url);
    const host = new URL(url).hostname;
    if (['127.0.0.1','localhost','[::1]'].includes(host)) {
      log.zotero.push(url);
      assert.equal(options.redirect === 'manual' || options.redirect === 'error',true);
      return zotero ? zotero(new URL(url),options) : Response.json([]);
    }
    if (host === 'api.openalex.org' && new URL(url).pathname === '/rate-limit') {
      log.quota=(log.quota||0)+1;
      assert.equal(options.headers.Authorization, 'Bearer fictional-hosted-key');
      return Response.json({ rate_limit: quota ?? { daily_budget_usd:1, daily_remaining_usd:1, prepaid_balance_usd:0, prepaid_remaining_usd:0, endpoint_costs_usd:{ content:0.01 } } }, {status:quotaStatus});
    }
    if (host === 'content.openalex.org' || host === 'storage.example.org') {
      log.hosted=(log.hosted||0)+1;
      if (host === 'content.openalex.org') assert.equal(options.headers.Authorization, 'Bearer fictional-hosted-key');
      else assert.equal(options.headers.Authorization, undefined);
      const r=new Response(hostedBytes, { status: storageRedirect && host==='content.openalex.org' ? 302 : hostedStatus,
        headers: storageRedirect && host==='content.openalex.org' ? { location:storageRedirect } : {} });
      Object.defineProperty(r,'url',{value:url});return r;
    }
    if (new URL(url).hostname === 'api.openalex.org') { log.metadata++; log.hasKey=new URL(url).searchParams.has('api_key'); return Response.json(oaWork, { status: oaStatus, headers: rateHeaders }); }
    if (new URL(url).hostname === 'export.arxiv.org' && new URL(url).pathname === '/api/query') {
      log.arxivLookups=(log.arxivLookups||0)+1;assert.ok(!new URL(url).searchParams.has('api_key'));
      return new Response(arxivMeta,{status:arxivStatus,headers:rateHeaders});
    }
    if (new URL(url).hostname !== 'doi.org') {
      log.openURLs.push(url); log.downloads++;
      if (error) throw error;
      if (openResponses[url]) {
        const value = openResponses[url];
        const response = new Response(value.bytes ?? bytes, { status: value.status ?? 200, headers: value.headers });
        Object.defineProperty(response, 'url', { value: url }); return response;
      }
      const response = new Response(bytes, { status: redirect ? 302 : pdfStatus, headers: { ...rateHeaders, ...(redirect ? { location: redirect } : {}) } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    log.resolved++; assert.ok(url.startsWith('https://doi.org/'));
    return { status: resolverStatus, headers: new Headers({ location: article }) };
  });
  const page = { url: () => current, goto: async url => { assert.equal(open ? url : new URL(url).searchParams.get('qurl'),article); return { status: () => status, headers: () => rateHeaders }; },
    evaluate: async () => snapshot,
    waitForURL: async (predicate, options) => { assert.equal(options.timeout,480000); current = proxied; assert.equal(predicate(new URL(current)),true); } };
  const context = { newPage: async () => page, route: async (pattern,handler) => { log.routeGuard=handler; },
    storageState: async ({path:file}) => { log.saved++; fs.writeFileSync(file,JSON.stringify({cookies:[],origins:[]})); },
    request: { get: async (url, options) => {
    log.downloads++; assert.equal(options.maxRetries,0); if (error) throw error;
    assert.equal(url,proxied+'.pdf'); return { status: () => 200, ok: () => true, body: async () => bytes, url: () => url };
  } } };
  const launch = async options => { log.launched++; log.headless = options.headless; return { newContext: async options => {log.contextOptions=options;return context;}, close: async () => { log.closed++; } }; };
  return { launch, log };
}

test('generic metadata and hidden anchors work without publisher names; supplements and unsafe links are excluded', () => {
  const base = { url: 'https://journals-example-org.ezproxy.library.wisc.edu/article/42',
    pdfMeta: ['https://journals.example.org/article/42.pdf'],
    links: [{ text: 'Supplementary PDF', href: '/supplement.pdf' }, { text: 'Download PDF', href: '/article/42.pdf' }] };
  assert.equal(selectPDF(base),base.url+'.pdf');
  assert.equal(selectPDF({ url:'https://another.example.net/paper',pdfMeta:[],links:[{text:'View PDF',href:'/content/fulltext'}] }), 'https://another.example.net/content/fulltext');
  assert.equal(selectPDF({ ...base,pdfMeta:[],links:[{text:'PDF',href:'http://127.0.0.1/internal.pdf'}, {text:'Supporting information PDF',href:'/support.pdf'}] }),null);
});

const openWork = (location = {}) => ({ doi: 'https://doi.org/' + doi, title: 'Open fictional article', publication_year: 2026,
  authorships: [{author: {display_name: 'Open Author'}}], open_access: {is_oa: true},
  best_oa_location: {is_oa: true, pdf_url: 'https://repository.example.org/paper.pdf', version: 'publishedVersion', license: 'cc-by', ...location}, locations: [] });

const manuscriptWork = () => ({...openWork({pdf_url:'https://arxiv.org/pdf/1901.12345',version:'submittedVersion'}),
  title:'Renamed journal title',authorships:[{author:{display_name:'Alice Kepler'}},{author:{display_name:'Bruno Maxwell'}}]});
const manuscriptFeed = ({id='1901.12345v2',linkedDOI=doi,title='Original manuscript title',authors=['Alice Kepler','Bruno Maxwell'],pdfID=id}={}) =>
  `<feed><entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title>${linkedDOI?`<arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">${linkedDOI}</arxiv:doi>`:''}
  ${authors.map(name=>`<author><name>${name}</name></author>`).join('')}<link href="https://arxiv.org/pdf/${pdfID}" type="application/pdf"/></entry></feed>`;
const manuscriptPDF = (id='1901.12345v2',title='Original manuscript title',authors='Alice Kepler and Bruno Maxwell') =>
  pdf(`arXiv:${id}\n${title}\n${authors}`);

const hostedWork = () => ({ ...openWork(), best_oa_location:null, open_access:{is_oa:false}, id:'https://openalex.org/W123', has_content:{pdf:true}, content_urls:{pdf:'https://content.openalex.org/works/W123.pdf'} });
function hostedFixture(t, options={}) {
  const old=process.env.OPENALEX_API_KEY;process.env.OPENALEX_API_KEY='fictional-hosted-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENALEX_API_KEY;else process.env.OPENALEX_API_KEY=old;});
  return fixture(t,{oaWork:hostedWork(),...options});
}
test('hosted OpenAlex PDF fills absent open locations, is validated without leaking signed URL or key; cache stays local',async t=>{
  const {launch,log}=hostedFixture(t,{storageRedirect:'https://storage.example.org/paper.pdf?signature=PRIVATE'});
  const r=await fetch_paper(doi,{launch}); assert.equal(r.status,'available',r.message);assert.equal(r.access_route,'openalex-hosted');
  const p=read('literature/catalog.json').papers[0];assert.equal(p.fulltext_source,'https://content.openalex.org/works/W123.pdf');
  assert.equal(p.fulltext_version,null);assert.equal(p.fulltext_license,null);assert.equal(log.quota,1);assert.equal(log.hosted,2);
  assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.ok(!JSON.stringify({r,p}).match(/PRIVATE|fictional-hosted-key/));
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.metadata,1);assert.equal(log.hosted,2);
});

for(const [label,quota] of [
  ['exhausted free quota',{daily_budget_usd:1,daily_remaining_usd:0,prepaid_balance_usd:0,prepaid_remaining_usd:0,endpoint_costs_usd:{content:0.01}}],
  ['funded prepaid balance',{daily_budget_usd:1,daily_remaining_usd:1,prepaid_balance_usd:5,prepaid_remaining_usd:5,endpoint_costs_usd:{content:0.01}}],
  ['unknown price',{daily_budget_usd:1,daily_remaining_usd:1,prepaid_balance_usd:0,prepaid_remaining_usd:0}],
  ['unknown account budget',{daily_budget_usd:null,daily_remaining_usd:1,prepaid_balance_usd:0,prepaid_remaining_usd:0,endpoint_costs_usd:{content:0.01}}],
  ['paid daily budget',{daily_budget_usd:10,daily_remaining_usd:10,prepaid_balance_usd:0,prepaid_remaining_usd:0,endpoint_costs_usd:{content:0.01}}]
]) test(label+' never spends content credit after a missing original PDF',async t=>{
  const {launch,log}=hostedFixture(t,{quota,oaWork:{...hostedWork(),...openWork()},pdfStatus:404});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'not_found',r.message);assert.equal(r.search_suggested,true);
  assert.equal(log.hosted,undefined);assert.equal(log.downloads,1);assert.equal(log.launched,0);
  assert.deepEqual(r.provider_notes,[{provider:'openalex',status:'free_budget_unavailable'}]);
});

const funded={daily_budget_usd:1,daily_remaining_usd:0,prepaid_balance_usd:1,prepaid_remaining_usd:1,endpoint_costs_usd:{content:0.01}};
test('hosted-only with spend-prepaid uses only the hosted copy, never the original site or campus',async t=>{
  const {launch,log}=hostedFixture(t,{quota:funded,oaWork:{...hostedWork(),...openWork()}});
  const r=await fetch_paper(doi,{launch,hostedOnly:true,spendPrepaid:true});assert.equal(r.status,'available',r.message);assert.equal(r.access_route,'openalex-hosted');
  assert.equal(log.hosted,1);assert.equal(log.downloads,0);assert.deepEqual(log.openURLs,[]);assert.equal(log.launched,0);
});
for(const [label,text,ok] of [
  ['title and article locator',`Open fictional article\nSci Rep 2026 6 efetch`,true],
  ['title without locator',`Open fictional article\nSci Rep 2026`,false],
  ['locator without title',`Another unrelated paper entirely\nSci Rep 2026 6 efetch`,false]
]) test('hosted copy without printed DOI is accepted only on '+(ok?'':'NOT ')+label,async t=>{
  const {launch,log}=hostedFixture(t,{hostedBytes:pdf(text)});
  const r=await fetch_paper(doi,{launch,hostedOnly:true});
  if(!ok){assert.equal(r.status,'validation_failed');assert.equal(read('literature/catalog.json').papers.length,0);return;}
  assert.equal(r.status,'available',r.message);
  const p=read('literature/catalog.json').papers[0];assert.equal(p.fulltext_identity.kind,'hosted-title-locator');assert.equal(p.fulltext_identity.locator,'fetch');
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.hosted,1);
});
test('hosted-only without spend-prepaid refuses a funded account and tries no other route',async t=>{
  const {launch,log}=hostedFixture(t,{quota:funded,oaWork:{...hostedWork(),...openWork()}});
  const r=await fetch_paper(doi,{launch,hostedOnly:true});assert.equal(r.status,'needs_attention');
  assert.equal(log.hosted,undefined);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.deepEqual(r.provider_notes,[{provider:'openalex',status:'free_budget_unavailable'}]);
});

test('legacy Symbol Greek title text matches Unicode metadata without collapsing different letters',t=>{
  // Natural incident: PMC6954054 extracts Symbol beta as F062. Keep the
  // synthetic PDF private-data-free; the real downloaded PDF is checked separately.
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,pdf('Synthetic text stream'));
  let text;
  const mocked=t.mock.method(childProcess,'spawnSync',()=>({status:0,stdout:text,stderr:''}));syncBuiltinESMExports();
  t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  for(const [pua,greek] of [['\uf061','α'],['\uf062','β'],['\uf067','γ'],['\uf044','Δ']]){
    const title=`Quantum ${greek} relaxation under controlled strain`;
    text=`Quantum ${pua} relaxation under controlled strain\nJournal 2026 efetch`;
    const checked=validatePDF(output,doi,undefined,undefined,title);
    assert.equal(checked.identity.kind,'hosted-title-locator');
    assert.equal(checked.identity.title,title);
    assert.equal(validatePDF(output,doi,checked.sha256,checked.identity).sha256,checked.sha256);
  }
  text='Quantum \uf062 relaxation under controlled strain\nJournal 2026 efetch';
  assert.throws(()=>validatePDF(output,doi,undefined,undefined,'Quantum α relaxation under controlled strain'),/Requested DOI/);
  assert.throws(()=>validatePDF(output,doi,undefined,undefined,'Unrelated β relaxation in a different material'),/Requested DOI/);
  text='Quantum \uf062 relaxation under controlled strain\nJournal 2026 eother';
  assert.throws(()=>validatePDF(output,doi,undefined,undefined,'Quantum β relaxation under controlled strain'),/Requested DOI/);
  text='Quantum b relaxation under controlled strain\nJournal 2026 efetch';
  assert.throws(()=>validatePDF(output,doi,undefined,undefined,'Quantum β relaxation under controlled strain'),/Requested DOI/);
});
test('spend-prepaid still refuses when free and prepaid room together are below one download',async t=>{
  const {launch,log}=hostedFixture(t,{quota:{...funded,prepaid_remaining_usd:0.005},oaWork:hostedWork()});
  const r=await fetch_paper(doi,{launch,hostedOnly:true,spendPrepaid:true});assert.equal(r.status,'needs_attention');assert.equal(log.hosted,undefined);
});

test('missing original plus hosted 429 is not retried or sent to campus',async t=>{
  const {launch,log}=hostedFixture(t,{hostedStatus:429,oaWork:{...hostedWork(),...openWork()},pdfStatus:404});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'not_found',r.message);assert.equal(r.search_suggested,true);
  assert.equal(log.hosted,1);assert.equal(log.downloads,1);assert.equal(log.launched,0);
  assert.deepEqual(r.provider_notes,[{provider:'openalex',status:'http_429'}]);
});

test('quota lookup failure does not download metered content',async t=>{
  const {launch,log}=hostedFixture(t,{quotaStatus:403,oaWork:{...hostedWork(),...openWork()},pdfStatus:404});
  assert.equal((await fetch_paper(doi,{launch})).status,'not_found');assert.equal(log.hosted,undefined);
});

for (const [label,bytes,status] of [['wrong DOI',pdf('10.5555/wrong'),'validation_failed'],['web page',Buffer.from('<html>captcha</html>'),'needs_attention']])
test('hosted '+label+' stops at shared validator, without saving or switching source',async t=>{
  const {launch,log}=hostedFixture(t,{hostedBytes:bytes});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,status);assert.equal(fs.existsSync(output),false);
  assert.equal(read('literature/catalog.json').papers.length,0);assert.equal(log.downloads,0);
});

test('an available original PDF preserves hosted credit even when a hosted copy exists',async t=>{
  const {launch,log}=hostedFixture(t,{oaWork:{...hostedWork(),...openWork()}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'open-access');
  assert.equal(log.quota,undefined);assert.equal(log.hosted,undefined);assert.equal(log.downloads,1);
});

for(const status of [404,410]) test('missing original HTTP '+status+' advances to a distinct mirror, deduplicating locations',async t=>{
  const work={...hostedWork(),...openWork()};
  work.locations=[{...work.best_oa_location,pdf_url:work.best_oa_location.pdf_url+'#fragment'},
    {...work.best_oa_location,pdf_url:'https://mirror.example.org/paper.pdf',version:'acceptedVersion',license:'cc-by-nc'}];
  const {launch,log}=hostedFixture(t,{oaWork:work,openResponses:{'https://repository.example.org/paper.pdf':{status}}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'available',r.message);assert.equal(r.access_route,'open-access');
  assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf','https://mirror.example.org/paper.pdf']);
  assert.equal(log.quota,undefined);assert.equal(log.launched,0);
  const p=read('literature/catalog.json').papers[0];assert.equal(p.fulltext_version,'acceptedVersion');assert.equal(p.fulltext_license,'cc-by-nc');
});

test('a missing original can use the hosted supplement, retaining unknown hosted version/license',async t=>{
  const {launch,log}=hostedFixture(t,{oaWork:{...hostedWork(),...openWork()},pdfStatus:404});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'openalex-hosted');
  assert.equal(log.downloads,1);assert.equal(log.hosted,1);assert.equal(log.launched,0);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_version,null);
});

test('an anonymous page without a PDF link advances to hosted content without using UW',async t=>{
  const work=openWork({pdf_url:null,landing_page_url:'https://journals.example.org/article/42'});
  // Equal scores keep the first page first; neither location advertises a direct PDF.
  work.locations=[{is_oa:true,pdf_url:null,landing_page_url:'https://journals.example.org/article/42#same'}];
  const {launch,log}=hostedFixture(t,{oaWork:{...hostedWork(),...work},links:[]});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'openalex-hosted');
  assert.equal(log.launched,1);assert.equal(log.saved,0);assert.equal(log.resolved,0);assert.equal(log.downloads,0);
});

test('duplicate redirect targets are not retried across independent candidate URLs',async t=>{
  const work=openWork();
  work.locations=[{...work.best_oa_location,pdf_url:'https://mirror.example.org/paper.pdf'}];
  const {launch,log}=fixture(t,{oaWork:work,openResponses:{
    'https://repository.example.org/paper.pdf':{status:404},
    'https://mirror.example.org/paper.pdf':{status:302,headers:{location:'https://repository.example.org/paper.pdf'}}
  }});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'not_found');assert.equal(r.search_suggested,true);
  assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf','https://mirror.example.org/paper.pdf']);assert.equal(log.launched,0);
});

for(const [label,options] of [
  ['refusal',{pdfStatus:403},'access_denied'],['rate limit',{pdfStatus:429},'rate_limited'],
  ['challenge',{bytes:Buffer.from('<html>captcha</html>')},'needs_attention']
]) test(label+' stops original and mirrors but retains independently hosted public content',async t=>{
  const work={...hostedWork(),...openWork()};work.locations=[{...work.best_oa_location,pdf_url:'https://mirror.example.org/paper.pdf'}];
  const {launch,log}=hostedFixture(t,{oaWork:work,...options,hostedBytes:pdf()});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'available',r.message);assert.equal(r.access_route,'openalex-hosted');
  assert.equal(log.downloads,1);assert.equal(log.hosted,1);assert.equal(log.launched,0);
});

test('a refused original with no hosted budget keeps its refusal and never suggests mirror search or UW',async t=>{
  const work={...hostedWork(),...openWork()};work.locations=[{...work.best_oa_location,pdf_url:'https://mirror.example.org/paper.pdf'}];
  const {launch,log}=hostedFixture(t,{oaWork:work,pdfStatus:403,quota:{daily_budget_usd:1,daily_remaining_usd:0,prepaid_balance_usd:0,prepaid_remaining_usd:0,endpoint_costs_usd:{content:0.01}}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'access_denied');assert.notEqual(r.search_suggested,true);
  assert.equal(log.downloads,1);assert.equal(log.hosted,undefined);assert.equal(log.launched,0);
});

test('wrong-article identity never advances to a mirror, hosted PDF, UW or suggested search',async t=>{
  const work={...hostedWork(),...openWork()};work.locations=[{...work.best_oa_location,pdf_url:'https://mirror.example.org/paper.pdf'}];
  const {launch,log}=hostedFixture(t,{oaWork:work,bytes:pdf('10.5555/another')});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');assert.notEqual(r.search_suggested,true);
  assert.equal(log.downloads,1);assert.equal(log.quota,undefined);assert.equal(log.launched,0);
});

test('an observed open PDF source uses the shared validator without OpenAlex or UW and retains registered metadata',async t=>{
  write('literature/catalog.json',{...baseline,papers:[{id:'doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16),doi,title:'Registered title',authors:['Alice Kepler','Bruno Maxwell'],year:2020}]});
  const {launch,log}=fixture(t);
  const r=await fetch_paper(doi,{launch,source:'https://author.example.org/observed.pdf'});
  assert.equal(r.status,'available',r.message);assert.equal(r.access_route,'open-access');
  assert.equal(log.metadata,0);assert.equal(log.launched,0);assert.equal(log.quota,undefined);
  const p=read('literature/catalog.json').papers[0];assert.equal(p.title,'Registered title');assert.equal(p.fulltext_version,null);
  assert.equal(p.fulltext_source,'https://author.example.org/observed.pdf');
  assert.equal((await fetch_paper(doi,{launch,source:'https://author.example.org/observed.pdf'})).reused,true);
  assert.equal(log.downloads,1);
});

test('an explicit source requires registered DOI metadata and never guesses a campus route',async t=>{
  const {launch,log}=fixture(t);
  const r=await fetch_paper(doi,{launch,source:'https://author.example.org/observed.pdf'});
  assert.equal(r.status,'needs_attention');assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);
});

test('an observed OA landing page resolves its main PDF with the shared validator, without Zotero, metadata lookup or hosted spending',async t=>{
  write('literature/catalog.json',{...baseline,papers:[{id:'doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16),doi,title:'Fictional article',authors:['Fictional Author'],year:2026}]});
  const {launch,log}=fixture(t);
  const r=await fetch_paper(doi,{launch,source:'https://journals.example.org/article/42',sourceType:'page'});
  assert.equal(r.status,'available',r.message);assert.equal(log.metadata,0);assert.equal(log.quota,undefined);
  assert.equal(log.zotero.length,0);assert.equal(log.resolved,0);assert.equal(log.launched,1);assert.equal(log.headless,true);
  assert.equal(log.downloads,1);assert.equal(read('literature/catalog.json').papers[0].fulltext_sha256,r.sha256);
});

test('a refused explicit OA landing page does not fetch a PDF, change source or use hosted credit',async t=>{
  write('literature/catalog.json',{...baseline,papers:[{id:'doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16),doi,title:'Fictional article'}]});
  const {launch,log}=fixture(t,{status:403});
  const r=await fetch_paper(doi,{launch,source:'https://journals.example.org/article/42',sourceType:'page'});
  assert.equal(r.status,'access_denied');assert.equal(log.downloads,0);assert.equal(log.metadata,0);assert.equal(log.quota,undefined);
  assert.equal(log.launched,1);assert.equal(log.closed,1);assert.equal(log.zotero.length,0);
});

for(const source of ['http://author.example.org/p.pdf','https://127.0.0.1/p.pdf','https://content.openalex.org/works/W123.pdf','https://ezproxy.library.wisc.edu/login','https://user:secret@author.example.org/p.pdf'])
test('an explicit source rejects unsafe or authenticated URLs before any network request',async t=>{
  const {launch,log}=fixture(t);const r=await fetch_paper(doi,{launch,source});assert.equal(r.status,'failed');
  assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);assert.ok(!JSON.stringify(r).includes('secret'));
});

test('CLI source flags are exclusive, nonempty, and require a DOI',async()=>{
  const argv=process.argv;
  try {
    for(const flags of [['--source='],['--source=https://example.org/a.pdf','--login'],['--source=https://example.org/a.pdf','--source=https://example.org/b.pdf'],['--unknown']]) {
      process.argv=[...argv.slice(0,2),'literature','fetch',doi,...flags];
      await assert.rejects(runLiterature('fetch',doi),/fetch <doi>/);
    }
    process.argv=[...argv.slice(0,2),'literature','fetch','1901.12345','--source=https://example.org/a.pdf'];
    await assert.rejects(runLiterature('fetch','1901.12345'),/registered journal DOI/);
  } finally {process.argv=argv;}
});

test('CLI Zotero-only mode forwards the restriction and rejects conflicting routes before networking',async t=>{
  const argv=process.argv,exitCode=process.exitCode;
  const {log}=fixture(t,{oaWork:hostedWork()});let printed;
  t.mock.method(console,'log',value=>{printed=JSON.parse(value);});
  try {
    process.argv=[...argv.slice(0,2),'literature','fetch',doi,'--zotero-only'];
    await runLiterature('fetch',doi);
    assert.equal(printed.status,'needs_attention');assert.equal(printed.zotero_status,'missing');
    assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.quota,undefined);assert.equal(log.launched,0);
    for(const flag of ['--source=https://example.org/p.pdf','--hosted-only','--spend-prepaid','--login']) {
      process.argv=[...argv.slice(0,2),'literature','fetch',doi,'--zotero-only',flag];
      await assert.rejects(runLiterature('fetch',doi),/fetch <doi>/);
    }
    process.argv=[...argv.slice(0,2),'literature','fetch','1901.12345','--zotero-only'];
    await assert.rejects(runLiterature('fetch','1901.12345'),/requires a DOI/);
  } finally {process.argv=argv;process.exitCode=exitCode;}
});

test('journal-linked renamed arXiv manuscript without printed journal DOI verifies and stays fully local on reuse',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF()});
  const first=await fetch_paper(doi,{launch});assert.equal(first.status,'available',first.message);
  assert.equal(first.identity.kind,'arxiv-manuscript');assert.equal(first.identity.arxiv_id,'1901.12345v2');
  const item=read('literature/catalog.json').papers[0];assert.equal(item.doi,doi);assert.equal(item.title,'Renamed journal title');
  assert.equal(item.fulltext_identity.title,'Original manuscript title');assert.equal(item.fulltext_version,'submittedVersion');
  assert.deepEqual(log.openURLs,['https://arxiv.org/pdf/1901.12345v2']);assert.equal(log.arxivLookups,1);assert.equal(log.arxivWaits,1);
  assert.equal(log.launched,0);assert.equal(log.saved,0);
  const second=await fetch_paper(doi,{launch});assert.equal(second.status,'available',second.message);assert.equal(second.reused,true);
  assert.equal(log.metadata,1);assert.equal(log.arxivLookups,1);assert.equal(log.downloads,1);
});

test('an unstamped manuscript still requires pinned official delivery, exact title and two author matches',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:pdf('Original manuscript title\nAlice Kepler and Bruno Maxwell')});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');assert.equal(log.arxivLookups,1);
});

test('two distinct complete authors may share a surname; hyphenation and affiliation numbers do not erase identity',async t=>{
  const authors=['Young Woo Choi','Hyoung Joon Choi'];
  const work={...manuscriptWork(),authorships:authors.map(display_name=>({author:{display_name}}))};
  const {launch,log}=fixture(t,{oaWork:work,arxivMeta:manuscriptFeed({authors}),bytes:manuscriptPDF('1901.12345v2','Original manuscript title','Young-Woo Choi1 and Hyoung Joon Choi2')});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'available',r.message);
  assert.deepEqual(r.identity.matched_authors,authors);assert.equal(r.identity.matched_surnames,undefined);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.arxivLookups,1);assert.equal(log.downloads,1);
});

test('one complete author repeated in metadata is not two distinct authors',async t=>{
  const work={...manuscriptWork(),authorships:[{author:{display_name:'Alice Kepler'}},{author:{display_name:'Alice Kepler'}}]};
  const {launch,log}=fixture(t,{oaWork:work,arxivMeta:manuscriptFeed({authors:['Alice Kepler','Alice Kepler']}),bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');assert.equal(log.downloads,0);
});

for(const authors of ['Other Kepler and Someone Maxwell','Alice Kepler and Alice Kepler','Malice Kepler and Abruno Maxwell'])
test('PDF must contain two verified complete names, not surnames, duplicates or substrings',async t=>{
  const {launch}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF('1901.12345v2','Original manuscript title',authors)});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');assert.equal(read('literature/catalog.json').papers.length,0);
});

test('legacy surname evidence is accepted only for an unchanged hash-bound cache, never for a fresh automatic PDF',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  const catalog=read('literature/catalog.json'),p=catalog.papers[0];
  delete p.fulltext_identity.matched_authors;p.fulltext_identity.matched_surnames=['kepler','maxwell'];
  write('literature/catalog.json',catalog);
  assert.throws(()=>validatePDF(output,doi,undefined,p.fulltext_identity),/arXiv PDF/);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.metadata,1);
  assert.deepEqual(read('literature/catalog.json').papers[0].fulltext_identity,p.fulltext_identity);
  p.fulltext_identity.matched_authors=[];write('literature/catalog.json',catalog);
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');
});

test('legacy visually verified cache retains its exact hash-bound approval without rewriting evidence',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  const catalog=read('literature/catalog.json'),p=catalog.papers[0];
  fs.writeFileSync(output,pdf('Visual-only identity fixture'));
  p.fulltext_sha256=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  delete p.fulltext_identity.matched_authors;
  Object.assign(p.fulltext_identity,{matched_surnames:['kepler','maxwell'],verification:'visual-first-page',verified_sha256:p.fulltext_sha256});
  write('literature/catalog.json',catalog);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.metadata,1);
  fs.appendFileSync(output,'changed');assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');
});

test('a PDF with header and EOF but an out-of-file xref is explicitly rejected, not mistaken for a missing parser',async t=>{
  const valid=pdf(),broken=Buffer.from(valid.toString().replace(/startxref\n\d+/,`startxref\n${valid.length+1000}`));
  const {launch}=fixture(t,{oaWork:openWork(),bytes:broken});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');assert.equal(r.pdf_reason,'pdf_structure_invalid');
  assert.match(r.message,/outside the file/);assert.equal(fs.existsSync(output),false);assert.equal(read('literature/catalog.json').papers.length,0);
});

for(const [label,parsed,reason]of [
  ['missing executable',{error:{code:'ENOENT'},status:null},'parser_unavailable'],
  ['host execution denied',{error:{code:'EACCES'},status:null},'parser_permission_denied'],
  ['timeout',{error:{code:'ETIMEDOUT'},status:null},'parser_timeout'],
  ['output limit',{error:{code:'ENOBUFS'},status:null},'parser_output_limit'],
  ['broken trailer',{status:1,stderr:"Syntax Error: Couldn't find trailer dictionary\nPRIVATE_URL_OR_PATH"},'pdf_structure_invalid'],
  ['PDF password',{status:1,stderr:'Command Line Error: Incorrect password PRIVATE_URL_OR_PATH'},'pdf_password_or_permissions'],
  ['unclassified parser failure',{status:1,stderr:'PRIVATE_URL_OR_PATH'},'pdf_parse_failed']
])test('parser diagnostic distinguishes '+label+' without exposing raw stderr',async t=>{
  const {launch}=fixture(t,{oaWork:openWork()});
  const mocked=t.mock.method(childProcess,'spawnSync',()=>({stdout:doi,...parsed}));syncBuiltinESMExports();
  t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');assert.equal(r.pdf_reason,reason);
  if(Number.isInteger(parsed.status))assert.equal(r.parser_exit_code,parsed.status);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_URL_OR_PATH'));assert.equal(fs.existsSync(output),false);
});

for(const [label,feed,status]of [
  ['conflicting journal DOI',manuscriptFeed({linkedDOI:'10.5555/wrong'}),'validation_failed'],
  ['missing journal DOI',manuscriptFeed({linkedDOI:''}),'needs_attention'],
  ['wrong metadata ID',manuscriptFeed({id:'1901.99999v2'}),'validation_failed'],
  ['mismatched author set',manuscriptFeed({authors:['Other Person','Someone Else']}),'validation_failed'],
  ['one shared complete name is not two authors',manuscriptFeed({authors:['Alice Kepler','Another Kepler']}),'validation_failed'],
  ['wrong pinned PDF link',manuscriptFeed({pdfID:'1901.99999v2'}),'needs_attention']])
test('arXiv '+label+' cannot register or download',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:feed,bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,status);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.equal(read('literature/catalog.json').papers.length,0);
});

for(const [label,bytes]of [
  ['wrong PDF title',manuscriptPDF('1901.12345v2','Another manuscript title')],
  ['wrong PDF authors',manuscriptPDF('1901.12345v2','Original manuscript title','Other Person and Someone Else')],
  ['wrong PDF ID',manuscriptPDF('1901.99999v2')],
  ['wrong PDF version',manuscriptPDF('1901.12345v1')],
  ['journal DOI in unrelated PDF is not enough',pdf(doi)]])
test('arXiv '+label+' is rejected despite correct metadata association',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes});
  const result=await fetch_paper(doi,{launch});assert.equal(result.status,'validation_failed');assert.match(result.message,/arXiv PDF/);
  assert.equal(read('literature/catalog.json').papers.length,0);assert.equal(fs.existsSync(output),false);assert.equal(log.launched,0);
});

for(const status of [403,429,503])test('arXiv metadata HTTP '+status+' stops without PDF download or alternate route',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),arxivStatus:status});
  assert.equal((await fetch_paper(doi,{launch})).status,status===429?'rate_limited':status===403?'access_denied':'needs_attention');
  assert.equal(log.downloads,0);assert.equal(log.launched,0);assert.equal(log.arxivLookups,1);
});

test('version-pinned arXiv request cannot silently use another metadata version',async t=>{
  const work=manuscriptWork();work.best_oa_location.pdf_url+='v1';
  const {launch,log}=fixture(t,{oaWork:work,arxivMeta:manuscriptFeed()});
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');assert.equal(log.downloads,0);
});

test('cached manuscript hash and stored identity remain necessary; neither corruption nor evidence removal succeeds',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  const catalog=read('literature/catalog.json');const identity=catalog.papers[0].fulltext_identity;
  delete catalog.papers[0].fulltext_identity;write('literature/catalog.json',catalog);
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');
  catalog.papers[0].fulltext_identity=identity;write('literature/catalog.json',catalog);fs.appendFileSync(output,'changed');
  const result=await fetch_paper(doi,{launch});assert.equal(result.status,'validation_failed');assert.match(result.message,/hash differs/);
  assert.equal(log.metadata,1);assert.equal(log.arxivLookups,1);
});

test('visual verification is reusable only for its exact cached hash, not a new automatic file',async t=>{
  const {launch,log}=fixture(t,{oaWork:manuscriptWork(),arxivMeta:manuscriptFeed(),bytes:manuscriptPDF()});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  const catalog=read('literature/catalog.json');
  fs.writeFileSync(output,pdf('Unextractable font encoding; independently visually checked fixture'));
  const sha256=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  catalog.papers[0].fulltext_sha256=sha256;
  catalog.papers[0].fulltext_identity={...catalog.papers[0].fulltext_identity,verification:'visual-first-page',verified_sha256:sha256};
  write('literature/catalog.json',catalog);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.metadata,1);
  catalog.papers[0].fulltext_identity.verified_sha256='wrong';write('literature/catalog.json',catalog);
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');assert.equal(log.metadata,1);
});

test('OA PDF uses only metadata and original host, never UW/browser/content API; second call stays local', async t => {
  const {launch,log} = fixture(t,{oaWork:openWork()});
  const first = await fetch_paper(doi,{launch});
  assert.equal(first.status,'available',first.message); assert.equal(first.access_route,'open-access');
  assert.equal(log.launched,0); assert.equal(log.saved,0); assert.equal(log.resolved,0);
  assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf']);
  const item=read('literature/catalog.json').papers[0];
  assert.equal(item.fulltext_license,'cc-by'); assert.equal(item.fulltext_version,'publishedVersion');
  assert.equal(item.title,'Open fictional article'); assert.deepEqual(item.authors,['Open Author']);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);
  assert.equal(log.metadata,1); assert.equal(log.downloads,1);
});

test('OA landing page gets an anonymous context and observed PDF link, without saved campus cookies', async t => {
  const {launch,log}=fixture(t,{oaWork:openWork({pdf_url:null,landing_page_url:'https://journals.example.org/article/42'})});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  assert.equal(log.launched,1); assert.equal(log.contextOptions,undefined); assert.equal(log.saved,0);
  assert.deepEqual(log.openURLs,['https://journals.example.org/article/42.pdf']); assert.equal(log.resolved,0);
  let aborted=0,continued=0;
  const route=url=>({request:()=>({url:()=>url}),abort:()=>{aborted++;},continue:()=>{continued++;}});
  await log.routeGuard(route('https://ezproxy.library.wisc.edu/login'));
  await log.routeGuard(route('https://content.openalex.org/works/W123.pdf'));
  await log.routeGuard(route('https://journals.example.org/article/42'));
  assert.equal(aborted,2);assert.equal(continued,1);
});

test('open author manuscript is supported and version preserved even when publisher is closed', async t => {
  const work=openWork({version:'acceptedVersion'});work.open_access.is_oa=false;
  const {launch,log}=fixture(t,{oaWork:work});
  assert.equal((await fetch_paper(doi,{launch})).status,'available');
  assert.equal(read('literature/catalog.json').papers[0].fulltext_version,'acceptedVersion'); assert.equal(log.launched,0);
});

for (const status of [403,429,404]) test('metadata HTTP '+status+' never falls through to campus',async t=>{
  const {launch,log}=fixture(t,{oaStatus:status});
  assert.equal((await fetch_paper(doi,{launch})).status,status===429?'rate_limited':'needs_attention');
  assert.equal(log.launched,0); assert.equal(log.resolved,0); assert.equal(log.downloads,0); assert.equal(log.metadata,1);
});

test('metadata must match requested DOI; no false closed inference from missing OA information',async t=>{
  const {launch,log}=fixture(t,{oaWork:{doi:'10.5555/wrong'}});
  assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed'); assert.equal(log.launched,0);
});

for (const [route, options] of [
  ['OpenAlex', { oaStatus: 429 }],
  ['arXiv', { oaWork: manuscriptWork(), arxivMeta: manuscriptFeed(), arxivStatus: 429 }],
  ['article page', { status: 429 }],
  ['PDF', { oaWork: openWork(), pdfStatus: 429 }]
]) test(route + ' 429 exposes Retry-After to the batch without retrying or logging credentials', async t => {
  const { launch } = fixture(t, { ...options, retryAfter: '120' });
  const result = await fetch_paper(doi, { launch });
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.retry_after_ms, 120000);
  assert.equal(fs.existsSync(output), false);
});

for (const [value, expected] of [
  ['0', 0], ['invalid', 60000], [undefined, 60000],
  ['Mon, 26 Oct 2026 12:02:00 GMT', 120000], ['Mon, 26 Oct 2026 11:59:00 GMT', 0]
]) test('429 Retry-After parsing: ' + String(value), async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-26T12:00:00Z'));
  const { launch } = fixture(t, { oaStatus: 429, retryAfter: value });
  assert.equal((await fetch_paper(doi, { launch })).retry_after_ms, expected);
});

for (const status of [401,403,429]) test('OA PDF HTTP '+status+' stops without UW fallback or retry',async t=>{
  const {launch,log}=fixture(t,{oaWork:openWork(),pdfStatus:status});
  assert.equal((await fetch_paper(doi,{launch})).status,status===429?'rate_limited':'access_denied');
  assert.equal(log.launched,0); assert.equal(log.downloads,1); assert.equal(read('literature/catalog.json').papers.length,0);
});

test('real batch skips a 15-minute limited host, obtains another host PDF immediately, and does not re-request the limited host', async t => {
  const directory = fs.mkdtempSync(path.join(root, '.runtime/independent-hosts-'));
  const dois = ['10.5555/limited-first', '10.5555/independent', '10.5555/limited-next'];
  const files = dois.map(d => path.join(root, 'literature/fulltext', 'doi-' + createHash('sha256').update(d).digest('hex').slice(0, 16) + '.pdf'));
  t.after(() => { fs.rmSync(directory, { recursive: true }); for (const f of files) fs.rmSync(f, { force: true }); });
  write('literature/catalog.json', { papers: dois.map(d => ({ doi: d, title: 'Fictional article' })) });
  let now = Date.now(), slept = 0; const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { now += ms; slept += ms; queueMicrotask(fn); return 0; });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value); calls.push(url.hostname);
    const r = url.hostname === 'limited.example' ? new Response(null, { status: 429, headers: { 'retry-after': '900' } }) : new Response(pdf(dois[1]));
    Object.defineProperty(r, 'url', { value: url.href }); return r;
  });
  const state = await runFetchBatch({ directory, concurrency: 1, fetchPaper: (d, options) => fetch_paper(d, {
    ...options, source: d === dois[1] ? 'https://independent.example/article.pdf' : 'https://limited.example/' + d
  }) });
  assert.equal(state.status, 'complete'); assert.equal(state.completed, 3); assert.equal(state.available, 1);
  assert.equal(slept, 0); assert.deepEqual(calls, ['limited.example', 'independent.example']);
  const journal = fs.readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(p => p.result.status), ['rate_limited', 'available', 'rate_limited']);
  assert.ok(fs.existsSync(files[1])); assert.equal(read('literature/catalog.json').papers.filter(p => p.fulltext_path).length, 1);
  const history = fs.readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8');
  await runFetchBatch({ directory, fetchPaper: async () => assert.fail('completed DOI must not be retried') });
  assert.equal(fs.readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8'), history);
});

test('browser article 429 prevents reopening that host but not an independent PDF', async t => {
  const { launch, log } = fixture(t, { status: 429, retryAfter: '900' });
  const backoff = new FetchBackoff();
  assert.equal((await fetch_paper(doi, { launch, backoff })).status, 'rate_limited');
  assert.equal((await fetch_paper(doi, { launch, backoff })).status, 'rate_limited');
  assert.equal(log.launched, 1);
  write('literature/catalog.json', { papers: [{ doi, title: 'Fictional article' }] });
  const result = await fetch_paper(doi, { source: 'https://independent.example/article.pdf', backoff });
  assert.equal(result.status, 'available'); assert.equal(log.downloads, 1);
});

test('OA HTML challenge is not saved and does not trigger campus access',async t=>{
  const {launch,log}=fixture(t,{oaWork:openWork(),bytes:Buffer.from('<html>Verify you are human</html>')});
  assert.equal((await fetch_paper(doi,{launch})).status,'needs_attention'); assert.equal(log.launched,0);
  assert.equal(read('literature/catalog.json').papers.length,0);
});

test('OA wrong-article PDF retains strict identity validation',async t=>{
  const {launch,log}=fixture(t,{oaWork:openWork(),bytes:pdf('10.5555/wrong-paper')});
  const result=await fetch_paper(doi,{launch});
  assert.equal(result.status,'validation_failed'); assert.match(result.message,/Requested DOI/); assert.equal(log.launched,0);
  assert.equal(read('literature/catalog.json').papers.length,0);
});

for(const redirect of ['https://ezproxy.library.wisc.edu/login?qurl=paper','https://content.openalex.org/works/W123.pdf'])
test('OA redirect cannot enter campus or metered content: '+new URL(redirect).hostname,async t=>{
  const {launch,log}=fixture(t,{oaWork:openWork(),redirect});
  assert.equal((await fetch_paper(doi,{launch})).status,'failed'); assert.equal(log.launched,0);
  assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf']);
});

test('OA without a usable URL or unknown access status stops instead of guessing subscription',async t=>{
  const {launch,log}=fixture(t,{oaWork:{doi,open_access:{is_oa:true},locations:[]}});
  assert.equal((await fetch_paper(doi,{launch})).status,'needs_attention'); assert.equal(log.launched,0);
});

test('missing access metadata is unknown, not permission to use campus',async t=>{
  const {launch,log}=fixture(t,{oaWork:{doi,locations:[]}});
  assert.equal((await fetch_paper(doi,{launch})).status,'needs_attention'); assert.equal(log.launched,0);
});

test('OpenAlex key goes only to metadata API, never the PDF source or registered record',async t=>{
  const original=process.env.OPENALEX_API_KEY;process.env.OPENALEX_API_KEY='fictional-openalex-key';
  t.after(()=>{if(original===undefined)delete process.env.OPENALEX_API_KEY;else process.env.OPENALEX_API_KEY=original;});
  const {launch,log}=fixture(t,{oaWork:openWork()});
  const result=await fetch_paper(doi,{launch});assert.equal(result.status,'available',result.message);
  assert.equal(log.hasKey,true);assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf']);
  assert.ok(!JSON.stringify({result,catalog:read('literature/catalog.json')}).includes('fictional-openalex-key'));
});

test('human verification on an OA landing page stops before any download or campus session save',async t=>{
  const {launch,log}=fixture(t,{oaWork:openWork({pdf_url:null,landing_page_url:'https://journals.example.org/article/42'}),challenged:true});
  assert.equal((await fetch_paper(doi,{launch})).status,'needs_attention'); assert.equal(log.downloads,0); assert.equal(log.saved,0);
});
test('new download is checked and registered; second call is entirely local and preserves file', async t => {
  const {launch,log} = fixture(t);
  const first = await fetch_paper(doi,{launch}); assert.equal(first.status,'available',first.message); assert.equal(first.reused,false);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_status,'local-file');
  const before = fs.readFileSync(output); const second = await fetch_paper('https://doi.org/'+doi,{launch});
  assert.equal(second.status,'available'); assert.equal(second.reused,true); assert.deepEqual(fs.readFileSync(output),before);
  assert.equal(log.resolved,0); assert.equal(log.launched,1); assert.equal(log.downloads,1); assert.equal(log.closed,1);
  assert.equal(authStatus().session_saved,false); assert.equal(log.saved,0);
});
test('closed paper stops with Zotero guidance, without resolving DOI or opening UW even if campus:true is passed', async t => {
  const {launch,log} = fixture(t,{oaWork:{doi,open_access:{is_oa:false},locations:[]}});
  const r = await fetch_paper(doi,{launch,campus:true});
  assert.equal(r.status,'needs_attention'); assert.match(r.message,/Zotero/); assert.equal(r.search_suggested,true);
  assert.equal(log.resolved,0); assert.equal(log.launched,0); assert.equal(log.downloads,0); assert.equal(log.saved,0);
});
test('retired --login cannot restart UW or any network requests', async t => {
  const {launch,log} = fixture(t); const r = await fetch_paper(doi,{launch,login:true});
  assert.equal(r.status,'needs_attention'); assert.match(r.message,/retired.*Zotero/);
  assert.equal(log.metadata,0); assert.equal(log.resolved,0); assert.equal(log.launched,0); assert.equal(log.downloads,0);
  assert.equal(log.zotero.length,0);
});
test('missing PDF link is not a subscription diagnosis or a retry', async t => {
  const {launch,log} = fixture(t,{links:[]}); const r = await fetch_paper(doi,{launch});
  assert.equal(r.status,'needs_attention'); assert.equal(log.downloads,0); assert.equal(log.closed,1);
});
test('HTML pretending to be a PDF is not saved or registered', async t => {
  const {launch,log} = fixture(t,{bytes:Buffer.from('<html>Purchase access</html>')}); const r = await fetch_paper(doi,{launch});
  assert.equal(r.status,'needs_attention'); assert.equal(fs.existsSync(output),false); assert.equal(read('literature/catalog.json').papers.length,0); assert.equal(log.downloads,1);
});
test('wrong-article PDF is rejected; staging files are removed', async t => {
  const {launch} = fixture(t,{bytes:pdf('10.5555/wrong-paper')}); const r = await fetch_paper(doi,{launch});
  assert.equal(r.status,'validation_failed'); assert.match(r.message,/Requested DOI/); assert.equal(fs.existsSync(output),false);
  assert.equal(fs.readdirSync(path.dirname(output)).some(f=>f.endsWith('.tmp')),false);
  assert.equal(read('literature/catalog.json').papers.length,0);
});
test('HTTP denial is reported without download', async t => {
  const {launch,log} = fixture(t,{status:403}); assert.equal((await fetch_paper(doi,{launch})).status,'access_denied'); assert.equal(log.downloads,0);
});
test('malformed DOI and metadata 404 do not start a browser or DOI resolution', async t => {
  const {launch,log} = fixture(t,{oaStatus:404}); assert.equal((await fetch_paper('bad',{launch})).status,'invalid_doi'); assert.equal(log.resolved,0);
  const result=await fetch_paper(doi,{launch});assert.equal(result.status,'needs_attention');assert.equal(result.search_suggested,true);
  assert.equal(log.resolved,0); assert.equal(log.launched,0);
});
test('a changed cached file fails without network or overwriting the original', async t => {
  const {launch,log} = fixture(t); await fetch_paper(doi,{launch}); fs.appendFileSync(output,'tamper');
  const bytes=fs.readFileSync(output); assert.equal((await fetch_paper(doi,{launch})).status,'validation_failed');
  assert.deepEqual(fs.readFileSync(output),bytes); assert.equal(log.resolved,0); assert.equal(log.downloads,1);
});
test('provider exception exposes no authentication token and is not retried', async t => {
  const {launch,log} = fixture(t,{error:new Error('failed https://login.wisc.edu/?token=SECRET')});
  const r = await fetch_paper(doi,{launch}); assert.equal(r.status,'failed'); assert.ok(!JSON.stringify(r).includes('SECRET')); assert.equal(log.downloads,1); assert.equal(log.closed,1);
});

function netidPage({outcome='ready',host='login.wisc.edu',action='/idp/auth',fields=1,scheme='https'}={}) {
  const article='https://journals.example.org/article/42';
  let current=scheme+'://'+host+'/idp/auth';
  const log={filled:[],clicked:0,waited:0};
  const field=name=>({count:async()=>fields,fill:async value=>log.filled.push({name,value}),click:async()=>{log.clicked++;}});
  const form={count:async()=>1,getAttribute:async()=>action,locator:selector=>field(selector.includes('password')?'password':selector.includes('submit')?'submit':'user')};
  const page={url:()=>current,locator:()=>({filter:()=>form}),waitForURL:async predicate=>{
    log.waited++;if(outcome==='failed'||outcome==='human'&&log.waited===1)throw Error('Invalid password SECRET');
    current=outcome==='duo'?'https://api-fixture.duosecurity.com/prompt':article;
    assert.equal(predicate(new URL(current)),true);
  }};
  return {page,article,log};
}
test('saved library state is reused for the next context, not treated as proof of validity',async()=>{
  const file=path.join(authDirectory,'session.local.json');
  await saveLibrarySession({storageState:async({path:p})=>fs.writeFileSync(p,JSON.stringify({cookies:[],origins:[]}))});
  let options; await createLibraryContext({newContext:async o=>{options=o;}});
  assert.equal(options.storageState,file); assert.equal(authStatus().session_saved,true);
  assert.ok(!JSON.stringify(authStatus()).includes('cookies'));
});
// The native Connector is the producer. These tests exercise the consumer from
// its actual local-API contract, without a browser, network download or model.
function localZotero(t,{text=doi,matchingDOI=doi,contentType='application/pdf',fileLocation,missing=false,url='https://journals.example.org/paper.pdf',authors=['Fictional Author']}={}) {
  const file=path.join(root,'.runtime','zotero-fixture.pdf');fs.mkdirSync(path.dirname(file),{recursive:true});
  if(!missing)fs.writeFileSync(file,pdf(text));
  t.after(()=>{if(fs.existsSync(file))fs.unlinkSync(file);});
  const parent={key:'PARENT01',data:{itemType:'journalArticle',DOI:matchingDOI,title:'Fictional Zotero paper',date:'2026',creators:authors.map(name=>({name,creatorType:'author'}))}};
  const child={key:'ATTACH01',data:{itemType:'attachment',parentItem:parent.key,contentType,linkMode:'imported_url',url}};
  return {file,reply:(url)=>{
    if(url.pathname==='/api/users/0/items'){
      assert.equal(url.searchParams.get('q'),doi);assert.equal(url.searchParams.get('qmode'),'everything');
      return Response.json([parent]);
    }
    if(url.pathname.endsWith('/PARENT01/children'))return Response.json([child]);
    if(url.pathname.endsWith('/ATTACH01/file'))return new Response(null,{status:302,headers:{location:fileLocation||pathToFileURL(file).href}});
    throw new Error('Unexpected Zotero request '+url.pathname);
  }};
}

test('fetch consumes official Connector local PDF, verifies and registers once; repeat is entirely cached',async t=>{
  const z=localZotero(t);const {launch,log}=fixture(t,{zotero:z.reply});
  const before=fs.readFileSync(z.file);const first=await fetch_paper(doi,{launch});
  assert.equal(first.status,'available',first.message);assert.equal(first.access_route,'zotero-local');assert.equal(first.path,output);
  const p=read('literature/catalog.json').papers[0];assert.equal(p.zotero_key,'PARENT01');assert.equal(p.zotero_attachment_key,'ATTACH01');
  assert.equal(p.fulltext_status,'local-file');assert.equal(p.fulltext_version,null);assert.equal(p.fulltext_sha256,first.sha256);
  assert.equal(log.zotero.length,3);assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.zotero.length,3);
  assert.deepEqual(fs.readFileSync(output),before);assert.equal(fs.existsSync(z.file),false);
});

function nativeConfig(t) {
  const old=read('literature/config.json');t.after(()=>write('literature/config.json',old));
  write('literature/config.json',{...old,zotero_native:true});
}
for(const zoteroOnly of [false,true])
test((zoteroOnly?'Zotero-only':'normal')+' fetch triggers native acquisition once, rereads exact local attachment and registers verified PDF; repeat stays cached',async t=>{
  nativeConfig(t);const z=localZotero(t);let acquired=false,calls=0;
  const {launch,log}=fixture(t,{zotero:(url,options)=>{
    if(url.pathname==='/office/fetch'){
      calls++;assert.equal(options.method,'POST');assert.equal(options.headers['X-Office-Fetch'],'1');
      assert.deepEqual(JSON.parse(options.body),{doi});acquired=true;
      return Response.json({status:'saved',doi,path:'file:///untrusted-from-notification.pdf'});
    }
    return acquired?z.reply(url):Response.json([]);
  }});
  const r=await fetch_paper(doi,{launch,zoteroOnly});assert.equal(r.status,'available',r.message);
  assert.equal(r.native_acquired,true);assert.equal(r.reused,false);assert.equal(r.path,output);assert.equal(fs.existsSync(z.file),false);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_sha256,r.sha256);
  assert.equal(calls,1);assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  await fetch_paper(doi,{launch,zoteroOnly});assert.equal(calls,1);
});

for(const unavailable of [false,true])
test('Zotero-only '+(unavailable?'disconnected API':'native no-file')+' never queries OpenAlex, hosted quota, browser or UW',async t=>{
  nativeConfig(t);
  const {launch,log}=fixture(t,{oaWork:hostedWork(),zotero:url=>{
    if(unavailable)throw new Error('ECONNREFUSED');
    if(url.pathname==='/office/fetch')return Response.json({status:'no_file_found',doi});
    return Response.json([]);
  }});
  const r=await fetch_paper(doi,{launch,zoteroOnly:true});assert.equal(r.status,'needs_attention');
  assert.match(r.message,/did not query OpenAlex/);assert.equal(log.metadata,0);assert.equal(log.downloads,0);
  assert.equal(log.quota,undefined);assert.equal(log.hosted,undefined);assert.equal(log.launched,0);assert.equal(log.resolved,0);
  assert.equal(read('literature/catalog.json').papers.length,0);
});
test('a newly native-saved wrong PDF stops the whole article without online replacement',async t=>{
  nativeConfig(t);const z=localZotero(t,{text:'10.5555/another-paper'});let acquired=false;
  const {launch,log}=fixture(t,{zotero:(url,options)=>{
    if(url.pathname==='/office/fetch'){acquired=true;return Response.json({status:'saved',doi});}
    return acquired?z.reply(url):Response.json([]);
  }});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');
  assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(read('literature/catalog.json').papers.length,0);
});
test('native no-file and unavailable plugin do not fabricate availability or block independent OA',async t=>{
  nativeConfig(t);let nativeCalls=0;
  const {launch,log}=fixture(t,{oaWork:openWork(),zotero:url=>{
    if(url.pathname==='/office/fetch'){nativeCalls++;return Response.json({status:'no_file_found',doi});}
    return Response.json([]);
  }});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'open-access');assert.equal(nativeCalls,1);assert.equal(log.downloads,1);
});
test('native acquisition cannot be triggered by explicit hosted/source or retired login modes',async t=>{
  nativeConfig(t);const {launch,log}=fixture(t,{oaWork:openWork()});
  await fetch_paper(doi,{launch,login:true});assert.equal(log.zotero.length,0);
  await fetch_paper(doi,{launch,hostedOnly:true});assert.equal(log.zotero.length,0);
  if(fs.existsSync(output))fs.unlinkSync(output);
  await fetch_paper(doi,{launch,source:'https://repository.example.org/paper.pdf'});assert.equal(log.zotero.length,0);
});

test('a similarly matched Zotero item with a different DOI is ignored',async t=>{
  const z=localZotero(t,{matchingDOI:'10.5555/not-the-target'});const {launch,log}=fixture(t,{zotero:z.reply,oaWork:openWork()});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'open-access');assert.equal(log.zotero.length,1);
  assert.equal(log.downloads,1);
});

test('a web snapshot is not a Zotero PDF and does not create false availability',async t=>{
  const z=localZotero(t,{contentType:'text/html'});const {launch,log}=fixture(t,{zotero:z.reply,oaWork:{doi,open_access:{is_oa:false},locations:[]}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'needs_attention');assert.equal(r.zotero_reason,'no_pdf_attachment');
  assert.match(r.next,/repeat literature fetch/);assert.equal(read('literature/catalog.json').papers.length,0);assert.equal(log.launched,0);
});

test('wrong Zotero PDF fails identity and never tries an online replacement',async t=>{
  const z=localZotero(t,{text:'10.5555/wrong-article'});const {launch,log}=fixture(t,{zotero:z.reply});
  const before=fs.readFileSync(z.file);const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');
  assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.equal(read('literature/catalog.json').papers.length,0);assert.deepEqual(fs.readFileSync(z.file),before);
});

test('a nonlocal attachment redirect is never followed or fetched',async t=>{
  const z=localZotero(t,{fileLocation:'https://journals.example.org/subscription.pdf'});
  const {launch,log}=fixture(t,{zotero:z.reply,oaWork:{doi,open_access:{is_oa:false},locations:[]}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.zotero_reason,'nonlocal_attachment');
  assert.equal(r.status,'needs_attention');assert.equal(log.downloads,0);assert.equal(log.launched,0);
});

test('a Zotero attachment not present on disk does not trigger cloud download',async t=>{
  nativeConfig(t);
  const z=localZotero(t,{missing:true});const {launch,log}=fixture(t,{zotero:z.reply,oaWork:{doi,open_access:{is_oa:false},locations:[]}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.zotero_reason,'attachment_not_local');
  assert.equal(log.downloads,0);assert.equal(log.launched,0);assert.equal(read('literature/catalog.json').papers.length,0);
  assert.equal(log.zotero.some(url=>url.endsWith('/office/fetch')),false);
});

test('Zotero being closed does not prevent ordinary open-access fetch',async t=>{
  const {launch,log}=fixture(t,{zotero:()=>{throw new Error('ECONNREFUSED')},oaWork:openWork()});
  const r=await fetch_paper(doi,{launch});assert.equal(r.access_route,'open-access');assert.equal(log.downloads,1);assert.equal(log.launched,0);
});

test('Zotero local API disabled yields actionable result, not false fulltext availability',async t=>{
  const {launch,log}=fixture(t,{zotero:()=>new Response('',{status:403}),oaWork:{doi,open_access:{is_oa:false},locations:[]}});
  const r=await fetch_paper(doi,{launch});assert.equal(r.zotero_reason,'api_disabled');assert.equal(r.status,'needs_attention');
  assert.match(r.next,/official Zotero Connector/);assert.equal(log.downloads,0);assert.equal(log.launched,0);
});

test('Zotero config cannot redirect metadata queries to a remote service',async t=>{
  const old=read('literature/config.json');t.after(()=>write('literature/config.json',old));
  write('literature/config.json',{...old,zotero_local:'https://untrusted.example.org/api/'});
  const {launch,log}=fixture(t,{oaWork:openWork()});const r=await fetch_paper(doi,{launch});
  assert.equal(r.access_route,'open-access');assert.equal(log.zotero.length,0);
  assert.deepEqual(log.openURLs,['https://repository.example.org/paper.pdf']);
});

test('Zotero arXiv manuscript still requires official journal association and two complete author names',async t=>{
  const text='arXiv:1901.12345v2\nOriginal manuscript title\nAlice Kepler and Bruno Maxwell';
  const z=localZotero(t,{text,url:'https://arxiv.org/pdf/1901.12345',authors:['Alice Kepler','Bruno Maxwell']});
  const {launch,log}=fixture(t,{zotero:z.reply,arxivMeta:manuscriptFeed()});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'available',r.message);assert.equal(r.identity.kind,'arxiv-manuscript');
  assert.equal(log.arxivLookups,1);assert.equal(log.metadata,0);assert.equal(log.downloads,0);assert.equal(log.launched,0);
  assert.equal((await fetch_paper(doi,{launch})).reused,true);assert.equal(log.arxivLookups,1);
});

test('Zotero arXiv conflict is not accepted merely because its parent item has the requested DOI',async t=>{
  const z=localZotero(t,{url:'https://arxiv.org/pdf/1901.12345',authors:['Alice Kepler','Bruno Maxwell']});
  const {launch,log}=fixture(t,{zotero:z.reply,arxivMeta:manuscriptFeed({linkedDOI:'10.5555/other'})});
  const r=await fetch_paper(doi,{launch});assert.equal(r.status,'validation_failed');assert.equal(log.metadata,0);
  assert.equal(log.downloads,0);assert.equal(read('literature/catalog.json').papers.length,0);
});

test('retired --login does not refresh authentication or alter a cached PDF',async t=>{
  const {launch,log}=fixture(t);await fetch_paper(doi,{launch});
  const bytes=fs.readFileSync(output);const result=await fetch_paper(doi,{launch,login:true});
  assert.equal(result.status,'needs_attention');assert.match(result.message,/retired/);assert.equal(log.downloads,1);
  assert.equal(log.launched,1);assert.equal(log.saved,0);assert.equal(log.contextOptions,undefined);
  assert.deepEqual(fs.readFileSync(output),bytes);
});
test('normal NetID login succeeds once without Duo and without touching FOM credentials',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const {page,article,log}=netidPage();const result=await ensureLibraryAccess(page,article);
  assert.equal(result.status,'ready');assert.equal(log.clicked,1);assert.equal(log.filled.length,2);assert.equal(authStatus().auto_login_blocked,false);
});
test('Duo requires human intervention; no push/approval interaction and no repeated password submission',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const {page,article,log}=netidPage({outcome:'duo'});const result=await ensureLibraryAccess(page,article);
  assert.equal(result.status,'needs_login');assert.match(result.message,/Duo/);assert.equal(log.clicked,1);
  assert.equal((await ensureLibraryAccess(page,article)).status,'needs_login');assert.equal(log.clicked,1);
});
test('unconfirmed password attempt blocks all later automatic attempts until explicit reset',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const {page,article,log}=netidPage({outcome:'failed'});
  assert.equal((await ensureLibraryAccess(page,article)).status,'login_failed');assert.equal(log.clicked,1);
  const second=await ensureLibraryAccess(page,article);assert.equal(second.status,'login_failed');assert.equal(log.clicked,1);
  assert.equal(authStatus().auto_login_blocked,true);assert.ok(!JSON.stringify(second).includes('SECRET'));
  resetLoginBlock();assert.equal(authStatus().auto_login_blocked,false);
});
test('publisher login form or cross-origin form action never receives NetID',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const publisher=netidPage({host:'publisher.example.org'});await ensureLibraryAccess(publisher.page,publisher.article);
  assert.equal(publisher.log.filled.length,0);assert.equal(publisher.log.clicked,0);
  const hostile=netidPage({action:'https://evil.example.org/login'});assert.equal((await ensureLibraryAccess(hostile.page,hostile.article)).status,'needs_login');
  assert.equal(hostile.log.filled.length,0);assert.equal(hostile.log.clicked,0);
  const insecure=netidPage({scheme:'http'});await ensureLibraryAccess(insecure.page,insecure.article);
  assert.equal(insecure.log.filled.length,0);assert.equal(insecure.log.clicked,0);
});
test('interactive takeover after an unconfirmed normal login never submits the password twice',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const {page,article,log}=netidPage({outcome:'human'});
  assert.equal((await ensureLibraryAccess(page,article,{interactive:true})).status,'ready');
  assert.equal(log.clicked,1);assert.equal(log.waited,2);assert.equal(authStatus().auto_login_blocked,false);
});
test('changed or ambiguous form is stopped instead of guessing credential fields',async()=>{
  saveCredential('uw-library','fictional-user','fictional-password');
  const {page,article,log}=netidPage({fields:2});assert.equal((await ensureLibraryAccess(page,article)).status,'needs_login');
  assert.equal(log.filled.length,0);assert.equal(log.clicked,0);
});
