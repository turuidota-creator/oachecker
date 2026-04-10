(() => {
  const models = globalThis.OAFinanceRebuildModels;
  if (!models) {
    return;
  }

  function classifyAttachmentRole(item) {
    const combined = models.cleanText(`${item?.name || ""} ${item?.url || ""}`);
    if (/发票|电子发票|专票|普票|invoice/i.test(combined)) {
      return "invoice";
    }
    if (/合同|框架协议|采购合同|补充协议/i.test(combined)) {
      return "contract";
    }
    if (/变更函|开户行|开户信息|银行信息|账户信息|收款账户|账户变更/i.test(combined)) {
      return "bank_notice";
    }
    if (/验收|结算单|验收单|验收邮件/i.test(combined)) {
      return "acceptance";
    }
    return "other";
  }

  function buildSourceInventories(snapshot) {
    const attachments = Array.isArray(snapshot?.attachments) ? snapshot.attachments : [];
    const relatedLinks = Array.isArray(snapshot?.relatedLinks) ? snapshot.relatedLinks : [];
    const inventories = {
      invoiceAttachments: [],
      contractAttachments: [],
      bankChangeAttachments: [],
      acceptanceAttachments: [],
      otherAttachments: [],
      domesticPrLinks: [],
      purchaseOrderLinks: [],
      contractLinks: [],
      acceptanceLinks: [],
      relatedLinks: []
    };

    for (const attachment of attachments) {
      const role = classifyAttachmentRole(attachment);
      if (role === "invoice") {
        inventories.invoiceAttachments.push(attachment);
      } else if (role === "contract") {
        inventories.contractAttachments.push(attachment);
      } else if (role === "bank_notice") {
        inventories.bankChangeAttachments.push(attachment);
      } else if (role === "acceptance") {
        inventories.acceptanceAttachments.push(attachment);
      } else {
        inventories.otherAttachments.push(attachment);
      }
    }

    for (const link of relatedLinks) {
      if (link.relation === "domestic_pr") {
        inventories.domesticPrLinks.push(link);
      } else if (link.relation === "purchase_order") {
        inventories.purchaseOrderLinks.push(link);
      } else if (link.relation === "contract") {
        inventories.contractLinks.push(link);
      } else if (link.relation === "acceptance") {
        inventories.acceptanceLinks.push(link);
      } else {
        inventories.relatedLinks.push(link);
      }
    }

    return inventories;
  }

  function pickBestSource(candidates) {
    return candidates.find((item) => item?.name || item?.title || item?.url) || null;
  }

  function sourceNameOf(item) {
    return item?.name || item?.title || "";
  }

  function sourceUrlOf(item) {
    return item?.url || "";
  }

  function createPhaseOneAnalysis(snapshot, buildTag) {
    const target = snapshot?.paymentTarget || {};
    const inventories = buildSourceInventories(snapshot);
    const contractSource = pickBestSource([...inventories.contractLinks, ...inventories.contractAttachments]);
    const acceptanceSource = pickBestSource([...inventories.acceptanceLinks, ...inventories.acceptanceAttachments]);

    return {
      buildTag,
      analyzedAt: new Date().toISOString(),
      phase: "phase-1-evidence-pool",
      overallStatus: "warn",
      paymentTarget: target,
      pageSummary: {
        attachmentCount: snapshot?.attachments?.length || 0,
        invoiceAttachmentCount: inventories.invoiceAttachments.length,
        contractAttachmentCount: inventories.contractAttachments.length,
        bankChangeAttachmentCount: inventories.bankChangeAttachments.length,
        acceptanceAttachmentCount: inventories.acceptanceAttachments.length,
        domesticPrLinkCount: inventories.domesticPrLinks.length,
        purchaseOrderLinkCount: inventories.purchaseOrderLinks.length,
        contractLinkCount: inventories.contractLinks.length,
        acceptanceLinkCount: inventories.acceptanceLinks.length,
        otherLinkCount: inventories.relatedLinks.length
      },
      verificationItems: [
        models.createVerificationItem({
          key: "amount",
          label: "金额一致",
          status: "warn",
          statement: target.paymentAmount ? "已采集付款金额，待用外部证据核验" : "未从付款单页面识别到付款金额",
          matchedValue: models.formatAmount(target.paymentAmount),
          snippet: target.paymentAmount ? `付款单金额：${models.formatAmount(target.paymentAmount)}` : ""
        }),
        models.createVerificationItem({
          key: "company",
          label: "收款公司名称一致",
          status: "warn",
          statement: target.payeeCompany ? "已采集收款公司，待用外部证据核验" : "未从付款单页面识别到收款公司名称",
          matchedValue: target.payeeCompany || "",
          snippet: target.payeeCompany ? `付款单收款公司：${target.payeeCompany}` : ""
        }),
        models.createVerificationItem({
          key: "account",
          label: "收款账号一致",
          status: "warn",
          statement: target.payeeAccount ? "已采集收款账号，待用外部证据核验" : "未从付款单页面识别到收款账号",
          matchedValue: target.payeeAccount || "",
          snippet: target.payeeAccount ? `付款单收款账号：${target.payeeAccount}` : ""
        })
      ],
      contractReference: models.createContractReferenceSummary({
        paymentTerms: contractSource ? `已发现合同来源：${sourceNameOf(contractSource)}，待继续读取合同正文` : "尚未发现明确的合同来源",
        sourceName: sourceNameOf(contractSource),
        sourceUrl: sourceUrlOf(contractSource)
      }),
      acceptanceReference: models.createAcceptanceReferenceSummary({
        statement: acceptanceSource ? `已发现验收来源：${sourceNameOf(acceptanceSource)}，待校验是否对应当前付款单` : "尚未发现明确的验收来源",
        sourceName: sourceNameOf(acceptanceSource),
        sourceUrl: sourceUrlOf(acceptanceSource)
      }),
      evidencePool: inventories,
      debug: { snapshot }
    };
  }

  globalThis.OAFinanceRebuildEvidence = {
    classifyAttachmentRole,
    buildSourceInventories,
    createPhaseOneAnalysis
  };
})();
