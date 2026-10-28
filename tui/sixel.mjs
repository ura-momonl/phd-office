// Sixel encoder for a full-colour RGB buffer: median-cut palette (<= 255 colours) + run-length bands.
// Pure functions; the terminal decides whether it can show the result (see DA1 detection in app.mjs).

// pixels: Uint8Array RGB (w*h*3). Returns { palette:[[r,g,b]...], index:Uint8Array(w*h) }.
export function quantize(pixels, count, max = 255, exact = null) {
  const hist = new Map(), isExact = i => exact && pixels[i * 3] === exact[0] && pixels[i * 3 + 1] === exact[1] && pixels[i * 3 + 2] === exact[2];
  if (exact) max -= 1; // one palette slot is kept for the exact ground colour so it matches the terminal's own background
  for (let i = 0; i < count; i++) {
    if (isExact(i)) continue;
    // Group in 5-bit bins, but keep their actual colours. Replacing every dark
    // bin by its centre manufactured colour steps next to the exact background.
    const k = ((pixels[i * 3] >> 3) << 10) | ((pixels[i * 3 + 1] >> 3) << 5) | (pixels[i * 3 + 2] >> 3);
    let bin = hist.get(k);
    if (!bin) { bin = { k, r: 0, g: 0, b: 0, n: 0 }; hist.set(k, bin); }
    bin.r += pixels[i * 3]; bin.g += pixels[i * 3 + 1]; bin.b += pixels[i * 3 + 2]; bin.n++;
  }
  let boxes = [{ items: [...hist.values()].map(p => ({ k: p.k, r: p.r / p.n, g: p.g / p.n, b: p.b / p.n, n: p.n })) }];
  const range = box => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const p of box.items) for (const [i, c] of [[0, p.r], [1, p.g], [2, p.b]]) { lo[i] = Math.min(lo[i], c); hi[i] = Math.max(hi[i], c); }
    const span = hi.map((v, i) => v - lo[i]), ch = span.indexOf(Math.max(...span));
    return { ch, span: span[ch] };
  };
  while (boxes.length < max) {
    let best = -1, bs = 0;
    boxes.forEach((b, i) => { if (b.items.length > 1) { const s = range(b).span * Math.log2(b.items.reduce((a, p) => a + p.n, 0) + 1); if (s > bs) { bs = s; best = i; } } });
    if (best < 0) break;
    const box = boxes[best], { ch } = range(box), key = ['r', 'g', 'b'][ch];
    box.items.sort((p, q) => p[key] - q[key]);
    const total = box.items.reduce((a, p) => a + p.n, 0); let acc = 0, cut = 1;
    for (let i = 0; i < box.items.length - 1; i++) { acc += box.items[i].n; cut = i + 1; if (acc >= total / 2) break; }
    boxes.splice(best, 1, { items: box.items.slice(0, cut) }, { items: box.items.slice(cut) });
  }
  const palette = boxes.map(b => { const t = b.items.reduce((a, p) => a + p.n, 0); return [b.items.reduce((a, p) => a + p.r * p.n, 0) / t, b.items.reduce((a, p) => a + p.g * p.n, 0) / t, b.items.reduce((a, p) => a + p.b * p.n, 0) / t].map(Math.round); });
  const lookup = new Map();
  boxes.forEach((b, i) => b.items.forEach(p => lookup.set(p.k, i)));
  const index = new Uint8Array(count);
  if (exact) palette.push(exact.slice());
  // Soft glow around bright shapes sits just above the ground colour. A palette entry averaged together with the art's near-black
  // would be darker than the ground, and every halo pixel snapping to it draws a dark rim. Dim pixels at or above the ground are
  // therefore matched only to entries that are not darker than the ground.
  const above = exact ? palette.map(c => c[0] >= exact[0] && c[1] >= exact[1] && c[2] >= exact[2]) : null, halo = new Map();
  const nearestAbove = (r, g, b) => { let best = palette.length - 1, bd = Infinity; palette.forEach((c, j) => { if (!above[j]) return; const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = j; } }); return best; };
  for (let i = 0; i < count; i++) {
    if (isExact(i)) { index[i] = palette.length - 1; continue; }
    const r = pixels[i * 3], g = pixels[i * 3 + 1], bl = pixels[i * 3 + 2], key = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
    if (exact && r >= exact[0] && g >= exact[1] && bl >= exact[2] && Math.max(r, g, bl) < 96) {
      let j = halo.get(key); if (j === undefined) { j = nearestAbove(r, g, bl); halo.set(key, j); }
      index[i] = j;
    } else index[i] = lookup.get(key);
  }
  return { palette, index };
}

// Returns the complete DCS string (ESC P q ... ESC \). Rows below the picture, up to the next multiple of 6, are the ground colour (the last pixel's colour when there is none).
export function encodeSixel(pixels, w, h, colors = 96, exact = null) {
  const { palette, index } = quantize(pixels, w * h, colors, exact), padIndex = exact ? palette.length - 1 : index[w * h - 1];
  let out = `\x1bP0;0;0q"1;1;${w};${h}`;
  palette.forEach((c, i) => { out += `#${i};2;${Math.round(c[0] / 2.55)};${Math.round(c[1] / 2.55)};${Math.round(c[2] / 2.55)}`; });
  for (let y0 = 0; y0 < h; y0 += 6) {
    const cols = new Map(); // colour -> Uint8Array of sixel bits per x
    for (let x = 0; x < w; x++) for (let k = 0; k < 6; k++) {
      const y = y0 + k, c = y < h ? index[y * w + x] : padIndex;
      let a = cols.get(c); if (!a) { a = new Uint8Array(w); cols.set(c, a); }
      a[x] |= 1 << k;
    }
    let first = true;
    for (const [c, a] of cols) {
      out += (first ? '' : '$') + `#${c}`; first = false;
      let x = 0;
      while (x < w) {
        let n = 1; while (x + n < w && a[x + n] === a[x]) n++;
        const ch = String.fromCharCode(63 + a[x]);
        out += n > 3 ? `!${n}${ch}` : ch.repeat(n); x += n;
      }
    }
    out += '-';
  }
  return out + '\x1b\\';
}
