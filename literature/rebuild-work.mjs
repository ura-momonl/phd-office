// The admission ledger owns delivery; the work queue owns execution history.
// Reconcile only an unstarted, single-package formal handoff, never a failed run.
import {read} from '../automation/files.mjs';
import {update} from '../work/run.mjs';
const base='output/literature-rebuild-20261021/';
const names={codex:'Codex',claude:'Claude',deepseek:'DeepSeek'};

export function reconcileRebuildWork(packageId,{apply=false}={}) {
  const state=read(base+'CONTINUE.json');
  if(!state)throw Error('No literature rebuild state');
  const packages=packageId==='all' ? state.packages : state.packages.filter(p=>p.id===packageId);
  if(!packages.length)throw Error('Unknown rebuild package');
  const queue=read('work/queue.json'),results=[];
  let known;
  for(const pkg of packages){
    const candidates=queue.items.filter(t=>!t.deleted_at && ['open','queued'].includes(t.status) &&
      t.executor===pkg.owner && t.actor===pkg.owner &&
      t.title===`${names[pkg.owner]} 正式文献包：${pkg.id}` &&
      pkg.manifest && String(t.goal||'').includes(pkg.manifest));
    if(!candidates.length)continue;
    try {
      const receiptPath=base+`coordinator/admissions/${pkg.id}/receipt.json`;
      const receipt=read(receiptPath);
      if(pkg.status!=='accepted' || !receipt?.catalog_readback_verified || !receipt.state_synced)
        throw Error('Package has no verified, synced admission');
      if(receipt.package!==pkg.id || receipt.owner!==pkg.owner)throw Error('Receipt package/owner mismatch');
      const ledgerPath=base+`coordinator/admissions/${pkg.id}/ledger.json`;
      const ledger=read(ledgerPath),input=read(pkg.input);
      if(!Array.isArray(ledger)||!Array.isArray(input)||ledger.length!==input.length||receipt.records!==input.length ||
        new Set(ledger.map(r=>r.id)).size!==ledger.length || ledger.some((r,i)=>r.id!==input[i].id || !['include','exclude','pending'].includes(r.decision)))
        throw Error('Admission ledger does not cover the package input');
      const pending=ledger.filter(r=>r.decision==='pending').length;
      if(pending){results.push({package:pkg.id,status:'pending',pending,tasks:candidates.map(t=>t.id)});continue;}
      known??=new Set(read(state.catalog).papers.map(p=>String(p.doi||'').toLowerCase()));
      const includes=ledger.filter(r=>r.decision==='include');
      if(includes.some(r=>!r.doi || !known.has(r.doi.toLowerCase())))throw Error('Included DOI is missing from the current catalog');
      for(const candidate of candidates){
        const current=read('work/queue.json').items.find(t=>t.id===candidate.id);
        if(!current || current.deleted_at || !['open','queued'].includes(current.status))continue;
        const handoff=`${pkg.id} 已有入库成果，本派工无需重复执行；这不表示本对话曾实际运行。共 ${ledger.length} 条，收录 ${includes.length} 条、排除 ${ledger.length-includes.length} 条、待核 0 条。入库凭据：${receiptPath}；逐条决定：${ledgerPath}。原派工历史保留。`;
        if(apply)update({id:current.id,status:'done',reason:'文献包已由其他运行交付，依据入库凭据收尾未启动派工；不改写运行失败历史。',
          handoff,outputs:[...new Set([...(current.outputs||[]),receiptPath,ledgerPath]) ]});
        results.push({package:pkg.id,task:current.id,status:apply?'done':'would-complete',previous_status:current.status,records:ledger.length,includes:includes.length,receipt:receiptPath});
      }
    } catch(error){results.push({package:pkg.id,status:'error',error:error.message});}
  }
  return {apply,results};
}

// Admission success is durable even if its separate queue write needs attention.
export function syncAcceptedRebuildWork(packageId) {
  try{return reconcileRebuildWork(packageId,{apply:true});}
  catch(error){return {apply:true,results:[{package:packageId,status:'error',error:error.message}]};}
}
