/* 场景配置：便利店（45° 俯视小房间）。
 * walkable 按地砖空地展开，避开冰柜、货架与右前方柜台。
 * 新增场景 = 复制本文件，换背景、多边形、同伴和台词即可；引擎不用改。
 */
(() => {
  const animation = (character, pose) => ({
    frames: Array.from({ length: 8 }, (_, i) => `assets/chars/${character}/${pose}_anim/f${i}.png`),
    frameMs: 120
  });
window.SCENE_STORE = {
  id: 'store',
  size: [344, 192],
  background: 'assets/store/bg.png',
  // 可走地面（原生像素，顺时针）
  walkable: [[170, 92], [232, 121], [191, 147], [151, 159], [82, 128]],
  ambience: {
    glimmer: { at: [232,57], radius: 75, color: '255,190,105', alpha: 0.42, rate: 0.70 }
  },
  // Display-only light layers; original image pixels remain untouched.
  lighting: { shadeAlpha: 0.192, lights: [
    { color: '86,203,255', floorAt: [135,108], radius: 100, tintAlpha: 0.272,
      glowAt: [117,82], glowRadius: 78, glowAlpha: 0.336 },
    { color: '255,165,60', floorAt: [218,109], radius: 76, tintAlpha: 0.24,
      glowAt: [232,57], glowRadius: 65, glowAlpha: 0.28 }
  ] },
  // 原自然静息保留120ms；仅娇滴滴小动作220ms。只翻转横向左走。
  characters: {
    user: { name: '你', sprites: {
      idle: animation('user','idle'), wave: animation('user','wave'),
      shy_sweet: { ...animation('user','shy_sweet'), frameMs: 220 },
      cheer: 'assets/chars/user/cheer.png', walk_right: animation('user','walk_right'),
      walk_front: animation('user','walk_front'), walk_back: animation('user','walk_back') } },
    sol: { name: 'sol', sprites: {
      idle: animation('sol','idle'), wave: animation('sol','wave'),
      sip: animation('sol','sip'), read_stand: animation('sol','read_stand'),
      jacket_tidy: animation('sol','jacket_tidy'), polite_bow: animation('sol','polite_bow'),
      yawn: animation('sol','yawn'), wink_finger: animation('sol','wink_finger'),
      touch_hair: animation('sol','touch_hair'),
      cheer: 'assets/chars/sol/cheer.png', walk_right: animation('sol','walk_right'),
      walk_front: animation('sol','walk_front'), walk_back: animation('sol','walk_back') } },
    // Library entry only: Claude is not spawned in this scene.
    claude: { name: 'Claude', sprites: {
      idle: animation('claude','idle'), wave: animation('claude','wave'),
      chin_think: animation('claude','chin_think'), palm_up_shrug: animation('claude','palm_up_shrug'),
      double_peace: animation('claude','double_peace'), held_item_show: animation('claude','held_item_show'),
      surprised_palms: animation('claude','surprised_palms'),
      walk_right: animation('claude','walk_right'),
      walk_front: animation('claude','walk_front'), walk_back: animation('claude','walk_back') } }
  },
  player: { character: 'user', spawn: [140, 120],
    idleExtras: { gap: [12000,22000], poses: ['shy_sweet'] } },
  npcs: [
    { character: 'sol', at: [205, 112], facing: -1,
      roam: { speed: 16, frameMs: 220, pause: [2000,5000], radius: [32,64], avoid: 36 },
      // Quiet standing interludes; no automatic speech. Clicks always interrupt.
      idleExtras: { gap: [12000,22000], poses: ['sip','read_stand','yawn','jacket_tidy'] },
      // After the first wave: wink, adjust hair ornament, bow, then wave again.
      triggerActions: [
        ['wink_finger', '只许选一样零食？那我先选和你分着吃的。'],
        ['touch_hair', '发饰没歪吧？……好啦，站近一点也给你看。'],
        ['polite_bow', '来啦？那我也认真地和你打个招呼。']
      ],
      // [姿势, 台词]。占位台词，用户可直接改；不写工作进展类断言。
      lines: [
        ['wave', '哼哼，这家店我先到的，所以是我的。'],
        ['wave', '来啦？冰柜那边的饮料，我替你看过了。'],
        ['wave', '……（盯）你是不是又忘了喝水。'],
        ['wave', '今晚的快乐可以很简单，比如分一包薯片。'],
        ['wave', '深夜便利店，是不是有一种偷偷出门的感觉？'],
        ['wave', '薯片我没动，只是在检查保质期。'],
        ['wave', '别笑，我看着冷静，其实是在比较饭团。'],
        ['wave', '要不要坐一会儿？反正没人催。']
      ] }
  ]
};
})();
