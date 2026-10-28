// Abstract metadata only. Publisher/browser/preprint paths require an explicit shortlist.
import { launchEdge } from '../automation/browser-launch.mjs';
import { createLibraryContext } from './auth.mjs';
import fs from 'node:fs';

const UA = 'PhD-Workflows/0.1 (personal literature metadata; low volume)';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const doiOf = s => String(s || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase().trim();
const norm = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const decode = s => String(s || '').replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n, named) => {
  if (n) { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : m; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[named.toLowerCase()];
});
const clean = s => decode(String(s || '').replace(/<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>/g, ' ')).replace(/\s+/g, ' ').trim();
const challenged = text => /client challenge|verify (?:that )?you are human|captcha|just a moment|checking your browser/i.test(text);
function meta(html) {
  const values = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3])]));
    const key = (attrs.name || attrs.property || '').toLowerCase();
    if (key) values[key] = attrs.content || '';
  }
  return values;
}
const SPRINGER_KEY_FILE = new URL('../.runtime/literature/springer-api.credentials.local.json', import.meta.url);
const loadKey = name => { try { return JSON.parse(fs.readFileSync(SPRINGER_KEY_FILE, 'utf8'))[name] || ''; } catch { return ''; } };
const loadSpringerKey = () => loadKey('springer_meta'), loadS2Key = () => loadKey('semantic_scholar');
const invert = ix => { const words = []; for (const [w, positions] of Object.entries(ix || {})) for (const i of positions) words[i] = w; return words.join(' '); };

/** Mutates only the supplied items, never catalogs/files. No retries, passwords, or PDF requests.
 * Default: OpenAlex, Semantic Scholar, then Springer Nature Meta API (10.1038/ only, when a key file exists). selected:true enables APS and title-matched arXiv.
 * browser:true additionally permits one shared normal Edge session for selected Nature pages.
 */
export async function enrichAbstracts(items, { selected = false, browser = false, fetchImpl = globalThis.fetch,
  pause = delay, launch = launchEdge, createContext = createLibraryContext, springerKey = loadSpringerKey(), s2Key = loadS2Key() } = {}) {
  if (browser && !selected) throw new Error('Browser abstract lookup requires an explicit selected shortlist');
  const stats = { already: 0, openalex: 0, semantic_scholar: 0, springer: 0, aps: 0, nature: 0, arxiv: 0, missing: 0, s2_stopped: false, attempts: [] };
  const stopped = new Set();
  let edge, context, browserFailed = false;
  const attempt = (p, source, status) => stats.attempts.push({ doi: p.doi, source, status });
  const request = async (p, source, url, options = {}) => {
    await pause(source === 'arxiv' ? 3100 : 1100);
    const headers = source === 'semantic_scholar' && s2Key ? { 'User-Agent': UA, 'x-api-key': s2Key } : { 'User-Agent': UA };
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000), ...options });
    if (!r.ok && !(options.redirect === 'manual' && r.status >= 300 && r.status < 400)) {
      attempt(p, source, 'http_' + r.status);
      if ([401, 403, 429].includes(r.status)) stopped.add(source);
      if (source === 'semantic_scholar' && r.status === 429) stats.s2_stopped = true;
      return null;
    }
    return r;
  };
  const accept = (p, source, abstract, url, extra = {}) => {
    const a = clean(abstract);
    if (!a) { attempt(p, source, 'no_abstract'); return false; }
    // Index-derived abstracts are sometimes only a trailing fragment (starts mid-sentence); keep looking elsewhere.
    if (/^[a-z]{3,}(?![a-z-])/.test(a) && !/^(?:van der|ab initio|de |von |et al)/.test(a)) { attempt(p, source, 'fragment'); return false; }
    p.abstract = a; p.abstract_from = source; p.abstract_url = url;
    Object.assign(p, extra); stats[source]++; attempt(p, source, 'available'); return true;
  };
  try {
    for (const p of items) {
      if (p.abstract?.trim()) { stats.already++; continue; }
      const doi = doiOf(p.doi);
      for (const source of ['openalex', 'semantic_scholar']) {
        if (stopped.has(source)) continue;
        try {
          const url = source === 'openalex'
            ? `https://api.openalex.org/works/https://doi.org/${doi}?select=doi,abstract_inverted_index`
            : `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=abstract,externalIds`;
          const r = await request(p, source, url); if (!r) continue;
          const j = await r.json();
          const foundDOI = source === 'openalex' ? j.doi : j.externalIds?.DOI;
          if (doiOf(foundDOI) !== doi) { attempt(p, source, 'identity_mismatch'); continue; }
          if (accept(p, source, source === 'openalex' ? invert(j.abstract_inverted_index) : j.abstract, url)) break;
        } catch { attempt(p, source, 'request_failed'); }
      }
      if (springerKey && !p.abstract && /^10\.1038\//.test(doi) && !stopped.has('springer')) {
        try { // official Springer Nature Meta API (free key); the key is never stored in abstract_url
          const base = 'https://api.springernature.com/meta/v2/json?q=doi:' + encodeURIComponent(doi);
          const r = await request(p, 'springer', base + '&api_key=' + encodeURIComponent(springerKey));
          if (r) {
            const rec = (await r.json()).records?.find(x => doiOf(x.doi) === doi);
            if (!rec) attempt(p, 'springer', 'identity_mismatch');
            else accept(p, 'springer', rec.abstract, base);
          }
        } catch { attempt(p, 'springer', 'request_failed'); }
      }
      if (selected && !p.abstract && doi.startsWith('10.1103/') && !stopped.has('aps')) {
        try {
          const resolver = await request(p, 'aps', 'https://doi.org/' + doi, { redirect: 'manual' });
          if (resolver) {
            const location = resolver.headers.get('location');
            if (!location || resolver.status < 300 || resolver.status >= 400) attempt(p, 'aps', 'resolver_did_not_redirect');
            else {
              const url = new URL(location);
              if (url.protocol !== 'https:' || !['journals.aps.org', 'link.aps.org'].includes(url.hostname)) attempt(p, 'aps', 'unexpected_publisher');
              else {
                const r = await request(p, 'aps', url.href);
                if (r) {
                  const html = await r.text(), m = meta(html);
                  if (challenged(clean(html.slice(0, 3000)))) { attempt(p, 'aps', 'challenge'); stopped.add('aps'); }
                  else if (r.url && !['journals.aps.org', 'link.aps.org'].includes(new URL(r.url).hostname)) attempt(p, 'aps', 'unexpected_publisher');
                  else {
                    // Accepted-paper pages carry no citation meta; identity then rests on the DOI in the final URL path.
                    const finalUrl = r.url || url.href;
                    const sameDOI = m.citation_doi ? doiOf(m.citation_doi) === doi : doiOf(decodeURIComponent(new URL(finalUrl).pathname).split(/\/(?=10\.\d{4,9}\/)/).pop()) === doi;
                    if (!sameDOI) attempt(p, 'aps', 'identity_mismatch');
                    else accept(p, 'aps', m.citation_abstract || m['dc.description'] || m.description
                      || html.match(/id="abstract-section-content"[^>]*>([\s\S]*?)<\/section>/)?.[1], finalUrl);
                  }
                }
              }
            }
          }
        } catch { attempt(p, 'aps', 'request_failed'); }
      }
      if (selected && browser && !p.abstract && /^10\.1038\/s\d{5}-[\w-]+$/i.test(doi) && !browserFailed) {
        let page;
        try {
          if (!edge) { edge = await launch({ headless: true }); context = await createContext(edge); }
          await pause(1100); page = await context.newPage();
          const url = 'https://www.nature.com/articles/' + doi.split('/')[1];
          const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const data = await page.evaluate(() => ({
            doi: document.querySelector('meta[name="citation_doi"]')?.content || '',
            title: document.title, body: document.body.innerText.slice(0, 1000),
            abstract: document.querySelector('#Abs1-content, [data-title="Abstract"] .c-article-section__content')?.innerText || ''
          }));
          if (challenged(data.title + ' ' + data.body)) { attempt(p, 'nature', 'challenge'); browserFailed = true; }
          else if (r && !r.ok()) { attempt(p, 'nature', 'http_' + r.status()); browserFailed = true; }
          else if (doiOf(data.doi) !== doi) attempt(p, 'nature', 'identity_mismatch');
          else accept(p, 'nature', data.abstract, url);
        } catch { attempt(p, 'nature', 'request_failed'); browserFailed = true; }
        finally { await page?.close().catch(() => {}); }
      }
      if (selected && !p.abstract && p.title && !stopped.has('arxiv')) {
        try {
          const url = new URL('https://export.arxiv.org/api/query');
          url.searchParams.set('search_query', 'ti:"' + p.title.replace(/["\\]/g, ' ') + '"');
          url.searchParams.set('max_results', '5');
          const r = await request(p, 'arxiv', url.href);
          if (r) {
            const xml = await r.text(); let match = null;
            for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
              const tag = name => clean(entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1]);
              const linkedDOI = doiOf(tag('arxiv:doi'));
              const names = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map(m => norm(clean(m[1]).split(/\s+/).at(-1)));
              const expectedNames = (Array.isArray(p.authors) ? p.authors : String(p.authors || '').split(',')).map(s => norm(s.trim().split(/\s+/).at(-1))).filter(Boolean);
              const byDOI = linkedDOI && linkedDOI === doi;
              const byTitle = !linkedDOI && norm(tag('title')) === norm(p.title) && expectedNames.some(n => names.includes(n));
              if (!byDOI && !byTitle) continue;
              const id = tag('id').match(/^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)$/i)?.[1];
              if (id) { match = { abstract: tag('summary'), url: 'https://arxiv.org/abs/' + id, matchedBy: byDOI ? 'doi' : 'title_and_author' }; break; }
            }
            if (match) accept(p, 'arxiv', match.abstract, match.url, { preprint_url: match.url, abstract_version: 'preprint', preprint_match: match.matchedBy });
            else attempt(p, 'arxiv', 'no_verified_match');
          }
        } catch { attempt(p, 'arxiv', 'request_failed'); }
      }
      if (!p.abstract) stats.missing++;
    }
  } finally { await edge?.close(); }
  return stats;
}
