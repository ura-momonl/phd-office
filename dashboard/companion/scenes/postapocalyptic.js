/* Two compact post-apocalyptic scenes. Reuse the accepted character library
 * and idle/trigger behavior; only floor, lighting and scene dialogue differ.
 * Coordinates are native pixels and mark the feet, not the sprite center.
 */
window.SCENE_SUNSET_DINER = {
  id: 'sunset-diner', size: [344,192], background: 'assets/sunset-diner/bg.png',
  // Open floor below the counter/table; keep the fridge and foreground plants out.
  walkable: [[158,134],[218,128],[255,140],[174,178],[113,151]],
  ambience: {
    motes: { count: 42, bounds: [78,42,151,117], color: '255,210,137', alpha: 0.95, rise: 5,
      halo: { radius: 3, alpha: 0.28 } },
    glimmer: { at: [109,57], radius: 82, color: '255,186,107', alpha: 0.30, rate: 0.50 }
  },
  lighting: { shadeAlpha: 0.16, lights: [
    { color: '255,177,91', floorAt: [145,146], radius: 88, tintAlpha: 0.22,
      glowAt: [112,70], glowRadius: 76, glowAlpha: 0.24 }
  ] },
  characters: window.SCENE_STORE.characters,
  player: { ...window.SCENE_STORE.player, spawn: [137,148] },
  npcs: [{ ...window.SCENE_STORE.npcs[0], at: [194,148],
    triggerActions: [
      ['wink_finger','最后一缕夕阳也分你一半，怎么样？'],
      ['touch_hair','风把头发吹乱了？那你帮我看一眼。'],
      ['polite_bow','欢迎来到这间旧店，今天只招待你。']
    ],
    lines: [
      ['wave','这家店旧归旧，夕阳还是很认真地照进来。'],
      ['wave','那株小草连地砖都顶开了，有点厉害。'],
      ['wave','来我旁边站一会儿，这块地面暖暖的。'],
      ['wave','收音机不响也没关系，你来了就不那么安静了。']
    ]
  }]
};

window.SCENE_RAINY_STATION = {
  id: 'rainy-station', size: [344,192], background: 'assets/rainy-station/bg.png',
  // Outdoor platform: keep feet on the paving, below the bench and signpost.
  walkable: [[163,99],[267,126],[171,172],[80,126]],
  // Uniform night grade everywhere; only the immediate lamp area adds warm tint.
  // Equal side dimming, mirrored around x=172; leave the foreground untouched.
  backgroundShade: [
    { at: [97,118], radius: 62, alpha: 0.12 },
    { at: [247,118], radius: 62, alpha: 0.12 }
  ],
  weather: {
    rain: { count: 104, speed: [220,396], length: [18,34], alpha: [0.48,0.90] },
    fog: [
      { at: [100,120], radius: 43, alpha: 0.35, speed: 6 },
      { at: [246,128], radius: 45, alpha: 0.35, speed: 5 },
      { at: [176,146], radius: 39, alpha: 0.245, speed: 7 }
    ]
  },
  lighting: { uniformShade: true, shadeAlpha: 0.22, lights: [
    { color: '105,171,207', floorAt: [180,130], radius: 52, tintAlpha: 0,
      glowAt: [178,112], glowRadius: 80, glowAlpha: 0.10 },
    { color: '255,185,87', floorAt: [173,108], radius: 30, tintAlpha: 0.12,
      glowAt: [174,16], glowRadius: 76, glowAlpha: 0.24 }
  ] },
  characters: window.SCENE_STORE.characters,
  player: { ...window.SCENE_HALL.player, spawn: [140,128] },
  npcs: [{ ...window.SCENE_HALL.npcs[0], at: [201,126],
    triggerActions: [
      ['double_peace','不用赶车，今天可以慢慢待着。'],
      ['held_item_show','你看，这一点暖色在雨夜里特别亮。'],
      ['surprised_palms','呀，雨声把你的脚步藏起来了。']
    ],
    lines: [
      ['wave','站台还湿着，我们先在灯边待一会儿。'],
      ['wave','这株小蕨长得挺好，旧车站也没完全睡着。'],
      ['wave','来啦。这里没人催我们去下一站。'],
      ['wave','雨声很大，你站近一点，我就听得到。']
    ]
  }]
};
