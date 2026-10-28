// Lossless palette data from mascot-sheet.png: 3 × 3, row-major, 64 × 64 per frame.
// Decode once; no image library, terminal image protocol, or runtime file conversion.
import asset from './assets/mascot.json' with { type: 'json' };
import selection from './mascot-curves.json' with { type: 'json' };
import { curvePalette } from './curves.mjs';

// Applied selection is separate from the editor's draft and the lossless art.
export const MASCOT_PALETTE = curvePalette(asset.palette, selection.curves);

export const MASCOT_FRAME_MS = asset.frame_ms;
export const MASCOT_FRAMES = asset.frames.length;
const frames = asset.frames.map(s => Buffer.from(s, 'base64'));
const sizes = new Map();
export const mascotFrame = now => Math.floor(now / MASCOT_FRAME_MS) % MASCOT_FRAMES;

export function mascotPixels(size, now) {
  if (!sizes.has(size)) {
    // Area-sample in premultiplied alpha so the fine outline survives shrinking,
    // while transparent black never bleeds into the pale skin and clothes.
    const scale = asset.width / size;
    sizes.set(size, frames.map(frame => Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => {
      let alpha = 0, r = 0, g = 0, b = 0;
      for (let sy = Math.floor(y * scale); sy < Math.ceil((y + 1) * scale); sy++) for (let sx = Math.floor(x * scale); sx < Math.ceil((x + 1) * scale); sx++) {
        const area = (Math.min(sx + 1, (x + 1) * scale) - Math.max(sx, x * scale)) * (Math.min(sy + 1, (y + 1) * scale) - Math.max(sy, y * scale));
        const p = MASCOT_PALETTE[frame[sy * asset.width + sx]], a = p[3] / 255 * area;
        alpha += a; r += p[0] * a; g += p[1] * a; b += p[2] * a;
      }
      return alpha < scale * scale / 3 ? null : [r, g, b].map(v => Math.round(v / alpha));
    }))));
  }
  return sizes.get(size)[mascotFrame(now)];
}
