import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {root,read} from '../automation/files.mjs';

export const SPEECH_LIMITS={maxBytes:8*1024*1024,maxSeconds:120};
export function createSpeech({python=read('.runtime/speech/config.json',{}).python,model=read('.runtime/speech/config.json',{}).model,idleMs=10*60*1000,timeoutMs=120000}={}) {
  let worker,pending,idle,busy=false;
  const available=()=>!!(python && model && fs.existsSync(python) && fs.existsSync(path.join(model,'model.bin')));
  function stop() {clearTimeout(idle);const child=worker;worker=undefined;if(pending){pending.reject(new Error('本地转写进程已停止；没有自动重试'));pending=undefined;}child?.stdin.end();child?.kill();}
  function start() {
    if(worker)return;
    const child=spawn(python,['-u',path.join(root,'dashboard/speech-worker.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',OFFICE_SPEECH_MODEL:model,HF_HUB_OFFLINE:'1'}});
    worker=child;let stderr='';
    child.stderr.on('data',d=>stderr=(stderr+d.toString()).slice(-1800));
    const fail=error=>{if(worker!==child)return;worker=undefined;if(pending){pending.reject(error);pending=undefined;}child.stdin.end();child.kill();};
    child.on('error',()=>fail(new Error('无法启动本地语音环境')));
    child.stdin.on('error',()=>fail(new Error('本地语音进程连接中断')));
    child.on('exit',()=>fail(new Error('本地转写失败：'+(stderr.trim() || '进程退出'))));
    createInterface({input:child.stdout}).on('line',line=>{
      if(!pending)return;
      let result;try{result=JSON.parse(line);}catch{return;}
      const p=pending;pending=undefined;
      if(result.error)p.reject(new Error('本地转写失败：'+result.error));
      else if(typeof result.text!=='string')p.reject(new Error('本地转写返回格式无效'));
      else p.resolve(result);
    });
  }
  async function transcribe(bytes,{language}={}) {
    if(!Buffer.isBuffer(bytes) || !bytes.length || bytes.length>SPEECH_LIMITS.maxBytes)throw new Error('录音为空或超过 8 MB；请分段输入');
    if(language && !['zh','en'].includes(language))throw new Error('不支持此语音语言选项');
    if(!available())throw new Error('本地语音模型尚未安装完整');
    if(busy)throw new Error('已有录音正在转写，请稍等');
    busy=true;clearTimeout(idle);let dir,timer;
    try {
      fs.mkdirSync(path.join(root,'.runtime/speech/tmp'),{recursive:true});
      dir=fs.mkdtempSync(path.join(root,'.runtime/speech/tmp/dictation-'));
      const file=path.join(dir,'audio.webm');fs.writeFileSync(file,bytes);
      start();
      return await new Promise((resolve,reject)=>{
        pending={resolve,reject};timer=setTimeout(()=>{stop();reject(new Error('本地转写超时，没有自动重试'));},timeoutMs);
        worker.stdin.write(JSON.stringify({path:file,language:language || null})+'\n');
      });
    }finally {
      clearTimeout(timer);busy=false;
      if(dir)fs.rmSync(dir,{recursive:true,force:true});
      if(worker){idle=setTimeout(stop,idleMs);idle.unref();}
    }
  }
  return {available,transcribe,close:stop,get busy(){return busy;}};
}
