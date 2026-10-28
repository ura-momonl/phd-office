import { read } from '../automation/files.mjs';

// Routing boundary, shared by the CLI and model launchers; not OS isolation.
export function ownerCheck(owner) {
  if (!['codex', 'claude', 'deepseek'].includes(owner)) throw new Error('owner 必须是 codex、claude 或 deepseek');
  if (process.env.OFFICE_MEMORY_OWNER && process.env.OFFICE_MEMORY_OWNER !== owner) throw new Error('只能访问自己的记忆');
  return owner;
}
export const ownerOn = (cfg, owner) => cfg?.enabled === true && (!Array.isArray(cfg.owners) || cfg.owners.includes(owner));
export const memoryEnabled = owner => ownerOn(read('agent/config.json').memory_v2, owner);
