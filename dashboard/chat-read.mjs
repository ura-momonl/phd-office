import {read,write} from '../automation/files.mjs';
import {agentUpdates} from './workspace.js';

const file='.runtime/dashboard/chat-read.json';
export const chatReadState=()=>read(file,{});

// Devices report the final reply they actually saw, never their wall clock.
// Merge monotonically so an older device/request cannot make a reply unread again.
export function markChatRead(receipts,state) {
  if(!receipts || typeof receipts!=='object' || Array.isArray(receipts))throw new Error('Invalid chat read receipts');
  const latest=new Map();
  for(const u of agentUpdates(state))latest.set(u.sessionId,Math.max(latest.get(u.sessionId) || 0,Date.parse(u.at)));
  const saved=chatReadState();let changed=false;
  for(const [id,at] of Object.entries(receipts)) {
    if(typeof at!=='number' || !Number.isFinite(at) || at<=0)throw new Error('Invalid chat read timestamp');
    if(!latest.has(id))continue;
    const seen=Math.min(at,latest.get(id));
    if(seen>Number(saved[id] || 0)){saved[id]=seen;changed=true;}
  }
  if(changed)write(file,saved);
  return saved;
}
