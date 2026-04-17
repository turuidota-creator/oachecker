import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  analyzeStructuredInvoiceSources,
  detectInvoiceRole,
  inferInvoiceSubtypeFromPageContext,
  isInvoiceTypePass,
  normalizeInvoiceSubtypeLabel,
  normalizePageInvoiceLabel,
  pickFirstNormalizedValue
} from "../oa_finance_audit_rebuild_extension/bg/common.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

globalThis.chrome ??= {
  runtime: {
    getURL(resource = "") {
      return `chrome-extension://test/${String(resource).replace(/^\/+/, "")}`;
    }
  }
};

const analyzerModuleUrl = pathToFileURL(path.join(extensionRoot, "bg", "analyzer.js")).href;
const {
  buildInvoiceTypeCheck,
  selectStructuredInvoiceAttachmentsForOcr
} = await import(analyzerModuleUrl);

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

runTest("专票文本归一化", () => {
  assert.equal(normalizeInvoiceSubtypeLabel("电子发票（增值税专用发票）"), "增值税专用发票");
  assert.equal(normalizeInvoiceSubtypeLabel("增值税专用发票"), "增值税专用发票");
  assert.equal(normalizeInvoiceSubtypeLabel("专票"), "增值税专用发票");
  assert.equal(normalizeInvoiceSubtypeLabel("电 子 发 票 （ 增 值 税 专 用 发 票 ）"), "增值税专用发票");
  assert.equal(normalizeInvoiceSubtypeLabel("增 值 税 专 用 发 票"), "增值税专用发票");
});

runTest("普票文本归一化", () => {
  assert.equal(normalizeInvoiceSubtypeLabel("电子发票（普通发票）"), "增值税普通发票");
  assert.equal(normalizeInvoiceSubtypeLabel("增值税普通发票"), "增值税普通发票");
  assert.equal(normalizeInvoiceSubtypeLabel("普票"), "增值税普通发票");
});

runTest("专票标题残片 OCR 仍归一为专票", () => {
  assert.equal(
    normalizeInvoiceSubtypeLabel('rae ae 电子发票 CR" HEDON 用发 票) 发票号码: 26127000000204159518'),
    "增值税专用发票"
  );
  assert.equal(
    normalizeInvoiceSubtypeLabel("PEA 电 > 发 可 用 发 票) 发票号码: 26442000003238840906"),
    "增值税专用发票"
  );
  assert.equal(
    normalizeInvoiceSubtypeLabel("电子发票（普通发票） 发票号码：26117000000332826050"),
    "增值税普通发票"
  );
});

runTest("发票细分类选项串不应误判为当前值", () => {
  assert.equal(normalizeInvoiceSubtypeLabel("增值税专用发票增值税普通发票invoice"), "");
  const picked = pickFirstNormalizedValue(
    ["增值税专用发票增值税普通发票invoice", "增值税专用发票"],
    normalizeInvoiceSubtypeLabel
  );
  assert.equal(picked.label, "增值税专用发票");
  assert.equal(picked.raw, "增值税专用发票");
});

runTest("页面粗分类归一化", () => {
  assert.equal(normalizePageInvoiceLabel("增值税发票"), "增值税发票");
  assert.equal(normalizePageInvoiceLabel("增 值 税 发 票"), "增值税发票");
  assert.equal(normalizePageInvoiceLabel("其他票据（收据、非税票据、invoice等）"), "其他票据");
  assert.equal(normalizePageInvoiceLabel("暂未取得发票"), "暂未取得发票");
});

runTest("页面粗分类选项串不应误判为当前值", () => {
  assert.equal(normalizePageInvoiceLabel("增值税发票其他票据（收据、非税票据、invoice等）暂未取得发票"), "");
  const picked = pickFirstNormalizedValue(
    ["增值税发票其他票据（收据、非税票据、invoice等）暂未取得发票", "增值税发票"],
    normalizePageInvoiceLabel
  );
  assert.equal(picked.label, "增值税发票");
  assert.equal(picked.raw, "增值税发票");
});

runTest("宽字距 OCR 发票关键词仍能识别附件角色", () => {
  const detected = detectInvoiceRole(
    { name: "vsg_output.jpg", url: "" },
    "发 票 号 码：2611700000401458248 开 票 日 期：2026年04月08日 税 额：250.62 销 售 方：北京测试公司"
  );
  assert.equal(detected.role, "invoice");
});

runTest("金额卡放绿只允许专票加页面增值税发票", () => {
  assert.equal(isInvoiceTypePass("增值税专用发票", "增值税发票"), true);
  assert.equal(isInvoiceTypePass("增值税普通发票", "增值税发票"), false);
  assert.equal(isInvoiceTypePass("增值税专用发票", "其他票据"), false);
  assert.equal(isInvoiceTypePass("未识别", "增值税发票"), false);
});

runTest("多张专票按价税合计匹配付款金额", () => {
  const matches = analyzeStructuredInvoiceSources(
    [
      buildInvoice("INV001", "100.10", "增值税专用发票"),
      buildInvoice("INV002", "200.20", "增值税专用发票"),
      buildInvoice("INV003", "300.30", "增值税专用发票"),
      buildInvoice("INV004", "400.40", "增值税专用发票")
    ],
    { paymentAmount: "1001.00" }
  );

  assert.equal(matches.amount?.multiInvoiceAggregate, true);
  assert.equal(matches.amount?.invoiceCount, 4);
  assert.equal(matches.amount?.invoiceTypeAllSpecial, true);
  assert.equal(matches.amount?.invoiceTypeLabel, "增值税专用发票");
  assert.equal(matches.amount?.matchedValue, "1,001");
  assert.equal(isInvoiceTypePass(matches.amount?.invoiceTypeLabel, "增值税发票"), true);
});

runTest("多张发票合计不等于付款金额时不允许单张误命中", () => {
  const matches = analyzeStructuredInvoiceSources(
    [
      buildInvoice("INV001", "100.00", "增值税专用发票"),
      buildInvoice("INV002", "50.00", "增值税专用发票")
    ],
    { paymentAmount: "100.00" }
  );

  assert.equal(matches.amount, null);
});

runTest("多张发票合计命中但任一票种不是专票时保持预警", () => {
  const matches = analyzeStructuredInvoiceSources(
    [
      buildInvoice("INV001", "100.00", "增值税专用发票"),
      buildInvoice("INV002", "50.00", "增值税普通发票")
    ],
    { paymentAmount: "150.00" }
  );

  assert.equal(matches.amount?.multiInvoiceAggregate, true);
  assert.equal(matches.amount?.invoiceTypeAllSpecial, false);
  assert.equal(matches.amount?.invoiceTypeLabel, "");
  assert.equal(isInvoiceTypePass(matches.amount?.invoiceTypeLabel, "增值税发票"), false);
});

runTest("单张发票保持原有金额匹配行为", () => {
  const matches = analyzeStructuredInvoiceSources(
    [buildInvoice("INV001", "100.00", "增值税专用发票")],
    { paymentAmount: "100.00" }
  );

  assert.ok(matches.amount);
  assert.equal(matches.amount?.multiInvoiceAggregate, undefined);
  assert.equal(matches.amount?.sourceName, "付款页发票明细：INV001");
  assert.equal(matches.amount?.invoiceTypeLabel, "增值税专用发票");
});

runTest("页面字段推断不能单独把金额卡放绿", () => {
  const check = buildInvoiceTypeCheck(
    {
      sourceName: "付款页发票明细：INV001",
      sourceUrl: "https://example.com/invoice-inv001.jpg",
      snippet: "发票号码：INV001；价税合计：100.00"
    },
    {
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "1.61"
    },
    [],
    []
  );

  assert.equal(check.invoiceTypeLabel, "未识别");
  assert.equal(check.inferredInvoiceTypeLabel, "增值税专用发票");
  assert.equal(check.status, "warn");
});

runTest("只有OCR识别为专票且页面为增值税发票才通过", () => {
  const check = buildInvoiceTypeCheck(
    {
      sourceName: "付款页发票明细：26442000003238840906",
      sourceUrl: "https://example.com/invoice-26442000003238840906.jpg",
      snippet: "发票号码：26442000003238840906；价税合计：1474.65"
    },
    {
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "169.65"
    },
    [],
    [
      {
        role: "invoice",
        sourceName: "付款页附件: 付款页发票明细-26442000003238840906.jpg",
        sourceUrl: "https://example.com/invoice-26442000003238840906.jpg",
        attachmentName: "付款页发票明细-26442000003238840906.jpg",
        text: "电子发票（增值税专用发票） 发票号码：26442000003238840906 价税合计：1474.65"
      }
    ]
  );

  assert.equal(check.invoiceTypeLabel, "增值税专用发票");
  assert.equal(check.status, "pass");
});

runTest("OCR未识别到专票时即使页面推断为专票也不通过", () => {
  const check = buildInvoiceTypeCheck(
    {
      sourceName: "付款页发票明细：INV001",
      sourceUrl: "https://example.com/invoice-inv001.jpg",
      snippet: "发票号码：INV001；价税合计：100.00"
    },
    {
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "1.61"
    },
    [],
    [
      {
        role: "invoice",
        sourceName: "付款页附件: 付款页发票明细-INV001.jpg",
        sourceUrl: "https://example.com/invoice-inv001.jpg",
        attachmentName: "付款页发票明细-INV001.jpg",
        text: "电子发票（普通发票） 发票号码：INV001 价税合计：100.00"
      }
    ]
  );

  assert.equal(check.invoiceTypeLabel, "增值税普通发票");
  assert.equal(check.inferredInvoiceTypeLabel, "");
  assert.equal(check.status, "warn");
});

runTest("结构化命中发票即使页面可推断专票也不能跳过OCR", () => {
  const attachments = selectStructuredInvoiceAttachmentsForOcr(
    [
      {
        invoiceNo: "26442000003238840906",
        sourceName: "付款页发票明细：26442000003238840906",
        sourceUrl: "https://example.com/invoice-26442000003238840906.jpg",
        sourceText: "发票类型：增值税专用发票 发票号码：26442000003238840906 价税合计：1474.65",
        attachment: {
          name: "付款页发票明细：26442000003238840906.jpg",
          url: "https://example.com/invoice-26442000003238840906.jpg"
        }
      }
    ],
    {
      paymentAmount: "1474.65"
    },
    {
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "169.65"
    },
    {
      amount: {
        sourceName: "付款页发票明细：26442000003238840906",
        sourceUrl: "https://example.com/invoice-26442000003238840906.jpg",
        invoiceNo: "26442000003238840906",
        snippet: "发票号码：26442000003238840906；价税合计：1474.65"
      },
      company: true,
      account: true
    }
  );

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.url, "https://example.com/invoice-26442000003238840906.jpg");
});

runTest("page context infers special vat invoice", () => {
  assert.equal(
    inferInvoiceSubtypeFromPageContext({
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "1.61"
    }),
    "增值税专用发票"
  );
});

runTest("page context does not infer special vat invoice without full signal", () => {
  assert.equal(
    inferInvoiceSubtypeFromPageContext({
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "0"
    }),
    ""
  );
  assert.equal(
    inferInvoiceSubtypeFromPageContext({
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "不正确",
      deductibleTaxAmount: "1.61"
    }),
    ""
  );
});

function buildInvoice(invoiceNo, amount, invoiceTypeRaw) {
  return {
    invoiceNo,
    amount,
    invoiceTypeRaw,
    invoiceTypeCandidates: [invoiceTypeRaw],
    sourceName: `付款页发票明细：${invoiceNo}`,
    sourceText: [
      `发票号码：${invoiceNo}`,
      `发票类型：${invoiceTypeRaw}`,
      `销售方：测试供应商`,
      `价税合计：${amount}`
    ].join("；")
  };
}

if (!process.exitCode) {
  console.log("invoice type rules passed");
}
