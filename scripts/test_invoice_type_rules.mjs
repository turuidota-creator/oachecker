import assert from "node:assert/strict";

import {
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

if (!process.exitCode) {
  console.log("invoice type rules passed");
}
