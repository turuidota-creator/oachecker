import assert from "node:assert/strict";

import { extractFlowableFacts } from "../oa_finance_audit_rebuild_extension/bg/detail.js";

const facts = extractFlowableFacts({
  processCode: "GNTYYFK-202604160001",
  flowFormData: {
    payeecode: "1402022109601315856",
    payeeBankName: "中国工商银行福建省福州市台江支行",
    SUPPLIER: "福州云江水科技发展有限公司"
  }
});

assert.equal(facts.accountNo, "1402022109601315856");
assert.equal(facts.bankName, "中国工商银行福建省福州市台江支行");
assert.equal(facts.supplier, "福州云江水科技发展有限公司");

console.log("flowable payeecode account checks passed");
