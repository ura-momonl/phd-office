import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import asset from './assets/mascot.json' with { type: 'json' };
import applied from './mascot-curves.json' with { type: 'json' };
import { MASCOT_PALETTE, mascotPixels } from './mascot.mjs';
import { heroLayout, renderHero } from './hero.mjs';
import { THEMES } from './view.mjs';
import { BROWN_CURVES, IDENTITY_CURVES, CHANNELS, curveTable, curvePalette, validateCurves, fullRangeCurves } from './curves.mjs';
import { createCurveEditor } from './curve-editor.mjs';
import { createApp, drawFrame, crtLines } from './app.mjs';
import { launchEdge } from '../automation/browser-launch.mjs';
if (process.env.PHD_ISOLATED_TESTS !== '1') throw new Error('Run with scripts/run-tests.mjs');

test('smooth shadow curves lift black to brown while keeping bright colours, alpha and source intact', () => {
  const original = structuredClone(asset.palette), mapped = curvePalette(asset.palette, BROWN_CURVES);
  assert.deepEqual(curvePalette([[0,0,0,255]], BROWN_CURVES), [[48,35,28,255]]);
  assert.deepEqual(curvePalette(asset.palette, IDENTITY_CURVES), original);
  for (let i = 0; i < original.length; i++) {
    const p = original[i];
    assert.equal(mapped[i][3], p[3]);
    if (p[3] < 100 || Math.max(...p.slice(0,3)) >= 128) assert.deepEqual(mapped[i], p);
  }
  assert.deepEqual(asset.palette, original, 'lossless source palette is not mutated');
  for (const c of CHANNELS) {
    const t = curveTable(BROWN_CURVES[c]);
    for (let x = 1; x < 256; x++) { assert.ok(t[x] >= t[x-1] - 1e-8); if (x >= 128) assert.equal(Math.round(t[x]), x, 'default highlights stay unchanged at output precision'); }
    // Every movable knot has matching first derivatives, not a polygon corner.
    for (const [x] of BROWN_CURVES[c].slice(1,-1)) assert.ok(Math.abs((t[x]-t[x-1])-(t[x+1]-t[x])) < .08);
  }
  assert.deepEqual(curvePalette([[127,35,5,255],[128,35,5,255]], BROWN_CURVES), [[127,35,5,255],[128,35,5,255]], 'no coloured-pixel jump at highlight lock');
  assert.throws(() => validateCurves({...BROWN_CURVES,r:[[0,48],[32,20],[128,128]]}));
});

test('full-range curves can darken highlights and white; old shadow edits are retained', () => {
  const curves=Object.fromEntries(CHANNELS.map(c=>[c,[[0,0],[128,128],[192,166],[255,210]]]));
  validateCurves(curves);
  const adjusted=curvePalette([[240,235,220,255],[255,255,255,255],[255,255,255,0]],curves);
  assert.ok(adjusted[0][0]<220,'bright skin/clothes are adjustable');
  assert.deepEqual(adjusted[1],[210,210,210,255],'white point is not locked');
  assert.deepEqual(adjusted[2],[255,255,255,0],'transparent source stays untouched');
  const legacy=Object.fromEntries(CHANNELS.map(c=>[c,structuredClone(BROWN_CURVES[c].filter(p=>p[0]<=128))]));
  legacy.r[0][1]=51;const before=structuredClone(legacy),full=fullRangeCurves(legacy);
  for(const c of CHANNELS){assert.deepEqual(full[c].slice(0,legacy[c].length),legacy[c]);assert.deepEqual(full[c].at(-1),[255,255]);}
  assert.deepEqual(legacy,before,'expansion does not mutate the saved selection');
});

test('all non-home screens bypass flicker, rolling brightness and boot at any time', () => {
  for (const screen of ['chat','sessions','call']) {
    const app = createApp({cols:100,rows:30}); app.screen=screen;
    app.sw={q:'',rail:0,focus:'list',sel:0,extra:[]}; app.callView={i:0,scroll:0};
    const raw = drawFrame(app);
    for (const now of [0,80,200,500,1234,4100,8700,12345,40000]) {
      app.now=now;app.crtBoot=0;
      assert.strictEqual(crtLines(app,raw),raw, screen+' is untouched at '+now);
    }
  }
});

test('ANSI and sixel use the applied selection exactly once, matching the editor preview', () => {
  const expected=curvePalette(asset.palette,applied.curves);
  assert.deepEqual(MASCOT_PALETTE,expected);
  assert.notDeepEqual(expected,asset.palette,'the chosen curve is actually active');
  const L=heroLayout({cols:100,maxRows:24,cw:10,ch:20});
  for(let fi=0;fi<asset.frames.length;fi++) {
    const now=fi*asset.frame_ms,frame=Buffer.from(asset.frames[fi],'base64'),grid=mascotPixels(64,now);
    for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
      const colour=expected[frame[y*64+x]];
      if(colour[3]>=100)assert.deepEqual(grid[y][x],colour.slice(0,3),'ANSI colours match the selected palette');
      else assert.equal(grid[y][x],null,'transparent pixels stay transparent');
    }
    for(const effects of [false,true])for(const themeKey of Object.keys(THEMES)) {
      const options={now,effects,themeKey,theme:THEMES[themeKey]},actual=renderHero(L,options);
      assert.deepEqual(actual,renderHero(L,{...options,palette:expected}),'default hero matches the editor substitution, not a double curve');
    }
  }
  const actual=renderHero(L,{effects:false}),original=renderHero(L,{effects:false,palette:asset.palette});
  for(let y=0;y<L.H;y++) {
    const start=(y*L.W+L.spriteW)*3,end=(y+1)*L.W*3;
    assert.deepEqual(actual.subarray(start,end),original.subarray(start,end),'title and background are unchanged');
  }
});

test('real editor drags a smooth curve, previews, saves readable parameters and restores them', async () => {
  const saveFile=path.resolve('.runtime/curve-editor-fixture/selection.json');
  const server=createCurveEditor({saveFile}); server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    assert.equal((await fetch(url+'/save',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://foreign.example'},body:'{}'})).status,403);
    assert.equal(fs.existsSync(saveFile),false);
    browser=await launchEdge();const page=await browser.newPage({viewport:{width:1120,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
    await page.waitForFunction(()=>document.querySelector('#hero').width>300);
    const before=await page.locator('#after').evaluate(c=>c.toDataURL());
    const point=page.locator('circle[data-i="0"]'), box=await point.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2-12,{steps:8});await page.mouse.up();
    const red=+(await page.locator('#y').inputValue());assert.ok(red>48&&red<=66,'real pointer drag changes red black point');
    assert.notEqual(await page.locator('#after').evaluate(c=>c.toDataURL()),before,'preview visibly changes');
    await page.locator('[data-c="g"]').click();await page.locator('#y').fill('39');await page.locator('#y').dispatchEvent('change');
    await page.locator('[data-c="b"]').click();
    const beforeHigh=await page.locator('#after').evaluate(c=>c.toDataURL()),high=await page.locator('circle[data-i="6"]').boundingBox();
    await page.mouse.move(high.x+high.width/2,high.y+high.height/2);await page.mouse.down();await page.mouse.move(high.x+high.width/2,high.y+high.height/2+16,{steps:8});await page.mouse.up();
    const highBlue=+(await page.locator('#y').inputValue());assert.ok(highBlue<192&&highBlue>=160,'highlight point moves');
    assert.notEqual(await page.locator('#after').evaluate(c=>c.toDataURL()),beforeHigh,'highlight edit changes the character');
    await page.locator('circle[data-i="7"]').click();assert.equal(await page.locator('#y').isEnabled(),true);
    await page.locator('#y').fill('230');await page.locator('#y').dispatchEvent('change');assert.equal(await page.locator('#x').inputValue(),'255');
    await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('已保存'));
    const saved=JSON.parse(fs.readFileSync(saveFile,'utf8'));assert.equal(saved.curves.r[0][1],red);assert.equal(saved.curves.g[0][1],39);assert.equal(saved.curves.b[0][1],28);
    assert.equal(saved.curves.b[6][1],highBlue);assert.deepEqual(saved.curves.b.at(-1),[255,230]);
    assert.equal(saved.highlightLock,null);assert.equal(saved.version,2);assert.equal(saved.mode,'max-channel-rgb-offset');assert.equal(saved.interpolation,'monotone-cubic');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#y').value!=='');assert.equal(+(await page.locator('#y').inputValue()),red);
    for(const width of [1120,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');}
    assert.deepEqual(errors,[]);
    const state=await(await fetch(url+'/state')).json();
    const bad=await fetch(url+'/save',{method:'POST',headers:{'Content-Type':'application/json','X-Curve-Token':state.token},body:JSON.stringify({curves:{}})});
    assert.equal(bad.status,400);assert.equal(fs.readFileSync(saveFile,'utf8'),JSON.stringify(saved,null,2)+'\n','invalid edits cannot overwrite the saved choice');
    const legacy=Object.fromEntries(CHANNELS.map(c=>[c,saved.curves[c].filter(p=>p[0]<=128)]));
    const oldPage=await fetch(url+'/save',{method:'POST',headers:{'Content-Type':'application/json','X-Curve-Token':state.token},body:JSON.stringify({curves:legacy})});
    assert.equal(oldPage.status,200,'still-open old page can save its shadow edits before refreshing');
    const restored=(await(await fetch(url+'/state')).json()).curves;
    for(const c of CHANNELS){assert.deepEqual(restored[c].slice(0,legacy[c].length),legacy[c]);assert.deepEqual(restored[c].at(-1),[255,255]);}
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
