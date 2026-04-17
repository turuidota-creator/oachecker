# 文档索引

## 当前版本重点

- 2026-04-15：详情页和列表页都已经接入基于 `requestId` 的异步进度隔离。
- 2026-04-15：列表页自动审核已采用受控并发，当前默认并发数为 `2`。
- 2026-04-15：OCR 识别链路已改成 `background 编排 + 宿主页 ISOLATED world bridge 复用`。
- 2026-04-16：详情页增加页面内 `自动审核` 入口和固定兜底入口，避免只依赖悬浮面板自动出现。
- 2026-04-16：详情页进入时只被动读取批量审核缓存；只有用户点击 `自动审核` 时，缓存未命中才自动开始审核。
- 2026-04-16：`pitfalls_and_lessons.md` 已从长篇事故记录整理为高密度经验清单，细节回溯以 git 历史为准。
- 2026-04-17：活动代码 UTF-8 乱码已集中清理；旧 in-tab PDF OCR / 直接图片 OCR 死路径已移除，OCR guard 改为锚定 bridge 主链路。
- 2026-04-17：列表页长耗时自动审核已增加同 `requestId` 后台响应合并和 message channel closed 有限重试。
- 2026-04-17：用户可见失败说明已增加底层英文错误中文化映射，覆盖 Chrome message、网络、权限、OCR 初始化等常见提示。

- `rebuild_plan.md`
  总体重构范围、分阶段目标和推进顺序。

- `purchase_payment_related_documents_plan.md`
  采购付款场景下，国内 PR、采购订单、验收单、合同四条关联链路的产品口径与实现计划。

- `contract_summary_and_redaction.md`
  合同摘要当前的纯本地实现、本地摘要接口口径，以及本地化架构图。

- `contract_clause_evidence_plan.md`
  合同模块从“单句摘要”升级到“付款条件 / 合同期限”主题化证据包的产品与实现方案。

- `invoice_detection_rules.md`
  发票识别、优先级和主核对证据来源规则。

- `oa_system_guide.md`
  基于真实回放、页面源码和接口行为整理的 OA 系统解读指导。

- `pitfalls_and_lessons.md`
  当前项目已经踩过的关键坑、排查顺序和可复用修复原则。

- `scripts/test_extract_ocr_guards.mjs`
  OCR / 提取兜底规则的本地校验脚本。

- `scripts/test_invoice_type_rules.mjs`
  发票类型与金额主核对闸门规则的本地校验脚本。

- `scripts/test_invoice_type_page_context.mjs`
  发票类型识别在页面上下文中的本地校验脚本。

- `scripts/test_process_link_refs.mjs`
  付款流程关联链接引用的本地校验脚本。

- `scripts/test_docx_extraction_guards.mjs`
  DOCX 可见文本提取与防误提取规则的本地校验脚本。

- `proxy_troubleshooting_lessons_2026-04-10.md`
  代理导致无法访问 OA 时的排查记录与处理办法。

- `PROJECT_ROOT_NOTE.txt`
  项目根目录整理说明。
- 2026-04-13 补充：批量审核弹层点击无响应的排查经验、老历史合同页附件下载不稳定时的页面快照兜底经验，已写入 `pitfalls_and_lessons.md`
