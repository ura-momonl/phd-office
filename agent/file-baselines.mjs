// Immutable file-state baselines live outside the frequently rewritten chat store.
// Persist the object before publishing its reference; never remove earlier baselines.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read,write} from '../automation/files.mjs';

const directory='.runtime/agent/file-baselines';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const location=ref=>{
  if(!/^[a-f0-9]{64}$/.test(ref?.sha256 || ''))throw new Error('Invalid file baseline reference');
  return `${directory}/${ref.sha256}.json`;
};
export function loadBaseline(value) {
  if(!value || value.files)return value; // Existing inline baselines remain readable.
  const file=location(value),baseline=read(file);
  if(!baseline || digest(baseline)!==value.sha256)throw new Error('File baseline missing or changed: '+file);
  return baseline;
}
export function saveBaseline(baseline) {
  const ref={sha256:digest(baseline)},file=location(ref);
  if(fs.existsSync(path.join(root,file)))loadBaseline(ref);
  else write(file,baseline);
  return ref;
}
// Run only at backend startup, before task recovery/dispatch. All child objects
// are committed first, so a failed write leaves the original session store usable.
export function migrateSessionBaselines() {
  const file='.runtime/agent/sessions.json',state=read(file,{sessions:[]});let moved=0;
  for(const session of state.sessions) {
    for(const [provider,value] of Object.entries(session.file_snapshots || {}))if(value?.files){
      session.file_snapshots[provider]=saveBaseline(value);moved++;
    }
    const legacy=session.codex_continuation?.fileSnapshot;
    if(legacy?.files){session.codex_continuation.fileSnapshot=saveBaseline(legacy);moved++;}
  }
  if(moved)write(file,state);
  return moved;
}
