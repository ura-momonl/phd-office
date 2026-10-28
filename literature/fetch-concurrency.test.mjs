import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { read, write } from '../automation/files.mjs';
import { fetch_paper } from './fetch.mjs';
import { zoteroPDF } from './zotero.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs');
const config=read('literature/config.json'),catalog=read('literature/catalog.json');
const dois=['10.5555/parallel-a','10.5555/parallel-b','10.5555/parallel-c'];
beforeEach(()=>{write('literature/config.json',{...config,zotero_native:true});write('literature/catalog.json',{...catalog,papers:[]});});
afterEach(()=>{write('literature/config.json',config);write('literature/catalog.json',catalog);});

test('three article fetches overlap OA lookup but each gets one serialized native attempt',async t=>{
 let nativeActive=0,nativeMax=0,oaActive=0,oaMax=0;
 const nativeCalls=[],oaCalls=[];
 t.mock.method(globalThis,'fetch',async(value,options={})=>{
  const url=new URL(value);
  if(url.hostname==='127.0.0.1'){
   if(url.pathname==='/api/users/0/items')return Response.json([]);
   assert.equal(url.pathname,'/office/fetch');
   const {doi}=JSON.parse(options.body);nativeCalls.push(doi);
   nativeActive++;nativeMax=Math.max(nativeMax,nativeActive);
   await new Promise(resolve=>setTimeout(resolve,15));
   nativeActive--;return Response.json({doi,status:'no_file_found'});
  }
  assert.equal(url.hostname,'api.openalex.org');assert.ok(url.pathname.startsWith('/works/'));
  const doi=decodeURIComponent(url.pathname.split('/works/https://doi.org/')[1]);
  oaCalls.push(doi);oaActive++;oaMax=Math.max(oaMax,oaActive);
  await new Promise(resolve=>setTimeout(resolve,70));
  oaActive--;return Response.json({doi:'https://doi.org/'+doi,open_access:{is_oa:false},locations:[]});
 });
 const results=await Promise.all(dois.map(doi=>fetch_paper(doi)));
 assert.equal(nativeMax,1);assert.equal(oaMax,3);
 assert.deepEqual(nativeCalls,dois);assert.deepEqual(oaCalls,dois);
 assert.ok(results.every(r=>r.status==='needs_attention'&&r.zotero_native_reason==='no_file_found'));
 assert.equal(read('literature/catalog.json').papers.length,0);
});

test('a failed native acquisition releases the next queued article without retry',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(value,options={})=>{
  const url=new URL(value);assert.equal(url.hostname,'127.0.0.1');
  if(url.pathname==='/api/users/0/items')return Response.json([]);
  assert.equal(url.pathname,'/office/fetch');const {doi}=JSON.parse(options.body);calls.push(doi);
  if(doi===dois[0])throw new Error('simulated disconnect');
  return Response.json({doi,status:'no_file_found'});
 });
 const results=await Promise.all(dois.map(doi=>zoteroPDF(doi,{acquire:true})));
 assert.deepEqual(calls,dois);assert.equal(results[0].native_reason,'native_unavailable');
 assert.ok(results.slice(1).every(r=>r.native_reason==='no_file_found'));
});

test('concurrent manuscripts share arXiv request pacing and do not retry a refusal',async t=>{
 write('literature/catalog.json',{...catalog,papers:dois.map(doi=>({doi,title:'Fictional paper',authors:['Alice Kepler','Bruno Maxwell']}))});
 let active=0,max=0,calls=0,waits=0;
 const originalTimeout=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
  if(ms===3100){waits++;return originalTimeout(fn,5,...args);}
  return originalTimeout(fn,ms,...args);
 });
 t.mock.method(globalThis,'fetch',async(value)=>{
  const url=new URL(value);assert.equal(url.hostname,'export.arxiv.org');
  calls++;active++;max=Math.max(max,active);
  await new Promise(resolve=>originalTimeout(resolve,15));active--;
  return new Response('',{status:403});
 });
 const results=await Promise.all(dois.map(doi=>fetch_paper(doi,{source:'https://arxiv.org/pdf/2001.12345v1'})));
 assert.equal(max,1);assert.equal(calls,3);assert.equal(waits,3);
 assert.ok(results.every(r=>r.status==='access_denied'));
});
