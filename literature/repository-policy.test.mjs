import test from 'node:test';
import assert from 'node:assert/strict';
import {repositorySources,repositoryAccess,resolveRepositoryPage,staticRepositoryPDF} from './repository-policy.mjs';
import {fetch_paper} from './fetch.mjs';
import {read,write} from '../automation/files.mjs';
import {createHash} from 'node:crypto';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use scripts/run-tests.mjs');
const repo={is_oa:true,pdf_url:'https://repository.example/main.pdf',landing_page_url:'https://repository.example/article',
  source:{type:'repository',host_organization:'https://openalex.org/I123'}};
const sources=()=>repositorySources({locations:[repo]});
const fake=handler=>({remaining:()=>0,observe:()=>{},fetch:handler});

test('publishers, unknown provenance and cross-host PDF links are excluded even with misleading OA metadata',()=>{
  const journal={...repo,pdf_url:'https://www.nature.com/main.pdf',landing_page_url:'https://www.nature.com/article'};
  assert.equal(repositorySources({locations:[journal]}).length,0);
  assert.equal(repositorySources({locations:[{...repo,pdf_url:null,landing_page_url:'https://rdcu.be/bG4nA'}]}).length,0);
  assert.equal(repositorySources({locations:[{...repo,source:{type:'journal'}}]}).length,0);
  assert.equal(repositorySources({locations:[{...repo,pdf_url:'https://unknown.example/main.pdf'}]}).filter(p=>p.type==='pdf').length,0);
  assert.equal(sources().length,2);
  assert.equal(repositorySources({locations:[{is_oa:true,pdf_url:'https://arxiv.org/pdf/2501.12345'}]}).length,1);
});

test('a publisher or unconfirmed host is blocked before the transport is called',async()=>{
  const calls=[],access=repositoryAccess(sources(),fake(async u=>{calls.push(u);return new Response('ok');}));
  for(const url of ['https://www.nature.com/p.pdf','https://pubs.acs.org/p.pdf','https://rdcu.be/bG4nA','https://unknown.example/p.pdf'])
    assert.throws(()=>access.fetch(url),/policy blocked/);
  assert.equal(calls.length,0);
  await access.fetch(repo.pdf_url);assert.deepEqual(calls,[repo.pdf_url]);
});

test('repository page redirects to publishers are never requested',async()=>{
  const calls=[],access=repositoryAccess(sources(),fake(async(u,options)=>{
    calls.push(u);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://www.nature.com/p.pdf'}});
  }));
  const result=await resolveRepositoryPage(repo.landing_page_url,access);assert.match(result.error.message,/policy blocked/);
  assert.deepEqual(calls,[repo.landing_page_url]);
});

test('repository redirects to publisher sharing shortlinks stop before the shortlink request',async()=>{
  const calls=[],access=repositoryAccess(sources(),fake(async u=>{
    calls.push(u);return new Response(null,{status:302,headers:{location:'https://rdcu.be/bG4nA'}});
  }));
  const result=await resolveRepositoryPage(repo.landing_page_url,access);
  assert.match(result.error.message,/policy blocked/);assert.deepEqual(calls,[repo.landing_page_url]);
});

test('static repository HTML never executes publisher scripts, loads assets or follows publisher PDF metadata',async()=>{
  const calls=[],html='<script src="https://www.nature.com/track.js"></script><img src="https://pubs.acs.org/pixel"><meta name="citation_pdf_url" content="https://www.nature.com/main.pdf"><a href="/main.pdf">Download PDF</a>';
  const access=repositoryAccess(sources(),fake(async u=>{calls.push(u);return new Response(html,{headers:{'content-type':'text/html'}});}));
  const result=await resolveRepositoryPage(repo.landing_page_url,access);assert.equal(result.pdf_url,repo.pdf_url);assert.deepEqual(calls,[repo.landing_page_url]);
  assert.equal(staticRepositoryPDF('<meta name="citation_pdf_url" content="https://www.nature.com/main.pdf">',repo.landing_page_url,access),null);
});

test('actual shared PDF downloader cannot follow a repository redirect into a publisher',async t=>{
  const baseline=read('literature/catalog.json'),doi='10.5555/repository-policy';
  t.after(()=>write('literature/catalog.json',baseline));
  write('literature/catalog.json',{papers:[{id:'doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16),doi,title:'Fictional repository policy article'}]});
  const calls=[],access=repositoryAccess(sources(),fake(async u=>{calls.push(u);return new Response(null,{status:302,headers:{location:'https://pubs.acs.org/main.pdf'}});}));
  const result=await fetch_paper(doi,{source:repo.pdf_url,backoff:access});
  assert.equal(result.status,'failed');assert.deepEqual(calls,[repo.pdf_url]);
});
