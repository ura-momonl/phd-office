import { launchEdge } from '../automation/browser-launch.mjs';
// Rebuilds dashboard/avatars/*.webp from D:/Main/icons: a face-centred square crop, 160px. Needs the installed Edge. Usage: node scripts/build-avatars.mjs
// The crop boxes ([file, x, y, size] in source pixels) were tuned by eye; change them if the pictures change.
import fs from 'node:fs';
const sources = { codex: ['D:/Main/icons/sol.jpg', 190, 250, 700], claude: ['D:/Main/icons/sonnet.jpg', 120, 230, 740], user: ['D:/Main/icons/user.jpg', 160, 230, 720] };
const b = await launchEdge();
const p = await b.newPage();
await p.goto('about:blank');
for (const [name, [file, cx, cy, cs]] of Object.entries(sources)) {
  const data = 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
  const out = await p.evaluate(async ({ data, size, cx, cy, cs }) => {
    const img = new Image(); img.src = data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, cx, cy, cs, cs, 0, 0, size, size);
    return { url: canvas.toDataURL('image/webp', 0.9), w: img.width, h: img.height };
  }, { data, size: 160, cx, cy, cs });
  const buffer = Buffer.from(out.url.split(',')[1], 'base64');
  fs.writeFileSync(`D:/Main/assistant/dashboard/avatars/${name}.webp`, buffer);
  console.log(name.padEnd(7), `${out.w}x${out.h} -> 160x160 (face crop)`, buffer.length, 'bytes', out.url.startsWith('data:image/webp') ? 'webp' : 'FALLBACK ' + out.url.slice(0, 20));
}
await b.close(); process.exit(0);
