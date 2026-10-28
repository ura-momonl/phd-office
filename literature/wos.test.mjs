import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root } from '../automation/files.mjs';
import { searchWos } from './wos.mjs';

if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use node scripts/run-tests.mjs --literature or --files=literature/wos.test.mjs');
const file = path.join(root, '.runtime/literature/wos.credentials.local.json');
const fakeKey = 'fixture-wos-secret-do-not-print';
const document = { uid: 'WOS:FIXTURE', title: 'Graphene 中文 fixture', identifiers: { doi: '10.5555/fixture' },
  names: { authors: [{ displayName: 'A. Example' }] }, citations: [{ db: 'WOS', count: 17 }] };
const data = () => ({ metadata: { total: 3, page: 2, limit: 1 }, hits: [document] });
const response = (body = data(), status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

async function fixture(fn, { envKey = fakeKey, local } = {}) {
  const env = process.env.WOS_API_KEY;
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (envKey === null) delete process.env.WOS_API_KEY; else process.env.WOS_API_KEY = envKey;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (local !== undefined) fs.writeFileSync(file, typeof local === 'string' ? local : JSON.stringify(local));
  else fs.rmSync(file, { force: true });
  try { return await fn(); } finally {
    if (env === undefined) delete process.env.WOS_API_KEY; else process.env.WOS_API_KEY = env;
    if (previous) fs.writeFileSync(file, previous); else fs.rmSync(file, { force: true });
  }
}

test('WoS preserves Unicode query, citation provenance and paging in one authenticated read-only request', () => fixture(async () => {
  const catalog = path.join(root, 'literature/catalog.json'), before = fs.readFileSync(catalog);
  let calls = 0;
  const result = await searchWos('  TS=(graphene 中文) AND PY=2025  ', { limit: 1, page: 2, sort: 'TC+D,PY+A',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin + url.pathname, 'https://api.clarivate.com/apis/wos-starter/v1/documents');
      assert.equal(url.searchParams.get('q'), 'TS=(graphene 中文) AND PY=2025');
      assert.equal(url.searchParams.get('limit'), '1'); assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.searchParams.get('sortField'), 'TC+D,PY+A');
      assert.equal(url.searchParams.has('api_key'), false);
      assert.equal(options.headers['X-ApiKey'], fakeKey); assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response(data(), 200, { 'x-ratelimit-limit-day': '5000', 'x-ratelimit-remaining-day': '0', 'x-ratelimit-limit-second': '5' });
    } });
  assert.equal(calls, 1); assert.equal(result.status, 'ok'); assert.equal(result.source, 'web-of-science-starter');
  assert.equal(result.query, 'TS=(graphene 中文) AND PY=2025'); assert.deepEqual(result.hits, [document]);
  assert.deepEqual(result.metadata, { total: 3, page: 2, limit: 1 }); assert.ok(!Number.isNaN(Date.parse(result.fetched_at)));
  assert.deepEqual(result.quota, { limit_day: 5000, remaining_day: 0, limit_second: 5, remaining_second: null });
  assert.ok(!JSON.stringify(result).includes(fakeKey)); assert.deepEqual(fs.readFileSync(catalog), before);
}));

test('WoS zero results remain successful, missing quota stays unknown, and default paging is bounded', () => fixture(async () => {
  let calls = 0;
  const result = await searchWos('TI=(fixture)', { fetchImpl: async url => {
    calls++; assert.equal(url.searchParams.get('limit'), '10'); assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.has('sortField'), false);
    return response({ metadata: { total: 0, page: 1, limit: 10 }, hits: [] });
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'ok'); assert.deepEqual(result.hits, []);
  assert.deepEqual(Object.values(result.quota), [null, null, null, null]);
}));

test('WoS local credential works; environment key takes precedence without exposing either', () => fixture(async () => {
  const result = await searchWos('DO=10.5555/fixture', { fetchImpl: async (_url, options) => {
    assert.equal(options.headers['X-ApiKey'], 'local-fixture-key'); return response();
  } });
  assert.equal(result.status, 'ok'); assert.ok(!JSON.stringify(result).includes('local-fixture-key'));
  process.env.WOS_API_KEY = fakeKey;
  const second = await searchWos('DO=10.5555/fixture', { fetchImpl: async (_url, options) => {
    assert.equal(options.headers['X-ApiKey'], fakeKey); return response();
  } });
  assert.equal(second.status, 'ok');
}, { envKey: null, local: { api_key: 'local-fixture-key' } }));

test('WoS missing or malformed credentials do not call the network or leak file contents', () => fixture(async () => {
  const fetchImpl = () => { assert.fail('network must not be called'); };
  assert.equal((await searchWos('DO=10.5555/fixture', { fetchImpl })).status, 'missing_key');
  fs.writeFileSync(file, '{' + fakeKey);
  const result = await searchWos('DO=10.5555/fixture', { fetchImpl });
  assert.equal(result.status, 'invalid_credentials'); assert.ok(!JSON.stringify(result).includes(fakeKey));
}, { envKey: null }));

test('WoS invalid query, paging and sort fail before requesting data', () => fixture(async () => {
  const fetchImpl = () => { assert.fail('network must not be called'); };
  for (const [query, options] of [[undefined, {}], ['', {}], [' ', {}], ['TI=x', { limit: 0 }], ['TI=x', { limit: 51 }],
    ['TI=x', { limit: 1.5 }], ['TI=x', { page: 0 }], ['TI=x', { page: 1.5 }], ['TI=x', { sort: 'TC' }]])
    await assert.rejects(searchWos(query, { ...options, fetchImpl }), /wos/);
}));

test('WoS auth, access, limit and server errors are distinct, never retried, and never expose error bodies', () => fixture(async () => {
  for (const [http, status] of [[401, 'authentication_failed'], [403, 'access_denied'], [429, 'rate_limited'], [500, 'request_failed']]) {
    let calls = 0;
    const result = await searchWos('TI=fixture', { fetchImpl: async () => { calls++; return response({ error: fakeKey }, http); } });
    assert.equal(calls, 1); assert.equal(result.status, status); assert.equal(result.http_status, http);
    assert.equal(result.hits, undefined); assert.ok(!JSON.stringify(result).includes(fakeKey));
  }
}));

test('WoS transport failures and invalid successful responses are not empty searches or secret-bearing errors', () => fixture(async () => {
  let calls = 0;
  const failed = await searchWos('TI=fixture', { fetchImpl: async () => { calls++; throw new Error(fakeKey); } });
  assert.equal(calls, 1); assert.equal(failed.status, 'request_failed'); assert.ok(!JSON.stringify(failed).includes(fakeKey));
  for (const value of [null, {}, { metadata: { total: 0 } }, { metadata: { total: -1 }, hits: [] }]) {
    const result = await searchWos('TI=fixture', { fetchImpl: async () => response(value) });
    assert.equal(result.status, 'invalid_response');
  }
  const result = await searchWos('TI=fixture', { fetchImpl: async () => new Response('not-json-' + fakeKey) });
  assert.equal(result.status, 'invalid_response'); assert.ok(!JSON.stringify(result).includes(fakeKey));
}));

test('root CLI and help expose the usable WoS command and distinguish saved Wiley token from an integrated route', () => fixture(async () => {
  const preload = path.join(root, '.runtime/wos-cli-fixture.mjs');
  fs.writeFileSync(preload, `import assert from 'node:assert/strict';
let calls=0;
globalThis.fetch=async(url,options)=>{
  assert.equal(++calls,1);
  assert.equal(url.origin+url.pathname,'https://api.clarivate.com/apis/wos-starter/v1/documents');
  assert.equal(url.searchParams.get('q'),'TS=(graphene 中文)');
  assert.equal(url.searchParams.get('limit'),'1'); assert.equal(url.searchParams.get('page'),'2');
  assert.equal(url.searchParams.get('sortField'),'TC+D');
  assert.equal(options.headers['X-ApiKey'],process.env.WOS_API_KEY);
  return new Response(${JSON.stringify(JSON.stringify(data()))});
};`);
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'automation/run.mjs', ...args],
    { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  try {
    const catalog = fs.readFileSync(path.join(root, 'literature/catalog.json'));
    const help = run(['help', 'literature']); assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /wos/); assert.match(help.stdout, /Wiley TDM/); assert.match(help.stdout, /尚未 API 实测/);
    assert.match(help.stdout, /literature\/README.md/);
    const result = run(['literature', 'wos', 'TS=(graphene 中文)', '--limit=1', '--page=2', '--sort=TC+D']);
    assert.equal(result.status, 0, result.stderr); const json = JSON.parse(result.stdout);
    assert.equal(json.status, 'ok'); assert.equal(json.hits[0].title, document.title);
    assert.equal(json.hits[0].citations[0].count, 17); assert.ok(!result.stdout.includes(fakeKey));
    assert.deepEqual(fs.readFileSync(path.join(root, 'literature/catalog.json')), catalog);
    for (const flags of [['--limit=0'], ['--limit=1x'], ['--page=2', '--page=3'], ['--typo=1'], ['extra']]) {
      const bad = run(['literature', 'wos', 'TS=(graphene 中文)', ...flags]);
      assert.notEqual(bad.status, 0); assert.match(bad.stderr, /wos/); assert.ok(!(bad.stdout + bad.stderr).includes(fakeKey));
    }
    delete process.env.WOS_API_KEY;
    const missing = run(['literature', 'wos', 'TI=fixture']);
    assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).status, 'missing_key');
  } finally { fs.rmSync(preload, { force: true }); }
}));
