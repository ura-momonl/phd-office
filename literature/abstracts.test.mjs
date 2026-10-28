import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichAbstracts } from './abstracts.mjs';
import { arxiv, crossrefJournal } from './discover.mjs';
import { coarse } from './backfill.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Use node scripts/run-tests.mjs --literature');
const doi = '10.1103/fixture';
const item = () => ({ doi, title: 'A precise noise measurement', authors: 'Example, Researcher', abstract: '' });
const response = (data, status = 200, url = '') => ({ ok: status >= 200 && status < 300, status, url,
  headers: new Headers(), json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
const options = fetchImpl => ({ fetchImpl, pause: async () => {} });
const noMetadata = url => new URL(url).hostname === 'api.openalex.org'
  ? response({ doi: 'https://doi.org/' + doi, abstract_inverted_index: null })
  : response({}, 429);
const feed = (title = 'A precise noise measurement', linkedDOI = '', author = 'A. Example') =>
  `<feed><entry><id>http://arxiv.org/abs/2610.00001v2</id><title>${title}</title><author><name>${author}</name></author><summary>A complete abstract with x &lt; 2 and an experimental result.</summary>${linkedDOI ? `<arxiv:doi>${linkedDOI}</arxiv:doi>` : ''}</entry></feed>`;

test('cached abstracts are preserved without any network or browser calls', async () => {
  const p = { ...item(), abstract: 'Previously checked.' };
  const s = await enrichAbstracts([p], options(() => { throw new Error('must not call'); }));
  assert.equal(s.already, 1); assert.equal(p.abstract, 'Previously checked.'); assert.deepEqual(s.attempts, []);
});
test('OpenAlex preserves the whole abstract, word order, and provenance', async () => {
  const long = ('Measurement ' + 'measurement '.repeat(199)).trim(), ix = {};
  long.split(' ').forEach((w, i) => (ix[w] ||= []).push(i)); const p = item();
  const s = await enrichAbstracts([p], options(async () => response({ doi, abstract_inverted_index: ix })));
  assert.equal(s.openalex, 1); assert.equal(p.abstract, long); assert.ok(p.abstract.length > 1500); assert.match(p.abstract_url, /openalex/);
});
test('Semantic Scholar fallback validates DOI and decodes the abstract', async () => {
  const p = item(); const s = await enrichAbstracts([p], options(async url => new URL(url).hostname === 'api.openalex.org'
    ? response({ doi, abstract_inverted_index: null }) : response({ externalIds: { DOI: doi }, abstract: 'Noise &amp; signal.' })));
  assert.equal(s.semantic_scholar, 1); assert.equal(p.abstract, 'Noise & signal.');
});
test('429 stops the provider for the rest of a call; defaults never visit publishers, arXiv, or browsers', async () => {
  const calls = [], waits = [], p = item(), q = { ...item(), doi: '10.1103/other' };
  const s = await enrichAbstracts([p, q], { fetchImpl: async url => { calls.push(url); return response({}, 429); }, pause: async ms => waits.push(ms), launch: () => { throw new Error('not selected'); } });
  assert.equal(calls.length, 2); assert.equal(s.s2_stopped, true); assert.equal(s.missing, 2);
  assert.ok(waits.every(ms => ms >= 1000)); assert.ok(calls.every(u => /api.openalex.org|api.semanticscholar.org/.test(u)));
});
test('selected APS lookup handles reversed meta attributes and HTML entities; does not fetch PDFs', async () => {
  const calls = [], p = item();
  const s = await enrichAbstracts([p], { ...options(async url => {
    calls.push(url);
    if (url.startsWith('https://doi.org/')) return { ...response('', 302), headers: new Headers({ location: 'https://journals.aps.org/prb/abstract/' + doi }) };
    if (url.startsWith('https://journals.aps.org/')) return response(`<meta content='${doi}' name='citation_doi'><meta content='Shot noise &amp; x &lt; 2 &#39;quoted&#39;.' name='description'>`, 200, url);
    return noMetadata(url);
  }), selected: true });
  assert.equal(s.aps, 1); assert.equal(p.abstract, "Shot noise & x < 2 'quoted'."); assert.ok(calls.every(u => !u.endsWith('.pdf')));
});
test('APS accepted-paper page without citation meta: abstract from body, identity from the DOI in the final URL', async () => {
  const mk = (page) => async url => {
    if (url.startsWith('https://doi.org/')) return { ...response('', 302), headers: new Headers({ location: 'https://journals.aps.org/prb/accepted/' + doi }) };
    if (url.startsWith('https://journals.aps.org/')) return response(page, 200, page.includes('WRONGURL') ? 'https://journals.aps.org/prb/accepted/10.5555/wrong' : url);
    return noMetadata(url);
  };
  const body = '<section id="abstract-section"><div class="content" id="abstract-section-content"><div class="content"><p><span>Body &amp; abstract.</span></p></div></div></section>';
  const p = item();
  const s = await enrichAbstracts([p], { ...options(mk(body)), selected: true });
  assert.equal(s.aps, 1); assert.equal(p.abstract, 'Body & abstract.');
  const q = item();
  const t = await enrichAbstracts([q], { ...options(mk(body + 'WRONGURL')), selected: true });
  assert.equal(t.aps, 0); assert.equal(q.abstract, '');
});
test('Springer Nature Meta API fills 10.1038 items by exact DOI, keeps the key out of provenance, and ignores other prefixes', async () => {
  const nd = '10.1038/s00000-000-00000-0', calls = [];
  const impl = async url => {
    calls.push(url);
    if (url.startsWith('https://api.springernature.com/')) return response({ records: [{ doi: '10.1038/other', abstract: 'Wrong record.' }, { doi: nd, abstract: '<p>Right &amp; whole abstract.</p>' }] });
    return noMetadata(url);
  };
  const p = { ...item(), doi: nd };
  const s = await enrichAbstracts([p], { ...options(impl), springerKey: 'SECRETKEY' });
  assert.equal(s.springer, 1); assert.equal(p.abstract, 'Right & whole abstract.'); assert.equal(p.abstract_from, 'springer');
  assert.ok(!p.abstract_url.includes('SECRETKEY')); assert.ok(calls.some(u => u.includes('api_key=SECRETKEY')));
  const aps = item(); calls.length = 0;
  await enrichAbstracts([aps], { ...options(impl), springerKey: 'SECRETKEY' });
  assert.ok(calls.every(u => !u.includes('springernature')));
  const none = { ...item(), doi: nd }; calls.length = 0;
  await enrichAbstracts([none], { ...options(impl), springerKey: '' });
  assert.ok(calls.every(u => !u.includes('springernature')));
});
test('Semantic Scholar requests carry the key header only when a key exists, and never to other hosts', async () => {
  const seen = [];
  const impl = async (url, o) => { seen.push([new URL(url).hostname, o.headers['x-api-key']]); return noMetadata(url); };
  await enrichAbstracts([item()], { ...options(impl), s2Key: 'S2SECRET', springerKey: '' });
  assert.deepEqual(seen.filter(([h]) => h === 'api.semanticscholar.org').map(x => x[1]), ['S2SECRET']);
  assert.ok(seen.filter(([h]) => h !== 'api.semanticscholar.org').every(x => x[1] === undefined));
  seen.length = 0; await enrichAbstracts([item()], { ...options(impl), s2Key: '', springerKey: '' });
  assert.ok(seen.every(x => x[1] === undefined));
});
test('a mid-sentence fragment is not accepted as an abstract, but lowercase-initial real abstracts are', async () => {
  const fragment = 'heterostructures. The onset of lasing was identified by the kink in the curve and the narrowing of the linewidth.';
  const p = item();
  const s = await enrichAbstracts([p], options(async url => new URL(url).hostname === 'api.openalex.org'
    ? response({ doi: 'https://doi.org/' + doi, abstract_inverted_index: Object.fromEntries(fragment.split(' ').map((w, i) => [w, [i]])) }) : response({}, 429)));
  assert.equal(p.abstract, ''); assert.ok(s.attempts.some(a => a.source === 'openalex' && a.status === 'fragment'));
  for (const ok of ['van der Waals stacks host a flat band near the Fermi level.', 'p-type doping shifts the Dirac point in these devices.']) {
    const q = item();
    await enrichAbstracts([q], options(async url => new URL(url).hostname === 'api.openalex.org'
      ? response({ doi: 'https://doi.org/' + doi, abstract_inverted_index: Object.fromEntries(ok.split(' ').map((w, i) => [w, [i]])) }) : response({}, 429)));
    assert.equal(q.abstract, ok);
  }
});
test('backfill coarse filter drops covers, comments, retractions, excluded words and duplicate titles, keeping the more cited', () => {
  const w = (doi, title, cites = 1) => ({ doi, title, cites, journal: 'J' });
  const cfg = { exclude: ['protein'] };
  const { kept, dropped } = coarse([
    w('10.1/a', 'A real study of moire excitons', 50), w('10.1/b', 'Graphene: Growth of films (Adv. Mater. 9/2019)'),
    w('10.1/c', 'Comment on “Something”'), w('10.1/d', 'RETRACTED ARTICLE: Something'), w('10.1/e', 'Protein folding on 2D surfaces'),
    w('10.1/f', 'A Real Study of Moiré Excitons', 5), w('', 'No DOI here'), w('10.1/g', 'Morgado and Silveirinha Reply:')], cfg);
  assert.deepEqual(kept.map(p => p.doi), ['10.1/a']);
  assert.deepEqual(dropped, { cover: 1, comment: 2, retracted: 1, excluded: 1, duplicate: 1, no_doi: 1 });
});
test('wrong-DOI metadata and a preprint with conflicting DOI cannot fill the item', async () => {
  const p = item();
  const s = await enrichAbstracts([p], { ...options(async url => {
    const host = new URL(url).hostname;
    if (host === 'api.openalex.org') return response({ doi: '10.5555/wrong', abstract_inverted_index: { Wrong: [0] } });
    if (host === 'doi.org') return { ...response('', 302), headers: new Headers({ location: 'https://journals.aps.org/prb/abstract/' + doi }) };
    if (host === 'journals.aps.org') return response('<meta name="citation_doi" content="10.5555/wrong"><meta name="description" content="Wrong abstract">', 200, url);
    if (host === 'export.arxiv.org') return response(feed(p.title, '10.5555/wrong'));
    return response({}, 429);
  }), selected: true });
  assert.equal(s.missing, 1); assert.equal(p.abstract, ''); assert.equal(s.attempts.filter(a => a.status === 'identity_mismatch').length, 2);
});
test('same title plus author is required for unlinked preprints; records preprint identity, not publisher version', async () => {
  const p = { ...item(), doi: '10.1038/s41565-026-fixture' }, waits = [];
  const s = await enrichAbstracts([p], { fetchImpl: async url => new URL(url).hostname === 'export.arxiv.org' ? response(feed()) : noMetadata(url), pause: async ms => waits.push(ms), selected: true });
  assert.equal(s.arxiv, 1); assert.equal(p.preprint_match, 'title_and_author'); assert.equal(p.abstract_version, 'preprint');
  assert.equal(p.preprint_url, 'https://arxiv.org/abs/2610.00001v2'); assert.ok(p.abstract.includes('x < 2')); assert.ok(waits.includes(3100));
});
test('similar titles without author agreement do not silently match', async () => {
  const p = { ...item(), doi: '10.1038/s41565-026-fixture' };
  const s = await enrichAbstracts([p], { ...options(async url => new URL(url).hostname === 'export.arxiv.org' ? response(feed(p.title, '', 'Different Person')) : noMetadata(url)), selected: true });
  assert.equal(s.arxiv, 0); assert.equal(s.missing, 1); assert.ok(s.attempts.some(a => a.status === 'no_verified_match'));
});
test('linked journal DOI can verify a renamed preprint', async () => {
  const p = { ...item(), doi: '10.1038/s41565-026-fixture' };
  const s = await enrichAbstracts([p], { ...options(async url => new URL(url).hostname === 'export.arxiv.org' ? response(feed('Earlier title', p.doi)) : noMetadata(url)), selected: true });
  assert.equal(s.arxiv, 1); assert.equal(p.preprint_match, 'doi');
});
test('Nature challenge stops subsequent Nature navigation and closes its own session without interaction', async () => {
  let launched = 0, navigated = 0, closed = 0;
  const p = { ...item(), doi: '10.1038/s41565-026-fixture' }, q = { ...p, doi: '10.1038/s41565-026-second' };
  const s = await enrichAbstracts([p, q], { ...options(async url => new URL(url).hostname === 'export.arxiv.org' ? response('<feed/>') : response({}, 429)), selected: true, browser: true,
    launch: async () => { launched++; return { close: async () => { closed++; } }; },
    createContext: async () => ({ newPage: async () => ({ goto: async () => { navigated++; return { ok: () => true }; }, evaluate: async () => ({ title: 'Client Challenge', body: 'Verify you are human', doi: '', abstract: '' }), close: async () => {} }) }) });
  assert.equal(launched, 1); assert.equal(navigated, 1); assert.equal(closed, 1); assert.equal(s.nature, 0); assert.equal(s.missing, 2);
  assert.ok(s.attempts.some(a => a.source === 'nature' && a.status === 'challenge'));
});
test('Nature accepts only an exact DOI and DOM abstract, and browser opt-in cannot apply to the general pool', async () => {
  const p = { ...item(), doi: '10.1038/s41565-026-fixture' };
  await assert.rejects(enrichAbstracts([p], { browser: true }), /selected shortlist/);
  const s = await enrichAbstracts([p], { ...options(async () => response({}, 429)), selected: true, browser: true,
    launch: async () => ({ close: async () => {} }), createContext: async () => ({ newPage: async () => ({
      goto: async () => ({ ok: () => true }), evaluate: async () => ({ title: p.title, body: '', doi: p.doi, abstract: 'Complete publisher abstract.' }), close: async () => {} }) }) });
  assert.equal(s.nature, 1); assert.equal(p.abstract, 'Complete publisher abstract.');
});
test('source ingestion no longer truncates Crossref and arXiv abstracts to 1500 characters', async t => {
  const long = 'Full abstract. '.repeat(200).trim();
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('crossref')
    ? response({ message: { items: [{ DOI: doi, title: ['Fixture'], abstract: long }] } })
    : response(`<feed><entry><id>http://arxiv.org/abs/2610.00001</id><title>Fixture</title><summary>${long}</summary><published>2026-10-17</published></entry></feed>`));
  assert.equal((await crossrefJournal(['Fixture', '0000-0000', 1], '2026-10-17', 1))[0].abstract, long);
  assert.equal((await arxiv('2026-10-17', 1))[0].abstract, long);
});
