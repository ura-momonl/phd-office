import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../automation/files.mjs';

export const tokenEstimate = text => { const cjk = (text.match(/[⺀-鿿＀-￯]/g) || []).length; return Math.ceil(cjk * 1.3 + (text.length - cjk) * 0.4); };
// Capture the loaded implementation, not a later deployment's files.
export const memoryVersion = createHash('sha256').update(['memory2/owner.mjs', 'memory2/context.mjs', 'memory2/extract.mjs', 'memory2/auto.mjs', 'memory2/inject.mjs', 'memory2/telemetry.mjs', 'agent/run.mjs', 'agent/codex.mjs', 'agent/claude.mjs'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n')).digest('hex');
export function runRelative(directory) { return path.relative(root, path.resolve(directory)).replaceAll('\\', '/'); }
