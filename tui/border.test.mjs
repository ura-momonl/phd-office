import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('runtime repaint restores terminal padding colour after a host reset, across screens and themes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-border-'));
  try {
    const result = path.join(dir, 'writes.json'), fixture = path.join(dir, 'fixture.mjs');
    fs.writeFileSync(fixture, `
      import fs from 'node:fs';
      import { run } from ${JSON.stringify(new URL('./app.mjs', import.meta.url).href)};
      process.env.PHD_TUI_NO_PREFS = '1'; process.env.WT_SESSION = 'fixture';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'columns', { value: 100 });
      Object.defineProperty(process.stdout, 'rows', { value: 26 });
      process.stdin.setRawMode = () => {};
      const session = { id: 'fixture', title: 'Border test', task_ids: [], messages: [] };
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ agent: { sessions: [session], active_turns: [] }, projects: [], agent_read_at: {} }) });
      let phase = 'home'; const writes = [];
      process.stdout.write = text => { writes.push({ phase, text: String(text) }); return true; };
      process.once('exit', () => fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(writes)));
      const pause = () => new Promise(resolve => setTimeout(resolve, 230));
      const input = text => process.stdin.emit('data', text);
      run('start');
      await pause();
      // The host can reset its default background independently of the app's theme.
      // Every later repaint must reassert it, even if the desired colour hasn't changed.
      phase = 'home-after-reset'; await pause();
      phase = 'chat'; input('\\x0b\\x1b[B\\r'); await pause();
      phase = 'night'; input('/theme\\r'); await pause();
      phase = 'off'; input('/crt\\r'); await pause();
      phase = 'home-off'; input('\\x0e'); await pause();
      phase = 'sixel-off-effects'; input('\\x1b[?61;4c\\x1b[6;20;10t'); await pause();
      phase = 'exit'; process.emit('tui-quit');
    `);
    const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || String(child.error || 'fixture failed'));
    const writes = JSON.parse(fs.readFileSync(result, 'utf8'));
    const clay = '\x1b]11;rgb:1b/19/17\x07', night = '\x1b]11;rgb:0f/12/1d\x07', reset = '\x1b]111\x07';
    for (const [phase, expected] of [['home', clay], ['home-after-reset', clay], ['chat', clay], ['night', night], ['off', reset], ['home-off', reset], ['sixel-off-effects', night]]) {
      const paints = writes.filter(w => w.phase === phase && /\x1b\[\d+;\d+H/.test(w.text));
      assert.ok(paints.length, phase + ' painted');
      for (const { text } of paints) assert.ok(text.startsWith(expected), phase + ': repaint must restore the terminal background, not trust a cached colour');
    }
    assert.ok(writes.some(w => w.phase === 'sixel-off-effects' && w.text.includes('\x1bP')), 'real runtime emits the hero picture with effects off');
    assert.ok(writes.filter(w => w.phase === 'exit').some(w => w.text.includes(reset)), 'exit restores the terminal default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
