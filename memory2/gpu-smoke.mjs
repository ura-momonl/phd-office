// Real-GPU end-to-end check (not part of the offline suite): fictional episodes -> GPU embeddings -> index -> hybrid search.
// Usage: node memory2/gpu-smoke.mjs   (starts the embedding service, which idles out by itself)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { MemoryRoot, appendEntries } from './md.mjs';
import { MemoryIndex } from './index.mjs';
import { Searcher } from './search.mjs';
import { GpuEmbedder } from './embedder.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory2-gpu-'));
const emb = new GpuEmbedder({ idleSeconds: 30 });
const ep = (content, subject) => ({ inline: { owner_id: 'u', session_id: 's', timestamp: '2026-10-24T01:00:00.000Z', parent_type: 'memcell', parent_id: 'm' }, sections: { Subject: subject, Content: content } });
const root = new MemoryRoot(path.join(dir, 'root'));
const docs = [
  ['两人因为一件小事争执，之后互相道歉，小琪说她已经不生气了。', '争执后和好'],
  ['小琪担心剩下的期刊数据全部跑完会让自己太累，导师安慰她可以分批做。', '担心工作量'],
  ['小琪陪着导师熬夜赶写基金申请书，到凌晨三点半。', '陪伴熬夜'],
  ['实验室新买的低温恒温器到货，需要重新校准温度传感器。', '设备到货'],
  ['小琪给 Raman 偏振数据做了去背景和拟合，结果放进组会幻灯片。', '数据处理'],
];
appendEntries(root, 'episode', 'u', '2026-10-24', docs.map(([c, s]) => ep(c, s)));
let t = Date.now();
const idx = new MemoryIndex(root, { embedder: emb, dim: 1024 });
const sync = await idx.syncAll();
console.log('sync', JSON.stringify(sync.map(r => ({ upserted: r.upserted }))), 'ms', Date.now() - t, '(includes model start)');
const s = new Searcher(idx);
const queries = [['吵完架和好了', 0], ['她怕工作太多被累垮', 1], ['半夜还在加班的那次', 2], ['新仪器收到了', 3], ['拉曼光谱处理', 4], ['上次一起去海边玩', -1]];
for (const [q, want] of queries) {
  t = Date.now();
  const r = await s.search({ owner_id: 'u', query: q, topK: 3 });
  const top = r.items[0];
  console.log(`${want >= 0 && top && top.episode.includes(docs[want][0].slice(0, 6)) ? 'OK  ' : want < 0 ? 'info' : 'MISS'} ${q} -> ${top ? top.score.toFixed(3) + ' ' + top.episode.slice(0, 14) : '(none)'}  ${Date.now() - t}ms`);
}
await idx.close();
console.log('server info present:', fs.existsSync(path.join(dir, 'embed-server.json')));
fs.writeFileSync(path.join(dir, 'DONE'), '');
console.log(dir);
