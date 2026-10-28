import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs --companion-ui --keep');

test('scene assets are served locally with correct MIME and cannot expose source data or tokens',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    for(const [route,mime] of [['index.html','text/html'],['scene-kit.js','text/javascript'],['scene-kit.css','text/css'],['scenes/hall.js','text/javascript'],['scenes/postapocalyptic.js','text/javascript'],['assets/sunset-diner/bg.png','image/png'],['assets/rainy-station/bg.png','image/png'],['assets/hall/bg.png','image/png'],['assets/chars/claude/walk_right_anim/f7.png','image/png'],['assets/chars/sol/sip_anim/f7.png','image/png'],['assets/chars/sol/touch_hair_anim/f7.png','image/png'],['assets/chars/claude/idle_anim/f7.png','image/png'],['assets/chars/claude/chin_think_anim/f7.png','image/png'],['assets/chars/claude/palm_up_shrug_anim/f7.png','image/png'],['assets/chars/claude/double_peace_anim/f7.png','image/png'],['assets/chars/claude/held_item_show_anim/f7.png','image/png'],['assets/chars/claude/surprised_palms_anim/f7.png','image/png'],['assets/chars/sol/jacket_tidy_anim/f7.png','image/png'],['assets/chars/sol/polite_bow_anim/f7.png','image/png'],['assets/chars/user/shy_sweet_anim/f7.png','image/png']]){
      const r=await fetch(base+'/companion/'+route);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(mime));
      assert.deepEqual(Buffer.from(await r.arrayBuffer()),fs.readFileSync(path.join(root,'dashboard/companion',route)));
    }
    assert.equal((await (await fetch(base+'/health')).json()).companion_scenes,true);
    for(const route of ['/companion/README.md','/companion/tests/animation.test.mjs','/companion/..%2f..%2fagent/config.json','/companion/%2e%2e/%2e%2e/work/queue.json','/companion/assets/chars/user/idle_anim/f8.png','/companion/.private/pixellab-token.dpapi'])assert.equal((await fetch(base+route)).status,404,route);
  }finally{await new Promise(r=>server.close(r));}
});

test('new-chat random scenes run without switches or scrollbars: extra actions, roam, talk, polling, teardown, draft and responsive sizes', {timeout:180000},async()=>{
  const cfg=read('agent/config.json');write('agent/config.json',{...cfg,enabled:true});
  const noteCalls=[];
  write('.runtime/agent/sessions.json',{sessions:[{id:'companion-test',title:'界面验收旧对话',origin:'chat',project_ids:[],task_ids:[],created_at:new Date().toISOString(),messages:[{role:'user',text:'原有的聊天内容不变',at:new Date().toISOString()}]}]});
  const before={queue:read('work/queue.json'),sessions:read('.runtime/agent/sessions.json')};
  const dir=path.join(root,'.runtime/companion-review');fs.mkdirSync(dir,{recursive:true});
  const server=createServer({noteRunner:async(provider,prompt)=>{
    if(noteCalls.length===1)assert.ok(prompt.includes(noteCalls[0]==='codex'?'薄荷色的抱抱':'安静的陪伴'),'follower receives the first actual note through the HTTP route');
    noteCalls.push(provider);return {result:provider==='codex' ? '我想把今天的小角落留得软一些。你经过的时候，不用想着说什么，随手碰一下我就好。薄荷色的抱抱放在这里，不限领取次数。' : '这张纸条没有问题需要你回答。我只是想留一点安静的陪伴给你：可以发呆，可以乱想，也可以只坐一小会儿。\n\n你愿意说时，我再认真听。',toolCalls:0};
  },noteRandom:()=>Math.random()<.5 ? 0 : .99});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;let browser,page,weatherEvidence;const errors=[],posts=[],scenePosts=[],missing=[];
  try{
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1050}});
    // Control only randomness, not the production scene entry or sizing path.
    await page.addInitScript(()=>{if(location.pathname==='/companion/index.html'){
      let calls=0,seed=123;Math.random=()=>calls++===0?.375:((seed=(1664525*seed+1013904223)>>>0)/2**32);
    }});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'){posts.push(new URL(r.url()).pathname);if(r.frame().url().includes('/companion/'))scenePosts.push(new URL(r.url()).pathname);}});
    page.on('response',r=>{if(r.status()>=400)missing.push(new URL(r.url()).pathname);});
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.goto(base);await page.locator('.companion-frame').waitFor();
    assert.equal(await page.getByRole('heading',{name:'今天，先推进什么？'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'开始第一夜',exact:true}).count(),0);
    assert.equal(await page.locator('.suggestions').count(),0);
    await page.locator('#message').fill('保留工作输入草稿');
    await page.frameLocator('.companion-frame').locator('.sk-canvas').waitFor();
    let frame=page.frames().find(f=>f.url().includes('/companion/index.html'));
    await frame.waitForFunction(()=>window.__picker?.current==='hall');
    const idleRates=await frame.evaluate(()=>({user:SCENE_HALL.characters.user.sprites.idle.frameMs,userFrames:SCENE_HALL.characters.user.sprites.idle.frames.length,shy:SCENE_HALL.characters.user.sprites.shy_sweet.frameMs,userWalk:SCENE_HALL.characters.user.sprites.walk_right.frameMs,sol:SCENE_HALL.characters.sol.sprites.idle.frameMs,claude:SCENE_HALL.characters.claude.sprites.idle.frameMs}));
    assert.deepEqual(idleRates,{user:120,userFrames:8,shy:220,userWalk:120,sol:120,claude:120});
    const firstUserFrame=await frame.evaluate(()=>__scene.player.frameIndex);
    await frame.waitForFunction(first=>__scene.player.pose==='idle'&&__scene.player.frameIndex!==first,firstUserFrame,{timeout:2000});
    assert.equal(await frame.locator('button,nav').count(),0);
    assert.equal(await frame.locator('#scene-status').isVisible(),false,'no small scene title or instructions above the picture');
    await page.locator('.companion-note.sol p').filter({hasText:'薄荷色'}).waitFor();
    await page.locator('.companion-note.claude p').filter({hasText:'安静的陪伴'}).waitFor();
    const expectedAuthors=noteCalls.map(p=>p==='codex'?'sol':'Claude');
    assert.deepEqual(await page.locator('.companion-note h2').allTextContents(),expectedAuthors);
    const noteAvatars=await page.locator('.companion-note-avatar').evaluateAll(imgs=>imgs.map(im=>({src:im.getAttribute('src'),loaded:im.complete&&im.naturalWidth>0})));
    assert.deepEqual(noteAvatars,noteCalls.map(p=>({src:'/avatars/'+p+'.webp',loaded:true})));
    const originalNote=await page.locator('.companion-notes').textContent();
    const original=await page.locator('.companion-frame').elementHandle();
    await page.waitForTimeout(5600);assert.equal(await original.evaluate(el=>el.isConnected),true,'normal state polling must not restart the scene');
    assert.equal(await frame.evaluate(()=>__picker.current),'hall','polling never rerolls the chosen scene');
    assert.equal(await page.locator('.companion-notes').textContent(),originalNote,'polling preserves genuine saved notes');
    assert.deepEqual([...noteCalls].sort(),['claude','codex'],'exactly one call to each actual provider seam');
    await frame.waitForFunction(()=>window.__scene?.npcs[0].path!==null,{},{timeout:15000});
    const start=await frame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    await page.waitForTimeout(500);
    const next=await frame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    assert.ok(Math.hypot(next.x-start.x,next.y-start.y)>1,'Claude actually moves in the browser');
    assert.ok(Math.hypot(next.x-start.x,next.y-start.y)<10,'keep the slow step speed');
    await frame.waitForFunction(()=>__scene.player.pose==='shy_sweet',{},{timeout:25000});
    const shyFrame=await frame.evaluate(()=>__scene.player.frameIndex);
    await frame.waitForFunction(first=>__scene.player.pose==='shy_sweet'&&__scene.player.frameIndex!==first,shyFrame,{timeout:1000});
    await page.screenshot({path:path.join(dir,'office-user-shy-extra.png')});
    await frame.waitForFunction(()=>__scene.player.pose==='idle',{},{timeout:5000});

    const clickNPC=async()=>{
      const n=await frame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
      const box=await frame.locator('.sk-canvas').boundingBox();
      await page.mouse.click(box.x+n.x*box.width/344,box.y+(n.y-30)*box.height/192);
    };
    await clickNPC();await frame.waitForFunction(()=>window.__scene.npcs[0].pose==='wave');
    await frame.locator('.sk-bubble.on').waitFor();
    await page.waitForTimeout(200); // Capture the bubble after its existing opacity transition.
    await page.screenshot({path:path.join(dir,'office-hall-talk.png')});
    await frame.waitForFunction(()=>window.__scene.npcs[0].pose==='idle');
    const stopped=await frame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));await page.waitForTimeout(800);
    assert.deepEqual(await frame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y})),stopped,'close companion remains with the player');
    assert.equal(await frame.locator('.sk-bubble.on').count(),0);
    // Natural standing interlude, then real clicks through each new Claude response.
    await frame.waitForFunction(()=>__scene.npcs[0].actionKind==='idle-extra',null,{timeout:30000});
    const claudeIdleExtra=await frame.evaluate(()=>({pose:__scene.npcs[0].pose,x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    assert.ok(['chin_think','palm_up_shrug'].includes(claudeIdleExtra.pose));
    assert.equal(await frame.locator('.sk-bubble.on').count(),0);
    await page.screenshot({path:path.join(dir,'office-hall-idle-extra.png')});
    const claudeTriggerPoses=[];
    for(const pose of ['double_peace','held_item_show','surprised_palms']){
      await clickNPC();await frame.waitForFunction(p=>__scene.npcs[0].pose===p,pose);
      await page.waitForTimeout(180);
      const state=await frame.evaluate(()=>({pose:__scene.npcs[0].pose,kind:__scene.npcs[0].actionKind,frame:__scene.npcs[0].frameIndex}));
      assert.equal(state.kind,'trigger');assert.ok(state.frame>0&&state.frame<8);claudeTriggerPoses.push(state.pose);
      await page.screenshot({path:path.join(dir,'office-hall-trigger-'+pose+'.png')});
    }
    await frame.waitForFunction(()=>__scene.npcs[0].pose==='idle');
    assert.equal(await frame.locator('.sk-bubble.on').count(),0);
    const sizes=[];
    async function checkFit(target,sceneFrame){
      await target.waitForTimeout(250);
      const m=await sceneFrame.evaluate(()=>{
        const stage=document.getElementById('stage'),cv=document.querySelector('.sk-canvas');
        const s=stage.getBoundingClientRect(),c=cv.getBoundingClientRect(),v=document.getElementById('visual').getBoundingClientRect();
        return {stageWidth:s.width,canvasWidth:c.width,canvasHeight:c.height,nativeWidth:cv.width,nativeHeight:cv.height,
          background:scenes[window.__picker.current].config.background,
          pictureTop:s.top,visualTop:v.top,pictureBottom:c.bottom,frameHeight:innerHeight,
          stageOverflowX:stage.scrollWidth-stage.clientWidth,stageOverflowY:stage.scrollHeight-stage.clientHeight,
          bodyOverflowX:document.documentElement.scrollWidth-innerWidth,bodyOverflowY:document.documentElement.scrollHeight-innerHeight};
      });
      // The scene sandbox deliberately taints its canvas. Inspect the same local
      // background from the parent origin; do not weaken iframe permissions.
      const inkRow=await target.evaluate(async(src)=>{
        const im=new Image();im.src='/companion/'+src;await im.decode();
        const cv=new OffscreenCanvas(im.width,im.height),ctx=cv.getContext('2d');ctx.drawImage(im,0,0);
        const pixels=ctx.getImageData(0,0,im.width,im.height).data;
        for(let y=0;y<im.height;y++)for(let x=0;x<im.width;x++)if(pixels[(y*im.width+x)*4+3])return y;
        throw new Error('Background is entirely transparent');
      },m.background);
      m.visiblePictureTop=m.pictureTop+inkRow*m.canvasHeight/m.nativeHeight;
      assert.ok(Math.abs(m.canvasWidth-m.stageWidth)<=1,'use the available scene width, no integer jump or flex squeeze');
      assert.ok(Math.abs(m.canvasHeight/m.canvasWidth-192/344)<.001);
      assert.equal(m.nativeWidth,344);assert.equal(m.nativeHeight,192);
      assert.ok(m.pictureTop<=m.visualTop+1,'picture is top aligned rather than vertically centered over the note');
      assert.ok(m.canvasWidth<=450,'scene further shrinks from 550px to at most 450px');
      assert.equal(await target.locator('.companion-note').count(),2);
      assert.equal(await target.locator('.companion-notes time,.companion-note-date').count(),0,'daily date stays in storage, not in the displayed notes');
      assert.equal(await sceneFrame.locator('#scene-status').isVisible(),false);
      for(const key of ['stageOverflowX','stageOverflowY','bodyOverflowX','bodyOverflowY'])assert.ok(m[key]<=1,key+': '+JSON.stringify(m));
      assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const ib=await target.locator('.companion-frame').boundingBox(),cb=await target.locator('#composer').boundingBox();
      const nb=await target.locator('.companion-notes').boundingBox();
      assert.ok(ib.y+ib.height<=nb.y,'both note bubbles follow the scene');
      assert.ok(Math.abs(nb.y-ib.y-ib.height-10)<=1,'keep the scene and notes together with a compact gap');
      const transcript=await target.locator('#transcript').boundingBox();
      const lastNote=await target.locator('.companion-note').last().boundingBox();
      const topSpace=ib.y+m.visiblePictureTop-transcript.y;
      const bottomSpace=transcript.y+transcript.height-lastNote.y-lastNote.height;
      if(await target.evaluate(()=>innerWidth>=900&&innerHeight>=700))assert.ok(Math.abs(topSpace-bottomSpace)<=12,'center the visible scene and notes, not the iframe box: '+JSON.stringify({topSpace,bottomSpace}));
      assert.ok(nb.x>=0 && nb.x+nb.width<=await target.evaluate(()=>innerWidth),'notes never overflow horizontally');
      const layout=await target.locator('.companion-note-row').evaluateAll(rows=>rows.map(row=>{
        const img=row.querySelector('img'),bubble=row.querySelector('article');
        const r=row.getBoundingClientRect(),a=img.getBoundingClientRect(),b=bubble.getBoundingClientRect();
        return {author:row.classList.contains('sol')?'sol':'claude',rowLeft:r.left,rowRight:r.right,
          avatarLeft:a.left,avatarRight:a.right,bubbleLeft:b.left,bubbleRight:b.right,bubbleWidth:b.width,
          loaded:img.complete&&img.naturalWidth>0,overflow:bubble.scrollWidth-bubble.clientWidth};
      }));
      assert.equal(layout.length,2);
      for(const item of layout){
        assert.ok(item.loaded,'reuse actual author avatar, not a placeholder');
        assert.ok(item.avatarLeft>=nb.x-1&&item.avatarRight<=nb.x+nb.width+1,'avatar stays inside notes');
        assert.ok(item.bubbleLeft>=nb.x-1&&item.bubbleRight<=nb.x+nb.width+1,'bubble stays inside notes');
        assert.ok(item.overflow<=1,'note text wraps, never clips');
        assert.ok(item.author==='sol'?item.avatarRight<=item.bubbleLeft:item.bubbleRight<=item.avatarLeft,'avatars frame each author on their own side');
        if(await target.evaluate(()=>innerWidth>=1400))assert.ok(item.bubbleWidth>650,'desktop bubble grows again beyond the previous ~612px');
      }
      const transcriptFit=await target.locator('#transcript').evaluate(el=>({overflow:el.scrollHeight-el.clientHeight}));
      if(await target.evaluate(()=>innerWidth>=900&&innerHeight>=700)){
        assert.ok(transcriptFit.overflow<=1,'normal desktop can see scene and both notes without scrolling: '+JSON.stringify(transcriptFit));
        assert.ok(nb.y+nb.height<=cb.y+1,'both notes are fully above the composer');
      }
      assert.ok(ib.y<cb.y,'the scene begins above the fixed composer');
      return {...m,noteWidth:nb.width,noteLayout:layout,groupTopSpace:topSpace,groupBottomSpace:bottomSpace,transcriptOverflow:transcriptFit.overflow};
    }
    const expandedTravel=[];
    async function checkExpandedTravel(target,f,id){
      // A preceding viewport change also resizes the embedded canvas asynchronously.
      await f.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const destination={store:[117,139],hall:[90,128],'sunset-diner':[211,151],'rainy-station':[241,128]}[id];
      const box=await f.locator('.sk-canvas').boundingBox();
      await target.mouse.click(box.x+destination[0]*box.width/344,box.y+destination[1]*box.height/192);
      await f.waitForFunction(([x,y])=>!__scene.player.path&&Math.hypot(__scene.player.x-x,__scene.player.y-y)<1,destination,{timeout:12000});
      const position=await f.evaluate(()=>({x:__scene.player.x,y:__scene.player.y}));
      expandedTravel.push({id,destination,position});
      fs.writeFileSync(path.join(dir,'expanded-travel.json'),JSON.stringify(expandedTravel,null,2));
      await target.screenshot({path:path.join(dir,'expanded-floor-'+id+'.png')});
    }
    for(const [width,height] of [[1440,1050],[1150,850],[900,700],[688,650],[390,900],[320,640],[1440,600]]){
      await page.setViewportSize({width,height});sizes.push({width,height,...await checkFit(page,frame)});
      assert.equal(await original.evaluate(el=>el.isConnected),true,'resize preserves the same scene');
    }
    await page.setViewportSize({width:1440,height:1050});
    await checkExpandedTravel(page,frame,'hall');
    await page.locator('#chat-tabs [data-page="history"]').click();
    assert.equal(await page.locator('.companion-frame').count(),0);assert.equal(await original.evaluate(el=>el.isConnected),false);
    await page.locator('#chat-tabs [data-page="chat"]').click();await page.locator('.companion-frame').waitFor();
    assert.equal(await page.locator('#message').inputValue(),'保留工作输入草稿');
    await page.locator('.session-entry[data-session="companion-test"]').click();
    await page.locator('.message-text').getByText('原有的聊天内容不变',{exact:true}).waitFor();assert.equal(await page.locator('.companion-frame').count(),0);
    await page.locator('#new-session').click();await page.locator('.companion-frame').waitFor();
    await page.setViewportSize({width:390,height:900});
    frame=page.frames().find(f=>f.url().includes('/companion/index.html'));await frame.waitForFunction(()=>window.__picker?.current==='hall');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('#composer').isVisible(),true);
    const ib=await page.locator('.companion-frame').boundingBox(),cb=await page.locator('#composer').boundingBox();assert.ok(ib.y+ib.height<=cb.y+1,'scene does not cover the composer');
    await page.screenshot({path:path.join(dir,'office-mobile.png'),fullPage:true});
    // A second page in the same safe Edge instance exercises the other random branch
    // through the real new-chat entry, without a hidden scene-switch shortcut.
    const storePage=await browser.newPage({viewport:{width:1440,height:1050}});
    await storePage.addInitScript(()=>{if(location.pathname==='/companion/index.html'){let calls=0;Math.random=()=>calls++===0?.125:.999;}});
    storePage.on('pageerror',e=>errors.push(e.message));
    storePage.on('response',r=>{if(r.status()>=400)missing.push(new URL(r.url()).pathname);});
    storePage.on('request',r=>{if(r.method()==='POST'){posts.push(new URL(r.url()).pathname);if(r.frame().url().includes('/companion/'))scenePosts.push(new URL(r.url()).pathname);}});
    await storePage.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await storePage.goto(base);await storePage.locator('.companion-frame').waitFor();
    await storePage.frameLocator('.companion-frame').locator('.sk-canvas').waitFor();
    const storeFrame=storePage.frames().find(f=>f.url().includes('/companion/index.html'));
    await storeFrame.waitForFunction(()=>window.__picker?.current==='store');
    assert.equal(await storeFrame.locator('button,nav').count(),0);
    await storePage.locator('.companion-note.claude p').filter({hasText:'安静的陪伴'}).waitFor();
    assert.equal(await storePage.locator('.companion-notes').textContent(),originalNote,'both real messages are independent of chosen scene');
    await checkFit(storePage,storeFrame);await storePage.screenshot({path:path.join(dir,'office-store.png')});
    await storePage.setViewportSize({width:1210,height:825});
    await storePage.locator('#toggle-context').click();
    sizes.push({width:1210,height:825,overviewCollapsed:true,...await checkFit(storePage,storeFrame)});
    await storePage.screenshot({path:path.join(dir,'office-collapsed-visible-center.png')});
    await storePage.locator('#toggle-context').click();
    await storePage.setViewportSize({width:1440,height:1050});
    await storeFrame.waitForFunction(()=>__scene.npcs[0].actionKind==='idle-extra',null,{timeout:30000});
    const extraBefore=await storeFrame.evaluate(()=>({pose:__scene.npcs[0].pose,x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    assert.equal(extraBefore.pose,'jacket_tidy');
    assert.equal(await storeFrame.locator('.sk-bubble.on').count(),0,'idle action is silent');
    await storePage.waitForTimeout(150);
    const extraAfter=await storeFrame.evaluate(()=>({pose:__scene.npcs[0].pose,x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    assert.deepEqual(extraAfter,extraBefore,'extra action is stationary, not another walk');
    await storePage.screenshot({path:path.join(dir,'office-store-idle-extra.png')});
    const triggerPoses=[];
    for(const pose of ['wave','wink_finger','touch_hair','polite_bow']){
      const n=await storeFrame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
      const box=await storeFrame.locator('.sk-canvas').boundingBox();
      await storePage.mouse.click(box.x+n.x*box.width/344,box.y+(n.y-30)*box.height/192);
      await storeFrame.waitForFunction(p=>__scene.npcs[0].pose===p,pose);
      await storeFrame.locator('.sk-bubble.on').waitFor();
      await storePage.waitForTimeout(180);
      const state=await storeFrame.evaluate(()=>({pose:__scene.npcs[0].pose,kind:__scene.npcs[0].actionKind,frame:__scene.npcs[0].frameIndex}));
      assert.equal(state.kind,'trigger');assert.ok(state.frame>0 && state.frame<8);triggerPoses.push(state.pose);
      await storePage.screenshot({path:path.join(dir,'office-store-trigger-'+pose+'.png')});
    }
    await storeFrame.waitForFunction(()=>__scene.npcs[0].pose==='idle');
    assert.equal(await storeFrame.locator('.sk-bubble.on').count(),0);
    await checkExpandedTravel(storePage,storeFrame,'store');
    await storePage.setViewportSize({width:320,height:640});await checkFit(storePage,storeFrame);
    const n=await storeFrame.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
    const box=await storeFrame.locator('.sk-canvas').boundingBox();
    await storePage.mouse.click(box.x+n.x*box.width/344,box.y+(n.y-30)*box.height/192);
    await storeFrame.locator('.sk-bubble.on').waitFor();await storePage.waitForTimeout(200);
    await checkFit(storePage,storeFrame);
    const bubbleFit=await storeFrame.locator('.sk-bubble.on').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    assert.ok(bubbleFit.top>=0&&bubbleFit.left>=0&&bubbleFit.right<=bubbleFit.width&&bubbleFit.bottom<=bubbleFit.height,'the full dialogue bubble must fit, not be silently clipped: '+JSON.stringify(bubbleFit));
    await storePage.screenshot({path:path.join(dir,'office-small-talk.png'),fullPage:true});
    await storePage.locator('.companion-note').last().scrollIntoViewIfNeeded();
    // A multi-paragraph bubble can be taller than this viewport: reach its end,
    // rather than asking scrollIntoView to fit the entire tall element at once.
    await storePage.locator('#transcript').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    const last=await storePage.locator('.companion-note').last().boundingBox(),composer=await storePage.locator('#composer').boundingBox();
    assert.ok(last.y+last.height<=composer.y+1,'the end of the last bubble can be reached without moving the composer');
    await storePage.screenshot({path:path.join(dir,'office-small-notes-scrolled.png'),fullPage:true});
    await storePage.close();
    // The new backgrounds enter through the same real random new-chat route.
    // No production scene switch, model call or extra browser instance is added.
    for(const [id,choice,companion] of [['sunset-diner',.625,'sol'],['rainy-station',.875,'claude']]){
      const corner=await browser.newPage({viewport:{width:1440,height:1050}});
      await corner.addInitScript(choice=>{if(location.pathname==='/companion/index.html'){
        let calls=0,seed=123;Math.random=()=>calls++===0?choice:((seed=(1664525*seed+1013904223)>>>0)/2**32);
      }},choice);
      corner.on('pageerror',e=>errors.push(e.message));
      corner.on('response',r=>{if(r.status()>=400)missing.push(new URL(r.url()).pathname);});
      corner.on('request',r=>{if(r.method()==='POST'){posts.push(new URL(r.url()).pathname);if(r.frame().url().includes('/companion/'))scenePosts.push(new URL(r.url()).pathname);}});
      await corner.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
      await corner.goto(base);await corner.locator('.companion-frame').waitFor();
      await corner.frameLocator('.companion-frame').locator('.sk-canvas').waitFor();
      const f=corner.frames().find(f=>f.url().includes('/companion/index.html'));
      await f.waitForFunction(id=>window.__picker?.current===id,id);
      assert.deepEqual(await f.evaluate(()=>({player:__scene.player.id,npcs:__scene.npcs.map(n=>n.id)})),{player:'user',npcs:[companion]});
      await corner.locator('.companion-note').last().waitFor();
      await checkFit(corner,f);await corner.screenshot({path:path.join(dir,'office-'+id+'.png')});
      if(id==='rainy-station'){
        // Observe real canvas motion without reading tainted pixels, weakening
        // iframe permissions or adding a production test hook.
        await f.evaluate(()=>{
          const proto=CanvasRenderingContext2D.prototype,states=new WeakMap();
          const clear=proto.clearRect,fill=proto.fillRect,draw=proto.drawImage;
          window.__weatherEvidence={frames:0};let rear;
          proto.clearRect=function(...args){states.set(this,{rain:[],fog:[],opacity:[]});return clear.apply(this,args);};
          proto.fillRect=function(...args){const s=states.get(this);if(s&&this.fillStyle.startsWith('rgba(167, 194, 211,')){s.rain.push(args);s.opacity.push(this.fillStyle);}return fill.apply(this,args);};
          proto.drawImage=function(im,x,y,...args){
            const s=states.get(this);
            if(s&&this.canvas.width===344&&this.canvas.height===192){
              if(this.globalCompositeOperation==='destination-in'&&(s.rain.length||s.fog.length)){
                if(s.fog.length)rear={rain:s.rain,opacity:s.opacity,fog:s.fog,mask:im.getAttribute('src')};
                else if(rear)window.__weatherEvidence={frames:window.__weatherEvidence.frames+1,rain:rear.rain,frontRain:s.rain,opacity:rear.opacity,frontOpacity:s.opacity,fog:rear.fog,mask:rear.mask,frontMask:im.getAttribute('src')};
              }else if(im instanceof HTMLCanvasElement)s.fog.push([x,y]);
            }
            return draw.call(this,im,x,y,...args);
          };
        });
        await f.waitForFunction(()=>__weatherEvidence.frames>2);
        const first=await f.evaluate(()=>__weatherEvidence);
        await corner.waitForTimeout(1000);
        const second=await f.evaluate(()=>__weatherEvidence);
        assert.ok(second.frames>first.frames);
        for(const sample of [first,second]){
          assert.equal(sample.rain.length,0,'no rear rain');assert.equal(sample.frontRain.length,104*4);assert.equal(sample.fog.length,3);
          assert.ok(sample.frontRain.every(p=>p[2]===1),'real front rain is thin');
          assert.ok(new Set(sample.frontOpacity).size>40,'real render has varied and tapered opacity');
          assert.equal(sample.mask,'assets/rainy-station/bg.png');
          assert.equal(sample.frontMask,sample.mask);
        }
        assert.notDeepEqual(second.fog,first.fog);
        assert.notDeepEqual(second.frontRain,first.frontRain);
        weatherEvidence={first,second};
        fs.writeFileSync(path.join(dir,'weather-motion.json'),JSON.stringify(weatherEvidence,null,2));
        await corner.screenshot({path:path.join(dir,'office-rainy-station-weather-later.png')});
      }
      const npc=await f.evaluate(()=>({x:__scene.npcs[0].x,y:__scene.npcs[0].y}));
      const canvas=await f.locator('.sk-canvas').boundingBox();
      await corner.mouse.click(canvas.x+npc.x*canvas.width/344,canvas.y+(npc.y-30)*canvas.height/192);
      await f.locator('.sk-bubble.on').waitFor();
      assert.equal(await f.evaluate(()=>__scene.npcs[0].pose),'wave');
      await corner.waitForTimeout(180);
      await corner.screenshot({path:path.join(dir,'office-'+id+'-talk.png')});
      await checkExpandedTravel(corner,f,id);
      await corner.setViewportSize({width:320,height:640});await checkFit(corner,f);
      await corner.screenshot({path:path.join(dir,'office-'+id+'-small.png'),fullPage:true});
      if(id==='rainy-station'){
        await corner.locator('#chat-tabs [data-page="history"]').click();
        assert.equal(await corner.locator('.companion-frame').count(),0,'weather scene unmounts when leaving the chat');
      }
      await corner.close();
    }
    const failedScene=await browser.newPage();
    await failedScene.route('**/assets/chars/user/idle_anim/f0.png',r=>r.abort());
    await failedScene.goto(base+'/companion/index.html');
    await failedScene.locator('#scene-status').waitFor({state:'visible'});
    assert.ok((await failedScene.locator('#scene-status').textContent()).startsWith('场景加载失败：'));
    assert.equal(await failedScene.locator('#note').count(),0,'static fake notes removed from the sandboxed scene');
    await failedScene.close();
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);assert.deepEqual(scenePosts,[]);
    assert.ok(posts.every(p=>['/api/usage/refresh','/api/companion/notes'].includes(p)),'only explicit daily notes and pre-existing quota requests, never chat writes');
    assert.deepEqual([...noteCalls].sort(),['claude','codex'],'multiple pages and remounts do not regenerate messages');
    assert.deepEqual(read('work/queue.json'),before.queue);assert.deepEqual(read('.runtime/agent/sessions.json'),before.sessions);
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({errors,missing,posts,scenePosts,sizes,randomBranches:['store','hall','sunset-diner','rainy-station'],idleExtra:extraBefore,triggerPoses,claudeIdleExtra,claudeTriggerPoses,extraReturnedToIdle:true,switchesRemoved:true,topHintRemoved:true,notesBelowBothScenes:true,loadErrorStillVisible:true,claudeMoved:true,oldDraftPreserved:true,sceneNotRestartedByPolling:true,assetsLocal:true,liveOfficeRestarted:false},null,2));
  }catch(e){if(page)await page.screenshot({path:path.join(dir,'failure.png'),fullPage:true});throw e;}
  finally{if(browser)await browser.close();await new Promise(r=>server.close(r));write('agent/config.json',cfg);}
});
