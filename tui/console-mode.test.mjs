import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('console helper runs without PowerShell or policy overrides and restores its own native console', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-console-native-'));
  const helper = fileURLToPath(new URL('./console-mode.py', import.meta.url));
  const driver = path.join(dir, 'driver.py'), output = path.join(dir, 'report.json');
  // An independent ctypes readback observes the real shared console, not helper stdout alone.
  fs.writeFileSync(driver, String.raw`import ctypes, json, os, subprocess, sys
from ctypes import wintypes
helper, output = sys.argv[1:]
os.environ.pop('PSExecutionPolicyPreference', None)
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.GetStdHandle.argtypes = [wintypes.DWORD]
k.GetStdHandle.restype = wintypes.HANDLE
k.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
k.GetConsoleMode.restype = wintypes.BOOL
h = k.GetStdHandle(-10)
def flags():
    m = wintypes.DWORD()
    if not k.GetConsoleMode(h, ctypes.byref(m)):
        raise RuntimeError('Test needs a real inherited console')
    return m.value
original = flags()
steps = []
try:
    for name, args in [('read', []), ('mouse', ['-Mouse']), ('selection', ['-QuickEdit']), ('restore', ['-Restore', hex(original)])]:
        r = subprocess.run([sys.executable, helper, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        steps.append(dict(phase=name, exit=r.returncode, stdout=r.stdout.strip(), stderr=r.stderr, mode=flags()))
finally:
    subprocess.run([sys.executable, helper, '-Restore', hex(original)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    with open(output, 'w', encoding='utf-8') as f:
        json.dump(dict(original=original, restored=flags(), steps=steps), f)
`);
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  // Only a native process launcher is a PS command; neither it nor the helper
  // loads a .ps1 file or requests any execution-policy setting.
  const command = `$p = Start-Process -FilePath python -ArgumentList @(${[driver, helper, output].map(s => quote('"' + s + '"')).join(',')}) -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  try {
    const env = { ...process.env }; delete env.PSExecutionPolicyPreference;
    const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    for (const step of report.steps) {
      assert.equal(step.exit, 0, JSON.stringify(step)); assert.equal(step.stderr, '');
      assert.match(step.stdout, /^0x[0-9A-F]+ vt=[01] quickedit=[01] was=0x[0-9A-F]+$/);
    }
    assert.equal(report.steps[1].mode & (0x200 | 0x10 | 0x40), 0x210);
    assert.equal(report.steps[2].mode & (0x10 | 0x40), 0x40);
    assert.equal(report.steps[3].mode, report.original);
    assert.equal(report.restored, report.original);
    const app = fs.readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
    assert.equal(app.includes('console-mode.ps1'), false);
    assert.equal(app.includes("spawnSync('powershell'"), false);
    assert.equal(app.includes("spawn('powershell'"), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
