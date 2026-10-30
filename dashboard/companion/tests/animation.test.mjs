// Deterministic engine tests, not a browser/visual acceptance substitute.
import test,{describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {companionPackage} from '../../companion-assets.mjs';
const base=companionPackage()?.directory;
if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run only in a sanitised test copy');
async function fixture({debug=false,width=1100,character,roam=false,lighting=true,weather=true,randomSeed=123,random,responsive=false,scene='store'}={}){
  let now=0,rafId=0,resize,mainCanvas,seed=randomSeed;const queue=new Map(),draws=[],scales=[],translations=[],ops=[];
  const contexts=[];
  const make=tag=>{
    const node={tag,style:{},dataset:{},children:[],classList:{set:new Set(),contains(s){return this.set.has(s);},add(...s){s.forEach(v=>this.set.add(v));},remove(...s){s.forEach(v=>this.set.delete(v));}},append(...s){this.children.push(...s);},addEventListener(event,fn){this[event]=fn;},removeEventListener(event,fn){if(this[event]===fn)delete this[event];},setAttribute(key,value){this[key]=value;},getBoundingClientRect(){return {left:0,top:0,width:parseFloat(this.style.width)||344,height:parseFloat(this.style.height)||192};}};
    Object.defineProperty(node,'innerHTML',{get(){return this._html||'';},set(v){this._html=v;this.children.length=0;}});
    if(tag==='canvas'&&!mainCanvas)mainCanvas=node;
    const main=()=>node.className==='sk-canvas';
    const ctx={imageSmoothingEnabled:true,globalCompositeOperation:'source-over',gradients:[],
      clearRect(){if(main()){draws.length=0;scales.length=0;translations.length=0;ops.length=0;}},
      drawImage(im,x,y,...args){ctx.imageCalls?.push({im,x,y,width:args[0],height:args[1],alpha:ctx.globalAlpha,mode:ctx.globalCompositeOperation,fillCount:ctx.fillCalls?.length||0});if(main()){draws.push({src:im.src||im.source,x,y});ops.push({kind:'image',src:im.src||im.source,im});}else{node.source=im.src||im.source;ctx.lastDraw={src:node.source,mode:ctx.globalCompositeOperation};}},
      createRadialGradient(...args){const g={args,stops:[],addColorStop(at,color){this.stops.push([at,color]);}};ctx.gradients.push(g);return g;},
      beginPath(){},ellipse(x,y,rx,ry){if(main())ops.push({kind:'shadow',x,y,rx,ry});},fill(){},save(){},restore(){},translate(x,y){if(main())translations.push([x,y]);},scale(x,y){if(main())scales.push([x,y]);},moveTo(){},lineTo(){},closePath(){},stroke(){},
      fillRect(...args){ctx.lastFill={style:ctx.fillStyle,mode:ctx.globalCompositeOperation};ctx.fillCalls?.push({...ctx.lastFill,args,src:node.source});},fillText(){}};
    node.getContext=()=>ctx;if(tag==='canvas')contexts.push({node,ctx});return node;
  };
  class Image {set src(value){this._src=value;const b=fs.readFileSync(path.join(base,value));this.naturalWidth=b.readUInt32BE(16);this.naturalHeight=b.readUInt32BE(20);queueMicrotask(()=>this.onload());}get src(){return this._src;}}
  const math=Object.create(Math);math.random=random||(()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;});
  const win={};const context=vm.createContext({window:win,Math:math,Image,document:{createElement:make},performance:{now:()=>now},console,requestAnimationFrame:fn=>{const id=++rafId;queue.set(id,fn);return id;},cancelAnimationFrame:id=>queue.delete(id),ResizeObserver:class {constructor(fn){resize=fn;}observe(){}disconnect(){}}});
  vm.runInContext(fs.readFileSync(path.join(base,'scene-kit.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'scenes/store.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'scenes/hall.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'scenes/postapocalyptic.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(base,'scene-picker.js'),'utf8'),context);
  const cfg={store:win.SCENE_STORE,hall:win.SCENE_HALL,'sunset-diner':win.SCENE_SUNSET_DINER,'rainy-station':win.SCENE_RAINY_STATION}[scene];
  if(character){cfg.player.character=character;delete cfg.player.idleExtras;} // Exercise the public character configuration, not NPC auto-walk.
  if(!roam)for(const n of cfg.npcs)delete n.roam;
  if(!lighting)delete cfg.lighting;
  if(!weather)delete cfg.weather;
  const root=make('root');root.clientWidth=width;
  const handle=await win.SceneKit.mount(root,cfg,{debug,responsive});
  await handle.ready;
  const [cv,bubble]=root.children[0].children;
  function step(ms){now+=ms;const pending=[...queue.values()];queue.clear();for(const fn of pending)fn(now);}
  function click(x,y){const r=cv.getBoundingClientRect();cv.click({clientX:x*r.width/344,clientY:y*r.height/192});}
  function moveToStart(){handle.player.path=null;handle.player.onArrive=null;handle.player.x=160;handle.player.y=120;}
  return {handle,cv,bubble,draws,scales,translations,ops,contexts,root,queue,step,click,moveToStart,win,make,resize:()=>resize()};
}
describe('optional personal scene animation', {skip:!base},()=>{
test('station fine rain is all in front; stronger fog stays behind, with masks and lifecycle intact',async()=>{
  const t=await fixture({scene:'rainy-station'});t.step(0);
  const firstShadow=t.ops.findIndex(o=>o.kind==='shadow');
  const layer=t.ops[firstShadow-1].im;
  const {ctx}=t.contexts.find(c=>c.node===layer);
  assert.equal(layer.width,344);assert.equal(layer.height,192);
  assert.equal(ctx.lastDraw.mode,'destination-in');
  assert.equal(ctx.lastDraw.src,'assets/rainy-station/bg.png');
  assert.equal(ctx.globalCompositeOperation,'source-over');
  assert.equal(t.ops[0].kind,'image');assert.equal(t.ops[1].im,layer);
  assert.equal(t.ops.at(-1).im,layer,'front rain is composited after sprites and glow, below the DOM bubble');
  assert.ok(t.ops.filter(o=>o.src?.includes('/chars/')).every(o=>t.ops.indexOf(o)>firstShadow));
  ctx.fillCalls=[];ctx.imageCalls=[];t.step(0);
  const rain0=ctx.fillCalls.map(f=>f.args),fog0=ctx.imageCalls.slice(0,3).map(d=>[d.x,d.y,d.width,d.height,d.alpha]);
  const trails=calls=>Array.from({length:104},(_,i)=>{
    const parts=calls.slice(i*4,i*4+4);
    return {x:parts[0].args[0],y:parts[0].args[1],length:parts.reduce((n,p)=>n+p.args[3],0),
      alpha:parts.map(p=>Number(p.style.slice(p.style.lastIndexOf(',')+1,-1)))};
  });
  const initial=trails(ctx.fillCalls);
  assert.equal(rain0.length,104*4);assert.equal(ctx.imageCalls.length,5,'fog and front rain get separate alpha masks');
  assert.equal(ctx.imageCalls[3].fillCount,0,'the behind-person pass contains only fog, not any rain');
  assert.equal(ctx.imageCalls[4].fillCount,104*4,'ALL 104 drops are drawn in the front pass');
  assert.ok(ctx.imageCalls.slice(0,3).every(d=>d.width>d.height*3&&d.alpha>=.72&&d.alpha<=1),'low, softly varying fog wisps');
  assert.ok(ctx.imageCalls.slice(3).every(d=>d.alpha===1),'mask and rain opacity are not affected by fog modulation');
  assert.ok(ctx.fillCalls.every(f=>f.args[2]===1),'all trails remain one pixel thin');
  assert.ok(initial.every(d=>d.length>=18&&d.length<=34));
  assert.deepEqual(Array.from(t.win.SCENE_RAINY_STATION.weather.fog,p=>p.alpha),[.35,.35,.245]);
  assert.equal(t.contexts.filter(c=>c.ctx.gradients.some(g=>g.stops[0][1].startsWith('rgba(185,197,205,'))).length,3,'fog color is visibly lighter than before');
  assert.ok(initial.every(d=>d.alpha.every((a,i)=>!i||a>d.alpha[i-1])),'tail fades instead of a uniform bar');
  assert.ok(new Set(initial.map(d=>d.length)).size>=10,'many independent lengths, not one fixed streak');
  assert.ok(new Set(initial.map(d=>d.alpha[3].toFixed(3))).size>=40,'many independent brightnesses');
  assert.ok(new Set(initial.map(d=>d.x)).size>=70,'scattered x positions');
  assert.ok(ctx.imageCalls.slice(3).every(d=>d.mode==='destination-in'));
  ctx.fillCalls=[];ctx.imageCalls=[];t.step(50);
  const moved=trails(ctx.fillCalls).map((d,i)=>d.y-initial[i].y).filter(d=>d>=11&&d<=20);
  assert.ok(moved.length>=80,'most drops advance 11–20px in 50ms, once per frame; reset drops are excluded');
  assert.ok(new Set(moved).size>=6,'drops have independent fast speeds, not a shared scrolling pattern');
  for(let frame=0;frame<300;frame++){
    ctx.fillCalls=[];ctx.imageCalls=[];t.step(16);
    assert.equal(ctx.fillCalls.length,104*4);assert.equal(ctx.imageCalls.length,5);
    assert.equal(t.queue.size,1,'weather adds no independent animation loop');
    assert.ok(ctx.fillCalls.every(f=>f.args[2]===1&&f.args[0]>=0&&f.args[0]<384&&f.args[1]>=-82&&f.args[1]<226));
  }
  assert.notDeepEqual(ctx.fillCalls.map(f=>f.args),rain0);
  assert.notDeepEqual(trails(ctx.fillCalls).map(d=>d.length),initial.map(d=>d.length),'recycling re-samples lengths, not the same periodic lattice');
  assert.notDeepEqual(ctx.imageCalls.slice(0,3).map(d=>[d.x,d.y,d.width,d.height,d.alpha]),fog0);
  const gradients=t.contexts.reduce((n,c)=>n+c.ctx.gradients.length,0);
  t.step(16);assert.equal(t.contexts.reduce((n,c)=>n+c.ctx.gradients.length,0),gradients,'fog shapes are cached');
  t.handle.destroy();assert.equal(t.queue.size,0);
  const calls=ctx.imageCalls.length;t.step(1000);assert.equal(ctx.imageCalls.length,calls);
});

test('random weather does not consume companion randomness or change their behavior',async()=>{
  const run=async weather=>{
    let calls=0;const t=await fixture({scene:'rainy-station',roam:true,weather,random:()=>{calls++;return .3;}});
    for(let i=0;i<600;i++)t.step(16);
    const result={calls,pose:t.handle.npcs[0].pose,x:t.handle.npcs[0].x,y:t.handle.npcs[0].y,roamAt:t.handle.npcs[0].roamAt};
    t.handle.destroy();return result;
  };
  assert.deepEqual(await run(true),await run(false));
});

test('other scenes keep rain/fog absent and render their own background ambience',async()=>{
  for(const scene of ['store','hall','sunset-diner']){
    const t=await fixture({scene});t.step(0);
    const firstShadow=t.ops.findIndex(o=>o.kind==='shadow');
    assert.equal(firstShadow,2,'background and ambience precede floor shadows');
    const layer=t.ops[1].im,{ctx}=t.contexts.find(c=>c.node===layer);
    assert.equal(ctx.lastDraw.mode,'destination-in');
    const count={store:0,hall:24,'sunset-diner':42}[scene];
    ctx.fillCalls=[];ctx.imageCalls=[];t.step(0);
    assert.equal(ctx.fillCalls.length,count);assert.equal(ctx.imageCalls.length,scene==='sunset-diner'?44:2);
    assert.ok(ctx.fillCalls.every(f=>f.args[2]===1&&f.args[3]===1));
    assert.equal(ctx.imageCalls.at(-1).alpha,1,'dust/light modulation must not weaken the silhouette mask');
    if(scene==='sunset-diner')assert.ok(ctx.imageCalls.slice(1,-1).every(d=>d.im.width===7&&d.im.height===7),'each dust core has a small cached halo');
    if(scene==='hall')assert.ok(t.contexts.some(c=>c.ctx.gradients.some(g=>g.args.at(-1)===130&&g.stops[0][1]==='rgba(12,18,24,0.35)')),'dark patch coverage expands without changing bright glow radius');
    const first=ctx.fillCalls.map(f=>f.args),alpha=ctx.imageCalls[0].alpha;
    ctx.fillCalls=[];ctx.imageCalls=[];t.step(2000);
    if(count)assert.notDeepEqual(ctx.fillCalls.map(f=>f.args),first,'dust actually drifts');
    assert.notEqual(ctx.imageCalls[0].alpha,alpha,'local light varies');
    if(scene==='hall'){
      const phases=[];
      const actorCtx=t.contexts.find(c=>c.node.width===64).ctx;
      for(let i=0;i<300;i++){ctx.imageCalls=[];t.step(50);phases.push({alpha:ctx.imageCalls[0].alpha,images:ctx.imageCalls.length,maskAlpha:ctx.imageCalls.at(-1).alpha,actorShade:Number(actorCtx.lastFill.style.slice(actorCtx.lastFill.style.lastIndexOf(',')+1,-1))});}
      assert.ok(phases.some(p=>p.alpha<.2&&p.images===3),'fluorescent dips include the local dark layer');
      assert.ok(phases.some(p=>p.alpha>.8&&p.images===2),'light returns to steady between bursts');
      assert.ok(phases.every(p=>p.maskAlpha===1));
      assert.ok(phases.find(p=>p.images===3).actorShade>phases.find(p=>p.images===2).actorShade,'actors dim with the same fluorescent beat');
    }
    assert.equal(t.queue.size,1);
    t.handle.destroy();
    assert.equal(t.queue.size,0);
  }
});

test('natural user idle stays unchanged; only occasional shy gesture is slower and input interrupts',async()=>{
  for(const scene of ['store','hall']){
    const t=await fixture({scene,random:()=>.1}),p=t.handle.player;
    const roles=t.win.SCENE_STORE.characters;
    assert.equal(roles.user.sprites.idle.frameMs,120);
    assert.equal(roles.user.sprites.shy_sweet.frameMs,220);
    for(const pose of ['wave','walk_right','walk_front','walk_back'])assert.equal(roles.user.sprites[pose].frameMs,120);
    assert.equal(roles.sol.sprites.idle.frameMs,120);assert.equal(roles.claude.sprites.idle.frameMs,120);
    t.step(0);assert.equal(p.pose,'idle');t.step(120);assert.equal(p.frameIndex,1);
    t.step(p.idleExtraAt-120);assert.equal(p.pose,'shy_sweet');assert.equal(p.frameIndex,0);
    const fixed={x:p.x,y:p.y};
    t.step(219);assert.equal(p.frameIndex,0);t.step(1);assert.equal(p.frameIndex,1);
    for(let i=2;i<16;i++){
      t.step(220);assert.equal(p.frameIndex,i%8);
      assert.ok(t.draws.some(d=>d.src.endsWith('/chars/user/shy_sweet_anim/f'+(i%8)+'.png')));
    }
    assert.equal(p.x,fixed.x);assert.equal(p.y,fixed.y);assert.equal(t.bubble.classList.set.has('on'),false);
    t.step(221);assert.equal(p.pose,'idle');assert.equal(p.actionKind,null);
    t.step(p.idleExtraAt-p.poseAt);assert.equal(p.pose,'shy_sweet');
    t.click(170,130);t.step(16);assert.ok(p.pose.startsWith('walk_'));
    assert.equal(p.poseUntil,0);assert.equal(p.actionKind,null);
    for(let i=0;i<300&&p.path;i++)t.step(16);
    assert.equal(p.pose,'idle');
    p.idleExtraAt=0;t.step(0);assert.equal(p.pose,'shy_sweet');
    const n=t.handle.npcs[0];t.click(n.x,n.y-30);t.step(16);
    assert.equal(p.poseUntil,0);assert.equal(p.actionKind,null);assert.notEqual(p.pose,'shy_sweet');
    for(let i=0;i<400&&p.path;i++)t.step(16);
    assert.equal(t.bubble.classList.set.has('on'),true);
    p.idleExtraAt=0;t.step(0);assert.equal(p.pose,'idle','no coy gesture during conversation');
    assert.equal(roles.user.sprites.hands_on_hips,undefined);assert.equal(roles.user.sprites.thoughtful,undefined);assert.equal(roles.user.sprites.focused,undefined);
    t.handle.destroy();assert.equal(t.queue.size,0);
  }
});

test('all 15 base animation sets contain eight native 64px frames',()=>{
  let frames=0;
  for(const role of ['sol','user','claude'])for(const pose of ['idle','wave','walk_front','walk_back','walk_right'])for(let i=0;i<8;i++){
    const f=path.join(base,'assets/chars',role,pose+'_anim',`f${i}.png`),b=fs.readFileSync(f);
    assert.equal(b.readUInt32BE(16),64);assert.equal(b.readUInt32BE(20),64);frames++;
  }
  assert.equal(frames,120); // Exact byte equality is additionally checked by installation.
});

test('standing-only extras have eight 64px frames and explicit idle/trigger categories',async()=>{
  const t=await fixture(),n=t.handle.npcs[0];
  assert.deepEqual(Array.from(n.idleExtras.poses),['sip','read_stand','yawn','jacket_tidy']);
  assert.deepEqual(Array.from(n.triggerActions,a=>a[0]),['wink_finger','touch_hair','polite_bow']);
  const poses=[...n.idleExtras.poses,...n.triggerActions.map(a=>a[0])];
  for(const pose of poses){
    const clip=t.win.SCENE_STORE.characters.sol.sprites[pose];
    assert.equal(clip.frameMs,120);assert.equal(clip.frames.length,8);
    for(const f of clip.frames){const b=fs.readFileSync(path.join(base,f));assert.equal(b.readUInt32BE(16),64);assert.equal(b.readUInt32BE(20),64);}
  }
  assert.ok(!poses.some(p=>/hip|sit|hug/.test(p)));t.handle.destroy();
});

test('idle extras play two loops while standing, never speak, do not immediately repeat, and yield to clicks',async()=>{
  const t=await fixture({roam:true,random:()=>.1}),n=t.handle.npcs[0];
  // Natural close-player rest: roaming is paused, but standing extras remain alive.
  t.handle.player.x=n.x-32;t.handle.player.y=n.y;
  const start={x:n.x,y:n.y};
  t.step(n.idleExtraAt-1);assert.equal(n.actionKind,null);t.step(1);
  assert.equal(n.actionKind,'idle-extra');assert.equal(n.pose,'sip');assert.equal(n.path,null);
  for(let i=0;i<16;i++){
    if(i)t.step(120);
    assert.equal(n.frameIndex,i%8);assert.equal(n.x,start.x);assert.equal(n.y,start.y);
    assert.ok(t.draws.some(d=>d.src.endsWith('/sip_anim/f'+(i%8)+'.png')));
    assert.equal(t.bubble.classList.set.has('on'),false);
  }
  t.step(121);assert.equal(n.pose,'idle');assert.equal(n.actionKind,null);
  t.step(100);assert.equal(n.pose,'idle','a real rest separates action clips');
  t.step(n.idleExtraAt-n.poseAt-100); // Clock now reaches the next scheduled extra.
  assert.equal(n.actionKind,'idle-extra');assert.notEqual(n.pose,'sip');
  t.click(n.x,n.y-30);t.step(0);
  assert.equal(n.pose,'wave');assert.equal(n.actionKind,'trigger');
  assert.equal(t.bubble.classList.set.has('on'),true);assert.equal(n.frameIndex,0);
  t.step(3801);assert.equal(n.pose,'idle');assert.equal(n.actionKind,null);
  assert.equal(t.bubble.classList.set.has('on'),false);
  t.handle.destroy();assert.equal(t.queue.size,0);
});

test('real clicks cycle wave then both extra responses, preserve approach priority, and restart clip frame zero',async()=>{
  const t=await fixture({roam:true,random:()=>.25}),n=t.handle.npcs[0];
  // Interrupt an idle extra from far away, then cancel the approach with a floor click.
  n.idleExtraAt=0;t.step(0);assert.equal(n.actionKind,'idle-extra');
  t.click(n.x,n.y-30);assert.equal(n.actionKind,null);assert.equal(n.pose,'idle');
  assert.equal(t.bubble.classList.set.has('on'),false);
  t.click(150,120);for(let i=0;i<300&&t.handle.player.path;i++)t.step(16);
  assert.equal(t.bubble.classList.set.has('on'),false);assert.equal(n.replyIndex,0,'cancelled approach consumes no response');
  t.handle.player.x=n.x-32;t.handle.player.y=n.y;
  for(const pose of ['wave','wink_finger','touch_hair','polite_bow','wave']){
    t.click(n.x,n.y-30);t.step(0);assert.equal(n.pose,pose);assert.equal(n.actionKind,'trigger');
    assert.equal(n.frameIndex,0);assert.equal(t.bubble.classList.set.has('on'),true);
    for(let i=1;i<8;i++){t.step(120);assert.equal(n.frameIndex,i);assert.ok(t.draws.some(d=>d.src.endsWith('/'+pose+'_anim/f'+i+'.png')));}
  }
  t.step(3801);assert.equal(n.pose,'idle');assert.equal(n.actionKind,null);
  assert.equal(t.bubble.classList.set.has('on'),false);t.handle.destroy();
});

test('an extra waits for a stroll to finish; Level 0 adopts only Claude approved extras',async()=>{
  const t=await fixture({roam:true}),n=t.handle.npcs[0];
  for(let i=0;i<600&&!n.path;i++)t.step(40);assert.ok(n.path);
  n.idleExtraAt=0;t.step(40);assert.ok(n.path);assert.equal(n.actionKind,null);assert.ok(n.pose.startsWith('walk_'));
  for(let i=0;i<600&&n.path;i++)t.step(40);
  t.step(0);
  assert.equal(n.actionKind,'idle-extra');assert.equal(n.path,null);t.handle.destroy();
  const hall=await fixture({scene:'hall',roam:true,random:()=>.25}),c=hall.handle.npcs[0];
  assert.deepEqual(Array.from(c.idleExtras.poses),['chin_think','palm_up_shrug']);
  assert.deepEqual(Array.from(c.triggerActions,a=>a[0]),['double_peace','held_item_show','surprised_palms']);
  hall.handle.player.x=c.x-32;hall.handle.player.y=c.y;
  for(const pose of ['wave','double_peace','held_item_show','surprised_palms','wave']){
    hall.click(c.x,c.y-30);hall.step(0);assert.equal(c.pose,pose);assert.equal(c.frameIndex,0);
  }
  const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
  assert.ok(html.includes('Backrooms Level 0 · Claude'));assert.ok(!html.includes('黄色走廊 · Claude'));
  hall.handle.destroy();
});

test('Claude quiet extras alternate, yield to interaction, and all approved clips draw eight native frames',async()=>{
  const t=await fixture({scene:'hall',roam:true,random:()=>.1}),n=t.handle.npcs[0];
  t.handle.player.x=n.x-32;t.handle.player.y=n.y;
  n.idleExtraAt=0;t.step(0);assert.equal(n.pose,'chin_think');
  for(let i=0;i<16;i++){
    if(i)t.step(120);
    assert.equal(n.actionKind,'idle-extra');assert.equal(n.frameIndex,i%8);
    assert.ok(t.draws.some(d=>d.src.endsWith('/chin_think_anim/f'+(i%8)+'.png')));
    assert.equal(t.bubble.classList.set.has('on'),false);
  }
  t.step(121);assert.equal(n.pose,'idle');assert.equal(n.actionKind,null);
  t.step(n.idleExtraAt-1921);assert.equal(n.pose,'palm_up_shrug');
  t.click(n.x,n.y-30);t.step(0);assert.equal(n.pose,'wave');
  for(const pose of ['double_peace','held_item_show','surprised_palms']){
    t.click(n.x,n.y-30);t.step(0);
    for(let i=0;i<8;i++){
      if(i)t.step(120);
      assert.equal(n.pose,pose);assert.equal(n.frameIndex,i);
      assert.ok(t.draws.some(d=>d.src.endsWith('/'+pose+'_anim/f'+i+'.png')));
    }
  }
  t.step(3801);assert.equal(n.pose,'idle');assert.equal(n.actionKind,null);
  for(const pose of ['idle','chin_think','palm_up_shrug','double_peace','held_item_show','surprised_palms']){
    const clip=t.win.SCENE_HALL.characters.claude.sprites[pose];
    assert.equal(clip.frames.length,8);assert.equal(clip.frameMs,120);
    for(const f of clip.frames){const b=fs.readFileSync(path.join(base,f));assert.equal(b.readUInt32BE(16),64);assert.equal(b.readUInt32BE(20),64);}
  }
  assert.equal(t.win.SCENE_HALL.characters.claude.sprites.collar_tidy,undefined);
  assert.equal(t.win.SCENE_STORE.characters.sol.sprites.side_glance,undefined);
  assert.equal(t.win.SCENE_STORE.characters.sol.sprites.seated_feet_swing,undefined);
  t.handle.destroy();assert.equal(t.queue.size,0);
});
test('user idle frame clock draws all 8 frames at 120ms and wraps without procedural bob',async()=>{
  const t=await fixture();t.step(0);
  for(let i=0;i<=8;i++){
    if(i)t.step(120);
    const d=t.draws.find(d=>d.src.includes('/user/'));
    assert.ok(d.src.endsWith(`/idle_anim/f${i%8}.png`));
    assert.ok(t.translations.some(([x,y])=>x===140&&y===120),'player keeps the floor anchor regardless of depth-sort order');
  }
  assert.equal(t.scales.length,0);t.handle.destroy();assert.equal(t.queue.size,0);
});
test('screen-direction selection uses front/back/right and mirrors only leftward side-walk',async()=>{
  const t=await fixture({debug:true});
  for(const [x,y,pose,left] of [[165,130,'walk_front',false],[170,105,'walk_back',false],[190,123,'walk_right',false],[130,120,'walk_right',true]]){
    t.moveToStart();t.click(x,y);t.step(16);
    assert.equal(t.handle.player.pose,pose);
    assert.equal(t.scales.some(([x,y])=>x===-1&&y===1),left);
    assert.ok(t.draws.some(d=>d.src.includes(`/user/${pose}_anim/`)));
    for(let i=0;i<220 && t.handle.player.path;i++)t.step(16);
    assert.equal(t.handle.player.path,null);assert.equal(t.handle.player.pose,'idle');
    assert.ok(Math.abs(t.handle.player.x-x)<1e-6);assert.ok(Math.abs(t.handle.player.y-y)<1e-6);
  }
  t.handle.destroy();
});
test('NPC click walks to her side before speech, animates wave then returns to idle, and preserves depth ordering',async()=>{
  const t=await fixture();t.step(0);t.click(205,75);t.step(16);
  assert.equal(t.bubble.classList.set.has('on'),false);
  for(let i=0;i<300 && t.handle.player.path;i++)t.step(16);
  assert.equal(t.handle.player.x,173);assert.equal(t.handle.player.y,112);
  assert.equal(t.bubble.classList.set.has('on'),true);assert.equal(t.handle.npcs[0].pose,'wave');
  assert.ok(t.draws.some(d=>d.src.includes('/sol/wave_anim/')));
  const text=t.bubble.textContent;t.step(120);assert.equal(t.handle.npcs[0].frameIndex,1);
  t.click(205,75);t.step(0);assert.notEqual(t.bubble.textContent,text);assert.equal(t.handle.npcs[0].frameIndex,0);
  for(let i=0;i<250;i++)t.step(16);
  assert.equal(t.bubble.classList.set.has('on'),false);assert.equal(t.handle.npcs[0].pose,'idle');
  for(const [y,front] of [[130,'/user/'],[100,'/sol/']]){
    t.handle.player.y=y;t.step(0);const chars=t.draws.filter(d=>d.src.includes('/chars/'));assert.ok(chars.at(-1).src.includes(front));
  }
  t.handle.destroy();
});
test('new ground click cancels queued conversation, clamps outside floor and retains integer scaling',async()=>{
  const t=await fixture({width:390});assert.equal(t.cv.style.width,'344px');
  t.click(205,75);t.step(16);t.click(150,120);
  for(let i=0;i<240 && t.handle.player.path;i++)t.step(16);
  assert.equal(t.bubble.classList.set.has('on'),false);assert.equal(t.handle.npcs[0].pose,'idle');
  t.click(0,190);assert.ok(t.handle.player.path.x>82);assert.ok(t.handle.player.path.y<159);
  t.root.clientWidth=720;t.resize();assert.equal(t.cv.style.width,'688px');
  t.handle.destroy();
});

test('sol and Claude library entries play all eight side-walk frames; leftward movement mirrors and arrival returns to idle',async()=>{
  for(const character of ['sol','claude'])for(const [x,left] of [[130,true],[190,false]]){
    const t=await fixture({character});t.moveToStart();t.click(x,120);t.step(16);
    assert.equal(t.handle.player.pose,'walk_right');
    for(let i=0;i<8;i++){
      if(i)t.step(120);
      const d=t.draws.find(d=>d.src.includes('/'+character+'/walk_right_anim/'));
      assert.ok(d?.src.endsWith('/f'+i+'.png'));
      assert.equal(t.scales.some(([sx,sy])=>sx===-1&&sy===1),left);
    }
    for(let i=0;i<240 && t.handle.player.path;i++)t.step(16);
    assert.equal(t.handle.player.pose,'idle');assert.equal(t.handle.player.x,x);
    t.handle.destroy();
  }
});
test('default scene remains user plus sol with an initial pause; unused Claude is not spawned',async()=>{
  const t=await fixture({roam:true});assert.equal(t.handle.player.id,'user');
  assert.deepEqual(Array.from(t.handle.npcs,n=>n.id),['sol']);
  for(let i=0;i<6;i++)t.step(120);
  assert.equal(t.handle.npcs[0].x,205);assert.equal(t.handle.npcs[0].y,112);
  assert.equal(t.handle.npcs[0].pose,'idle');assert.equal(t.handle.npcs[0].path,null);
  assert.ok(!t.draws.some(d=>d.src.includes('/claude/')));t.handle.destroy();
});

test('light layers mask sprites with source-atop, mask glow to room alpha, and keep floor shadows below characters',async()=>{
  const t=await fixture();t.step(0);
  const shade=t.contexts.find(c=>c.node.width===64),glow=t.contexts.find(c=>c.node.width===344&&c.node!==t.cv);
  assert.equal(shade.ctx.lastFill.mode,'source-atop');
  assert.equal(shade.ctx.globalCompositeOperation,'source-over');
  assert.equal(shade.ctx.imageSmoothingEnabled,false);
  assert.equal(glow.ctx.lastDraw.mode,'destination-in');
  assert.equal(glow.ctx.globalCompositeOperation,'source-over');
  const firstChar=t.ops.findIndex(o=>o.kind==='image'&&o.src?.includes('/chars/'));
  assert.equal(t.ops.filter(o=>o.kind==='shadow').length,4);
  assert.ok(t.ops.every((o,i)=>o.kind!=='shadow'||i<firstChar));
  assert.equal(t.ops.at(-1).src,'assets/store/bg.png'); // Last canvas is glow, masked with this background.
  t.handle.destroy();
});
test('station side dimming stays on the background, beneath actors, and spares the foreground',async()=>{
  const t=await fixture({scene:'rainy-station'});t.step(0);
  const patches=t.win.SCENE_RAINY_STATION.backgroundShade;
  const layer=t.contexts.find(c=>c.node.width===344&&c.node!==t.cv&&c.ctx.lastFill?.mode==='source-atop');
  assert.ok(layer,'dimming is a separate masked background, not an actor overlay');
  assert.equal(layer.ctx.lastDraw.src,'assets/rainy-station/bg.png');
  assert.equal(layer.ctx.globalCompositeOperation,'source-over');
  assert.equal(layer.ctx.gradients.length,2);
  assert.equal(layer.ctx.imageSmoothingEnabled,false);
  for(const g of layer.ctx.gradients)assert.equal(g.stops.at(-1)[1],'rgba(12,18,30,0)');
  assert.equal(patches[0].alpha,patches[1].alpha,'both sides use the same dimming strength');
  assert.equal(patches[0].radius,patches[1].radius,'both sides use the same falloff range');
  assert.equal(patches[0].at[0]+patches[1].at[0],344,'patches are horizontally mirrored');
  assert.equal(patches[0].at[1],patches[1].at[1]);
  for(const p of [[160,145],[171,153],[180,150]])for(const patch of patches)
    assert.ok(Math.hypot(p[0]-patch.at[0],p[1]-patch.at[1])>=patch.radius,'accepted foreground lies outside either patch');
  assert.equal(t.ops[0].src,'assets/rainy-station/bg.png');
  const actor=t.ops.findIndex(o=>o.src?.includes('/chars/'));
  assert.ok(t.ops.every((o,i)=>o.kind!=='shadow'||i<actor));
  t.handle.destroy();assert.equal(t.queue.size,0);
});

test('station character darkness is uniform across positions and identities; warm tint stays near the lamp',async()=>{
  const t=await fixture({scene:'rainy-station'});
  const shade=t.contexts.find(c=>c.node.width===64);
  const lighting=t.win.SCENE_RAINY_STATION.lighting;
  assert.equal(lighting.lights.length,2,'the old left-side compensating light is removed');
  for(const ent of [t.handle.player,t.handle.npcs[0]])for(const [x,y,nearLamp] of [[140,128,false],[118,125,false],[201,126,false],[160,145,false],[171,151,false],[173,108,true]]){
    ent.x=x;ent.y=y;shade.ctx.fillCalls=[];t.step(0);
    const calls=shade.ctx.fillCalls.filter(f=>f.src?.includes('/chars/'+ent.id+'/')&&typeof f.style==='string');
    const fill=calls.find(f=>f.style.startsWith('rgba(12,18,30,'));
    const alpha=Number(fill.style.slice('rgba(12,18,30,'.length,-1));
    assert.equal(alpha,lighting.shadeAlpha,'the base darkness is the same at left, right, foreground and lamp');
    assert.equal(fill.mode,'source-atop');
    const warm=calls.find(f=>f.style.startsWith('rgba(255,185,87,'));
    const warmAlpha=Number(warm.style.slice('rgba(255,185,87,'.length,-1));
    assert.equal(warmAlpha>0,nearLamp,'only the small lamp neighborhood receives warm color');
    const cold=calls.find(f=>f.style.startsWith('rgba(105,171,207,'));
    assert.equal(Number(cold.style.slice('rgba(105,171,207,'.length,-1)),0);
  }
  t.handle.destroy();assert.equal(t.queue.size,0);
});

test('sol repeatedly strolls slowly then rests, stays inside safe floor and does not cross the player',async()=>{
  for(const randomSeed of [123,1,8,99]){
  const t=await fixture({roam:true,randomSeed}),n=t.handle.npcs[0];
  const floor=t.win.SCENE_STORE.walkable;
  function inside(x,y){const cross=floor.map(([ax,ay],i)=>{const [bx,by]=floor[(i+1)%floor.length];return (bx-ax)*(y-ay)-(by-ay)*(x-ax);});return cross.every(v=>v>=-1e-6)||cross.every(v=>v<=1e-6);}
  let starts=0,stops=0,wasMoving=false,sawSlowerFrames=false;
  for(let i=0;i<2500;i++){
    const before={x:n.x,y:n.y};t.step(40);const moving=!!n.path;
    if(moving&&!wasMoving)starts++;
    if(!moving&&wasMoving){stops++;assert.ok(n.pose==='idle'||n.actionKind==='idle-extra');}
    if(moving){assert.ok(n.pose.startsWith('walk_'));sawSlowerFrames ||= n.roam.frameMs>120;}
    assert.ok(Math.hypot(n.x-before.x,n.y-before.y)<=16*0.04+1e-6);
    assert.ok(inside(n.x,n.y));assert.ok(Math.hypot(n.x-t.handle.player.x,n.y-t.handle.player.y)>=36-1e-6);
    wasMoving=moving;
  }
  assert.ok(starts>=8&&stops>=8,'strolls are now frequent enough, not just two short moves in 100 seconds');assert.ok(sawSlowerFrames);
  assert.equal(t.bubble.classList.set.has('on'),false);t.handle.destroy();
  console.log('100s stroll sample',randomSeed,{starts,stops});
  }
});
test('click moving sol freezes her destination; player approaches, she waves and rests nearby, then resumes after departure',async()=>{
  const t=await fixture({roam:true}),n=t.handle.npcs[0];
  for(let i=0;i<600&&!n.path;i++)t.step(40);assert.ok(n.path);
  const x=n.x,y=n.y;t.click(x,y-30);
  assert.equal(n.path,null);assert.equal(n.pose,'idle');
  for(let i=0;i<600&&t.handle.player.path;i++){t.step(16);assert.equal(n.x,x);assert.equal(n.y,y);}
  assert.equal(t.bubble.classList.set.has('on'),true);assert.equal(n.pose,'wave');
  for(let i=0;i<400;i++)t.step(40);
  assert.equal(n.x,x);assert.equal(n.y,y);assert.ok(n.pose==='idle'||n.actionKind==='idle-extra');
  t.click(135,117);for(let i=0;i<300&&t.handle.player.path;i++)t.step(16);
  assert.ok(Math.hypot(t.handle.player.x-x,t.handle.player.y-y)>36);
  for(let i=0;i<800&&!n.path;i++)t.step(40);assert.ok(n.path,'roaming resumes, without requiring a new NPC click');
  t.handle.destroy();
});
test('NPC keeps the original slow 220ms clock without slowing the player or idle animation',async()=>{
  const t=await fixture({roam:true}),n=t.handle.npcs[0];
  for(let i=0;i<600&&!n.path;i++)t.step(40);assert.ok(n.path);
  assert.equal(n.frameIndex,0);t.step(219);assert.equal(n.frameIndex,0);
  t.step(1);assert.equal(n.frameIndex,1);
  assert.ok(t.draws.some(d=>d.src.includes('/sol/walk_')&&d.src.endsWith('/f1.png')));
  t.handle.destroy();
});
test('cancelling a pending approach releases the companion without delayed speech; proximity interrupts a stroll',async()=>{
  const t=await fixture({roam:true}),n=t.handle.npcs[0];
  for(let i=0;i<600&&!n.path;i++)t.step(40);assert.ok(n.path);
  t.click(n.x,n.y-30);t.click(135,117);
  for(let i=0;i<500;i++)t.step(40);
  assert.equal(t.bubble.classList.set.has('on'),false);
  for(let i=0;i<800&&!n.path;i++)t.step(40);assert.ok(n.path);
  t.handle.player.x=n.x-32;t.handle.player.y=n.y;t.step(16);
  assert.equal(n.path,null);assert.equal(n.pose,'idle');
  const x=n.x,y=n.y;for(let i=0;i<400;i++)t.step(40);
  assert.equal(n.x,x);assert.equal(n.y,y);t.handle.destroy();assert.equal(t.queue.size,0);
});

test('Backrooms Level 0 loads native background, four-direction player movement and Claude approach/wave/idle',async()=>{
  const t=await fixture({scene:'hall',debug:true,width:390});
  assert.deepEqual(Array.from(t.handle.npcs,n=>n.id),['claude']);
  assert.equal(t.cv.style.width,'344px');t.step(0);
  assert.ok(t.draws.some(d=>d.src==='assets/hall/bg.png'));
  assert.ok(!t.draws.some(d=>d.src?.includes('/sol/')));
  for(const [x,y,pose] of [[174,156,'walk_front'],[174,116,'walk_back'],[195,141,'walk_right'],[130,140,'walk_right']]){
    t.handle.player.x=170;t.handle.player.y=137;t.click(x,y);t.step(16);
    assert.equal(t.handle.player.pose,pose);
    for(let i=0;i<300&&t.handle.player.path;i++)t.step(16);
    assert.equal(t.handle.player.x,x);assert.equal(t.handle.player.y,y);assert.equal(t.handle.player.pose,'idle');
  }
  t.click(208,100);assert.equal(t.bubble.classList.set.has('on'),false);
  for(let i=0;i<300&&t.handle.player.path;i++)t.step(16);
  assert.equal(t.handle.player.x,176);assert.equal(t.handle.player.y,137);
  assert.equal(t.handle.npcs[0].pose,'wave');assert.equal(t.bubble.dataset.owner,'claude');
  assert.equal(t.bubble.classList.set.has('on'),true);t.step(120);assert.equal(t.handle.npcs[0].frameIndex,1);
  for(let i=0;i<250;i++)t.step(16);
  assert.equal(t.handle.npcs[0].pose,'idle');assert.equal(t.handle.npcs[0].x,208);
  assert.equal(t.bubble.classList.set.has('on'),false);
  t.click(0,0);assert.ok(t.handle.player.path.x>68&&t.handle.player.path.y>=99);
  t.handle.destroy();assert.equal(t.queue.size,0);
});
test('scene buttons switch actual engine mounts without accumulating animation loops or old dialogue',async()=>{
  const t=await fixture({roam:true});t.handle.destroy();
  const buttons=['store','hall'].map(id=>{const b=t.make('button');b.dataset.scene=id;return b;});
  const status=t.make('p');let active;
  const entries={store:{label:'便利店',hint:'sol',config:t.win.SCENE_STORE},hall:{label:'黄色走廊',hint:'Claude',config:t.win.SCENE_HALL}};
  const picker=await t.win.ScenePicker.mount(t.root,buttons,status,entries,{debug:true,onChange:h=>{active=h;}});
  assert.equal(picker.current,'store');assert.equal(t.queue.size,1);
  for(const id of ['hall','store','hall']){
    await buttons.find(b=>b.dataset.scene===id).click();t.step(0);
    assert.equal(picker.current,id);assert.equal(t.queue.size,1);
    assert.equal(t.root.children.length,1);
    assert.equal(buttons.find(b=>b.dataset.scene===id)['aria-pressed'],'true');
    assert.ok(status.textContent.includes(entries[id].label));
    assert.equal(active.npcs[0].id,id==='store'?'sol':'claude');
    assert.ok(t.draws.some(d=>d.src===entries[id].config.background));
    assert.equal(t.root.children[0].children[1].classList.set.has('on'),false);
  }
  const pending=picker.select('store');assert.ok(buttons.every(b=>b.disabled));
  assert.equal(await picker.select('hall'),false);await pending;
  assert.equal(picker.current,'store');assert.equal(t.queue.size,1);
  assert.equal(await picker.select('store'),false);
  const loading=picker.select('hall');picker.destroy();await loading;
  assert.equal(t.queue.size,0);assert.equal(active,null);assert.ok(buttons.every(b=>b.disabled));
});
test('Claude repeatedly strolls, pauses, stays on the hallway floor, and stops for an approach',async()=>{
  for(const randomSeed of [123,1,8,99]){
    const t=await fixture({scene:'hall',roam:true,randomSeed}),n=t.handle.npcs[0];
    const floor=t.win.SCENE_HALL.walkable;
    const inside=(x,y)=>{const c=floor.map(([ax,ay],i)=>{const [bx,by]=floor[(i+1)%floor.length];return (bx-ax)*(y-ay)-(by-ay)*(x-ax);});return c.every(v=>v>=-1e-6)||c.every(v=>v<=1e-6);};
    let starts=0,stops=0,moving=false;
    for(let i=0;i<2500;i++){
      const x=n.x,y=n.y;t.step(40);
      if(n.path&&!moving)starts++;if(!n.path&&moving)stops++;
      assert.ok(Math.hypot(n.x-x,n.y-y)<=16*.04+1e-6);
      assert.ok(inside(n.x,n.y));assert.ok(Math.hypot(n.x-t.handle.player.x,n.y-t.handle.player.y)>=36-1e-6);
      moving=!!n.path;
    }
    assert.ok(starts>=8&&stops>=8);assert.equal(n.roam.frameMs,220);
    for(let i=0;i<600&&!n.path;i++)t.step(40);assert.ok(n.path);
    const x=n.x,y=n.y;t.click(x,y-30);assert.equal(n.path,null);
    for(let i=0;i<500&&t.handle.player.path;i++){t.step(16);assert.equal(n.x,x);assert.equal(n.y,y);}
    assert.equal(n.pose,'wave');assert.equal(t.bubble.classList.set.has('on'),true);
    for(let i=0;i<250;i++)t.step(16);
    assert.equal(n.pose,'idle');assert.equal(n.x,x);assert.equal(n.y,y);
    t.handle.destroy();assert.equal(t.queue.size,0);
  }
});

test('expanded floors are convex, substantially larger, and bound every step of manual travel',async()=>{
  const previous={store:[[177,88],[232,114],[185,141],[98,131]],hall:[[174,103],[239,131],[176,166],[94,131]],
    'sunset-diner':[[158,134],[207,148],[173,168],[119,147]],'rainy-station':[[160,104],[224,124],[171,153],[116,124]]};
  const area=poly=>Math.abs(poly.reduce((sum,[x,y],i)=>{const [nx,ny]=poly[(i+1)%poly.length];return sum+x*ny-y*nx;},0))/2;
  for(const scene of Object.keys(previous)){
    const t=await fixture({scene});
    const cfg={store:t.win.SCENE_STORE,hall:t.win.SCENE_HALL,'sunset-diner':t.win.SCENE_SUNSET_DINER,'rainy-station':t.win.SCENE_RAINY_STATION}[scene];
    const poly=cfg.walkable,p=t.handle.player;
    const cross=(x,y)=>poly.map(([ax,ay],i)=>{const [bx,by]=poly[(i+1)%poly.length];return (bx-ax)*(y-ay)-(by-ay)*(x-ax);});
    const inside=(x,y)=>cross(x,y).every(c=>c>=-1e-6);
    assert.ok(area(poly)>area(previous[scene])*1.4,scene+' opens substantially more floor');
    for(const [x,y] of poly)assert.ok(inside(x,y),scene+' remains convex for straight movement');
    assert.ok(inside(p.x,p.y));assert.ok(inside(t.handle.npcs[0].x,t.handle.npcs[0].y));
    // Real pointer input from corner to corner, including outside-floor clicks.
    for(const [x,y] of [[0,192],[344,192],[344,0],[0,0],[0,192],[344,0]]){
      t.click(x,y);assert.ok(inside(p.path.x,p.path.y));
      for(let frame=0;frame<1000&&p.path;frame++){
        const before={x:p.x,y:p.y};t.step(40);
        assert.ok(inside(p.x,p.y),scene+' manual movement must stay inside at every frame');
        assert.ok(Math.hypot(p.x-before.x,p.y-before.y)<=46*.04+1e-6,'no faster than existing player speed');
      }
      assert.equal(p.path,null,'player reaches the floor-clamped destination');
    }
    t.handle.destroy();
  }
});

test('office index randomly selects one scene without switch controls; local scripts and native backgrounds remain',()=>{
  const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
  assert.ok(!html.includes('<button'));assert.ok(!html.includes('<nav'));
  assert.ok(html.includes('randomInitial:true'));assert.ok(html.includes('responsive:true'));
  const refs=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(refs,['scene-kit.js','scenes/store.js','scenes/hall.js','scenes/postapocalyptic.js','scene-picker.js']);
  for(const ref of refs)assert.ok(fs.existsSync(path.join(base,ref)));
  const b=fs.readFileSync(path.join(base,'assets/hall/bg.png'));
  assert.equal(b.readUInt32BE(16),344);assert.equal(b.readUInt32BE(20),192);
});

test('responsive display fits below native width and resizes continuously without changing native canvas or hit coordinates',async()=>{
  const t=await fixture({width:280,responsive:true});
  for(const width of [280,343,344,500,687,688,689]){
    t.root.clientWidth=width;t.resize();
    assert.ok(Math.abs(parseFloat(t.cv.style.width)-width)<1e-6);
    assert.ok(Math.abs(parseFloat(t.cv.style.height)-width*192/344)<1e-6);
    assert.equal(t.cv.width,344);assert.equal(t.cv.height,192);
    t.moveToStart();t.click(190,123);
    assert.ok(Math.abs(t.handle.player.path.x-190)<1e-6);assert.ok(Math.abs(t.handle.player.path.y-123)<1e-6);
  }
  t.handle.destroy();
});

test('post-apocalyptic corners keep two characters, floor-bound strolls and approach-triggered replies',async()=>{
  const inside=(p,poly)=>{
    let yes=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const [xi,yi]=poly[i],[xj,yj]=poly[j];
      if((yi>p.y)!==(yj>p.y)&&p.x<(xj-xi)*(p.y-yi)/(yj-yi)+xi)yes=!yes;
    }
    return yes;
  };
  for(const [scene,companion] of [['sunset-diner','sol'],['rainy-station','claude']])for(const randomSeed of [1,123,99]){
    const t=await fixture({scene,roam:true,randomSeed});
    const cfg=scene==='sunset-diner'?t.win.SCENE_SUNSET_DINER:t.win.SCENE_RAINY_STATION;
    const n=t.handle.npcs[0],p=t.handle.player;
    assert.equal(p.id,'user');assert.equal(t.handle.npcs.length,1);assert.equal(n.id,companion);
    assert.equal(n.roam.speed,16);assert.equal(n.roam.frameMs,220);
    assert.equal(p.idleExtras.poses[0],'shy_sweet');
    assert.ok(inside(p,cfg.walkable));assert.ok(inside(n,cfg.walkable));
    let moved=0;
    for(let i=0;i<1000;i++){
      const before={x:n.x,y:n.y};t.step(100);
      if(Math.hypot(n.x-before.x,n.y-before.y)>.01)moved++;
      assert.ok(inside(n,cfg.walkable),'stroll never leaves the selected floor');
    }
    assert.ok(moved>0,'companion must not be permanently blocked by the compact floor');
    t.click(n.x,n.y-30);
    for(let i=0;i<400&&p.path;i++)t.step(16);
    assert.ok(inside(p,cfg.walkable));assert.equal(n.pose,'wave');
    assert.equal(t.bubble.dataset.owner,companion);assert.equal(t.bubble.classList.set.has('on'),true);
    assert.ok(!t.bubble.textContent.includes('便利店')&&!t.bubble.textContent.includes('Level 0'));
    t.handle.destroy();assert.equal(t.queue.size,0);
  }
});

test('random initial selection covers all four scenes, is picked once, and works without any buttons',async()=>{
  for(const [value,id] of [[0,'store'],[.249,'store'],[.25,'hall'],[.499,'hall'],[.5,'sunset-diner'],[.749,'sunset-diner'],[.75,'rainy-station'],[.999,'rainy-station']]){
    const t=await fixture({width:280,random:()=>value});t.handle.destroy();
    const entries={store:{label:'Store',hint:'sol',config:t.win.SCENE_STORE},hall:{label:'Hall',hint:'Claude',config:t.win.SCENE_HALL},'sunset-diner':{label:'Diner',hint:'sol',config:t.win.SCENE_SUNSET_DINER},'rainy-station':{label:'Station',hint:'Claude',config:t.win.SCENE_RAINY_STATION}};
    const picker=await t.win.ScenePicker.mount(t.root,[],t.make('p'),entries,{randomInitial:true,responsive:true});
    assert.equal(picker.current,id);assert.equal(t.queue.size,1);
    assert.equal(t.root.children[0].children[0].style.width,'280px');
    for(let i=0;i<100;i++)t.step(100);
    assert.equal(picker.current,id);assert.equal(t.queue.size,1);
    picker.destroy();assert.equal(t.queue.size,0);
  }
});
});
