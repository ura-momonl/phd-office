# 提示词管理

这套机制只做两件事：**方便查看**（每段文字在哪、谁读到什么）和**方便改动**（改、增、删，引用自动跟上）。它不规定提示词该写什么，也不往提示词里加东西。设计过程见 `DESIGN.md`（长，平时不用读）。

## 文字在哪

| 文字 | 位置 |
|---|---|
| 程序写给模型的固定句子（任务、卡片、标题、对话轮、记忆、陪伴留言、通知、文献任务、项目框架索引开头） | `prompts/fragments/<域>/*.md` |
| 被多个提示词引用的文字（包括规则） | 也是普通片段，如 `prompts/fragments/rule/`，用 `{{>片段id}}` 引用 |
| 业务口径（如文献收录标准） | 对应配置（如 `literature/sources.json` 的 `lines`），代码读出来当值传进片段 |
| 常驻文本 | `AGENTS.md`；三位助手共用的办公室正文在 `prompts/office-system.md`，`agent/native.mjs` 读为 `SYSTEM_PROMPT`（参与线程续接签名），DeepSeek 的 `chat.py` 从同一文件生成当轮 `personaPrefix` |
| 按任务发现的做法 | `.agents/skills/<名>/SKILL.md` |
| 邮件判断说明 | `mail-flow/REVIEW-PROMPT.md`、`SCREEN-PROMPT.md`（外壳在 `fragments/mail/`） |
| 界面文字、写进文件的样板等非提示词文本 | 留在所属模块，不需要向提示词架构申请豁免 |

片段是普通 Markdown。`{{名}}` 是代码传进来的值，`{{>片段id}}` 引用另一个片段；一次替换，插入的内容不会再被解析，缺值或缺片段直接报错。

来源记录不向提示词插入任何标记。work 轮的同步 `traceFragments(fn, {sources:true})` 在同一次渲染中携带范围树；`joinPrompt` 保留已渲染片段、引用和值槽的位置，`promptSource` 由调用方标注已知的数据出处。普通字符串拼接不保留这些元信息，也不会事后按文本匹配补猜。默认 `fragment()` 与其他调用的返回值仍是字符串。

普通work轮把稳定办公室说明和原样追加的历史放在前部，日期、当轮检索记忆、运行目录、资料变化通知等动态材料放在历史之后、当前请求之前；不靠截短证据增加缓存命中。原生续接仍按各助手实际已见消息发送增量；资料变化照常带入，不为缓存冻结旧版本。缓存读取与写入看已有usage记录，稳定前缀只是可复用条件，不代表已验证命中或额度节省。

对话 work 输入由 `promptFor` 分为办公室背景、历史引文、运行材料和新用户请求；空块不发送。交接轮将用户消息和助手回复按实际发生顺序放在同一份历史引文中，不再把旧用户消息重复放到末尾当成“当前请求”，也不另加同事回复提醒。原生续接只补未见过的消息。历史逐条用 JSONL 保存发言角色、来源和原文，不把同事回复伪装成用户决定。Codex 与 Claude 适配器将这些块传为同一用户消息内的多个原生 text 内容块，拼接后与 `prompt.txt` 完全一致；这不是把背景提升为 system/developer 权限，也不重写原生线程中已有的 assistant/tool 历史。manifest 的 `input_parts` / `resume_input_parts` 记录本次块序和长度。DeepSeek 目前使用相同分层后的正文，但其独立 harness 仍接收单段字符串。

## 查看

```
node automation/run.mjs prompt fragments          全部片段：字数、需要的值、被谁引用
node automation/run.mjs prompt show <片段id>      看原文
node automation/run.mjs prompt uses <片段id>      谁在用它
node automation/run.mjs prompt where "短语"       某句话在哪些文件的哪几行
node automation/run.mjs prompt dupes [汉字数]     整句重复：同一句（默认 ≥12 汉字）出现在几个提示词面
node automation/run.mjs prompt overhead [运行数]  各用途实际输入 token 与提示词字节数（最近 N 次运行的 Codex 记录）
node automation/run.mjs prompt layers             各提示词面的位置、大小、谁载入
node automation/run.mjs prompt standing           每种调用拿到哪几份常驻提示词
node automation/run.mjs prompt run <运行目录前缀>   某次运行的文件（prompt-manifest.json 是哈希和用到的片段，prompt.txt 是正文）
```

常驻提示词不是每个调用都带：对话轮（work）两家都带 `AGENTS.md`；Claude 的 ask 模式用 `--safe-mode`，不读；Codex 的 ask 读；陪伴留言换了自己的系统提示词。具体以 `prompt standing` 为准（登记在 `registry.json`，测试会拿启动参数和源码核对）。

## 改、增、删

```
改   直接编辑 prompts/fragments/<id>.md
增   node automation/run.mjs prompt new "<片段id> [正文]"
     需要接入时在代码里用 fragment('<片段id>', {值}) 取用；也可以先存着
改名 node automation/run.mjs prompt mv "<旧id> <新id>"       同步代码、其他片段、登记表里的引用
删   node automation/run.mjs prompt rm <片段id>              还有地方在用就拒绝，并列出引用
```

`new` 和 `mv` 的参数要加引号，写成一个字符串。改完跑：

```
node automation/run.mjs prompt lint        检查缺失/循环引用、未登记的 purpose；附带未使用片段和内联长句清单
node automation/run.mjs prompt snapshot    固定的虚构输入渲染结果与 golden.json 比对；确认是有意的改动后 snapshot accept
```

lint 的 `errors` 表示引用等结构问题，有错误时退出码为 1。`unused`、`inline_text` 和 `candidates` 只是查看线索，不影响退出码，也不要求登记豁免。内联长句按 ≥80 个汉字发现，可能是界面文字或文件样板，不代表它就是提示词。

代码引用扫描识别静态的 `fragment('id')` / `block('id')` 调用，支持单引号、双引号和无插值反引号；动态计算的 id 不在自动改名范围内。`new` 保留正文的空格和换行，较长正文也可直接编辑新文件。

## 界面：更多 → 提示词

Workbench 的「更多 → 提示词」是 `prompts/view.mjs`、`prompts/runs.mjs` 与上述 `run.mjs` 函数的图形外壳，不另存规则。按场景（调用用途 × provider）看三层架构图与可能出现的片段，按目录浏览片段；选中片段可看展开全文、历史差异、值槽和引用关系。页面不再提供源码编辑、保存或新建，修改正文由助手直接改文件或使用上述命令；改名、删除入口仍保留。旧文字留在 `.runtime/prompt-history/<片段id>/`，同一毫秒的连续保存也按保存先后倒序显示。

左侧“按运行”列出最近 100 段对话中全部保留的 work 输入，包括后续轮次和任务内交接，不含后台调用。轮次按会话 `task_ids` 的顺序编号，任务目录里的 `/2`、`/3` 是任务内交接，不是跨用户消息的对话轮次；列表和详情分别显示对话轮次与交接序号，无所属会话时轮次为未知，不默认填 1。前面的记录已清理也不重编号。`GET /api/prompts/runs` 列出各轮元信息，`GET /api/prompts/run?id=<完整任务UUID>[/交接序号]` 可只读读取任一保留记录，不删历史。优先展示 `native-prompt.txt`（原生实际选择发送的文字），没有时展示 `prompt.txt` 并明确标为应用层拼装稿。原生续接只显示本轮增量，而不是伪装成完整历史。

新 work 运行的 manifest 另存 `sources` / `resume_sources`：实际字符范围树、片段版本哈希与当时原文；全稿、续接增量分别有 SHA-256。页面只使用与显示正文哈希吻合、范围有序且嵌套合法的来源记录，默认“来源分块”：彩色片段框与左侧目录共用颜色函数；普通程序文字／数据正常排版，不伪装成片段；已知数据出处显示文件、模块、消息序号或记忆条目 ID，未记录更细来源的值仅标为调用方填入的值槽。右侧色签按实际出现顺序定位正文，同一片段重复出现保留各自位置；定位嵌套片段会自动展开祖先框，并从原样全文切回来源分块，不再显示顶部色签。点击彩色框本身（或用键盘操作框标题）切到“按目录”，展开对应目录并显示当前片段详情；内部按钮、链接和文字选择不会误触这一跳转。“内部来源”展开值槽、引用和预渲染片段；框底不再展示“当时片段原文／查看当前版本”面板，但后台快照仍保留用于核验，不删原始运行资料。可切换“原样全文”核对全部字符，分块模式只是按段进行安全 Markdown 排版。

运行详情不再显示顶部“本轮原生发送记录／本轮应用层拼装稿”说明框；必要的记录异常警告仍保留。中间区只让正文滚动，标题和视图切换固定，避免双层滚动条；场景和片段详情的滚动不变。桌面三栏使用页头下方的实际剩余高度，不再按固定像素估算，底部留 16px；只在栏内滚动，不撑出整页滚动条。窄屏仍按上下排列布局滚动。

旧 manifest 的片段清单仅说明渲染过哪些片段及次数，不是正文位置，因此仍只显示原文、不补猜彩框。旧续接增量只有字数可核对时会提示；损坏或不匹配的来源位置退回原样全文，不影响读取正文。没有位置的右侧清单项会注明仅查看当前版本，不能伪装成正文定位。本文不含原生入口另载的常驻层、工具定义、线程历史或后续补充消息。

“会抵达的场景”由代码推出：`templates.mjs` 的哪个导出渲染了这个片段，导入该导出的文件在登记表里属于哪些用途；导入文件同时承担多个用途时，`registry.json` 的 `template_exports` 写明每个导出对应的用途。这是“可能到达”，不保证每轮都出现。

## 新增一个会调用模型的调用点

调用时带 `purpose:'名字'` 和 `mode`（`work` 有工具；`ask` 一次回复、无工具），并在 `registry.json` 的 `purposes` 里登记 mode 和 provider，否则 lint 报错（那样看不出它拿到哪些常驻提示词）。想换系统提示词：自己传 `systemPrompt`，并在 `purposes` 里写 `system_prompt_override`。

## 当前查看范围

`layers` / `standing` 显示登记的来源与载入方式，`fragments` / `uses` 显示片段及静态引用。场景的顺序和条件仍在调用代码里；邮件说明、常驻文件和技能保留原位，不必为了管理而全部拆成片段。

运行 manifest 目前只覆盖 work 轮对话，不含卡片、标题、邮件判断等后台调用。因此清单能说明来源，但不是每次调用完整输入的实测记录。
