import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, read, write, input, checkProjects } from '../automation/files.mjs';
export function normalizeDOI(value) {
  const doi = String(value).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('Expected DOI or doi.org link');
  return doi;
}
export function record(paper) {
  const catalog = read('literature/catalog.json'); const doi = normalizeDOI(paper.doi);
  const id = 'doi-' + createHash('sha256').update(doi).digest('hex').slice(0,16);
  const previous = catalog.papers.find(p => p.id === id);
  const item = { ...previous, ...paper, id, doi, project_ids: checkProjects(paper.project_ids || previous?.project_ids),
    title: paper.title || previous?.title || null, fulltext_path: paper.fulltext_path || previous?.fulltext_path || null,
    zotero_key: paper.zotero_key || previous?.zotero_key || null };
  if (paper.fulltext_path) {
    const file = path.resolve(paper.fulltext_path);
    const signature = Buffer.alloc(5); const fd = fs.openSync(file,'r');
    try { fs.readSync(fd,signature,0,5,0); } finally { fs.closeSync(fd); }
    if (signature.toString() !== '%PDF-') throw new Error('fulltext_path must refer to a real PDF');
    item.fulltext_path = file;
  }
  item.fulltext_status = item.fulltext_path ? 'local-file' : item.zotero_key ? 'zotero-reference-unverified' : 'needs-fulltext';
  if (previous) catalog.papers[catalog.papers.indexOf(previous)] = item; else catalog.papers.push(item);
  write('literature/catalog.json', catalog); return item;
}
export function access(doi) {
  const config = read('literature/config.json'); const publisher = 'https://doi.org/' + normalizeDOI(doi);
  return { doi: normalizeDOI(doi), publisher, library_home:config.library_home,
    campus_fulltext: config.proxy_login ? config.proxy_login + encodeURIComponent(publisher) : config.bookmarklet_help,
    instructions:'先在浏览器通过图书馆/官方书签工具访问全文，正常 NetID/Duo 登录后保存到 Zotero；当前没有尝试校园登录或声称已经取得全文。' };
}
export async function run(action, argument) {
  if (action === 'macro') {
    const {macroCommand}=await import('./mouse-download.mjs');
    console.log(JSON.stringify(macroCommand(input(argument)),null,2));
  }
  else if (action === 'reconcile-work') {
    const flags=process.argv.slice(5);
    if(!argument || flags.some(f=>f!=='--apply'))throw Error('reconcile-work <package-id|all> [--apply]');
    const {reconcileRebuildWork}=await import('./rebuild-work.mjs');
    const result=reconcileRebuildWork(argument,{apply:flags.includes('--apply')});
    console.log(JSON.stringify(result,null,2));
    if(result.results.some(r=>r.status==='error'))process.exitCode=1;
  }
  else if (action === 'list') {
    const catalog = read('literature/catalog.json');
    const hidden = new Set(['deferred-publication', 'rereview-excluded']);
    const papers = catalog.papers.filter(p => !hidden.has(p.library_status));
    console.log(JSON.stringify({ ...catalog, papers, deferred_count: catalog.papers.filter(p => p.library_status === 'deferred-publication').length, rereview_excluded_count: catalog.papers.filter(p => p.library_status === 'rereview-excluded').length }, null, 2));
  }
  else if (action === 'auth-status') {
    const { authStatus } = await import('./auth.mjs');
    console.log(JSON.stringify(authStatus()));
  }
  else if (action === 'wos') {
    const { wosCommand } = await import('./wos.mjs');
    await wosCommand(argument, process.argv.slice(5));
  }
  else if (action === 'login-set') {
    const { setCredentialInteractively } = await import('../browser/run.mjs');
    const { resetLoginBlock } = await import('./auth.mjs');
    console.error('注意：NetID凭据将保存在本机明文文件，不进版本库/备份。仅在官方login.wisc.edu尝试一次普通登录；Duo仍需你完成。');
    await setCredentialInteractively('uw-library', 'NetID已保存到本机.runtime/browser/credentials.local.json（明文；不进版本库、备份或测试副本）。文献获取可按需自动普通登录，Duo仍由你完成。');
    resetLoginBlock();
  }
  else if (action === 'fetch') {
    const flags = process.argv.slice(5);
    const sources = flags.filter(flag => flag.startsWith('--source='));
    const hostedOnly = flags.includes('--hosted-only'), spendPrepaid = flags.includes('--spend-prepaid'), zoteroOnly = flags.includes('--zotero-only');
    if (sources.length > 1 || flags.some(flag => !['--login', '--no-campus', '--hosted-only', '--spend-prepaid', '--zotero-only'].includes(flag) && !flag.startsWith('--source='))
        || sources.some(flag => !flag.slice('--source='.length)) || (sources.length && flags.includes('--login')) || (flags.includes('--login') && flags.includes('--no-campus'))
        || (zoteroOnly && (hostedOnly || spendPrepaid || sources.length || flags.includes('--login')))
        || ((hostedOnly || spendPrepaid) && (!hostedOnly || sources.length || flags.includes('--login') || flags.includes('--no-campus'))))
      throw new Error('fetch <doi> [--zotero-only | --login | --source=<observed-open-PDF-URL> | --hosted-only [--spend-prepaid]]');
    const { ARXIV_ID, fetch_arxiv } = await import('./arxiv.mjs');
    const { fetch_paper } = await import('./fetch.mjs');
    if (sources.length && ARXIV_ID.test(String(argument).trim())) throw new Error('--source requires a registered journal DOI, not an arXiv identifier');
    if (zoteroOnly && ARXIV_ID.test(String(argument).trim())) throw new Error('--zotero-only requires a DOI, not an arXiv identifier');
    const result = ARXIV_ID.test(String(argument).trim()) ? await fetch_arxiv(argument)
      : await fetch_paper(argument, { login: flags.includes('--login'), zoteroOnly, ...(hostedOnly ? { hostedOnly, spendPrepaid } : {}), ...(sources.length ? { source: sources[0].slice('--source='.length) } : {}) });
    console.log(JSON.stringify(result));
    if (result.status !== 'available') process.exitCode = 1;
  }
  else if (action === 'discover') {
    const { discover } = await import('./discover.mjs');
    const result = await discover({ days: Number(argument) || 7 });
    const { literatureList } = await import('./view.mjs');
    console.log(JSON.stringify({ since: result.since, total: result.total, shown: result.shown, errors: result.errors,
      abstracts: { ...result.abstracts, attempts: undefined },
      candidate_file: '.runtime/literature/candidates-' + new Date().toISOString().slice(0, 10) + '.json',
      browse: literatureList(), next: 'browse candidates <页码> 继续题名初筛；show <doi> 只读入围摘要。完整数据仍在候选文件。' }));
  }
  else if (action === 'browse') {
    const { literatureList } = await import('./view.mjs');
    console.log(JSON.stringify(literatureList({ scope: argument || 'daily', page: process.argv[5] || 1, q: process.argv.slice(6).join(' ') })));
  }
  else if (action === 'recommend') {
    const {prepareRecommendations,saveRecommendations}=await import('./recommendations.mjs');
    const {literaturePaper}=await import('./view.mjs');
    const request=input(argument),prepared=prepareRecommendations(request),value=prepared.record;
    if(prepared.reused){console.log(JSON.stringify(prepared.reused));return;}
    const papers=value.items.map(p=>{const metadata=literaturePaper(p.doi);if(!metadata)throw new Error('先登记或抓取这篇的元数据：'+p.doi);if(p.basis==='abstract'&&!metadata.abstract)throw new Error('缺摘要，不能标作已读摘要：'+p.doi);return metadata;});
    // Retain the selected paper's metadata/abstract in the canonical catalog, not only runtime caches.
    for(const p of papers)record({doi:p.doi,title:p.title,source:p.source,date:p.date,authors:p.authors,abstract:p.abstract,abstract_from:p.abstract_from,abstract_version:p.abstract_version,publisher_url:p.publisher_url,preprint_url:p.preprint_url});
    console.log(JSON.stringify(saveRecommendations({...request,...value})));
  }
  else if (action === 'show') {
    const { literaturePaper } = await import('./view.mjs');
    const paper = literaturePaper(argument);
    if (!paper) throw new Error('本地记录里未找到这篇文献；show 不联网。');
    console.log(JSON.stringify(paper));
  }
  else if(action==='daily') {
    const {recommendationDay}=await import('./recommendations.mjs');
    console.log(JSON.stringify(recommendationDay(argument || undefined)));
  }
  else if (action === 'library') {
    const lib = await import('./library.mjs');
    if (argument === 'init' || argument === 'status' || argument === undefined) console.log(JSON.stringify(lib.status(), null, 2));
    else if (argument === 'ingest') console.log(JSON.stringify(lib.ingest({ limit: Number(process.argv[5]) || Infinity, force: process.argv.includes('--force') }), null, 2));
    else if (argument === 'search') console.log(JSON.stringify(lib.search(process.argv[5], { k: Number(process.argv.find(a => a.startsWith('--k='))?.slice(4)) || 8, refs: process.argv.includes('--refs') }), null, 2));
    else if (argument === 'update') { const i = lib.ingest({}); console.log(JSON.stringify({ ingest: i, embed: lib.embed({}) }, null, 2)); }
    else if (argument === 'abstracts') console.log(JSON.stringify(lib.indexAbstracts(), null, 2));
    else if (argument === 'embed') console.log(JSON.stringify(lib.embed({ limit: Number(process.argv[5]) || Infinity }), null, 2));
    else if (argument === 'hsearch') console.log(JSON.stringify(lib.hybridSearch(process.argv[5], { k: Number(process.argv.find(a => a.startsWith('--k='))?.slice(4)) || 8, refs: process.argv.includes('--refs'), papers: !process.argv.includes('--chunks'), rerank: process.argv.includes('--rerank') }), null, 2));
    else throw new Error('library: init | status | ingest [条数] [--force] | update（新论文一步到位：ingest + 摘要块 + embed，已处理的自动跳过）| abstracts（把题录摘要作为一块进索引，幂等）| embed [条数] | search "<查询>" [--k=8] [--refs]（BM25）| hsearch "<查询>" [--k=8] [--rerank] [--chunks]（BM25+向量，默认按论文合并，每篇附最多 2 段；--rerank 再用交叉编码器重排，多约 15 秒；--chunks 返回原始块；起 GPU 进程）');
  }
  else if (action === 'record') console.log(JSON.stringify(record(input(argument)), null, 2));
  else if (action === 'access') console.log(JSON.stringify(access(argument), null, 2));
  else if (action === 'resolve') {
    const doi = normalizeDOI(argument); const existing = read('literature/catalog.json').papers.find(p => p.doi === doi && p.metadata_source);
    if (existing) { console.log(JSON.stringify(existing)); return; }
    const response = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi), {
      headers:{'User-Agent':'PhD-Workflows/0.1 (personal DOI metadata lookup)'}, signal:AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Crossref metadata lookup failed: ' + response.status);
    const {message:m} = await response.json();
    console.log(JSON.stringify(record({doi,title:m.title?.[0],authors:m.author?.map(a=>[a.given,a.family].filter(Boolean).join(' ')),
      year:m.published?.['date-parts']?.[0]?.[0] || null,metadata_source:'https://api.crossref.org/works/'+encodeURIComponent(doi),
      publisher_url:m.URL,...(m.abstract ? {abstract_html:m.abstract} : {})}), null, 2));
  } else if (action === 'backfill') {
    const b = await import('./backfill.mjs'); const [year, from, count] = String(argument || '').split(/\s+/);
    if (!/^\d{4}$/.test(year || '')) throw new Error('literature backfill <年份> [起始序号] [条数]');
    console.log(JSON.stringify(await b.page(Number(year), Number(from) || 1, Number(count) || 150), null, 1));
  } else if (action === 'curate-task') {
    // Prints the work-queue request only; it enqueues nothing. Pass the JSON to work add/enqueue when you decide to run it.
    const [year, floor, actor] = String(argument || '').split(/\s+/);
    console.log(JSON.stringify((await import('./curate.mjs')).backfillTask({ year: Number(year), citationFloor: floor ? '被引 ≥ ' + floor : '', actor: actor || undefined }), null, 1));
  } else if (action === 'ingest') {
    const b = await import('./backfill.mjs'); console.log(JSON.stringify(await b.ingest(input(argument)), null, 1));
  } else if (action === 'zotero-status') {
    try {
      const response = await fetch(read('literature/config.json').zotero_local+'users/0/items?limit=1', {signal:AbortSignal.timeout(2000)});
      console.log(JSON.stringify({running:true,readable:response.ok,status:response.status}));
    } catch { console.log(JSON.stringify({running:false,readable:false,next:'Open Zotero and enable its local API'})); }
  } else throw new Error('literature: browse [daily|candidates|pool|local|nofull] [页码] [关键词], show <doi>, recommend <JSON文件>, list, discover [天数], library [init|status], fetch <doi> [--login|--source=<PDF-URL>], backfill <年> [起] [条数], ingest <JSON文件>, curate-task <年> <被引门槛数> [codex|claude], login-set, auth-status, record <json>, access <doi>, resolve <doi>, zotero-status');
}
