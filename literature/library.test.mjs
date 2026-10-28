import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root } from '../automation/files.mjs';
import { pdfTextExecutable } from './pdf-tools.mjs';
import { chunkItems, looksLikeRefs, ingest, mineruItems, mineruErrors, open, search } from './library.mjs';
// 全部是虚构的文字，只验证“参考文献块”和“页眉章节”的判定逻辑，不读取任何真实库文件。
const para = (p, text, label = 'text') => ({ p, label, text });
const head = (p, text) => ({ p, label: 'section_header', text });

test('MinerU 内容适配保留公式、表格、图注和原 PDF 页码（不运行模型）', () => {
  const python = process.env.GPU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const run = spawnSync(python, ['-B', fileURLToPath(new URL('./mineru_worker_test.py', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, String(run.error || run.stderr || run.stdout));
  assert.match(run.stderr, /Ran 3 tests/);
  const chunks = chunkItems([head(4, 'Energy'), para(4, '$$E=mc^2$$', 'equation'), head(5, 'Table'), para(5, '<table>4 K</table>', 'table')]);
  assert.equal(chunks.length, 2, '短公式、短表格不能被 40 字门槛丢掉');
  assert.equal(chunks[0].page, 4);
  assert.match(chunks[0].text, /E=mc\^2/);
  assert.match(chunks[1].text, /<table>/);
});

test('入库只认 MinerU 缓存；增量跳过旧索引，失败不回退且保留原块', t => {
  assert.equal(process.env.PHD_ISOLATED_TESTS, '1', '只在脱敏副本中运行');
  const catalogFile = path.join(root, 'literature/catalog.json');
  const before = fs.readFileSync(catalogFile);
  const dir = path.join(root, '.runtime/literature');
  const cacheDir = path.join(dir, 'mineru-items');
  const legacyDir = path.join(dir, 'docling-items');
  const id = 'mineru-fixture-only', doi = '10.0000/mineru-fixture-only';
  const file = path.join(dir, id + '.pdf');
  const cacheFile = path.join(cacheDir, id + '.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(file, 'Synthetic PDF placeholder; cached result only, no parser or model runs.');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const items = [head(7, 'Fictional result'), para(7, 'MineruBoundaryMarker: a fictional layered sample demonstrates a measured response at four kelvin. '), para(7, '$$E=mc^2$$', 'equation')];
  fs.writeFileSync(cacheFile, JSON.stringify({ sha, items }));
  fs.writeFileSync(path.join(legacyDir, id + '.json'), JSON.stringify({ sha, items: [para(1, 'Wrong legacy parser output'.repeat(5))] }));
  t.after(() => {
    fs.writeFileSync(catalogFile, before);
    const db = open();
    try { db.prepare('delete from chunks_fts where rowid in (select id from chunks where paper_id=?)').run(id); db.prepare('delete from papers where id=?').run(id); } finally { db.close(); }
    for (const f of [file, cacheFile, path.join(legacyDir, id + '.json')]) fs.rmSync(f, { force: true });
  });
  fs.writeFileSync(catalogFile, JSON.stringify({ papers: [{ id, doi, title: 'Fictional MinerU test', date: '2026-01-01', source: 'fixture', fulltext_path: file }] }));
  const first = ingest();
  assert.equal(first.added, 1);
  assert.equal(first.mineru, 1);
  assert.deepEqual(first.mineru_errors, []);
  assert.equal(search('MineruBoundaryMarker')[0].page, 7);
  assert.equal(search('legacy').length, 0);
  fs.rmSync(cacheFile);
  const again = ingest();
  assert.equal(again.skipped, 1, '未变 PDF 不触发重解析，即使没有 MinerU 缓存');
  assert.deepEqual(again.mineru_errors, []);
  const forced = ingest({ force: true });
  assert.equal(forced.added, 0);
  assert.equal(forced.failed.length, 1);
  assert.match(forced.failed[0].error, /MinerU/);
  assert.ok(!('pdftotext_fallback' in forced));
  assert.equal(search('MineruBoundaryMarker')[0].page, 7, '失败不得删掉已有块');
  fs.writeFileSync(cacheFile, JSON.stringify({ sha: 'different-pdf', items }));
  assert.equal(mineruItems([{ id, file, sha }]).get(id), null, '缓存哈希不符不得复用');
  assert.equal(mineruErrors.length, 1);
});

test('PDF parser resolution: explicit executable, portable Windows bundle, then existing PATH', t => {
  const old=process.env.PDFTOTEXT;
  t.after(()=>{if(old===undefined)delete process.env.PDFTOTEXT;else process.env.PDFTOTEXT=old;});
  process.env.PDFTOTEXT=path.join(root,'a directory with spaces','pdftotext.exe');
  assert.equal(pdfTextExecutable(),process.env.PDFTOTEXT);
  delete process.env.PDFTOTEXT;
  const exists=t.mock.method(fs,'existsSync',()=>true);
  assert.equal(pdfTextExecutable(),process.platform==='win32' ? path.join(root,'.runtime/tools/poppler/Library/bin/pdftotext.exe') : 'pdftotext');
  exists.mock.mockImplementation(()=>false);
  assert.equal(pdfTextExecutable(),'pdftotext');
});

test('GPU 部署守卫：拒绝 CPU 权重、缺 CUDA 与无声回退（假对象，不运行模型）', () => {
  const python = process.env.GPU_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const run = spawnSync(python, ['-B', fileURLToPath(new URL('./gpu_runtime_test.py', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, String(run.error || run.stderr || run.stdout));
  assert.match(run.stderr, /Ran 6 tests/);
});
const prose = i => `We measure the response of device ${i} at several temperatures and find that the signal saturates above a critical gate voltage, which we attribute to screening by the substrate and to the finite carrier density in the channel. `.repeat(4);
const refs = (i, n = 8) => Array.from({ length: n }, (_, k) => `Author${i}${k}, A. B. et al. Fictional study of layered devices. Nature ${500 + k}, ${10 + k}–${20 + k} (20${10 + k % 9}).`).join(' ');

test('Nature 式论文：无 References 标题、页眉 Article 重复、参考文献后还有 Methods 与图注 -> 参考文献块仍被识别', () => {
  const items = [head(1, 'A fictional title about layered devices'), para(1, prose(1)), head(1, 'Article'), para(2, prose(2)), head(2, 'Article'), para(3, prose(3)), head(3, 'Article'),
    para(4, prose(4)), head(4, 'Article'), para(5, refs(1)), para(5, refs(2)), head(5, 'Article'), para(6, refs(3)), para(6, refs(4)),
    head(7, 'Methods'), para(7, prose(5)), head(7, 'Data availability'), para(7, 'Data are available from the corresponding author on reasonable request. '.repeat(3)),
    head(8, 'Extended Data Fig. 1'), para(8, 'Extended Data Fig. 1 | Schematic of the fictional device and the optical set-up used in the measurements described above. '.repeat(2))];
  const c = chunkItems(items);
  const kinds = c.map(x => x.kind);
  assert.ok(kinds.filter(k => k === 'refs').length >= 2, '参考文献块应被识别：' + kinds.join(','));
  for (const x of c) {
    if (/Author\d\d, A\. B\. et al\./.test(x.text)) assert.equal(x.kind, 'refs', '参考文献内容应为 refs');
    if (/response of device|Data are available|Extended Data Fig\. 1 \|/.test(x.text) && !/Author\d\d, A\. B\./.test(x.text)) assert.equal(x.kind, 'body', '正文、Methods、数据可用性、图注应保持 body：' + x.text.slice(0, 40));
  }
  assert.ok(!c.some(x => /^Article\. /.test(x.text)), '重复出现的页眉不应作为章节名前缀');
});

test('标题带冒号或 and Notes 也算参考文献；孤立的像引用的正文块不误判', () => {
  const items = [head(1, 'A fictional title'), para(1, prose(1)), para(2, prose(2)), para(3, prose(3)), para(4, prose(4)),
    para(5, 'Compared with earlier work (2011, 2012, 2013, 2014, 2015) the gap is larger. '.repeat(12)), para(5, prose(5)),
    head(6, 'References:'), para(6, refs(1, 6)), para(6, refs(2, 6))];
  const c = chunkItems(items);
  assert.ok(c.filter(x => x.kind === 'refs').every(x => /Author\d/.test(x.text)));
  assert.ok(c.some(x => x.kind === 'refs'));
  const lone = c.find(x => /Compared with earlier work/.test(x.text));
  assert.equal(lone.kind, 'body', '孤立的年份密集正文块应保持 body');
  const c2 = chunkItems([head(1, 'A title'), para(1, prose(1)), para(2, prose(2)), para(3, prose(3)), head(4, 'REFERENCES AND NOTES'), para(4, refs(1, 5))]);
  assert.equal(c2.at(-1).kind, 'refs');
});

test('looksLikeRefs 认得 Nature 式页码范围引用', () => {
  assert.ok(looksLikeRefs(refs(1, 4)));
  assert.ok(!looksLikeRefs(prose(1)));
});

test('前 30% 内的参考文献（短正文后接长 SI）有标题才认；方法部分的参考文献标题也认', () => {
  const items = [head(1, 'A fictional title'), para(1, prose(1)), para(1, prose(2)), head(2, 'References:'), para(2, refs(1, 6)), para(2, refs(2, 6)),
    head(3, 'Supplementary text'), ...Array.from({ length: 12 }, (_, k) => para(3 + k, prose(10 + k))), head(16, 'Methods References:'), para(16, refs(3, 6)), para(16, refs(4, 6))];
  const c = chunkItems(items);
  const early = c.slice(0, Math.floor(c.length * 0.3));
  assert.ok(early.some(x => x.kind === 'refs'), '前 30% 内带标题的参考文献应被识别');
  assert.equal(c.at(-1).kind, 'refs', 'Methods References 应被识别');
  assert.ok(c.filter(x => /response of device/.test(x.text)).every(x => x.kind === 'body'));
  // 前 30% 内没有标题的单块像引用的内容不算（如作者单位、致谢）
  const c2 = chunkItems([head(1, 'A title'), para(1, refs(5, 8)), para(2, prose(1)), para(3, prose(2)), para(4, prose(3)), para(5, prose(4)), para(6, prose(5))]);
  assert.equal(c2[0].kind, 'body');
});

test('JSTOR 版 PDF：去掉封面和第 2 页开头夹带的前一篇文章，保留本文题名之后的内容', async () => {
  const { trimJstorCover } = await import('./library.mjs');
  const title = 'A fictional measurement of something in layered crystals';
  const items = [para(1, title), para(1, 'Stable URL: https://www.jstor.org/stable/10.2307/0000000'), para(1, 'JSTOR is a not-for-profit service'),
    para(2, 'A. Other, Phys. Rev. 1, 2-3 (1966).'), para(2, 'ACKNOWLEDGMENTS. Thanks from the previous article.'), para(2, title + '. Abstract text begins here.'), para(2, prose(1))];
  const t = trimJstorCover(items, title);
  assert.equal(t.length, 2);
  assert.ok(t[0].text.startsWith(title));
  // 找不到题名时只丢封面页；非 JSTOR 文件原样返回
  assert.equal(trimJstorCover(items, 'Unrelated title that never appears in the text').length, 4);
  const plain = [para(1, title), para(1, prose(1))];
  assert.equal(trimJstorCover(plain, title), plain);
});
