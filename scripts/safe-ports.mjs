// Test-only preload (node --import). `listen(0)` asks Windows for a port from its dynamic range, which on this machine starts at 1024 and so
// includes ports that Chromium and Node's fetch refuse outright (5060, 6669, ...): ERR_UNSAFE_PORT / "bad port" in the middle of an otherwise
// good run. Give every port-0 listener a random port from a range that holds no restricted port and that Windows does not hand out.
// A pick can still be taken or administratively reserved (20100 is here); that error is swallowed and another port is tried, so the caller only
// ever sees a successful listen (or, after many failures, the real error).
import net from 'node:net';

export const LOW = 20000, HIGH = 45000;          // above every restricted port (the highest is 10080) and above this machine's dynamic range (1024-15000)
export const randomSafePort = () => LOW + Math.floor(Math.random() * (HIGH - LOW));
const RETRYABLE = new Set(['EADDRINUSE', 'EACCES']);

const original = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const isPortZero = first === 0 || (first && typeof first === 'object' && first.port === 0);
  if (!isPortZero) return original.apply(this, args);
  const withPort = port => typeof first === 'number' ? [port, ...args.slice(1)] : [{ ...first, port }, ...args.slice(1)];
  const emit = this.emit;
  let tries = 0;
  const restore = () => { delete this.emit; };
  const attempt = () => {
    this.emit = function (event, error, ...rest) {
      if (event === 'error' && RETRYABLE.has(error?.code) && ++tries < 50) { setImmediate(attempt); return true; }
      if (event === 'error' || event === 'listening') restore();
      return emit.call(this, event, error, ...rest);
    };
    original.apply(this, withPort(randomSafePort()));
  };
  attempt();
  return this;
};
