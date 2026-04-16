# OA 付款审核

这里是 OA 付款审核插件当前正式工作区的整理后项目根目录。

请将以下目录作为项目根目录使用：

- `C:\Users\turui\Documents\OA_Payment_Audit_Rebuild_Project`

## 仓库结构

- `oa_finance_audit_rebuild_extension/`
  浏览器插件主源码目录。
- `docs/`
  产品、架构、脱敏、发票和推进计划等文档。
- `scripts/`
  本地校验与自动化脚本。

## 包含内容

- OA 付款审核插件源码
- 当前产品与实现文档
- 本地单案例校验脚本
- 列表页异步并行审查与 OCR bridge 相关实现

## 推荐工作目录

如果某个工具要求你添加或打开项目目录，请选择：

- `C:\Users\turui\Documents\OA_Payment_Audit_Rebuild_Project`

## 重要路径

- 插件根目录：
  `C:\Users\turui\Documents\OA_Payment_Audit_Rebuild_Project\oa_finance_audit_rebuild_extension`
- 文档目录：
  `C:\Users\turui\Documents\OA_Payment_Audit_Rebuild_Project\docs`
- 脚本目录：
  `C:\Users\turui\Documents\OA_Payment_Audit_Rebuild_Project\scripts`

## 核心文档

- `docs/rebuild_plan.md`
- `docs/purchase_payment_related_documents_plan.md`
- `docs/contract_summary_and_redaction.md`
- `docs/invoice_detection_rules.md`
- `docs/pitfalls_and_lessons.md`

## 当前实现摘要

- 详情页分析已经采用 `requestId + progress` 的异步进度隔离，避免旧回调把新一次分析状态覆盖掉。
- 列表页自动审核已支持受控并行，当前默认并发数为 `2`，通过 worker 队列逐条拉起付款单审查。
- background 会把分析结果按 `processCode + buildTag + 当天日期` 写入本地缓存；详情页进入后只被动读取缓存，不自动开跑审核。
- 详情页底部 OA 原生按钮区右侧会挂载页面内 `自动审核` 入口；找不到原生按钮区时会显示小型固定兜底入口。
- 点击详情页 `自动审核` 后会先展开审核面板并读取缓存；命中缓存则直接展示，未命中才开始当前付款单审核。
- OCR 已切到宿主页 `ISOLATED` world 的 bridge 复用模式，避免 MV3 service worker 里直接长期承载 OCR worker。
- 新增本地规则校验脚本：
  - `scripts/test_extract_ocr_guards.mjs`
  - `scripts/test_invoice_type_rules.mjs`
  - `scripts/test_invoice_type_page_context.mjs`
  - `scripts/test_process_link_refs.mjs`
  - `scripts/test_docx_extraction_guards.mjs`

## 说明

- 这个整理后的项目根目录中不包含临时研究文件和归档的调试产物。
- 原始归档工作区仍保留在：
  `C:\Users\turui\Documents\Playground_oa_finance_rebuild`
