# Zotero 本地操作

2026-10-20 用户要求试通图书馆推荐的 Zotero 路线，并停用日常 `literature fetch` 的 UW 自动取文；鼠标宏保留、不改。

## 已安装和启动

- 官方 Windows ZIP 版 10.0.6：`.runtime/tools/zotero-desktop/Zotero_win-x64/zotero.exe`，已检查 Authenticode 签名有效（Corporation for Digital Scholarship）。原始安装 ZIP 已清理。
- 独立 profile：`.runtime/zotero-pilot/profile`；独立数据目录：`.runtime/zotero-pilot/data`。已启用本地只读 API，未配置账户或云同步。
- 用户已安装官方 Edge Zotero Connector，已实际核对存在并可保存文献。

启动该库（不要省略 profile 参数、不要擅自改为其他库）：

```powershell
& 'D:/Main/assistant/.runtime/tools/zotero-desktop/Zotero_win-x64/zotero.exe' -no-remote -profile 'D:/Main/assistant/.runtime/zotero-pilot/profile'
```

日常只用 `node automation/run.mjs literature fetch <DOI>`：已有 Zotero PDF 自动核验入库；没有时，由本地插件调用 Zotero 原生查找全文，再核验实际文件。`zotero-status` 只作诊断，不是第二条日常流程。本地 API 前缀 `http://127.0.0.1:23119/api/users/0/`。保持 Zotero 运行；关闭后 fetch 仍可走原有开放来源，但不能调用原生获取。不加自启动、轮询或新模型调用，不直接写 SQLite、不复制 Edge 会话。

## 已安装的本地原生集成

- 源码 `software/zotero/native-fetch/{manifest.json,bootstrap.js}`，插件名 **Office Zotero Fetch**，ID `office-fetch@local.invalid`，当前0.2.1；已通过 Zotero 的正常“插件 → Install Plugin From File…”安装到上述独立 profile 并启用。没有更改签名、全局侧载或系统权限设置。
- 日常启用项为 `literature/config.json` 的 `zotero_native:true`。插件在 Zotero 既有回环服务上提供 `/office/fetch`，只接收本机程序明确发出的 JSON `{doi}`；拒绝浏览器 Origin／Fetch 元数据、额外 URL／路径／代码字段。只允许原生查找题录／PDF，不暴露任意执行或通用库写入。它是一项显式安装授权给本机程序的窄能力，不靠一个可伪造的客户端标记声称用户认证；不向 Zotero 的请求调试日志发送密钥。
- 插件只发起一次原生查找，内部网络行为由 Zotero 管理；不是我们的 UW 下载器或官方 Connector 自动化。它不继承 Edge 的登录，订阅版及全出版社覆盖未保证。原生验证界面不由程序接管。
- Zotero 10 强制要求清单具有 `applications.zotero.update_url`；本地分发使用保留的 `.invalid` HTTPS 地址作为不可更新占位，已在该插件的 Manage 页将自动更新设为 Off。维护时从本地源码打包这两个文件为 XPI，通过正常插件管理器更新；不要点击名称来安装或改签名设置。

## 验证范围

- DOI 添加：Science Advances 开放 PDF、Nano Letters 的 arXiv 作者稿取得成功；一篇 Wiley 的 Find Full Text 返回未找到。
- 官方 Edge Connector：一篇 Nano Letters 在现有校园访问下保存出版社 PDF，本地现有身份校验通过；`connector-verified.json` 记录真实文件、来源和 SHA-256。
- `fetch` 接收原生 Connector 已保存 PDF 已在脱敏副本用真实 Zotero 10.0.6 本地 API 与真实出版社 PDF 验证；重复调用复用缓存，源 PDF 和真实办公室账本不变，全程没有鼠标键盘操作。证据：`.runtime/agent/runs/49fa35c3-57a9-4868-96b1-2eaff05e10d0/real-zotero-smoke.json`。
- 2026-10-20 原生首次获取：隔离 Zotero 库中 Science Advances DOI 起初没有题录／PDF，真实 `fetch` 自动创建题录、由 Zotero 下载、校验并登记；再次调用复用缓存，取文期间0次键鼠。原生 Nano Letters 作者稿另经官方 arXiv 期刊 DOI／版本／题名／完整作者核验。169项脱敏测试通过；正式插件代码与受测 XPI 内容一致、已启用并响应。证据：`.runtime/agent/runs/5447dbef-aa6d-443c-8f3d-40e04b49f7bc/native-cli-verification.json`。
- 首次浏览器保存没有自动触发；没有证明全部出版社覆盖、校外会话、无人值守自动下载或语义索引许可。鼠标宏仅显式特殊调用，不自动兜底。
- 不把题录或快照当全文；不因 Zotero 条目存在就登记 available。保存后按 DOI 精确核对父条目和 PDF 子附件，再核验实际文件。已存在的办公室全文不覆盖。

证据：`.runtime/agent/runs/e64046e1-7600-4a42-9942-a9cb4b608a29/zotero-pilot.md`、`.runtime/agent/runs/b2a5a67a-bee3-4d8e-9b7a-eecfef143f16/connector-verified.json`。

## 只取网页摘要，不下载全文（0.2.1）

- `literature/zotero.mjs` 的 `zoteroMetadata(doi)` 调用同一插件的 `/office/metadata`，JSON仍只有 `{doi}`。现支持本次获准的Nature Physics、Nature Materials和Nature Nanotechnology DOI前缀；不接受任意URL、脚本或文件路径。
- 由Zotero自己的HTTP读取官网文章页，再用原生Web／Embedded Metadata translator取得题名作者；摘要只接受明确标为 **Abstract** 的正文区域，不回退到导语或网站description。双重核对页面与题录DOI；保留完整摘要，不生成或截短。
- 原生翻译明确设置 `libraryID:false, saveAttachments:false`，不创建Zotero条目、不调用PDF resolver、不修改用户的自动下载设置，也不修改办公室文献库。原 `/office/fetch` 的PDF流程不变。
- 一次显式调用只处理一个DOI；调用者可按准备好的清单串行批量、落盘和复用结果。没有常驻采集、额外模型、重试或浏览器鼠标宏。403/429、验证页或身份异常应停止当前批次，保留回执；`no_abstract`仅表示该页面未找到明确Abstract，不能伪称已读摘要。
- 当前字段：`status`、`doi`、`source_url`、`library_writes:0`、`attachment_downloads:0`；成功另有 `title/authors/journal/date/abstract/abstract_section/abstract_from`。`available`只表示取得来源摘要，不表示筛选通过或已入库。Zotero需保持运行；旧插件会返回`metadata_plugin_not_installed`，不得转入PDF流程。
- 2026-10-21实际验证：插件正常更新至0.2.0，安装包代码与源文件相同；新DOI小批3条中1条Abstract、2条无明确Abstract，Zotero总条目数／版本／keys均不变，批处理0次键鼠。再用2篇旧的实时网页Abstract作独立对照，全文一致（包括含上下标的化学式）。190项脱敏文献回归通过；不是证明所有出版社、所有页面或无限批量均可用。

证据：`output/literature-rebuild-20261021/batch-020/zotero-native-metadata/{RESULT.json,ORACLE-RESULT.json}`；代码测试：`.runtime/agent/runs/a706bb5e-710f-4eda-8293-a9d436dd0a38/native-metadata-final-tests.log`。实际后续补源数量看同目录`BATCH-RESULT.json`，不能把小样本当作全量已完成。

2026-10-21批量实测：1385 个Nature Physics缺摘要DOI完成来源检查，补回630条完整Abstract，755页无明确Abstract；输入缺失／异常DOI另行保留。0.2.1修复《Just a moment》真实题名误判：先核对出版社citation DOI，缺失或不符时才用标题识别challenge，真实挑战页仍停止。191项隔离回归及安装代码一致性通过。最终结果、批量源文和父子回写核验见`output/literature-rebuild-20261021/batch-020/zotero-native-metadata/FINAL-RESULT.json`。本轮不启动新阅读模型，原PDF fetch不变。
