// One-shot logged-in browser sessions. Each call starts Edge through the shared safe launcher
// (automation/browser-launch.mjs) with a clean context, logs in with the stored credentials, runs the
// caller's function, closes. FOM cookies are deliberately not saved or reused.
// UW library auth is maintained separately by literature/auth.mjs; FOM is unchanged.
// Credentials live in .runtime/browser (git-ignored, not in backups).
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';

export const defaultDir = path.join(root, '.runtime/browser');
export const loadSites = () => JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url), 'utf8'));
const credentialFile = dir => path.join(dir, 'credentials.local.json');
const readJson = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;

export const getSite = (id, sites = loadSites()) => {
  if (!sites[id]) throw new Error(`未登记的站点 ${id}；已登记：${Object.keys(sites).join(', ')}（在 browser/sites.json 添加）`);
  return sites[id];
};
export const getCredential = (id, dir = defaultDir) => readJson(credentialFile(dir), {})[id];
export function saveCredential(id, username, password, dir = defaultDir) {
  if (!username || !password) throw new Error('用户名和密码都不能为空');
  fs.mkdirSync(dir, { recursive: true });
  const all = readJson(credentialFile(dir), {});
  all[id] = { username, password };
  fs.writeFileSync(credentialFile(dir), JSON.stringify(all, null, 2) + '\n');
}
export function siteStatus(sites = loadSites(), dir = defaultDir) {
  const creds = readJson(credentialFile(dir), {});
  return Object.entries(sites).map(([id, s]) => ({ id, label: s.label, origin: s.origin, has_credential: Boolean(creds[id]) }));
}

const visible = (page, selector, timeout) => page.locator(selector).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

// Single attempt on purpose: a wrong password must not be retried against a real account.
// FOM reports a rejected login as a JS alert ("Message from FOM server: Wrong username or password.") and stays on the
// login path; Playwright would dismiss it silently, so the alert text is captured and ends the wait early.
export async function login(page, site, credential) {
  const l = site.login;
  const alerts = [];
  let onAlert; const alerted = new Promise(r => { onAlert = r; });
  page.on('dialog', d => { alerts.push(d.message().trim()); d.accept().catch(() => {}); onAlert(); });
  await page.locator(l.user).first().fill(credential.username);
  await page.locator(l.pass).first().fill(credential.password);
  await page.locator(l.submit).first().click();
  const reached = page.waitForURL(url => url.pathname.includes(l.success_url), { timeout: 15000 }).then(() => true, () => false);
  if (await Promise.race([reached, alerted.then(() => false)])) return;
  const shown = alerts.length ? alerts.join(' / ') : l.error ? (await page.locator(l.error).first().textContent({ timeout: 1000 }).catch(() => '')).trim() : '';
  const at = new URL(page.url()).pathname;
  throw new Error(`登录未成功（停在 ${at}，未到 ${l.success_url}）${shown ? '：' + shown : ''}。已停止，未重试；请核对 browser login-set 保存的账号和密码`);
}

// fn(page, context) runs logged in, on the start page (or the page the site lands on right after login). Every call logs in again. launch/sites/dir are injectable for tests.
export async function withSite(id, fn, { launch = launchEdge, headed = false, sites = loadSites(), dir = defaultDir } = {}) {
  const site = getSite(id, sites);
  const browser = await launch(headed ? { headless: false } : {});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(site.origin + site.start, { waitUntil: 'load' });
    if (await visible(page, site.login.user, 5000)) {
      const credential = getCredential(id, dir);
      if (!credential) throw new Error(`${id} 需要登录但没有保存账号：请在你自己的终端运行 node automation/run.mjs browser login-set ${id}`);
      await login(page, site, credential);
    }
    return await fn(page, context);
  } finally { await browser.close(); }
}
