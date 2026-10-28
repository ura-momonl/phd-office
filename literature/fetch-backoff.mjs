import fs from 'node:fs';

export function retryAfterMs(headers) {
  const value = headers?.get ? headers.get('retry-after') : headers?.['retry-after'];
  const delay = value == null || String(value).trim() === '' ? NaN : /^\d+(?:\.\d+)?$/.test(String(value).trim())
    ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 60000;
}

// A batch shares only a host's observed Retry-After deadline, never a global
// dispatch delay. Skipped requests do not extend it. Store hostnames, not URLs
// with query strings or credentials. arXiv's two official hosts share a limit.
// Servers may ask for 15 minutes; we skip that host for at most this long, then
// let a request probe again. Other hosts are never affected.
export const MAX_HOST_SKIP_MS = 60000;

export class FetchBackoff {
  constructor(file, { maxSkipMs = MAX_HOST_SKIP_MS } = {}) {
    this.file = file;
    this.maxSkipMs = maxSkipMs;
    const cap = Date.now() + maxSkipMs;
    this.deadlines = new Map((file && fs.existsSync(file) ? Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))) : [])
      .map(([host, at]) => [host, Math.min(at, cap)]));
  }
  host(value) {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return host === 'export.arxiv.org' ? 'arxiv.org' : host;
  }
  remaining(value) { return Math.max(0, (this.deadlines.get(this.host(value)) || 0) - Date.now()); }
  observe(value, status, headers) {
    if (status !== 429) return;
    const host = this.host(value);
    this.deadlines.set(host, Math.max(this.deadlines.get(host) || 0, Date.now() + Math.min(retryAfterMs(headers), this.maxSkipMs)));
    // A failed save must not kill a fetch lane; the in-memory deadline still applies.
    if (this.file) try { fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.deadlines), null, 2) + '\n'); } catch { /* ignore */ }
  }
  async fetch(value, options) {
    const remaining = this.remaining(value);
    if (remaining > 0) return new Response(null, { status: 429, headers: { 'retry-after': String(remaining / 1000) } });
    const response = await fetch(value, options);
    this.observe(value, response.status, response.headers);
    // Redirect targets can impose their own limit. Bind it to both the original
    // route and the observed target rather than hitting the target indirectly.
    if (response.url && response.url !== String(value)) this.observe(response.url, response.status, response.headers);
    return response;
  }
}
