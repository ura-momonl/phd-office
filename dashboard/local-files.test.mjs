// Run via scripts/run-tests.mjs (sanitised copy): starts the real dashboard server.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import {root} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {resolveLocalFile,resolveWorkspaceFile,revealInExplorer,openInDefaultApp} from './local-files.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');

test('resolveLocalFile opens any local drive path but hides internal state and credentials',()=>{
  const profile=path.join(root,'AGENTS.md');
  assert.equal(resolveLocalFile(profile).toLowerCase(),profile.toLowerCase());
  assert.equal(resolveLocalFile(profile.replace(/\\/g,'/')).toLowerCase(),profile.toLowerCase());
  // Denied fixtures must exist, otherwise "missing" would pass for the wrong reason.
  const internal=path.join(root,'.runtime','zz-local-file-test.txt'),secret=path.join(root,'zz-secret-test.txt');
  fs.mkdirSync(path.dirname(internal),{recursive:true});fs.writeFileSync(internal,'x');fs.writeFileSync(secret,'x');
  try {
    for(const bad of ['relative/file.txt','',internal,secret,path.join(root,'.runtime'),'\\\\server\\share\\x.txt'])
      assert.throws(()=>resolveLocalFile(bad),undefined,bad);
    assert.throws(()=>resolveLocalFile(internal),/安全/);
    // 2026-10-20: the folder limit is lifted, so a file outside the office tree opens; a credential name or .git folder there stays closed.
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'phd-open-outside-')),ok=path.join(outDir,'note.txt'),key=path.join(outDir,'server.key');
    fs.mkdirSync(path.join(outDir,'.git'));const inGit=path.join(outDir,'.git','config.txt');
    for(const f of [ok,key,inGit])fs.writeFileSync(f,'x');
    try {
      assert.equal(resolveLocalFile(ok).toLowerCase(),fs.realpathSync.native(ok).toLowerCase());
      for(const bad of [key,inGit])assert.throws(()=>resolveLocalFile(bad),/安全/,bad);
    } finally {fs.rmSync(outDir,{recursive:true,force:true});}
  } finally {fs.rmSync(internal,{force:true});fs.rmSync(secret,{force:true});}
});

test('Zotero storage PDFs are openable but the rest of its folder stays closed',()=>{
  const dir=path.join(root,'.runtime','zotero-pilot','data','storage','ZZTEST01');
  const pdf=path.join(dir,'paper.pdf'),txt=path.join(dir,'note.txt'),db=path.join(root,'.runtime','zotero-pilot','data','zz-test.pdf');
  fs.mkdirSync(dir,{recursive:true});for(const f of [pdf,txt,db])fs.writeFileSync(f,'x');
  try {
    assert.equal(resolveLocalFile(pdf).toLowerCase(),pdf.toLowerCase());
    for(const bad of [txt,db,dir])assert.throws(()=>resolveLocalFile(bad),/安全/,bad);
  } finally {fs.rmSync(path.join(root,'.runtime','zotero-pilot','data','storage','ZZTEST01'),{recursive:true,force:true});fs.rmSync(db,{force:true});}
});

test('/api/local-file serves allowed files with safe headers and refuses the rest',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,get=(file,headers)=>fetch(base+'/api/local-file?path='+encodeURIComponent(file),{headers});
  try {
    const profile=path.join(root,'AGENTS.md');
    const text=await get(profile);
    assert.equal(text.status,200);assert.match(text.headers.get('content-type'),/^text\/plain/);assert.equal(text.headers.get('content-security-policy'),'sandbox');
    const image=await get(path.join(root,'dashboard','avatars','claude.webp'));
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
    const script=await get(path.join(root,'dashboard','app.js'));
    assert.match(script.headers.get('content-type'),/^text\/plain/,'scripts display as text, never execute in the dashboard origin');
    const sneaky=await get(path.join(root,'dashboard','index.html'));
    assert.equal(sneaky.status,200);assert.match(sneaky.headers.get('content-disposition'),/^attachment/);
    for(const bad of [path.join(root,'.runtime','discord.env'),path.join(root,'.runtime')])assert.equal((await get(bad)).status,400,bad);
    // The browser shows no folder pages; the chat offers Explorer for those.
    const folder=await get(path.join(root,'dashboard'));
    assert.equal(folder.status,400);assert.match((await folder.json()).error,/资源管理器/);
    assert.equal((await get(profile,{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await get(profile,{'Sec-Fetch-Site':'same-origin'})).status,200);
    // fetch cannot forge Host, so a raw request stands in for a DNS-rebinding page.
    const rebinding=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/api/local-file?path='+encodeURIComponent(profile),headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    assert.equal(rebinding,403);
    // The phone's tailnet Host reads files (the forwarder connects from loopback); look-alike hosts and cross-site requests do not.
    const withHost=(Host,extra={})=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/api/local-file?path='+encodeURIComponent(profile),headers:{Host,...extra}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    for(const ok of ['kemono.tail7de0a6.ts.net','kemono.tail7de0a6.ts.net:8081','100.68.133.127:8081','100.64.0.1','100.127.255.254'])assert.equal(await withHost(ok),200,ok);
    for(const bad of ['evil.example','ts.net.evil.example','evilts.net','100.63.0.1','100.128.0.1','101.68.133.127','10.0.0.1','1100.68.133.127'])assert.equal(await withHost(bad),403,bad);
    assert.equal(await withHost('kemono.tail7de0a6.ts.net',{'Sec-Fetch-Site':'cross-site'}),403);
  } finally {await new Promise(r=>server.close(r));}
});

test('workspace URLs reuse file security and native open requires a local, same-origin POST',async()=>{
  const dir=path.join(root,'workspace','outbox','local-open-test'),file=path.join(dir,'全文 待办.md');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,'中文工作区文件\n');
  const calls=[],run=(exe,args,options,done)=>{calls.push({exe,args,options});done(null,'','');};
  const server=createServer({openLocalFile:file=>openInDefaultApp(file,{run})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,base=`http://127.0.0.1:${port}`,url='/workspace/outbox/local-open-test/'+encodeURIComponent(path.basename(file));
  const post=(body,headers={Origin:base})=>fetch(base+'/api/local-file/open',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  try {
    assert.equal(resolveWorkspaceFile(url),resolveLocalFile(file));
    const response=await fetch(base+url);
    assert.equal(response.status,200);assert.equal(await response.text(),fs.readFileSync(file,'utf8'));
    assert.match(response.headers.get('content-type'),/^text\/plain/);
    assert.equal(calls.length,0,'GET previews never launch a program');
    assert.equal((await post({url})).status,200);
    assert.equal((await post({path:file})).status,200);
    assert.equal(calls.length,2);
    for(const headers of [{},{Origin:'https://evil.example'},{Origin:base,'Sec-Fetch-Site':'cross-site'}]) {
      // Sec-Fetch-Site is an additional boundary, not a substitute for Origin.
      assert.equal((await post({path:file},headers)).status,403);
    }
    for(const bad of [url.replace(/[^/]+$/,'missing.md'),'/workspace/%2e%2e%2fAGENTS.md','/workspace/..%5cAGENTS.md','/workspace/%00.md','/workspace/%ZZ','/workspace/C:%5cWindows/win.ini'])assert.throws(()=>resolveWorkspaceFile(bad),undefined,bad);
    for(const body of [{path:file,url},{url:'/workspace/../AGENTS.md'},{path:path.join(root,'.runtime')},{path:path.join(root,'dashboard','app.js')}])assert.equal((await post(body)).status,400,JSON.stringify(body));
    assert.equal((await fetch(base+'/api/local-file/open')).status,404,'GET cannot launch');
    assert.equal((await fetch(base+url,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(base+'/workspace/outbox/local-open-test/missing.md')).status,400);
    const blocked=path.join(dir,'secret.txt');fs.writeFileSync(blocked,'private');
    assert.equal((await fetch(base+'/workspace/outbox/local-open-test/secret.txt')).status,400);
    const outside=path.join(root,'AGENTS.md'),junction=path.join(dir,'escape');
    fs.symlinkSync(path.dirname(outside),junction,'junction');
    assert.throws(()=>resolveWorkspaceFile('/workspace/outbox/local-open-test/escape/AGENTS.md'),/越界/);
    assert.equal(calls.length,2,'refused paths and requests never launch');
  } finally {await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('default-app launcher passes only a literal real document path and reports association failure',async()=>{
  const file=path.join(root,"中文 空格'&$;验证.txt"),calls=[];
  fs.writeFileSync(file,'fixture');
  const run=(exe,args,options,done)=>{calls.push({exe,args,options});done(null,'','');};
  try {
    assert.equal((await openInDefaultApp(file,{run})).started,true);
    const call=calls[0],script=Buffer.from(call.args.at(-1),'base64').toString('utf16le');
    assert.equal(call.options.env.OFFICE_LOCAL_OPEN_PATH,resolveLocalFile(file));
    assert.equal(call.options.windowsHide,true);assert.equal(call.options.shell,undefined);
    assert.match(script,/UseShellExecute=\$true/);assert.match(script,/Verb='open'/);
    assert.ok(!script.includes(file));assert.ok(!call.args.some(x=>/bypass/i.test(x)));
    for(const name of ['program.exe','shortcut.lnk','script.ps1','script.bat','script.cmd','script.py','script.js','page.html','page.svg','document.docm','unknown.xyz']) {
      const bad=path.join(root,name);fs.writeFileSync(bad,'fixture');
      try {await assert.rejects(openInDefaultApp(bad,{run}),/文件类型/);}finally{fs.rmSync(bad);}
    }
    await assert.rejects(openInDefaultApp(file,{run,platform:'linux'}),/Windows/);
    await assert.rejects(openInDefaultApp(file,{run:(exe,args,options,done)=>done(new Error('failed'),'','no association')}),/no association/);
    assert.equal(calls.length,1);
  } finally {fs.rmSync(file,{force:true});}
});

test('registered Command Code key opens only in local Notepad; HTTP reads and other internal files remain closed',async()=>{
  const file=path.join(root,'.runtime/commandcode/credentials.json'),other=path.join(root,'.runtime/commandcode/other.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({api_key:'fixture-never-in-http'}));fs.writeFileSync(other,'{}');
  const calls=[],run=(exe,args,options,done)=>{calls.push({exe,args,options});done(null,'','');};
  const server=createServer({openLocalFile:file=>openInDefaultApp(file,{run})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const post=(p,origin=base)=>fetch(base+'/api/local-file/open',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({path:p})});
  try {
    assert.throws(()=>resolveLocalFile(file),/安全/);
    const response=await post(file);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/fixture-never-in-http/);
    assert.equal(calls.length,1);assert.equal(calls[0].options.env.OFFICE_LOCAL_OPEN_PATH,file);
    const script=Buffer.from(calls[0].args.at(-1),'base64').toString('utf16le');
    assert.match(script,/notepad\.exe/);assert.ok(!script.includes(file));
    assert.equal((await fetch(base+'/api/local-file?path='+encodeURIComponent(file))).status,400);
    assert.equal((await post(file,'http://evil.example')).status,403);
    assert.equal((await post(other)).status,400);
    assert.throws(()=>revealInExplorer(file),/安全/);
    const directory=path.dirname(file),saved=directory+'-saved';
    fs.renameSync(directory,saved);fs.symlinkSync(saved,directory,'junction');
    try {assert.equal((await post(file)).status,400,'an allowlisted filename cannot disguise a different real file');}
    finally {fs.rmdirSync(directory);fs.renameSync(saved,directory);}
    assert.equal(calls.length,1);
  } finally {await new Promise(r=>server.close(r));fs.rmSync(file,{force:true});fs.rmSync(other,{force:true});}
});

test('Explorer reveal passes one verbatim argument, honours the path rules and never launches for refused requests',async()=>{
  const calls=[],launch=(exe,args,options)=>{calls.push({exe,args,options});return {on(){},unref(){}};};
  const file=path.join(root,'AGENTS.md'),dir=path.join(root,'dashboard');
  assert.equal(revealInExplorer(file,{launch}).started,true);
  assert.equal(revealInExplorer(dir,{launch}).started,true);
  assert.match(calls[0].exe,/explorer.exe$/i);
  assert.deepEqual(calls[0].args,['/select,"'+resolveLocalFile(file)+'"']);
  assert.deepEqual(calls[1].args,['"'+resolveLocalFile(dir)+'"']);
  assert.equal(calls[0].options.windowsVerbatimArguments,true);
  assert.equal(calls[0].options.shell,undefined,'never through a shell');
  assert.throws(()=>revealInExplorer(path.join(root,'.runtime'),{launch}));
  assert.throws(()=>revealInExplorer(file,{launch,platform:'linux'}));
  assert.equal(calls.length,2,'refused paths never reached the launcher');

  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,post=(headers,body)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:'/api/local-file/reveal',method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  try {
    // Only refused requests are sent: a granted one would open a real Explorer window.
    assert.equal(await post({Host:'127.0.0.1:'+port},{path:file}),403,'no Origin');
    assert.equal(await post({Host:'127.0.0.1:'+port,Origin:'http://evil.example'},{path:file}),403,'foreign Origin');
    assert.equal(await post({Host:'evil.example',Origin:'http://evil.example'},{path:file}),403,'rebinding Host');
    assert.equal(await post({Host:'127.0.0.1:'+port,Origin:'http://127.0.0.1:'+port},{path:path.join(root,'.runtime')}),400,'internal state');
  } finally {await new Promise(r=>server.close(r));}
});
