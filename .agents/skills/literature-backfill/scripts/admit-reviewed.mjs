// Each owner accepts its own content. One locked program path writes the shared catalog.
import fs from 'node:fs';
import {local,read,sha,validate,save} from './records.mjs';
import {syncAcceptedRebuildWork} from '../../../../literature/rebuild-work.mjs';
const request=read(process.argv[2]),statePath='output/literature-rebuild-20261021/CONTINUE.json',state=read(statePath);
if(!['codex','claude','deepseek'].includes(request.owner))throw Error('Explicit owner required');
const pkg=state.packages.find(p=>p.id===request.package&&p.owner===request.owner);
if(!pkg)throw Error('Package is not owned by submitter');
const manifest=read(pkg.manifest),input=read(pkg.input),decisions=read(request.decisions),audit=read(request.audit);
if(sha(JSON.stringify(input))!==manifest.input_sha256||!Array.isArray(decisions)||decisions.length!==input.length)throw Error('Input hash or final decision count');
if(audit.owner!==request.owner||audit.package!==pkg.id||!Array.isArray(audit.checked_include_ids)||!Array.isArray(audit.checked_pending_ids)||!Array.isArray(audit.checked_exclude_ids)||!Array.isArray(audit.exclusion_audit))throw Error('Owner-specific content audit required');
const inputIds=new Set(input.map(p=>p.id));
for(const key of ['checked_include_ids','checked_pending_ids','checked_exclude_ids'])if(new Set(audit[key]).size!==audit[key].length||audit[key].some(id=>!inputIds.has(id)))throw Error('Invalid audit IDs '+key);
decisions.forEach((d,i)=>validate(d,input[i]));
for(const [key,category] of [['checked_include_ids','include'],['checked_pending_ids','pending'],['checked_exclude_ids','exclude']])if(audit[key].some(id=>!decisions.some(d=>d.id===id&&d.decision===category)))throw Error('Audit category mismatch '+key);
const includes=decisions.filter(d=>d.decision==='include');
if(includes.some(d=>!audit.checked_include_ids.includes(d.id)))throw Error('Every include requires this owner actual abstract review');
if(decisions.some(d=>d.decision==='pending'&&!audit.checked_pending_ids.includes(d.id)))throw Error('Every pending requires owning main review');
if(decisions.some(d=>d.decision==='exclude')&&(!audit.checked_exclude_ids.length||!audit.exclusion_audit.length))throw Error('Record actual stratified exclusion audit; no fixed percentage imposed');
for(const group of audit.exclusion_audit)if(!group.stratum||!Array.isArray(group.ids)||!group.ids.length||group.ids.some(id=>!audit.checked_exclude_ids.includes(id)))throw Error('Invalid exclusion audit stratum');
const dir=`output/literature-rebuild-20261021/coordinator/admissions/${pkg.id}`,receiptPath=`${dir}/receipt.json`;
if(fs.existsSync(local(receiptPath))){const receipt=read(receiptPath);if(receipt.owner!==request.owner||receipt.final_decisions_sha256!==sha(JSON.stringify(decisions)))throw Error('Package previously admitted with different final decisions; inspect receipt');console.log(JSON.stringify({...receipt,already_admitted:true,work_sync:syncAcceptedRebuildWork(pkg.id)}));process.exit(0);}
const lockPath='output/literature-rebuild-20261021/coordinator/catalog-admission.lock';
let lock;try{lock=fs.openSync(local(lockPath),'wx');}catch(e){if(e.code==='EEXIST')throw Error('Another admission holds the catalog lock. Do not delete it or poll automatically; submit after that write finishes.');throw e;}
try{
 fs.writeFileSync(lock,JSON.stringify({owner:request.owner,package:pkg.id,pid:process.pid,created_at:new Date().toISOString()}));
 const bytes=fs.readFileSync(local(state.catalog)),catalog=JSON.parse(bytes),initial=catalog.papers.length;
 const known=new Set(catalog.papers.map(p=>p.doi.toLowerCase())),added=[],now=new Date().toISOString();
 if(known.size!==initial)throw Error('Preexisting catalog duplicate DOI');
 for(let i=0;i<input.length;i++){
  const p=input[i],d=decisions[i];if(d.decision!=='include')continue;
  if(!/^10\.\d{4,9}\//i.test(p.doi||'')||!p.title||!p.authors?.length||p.authors.some(a=>!String(a).trim())||!p.abstract||!/^https:\/\//.test(p.abstract_url||'')||!/^\d{4}-\d{2}-\d{2}$/.test(p.date||'')||p.date<state.scope.date_start||p.date>state.scope.date_end||p.year!==Number(p.date.slice(0,4))||state.journal_policy.excluded.includes(p.journal))throw Error('Invalid metadata/scope '+p.id);
  const doi=p.doi.toLowerCase();if(known.has(doi))continue;
  const paper={doi,title:p.title,authors:[...new Set(p.authors.map(a=>a.normalize('NFC').trim()))],date:p.date,year:p.year,source:p.journal,abstract:p.abstract,abstract_from:p.abstract_from,abstract_url:p.abstract_url,publisher_url:'https://doi.org/'+doi,library_tier:'library',library_status:'active',collected_via:'rebuild-20261021-owner-reviewed',selection_basis:'abstract',selection_review:{reviewer:request.owner+'-worker',audited_by:request.owner+'-main',reviewed_at:now,complete_stored_abstract_read:true,main_complete_abstract_read:true,source_abstract_sha256:sha(p.abstract),source_kind:'indexed-source-abstract-content-reviewed-not-automatically-publisher-verified',primary_direction:d.direction,article_type:d.type,scope:'in',evidence:d.evidence,provenance:`${p.id}; package ${pkg.id}; owner audit ${request.audit}`,evidence_boundary:'Assigned reader read the stored source; owning main reviewed the include. No second assistant acceptance, PDF audit, or automatic publisher verification.'},library_reason:d.reason,library_tags:d.tags,metadata_source:p.abstract_url,fulltext_path:null,project_ids:[],id:'doi-'+sha(doi).slice(0,16),zotero_key:null,fulltext_status:'needs-fulltext'};
  catalog.papers.push(paper);known.add(doi);added.push({id:p.id,doi});
 }
 fs.mkdirSync(local(dir),{recursive:true});
 fs.writeFileSync(local(`${dir}/catalog-before.json`),bytes,{flag:'wx'});
 save(`${dir}/ledger.json`,decisions.map((d,i)=>({...d,doi:input[i].doi||null,source_url:input[i].abstract_url,source_sha256:sha(input[i].abstract||''),accepted_by:request.owner,audit:request.audit})));
 save(state.catalog,catalog,bytes);
 const actual=read(state.catalog);if(actual.papers.length!==initial+added.length||new Set(actual.papers.map(p=>p.doi.toLowerCase())).size!==actual.papers.length)throw Error('Catalog readback count/duplicates');
 for(const a of added){const p=actual.papers.find(p=>p.doi===a.doi),expected=catalog.papers.find(p=>p.doi===a.doi);if(JSON.stringify(p)!==JSON.stringify(expected)||sha(p.abstract)!==p.selection_review.source_abstract_sha256)throw Error('Readback fields/hash '+a.id);}
 const receipt={owner:request.owner,package:pkg.id,accepted_at:now,records:decisions.length,added:added.length,added_records:added,catalog_total:actual.papers.length,final_decisions_sha256:sha(JSON.stringify(decisions)),audit:request.audit,catalog_readback_verified:true};
 save(receiptPath,receipt);
 const currentBytes=fs.readFileSync(local(statePath)),current=JSON.parse(currentBytes);
 current.work_items=current.work_items.map(w=>pkg.work_item_ids.includes(w.id)?{...w,status:'accepted',accepted_by:request.owner,accepted_at:now,ledger:`${dir}/ledger.json`,delivery:receiptPath}:w);
 current.packages=current.packages.map(p=>p.id===pkg.id?{...p,status:'accepted',accepted_by:request.owner,delivery:receiptPath}:p);
 current.catalog_total_at_update=actual.papers.length;current.updated_at=now;
 try{save(statePath,current,currentBytes);receipt.state_synced=true;}catch(e){receipt.state_synced=false;receipt.state_sync_error=e.message;}
 fs.writeFileSync(local(receiptPath),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({...receipt,work_sync:syncAcceptedRebuildWork(pkg.id)}));
}finally{fs.closeSync(lock);fs.unlinkSync(local(lockPath));}
