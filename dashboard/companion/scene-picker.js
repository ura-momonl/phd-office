/* One scene mount at a time: switching destroys the previous frame loop. */
(function(global){
  'use strict';
  async function mount(root,buttons,status,scenes,options={}){
    let handle=null,current=null,busy=false,destroyed=false;
    const listeners=[];
    async function select(id){
      if(destroyed||busy||id===current)return false;
      const entry=scenes[id];if(!entry)throw new Error('未知场景：'+id);
      busy=true;buttons.forEach(b=>b.disabled=true);
      if(handle){handle.destroy();handle=null;}current=null;
      options.onChange?.(null);
      status.textContent='正在进入 '+entry.label+'…';
      try{
        const next=await global.SceneKit.mount(root,entry.config,{debug:!!options.debug,responsive:!!options.responsive});
        if(destroyed){next.destroy();return false;}
        handle=next;current=id;options.onChange?.(handle);
        next.ready.catch(e=>{if(!destroyed && handle===next){status.textContent='场景素材加载失败：'+e.message;status.hidden=false;}});
        status.textContent=entry.label+' · '+entry.hint;
        buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scene===id)));
        return true;
      }catch(e){status.textContent='场景加载失败：'+e.message;throw e;}
      finally{busy=false;buttons.forEach(b=>b.disabled=destroyed);}
    }
    for(const button of buttons){
      const fn=()=>select(button.dataset.scene).catch(()=>{}); // Error is visible in the status line; no retry.
      button.addEventListener('click',fn);listeners.push([button,fn]);
    }
    const ids=Object.keys(scenes);
    await select(ids[options.randomInitial?Math.floor(Math.random()*ids.length):0]);
    return {select,get current(){return current;},destroy(){
      destroyed=true;handle?.destroy();handle=null;current=null;options.onChange?.(null);
      for(const [button,fn] of listeners){button.removeEventListener('click',fn);button.disabled=true;}
    }};
  }
  global.ScenePicker={mount};
})(window);
