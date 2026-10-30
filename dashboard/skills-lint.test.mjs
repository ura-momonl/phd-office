import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root} from '../automation/files.mjs';
import {skillsView,run} from './settings.mjs';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Use scripts/run-tests.mjs in a sanitised copy');

const ZERO_WIDTH=String.fromCharCode(0x200B),TAG_A=String.fromCodePoint(0xE0041);
async function withSkills(make,check) {
  const skills=path.join(root,'.agents/skills'),existed=fs.existsSync(skills),made=[];
  const skill=(dir,files)=>{
    const d=path.join(skills,dir);
    for(const [name,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(d,name)),{recursive:true});fs.writeFileSync(path.join(d,name),text);}
    made.push(d);return d;
  };
  try{make(skill);const view=await skillsView(),names=new Set(made.map(d=>path.basename(d)));await check(Object.fromEntries(view.skills.filter(s=>names.has(s.dir)).map(s=>[s.dir,s])));}
  finally{for(const d of made)fs.rmSync(d,{recursive:true,force:true});if(!existed)fs.rmSync(skills,{recursive:true,force:true});}
}
const head=name=>`---\nname: ${name}\ndescription: 测试用\n---\n`;

test('a user-level Claude entry is not reported as unavailable because its project link is absent',async()=>{
  const home=fs.mkdtempSync(path.join(root,'tmp-skill-home-')),before=process.env.OFFICE_BASE_HOME;
  try {
    process.env.OFFICE_BASE_HOME=home;
    const user=path.join(home,'.claude/skills/t-user-entry/SKILL.md');
    fs.mkdirSync(path.dirname(user),{recursive:true});fs.writeFileSync(user,head('t-user-entry')+'依据适用。');
    await withSkills(skill=>{
      skill('t-user-entry',{'SKILL.md':head('t-user-entry')+'依据适用。'});
      skill('t-no-entry',{'SKILL.md':head('t-no-entry')+'依据适用。'});
    },async by=>{
      assert.equal(by['t-user-entry'].claude,'missing','project link status remains a filesystem fact');
      assert.ok(!by['t-user-entry'].issues.some(i=>i.includes('同名链接')));
      assert.ok(by['t-user-entry'].notes.some(i=>i.includes('用户级同名文件')));
      assert.ok(by['t-no-entry'].issues.some(i=>i.includes('未找到同名用户级文件')));
    });
  } finally {
    if(before===undefined)delete process.env.OFFICE_BASE_HOME;else process.env.OFFICE_BASE_HOME=before;
    fs.rmSync(home,{recursive:true,force:true});
  }
});

test('advisory notes: a well-formed skill is quiet, and each soft rule fires only on its own trigger',()=>withSkills(skill=>{
  skill('t-lint-good',{'SKILL.md':head('t-lint-good')+'依据：2026-10-16 某任务实际走通。适用：整理样品账本。验证范围：一份账本。\n步骤略。\n'});
  skill('t-lint-nobasis',{'SKILL.md':head('t-lint-nobasis')+'直接写步骤，没有来历。\n'});
  skill('t-lint-diary',{'SKILL.md':head('t-lint-diary')+'依据与适用：见下。\n'+Array.from({length:6},(_,i)=>`2026-10-0${i+1} 今天做了某事`).join('\n')+'\n'});
  skill('t-lint-long',{'SKILL.md':head('t-lint-long')+'依据与适用：测试。\n'+'做法。'.repeat(2500)});
  skill('t-lint-files',{'SKILL.md':head('t-lint-files')+'依据与适用：测试。\n',...Object.fromEntries(Array.from({length:16},(_,i)=>[`references/r${i}.md`,'x']))});
},async by=>{
  assert.deepEqual(by['t-lint-good'].notes,[],'依据 and 适用 in the opening, no diary, short, few files');
  assert.match(by['t-lint-nobasis'].notes.join(),/依据与适用条件/);
  assert.match(by['t-lint-diary'].notes.join(),/6 行以日期开头/);assert.doesNotMatch(by['t-lint-diary'].notes.join(),/依据与适用条件/);
  assert.match(by['t-lint-long'].notes.join(),/较长/);
  assert.match(by['t-lint-files'].notes.join(),/附属文件 16 个/);
  for(const s of Object.values(by))assert.ok(!s.issues.some(i=>/不可见/.test(i)),s.dir+' has no hidden characters');
}));

test('hidden control characters in the skill or its reference files are reported as an issue, naming the file',()=>withSkills(skill=>{
  skill('t-hide-body',{'SKILL.md':head('t-hide-body')+'依据适用。正常文字'+ZERO_WIDTH+'后面藏了零宽字符\n'});
  skill('t-hide-ref',{'SKILL.md':head('t-hide-ref')+'依据适用。\n','references/a.md':'正常','references/b.md':'带标签字符'+TAG_A});
  skill('t-hide-bom',{'SKILL.md':'﻿'+head('t-hide-bom')+'依据适用。\n','references/a.md':'﻿开头的字节序标记不算'});
  skill('t-hide-binary',{'SKILL.md':head('t-hide-binary')+'依据适用。\n','assets/logo.png':'x'+ZERO_WIDTH+'y'});
},async by=>{
  assert.match(by['t-hide-body'].issues.join(),/含不可见控制字符：SKILL\.md/);
  assert.match(by['t-hide-ref'].issues.join(),/含不可见控制字符：references\/b\.md/);assert.doesNotMatch(by['t-hide-ref'].issues.join(),/a\.md/);
  assert.ok(!by['t-hide-bom'].issues.some(i=>/不可见/.test(i)),'a leading byte-order mark is not hidden text');
  assert.ok(!by['t-hide-binary'].issues.some(i=>/不可见/.test(i)),'only text-like files are scanned');
}));

test('the command-line listing shows notes separately from issues',()=>withSkills(skill=>{skill('t-cli-note',{'SKILL.md':head('t-cli-note')+'没有来历。\n'});},async()=>{
  const lines=[],log=console.log;console.log=(...a)=>lines.push(a.join(' '));
  try{await run('skills');}finally{console.log=log;}
  const line=lines.find(l=>l.startsWith('t-cli-note '));assert.ok(line);assert.match(line,/；提示：正文开头没有看到依据与适用条件/);
}));

test('base skills view lists user-level, synced and system skills read-only, and compares only same-name user-level ones',async()=>{
  const {baseSkillsView}=await import('./settings.mjs');
  const home=fs.mkdtempSync(path.join(root,'tmp-base-home-')),before=process.env.OFFICE_BASE_HOME;
  const put=(rel,text)=>{const f=path.join(home,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);return f;};
  const sk=(name,body='正文')=>`---\nname: ${name}\ndescription: 测试 ${name}\n---\n${body}\n`;
  try {
    process.env.OFFICE_BASE_HOME=home;
    put('.claude/skills/same-one/SKILL.md',sk('same-one'));put('.codex/skills/same-one/SKILL.md',sk('same-one'));
    put('.claude/skills/drift-one/SKILL.md',sk('drift-one','甲'));put('.codex/skills/drift-one/SKILL.md',sk('drift-one','乙'));
    put('.claude/skills/only-claude/SKILL.md',sk('only-claude'));
    put('.claude/skills/synced/bucket-1/vendor-doc/SKILL.md',sk('vendor-doc'));put('.codex/skills/.system/vendor-doc/SKILL.md',sk('vendor-doc','别的内容'));
    put('.claude/skills/broken/SKILL.md','没有头部');
    put('.claude/plugins/marketplaces/m/plugins/p/skills/x/SKILL.md',sk('x'));
    const view=await baseSkillsView(),by=Object.fromEntries(view.assistants.map(a=>[a.id,a]));
    assert.deepEqual(by.claude.skills.map(s=>`${s.name}:${s.source}`).sort(),['broken:用户级','drift-one:用户级','only-claude:用户级','same-one:用户级','vendor-doc:官方同步']);
    assert.deepEqual(by.codex.skills.map(s=>`${s.name}:${s.source}`).sort(),['drift-one:用户级','same-one:用户级','vendor-doc:系统自带']);
    assert.deepEqual(Object.fromEntries(view.shared.map(s=>[s.name,s.same])),{'same-one':true,'drift-one':false},'vendor copies are not compared; user-level ones are');
    assert.match(by.claude.skills.find(s=>s.name==='broken').issues.join(),/description/);
    assert.equal(by.claude.plugin_skill_files,1);assert.equal(by.codex.plugin_skill_files,0);
    assert.ok(by.claude.always_tokens>0);
    const lines=[],log=console.log;console.log=(...a)=>lines.push(a.join(' '));try{await run('skills');}finally{console.log=log;}
    assert.ok(lines.some(l=>l.startsWith('Claude：5 个')) && lines.some(l=>l.includes('两边同名：drift-one，内容不同')) && lines.some(l=>l.includes('两边同名：same-one，内容相同')));
    assert.ok(fs.existsSync(path.join(home,'.claude/skills/same-one/SKILL.md')),'the scan does not touch the files');
  } finally {
    if(before===undefined)delete process.env.OFFICE_BASE_HOME;else process.env.OFFICE_BASE_HOME=before;
    fs.rmSync(home,{recursive:true,force:true});
  }
});
