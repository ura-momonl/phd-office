// Selection belongs to the TUI while mouse reporting is on. Keep the displayed
// frame stable during a drag, including when replies stream underneath it.
import { cw, strip } from './text.mjs';

const before = (a, b) => a.y < b.y || (a.y === b.y && a.x < b.x);
const bounds = s => before(s.anchor, s.end) ? [s.anchor, s.end] : [s.end, s.anchor];
const span = (s, y) => {
  const [a, b] = bounds(s);
  return y < a.y || y > b.y ? null : [y === a.y ? a.x - 1 : 0, y === b.y ? b.x : Infinity];
};

export function selectionText(s) {
  const rows = [];
  s.frame.forEach((line, i) => {
    const range = span(s, i + 1); if (!range) return;
    let cell = 0, text = '', selected = false;
    for (const ch of strip(line)) {
      const w = cw(ch.codePointAt(0));
      if (w) selected = cell < range[1] && cell + w > range[0];
      if (selected) text += ch;
      cell += w;
    }
    rows.push(text.trimEnd());
  });
  return rows.join('\n');
}

export function selectionFrame(s) {
  return s.frame.map((line, i) => {
    const range = span(s, i + 1); if (!range) return line;
    let cell = 0, out = '', selected = false;
    for (const token of line.match(/\x1b\[[0-9;:]*m|[^]/gu) || []) {
      if (token.startsWith('\x1b')) { out += token + (selected ? '\x1b[7m' : ''); continue; }
      const w = cw(token.codePointAt(0)), next = w ? cell < range[1] && cell + w > range[0] : selected;
      if (next !== selected) out += next ? '\x1b[7m' : '\x1b[27m';
      out += token; cell += w; selected = next;
    }
    return out + '\x1b[27m';
  });
}

export function moveSelection(app, m) {
  const s = app.selection; if (!s?.down) return;
  s.end = { x: Math.max(1, Math.min(app.cols, m.x)), y: Math.max(1, Math.min(s.frame.length, m.y)) };
  s.dragged ||= s.end.x !== s.anchor.x || s.end.y !== s.anchor.y;
}
