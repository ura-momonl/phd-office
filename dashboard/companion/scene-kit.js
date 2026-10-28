/* scene-kit：像素小场景引擎（纯前端，零依赖，零模型调用）
 * 用法：SceneKit.mount(容器元素, 场景配置对象, {debug})。配置格式见 README.md。
 * 约定：画布按场景原生分辨率绘制，背景和人物统一缩放（image-rendering:pixelated）。默认整数倍，responsive 模式连续适配容器宽度。
 * 坐标：一律是场景原生像素坐标；角色坐标 = 脚底中心点。
 */
(function (global) {
  'use strict';
  const FRAME = 64;                  // 角色原生帧边长
  const SPEED = 46;                  // 走路速度，原生像素/秒
  const STAND_GAP = 32;              // 走近同伴时，停在她身侧的距离
  const RAIN_TAPER = [0.18,0.40,0.70,1];

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片加载失败：' + src));
      im.src = src;
    });
  }

  // ---- 几何：可走多边形 ----
  function inPoly(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function nearestOnSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2)) : 0;
    return { x: a[0] + t * dx, y: a[1] + t * dy };
  }
  // 点在多边形外则吸附到最近边，并向内收 1px，避免卡在边上
  function clampToPoly(p, poly) {
    if (inPoly(p, poly)) return { x: p.x, y: p.y };
    let best = null, bd = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const q = nearestOnSeg(p, poly[i], poly[(i + 1) % poly.length]);
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    const cx = poly.reduce((s, v) => s + v[0], 0) / poly.length;
    const cy = poly.reduce((s, v) => s + v[1], 0) / poly.length;
    const vx = cx - best.x, vy = cy - best.y, vl = Math.hypot(vx, vy) || 1;
    return { x: best.x + vx / vl, y: best.y + vy / vl };
  }

  async function mount(root, cfg, opts = {}) {
    const debug = !!opts.debug;
    const [W, H] = cfg.size;

    // ---- DOM ----
    root.classList.add('sk-root');
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'sk-wrap';
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    cv.className = 'sk-canvas';
    const bubble = document.createElement('div');
    bubble.className = 'sk-bubble';
    wrap.append(cv, bubble);
    root.append(wrap);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // ---- 素材 ----
    const charDefs = cfg.characters;
    const sprites = {};
    const present = [...new Set([cfg.player.character, ...cfg.npcs.map(n => n.character)])];
    async function loadClip(id, pose, source) {
        const paths = typeof source === 'string' ? [source] : source.frames;
        const frameMs = typeof source === 'string' ? 120 : source.frameMs;
        const frames = await Promise.all(paths.map(loadImage));
        if (frames.some(im => im.naturalWidth !== FRAME || im.naturalHeight !== FRAME))
          throw new Error('角色帧必须为 64×64：' + id + '/' + pose);
        (sprites[id] ||= {})[pose] = { frames, frameMs };
    }
    // The background and both idle clips are independent. Load them together;
    // keep all eight original frames and never fetch absent library characters.
    const [bg] = await Promise.all([loadImage(cfg.background),
      ...present.map(id => loadClip(id, 'idle', charDefs[id].sprites.idle))]);
    // Display-only layers: do not read file:// pixels or change any source PNG.
    // Local background dimming is baked once, underneath shadows and sprites.
    // source-atop preserves the image's existing transparent silhouette.
    let backdrop = bg;
    if (cfg.backgroundShade?.length) {
      backdrop = document.createElement('canvas'); backdrop.width = W; backdrop.height = H;
      const b = backdrop.getContext('2d'); b.imageSmoothingEnabled = false;
      b.drawImage(bg, 0, 0); b.globalCompositeOperation = 'source-atop';
      for (const patch of cfg.backgroundShade) {
        const grad = b.createRadialGradient(...patch.at, 0, ...patch.at, patch.radius);
        grad.addColorStop(0, `rgba(12,18,30,${patch.alpha})`);
        grad.addColorStop(1, 'rgba(12,18,30,0)');
        b.fillStyle = grad; b.fillRect(0, 0, W, H);
      }
      b.globalCompositeOperation = 'source-over';
    }
    const lighting = cfg.lighting;
    const shade = document.createElement('canvas');
    shade.width = shade.height = FRAME;
    const shadeCtx = shade.getContext('2d');
    shadeCtx.imageSmoothingEnabled = false;
    let glow;
    if (lighting) {
      glow = document.createElement('canvas'); glow.width = W; glow.height = H;
      const g = glow.getContext('2d');
      for (const light of lighting.lights) {
        const grad = g.createRadialGradient(...light.glowAt, 0, ...light.glowAt, light.glowRadius);
        grad.addColorStop(0, `rgba(${light.color},${light.glowAlpha})`);
        grad.addColorStop(1, `rgba(${light.color},0)`);
        g.fillStyle = grad; g.fillRect(0, 0, W, H);
      }
      // Keep the room cutout transparent outside its original silhouette.
      g.globalCompositeOperation = 'destination-in'; g.drawImage(bg, 0, 0);
      g.globalCompositeOperation = 'source-over';
    }
    // Weather shares this scene's single frame loop. Cache the soft fog shapes;
    // Fog stays behind people; ALL rain is in front, both clipped to the
    // original background alpha. Reuse one scratch canvas, never another loop.
    const weather = cfg.weather;
    let atmosphere, atmosphereCtx;
    const fogPuffs = [];
    const raindrops = [];
    // Local random stream: varied weather must not consume the companions'
    // Math.random() sequence. Every recycled drop gets a new trajectory.
    let effectSeed = (Math.floor(performance.now() * 1000) ^ 0x9e3779b9) >>> 0;
    function effectRandom() {
      effectSeed = (effectSeed + 0x6d2b79f5) >>> 0;
      let n = effectSeed;
      n = Math.imul(n ^ n >>> 15, n | 1);
      n ^= n + Math.imul(n ^ n >>> 7, n | 61);
      return ((n ^ n >>> 14) >>> 0) / 4294967296;
    }
    function resetDrop(drop, initial) {
      const rain = weather.rain, mix = ([lo, hi]) => lo + effectRandom() * (hi - lo);
      drop.length = Math.round(mix(rain.length));
      drop.speed = mix(rain.speed);
      drop.alpha = mix(rain.alpha);
      drop.slant = 0.06 + effectRandom() * 0.08;
      drop.x = effectRandom() * W;
      drop.y = initial ? effectRandom() * (H + drop.length) - drop.length : -drop.length - effectRandom() * 48;
    }
    if (weather) {
      atmosphere = document.createElement('canvas'); atmosphere.width = W; atmosphere.height = H;
      atmosphereCtx = atmosphere.getContext('2d');
      for (const patch of weather.fog) {
        const puff = document.createElement('canvas'), r = patch.radius;
        puff.width = puff.height = r * 2;
        const p = puff.getContext('2d'), gradient = p.createRadialGradient(r, r, 0, r, r, r);
        gradient.addColorStop(0, `rgba(185,197,205,${patch.alpha})`);
        gradient.addColorStop(1, 'rgba(185,197,205,0)');
        p.fillStyle = gradient; p.fillRect(0, 0, r * 2, r * 2);
        fogPuffs.push({ patch, puff });
      }
      for (let i = 0; i < weather.rain.count; i++) {
        const drop = {};
        resetDrop(drop, true); raindrops.push(drop);
      }
    }
    // Indoor ambience: cached local glow + a few drifting dust motes. This is
    // a background layer, not a character filter or another animation owner.
    const ambience = cfg.ambience;
    let ambientLayer, ambientCtx, glimmer, glimmerDim, moteHalo;
    let flickerAt = Infinity, flickerStart = -Infinity;
    let flickerDim = false; // One state shared by lamp, both people and the glow.
    const motes = [];
    if (ambience) {
      ambientLayer = document.createElement('canvas'); ambientLayer.width = W; ambientLayer.height = H;
      ambientCtx = ambientLayer.getContext('2d'); ambientCtx.imageSmoothingEnabled = false;
      glimmer = document.createElement('canvas'); glimmer.width = W; glimmer.height = H;
      const g = glimmer.getContext('2d'), light = ambience.glimmer;
      const grad = g.createRadialGradient(...light.at, 0, ...light.at, light.radius);
      grad.addColorStop(0, `rgba(${light.color},${light.alpha})`);
      grad.addColorStop(1, `rgba(${light.color},0)`);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      if (ambience.motes) for (let i = 0; i < ambience.motes.count; i++)
        motes.push({ x: effectRandom(), phase: effectRandom(), speed: 0.6 + effectRandom() * 0.8,
          wobble: 3 + effectRandom() * 4 });
      if (ambience.motes?.halo) {
        const halo = ambience.motes.halo, center = halo.radius + 0.5;
        moteHalo = document.createElement('canvas'); moteHalo.width = moteHalo.height = halo.radius * 2 + 1;
        const h = moteHalo.getContext('2d'), grad = h.createRadialGradient(center, center, 0, center, center, halo.radius);
        grad.addColorStop(0, `rgba(${ambience.motes.color},${halo.alpha})`);
        grad.addColorStop(1, `rgba(${ambience.motes.color},0)`);
        h.fillStyle = grad; h.fillRect(0, 0, moteHalo.width, moteHalo.height);
      }
      if (light.flicker) {
        flickerAt = 1 + effectRandom() * 1.5;
        glimmerDim = document.createElement('canvas'); glimmerDim.width = W; glimmerDim.height = H;
        const d = glimmerDim.getContext('2d'), dark = d.createRadialGradient(...light.at, 0, ...light.at, light.dimRadius);
        dark.addColorStop(0, 'rgba(12,18,24,0.35)'); dark.addColorStop(1, 'rgba(12,18,24,0)');
        d.fillStyle = dark; d.fillRect(0, 0, W, H);
      }
    }
    // First make the two people visible and interactive. Absent library characters
    // are never loaded; other poses fill in without holding the initial scene blank.
    const ready = Promise.all(present.flatMap(id => Object.entries(charDefs[id].sprites)
      .filter(([pose]) => pose !== 'idle').map(([pose, source]) => loadClip(id, pose, source))));

    // ---- 实体 ----
    const poly = cfg.walkable;
    const mk = (id, x, y, extra = {}) => ({
      id, name: charDefs[id].name, x, y, facing: 1, pose: 'idle', poseAt: performance.now(), poseUntil: 0,
      path: null, onArrive: null, lastLine: -1, replyIndex: 0,
      actionKind: null, lastIdleExtra: null, ...extra
    });
    const player = mk(cfg.player.character, ...cfg.player.spawn, {
      isPlayer: true, idleExtras: cfg.player.idleExtras,
      idleExtraAt: cfg.player.idleExtras ? performance.now() + extraGap(cfg.player.idleExtras) : Infinity
    });
    const npcs = cfg.npcs.map(n => mk(n.character, ...n.at, {
      lines: n.lines, triggerActions: n.triggerActions, idleExtras: n.idleExtras,
      idleExtraAt: n.idleExtras ? performance.now() + extraGap(n.idleExtras) : Infinity,
      facing: n.facing || 1, roam: n.roam,
      roamAt: performance.now() + (n.roam ? pause(n.roam) : 0)
    }));
    const all = [player, ...npcs];
    let interactionNpc = null; // The one companion waiting for the player's approach.

    // ---- 行为 ----
    function setPose(ent, pose, now) {
      if (ent.pose !== pose) { ent.pose = pose; ent.poseAt = now; }
    }
    function walkTo(ent, target, onArrive) {
      ent.path = clampToPoly(target, poly);
      ent.onArrive = onArrive || null;
    }
    function pause(roam) { return roam.pause[0] + Math.random() * (roam.pause[1] - roam.pause[0]); }
    function extraGap(extras) { return extras.gap[0] + Math.random() * (extras.gap[1] - extras.gap[0]); }
    // Extra poses share the existing animation clock and expiry, not another timer.
    function idleExtra(n, now) {
      if (!n.idleExtras || n.path || n.poseUntil || interactionNpc === n || now < n.idleExtraAt) return;
      if (n.isPlayer && (interactionNpc || bubble.classList.contains('on'))) return;
      const choices = n.idleExtras.poses.filter(p => p !== n.lastIdleExtra);
      const pose = choices[Math.floor(Math.random() * choices.length)] || n.idleExtras.poses[0];
      const clip = sprites[n.id][pose];
      if (!clip) return; // Keep standing until this optional animation has arrived.
      n.lastIdleExtra = pose; n.actionKind = 'idle-extra';
      setPose(n, pose, now); n.poseAt = now;
      n.poseUntil = now + clip.frames.length * clip.frameMs * 2;
    }
    function stopRoam(n, now) {
      n.path = null;
      if (!n.poseUntil) setPose(n, 'idle', now);
      if (n.roam) n.roamAt = now + pause(n.roam);
    }
    function releaseInteraction(now) {
      if (interactionNpc) stopRoam(interactionNpc, now);
      interactionNpc = null;
    }
    // Movement has one owner, shared by manual player input and short NPC strolls.
    function advance(ent, now, dt, speed) {
      if (!ent.path) return;
      const dx = ent.path.x - ent.x, dy = ent.path.y - ent.y, d = Math.hypot(dx, dy);
      // NPC strolls follow a straight segment inside the convex floor. Applying
      // depth slowdown only to y bends the path and can cut across an edge.
      const step = speed * dt * (ent.roam && Math.abs(dy) > Math.abs(dx) ? 0.75 : 1);
      const depth = ent.roam ? 1 : 0.75; // Preserve existing manual player movement.
      if (d <= step) {
        ent.x = ent.path.x; ent.y = ent.path.y; ent.path = null;
        setPose(ent, 'idle', now);
        if (ent.roam) ent.roamAt = now + pause(ent.roam);
        const cb = ent.onArrive; ent.onArrive = null; if (cb) cb();
      } else {
        const vertical = Math.abs(dy) > Math.abs(dx);
        if (ent.roam && Math.hypot(player.x - (ent.x + (dx / d) * step), player.y - (ent.y + (dy / d) * step * depth)) < ent.roam.avoid) {
          stopRoam(ent, now); return;
        }
        setPose(ent, vertical ? (dy > 0 ? 'walk_front' : 'walk_back') : 'walk_right', now);
        ent.x += (dx / d) * step; ent.y += (dy / d) * step * depth;
        if (!vertical) ent.facing = dx > 0 ? 1 : -1;
      }
    }
    function stroll(n, now, dt) {
      if (!n.roam) return;
      const r = n.roam;
      if (interactionNpc === n || n.poseUntil || Math.hypot(player.x - n.x, player.y - n.y) < r.avoid) {
        stopRoam(n, now); return;
      }
      if (n.path) { advance(n, now, dt, r.speed); return; }
      if (now < n.roamAt) return;
      n.roamAt = now + pause(r); // Sometimes stay a little longer instead of pacing.
      if (Math.random() < 0.10) return;
      for (let i = 0; i < 12; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = r.radius[0] + Math.random() * (r.radius[1] - r.radius[0]);
        const p = clampToPoly({ x: n.x + Math.cos(angle) * distance, y: n.y + Math.sin(angle) * distance }, poly);
        // Edge-facing proposals become safe nearby destinations, not repeated idle failures.
        if (Math.hypot(p.x - n.x, p.y - n.y) < 12) continue;
        // Avoid crossing the player as well as ending on top of her.
        const nearest = nearestOnSeg(player, [n.x, n.y], [p.x, p.y]);
        if (Math.hypot(player.x - nearest.x, player.y - nearest.y) < r.avoid) continue;
        walkTo(n, p); advance(n, now, dt, r.speed); return;
      }
    }
    function say(npc, now) {
      // First greeting is a wave; subsequent clicks visit the extra reactions.
      // Rotate the action, so the player need not win a random draw to see it.
      const turn = npc.replyIndex++ % (1 + (npc.triggerActions?.length || 0));
      let reply;
      if (turn) reply = npc.triggerActions[turn - 1];
      else {
        const candidates = npc.lines.map((_, i) => i).filter(i => i !== npc.lastLine);
        const i = candidates[Math.floor(Math.random() * candidates.length)];
        npc.lastLine = i; reply = npc.lines[i];
      }
      const [pose, text] = reply;
      npc.actionKind = 'trigger';
      setPose(npc, pose, now); npc.poseAt = now;
      npc.poseUntil = now + 3800;
      if (npc.roam) npc.roamAt = npc.poseUntil + 6500;
      bubble.textContent = text;
      bubble.dataset.owner = npc.id;
      bubble.classList.add('on');
    }
    function hitNpc(p) {      // 命中判定：脚底上方 56px、左右各 18px 的窄盒，避开透明边
      for (const n of [...npcs].sort((a, b) => b.y - a.y)) {
        if (Math.abs(p.x - n.x) <= 18 && p.y <= n.y + 2 && p.y >= n.y - 58) return n;
      }
      return null;
    }
    function pointer(ev) {
      const r = cv.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
    }
    cv.addEventListener('click', ev => {
      const p = pointer(ev);
      if (debug) console.log('click', Math.round(p.x), Math.round(p.y));
      const npc = hitNpc(p);
      const now = performance.now();
      player.poseUntil = 0; player.actionKind = null;
      if (player.idleExtras) player.idleExtraAt = now + extraGap(player.idleExtras);
      releaseInteraction(now);
      if (npc) {
        npc.poseUntil = 0; npc.actionKind = null;
        if (npc.idleExtras) npc.idleExtraAt = now + extraGap(npc.idleExtras);
        stopRoam(npc, now); interactionNpc = npc;
        bubble.classList.remove('on');
        // 走到她身侧再触发对话；已在身侧则直接触发
        const side = player.x <= npc.x ? -1 : 1;
        const stand = clampToPoly({ x: npc.x + side * STAND_GAP, y: npc.y }, poly);
        player.facing = -side;
        const near = Math.hypot(player.x - stand.x, player.y - stand.y) < 3;
        const fire = () => { interactionNpc = null; player.facing = npc.x >= player.x ? 1 : -1; npc.facing = -player.facing; say(npc, performance.now()); };
        if (near) { player.path = null; player.onArrive = null; setPose(player, 'idle', now); fire(); }
        else walkTo(player, stand, fire);
      } else {
        bubble.classList.remove('on');
        walkTo(player, p);
      }
    });

    // ---- 绘制 ----
    function drawAmbience(elapsed) {
      const a = ambientCtx, t = elapsed / 1000, light = ambience.glimmer, dust = ambience.motes;
      a.clearRect(0, 0, W, H);
      flickerDim = false;
      // Gentle, low-amplitude variation, not a full-screen flashing effect.
      a.globalAlpha = 0.58 + Math.sin(t * light.rate) * 0.30 + Math.sin(t * light.rate * 3.1 + 1.4) * 0.12;
      if (light.flicker) {
        // A short fluorescent fault, then several steady seconds. Local light
        // only; spaced dips avoid continuous rapid/full-screen strobing.
        if (t >= flickerAt) { flickerStart = t; flickerAt = t + 5 + effectRandom() * 4; }
        const since = t - flickerStart;
        const dim = since < 0.12 || (since >= 0.55 && since < 0.69) || (since >= 1.10 && since < 1.18);
        flickerDim = dim;
        a.globalAlpha = (0.88 + Math.sin(t * 0.8) * 0.07) * (dim ? 0.10 : 1);
      }
      a.drawImage(glimmer, 0, 0); a.globalAlpha = 1;
      if (flickerDim) a.drawImage(glimmerDim, 0, 0);
      if (dust) {
        const [left, top, width, height] = dust.bounds;
        for (const mote of motes) {
          const phase = (mote.phase + t * dust.rise * mote.speed / height) % 1;
          const x = Math.floor(left + mote.x * width + Math.sin(t / mote.wobble + mote.phase * Math.PI * 2) * 2);
          const y = Math.floor(top + height * (1 - phase)), fade = Math.sin(phase * Math.PI);
          if (moteHalo) {
            a.globalAlpha = fade;
            a.drawImage(moteHalo, x - dust.halo.radius, y - dust.halo.radius); a.globalAlpha = 1;
          }
          a.fillStyle = `rgba(${dust.color},${dust.alpha * fade})`;
          a.fillRect(x, y, 1, 1);
        }
      }
      a.globalCompositeOperation = 'destination-in'; a.drawImage(bg, 0, 0);
      a.globalCompositeOperation = 'source-over';
      ctx.drawImage(ambientLayer, 0, 0);
    }
    function drawWeather(elapsed, rainPass = false) {
      const a = atmosphereCtx, t = elapsed / 1000;
      a.clearRect(0, 0, W, H);
      if (!rainPass) fogPuffs.forEach(({ patch, puff }, i) => {
        // Flatten into low wisps, flowing across rather than rocking in place.
        // Wrap only while fully off-canvas, with margin for gentle deformation.
        const baseWidth = patch.radius * 3.8, span = W + baseWidth + 24;
        const width = baseWidth * (1 + Math.sin(t / 5 + i) * 0.10);
        const height = patch.radius * 2 * (0.45 + Math.sin(t / 7 + i * 2) * 0.05);
        const center = (patch.at[0] + baseWidth / 2 + 12 + t * patch.speed) % span - baseWidth / 2 - 12;
        const x = center - width / 2;
        const y = patch.at[1] - height / 2 + Math.sin(t / 6 + i) * 2;
        a.globalAlpha = 0.86 + Math.sin(t / 4 + i * 2) * 0.14;
        a.drawImage(puff, x, y, width, height);
      });
      a.globalAlpha = 1; // Do not weaken the alpha mask or the front rain pass.
      if (rainPass) for (const drop of raindrops) {
        // One-pixel rain silk: faint tail, brighter head, a slight shared wind
        // direction but independent length/speed/opacity, not identical bars.
        for (let part = 0; part < 4; part++) {
          const start = Math.round(part * drop.length / 4), end = Math.round((part + 1) * drop.length / 4);
          a.fillStyle = `rgba(167,194,211,${drop.alpha * RAIN_TAPER[part]})`;
          a.fillRect(Math.floor(drop.x + start * drop.slant), Math.floor(drop.y + start), 1, end - start);
        }
      }
      a.globalCompositeOperation = 'destination-in'; a.drawImage(bg, 0, 0);
      a.globalCompositeOperation = 'source-over';
      ctx.drawImage(atmosphere, 0, 0);
    }
    function drawEnt(e, now) {
      const pose = e.pose, clip = sprites[e.id][pose] || sprites[e.id].idle;
      const frameMs = e.roam && pose.startsWith('walk_') ? e.roam.frameMs : clip.frameMs;
      const index = Math.floor(Math.max(0, now - e.poseAt) / frameMs) % clip.frames.length;
      const img = clip.frames[index];
      e.frameIndex = index; // Also visible in ?debug / the existing mount handle.
      const fx = Math.round(e.x), fy = Math.round(e.y);
      ctx.save();
      // Motion is already in the authored frames; no second procedural bounce.
      ctx.translate(fx, fy);
      if (pose === 'walk_right' && e.facing < 0) ctx.scale(-1, 1);
      if (lighting) {
        shadeCtx.clearRect(0, 0, FRAME, FRAME); shadeCtx.drawImage(img, 0, 0);
        shadeCtx.globalCompositeOperation = 'source-atop';
        const flickering = !!ambience?.glimmer.flicker && flickerDim;
        let strength = 0;
        for (const light of lighting.lights) {
          const falloff = Math.max(0, 1 - Math.hypot(e.x - light.floorAt[0], e.y - light.floorAt[1]) / light.radius);
          strength = Math.max(strength, falloff);
          shadeCtx.fillStyle = `rgba(${light.color},${light.tintAlpha * falloff * (flickering ? 0.20 : 1)})`;
          shadeCtx.fillRect(0, 0, FRAME, FRAME);
        }
        const darkAlpha = (lighting.uniformShade ? lighting.shadeAlpha : lighting.shadeAlpha * (1 - strength))
          + (flickering ? 0.26 * strength : 0);
        shadeCtx.fillStyle = `rgba(12,18,30,${darkAlpha})`;
        shadeCtx.fillRect(0, 0, FRAME, FRAME);
        shadeCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(shade, -FRAME / 2, -FRAME);
      } else ctx.drawImage(img, -FRAME / 2, -FRAME);
      ctx.restore();
    }
    function drawShadow(e) {
      const x = Math.round(e.x), y = Math.round(e.y);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath(); ctx.ellipse(x, y - 1, 11, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.beginPath(); ctx.ellipse(x, y - 1, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
    }
    function place(e) {      // 气泡跟随说话者头顶（DOM 叠层，文字保持清晰）
      const k = cv.getBoundingClientRect().width / W;
      const half = (bubble.offsetWidth || 0) / 2;
      bubble.style.left = Math.max(half + 8, Math.min(W * k - half - 8, e.x * k)) + 'px';
      bubble.style.top = (e.y - FRAME - 6) * k + 'px';
    }

    const started = performance.now();
    let last = started, running = true, raf;
    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      advance(player, now, dt, SPEED);
      for (const n of all) if (n.poseUntil && now > n.poseUntil) {
        const wasIdleExtra = n.actionKind === 'idle-extra';
        setPose(n, 'idle', now); n.poseUntil = 0;
        n.actionKind = null;
        if (n.idleExtras) n.idleExtraAt = now + extraGap(n.idleExtras);
        if (wasIdleExtra && n.roam) n.roamAt = now + pause(n.roam);
        if (bubble.dataset.owner === n.id) bubble.classList.remove('on');
      }
      for (const n of all) idleExtra(n, now);
      for (const n of npcs) stroll(n, now, dt);
      // Advance once per frame; fog/rain drawing passes do not move particles.
      for (const drop of raindrops) {
        drop.y += drop.speed * dt; drop.x += drop.speed * drop.slant * dt;
        if (drop.y > H || drop.x > W + drop.length) resetDrop(drop, false);
      }
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(backdrop, 0, 0);
      if (ambience) drawAmbience(now - started);
      if (weather) drawWeather(now - started);
      for (const e of all) drawShadow(e); // Floor layer, before either character.
      for (const e of [...all].sort((a, b) => a.y - b.y)) drawEnt(e, now);
      if (glow) {
        ctx.globalAlpha = flickerDim ? 0.20 : 1;
        ctx.drawImage(glow, 0, 0); ctx.globalAlpha = 1;
      } // Local glow shares the same dim beat; the DOM bubble stays unaffected.
      if (weather) drawWeather(now - started, true);
      if (debug) {
        ctx.strokeStyle = '#f0f'; ctx.lineWidth = 1; ctx.beginPath();
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,0,255,.5)'; ctx.font = '6px sans-serif';
        for (let x = 0; x <= W; x += 20) { ctx.fillRect(x, 0, 1, H); ctx.fillText(x, x + 1, 6); }
        for (let y = 0; y <= H; y += 20) { ctx.fillRect(0, y, W, 1); ctx.fillText(y, 1, y - 1); }
      }
      const owner = npcs.find(n => n.id === bubble.dataset.owner);
      if (owner) place(owner);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    // ---- 显示缩放：原生画布/素材不变，点击和气泡使用实际显示比例 ----
    function fit() {
      const avail = root.clientWidth || W;
      const s = opts.responsive ? Math.min(3, avail / W) : Math.max(1, Math.min(3, Math.floor(avail / W)));
      cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px';
    }
    fit();
    const ro = new ResizeObserver(fit); ro.observe(root);

    return { destroy() { running = false; cancelAnimationFrame(raf); ro.disconnect(); root.innerHTML = ''; }, player, npcs, ready };
  }

  global.SceneKit = { mount };
})(window);
