# OA 付款审核插件重构清单

这份文档记录的是“重构版插件应该如何做”，以及“当前已经做到哪一步”。

## 1. 重构目标

本次重构不是给旧版继续打补丁，而是把整个项目收敛成一套明确的业务链：

1. 读取付款单页面
2. 读取付款单附件
3. 进入二级合同页
4. 读取合同页和合同附件
5. 进入二级验收页
6. 用外部证据去核验付款单
7. 只把最关键的结果展示给财务

## 2. 固定业务口径

### 2.1 被核验目标

所有外部来源都只用于核验付款单上的这三项：

1. 付款金额
2. 收款公司名称
3. 收款账号

### 2.2 主结果展示

前端主区域只展示三张结果卡片：

1. 金额一致
2. 收款公司名称一致
3. 收款账号一致

颜色规则固定：

- `pass`：绿色，已找到外部证据且一致
- `warn`：黄色，暂未核实或证据不足
- `fail`：红色，已找到外部证据但冲突

### 2.3 合同参考区

合同区不再承担主判断，只展示参考信息：

- 合同页状态
- 合同附件处理状态
- 合同有效期
- 合同付款条件
- 合同付款摘要
- 上述信息的来源

### 2.4 验收规则

验收当前只做辅助判断：

- 是否找到了对应验收页
- 验收名称/邮件标题是否像这笔付款

验收不直接主导三张主卡片的绿黄红。

## 3. 证据优先级

### 3.1 默认优先级

对金额、公司、账号的展示来源，当前按这个优先级选主证据：

1. 发票
2. 当前付款页附件
3. 合同
4. 其他附件

### 3.2 特别规则

- 发票优先，但不是唯一来源
- 发票缺少某字段时，可以继续用合同或其他附件补证
- 缺证据不等于不一致
- 付款单字段不能作为证据来源
- 后面出现更高优先级来源时，可以覆盖前面低优先级来源

## 4. 发票识别规则

当前不再只靠文件名判断发票，而是采用“文件名 + 正文/OCR 内容”双重识别。

具体规则见：

- [invoice_detection_rules.md](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/docs/invoice_detection_rules.md)

## 5. 模块划分

### 5.1 页面采集层

文件：

- [page/collector.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/page/collector.js)

职责：

- 读取付款单页面字段
- 发现付款页附件
- 发现合同/验收链接
- 输出页面快照

状态：

- 已完成基础版

### 5.2 OA 详情适配层

文件：

- [bg/detail.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/detail.js)

职责：

- 兼容 `flowable`
- 兼容 `history`
- 兼容老 `requestid`
- 发现流程详情中的附件和关联流程

状态：

- 已完成
- 仍需继续减少合同附件中的无意义重复项

### 5.3 附件下载与读取层

文件：

- [bg/io.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/io.js)

职责：

- 复用当前标签页上下文
- 下载 OA 附件和外部文件服务附件
- 统一返回二进制和内容类型

状态：

- 已完成

### 5.4 附件解析层

文件：

- [bg/extract.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/extract.js)

职责：

- 解析 PDF / DOCX / XLSX / OFD / 图片 / 邮件 / ZIP
- 文本型 PDF 直接抽字
- 扫描版 PDF 渲染后 OCR
- 图片附件多轮 OCR

状态：

- 已完成主要能力
- 仍需继续提高复杂合同条款的提取稳定性

### 5.5 规则与归一化层

文件：

- [bg/common.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/common.js)

职责：

- 金额、公司、账号匹配
- 发票识别
- 附件角色识别
- 附件预扫描优先级
- 文本清洗

状态：

- 已完成主要规则

### 5.6 主分析与决策层

文件：

- [bg/analyzer.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/analyzer.js)

职责：

- 串起付款页、合同页、验收页
- 分析附件
- 生成证据命中结果
- 输出三张主卡片和合同参考信息
- 维护调试信息和处理状态

状态：

- 已完成主链路
- 已接入合同摘要 MVP
- 当前重点是继续补强“合同附件读全”“付款条件提取”和“更安全的外发边界”

### 5.7 合同摘要与条款提取层

文件：

- [bg/contract_terms.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/bg/contract_terms.js)

职责：

- 本地筛付款相关候选条款
- 本地提取轻量合同摘要
- 输出付款条件、合同期限等可展示结果

当前状态：

- 当前只保留本地规则链路
- 外部模型分支已停用并清理

### 5.8 前端展示层

文件：

- [content.js](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/content.js)
- [styles.css](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/oa_finance_audit_rebuild_extension/styles.css)

职责：

- 实时进度
- 三张主卡片
- 合同参考信息
- 合同付款摘要
- hover 来源说明
- 整卡点击打开来源
- 调试信息折叠
- 发送给 AI 预览折叠

状态：

- 已完成主展示
- 已加合同处理状态信息
- 已加“发送给 AI 的预览”折叠

## 6. 当前已经落实的关键实现

### 6.1 OCR 本地化

当前 OCR 已经改成完全本地化：

- 使用本地 `tessdata`
- 不再依赖外网下载语言包
- 对扫描版 PDF 和图片附件都可用

### 6.2 小文件优先扫描

当前扫描顺序已经收敛为：

1. 先按业务角色
2. 同角色内，小文件优先
3. 可疑发票的小图、小 PDF 会提前于合同大文件扫描

### 6.3 合同处理状态可见化

当前已经会输出这些合同处理信息：

- 是否进入合同页
- 发现了多少合同附件
- 支持解析的合同附件有多少
- 实际成功下载多少
- 实际成功解析多少
- 有效期来源
- 付款条件来源

### 6.4 VPN 代理绕过

测试脚本现在已经默认带直连参数，避免因为 VPN 导致自动化浏览器打不开 OA。

文件：

- [test_rebuild_single_case.py](C:/Users/turui/Documents/OA_Payment_Audit_Rebuild_Project/scripts/test_rebuild_single_case.py)

### 6.5 合同摘要 MVP

当前已经落地：

1. 本地从合同页 / 合同附件里筛付款相关候选条款
2. 候选条款优先收缩成“付款关键词句子窗口”
3. 前端会显示：
   - 摘要状态
   - 合同处理状态
   - 条款证据与摘要结果

## 7. 当前未完成项

### 7.1 合同付款条件提取

现状：

- 有些合同页能进
- 有些合同附件能读
- 但付款条件和摘要仍存在误命中、漏命中、语义噪音

下一步：

- 继续收紧付款条款候选切法
- 继续减少价格表、签章区、联系人块误入候选段

### 7.2 合同附件计数和展示

现状：

- 已经比之前明显干净
- 但仍然可能混入一些无意义文件名或重复项

下一步：

- 继续细化附件去重和展示口径

### 7.3 验收弱校验

现状：

- 能进入就做标题匹配
- 没权限就提示

下一步：

- 保持轻量，不打算把验收做成复杂语义判断

### 7.4 合同摘要本地化稳定性

现状：

- 外部模型分支已停用
- 当前合同摘要完全走本地规则链路

下一步：

- 继续提高条款召回与摘要稳定性
- 继续减少无关段落误入候选池

## 8. 验收标准

这版插件要达到的最低验收标准是：

1. 付款单能正常读取
2. 三张主卡片不出现“付款单自己核实自己”
3. 发票命中时，金额/公司优先显示发票来源
4. 图片发票和扫描 PDF 能通过 OCR 命中关键字段
5. 合同区能明确告诉用户：
   - 合同页进没进去
   - 合同附件发现了多少
   - 实际解析了多少
   - 付款条件是没提到，还是没读到
6. 合同摘要失败时不能影响三张主卡片
7. 发送给 AI 的预览默认收起，且收起后不暴露正文内容

## 9. 当前建议的开发顺序

后面如果继续做，建议按这个顺序推进：

1. 先补合同付款条件规则提取
2. 再收合同附件去重和展示
3. 再把合同摘要从“脱敏条款片段外发”升级到“结构化 facts 外发”
4. 再做更多单据回放
5. 最后再考虑更复杂的条款理解能力
