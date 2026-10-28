// Test helper. After a chat's first answer the program asks a small model for a title (agent/run.mjs titleSession). Tests that count or inspect the
// model calls of a conversation are about the conversation, so their fake model answers that one call with nothing and leaves it unrecorded.
// Tests of the title itself call titleSession with their own fake model instead.
export const withoutTitle=runner=>(provider,prompt,opts={},...rest)=>opts.purpose==='title' ? {result:''} : runner(provider,prompt,opts,...rest);
export const executeWithoutTitle=execute=>(taskId,runner,...rest)=>execute(taskId,withoutTitle(runner),...rest);
