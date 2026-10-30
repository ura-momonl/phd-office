// Run through scripts/run-tests.mjs in a sanitised copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from './server.mjs';

if(process.env.PHD_ISOLATED_TESTS!=='1')throw new Error('Run via scripts/run-tests.mjs');

test('brand serves the transparent portrait; grey semi-transparent matte edge pixels recoloured dark brown',async()=>{
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(base+'/');
    assert.equal(response.status,200);
    const html=await response.text();
    const brand=html.match(/<a class="brand"[^>]*>(.*?)<\/a>/s)?.[1];
    assert.ok(brand);
    assert.doesNotMatch(brand,/data-ico=/);
    assert.match(html,/<link rel="icon" type="image\/png" sizes="106x106" href="data:image\/png;base64,[A-Za-z0-9+\/=]+">/,'browser tab icon is the portrait at exact 2x, without the sidebar plate');
    assert.doesNotMatch(html,/<link rel="icon" type="image\/svg\+xml"/);
    assert.match(brand,/PIRI Office<small>Research Support &amp;<br>Workflow Automation/);
    const encoded=brand.match(/<img src="data:image\/png;base64,([A-Za-z0-9+/=]+)" width="53" height="53" alt="">/)?.[1];
    assert.ok(encoded,'portrait is self-contained and needs no additional backend asset route');
    const png=Buffer.from(encoded,'base64');
    assert.equal(createHash('sha256').update(png).digest('hex'),'79835d5645ce0768bdbbd3e946878ebc627e604c2b1c2a216490980b134100b4');
    assert.equal(png.readUInt32BE(16),53);
    assert.equal(png.readUInt32BE(20),53);
    const cssResponse=await fetch(base+'/workspace.css');
    assert.equal(cssResponse.status,200);
    const css=await cssResponse.text();
    assert.match(css,/\.sidebar \.brand\{background:transparent;border-radius:0;padding:0;gap:8px;align-self:flex-start;align-items:flex-end;overflow:visible\}\r?\n\.sidebar \.brand-mark\{background:#625a52;width:48px;height:48px;flex-shrink:0;border-radius:9px;margin:0 0 -2px;overflow:hidden;grid-template-columns:minmax\(0,1fr\)\}\r?\n\.sidebar \.brand-mark img\{width:44px;height:44px;margin:4px 0 0 2px;justify-self:start\}/);
    assert.match(css,/\.sidebar \.brand>span:last-child\{color:#f6c9a2;margin-bottom:-3px;line-height:1.35\}\.sidebar \.brand small\{color:#b9a592;line-height:1.4;margin-top:3px\}/);
    assert.match(css,/\.sidebar \.brand\{background:transparent;padding:0;border-radius:0;overflow:visible;align-items:center\}\.sidebar \.brand>span:last-child\{margin-bottom:0;line-height:1.5\}\.sidebar \.brand-mark\{background:transparent;width:28px;height:28px;border-radius:0;margin-top:0;align-self:center\}\.sidebar \.brand-mark img\{width:28px;height:28px;image-rendering:auto;margin:0;justify-self:center;align-self:center\}/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
