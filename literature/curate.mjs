// Builds the work-queue request for a literature backfill job. It only builds: nothing here enqueues, schedules or calls a model.
// Whoever decides to run it passes the result to work `enqueue` (status stays 'open' until someone queues it).
import { literatureGoal } from '../prompts/templates.mjs';
import { read } from '../automation/files.mjs';

export function backfillTask({ year, citationFloor, actor }) {
  if (!Number.isInteger(year) || year < 1990 || year > new Date().getFullYear()) throw new Error('year 必须是四位年份');
  if (!citationFloor.trim()) throw new Error('必须写明本年的被引门槛（用户或派出者定，程序不替她定）');
  const route=read('work/policy.json').defaults.find(p=>p.kind==='literature');
  actor ||= route.actor;
  if (!['codex', 'claude', 'deepseek'].includes(actor)) throw new Error('actor 必须是 codex、claude 或 deepseek');
  return {
    title: `文献回填 · ${year}`, kind: 'literature', actor, status: 'open', project_ids: [],
    ...(actor===route.actor && route.model ? {model:route.model} : {}),
    ...(actor===route.actor && route.effort ? {effort:route.effort} : {}),
    goal: literatureGoal.backfill({ year, citationFloor: citationFloor.trim(), rules: read('literature/sources.json').lines.library }),
    sources: ['literature/sources.json lines.library；.agents/skills/literature-backfill'],
    require_outputs: false,
  };
}
