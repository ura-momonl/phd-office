import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,write,read} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {createSpeech,SPEECH_LIMITS} from './speech.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use node scripts/run-tests.mjs --speech --keep');
const listen=async speech=>{const server=createServer({speech});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,origin:`http://127.0.0.1:${server.address().port}`};};
const close=server=>new Promise(r=>server.close(r));

test('voice API enforces same-origin, bounded audio and language before calling decoder',async()=>{
  const calls=[];let stopped=false;
  const {server,origin}=await listen({available:()=>true,transcribe:async(bytes,options)=>{calls.push({bytes,options});return {text:'实验记录',language:'zh'};},close:()=>stopped=true});
  const send=(headers,body='audio',suffix='')=>fetch(origin+'/api/speech/transcribe'+suffix,{method:'POST',headers,body});
  try {
    for(const headers of [{'Content-Type':'audio/webm'},{'Content-Type':'audio/webm',Origin:'http://foreign.example'},{'Content-Type':'audio/webm',Origin:'http://evil.example',Host:'evil.example'}])assert.equal((await send(headers)).status,403);
    assert.equal((await send({'Content-Type':'application/json',Origin:origin},'{}')).status,415);
    assert.equal((await send({'Content-Type':'audio/webm',Origin:origin},'audio','?language=unknown')).status,400);
    assert.equal((await send({'Content-Type':'audio/webm',Origin:origin},Buffer.alloc(SPEECH_LIMITS.maxBytes+1))).status,413);
    assert.equal(calls.length,0);
    const response=await send({'Content-Type':'audio/webm;codecs=opus',Origin:origin},'audio','?language=zh');assert.equal(response.status,200);assert.equal((await response.json()).text,'实验记录');assert.equal(calls.length,1);assert.equal(calls[0].bytes.toString(),'audio');assert.deepEqual(calls[0].options,{language:'zh'});
    assert.equal(read('work/queue.json').items.length,0,'dictation cannot enqueue chat');
  }finally{await close(server);}
  assert.equal(stopped,true);
});

test('missing speech install is honest and does not download or start a worker',async()=>{
  const speech=createSpeech({python:path.join(root,'.runtime/missing-python.exe'),model:path.join(root,'.runtime/missing-model')});
  assert.equal(speech.available(),false);
  await assert.rejects(speech.transcribe(Buffer.from('audio')),/尚未安装/);
  await assert.rejects(speech.transcribe(Buffer.alloc(0)),/录音为空/);
  await assert.rejects(speech.transcribe(Buffer.from('audio'),{language:'bad'}),/语言/);
  const {server,origin}=await listen(speech);
  try {
    assert.equal((await (await fetch(origin+'/health')).json()).chat_speech,false);
    assert.equal((await fetch(origin+'/api/speech/transcribe',{method:'POST',headers:{Origin:origin,'Content-Type':'audio/webm'},body:'audio'})).status,503);
  }finally{await close(server);}
});

test('real composer recording preserves drafts, cancellation, navigation, permissions; optional actual CUDA receiver',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  write('.runtime/agent/sessions.json',{sessions:['voice-a','voice-b'].map(id=>({id,title:id,task_ids:[],project_ids:[],messages:[]}))});
  let decoder=async()=>({text:'语音转写结果',language:'zh'}),calls=0,real;
  const {server,origin}=await listen({available:()=>true,transcribe:(...args)=>{assert.equal(args[1]?.language,undefined,'composer always uses automatic language');calls++;return decoder(...args);},close:()=>real?.close()});
  let browser;
  const qa=path.join(root,'.runtime/speech-qa');fs.mkdirSync(qa,{recursive:true});
  try {
    const args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'];
    if(process.env.PHD_SPEECH_QA_AUDIO)args.push('--use-file-for-fake-audio-capture='+process.env.PHD_SPEECH_QA_AUDIO);
    browser=await launchEdge({args});const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1000}});const page=await context.newPage();
    await page.route('**/api/usage/refresh',r=>r.fulfill({json:{}}));
    await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('lab-session','voice-a');});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const chatPosts=[];page.on('request',r=>{if(r.method()==='POST' && new URL(r.url()).pathname==='/api/chat')chatPosts.push(r.postData());});
    await page.goto(origin);const record=page.locator('#voice-input'),input=page.locator('#message'),status=page.locator('#voice-status');
    await record.waitFor();await page.waitForFunction(()=>!document.querySelector('#voice-input').disabled);
    assert.equal(await status.isVisible(),false,'no idle hint or reserved status row');
    assert.equal(await page.locator('.paste-hint').count(),0,'composer has no permanent shortcut hint');
    assert.equal(await page.locator('#voice-language').count(),0);
    assert.equal(await record.locator('svg').count(),1);assert.equal(await record.textContent(),'');
    assert.equal(await record.getAttribute('aria-keyshortcuts'),'Control+Shift');
    const micBox=await record.boundingBox(),sendBox=await page.locator('#send').boundingBox();assert.ok(micBox.x+micBox.width<=sendBox.x && sendBox.x-micBox.x<60,'mic sits beside send');
    const shortcut=async(reverse=false)=>{const first=reverse ? 'Shift' : 'Control',second=reverse ? 'Control' : 'Shift';await page.keyboard.down(first);await page.keyboard.down(second);await page.keyboard.up(second);await page.keyboard.up(first);};
    // Other Ctrl+Shift combinations and a hidden composer must not start recording.
    await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyA');await page.keyboard.up('Shift');await page.keyboard.up('Control');assert.equal(await record.getAttribute('aria-pressed'),'false');
    await page.locator('[data-page="projects"]').first().click();await shortcut();assert.equal(await record.getAttribute('aria-pressed'),'false');await page.locator('[data-page="chat"]').first().click();
    await input.fill('原有草稿 @Codex');await shortcut();await page.waitForFunction(()=>document.querySelector('#voice-input').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#send').isDisabled(),true);await page.screenshot({path:path.join(qa,'recording.png')});
    await new Promise(r=>setTimeout(r,400));await shortcut(true);await page.waitForFunction(()=>document.querySelector('#voice-input').dataset.phase==='idle');assert.equal(await status.isVisible(),false,'success is silent');assert.equal(await input.inputValue(),'原有草稿 @Codex\n语音转写结果');assert.equal(chatPosts.length,0);assert.equal(calls,1);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#voice-input').disabled);assert.equal(await input.inputValue(),'原有草稿 @Codex\n语音转写结果','transcription uses the existing persisted tab draft');
    await record.click();await page.waitForFunction(()=>document.querySelector('#voice-input').getAttribute('aria-pressed')==='true');await page.locator('#voice-cancel').click();assert.equal(calls,1);assert.match(await input.inputValue(),/原有草稿/);
    // Edits while decoding must survive; Shift+Enter cannot bypass the recording guard.
    let finish;decoder=()=>new Promise(resolve=>finish=resolve);
    await record.click();await page.waitForFunction(()=>document.querySelector('#voice-input').getAttribute('aria-pressed')==='true');await new Promise(r=>setTimeout(r,300));await record.click();await page.waitForFunction(()=>document.querySelector('#voice-input').dataset.phase==='transcribing');
    await shortcut();assert.equal(await record.getAttribute('data-phase'),'transcribing','shortcut cannot launch duplicate decode');
    await input.fill('转写期间我补的内容');await input.press('Shift+Enter');assert.equal(chatPosts.length,0);
    while(!finish)await new Promise(r=>setTimeout(r,20));finish({text:'后来的转写',language:'zh'});await page.waitForFunction(()=>document.querySelector('#voice-input').dataset.phase==='idle');assert.equal(await input.inputValue(),'转写期间我补的内容\n后来的转写');
    // Switching sessions while an HTTP decode is pending discards its result.
    finish=undefined;await record.click();await page.waitForFunction(()=>document.querySelector('#voice-input').getAttribute('aria-pressed')==='true');await new Promise(r=>setTimeout(r,300));await record.click();while(!finish)await new Promise(r=>setTimeout(r,20));
    await page.locator('[data-session="voice-b"]').click();finish({text:'不能串入别的对话',language:'zh'});await page.waitForFunction(()=>document.querySelector('#session-title').textContent==='voice-b');assert.equal(await input.inputValue(),'');
    // Permission denial is visible; the input remains editable and sendable.
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};});await record.click();await status.getByText(/麦克风权限被拒/).waitFor();assert.equal(await page.locator('#send').isDisabled(),false);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#voice-input').disabled);
    await page.setViewportSize({width:390,height:900});await page.screenshot({path:path.join(qa,'mobile.png')});assert.ok(await page.locator('#composer').evaluate(e=>e.getBoundingClientRect().right<=innerWidth+1));
    if(process.env.PHD_SPEECH_QA_CONFIG && process.env.PHD_SPEECH_QA_AUDIO) {
      const config=JSON.parse(fs.readFileSync(process.env.PHD_SPEECH_QA_CONFIG,'utf8').replace(/^\uFEFF/,''));real=createSpeech(config);assert.equal(real.available(),true);decoder=(...args)=>real.transcribe(...args);
      await page.setViewportSize({width:1440,height:1000});await input.fill('保留的中文草稿');await record.click();await page.waitForFunction(()=>document.querySelector('#voice-input').getAttribute('aria-pressed')==='true');await new Promise(r=>setTimeout(r,8500));await record.click();
      await page.waitForFunction(()=>document.querySelector('#voice-input').dataset.phase==='idle',null,{timeout:120000});assert.equal(await status.isVisible(),false);assert.match(await input.inputValue(),/^保留的中文草稿\n/);assert.match(await input.inputValue(),/experiment notes/i);assert.equal(chatPosts.length,0);
      await page.screenshot({path:path.join(qa,'actual-cuda-result.png')});
      fs.writeFileSync(path.join(qa,'actual-cuda-result.json'),JSON.stringify({text:await input.inputValue(),chatPosts:chatPosts.length,model:config.model,python:config.python,fixture:'synthetic speech -> browser microphone -> MediaRecorder -> HTTP -> CUDA -> existing chat textarea'},null,2));
      assert.deepEqual(fs.readdirSync(path.join(root,'.runtime/speech/tmp')),[],'temporary audio cleaned after decode');
    }
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await close(server);}
});
