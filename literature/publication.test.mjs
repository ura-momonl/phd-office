import test,{describe,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,read,write} from '../automation/files.mjs';
import {record} from './run.mjs';
import {validatePDF} from './fetch.mjs';
import {registerDownload} from './register-download.mjs';
import {spawnSync} from 'node:child_process';
if(process.env.PHD_ISOLATED_TESTS!=='1')throw Error('Use the isolated literature test runner');
const doi='10.5555/publication-fixture',title='Quantum sample transport under controlled strain';
const baseline=read('literature/catalog.json');
const input=path.join(root,'.runtime','publication-input.pdf');
const out=path.join(root,'literature/fulltext','doi-'+createHash('sha256').update(doi).digest('hex').slice(0,16)+'.pdf');
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function pdf(pages,{metaTitle,subject}={}){
  const esc=s=>s.replace(/[\\()]/g,'\\$&');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const text of pages){
    const index=objects.length+1;
    const content=text.split('\n').map((line,i)=>`BT /F1 10 Tf 40 ${740-i*14} Td (${esc(line)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${index+1} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let info='';if(metaTitle!==undefined||subject!==undefined){objects.push(`<< /Title (${esc(metaTitle||'')}) /Subject (${esc(subject||'')}) >>`);info=` /Info ${objects.length} 0 R`;}
  let body='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(body+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`);
}
const save=(pages,meta)=>fs.writeFileSync(input,pdf(pages,meta));
describe('publication identity and browser registration',()=>{
beforeEach(()=>{write('literature/catalog.json',{...baseline,papers:[]});fs.mkdirSync(path.dirname(input),{recursive:true});fs.mkdirSync(path.dirname(out),{recursive:true});record({doi,title,authors:['Alice Kepler','Bruno Maxwell'],year:2020});});
afterEach(()=>{write('literature/catalog.json',baseline);for(const f of [input,out])if(fs.existsSync(f))fs.unlinkSync(f);});

test('publisher end sheet requires its own title and exact DOI field; cached reuse stays hash bound',()=>{
  save([title+'\nAlice Kepler and Bruno Maxwell\nResearch body',title+'\nAlice Kepler and Bruno Maxwell\nJournal 12 (3), DOI: '+doi]);
  const r=validatePDF(input,doi,undefined,undefined,title);assert.equal(r.identity.kind,'publisher-title-doi-block');assert.equal(r.identity.doi_page,2);
  registerDownload(doi,input);assert.equal(read('literature/catalog.json').papers[0].identity_verification.printed_identifier_verified,true);
  assert.equal(validatePDF(input,doi,r.sha256,r.identity).sha256,r.sha256);
  fs.appendFileSync(input,'changed');assert.throws(()=>validatePDF(input,doi,r.sha256,r.identity),/hash differs/);
});
test('macro CLI rejects an orphan with the incident identity failure without replacing it or linking it',()=>{
  fs.writeFileSync(out,pdf(['Different research paper\n10.5555/unrelated']));
  const before=hash(out);
  const r=spawnSync(process.execPath,[path.join(root,'literature/mouse-download.mjs'),'local',doi],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,1,r.stderr);
  const result=JSON.parse(r.stdout);assert.equal(result.status,'validation_failed');assert.match(result.message,/Requested DOI is not verified/);
  assert.equal(hash(out),before);assert.equal(read('literature/catalog.json').papers[0].fulltext_path,null);
});
test('a shared-page article can bind its title to its later Published online DOI block',()=>{
  save(['Another short article\n10.5555/other\n'+title+'\nAlice Kepler', 'Article ending\nPublished online: 12 March 2020\nhttps://doi.org/'+doi+'\nReferences\n1. A cited work']);
  const r=validatePDF(input,doi,undefined,undefined,title);assert.equal(r.identity.doi_page,2);
});
test('a cited target title and DOI in references are not a publication identity block',()=>{
  save([title+'\nResearch body','References\n'+title+'\nDOI: '+doi+'\nPublished online: 12 March 2020\nhttps://doi.org/'+doi]);
  assert.throws(()=>validatePDF(input,doi,undefined,undefined,title),/Requested DOI/);
});
test('an unlabelled DOI on a later page does not satisfy title-bound publication evidence',()=>{
  save([title,'A reference DOI https://doi.org/'+doi]);assert.throws(()=>validatePDF(input,doi,undefined,undefined,title),/Requested DOI/);
});
test('a mismatched first-page title is rejected even with the target end-sheet title and DOI',()=>{
  save(['A different research article',title+'\nDOI: '+doi]);assert.throws(()=>validatePDF(input,doi,undefined,undefined,title),/Requested DOI/);
});
test('a mismatched publication DOI is rejected despite a matching title',()=>{
  save([title,title+'\nDOI: 10.5555/wrong']);assert.throws(()=>validatePDF(input,doi,undefined,undefined,title),/Requested DOI/);
});
test('metadata-only DOI requires matching visible title, exact PDF Title and a sole DOI-labelled Subject',()=>{
  save([title+'\nEditorial content'],{metaTitle:title,subject:'Journal, doi:'+doi});
  const r=validatePDF(input,doi,undefined,undefined,title);assert.equal(r.identity.kind,'pdf-title-doi-metadata');
  for(const meta of [{metaTitle:'Another title',subject:'Journal, doi:'+doi},{metaTitle:title,subject:'Journal, doi:10.5555/wrong'},{metaTitle:title,subject:'doi:'+doi+' doi:10.5555/other'}]){
    save([title],meta);assert.throws(()=>validatePDF(input,doi,undefined,undefined,title),/Requested DOI/);
  }
});
test('browser registration is idempotent and never replaces verified existing fulltext',()=>{
  save([doi]);const first=registerDownload(doi,input);const stored=fs.readFileSync(out),stamp=fs.statSync(out).mtimeMs;
  assert.equal(first.reused,false);save(['10.5555/wrong']);const second=registerDownload(doi,input);
  assert.equal(second.reused,true);assert.deepEqual(fs.readFileSync(out),stored);assert.equal(fs.statSync(out).mtimeMs,stamp);
  assert.equal(read('literature/catalog.json').papers.length,1);
});
test('an existing verified orphan target is reused and attached to its DOI without rewriting the file',()=>{
  save([doi]);fs.copyFileSync(input,out);const stamp=fs.statSync(out).mtimeMs,sha=hash(out);
  const r=registerDownload(doi,input);assert.equal(r.reused,true);assert.equal(fs.statSync(out).mtimeMs,stamp);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_sha256,sha);
});
test('a wrong orphan target is not overwritten by a correct incoming file',()=>{
  save([doi]);fs.writeFileSync(out,pdf(['10.5555/wrong']));const bytes=fs.readFileSync(out);
  assert.throws(()=>registerDownload(doi,input),/Requested DOI/);assert.deepEqual(fs.readFileSync(out),bytes);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_path,null);
});
test('a wrong fresh download never becomes a target or catalog fulltext',()=>{
  save(['10.5555/wrong']);assert.throws(()=>registerDownload(doi,input),/Requested DOI/);assert.equal(fs.existsSync(out),false);
  assert.equal(read('literature/catalog.json').papers[0].fulltext_path,null);
});
test('a changed registered file fails hash verification and is not overwritten',()=>{
  save([doi]);registerDownload(doi,input);fs.appendFileSync(out,'changed');
  assert.throws(()=>registerDownload(doi,input),/hash differs/);assert.match(fs.readFileSync(out,'utf8'),/changed$/);
});
});
