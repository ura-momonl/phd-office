// Settings → 头像: one row of four avatars. "更换" picks a picture and opens a round crop window (drag to move, slider or wheel to zoom);
// 确定 uploads the cropped square, and /avatars/view.css swaps it in everywhere. "还原默认" deletes the upload.
const NAMES={user:'你',codex:'Codex',claude:'Claude',deepseek:'DeepSeek'};
const SRC={user:'/avatars/user.webp',codex:'/avatars/codex.webp',claude:'/avatars/claude.webp',deepseek:'/avatars/deepseek.png'};
const RING={user:'#b9c4bc',codex:'#2aa397',claude:'#e0602e',deepseek:'#4d78d8'};
const STAGE=260,OUT=256,MAX_ZOOM=4;
const refresh=()=>{document.getElementById('avatar-view').href='/avatars/view.css?v='+Date.now();};
async function post(body) {
  const res=await fetch('/api/avatars/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const out=await res.json();if(!res.ok)throw new Error(out.error || '保存失败');return out;
}
// Crop window. Resolves to a data URL of the square the user framed, or null when cancelled.
function crop(bitmap,name) {
  return new Promise(resolve=>{
    const box=document.createElement('div');box.className='avatar-crop-backdrop';
    box.innerHTML=`<div class="avatar-crop" role="dialog" aria-label="调整${name}的头像"><h3>调整${name}的头像</h3><canvas width="${STAGE}" height="${STAGE}"></canvas><p class="muted">拖动图片移动位置，滑块或滚轮缩放。</p><input type="range" min="100" max="${MAX_ZOOM*100}" value="100" aria-label="缩放"><div class="avatar-crop-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="secondary primary" data-ok>确定</button></div></div>`;
    document.body.append(box);
    const canvas=box.querySelector('canvas'),zoom=box.querySelector('input'),ctx=canvas.getContext('2d');
    const base=STAGE/Math.min(bitmap.width,bitmap.height);let k=1,ox=(STAGE-bitmap.width*base)/2,oy=(STAGE-bitmap.height*base)/2;
    const fit=()=>{const s=base*k;ox=Math.min(0,Math.max(STAGE-bitmap.width*s,ox));oy=Math.min(0,Math.max(STAGE-bitmap.height*s,oy));};
    const draw=(c=ctx,f=1)=>{const s=base*k;c.clearRect(0,0,STAGE*f,STAGE*f);c.drawImage(bitmap,ox*f,oy*f,bitmap.width*s*f,bitmap.height*s*f);};
    const setZoom=next=>{ // zoom about the window centre
      const old=base*k,cx=(STAGE/2-ox)/old,cy=(STAGE/2-oy)/old;k=Math.min(MAX_ZOOM,Math.max(1,next));zoom.value=Math.round(k*100);
      ox=STAGE/2-cx*base*k;oy=STAGE/2-cy*base*k;fit();draw();
    };
    fit();draw();
    zoom.addEventListener('input',()=>setZoom(zoom.value/100));
    canvas.addEventListener('wheel',e=>{e.preventDefault();setZoom(k*(e.deltaY<0 ? 1.08 : 1/1.08));},{passive:false});
    let drag=null;
    canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,ox,oy};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{if(!drag)return;ox=drag.ox+e.clientX-drag.x;oy=drag.oy+e.clientY-drag.y;fit();draw();});
    canvas.addEventListener('pointerup',()=>{drag=null;});
    const done=value=>{box.remove();document.removeEventListener('keydown',esc);resolve(value);};
    const esc=e=>{if(e.key==='Escape')done(null);};document.addEventListener('keydown',esc);
    box.addEventListener('click',e=>{
      if(e.target===box || e.target.closest('[data-cancel]'))done(null);
      else if(e.target.closest('[data-ok]')){
        const out=document.createElement('canvas');out.width=out.height=OUT;draw(out.getContext('2d'),OUT/STAGE);done(out.toDataURL('image/webp',0.92));
      }
    });
    box.querySelector('[data-ok]').focus();
  });
}
export async function mountAvatarTuner(root) {
  const r=await fetch('/api/avatars'),data=await r.json();
  if(!r.ok)throw new Error(data.error || '头像设置读取失败');
  let view=data.view;
  const html=()=>Object.keys(NAMES).map(who=>`<div class="avatar-item" data-who-item="${who}"><img class="avatar-preview" data-who="${who}" src="${SRC[who]}" width="96" height="96" alt="" style="border:3px solid ${RING[who]}"><strong>${NAMES[who]}</strong><span class="avatar-actions"><button type="button" class="secondary" data-avatar-upload>更换</button><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="text-button" data-avatar-original ${view[who].custom ? '' : 'hidden'}>还原默认</button></span><span class="muted avatar-status" role="status"></span></div>`).join('');
  root.className='avatar-row';root.innerHTML=html();
  async function apply(item,image,message) {
    const status=item.querySelector('.avatar-status');
    try {view=(await post({who:item.dataset.whoItem,image})).view;item.querySelector('[data-avatar-original]').hidden=!view[item.dataset.whoItem].custom;refresh();status.textContent=message;}
    catch(e) {status.textContent=e.message;}
  }
  root.addEventListener('change',async e=>{
    if(e.target.type!=='file')return;
    const item=e.target.closest('.avatar-item'),file=e.target.files[0];e.target.value='';if(!file)return;
    let bitmap;try {bitmap=await createImageBitmap(file);} catch {item.querySelector('.avatar-status').textContent='这张图片读不出来，请换 PNG、JPEG 或 WebP';return;}
    const image=await crop(bitmap,NAMES[item.dataset.whoItem]);if(image)await apply(item,image,'已更换');
  });
  root.addEventListener('click',e=>{
    const item=e.target.closest('.avatar-item');if(!item)return;
    if(e.target.closest('[data-avatar-upload]'))item.querySelector('input[type=file]').click();
    else if(e.target.closest('[data-avatar-original]'))void apply(item,null,'已还原默认头像');
  });
}
