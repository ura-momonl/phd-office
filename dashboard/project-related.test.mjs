import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {root,read,write} from '../automation/files.mjs';
import {createServer} from './server.mjs';
import {launchEdge} from '../automation/browser-launch.mjs';
import {addEvent} from '../calendar/run.mjs';
import {enqueue} from '../work/run.mjs';
import {withFramework,proposeLinks} from '../projects/run.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run through scripts/run-tests.mjs in an isolated copy');

test('future correspondence and arrangements persist in the existing related section, not research lines',async()=>{
  assert.equal(read('agent/config.json').enabled,false);
  const pid='tairte4-transport',other='graphene-thz',framework=path.join(root,'workspace/projects',pid,'FRAMEWORK.md');
  const before=fs.readFileSync(framework),catalog=read('projects/catalog.json');
  const cli=(action,arg)=>JSON.parse(execFileSync(process.execPath,['automation/run.mjs','projects',action,arg],{cwd:root,encoding:'utf8'}));
  const requestFile=path.join(root,'.runtime','related-fixture.json');
  fs.writeFileSync(requestFile,JSON.stringify({project_id:pid,title:'与合作组约会面',kind:'meeting',date:'2026-10-28',body:'先确认房间；不涉及物理结论。',source:'chat:fixture'}));
  const note=cli('related-add',requestFile).item;
  assert.equal(cli('related',pid).items.find(r=>r.id===note.id).body,'先确认房间；不涉及物理结论。');
  fs.writeFileSync(requestFile,JSON.stringify({project_id:other,title:'OTHER_PROJECT_PRIVATE_NOTE'}));cli('related-add',requestFile);

  const step=enqueue({title:'确认会议室',goal:'向合作组确认会议室',kind:'misc',actor:'user',project_ids:[pid]});
  const mailStep=enqueue({title:'邮件确认排期',kind:'mail',actor:'user',project_ids:[pid]});
  const p=withFramework([catalog.projects.find(p=>p.id===pid)])[0];
  const logBoard=p.framework.boards.find(b=>b.type==='timeline');assert.ok(logBoard?.id);
  const research=enqueue({title:'讨论确立的测量方案',kind:'misc',actor:'user',project_ids:[pid],plan_node_id:logBoard.id});
  const event=addEvent({title:'合作组会面',start:'2026-10-28T14:00:00-05:00',end:'2026-10-28T14:30:00-05:00',project_id:pid,note:'楼下会议室'});
  const oldEvent=addEvent({title:'已发生的合作会议',start:'2026-10-01T14:00:00-05:00',project_id:pid});
  const db=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
  try {
    db.prepare('INSERT INTO tasks(id,title,status,action,contacts,subjects,artifacts) VALUES(?,?,?,?,?,?,?)').run('future-related-mail','TaIrTe4 会议邀请','todo','确认时间','[]','[]','[]');
  } finally {db.close();}
  assert.equal(proposeLinks([{id:'future-related-mail',title:'TaIrTe4 会议邀请',action:'确认时间'}]).added,1);
  assert.deepEqual(read('projects/catalog.json').links.find(l=>l.item_id==='future-related-mail').project_ids,[pid]);

  const server=createServer();let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=async body=>{
      const response=await fetch(base+'/api/projects/related',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return {response,json:await response.json()};
    };
    const invalid=await post({project_id:pid,title:'   '});assert.equal(invalid.response.ok,false);
    const unknown=await post({project_id:'missing',title:'must not be saved'});assert.equal(unknown.response.ok,false);
    assert.equal(cli('related',pid).items.length,1);
    const large=await post({project_id:pid,title:'长事务笔记',body:'中'.repeat(16000)});
    assert.equal(large.response.ok,true,'a valid Unicode note fits through the HTTP boundary');
    const context=cli('context',pid);
    assert.equal(context.related[0].id,note.id);assert.ok(context.calendar.some(e=>e.id===event.id));
    assert.ok(context.items.some(i=>i.item?.id==='future-related-mail'));

    browser=await launchEdge();
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.goto(base+'/#projects/'+pid);
    const panel=page.locator(`[data-expand="sources:${pid}"]`);
    await panel.locator('> summary').click();
    await panel.locator(`[data-related-id="${note.id}"]`).waitFor();
    for(const t of [step,mailStep]) {
      assert.equal(await panel.locator(`[data-related-work="${t.id}"]`).count(),1);
      assert.equal(await page.locator(`.plan-panel [data-step-row="${t.id}"]`).count(),0,'ordinary arrangements must not appear in either research line');
    }
    assert.equal(await page.locator(`.plan-panel [data-step-row="${research.id}"]`).count(),1,'an explicitly research-bound task stays on its research node');
    assert.equal(await panel.locator('[data-related-mail="future-related-mail"]').count(),1);
    for(const e of [event,oldEvent])assert.equal(await panel.locator(`[data-related-event="${e.id}"]`).count(),1);
    assert.equal(await panel.getByText('OTHER_PROJECT_PRIVATE_NOTE').count(),0);

    await panel.locator(`[data-expand="related-add:${pid}"] > summary`).click();
    const form=panel.locator('[data-project-related-form]');
    await form.locator('[name=title]').fill('确认会议安排与附件');
    await form.locator('[name=body]').fill('中文与弯引号 “保持原样”\n第二行 <img src=x onerror=alert(1)>');
    // A genuine state poll must not discard the in-progress record.
    await page.clock.fastForward(6000);
    assert.equal(await form.locator('[name=title]').inputValue(),'确认会议安排与附件');
    await form.locator('[name=kind]').selectOption('meeting');
    const saved=page.waitForResponse(r=>r.url()===base+'/api/projects/related' && r.request().method()==='POST');
    await form.locator('button[type=submit]').click();const receipt=await saved;assert.equal(receipt.ok(),true);
    const savedNote=(await receipt.json()).item;
    await panel.locator(`[data-related-id="${savedNote.id}"]`).waitFor();
    assert.ok((await panel.locator(`[data-related-id="${savedNote.id}"] > summary`).textContent()).includes('确认会议安排与附件'));
    await page.reload();await panel.locator('> summary').click();
    const stored=cli('related',pid).items.find(r=>r.title==='确认会议安排与附件');
    assert.equal(stored.body,'中文与弯引号 “保持原样”\n第二行 <img src=x onerror=alert(1)>');
    const row=panel.locator(`[data-related-id="${stored.id}"]`);await row.locator('summary').click();
    assert.equal(await row.locator('img').count(),0,'notes are escaped, not interpreted as HTML');
    assert.ok((await row.textContent()).includes('<img src=x onerror=alert(1)>'));
    if(process.env.PHD_TEST_ARTIFACTS) {
      fs.mkdirSync(process.env.PHD_TEST_ARTIFACTS,{recursive:true});
      await panel.locator(`[data-expand="related-add:${pid}"] > summary`).click();
      await panel.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-related.png')});
      await page.setViewportSize({width:390,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the related form fits a narrow viewport');
      await panel.screenshot({path:path.join(process.env.PHD_TEST_ARTIFACTS,'project-related-mobile.png')});
    }
    // Closing a mail matter does not remove its record from the related section.
    const finish=new DatabaseSync(path.join(root,'.runtime/mail-flow/mail.sqlite'));
    try {finish.prepare("UPDATE tasks SET status='done' WHERE id=?").run('future-related-mail');} finally {finish.close();}
    await page.reload();await panel.locator('> summary').click();
    assert.equal(await panel.locator('[data-related-mail="future-related-mail"]').count(),1);
    assert.deepEqual(fs.readFileSync(framework),before,'none of the writes change research prose or timeline');
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
});
