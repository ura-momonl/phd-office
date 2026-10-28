import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { root, read } from '../automation/files.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';
import { normalizeDOI, record } from './run.mjs';
import { providerKey, fetchHosted } from './hosted.mjs';
import { pdfTextExecutable, pdfInfoExecutable } from './pdf-tools.mjs';
import { zoteroPDF } from './zotero.mjs';
import { FetchBackoff, retryAfterMs } from './fetch-backoff.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proxySuffix = '.ezproxy.library.wisc.edu';
const failure = (doi, status, message, error) => ({ doi, status, message,
  ...(error?.pdf_reason ? { pdf_reason: error.pdf_reason, ...(Number.isInteger(error.parser_exit_code) ? { parser_exit_code: error.parser_exit_code } : {}) } : {}) });
function rateLimit(doi, message, headers) {
  return { ...failure(doi, 'rate_limited', message), retry_after_ms: retryAfterMs(headers) };
}
const norm = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const surnames = names => [...new Set(names.map(name => norm(String(name).trim().split(/\s+/).at(-1))).filter(n => n.length >= 3))];
const sharedAuthors = (left, right) => {
  const expected = new Set(right.map(norm));
  return [...new Map(left.filter(name => norm(name).length >= 3 && expected.has(norm(name))).map(name => [norm(name), name])).values()];
};
const authorOnPage = (name, text) => {
  const normalized = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  // Ignore spacing, hyphenation and superscript affiliation numbers, but do not
  // match a short name inside a different author's longer name.
  const pattern = [...norm(name)].join('[\\s\\p{P}\\p{N}]*');
  return new RegExp('(?<![\\p{L}])' + pattern + '(?![\\p{L}])', 'u').test(normalized);
};
const arxivID = value => {
  const url = new URL(value);
  return ['arxiv.org', 'export.arxiv.org'].includes(url.hostname)
    ? url.pathname.match(/^\/(?:pdf|abs)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)(?:\.pdf)?$/i)?.[1] : null;
};
const xmlText = value => String(value || '').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi, s => {
  const named = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
  if (named[s.toLowerCase()]) return named[s.toLowerCase()];
  const n = s.toLowerCase().startsWith('&#x') ? parseInt(s.slice(3,-1),16) : Number(s.slice(2,-1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : s;
}).replace(/\s+/g,' ').trim();

// Official journal association + common authors binds the journal record to a
// possibly renamed preprint. The PDF itself must separately match ID/title/authors.
let manuscriptQueue = Promise.resolve();
async function manuscriptIdentity(pdfURL, doi, authors, backoff) {
  const requested = arxivID(pdfURL);
  if (!requested) return {};
  const metadataURL = 'https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(requested);
  // Share the existing arXiv pacing across concurrent articles, not per worker.
  const request = manuscriptQueue.then(async () => {
    if (backoff.remaining(metadataURL) > 0) return backoff.fetch(metadataURL);
    await new Promise(resolve => setTimeout(resolve, 3100));
    return backoff.fetch(metadataURL, { signal: AbortSignal.timeout(30000) });
  });
  manuscriptQueue = request.then(() => {}, () => {});
  const response = await request;
  if (response.status === 429) return { error: rateLimit(doi, 'arXiv metadata rate limit; no retry or alternate route', response.headers) };
  if ([401,403].includes(response.status)) return { error: failure(doi, 'access_denied', 'arXiv metadata access denied; no alternate route') };
  if (!response.ok) return { error: failure(doi, 'needs_attention', 'arXiv metadata returned HTTP ' + response.status + '; manuscript not verified') };
  const entries = [...(await response.text()).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)];
  if (entries.length !== 1) return { error: failure(doi, 'validation_failed', 'Expected one arXiv metadata entry') };
  const entry = entries[0][1];
  const tag = name => xmlText(entry.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>'))?.[1]);
  const id = arxivID(tag('id'));
  if (!id || (/v\d+$/.test(requested) ? id !== requested : id.replace(/v\d+$/, '') !== requested))
    return { error: failure(doi, 'validation_failed', 'arXiv metadata ID/version differs from requested PDF') };
  const linkedDOI = tag('arxiv:doi');
  if (!linkedDOI) return { error: failure(doi, 'needs_attention', 'arXiv has no explicit journal DOI; manual identity verification required') };
  if (normalizeDOI(linkedDOI) !== doi) return { error: failure(doi, 'validation_failed', 'arXiv journal DOI conflicts with requested DOI') };
  const names = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)]
    .map(m => xmlText(m[1].match(/<name\b[^>]*>([\s\S]*?)<\/name>/)?.[1])).filter(Boolean);
  const common = sharedAuthors(names, authors);
  if (!tag('title') || common.length < 2) return { error: failure(doi, 'validation_failed', 'arXiv and journal must share at least two distinct complete author names') };
  // Use the API's observed version-pinned PDF link, never an invented endpoint.
  const link = [...entry.matchAll(/<link\b[^>]*>/g)].find(m => /type=["']application\/pdf["']/.test(m[0]));
  const pinned = xmlText(link?.[0].match(/href=["']([^"']+)["']/)?.[1]);
  if (!pinned || arxivID(pinned) !== id)
    return { error: failure(doi, 'needs_attention', 'arXiv metadata has no matching versioned HTTPS PDF link') };
  return { pdf_url: pinned, identity: { kind: 'arxiv-manuscript', journal_doi: doi, arxiv_id: id,
    metadata_url: metadataURL, pdf_url: pinned, title: tag('title'), authors: names, matched_authors: common } };
}
function publicURL(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname)
      || !url.hostname.includes('.') || url.hostname.endsWith('.localhost'))
    throw new Error('Expected a public HTTPS article/PDF URL');
  return url;
}

// Original locations and hosted content are distinct; only hosted.mjs can spend free content credit.
async function openAccess(doi, backoff) {
  const url = new URL('https://api.openalex.org/works/https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/'));
  url.searchParams.set('select', 'id,doi,title,publication_year,authorships,open_access,best_oa_location,locations,has_content,content_urls');
  const key = providerKey('openalex');
  if (key) url.searchParams.set('api_key', key);
  const response = await backoff.fetch(url.href, { signal: AbortSignal.timeout(20000) });
  if (response.status === 429) return { error: rateLimit(doi, 'OpenAlex rate limit; stopped without retry or campus fallback', response.headers) };
  if (!response.ok) return { error: { ...failure(doi, 'needs_attention', 'OpenAlex lookup returned HTTP ' + response.status + '; access type unknown, campus not attempted'), ...(response.status === 404 ? { search_suggested: true } : {}) } };
  const work = await response.json();
  if (normalizeDOI(work.doi) !== doi) return { error: failure(doi, 'validation_failed', 'OpenAlex returned a different DOI; nothing downloaded') };
  const locations = [work.best_oa_location, ...(work.locations || [])].filter(l => l?.is_oa === true);
  // A direct PDF avoids page automation. Within that group prefer the published version.
  const score = l => (l.pdf_url ? 10 : 0) + ({ publishedVersion: 3, acceptedVersion: 2, submittedVersion: 1 }[l.version] || 0);
  locations.sort((a, b) => score(b) - score(a));
  const seen = new Set();
  const candidates = locations.filter(l => {
    try {
      const url = openURL(l.pdf_url || l.landing_page_url).href;
      if (seen.has(url)) return false;
      seen.add(url); return true;
    } catch { return false; }
  });
  if (!candidates.length && (work.open_access?.is_oa !== false || locations.length))
    return { work, locations: [], error: { ...failure(doi, 'needs_attention', 'No usable open fulltext URL; access not confirmed as closed, campus not attempted'), search_suggested: true } };
  return { work, locations: candidates };
}

function openURL(value, base) {
  const url = publicURL(value, base);
  if (url.hostname === 'content.openalex.org' || url.hostname === 'ezproxy.library.wisc.edu'
      || url.hostname.endsWith(proxySuffix) || url.hostname === 'login.wisc.edu' || url.hostname.endsWith('.duosecurity.com'))
    throw new Error('Open fulltext must not use a metered content service or campus authentication');
  url.hash = '';
  return url;
}

// Follow only observed HTTPS redirects; a refusal is terminal, not a reason to use UW.
async function downloadOpen(value, attempted, backoff) {
  let url = openURL(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (attempted.has(url.href)) return null;
    attempted.add(url.href);
    const response = await backoff.fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get('location');
    if (!next) throw new Error('Open PDF redirect has no target');
    url = openURL(next, url);
  }
  throw new Error('Too many open PDF redirects; stopped');
}

// Pure selection from observed page data, not a publisher/journal registry.
export function selectPDF(snapshot) {
  const base = publicURL(snapshot.url);
  const excluded = /supplement|supporting|peer.?review|correction|moesm|附件|补充/i;
  const links = snapshot.links.filter(l => !excluded.test(l.text + ' ' + l.href));
  const candidates = snapshot.pdfMeta.map(href => ({ href, rank: 3 }))
    .concat(links.filter(l => /\bpdf\b/i.test(l.text) || /\.pdf(?:[?#]|$)/i.test(l.href))
      .map(l => ({ href: l.href, rank: /download.*pdf|pdf.*download|full.?text.*pdf/i.test(l.text) ? 2 : 1 })));
  candidates.sort((a, b) => b.rank - a.rank);
  for (const candidate of candidates) {
    try {
      let url = publicURL(candidate.href, base);
      if (excluded.test(url.pathname)) continue;
      // Prefer an already-observed proxied anchor for the same metadata PDF.
      if (base.hostname.endsWith(proxySuffix) && !url.hostname.endsWith(proxySuffix)) {
        const matching = links.map(l => { try { return publicURL(l.href, base); } catch { return null; } })
          .find(u => u?.hostname.endsWith(proxySuffix) && u.pathname === url.pathname);
        if (matching) url = matching;
      }
      return url.href;
    } catch { /* Ignore non-public, malformed, and script links. */ }
  }
  return null;
}

// A later DOI must belong to a publication-information block, not merely to
// a cited reference. Every fallback also requires the expected title on page 1.
function publicationIdentity(file, doi, title, firstPage, sha256) {
  if (!title || norm(title).length < 20 || !norm(firstPage).includes(norm(title))) return null;
  const escaped = doi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const full = spawnSync(pdfTextExecutable(), [file, '-'], {
    encoding:'utf8', timeout:20000, maxBuffer:8*1024*1024, windowsHide:true
  });
  if (full.error || full.status !== 0) return null;
  const pages = full.stdout.split('\f').filter(p => p.trim());
  for (let i = Math.max(0, pages.length - 2); i < pages.length; i++) {
    const page = pages[i];
    const field = page.slice(0,3000).match(new RegExp('\\bDOI\\s*:\\s*' + escaped + '(?=$|[\\s,;])','i'));
    const ownHeader = field && norm(page).startsWith(norm(title)) && !/\breferences\b/i.test(page.slice(0,field.index));
    const publication = page.match(new RegExp('Published\\s+online\\s*:[\\s\\S]{0,180}?https?://(?:dx\\.)?doi\\.org/' + escaped + '(?=$|[\\s,;])','i'));
    const ownFooter = publication && !/\breferences\b/i.test(page.slice(0,publication.index));
    if (ownHeader || ownFooter) return {kind:'publisher-title-doi-block',journal_doi:doi,title,doi_page:i+1,
      rule:ownHeader?'first-page title and publication title/DOI header':'first-page title and Published online DOI block before references',verified_sha256:sha256};
  }
  const info = spawnSync(pdfInfoExecutable(), [file], {
    encoding:'utf8', timeout:20000, maxBuffer:1024*1024, windowsHide:true
  });
  if (info.error || info.status !== 0) return null;
  const metaTitle = info.stdout.match(/^Title:\s*(.*)$/m)?.[1];
  const subject = info.stdout.match(/^Subject:\s*(.*)$/m)?.[1] || '';
  const ids = subject.match(/10\.\d{4,9}\/[^\s,;]+/gi) || [];
  if (norm(metaTitle) === norm(title) && ids.length === 1 && ids[0].toLowerCase() === doi
      && new RegExp('\\bdoi\\s*:\\s*'+escaped+'(?=$|[\\s,;])','i').test(subject))
    return {kind:'pdf-title-doi-metadata',journal_doi:doi,title,
      rule:'first-page title, exact PDF Title and sole DOI-labelled PDF Subject identifier',verified_sha256:sha256};
  return null;
}

export function validatePDF(file, doi, expectedHash, identity, hostedTitle) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(-4096).includes(Buffer.from('%%EOF')))
    throw new Error('File is not a complete PDF');
  const sha256 = digest(bytes);
  if (expectedHash && expectedHash !== sha256) throw new Error('PDF hash differs from the registered file; original was not changed');
  const xref = bytes.subarray(-4096).toString('latin1').match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (xref && Number(xref[1]) >= bytes.length)
    throw Object.assign(new Error('PDF cross-reference offset is outside the file; source copy is incomplete or damaged'), { pdf_reason: 'pdf_structure_invalid' });
  // Read-only compatibility for existing, hash-bound records. Fresh downloads
  // cannot use the old surname-only evidence, and no catalog migration is needed.
  const legacy = expectedHash && identity?.kind === 'arxiv-manuscript' && !Object.hasOwn(identity, 'matched_authors');
  const common = sharedAuthors(identity?.authors || [], identity?.matched_authors || []);
  const oldSurnames = legacy ? surnames(identity.authors || []).filter(name => (identity.matched_surnames || []).includes(name)) : [];
  // A recorded visual identity decision applies only to that exact, unchanged
  // cached file. It never bypasses validation of a fresh automatic download.
  if (expectedHash && identity?.kind === 'arxiv-manuscript' && identity.journal_doi === doi
      && identity.verification === 'visual-first-page' && identity.verified_sha256 === sha256
      && identity.title && (legacy ? oldSurnames.length >= 2 : common.length >= 2)
      && arxivID(identity.pdf_url) === identity.arxiv_id)
    return { sha256, bytes: bytes.length, identity };
  const parsed = spawnSync(pdfTextExecutable(), ['-f', '1', '-l', '1', file, '-'], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  if (parsed.error || parsed.status !== 0) {
    const code = parsed.error?.code;
    const stderr = parsed.stderr || '';
    const [reason, message] = code === 'ENOENT' ? ['parser_unavailable', 'pdftotext executable was not found']
      : ['EACCES', 'EPERM'].includes(code) ? ['parser_permission_denied', 'pdftotext execution was denied by the host']
      : code === 'ETIMEDOUT' ? ['parser_timeout', 'pdftotext exceeded the PDF validation time limit']
      : code === 'ENOBUFS' ? ['parser_output_limit', 'pdftotext exceeded the PDF validation output limit']
      : /couldn.t find trailer dictionary|couldn.t read xref table|invalid xref|xref.*(?:invalid|damaged)/i.test(stderr)
        ? ['pdf_structure_invalid', 'PDF trailer/xref structure is invalid; file was not saved or registered']
      : /incorrect password|password required|copying of text.*not allowed/i.test(stderr)
        ? ['pdf_password_or_permissions', 'PDF text extraction requires a password or is restricted; no bypass attempted']
      : /permission denied|access is denied/i.test(stderr)
        ? ['parser_permission_denied', 'pdftotext could not access its input or host configuration']
      : ['pdf_parse_failed', 'pdftotext failed to parse this PDF'];
    // Deliberately exclude raw stderr, filenames, URLs and page text from the API.
    throw Object.assign(new Error(message), { pdf_reason: reason, parser_exit_code: parsed.status });
  }
  const text = parsed.stdout.replace(/\s+/g, '').toLowerCase();
  if (identity?.kind === 'arxiv-manuscript') {
    const ids = [...parsed.stdout.matchAll(/arxiv\s*:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)/gi)].map(m => m[1].toLowerCase());
    const words = new Set((parsed.stdout.match(/[\p{L}\p{M}]+(?:[-’'][\p{L}\p{M}]+)*/gu) || []).map(norm));
    if (identity.journal_doi !== doi || !identity.title || arxivID(identity.pdf_url) !== identity.arxiv_id
        || ids.some(id => id !== String(identity.arxiv_id).toLowerCase())
        || !norm(parsed.stdout).includes(norm(identity.title))
        || (legacy ? oldSurnames.filter(name => words.has(name)).length < 2 : common.filter(name => authorOnPage(name, parsed.stdout)).length < 2))
      throw new Error('arXiv PDF ID/version, title or authors differ from the verified journal association; nothing registered');
    return { sha256, bytes: bytes.length, identity };
  }
  if (text.includes(doi.replace(/\s+/g, '').toLowerCase())) return { sha256, bytes: bytes.length };
  // OpenAlex-hosted copies often omit the printed DOI. Accept them only on first-page title
  // plus the DOI's article locator (e.g. eaay8912, 045101); the rule is recorded in the identity.
  const title = ['hosted-title-locator','publisher-title-doi-block','pdf-title-doi-metadata'].includes(identity?.kind)
    && identity.journal_doi === doi ? identity.title : hostedTitle;
  const locator = norm(doi.split('/').pop().split(/[^A-Za-z0-9]+/).filter(Boolean).pop() || '');
  if (title && norm(title).length >= 20 && locator.length >= 5 && norm(parsed.stdout).includes(norm(title))
      && (parsed.stdout.match(/[\p{L}\p{N}]+/gu) || []).some(token => norm(token).endsWith(locator)))
    return { sha256, bytes: bytes.length, identity: { kind: 'hosted-title-locator', journal_doi: doi, title, locator,
      rule: 'first-page title and DOI article locator; full DOI not printed', verified_sha256: sha256 } };
  const publication = publicationIdentity(file, doi, title, parsed.stdout, sha256);
  if (publication) return {sha256,bytes:bytes.length,identity:publication};
  throw new Error('Requested DOI is not verified by a first-page identifier or title-bound publication DOI evidence; nothing registered');
}

/** One DOI: local cache, Zotero's already-saved PDF, original OA, then permitted hosted PDF. Never uses UW.
 * An explicit observed public PDF source uses the same identity/registration boundary, without other routes. */
export async function fetch_paper(value, { login = false, source, hostedOnly = false, zoteroOnly = false, spendPrepaid = false, launch = launchEdge, backoff = new FetchBackoff() } = {}) {
  let doi;
  try { doi = normalizeDOI(value); } catch { return failure(String(value ?? ''), 'invalid_doi', 'Provide a DOI or doi.org URL'); }
  if (login) return failure(doi, 'needs_attention', 'fetch --login is retired: use the official Zotero Connector for subscription articles; no UW request attempted');
  const previous = read('literature/catalog.json').papers.find(p => p.doi === doi);
  if (source !== undefined) {
    try { source = openURL(source).href; } catch { return failure(doi, 'failed', 'Source must be an observed public HTTPS PDF URL, not a campus or content API URL'); }
    if (!previous) return failure(doi, 'needs_attention', 'Register DOI metadata before supplying an open PDF source');
  }
  const output = path.join(root, 'literature/fulltext', 'doi-' + digest(doi).slice(0, 16) + '.pdf');
  const cached = previous?.fulltext_path && fs.existsSync(previous.fulltext_path) ? previous.fulltext_path
    : fs.existsSync(output) ? output : null;
  if (cached) {
    try {
      const checked = validatePDF(cached, doi, previous?.fulltext_sha256, previous?.fulltext_identity);
      if (!previous?.fulltext_path) record({ doi, fulltext_path: cached, fulltext_sha256: checked.sha256 });
      return { doi, status: 'available', path: cached, reused: true, ...checked };
    } catch (error) { return failure(doi, 'validation_failed', error.message, error); }
  }
  let zotero;
  if (source === undefined && !hostedOnly) {
    zotero = await zoteroPDF(doi, { acquire: true });
    if (zotero.status === 'available') {
      try {
        let identity;
        if (zotero.url && arxivID(zotero.url)) {
          const manuscript = await manuscriptIdentity(zotero.url, doi, previous?.authors?.length ? previous.authors : zotero.authors, backoff);
          if (manuscript.error) return manuscript.error;
          identity = manuscript.identity;
        }
        const checked = validatePDF(zotero.path, doi, undefined, identity, previous?.title || zotero.title);
        // Zotero is only the downloader: move the verified PDF into the office store so every PDF lives in literature/fulltext.
        fs.renameSync(zotero.path, output);
        const item = record({doi, title: previous?.title || zotero.title,
          ...(!previous?.authors?.length && zotero.authors.length ? {authors:zotero.authors} : {}),
          ...(!previous?.year && zotero.year ? {year:zotero.year} : {}),
          fulltext_path:output, fulltext_sha256:checked.sha256,
          fulltext_source:'zotero:' + zotero.key + '/' + zotero.attachment_key, fulltext_access:'zotero-local',
          fulltext_version:null, fulltext_license:null, fulltext_identity:identity || checked.identity || null,
          zotero_key:zotero.key, zotero_attachment_key:zotero.attachment_key});
        return {doi, status:'available', path:item.fulltext_path, reused:!zotero.native_acquired, access_route:'zotero-local',
          ...(zotero.native_acquired ? {native_acquired:true} : {}), ...checked};
      } catch (error) { return failure(doi, 'validation_failed', error.message, error); }
    }
  }
  const connectorNext = { next:'Save this article with the official Zotero Connector, then repeat literature fetch ' + doi + '; the mouse macro is never started automatically',
    ...(zotero ? {zotero_status:zotero.status, zotero_reason:zotero.reason,
      ...(zotero.native_reason ? {zotero_native_reason:zotero.native_reason} : {})} : {}) };
  if (zoteroOnly) return { ...failure(doi, 'needs_attention', 'No verified local Zotero PDF obtained; Zotero-only mode did not query OpenAlex or other download routes'), ...connectorNext };
  let browser, staged;
  let stage = 'resolve';
  try {
    let found;
    stage = 'oa_lookup';
    try {
      found = source ? { work: { title: previous.title, publication_year: previous.year,
        authorships: (previous.authors || []).map(display_name => ({ author: { display_name } })) },
        locations: [{ is_oa: true, pdf_url: source }] } : await openAccess(doi, backoff);
    } catch { found = { error: failure(doi, 'needs_attention', 'OpenAlex lookup failed; access unknown') }; }
    if (found.error?.status === 'validation_failed') return found.error;
    const work = found?.work;
    const attempted = new Set();
    let missing, stopped;
    // null is the single hosted fallback point. Missing sources may advance;
    // refusals/challenges stop originals and mirrors, not an independent hosted copy.
    // Unknown errors and failed identity checks still return immediately.
    // hostedOnly: skip original sites and campus entirely; only the OpenAlex hosted copy is tried.
    for (const oa of hostedOnly ? [null] : source ? found.locations : [...(found?.locations || []), null]) {
      if (stopped && oa) continue;
      let hosted;
      if (!oa) {
        stage = 'hosted';
        hosted = await fetchHosted(doi, work, { spendPrepaid, backoff });
        if (!hosted.response && hostedOnly) return { ...failure(doi, 'needs_attention', 'OpenAlex hosted PDF unavailable; hosted-only mode did not try other routes'), provider_notes: hosted.notes };
        if (!hosted.response && stopped) return { ...stopped, provider_notes: hosted.notes };
        if (!hosted.response && found.error) return { ...found.error, ...(found.error.search_suggested ? connectorNext : {}), provider_notes: hosted.notes };
        if (!hosted.response && (missing || found.locations?.length)) return {
          ...(missing || failure(doi, 'needs_attention', 'No untried open PDF source remains')),
          search_suggested: true, ...connectorNext, provider_notes: hosted.notes };
        if (!hosted.response) return { ...failure(doi, 'needs_attention', 'No local Zotero or open PDF found; save using the official Zotero Connector, then repeat the same fetch; UW fetch is disabled'),
          search_suggested: true, ...connectorNext, provider_notes: hosted.notes };
      }
      let snapshot, result, context, identity;
      if (hosted?.response) {
        result = hosted.response;
        snapshot = { title: hosted.title, authors: hosted.authors, year: hosted.year };
      } else if (oa?.pdf_url) {
        stage = 'manuscript_metadata';
        const manuscript = await manuscriptIdentity(oa.pdf_url, doi, previous?.authors?.length ? previous.authors : (work.authorships || []).map(a => a.author?.display_name).filter(Boolean), backoff);
        if (manuscript.error) return manuscript.error;
        identity = manuscript.identity;
        stage = 'download';
        result = await downloadOpen(manuscript.pdf_url || oa.pdf_url, attempted, backoff);
        if (!result) continue;
        snapshot = { title: work.title, authors: (work.authorships || []).map(a => a.author?.display_name).filter(Boolean), year: work.publication_year };
      } else {
        const article = openURL(oa.landing_page_url).href;
        stage = 'browser';
        if (attempted.has(article)) continue;
        attempted.add(article);
        if (backoff.remaining(article) > 0) {
          stopped = rateLimit(doi, 'Article host still within Retry-After; skipped without request or batch wait', { 'retry-after': String(backoff.remaining(article) / 1000) });
          continue;
        }
        browser ||= await launch({ headless: true });
        context = await browser.newContext();
        await context.route('**/*', route => {
          try { const url = openURL(route.request().url()); return backoff.remaining(url) > 0 ? route.abort() : route.continue(); } catch { return route.abort(); }
        });
        const page = await context.newPage();
        stage = 'page';
        const response = await page.goto(article, {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        if (response?.status() === 429) {
          backoff.observe(article, 429, response.headers?.());
          if (response.url?.()) backoff.observe(response.url(), 429, response.headers?.());
        }
        if ([401, 403, 429].includes(response?.status())) {
          const message = 'Article access returned HTTP ' + response.status() + '; original route stopped without retry';
          const error = response.status() === 429 ? rateLimit(doi, message, response.headers?.()) : failure(doi, 'access_denied', message);
          if (!source) { stopped = error; continue; }
          return error;
        }
        if ([404, 410].includes(response?.status())) {
          missing = failure(doi, 'not_found', 'Open article location is no longer available'); continue;
        }
        if (response && response.status() >= 400) return failure(doi, 'failed', 'Article access returned HTTP ' + response.status());
        openURL(page.url());
        stage = 'pdf_link';
        snapshot = await page.evaluate(() => {
          const metas = [...document.querySelectorAll('meta[name]')];
          const values = name => metas.filter(m => m.name.toLowerCase() === name).map(m => m.content).filter(Boolean);
          return { url: location.href, pdfMeta: values('citation_pdf_url'), title: values('citation_title')[0] || document.querySelector('h1')?.textContent?.trim(),
            challenged: /client challenge|verify (?:that )?you are human|captcha|just a moment|checking your browser/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 5000)),
            authors: values('citation_author'), year: Number(values('citation_publication_date')[0]?.slice(0, 4)) || null,
            links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.textContent.trim() })) };
        });
        if (snapshot.challenged) {
          const error = failure(doi, 'needs_attention', 'Article requires human verification; original route stopped without retry');
          if (!source) { stopped = error; continue; }
          return error;
        }
        let pdf = selectPDF(snapshot);
        if (!pdf) {
          missing = failure(doi, 'needs_attention', 'Page did not expose an identifiable main-article PDF link; no download attempted');
          continue;
        }
        stage = 'manuscript_metadata';
        const manuscript = await manuscriptIdentity(pdf, doi, previous?.authors?.length ? previous.authors : snapshot.authors, backoff);
        if (manuscript.error) return manuscript.error;
        identity = manuscript.identity;
        pdf = manuscript.pdf_url || pdf;
        stage = 'download';
        result = await downloadOpen(pdf, attempted, backoff);
        if (!result) continue;
      }
      const status = result.status;
      if ([401, 403, 429].includes(status)) {
        const message = 'PDF access returned HTTP ' + status + '; original route stopped without retry';
        const error = status === 429 ? rateLimit(doi, message, result.headers) : failure(doi, 'access_denied', message);
        if (oa && !source) { stopped = error; continue; }
        return error;
      }
      if (oa && [404, 410].includes(status)) {
        missing = failure(doi, 'not_found', 'Open PDF location is no longer available'); continue;
      }
      if (status < 200 || status >= 300) return failure(doi, 'failed', 'PDF download returned HTTP ' + status);
      if (identity && arxivID(result.url) !== identity.arxiv_id)
        return failure(doi, 'validation_failed', 'Downloaded arXiv URL differs from the verified pinned version');
      const bytes = Buffer.from(await result.arrayBuffer());
      if (bytes.subarray(0, 5).toString() !== '%PDF-') {
        const error = failure(doi, 'needs_attention', 'PDF link returned a web page, not a PDF; not saved or registered');
        if (oa && !source) { stopped = error; continue; }
        return error;
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      staged = output + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(staged, bytes, { flag: 'wx' });
      stage = 'validate';
      const checked = validatePDF(staged, doi, undefined, identity, previous?.title || snapshot.title);
      fs.copyFileSync(staged, output, fs.constants.COPYFILE_EXCL);
      stage = 'register';
      const sourceURL = new URL(hosted?.response ? hosted.source : result.url);
      const item = record({ doi, title: snapshot.title, ...(snapshot.authors.length ? { authors: snapshot.authors } : {}),
        ...(snapshot.year ? { year: snapshot.year } : {}), fulltext_path: output, fulltext_sha256: checked.sha256,
        fulltext_source: sourceURL.origin + sourceURL.pathname, fulltext_access: hosted?.response ? hosted.provider + '-hosted' : 'open-access', fulltext_identity: identity || checked.identity || null,
        ...(hosted?.response ? { fulltext_version: null, fulltext_license: null } : { fulltext_version: oa.version || null, fulltext_license: oa.license || null }) });
      return { doi, status: 'available', path: item.fulltext_path, reused: false, access_route: item.fulltext_access, ...checked, ...(hosted ? { provider_notes: hosted.notes } : {}) };
    }
    return missing || failure(doi, 'needs_attention', 'No untried open PDF source remains');
  } catch (error) {
    // Never expose Playwright navigation logs, URLs with auth tokens, or page text.
    return failure(doi, stage === 'validate' ? 'validation_failed' : 'failed',
      stage === 'validate' ? error.message : `Stopped at ${stage} (${error.name || 'Error'}); no automatic retry`, stage === 'validate' ? error : undefined);
  } finally {
    if (staged && fs.existsSync(staged)) fs.unlinkSync(staged);
    if (browser) await browser.close();
  }
}
