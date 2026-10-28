// OpenAlex-hosted PDFs only. No publisher scraping, paid balance, retries or writers of the catalog.
// CORE was removed 2026-10-19: its PDF links (core.ac.uk/download, also behind the API download endpoints) answer programmatic requests with a Cloudflare challenge.
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../automation/files.mjs';

export function providerKey(name) {
  const file = path.join(root, `.runtime/literature/${name}.credentials.local.json`);
  return process.env[name.toUpperCase() + '_API_KEY'] || (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).api_key : '') || '';
}
const note = (provider, status) => ({ provider, status });
// Credentials go only to the initial content endpoint, never to a redirected storage URL.
async function hostedDownload(source, key, backoff) {
  let url = new URL(source);
  for (let n = 0; n <= 5; n++) {
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Hosted PDF left the permitted download service');
    const options = { headers: n === 0 && key ? { Authorization: 'Bearer ' + key } : {}, redirect: 'manual', signal: AbortSignal.timeout(60000) };
    const r = await (backoff ? backoff.fetch(url, options) : fetch(url, options));
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    if (!r.headers.get('location')) throw new Error('Missing storage redirect');
    const next = new URL(r.headers.get('location'), url);
    // OpenAlex may redirect to signed object storage, but not back to a billable endpoint.
    if ((next.hostname === 'content.openalex.org' || /(?:^|\.)(?:localhost|wisc\.edu|duosecurity\.com)$/.test(next.hostname)
        || !next.hostname.includes('.') || /^(?:\d+\.){3}\d+$/.test(next.hostname) || next.hostname.includes(':')))
      throw new Error('Unexpected content redirect');
    url = next;
  }
  throw new Error('Too many storage redirects');
}

// spendPrepaid is explicit per call (CLI --spend-prepaid): the default stays free-budget only, so background runs never spend the user's money.
export async function fetchHosted(doi, work, { spendPrepaid = false, backoff } = {}) {
  const notes = [];
  const key = providerKey('openalex');
  const id = /^https:\/\/openalex\.org\/(W\d+)$/.exec(work?.id || '')?.[1];
  const source = work?.content_urls?.pdf;
  if (key && id && work?.has_content?.pdf === true && source === `https://content.openalex.org/works/${id}.pdf`) {
    try {
      const options = { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) };
      const quotaResponse = await (backoff ? backoff.fetch('https://api.openalex.org/rate-limit', options) : fetch('https://api.openalex.org/rate-limit', options));
      const q = quotaResponse.ok ? (await quotaResponse.json()).rate_limit : null;
      // Refuse funded/paid accounts as well as unknown budgets: a concurrent API consumer
      // can exhaust free credit between the check and download. Zero prepaid prevents spending it.
      const room = q && (spendPrepaid ? q.daily_remaining_usd + q.prepaid_remaining_usd : q.daily_remaining_usd);
      const free = q && Number.isFinite(room) && Number.isFinite(q.endpoint_costs_usd?.content)
        && q.endpoint_costs_usd.content > 0 && room >= q.endpoint_costs_usd.content
        && Number.isFinite(q.daily_budget_usd) && q.daily_budget_usd > 0 && q.daily_budget_usd <= 1
        && (spendPrepaid || (q.prepaid_balance_usd === 0 && q.prepaid_remaining_usd === 0));
      if (free) {
        const response = await hostedDownload(source, key, backoff);
        if (response.ok) return { response, source, provider: 'openalex', notes,
          title: work.title, authors: (work.authorships || []).map(a => a.author?.display_name).filter(Boolean), year: work.publication_year };
        notes.push(note('openalex', 'http_' + response.status));
      } else notes.push(note('openalex', quotaResponse.ok ? 'free_budget_unavailable' : 'quota_http_' + quotaResponse.status));
    } catch { notes.push(note('openalex', 'hosted_download_failed')); }
  } else notes.push(note('openalex', key ? 'no_hosted_pdf' : 'missing_key'));
  return { notes };
}
