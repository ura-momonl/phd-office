import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { read, root, write } from '../automation/files.mjs';
import { check, compare, run } from './run.mjs';

// Fictional vendor and sources, reproducing the received-quote arithmetic and unknown discount.
const quote = () => ({name:'Vendor Q', source:'fixture:quote-and-attachment', quote_number:'NEW-2', currency:'USD',
  quoted_total:4094.02, shipping_included:true, tax_included:true, lead_time:null, valid_until:null, technical_match:'待核对',
  items:[
    {description:'Valve',part_number:'V-1',quantity:2,unit_price:240.35,line_total:480.70},
    {description:'Adapter',part_number:'A-1',quantity:1,unit_price:94.21,line_total:94.21},
    {description:'Pump',part_number:'P-1',quantity:1,unit_price:3117.32,line_total:3117.32}],
  charges:{subtotal:3692.23,shipping:41.99,tariff:359.80,tax:0}, education_discount:{status:'unknown',evidence:'No discount statement'},
  commercial_notes:['Tariffs may change at shipment.']});

function withCatalog(fn) {
  const original=read('procurement/catalog.json');
  try {
    write('procurement/catalog.json',{version:1,requests:[{id:'quote-test',title:'Fictional purchase',vendors:[quote()]}]});
    return fn();
  } finally { write('procurement/catalog.json',original); }
}

test('check exposes arithmetic, evidence and unknowns without claiming a discount or technical approval',()=>withCatalog(()=>{
  const result=check('quote-test').quotes[0];
  assert.equal(result.arithmetic,'matched');
  assert.equal(result.calculations.length,5);
  assert.ok(result.calculations.every(c=>c.matches));
  assert.equal(result.calculations.at(-1).expected,4094.02);
  assert.equal(result.education_discount.status,'unknown');
  assert.deepEqual(result.missing,['lead_time','valid_until','technical_match','education_discount']);
  assert.equal(result.source,'fixture:quote-and-attachment');
  assert.equal(result.commercial_notes.length,1);
  assert.equal(compare('quote-test').comparison[0].comparable,false);
}));

test('CLI record replaces the same purchase, survives reread and rejects contradictions without writing',()=>withCatalog(()=>{
  const dir=path.join(root,'.runtime/procurement-tests'); fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'request.json');
  const cli=(...args)=>execFileSync(process.execPath,['automation/run.mjs','procurement',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const request={id:'quote-test',title:'Fictional purchase',vendors:[quote()],notes:'New quote only'};
  fs.writeFileSync(file,JSON.stringify(request));
  assert.equal(JSON.parse(cli('record',file)).saved,'quote-test');
  cli('record',file);
  assert.equal(read('procurement/catalog.json').requests.length,1);
  assert.equal(JSON.parse(cli('check','quote-test')).quotes[0].arithmetic,'matched');
  assert.equal(JSON.parse(cli('list')).requests[0].vendors[0].quote_number,'NEW-2');
  const before=fs.readFileSync(path.join(root,'procurement/catalog.json'),'utf8');
  for (const mutate of [
    v=>{v.items[0].quantity=1;}, // Wrong count, although the grand total still matches.
    v=>{v.charges.subtotal+=1;},
    v=>{v.charges.tariff+=1;},
    v=>{v.quoted_total+=0.01;},
    v=>{v.charges.shipping=-1;},
    v=>{v.education_discount={status:'confirmed'};},
    v=>{v.shipping_included='true';}
  ]) {
    const bad=structuredClone(request); mutate(bad.vendors[0]); fs.writeFileSync(file,JSON.stringify(bad));
    assert.throws(()=>cli('record',file));
    assert.equal(fs.readFileSync(path.join(root,'procurement/catalog.json'),'utf8'),before);
  }
  assert.match(execFileSync(process.execPath,['automation/run.mjs','help','procurement'],{cwd:root,encoding:'utf8'}),/check <请求id>/);
}));

test('unknown fees are not zero; old records remain readable and incomplete prices cannot compare',()=>withCatalog(()=>{
  const catalog=read('procurement/catalog.json'),v=catalog.requests[0].vendors[0];
  v.charges.tariff=null; delete v.items; delete v.quoted_total;
  v.technical_match='confirmed'; write('procurement/catalog.json',catalog);
  const result=check('quote-test').quotes[0];
  assert.equal(result.arithmetic,'unknown');
  assert.ok(result.missing.includes('charges.tariff'));
  assert.equal(result.calculations.length,0);
  assert.equal(compare('quote-test').comparison[0].comparable,false);
}));

test('comparison refuses mixed currencies and invalid arithmetic, but accepts a complete alternative quote',()=>withCatalog(()=>{
  const catalog=read('procurement/catalog.json'),request=catalog.requests[0];
  request.vendors[0].technical_match='confirmed';
  request.vendors.push({...quote(),name:'Vendor R',currency:'EUR',technical_match:'confirmed'});
  write('procurement/catalog.json',catalog);
  assert.ok(compare('quote-test').comparison.every(v=>!v.comparable));
  request.vendors[1].currency='USD'; request.vendors[1].quoted_total=1; write('procurement/catalog.json',catalog);
  assert.equal(compare('quote-test').comparison[1].comparable,false);
  request.vendors[1]=quote(); request.vendors[1].technical_match='confirmed';
  request.vendors[1].items.reverse(); write('procurement/catalog.json',catalog);
  assert.ok(compare('quote-test').comparison.every(v=>v.comparable));
}));

test('partial records can be saved without inventing missing evidence',async()=>{
  const original=read('procurement/catalog.json');
  const file=path.join(root,'.runtime/partial-quote.json');
  try {
    fs.writeFileSync(file,JSON.stringify({id:'partial-test',title:'Unknown offer',vendors:[{name:'Vendor P',source:'fixture',quoted_total:null}]}));
    await run('record',file);
    assert.equal(check('partial-test').quotes[0].arithmetic,'unknown');
  } finally {write('procurement/catalog.json',original);fs.unlinkSync(file);}
});
