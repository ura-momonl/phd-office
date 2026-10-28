import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {root,read,write} from '../automation/files.mjs';
import {invokeNative} from '../agent/run.mjs';
import {memoryNoteMaterial} from '../memory2/note.mjs';
import {companionText} from '../prompts/templates.mjs';

const folder='.runtime/companion-notes';
const authors=[['codex','sol'],['claude','Claude'],['deepseek','DeepSeek']];
// Each day two of the three write, in a random order. Six ordered pairs, uniform; the first and last keep the earlier codex/claude orders for random()=0 and ~1.
const pairs=[['codex','claude'],['codex','deepseek'],['deepseek','codex'],['deepseek','claude'],['claude','deepseek'],['claude','codex']];
const flights=new Map();
export const notesBusy=()=>flights.size>0;
export function noteDate(now=new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
const fileFor=date=>`${folder}/${date}.json`;

// Public view contains only today's messages, never prompts, model telemetry or office data.
export function companionNotes(now=new Date()) {
  const date=noteDate(now),record=read(fileFor(date));
  const order=record?.messages.map(m=>m.provider) || [];
  return {date,enabled:read('agent/config.json').enabled===true,attempted:!!record,
    messages:order.map(provider=>authors.find(a=>a[0]===provider)).map(([provider,author])=>{
      const m=record?.messages.find(n=>n.provider===provider);
      return {author,text:m?.text || '',status:m.status==='writing' && !flights.has(date) ? 'interrupted' : m.status};
    })};
}

export function notePrompt(provider,date,previous=[],earlier,{cues=[],episodes=[]}={}) {
  const memory=cues.length || episodes.length ? companionText.memory(cues,episodes) : '';
  return companionText.note({provider,date,memory,previous:JSON.stringify(previous),earlier:earlier ? companionText.earlier(JSON.stringify(earlier)) : ''});
}

// Once per Chicago day, requested by a visible empty chat. Claim BEFORE either native
// call, including across process restarts; failure/interruption never auto-replays.
export function ensureCompanionNotes({now=new Date(),runner=invokeNative,random=Math.random}={}) {
  const date=noteDate(now);
  if(flights.has(date))return flights.get(date);
  if(read(fileFor(date)))return Promise.resolve(companionNotes(now));
  const cfg=read('agent/config.json');
  if(runner===invokeNative && !cfg.enabled)return Promise.resolve(companionNotes(now));
  fs.mkdirSync(path.join(root,folder),{recursive:true});
  const orderedAuthors=pairs[Math.floor(random()*pairs.length)].map(p=>authors.find(a=>a[0]===p));
  const record={date,messages:orderedAuthors.map(([provider])=>({provider,status:'writing',text:''}))};
  try {fs.writeFileSync(path.join(root,fileFor(date)),JSON.stringify(record,null,2)+'\n',{flag:'wx'});}
  catch(e){if(e.code==='EEXIST')return Promise.resolve(companionNotes(now));throw e;}
  const promise=Promise.resolve().then(async()=>{
    for(const m of record.messages) {
      const runId=`companion-note-${randomUUID()}`,directory=path.join(root,'.runtime/agent/runs',runId);
      m.run_id=runId;
      write(fileFor(date),record);
      try {
        const previous=fs.readdirSync(path.join(root,folder)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)&&f.slice(0,10)<date)
          .sort().slice(-3).map(f=>read(`${folder}/${f}`).messages.find(n=>n.provider===m.provider)?.text).filter(Boolean);
        const first=record.messages[0];
        const earlier=m!==first && first.status==='completed'
          ? {author:authors.find(([provider])=>provider===first.provider)[1],text:first.text} : undefined;
        const body=notePrompt(m.provider,date,previous,earlier,memoryNoteMaterial(m.provider,date)),deepseek=m.provider==='deepseek';
        // The DeepSeek harness has no separate system prompt; its one-line framing goes in front of the note prompt.
        const output=await runner(m.provider,deepseek ? companionText.system()+'\n\n'+body : body,{mode:'ask',purpose:'companion-note',
          model:{codex:cfg.codex_model,claude:cfg.claude_model,deepseek:cfg.deepseek_model}[m.provider],effort:deepseek ? 'low' : 'medium',directory,
          systemPrompt:companionText.system(),signal:AbortSignal.timeout(120000)});
        const text=output.result?.trim();
        if(output.toolCalls || !text || [...text].length>180)throw new Error('留言未通过正文/无工具校验');
        m.text=text;m.status='completed';m.model=output.model;m.at=new Date().toISOString();
      }catch(e){m.status='failed';m.error=e.message;}
      write(fileFor(date),record);
    }
    return companionNotes(now);
  }).finally(()=>flights.delete(date));
  flights.set(date,promise);
  return promise;
}
