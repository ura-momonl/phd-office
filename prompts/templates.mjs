import { fragment, joinPrompt, promptSource } from './compose.mjs';
import { requiresOutputs } from '../work/run.mjs';
import fs from 'node:fs';

// The model-facing texts agent/run.mjs used to carry inline. Each function only fills values into a fragment; wording lives in prompts/fragments.
const who = actor => ({claude:'Claude',codex:'Codex',deepseek:'DeepSeek'}[actor] || actor);
const block = (id, values) => '\n' + fragment(id, values);

export function taskPrompt(item, inputs, logRequirement) {
  const log = logRequirement ? block('task/log', { requirement: JSON.stringify(logRequirement), id: item.id }) : '';
  const provenance = item.autonomy ? block('task/provenance', { autonomy: JSON.stringify(item.autonomy) }) : '';
  const common = { who: who(item.actor), title: item.title, goal: item.goal, inputs, log, provenance };
  if (item.autonomy?.type === 'plan') return fragment('task/plan', common);
  const authorized=fragment('task/authorized', { ...common, require_outputs: requiresOutputs(item) ? fragment('task/require-outputs') : '' });
  return item.result_review ? joinPrompt([authorized,fragment('task/result-review-owner',{state:item.result_review.state})],'\n\n') : authorized;
}

// The shared work-turn entry calls this for both operations and routed chats.
// Read originals each turn, without a native selection decision or prompt copy.
export function dataAnalysisMode(item) {
  // Outer result review has its own demanding PI brief, not the analyst's raw-data workflow.
  if (item.kind !== 'data' || item.autonomy?.type === 'plan' || item.review_target) return '';
  const modes = ['research-partner', 'data-analysis'].map(name => {
    const file = `.agents/skills/${name}/SKILL.md`;
    const body = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
      .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim();
    return promptSource(body, { path: file, label: name });
  });
  return joinPrompt(modes, '\n\n');
}

export const cardPrompt = (title, evidence) => fragment('card', { title, evidence });
export const titlePrompt = excerpt => fragment('title', { excerpt });
export const overloadResumePrompt = () => fragment('turn/overload-resume');

// Fixed sentences of an ordinary conversation turn (agent/run.mjs promptFor). The code decides which pieces appear and in what order; the wording is here.
export const turn = {
  intro: (today, profile) => fragment('turn/intro', { today, profile }),
  surroundings: modules => fragment('turn/surroundings', { modules }),
  identity: (me, other) => fragment('turn/identity', { me, other }),
  projectList: projects => projects.length
    ? fragment('turn/project/bound', { names: promptSource(projects.map(p => `${p.name}（${p.id}）`).join('、'), {path:'projects/catalog.json',label:'绑定项目名称'}), lines: joinPrompt(projects.map(p => joinPrompt(['', fragment('turn/project/line', { id: p.id })])), '') })
    : fragment('turn/project/unbound'),
  stage: (stage, projectId, files) => fragment('turn/project/stage', {
    title: stage.title, id: stage.id, project: projectId, files,
    description: stage.description ? joinPrompt(['', fragment('turn/project/stage-description', { text: stage.description })]) : '',
  }),
  executionChanged: () => fragment('turn/execution-changed'),
  sourceVersion: (hash, changed) => fragment('turn/source-version', { hash, note: changed ? fragment('turn/source-changed') : fragment('turn/source-initial') }),
  record: lines => fragment('turn/record', { lines: joinPrompt(lines) }),
  runDir: dir => fragment('turn/run-dir', { dir }),
  workdir: (dir, root) => fragment('turn/workdir', { dir, root }),
  subagents: (limit, cards) => fragment('turn/subagents', { limit, cards }),
  cardOrigin: origin => fragment('turn/card-origin', { origin }),
  focusEvidence: text => fragment('turn/focus-evidence', { text }),
  focusNone: () => fragment('turn/focus-none'),
  focusRole: folder => folder === 'sent' ? fragment('turn/focus-role/sent') : folder === 'inbox' ? fragment('turn/focus-role/inbox') : fragment('turn/focus-role/other'),
  request: goal => fragment('turn/request', { goal }),
  handoffSource: (who, source) => fragment('turn/handoff-source', { who, source }),
  handoffReceipt: (who, source) => fragment('turn/handoff-receipt', { who, source }),
};

// The memory2 (EverOS-style) block: user profile + memories retrieved for this turn's topic (memory2/context.mjs).
export const memoryTextV2 = {
  header: owner => fragment('memory/v2-header', { owner }),
  profileHeading: () => fragment('memory/v2-profile-heading'),
  standingHeading: () => fragment('memory/v2-standing-heading'),
  recalledHeading: () => fragment('memory/v2-recalled-heading'),
  noMatch: () => fragment('memory/v2-no-match'),
  noVectors: () => fragment('memory/v2-no-vectors'),
};

// Companion notes and the frame around mail judging instructions.
// One literal call per provider so `prompt fragments`, `prompt uses` and lint see the reference; an unknown provider still fails loudly.
const identities = {
  claude: () => fragment('companion/identity-claude'),
  codex: () => fragment('companion/identity-codex'),
  deepseek: () => fragment('companion/identity-deepseek'),
};
export const companionText = {
  note: ({ provider, date, memory, previous, earlier }) => fragment('companion/note', {
    identity: (identities[provider] ?? (() => fragment('companion/identity-' + provider)))(), date, memory, previous, earlier }),
  memory: (cues, episodes) => fragment('companion/memory', {
    cues: cues.length ? fragment('companion/memory-cues', { lines: cues.join('\n') }) + '\n' : '',
    episodes: episodes.length ? fragment('companion/memory-episodes', { lines: episodes.join('\n') }) + '\n' : '' }),
  earlier: text => fragment('companion/earlier', { text }),
  system: () => fragment('companion/system'),
};
export const mailJudgePrompt = (instructions, packet) => fragment('mail/judge-frame', { instructions, refs: fragment('mail/judge-refs'), packet });

// Goal text of literature jobs. The collection criteria are not written here: the caller passes them in from literature/sources.json (`lines`), the one place the user's confirmed rules live.
export const literatureGoal = {
  backfill: ({ year, citationFloor, rules }) => fragment('literature/backfill-goal', { year, citation_floor: citationFloor, rules }),
  daily: ({ date, rules, file }) => fragment('literature/daily-goal', { date, rules, file }),
};

// Notices appended to a turn: attachments and the file-state / running-code reminders. The code decides when they appear.
export const noticeText = {
  images: lines => fragment('notice/images', { lines }),
  files: lines => fragment('notice/files', { lines }),
  firstSnapshot: () => fragment('notice/first-snapshot'),
  fileChanges: ({ lines, extra, report, unknown }) => fragment('notice/file-changes', {
    lines,
    more: extra ? '\n' + fragment('notice/file-changes-more', { count: extra, report: report ? fragment('notice/file-changes-report', { path: report }) : '' }) : '',
    unknown: unknown ? '\n' + fragment('notice/file-changes-unknown') : '' }),
  codeCurrent: (loaded, disk) => fragment('notice/code-current', { loaded, disk }),
  codeUnknown: (loaded, disk) => fragment('notice/code-unknown', { loaded, disk }),
  codeBehind: (loaded, disk, changes) => fragment('notice/code-behind', { loaded, disk, changes }),
};
