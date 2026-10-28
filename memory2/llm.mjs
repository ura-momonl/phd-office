// LLM access for memory2. The model is gpt-6-luna through the Codex channel (user decision 2026-10-24), configured by
// the same agent/config.json `memory_extract.<owner>` entry the office already uses, so model/effort change in one place.
// The function shape is `async (prompt, { purpose }) => string`; tests inject a fake.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// memory_v2.lean_calls (default on): run these calls in an empty folder with Codex's plugins, MCP servers and tools off (see agent/codex.mjs leanLaunch).
const leanEnabled = () => JSON.parse(fs.readFileSync(path.join(root, 'agent/config.json'), 'utf8')).memory_v2?.lean_calls !== false;
export function codexChat(owner, { calls = [], lean = leanEnabled() } = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agent/config.json'), 'utf8')).memory_extract?.[owner];
  if (!cfg) throw new Error(`agent/config.json 缺少 memory_extract.${owner}`);
  return async (prompt, { purpose = 'memory2' } = {}) => {
    const { invokeNative } = await import('../agent/run.mjs');
    const directory = path.join(root, '.runtime/memory2/llm-runs', `${purpose}-${randomUUID()}`);
    const leanOptions = lean && (cfg.provider || 'codex') === 'codex' ? (await import('../agent/codex.mjs')).leanLaunch() : {};
    const { result } = await invokeNative(cfg.provider || 'codex', prompt, { directory, mode: 'ask', purpose, model: cfg.model, effort: cfg.effort, ...leanOptions });
    calls.push({ purpose, directory, chars: prompt.length });
    return typeof result === 'string' ? result : JSON.stringify(result);
  };
}
