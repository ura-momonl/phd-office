/* Installed explicitly using Zotero's normal plugin manager. This adds one
 * local operation, not an eval endpoint or a replacement PDF downloader.
 * The existing Zotero server owns its loopback listener/Host checks. Reject
 * browser-origin requests here as well; callers must be local programs that
 * deliberately request this narrow installed capability. No secrets are sent
 * through Zotero's debug-logged request headers or bodies. */
var endpointPath = '/office/fetch';
var metadataEndpointPath = '/office/metadata';
var busy = false;
var stopped = false;
function install() {}
function uninstall() {}
function shutdown() {
  stopped = true;
  delete Zotero.Server.Endpoints[endpointPath];
  delete Zotero.Server.Endpoints[metadataEndpointPath];
}
function startup() {
  stopped = false;
  // Do not await app initialization in the plugin's own startup hook: the app
  // may itself be waiting for plugins. Registration happens after initialization.
  Zotero.initializationPromise.then(() => {
    if (stopped) return;
    // Metadata is a separate read-only operation. It never invokes the PDF
    // resolver, saves a library item, inherits browser cookies, or runs page JS.
    Zotero.Server.Endpoints[metadataEndpointPath] = function () {};
    Zotero.Server.Endpoints[metadataEndpointPath].prototype = {
      supportedMethods: ['POST'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
      async init(request) {
        const reply = (code, body) => [code, 'application/json', JSON.stringify(body)];
        const headers = request.headers || {}, data = request.data;
        if (headers.origin || headers['sec-fetch-site'] || headers['x-office-fetch'] !== '1')
          return reply(403, { status: 'denied' });
        if (!data || Object.keys(data).some(k => k !== 'doi') || typeof data.doi !== 'string'
            || !/^10\.1038\/(?:s41567-|s41563-|s41565-|nphys|nmat|nnano)[a-z0-9.-]+$/.test(data.doi)
            || Zotero.Utilities.cleanDOI(data.doi)?.toLowerCase() !== data.doi)
          return reply(400, { status: 'unsupported_doi' });
        if (busy) return reply(409, { status: 'busy' });
        busy = true;
        const doi = data.doi, url = 'https://www.nature.com/articles/' + doi.slice(8);
        const result = (status, extra = {}) => reply(200, {
          status, doi, source_url: url, library_writes: 0, attachment_downloads: 0, ...extra
        });
        try {
          const response = await Zotero.HTTP.request('GET', url, {
            responseType: 'document', timeout: 30000,
            errorDelayMax: 0, noRetryOnThrottle: true
          });
          const doc = response.response;
          if (!doc) return result('challenge');
          const pageDOI = doc.querySelector('meta[name="citation_doi"]')?.getAttribute('content');
          if (Zotero.Utilities.cleanDOI(pageDOI || '')?.toLowerCase() !== doi)
            // "Just a moment" is also a real Nature Physics article title.
            // Classify challenge text only when publisher DOI identity is absent.
            return result(/client challenge|just a moment|access denied|captcha/i.test(doc.title || '')
              ? 'challenge' : 'identity_mismatch');
          // Only a labeled Abstract section is evidence. No lead/intro/meta
          // description fallback: the site translator can legitimately return those.
          const section = doc.querySelector('[data-title="Abstract"] .c-article-section__content')
            || (doc.querySelector('#Abs1')?.textContent?.trim() === 'Abstract'
              ? doc.querySelector('#Abs1-content') : null);
          const abstract = section?.textContent?.trim();
          if (!abstract) return result('no_abstract');
          const translate = new Zotero.Translate.Web();
          translate.setDocument(Zotero.HTTP.wrapDocument(doc, url));
          // Embedded Metadata reads this already-fetched document, without the
          // Nature translator's extra RIS request or its intro-text fallback.
          translate.setTranslator('951c027d-74ac-47d4-a107-9c3069ab7b48');
          const items = await translate.translate({ libraryID: false, saveAttachments: false });
          const item = items.find(i => Zotero.Utilities.cleanDOI(i.DOI || '')?.toLowerCase() === doi);
          if (!item?.title) return result('identity_mismatch');
          return result('available', {
            title: item.title, journal: item.publicationTitle || null, date: item.date || null,
            authors: (item.creators || []).filter(c => c.creatorType === 'author')
              .map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')),
            abstract, abstract_section: 'Abstract', translator: 'Embedded Metadata',
            abstract_from: 'zotero-native-web', no_retry: true
          });
        } catch (error) {
          const status = Number(error.status || error.xmlhttp?.status) || null;
          return result(status ? 'http_error' : 'native_failed', { http_status: status, no_retry: true });
        } finally { busy = false; }
      }
    };
    Zotero.Server.Endpoints[endpointPath] = function () {};
    Zotero.Server.Endpoints[endpointPath].prototype = {
      supportedMethods: ['POST'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
      async init(request) {
        const reply = (code, body) => [code, 'application/json', JSON.stringify(body)];
        const headers = request.headers || {};
        if (headers.origin || headers['sec-fetch-site'] || headers['x-office-fetch'] !== '1')
          return reply(403, { status: 'denied' });
        const data = request.data;
        if (!data || Object.keys(data).some(k => k !== 'doi') || typeof data.doi !== 'string'
            || !/^10\.\d{4,9}\/\S{1,200}$/i.test(data.doi)
            || Zotero.Utilities.cleanDOI(data.doi)?.toLowerCase() !== data.doi)
          return reply(400, { status: 'invalid_doi' });
        if (busy) return reply(409, { status: 'busy' });
        busy = true;
        try {
          const doi = data.doi;
          const search = new Zotero.Search();
          search.libraryID = Zotero.Libraries.userLibraryID;
          search.addCondition('DOI', 'is', doi);
          let items = await Zotero.Items.getAsync(await search.search());
          let item = items.find(i => !i.deleted && i.getField('DOI').toLowerCase() === doi);
          if (!item) {
            const lookup = new Zotero.Translate.Search();
            lookup.setIdentifier({ DOI: doi });
            lookup.setTranslator(await lookup.getTranslators());
            items = await lookup.translate({ libraryID: Zotero.Libraries.userLibraryID, saveAttachments: false });
            item = items.find(i => i.getField('DOI').toLowerCase() === doi);
          }
          if (!item) return reply(200, { status: 'metadata_not_found', doi });
          // Reuse an existing local PDF; never trigger cloud sync or fetch a
          // cloud-only attachment implicitly. Otherwise call Zotero once.
          const children = await Zotero.Items.getAsync(item.getAttachments());
          let attachment;
          for (const child of children) {
            if (child.attachmentContentType === 'application/pdf' && await child.fileExists()) {
              attachment = child; break;
            }
          }
          attachment ||= await Zotero.Attachments.addAvailableFile(item, { methods: ['doi', 'url', 'oa'] });
          return reply(200, { status: attachment ? 'saved' : 'no_file_found', doi,
            parent_key: item.key, attachment_key: attachment?.key || null });
        } catch {
          // Do not return raw network errors, page contents, credentials or paths.
          return reply(500, { status: 'native_failed', doi: data.doi });
        } finally { busy = false; }
      }
    };
  }).catch(error => Zotero.logError(error));
}
