// Drop-in for literature/embed_worker.py that uses the shared embedding service instead of loading its own copy of the model.
// Same contract: node embed-cli.mjs <model-or-dir> <in.jsonl> <out.f32> [--batch=N] [--query]
//   in.jsonl: one JSON string per line; out.f32: little-endian float32, rows x dim, L2-normalised (full 2560 dimensions);
//   last stdout line: JSON { n, dim, ... }. The memory system and the literature library therefore share ONE resident copy of
//   Qwen3-Embedding-4B (int8) on the GPU; loading it twice does not fit in 8 GB.
import fs from 'node:fs';
import { GpuEmbedder } from './embedder.mjs';

const [, , , src, dst, ...flags] = process.argv;
const texts = fs.readFileSync(src, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const t0 = Date.now();
const { n, dim, buffer } = await new GpuEmbedder().embedRaw(texts, { query: flags.includes('--query') });
fs.writeFileSync(dst, buffer);
console.log(JSON.stringify({ n, dim, encode_s: Math.round((Date.now() - t0) / 100) / 10, device: 'shared-embedding-service' }));
