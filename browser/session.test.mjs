// Fake browser only: no Edge is started and the real .runtime/browser is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSite, saveCredential, siteStatus } from './session.mjs';

const sites = { demo: { label: 'demo', origin: 'https://example.test', start: '/app/', login: { user: '#u', pass: '#p', submit: '#go', success_url: '/welcome', error: '#err' } } };

function fake({ needsLogin, loginWorks = true, errText = '', alertText = '' }) {
  const log = { filled: {}, clicked: [], closed: 0, contexts: [] };
  let pathname = '/app/';
  const locator = sel => ({ first: () => ({
    waitFor: async () => { if (sel === '#u' && !needsLogin) throw new Error('not visible'); },
    fill: async v => { log.filled[sel] = v; },
    click: async () => { log.clicked.push(sel); if (loginWorks) pathname = '/welcome'; else if (alertText) setTimeout(() => onDialog({ message: () => alertText, accept: async () => { log.accepted = true; } }), 0); },
    textContent: async () => errText }) });
  let onDialog = () => {};
  const page = { goto: async () => {}, locator, on: (ev, f) => { if (ev === 'dialog') onDialog = f; }, url: () => 'https://example.test' + pathname,
    waitForURL: async (test) => { if (test(new URL('https://example.test' + pathname))) return; await new Promise(r => setTimeout(r, alertText ? 5000 : 0)); throw new Error('timeout'); } };
  const context = { newPage: async () => page, };
  const browser = { newContext: async (...a) => { log.contexts.push(a); return context; }, close: async () => { log.closed++; } };
  return { log, launch: async () => browser };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-'));

test('logs in with the stored credential in a clean context, saves no cookies, closes the browser', async () => {
  const dir = tmp(); saveCredential('demo', 'alice', 's3cret', dir);
  const { log, launch } = fake({ needsLogin: true });
  assert.equal(await withSite('demo', async () => 'done', { launch, sites, dir }), 'done');
  assert.deepEqual(log.filled, { '#u': 'alice', '#p': 's3cret' });
  assert.deepEqual(log.clicked, ['#go']);
  assert.deepEqual(log.contexts, [[]]);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.local.json']);
  assert.equal(log.closed, 1);
  const status = siteStatus(sites, dir)[0];
  assert.equal(status.has_credential, true); assert.ok(!('saved_cookies' in status));
  assert.ok(!JSON.stringify(status).includes('s3cret'), 'status must not reveal the password');
});

test('every call logs in again; an old state file is ignored, not loaded', async () => {
  const dir = tmp(); saveCredential('demo', 'alice', 's3cret', dir); fs.writeFileSync(path.join(dir, 'demo.state.json'), '{}');
  for (let i = 0; i < 2; i++) {
    const { log, launch } = fake({ needsLogin: true });
    await withSite('demo', async () => {}, { launch, sites, dir });
    assert.deepEqual(log.contexts, [[]]); assert.deepEqual(log.clicked, ['#go']);
  }
});

test('wrong password: one attempt, clear error without the password, browser closed', async () => {
  const dir = tmp(); saveCredential('demo', 'alice', 's3cret', dir);
  const { log, launch } = fake({ needsLogin: true, loginWorks: false, errText: ' Invalid Username or Password ! ' });
  await assert.rejects(withSite('demo', async () => 'never', { launch, sites, dir }), e => {
    assert.match(e.message, /Invalid Username or Password/); assert.ok(!e.message.includes('s3cret')); return true; });
  assert.equal(log.clicked.length, 1); assert.equal(log.closed, 1);
});

test('FOM-style rejection: the alert text is reported, the login ends without waiting out the timeout', async () => {
  const dir = tmp(); saveCredential('demo', 'alice', 's3cret', dir);
  const { log, launch } = fake({ needsLogin: true, loginWorks: false, alertText: 'Message from FOM server:\nWrong username or password.' });
  const t0 = Date.now();
  await assert.rejects(withSite('demo', async () => 'never', { launch, sites, dir }), e => {
    assert.match(e.message, /停在 \/app\//); assert.match(e.message, /Wrong username or password/); assert.ok(!e.message.includes('s3cret')); return true; });
  assert.ok(Date.now() - t0 < 3000, 'must not wait for the URL timeout after an alert');
  assert.equal(log.accepted, true); assert.equal(log.clicked.length, 1); assert.equal(log.closed, 1);
});

test('login needed but no stored credential: explains how to set it, nothing is typed', async () => {
  const { log, launch } = fake({ needsLogin: true });
  await assert.rejects(withSite('demo', async () => {}, { launch, sites, dir: tmp() }), /login-set demo/);
  assert.deepEqual(log.filled, {}); assert.equal(log.closed, 1);
});

test('unknown site is rejected before any browser starts', async () => {
  let launched = false;
  await assert.rejects(withSite('nope', async () => {}, { launch: async () => { launched = true; }, sites, dir: tmp() }), /未登记/);
  assert.equal(launched, false);
});
