import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchPowerShell} from './powershell.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --powershell-ui --keep');
const literal=value=>`'${value.replace(/'/g,"''")}'`;
const waitForFile=async file=>{for(let i=0;i<150;i++){if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));await new Promise(r=>setTimeout(r,100));}throw Error('Console did not produce evidence: '+file);};

test('PowerShell requires explicit confirmation, local host and same-origin JSON',async()=>{
  await assert.rejects(launchPowerShell({code:'Write-Host unsafe'}),/确认/);
  await assert.rejects(launchPowerShell({code:' ',confirmed:true}),/命令/);
  await assert.rejects(launchPowerShell({code:'Write-Host test',cwd:'relative',confirmed:true}),/绝对目录/);
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const headers of [{'Content-Type':'application/json'},{'Content-Type':'application/json',Origin:'http://evil.example'},{'Content-Type':'text/plain',Origin:origin},{'Content-Type':'application/json',Host:`evil.example:${server.address().port}`,Origin:`http://evil.example:${server.address().port}`}]){
      const response=await fetch(origin+'/api/powershell/run',{method:'POST',headers,body:'{}'});assert.equal(response.status,400);
    }
    const response=await fetch(origin+'/api/powershell/run',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({code:'Write-Host test',cwd:root})});assert.equal(response.status,400);assert.match((await response.json()).error,/确认/);
  }finally{await new Promise(r=>server.close(r));}
});

test('assistant code -> review -> visible interactive console preserves cwd, full paths, quotes and Chinese',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const qa=path.join(root,'.runtime/powershell-qa'),custom=path.join(qa,"中文 path's"),nested=path.join(custom,'nested');fs.mkdirSync(nested,{recursive:true});
  fs.writeFileSync(path.join(qa,'source.txt'),'中文 "quotes" $literal & 原样','utf8');
  const source=path.join(qa,'source.txt'),first=path.join(qa,'default.json'),second=path.join(qa,'absolute.json');
  const evidence=(input,out)=>`$data=[ordered]@{cwd=(Get-Location).Path;text=[string](Get-Content -LiteralPath ${input} -Raw -Encoding UTF8);inputRedirected=[Console]::IsInputRedirected;outputRedirected=[Console]::IsOutputRedirected}\nWrite-Host 'PowerShell UI 验收：仅写隔离副本，无科研数据'\n$data | ConvertTo-Json | Set-Content -LiteralPath ${literal(out)} -Encoding UTF8\nStart-Sleep -Seconds 2\nexit`;
  const code1=evidence("'./.runtime/powershell-qa/source.txt'",first);
  const code2=`Set-Location -LiteralPath './nested'\n${evidence(literal(source),second)}`;
  const messages=[{role:'user',text:'```powershell\nWrite-Host user quote\n```'},{role:'assistant',provider:'codex',text:`默认目录\n\n\`\`\`powershell\n${code1}\n\`\`\`\n\n\`\`\`javascript\nconst x=1;\n\`\`\``},{role:'assistant',provider:'claude',text:`\`\`\`pwsh\n${code2}\n\`\`\``}].map(m=>({...m,at:new Date().toISOString()}));
  write('.runtime/agent/sessions.json',{sessions:[{id:'powershell-ui',title:'PowerShell 运行验收',task_ids:[],project_ids:[],messages}]});
  let browser,page;const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    browser=await launchEdge();page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/api/powershell/run'))posts.push(r.postDataJSON());});
    await page.route('**/*',r=>r.request().url().startsWith(origin) ? r.continue() : r.abort());
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','powershell-ui');});
    await page.goto(origin);await page.locator('.message.claude .md-run-powershell').waitFor();
    assert.equal(await page.locator('.md-run-powershell').count(),2);assert.equal(await page.locator('.message.user .md-run-powershell').count(),0);
    assert.equal(await page.locator('.message.codex .md-code').nth(1).locator('.md-run-powershell').count(),0);assert.equal(posts.length,0,'rendering cannot execute');
    const dialog=page.locator('#powershell-dialog');
    await page.locator('.message.codex .md-run-powershell').click();assert.equal(await dialog.locator('[name="cwd"]').inputValue(),root);assert.equal(await dialog.locator('[name="code"]').inputValue(),code1);
    await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts.length,0,'cancel cannot execute');
    await page.locator('.message.codex .md-run-powershell').click();
    await page.setViewportSize({width:390,height:900});assert.ok(await dialog.evaluate(e=>e.getBoundingClientRect().right<=innerWidth && e.scrollWidth<=e.clientWidth));
    await page.screenshot({path:path.join(qa,'review-mobile.png')});await page.setViewportSize({width:1440,height:1000});
    await dialog.getByRole('button',{name:'确认运行',exact:true}).click();await dialog.getByText(/已启动 PowerShell 窗口/).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'确认运行',exact:true}).isDisabled(),true,'success cannot be duplicated accidentally');
    const one=await waitForFile(first);assert.equal(path.resolve(one.cwd),path.resolve(root));assert.equal(one.text,'中文 "quotes" $literal & 原样');assert.equal(one.inputRedirected,false);assert.equal(one.outputRedirected,false);
    await page.screenshot({path:path.join(qa,'started-desktop.png')});await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('.message.claude .md-run-powershell').click();await dialog.locator('[name="cwd"]').fill(path.join(qa,'missing'));
    await dialog.getByRole('button',{name:'确认运行',exact:true}).click();await dialog.getByText(/不会自动重试/).waitFor();assert.equal(posts.length,2);
    await dialog.locator('[name="cwd"]').fill(custom);await dialog.getByRole('button',{name:'确认运行',exact:true}).click();await dialog.getByText(/已启动 PowerShell 窗口/).waitFor();
    const two=await waitForFile(second);assert.equal(two.cwd,nested);assert.equal(two.text,one.text);assert.equal(two.inputRedirected,false);assert.equal(two.outputRedirected,false);
    assert.deepEqual(posts.map(p=>p.code),[code1,code2,code2]);assert.deepEqual(errors,[]);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await page.route('**/health',r=>r.fulfill({json:{app:'phd-workflows',version:2,chat_markdown:true}}));await page.reload();await page.locator('.md-copy').first().waitFor();assert.equal(await page.locator('.md-run-powershell').count(),0,'old backend remains copy-only');
  }finally{
    if(browser)await browser.close();await new Promise(r=>server.close(r));
    // Harmless consoles exit themselves; no blanket process kill or real files.
    await new Promise(r=>setTimeout(r,2200));
  }
});
