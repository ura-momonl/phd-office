import { taskPrompt, dataAnalysisMode, cardPrompt, titlePrompt, turn, memoryTextV2, companionText, mailJudgePrompt, noticeText, literatureGoal, overloadResumePrompt } from './templates.mjs';
import { fragment } from './compose.mjs';

// Fixed, fictional inputs. prompts/golden.json holds what they render to; the test fails when a fragment edit changes any of it,
// and `node automation/run.mjs prompt snapshot` accepts the new wording after you have read the diff.
const base = { id: 't-1', actor: 'codex', title: '整理示例数据（虚构）', goal: '把示例 CSV 汇总成一张表' };
const inputs = '前置步骤：采集示例数据\n留言/结果：完成\n数据/产出位置：\nexample/data.csv';
const log = { kind: 'processing', parent: 'example-project' };
export const taskArgs = {
  'task-plan': [{ ...base, actor: 'claude', autonomy: { type: 'plan', source: 'example' } }, inputs, null],
  'task-authorized': [base, inputs, null],
  'task-authorized-result-review': [{...base,result_review:{actor:'codex',state:'pending'}},inputs,null],
  'task-authorized-outputs-log': [{ ...base, require_outputs: true, autonomy: { type: 'follow', source: 'example' } }, inputs, log],
};
export const cases = [
  ...Object.entries(taskArgs).map(([name, args]) => ({ name, render: () => taskPrompt(...args) })),
  { name: 'data-analysis-mode', render: () => dataAnalysisMode({kind:'data'}) },
  { name: 'card', render: () => cardPrompt('示例事项（虚构）', JSON.stringify({ source_messages: [] })) },
  { name: 'title', render: () => titlePrompt('用户：示例问题\nCodex：示例回答') },
  // Fixed sentences of a conversation turn (promptFor); the order and conditions are decided in agent/run.mjs.
  { name: 'turn-intro-surroundings-identity', render: () => [turn.intro('2026-01-02 星期五（Zone/Example）', 'D:/Example/PROFILE.md'), turn.surroundings('甲、乙'), turn.identity('Claude', 'Codex')].join('\n') },
  { name: 'turn-project-bound-stage', render: () => [turn.projectList([{ id: 'p-a', name: '示例甲' }, { id: 'p-b', name: '示例乙' }]), turn.stage({ id: 'n-1', title: '示例阶段', description: '阶段说明正文' }, 'p-a', '[{"name":"f","file":"x"}]')].join('\n') },
  { name: 'turn-project-unbound-stage-nodesc', render: () => [turn.projectList([]), turn.stage({ id: 'n-2', title: '无说明阶段' }, 'p-b', '[]')].join('\n') },
  { name: 'turn-change-notices', render: () => [turn.executionChanged(), turn.sourceVersion('abc123', false), turn.sourceVersion('abc123', true)].join('\n') },
  { name: 'turn-record-rundir-origin', render: () => [turn.record(['{"role":"user","speaker":"用户","text":"甲"}', '{"role":"assistant","speaker":"Codex","text":"乙"}']), turn.runDir('D:/Example/runs/t-1'), turn.cardOrigin('card-1')].join('\n') },
  { name: 'turn-workdir-subagents-resume', render: () => [turn.workdir('D:/Example/projects/p-a', 'D:/office'), turn.subagents(10, 10), overloadResumePrompt()].join('\n') },
  { name: 'turn-focus-roles', render: () => [turn.focusEvidence('{"k":1}'), turn.focusNone(), turn.focusRole('sent'), turn.focusRole('inbox'), turn.focusRole('other')].join('\n') },
  { name: 'turn-request-plain-and-handed', render: () => [turn.request('做示例'), turn.record(['{"role":"user","speaker":"用户","text":"原始目标"}', '{"role":"assistant","speaker":"Claude","text":"递来的话"}'])].join('\n') },
  { name: 'turn-assistant-created-conversation', render: () => turn.request(turn.handoffSource('Codex · 发起交接','source-session#source-task')+'\n整理已授权的实验数据。') },
  { name: 'turn-handoff-receipt', render: () => turn.request(turn.handoffReceipt('DeepSeek · 交接回执','child-session#child-task')+'\n筛选完成，统计如下。') },
  { name: 'memory-block-parts', render: () => [memoryTextV2.header('codex'), memoryTextV2.profileHeading(), memoryTextV2.standingHeading(), memoryTextV2.recalledHeading(), memoryTextV2.noMatch(), memoryTextV2.noVectors(), fragment('memory/v2-unavailable')].join('\n') },
  // Companion notes and the frame around mail judging instructions.
  { name: 'companion-note-full', render: () => companionText.note({ provider: 'codex', date: '2026-10-19', memory: companionText.memory(['线索甲'], ['2026-10-01 经历乙']), previous: JSON.stringify(['昨天的话']), earlier: companionText.earlier(JSON.stringify('同伴的话')) }) },
  { name: 'companion-note-plain', render: () => companionText.note({ provider: 'claude', date: '2026-10-19', memory: '', previous: '[]', earlier: '' }) },
  { name: 'companion-note-deepseek', render: () => companionText.note({ provider: 'deepseek', date: '2026-10-19', memory: '', previous: '[]', earlier: '' }) },
  { name: 'mail-judge-frame', render: () => mailJudgePrompt('（判断说明）', '{"packet_id":"p-1"}') },
  { name: 'literature-backfill-goal', render: () => literatureGoal.backfill({ year: 2030, citationFloor: '被引 ≥ 10（虚构）', rules: '（此处是 sources.json 的 lines.library，虚构占位）' }) },
  { name: 'literature-daily-goal', render: () => literatureGoal.daily({ date: '2030-01-02', rules: '（此处是 lines.reading 与 lines.picks，虚构占位）', file: 'D:/office/literature/recommendations/2030-01-02.json' }) },
  // Texts that code outside templates.mjs fills in (work/run.mjs, projects/framework.mjs); the fragments are the single owner of their wording.
  { name: 'task-progress-goal', render: () => fragment('task/progress-goal', { sources: 't-1、t-2' }) },
  { name: 'task-result-review', render: () => fragment('task/result-review',{id:'example-parent',revision:'example-version',goal:'用户要用示例数据比较两种解释',direction:'接续比较，不新增测量',origin:'work handoff example-request',handoff:'示例结果，待核实',outputs:'example/report.html  SHA256=example-hash'}) },
  { name: 'task-result-review-changes', render: () => fragment('task/result-review-changes',{id:'example-previous-review',revision:'example-previous-version',verdict:'revise',evidence:'example/review.md',fields:'handoff',added:'example/new-result.csv',changed:'example/report.html',removed:'example/old-appendix.csv',unchanged:1}) },
  { name: 'task-result-review-return', render: () => fragment('task/result-review-return',{id:'example-review',revision:'example-version'}) },
  { name: 'framework-digest-header', render: () => fragment('framework/digest-header', { file: 'D:/office/workspace/projects/demo/FRAMEWORK.md', project: 'demo' }) },
  // Notices appended to a turn: attachments, file-state and running-code reminders.
  { name: 'notice-attachments', render: () => [noticeText.images('{"name":"p.png","file":"D:/x/p.png"}'), noticeText.files('{"name":"a.csv","file":"D:/x/a.csv","size":3}')].join('\n') },
  { name: 'notice-file-state', render: () => [noticeText.firstSnapshot(), noticeText.fileChanges({ lines: '修改 "a.mjs"', extra: 0, report: '', unknown: 0 }), noticeText.fileChanges({ lines: '新增 "b.mjs"\n删除 "c.mjs"', extra: 4, report: '"D:/runs/r/file-changes.json"', unknown: 1 })].join('\n\n') },
  { name: 'notice-running-code', render: () => [noticeText.codeCurrent('aaaaaaaaaa', 'aaaaaaaaaa'), noticeText.codeUnknown('aaaaaaaaaa', 'bbbbbbbbbb'), noticeText.codeBehind('aaaaaaaaaa', 'bbbbbbbbbb', '"x.mjs"、"y.mjs" 等')].join('\n') },
  { name: 'companion-system', render: () => companionText.system() },
];
