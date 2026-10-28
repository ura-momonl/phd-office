# 采购：报价核对与 ECE 申请工作流

需求与规格 → 供应商候选 → 询价草稿 → 报价核对/比较 → ECE 内部采购申请 → 审批及采购人员执行 → 到货与实验使用。当前实现本地需求登记、报价验算及 ECE 申请的准备、附件上传、用户批准后提交和只读跟踪；不直接向供应商下单或付款。

catalog.json 存采购本身的事实，邮件行动继续由原邮件账本拥有；用 mail_task_id 关联，不复制邮件处理状态。每个供应商在该采购下保存当前报价；按用户要求替换旧报价时保留采购 id，不自动判断新旧报价关系。历史邮件和原附件仍为依据。项目归属从项目链接读取，共享采购不重复建单。

## 模块搭建策略

- agent 是本次工作的推进者：读原信、附件和用户最新决定，提取型号、数量、费用并判断哪些信息明确、哪些未知；只看新报价就不重开旧报价关系调查。
- 采购模块拥有采购事实和确定性计算，不用正则或另一个模型重新解释邮件，不建第二套邮件队列、自动催信或轮询。
- agent 先 `list` 读当前记录，保留无关字段后 `record`，再用 `check` 读回结果，在对话直接交付；只有必要的用户决策或对外动作批准才出卡片。
- `check` 验算录入数字，不自动证明其与原文一致；agent 负责来源核对。税为零不代表教育优惠，报价算对也不代表技术适配或可直接下单。

```powershell
& 'D:/Program Files/nodejs/node.exe' automation/run.mjs procurement list
& 'D:/Program Files/nodejs/node.exe' automation/run.mjs procurement check high-vac-pumps
& 'D:/Program Files/nodejs/node.exe' automation/run.mjs procurement compare high-vac-pumps
& 'D:/Program Files/nodejs/node.exe' automation/run.mjs procurement record <request.json>
```

## 报价录入契约

原有供应商字段继续有效。可附加 `items:[{description,part_number,quantity,unit_price,line_total}]`、`charges:{subtotal,shipping,tariff,tax}`、`education_discount:{status,evidence}` 和 `commercial_notes:[]`。具体完整入口见 `help procurement`。

- 未知值填 null 或省略，不能代填 0；优惠状态为 `unknown`、`confirmed` 或 `not_offered`，后两者必须有原文依据。状态由 agent 判断，程序不验证依据文本的语义。
- 金额按两位小数货币逐行四舍五入，逐项检查数量 × 单价、行金额之和＝小计、小计＋运费＋关税＋税＝报价总额。不反推税率、关税基数或未写明的折扣；不用于零位／三位小数货币。
- `record` 完整替换同 id 记录；结构错误或已知数字矛盾时不落盘；不完整的报价仍可登记。`check` 的 `arithmetic` 为 `matched`、`unknown` 或 `invalid`，缺项及原始来源随结果返回，商业条款保留为备注。
- `compare.comparable` 只是已知价格、同币种、含税运、人工确认技术适配且无录入错误的基础门槛，不是供应商推荐；数量、规格、时效与商业条件仍须按实际需求核对。

隔离回归：`node scripts/run-tests.mjs --procurement --keep`（脱敏副本，一次安全 Edge 启动访问 localhost 虚构站点；无真实学校／供应商／邮件或模型调用）。这不等于重新验收工作台按钮发起 agent 的整条路径。

## 可复用的 ECE 采购申请

当前真实入口：https://purchasing.ece.wisc.edu/ 。程序只有一条路径：agent 整理明确资料 → `ece-prepare` → 真实网页待审预览及 PDF 上传 → 用户明确批准这份预览 → `ece-submit` → 提交回执及唯一新增申请记录 → 原采购条目的 `purchase_request`。准备完成不是提交，提交审批不是供应商已下单。刚才真实任务的申请号为 **12533**，不用重建。

### 1. 准备输入并填单、上传

先 `procurement list` / `check <采购id>` 读现状。采购条目保存来源明确的供应商、USD 报价号及商品明细。复制 `procurement/examples/ece-request.example.json`，填写本次申请参数；例子全为虚构，不是批准或可直接购买的申请。

```powershell
node automation/run.mjs procurement ece-prepare <request.json>
node automation/run.mjs procurement ece-status <preparation_id>
```

- 姓名、邮箱、电话和收货地址可复用 `.runtime/procurement/ece/defaults.local.json`，本次显式值优先。当前用户提供的联系和收货信息已存这里；不含密码、不进测试副本。
- **经费、审批人、费用科目、具体用途、审批备注、Approved Cost 及其口径必须每次明确提供**，不从上一单偷偷继承。`approved_cost_basis` 用普通文字说明含哪些费用及排除哪些费用；程序不把 sales tax、关税、教育优惠混为一谈。原报价总额不会被申请金额覆盖。
- `vendor` 精确选择采购台账的供应商；商品由该报价读入。可用 `links:{料号:官网URL}` 补商品链接。用户最新决定及具体原文优先，agent 负责判断，程序不另调模型猜测。
- 本轮范围是一份报价 PDF（最大 25 MB），不是任意附件包。准备开始前确认这份文件属于当前报价；首次上传前校验 SHA256，服务器接受和页面可见文件名都要核对，文件名检查不能误匹配删除按钮。
- 使用 `launchEdge()`，不使用 Windows MCP。复用已保存的学校会话；需要密码时只向官方 `login.wisc.edu` 使用已有 `uw-library` NetID 保存项自动尝试一次，复用现有失败锁。不让用户重复录入已保存的 NetID；没有凭据或密码失败才具体说明，Duo 才请用户接手。Duo 最长等 8 分钟，不代点、不绕过。
- 准备命令在首次可行动阶段返回：`needs_duo`、`ready` 或 `stopped`。`ready` 提供 `approval_digest`、金额口径、附件核验和截图，保留同一独立浏览器窗口 30 分钟。后台助手只等待本地命令事件，不轮询、不调用模型，父会话结束不丢网页；到期自动关闭，不假称网站保存了草稿。

### 2. 用户批准后，在同一页面提交一次

普通拟稿、确认地址、允许上传附件或 `ece-prepare` 不等于批准最终提交。给用户看完整申请内容、金额及附件；用户批准这份最终申请后，agent 才写批准文件：

```json
{
  "preparation_id": "本次返回的ID",
  "approval_digest": "本次ready返回的摘要",
  "confirmed_by_user": true,
  "confirmation_source": "实际用户批准的会话/任务及原话"
}
```

```powershell
node automation/run.mjs procurement ece-submit <approval.json>
node automation/run.mjs procurement ece-status <preparation_id>
```

**`queued:true` 只表示命令已交给活页面，不表示提交成功。**只有状态成为 `submitted`，且有网页回执与唯一新增申请编号，才能报告已提交。程序提交前重新核对所有字段、商品、用途、可见审批备注及附件；TinyMCE 的 `<p>` 包装和金额显示格式不当成语义变化。预览摘要不符、页面变化、窗口失效、同一准备被重复调用或原采购已有 `purchase_request` 时拒绝提交。

点击前先持久化独占的提交尝试标记，只点一次。不重新上传、重写已批准文字、增加附件或自动重试。确认页及提交前后的申请列表共同识别新记录，成功后只登记申请号、访问链接、提交时间、金额、审批人及来源报价号；外部审批状态继续由学校系统拥有。

### 3. 跟踪或结束

```powershell
node automation/run.mjs procurement ece-track high-vac-pumps
node automation/run.mjs procurement ece-close <preparation_id>
```

`ece-track` 只读查询已登记申请号的当前状态，不依据“看不到”推断未提交，也不因为网页提示“没收到邮件就重提”而自动重提。`ece-close` 关闭 ready 阶段的待审窗口，不删除资料。

本地准备记录和证据在 `.runtime/procurement/ece/<preparation_id>/`；`ece-status` 是读取入口。`stopped`、`unconfirmed` 或过期必须先看日志、回执与学校申请记录；已有提交尝试的锁不自动清除。未确认结果不能冒充失败后重提。若确认确实需要一笔独立新购买，应建立新的采购事项，而不是对已提交事项强制重复。

### 验收范围

- 真实案例已跑通 NetID/Duo、填单、上传及提交，申请 **12533**；本轮只用新 `ece-track` 读回其真实记录，不为测试再建申请。
- 新封装通过脱敏副本的真实 Edge / localhost 回归，覆盖隐藏的已预填邮箱、增强下拉框的示例占位项、富文本、三行商品、上传服务器与页面双核验、单独批准、一次提交、持久申请号、字段被改、错误批准摘要、重复调用、校验失败、过期及启动权限错误。
- 不新增工作台按钮、审批自动化、供应商结账、后台定时查询或自动模型调用。新封装未再向真实学校系统创建申请；模拟站点通过不等于已经验收所有学校页面变化。

比较先检查同一型号/规格、数量、币种、税运费用和交期。数字未知保留缺项，不用最低裸价直接推荐供应商。供应商候选后续按明确规格搜索官网/学校认可渠道，核对技术等效性和实际供应情况，来源附在记录里。

跟进以变化和实际时间为触发：报价过了供应商承诺时间再起草催询，或明确截止日来临需要替代供应商；没有承诺时间先补询问。供应商不回复时最多准备一次跟进及并行候选，不每十分钟重复让模型决定催不催。具体延迟阈值由采购的交期/依赖决定，不把这件例子升级成整个系统的中心。

后续加入采购规格、资金来源、学校要求和到货记录，逐项补初始化即可。
