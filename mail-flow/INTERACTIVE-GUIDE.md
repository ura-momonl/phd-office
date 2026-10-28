# 交互式邮件快捷说明

适用于当前对话中的读取、拟稿、回复和发送的操作机制；不是后台收件分类规则，也不是发送授权。所有 agents 可用 `node automation/run.mjs mail guide` 按需读取，`outlook-prepare` 也返回同一份。交互式邮件任务的提示词只自动带入简短的 `MAIL-BRIEF.md`（工作目标、材料入口、授权底线），要回复或发送时再读本说明。

## 判断与授权

- 用户已批准具体动作和最终正文、To/CC/BCC、附件后，核对就执行，不再请示、不重新改写。`confirmed_by_user:true` 只记录已有批准，不自行授权。拟稿、看看、卡片选择不等于批准发送。
- 称呼、语气和对已提安排的接受，结合原信、前后问答与用户最新决定自行判断；能查的自己查。只有无法补齐且影响结果或授权的关键缺口才集中问；不得自行增加收件人、金额、截止日期、附件或承诺。
- 回复经 graph 通道一律由服务器生成原生引用，不复刻 Outlook 排版；要无引用就新建邮件。已发邮件不能为补引用擅自重发。

## 一次准备，一次执行并核对

入口统一为 `node automation/run.mjs mail <动作>`。`outlook-prepare`、`outlook` 接受 JSON 文件路径、内联 JSON，或 `-` 从标准输入读。**含邮件正文的请求默认用工具写 UTF-8 JSON 文件，再传文件路径；发送前读回实际文件核对已批准正文。** 内联 JSON／标准输入仍可用，但调用方必须保证编码及转义无损；Windows PowerShell 5.1 的默认文字管道会把弯引号、中文等替换成 `?`，具体管道设置见根目录 `AGENTS.md`，不要依赖 `-NoProfile` 下不会加载的启动配置。无需为此修改系统地区或降低权限；已损坏的已发邮件不擅自重发。

**回复原信：**
```json
{"tools":[],"reads":[],"reply":{"message_id":"原信ID","text_content":"只填新增回复文字"}}
```
传给 `outlook-prepare`，一次取得当前 schema、完整原信、`reply_request_file`、`reply_preview` 和核对方式；准备不发送，也不批准。读取并核对原信、新增文字和回复收件人；准备时程序已读回请求文件并给出 `reply_preview.body_sha256`，你只需确认新增文字是用户批准的那版，不要让模型重抄整封引用。发送时程序还会回读草稿，正文或收件人与请求不一致就不发送并保留草稿。取得用户批准后，仅向该文件增加批准标记、已批准的收件参数，以及需要时的 `verify`；不改 `args.text_content`，然后 `outlook <reply_request_file>`。

Graph 原生回复准备返回 `verification_mode:"immutable_sent_copy"`，发送时自带按不可变 ID 读取已发送副本的核对，不需要连接器的 `verify_template` 或已发送文件夹查询。原生工具的参数查询、原信读取、准备、发送与内置核对不启动 Codex/MCP 连接器；只有明确使用连接器工具、查询完整工具目录，或额外要求 `sent:true` / 连接器 `verify` 时才启动它。连接器自身失败仍按正常授权处理，不绕过。

**原生引用路径（2026-10-15 起已启用，`mail-flow/config.json` 的 `replyTransport:"graph"`）：** 准备保存 `reply_native` 请求，`text_content` 只含新增文字，To 按原信 Reply-To（否则 From）显式列出，CC/BCC 为空；如需改变收件范围须按用户批准修改。`quote_mode:"server_native"`、`quote_verified:false` 表示准备阶段尚未创建服务器引用，不是引用失败。发送时程序创建原生回复草稿，保留其 HTML 引用，在顶部加入转义后的新增文字及换行，回读核对正文和收件人后只发送一次，再用不可变 ID 读取已发送副本。引用是否在收件端折成“…”仍须实际验收。出错保留草稿及动作记录，不改回纯文本重发。Graph 会话报“无已保存登录”或登录过期时，如实报告并让用户按 README 重新登录（两个设备码，建议在用户自己的终端运行）；不改回纯文本重发，也不反复发码。被拒发或诊断留下的草稿本通道无法删除，请用户在 Outlook 里手动删。

**正式 Outlook 会议邀请（不是普通 .ics 附件）：**

`outlook-tools create_event_native` / `fetch_event_native` 查询当前参数。建会需要用户批准标题、正文、时间、地点和完整与会者；`POST` 创建会议时服务器立即发邀请，不另调发信工具。仍走 `outlook` 的批准、审计和24小时防重复入口，成功后用事件 ID 读回核对；超时不重试，不把读回失败当作未发送。后台收件没有此能力。

先明确执行 `node automation/run.mjs mail graph-login calendar`，由用户本人完成微软 `Calendars.ReadWrite` 授权；`mail graph-status` 查看当前设备码和完成状态（必要时会出现第二个设备码）。普通邮件登录不增加日历权限。创建工具用 `start_utc` / `end_utc`（`YYYY-MM-DDTHH:mm:ssZ`），助手须先换算并核对用户约定的当地时区。只支持默认日历的创建和按 ID 读取，不修改、删除、批量邀请或操作其他账户。房间仅写作地点，不自动邀请资源邮箱。Gmail/Outlook 收件端的会议卡片、接受/拒绝与入账仍需实际验收。

**新建邮件：**
```json
{"tools":["send_email"],"reads":[],"sent":true}
```
传给 `outlook-prepare`，取得发送 schema 和已发送箱核对模板，再按批准参数执行：
```json
{"tool":"send_email","args":{"to":[{"email":"已批准的收件地址"}],"subject":"已批准的主题","text_content":"已批准的正文"},"confirmed_by_user":true,"verify":{"tool":"list_messages","args":{"folder_id":"准备返回的sent_folder.id","order_by":"sentDateTime desc","top":3}}}
```
以上占位文字不是可直接发送的参数，也不构成用户批准。需要附件时按当前 schema 的 `attachment_files` 填绝对本地路径或路径数组，批准必须覆盖附件；上传失败停止，不重试。

**转发邮件（`forward_email`，立即发出、不能撤回）：** 发送前先用 `fetch_message` 读 `message_id` 对应的那封，核对发件人、时间、主题确实是用户要转发的那封（实际出过错：转发成了用户自己先前发出的那封，而不是别人的回复），再取得用户对收件人和说明文字的批准。实测（2026-10-15）`comment` 的换行不按纯文本处理：单个换行会被合并成一行，段落之间要空一行，要保留单个换行就在行尾加两个空格再换行。发出后读已发送副本，核对被转发的邮件、收件人和换行。

**其他读取或操作：**按需把短工具名放进准备请求的 `tools`，把独立只读查询放进 `reads:[{tool,args}]`，程序并行读取。只有不知道工具名时才用 `outlook-tools` 看目录；已知名称用 `outlook-tools <工具名>`，不每次拉全量目录。快捷说明够用就不重复读 README、不加载不相关技能；更复杂的限制见 `mail-flow/README.md`。

## 读取附件和正文内嵌图

已启用 Graph 的办公室可直接保存图片原字节，不经过连接器云端文件引用：

```json
{"tool":"list_attachments_native","args":{"message_id":"原信ID"}}
```

用 `mail outlook <JSON文件>` 列出附件（包含 `is_inline` 为 true 的内嵌图），选中后：

```json
{"tool":"download_attachment_native","args":{"message_id":"同一原信ID","attachment_id":"列表返回的原样ID"}}
```

结果返回本地 `path`、`bytes`、`sha256` 和 `content_id`；原文件保存在 `output/mail-attachments/` 的独立目录，同名不覆盖。图片可直接打开；HTML 中 `cid:` 用下载结果的 `content_id` 对应。不要只凭 `hasAttachments:false` 排除内嵌图。此能力只读邮箱、不会标记已读，不发信、不自动跟随正文外链或加载跟踪图；链接型附件和附加邮件条目不当作图片文件下载。原始 HTML 仍用 `fetch_native` 获取。

工具 schema 查询不启动 Graph 登录。真实下载需要一条已就绪的只读登录且账户与配置一致：受限 shell 里 SDK 会话起不来（设备码打不出来、`Connect-MgGraph` 静默卡住），这时用 `node automation/run.mjs mail read-login` 拿设备码、用户本人完成微软登录（只申请 Mail.Read），`read-status` 续查状态，然后照上面的 JSON 调用即可。旧 `graph-status` 的成功记录不代表今天已连接。连接器 `get_profile` 是服务端返回的资料，不是按办公室配置切换身份的命令；报告与配置不同意味着邮箱身份未核实，不应宣称已读取那个邮箱。可继续查询 schema 和 profile 排错，实际连接器邮件读取、上传和写入会先核对资料。

## 核对与失败

- `app-server exited` 或 `Graph SDK process exited` 是进程启动结果，不足以判断登录过期或附件不可获取。本机已观察到沙箱内立即退出、经正常工具授权后宿主连接器可启动；按工具正常授权排查，不据此重置登录，也不把让用户重贴图片当作唯一入口。
- 比较实际返回的正文、To/CC/BCC、附件及引用；`verification` 只是读取结果，`returned` 只是连接器返回成功，都不等于送达。找不到已发送文件夹时先解决核对入口，不能凭空填写 ID。
- 发送后立刻读回，已发送副本的 `isDraft` 可能仍为 true（`verification.status:"pending"`）。`sentDateTime` 有值或动作记录为 `returned` 时，都不能当作未发送，不要因暂时的 `isDraft:true` 判定失败或重发；实际状态继续以已发送箱的只读核对为准。
- 不自动重试写操作。超时或异常先只读查邮箱状态；核对失败保留动作结果，不重发。程序拦截24小时内相同参数的重复发送，只有用户明确要求再发才可加 `allow_repeat:true`。
- 工具权限拦截或登录失败如实报告，走正常授权，不换命令绕过。后台收件保持只读，本说明不改变它的权限。
