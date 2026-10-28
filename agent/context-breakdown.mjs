// What occupies a native session's context window right now, read from the transcript the CLI itself keeps (Claude: ~/.claude/projects/*/<id>.jsonl,
// Codex: ~/.codex/sessions/**/rollout-*-<thread>.jsonl). Sizes are estimated from characters, then scaled so that the parts add up to the total the
// provider actually reported for the latest request. The fixed part (system prompt, tool and skill definitions, instruction files) is not in the
// transcript as text. Two requests of the same session pin it down together with the estimate's scale: reported = fixed + scale × estimated, once for the
// first request and once for the latest. If the two points cannot give a sensible answer, the fixed part is the first request minus its estimate.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Characters to tokens, deliberately high (checked against 5 Claude runs with prompts over 20k characters, net of about 26k fixed overhead: 12–17% over).
export const estimateTokens=text=>{const cjk=(text.match(/[⺀-鿿＀-￯]/g) || []).length;return Math.ceil(cjk*1.3+(text.length-cjk)*0.4);};

const textOf=v=>typeof v==='string' ? v : Array.isArray(v) ? v.map(textOf).join('') : v && typeof v==='object' ? (typeof v.text==='string' ? v.text : v.type==='image' || v.type==='input_image' ? '' : JSON.stringify(v)) : '';
const IMAGE_TOKENS=1500;

// Accumulates estimated tokens per part; `fixed` is worked out last.
function parts(order) {
  const est=new Map(order.map(([key,label])=>[key,{key,label,est:0}]));
  return {add(key,tokens){if(tokens>0)est.get(key).est+=tokens;},sum(){return [...est.values()].reduce((a,p)=>a+p.est,0);},list:()=>[...est.values()].map(p=>({...p}))};
}
// first/last: {T: tokens the provider reported for that request, E: estimated tokens of the transcript up to it}; list: the estimated parts at the last request.
export function settle(list,first,last) {
  if(!(last?.T>0) || !(first?.T>0) || !(last.E>0))return null;
  let scale=(last.T-first.T)/(last.E-first.E),fixed=first.T-scale*first.E;
  if(!(last.E-first.E>2000) || !(scale>=0.2 && scale<=1.5) || !(fixed>=0)) {   // too little growth or an odd fit: trust the first request for the fixed part
    fixed=Math.max(0,Math.min(last.T,first.T-first.E));scale=(last.T-fixed)/last.E;
  }
  const out=[{key:'fixed',label:'固定开销（系统提示、工具与技能定义）',tokens:Math.round(fixed)},
    ...list.filter(p=>p.est>0).map(p=>({key:p.key,label:p.label,tokens:Math.round(p.est*scale)}))];
  out[0].tokens+=last.T-out.reduce((a,p)=>a+p.tokens,0);   // rounding goes to the fixed part, so the parts always add up to the total
  return {total:last.T,scale:Math.round(scale*100)/100,parts:out.filter(p=>p.tokens>0)};
}

const lines=file=>fs.readFileSync(file,'utf8').split('\n');
const parse=(line,needles)=>{if(!needles.some(n=>line.includes(n)))return null;try {return JSON.parse(line);} catch {return null;}};

const CLAUDE_TOOL={Read:'read',NotebookRead:'read',Bash:'cmd',PowerShell:'cmd',BashOutput:'cmd',Grep:'search',Glob:'search',WebFetch:'web',WebSearch:'web'};
const CLAUDE_PARTS=[['summary','压缩摘要'],['user','用户消息'],['assistant','助手文字'],['call','工具调用'],['read','读文件'],['cmd','命令输出'],['search','搜索结果'],['web','网页'],['result','其他工具结果']];
const inputOf=u=>(u.input_tokens || 0)+(u.cache_read_input_tokens || 0)+(u.cache_creation_input_tokens || 0);
export function claudeBreakdown(file) {
  let acc=parts(CLAUDE_PARTS),names=new Map(),first=null,last=null;
  for(const line of lines(file)) {
    const e=parse(line,['"type":"user"','"type":"assistant"','compact_boundary']);
    if(!e || e.isSidechain)continue;
    if(e.type==='system' && e.subtype==='compact_boundary'){acc=parts(CLAUDE_PARTS);names=new Map();first=last=null;continue;}
    const content=e.message?.content;
    if(e.type==='user') {
      const key=e.isCompactSummary ? 'summary' : 'user';
      if(typeof content==='string')acc.add(key,estimateTokens(content));
      else for(const b of content || []) {
        if(b.type==='text')acc.add(key,estimateTokens(b.text || ''));
        else if(b.type==='image')acc.add(key,IMAGE_TOKENS);
        else if(b.type==='tool_result')acc.add(CLAUDE_TOOL[names.get(b.tool_use_id)] || 'result',estimateTokens(textOf(b.content)));
      }
    } else if(e.type==='assistant') {
      const u=e.message?.usage;
      if(u && !first)first={T:inputOf(u),E:acc.sum()};   // before this reply: its own output is not part of what it was sent
      for(const b of content || []) {
        if(b.type==='text')acc.add('assistant',estimateTokens(b.text || ''));
        else if(b.type==='tool_use'){names.set(b.id,b.name);acc.add('call',estimateTokens(b.name+JSON.stringify(b.input || {})));}
      }
      if(u)last={T:inputOf(u)+(u.output_tokens || 0),E:acc.sum(),list:acc.list()};
    }
  }
  return first && last ? settle(last.list,first,last) : null;
}

const CODEX_PARTS=[['user','用户消息'],['assistant','助手文字'],['reasoning','推理'],['call','工具调用'],['output','工具输出']];
export function codexBreakdown(file) {
  let acc=parts(CODEX_PARTS),first=null,last=null;
  const add=(key,tokens)=>acc.add(key,tokens);
  const item=p=>{
    if(p.type==='message') {   // developer/system text belongs to the fixed overhead, not to a part
      const t=estimateTokens(textOf(p.content));
      if(p.role==='user')add('user',t);else if(p.role==='assistant')add('assistant',t);
    } else if(p.type==='reasoning')add('reasoning',Math.round(String(p.encrypted_content || '').length*0.2)+estimateTokens(textOf(p.summary)));
    else if(/_call$/.test(p.type))add('call',estimateTokens((p.name || '')+String(p.arguments ?? p.input ?? '')));
    else if(/_call_output$/.test(p.type))add('output',estimateTokens(textOf(p.output)));
  };
  for(const line of lines(file)) {
    const e=parse(line,['"type":"response_item"','"type":"compacted"','"type":"token_count"']);
    if(!e)continue;
    if(e.type==='compacted'){acc=parts(CODEX_PARTS);first=last=null;for(const p of e.payload?.replacement_history || [])item(p);continue;}
    if(e.type==='response_item'){item(e.payload || {});continue;}
    const usage=e.payload?.type==='token_count' && e.payload.info?.last_token_usage;
    if(usage?.total_tokens) {   // input + output of that request; its answer is already in the transcript above
      last={T:usage.total_tokens,E:acc.sum(),list:acc.list()};
      first ||= last;
    }
  }
  return first && last ? settle(last.list,first,last) : null;
}

// DeepSeek keeps no readable transcript, so the parts are counted from the session events as they stream by (one fresh full-history turn per call).
// Each reply carries the request's usage: first and last reply pin the fixed part and the estimate's scale, as for the other two.
const DEEPSEEK_PARTS=[['user','用户消息'],['assistant','助手文字'],['reasoning','推理'],['call','工具调用'],['read','读文件'],['cmd','命令输出'],['search','搜索结果'],['web','网页'],['result','其他工具结果']];
const DEEPSEEK_TOOL={read:'read',bash:'cmd',shell:'cmd',powershell:'cmd',grep:'search',glob:'search',find:'search',search:'search',web_fetch:'web',web_search:'web',fetch:'web'};
export function deepseekTracker() {
  const acc=parts(DEEPSEEK_PARTS),names=new Map();let first=null,last=null;
  return {
    push(e) {
      const d=e?.data || {};
      if(e?.type==='user/message'){for(const b of d.content || [])acc.add('user',b.type==='image' ? IMAGE_TOKENS : estimateTokens(b.text || ''));}
      else if(e?.type==='assistant/message') {
        const u=d.usage,input=u && (u.inputTokens || 0)+(u.cacheReadTokens || 0)+(u.cacheWriteTokens || 0);
        if(u && !first)first={T:input,E:acc.sum()};
        for(const b of d.message?.content || []) {
          if(b.type==='text')acc.add('assistant',estimateTokens(b.text || ''));
          else if(b.type==='reasoning')acc.add('reasoning',estimateTokens(b.text || ''));
          else if(b.type==='tool-call'){names.set(b.id,b.name);acc.add('call',estimateTokens((b.name || '')+String(b.arguments ?? '')));}
        }
        if(u)last={T:input+(u.outputTokens || 0),E:acc.sum(),list:acc.list()};
      } else if(e?.type==='tool/result')acc.add(DEEPSEEK_TOOL[names.get(d.message?.toolCallId)] || 'result',estimateTokens(textOf(d.message?.content)));
    },
    result:()=>first && last ? settle(last.list,first,last) : null
  };
}

// A native session's transcript file, or null. Claude keeps one file per session id under a per-folder directory; Codex names rollouts by date and ends the name with the thread id.
export function claudeTranscript(id,configDir=process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude')) {
  if(!/^[0-9a-f-]{36}$/i.test(id || ''))return null;
  const projects=path.join(configDir,'projects');
  try {const dir=fs.readdirSync(projects).find(d=>fs.existsSync(path.join(projects,d,id+'.jsonl')));return dir ? path.join(projects,dir,id+'.jsonl') : null;} catch {return null;}
}
export function codexTranscript(id,configDir=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {
  if(!/^[0-9a-f-]{36}$/i.test(id || ''))return null;
  const root=path.join(configDir,'sessions');
  const newest=dir=>{try {return fs.readdirSync(dir).sort().reverse();} catch {return [];}};
  for(const y of newest(root))for(const m of newest(path.join(root,y)))for(const d of newest(path.join(root,y,m))) {
    const hit=newest(path.join(root,y,m,d)).find(f=>f.endsWith(`-${id}.jsonl`));
    if(hit)return path.join(root,y,m,d,hit);
  }
  return null;
}
export function contextBreakdown(provider,sessionId) {
  if(!['claude','codex'].includes(provider))return null;
  const file=(provider==='claude' ? claudeTranscript : codexTranscript)(sessionId);
  return file ? (provider==='claude' ? claudeBreakdown : codexBreakdown)(file) : null;
}
