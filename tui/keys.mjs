// Turns raw stdin chunks into key events: {key, ch?, ctrl, alt, text?, mouse?}.
// Handles CSI/SS3 arrows, bracketed paste, SGR mouse and UTF-8 text.
const CSI_KEYS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab' };
const TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

export function createKeyParser(emit) {
  let buf = '', pasting = null;
  return function feed(chunk) {
    buf += chunk;
    for (;;) {
      if (pasting !== null) {
        const end = buf.indexOf('\x1b[201~');
        if (end < 0) { pasting += buf; buf = ''; return; }
        pasting += buf.slice(0, end); buf = buf.slice(end + 6);
        emit({ key: 'paste', text: pasting.replace(/\r\n?/g, '\n') }); pasting = null; continue;
      }
      if (!buf) return;
      if (buf[0] === '\x1b') {
        if (buf.length === 1) { emit({ key: 'escape' }); buf = ''; return; }
        if (buf.startsWith('\x1b[200~')) { buf = buf.slice(6); pasting = ''; continue; }
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
        if (m) {
          buf = buf.slice(m[0].length);
          const b = Number(m[1]);
          if ((b & 32) && (b & 3) === 3) continue; // hover, not a button drag
          emit({ key: 'mouse', mouse: { x: Number(m[2]), y: Number(m[3]), button: b & 3, wheel: b & 64 ? ((b & 1) ? 'down' : 'up') : null, down: m[4] === 'M', motion: !!(b & 32) } });
          continue;
        }
        // Legacy X10 report (terminals that ignore mode 1006): ESC [ M, then button, column, row each as a byte + 32.
        if (buf.startsWith('\x1b[M')) {
          if (buf.length < 6) return;
          const [cb, cx, cy] = [buf.charCodeAt(3) - 32, buf.charCodeAt(4) - 32, buf.charCodeAt(5) - 32];
          buf = buf.slice(6);
          if (!(cb & 32) || (cb & 3) !== 3) emit({ key: 'mouse', mouse: { x: cx, y: cy, button: cb & 3, wheel: cb & 64 ? ((cb & 1) ? 'down' : 'up') : null, down: (cb & 3) !== 3, motion: !!(cb & 32) } });
          continue;
        }
        // Replies to our terminal queries: primary device attributes (a 4 means sixel graphics) and the cell size in pixels.
        const da = /^\x1b\[\?([0-9;]*)c/.exec(buf);
        if (da) { buf = buf.slice(da[0].length); emit({ key: 'da1', params: da[1].split(';').map(Number) }); continue; }
        const cs = /^\x1b\[6;(\d+);(\d+)t/.exec(buf);
        if (cs) { buf = buf.slice(cs[0].length); emit({ key: 'cellsize', h: Number(cs[1]), w: Number(cs[2]) }); continue; }
        const c = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(buf);
        if (c) {
          buf = buf.slice(c[0].length);
          const params = c[1].split(';').map(Number), mod = (params[1] || 1) - 1;
          const key = c[2] === '~' ? TILDE[params[0]] : CSI_KEYS[c[2]];
          if (key) emit({ key, ctrl: !!(mod & 4), alt: !!(mod & 2), shift: !!(mod & 1) });
          continue;
        }
        const s = /^\x1bO([A-Za-z])/.exec(buf);
        if (s) { buf = buf.slice(3); if (CSI_KEYS[s[1]]) emit({ key: CSI_KEYS[s[1]] }); continue; }
        if (/^\x1b\[[0-9;<?]*$/.test(buf)) return; // incomplete sequence: wait for the rest
        // Alt+char
        const [first] = buf.slice(1);
        buf = buf.slice(1 + first.length);
        if (first === '\r' || first === '\n') emit({ key: 'enter', alt: true });
        else emit({ key: 'char', ch: first, alt: true });
        continue;
      }
      const [ch] = buf; buf = buf.slice(ch.length);
      const code = ch.codePointAt(0);
      if (ch === '\r' || ch === '\n') emit({ key: ch === '\n' ? 'ctrl-j' : 'enter' });
      else if (ch === '\t') emit({ key: 'tab' });
      else if (ch === '\x7f' || ch === '\b') emit({ key: 'backspace' });
      else if (code < 32) emit({ key: 'char', ch: String.fromCharCode(code + 96), ctrl: true });
      else emit({ key: 'char', ch });
    }
  };
}
