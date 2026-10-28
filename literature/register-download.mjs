// Local browser-download registration. Reuse verified files, never overwrite.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read} from '../automation/files.mjs';
import {normalizeDOI,record} from './run.mjs';
import {validatePDF} from './fetch.mjs';

export function registerDownload(value, file, source='existing local browser download') {
  const doi=normalizeDOI(value);
  const previous=read('literature/catalog.json').papers.find(p=>p.doi===doi);
  if(!previous)throw new Error('DOI is not registered in the library');
  if(previous.fulltext_path&&fs.existsSync(previous.fulltext_path)){
    const checked=validatePDF(previous.fulltext_path,doi,previous.fulltext_sha256,previous.fulltext_identity,previous.title);
    return {doi,status:'local-file',path:previous.fulltext_path,reused:true,...checked};
  }
  const out=path.join(root,'literature/fulltext','doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16)+'.pdf');
  let checked=validatePDF(file,doi,undefined,undefined,previous.title),reused=false;
  if(!fs.existsSync(out)){
    fs.mkdirSync(path.dirname(out),{recursive:true});
    try{fs.copyFileSync(file,out,fs.constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='EEXIST')throw error;reused=true;}
  }else reused=true;
  // Also validates a pre-existing/orphan target; a corrupt target is not replaced.
  checked=validatePDF(out,doi,undefined,undefined,previous.title);
  const item=record({doi,fulltext_path:out,fulltext_sha256:checked.sha256,
    fulltext_source:source,fulltext_access:'browser-manual-ai',fulltext_version:'publisher-version',
    fulltext_identity:checked.identity||null,
    identity_verification:{method:checked.identity?.rule||'DOI printed on first page',
      printed_identifier_verified:!checked.identity||checked.identity.kind==='publisher-title-doi-block',source_file_sha256:checked.sha256}});
  return {doi,status:item.fulltext_status,path:item.fulltext_path,reused,...checked};
}
