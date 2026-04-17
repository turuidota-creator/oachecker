import assert from "node:assert/strict";

import {
  derivePageInvoiceContext,
  inferInvoiceSubtypeFromPageContext
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

runTest("infers special vat invoice from deductible tax signal", () => {
  assert.equal(
    inferInvoiceSubtypeFromPageContext({
      pageInvoiceLabel: "增值税发票",
      linkedInvoiceCorrectness: "正确",
      deductibleTaxAmount: "1.61"
    }),
    "增值税专用发票"
  );
});

runTest("does not infer special vat invoice without full page signal", () => {
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

runTest("derives page invoice context from flow detail fallback", () => {
  const pageContext = derivePageInvoiceContext(
    { fieldPairs: [], bodyText: "" },
    {
      flowFormData: {
        fplx: "1",
        fpsfzq: "1",
        fpSubform: [{ yxdkse: "1.61" }]
      },
      taskFormData: {
        widgetList: [
          {
            options: {
              name: "fplx",
              optionItems: [
                { label: "增值税发票", value: 1 },
                { label: "其他票据", value: 2 },
                { label: "暂未取得发票", value: 3 }
              ]
            }
          },
          {
            options: {
              name: "fpsfzq",
              optionItems: [
                { label: "正确", value: 1 },
                { label: "不正确", value: 2 }
              ]
            }
          }
        ]
      }
    },
    []
  );

  assert.equal(pageContext.pageInvoiceLabel, "增值税发票");
  assert.equal(pageContext.linkedInvoiceCorrectness, "正确");
  assert.equal(pageContext.deductibleTaxAmount, "1.61");
  assert.equal(inferInvoiceSubtypeFromPageContext(pageContext), "增值税专用发票");
});

if (!process.exitCode) {
  console.log("invoice type page context rules passed");
}
