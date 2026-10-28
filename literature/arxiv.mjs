// arXiv 开放全文：单篇、直连 arxiv.org，无登录、无模型、不重试。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, read } from '../automation/files.mjs';
import { record } from './run.mjs';
import { validatePDF } from './fetch.mjs';

export const ARXIV_ID = /^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i;

export async function fetch_arxiv(value) {
  const m = String(value).trim().match(ARXIV_ID);
  const id = m[1], doi = '10.48550/arxiv.' + id;
  const output = path.join(root, 'literature/fulltext', `arxiv-${id}.pdf`);
  const previous = read('literature/catalog.json').papers.find(p => p.doi === doi);
  if (fs.existsSync(output) && previous?.fulltext_path) {
    return { doi, status: 'available', path: output, reused: true, ...validatePDF(output, 'arxiv:' + id, previous.fulltext_sha256) };
  }
  let staged;
  try {
    const meta = await (await fetch(`https://export.arxiv.org/api/query?id_list=${id}`, { signal: AbortSignal.timeout(30000) })).text();
    const entry = meta.match(/<entry>([\s\S]*?)<\/entry>/)?.[1] || '';
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim();
    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map(x => x[1]);
    const year = Number(entry.match(/<published>(\d{4})/)?.[1]) || null;
    const response = await fetch(`https://arxiv.org/pdf/${id}${m[2] || ''}`, { signal: AbortSignal.timeout(90000), redirect: 'follow' });
    if (!response.ok) return { doi, status: 'failed', message: 'arXiv PDF returned HTTP ' + response.status };
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(output), { recursive: true });
    staged = output + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(staged, bytes, { flag: 'wx' });
    let checked;
    try { checked = validatePDF(staged, 'arxiv:' + id); }
    catch (error) { return { doi, status: 'validation_failed', message: error.message }; }
    fs.copyFileSync(staged, output, fs.constants.COPYFILE_EXCL);
    const item = record({ doi, title, authors, year, fulltext_path: output, fulltext_sha256: checked.sha256,
      fulltext_source: 'https://arxiv.org/pdf/' + id, metadata_source: 'https://export.arxiv.org/api/query?id_list=' + id });
    return { doi, status: 'available', path: item.fulltext_path, reused: false, ...checked };
  } catch (error) {
    return { doi, status: 'failed', message: `arXiv fetch stopped (${error.name || 'Error'}); no automatic retry` };
  } finally {
    if (staged && fs.existsSync(staged)) fs.unlinkSync(staged);
  }
}
