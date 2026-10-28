// The WebP is canonical; the HTML copy is generated so the first sent message
// never needs an image request after the chat receipt is already visible.
import fs from 'node:fs';
const htmlFile=new URL('../dashboard/index.html',import.meta.url);
const imageFile=new URL('../dashboard/avatars/user.webp',import.meta.url);
export function inlineUserAvatar(){
  const html=fs.readFileSync(htmlFile,'utf8');
  const marker=/<meta name="office-user-avatar" content="[^"]*">|<link rel="preload" as="image" type="image\/webp" href="\/avatars\/user\.webp">/;
  if(!marker.test(html))throw new Error('User avatar HTML marker is missing');
  const data='data:image/webp;base64,'+fs.readFileSync(imageFile).toString('base64');
  fs.writeFileSync(htmlFile,html.replace(marker,`<meta name="office-user-avatar" content="${data}">`));
}
