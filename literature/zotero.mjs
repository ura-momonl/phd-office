// Read native local files; optional first acquisition belongs to the installed
// Zotero plugin/native resolver, never our UW route or a mouse macro.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { read } from '../automation/files.mjs';
import { normalizeDOI } from './run.mjs';

// The installed native plugin accepts one acquisition at a time. Queue before
// entering it so concurrent article fetches do not skip Zotero on HTTP 409.
let acquisitionQueue = Promise.resolve();
export function zoteroPDF(doi, options = {}) {
  if (!options.acquire) return readZoteroPDF(doi, options);
  const result = acquisitionQueue.then(() => readZoteroPDF(doi, options));
  acquisitionQueue = result.then(() => {}, () => {});
  return result;
}

async function readZoteroPDF(doi, { acquire = false } = {}) {
  let base;
  try {
    base = new URL(read('literature/config.json').zotero_local);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
        || base.username || base.password || base.pathname !== '/api/' || base.search || base.hash)
      return { status: 'unavailable', reason: 'local_api_only' };
  } catch { return { status: 'unavailable', reason: 'invalid_configuration' }; }
  const json = async relative => {
    const r = await fetch(new URL(relative, base), { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(r.status === 403 ? 'api_disabled' : 'api_unavailable');
    const body = await r.json();
    if (!Array.isArray(body)) throw new Error('invalid_response');
    return body;
  };
  try {
    // qmode=everything includes DOI; exact identity is checked again, never fuzzy title matching.
    const query = new URLSearchParams({q: doi, qmode: 'everything', itemType: '-attachment', limit: '100'});
    const items = await json('users/0/items?' + query);
    const matches = items.filter(item => {
      if (!/^[A-Z0-9]{8}$/.test(item?.key || '') || item.data?.deleted || item.data?.itemType === 'attachment') return false;
      try { return normalizeDOI(item.data?.DOI) === doi; } catch { return false; }
    });
    let missingFile = false;
    for (const item of matches) {
      const attachments = await json('users/0/items/' + item.key + '/children?limit=100');
      for (const attachment of attachments) {
        const data = attachment?.data;
        if (!/^[A-Z0-9]{8}$/.test(attachment?.key || '') || data?.parentItem !== item.key || data.deleted
            || data.itemType !== 'attachment' || data.contentType !== 'application/pdf' || data.linkMode === 'linked_url') continue;
        const r = await fetch(new URL('users/0/items/' + attachment.key + '/file', base), {
          redirect: 'manual', signal: AbortSignal.timeout(2000)
        });
        if (r.status !== 302) { missingFile = true; continue; }
        const location = new URL(r.headers.get('location'));
        if (location.protocol !== 'file:' || (location.hostname && location.hostname !== 'localhost'))
          return { status: 'unavailable', reason: 'nonlocal_attachment' };
        const file = fileURLToPath(location);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { missingFile = true; continue; }
        return { status: 'available', path: file, key: item.key, attachment_key: attachment.key,
          title: item.data.title, year: Number(String(item.meta?.parsedDate || item.data.date || '').match(/\b\d{4}\b/)?.[0]) || null,
          authors: (item.data.creators || []).filter(c => c.creatorType === 'author')
            .map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean),
          url: data.url || null };
      }
    }
    const missing = { status: 'missing', reason: missingFile ? 'attachment_not_local' : matches.length ? 'no_pdf_attachment' : 'item_not_found' };
    if (!acquire || read('literature/config.json').zotero_native !== true) return missing;
    // Never implicitly redownload cloud-only attachments. A normal DOI without
    // a PDF may use the explicitly installed, narrowly scoped native operation.
    if (missingFile) return missing;
    let native;
    try {
      const response = await fetch(new URL('/office/fetch', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { 'Content-Type': 'application/json', 'X-Office-Fetch': '1' }, body: JSON.stringify({ doi })
      });
      if (!response.ok) return { ...missing, native_reason: response.status === 404 ? 'plugin_not_installed'
        : response.status === 409 ? 'busy' : response.status === 403 ? 'denied' : 'native_failed' };
      native = await response.json();
    } catch { return { ...missing, native_reason: 'native_unavailable' }; }
    if (native.doi !== doi || native.status !== 'saved')
      return { ...missing, native_reason: ['no_file_found','metadata_not_found'].includes(native.status) ? native.status : 'invalid_native_response' };
    // Treat the native response as a notification, not a trusted file path.
    // Re-read exact DOI/PDF/local-file state through the ordinary read boundary.
    const result = await zoteroPDF(doi);
    return { ...result, native_acquired: result.status === 'available' };
  } catch (error) {
    const known = ['api_disabled', 'api_unavailable', 'invalid_response'];
    return { status: 'unavailable', reason: known.includes(error.message) ? error.message : 'not_connected' };
  }
}

// One explicit metadata-only native request. Batch callers own pacing/checkpoints
// and stop on source/access errors; this function never retries or calls fetch_paper.
export async function zoteroMetadata(value) {
  const doi = normalizeDOI(value);
  let base;
  try {
    base = new URL(read('literature/config.json').zotero_local);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
        || base.username || base.password || base.pathname !== '/api/' || base.search || base.hash)
      return { status: 'unavailable', doi, reason: 'local_api_only' };
  } catch { return { status: 'unavailable', doi, reason: 'invalid_configuration' }; }
  try {
    const response = await fetch(new URL('/office/metadata', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'X-Office-Fetch': '1' }, body: JSON.stringify({ doi })
    });
    if (!response.ok) return { status: 'unavailable', doi,
      reason: response.status === 404 ? 'metadata_plugin_not_installed'
        : response.status === 409 ? 'busy' : response.status === 403 ? 'denied' : 'native_failed' };
    const result = await response.json();
    if (result.doi !== doi || result.library_writes !== 0 || result.attachment_downloads !== 0)
      return { status: 'unavailable', doi, reason: 'invalid_native_response' };
    if (result.status === 'available' && (!result.title || !result.abstract?.trim()
        || result.abstract_section !== 'Abstract' || result.abstract_from !== 'zotero-native-web'))
      return { status: 'unavailable', doi, reason: 'invalid_native_response' };
    return result;
  } catch { return { status: 'unavailable', doi, reason: 'native_unavailable' }; }
}
