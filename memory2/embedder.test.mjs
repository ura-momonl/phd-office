import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { GpuEmbedder } from './embedder.mjs';

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// An in-process stand-in for embed_server.py speaking the same protocol (no GPU, no Python).
async function fakeServer() {
  const calls = [], token = 'tok-test';
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(404).end('{}'); return; }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); return; }
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const { texts, query } = JSON.parse(body); calls.push({ n: texts.length, query });
      const dim = 4, buf = Buffer.alloc(texts.length * dim * 4);
      texts.forEach((t, i) => { for (let k = 0; k < dim; k++) buf.writeFloatLE(t.length + k + i * 0.5, (i * dim + k) * 4); });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ n: texts.length, dim, vectors: buf.toString('base64') }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-emb-')); made.push(dir);
  const infoFile = path.join(dir, 'info.json');
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port: server.address().port, token }));
  return { server, calls, infoFile };
}

test('client reuses a running service, decodes float32 vectors, passes the query flag and splits batches', async () => {
  const { server, calls, infoFile } = await fakeServer();
  try {
    const e = new GpuEmbedder({ infoFile, batchTexts: 2 });
    const v = await e.embed(['ab', 'abcd', 'abcdef'], { query: true });
    assert.equal(v.length, 3);
    assert.deepEqual(v[0], [2, 3, 4, 5]);
    assert.equal(v[1].length, 4);
    assert.deepEqual(calls, [{ n: 2, query: true }, { n: 1, query: true }]);
    assert.deepEqual(await e.embed([]), []);
  } finally { server.close(); }
});

test('missing python/model files fail with a named path instead of hanging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-emb-')); made.push(dir);
  const e = new GpuEmbedder({ infoFile: path.join(dir, 'none.json'), python: path.join(dir, 'no-python.exe'), startTimeoutMs: 5000 });
  await assert.rejects(e.embed(['x']), /缺少文件.*no-python/);
  assert.equal(fs.existsSync(path.join(dir, 'none.json.starting')), false, 'start lock released');
});
