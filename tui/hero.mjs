// Home hero (sprite + title) as one true-pixel picture for sixel terminals, with the Animal Well treatment done per
// screen pixel: soft light behind the figure, bloom around bright pixels, thin scanlines, slight colour fringing,
// a slow brightness roll, rare flicker/wobble and drifting motes. Pure: (layout, time) -> RGB buffer.
import asset from './assets/mascot.json' with { type: 'json' };
import { MASCOT_FRAME_MS, MASCOT_FRAMES, MASCOT_PALETTE } from './mascot.mjs';
import { GLYPHS } from './view.mjs';
import { CRT_BG } from './crt.mjs';

const frames = asset.frames.map(s => Buffer.from(s, 'base64'));
const X0 = 6, SW = 48, SH = 64; // the art lives in x 6..54 of the 64 px frame
const hash = (a, b = 0, c = 0) => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return ((h >>> 0) % 100000) / 100000; };
// Old-tube colour, the cold way: many sets ran a 9300 K white (blue-leaning, red held back) and showed shadows with a teal-grey cast.
// The art goes through SMPTE-C phosphors (narrower gamut), a steeper gamma (2.5 against 2.2) and a cool white point; shadows are
// split-toned towards teal so the pale face reads sickly-cold, highlights stay near neutral. Nothing is warmed.
export const GRADE_ON = false; // colour grade off: the art keeps its own colours (grade() below stays for later)
export const GRADE = { sat: 0.8, gamma: 2.5 / 2.2, white: [0.95, 1.0, 1.07], shadow: [0.82, 1.04, 1.1], shadowAmount: 0.75, lift: 3 };
const SMPTE_C = [[0.9395, 0.0502, 0.0103], [0.0178, 0.9658, 0.0164], [-0.0016, -0.0044, 1.006]]; // linear SMPTE-C -> sRGB
export function grade(c, g = GRADE) {
  const lin = c.map(v => Math.pow(Math.max(0, v) / 255, 2.2)), m = SMPTE_C.map(r => r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]);
  const L = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  // shadow weight: full in the darks and mid-greys, fading out through the highlights (no tint on white)
  const t = Math.min(1, Math.max(0, 1 - Math.sqrt(L) / 0.95)), w = t * t * (3 - 2 * t) * g.shadowAmount;
  return m.map((v, i) => { const x = Math.max(0, L + (v - L) * g.sat) * g.white[i] * (1 + (g.shadow[i] - 1) * w); return Math.min(255, Math.pow(Math.min(1, Math.pow(x, g.gamma)), 1 / 2.2) * (255 - g.lift) + g.lift); });
}
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);

// Tube letters on a 4 x 6 box (x right, y down); corners are chamfered the way bent glass tube turns.
const PIXEL_TITLE = true; // the title drawn in the sprite's own pixels (false: smooth glass tube)
const TUBE_GAP = 1.9;
const TUBE = {
  P: [[[0, 6], [0, 0.6], [0.6, 0], [3.2, 0], [4, 0.8], [4, 2.2], [3.2, 3], [0, 3]]],
  I: [[[0.4, 0], [3.6, 0]], [[2, 0], [2, 6]], [[0.4, 6], [3.6, 6]]],
  R: [[[0, 6], [0, 0.6], [0.6, 0], [3.2, 0], [4, 0.8], [4, 2.2], [3.2, 3], [0, 3]], [[2.2, 3], [4, 6]]],
  O: [[[0.8, 0], [3.2, 0], [4, 0.8], [4, 5.2], [3.2, 6], [0.8, 6], [0, 5.2], [0, 0.8], [0.8, 0]]],
  F: [[[0, 6], [0, 0.6], [0.6, 0], [4, 0]], [[0, 3], [3, 3]]],
  C: [[[4, 0.9], [3.1, 0], [0.9, 0], [0, 0.9], [0, 5.1], [0.9, 6], [3.1, 6], [4, 5.1]]],
  E: [[[4, 0], [0.6, 0], [0, 0.6], [0, 5.4], [0.6, 6], [4, 6]], [[0, 3], [3, 3]]],
};

// Picks the largest pixel scale that fits the rows and columns on offer; null when even 2 px per sprite pixel does not fit.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export function heroLayout({ cols, maxRows, cw, ch }) {
  const rows = Math.min(maxRows, 30);
  for (let k = Math.floor(rows * ch / SH); k >= 2; k--) {
    // k sets the title's scale; the character is drawn a quarter smaller (ks) so the title carries the picture
    const t = k, ks = Math.max(2, Math.round(k * 0.75)), gap = 7 * ks, width = SW * ks + gap + 76 * t;
    if (width <= (cols - 2) * cw) {
      // Sixel is sent in bands of 6 pixel rows. Keeping the picture a multiple of both 6 px and the cell height (so 60 px for 20 px cells)
      // means no padding rows are ever sent below it; those used to repeat the bottom row of the art and spill into the row below.
      const unit = ch * 6 / gcd(ch, 6) / ch, cellsW = Math.ceil(width / cw), cellsH = Math.ceil(Math.ceil(Math.max(SH * ks, 41 * t) / ch) / unit) * unit;
      if (cellsH > rows) continue;
      return { k, ks, t, gap, cellsW, cellsH, W: cellsW * cw, H: cellsH * ch, cw, ch, spriteW: SW * ks, spriteH: SH * ks, pad: 0 };
    }
  }
  return null;
}

// What changes over time, in steps: the picture is re-sent only when `key` changes (about three times a second at most).
const BAR_STEPS = 16;
const SCAN = { depth: 0.6, lum: 0.3, knee: 215 }; // seam darkness, light gained by bright pixels, where the highlight roll-off starts
// Soft shoulder instead of a hard clip: values above `knee` are compressed so over-bright skin and white keep their hue.
const toneOf = v => v <= SCAN.knee ? v : SCAN.knee + (255 - SCAN.knee) * (1 - Math.exp(-(v - SCAN.knee) / (255 - SCAN.knee)));
export function timeState(now, effects = true) {
  const sec = now / 1000, fi = Math.floor(now / MASCOT_FRAME_MS) % MASCOT_FRAMES;
  if (!effects) return { fi, bar: -BAR_STEPS, flick: false, glitch: null, key: `${fi}` };
  const slot = Math.floor(sec / 4.1), dip = sec - slot * 4.1 - hash(slot, 1) * 3.4, flick = dip >= 0 && dip < 0.12;
  const gSlot = Math.floor(sec / 8.7), gOn = sec - gSlot * 8.7 - hash(gSlot, 2) * 7.5, glitch = gOn >= 0 && gOn < 0.14 ? gSlot : null;
  // no rolling bar in the picture: it would re-send ~100-200 KB several times a second; the cell rows around still carry theirs
  return { fi, bar: -BAR_STEPS, flick, glitch, key: `${fi}|${flick ? 1 : 0}|${glitch ?? ''}` };
}

const LAYERS = new Map();
export function renderHero(L, { now = 0, themeKey = 'clay', theme, effects = true, palette: sourcePalette = MASCOT_PALETTE } = {}) {
  const { W, H, k, ks, t } = L, bg = CRT_BG[themeKey] || CRT_BG.clay, light = bg[0] > 128, sec = now / 1000;
  const accent = theme?.accent || [217, 119, 87], warm = theme?.warn || [222, 176, 90];
  const base = new Float32Array(W * H * 3), lit = new Uint8Array(W * H); // base colour; lit marks art pixels
  const oy = H - L.spriteH; // the character stands on the bottom edge of the picture; the title's last line sits on the same line
  const fi = Math.floor(now / MASCOT_FRAME_MS) % MASCOT_FRAMES, fr = frames[fi];
  const palette = sourcePalette.map(p => (p[3] < 100 || !GRADE_ON ? p : [...grade(p), p[3]])); // the whole sprite palette is graded once per frame
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = y * W + x; lit[o] = 1; base[o * 3] = c[0]; base[o * 3 + 1] = c[1]; base[o * 3 + 2] = c[2]; };
  // ground + title never change between frames, so they are built once per layout and copied (the tube letters are the slow part)
  const layerKey = `${W}x${H}|${k}|${ks}|${themeKey}`, cached = LAYERS.get(layerKey);
  if (cached) { base.set(cached.base); lit.set(cached.lit); } else {
  // ground: flat background plus a faint warm light behind the figure that fades out before the picture edge
  const lx = L.spriteW / 2, ly = H / 2, lr = Math.min(W, H) * 0.5; // light stays well inside the picture so its edge never shows against the flat cells
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - lx, (y - ly) * 1.15) / lr, g = d < 1 ? Math.pow(1 - d, 2) * (light ? -0.05 : 0.07) : 0, o = (y * W + x) * 3;
    for (let i = 0; i < 3; i++) base[o + i] = bg[i] + (light ? bg[i] : accent[i]) * g;
  }
  // title: glass-tube letters. Each letter is a few polylines (corners chamfered like bent tube); a pixel's distance to the nearest
  // segment decides tube / rim / core, and a soft orange halo is added around it. Width stays 72k, so the layout is unchanged.
  const tx = L.spriteW + L.gap, baseline = oy + L.spriteH - 0.5 * ks; // outer edge of OFFICE's tube = bottom of the character
  const neon = (text, scale, x0, y0, y1, tubeR) => { // tubeR: tube radius in screen px
    const segs = []; let ax = 0;
    for (const chr of text) {
      for (const line of TUBE[chr]) for (let i = 0; i + 1 < line.length; i++) segs.push([x0 + (ax + line[i][0]) * scale, y0 + line[i][1] * scale, x0 + (ax + line[i + 1][0]) * scale, y0 + line[i + 1][1] * scale]);
      ax += 4 + TUBE_GAP;
    }
    const R = Math.ceil(tubeR + 2.4 * k), sig = 1.5 * k, ground = bg;
    const xa = Math.max(0, Math.floor(x0 - R)), xb = Math.min(W - 1, Math.ceil(x0 + (ax - TUBE_GAP) * scale + R));
    const ya = Math.max(0, Math.floor(y0 - R)), yb = Math.min(H - 1, Math.ceil(y1 + R));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      let d = Infinity;
      for (const [x1, y1_, x2, y2] of segs) {
        const dx = x2 - x1, dy = y2 - y1_, l2 = dx * dx + dy * dy, tt = l2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1_) * dy) / l2)) : 0;
        const e = Math.hypot(x - (x1 + tt * dx), y - (y1_ + tt * dy)); if (e < d) d = e;
      }
      if (d > R) continue;
      const o = y * W + x, yn = Math.min(1, Math.max(0, (y - y0) / (y1 - y0))), rim = lerp(accent, warm, yn);
      const halo = 0.34 * Math.exp(-((d / sig) ** 2)); // orange light spilling onto the ground
      let col = [base[o * 3] + rim[0] * halo, base[o * 3 + 1] + rim[1] * halo, base[o * 3 + 2] + rim[2] * halo];
      const a = Math.max(0, Math.min(1, tubeR + 0.5 - d)); // 1 px of anti-aliasing at the tube's edge
      if (a > 0) {
        const core = Math.max(0, 1 - d / (0.5 * tubeR)), tube = lerp(rim, [255, 238, 212], 0.68 * core);
        col = col.map((v, i) => v + (tube[i] - v) * a); if (a >= 0.5) lit[o] = 1;
      }
      base[o * 3] = col[0]; base[o * 3 + 1] = col[1]; base[o * 3 + 2] = col[2];
    }
  };
  const sBase = 72 * t / (16 + 3 * TUBE_GAP), sP = 0.88 * sBase, sO = 0.64 * sBase; // PIRI 88% of the old letter size, OFFICE 64%: both left-aligned, OFFICE runs wider than PIRI like a base plate
  const yO = baseline - 1.4 * k - 6 * sO, yP = yO - 7.5 * t - 6 * sP; // OFFICE's bottom line, then PIRI above it
  // Pixel title: the same letter outlines drawn on the sprite's own pixel grid (one cell = ks x ks screen px, aligned to the sprite's rows), so the
  // title and the character share one pixel size and the scanline seams run through both. PIRI strokes are 5 cells, OFFICE 4, left edges aligned.
  const pixelWord = (text, s, stroke, xLeft, bottomY, gapAfterEdgeCells) => {
    const wC = Math.round(4 * s / ks), hC = Math.round(6 * s / ks), gC = Math.floor(TUBE_GAP * s / ks), off = stroke % 2 ? ks / 2 : 0, half = stroke * ks / 2 + 0.01 * ks;
    const yTop = bottomY - hC * ks, segs = []; let li = 0;
    for (const chr of text) {
      const xo = xLeft + li * (wC + gC) * ks + off;
      for (const line of TUBE[chr]) for (let i = 0; i + 1 < line.length; i++) segs.push([xo + line[i][0] / 4 * wC * ks, yTop + line[i][1] / 6 * hC * ks, xo + line[i + 1][0] / 4 * wC * ks, yTop + line[i + 1][1] / 6 * hC * ks]);
      li++;
    }
    const x1 = xLeft + (li * (wC + gC) - gC) * ks + ks, g0 = Math.floor((xLeft - 2 * ks) / ks), g1 = Math.ceil(x1 / ks), r0 = Math.floor((yTop - 2 * ks - oy) / ks), r1 = Math.ceil((bottomY + 2 * ks - oy) / ks);
    for (let gy = r0; gy <= r1; gy++) for (let gx = g0; gx <= g1; gx++) {
      const cx = gx * ks + ks / 2, cy = oy + gy * ks + ks / 2; let d = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, tt = l2 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0, e = Math.hypot(cx - (ax + tt * dx), cy - (ay + tt * dy));
        if (e < d) d = e;
      }
      if (d > half) continue;
      const rim = lerp(accent, warm, Math.min(1, Math.max(0, (cy - yTop) / (hC * ks)))), col = stroke >= 4 && d <= (stroke - 2) * ks / 2 + 0.01 * ks ? lerp(rim, [255, 238, 212], 0.5) : rim;
      for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) { const x = gx * ks + i, y = oy + gy * ks + j; if (x >= 0 && y >= 0 && x < W && y < H) { const o = y * W + x; lit[o] = 1; base[o * 3] = col[0]; base[o * 3 + 1] = col[1]; base[o * 3 + 2] = col[2]; } }
    }
    return { hC, topEdge: yTop - stroke * ks / 2, bottomEdge: bottomY + stroke * ks / 2 };
  };
  if (PIXEL_TITLE) {
    const xLeft = tx + 2 * ks, o = pixelWord('OFFICE', sO, 4, xLeft, oy + L.spriteH - 2 * ks);
    pixelWord('PIRI', sP, 5, xLeft, o.topEdge - 5 * ks - 2.5 * ks);
  } else {
    neon('PIRI', sP, tx + 1.5 * k, yP, yP + 6 * sP, 2.2 * k); neon('OFFICE', sO, tx + 1.5 * k, yO, yO + 6 * sO, 1.4 * k); // 1.5k of room each side for tube and halo
  }
  LAYERS.set(layerKey, { base: base.slice(), lit: lit.slice() }); }
  // sprite, nearest-neighbour: one source pixel = k x k screen pixels
  for (let sy = 0; sy < SH; sy++) for (let sx = 0; sx < SW; sx++) {
    const p = palette[fr[sy * 64 + sx + X0]]; if (p[3] < 100) continue;
    for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) put(sx * ks + i, oy + sy * ks + j, p);
  }

  // bloom: blur the art at 1/b resolution and add it back onto the dark ground
  const b = Math.max(2, ks), bw = Math.ceil(W / b), bh = Math.ceil(H / b), small = new Float32Array(bw * bh * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = y * W + x; if (!lit[o]) continue; const s = ((y / b | 0) * bw + (x / b | 0)) * 3; for (let i = 0; i < 3; i++) small[s + i] += base[o * 3 + i] / (b * b); }
  const tmp = new Float32Array(small.length), blur = new Float32Array(small.length), R = 3, w = [1, 0.8, 0.5, 0.25];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let i = 0; i < 3; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const xx = x + d; if (xx < 0 || xx >= bw) continue; s += small[(y * bw + xx) * 3 + i] * w[Math.abs(d)]; n += w[Math.abs(d)]; } tmp[(y * bw + x) * 3 + i] = s / n; }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let i = 0; i < 3; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const yy = y + d; if (yy < 0 || yy >= bh) continue; s += tmp[(yy * bw + x) * 3 + i] * w[Math.abs(d)]; n += w[Math.abs(d)]; } blur[(y * bw + x) * 3 + i] = s / n; }

  // The glow lives at 1/b resolution; sample it bilinearly (nearest-neighbour made it a staircase of b x b blocks whose edges jumped by
  // a whole block when the art moved one pixel) and let it die out before the picture border, where it used to end in a hard line.
  const ZERO = [0, 0, 0], gtmp = [0, 0, 0];
  const glowAt = (x, y) => {
    const fx = (x + 0.5) / b - 0.5, fy = (y + 0.5) / b - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const edge = Math.min(1, Math.min(x, W - 1 - x, y, H - 1 - y) / 40), e = edge * edge * (3 - 2 * edge);
    for (let i = 0; i < 3; i++) {
      const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= bw || yy >= bh ? 0 : blur[(yy * bw + xx) * 3 + i]);
      gtmp[i] = e * ((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty);
    }
    return gtmp;
  };
  // composite with the per-pixel effects
  const st = timeState(now, effects), flick = st.flick ? 0.94 : 1, barY = st.bar / BAR_STEPS * (H * 1.5) - H * 0.25;
  const gSlot = st.glitch, gy0 = Math.floor(hash(gSlot ?? 0, 3) * (H - 40)), gdx = hash(gSlot ?? 0, 4) < 0.5 ? -ks : ks, glitch = gSlot !== null;
  const out = new Uint8Array(W * H * 3), c0 = new Float32Array(W * 3), c1 = new Float32Array(W * 3), reach = new Float32Array(W);
  const bloomK = light ? 0 : 0.30, X = Math.min;
  for (let y = 0; y < H; y++) {
    // One sprite pixel = k screen rows. The Animal Well recreation's CRT pass (shaders/crt.gdshader, 6 px per game pixel) weights
    // the rows of a pixel [1, .5, 0, 0, .5, 1] (seam rows dark, middle rows clear); this is the same shape for any k.
    const d = Math.abs(((((y - oy) % ks) + ks) % ks + 0.5) / ks - 0.5), scan = effects ? Math.max(0, Math.min(1, (d - 1 / 6) * 3)) : 0;
    const bar = effects ? 1 + (light ? -0.04 : 0.06) * Math.max(0, 1 - Math.abs(y - barY) / (H * 0.07)) : 1;
    for (let x = 0; x < W; x++) {
      const o = y * W + x, a = lit[o], f = a ? bar * flick : 1, g = a || !effects ? ZERO : glowAt(x, y), gl = g[1] * bloomK;
      for (let i = 0; i < 3; i++) c0[x * 3 + i] = (base[o * 3 + i] + g[i] * bloomK) * f;
      reach[x] = a ? 1 : X(1, 0.06 + gl / 255 * 3.5); // the plain ground is left alone so the picture has no visible edge
    }
    // horizontal beam: the recreation blurs with taps [1,1,2,1,1]/6 across a pixel, then scales by 1 - scan/2 + luma/2:
    // seams halve the light, and bright pixels gain up to +50% (they bloom past the dark seam instead of being cut by it).
    for (let x = 0; x < W; x++) for (let i = 0; i < 3; i++) c1[x * 3 + i] = effects ? (2 * c0[x * 3 + i] + c0[X(W - 1, x + 1) * 3 + i] + c0[Math.max(0, x - 1) * 3 + i] + c0[X(W - 1, x + 2) * 3 + i] + c0[Math.max(0, x - 2) * 3 + i]) / 6 : c0[x * 3 + i];
    for (let x = 0; x < W; x++) {
      const lum = (c1[x * 3] * 0.3 + c1[x * 3 + 1] * 0.59 + c1[x * 3 + 2] * 0.11) / 255, f = 1 + reach[x] * (SCAN.lum * lum - SCAN.depth * scan);
      // The scanline gaps only dim light the picture itself adds (art, glow): they must never take the plain ground below its own
      // colour, or every glyph gets a dark outline. Non-art pixels are floored at the ground + soft light underneath them.
      const o = y * W + x, art = lit[o];
      // Highlight roll-off on the brightest channel, applied to all three alike: squeezing channels separately pulls pale colours (the
      // blue-grey of the face) towards white and loses their tint.
      const m = Math.max(c1[x * 3], c1[x * 3 + 1], c1[x * 3 + 2]) * f, sc = effects && m > SCAN.knee ? toneOf(m) / m : 1;
      for (let i = 0; i < 3; i++) { const v = effects ? c1[x * 3 + i] * f * sc : c1[x * 3 + i]; c0[x * 3 + i] = art ? v : Math.max(v, base[o * 3 + i]); }
    }
    // colour fringing (red a pixel to the left, blue a pixel to the right) and the rare sideways wobble of a thin band
    const shift = glitch && y >= gy0 && y < gy0 + 2 * ks ? gdx : 0;
    for (let x = 0; x < W; x++) {
      const xs = Math.min(W - 1, Math.max(0, x - shift)), o = (y * W + x) * 3, fr1 = 0;
      out[o] = clamp(c0[Math.min(W - 1, xs + fr1) * 3]); out[o + 1] = clamp(c0[xs * 3 + 1]); out[o + 2] = clamp(c0[Math.max(0, xs - fr1) * 3 + 2]);
    }
  }
  return out;
}
