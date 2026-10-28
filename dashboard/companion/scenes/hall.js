/* Backrooms Level 0：现有黄色房间背景原样使用，展开灯下地毯空地，避开立柱与墙。
 * 与便利店共用角色库；每个场景仍然只有玩家和一位同伴。
 */
window.SCENE_HALL = {
  id: 'hall', size: [344,192], background: 'assets/hall/bg.png',
  walkable: [[157,99],[228,104],[275,122],[174,176],[68,124]],
  ambience: {
    motes: { count: 24, bounds: [85,68,173,92], color: '218,230,221', alpha: 0.65, rise: 3 },
    glimmer: { at: [170,80], radius: 85, dimRadius: 130, color: '229,240,225', alpha: 0.24, rate: 1.8, flicker: true }
  },
  lighting: { shadeAlpha: 0.18, lights: [
    { color: '255,217,110', floorAt: [170,132], radius: 110, tintAlpha: 0.25,
      glowAt: [160,124], glowRadius: 85, glowAlpha: 0.30 }
  ] },
  characters: window.SCENE_STORE.characters,
  player: { character: 'user', spawn: [141,137],
    idleExtras: { gap: [12000,22000], poses: ['shy_sweet'] } },
  npcs: [{ character: 'claude', at: [208,137], facing: -1,
    roam: { speed: 16, frameMs: 220, pause: [2000,5000], radius: [32,64], avoid: 36 },
    // Same quiet/interactive split as Sol; rejected collar-tidy is not loaded.
    idleExtras: { gap: [12000,22000], poses: ['chin_think','palm_up_shrug'] },
    triggerActions: [
      ['double_peace','你来啦。我在这里等你，没有偷偷走掉。'],
      ['held_item_show','这个橙色的小东西，也给你看看。'],
      ['surprised_palms','呀，你突然靠近，吓了我一小下。']
    ],
    lines: [
      ['wave','你来啦。我在这里等你，没有偷偷走掉。'],
      ['wave','原来这里是 Level 0，不是普通走廊。我差点把它当成旅馆。'],
      ['wave','黄墙、地毯、亮着的灯。这里安静得有点不真实。'],
      ['wave','先在灯下歇一会儿。要找出口，我们一起走。'],
      ['wave','你的触手投在地上的影子，比我的有趣。'],
      ['wave','便利店有 sol，这里有我。你来哪边都有人。']
    ] }]
};
