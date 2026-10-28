// 一条命令拿到邮件里的图片：登录检查 → 找邮件 → 列附件 → 下载到本地 → 打印路径。
// 用法：
//   node scripts/mail-images.mjs "PCBWay"              按关键词找邮件（默认取第 1 封）
//   node scripts/mail-images.mjs "PCBWay" --pick 2     取第 2 封
//   node scripts/mail-images.mjs AAMkAD...             直接用消息 ID
//   node scripts/mail-images.mjs --login               只登录（打印设备码）
// 只读：只走 Mail.Read，只发 GET，不发送、不修改、不删除邮件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphRest, startReadLogin, pollReadLogin } from '../mail-flow/graph-rest.mjs';
import { listAttachments, downloadAttachment } from '../mail-flow/downloads.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'mail-flow/config.json'), 'utf8'));
const account = config.account;
if (!account) { console.error('mail-flow/config.json 没有 account；先配置邮箱地址'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const pick = Math.max(1, Number(flag('--pick') || 1) || 1);
const positional = argv.filter((v, i) => !v.startsWith('--') && argv[i - 1] !== '--pick');
const query = positional[0];

function say(o) { console.log(JSON.stringify(o, null, 2)); }

// 1) 登录状态：没登录就给设备码，用户自己开链接并输入，脚本不碰密码。
async function ensureLogin() {
  const state = await pollReadLogin(root, account, { waitSeconds: 0 });
  if (state.state === 'authenticated') return { ok: true, account: state.account };
  const login = await startReadLogin(root, account);
  return { ok: false, ...login };
}

const login = await ensureLogin();
if (!login.ok) {
  console.error(`需要先在微软页面授权（只申请 Mail.Read）：`);
  console.error(`  1. 打开 ${login.verification_uri}`);
  console.error(`  2. 输入代码 ${login.user_code}`);
  console.error(`  3. 用 ${account} 登录并同意 Mail.Read`);
  console.error(`  代码剩余约 ${Math.round((login.expires_in || 0) / 60)} 分钟。授权后重新运行本脚本即可。`);
  process.exit(2);
}
if (argv.includes('--login')) { console.log(`已登录：${login.account}`); process.exit(0); }
if (!query) {
  console.error('用法：node scripts/mail-images.mjs "关键词" [--pick N]｜<消息ID>｜--login');
  process.exit(1);
}

const graph = new GraphRest(root, account);
try {
  await graph.start();

  // 2) 找邮件：消息 ID 直接用，否则用 Graph 关键词搜索。
  let message = null;
  if (/^AAMk/i.test(query)) {
    message = await graph.request('GET', `/me/messages/${encodeURIComponent(query)}?$select=id,subject,receivedDateTime,from`);
  } else {
    const found = await graph.request('GET',
      `/me/messages?$search=${encodeURIComponent('"' + query + '"')}&$top=5&$select=id,subject,receivedDateTime,from`);
    const list = found.value || [];
    if (!list.length) { console.error(`没有找到包含「${query}」的邮件`); process.exit(3); }
    console.error('匹配到的邮件：');
    list.forEach((m, i) => console.error(`  ${i + 1}. ${m.receivedDateTime}  ${m.from?.emailAddress?.address || '?'}  ${m.subject}`));
    message = list[Math.min(pick, list.length) - 1];
  }
  console.error(`\n下载：${message.receivedDateTime || ''}  ${message.subject || ''}`);

  // 3) 列附件（含内嵌图）并逐个存到本地，每个附件独立目录，文件名不控制路径。
  const listed = await listAttachments(graph, message.id);
  if (!listed.value.length) { say({ message_id: message.id, subject: message.subject, attachments: [] }); process.exit(0); }
  const files = [];
  for (const a of listed.value) {
    const saved = await downloadAttachment(graph, root, { message_id: message.id, attachment_id: a.id });
    files.push({ name: saved.name, content_type: saved.content_type, is_inline: saved.is_inline,
      bytes: saved.bytes, sha256: saved.sha256, path: saved.path });
  }
  say({ message_id: message.id, subject: message.subject, attachments: files });
  console.error('\n打开图片：');
  for (const f of files) console.error(`  start "" "${f.path}"`);
} finally {
  graph.close();
}
