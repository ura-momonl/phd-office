# Discord 远程交流

默认使用你的 Discord 私有频道。复用 discord.js 的官方实现，只接收明确的斜杠命令；无需 Message Content Intent，不监听日常闲聊，不自发拉起两个模型。

默认只提醒新收件箱事项。按钮点击、手机实际显示和锁屏推送要在真机上分别确认，隔离测试不等于真实点击。

## 一次配置

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 建个人应用和 Bot，取 Bot Token。
2. 邀请到你的私人服务器（Add to server，不是 Add to my apps）；作用域选 bot、applications.commands，权限给 View Channels、Send Messages、Embed Links（嵌入链接，卡片所需）。不选 Administrator；私有频道也要允许机器人访问。
3. Discord 设置 Advanced 打开 Developer Mode，复制服务器、私有频道和本人用户 ID。
4. 将 remote/config.example.env 复制为 .runtime/discord.env，在本地填 Token 与三个 ID；不要把 Token 贴到聊天里。默认 `DISCORD_NOTIFY=inbox` 仅同步收件箱；`tasks,inbox` 额外通知任务结果，`tasks` 仅任务结果，留空关闭主动通知。改配置或代码后重启桥接器生效，不要双开。
5. 双击 ../Open-Discord-Bridge.cmd，或运行 package.json 中的 discord 命令。只接受指定的本人和频道。

## 入口

| 命令 | 当前行为 | AI 用量 |
|---|---|---|
| /status | 当前任务数、邮件队列和最近收件情况 | 0 |
| /tasks | 新工作请求清单 | 0 |
| /inbox | 需要你处理的事项 | 0 |
| /weekly | 本周计划和上周复盘 | 0 |
| /usage | 已缓存的账号额度与实际调用记录 | 0 |
| /task | 把目标交给本机 agent 执行，无需指定负责人 | 执行时按实际任务调用模型 |
| /handoff | 读取一个任务的短交接 | 0 |
| /chat | 自然对话，可用 @Codex、@Claude；可选择项目或新对话 | 实际执行消耗订阅；交接沿用工作台配置 |

先启动电脑端工作助手，再启动桥接器。桥接器通过本机 HTTP `/api/chat` 交给同一个执行器，接单后立即返回任务和对话 ID，不另起工作进程。`/chat` 的 new 选项开始新对话，project 可填写项目 ID；否则接续 Discord 最近一次对话。`/task` 也走同一个接单入口。电脑端可查看完整结果和进度，普通消息不会调用模型。

## 主动通知

- 默认只同步新出现的收件箱事项（按事项 ID 去重），发到配置的私有频道，仅 @ 本人；同一事项更新、重新出现或重启均不再通知。没有收件箱事项的普通任务完成不提醒。原有 /chat、/task 等手动指令保留，通知本身不调用模型。
- 收件箱使用 Discord Embed 卡片：短标题、事项类型、分类、优先级、原始日期和底部事项 ID。常规绿色、优先琥珀色、紧急红色，颜色之外也显示文字级别；不添加无法从手机访问的 localhost 链接或假操作按钮。
- 通知只带短标题、状态/日期、ID 和选项标签，不自动发送邮件正文、原始结果、附件或科研数据。通知本身不代表审批通过；只有本人明确点击具体选项才记录选择，邮件发送、付款等仍遵循原工作台的具体确认规则。
- 卡片同步 reply／accept 类型的具体选项，排除“进入对话”、导航、自由讨论和对照链接。点击只接受配置的本人／频道／服务器，按钮 ID 包含当前事项指纹和动作 ID 的哈希。回复沿用工作台原有 respond API；accept 沿用工作台的 acknowledgeInbox 同步函数。旧版本或已处理的按钮不执行；回复类选项会按工作台原规则调用模型，accept 只记录处理，不自行发送邮件或付款。
- 一个桥接器每 15 秒读取本地状态，无模型调用；没有每条任务独立轮询。电脑、工作台和桥接器须保持运行。
- Windows 登录自启：`powershell -NoProfile -File remote/Install-Startup.ps1` 安装当前用户 Startup 快捷方式，指向隐藏 VBS 启动入口；双击 Open-Discord-Bridge.cmd 也走同一入口。运行日志：`.runtime/remote/output.log` 和 `error.log`。不启动新模型，不注册周期重启或发送重试，不改变工作台的自启设置。
- 停止后台桥接器：`powershell -NoProfile -File remote/Stop-Discord.ps1`；禁用下次登录自启：`powershell -NoProfile -File remote/Install-Startup.ps1 -Uninstall`（不停止当前进程）。启动和停止都验证绝对桥接器路径与锁中的进程身份，拒绝误停其他 Node；启动重复调用复用已有进程。
- 首次启用或更换频道/本人/通知范围时，现有历史结果和待办只建立基线，不集中补发。后续重启保留去重账本，停机期间尚在当前状态里的新结果/问题会在恢复后检查；短暂出现后已消失的事件不会补发。
- 通知独立于斜杠命令的回复令牌，所以没有原来的 9 分钟等待上限，也不依赖 [Discord 的 15 分钟 interaction token](https://docs.discord.com/developers/interactions/receiving-and-responding)。平台与手机通知设置仍可能影响实际推送，必须做真实手机验收。
- `.runtime/remote/notifications.json` 保存通知版本和发送结果。发送前登记，失败/结果未知不自动重发；Discord REST 的服务错误重试也关闭。失败时本地只记状态，不记录 Token 或响应正文；需要结果可从工作台或 `/handoff` 取。
- `.runtime/remote/bridge.lock` 防止双开重复发送，正常退出释放。异常中断留下锁时，先确认桥接器进程已经退出，再本地清理锁；不要在运行中删除。

只读配置检查（不连接 Discord、不发送消息）：

```powershell
node --env-file-if-exists=.runtime/discord.env automation/run.mjs remote check
```

本地隔离测试（无 Discord／模型／浏览器连接，按办公室流程申请子进程权限）：`node scripts/run-tests.mjs --remote --keep`。真实验收只在出现真实的新收件箱事项时做：确认频道卡片显示正确、重复检查不再通知、手机锁屏有推送；示例卡片或临时测试消息需用户明确批准，不向真实收件箱塞测试事项。

研究资料如通过 /chat 提交会经过 Discord；大文件和原始数据留电脑。远程接单不赋予额外权限，邮件对外发送等仍须明确批准具体动作。

## MCP 是否需要暴露

这条路线 **不需要向公网暴露 MCP**：电脑上的机器人主动连接 Discord，AI CLI 与软件连接器留在本机。已有 AutoCAD/Altium 使用本机 stdio，Fusion 是本机 HTTP；保留原路径。

如果以后要让云端 ChatGPT 直接访问本机工具，才单独评估带认证的远程 MCP。Tailscale 私网用于手机看工作台/远程电脑，不能据此假设云端 ChatGPT 能访问私网地址。当前没有开公网端口、Funnel 或无认证隧道。

## 已有项目评估

[claude-code-discord-bot](https://github.com/timoconnellaus/claude-code-discord-bot) 源码保存在 vendor/claude-code-discord-reference。它默认每条消息启动 Claude、每频道持续恢复上下文，并需要 Bun；这些默认行为与当前预算/短会话策略不符，所以没有直接运行。当前复用 [discord.js](https://github.com/discordjs/discord.js) 做小入口，沿用项目现有任务与单次判断模块。

[Happy](https://github.com/slopus/happy) 是以后可选的 Codex/Claude 手机客户端；现在按用户偏好以 Discord 为主，不安装第二个远程常驻桥。
