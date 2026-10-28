// Dictation fills the current draft only. It never sends a chat or records system audio.
import {ico} from './icons.js';
export function bindVoiceInput({button,cancel,status,input,getContext,onText,onBusy,maxSeconds=120}) {
  let phase='idle',generation=0,stream,recorder,chunks=[],timer,controller;
  const supported=!!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  function state(next,message) {
    phase=next;status.textContent=message;
    const label=next==='recording' ? '停止并转写' : next==='transcribing' ? '转写中…' : next==='requesting' ? '等待麦克风…' : '语音输入';
    button.innerHTML=ico(next==='recording' ? 'square' : ['requesting','transcribing'].includes(next) ? 'clock' : 'microphone');
    button.dataset.phase=next;button.setAttribute('aria-label',label);button.title=label+'（Ctrl＋Shift）';
    button.disabled=!supported || ['requesting','transcribing'].includes(next);button.setAttribute('aria-pressed',String(next==='recording'));
    cancel.hidden=next==='idle';onBusy(next!=='idle');
  }
  function release() {clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=undefined;}
  function abort(message='已取消语音输入') {
    generation++;controller?.abort();controller=undefined;
    const decoding=phase==='transcribing';
    if(recorder?.state==='recording')recorder.stop();release();chunks=[];state('idle',decoding && message ? '已取消填入草稿；本机已开始的转写可能继续完成' : message);
  }
  async function begin() {
    const id=++generation,context=getContext();state('requesting','请允许麦克风；只在你开始录音后采集');
    try {
      const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(id!==generation || context!==getContext()){media.getTracks().forEach(t=>t.stop());if(id===generation)state('idle','对话已切换，录音已取消');return;}
      stream=media;chunks=[];
      const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
      recorder=new MediaRecorder(media,mime ? {mimeType:mime} : undefined);
      recorder.ondataavailable=e=>{if(id===generation && e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>{if(id===generation)abort('录音失败，请检查麦克风后再试');};
      recorder.onstop=async()=>{
        if(id!==generation)return;release();
        const audio=new Blob(chunks,{type:recorder.mimeType});chunks=[];
        if(!audio.size){state('idle','没有录到声音，请再试一次');return;}
        state('transcribing','正在本机转写；首次加载模型会稍慢，不会自动发送');controller=new AbortController();
        try {
          const response=await fetch('/api/speech/transcribe',{method:'POST',headers:{'Content-Type':audio.type || 'audio/webm'},body:audio,signal:controller.signal});
          const result=await response.json();if(!response.ok)throw new Error(result.error || '本地转写失败');
          if(id!==generation)return;
          if(context!==getContext()){state('idle','对话已切换，未填入转写');return;}
          if(result.text?.trim()) {
            const separator=input.value && !/\s$/.test(input.value) ? '\n' : '';
            input.value+=separator+result.text.trim();onText();input.focus();input.setSelectionRange(input.value.length,input.value.length);
            state('idle','');
          }else state('idle','没有识别到讲话，草稿未改动');
        }catch(error){if(id===generation)state('idle',error.name==='AbortError' ? '已取消语音输入' : error.message);}
        finally{if(id===generation)controller=undefined;}
      };
      recorder.start();state('recording','正在录音 · 再点一次停止，最长 2 分钟');
      timer=setTimeout(()=>{if(id===generation && recorder.state==='recording')recorder.stop();},maxSeconds*1000);
    }catch(error){if(id===generation){release();state('idle',error.name==='NotAllowedError' ? '麦克风权限被拒，请在地址栏的网站权限中允许麦克风' : '无法使用麦克风：'+error.message);}}
  }
  button.onclick=()=>phase==='recording' ? recorder.stop() : void begin();cancel.onclick=()=>abort();
  // Trigger only a bare Ctrl+Shift chord, on release. Ctrl+Shift+V/etc remain untouched.
  let chord=false,chordContext;
  const eligible=()=>button.getClientRects().length && !button.disabled && !input.disabled && !document.querySelector('dialog[open]');
  document.addEventListener('keydown',event=>{
    if(event.key!=='Control' && event.key!=='Shift'){chord=false;return;}
    if(!event.defaultPrevented && !event.repeat && !event.isComposing && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && eligible()) {chord=true;chordContext=getContext();}
  });
  document.addEventListener('keyup',event=>{
    if(!chord || !['Control','Shift'].includes(event.key))return;
    chord=false;if(event.defaultPrevented || event.isComposing || event.altKey || event.metaKey || chordContext!==getContext() || !eligible())return;
    event.preventDefault();button.click();
  });
  window.addEventListener('blur',()=>{chord=false;});
  window.addEventListener('pagehide',()=>abort(''));
  state('idle',supported ? '' : '当前浏览器不能录音，请使用 localhost 或 HTTPS 页面');
  return {get busy(){return phase!=='idle';},cancel:()=>{if(phase!=='idle')abort();}};
}
