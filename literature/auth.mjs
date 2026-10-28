import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from '../automation/files.mjs';
import { getCredential } from '../browser/session.mjs';

const directory = path.join(root, '.runtime/browser/uw-library');
const session = path.join(directory, 'session.local.json');
const blocked = path.join(directory, 'blocked.local.json');
const credential = () => getCredential('uw-library');
const suffix = '.ezproxy.library.wisc.edu';
export const isLibraryLogin = url => ['login.wisc.edu', 'login.ezproxy.library.wisc.edu'].includes(url.hostname)
  || url.hostname.endsWith('.duosecurity.com');
const isDuo = url => url.hostname.endsWith('.duosecurity.com');
const reachedArticle = (url, article) => !isLibraryLogin(url)
  && (url.hostname === new URL(article).hostname || url.hostname.endsWith(suffix));
const needed = message => ({ status: 'needs_login', message });

export function authStatus() {
  return { saved_credentials: Boolean(credential()), session_saved: fs.existsSync(session),
    session_updated_at: fs.existsSync(session) ? fs.statSync(session).mtime.toISOString() : null,
    auto_login_blocked: fs.existsSync(blocked), note: 'Saved state is not proof of current server-side validity' };
}
export function resetLoginBlock() {
  if (fs.existsSync(blocked)) fs.unlinkSync(blocked);
}
export async function createLibraryContext(browser) {
  return browser.newContext(fs.existsSync(session) ? { storageState: session } : {});
}
export async function saveLibrarySession(context) {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = session + '.' + randomUUID() + '.tmp';
  try {
    // Sensitive state is passed directly to disk; never log or return it.
    await context.storageState({ path: temporary });
    fs.renameSync(temporary, session);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function ensureLibraryAccess(page, article, { interactive = false } = {}) {
  if (!isLibraryLogin(new URL(page.url()))) return reachedArticle(new URL(page.url()), article)
    ? { status: 'ready' } : needed('Campus navigation did not reach the publisher; no credentials entered');
  const creds = credential();
  if (creds && !fs.existsSync(blocked) && new URL(page.url()).origin === 'https://login.wisc.edu') {
    // Only the official NetID origin may receive credentials. Observe one normal
    // password form and its fields; no institutional credentials on publishers.
    const form = page.locator('form').filter({ has: page.locator('input[type="password"]:visible') });
    if (await form.count() === 1) {
      const action = new URL(await form.getAttribute('action') || page.url(), page.url());
      const user = form.locator('input:is([type="text"],[type="email"],[autocomplete="username"]):visible');
      const pass = form.locator('input[type="password"]:visible');
      const submit = form.locator('button[type="submit"]:visible, input[type="submit"]:visible');
      if (action.origin === 'https://login.wisc.edu' && await user.count() === 1 && await pass.count() === 1 && await submit.count() === 1) {
        // Mark before submission. Wrong-password or ambiguous failures must not
        // produce fresh password attempts on later fetch calls. Only confirmed
        // article/Duo arrival or explicit login-set clears this local block.
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(blocked, JSON.stringify({ since: new Date().toISOString(), reason: 'Unconfirmed NetID attempt; reset with literature login-set' })+'\n');
        await user.fill(creds.username);
        await pass.fill(creds.password);
        await submit.click();
        const navigated = await page.waitForURL(url => reachedArticle(url, article) || isDuo(url), {
          timeout: 20000, waitUntil: 'domcontentloaded'
        }).then(() => true, () => false);
        if (!navigated && !interactive) return { status: 'login_failed', message: 'NetID login not confirmed; automatic login blocked until literature login-set. No retry.' };
        if (navigated) {
          resetLoginBlock();
          if (reachedArticle(new URL(page.url()), article)) return { status: 'ready' };
        }
      }
    }
  }
  if (!interactive) {
    if (fs.existsSync(blocked)) return { status: 'login_failed', message: 'Previous NetID attempt was not confirmed. Reset credentials using literature login-set; no retry.' };
    return needed(isDuo(new URL(page.url())) ? 'Duo requires you; rerun with --login. No MFA action taken.'
      : 'Saved session needs login. Set NetID using literature login-set, or rerun fetch with --login.');
  }
  console.error('需要你接手登录/Duo：请在独立 Edge 窗口完成，保持窗口打开；最多等待 8 分钟。');
  const ready = await page.waitForURL(url => reachedArticle(url, article), {
    timeout: 480000, waitUntil: 'domcontentloaded'
  }).then(() => true, () => false);
  if (!ready) return needed('Human login/Duo did not reach the article; no automatic retry');
  resetLoginBlock();
  return { status: 'ready' };
}
