import { read, write, input } from '../automation/files.mjs';
const money = value => Number.isFinite(value) && value >= 0;
const cents = value => Math.round((value + Number.EPSILON) * 100);

// Agents extract and interpret sources; this module only checks the recorded facts.
export function inspectQuote(v) {
  const errors = [], missing = [], calculations = [];
  if (!v.name || !v.source || (v.quoted_total != null && !money(v.quoted_total))) errors.push('Vendor name, source and valid amount are required');
  for (const key of ['quote_number','currency','quoted_total','lead_time','valid_until']) if (v[key] == null || v[key] === '') missing.push(key);
  for (const key of ['shipping_included','tax_included']) {
    if (v[key] != null && typeof v[key] !== 'boolean') errors.push(`${key} must be boolean or null`);
    if (v[key] !== true) missing.push(key);
  }
  if (v.technical_match !== 'confirmed') missing.push('technical_match');
  const discount = v.education_discount;
  if (discount != null && (!['unknown','confirmed','not_offered'].includes(discount.status) ||
      (discount.status !== 'unknown' && !discount.evidence?.trim()))) errors.push('education_discount needs a valid status and evidence for a known decision');
  if (!discount || discount.status === 'unknown') missing.push('education_discount');
  const equation = (field, expected, actual) => {
    const matches = expected === cents(actual);
    calculations.push({field, expected: expected / 100, actual, matches});
    if (!matches) errors.push(`${field}: amount mismatch`);
  };
  if (v.items != null && (!Array.isArray(v.items) || !v.items.length)) errors.push('items must be a non-empty array');
  if (!v.items?.length) missing.push('items');
  if (Array.isArray(v.items)) v.items.forEach((item, i) => {
    if (!item || !item.description || !item.part_number || !Number.isFinite(item.quantity) || item.quantity <= 0 ||
        !money(item.unit_price) || !money(item.line_total)) errors.push(`items[${i}]: description, part_number, positive quantity and valid amounts are required`);
    else equation(`items[${i}].line_total`, cents(item.quantity * item.unit_price), item.line_total);
  });
  for (const key of ['subtotal','shipping','tariff','tax']) {
    const amount = v.charges?.[key];
    if (amount == null) missing.push(`charges.${key}`);
    else if (!money(amount)) errors.push(`charges.${key}: invalid amount`);
  }
  if (Array.isArray(v.items) && v.items.length && v.items.every(i => i && money(i.line_total)) && money(v.charges?.subtotal))
    equation('charges.subtotal', v.items.reduce((sum, i) => sum + cents(i.line_total), 0), v.charges.subtotal);
  if (['subtotal','shipping','tariff','tax'].every(k => money(v.charges?.[k])) && money(v.quoted_total))
    equation('quoted_total', ['subtotal','shipping','tariff','tax'].reduce((sum, k) => sum + cents(v.charges[k]), 0), v.quoted_total);
  const amountsComplete = !missing.some(k => k === 'items' || k === 'quoted_total' || k.startsWith('charges.'));
  return {name:v.name, quote_number:v.quote_number, currency:v.currency, quoted_total:v.quoted_total,
    arithmetic:errors.length ? 'invalid' : amountsComplete ? 'matched' : 'unknown', calculations, errors, missing,
    education_discount:discount ?? {status:'unknown'}, commercial_notes:v.commercial_notes ?? [], source:v.source};
}

function requestById(id) {
  const request = read('procurement/catalog.json').requests.find(i => i.id === id);
  if (!request) throw new Error('Unknown procurement request');
  return request;
}

export function check(id) {
  const request = requestById(id);
  return {id:request.id, title:request.title, quotes:request.vendors.map(inspectQuote),
    note:'金额匹配只表示录入数字的乘加一致，不代表原文已自动核验、教育优惠已确认、技术适配或已获采购批准。'};
}

export function compare(id) {
  const request = requestById(id);
  const sameCurrency = !!request.vendors[0]?.currency && request.vendors.every(v => v.currency === request.vendors[0].currency);
  return { request, comparison: request.vendors.map(v => {
    const checked = inspectQuote(v);
    return {...v, comparable:money(v.quoted_total) && sameCurrency && v.shipping_included === true && v.tax_included === true && v.technical_match === 'confirmed' && checked.errors.length === 0,
      missing:checked.missing, errors:checked.errors};
  }), note: '相同规格、数量、币种及费用口径确定后再比较总价；未选择供应商、下单或发送询价。' };
}
export async function run(action, argument) {
  if (action === 'list') console.log(JSON.stringify(read('procurement/catalog.json'), null, 2));
  else if (action === 'check') console.log(JSON.stringify(check(argument), null, 2));
  else if (action === 'compare') console.log(JSON.stringify(compare(argument), null, 2));
  else if (action.startsWith('ece-')) {
    const { runECE } = await import('./ece-workflow.mjs');
    console.log(JSON.stringify(await runECE(action, argument), null, 2));
  }
  else if (action === 'record') {
    const request = input(argument); const catalog = read('procurement/catalog.json');
    if (typeof request.id !== 'string' || !/^[a-z0-9-]+$/.test(request.id) || !request.title || !Array.isArray(request.vendors) || !request.vendors.length) throw new Error('id, title and non-empty vendors are required');
    for (const v of request.vendors) {
      if (!v || typeof v !== 'object') throw new Error('Vendor must be an object');
      const checked = inspectQuote(v);
      if (checked.errors.length) throw new Error(checked.errors.join('; '));
    }
    const index = catalog.requests.findIndex(i => i.id === request.id);
    // purchase_request is written by ece-submit (application id, receipt path, approval); a later record must not erase it.
    if (index >= 0 && request.purchase_request === undefined && catalog.requests[index].purchase_request) request.purchase_request = catalog.requests[index].purchase_request;
    if (index < 0) catalog.requests.push(request); else catalog.requests[index] = request;
    write('procurement/catalog.json', catalog); console.log(JSON.stringify({saved:request.id}));
  } else throw new Error('procurement: list, check <id>, compare <id>, record <json>');
}
