import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,read} from '../automation/files.mjs';

// Check concrete framework command/document references; prose still needs normal review.
const docs=['AGENTS.md','projects/README.md','projects/FRAMEWORK-RULES.md','projects/FRAMEWORK-TOOLS.md','mail-flow/MAIL-BRIEF.md'];
const text=file=>fs.readFileSync(path.join(root,file),'utf8');

test('every "projects <action>" named in the framework documents is a real projects action',()=>{
  const actions=new Set(read('automation/config.json').modules.projects.actions),seen=new Set();
  for(const doc of docs.slice(1,4)) {
    for(const [,action] of text(doc).matchAll(/\bprojects ([a-z][a-z-]+)\b/g)) {
      seen.add(action);assert.ok(actions.has(action),doc+' names "projects '+action+'", which is not a projects action');
    }
  }
  assert.ok(seen.has('entry-add') && seen.has('node-edit'),'the documents should still describe the core commands');
});

test('relative document paths cited in backticks resolve to existing files',()=>{
  let checked=0;
  for(const doc of docs) {
    for(const [,cited] of text(doc).matchAll(/`((?:[\w-]+\/)+[\w.-]+\.md|FRAMEWORK-(?:RULES|TOOLS)\.md)`/g)) {
      // AGENTS names the rules with a full path, then names the tools as "in the same directory".
      const candidates=[path.join(root,cited),path.join(root,path.dirname(doc),cited)];
      if(/^FRAMEWORK-(RULES|TOOLS)\.md$/.test(cited))candidates.push(path.join(root,'projects',cited));
      const found=candidates.some(p=>fs.existsSync(p));
      assert.ok(found,doc+' cites '+cited+', which does not exist');checked++;
    }
  }
  for(const doc of docs)for(const [,link] of text(doc).matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
    if(/^[a-z]+:/i.test(link) || path.isAbsolute(link))continue;
    assert.ok(fs.existsSync(path.resolve(root,path.dirname(doc),link)),doc+' has a broken relative Markdown link: '+link);checked++;
  }
  assert.ok(checked>=5,'expected to check the known citations, got '+checked);
  assert.ok(!fs.existsSync(path.join(root,'.agents/skills/research-framework')),'the old skill location must not come back');
});
