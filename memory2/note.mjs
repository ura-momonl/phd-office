// Read-only material for daily notes: use the same Markdown source as work turns.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root as officeRoot } from '../automation/files.mjs';
import { MemoryRoot, readMarkdown, parseStructuredEntry } from './md.mjs';
import { localDate } from './extract.mjs';
import { readLedger } from './ledger-store.mjs';
import { ownerCheck, memoryEnabled } from './owner.mjs';
import { tokenEstimate } from './telemetry.mjs';

export function memoryNoteMaterial(owner, seed, { count = 3, tokens = 1200 } = {}) {
  ownerCheck(owner);
  const empty = { cues: [], episodes: [] };
  if (!memoryEnabled(owner)) return empty;
  const root = new MemoryRoot(path.join(officeRoot, '.runtime/memory2', owner));
  const dir = path.dirname(root.dailyPath('episode', owner, '2000-01-01'));
  if (!fs.existsSync(dir)) return empty;
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.md')).flatMap(f => {
    const p = readMarkdown(path.join(dir, f));
    return p.entries.filter(e => !p.frontmatter.deprecated_entries?.[e.id]).map(e => {
      const s = parseStructuredEntry(e.body), legacy = s.sections.Legacy ? JSON.parse(s.sections.Legacy) : null;
      return { id: e.id, cue: s.sections.Subject || '', date: s.inline.timestamp ? localDate(Date.parse(s.inline.timestamp)) : '', text: s.sections.Content || '', understanding: legacy?.type === 'understanding' };
    });
  });
  const pinned = new Set(readLedger(root).pinned), cues = [], episodes = [];
  for (const e of [...all].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || String(b.date).localeCompare(a.date))) {
    const line = JSON.stringify({ id: e.id, cue: e.cue });
    if (tokenEstimate([...cues, line].join('\n')) <= 400) cues.push(line);
  }
  const rank = e => createHash('sha256').update(seed + e.id).digest('hex');
  for (const e of all.filter(e => !e.understanding).sort((a, b) => rank(a).localeCompare(rank(b)))) {
    const line = JSON.stringify({ date: e.date, cue: e.cue, text: e.text });
    if (episodes.length < count && tokenEstimate([...episodes, line].join('\n')) <= tokens) episodes.push(line);
  }
  return { cues, episodes };
}
