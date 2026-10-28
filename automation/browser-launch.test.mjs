import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './files.mjs';
import { safeLaunchOptions, launchEdge, LOCKOUT_FEATURE } from './browser-launch.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use node scripts/run-tests.mjs --browser-safety (sanitised copy only)');

test('browser lockout protection merges defaults and caller features into one switch, without changing other options', () => {
  const options = { headless: false, timeout: 1234, args: ['--lang=zh-CN', '--disable-features=CallerA,CallerB', '--disable-features=CallerA'], ignoreDefaultArgs: ['--some-default'] };
  const before = structuredClone(options);
  const actual = safeLaunchOptions(['--disable-features=DefaultA,DefaultB', '--some-default'], options);
  assert.deepEqual(actual.args, ['--lang=zh-CN', `--disable-features=DefaultA,DefaultB,CallerA,CallerB,${LOCKOUT_FEATURE}`]);
  assert.deepEqual(actual.ignoreDefaultArgs, ['--some-default', '--disable-features=DefaultA,DefaultB']);
  assert.equal(actual.headless, false); assert.equal(actual.timeout, 1234);
  assert.deepEqual(options, before);
  assert.deepEqual(safeLaunchOptions(['--disable-features=DefaultA,DefaultB', '--some-default'], actual), actual, 'idempotent merge');
});

test('browser lockout protection preserves intentionally ignored defaults and never ignores all defaults on its own', () => {
  const defaults = ['--disable-features=DefaultA', '--another-default'];
  const ignored = safeLaunchOptions(defaults, { ignoreDefaultArgs: defaults, args: ['--disable-features=CallerA'] });
  assert.deepEqual(ignored.args, [`--disable-features=CallerA,${LOCKOUT_FEATURE}`]);
  assert.deepEqual(ignored.ignoreDefaultArgs, defaults);
  const allIgnored = safeLaunchOptions(defaults, { ignoreDefaultArgs: true });
  assert.equal(allIgnored.ignoreDefaultArgs, true);
  assert.deepEqual(allIgnored.args, [`--disable-features=${LOCKOUT_FEATURE}`]);
});

test('actual Edge receives one merged feature switch and still renders a local page', async () => {
  const start = new Date().toISOString();
  // Edge only exposes Browser.getBrowserCommandLine with this observation flag.
  // It is confined to this test; other callers keep their original launch flags.
  const browser = await launchEdge({ args: ['--enable-automation', '--lang=en-US', '--disable-features=CallerFeatureForLockoutTest,msForceBrowserSignIn'] });
  try {
    const session = await browser.newBrowserCDPSession();
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const disabled = args.filter(arg => arg.startsWith('--disable-features='));
    assert.equal(disabled.length, 1, 'duplicate feature switches can discard the old defaults');
    const features = disabled[0].slice('--disable-features='.length).split(',');
    for (const feature of [LOCKOUT_FEATURE, 'CallerFeatureForLockoutTest', 'msForceBrowserSignIn', 'MediaRouter']) assert.ok(features.includes(feature), feature);
    assert.ok(args.includes('--lang=en-US'));
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.ok(args.some(arg => arg.startsWith('--user-data-dir=')));
    const page = await browser.newPage();
    await page.setContent('<title>Local browser safety check</title><h1>Ready</h1>');
    assert.equal(await page.title(), 'Local browser safety check');
    assert.equal(await page.locator('h1').textContent(), 'Ready');
    fs.writeFileSync(path.join(root, '.runtime/browser-lockout-smoke.json'), JSON.stringify({ start, end: new Date().toISOString(), nodePid: process.pid, browserPid: processInfo.find(p => p.type === 'browser')?.id, arguments: args, rendered: true }, null, 2));
  } finally { await browser.close(); }
});
