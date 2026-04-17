import assert from "node:assert/strict";

import {
  analyzeStructuredInvoiceSources,
  inferInvoiceSubtypeFromPageContext,
  isInvoiceTypePass,
  normalizeInvoiceSubtypeLabel,
  normalizePageInvoiceLabel,
  pickFirstNormalizedValue
} from "../oa_finance_audit_rebuild_extension/bg/common.js";

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
});

runTest("普票文本归一化", () => {
  assert.equal(normalizeInvoiceSubtypeLabel("电子发票（普通发票）"), "增值税普通发票");
  assert.equal(normalizeInvoiceSubtypeLabel("增值税普通发票"), "增值税普通发票");
  assert.equal(normalizeInvoiceSubtypeLabel("普票"), "增值税普通发票");
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
