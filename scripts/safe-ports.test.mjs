import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { LOW, HIGH } from './safe-ports.mjs';

// Chromium's restricted-port list (net/base/port_util.cc) is also what fetch refuses; none of these may ever be handed out.
const RESTRICTED = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

test('port 0 never yields a port that the browser or fetch refuses, in either call form', async () => {
  assert.ok(LOW > Math.max(...RESTRICTED) && HIGH <= 65535);
  const servers = [];
  try {
    for (let i = 0; i < 40; i++) {
      const a = net.createServer(), b = net.createServer();
      servers.push(a, b);                       // closed in finally even if a listen below fails
      await new Promise(r => a.listen(0, '127.0.0.1', r));
      await new Promise(r => b.listen({ port: 0, host: '127.0.0.1' }, r));
      for (const s of [a, b]) { const port = s.address().port; assert.ok(port >= LOW && port < HIGH, 'port ' + port); assert.equal(RESTRICTED.has(port), false); }
    }
  } finally { await Promise.all(servers.map(s => new Promise(r => s.listening ? s.close(r) : r()))); }
});

test('a pick that is taken or reserved is retried without the caller seeing an error', async () => {
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port, originalRandom = Math.random;
  // Force the first pick onto the taken port, then let real random picks continue.
  let forced = true;
  Math.random = () => { if (forced) { forced = false; return (taken - LOW) / (HIGH - LOW); } return originalRandom(); };
  const server = net.createServer(), errors = [];
  server.on('error', e => errors.push(e.code));
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    assert.deepEqual(errors, []);
    assert.notEqual(server.address().port, taken);
  } finally { Math.random = originalRandom; await new Promise(r => server.listening ? server.close(r) : r()); await new Promise(r => blocker.close(r)); }
});
