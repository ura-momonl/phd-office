import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use scripts/run-tests.mjs --literature');
const code = fs.readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
const doi = '10.5555/native-test';
const natureDOI = '10.1038/nphys9999';
async function plugin({ existing = true, metadataDOI = doi, download, web = {} } = {}) {
  const log = { searches: 0, lookups: 0, downloads: 0 };
  const webLog = { requests: 0, translations: 0 };
  const document = { title: web.title || 'Fixture article', querySelector(selector) {
    if (selector === 'meta[name="citation_doi"]') return { getAttribute: () => web.doi ?? natureDOI };
    if (selector === '[data-title="Abstract"] .c-article-section__content')
      return web.noAbstract ? null : { textContent: web.abstract || 'Complete abstract. Last sentence preserved.' };
    return null;
  } };
  const item = { key: 'PARENT01', getField: () => metadataDOI, getAttachments: () => [] };
  const z = { initializationPromise: Promise.resolve(), Server: { Endpoints: {} },
    Libraries: { userLibraryID: 1 }, Utilities: { cleanDOI: value => value },
    Search: class { addCondition(...args) { assert.deepEqual(args, ['DOI','is',doi]); }
      async search() { log.searches++; return existing ? [item] : []; } },
    Items: { getAsync: async items => items },
    HTTP: { async request(method,url,options) {
      webLog.requests++; assert.equal(method,'GET');
      assert.equal(url,'https://www.nature.com/articles/nphys9999');
      assert.equal(options.responseType,'document');assert.equal(options.errorDelayMax,0);
      assert.equal(options.noRetryOnThrottle,true);assert.equal(options.timeout,30000);
      if(web.error)throw web.error;
      if(web.wait)await web.wait();
      return {response:document};
    }, wrapDocument: value => {assert.equal(value,document);return value;} },
    Translate: { Web: class {
      setDocument(doc){assert.equal(doc,document);}
      setTranslator(t){assert.equal(t,'951c027d-74ac-47d4-a107-9c3069ab7b48');}
      async translate(options){
        assert.equal(options.libraryID,false);assert.equal(options.saveAttachments,false);webLog.translations++;
        return [{DOI:web.itemDOI||natureDOI,title:'Fixture article',publicationTitle:'Nature Physics',date:'2020',
          abstractNote:'Incorrect generic site description: must not replace the labeled section',
          creators:[{creatorType:'author',firstName:'First',lastName:'Author'}]}];
      }
    }, Search: class { setIdentifier(value) { assert.equal(value.DOI, doi); }
      async getTranslators() { return ['fictional']; } setTranslator() {}
      async translate(options) { assert.equal(options.saveAttachments, false); log.lookups++; return [item]; } } },
    Attachments: { async addAvailableFile(value, options) {
      assert.equal(value,item); assert.deepEqual(Array.from(options.methods),['doi','url','oa']);
      log.downloads++; return download ? download() : { key:'ATTACH01' };
    } }, logError: error => assert.fail(String(error)) };
  const context = vm.createContext({ Zotero:z }); vm.runInContext(code,context); context.startup();
  await z.initializationPromise; await Promise.resolve();
  const endpoint = new z.Server.Endpoints['/office/fetch']();
  return { context, endpoint, log, webLog,
    metadata: new z.Server.Endpoints['/office/metadata']() };
}
const request = (data = {doi}, headers = {'x-office-fetch':'1'}) => ({data,headers});
const body = result => JSON.parse(result[2]);
test('native plugin rejects browser origins, fetch metadata and missing deliberate-client header before any lookup',async()=>{
  const p=await plugin();
  for(const headers of [{origin:'https://evil.example','x-office-fetch':'1'}, {'sec-fetch-site':'cross-site','x-office-fetch':'1'},{}])
    assert.equal((await p.endpoint.init(request({doi},headers)))[0],403);
  assert.deepEqual(p.log,{searches:0,lookups:0,downloads:0});
});
test('native plugin accepts only a normalized DOI, not URLs, paths or arbitrary operations',async()=>{
  const p=await plugin();
  for(const data of [{doi:'file:///private.pdf'},{doi:'https://doi.org/'+doi},{doi,url:'http://127.0.0.1/private'},{doi,script:'anything'},{doi:doi.toUpperCase()},null])
    assert.equal((await p.endpoint.init(request(data)))[0],400);
  assert.equal(p.log.downloads,0);
});
test('native plugin uses Zotero metadata lookup and native resolver, returns notification keys not trusted file paths',async()=>{
  const p=await plugin({existing:false}); const r=await p.endpoint.init(request());
  assert.equal(r[0],200); assert.deepEqual(body(r),{status:'saved',doi,parent_key:'PARENT01',attachment_key:'ATTACH01'});
  assert.deepEqual(p.log,{searches:1,lookups:1,downloads:1}); p.context.shutdown();
  assert.equal(Object.keys(p.context.Zotero.Server.Endpoints).length,0);
});
test('native metadata with another DOI and no file result are never reported as available',async()=>{
  const wrong=await plugin({existing:false,metadataDOI:'10.5555/other'});
  assert.equal(body(await wrong.endpoint.init(request())).status,'metadata_not_found'); assert.equal(wrong.log.downloads,0);
  const missing=await plugin({download:()=>false});
  assert.equal(body(await missing.endpoint.init(request())).status,'no_file_found');
});
test('native plugin prevents overlapping requests and resets its busy flag after a native failure',async()=>{
  let release; const p=await plugin({download:()=>new Promise(resolve=>{release=resolve;})});
  const first=p.endpoint.init(request()); while(!release)await Promise.resolve();
  assert.equal((await p.endpoint.init(request()))[0],409); release({key:'ATTACH01'}); await first;
  assert.equal(p.log.downloads,1);
  const broken=await plugin({download:()=>{throw new Error('sensitive native detail');}});
  for(let i=0;i<2;i++){const r=await broken.endpoint.init(request());assert.equal(r[0],500);assert.ok(!r[2].includes('sensitive'));}
});

test('native metadata rejects browser origins, arbitrary URLs and unsupported journals before network access',async()=>{
  const p=await plugin();
  for(const headers of [{origin:'https://example.org','x-office-fetch':'1'},{'sec-fetch-site':'same-origin','x-office-fetch':'1'},{}])
    assert.equal((await p.metadata.init(request({doi:natureDOI},headers)))[0],403);
  for(const data of [null,{doi:'file:///secret'},{doi:'10.1038/nature12345'},{doi:natureDOI,url:'http://127.0.0.1/private'},{doi:natureDOI,script:'code'}])
    assert.equal((await p.metadata.init(request(data)))[0],400);
  assert.deepEqual(p.webLog,{requests:0,translations:0});assert.equal(p.log.downloads,0);
});

test('native metadata uses Web translator with no-save/no-attachment options and returns the complete labeled Abstract',async()=>{
  const abstract='First sentence. '+ 'Complete source text. '.repeat(300)+'Final sentence.';
  const p=await plugin({web:{abstract}}),r=body(await p.metadata.init(request({doi:natureDOI})));
  assert.equal(r.status,'available');assert.equal(r.abstract,abstract);assert.equal(r.abstract_section,'Abstract');
  assert.equal(r.library_writes,0);assert.equal(r.attachment_downloads,0);
  assert.equal(r.source_url,'https://www.nature.com/articles/nphys9999');
  assert.equal(r.abstract_from,'zotero-native-web');assert.deepEqual(r.authors,['First Author']);
  assert.deepEqual(p.webLog,{requests:1,translations:1});assert.deepEqual(p.log,{searches:0,lookups:0,downloads:0});
});

test('native metadata does not treat a challenge, intro-only page or wrong DOI as a source abstract',async()=>{
  for(const [web,status]of [[{title:'Client Challenge',doi:''},'challenge'],[{title:'Just a moment...',doi:''},'challenge'],[{noAbstract:true},'no_abstract'],[{doi:'10.1038/nphys-other'},'identity_mismatch'],[{itemDOI:'10.1038/nphys-other'},'identity_mismatch']]){
    const p=await plugin({web}),r=body(await p.metadata.init(request({doi:natureDOI})));
    assert.equal(r.status,status);assert.equal(r.abstract,undefined);assert.equal(p.webLog.requests,1);assert.equal(p.log.downloads,0);
  }
});

test('native metadata does not mistake an identified publisher article titled Just a moment for a challenge',async()=>{
  const p=await plugin({web:{title:'Just a moment | Nature Physics',noAbstract:true}});
  const r=body(await p.metadata.init(request({doi:natureDOI})));
  assert.equal(r.status,'no_abstract');assert.equal(p.webLog.requests,1);
  assert.equal(p.webLog.translations,0);assert.equal(p.log.downloads,0);
});

test('native metadata stops on source 403/429 without retry or sensitive exception detail',async()=>{
  for(const status of [403,429]){
    const error=Object.assign(new Error('private login token'),{status});
    const p=await plugin({web:{error}}),response=await p.metadata.init(request({doi:natureDOI})),r=body(response);
    assert.equal(r.status,'http_error');assert.equal(r.http_status,status);
    assert.equal(p.webLog.requests,1);assert.equal(p.webLog.translations,0);assert.equal(p.log.downloads,0);
    assert.ok(!response[2].includes('private login token'));
  }
});

test('native metadata and existing PDF fetch share the existing single-operation busy guard',async()=>{
  let release;const p=await plugin({web:{wait:()=>new Promise(r=>{release=r;})}});
  const first=p.metadata.init(request({doi:natureDOI}));while(!release)await Promise.resolve();
  assert.equal((await p.endpoint.init(request()))[0],409);assert.equal((await p.metadata.init(request({doi:natureDOI})))[0],409);
  release();assert.equal(body(await first).status,'available');assert.equal(p.webLog.requests,1);assert.equal(p.log.downloads,0);
});
