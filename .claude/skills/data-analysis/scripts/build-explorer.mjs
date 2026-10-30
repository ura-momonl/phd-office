import fs from 'node:fs';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';

const templateFile=fileURLToPath(new URL('../assets/grouped-signal-explorer.html',import.meta.url));
const need=(ok,message)=>{if(!ok)throw new Error(message);};

// This contract is for grouped, multi-channel complex/paired-component signals.
// Parsing instruments and choosing/calculating processing methods belong upstream.
function validate(data) {
  need(Array.isArray(data.channels)&&data.channels.length&&data.channels.every(x=>typeof x==='string'),'channels must be a nonempty string array');
  need(new Set(data.channels).size===data.channels.length,'channels must be unique');
  need(Array.isArray(data.methods)&&data.methods.length&&data.methods.every(m=>typeof m.id==='string'&&typeof m.label==='string'),'methods require id and label');
  const methods=new Set(data.methods.map(m=>m.id));
  need(methods.size===data.methods.length,'method ids must be unique');
  need(!data.default_channel||data.channels.includes(data.default_channel),'default_channel is not in channels');
  need(Array.isArray(data.groups)&&data.groups.length,'groups must be nonempty');
  for(const [i,g] of data.groups.entries()) {
    const at=`groups[${i}]`;
    need(typeof g.id==='string'&&typeof g.source==='string'&&typeof g.config==='string'&&Number.isFinite(g.condition),at+' requires id, source, config and numeric condition');
    need(Array.isArray(g.cols)&&g.cols.every(c=>typeof c==='string')&&Array.isArray(g.rows),at+' requires cols and rows');
    need(g.rows.every(r=>Array.isArray(r)&&r.length===g.cols.length),at+' row width differs from cols');
    need(Array.isArray(g.steps),at+' requires precomputed steps (may be empty)');
    for(const s of g.steps) {
      need(Number.isFinite(s.current)&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.values&&typeof s.values==='object',at+' step requires current, start, end and values');
      for(const [channel,results] of Object.entries(s.values)) {
        need(data.channels.includes(channel),at+' step has undeclared channel');
        for(const [method,value] of Object.entries(results)) {
          need(methods.has(method),at+' step has undeclared processing method');
          need(Array.isArray(value)&&value.length>=2&&Number.isFinite(value[0])&&Number.isFinite(value[1]),at+' result must start with finite paired components');
        }
      }
    }
  }
}

export function buildExplorer(inputFile,adapterFile,outputFile) {
  const target=path.resolve(outputFile);
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  for(const source of [inputFile,adapterFile,templateFile])need(!same(path.resolve(source),target),'output must not overwrite input, adapter or template');
  const bytes=fs.readFileSync(inputFile);
  const text=(bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes):bytes).toString('utf8').replace(/^\uFEFF/,'');
  const data=JSON.parse(text);validate(data);
  const adapter=fs.readFileSync(adapterFile,'utf8').replace(/<\/script/gi,'<\\/script');
  need(/signalAdapter/.test(adapter),'adapter must define window.signalAdapter');
  const bundle=gzipSync(JSON.stringify(data)).toString('base64');
  const template=fs.readFileSync(templateFile,'utf8');
  need(template.split('__ADAPTER__').length===2&&template.split('__BUNDLE__').length===2,'template markers are missing or duplicated');
  const html=template.replace(/__ADAPTER__|__BUNDLE__/g,marker=>marker==='__ADAPTER__'?adapter:bundle);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,html);
  return {output:target,groups:data.groups.length,rows:data.groups.reduce((n,g)=>n+g.rows.length,0),bytes:Buffer.byteLength(html)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==5) {console.error('Usage: node build-explorer.mjs prepared.json[.gz] trusted-adapter.js output.html');process.exitCode=1;}
  else {try {console.log(JSON.stringify(buildExplorer(...process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
}
