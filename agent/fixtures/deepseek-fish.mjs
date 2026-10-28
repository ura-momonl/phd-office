// Notification shapes captured in run 9bde487f (2026-10-23 workflow fish demo).
// Synthetic identities/text; includes a child tool and midway text to exercise
// the isolation boundary that the no-tool live demo did not exercise.
export const rootId='fixture-root',fishIds=['fixture-fish-1','fixture-fish-2'];
export const native=(sessionId,type,data)=>({method:'session.event',payload:{sessionId,event:{type,data}}});
const text=(value,usage)=>({message:{content:[{type:'text',text:value}]},...(usage?{usage}:{})});
export const rootUsage={inputTokens:100,outputTokens:10,cacheReadTokens:20,cacheWriteTokens:0};
export function fishStart(){return [
 native(rootId,'agent/inbox/spliced',{}),native(rootId,'user/message',{content:[{type:'text',text:'ROOT_REQUEST'}]}),
 native(rootId,'request/context',{contextWindow:1000000}),
 native(rootId,'assistant/message',text('ROOT_PROGRESS',rootUsage)),
 native(rootId,'tool/call',{callId:'workflow-call',name:'workflow',arguments:'{"meta":{"name":"fish-demo"}}'}),
 ...fishIds.flatMap((id,i)=>[
  {method:'subagent.started',payload:{parentSessionId:rootId,childSessionId:id}},
  native(rootId,'subagent/catalog',{version:0,childId:id,label:'fish-demo child '+(i+1)}),
  native(rootId,'tool-workflow/agent-start',{runId:'fixture-flow',seq:i+1,label:'小鱼'+(i+1)+'号',childId:id}),
  native(id,'user/message',{content:[{type:'text',text:'CHILD_TASK_'+(i+1)}]}),
  native(id,'agent/inbox/spliced',{}),native(id,'request/context',{contextWindow:9999999}),
  native(id,'assistant/message',text('CHILD_PROGRESS_'+(i+1),{inputTokens:900000,outputTokens:100,cacheReadTokens:0,cacheWriteTokens:0})),
  native(id,'tool/call',{callId:'same-call-id',name:'read',arguments:'{"file_path":"fixture-'+(i+1)+'.txt"}'}),
 ]),
];}
export function fishEnd(status='ok'){return [
 ...fishIds.slice().reverse().flatMap((id,index)=>[
  native(id,'tool/result',{message:{toolCallId:'same-call-id',isError:index===0,content:[{type:'text',text:'CHILD_TOOL_OUTPUT'}]}}),
  native(id,'assistant/message',text('CHILD_FINAL_'+(index+1))),
  native(id,'turn/end',{turn:1,reason:{kind:'completed'}}),
  {method:'subagent.finished',payload:{parentSessionId:rootId,childSessionId:id,status,stopReason:'completed',
   lastAssistantMessage:[{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:'CHILD_FINAL_'+(index+1)}]}},
  native(rootId,'tool-workflow/agent-end',{runId:'fixture-flow',seq:2-index,outcome:'completed'}),
 ]),
 native(rootId,'tool/result',{message:{toolCallId:'workflow-call',isError:false}}),
 native(rootId,'assistant/message',text('ROOT_FINAL',rootUsage)),
 ];}
