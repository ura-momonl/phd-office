// Terminal text helpers: display width (CJK = 2 cells), ANSI-aware measuring, wrapping and truncation.
const ANSI = /\x1b\[[0-9;:<?]*[ -/]*[@-~]/g;
export const strip = s => String(s).replace(ANSI, '');

export function cw(cp) {
  if (cp === 0 || (cp < 32) || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of strip(s)) w += cw(ch.codePointAt(0));
  return w;
}

// Cut a plain string to at most `max` cells, adding an ellipsis when something was removed.
export function clip(s, max) {
  s = String(s).replace(/\s+/g, ' ');
  if (width(s) <= max) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const c = cw(ch.codePointAt(0));
    if (w + c > max - 1) break;
    out += ch; w += c;
  }
  return out + '…';
}

export const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));

// Greedy wrap of a plain string into lines of at most `max` cells. Breaks at a space when one is close, otherwise between characters.
export function wrap(text, max) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = '', w = 0, lastSpace = -1, lastSpaceW = 0;
    for (const ch of raw) {
      const c = cw(ch.codePointAt(0));
      if (w + c > max && line) {
        if (lastSpace > 0 && w - lastSpaceW < max / 2) {
          out.push(line.slice(0, lastSpace).trimEnd());
          line = line.slice(lastSpace + 1); w = width(line);
        } else { out.push(line); line = ''; w = 0; }
        lastSpace = -1;
      }
      if (ch === ' ') { lastSpace = line.length; lastSpaceW = w; }
      line += ch; w += c;
    }
    out.push(line);
  }
  return out;
}

// Truncate an ANSI string to at most n visible cells, keeping its escape codes (closes styles at the cut).
export function cut(s, n) {
  if (width(s) <= n) return s;
  let out = '', w = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') { const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i)); if (m) { out += m[0]; i += m[0].length; continue; } }
    const ch = String.fromCodePoint(s.codePointAt(i)), c = cw(ch.codePointAt(0));
    if (w + c > n) break;
    out += ch; w += c; i += ch.length;
  }
  return out + '\x1b[0m';
}
