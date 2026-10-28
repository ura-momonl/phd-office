import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leanLaunch } from '../agent/codex.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-lean-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('leanLaunch: starts in an empty folder outside the office and switches off every MCP server named in the user Codex config', () => {
  const home = tmp(), t = tmp();
  fs.writeFileSync(path.join(home, 'config.toml'), [
    '[features]', 'memories = false', '', '[mcp_servers.node_repl]', 'command = "x"', '[mcp_servers.node_repl.env]', 'A = "1"',
    '[mcp_servers.autocad-mcp]', '[mcp_servers.autocad-mcp.tools.draw]', '[mcp_servers."odd name"]', '[plugins."a@b"]'].join('\n'));
  const r = leanLaunch({ home, tmp: t });
  assert.equal(r.cwd, path.join(t, 'office-llm-lean')); assert.ok(fs.existsSync(r.cwd));
  assert.deepEqual(fs.readdirSync(r.cwd), [], 'nothing in it for Codex to pick up');
  const mcp = r.extraOverrides.filter(o => o.startsWith('mcp_servers.'));
  assert.deepEqual(mcp.sort(), ['mcp_servers."odd name".enabled=false', 'mcp_servers.autocad-mcp.enabled=false', 'mcp_servers.node_repl.enabled=false'].sort());
  for (const f of ['plugins', 'multi_agent', 'shell_tool', 'browser_use']) assert.ok(r.extraOverrides.includes(`features.${f}=false`), f);
  assert.ok(r.extraOverrides.includes('web_search="disabled"'));
});

test('leanLaunch: no user config is fine (nothing to switch off beyond features)', () => {
  const r = leanLaunch({ home: path.join(tmp(), 'missing'), tmp: tmp() });
  assert.ok(r.extraOverrides.length > 5); assert.ok(!r.extraOverrides.some(o => o.startsWith('mcp_servers.')));
});
