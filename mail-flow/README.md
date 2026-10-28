# 低消耗的邮箱事务流程

双击 `../Open-Mail-Flow.cmd` 查看当前事项。唯一活跃账本是 `../.runtime/mail-flow/mail.sqlite`；旧邮箱看板只作历史。

流程：读取 → 去重 → 待判断队列 → 小批次判断 → 程序校验写入 → `today.md`。收件、去重、日期复查和清单生成都是普通 Node 程序，直接调用已连接的 Outlook，不经 OpenClaw、不启动模型轮次。

## 成本策略

- 收件程序不调用模型；判断由工作台服务在有新判断包时自动发起（见 `automation/CLAUDE-REVIEW.md` 的“无人值守邮件闭环”，可在 `agent/config.json` 关闭）。没有新增内容就没有判断请求。
- 每十分钟收集一次。首次读最近 24 小时；之后从上次完整读取时间续读并重叠 20 分钟。精确消息 ID 和内容指纹去重，已读状态变化不触发重判。每轮最多 6 页、每页 20 封；未完成的读取保存接口返回的位置，Inbox 和 Sent 都完成才推进时间。这是时间窗口读取，不是 Graph delta；邮件移动可能改变 Graph ID，线程不保证完全自动去重。每天最多 144 次程序触发，不等于 144 次模型调用。
- 无回复不代表未完成，有回复也不代表已完成；无法确定的保留供核实。Piazza、培训和 no-reply 邮件不因发件地址被丢弃。
- 一个判断包最多 8 封、6000 UTF-8 字节，仅带相关事项和每封最多 700 字正文；未入包的留在队列，正文不足就补证据再判断，不以裁剪内容推断事实。6000 字节是资料包大小，不是模型 token 或额度的上限。判断包及清单内容不变就不重写。
- `FW:`／`Fwd:`／`转发:`（含前置回复前缀）的正文保留内层转发资料、标题与链接，不当旧回复历史截掉；普通回复的历史裁剪不变。真人明确建议组内阅读指定论文应保留阅读动作；只点名别人的讨论安排不变成用户的承诺。人工纠正单封遗漏可用 Flow 的单信包，不批量重判历史邮件。
- 两级模型只看本批次短编号（邮件 m1…、事项 t1…、packet_id=batch），不复制 Outlook 长 ID 或指纹；程序映射回原 ID，仍由 Flow 校验写入。每级先校验编号、唯一性和完整覆盖，初筛失败不再花一次强模型调用。后台邮件每级最多 120 秒、16000 输出字符，原生流式文本越界即停；这些上限只用于后台邮件判断。每包失败最多 3 次、间隔 5 分钟退避。
- 合批：`agent/config.json` 的 `mail_batch_wait_minutes=15`、`mail_batch_min_messages=4`，按最早邮件的收信时间计，满 4 封或满 15 分钟就判断；新来信、重启和换包不重置最早时间。只有完整正文经程序检查没有时间敏感／操作提示、无关联事项且不属科研／教学的收件才可等待；关联事项、费用／回复／截止等提示、补长正文、已发送证据或缺可等待证据立即判断，混合包全部立即判断。等待分钟设 0 可关闭。
- 优化优先减少调用次数、重复上下文和无用操作：程序先识别已知来源和明确通知模板，重要回复、关键承诺、价格／政策判断、证据冲突再补证据或用强模型；不仅凭模型自报“高置信度”丢邮件。

## 使用

```powershell
& 'D:\Program Files\nodejs\node.exe' mail-flow/run.mjs collect   # 只读邮箱，更新本地清单和判断包
& 'D:\Program Files\nodejs\node.exe' mail-flow/run.mjs status
& 'D:\Program Files\nodejs\node.exe' mail-flow/run.mjs packet    # 不调模型
& 'D:\Program Files\nodejs\node.exe' mail-flow/run.mjs apply .runtime/mail-flow/decisions.json
```

按 `REVIEW-PROMPT.md` 判断一个包并保存 decisions.json，再 `apply`。AI 只负责理解和选择下一步，程序负责状态写入：`ignore/defer/update/new` 是自动流程支持的决定；`done`、发送邮件、修改邮箱、采购都不在其中。

粗筛识别明确 newsletter／digest、可选公共活动和 FOM 空闲模板（后者视为垃圾，不列入）；与现有事项、研究关键词、课程通知、截止／提交／回复／报价相关的留给判断。粗筛通知存本地 `notifications.md`（最近 50 条），邮箱本身不删除、不移动。所有邮件（含被筛掉的）都留在数据库，`search "<关键词>"` 只读查找；`defer` 或 filtered 的邮件可用 `requeue <精确消息ID>` 在证据增多后重新入队。没有自动重试模型或无限工具循环。

后台收件、连接器读取和新建信通过独立安装的官方 Codex CLI app-server（可用 `MAIL_FLOW_CODEX_BIN` 指定路径）；Graph 原生回复和会议工具直接用微软官方 SDK，不依赖此连接器。连接器调用由官方 CLI 管理账号凭据；批准的附件上传例外，会在内存读取现有 ChatGPT 登录文件，仅用于原生文件接口，不复制、输出或记日志。

## 收件箱与处理入口

收件判断直接给出事项和下一步，不默认另跑模型补写卡片（`automatic_cards=false`）。“让 agent 处理”直接进入 work，读／查／拟稿等由助手继续，普通产出在对话交付；确需关键决定或具体对外动作批准才发卡。历史卡 agent-check 仍按 ask 解析，旧 JSON 不当工作指令。已完成事项只在主题精确匹配时进入判断证据；分类器不能把 done 改回 todo；真实新动作另建；资讯／可选介绍不因可以设想“核对”而成为必办；重要要求不明则 defer，原信仍可检索。

## 邮件进入工作会话的边界

邮件层保存来源和关注线索，交互 agent 按用户目标决定实际工作；后台 action 不是用户确认的事实，也不限定交付物。卡片点击是真实交办，程序附带的判断单独标注。

- 工作轮由 `taskEvidence(...,{complete:true})` 提供完整的账本规范化文字和 message ID（按时间排序，不再截断“三封／1200字”）；账本文字不等于原始 MIME 或附件，按需用只读 Outlook 接口获取。
- 工作上下文分开提供 `source_messages`、`background_assessment`、来源混合的 `legacy_context` 和本地文件指针；不把旧草稿正文当独立邮件证据。
- 项目关联默认只给资料入口，agent 按任务选择：`projects outline <项目id>`（研究目录）、`projects read-nodes <项目id>#<节点>`（子树原文）、`projects context <项目id>`（执行事项）。普通会议邀请不因关联有 FRAMEWORK 的项目就通读研究资料；没有框架时明确说明，不编造现状。
- 续接分别比较入口、执行事项和原始证据的变化，变化时只发简短失效通知，按需重读。
- 回复、科研记录等是按需能力，不是每封邮件的固定步骤；发送成功不代表合作、实验或整件事项完成。

## 两位助手共用的交互 Outlook 工具

快捷入口 `node automation/run.mjs mail guide`。`INTERACTIVE-GUIDE.md` 是发信／回复机制的同一来源（`mail guide` 与 `outlook-prepare.guidance` 共用）；交互式邮件任务只自动注入简短的 `MAIL-BRIEF.md`，要回复或发送时再读完整说明。说明注入不授予发送权限；后台收件判断两者都不注入。

```powershell
node automation/run.mjs mail outlook-tools                     # 只列目录
node automation/run.mjs mail outlook-tools reply_to_email      # 返回当前完整 inputSchema
node automation/run.mjs mail outlook-prepare <JSON文件>
node automation/run.mjs mail outlook <JSON文件>
```

请求可为文件路径、内联 JSON（以 `{` 开头）或 `-`（读标准输入）。含邮件正文默认用 UTF-8 JSON 文件并在发送前读回核对，避免 Windows PowerShell 5.1 默认 ASCII 管道丢字。读取工具按连接器 `readOnlyHint` 放行；非只读或无该标记的操作须 `confirmed_by_user:true`，表示用户已批准具体动作和最终参数，不是程序替用户取得许可。可直接发送或回复，不强制建草稿。程序只拒绝未知工具、缺必填项和不支持的顶层参数，其余校验由连接器完成；工具拒绝、权限要求和登录错误停止交用户，不绕过。

```json
{ "tool": "send_email",
  "args": { "to": [{"email": "recipient@example.org"}], "subject": "用户已确认的主题", "text_content": "用户已确认的正文" },
  "confirmed_by_user": true }
```

（仅示例，不能据此发送。）

**`outlook-prepare`**：`{tools:[…], reads:[{tool,args}], reply?:{…}}`。一次返回所选工具的完整当前 schema 和按序的读取结果；先验证整个请求，`reads` 只接受 `readOnlyHint=true` 的工具，混入写操作整组拒绝；读取失败只在该项返回 error。带连接器 `reply` 或显式 `sent:true` 时，同一并行轮读 `list_mail_folders`，返回 `sent_folder` 与 `verify_template`（`list_messages`、已发送箱、`sentDateTime desc`、top 3），缺该工具则返回 `sent_folder_error` 不阻断。Graph 原生 `reply` 默认不查文件夹。返回含简版 `guidance`。

**发送＋核对**：保留 `{tool,args,confirmed_by_user:true}`，可加只读 `verify:{tool:"list_messages",args:{…}}`。主动作只调一次，成功后同一连接执行一次 verify；助手自己比较返回邮件的收件人、正文、时间、线程。`verification.status="returned"` 只表示核对读取返回，不等于找到目标邮件或送达；空列表或字段不足如实报告未确认；读取失败保留动作结果和 `status:"error"`，不重发；主动作异常或被拒则停止，不自动 verify 或重试，另行只读查状态。核对不是用户审批，也不关闭整件事项。

**防重复**：派发（和上传）前拒绝 24 小时内同工具、同 args 的 reply／send／forward／schedule（以 `outlook-actions.jsonl` 每个动作 ID 的最新状态判断，error 不算）；用户明确要求再发一次才在请求顶层加 `allow_repeat:true`。

**审计与超时**：调用前后记录 `.runtime/mail-flow/outlook-actions.jsonl`（动作 ID、工具、参数 SHA256、attempted／returned／error／unknown、返回的消息 ID），不记正文、附件内容或凭据。`returned` 只表示连接器返回成功，不证明送达；超时或进程退出可能已有外部效果，先查草稿／已发送箱，不自动重试。写操作只有文本返回也可能成功，不能因无结构化对象再次发送。

普通 Codex 对话的 apps 和 Claude 的直接连接器未启用，不代表 Outlook 不可用；两边从同一 CLI 入口按需调用已登录的 Codex Outlook 连接器，不开模型轮次，不需要桌面或浏览器登录。此入口独立于收件账本与锁；自动收件只保留三个读取操作。

### 连接器工具边界

- `create_reply_draft` 不接收 `to`；`reply_all` 控制回复范围，`cc` 与 Outlook 已带收件人合并而非替换。先读来信及发件人／Reply-To，建成后回读核对 To/CC；对已发送邮件调用回复工具可能回复自己。
- **`reply_to_email` 有可选 `to`、`cc`、`bcc`，且立即发送**，不要未经批准调用它“试试”。它只接受纯文本正文，没有 HTML 或保留引用开关，不能把“用了回复工具”当作“保留了原文引用”，也不能凭 RE 主题判定线程一致。
- 没有修改草稿正文／收件人、按草稿 ID 发送、永久删除邮件的专用工具；`send_email` 按传入正文新发邮件。`move_email` 可移到 `deleteditems`（不是永久删除，仍需授权，可能改变消息 ID）。`draft_email` 没有原消息 ID／线程头参数，不保证按原线程回复。
- **附件**：`outlook-tools <工具名>` 显示 `file_parameters` 和本地入口 schema，附件参数填一个绝对路径或路径数组（不填 base64、URL 或文件引用对象），程序按工具的 `openai/fileParams` 元数据完成上传转换。每个附件须为非空普通文件且小于 3 MiB（本地限制，远端限制仍适用）；批准检查、只读核对参数检查和全部文件检查在任何上传前完成；读取一次固定字节，上传一次、派发一次。返回 `attachments` 只含文件名、字节数和 SHA256。上传复用当前原生 ChatGPT 登录和文件流程（`https://chatgpt.com/backend-api/files` 的创建、blob 上传、完成），这是客户端内部协议，不保证未来兼容；凭据只用于原生文件接口，登录或上传失败停止，不自动刷新或重试。自动收件仍只读，不上传。

### 原始图片和文件下载

交互入口支持 `list_attachments_native {message_id}` 与 `download_attachment_native {message_id,attachment_id}`，通过原有 Graph SDK、原有账户检查直接把普通文件附件／内嵌图片保存到 `output/mail-attachments/`，返回可打开的本地路径和读回 SHA256，不把 base64 输出给模型。完整调用示例见 `mail guide`。列表不依赖 `hasAttachments`，下载结果的 `content_id` 可对应原始 HTML 的 `cid:`。同名文件各存独立目录，邮件里的文件名不控制目标路径；不自动访问外链图片、referenceAttachment 或 itemAttachment。

附件接口在 SDK 进程中仅允许当前邮箱的 GET 列表与单附件读取；不增加后台收件能力、授权 scopes、模型调用或自动重试。实现 `downloads.mjs`，离线覆盖 `downloads.test.mjs`。连接器资料与配置不符时，交互邮件操作与后台收件都在请求邮件内容前停止；资料返回不等于已证明能访问另一人的邮箱。schema 和 profile 诊断仍可使用。

### 原生 HTML 回复（Graph 通道，已启用）

`mail-flow/config.json` 的 `replyTransport:"graph"`：`outlook-prepare` 的普通 `reply` 用 `fetch_native` 读原信，保存 `reply_native` 请求；正文只含新增文字，绝不在本地复制引用，引用由服务器生成，Graph 未就绪时不静默回退重发。要无引用须新建邮件（须用户批准）。退回旧纯文本路径：删掉该配置项（旧已准备文件按其明确的旧工具执行，不自动再引用旧全文）。

- 原生工具名以 `_native` 结尾，由本地注册；未知或未启用的该类名字在任何连接器发现、认证、读取或发送前拒绝，并列出可用原生工具（如原信读取用 `fetch_native`，没有 `fetch_message_native`）。原生工具的 schema、读取、回复准备和发送不启动 Codex/MCP 连接器；准备返回 `verification_mode:"immutable_sent_copy"`，靠发送后按不可变 ID 读取的已发送副本核对。只有连接器工具、完整目录、显式 `sent:true` 或连接器 `verify` 才按需共享一个连接，启动失败不自动重试。
- 实现 `graph.mjs` / `graph-session.ps1`，通过微软官方 `Microsoft.Graph.Authentication`（2.41.2）和项目内便携 PowerShell 7.6.7（运行时 `.runtime/mail-flow/graph-sdk`，不全局安装；[PowerShell Gallery](https://www.powershellgallery.com/packages/Microsoft.Graph.Authentication/2.41.2)、[PowerShell 7.6.7](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.7)）。Windows PowerShell 5.1 的设备登录会 EventSourceException，不用。无模型调用、定时或轮询，认证缓存由 SDK 管理，不导出 token。
- 批准发送后的动作：`createReply`（或显式 `reply_all` 的 `createReplyAll`）→ 保留原生 HTML 结构并加上转义的新增文字 → PATCH → GET 检查持久化正文及 To/CC/BCC → send（一次）→ 用不可变 ID GET 已发送副本。请求重试固定为 0；超时或读回延迟不等于未发送，不能重发。`send_accepted` 只表示服务接受发送，内层 `verification` 才报告已发送副本读取状态，不证明送达。审计额外记录原生草稿 ID。
- 新建信、附件上传、共享邮箱和后台只读收件保持连接器路径。收件人范围和实际发送仍需用户授权。
- **登录**：`node automation/run.mjs mail graph-login` 启动隐藏的独立登录进程并返回设备码，重复调用复用仍在等待的进程；用户本人在微软页面完成设备登录和 Mail.ReadWrite／Mail.Send 委派同意（可能受学校管理员策略限制，不绕过），账户须与配置邮箱相同。`graph-status` 只读登录结果，绝不启动登录；`authenticated` 不等于真实邮件 API 已验收。结果写 `.runtime/mail-flow/graph-login/<id>/status.json`。
  - **登录是两个设备码**：SDK 的设备登录先后写 `mg.msal.cache.nocae` 与 `mg.msal.cache.cae` 两份缓存，各要一个码，第一个成功约 4 秒后出现第二个。设备登录窗口约 120 秒，超时报 `login_timeout`，完成标志是 `%USERPROFILE%\.mg\mg.authrecord.json` 出现。助手转述码常超窗口，所以首次或重新登录建议用户在自己的终端运行 `.runtime\mail-flow\graph-sdk\powershell-7.6.7\pwsh.exe -NoProfile -File mail-flow\graph-session.ps1 -Mode login -Root <办公室根目录> -Account <邮箱>`，两个码依次输入。`graph-status` 报告的是最近一个码。
  - 发信模式不用设备码：先检查 `mg.authrecord.json`，缺失就报错并提示 `mail graph-login`，不回退弹窗，然后 `Connect-MgGraph -ContextScope CurrentUser` 静默连接。令牌长期过期后能否静默复用未验证。
- **发信通道 `send-login`**：回信/发信（`reply_native`）现在走同一个 Node 传输（`graph-rest.mjs`，`kind:'send'`），自己的设备码登录申请 Mail.ReadWrite + Mail.Send，白名单只有 `/me/messages/{id}` 及 createReply、createReplyAll、send，方法限 GET/POST/PATCH。不需要 PowerShell SDK，也与 Codex 连接器、ChatGPT 账号无关。`mail send-login` 取设备码，`mail send-status [秒]` 轮询；令牌文件 `.runtime/mail-flow/graph-send-token.json`。日历仍用 SDK。
- **只读通道 `read-login`**：受限 shell 里上面的 SDK 会话根本起不来——Schannel 建不了客户端凭据（`SEC_E_NO_CREDENTIALS`，curl/pwsh 的 https 全失败），Node 用管道启动子进程报 `EPERM`，于是设备码永远打不出来，`Connect-MgGraph` 只是在静默重试。`graph-rest.mjs` 绕过这两个限制：用 Node 自己的 TLS 走同一套设备码流程，只申请 `Mail.Read`，`node automation/run.mjs mail read-login [等待秒数]` 打印设备码（同一码在有效期内复用），`read-status [等待秒数]` 只读轮询；refresh token 只写 `.runtime/mail-flow/graph-read-token.json`（0600），access token 不落盘、不打印。`fetch_native`、`list_attachments_native`、`download_attachment_native` 走这条通道，传输层只放行 `GET /me/...`；发信和日历仍用 SDK 会话。登录前调用会明确要求先 `read-login`，不会去启动连接器。
- **踩过的坑**：正文转义只用 `& < >`，不要把撇号转 `&#39;`（Exchange 保存时还原为 `'`，导致“持久化正文与组装不一致”而拒发）。本通道白名单没有 DELETE，被拒发留下的草稿要用户在 Outlook 手动删。发送后立刻读回 `isDraft` 可能仍为 true（`verification.status:"pending"`），只要 `sentDateTime` 有值或动作记录 `returned` 就不当未发送，以已发送箱为准，不重发。收件端是否折叠引用由客户端决定。
- **权限**：默认通道仅允许 `/me/messages` 下有限邮件操作；必须读实际 SDK scopes，不从旧记录推断日历权限。

### 正式会议邀请

用户要求不用浏览器／桌面，不把普通 `.ics` 附件算作成功。沿用 `mail outlook-tools` / `outlook-prepare` / `outlook`，工具为 `create_event_native` 和 `fetch_event_native`，参数与授权规则见 `mail guide`。这是 Outlook 账户里的真实会议，不是本地 `calendar` 账本事件。

- 日历权限单独申请：`node automation/run.mjs mail graph-login calendar`，用户亲自完成同意；日历会话只有在持久登录状态已确认 `Calendars.ReadWrite` 后才启动，不会因调用创建工具而偷偷发起登录。邮件登录仍只请求原邮件权限。
- 白名单仅在 `-Calendar` 会话允许 `POST /me/events` 和 `GET /me/events/<id>`；没有 PATCH／DELETE／任意 Graph URL。
- 参数 `subject,text_content,location,start_utc,end_utc,attendees:[{email,name?}]`；时间严格 UTC、结束晚于开始，拒绝空或重复参与人、未知字段；不会自动添加教授、会议室、Teams 链接或附件；已批准参数不可改写。
- 创建会立即邀请所有与会者，因此同发信一样先批准、防重复、审计；动作 ID 同作 Graph `transactionId`。创建只调一次，随后按不变 ID GET 核对标题、正文、时间、地点、完整参与人和组织者／响应状态；读回异常或不符保留已创建结果，绝不再创建。认证／参数缺失在记录可能发送之前拒绝。
- 依据：[Create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0)、[Get event](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0)。

### 旧纯文本回复路径（Graph 未启用时）

准备 JSON 加 `reply:{message_id,text_content}`，程序在同一连接读完整原信（已在 `reads` 中读过则复用），生成 `reply_request_file`（`.runtime/mail-flow/prepared-replies/<唯一ID>.json`，内容 `{tool:"reply_to_email",args:{message_id,text_content}}`）：新增文字不改写，后接 Outlook 样式分隔线（`________________________________`）、原信头（From/Sent 或 Received/To/Cc/Subject，America/Chicago 本地时间）和不加 `>` 的原信全文；程序只整理空白，不剪不改写。文件不含批准标记，不推测收件人，不是已发送邮件或草稿。`reply_preview` 回显 `message_id`、新增文字、`body_sha256`、`body_chars` 与 `quote_verified:true`（已读回文件核对，不表示用户批准、语义正确或送达）。助手读原文、新增文字和收件证据后，由程序读文件核对 hash，不把整封引用再输出给模型抄一遍。用户批准具体动作与最终参数后，只向该文件增加 `confirmed_by_user:true`、已批准的 To/CC/BCC/reply_all 和可选只读 `verify`，再 `mail outlook <reply_request_file>`；不得据预览校验成功自行批准，不得批准后重拼正文。原信不匹配、读取失败、缺全文或保存失败只返回 `reply_error`。已发邮件不为补引用擅自重发；读取接口未返回 conversationId 时不声称线程已验证。

## 其他工作的共同原则

资料投递、报销、文献和数据处理也采用同一分工：程序做检索定位、计算、缓存和状态，AI 做必要的理解、分析和表达；先复用结果、缩小上下文，再减少或选择模型调用；原始证据要保留，简单操作不变成多轮代理任务。可参考的现成项目：[Inbox Zero](https://github.com/elie222/inbox-zero)、[n8n Outlook 触发器](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.microsoftoutlooktrigger/)，当前轻量路径够用，不引入新服务。
