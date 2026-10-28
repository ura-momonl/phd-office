// The ECE site's field mapping stays here. Callers provide business facts, not
// Gravity Forms IDs, cookies or arbitrary browser code.
import assert from 'node:assert/strict';
export const ECE = Object.freeze({origin:'https://purchasing.ece.wisc.edu',form:'/index.php/purchase-parts-and-equipment/test-purchase-request/',status:'/index.php/purchase-parts-and-equipment/request-status/'});
const text=s=>String(s??'').replace(/\s+/g,' ').trim();
const numeric=s=>Number(String(s).replace(/[^\d.]/g,''));
const valueFields={first_name:'input_2_2_3',last_name:'input_2_2_6',email:'input_2_3',phone:'input_2_40',vendor:'input_2_26',approved_cost:'input_2_13',business_purpose:'input_2_29',additional_information:'input_2_14'};
const addressFields={street:'input_2_39_1',room:'input_2_39_2',city:'input_2_39_3',zip:'input_2_39_5'};
const selectFields={approver:'input_2_38',spend_category:'input_2_27',worktag:'input_2_6'};

async function select(page,id,label) {
  const field=page.locator('#'+id);
  await field.selectOption({label},{force:!(await field.isVisible())});
  const chosen=page.locator('#'+id+'_chosen');
  if(await chosen.count()) {
    const displayed=chosen.locator('.chosen-single span');
    if(text(await displayed.textContent())!==label) {
      await chosen.locator('.chosen-single').click();
      const search=chosen.locator('.chosen-search input');
      if(await search.isVisible())await search.fill(label);
      // A placeholder may contain the category as an example. Substring matching
      // once selected that placeholder instead of the requested category.
      await chosen.locator('.chosen-results').getByText(label,{exact:true}).click();
    }
    assert.equal(text(await displayed.textContent()),label);
  }
  assert.equal(text(await field.locator('option:checked').textContent()),label);
}

async function noteText(page) {
  if(await page.locator('#field_2_30 iframe').count())return text(await page.frameLocator('#field_2_30 iframe').locator('body').innerText());
  return text(await page.locator('#input_2_30').inputValue());
}

export async function readPrepared(page) {
  const result={shipping:{},items:[]};
  for(const [key,id] of Object.entries(valueFields))result[key]=text(await page.locator('#'+id).inputValue());
  result.phone=result.phone.replace(/\D/g,'');result.approved_cost=numeric(result.approved_cost);
  for(const [key,id] of Object.entries(addressFields))result.shipping[key]=text(await page.locator('#'+id).inputValue());
  for(const [key,id] of Object.entries(selectFields))result[key]=text(await page.locator('#'+id+' option:checked').textContent());
  result.shipping.state=text(await page.locator('#input_2_39_4 option:checked').textContent());
  result.shipping_rate=await page.locator('input[name="input_21"]:checked').inputValue();
  result.capstone=await page.locator('#input_2_50').inputValue();
  result.note_to_approver=await noteText(page);
  const cells=await page.locator('input[name="input_11[]"]').evaluateAll(es=>es.map(e=>e.value));
  assert.equal(cells.length%5,0);
  for(let i=0;i<cells.length;i+=5)result.items.push({quantity:Number(cells[i]),part_number:text(cells[i+1]),description:text(cells[i+2]),link:text(cells[i+3]),unit_price:numeric(cells[i+4])});
  result.attachments=await page.locator('#gform_preview_2_41 .gfield_fileupload_filename').allTextContents();
  return result;
}

export function expectedPage(draft) {
  const result={};
  for(const key of Object.keys(valueFields))result[key]=key==='approved_cost'?draft[key]:text(draft[key]);
  result.phone=result.phone.replace(/\D/g,'');
  result.shipping={};for(const key of [...Object.keys(addressFields),'state'])result.shipping[key]=text(draft.shipping[key]);
  for(const key of Object.keys(selectFields))result[key]=draft[key];
  result.shipping_rate=draft.shipping_rate;result.capstone='N/A';result.note_to_approver=text(draft.note_to_approver);
  result.items=draft.items.map(i=>({quantity:i.quantity,part_number:text(i.part_number),description:text(i.description),link:text(i.link),unit_price:i.unit_price}));
  result.attachments=[draft.attachment.filename];return result;
}

export async function fillAndUpload(page,draft,{onUploading=()=>{},onUploadAccepted=()=>{}}={}) {
  await page.locator('#gform_2').waitFor({state:'visible'});
  for(const [key,id] of Object.entries(valueFields)) {
    const field=page.locator('#'+id),value=String(draft[key]??'');
    // Email is hidden and prefilled by the site; do not force-edit it.
    if(await field.inputValue()!==value)await field.fill(value);
  }
  for(const [key,id] of Object.entries(addressFields))await page.locator('#'+id).fill(draft.shipping[key]);
  for(const [key,id] of Object.entries(selectFields))await select(page,id,draft[key]);
  await select(page,'input_2_39_4',draft.shipping.state);
  await select(page,'input_2_50','N/A');
  await page.locator('input[name="input_21"][value="'+draft.shipping_rate+'"]').check();
  const note=page.locator('#input_2_30');
  if(await note.isVisible())await note.fill(draft.note_to_approver);
  else await page.frameLocator('#field_2_30 iframe').locator('body').fill(draft.note_to_approver);
  // Keep TinyMCE's canonical form control in step, but compare rendered text
  // later: <p> wrappers are not a changed business decision.
  await page.evaluate(()=>globalThis.tinymce?.triggerSave());
  const cells=page.locator('input[name="input_11[]"]');
  assert.equal(await cells.count(),5,'New purchase form must start with one empty item row');
  for(let i=1;i<draft.items.length;i++)await page.locator('#field_2_11').getByRole('button',{name:/add/i}).last().click();
  assert.equal(await cells.count(),draft.items.length*5);
  const values=draft.items.flatMap(i=>[String(i.quantity),i.part_number,i.description,i.link||'',i.unit_price.toFixed(2)]);
  for(let i=0;i<values.length;i++)await cells.nth(i).fill(values[i]);
  await page.locator('#input_2_13').blur();
  // Verify the whole form before the first externally visible upload.
  const before=await readPrepared(page),expected=expectedPage(draft);
  assert.equal(before.attachments.length,0,'Refuse to upload over existing attachments');
  assert.deepEqual({...before,attachments:expected.attachments},expected);
  onUploading();
  const responsePromise=page.waitForResponse(response=>{
    const request=response.request();
    return new URL(response.url()).origin===new URL(page.url()).origin && request.method()==='POST' && request.postDataBuffer()?.includes(Buffer.from(draft.attachment.filename));
  },{timeout:45000});
  responsePromise.catch(()=>{}); // Preserve the original failure if setInputFiles itself fails.
  // Exactly one setInputFiles: an uncertain response is not retried.
  await page.locator('#field_2_41 input[type="file"]').setInputFiles(draft.attachment.path);
  const response=await responsePromise,body=await response.json();
  assert.equal(response.ok(),true,'Attachment upload HTTP failure');
  assert.equal(body.status,'ok','Uploader did not accept the file');
  onUploadAccepted({filename:draft.attachment.filename,http_status:response.status(),server_status:body.status,sha256:draft.attachment.sha256,size:draft.attachment.size});
  await page.locator('#gform_preview_2_41').getByText(draft.attachment.filename,{exact:true}).waitFor({state:'visible',timeout:15000});
  const actual=await readPrepared(page);assert.deepEqual(actual,expected);
  return {fields:actual,attachment:{filename:draft.attachment.filename,sha256:draft.attachment.sha256,size:draft.attachment.size,http_status:response.status(),server_status:body.status,ui_verified:true}};
}

export async function requestRows(page,site=ECE) {
  await page.goto(site.origin+site.status,{waitUntil:'domcontentloaded',timeout:30000});
  if(new URL(page.url()).origin!==site.origin)throw new Error('Status page needs authentication');
  return page.locator('tr').evaluateAll(rows=>rows.map(row=>{
    const cells=[...row.querySelectorAll('td')].map(c=>c.innerText.trim());
    const href=row.querySelector('a')?.href;
    return {id:cells[0],date:cells[1],submitter:cells[2],step:cells[3],status:cells[4],vendor:cells[5],url:href};
  }).filter(row=>/^\d+$/.test(row.id)));
}

export async function submitOnce(page,draft,{beforeClick,onAttempt,site=ECE,timeout=45000}={}) {
  assert.equal(new URL(page.url()).origin,site.origin);
  await page.evaluate(()=>globalThis.tinymce?.triggerSave());
  assert.deepEqual(await readPrepared(page),expectedPage(draft),'Live form no longer matches the approved preview');
  if(beforeClick)await beforeClick();
  // onAttempt persists an exclusive marker BEFORE clicking. Callers must keep
  // that marker even after timeouts, validation errors or a lost connection.
  onAttempt();
  const startPath=new URL(page.url()).pathname;
  const confirmation=page.locator('#gform_confirmation_message_2, #gform_confirmation_wrapper_2').first();
  const validation=page.locator('.gform_validation_errors, .validation_error, .gfield_validation_message');
  const outcome=Promise.race([
    confirmation.waitFor({state:'visible',timeout}).then(()=>'confirmation',()=>null),
    validation.first().waitFor({state:'visible',timeout}).then(()=>'validation',()=>null),
    page.waitForURL(url=>url.pathname!==startPath,{timeout,waitUntil:'domcontentloaded'}).then(()=>'navigation',()=>null)
  ]);
  await page.locator('#gform_submit_button_2').click({timeout:10000});
  const observed=await outcome;
  const message=await confirmation.innerText({timeout:1000}).catch(()=>null);
  const errors=(await validation.allTextContents()).filter(s=>s.trim());
  return {confirmed:!!message?.trim()&&!errors.length,observed,confirmation:message,validation_errors:errors,url:new URL(page.url()).origin+new URL(page.url()).pathname};
}
