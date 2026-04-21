import assert from "node:assert/strict";

import {
  discoverProcessRefs,
  extractKnownRefs,
  parseProcessRef
} from "../oa_finance_audit_rebuild_extension/bg/detail.js";

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

const paymentDetailId = "664349053227765760";
const contractDetailId = "649796677577871360";
const contractUrl =
  `http://oa.cyou-inc.com/workflow/process/detail/${contractDetailId}?sourceInstId=${paymentDetailId}`;
const historyContractId = "505752";
const historyContractUrl =
  `http://oa.cyou-inc.com/workflow/process/history/detail/${historyContractId}/monitor?processCode=CYHT-20241230004`;
const historyContractUrlWithSource =
  `${historyContractUrl}&sourceInstId=${paymentDetailId}`;

runTest("parseProcessRef preserves sourceInstId query", () => {
  const ref = parseProcessRef(contractUrl, "contract");
  assert.ok(ref);
  assert.equal(ref.detailUrl, contractUrl);
  assert.equal(ref.detailId, contractDetailId);
  assert.equal(ref.sourceInstId, paymentDetailId);
});

runTest("parseProcessRef preserves history sourceInstId query", () => {
  const ref = parseProcessRef(historyContractUrlWithSource, "contract");
  assert.ok(ref);
  assert.equal(ref.detailUrl, historyContractUrlWithSource);
  assert.equal(ref.detailId, historyContractId);
  assert.equal(ref.sourceInstId, paymentDetailId);
});

runTest("extractKnownRefs keeps full contract link from flow form rows", () => {
  const refs = extractKnownRefs(
    {
      flowFormData: {
        formtable_main_154_dt4: [
          {
            htlink: contractUrl,
            Num3: "CYNCHT-202602270001",
            CGHTTitle: "测试合同"
          }
        ]
      }
    },
    paymentDetailId
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].detailUrl, contractUrl);
  assert.equal(refs[0].sourceInstId, paymentDetailId);
});

runTest("extractKnownRefs fills missing sourceInstId for related flow links", () => {
  const blankSourceUrl =
    `http://oa.cyou-inc.com/workflow/process/detail/${contractDetailId}?sourceInstId=`;
  const refs = extractKnownRefs(
    {
      flowFormData: {
        formtable_main_154_dt4: [
          {
            htlink: blankSourceUrl,
            Num3: "CYHT-202604100002",
            CGHTTitle: "畅游合同用章申请"
          }
        ]
      }
    },
    paymentDetailId
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourceInstId, paymentDetailId);
  assert.match(refs[0].detailUrl, new RegExp(`sourceInstId=${paymentDetailId}`));
});

runTest("extractKnownRefs fills missing sourceInstId for history contract links", () => {
  const refs = extractKnownRefs(
    {
      flowFormData: {
        formtable_main_154_dt4: [
          {
            htlink: historyContractUrl,
            Num3: "CYHT-20241230004",
            CGHTTitle: "历史合同"
          }
        ]
      }
    },
    paymentDetailId
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].detailId, historyContractId);
  assert.equal(refs[0].sourceInstId, paymentDetailId);
  assert.match(refs[0].detailUrl, new RegExp(`sourceInstId=${paymentDetailId}`));
});

runTest("discoverProcessRefs keeps query string when scanning text blobs", () => {
  const refs = discoverProcessRefs(
    {
      debugText: `合同详情：${contractUrl}`
    },
    paymentDetailId
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].detailUrl, contractUrl);
  assert.equal(refs[0].sourceInstId, paymentDetailId);
});

if (!process.exitCode) {
  console.log("process link refs passed");
}
