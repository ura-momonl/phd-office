# 文献检索与校园全文

模块用法以 `help literature` 为准；本文是模块手册：命令、机制和数据位置。历史过程不在此保留，看 `agent search` 或 `.runtime/agent/runs/`。

## 找文献工具：按用途选入口

重建包与派工收尾：`reconcile-work <包ID|all>` 只预览，追加 `--apply` 才写回。正常入库及相同结果的重复提交会自动执行这一收尾：包的入库回执、逐条决定和当前库一致且待核为零时，将对应未启动的正式单包派工标为已交付，并附成果路径。原先失败、取消及正在运行的任务保持原状，不改写运行历史，不触发模型或全文下载。

| 要做什么 | 入口与状态 |
| --- | --- |
| 搜本地题录、摘要、已下载全文 | `browse`、`show <doi>`；全文与摘要混合检索用 `library hsearch "<问题>"`，见下文 |
| 发现候选、补 DOI 题录 | 现有 `discover` / `backfill` 使用 OpenAlex；`resolve <doi>` 用 Crossref 并登记题录 |
| 补完整摘要 | 现有 `enrichAbstracts`：Crossref / OpenAlex / Semantic Scholar，Nature 系可补 Springer Meta，见「补完整摘要」 |
| **Web of Science 检索、核对题录和被引次数** | **`wos "<WoS查询>"`**：机构成员档已用真实 DOI 实测；只查单页，不自动入库，不提供摘要或全文 |
| 取得全文 | **`fetch <doi>`**：现有 Zotero / OA / OpenAlex 托管路线，详见「获取全文」 |
| **Wiley 全文 TDM** | **本机 token 已实测；用户另授权全量 Wiley 补漏队列（不限 OA），12 秒一篇，与四路仓储共用进程**；尚未接入通用 `fetch`，批次入口见下文 |

### Web of Science Starter API

从办公室根目录调用，两位助手共用同一入口：

```powershell
node automation/run.mjs literature wos "DO=10.1126/science.1102896" --limit=1
node automation/run.mjs literature wos "SO=(Nature Nanotechnology) AND PY=2025" --limit=10 --page=1 --sort=TC+D
```

- 查询语法与字段见 [官方接口说明](https://developer.clarivate.com/apis/wos-starter/swagger)：`DO` DOI、`TI` 题名、`SO` 期刊、`PY` 年份、`TS` 主题等。`TS` 能检索摘要字段，不代表 Starter 会返回摘要文本。
- 参数：`--limit=1..50`（默认 10）、`--page=正整数`（默认 1）、`--sort=TC+D`（被引降序；也支持官方 `LD/PY/RS/TC` 与 `+A/+D`，逗号分隔多项）。只请求指定页，不自动翻页、不重试、不改 catalog，也不自动加入推荐或回填流程。
- 输出一行 JSON：`status:"ok"`、`source`、`fetched_at`、`query`、官方 `metadata` / `hits`、`quota`。`hits` 保留 DOI、作者、来源、`citations[].{db,count}` 等官方字段；空结果仍为 `ok`。失败返回状态并以退出码 1 结束，认证失败／限流不会当成零篇。
- 凭据：优先环境变量 `WOS_API_KEY`，否则 `.runtime/literature/wos.credentials.local.json` 的 `api_key`。程序用 `X-ApiKey` 请求头发送，不输出密钥或原始错误正文。机构成员档本机已实测为 5,000 次/天、5 次/秒；输出的 `quota` 给出本次响应头的上限与余量，缺失时为 null。
- Starter 用于题录与被引核对，不代替摘要来源、全文下载或内容判断。WoS 与 OpenAlex 的被引统计来源不同，不直接混作同一口径覆盖已有被引值。

### Wiley TDM：显式授权的全量补漏队列

- token 位于 `.runtime/literature/wiley.credentials.local.json` 的 `api_token`；只登记其位置，不在说明或命令中放密钥。
- 2026-10-29 14:07 实测单篇已知 OA 的 Advanced Materials 文献 `10.1002/adma.202418557`：官方 API 返回 302 至 `alm.wiley.com`，二进制服务返回 200、`application/pdf`，响应前缀为 `%PDF-`。只读取前缀并取消后续传输，未保存／核验完整 PDF、未入库、未启动 API 批量，也未测试订阅文章权限。证据 `.runtime/tmp/wiley-api-probe-20261029.json`，无密钥或签名 URL。
- [Wiley 官方用法](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)：`GET https://api.wiley.com/onlinelibrary/tdm/v1/articles/<URL编码后的DOI>`，请求头 `Wiley-TDM-Client-Token`。当前服务返回 PDF，不含补充材料；订阅内容还需相应机构权限及机构网络，token 本身不代表所有文章都可下载。
- 官方目前列出每 10 分钟最多 60 次请求，批量获取按至少 10 秒间隔；单篇探测不代表已验证持续批量限额或订阅权限。当前批次按更慢的 12 秒间隔接入，通用 `fetch` 与原仓储获取路线保持不变。
- 用户已授权以每 12 秒最多发起一篇，与仓储并行补齐全部缺全文 Wiley 文献，不限 OA。实现 `literature/wiley-tdm.mjs`，当前唯一批次入口 `output/literature-known-oa-20261029/run.mjs`；与四路仓储在同一进程共享 DOI 互斥，不另开写主库进程。进度、Wiley 冻结范围、逐篇回执与速率记录见批次 README；STOP 同时暂停两条路线，续跑不重试已有最终结果。通用 `fetch` 未改，其他出版社不在这次 API 授权范围。

## 收录规则不在这里

用户确认的收录／推荐规则只在 `literature/sources.json` 的 `lines`（`library`、`reading`、`picks`）里，派发回填和每日推荐任务时由代码原文带入提示词（`prompts/fragments/literature/`）。回填的选取方式和各年被引门槛在 `.agents/skills/literature-backfill/SKILL.md`。这份 README 是模块手册，只写命令、机制和数据位置，不放规则、判断或过程记录。

**现状：** 资料库已于 2026-10-17 清空重来：旧 849 条 catalog、34 份 PDF、推荐记录整体移到 `literature/archive/reset-2026-10-17/`，发现缓存和 SQLite 移到 `.runtime/literature-archive/reset-2026-10-17/`（恢复：把归档里的 catalog 与 PDF 移回原位）。之后按回填逐年充实。**每日任务关闭**（`daily_recommendations.enabled=false`），重新打开须用户同意。项目文献 `workspace/projects/graphene-thz/literature-notes/` 不属于资料库。

## 每日推荐

- 资料库 → 文献，顶部“项目 / 文献”切换；文献默认打开“每日推荐”，可切日期或历史记录。篇数可多可少、可为零。
- 每篇先读摘要或全文，再记录理由、问题、证据、启发、可达性；仅题名不足以正式推荐。资料积累不等于用户喜欢或已读。
- 正式记录在 `literature/recommendations/YYYY-MM-DD.json`，元数据和摘要在 `catalog.json`；`backup.mjs` 已纳入推荐目录。
- 每日任务复用办公室后台节拍和工作队列：芝加哥时间 8 点之后、助手队列空闲时入队一次；不补跑离线错过的旧日，失败／取消不自动重试，当日已有发布记录（含零篇）即停止。使用现有 Codex 额度，不新增模型 API、定时器或自动全文下载。开关是 `sources.json.daily_recommendations.enabled`，改调度须后端空闲重启。
- 渐进读取：先翻题名页、少数入围才读摘要；`seen.json` 保留但不再据它过滤。已登记论文按 catalog 去重。

```powershell
node automation/run.mjs literature browse daily 1
node automation/run.mjs literature daily 2026-10-17
node automation/run.mjs literature recommend <JSON文件>
```

发布 JSON：`{date,items:[{doi,reason,basis:"abstract或fulltext",question,evidence,inspiration,reach}],note}`；零篇须说明原因；已有日期不静默覆盖，修改须显式 `replace:true`。

## 文献台界面

- 范围：每日推荐、最近候选、资料积累、本地全文、没有全文；列表每页 20 条，只带题名、来源、日期和摘要／全文标记。
- 点卡片在阅读核对面板看推荐解读、原始摘要与来源；原文入口在面板上方（有安全 PDF 直接打开，否则到论文页面）。只读本地数据，不抓取、不补摘要、不调用模型；仅选中一篇才读取摘要。
- “采集与索引”默认折叠，显示真实能力状态与数据位置。
- 助手走同一分层，不把全部摘要送给模型：

```powershell
node automation/run.mjs literature browse candidates 1   # 也可 pool <页> "<词>"、local <页>
node automation/run.mjs literature show <DOI>            # 只读一篇本地记录，不联网
```

`browse` 返回总数和页数，要覆盖的题名页须翻完，不能只看首屏就宣称筛完；题名只作初筛，不据此判断工作质量。`discover` 的 CLI 输出只给统计和第一屏题名，完整结果写 `.runtime/literature/candidates-<日期>.json`；只想看已有记录用 `browse`，不要反复跑 discover。HTTP 接口 `/api/literature?scope=…&page=…&q=…`、`/api/literature/paper?doi=…` 共用 `view.mjs`。

## 获取全文

路线：一个研究问题 → 候选 → 按 DOI 去重取元数据 → 开放全文／Zotero 官方 Connector 保存订阅全文 → 登记 → 只读相关页段 → 项目笔记引用 DOI／页码。全文留原文件或 Zotero，一份文献可关联多个项目，不按项目复制 PDF。日常 `fetch` 不再自动访问 UW。

```powershell
node automation/run.mjs literature fetch <DOI>                 # 统一单篇入口，缓存优先
node automation/run.mjs literature fetch <已登记DOI> "--source=<PDF直链>"
node automation/run.mjs literature login-set                   # 旧校园凭据维护，fetch 不再使用
node automation/run.mjs literature auth-status
node automation/run.mjs literature resolve <DOI>               # Crossref 元数据，不调模型
node automation/run.mjs literature access <DOI>                # 只生成 UW 代理入口，不保证订购
node automation/run.mjs literature record <paper.json>
```

程序入口 `fetch_paper(doi)`（`literature/fetch.mjs`；托管平台 `hosted.mjs`；匿名 OA 页面共用 `automation/browser-launch.mjs`）。

**显式 PMC 批量取文（无需鼠标）：** `node literature/pmc-batch.mjs <配置JSON>`，配置 `{directory:"批次目录",targets_file:"[{doi,title,source}]的JSON文件",concurrency:3,max:20000}`。只用 PMC DOI 转换 API（每次不超过100条）及新版 `pmc-oa-opendata` 官方云端数据集，不访问出版社、不用 Zotero／OpenAlex、不登录、不调用模型。按官方 metadata 的 DOI、版本、开放许可与 PDF 链接取文，MD5及现有 PDF 身份／SHA-256 核验后入库，保留来源、许可、PMCID及出版版本；优先出版社版，不把 XML 算作 PDF。已有全文不覆盖。`progress.json`／`progress.log` 为进度，`attempts.jsonl` 为断点，`id-map.json` 缓存转换结果；续跑同一配置跳过已尝试文章，`max`只限本次新增尝试数。写批次 `STOP` 停止新派发，待在途文章收尾；显式恢复先移存 STOP。单篇身份／网络失败记录后继续，不自动重试网络；PMC拒绝访问、限流、服务端故障、核验器故障或其他共享读写异常则停止并保留未完成项，不换站。登记主库遇 EPERM／EACCES／EBUSY 时不退出：保留已核验PDF及批次 `pending-registration/` 的登记资料，首次等2秒、之后每10秒重新读取当前主库补登记，不重复下载、不更改权限或删除主库。进度显示 `waiting_registration` 和对应文章／错误码，等待段每250毫秒检查STOP；停止或宿主中断后，原批次恢复会重新核对PDF哈希及身份，再沿用原来源、许可和版本完成登记。状态 `paused` 表示达到本次max、`complete`表示清单已全部尝试，不代表全部取得。原始清单保持不变。本次双刊批次在 `output/literature-pmc-20261028/`，默认 fetch 路线未改。新版云端结构见 [PMC 官方说明](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/) 和 [数据集 README](https://pmc-oa-opendata.s3.amazonaws.com/README.txt)。

**鼠标宏仅作显式特殊手段：** 正式执行代码 `literature/mouse-download.ps1`，本地登记／状态入口 `literature/mouse-download.mjs`；旧 `.runtime/mouse-fetch/macro.ps1` 只转到正式代码。复用已有 Edge 和选定下载标签，启动时最大化并检查真实显示器边界，统一物理像素处理 Windows 缩放，不新开浏览器小窗。占用真实键鼠，不与用户／其他助手同时操作。按用户2026-10-28的无人值守要求：失焦立即暂停文章输入，记录窗口标题和句柄、窗口类及进程身份；连续失焦满180秒后自动激活指定 Edge，并重开同一 DOI 接续。恢复前若前台确认为系统快速设置（ControlCenterWindow，且为Windows目录内的ShellHost／ShellExperienceHost），先用Win+A收起整个面板，包括Wi-Fi／蓝牙子页；不点击网络开关或连接，不关闭普通应用或保存框。发键前再次核对前台身份，收起结果实际核验并写quick_settings_dismiss_*事件，失败不假报恢复。提前手动返回则立即继续，取消本次等待；切换其他前台应用不重置180秒计时。自动激活后会核对实际前台，失败则保持等待、记录原因，每隔3分钟再尝试一次，不修改系统焦点设置；锁屏／安全桌面不发送激活按键。用户要使用鼠标时用 stop 停止整个宏，STOP 优先于到点切回及收起面板，不会自动重启。浏览器关闭时保留进程和 waiting_browser，每30秒检查一次；将原配置 window_handle 更新为已确认的新Edge窗口后，在同一进程接续，不另开浏览器窗口。

配置为 UTF-8 JSON：`{list_file:"一行一个DOI的文件",directory:"本批次目录",window_handle:132138,pace_seconds:3,reuse_tab:true}`。从办公室根目录执行 `powershell -NoProfile -File literature/mouse-download.ps1 -RequestFile <配置JSON路径>`；后台启动用隐藏窗口并重定向输出，不另开进度小窗。查看 `node literature/mouse-download.mjs status <批次目录>`；停止同入口 `stop <批次目录>`，写本批次 STOP。模块也接受 `literature macro <JSON路径>`，内容 `{action:"status"|"stop",directory:"批次目录"}`。明确恢复时移走 STOP 后执行相同配置，读取 `attempts.jsonl`：成功和最终失败不重复派发，未完成文章继续；已落盘文件先本地补核验。补下最终失败文章可配置 `retry_failed:true`。页面／下载失败最多尝试两次，篇间额外等待3秒；身份不符（包括已有／孤立本地PDF）记 failed 后继续下一篇，不重试、不入库、不替换文件。校验器／主库／日志／状态写入等共享资源故障保留同一进程，waiting_error 中每30秒检查恢复，不把整批记成结束；本地子进程有90秒上限和STOP响应。未知运行异常及恢复处理异常也留在进程保活循环中。验证码／拒绝访问仅观察最多10秒，不点击验证、不刷新；页面仍未恢复则记 failed、跳过该篇继续。不明确的保存框暂停输入并等待处理；已知、属于目标Edge窗口的另存为框自动保存到Downloads，不覆盖已有文件，不碰其他窗口的保存框。下载标签被关闭时在原窗口补建专用标签。

`progress.json` 区分 running、retrying、waiting_focus、waiting_browser、waiting_error、waiting_access、stopped、complete，含当前 DOI／阶段／计数／心跳、focus_return_seconds=180 和失焦期间的 focus_return_in_seconds 倒计时。自动切回的请求、成功／失败及恢复均写 attempts.jsonl。CLI 还识别进程消失的 interrupted 和心跳超时的 stalled。暂停、需处理及结束时发托盘提醒，不创建抢焦点的弹窗；通知失败不影响下载。无模型轮询、无定时自启。运行中的业务故障不会主动退出进程；主动STOP及队列全部处理完成会退出。宿主被系统终止、关机或断电后仍需显式启动，从原游标接续，不设自动重启服务。新版实机验证 Nature Communications／Science Advances 的连续取文和失焦恢复；原有 APS／ACS／Wiley 分支保留，本次未重跑这些出版社。沿用 `register-download.mjs` 的 PDF 身份／SHA-256 核验，不覆盖已有全文，不调用 fetch／OpenAlex、不自动登录，也不自动恢复会并发写主库的旧无宏批次。

**只尝试 Zotero：** `fetch <DOI> --zotero-only`（程序参数 `zoteroOnly:true`）只复用缓存、读取本地 Zotero PDF 或调用已安装插件的原生查找；没有文件就返回 `needs_attention`，不查询 OpenAlex 元数据、额度或托管 PDF，也不启动 OA 浏览器／UW／鼠标宏。arXiv 作者稿仍按原有官方关联／固定版本核验接受。该模式需要 DOI，不与 `--source`／`--hosted-only`／`--spend-prepaid`／`--login` 混用；不改变默认 fetch 路线。原生 Zotero 自己的内部网络仍归 Zotero 管理。

**日常只有一个取文入口：** `node automation/run.mjs literature fetch <DOI>`。校验并复用已有 PDF → Zotero 本地 PDF → 已安装插件调用 Zotero 原生查找全文 → OpenAlex 标记的 OA 原站直连／匿名开放落地页 → 原有预算规则下的 OpenAlex 托管 PDF。Zotero 按 DOI 精确查询，不扫整库；原生操作成功后重新读取实际本地 PDF，沿用身份／SHA-256 核验再把 PDF 移入 `literature/fulltext/` 并登记路径、父条目／附件 key（Zotero 只负责下载，不保留文件），不另跑 `record`、不重复复制文件。新原生获取返回 `native_acquired:true`；重复调用走已有缓存。版本／许可证没有证据就记 null。

**原生获取与订阅边界：** 保持独立 Zotero profile 运行并安装 `software/zotero/native-fetch` 插件；`config.json` 的 `zotero_native:true` 才启用首次原生查找。插件只把单个 DOI 交给 Zotero 的原生题录查找和 `Attachments.addAvailableFile`，下载与内部网络行为归 Zotero；办公室不复制 Edge 登录、不开新浏览器控制通道、不重试原生操作、不操作登录／验证码。此插件是本地集成，不是官方 Connector 的自动点击接口，也不是自动获取订阅出版社版的保证：已实测取得 Science Advances 开放 PDF、Nano Letters 的 arXiv 作者稿；ACS 出版社请求曾返回403。若 Zotero 弹出原生验证，需用户处理，不能保证任意文章都无人值守。找不到文件时继续独立 OA／托管来源，安全耗尽后仍可用官方 Connector 保存一次再重复同一 `fetch`。Zotero 关闭／API 禁用／插件缺失不阻塞原有开放路线，不自动启动桌面或鼠标宏；云端未落地附件不隐式重新下载。

同一个 Node 进程并发调用 `fetch_paper` 时，Zotero 获取在进程内排队，开放来源查询／下载可以重叠；arXiv 元数据请求共用串行的 3.1 秒间隔。此队列不跨进程，不要以多开写主库进程代替批内并发。2026-10-26 的取文批次入口为 `output/literature-fetch-20261026/start-live.ps1`：当前试跑6路并发（原为3路），复用 `live/attempts.jsonl` 跳过已尝试 DOI，进度见 `live/progress.json` 的 `current` 数组；`STOP` 文件停止派发新文章，已在途的文章完成后退出。不改变单篇 CLI、来源顺序或预算规则。3→6的短时速率观察在同批次 `speed-comparison.json`。

批次执行代码在 `literature/fetch-batch.mjs`，上述目录的 `live-fetch.mjs` 只负责启动。单篇无全文、403、登录要求、超时或论文身份不符均记录后跳过，不再让整批退出；不自动重试同一 DOI。429也立即跳过该篇、继续派发其他文章，不设置整批等待。`literature/fetch-backoff.mjs` 在请求处尊重受限主机的 `Retry-After`：截止前同主机请求直接跳过、不联网，其他主机正常获取；服务器给的等待时间最多只采用60秒（`MAX_HOST_SKIP_MS`，旧批次留下的更长截止也按此截短），到点后放一次请求试探，仍被限流就再跳60秒；未给有效截止值时同为60秒，跳过不会延长截止时间。被429的文章仍写入 `attempts.jsonl` 作记录，但续跑时不算已尝试，会重新获取。主机截止时间保存在批次 `live/source-limits.json`，重启仍可复用，不保存URL或密钥；arXiv两个官方主机共用截止时间。终端明确显示 SKIPPED 与继续下一篇，`STOP` 仍停止新派发并等待在途文章收尾。PDF 校验器无法工作或共享读写异常仍会报错停止，不跳过核验、不丢弃历史回执。缓存、预算与拒绝后不换镜像的单篇规则不变。

用户于 2026-10-20 停用日常 UW 取文：`fetch --login` 只返回停用说明、不登录；旧 `--no-campus` 参数兼容保留。`--source`／`--hosted-only` 等显式来源模式不查询 Zotero，保留其原本的限定范围；正常日常使用不需要这些参数。
- 原站只有明确 404／410 或落地页没有正文 PDF 链接时才换下一个独立来源；已请求 URL 不重试。原站 401／403／429、验证码或返回 HTML 时，停止该原站及其余 OA 镜像，不切 UW、不绕过；仍可试已登记的 OpenAlex 独立托管副本。未知异常、已取得 PDF 的身份校验失败、缓存被改立即整篇停止。
- 所有 OA 候选失效不等于闭源，不能因此走 UW。页面上优先 `citation_pdf_url`，其次明确正文 PDF 链接，排除补充材料；不猜出版社下载端点。
- 所有路线共用 PDF 完整性、论文身份和 SHA-256 核验。首页没有 DOI 时，必须先匹配目标题名，再核对文末同题名出版信息页的精确 `DOI:` 字段，或参考文献之前的 `Published online` DOI 出版块；不因参考文献里出现 DOI 就放行。一页文还可用“首页题名＋完全一致的 PDF Title＋PDF Subject 中唯一的 DOI 标识”核验，并单独记录证据种类。托管副本没有可靠版本证据时，版本／许可证记 null。
- PDF 题名匹配识别旧 Adobe Symbol 字体提取的希腊字母（例如 `U+F062` 对应 β），不把普通拉丁字母 b 当成 β，也不把不同希腊字母混为一类；原有完整题名＋文章号／出版 DOI 证据和 SHA-256 要求不变。此修复不改变取文来源或下载权限。

**浏览器下载登记：** 宏的 `register.mjs` 委托 `literature/register-download.mjs`，复用已经核验的登记文件；规范目标路径已存在但账本未登记时，核验后回填，不再因“文件已存在”一律失败，也不覆盖任何已有文件。失败输出一行 JSON `validation_failed` 和实际原因，不再只留 Node 调用栈首行。PDF 元数据回退使用同一便携 Poppler 的 `pdfinfo`（可用 `PDFINFO` 覆盖路径）。
- CORE 已于 2026-10-19 移除（下载地址对程序返回 Cloudflare 挑战，不绕过）；本机凭据文件已于 2026-10-22 按用户决定删除。

**输出：** CLI 标准输出一行 JSON；成功 `{status:"available", doi, path, reused, access_route, sha256, bytes, provider_notes}`（作者稿还有 `identity`）。失败不假装有全文，退出码 1：`rate_limited`（最终仍不可用的 429，附 `retry_after_ms` 等待提示；单篇接口自身不重试）、`needs_login`（要用户登录／Duo）、`login_failed`、`access_denied`（401／403）、`needs_attention`（开放状态未知、无正文链接、需人工验证或返回网页；不推断学校没订购）、`validation_failed`（文件／DOI／哈希不符、作者稿题名作者编号版本不符、缺 PDF 解析器）、`invalid_doi`、`not_found`、`failed`。`validation_failed` 可附 `pdf_reason`（`pdf_structure_invalid`、`parser_unavailable`、`parser_permission_denied`、`parser_timeout`、`parser_output_limit`、`pdf_password_or_permissions`、`pdf_parse_failed`）和 `parser_exit_code`，不返回原始 stderr、文件名或 URL，不自动重试、修补或去除权限。PDF 存在但已改变时停止，不覆盖。需要本机 `pdftotext`：可用 `PDFTOTEXT` 指定可执行文件；Windows 默认优先项目内 `.runtime/tools/poppler/Library/bin/pdftotext.exe`，未安装时沿用 PATH。全文身份校验与显式提字诊断共用此选择；入库只用 MinerU，不再回退 pdftotext，不改系统 PATH 或初始化 MiKTeX。

**助手检索补漏（手动任务内）：** 仅当结果带 `search_suggested:true`（安全耗尽来源、缺开放位置或 OpenAlex 404），用 DOI 或题名加作者做少量通用网页检索找机构仓储、作者主页或预印本。每批最多 10 篇，每篇最多两次检索，其余列为待补漏。不抓 Scholar、不用付费代理、不处理验证码／登录，不把题名相似当身份确认。找到公开 PDF 直链后用 `fetch --source=` 交给程序（只处理该独立来源，不查 OpenAlex、不用校园会话，不能与 `--login` 混用）。找到链接、下载成功、身份校验通过要分开汇报；不允许仅找到链接就登记 available。`closed` 只表示索引没记录开放版本。

**arXiv 作者稿核验：** OpenAlex 指向 arXiv 时，按编号读 arXiv 官方 API 唯一记录，必须有与请求完全一致的期刊 DOI，并与期刊记录至少共享两位不同作者的完整姓名（规范化后精确匹配，不按姓氏模糊匹配）；缺关联 DOI 停下交人工，冲突则拒绝。不要求题名逐字相同，但 PDF 首页须匹配 arXiv 题名并含至少两位已匹配作者的完整姓名；只用 API 返回的固定版本地址，首页若印有编号／版本不得冲突。API 请求前等待 3.1 秒，不重试。成功后把 `fulltext_identity`（关联、原稿题名作者、编号版本、`matched_authors`）与 SHA-256 登记到同一篇期刊 DOI，不新增 arXiv 记录。旧 `matched_surnames` 记录仅在哈希完全相同的本地缓存上离线兼容。arXiv ID 的原有直连入口 `arxiv.mjs` 不变（记为 DOI `10.48550/arxiv.<id>`）。

**视觉核验：** 扫描件、字体缺字等自动核验不过时不模糊放行。助手可看渲染首页，核对官方期刊关联、固定版本来源、完整题名作者后，用 `record` 登记 `fulltext_identity.verification="visual-first-page"` 与 `verified_sha256`（必须绑定实际文件哈希）；缓存复用要求登记哈希、文件、视觉核验哈希三者一致。新自动下载不能用该标记跳过核验。

**OpenAlex 托管与预算：** 用作品的 `has_content.pdf` / `content_urls.pdf`，不拿 `locations[].pdf_url` 猜地址。下载前读 `/rate-limit`；默认只有剩余免费预算覆盖 content 成本、`daily_budget_usd` 不超过 $1、预付费余额为 0 时才调用，预算未知或 key 缺失则跳过。动用预付费余额须用户明确同意（`--spend-prepaid`，用户 2026-10-20 当天授权过一次）；`--hosted-only` 只走托管；`--no-campus` 只走开放来源。免费预算与搜索共用，$1 约合每日 100 份 $0.01 的 PDF；UTC 0 点（芝加哥 19:00）重置。平台拒绝／限流不重试；托管下载到 HTML、错 DOI 或缺页不保存、不切来源。见 [官方全文接口](https://help.openalex.org/access/fulltext/)、[计费](https://help.openalex.org/access/example-costs/)、[额度接口](https://help.openalex.org/api/authentication/)。

**密钥与旧登录记录：** OpenAlex 复用 `OPENALEX_API_KEY` 或 `.runtime/literature/openalex.credentials.local.json` 的 `api_key`；Springer Nature Meta API key 在 `.runtime/literature/springer-api.credentials.local.json`（不存在则跳过该来源）。这些凭据和校园会话 `.runtime/browser/uw-library/session.local.json` 都是本机明文敏感文件，不进版本库、备份、测试副本，不打印，不发聊天。`fetch` 不再读取、提交或刷新校园凭据及会话；旧文件不自动删除。`auth-status`／`login-set` 仍是旧会话的查看和维护入口，不代表 fetch 仍会使用 UW。正常浏览器访问、官方 Connector 及鼠标宏的访问情况各自核验，不自动点 Duo、不解验证码。

UW 校外访问经 EZproxy，校园 VPN 本身不足以取得全文（[远程访问说明](https://kb.wisc.edu/library/4773)、[官方 Bookmarklet](https://www.library.wisc.edu/help/off-campus-access/remote-access-bookmarklet/)）。代理链接用 `login?qurl=<编码目标>`，`login?url=` 会丢目标。`automatic_download:false` 保持不变，不阻止用户明确调用单篇命令。没有订购时转开放版本／作者稿或馆际互借，不把摘要当全文。

## 本地检索库

`library.mjs`：SQLite（node:sqlite，FTS5）。表 papers（含 stage）、chunks + chunks_fts、embeddings、notes。**是 catalog.json 和 fulltext/ 的派生索引，可重建**，位置 `.runtime/literature/library.sqlite`；PDF 原件才是唯一资料，`literature/fulltext/`（约数百 MB～GB）不在办公室每日备份清单里。阶段：candidate → picked → fulltext → indexed（ingest）→ read。

```powershell
node automation/run.mjs literature library update       # ingest + 摘要块 + embed，已处理自动跳过
node automation/run.mjs literature library search <词>  # FTS5 BM25
node automation/run.mjs literature library hsearch <词> [--rerank] [--chunks]
node literature/rag-eval.mjs [--mode=hybrid|lex|vec] [--rerank] [--set=<题集文件>]
```

- **解析与切块**：`library ingest` / `library update` 全部使用本机 GPU MinerU（环境 `.runtime/tools/mineru/venv`，`mineru_worker.py` 复用 `mineru_gpu.py` 的 GPU 守卫），串行解析，保留章节、原 PDF 页码、公式 LaTeX、表格与图注，按章节切块、块首拼章节名。失败列入 `failed` / `mineru_errors`，不退回 Docling 或 pdftotext，不覆盖已有索引；成功数为 `mineru`。缓存 `.runtime/literature/mineru-items/<id>.json` 带 PDF sha256，不混用旧 Docling 缓存。PDF 未变的已有索引仍跳过；`--force` 可显式重新切块/入库（有效 MinerU 缓存会复用）。已有文献的批量解析由 5080 另行处理，本机不自动重解析或迁移整库。手动导出 Markdown 仍用 `literature/mineru_gpu.py`，环境与命令见 [MODELS.md](MODELS.md)；不并行跑多个 GPU 任务。
- **参考文献块**（`markRefsTail`）：标 `kind=refs`，检索默认排除，也不算向量。判定：后 70% 内连续 ≥2 块像参考文献（内容启发式或标题命中）；前 30% 内有 References 类标题或连续 ≥3 块像引用也算；夹 1 块短碎片并入，孤立块保持正文；≥3 页重复的标题当页眉忽略。回归测试 `literature/library.test.mjs`。
- **摘要块**：题录摘要作为 `kind=abstract`、page 0 的一块进索引（`library abstracts` 幂等回填，`ingest` 自动带上）。rrf 分数只表示排名，不是重复概率，不能拿它当查重标准。
- **向量**：`EMBED_MODEL` 默认 `Qwen/Qwen3-Embedding-4B`（2560 维，`RAG_EMBED_MODEL` 仅用于对照实验）。库里向量由另一台 GPU 机器用 fp16 算出，本机查询与新论文入库用预量化 int8 目录 `.runtime/tools/embed/qwen3-4b-int8`（显存约 4.4 GB，与 fp16 余弦约 0.997）；模型清单、位置与重建方法见 [MODELS.md](MODELS.md)。`embeddings` 一块只存一个模型的向量，换模型要整表替换，先备份。`embed` 每 5000 块落库，中断后重跑只补缺。查询和入库的嵌入经 `memory2/embed-cli.mjs` 走与长期记忆共用的常驻嵌入服务（冷启动约 9 秒，热态一次查询约 0.3 秒；`RAG_EMBED_STANDALONE=1` 退回旧的一次一进程）；一次 `hsearch` 剩下的时间主要是读向量。重排序用 BAAI/bge-reranker-v2-m3（`--rerank`，多约 10 秒，默认关）。长期运行不依赖远程机器。
- **评测**（`rag-eval.json` 单篇 37 + 主题 20 + 证据 11，`rag-eval-2020.json` 为 2020 年单篇题；每次追加到 `.runtime/literature/rag-eval-log.jsonl`）：混合检索优于纯 BM25 和纯向量；重排序主要补中文和短查询。**题少，差 0.03 以内算噪声**；评测集带 `universe` 以便库扩大后仍可比，库扩大后旧题的单篇 MRR 下降多半是相近新论文合理挤到前面，不全是检索变差。当前（1695 篇、约 5.4 万个正文块）混合检索单篇 MRR 0.894、主题 nDCG@10 0.804、证据页命中 8/11；加重排序 0.931／0.769／9。待补：主题题对 2020 年后论文的答案、查重对（含相似但非同一工作的反例）。
- 未做：bge-m3 稀疏／多向量输出、问答生成（由助手读检索结果回答并引 DOI＋页）、笔记索引、界面接入、候选／选中状态写入库。

## 回填口径（老文献，“其他入库”一档）

命令：`literature backfill "<年> [起] [条数]"` 分页给“序号|刊|被引|题名”，助手读题名选序号，写 `{year,ranks:[…]}` 后 `literature ingest <JSON>`（补摘要、取作者日期，登记为 `library_tier=library`、`collected_via=backfill-<年>`，并记 `cited_by_at_collection`）。参数见 `help literature`；技能 `.agents/skills/literature-backfill`。

- **候选池**（`backfill.mjs`）：OpenAlex 按年取“期刊清单（`sources.json` 的 journals，含 Nature Communications）× 主题分类（`backfill.topics`：T10275 二维材料、T10083 石墨烯、T10657 拓扑、T10382 输运、T10037 超导与磁性、T10049 磁性薄膜，算法标签而非词表）”，按被引降序，最多约 1500 条，存 `.runtime/literature/backfill-<年>.json`。程序粗筛：封面重复、更正回复、撤稿、排除词、同题重复。追加新期刊／主题时序号追加在后，原序号不变，追加前先备份。
- **选取方式与被引门槛**见 `.agents/skills/literature-backfill/SKILL.md`。
- **规模**：已回填 2019～2023 年，catalog 约 1695 篇；各年选取率约 13～27%，按被引段对比各年相近。部分论文无摘要或摘要 <300 字，按“仅题名”处理，已存摘要不被空值覆盖，残缺片段摘要不收。
- **全文**：回填后逐篇 `fetch <doi> --no-campus`（开放来源），不碰 UW；约四成到六成能取到，其余是无开放来源、网页而非 PDF、HTTP 403／429、首页无 DOI、arXiv 作者核验未过。批量下载时若与他人同时使用主库，可在独立代码副本里跑再合并回主库（sha256 逐一核对）。新全文取得后跑 `library update` 才进检索索引。

## 补完整摘要

2026-10-23 整刊回填实测：现存 Springer **Meta** 与 **Open Access** 两类 key 均可用。Meta 的 `q=doi:... OR doi:...&s=1&p=10`（每次最多10个DOI）本轮157次请求全部完成；此前每页100条的请求曾返回403，不能据此概括为 key 失效或不能批量。OA 的普通检索实测返回200，JSON中的 `abstract` 可能是 `{h1,p}` 对象，正文取 `p`，不能用 `String(object)`。免费参数的实际回执在 `output/literature-rebuild-20261021/abstract-supplement-20261023/SPRINGER-RESULT.json`，两类key单独实测在 `output/literature-rebuild-20261021/springer-two-keys-20261023/SUMMARY.json`。

本轮整刊候选按出版社 `genre` 整理：News & Views、Research Highlight、Research Briefing、Comment、Editorial等确认的其他栏目直接移出候选与待核清单，栏目简介不作研究摘要；已拿到摘要的整理进可读包，身份/体裁仍未核清的单独保存。旧式 `BriefCommunication` 单标签的处置另列，不把它自动当成研究论文。当前可读包、移出账本和来源缺口的唯一入口见 `output/literature-rebuild-20261021/abstract-ready-20261023/STATE.md`；本轮没有入库或启动模型阅读。

`enrichAbstracts`（`abstracts.mjs`，由 `discover.mjs` 导出）。默认 `discover` 只对展示条目依次查 Crossref → OpenAlex → Semantic Scholar（间隔 ≥1 秒，不重试，429 即停），不启动浏览器。助手圈定少量入围条目后可：

```js
import { enrichAbstracts } from './literature/discover.mjs';
await enrichAbstracts(shortlist, { selected: true, browser: true });
```

- 只更新传入对象，不写 intake／catalog／原候选文件，保存结果需另存审阅材料；摘要保留出处，不按 1500 字符截断（旧文件中已截断的不会自动恢复）。
- API 仍缺时：APS 读落地页摘要块／meta，用网址里的 DOI 核对身份；`10.1038/` 走 Springer Nature Meta API（按 DOI 精确查，来源标 `springer`）；仍缺时 `browser:true` 才用安全 `launchEdge` 和已有校园状态读 Nature 公开摘要 DOM，不输入密码、不请求 PDF，遇挑战停止；最后按题名查 arXiv（一次最多五个结果，仅接受对应期刊 DOI，或规范化题名相同且作者姓氏有交集的结果），记 `preprint_url`、`preprint_match` 与 `abstract_version:preprint`，不冒充期刊版本，未匹配不代表没有预印本。
- 逐请求间隔 ≥1.1 秒，arXiv ≥3.1 秒，不重试；401／403／429 停止该来源后续请求；`stats.attempts` 记录来源和结果。`no_fulltext_journals` 列未订阅期刊（目前 Nature Electronics），只能读摘要。
- 交接背景见 [HANDOFF-abstract-search.md](HANDOFF-abstract-search.md)。

## Zotero

上游 [54yyyu/zotero-mcp](https://github.com/54yyyu/zotero-mcp) 已装为 CLI（`.runtime/tools/zotero`），优先 CLI 按需访问，不常驻挂载。需 Zotero 桌面开启 Settings → Advanced → Allow other applications on this computer to communicate with Zotero 并保持运行；入口设 `ZOTERO_LOCAL=true`，当前只读，不直接写 Zotero SQLite。数学、图表和关键结果要核对 PDF 原页，不只信抽取文本。

2026-10-20 已用官方桌面 ZIP 版 10.0.6 + 用户安装的官方 Edge Connector 实测订阅访问：在显示 UW 访问的 Nano Letters 文章页点 Connector，Zotero 保存出版社 PDF，经过现有首页 DOI／SHA-256 校验。不是 DOI 添加时找到的 arXiv 作者稿。证据：`.runtime/agent/runs/b2a5a67a-bee3-4d8e-9b7a-eecfef143f16/connector-verified.json`。一次样本不代表所有出版社都可用，也不代表无人值守取文获准。

当前统一路线：`fetch <DOI>` 自动查询、核验、登记 Zotero 已保存的本地 PDF；若首次订阅保存需要 Connector，保存后重复同一命令即可。已有办公室全文不覆盖；不自动点击浏览器或扫描整个 Zotero 库。独立桌面库和启动参数见 `software/zotero/README.md`；PDF 保留在独立 Zotero 库，未配置云同步。元数据里 DOI 正确不等于附件身份正确；错误 PDF 会停止该篇而不是换来源掩盖。arXiv 附件沿用官方期刊关联、固定版本、完整题名和两位作者核验。

```powershell
literature/Zotero-CLI.cmd --json search "graphene THz" --limit 5 --detail keys_only
literature/Zotero-CLI.cmd --json get metadata <ITEM_KEY>
literature/Zotero-CLI.cmd --json read <ITEM_KEY> --start-page 3 --end-page 6
```

登记格式 `{"doi":"10....","project_ids":["bi-devices"],"title":"...","zotero_key":"...","fulltext_path":"D:/.../paper.pdf"}`：路径只在 PDF 实际存在时接受；Zotero key 单独存在仍标为全文未核实。

## 数据位置

正式登记 `literature/catalog.json`；PDF 在 `literature/fulltext/`（所有登记的 PDF 统一在此，2026-10-20 起 Zotero 取得的也移入）；推荐 `literature/recommendations/`；发现池与候选在 `.runtime/literature/`；派生索引 `.runtime/literature/library.sqlite`。测试：`node scripts/run-tests.mjs --literature --keep`（脱敏副本、虚构网页和 PDF），不在真实目录跑会改数据的测试。
