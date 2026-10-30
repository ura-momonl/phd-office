import {spawn} from 'node:child_process';
import path from 'node:path';
import {root} from '../automation/files.mjs';
// 设置 → 更新：运行 scripts/github-update.mjs，预览或应用 GitHub 上的增量更新。只在用户点按钮时运行，没有定时联网。
let busy=false;
export function runGithubUpdate(apply,{script=path.join(root,'scripts','github-update.mjs'),cwd=root,timeoutMs=180000}={}) {
  if(busy)return Promise.reject(new Error('更新正在进行，请稍候'));
  busy=true;
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[script,...(apply ? ['--apply'] : [])],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';const take=d=>{out+=d;if(out.length>60000)out=out.slice(-60000);};
    child.stdout.on('data',take);child.stderr.on('data',take);
    const timer=setTimeout(()=>{out+='\n更新超时，已中止。';child.kill();},timeoutMs);
    const end=ok=>{clearTimeout(timer);busy=false;resolve({ok,apply,output:out.trim()});};
    child.on('error',e=>{out+=e.message;end(false);});
    child.on('close',code=>end(code===0));
  });
}
