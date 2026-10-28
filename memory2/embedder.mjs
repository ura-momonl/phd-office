// Node client for memory2/embed_server.py: starts the GPU embedding service on demand, reuses a running one,
// and exposes the { model, embed(texts, {query}) } interface that MemoryIndex / Searcher expect.
// A start lock (O_EXCL) keeps two callers from loading the 4.4 GB model twice.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
export const MODEL_NAME = 'Qwen/Qwen3-Embedding-4B';
// pythonw.exe has no console subsystem, so starting the server never opens a visible console window; its output goes to embed-server.log.
const venvScripts = path.join(root, '.runtime/tools/embed/venv/Scripts');
const defaults = {
  python: fs.existsSync(path.join(venvScripts, 'pythonw.exe')) ? path.join(venvScripts, 'pythonw.exe') : path.join(venvScripts, 'python.exe'),
  modelDir: path.join(root, '.runtime/tools/embed/qwen3-4b-int8'),
  infoFile: path.join(root, '.runtime/memory2/embed-server.json'),
  server: path.join(here, 'embed_server.py'),
  idleSeconds: 600, startTimeoutMs: 180000, batchTexts: 64,
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readInfo = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export class GpuEmbedder {
  constructor(options = {}) { this.o = { ...defaults, ...options }; this.model = MODEL_NAME; this.info = null; }

  async health(info) {
    if (!info || !alive(info.pid)) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(5000) });
      return r.ok;
    } catch { return false; }
  }
  async ensureServer() {
    if (await this.health(this.info)) return this.info;
    const current = readInfo(this.o.infoFile);
    if (await this.health(current)) return (this.info = current);
    fs.mkdirSync(path.dirname(this.o.infoFile), { recursive: true });
    const lock = this.o.infoFile + '.starting', deadline = Date.now() + this.o.startTimeoutMs;
    let owner = false;
    while (Date.now() < deadline) {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); owner = true; break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > this.o.startTimeoutMs) { fs.rmSync(lock, { force: true }); continue; }
        const info = readInfo(this.o.infoFile); // someone else is starting it: wait for readiness
        if (await this.health(info)) return (this.info = info);
        await sleep(500);
      }
    }
    if (!owner) throw new Error('等待嵌入服务启动超时');
    try {
      // The previous lock holder may have finished between our health check and our taking the lock: look again before starting a second server.
      const ready = readInfo(this.o.infoFile);
      if (await this.health(ready)) return (this.info = ready);
      for (const f of [this.o.python, this.o.modelDir, this.o.server]) if (!fs.existsSync(f)) throw new Error('嵌入服务缺少文件：' + f);
      fs.rmSync(this.o.infoFile, { force: true });
      const log = fs.openSync(path.join(path.dirname(this.o.infoFile), 'embed-server.log'), 'a');
      const child = spawn(this.o.python, [this.o.server, '--model-dir', this.o.modelDir, '--info', this.o.infoFile, '--idle', String(this.o.idleSeconds), '--model-name', this.model],
        { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
      let exited = null; child.once('exit', code => { exited = code; }); child.unref();
      while (Date.now() < deadline) {
        const info = readInfo(this.o.infoFile);
        if (info && await this.health(info)) return (this.info = info);
        if (exited !== null) throw new Error(`嵌入服务启动失败（退出码 ${exited}），见 ${path.join(path.dirname(this.o.infoFile), 'embed-server.log')}`);
        await sleep(500);
      }
      throw new Error('嵌入服务启动超时');
    } finally { fs.rmSync(lock, { force: true }); }
  }
  // Raw float32 (little-endian, L2-normalised, full model width) for all texts: { n, dim, buffer }. Shared by memory2 and the literature library.
  async embedRaw(texts, { query = false } = {}) {
    if (!texts.length) return { n: 0, dim: 0, buffer: Buffer.alloc(0) };
    const parts = []; let dim = 0;
    for (let i = 0; i < texts.length; i += this.o.batchTexts) {
      const chunk = texts.slice(i, i + this.o.batchTexts);
      let res;
      for (let attempt = 0; ; attempt++) {
        const info = await this.ensureServer();
        try {
          res = await fetch(`http://127.0.0.1:${info.port}/embed`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts: chunk, query }), signal: AbortSignal.timeout(600000) });
          break;
        } catch (e) { this.info = null; if (attempt >= 1) throw e; } // server idled out between health check and call: restart once
      }
      const body = await res.json();
      if (!res.ok) throw new Error('嵌入服务错误：' + (body.error || res.status));
      const buf = Buffer.from(body.vectors, 'base64');
      if (buf.length !== body.n * body.dim * 4) throw new Error('嵌入向量大小与行数不符');
      if (dim && dim !== body.dim) throw new Error('嵌入维度在批次之间不一致');
      dim = body.dim; parts.push(buf);
    }
    return { n: texts.length, dim, buffer: Buffer.concat(parts) };
  }
  async embed(texts, { query = false } = {}) {
    const { n, dim, buffer } = await this.embedRaw(texts, { query });
    const out = [];
    for (let r = 0; r < n; r++) out.push(Array.from(new Float32Array(buffer.buffer.slice(buffer.byteOffset + r * dim * 4, buffer.byteOffset + (r + 1) * dim * 4))));
    return out;
  }
}
