// Reader briefing (writes only the .briefed.json stamp): reader_guide + the single selection standard + task info + first title window, in one call.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {local,read} from './records.mjs';
const taskPath=process.argv[2];
if(!taskPath)throw Error('Usage: brief.mjs <TASK file>');
const t=read(taskPath);
// Recording results (reader-work titles/mark/read/append) requires this stamp, so every reader sees the one standard printed below.
fs.writeFileSync(local(t.chunk_file.replace(/\.json$/,'')+'.briefed.json'),JSON.stringify({task:taskPath,at:new Date().toISOString()})+'\n');
const text=p=>fs.readFileSync(local(p),'utf8');
const card='.agents/skills/literature-backfill/references/reader-card.md';
console.log('=== reader card: '+card+String.fromCharCode(10)+text(card));
console.log('=== reader_guide: '+t.reader_guide+'\n'+text(t.reader_guide));
const strategy='output/literature-rebuild-20261021/FUTURE-SCREENING-STRATEGY.md';
console.log('=== selection standard: '+strategy+'\n'+text(strategy));
console.log('=== task\n'+JSON.stringify({id:t.id,count:t.count,chunk_file:t.chunk_file,output:t.output,task:taskPath},null,1));
console.log('=== first title window (reader-work.mjs titles)');
const worker=fileURLToPath(new URL('./reader-work.mjs',import.meta.url));
console.log(execFileSync(process.execPath,[worker,'titles',taskPath],{encoding:'utf8',maxBuffer:1<<24}));
