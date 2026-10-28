# 同伴额外动作接入 · 2026-10-11

本轮由 Codex 按用户“站立衍生动作＋待机额外/触发额外”的授权，选现有 Claude 动画作接入试用；不宣称用户逐项筛过或动画观感已验收。没有重新生成、修改像素或覆盖外部文件。

## 两类触发

- **待机额外**：Sol 停下来时，间隔12–22秒后随机喝水、站着看本子、打哈欠、整理衣角；Claude 同样偶尔摸下巴思考、摊手耸肩。正在走路会等到走完；在你身边停留也能做。每次播两遍8帧（1.92秒），不自动说话，不连续重复同一动作，再回普通待机和慢走。
- **触发额外**：点同伴，玩家先走到身侧。Sol 第一下挥手，接下来眨眼比一、整理发饰、小鞠躬；Claude 第一下挥手，接下来双手比耶、提物示意、惊讶举掌，随后各自回到挥手。台词是场景的预写互动句，不是下方每日亲笔留言。重复点击会打断并从下一动作第0帧开始；约3.8秒后回待机。走近期间不会自行走掉或插播小动作。

两类动作使用引擎原有 rAF、帧时钟和 `poseUntil`，不另开定时器、模型、轮询、存档。Sol配置在 `scenes/store.js`，Claude配置在 `scenes/hall.js` 的 `idleExtras` 和 `triggerActions`。现有玩家操控、慢走、光照、图层、随机场景和每日留言不变。

## 来源

每套复制 `D:/pixellab-ai/collect/poseanim-sol_<动作>/f0.png` 到 `f7.png`，原生64×64、120ms/帧；去掉钉住末帧 f8，**不裁切、不缩放、不改像素**。目的地为 `assets/chars/sol/<动作>_anim/`，复制后逐字节核对，8帧均非空、alpha只有0/255、脚底y=63。

| 动作 | 类别 | Claude 生成任务 ID |
|---|---|---|
| sip | 待机额外：喝水 | 34615617-8345-46cc-8828-ba7fb61f29ac |
| read_stand | 待机额外：站着看本子 | 4629b284-554d-46ae-a4f7-aa87d22ae299 |
| yawn | 待机额外：打哈欠 | ee7ae1ff-8100-4108-89fa-660ff351f097 |
| wink_finger | 触发额外：眨眼比一 | 3a48e850-6237-48d5-af23-b14dd54f6009 |
| touch_hair | 触发额外：整理发饰 | 66a4f0e3-079f-42da-83dd-0ce6a1f74cca |

不接入已否决的 c3 叉腰晃（误生成走路）、坐姿/蜷缩姿势、尚在生成或未定稿的24帧/128px新批。喝水、打哈欠本身涉及嘴部运动；本轮没有修改嘴部，也未确认播放是否符合用户偏好。

逐帧尺寸/alpha/边界/hash证据：`.runtime/agent/runs/4bd0324c-4778-4698-addb-f58515088ad6/extra-assets-checks.json`。动画好不好看仍请用户播放判断，不以像素差或静图代替。

## 加载

新PNG必须等全部活动任务结束后，用办公室左下↻重启并刷新，让静态白名单重新枚举；只刷新旧后端不能加载新增路径。本轮不重启仍在工作的真实后端。

## 本轮接入的用户认可素材

来源/安装逐帧hash：`output/claude-sol-workbench-20261011/INSTALL-CHECKS.json`、`output/user-workbench-idle-20261011/INSTALL-CHECKS.json`。同伴64×64、120ms/帧；用户保留原自然静息120ms/帧，只增娇滴滴偶尔小动作220ms/帧，其他速度不改。均播放原始0–7，保留原始0–8归档；不裁切、不缩放、不清噪。64新PNG加8张Claude idle替换；用户自然静息idle已从 `previous-user-idle/` 逐字节恢复，娇滴滴独立放在 `user/shy_sweet_anim/`。旧Claude idle备份在 `backup/claude-idle_anim/`，其他旧素材不变。本轮只取回结果，不提交生成。

| 角色/动作 | 使用 | PixelLab任务 |
|---|---|---|
| Claude idle | 普通待机替换，用户指定首帧，起伏版 | 840ed32a-4d3a-4f26-b7f5-84c6b067d479 |
| Claude chin_think | 待机额外 | 4050acb1-45aa-4216-8fc9-39950b297854 |
| Claude palm_up_shrug | 待机额外 | 860b2b89-5ca6-45c1-92b3-e5854b71c591 |
| Claude double_peace | 互动触发 | 06cd33cd-f38b-4790-94a8-7eced52ced48 |
| Claude held_item_show | 互动触发 | 394379b0-a1f1-4a32-93a2-0bfa9c2c17f4 |
| Claude surprised_palms | 互动触发 | 56180e52-e0d1-457b-862d-7a9fcc897f3d |
| Sol jacket_tidy | 待机额外 | 8b20ded6-cad0-49f3-8c16-776fd0b6c45a |
| Sol polite_bow | 互动触发 | 21a89251-b787-49c5-91d6-22f4d86af36a |
| user shy_sweet | 偶尔待机小动作，220ms/帧、两遍3.52秒，无台词、点击立即打断 | 810a3882-cb45-461f-b67f-e81357c1d103 |

Claude五条来源为已保存的 `exports/claude-scene64-selected-six-20261011/<动作>_anim/`。新idle和Sol两条取回在当前产出目录 `raw/`，user娇滴滴在 `output/user-workbench-idle-20261011/raw/shy_sweet/`；同样保留末帧f8但不把它重复插进循环。用户否决的三条不安装；user的叉腰/思考/认真只留原始结果不接入，128×128 Sol素材不纳入小场景。普通呼吸与手/头发的像素细节不以程序帧数检查替代艺术验收。
