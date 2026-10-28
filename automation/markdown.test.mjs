import { launchEdge } from './browser-launch.mjs';
// Real browser and HTTP assets in scripts/run-tests.mjs's sanitised copy only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read} from './files.mjs';
import {createServer,snapshot} from '../dashboard/server.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('这些测试会改动所在目录的数据，请用 node scripts/run-tests.mjs 在隔离副本里运行');

test('Markdown reaches the actual chat UI without executable message content',async t=>{
  assert.equal(read('agent/config.json').enabled,false,'only run via the isolated test runner');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const linkDir=path.join(root,'workspace','outbox','chat-link-test'),linkFile=path.join(linkDir,'全文 待办.md');
  fs.mkdirSync(linkDir,{recursive:true});fs.writeFileSync(linkFile,'chat-link-preview-fixture');
  const workspaceUrl='/workspace/outbox/chat-link-test/'+encodeURIComponent(path.basename(linkFile));
  let browser;
  try {
    browser=await launchEdge();
    const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage(),errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      if(!route.request().url().startsWith(origin)) {external.push(route.request().url());return route.abort();}
      return route.continue();
    });
    const code='const value = "**原样** $x$ <img onerror=alert(1)>";\n'+ 'x'.repeat(240);
    const text=[
      '# 渲染验收','**粗体**、*斜体*、~~删除线~~ 和 `inline $x$ **literal**`。',
      '- 第一项\n- 第二项','> 引用段落','[安全链接](https://example.org/paper)',
      '| 材料 | 数值 |\n| --- | --- |\n| graphene | 2 |',
      '行内 $E=mc^2$ 与 \\(\\sigma=ne\\mu\\)。',
      '$$\nI=\\frac{V}{R}\n$$','\\[\\int_0^1 x\\,dx=\\frac12\\]',
      '```javascript\n'+code+'\n```','价格 $5 和 $10；转义 \\$x\\$。',
      '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>',
      '[危险链接](javascript:alert(1))','![不要自动加载](https://example.org/tracker.png)',
      '$\\includegraphics{https://example.org/secret}$','无效公式 $\\frac{$；后面的消息仍显示。'
    ].join('\n\n');
    const fixture=snapshot();fixture.agent.sessions=[{id:'render-fixture',title:'Markdown 验收',project_ids:[],task_ids:[],messages:[
      {role:'user',text:'**用户消息** $x^2$',at:new Date().toISOString()},
      {role:'assistant',provider:'codex',text,at:new Date().toISOString()},
      {role:'assistant',provider:'claude',text:'**Claude 消息** \\(a+b\\)\n\n文件 `D:\\Main\\PROFILE.md`、文件夹 `D:\\Main\\assistant` 与 [链接](file:///D:/Main/%E4%B8%AD%E6%96%87%20a.png)、[越界](file:///C:/Windows/win.ini)\n\n```text\nD:\\Main\\assistant\\README.md\n```\n\n`not a path`',at:new Date().toISOString()},
      {role:'assistant',provider:'codex',text:`[旧工作区](http://127.0.0.1:8787${workspaceUrl}) [相对工作区](${workspaceUrl}) [旧接口](http://127.0.0.1:8787/api/local-file?path=${encodeURIComponent(linkFile)}) [外站](https://example.org${workspaceUrl}) [其他本地服务](http://127.0.0.1:9999${workspaceUrl}) [脚本](file:///D:/Main/test.ps1) [本地凭据](D:/Main/assistant/.runtime/commandcode/credentials.json)`,at:new Date().toISOString()}
    ]}];
    fixture.work.items=[{id:'fixture-result',title:'格式化交接',status:'done',actor:'codex',project_ids:[],outputs:[],handoff:'**交接结论** $x^2$',completed_at:new Date().toISOString()}];
    await page.route('**/api/state*',route=>route.fulfill({json:fixture}));
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','render-fixture');});
    await page.goto(origin);
    try {await page.locator('.md-code').first().waitFor();}
    catch(error){error.message+='\nStartup evidence: '+JSON.stringify({errors,body:await page.locator('body').innerText()});throw error;}
    const body=page.locator('.message.codex .message-text').first();
    await t.test('bold, lists, quotes, tables and safe links render as semantic elements',async()=>{
      assert.equal(await body.locator('h1').textContent(),'渲染验收');
      assert.equal(await body.locator('strong').first().textContent(),'粗体');
      assert.equal(await body.locator('ul li').count(),2);assert.equal(await body.locator('blockquote').count(),1);
      assert.equal(await body.locator('table tbody tr').count(),1);
      assert.equal(await body.locator('a').first().getAttribute('rel'),'noopener noreferrer');
      assert.equal(await body.locator('a').first().getAttribute('target'),'_blank','sanitization must retain the intended new-tab behavior');
      assert.equal(await page.locator('.message.user strong').last().textContent(),'用户消息');
      assert.equal(await page.locator('.message.claude .katex').count(),1);
    });
    await t.test('four math delimiters render, malformed math stays readable and currency stays text',async()=>{
      assert.equal(await body.locator('.katex').count(),5); // two inline, two display, disabled includegraphics
      assert.equal(await body.locator('.katex-display').count(),2);
      assert.equal(await body.locator('.katex-error').count(),1,JSON.stringify(await body.locator('.katex-error').allTextContents()));
      assert.match(await body.textContent(),/价格 \$5 和 \$10；转义 \$x\$/);
      assert.match(await body.textContent(),/后面的消息仍显示/);
      await page.evaluate(()=>document.fonts.ready);
      assert.ok(await page.evaluate(()=>document.fonts.check('16px KaTeX_Main')));
    });
    await t.test('inline and fenced code stay literal; copy returns exact code',async()=>{
      assert.equal(await body.locator('pre code').textContent(),code);
      assert.equal(await body.locator('p code').textContent(),'inline $x$ **literal**');
      await body.locator('.md-copy').click();assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),code);
    });
    await t.test('local file paths in chat become same-origin open links; the path text stays copyable',async()=>{
      const claude=page.locator('.message.claude .message-text');
      const hrefs=await claude.locator('a').evaluateAll(a=>a.map(x=>x.getAttribute('href')));
      // The server, not the renderer, decides which of these may actually open (C:\Windows is refused there).
      assert.deepEqual(hrefs.filter(h=>h.startsWith('/api/local-file')).map(h=>new URLSearchParams(h.split('?')[1]).get('path')),['D:\\Main\\PROFILE.md','D:\\Main\\中文 a.png','C:\\Windows\\win.ini','D:\\Main\\assistant\\README.md']);
      assert.equal(hrefs.filter(h=>/^file:/i.test(h)).length,0);
      assert.equal(await claude.locator('p code').first().textContent(),'D:\\Main\\PROFILE.md');
      assert.equal(await claude.locator('p code').last().textContent(),'not a path');
      assert.equal(await claude.locator('p code + a.md-open-path').count(),1);
      assert.equal(await claude.locator('.md-code-actions a.md-open-path').count(),1);
      assert.deepEqual(await claude.locator('.md-reveal-path').evaluateAll(b=>b.map(x=>x.dataset.path)),['D:\\Main\\assistant'],'only the folder opens Explorer');
      assert.equal(await claude.locator('a.md-open-path.md-native-file').count(),2,'documents use the default app on this PC');
      assert.equal(await claude.locator('button.md-open-path').textContent(),'打开 ↗','folder uses the same label, no second button');
    });
    await t.test('old links become same-origin; ordinary clicks POST once, modifiers retain browser preview',async()=>{
      const posts=[];
      await page.route('**/api/local-file/open',async route=>{posts.push(route.request().postDataJSON());await route.fulfill({json:{started:true}});});
      const links=page.locator('.message.codex').last();
      const old=links.getByRole('link',{name:'旧工作区',exact:true});
      assert.equal(await old.getAttribute('href'),workspaceUrl);
      assert.equal(await links.getByRole('link',{name:'旧接口',exact:true}).getAttribute('href'),'/api/local-file?path='+encodeURIComponent(linkFile));
      assert.equal(await links.getByRole('link',{name:'外站',exact:true}).getAttribute('href'),'https://example.org'+workspaceUrl);
      assert.equal(await links.getByRole('link',{name:'其他本地服务',exact:true}).getAttribute('href'),'http://127.0.0.1:9999'+workspaceUrl);
      assert.equal(await links.getByRole('link',{name:'脚本',exact:true}).getAttribute('class'),null,'scripts keep the non-executing preview path');
      await old.click();assert.deepEqual(posts,[{url:workspaceUrl}]);
      await links.getByRole('link',{name:'旧接口',exact:true}).click();assert.deepEqual(posts[1],{path:linkFile});
      const popupPromise=context.waitForEvent('page');await old.click({modifiers:['Control']});
      const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.url(),origin+workspaceUrl);assert.match(await popup.locator('body').innerText(),/chat-link-preview-fixture/);
      await popup.close();assert.equal(posts.length,2,'Ctrl+click never launches an app');
      const credential=links.getByRole('link',{name:'本地凭据',exact:true});
      assert.match(await credential.getAttribute('class'),/md-native-file/);
      await credential.click();assert.deepEqual(posts[2],{path:'D:/Main/assistant/.runtime/commandcode/credentials.json'});
      await page.unroute('**/api/local-file/open');
    });
    await t.test('phone-origin links preview the server file without posting a desktop launch',async()=>{
      const remote='https://office.tail-test.ts.net:8787',phone=await context.newPage(),launches=[];
      await phone.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','render-fixture');});
      await context.route(remote+'/**',async route=>{
        const u=new URL(route.request().url());
        if(u.pathname==='/api/local-file/open')launches.push(route.request().url());
        if(u.pathname.startsWith('/api/state'))return route.fulfill({json:fixture});
        const response=await route.fetch({url:origin+u.pathname+u.search});return route.fulfill({response});
      });
      try {
        await phone.goto(remote);const old=phone.getByRole('link',{name:'旧工作区',exact:true});await old.waitFor();
        assert.equal(await old.getAttribute('href'),workspaceUrl);
        const popupPromise=context.waitForEvent('page');await old.click();const popup=await popupPromise;
        await popup.waitForLoadState('domcontentloaded');assert.equal(popup.url(),remote+workspaceUrl);
        assert.match(await popup.locator('body').innerText(),/chat-link-preview-fixture/);
        assert.deepEqual(launches,[]);await popup.close();
      }finally{await phone.close();await context.unroute(remote+'/**');}
    });
    await t.test('raw HTML, JavaScript links and TeX cannot execute or load remote images',async()=>{
      assert.equal(await page.evaluate(()=>window.pwned),undefined);
      assert.equal(await body.locator('script,img,iframe').count(),0);
      assert.equal(await body.locator('a[href^="javascript:"]').count(),0);
      assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
      assert.ok((await body.textContent()).includes('<img src=x onerror='));
    });
    await t.test('mouse-selected text survives status changes and incoming messages and pastes via Ctrl+C',async()=>{
      const session=fixture.agent.sessions[0],count=session.messages.length;
      try {
      session.messages.push({role:'user',text:'选中文字后复制验收 🌿',at:new Date().toISOString()});
      const selectedLine=page.locator('.message.user .message-text').filter({hasText:'选中文字后复制验收'});
      await selectedLine.waitFor();
      await selectedLine.click({clickCount:3});
      const selected=await page.evaluate(()=>getSelection().toString());
      const selectionBefore=await page.evaluate(()=>{
        const s=getSelection(),node=n=>({type:n.nodeType,name:n.nodeName,id:n.id,class:n.parentElement?.className,text:n.textContent?.slice(0,60)});
        return {anchor:node(s.anchorNode),anchorOffset:s.anchorOffset,focus:node(s.focusNode),focusOffset:s.focusOffset};
      });
      assert.equal(selected.trim(),'选中文字后复制验收 🌿','the mouse must actually select the fixture text');
      const top=await page.locator('#transcript').evaluate(e=>e.scrollTop);
      fixture.agent.sessions[0].task_ids.push('fixture-copy-job');
      const job={id:'fixture-copy-job',title:'复制验收任务',status:'queued',actor:'codex',project_ids:[],outputs:[]};
      fixture.work.items.push(job);
      await page.locator('.task-running').filter({hasText:'等待执行'}).waitFor();
      const selectionAfter=await page.evaluate(()=>{
        const s=getSelection(),node=n=>({type:n.nodeType,name:n.nodeName,id:n.id,class:n.parentElement?.className,text:n.textContent?.slice(0,60)});
        return {anchor:node(s.anchorNode),anchorOffset:s.anchorOffset,focus:node(s.focusNode),focusOffset:s.focusOffset};
      });
      assert.equal((await page.evaluate(()=>getSelection().toString())).trimEnd(),selected.trimEnd(),'a task status refresh must not clear the selection: '+JSON.stringify({selectionBefore,selectionAfter}));
      job.status='active';
      fixture.agent.sessions[0].messages.push({role:'user',text:'更新已到达，原选区应保留',at:new Date().toISOString()});
      await page.locator('.message-text').filter({hasText:'更新已到达，原选区应保留'}).waitFor();
      assert.equal((await page.evaluate(()=>getSelection().toString())).trimEnd(),selected.trimEnd(),'an incoming message must not clear the selection');
      assert.equal(await page.locator('#transcript').evaluate(e=>e.scrollTop),top,'incoming messages must not pull a selection to the bottom');
      await page.keyboard.press('Control+c');
      const copiedSelection=await page.evaluate(()=>getSelection().toString());
      assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),copiedSelection);
      await page.locator('#message').click();await page.keyboard.press('Control+v');
      assert.equal((await page.locator('#message').inputValue()).replace(/\r\n/g,'\n'),copiedSelection,'the copied text must arrive in the composer');
      await page.locator('#message').fill('');
      // Also exercise a backwards selection spanning formatted inline elements.
      const rangeText=await body.locator('p').first().evaluate(p=>{
        const selection=getSelection();selection.setBaseAndExtent(p.lastChild,p.lastChild.textContent.length,p.querySelector('strong').firstChild,0);
        return selection.toString();
      });
      assert.ok(rangeText.includes('粗体') && rangeText.includes('inline $x$ **literal**'));
      job.status='done';await page.locator('.task-running').waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>getSelection().toString()),rangeText,'finishing a task must preserve a backwards rich-text selection');
      await page.keyboard.press('Control+c');
      assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),rangeText);
      await page.evaluate(()=>getSelection().removeAllRanges());
      }finally{
        session.messages.splice(count);session.task_ids=[];
        fixture.work.items=fixture.work.items.filter(item=>item.id!=='fixture-copy-job');
        await page.locator('.message-text').filter({hasText:'选中文字后复制验收'}).waitFor({state:'hidden'});
      }
    });
    await t.test('long code and formulas stay inside desktop and mobile chat width',async()=>{
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:1000});
        const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,15)}));
        assert.ok(overflow.scrollWidth<=overflow.width,JSON.stringify(overflow));
        const box=await body.locator('pre').boundingBox();assert.ok(box.x+box.width<=width+1);
        assert.ok(await body.locator('pre').evaluate(e=>e.scrollWidth>e.clientWidth));
        const dir=path.join(root,'.runtime/markdown-qa');fs.mkdirSync(dir,{recursive:true});
        await page.screenshot({path:path.join(dir,`chat-${width}.png`),fullPage:true});
      }
    });
    await t.test('mobile header stays compact with running work, long titles and usable chat tabs',async()=>{
      const mobile=await browser.newContext({viewport:{width:390,height:760},isMobile:true,hasTouch:true,deviceScaleFactor:2});
      const phone=await mobile.newPage();
      const mobileFixture=structuredClone(fixture);
      mobileFixture.agent.sessions[0].title='手机端长标题验收：对话应占据主要空间，不能把上方导航挤成竖排';
      mobileFixture.work.items.push({id:'mobile-active',title:'手机运行状态验收',status:'active',actor:'codex',project_ids:[],outputs:[]});
      mobileFixture.agent.sessions.push({id:'mobile-task',origin:'task',title:'手机任务会话验收',project_ids:[],task_ids:['mobile-active'],messages:[]});
      await phone.route('**/*',route=>route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await phone.route('**/api/state*',route=>route.fulfill({json:mobileFixture}));
      await phone.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','render-fixture');});
      try {
        await phone.goto(origin);await phone.locator('.message.codex').first().waitFor();
        for(const [width,height] of [[320,568],[360,640],[390,760],[430,844],[600,800],[568,320],[390,440]]) {
          await phone.setViewportSize({width,height});
          const layout=await phone.evaluate(()=>{
            const box=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
            const tabs=document.querySelector('#chat-tabs');
            return {sidebar:box('.sidebar'),topbar:box('.topbar'),toolbar:box('.chat-toolbar'),transcript:box('#transcript'),composer:box('#composer'),send:box('#send'),running:box('#running'),tabs:box('#chat-tabs'),tabBoxes:[...tabs.children].map(e=>{const r=e.getBoundingClientRect();return {y:r.y,height:r.height};}),tabsFit:tabs.scrollWidth<=tabs.clientWidth+1,pageFits:document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight+1};
          });
          assert.equal(await phone.locator('#running').textContent(),'1 项助手任务正在执行');
          assert.ok(layout.pageFits,`no outer page overflow at ${width}×${height}: ${JSON.stringify(layout)}`);
          assert.ok(layout.sidebar.height<=96 && layout.topbar.height<=44 && layout.toolbar.height<=44,'mobile chrome is compact');
          assert.ok(layout.tabsFit,'all three chat labels remain visible without squeezing');
          assert.ok(layout.tabs.right<=layout.running.x,'tabs do not overlap running status');
          assert.ok(layout.tabBoxes.every(b=>b.height<=36 && Math.abs(b.y-layout.tabBoxes[0].y)<1),'chat tabs stay on one row');
          assert.ok(layout.transcript.height>=Math.max(30,height-320),`conversation keeps the reclaimed space at ${width}x${height}: ${JSON.stringify(layout)}`);
          assert.ok(layout.composer.bottom<=height+1 && layout.send.right<=width && layout.send.bottom<=height,`composer and send stay on screen at ${width}×${height}: ${JSON.stringify(layout)}`);
          // Scrolling old messages exposes the extra toolbar action from the reported screenshot.
          await phone.locator('#transcript').evaluate(e=>e.scrollTop=0);
          await phone.locator('#latest:not([hidden])').waitFor();
          const tools=await phone.locator('.chat-tools').boundingBox();
          assert.ok(tools.x>=0 && tools.x+tools.width<=width,'latest/project controls fit with a long title');
          if(width===390 && height===760){
            const dir=path.join(root,'.runtime/markdown-qa');fs.mkdirSync(dir,{recursive:true});
            await phone.screenshot({path:path.join(dir,'mobile-header-390.png'),fullPage:true});
          }
        }
        await phone.setViewportSize({width:390,height:760});
        for(const name of ['history','tasks','chat']) {
          await phone.locator(`.chat-tab[data-page="${name}"]`).click();
          assert.equal(await phone.locator(`#page-${name}`).isVisible(),true);
          assert.equal(await phone.locator(`.chat-tab[data-page="${name}"]`).getAttribute('aria-current'),'page');
        }
        await phone.locator('#latest').click();
        assert.ok(await phone.locator('#latest').isHidden(),'return to latest still works');
        await phone.locator('#new-session').click();
        await phone.locator('#message').fill('手机端草稿：不发送');
        assert.equal(await phone.locator('#message').inputValue(),'手机端草稿：不发送');
        assert.equal(await phone.locator('#project-context').isEnabled(),true);
        await phone.locator('.nav[data-page="more"]').click();
        assert.equal(await phone.locator('#more-tabs').isVisible(),true,'off-screen primary navigation remains reachable by touch scrolling');
      } finally {await mobile.close();}
      await page.setViewportSize({width:1440,height:1000});
      assert.equal(await page.locator('.brand small').isVisible(),true,'desktop brand is unchanged');
      assert.equal(await page.locator('.top-actions .avatar,.top-actions img').count(),0,'nonfunctional header avatar is removed');
      for(const who of ['user','codex','claude']) {
        const avatar=page.locator('.message.'+who+' > img.who');
        const expected=fixture.agent.sessions[0].messages.filter(m=>who==='user' ? m.role==='user' : m.role==='assistant' && m.provider===who).length;
        assert.equal(await avatar.count(),expected,'conversation '+who+' avatar is retained');
        assert.ok(await avatar.evaluateAll(images=>images.every(e=>e.complete && e.naturalWidth>0)),'conversation avatar asset loads');
      }
      const dir=path.join(root,'.runtime/markdown-qa');fs.mkdirSync(dir,{recursive:true});
      await page.screenshot({path:path.join(dir,'desktop-no-header-avatar.png'),fullPage:true});
    });
    await t.test('Edge reload restores middle, top and bottom reading positions even with delayed Markdown',async()=>{
      await page.evaluate(()=>document.fonts.ready);
      await page.locator('#message').fill('刷新保留草稿');
      for(const position of ['middle','top','near-bottom','bottom','user-scroll']) {
        const saved=await page.locator('#transcript').evaluate((e,position)=>{
          const max=e.scrollHeight-e.clientHeight;
          e.scrollTop=position==='top' ? 0 : position==='bottom' ? max : position==='near-bottom' ? max-40 : Math.floor(max*0.65);
          return {top:e.scrollTop,max};
        },position);
        assert.ok(saved.max>200,'the fixture must have a real scrollable conversation');
        let release,seen;const gate=new Promise(r=>release=r),requested=new Promise(r=>seen=r);
        const delayed=['middle','user-scroll'].includes(position);
        if(delayed)await page.route('**/markdown.js',async route=>{seen();await gate;await route.continue();});
        try {
          await page.reload({waitUntil:'domcontentloaded'});
          if(delayed) {
            await requested;await page.locator('.message.codex').first().waitFor();
            assert.equal(await body.locator('h1').count(),0,'saved plain text must appear before the delayed rich renderer');
            if(position==='user-scroll') {
              await page.locator('#transcript').hover();await page.mouse.wheel(0,-50000);
              await page.waitForFunction(()=>document.getElementById('transcript').scrollTop===0);
            }
            release();
          }
          await page.locator('.md-code').first().waitFor();
          await page.evaluate(async()=>{
            await document.fonts.ready;
            await Promise.all([...document.querySelectorAll('#transcript img')].filter(img=>!img.complete).map(img=>new Promise(r=>{img.addEventListener('load',r,{once:true});img.addEventListener('error',r,{once:true});})));
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          });
          const restored=await page.locator('#transcript').evaluate(e=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight}));
          const expected=position==='user-scroll' ? 0 : position==='bottom' ? restored.max : saved.top;
          assert.ok(Math.abs(restored.top-expected)<=1,JSON.stringify({position,saved,restored}));
          assert.equal(await page.locator('#message').inputValue(),'刷新保留草稿');
        }finally{release();if(delayed)await page.unroute('**/markdown.js');}
      }
      await page.locator('#message').fill('');
    });
    await t.test('project deep links survive reload, but returning to chat clears the project route',async()=>{
      const projectURL=origin+'/#projects/graphene-thz';
      await page.goto(projectURL);await page.locator('#project-detail').waitFor({state:'visible'});
      assert.equal(new URL(page.url()).hash,'#projects/graphene-thz');
      await page.reload();await page.locator('#project-detail').waitFor({state:'visible'});
      assert.equal(await page.locator('#page-chat').isVisible(),false,'reloading a project deep link must keep the project');
      await page.locator('.nav[data-page="chat"]').click();await page.locator('.md-code').first().waitFor();
      assert.equal(new URL(page.url()).hash,'','returning to chat must remove the stale project fragment');
      await page.reload();await page.locator('.md-code').first().waitFor();
      assert.equal(await page.locator('#page-chat').isVisible(),true,'refresh must stay on chat');
      assert.equal(await page.locator('#page-projects').isVisible(),false);
      await page.locator('.nav[data-page="projects"]').click();await page.locator('#project-overview').waitFor({state:'visible'});
      assert.equal(new URL(page.url()).hash,'#projects','the project list has its own reloadable route');
      await page.reload();await page.locator('#project-overview').waitFor({state:'visible'});
      await page.locator('.nav[data-page="chat"]').click();await page.locator('.md-code').first().waitFor();
      await page.goto(projectURL);await page.locator('#project-detail').waitFor({state:'visible'});
      await page.goBack();await page.locator('.md-code').first().waitFor();
      assert.equal(new URL(page.url()).hash,'','browser Back to the root route must also show chat');
      assert.equal(await page.locator('#page-projects').isVisible(),false);
      assert.deepEqual(errors,[]);
    });
    await t.test('history reload uses the same rendering path',async()=>{
      await page.reload();await page.locator('.md-code').first().waitFor();assert.equal(await body.locator('pre code').textContent(),code);
      assert.deepEqual(errors,[]);
    });
    await t.test('local renderer assets and fonts have proper MIME and no directory traversal',async()=>{
      for(const [file,mime] of [['/markdown.js','text/javascript'],['/vendor/markdown/katex.min.css','text/css'],['/vendor/markdown/fonts/KaTeX_Main-Regular.woff2','font/woff2']]) {
        const response=await fetch(origin+file);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(mime));
      }
      assert.equal((await fetch(origin+'/vendor/markdown/fonts/%2e%2e%2fREADME.md')).status,404);
    });
    await t.test('refreshing before server restart preserves plain text and does not import unavailable modules',async()=>{
      const modules=[];
      await page.route('**/health',route=>route.fulfill({json:{app:'phd-workflows',version:2}}));
      await page.route('**/markdown.js',route=>{modules.push(route.request().url());return route.fulfill({status:404,body:'Not found'});});
      await page.reload();await page.locator('.message.codex').first().waitFor();
      assert.equal(await body.textContent(),text);assert.equal(await body.locator('pre,.katex,strong').count(),0);
      assert.equal(await body.evaluate(e=>getComputedStyle(e).whiteSpace),'pre-wrap');
      assert.deepEqual(modules,[]);assert.deepEqual(errors,[]);
    });
  }finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(linkDir,{recursive:true,force:true});}
});
