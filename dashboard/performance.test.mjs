import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write,sharedReads} from '../automation/files.mjs';
import {createServer,snapshot} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {drain} from '../agent/run.mjs';
import {companionPackage} from './companion-assets.mjs';
const companion=companionPackage();
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --companion-ui --keep');

test('first new-chat avatar loads from its separate image file while queued', {timeout:30000},async()=>{
  const files=['agent/config.json','.runtime/agent/sessions.json','work/queue.json'];
  const originals=Object.fromEntries(files.map(f=>[f,read(f)]));
  write('agent/config.json',{...originals['agent/config.json'],enabled:false});
  write('.runtime/agent/sessions.json',{sessions:[]});write('work/queue.json',{...originals['work/queue.json'],items:[]});
  const htmlFile=path.join(root,'dashboard/index.html'),html=fs.readFileSync(htmlFile,'utf8');
  assert.doesNotMatch(html,/office-user-avatar|data:image\/(?:webp|png|jpeg);base64,/,'HTML must not embed avatar bytes');
  assert.match(html,/<link rel="preload" as="image" type="image\/webp" href="\/avatars\/user\.webp">/);
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=path.join(root,'.runtime/queued-avatar');fs.mkdirSync(dir,{recursive:true});
  let browser;const observations=[];
  try{
    const image=await fetch('http://127.0.0.1:'+server.address().port+'/avatars/user.webp');
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),fs.readFileSync(path.join(root,'dashboard/avatars/user.webp')),'serve the unchanged portrait file');
    browser=await launchEdge();
    for(const width of [1440,390]){
      const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname==='/avatars/user.webp')requests.push(r.url());});
      await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
      await page.route('**/api/companion/notes',r=>r.fulfill({json:{enabled:false,messages:[]}}));
      await page.addInitScript(()=>{
        window.__queuedAvatar={textAt:null,imageAt:null};
        new MutationObserver(()=>{
          const p=window.__queuedAvatar;if(p.textAt!==null)return;
          const img=document.querySelector('.message.user img.who');if(!img)return;
          p.textAt=performance.now();
          const loaded=()=>{if(img.naturalWidth>0)p.imageAt=performance.now();};
          if(img.complete)loaded();else img.addEventListener('load',loaded,{once:true});
        }).observe(document,{childList:true,subtree:true});
      });
      await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded'});
      await page.locator('#message').fill('First queued avatar '+width);
      const received=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat'&&r.request().method()==='POST');
      await page.locator('#send').click();const receipt=await (await received).json();
      assert.equal(receipt.task.status,'queued');
      await page.locator('.task-running').filter({hasText:'等待执行'}).waitFor();
      await page.waitForFunction(()=>Number.isFinite(window.__queuedAvatar.imageAt),{},{timeout:1200});
      assert.match(await page.locator('.task-running').textContent(),/等待执行/);
      const img=page.locator('.message.user img.who');
      assert.equal(await img.getAttribute('src'),'/avatars/user.webp');
      const timing=await page.evaluate(()=>({...window.__queuedAvatar,gapMs:window.__queuedAvatar.imageAt-window.__queuedAvatar.textAt}));
      await page.locator('.message.user').screenshot({path:path.join(dir,`${width}-queued.png`)});
      const queue=read('work/queue.json');queue.items.find(t=>t.id===receipt.task_id).status='active';write('work/queue.json',queue);
      await page.locator('.task-running').filter({hasText:'进行中'}).waitFor({timeout:7000});
      assert.ok(await img.evaluate(e=>e.complete&&e.naturalWidth>0),'avatar remains visible after the status transition');
      assert.equal(requests.length,1,'preload and the message reuse the same external avatar');assert.deepEqual(errors,[]);
      observations.push({width,statusWhenVisible:'queued',...timing,avatarRequests:requests.length,errors});
      await context.close();
    }
    fs.writeFileSync(path.join(dir,'timings.json'),JSON.stringify(observations,null,2));
  }finally{await browser?.close();await new Promise(r=>server.close(r));for(const [f,v] of Object.entries(originals))write(f,v);}
});

test('retired text adventure has no loaded code, page, state or HTTP entry; stored data remains untouched',async()=>{
  const file='.runtime/adventure/saves.json',before=read(file),saved={games:[{id:'retired-fixture',messages:[{text:'preserved fictional save'}]}]};
  write(file,saved);
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    for(const p of ['adventure','dashboard/adventure.js','dashboard/adventure.css','dashboard/adventure.test.mjs'])assert.equal(fs.existsSync(path.join(root,p)),false,p);
    for(const url of ['/api/adventure','/adventure.js','/adventure.css'])assert.equal((await fetch(base+url)).status,404,url);
    for(const url of ['/api/adventure/start','/api/adventure/action','/api/adventure/stop'])assert.equal((await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404,url);
    assert.equal((await (await fetch(base+'/api/state')).json()).adventure,undefined);
    assert.doesNotMatch(await (await fetch(base)).text(),/adventure.css|page-adventure|adventure-body/);
    assert.doesNotMatch(await (await fetch(base+'/app.js')).text(),/bindAdventure|adventureUI/);
    assert.deepEqual(read(file),saved);
  }finally{
    await new Promise(r=>server.close(r));
    if(before===undefined)fs.unlinkSync(path.join(root,file));else write(file,before);
  }
});

test('an idle scheduler reads the stores a bounded number of times, not once per historical conversation',async()=>{
  const files=['work/queue.json','.runtime/agent/sessions.json','agent/config.json'];
  const originals=Object.fromEntries(files.map(f=>[f,read(f)]));
  const oldRead=fs.readFileSync;let sessionReads=0;
  try{
    write('work/queue.json',{...originals['work/queue.json'],items:[]});
    write('.runtime/agent/sessions.json',{sessions:Array.from({length:55},(_,i)=>({id:'idle-'+i,task_ids:['finished-'+i]}))});
    write('agent/config.json',{...originals['agent/config.json'],enabled:true});
    fs.readFileSync=function(file,...args){if(String(file).endsWith(path.join('agent','sessions.json')))sessionReads++;return oldRead.call(this,file,...args);};
    await drain(async()=>{throw new Error('idle scheduler must never start a model');});
    assert.ok(sessionReads<=3,`historical sessions caused ${sessionReads} full store reads`);
  }finally{fs.readFileSync=oldRead;for(const [file,value] of Object.entries(originals))write(file,value);}
});

test('state snapshot parses each store once, keeps raw activity private, and shared reads never outlive the call',()=>{
  const files=['.runtime/agent/sessions.json'],originals=Object.fromEntries(files.map(f=>[f,read(f)]));
  const oldRead=fs.readFileSync;let sessionReads=0;
  const events=(n,offset)=>Array.from({length:n},(_,i)=>({type:'tool',name:'Edit',at:new Date(Date.UTC(2026,9,11,0,0,offset+i)).toISOString()}));
  try{
    // A large raw activity history must not travel in the UI payload.
    const sessions=Array.from({length:55},(_,i)=>({id:'busy-'+i,title:'t',task_ids:[],messages:[],project_ids:[],activity:events(50,i*3)}));
    write('.runtime/agent/sessions.json',{sessions});
    fs.readFileSync=function(file,...args){if(String(file).endsWith(path.join('agent','sessions.json')))sessionReads++;return oldRead.call(this,file,...args);};
    const first=snapshot();
    assert.ok(sessionReads<=1,`one snapshot read the session store ${sessionReads} times`);
    fs.readFileSync=oldRead;
    assert.ok(first.agent.sessions.every(s=>s.activity===undefined),'raw per-session tool details are private');
    assert.deepEqual(first.agent.executions,[],'no associated work means no invented task execution');
    assert.equal(JSON.stringify(first.agent.sessions.map(s=>s.id)),JSON.stringify(sessions.map(s=>s.id)));
    // Outside a snapshot every read is fresh and sees the latest write.
    const a=read('.runtime/agent/sessions.json'),b=read('.runtime/agent/sessions.json');
    assert.notEqual(a,b);
    write('.runtime/agent/sessions.json',{sessions:[]});
    assert.equal(snapshot().agent.sessions.length,0);
    // Inside one scope reads share a parse, but a write invalidates it.
    sharedReads(()=>{
      assert.equal(read('.runtime/agent/sessions.json'),read('.runtime/agent/sessions.json'));
      write('.runtime/agent/sessions.json',{sessions:[{id:'new'}]});
      assert.equal(read('.runtime/agent/sessions.json').sessions[0].id,'new');
    });
  }finally{fs.readFileSync=oldRead;for(const [file,value] of Object.entries(originals))write(file,value);}
});
test('image validators reuse bytes and notice replacements; private responses are not cached',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    for(const url of ['/avatars/codex.webp',...(companion ? ['/companion/assets/hall/bg.png'] : [])]){
      const first=await fetch(base+url),bytes=Buffer.from(await first.arrayBuffer());
      assert.ok(first.headers.get('etag'),url+' needs a validator');
      assert.equal(first.headers.get('cache-control'),'private, no-cache');
      const cached=await fetch(base+url,{headers:{'if-none-match':first.headers.get('etag')}});
      assert.equal(cached.status,304);assert.equal((await cached.arrayBuffer()).byteLength,0);
      const file=companion?.assets.get(url) ?? path.join(root,'dashboard',url);
      assert.ok(file.startsWith(path.resolve(root)+path.sep),'replacement tests must only edit their isolated resource copy');
      const original=fs.readFileSync(file);
      try{
        fs.writeFileSync(file,Buffer.concat([original,Buffer.from('fixture replacement')]));
        const replaced=await fetch(base+url,{headers:{'if-none-match':first.headers.get('etag')}});
        assert.equal(replaced.status,200);assert.notEqual(replaced.headers.get('etag'),first.headers.get('etag'));
        assert.notDeepEqual(Buffer.from(await replaced.arrayBuffer()),bytes);
      }finally{fs.writeFileSync(file,original);}
    }
    for(const url of ['/api/state','/health'])assert.equal((await fetch(base+url)).headers.get('cache-control'),'no-store',url);
    // Scripts and styles are revalidated, not stored blind: a change shows on refresh, an unchanged file costs a 304.
    for(const url of ['/app.js','/style.css',...(companion ? ['/companion/scene-kit.js'] : [])]){
      const first=await fetch(base+url);
      assert.equal(first.headers.get('cache-control'),'private, no-cache',url);
      assert.ok(first.headers.get('etag'),url);
      assert.equal((await fetch(base+url,{headers:{'if-none-match':first.headers.get('etag')}})).status,304,url);
    }
  }finally{await new Promise(r=>server.close(r));}
});
test('large text and JSON responses are gzipped for clients that accept it, and decode to identical content',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,get=(p,enc)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:p,headers:{'accept-encoding':enc}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({headers:res.headers,status:res.statusCode,body:Buffer.concat(chunks)}));}).on('error',reject));
  try{
    for(const url of ['/api/state?page=chat','/app.js','/']){
      const plain=await get(url,'identity'),zipped=await get(url,'gzip, deflate');
      assert.equal(plain.headers['content-encoding'],undefined,url);
      assert.equal(zipped.headers['content-encoding'],'gzip',url);
      assert.match(zipped.headers.vary,/Accept-Encoding/i);
      assert.ok(zipped.body.length<plain.body.length,url+' did not shrink');
      if(url==='/app.js')assert.ok(gunzipSync(zipped.body).equals(plain.body),'gzip must decode to the same bytes');
      else assert.ok(gunzipSync(zipped.body).length>0);
    }
    // Small bodies, binary images and streamed downloads are left alone.
    assert.equal((await get('/health','gzip')).headers['content-encoding'],undefined);
    assert.equal((await get('/avatars/codex.webp','gzip')).headers['content-encoding'],undefined);
  }finally{await new Promise(r=>server.close(r));}
});

test('startup paints saved chat while capabilities and markdown are delayed, then upgrades without losing the draft or reading position', {timeout:30000},async()=>{
  const files=['.runtime/agent/sessions.json','agent/config.json'],originals=Object.fromEntries(files.map(f=>[f,read(f)]));
  const at='2026-10-12T12:00:00Z';
  write('agent/config.json',{...originals['agent/config.json'],enabled:false});
  write('.runtime/agent/sessions.json',{sessions:[{id:'startup-chat',title:'Startup fixture',origin:'chat',project_ids:[],task_ids:[],created_at:at,
    messages:[{role:'user',text:'Saved startup message',at},...Array.from({length:30},(_,i)=>({role:'assistant',provider:'codex',text:'### Loaded heading '+i+'\n\n'+'.'.repeat(700),at}))]}]});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser,page,releaseHealth,releaseMarkdown,healthSeen,markdownSeen,stateSeen;
  const healthGate=new Promise(r=>releaseHealth=r),markdownGate=new Promise(r=>releaseMarkdown=r);
  const healthRequested=new Promise(r=>healthSeen=r),markdownRequested=new Promise(r=>markdownSeen=r),stateRequested=new Promise(r=>stateSeen=r);
  try{
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1050}});
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','startup-chat');});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route('**/health',async r=>{healthSeen();await healthGate;await r.continue();});
    await page.route('**/markdown.js',async r=>{markdownSeen();await markdownGate;await r.continue();});
    page.on('request',r=>{if(new URL(r.url()).pathname==='/api/state')stateSeen();});
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded'});
    await healthRequested;
    let timeout;const started=await Promise.race([stateRequested.then(()=>true),new Promise(r=>timeout=setTimeout(()=>r(false),1200))]);clearTimeout(timeout);
    assert.equal(started,true,'initial state must start before a delayed health response');
    await page.locator('.message-text').filter({hasText:'Saved startup message'}).waitFor({timeout:1500});
    await page.waitForFunction(()=>{const im=document.querySelector('.message.user img.who');return im.complete&&im.naturalWidth>0;});
    assert.equal(await page.locator('.message-text h3').count(),0,'plain saved content is available before markdown');
    await page.locator('#message').fill('Keep my startup draft');
    await page.locator('#transcript').evaluate(e=>e.scrollTop=0);
    releaseHealth();await markdownRequested;
    assert.equal(await page.locator('.message-text h3').count(),0,'slow optional renderer must not hold the saved content blank');
    releaseMarkdown();await page.locator('.message-text h3').first().waitFor();
    assert.equal(await page.locator('.message-text h3').count(),30,'all saved messages receive the real markdown renderer');
    assert.equal(await page.locator('#message').inputValue(),'Keep my startup draft');
    assert.equal(await page.locator('#transcript').evaluate(e=>e.scrollTop),0,'renderer upgrade must preserve a scrolled reading position');
    const dir=path.join(root,'.runtime/performance-review');fs.mkdirSync(dir,{recursive:true});
    await page.screenshot({path:path.join(dir,'startup-chat.png')});
    await page.locator('#message').fill('Markdown **does not touch** the composer');
    assert.equal(await page.locator('#message').inputValue(),'Markdown **does not touch** the composer');
  }finally{
    releaseHealth();releaseMarkdown();await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await new Promise(r=>server.close(r));
    for(const [file,value] of Object.entries(originals))write(file,value);
  }
});

test('new-chat background and idle frames start together, and a late renderer keeps the same scene and draft', {timeout:30000,skip:!companion},async()=>{
  const files=['.runtime/agent/sessions.json','agent/config.json'],originals=Object.fromEntries(files.map(f=>[f,read(f)]));
  write('agent/config.json',{...originals['agent/config.json'],enabled:false});write('.runtime/agent/sessions.json',{sessions:[]});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser,page,releaseBackground,releaseMarkdown,backgroundSeen,idleSeen;
  const backgroundGate=new Promise(r=>releaseBackground=r),markdownGate=new Promise(r=>releaseMarkdown=r);
  const backgroundRequested=new Promise(r=>backgroundSeen=r),idleRequested=new Promise(r=>idleSeen=r);
  const errors=[];
  try{
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1050}});
    await page.addInitScript(()=>{if(location.pathname==='/companion/index.html')Math.random=()=>.375;});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route('**/markdown.js',async r=>{await markdownGate;await r.continue();});
    await page.route('**/companion/assets/hall/bg.png',async r=>{backgroundSeen();await backgroundGate;await r.continue();});
    page.on('request',r=>{if(new URL(r.url()).pathname==='/companion/assets/chars/user/idle_anim/f0.png')idleSeen();});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded'});
    await backgroundRequested;
    let timeout;const parallel=await Promise.race([idleRequested.then(()=>true),new Promise(r=>timeout=setTimeout(()=>r(false),1200))]);clearTimeout(timeout);
    assert.equal(parallel,true,'idle frames must start while the scene background is still pending');
    releaseBackground();
    const frame=page.frames().find(f=>f.url().includes('/companion/index.html'));
    await frame.waitForFunction(()=>window.__scene?.player);
    const original=await page.locator('.companion-frame').elementHandle();
    await page.locator('#message').fill('Keep my new-chat draft');
    releaseMarkdown();await page.evaluate(()=>import('/markdown.js').then(()=>true));
    assert.equal(await original.evaluate(e=>e.isConnected),true,'rich-text availability must not replace or reroll an already-running empty-chat scene');
    assert.equal(await frame.evaluate(()=>__picker.current),'hall');
    assert.equal(await page.locator('#message').inputValue(),'Keep my new-chat draft');
    assert.equal(await frame.evaluate(()=>SCENE_HALL.characters.user.sprites.idle.frames.length),8);
    assert.deepEqual(errors,[]);
    const dir=path.join(root,'.runtime/performance-review');fs.mkdirSync(dir,{recursive:true});
    await page.screenshot({path:path.join(dir,'startup-scene.png')});
  }finally{
    releaseBackground();releaseMarkdown();await page?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await new Promise(r=>server.close(r));
    for(const [file,value] of Object.entries(originals))write(file,value);
  }
});

test('large-office chat starts before extra sprites and renders saved sends despite a stale in-flight poll', {timeout:60000,skip:!companion},async()=>{
  const originals=Object.fromEntries(['work/queue.json','.runtime/agent/sessions.json','agent/config.json'].map(f=>[f,read(f)]));
  write('agent/config.json',{...originals['agent/config.json'],enabled:false});
  const at='2026-10-11T12:00:00Z';
  write('.runtime/agent/sessions.json',{sessions:Array.from({length:55},(_,i)=>({id:'perf-'+i,title:'Fixture conversation '+i,origin:'chat',project_ids:[],task_ids:[],created_at:at,messages:Array.from({length:54},(_,j)=>({role:j%2?'assistant':'user',provider:j%2?'codex':undefined,text:'Fixture message '+j+' '+'.'.repeat(700),at}))}))});
  write('work/queue.json',{...originals['work/queue.json'],items:Array.from({length:800},(_,i)=>({id:'perf-task-'+i,title:'Fixture completed '+i,status:'done',actor:'codex',project_ids:[],dependencies:[],outputs:[],handoff:'Fixture handoff '+'.'.repeat(2000),completed_at:at}))});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;let browser,releasePoll,releaseSprites;
  const pollGate=new Promise(r=>releasePoll=r),spriteGate=new Promise(r=>releaseSprites=r);
  const dir=path.join(root,'.runtime/performance-review');fs.mkdirSync(dir,{recursive:true});
  try{
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],requested=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requested.push(new URL(r.url()).pathname));
    await page.addInitScript(()=>{
      if(location.pathname==='/companion/index.html')Math.random=()=>.375;
      if(location.pathname!=='/')return;
      window.__firstAvatarProbe={textAt:null,imageAt:null,paintAt:null};
      new MutationObserver(()=>{
        const probe=window.__firstAvatarProbe;
        if(probe.textAt!==null)return;
        const message=[...document.querySelectorAll('.message.user')].find(m=>m.querySelector('.message-text')?.textContent.trim()==='saved receipt visible before stale poll');
        if(!message)return;
        probe.textAt=performance.now();
        const image=message.querySelector('img.who');
        const loaded=()=>{if(image.naturalWidth>0){probe.imageAt=performance.now();requestAnimationFrame(()=>probe.paintAt=performance.now());}};
        if(image.complete)loaded();else image.addEventListener('load',loaded,{once:true});
      }).observe(document,{childList:true,subtree:true});
    });
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.route('**/api/companion/notes',r=>r.fulfill({json:{enabled:false,messages:[]}}));
    await page.route('**/companion/assets/chars/**',async r=>{
      if(!r.request().url().includes('/idle_anim/'))await spriteGate;
      await r.continue();
    });
    const started=Date.now();await page.goto(base,{waitUntil:'domcontentloaded'});
    const frame=page.frameLocator('.companion-frame');
    await frame.locator('.sk-canvas').waitFor();
    const scene=page.frames().find(f=>f.url().includes('/companion/index.html'));
    await scene.waitForFunction(()=>window.__scene?.player,{},{timeout:2500});
    const sceneMs=Date.now()-started;
    assert.ok(!requested.some(p=>p.includes('/assets/chars/sol/')),'hall must not load the absent Sol');
    releaseSprites();await scene.waitForFunction(()=>__scene.npcs[0].frameIndex>0);
    await page.locator('#message').fill('draft survives ordinary polling');
    let held=false,holdReady,oldRequest;const pollCaptured=new Promise(r=>holdReady=r);
    await page.route('**/api/state*',async r=>{
      if(!held){held=true;oldRequest=r.request();const old=await r.fetch();holdReady();await pollGate;await r.fulfill({response:old});}
      else await r.continue();
    });
    await pollCaptured;
    assert.equal(await page.locator('#message').inputValue(),'draft survives ordinary polling');
    await page.locator('#message').fill('saved receipt visible before stale poll');
    const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat'&&r.request().method()==='POST');
    const sendAt=Date.now();await page.locator('#send').click();const receipt=await (await reply).json();
    assert.ok(receipt.session?.messages.some(m=>m.text==='saved receipt visible before stale poll'),'actual HTTP route returns saved conversation');
    assert.ok(receipt.task?.id===receipt.task_id);
    assert.equal(receipt.session.file_snapshots,undefined);
    await page.locator('.message-text').filter({hasText:'saved receipt visible before stale poll'}).waitFor({timeout:1500});
    const visibleMs=Date.now()-sendAt;
    await page.waitForFunction(()=>Number.isFinite(window.__firstAvatarProbe?.paintAt),{},{timeout:1500});
    const firstAvatar=await page.evaluate(()=>{
      const probe=window.__firstAvatarProbe;
      return {...probe,gapMs:probe.imageAt-probe.textAt,paintGapMs:probe.paintAt-probe.textAt,
        requests:performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname==='/avatars/user.webp')
          .map(r=>({startMs:r.startTime,responseEndMs:r.responseEnd,transferBytes:r.transferSize}))};
    });
    assert.ok(firstAvatar.imageAt>=firstAvatar.textAt,'measure the first sent message, not the existing conversation or scene');
    await page.screenshot({path:path.join(dir,'first-message-avatar.png')});
    await page.waitForFunction(()=>!document.getElementById('message').disabled);
    const stale=oldRequest.response(); // Cancellation is also a valid way to reject an obsolete poll.
    releasePoll();const oldResponse=await stale;if(oldResponse)await oldResponse.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.message-text').filter({hasText:'saved receipt visible before stale poll'}).count(),1,'late old snapshot cannot erase the accepted message');
    await page.locator('[data-page="chat"]').first().click();
    await page.locator('#message').fill('second saved message');await page.locator('#send').click();
    await page.locator('.message-text').filter({hasText:'second saved message'}).waitFor();
    await page.screenshot({path:path.join(dir,'saved-chat.png')});
    await page.route('**/api/chat',r=>r.fulfill({status:400,json:{error:'fixture rejected request'}}));
    await page.locator('#message').fill('rejected text stays a draft');await page.locator('#send').click();
    await page.locator('#error').filter({hasText:'fixture rejected request'}).waitFor();
    assert.equal(await page.locator('#message').inputValue(),'rejected text stays a draft');
    assert.equal(await page.locator('.message-text').filter({hasText:'rejected text stays a draft'}).count(),0,'failed submissions must not be shown as saved');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(dir,'timings.json'),JSON.stringify({synthetic:{sessions:55,messages:2970,tasks:800},sceneMs,visibleMs,firstAvatar,errors},null,2));
  }finally{
    releasePoll();releaseSprites();await browser?.close();await new Promise(r=>server.close(r));
    for(const [file,value] of Object.entries(originals))write(file,value);
  }
});
