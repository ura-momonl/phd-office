// Read-only npm metadata check. The backend's existing beat owns scheduling;
// this module never installs packages, launches agents or changes DSH profiles.
import fs from 'node:fs';
import path from 'node:path';
import {root,read,write} from '../../automation/files.mjs';
import {enqueue,update} from '../../work/run.mjs';

const stateFile='.runtime/deepseek-harness/updates.json';
const installedFile=path.join(root,'.runtime/deepseek-harness/npm/node_modules/@deepseek-ai/dsh/package.json');
export const registry='https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags';
const DAY=864e5,noticeId='dsh-update-available';
let checking;

function version(text) {
  const m=typeof text==='string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/.exec(text);
  if(!m)throw new Error('Invalid DSH version');
  return {core:m.slice(1,4).map(BigInt),pre:m[4]?.split('.')};
}
export function compareVersions(a,b) {
  const x=version(a),y=version(b);
  for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return x.core[i]>y.core[i]?1:-1;
  if(!x.pre || !y.pre)return x.pre ? -1 : y.pre ? 1 : 0;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {
    const l=x.pre[i],r=y.pre[i];
    if(l===r)continue;
    if(l===undefined || r===undefined)return l===undefined?-1:1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r);
    if(ln && rn){if(BigInt(l)!==BigInt(r))return BigInt(l)>BigInt(r)?1:-1;continue;}
    if(ln!==rn)return ln?-1:1;
    return l>r?1:-1;
  }
  return 0;
}
export function availableUpdate(installed,tags) {
  version(installed);
  if(!tags || typeof tags!=='object' || Array.isArray(tags) || !tags.latest)throw new Error('npm dist-tags not recognized');
  const candidates=['latest','next'].filter(channel=>tags[channel]!==undefined).map(channel=>{
    version(tags[channel]);return {channel,version:tags[channel]};
  }).filter(c=>compareVersions(c.version,installed)>0).sort((a,b)=>compareVersions(b.version,a.version));
  return candidates.length ? {version:candidates[0].version,channels:candidates.filter(c=>c.version===candidates[0].version).map(c=>c.channel)} : null;
}
export const updateStatus=()=>read(stateFile,null);

function notify(report,previous) {
  let item=read('work/queue.json').items.find(i=>i.id===noticeId);
  if(!report.available) {
    if(item && !item.deleted_at && item.review?.state==='pending')update({id:noticeId,status:'done',handoff:`本机 DSH ${report.installed}；latest / next 当前没有比它更新的版本。`,review:{...item.review,state:'accepted'}});
    return null;
  }
  const key=report.installed+'->'+report.available.version;
  if(previous?.notified===key || item?.deleted_at)return key;
  if(!item)item=enqueue({title:'DSH 发现新版',kind:'decision',actor:'user',status:'open',
    goal:'仅提醒 DSH 新版，不自动安装。',sources:[registry,stateFile]},{internalId:noticeId,modelDefaults:false});
  update({id:item.id,status:'waiting_user',reason:'检测到新的 DSH 版本',
    handoff:`本机：${report.installed}；latest：${report.tags.latest}；next：${report.tags.next || '未发布'}。发现 ${report.available.version}（${report.available.channels.join(' / ')} 通道）。只检测并提醒，未安装。升级会替换 npm 包；请核对运行中消息追加和小鱼推理强度的本地补丁。`,
    review:{state:'pending',kind:'decision',reason:'自动版本检测；不调用模型、不自动升级',actions:[
      {id:'accept',type:'accept',label:'知道了'},
      {id:'compatibility',type:'reply',label:'检查升级兼容性',reply:'请检查 DSH 新版与现有三处本地补丁的兼容性，先报告结果，不安装升级。'}
    ]}});
  return key;
}

export async function checkUpdates({force=false,now=Date.now(),fetchImpl=globalThis.fetch}={}) {
  if(process.env.PHD_ISOLATED_TESTS==='1' && fetchImpl===globalThis.fetch)return {skipped:'isolated tests'};
  if(!force && read('software/deepseek-harness/update-policy.json',{}).enabled!==true)return {skipped:'disabled'};
  if(!fs.existsSync(installedFile))return {skipped:'DSH not installed'};
  if(checking)return checking;
  const previous=updateStatus();
  if(!force && now<Date.parse(previous?.next_check_at))return {skipped:'not due',...previous};
  checking=(async()=>{
    const report={...previous,checked_at:new Date(now).toISOString(),next_check_at:new Date(now+DAY).toISOString(),source:registry,automatic_install:false,error:null};
    try {
      report.installed=JSON.parse(fs.readFileSync(installedFile,'utf8')).version;
      const response=await fetchImpl(registry,{signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.ok)throw new Error(`npm HTTP ${response.status}`);
      const tags=await response.json();
      const available=availableUpdate(report.installed,tags);
      report.tags={latest:tags.latest,...(tags.next?{next:tags.next}:{})};
      report.available=available;
      report.notified=notify(report,previous);
    } catch(error) {report.error=String(error.message).slice(0,300);}
    write(stateFile,report);
    return report;
  })();
  try{return await checking;}finally{checking=null;}
}
