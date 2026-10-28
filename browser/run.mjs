import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { siteStatus, saveCredential, getSite, withSite } from './session.mjs';

function prompt(label, hidden) {
  process.stdout.write(label);
  const stdin = process.stdin;
  stdin.setEncoding('utf8'); stdin.setRawMode(hidden); stdin.resume();
  let text = '';
  return new Promise(resolve => {
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); return resolve(text); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1); else text += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function setCredentialInteractively(id, message) {
  if (!process.stdin.isTTY) throw new Error('请在你自己的终端运行账号设置命令（密码不要写进聊天）');
  saveCredential(id, (await prompt('用户名：', false)).trim(), await prompt('密码（不显示）：', true));
  console.log(message);
}

export async function run(action) {
  const argv = process.argv.slice(4);
  const headed = argv.includes('--headed');
  const shot = argv.find(a => a.startsWith('--shot='))?.slice(7);
  const [site, target, ...rest] = argv.filter(a => a !== '--headed' && !a.startsWith('--shot='));
  if (action === 'status') console.log(JSON.stringify(siteStatus(), null, 2));
  else if (action === 'login-set') {
    getSite(site);
    await setCredentialInteractively(site, `已保存到 .runtime/browser/credentials.local.json（本机、未进版本库和备份）；每次调用都会重新登录，不保存 cookie。`);
  } else if (action === 'read') {
    getSite(site);
    const out = await withSite(site, async page => {
      if (target) await page.goto(new URL(target, page.url()).href, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      if (shot) await page.screenshot({ path: path.resolve(shot), fullPage: true });
      return { url: page.url(), title: await page.title(), text: await page.locator('body').innerText() };
    }, { headed });
    console.log(JSON.stringify(out, null, 2));
  } else if (action === 'run') {
    getSite(site);
    if (!target) throw new Error('browser run <站点> <脚本.mjs>');
    const script = (await import(pathToFileURL(path.resolve(target)).href)).default;
    if (typeof script !== 'function') throw new Error('脚本须 export default async (page, { context, args }) => 结果');
    console.log(JSON.stringify(await withSite(site, (page, context) => script(page, { context, args: rest }), { headed }), null, 2));
  } else throw new Error('browser: status, login-set <站点>, read <站点> [路径或网址] [--shot=文件.png] [--headed], run <站点> <脚本.mjs> [参数...]');
}
