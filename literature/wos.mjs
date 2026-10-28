// Explicit, single-page WoS Starter lookup. Does not write the catalog or fetch full text.
import { providerKey } from './hosted.mjs';

const endpoint = 'https://api.clarivate.com/apis/wos-starter/v1/documents';
const usage = 'wos "<WoS query>" [--limit=1..50] [--page=1..] [--sort=TC+D]';

function quota(headers) {
  const number = name => {
    const value = headers.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  return {
    limit_day: number('x-ratelimit-limit-day'), remaining_day: number('x-ratelimit-remaining-day'),
    limit_second: number('x-ratelimit-limit-second'), remaining_second: number('x-ratelimit-remaining-second'),
  };
}

export async function searchWos(query, { limit = 10, page = 1, sort, fetchImpl = fetch } = {}) {
  if (typeof query !== 'string' || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 50
      || !Number.isInteger(page) || page < 1 || (sort !== undefined && !/^(?:LD|PY|RS|TC)\+[AD](?:,(?:LD|PY|RS|TC)\+[AD])*$/.test(sort)))
    throw new Error(usage);
  let key;
  try { key = providerKey('wos'); }
  catch { return { status: 'invalid_credentials', message: 'Check .runtime/literature/wos.credentials.local.json (api_key).' }; }
  if (typeof key !== 'string' || !key.trim())
    return { status: 'missing_key', message: 'Set WOS_API_KEY or .runtime/literature/wos.credentials.local.json (api_key).' };
  key = key.trim();
  const url = new URL(endpoint);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));
  if (sort !== undefined) url.searchParams.set('sortField', sort);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'X-ApiKey': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(25000), redirect: 'error',
    });
  } catch {
    // Do not expose transport errors, request headers, or provider error bodies containing credentials.
    return { status: 'request_failed', message: 'WoS request failed or timed out; no automatic retry.' };
  }
  const limits = quota(response.headers);
  if (!response.ok) return {
    status: ({ 401: 'authentication_failed', 403: 'access_denied', 429: 'rate_limited' })[response.status] || 'request_failed',
    http_status: response.status, quota: limits,
    message: 'WoS returned HTTP ' + response.status + '; no automatic retry.',
  };
  let body;
  try { body = await response.json(); } catch { /* Invalid JSON is not an empty successful search. */ }
  if (!body || !Number.isInteger(body.metadata?.total) || body.metadata.total < 0 || !Array.isArray(body.hits))
    return { status: 'invalid_response', http_status: response.status, quota: limits, message: 'WoS returned an unexpected response.' };
  return {
    status: 'ok', source: 'web-of-science-starter', fetched_at: new Date().toISOString(), query: query.trim(),
    metadata: body.metadata, hits: body.hits, quota: limits,
  };
}

export async function wosCommand(query, flags) {
  const options = {}, seen = new Set();
  for (const flag of flags) {
    const match = /^--(limit|page|sort)=(.+)$/.exec(flag);
    if (!match || seen.has(match[1])) throw new Error(usage);
    seen.add(match[1]);
    options[match[1]] = match[1] === 'sort' ? match[2] : /^\d+$/.test(match[2]) ? Number(match[2]) : NaN;
  }
  const result = await searchWos(query, options);
  console.log(JSON.stringify(result));
  if (result.status !== 'ok') process.exitCode = 1;
}
