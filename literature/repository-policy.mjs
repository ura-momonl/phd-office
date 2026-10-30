// Repository-only content access: positive provenance, exact host allow-list,
// manually checked redirects, and static HTML (no browser/subresource traffic).
import {isIP} from 'node:net';
import {selectPDF} from './fetch.mjs';

export const isPublisherHost=value=>/(^|\.)(nature\.com|springer\.com|springernature\.com|springeropen\.com|rdcu\.be|biomedcentral\.com|science\.org|sciencemag\.org|acs\.org|wiley\.com|aps\.org|aip\.org|scitation\.org|iop\.org|sciencedirect\.com|elsevier\.com|cell\.com|thelancet\.com|rsc\.org|ieee\.org|oup\.com|oxfordjournals\.org|cambridge\.org|tandfonline\.com|sagepub\.com|liebertpub\.com|annualreviews\.org|mdpi\.com|frontiersin\.org|hindawi\.com|karger\.com|degruyter\.com|researchsquare\.com|chemrxiv\.org)$/i.test(value.replace(/^www\./,''));
const name=value=>new URL(value).hostname.toLowerCase().replace(/^www\./,'');
function publicURL(value,base){
  const u=new URL(value,base),h=name(u.href);
  if(u.protocol!=='https:'||u.username||u.password||isIP(u.hostname)||!h.includes('.')||h.endsWith('.localhost')
    ||/ezproxy|duosecurity|login\.wisc/.test(h)||isPublisherHost(h)||['doi.org','content.openalex.org'].includes(h))throw Error('Not an allowed repository content URL');
  u.hash='';return u;
}
const arxiv=h=>['arxiv.org','export.arxiv.org'].includes(h);

export function repositorySources(work){
  const result=[],seen=new Set();
  const score=l=>(l.pdf_url?10:0)+({publishedVersion:3,acceptedVersion:2,submittedVersion:1}[l.version]||0);
  for(const l of [work.best_oa_location,...(work.locations||[])].filter(l=>l?.is_oa===true).sort((a,b)=>score(b)-score(a))){
    const institutional=l.source?.type==='repository'&&[l.source.host_organization,...(l.source.host_organization_lineage||[])]
      .some(id=>/^https:\/\/openalex\.org\/I\d+$/.test(id||''));
    let page;
    try{page=publicURL(l.landing_page_url);}catch{}
    for(const [type,value] of [['pdf',l.pdf_url],['page',l.landing_page_url]]){
      if(!value)continue;
      try{
        const u=publicURL(value),h=name(u.href);
        if(!arxiv(h)&&(!institutional||!page||h!==name(page.href)))continue;
        if(['pmc.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','europepmc.org','dev.europepmc.org','staging.europepmc.org'].includes(h))continue;
        if(type==='pdf'&&/(?:_reference|_supp(?:lement\w*)?|_moesm\w*)\.pdf$/i.test(u.pathname))continue;
        if(seen.has(u.href))continue;seen.add(u.href);
        result.push({url:u.href,type,repository:true,version:l.version||null,license:l.license||null});
      }catch{/* Raw metadata is retained; unconfirmed locations are not requested. */}
    }
  }
  return result;
}

export function repositoryAccess(sources,backoff,{onRequest=()=>{},onBlocked=()=>{}}={}){
  const allowed=new Set(['arxiv.org','export.arxiv.org',...sources.map(s=>name(publicURL(s.url).href))]);
  const assert=value=>{
    try{const u=publicURL(value);if(!allowed.has(name(u.href)))throw Error('Outside verified repository hosts');return u.href;}
    catch{onBlocked(String(value));throw Error('Repository-only policy blocked this content destination');}
  };
  return {
    assert,
    allows(value){try{publicURL(value);return allowed.has(name(value));}catch{return false;}},
    remaining(value){return backoff.remaining(assert(value));},
    observe(value,status,headers){return backoff.observe(assert(value),status,headers);},
    fetch(value,options={}){const url=assert(value);onRequest(url);return backoff.fetch(url,{...options,redirect:'manual'});}
  };
}

const decode=value=>String(value||'').replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[\da-f]+|\d+);/gi,s=>{
  const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
  if(named[s.toLowerCase()])return named[s.toLowerCase()];
  const n=s.toLowerCase().startsWith('&#x')?parseInt(s.slice(3,-1),16):Number(s.slice(2,-1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):s;
});
function attrs(tag){const a={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))a[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]);return a;}
export function staticRepositoryPDF(html,base,access){
  const snapshot={url:base,pdfMeta:[],links:[]};
  const permitted=value=>{try{const u=new URL(value,base);return access.allows(u.href)?u.href:null;}catch{return null;}};
  for(const m of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
    const a=attrs(m[0]);if(a.name?.toLowerCase()==='citation_pdf_url'){const u=permitted(a.content);if(u)snapshot.pdfMeta.push(u);}
  }
  for(const m of html.matchAll(/<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi)){
    const a=attrs(m[1]),u=permitted(a.href);if(u)snapshot.links.push({href:u,text:decode(m[2].replace(/<[^>]*>/g,' '))});
  }
  return selectPDF(snapshot);
}

export async function resolveRepositoryPage(value,access){
  try{
    let url=access.assert(value);
    for(let n=0;n<=5;n++){
      const response=await access.fetch(url,{signal:AbortSignal.timeout(30000)});
      if([301,302,303,307,308].includes(response.status)){
        const next=response.headers.get('location');if(!next)throw Error('Repository redirect has no destination');
        url=access.assert(new URL(next,url).href);continue;
      }
      if([401,403,429].includes(response.status))return {error:{status:response.status===429?'rate_limited':'access_denied',message:`Repository page returned HTTP ${response.status}; no retry`}};
      if([404,410].includes(response.status))return {error:{status:'not_found',message:'Repository article page not found'}};
      if(!response.ok)return {error:{status:'failed',message:`Repository page returned HTTP ${response.status}`}};
      if(/application\/pdf/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();return {pdf_url:url};}
      const html=await response.text();
      if(/captcha|verify (?:that )?you are human|client challenge|checking your browser/i.test(html.slice(0,12000)))
        return {error:{status:'needs_attention',message:'Article requires human verification; repository page not executed'}};
      const pdf=staticRepositoryPDF(html,url,access);
      return pdf?{pdf_url:pdf}:{error:{status:'needs_attention',message:'No permitted main PDF found in static repository HTML; no scripts or external resources loaded'}};
    }
    throw Error('Too many repository page redirects');
  }catch(e){return {error:{status:'needs_attention',message:e.message.includes('Repository-only policy')?e.message:'Repository page request failed; no automatic retry'}};}
}
