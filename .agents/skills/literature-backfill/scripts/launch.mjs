// Read-only launch card for a pre-dispatched package: state of every child task + the short spawn prompt.
// No models, network, lock or writes. Usage: launch.mjs claude|codex|deepseek <package-id> [--round screen-r01]
import fs from 'node:fs';
import {local,read,sha,prefix} from './records.mjs';
const args=process.argv.slice(2),role=args[0],pkgId=args[1];
if(!['claude','codex','deepseek'].includes(role)||!pkgId)throw Error('Usage: launch.mjs claude|codex|deepseek <package-id> [--round screen-r01]');
const ri=args.indexOf('--round'),round=ri<0?'screen-r01':args[ri+1];
const pi=args.indexOf('--phase'),phase=pi<0?'full':args[pi+1];
if(!['full','titles'].includes(phase))throw Error('--phase full|titles');
const state=read('output/literature-rebuild-20261021/CONTINUE.json');
const pkg=state.packages.find(p=>p.id===pkgId);
if(!pkg)throw Error('Unknown package '+pkgId);
if(pkg.owner!==role)throw Error(`Package ${pkgId} belongs to ${pkg.owner}, not ${role}; do not take another owner's package`);
const manifest=read(pkg.manifest);
const cursor=id=>{ // how much of a package's own work items is delivered (outputs are the source of truth)
 const p=state.packages.find(x=>x.id===id);if(!p)return null;
 const m=read(p.manifest);let done=0,total=0;
 for(const w of m.work_items){const src=read(w.input).slice(w.start_index-1,w.end_index);total+=src.length;
  if(fs.existsSync(local(w.output))){try{const d=read(w.output);if(Array.isArray(d))done+=d.length;}catch{done=NaN;}}}
 return {id,status:p.status,delivered:done,total};
};
const planPath=`output/literature-rebuild-20261021/coordinator/reader-jobs/${pkgId}/${round}/plan.json`;
const card={package:pkgId,owner:role,status:pkg.status,records:manifest.assigned_records??pkg.assigned_records,
 after_package:pkg.after_package?cursor(pkg.after_package):null,plan:planPath};
if(!fs.existsSync(local(planPath))){
 card.next=`No plan yet. Run: node .agents/skills/literature-dispatch/scripts/dispatch.mjs ${role} --package ${pkgId} --children ${role==='deepseek'?'1 --size 100':'10'} --round r01`;
 console.log(JSON.stringify(card,null,1));process.exit(0);
}
const plan=read(planPath);
const jobs=plan.jobs.map(j=>{
 let t=null,saved=0,note='';
 try{const data=read(j.input);if(sha(JSON.stringify(data))!==j.input_sha256)throw Error('input hash changed');
  saved=fs.existsSync(local(j.output))?prefix(j.output,data).length:0;t=data.length;}
 catch(e){note='NEEDS-REPAIR: '+e.message;}
 const state2=note?'repair':saved===t?'done':saved?'partial':'todo';
 let tp=null;
 try{const task=read(j.task_file),sf=task.chunk_file.replace(/\.json$/,'')+'.titles.json';const st=fs.existsSync(local(sf))?read(sf):{cursor:0,excluded:[]};tp={cursor:st.cursor,excluded:st.excluded.length};}catch{}
 return {n:j.id.split('-').at(-1),task:j.task_file,count:j.count,saved,state:state2,note:note||undefined,titles:tp};
});
// DeepSeek works in its existing formal chat, not via another model invocation.
// Reuse the same tasks, saved prefixes and merge path, one task at a time.
if(role==='deepseek'){
 const open=jobs.filter(j=>phase==='titles'
  ?j.state!=='repair'&&(!j.titles||j.titles.cursor<j.count)
  :j.state==='todo'||j.state==='partial');
 const next=open[0];
 card.phase=phase;
 card.jobs=jobs;
 card.serial={remaining_tasks:open.length,next_task:next?.task||null,
  command:next?`node .agents/skills/literature-backfill/scripts/brief.mjs ${next.task}`:null,
  note:phase==='titles'?'next_task 是下一块题名阶段；各块互不依赖，可每块派一只 off 小鱼（agent 的 effort:"off"），流程见 SKILL.md 的 DeepSeek 一节。':'各块互不依赖，可每块派一只 off 小鱼（agent 的 effort:"off"）按阅读卡读摘要并逐页保存；全部完成后重新运行本 launch 命令确认。流程见 SKILL.md 的 DeepSeek 一节。'};
 card.after_tasks={
  merge_dry_run:`node .agents/skills/literature-backfill/scripts/reader-work.mjs merge ${planPath} --dry-run`,
  merge:`node .agents/skills/literature-backfill/scripts/reader-work.mjs merge ${planPath}`,
  then:phase==='titles'?'题名完成后由来源协调者补缺摘要；更新输入后运行完整流程。':'块全部完成后机械合并，运行 node .agents/skills/literature-backfill/scripts/review-pack.mjs '+pkgId+' 生成复核包与块间一致性报告，再按 references/review-and-admit.md 做内容核对，复核记录只写实际读过的条目。'};
 console.log(JSON.stringify(card,null,1));process.exit(0);
}
if(phase==='titles'){
 const open=jobs.filter(j=>j.state!=='repair'&&(!j.titles||j.titles.cursor<j.count));
 card.phase='titles';card.jobs=jobs.map(j=>`${j.n} titles ${j.titles?.cursor||0}/${j.count} excluded ${j.titles?.excluded||0}${j.note?' '+j.note:''}`);
 card.spawn={for_each_open_child:open.map(j=>j.task),model:role==='claude'?'Agent tool: model="haiku"':'子agent: model="gpt-6-luna", fork_turns="none"',run_in_background:true,
  prompt_template:'你是文献题名粗筛读者。工作目录 D:/Main/assistant，先运行 node .agents/skills/literature-backfill/scripts/brief.mjs <TASK>（输出里含阅读卡），按其中“只做题名阶段”一节处理这个唯一任务文件：<TASK>。'};
 card.after_children_return={survivors_per_child:'node .agents/skills/literature-backfill/scripts/reader-work.mjs survivors <TASK> --out <文件>',
  then:'把各子块 need_source_ids 交给来源补摘要；补完更新输入后再按完整流程（不带 --phase）派读摘要。题名阶段的标记保存在各任务的 .titles.json，输入更新后仍有效。'};
 console.log(JSON.stringify(card,null,1));process.exit(0);
}
const WAVE=10,openAll=jobs.filter(j=>j.state==='todo'||j.state==='partial'),open=openAll.slice(0,WAVE);
card.wave={this_wave:open.length,still_open_after_wave:openAll.length-open.length};
card.children={total:jobs.length,todo:jobs.filter(j=>j.state==='todo').length,partial:jobs.filter(j=>j.state==='partial').length,done:jobs.filter(j=>j.state==='done').length,repair:jobs.filter(j=>j.state==='repair').length};
card.existing_result_issues=plan.existing_result_issues?.length||0;
card.jobs=jobs.map(j=>`${j.n} ${j.state} ${j.saved}/${j.count}${j.note?' '+j.note:''}`);
const model=role==='claude'?'Agent tool: model="haiku"（用户指定 Haiku 5.5；记录工具实际返回型号）':'子agent: model="gpt-6-luna", fork_turns="none"';
card.spawn={
 for_each_open_child:open.map(j=>j.task),
 model,
 run_in_background:true,
 note:'一次回复里并行发出 for_each_open_child 列出的本波 Agent 调用（每波最多10块，原生槽位更少时取实际值）；本波全部返回后再跑一次 launch.mjs 取下一波，直到 wave.still_open_after_wave 为 0；prompt 保持如下一句，不要再写长说明（长 prompt 每个多花数秒生成时间）。partial 的块若没有仍在运行的子agent（上一轮已结束/中断）才重发，程序从已存前缀继续；正在读的块不要重复派。',
 prompt_template:'你是文献摘要初筛读者。工作目录 D:/Main/assistant，先运行 node .agents/skills/literature-backfill/scripts/brief.mjs <TASK>（输出里含阅读卡），按阅读卡处理这个唯一任务文件，不要另读阅读卡或 task 文件：<TASK>。'
};
card.after_children_return={
 merge_dry_run:`node .agents/skills/literature-backfill/scripts/reader-work.mjs merge ${planPath} --dry-run`,
 merge:`node .agents/skills/literature-backfill/scripts/reader-work.mjs merge ${planPath}`,
 then:'再读 references/review-and-admit.md 做复核与入库（此前不需要读 references、help literature、其他包状态）。'
};
console.log(JSON.stringify(card,null,1));
