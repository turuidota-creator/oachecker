import {
  accountMatchesPayment,
  analyzeStructuredInvoiceSources,
  attachmentPreScanPriority,
  amountMatchesPayment,
  classifyAttachmentRole,
  cleanText,
  companyMatchesPayment,
  createVerificationItem,
  detectAttachmentRole,
  deriveBaseUrl,
  derivePageInvoiceContext,
  attachmentSizeHint,
  extractContractPeriod,
  extractPaymentTerms,
  firstLikelyBankAccount,
  firstMeaningfulText,
  firstNonEmpty,
  firstNonEmptyDate,
  formatAmount,
  inferInvoiceSubtypeFromPageContext,
  isInvoiceTypePass,
  makeEvidence,
  normalizeCompareText,
  normalizeError,
  normalizeInvoiceSubtypeLabel,
  normalizePageInvoiceLabel,
  parseAmount,
  pickFirstNormalizedValue,
  rolePriority,
  scoreAttachment,
  snippetAround,
  supportsAttachmentTextExtraction
} from "./common.js";
import { collectPageSnapshotFromUrl, fetchBinary, setRuntimeContext } from "./io.js";
import {
  buildAttachmentTitles,
  buildFlowableAttachmentList,
  buildFlowableInvoiceEvidenceList,
  buildHistoryAttachmentList,
  discoverProcessRefs,
  extractFlowableFacts,
  extractKnownRefs,
  fetchFlowableDetail,
  fetchHistoryDetail,
  findHistoryField,
  parseProcessRef,
  resolveProcessCodeRef
} from "./detail.js";
import { buildContractClauseCandidates, deriveLocalContractSummary } from "./contract_terms.js";
import { buildContractSummaryProviderMeta, generateContractSummary } from "./contract_summary_provider.js";
import { extractMailEvidenceFromAttachment, extractReferenceTextsFromAttachment } from "./extract.js";
import { acquireOcrBridge, releaseOcrBridge } from "./ocr_bridge.js";

export const BUILD_TAG = "rebuild-phase5-flowable-payeecode-account-2026-04-22";

const GENERIC_PROCESS_CODE_RE = /\b[A-Z]{2,10}-\d{8,}\b/i;
const DOMESTIC_PR_CODE_RE = /\bGNPR-\d{8,}\b/i;
const CONTRACT_PROCESS_CODE_RE = /\b(?:CYHT|CYNCHT|HT)-\d{8,}\b/i;
const PURCHASE_ORDER_CODE_RE = /\bCYNCDD-\d{8,}\b/i;
const PR_PAYMENT_CODE_RE = /^GNTYYFK-\d{8,}$/i;
const PURCHASE_PAYMENT_CODE_RE = /^DDFK-\d{8,}$/i;
const PAYEE_ACCOUNT_FIELD_LABELS = [
  "收款账号",
  "收款帐号",
  "收款账户",
  "收款银行账号",
  "收款银行帐号",
  "收款方账号",
  "收款方帐号",
  "收款方账户",
  "银行账号",
  "银行帐号",
  "开户账号",
  "开户帐号",
  "开户银行账号",
  "开户银行帐号",
  "银行账户",
  "账户号",
  "对方账号",
  "对方帐号",
  "对方账户",
  "供应商账号",
  "供应商帐号",
  "供应商账户"
];

function reportProgress(onProgress, phase, text, detail = "") {
  if (typeof onProgress !== "function") {
    return;
  }
  try {
    onProgress({
      phase,
      text,
      detail,
      at: new Date().toISOString()
    });
  } catch {
    // Ignore progress callback errors so analysis can continue.
  }
}

function createTimingRecorder() {
  const origin = Date.now();
  const entries = [];
  const elapsed = () => Date.now() - origin;

  const push = (entry) => {
    entries.push({
      at: new Date().toISOString(),
      atMs: elapsed(),
      ...entry
    });
  };

  return {
    mark(label, detail = {}) {
      push({
        type: "mark",
        label,
        ...detail
      });
    },
    async time(label, task, detail = {}) {
      const startedAtMs = elapsed();
      try {
        const value = await task();
        push({
          type: "duration",
          label,
          startedAtMs,
          durationMs: elapsed() - startedAtMs,
          status: "ok",
          ...detail
        });
        return value;
      } catch (error) {
        push({
          type: "duration",
          label,
          startedAtMs,
          durationMs: elapsed() - startedAtMs,
          status: "error",
          error: normalizeError(error),
          ...detail
        });
        throw error;
      }
    },
    snapshot() {
      return {
        totalMs: elapsed(),
        entries: entries.slice()
      };
    }
  };
}

function createLimiter(concurrency) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const queue = [];
  let activeCount = 0;

  const runNext = () => {
    if (activeCount >= limit || queue.length === 0) {
      return;
    }
    const item = queue.shift();
    activeCount += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        runNext();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
}

function createAnalysisRuntime(timings = null) {
  return {
    attachmentTextCache: new Map(),
    limitAttachmentWork: createLimiter(3),
    limitRelatedProcessWork: createLimiter(2),
    timings
  };
}

function runRelatedProcessWork(runtime, label, task) {
  const run = async () => {
    runtime?.timings?.mark("related-process-slot-start", { taskLabel: label });
    try {
      return await task();
    } finally {
      runtime?.timings?.mark("related-process-slot-end", { taskLabel: label });
    }
  };
  return typeof runtime?.limitRelatedProcessWork === "function"
    ? runtime.limitRelatedProcessWork(run)
    : run();
}

async function getAttachmentReferenceEntries(attachment, runtime = null, target = null, extractionOptions = {}) {
  const url = cleanText(attachment?.url || "");
  if (!url) {
    return { entries: [], downloaded: false, fromCache: false };
  }

  const runExtraction = async () => {
    const timingDetail = {
      attachmentName: cleanText(attachment?.name || ""),
      contentType: cleanText(attachment?.contentType || "")
    };
    const binary = runtime?.timings
      ? await runtime.timings.time("attachment-fetch", () => fetchBinary(url), timingDetail)
      : await fetchBinary(url);
    const bytes = binary?.bytes || null;
    if (!bytes || bytes.byteLength < 64) {
      return { entries: [], downloaded: false };
    }
    const extractDetail = {
      ...timingDetail,
      contentType: cleanText(binary.contentType || attachment?.contentType || ""),
      byteLength: bytes.byteLength
    };
    const extractOptions = {
      target,
      ocrIntent: extractionOptions?.ocrIntent || "full",
      ocrEvidence: extractionOptions?.ocrEvidence || {}
    };
    if (runtime?.timings) {
      extractOptions.onTiming = (label, detail = {}) => {
        runtime.timings.mark(label, {
          ...extractDetail,
          ...detail
        });
      };
    }
    const entries = runtime?.timings
      ? await runtime.timings.time(
          "attachment-extract",
          () => extractReferenceTextsFromAttachment(attachment, bytes, binary.contentType || "", extractOptions),
          extractDetail
        )
      : await extractReferenceTextsFromAttachment(attachment, bytes, binary.contentType || "", extractOptions);
    return { entries, downloaded: true };
  };

  if (!runtime?.attachmentTextCache || typeof runtime?.limitAttachmentWork !== "function") {
    return { ...(await runExtraction()), fromCache: false };
  }

  if (runtime.attachmentTextCache.has(url)) {
    runtime.timings?.mark("attachment-cache-hit", {
      attachmentName: cleanText(attachment?.name || "")
    });
    return { ...(await runtime.attachmentTextCache.get(url)), fromCache: true };
  }

  const task = runtime.limitAttachmentWork(runExtraction).catch((error) => {
    runtime.attachmentTextCache.delete(url);
    throw error;
  });
  runtime.attachmentTextCache.set(url, task);
  return { ...(await task), fromCache: false };
}

function buildAttachmentExtractionOptions(attachment, matches = {}, knownMatches = {}) {
  const role = classifyAttachmentRole(attachment);
  const amountMatched = !!(matches?.amount || knownMatches?.amount);
  const companyMatched = !!(matches?.company || knownMatches?.company);
  const accountMatched = !!(matches?.account || knownMatches?.account);
  const ocrEvidence = {
    amountMatched,
    companyMatched,
    accountMatched,
    role
  };

  if (role === "invoice") {
    return {
      ocrIntent: "invoice-gap-fill",
      ocrEvidence
    };
  }

  if (role === "bank_notice") {
    return {
      ocrIntent: "account-proof",
      ocrEvidence
    };
  }

  return {
    ocrIntent: "full",
    ocrEvidence
  };
}

export async function analyzePageSnapshot(snapshot, tabId, onProgress = null) {
  const baseUrl = deriveBaseUrl(snapshot?.pageUrl);
  setRuntimeContext(baseUrl, tabId);
  const timings = createTimingRecorder();
  timings.mark("analysis-start", {
    hasPageUrl: !!snapshot?.pageUrl,
    tabId: Number.isInteger(tabId) ? tabId : null
  });
  const analysisRuntime = createAnalysisRuntime(timings);
  await timings.time("ocr-bridge-acquire", () => acquireOcrBridge(tabId).catch(() => false), {
    tabId: Number.isInteger(tabId) ? tabId : null
  });

  try {

  reportProgress(onProgress, "payment-root", "正在读取付款单", "准备读取当前付款单详情和结构化字段");

  const rootRef = parseProcessRef(snapshot?.pageUrl || "", "payment");
  const rootDetail = rootRef?.mode === "flowable"
    ? await timings.time("payment-flowable-api", () => fetchFlowableDetail(rootRef, baseUrl), {
        detailId: rootRef.detailId || ""
      })
    : null;
  const rootFacts = rootDetail ? extractFlowableFacts(rootDetail) : {};
  const inlineDomesticPrRefs = await timings.time(
    "resolve-inline-domestic-pr",
    () => resolveInlineDomesticPrRefs(snapshot, baseUrl, onProgress, rootRef?.detailId || ""),
    { detailId: rootRef?.detailId || "" }
  );
  const snapshotWithResolvedPr = inlineDomesticPrRefs.length > 0
    ? {
        ...snapshot,
        relatedLinks: enrichRelatedLinks(snapshot?.relatedLinks || [], inlineDomesticPrRefs)
      }
    : snapshot;
  const inlineContractRefs = await timings.time(
    "resolve-inline-contract",
    () => resolveInlineContractRefs(snapshotWithResolvedPr, baseUrl, onProgress, rootRef?.detailId || ""),
    { detailId: rootRef?.detailId || "" }
  );
  const snapshotWithResolvedRefs = inlineContractRefs.length > 0
    ? {
        ...snapshotWithResolvedPr,
        relatedLinks: enrichRelatedLinks(snapshotWithResolvedPr?.relatedLinks || [], inlineContractRefs)
      }
    : snapshotWithResolvedPr;
  const target = mergePaymentTarget(snapshotWithResolvedRefs?.paymentTarget || {}, rootFacts, snapshotWithResolvedRefs);
  const flowType = detectPaymentFlowType(snapshotWithResolvedRefs, target);
  const structuredInvoiceSources = rootDetail
    ? await timings.time(
        "payment-invoice-evidence",
        () => buildFlowableInvoiceEvidenceList(rootDetail, baseUrl).catch(() => []),
        { detailId: rootRef?.detailId || "" }
      )
    : [];
  const enrichedSnapshot = rootDetail
    ? {
        ...snapshotWithResolvedRefs,
        flowType,
        attachments: dedupeAttachments([...(snapshotWithResolvedRefs?.attachments || []), ...buildFlowableAttachmentList(rootDetail)]),
        relatedLinks: enrichRelatedLinks(snapshotWithResolvedRefs?.relatedLinks || [], [
          ...extractKnownRefs(rootDetail, rootRef?.detailId || ""),
          ...discoverProcessRefs(rootDetail, rootRef?.detailId || "")
        ])
      }
    : {
        ...snapshotWithResolvedRefs,
        flowType
      };
  const pageInvoiceContext = derivePageInvoiceContext(enrichedSnapshot, rootDetail, structuredInvoiceSources);
  const structuredInvoiceMatches = analyzeStructuredInvoiceSources(structuredInvoiceSources, target);
  const structuredInvoiceAttachmentsForOcr = selectStructuredInvoiceAttachmentsForOcr(
    structuredInvoiceSources,
    target,
    pageInvoiceContext,
    structuredInvoiceMatches
  );
  const normalizedAttachments = normalizeAttachmentCandidates([
    ...structuredInvoiceAttachmentsForOcr,
    ...(enrichedSnapshot?.attachments || [])
  ]);

  reportProgress(
    onProgress,
    "page-invoice",
    "正在读取付款页发票",
    structuredInvoiceSources.length > 0 ? `已发现 ${structuredInvoiceSources.length} 条付款页发票明细` : "当前付款页未发现结构化发票明细"
  );

  reportProgress(
    onProgress,
    "page-attachments",
    "验收入口来自详情页",
    `已发现 ${normalizedAttachments.length} 个付款页附件`
  );

  const inventories = buildSourceInventories({
    ...enrichedSnapshot,
    attachments: normalizedAttachments,
    structuredInvoices: structuredInvoiceSources
  });
  const invoiceStatusSignal =
    flowType === "pr_payment"
      ? findSnapshotSignal(enrichedSnapshot, [/暂未取得发票|未取得发票|发票后补|发票在附件|发票附件/i], "")
      : "";
  const contractStatusSignal =
    flowType === "pr_payment"
      ? findSnapshotSignal(enrichedSnapshot, [/充值无合同|无合同|暂未签订合同|无需合同|框架协议/i], "")
      : "";
  const { missingDomesticPrDoc, missingPurchaseOrderDoc, missingAcceptanceDoc } = buildPrPaymentMissingDocs(
    flowType,
    invoiceStatusSignal
  );

  const pageAttachmentAnalysisTask = timings.time(
    "page-attachment-analysis",
    () => analyzeAttachmentList(
      [
        ...inventories.invoiceAttachments,
        ...inventories.bankChangeAttachments,
        ...inventories.contractAttachments,
        ...inventories.acceptanceAttachments,
        ...inventories.otherAttachments
      ],
      target,
      "付款页附件",
      onProgress,
      "page-attachments",
      { knownMatches: structuredInvoiceMatches, runtime: analysisRuntime }
    ),
    { attachmentCount: normalizedAttachments.length }
  );

  reportProgress(
    onProgress,
    "contract-link",
    "正在进入合同",
    inventories.contractLinks.length > 0 ? `已发现 ${inventories.contractLinks.length} 个合同入口` : "暂未发现明确的合同入口"
  );
  const contractResultTask = timings.time(
    "contract-analysis",
    () => runRelatedProcessWork(
      analysisRuntime,
      "contract-analysis",
      () => analyzeContractLinks(enrichedSnapshot?.relatedLinks || [], target, baseUrl, onProgress, analysisRuntime)
    ),
    { linkCount: inventories.contractLinks.length, concurrencyLimit: 2 }
  );

  reportProgress(
    onProgress,
    "domestic-pr-link",
    "正在读取国内PR",
    inventories.domesticPrLinks.length > 0 ? `已发现 ${inventories.domesticPrLinks.length} 个国内PR入口` : "暂未发现明确的国内PR入口"
  );
  const domesticPrDocsTask = timings.time(
    "domestic-pr-docs-analysis",
    () => runRelatedProcessWork(
      analysisRuntime,
      "domestic-pr-docs-analysis",
      () => analyzeDomesticPrLinksMulti(
        enrichedSnapshot?.relatedLinks || [],
        target,
        baseUrl,
        onProgress,
        {
          snapshot: enrichedSnapshot,
          missingDocument: missingDomesticPrDoc
        }
      )
    ),
    { linkCount: inventories.domesticPrLinks.length, concurrencyLimit: 2 }
  );

  reportProgress(
    onProgress,
    "acceptance-link",
    "正在核对附件",
    inventories.acceptanceLinks.length > 0 ? `已发现 ${inventories.acceptanceLinks.length} 个验收入口` : "尚未发现明确验收入口"
  );
  const acceptanceDocsTask = timings.time(
    "acceptance-docs-analysis",
    () => runRelatedProcessWork(
      analysisRuntime,
      "acceptance-docs-analysis",
      () => analyzeAcceptanceMailLinksMulti(
        enrichedSnapshot?.relatedLinks || [],
        target,
        baseUrl,
        onProgress,
        { missingDocument: missingAcceptanceDoc }
      )
    ),
    { linkCount: inventories.acceptanceLinks.length, concurrencyLimit: 2 }
  );

  reportProgress(
    onProgress,
    "purchase-order-link",
    "正在读取采购订单",
    inventories.purchaseOrderLinks.length > 0 ? `已发现 ${inventories.purchaseOrderLinks.length} 个采购订单入口` : "暂未发现明确的采购订单入口"
  );
  const purchaseOrderResultTask = timings.time(
    "purchase-order-analysis",
    () => runRelatedProcessWork(
      analysisRuntime,
      "purchase-order-analysis",
      () => analyzePurchaseOrderLinks(
        enrichedSnapshot?.relatedLinks || [],
        target,
        baseUrl,
        onProgress,
        { missingDocument: missingPurchaseOrderDoc }
      )
    ),
    { linkCount: inventories.purchaseOrderLinks.length, concurrencyLimit: 2 }
  );
  const [pageAttachmentAnalysis, contractResult, domesticPrDocs, acceptanceDocs, purchaseOrderResult] = await Promise.all([
    pageAttachmentAnalysisTask,
    contractResultTask,
    domesticPrDocsTask,
    acceptanceDocsTask,
    purchaseOrderResultTask
  ]);

  const hasMultiStructuredInvoices = structuredInvoiceSources.length > 1;
  const matches = {
    amount: structuredInvoiceMatches.amount || (hasMultiStructuredInvoices ? null : pageAttachmentAnalysis.matches.amount || contractResult.matches.amount || null),
    company: structuredInvoiceMatches.company || pageAttachmentAnalysis.matches.company || contractResult.matches.company || null,
    account: structuredInvoiceMatches.account || pageAttachmentAnalysis.matches.account || contractResult.matches.account || null
  };
  const invoiceTypeCheck = buildInvoiceTypeCheck(
    matches.amount,
    pageInvoiceContext,
    [structuredInvoiceMatches.amount, pageAttachmentAnalysis.matches.amount, contractResult.matches.amount],
    pageAttachmentAnalysis.referenceEntries || []
  );

  reportProgress(onProgress, "summary", "正在汇总核对结果", "验收入口、核对结果和合同参考信息");
  timings.mark("summary-start");

  const verificationItems = [
    buildAmountVerification(target, inventories, matches.amount, invoiceTypeCheck),
    buildCompanyVerification(target, inventories, matches.company),
    buildAccountVerification(target, inventories, matches.account)
  ];

  const attachmentOnlyContract = buildAttachmentOnlyContractResult(pageAttachmentAnalysis, inventories, target);
  const preferAttachmentOnlyContract = shouldPreferAttachmentOnlyContract(contractResult, attachmentOnlyContract);
  const missingContractProcessing =
    flowType === "pr_payment" && !contractResult?.ref && !hasUsableAttachmentOnlyContract(attachmentOnlyContract)
      ? emptyContractProcessing(
          "not_provided",
          contractStatusSignal || "当前付款单未提供合同入口，合同可能仅存在于附件或当前业务无需合同"
        )
      : null;
  const effectiveContractFacts = preferAttachmentOnlyContract
    ? attachmentOnlyContract?.facts || {}
    : contractResult.ref
      ? contractResult.facts
      : attachmentOnlyContract?.facts || {};
  const effectiveContractSummary = preferAttachmentOnlyContract
    ? attachmentOnlyContract?.summary || emptyContractSummary()
    : contractResult.ref
      ? contractResult.summary
      : attachmentOnlyContract?.summary || emptyContractSummary();
  const effectiveContractProcessing = missingContractProcessing ||
    (preferAttachmentOnlyContract
      ? attachmentOnlyContract?.processing || emptyContractProcessing("not_found", "尚未发现明确的合同来源")
      : contractResult.ref
        ? contractResult.processing
        : attachmentOnlyContract?.processing || emptyContractProcessing("not_found", "尚未发现明确的合同来源"));
  const effectiveContractResult = missingContractProcessing
    ? {
        ...contractResult,
        ref: null,
        facts: effectiveContractFacts,
        summary: effectiveContractSummary,
        processing: effectiveContractProcessing
      }
    : preferAttachmentOnlyContract
      ? {
          ...contractResult,
          ref: null,
          facts: effectiveContractFacts,
          summary: effectiveContractSummary,
          processing: effectiveContractProcessing
        }
      : contractResult.ref
        ? contractResult
        : {
            ...contractResult,
            facts: effectiveContractFacts,
            summary: effectiveContractSummary,
            processing: effectiveContractProcessing
          };

  const relatedDocuments = {
    domesticPr: domesticPrDocs[0] || null,
    domesticPrItems: domesticPrDocs,
    purchaseOrder: purchaseOrderResult,
    acceptance: acceptanceDocs[0] || null,
    acceptanceItems: acceptanceDocs,
    contract: buildContractRelatedDocument(effectiveContractResult, effectiveContractProcessing)
  };

  const overallStatus = verificationItems.some((item) => item.status === "fail")
    ? "fail"
    : verificationItems.some((item) => item.status === "warn")
      ? "warn"
      : "pass";

  reportProgress(onProgress, "done", "分析完成", "已生成主核对、关联摘要和合同参考信息");
  timings.mark("analysis-done", { overallStatus });

  return {
    buildTag: BUILD_TAG,
    analyzedAt: new Date().toISOString(),
    phase: "phase-5-related-docs",
    overallStatus,
    paymentTarget: target,
    pageSummary: {
      attachmentCount: normalizedAttachments.length,
      invoiceAttachmentCount: inventories.invoiceAttachments.length,
      invoiceStructuredCount: inventories.invoiceStructuredSources.length,
      contractAttachmentCount: inventories.contractAttachments.length,
      bankChangeAttachmentCount: inventories.bankChangeAttachments.length,
      acceptanceAttachmentCount: inventories.acceptanceAttachments.length,
      inlineDomesticPrCount: getInlineDomesticPrItems(enrichedSnapshot).length,
      domesticPrLinkCount: inventories.domesticPrLinks.length,
      purchaseOrderLinkCount: inventories.purchaseOrderLinks.length,
      contractLinkCount: inventories.contractLinks.length,
      acceptanceLinkCount: inventories.acceptanceLinks.length,
      otherLinkCount: inventories.relatedLinks.length
    },
    invoiceTypeCheck,
    verificationItems,
    relatedDocuments,
    contractReference: {
      effectiveStart: effectiveContractFacts.effectiveStart || pageAttachmentAnalysis.contractFacts.effectiveStart || "",
      effectiveEnd: effectiveContractFacts.effectiveEnd || pageAttachmentAnalysis.contractFacts.effectiveEnd || "",
      paymentTerms:
        effectiveContractSummary?.paymentTermsSummary ||
        effectiveContractFacts.paymentTerms ||
        pageAttachmentAnalysis.contractFacts.paymentTerms ||
        (contractResult.ref ? `宸插彂鐜板悎鍚屾潵婧愶細${contractResult.ref.detailUrl}` : "尚未发现明确的合同来源"),
      sourceName:
        effectiveContractFacts.sourceName ||
        pageAttachmentAnalysis.contractFacts.sourceName ||
        (contractResult.ref ? contractResult.ref.detailUrl : ""),
      sourceUrl:
        effectiveContractFacts.sourceUrl ||
        pageAttachmentAnalysis.contractFacts.sourceUrl ||
        (contractResult.ref ? contractResult.ref.detailUrl : "")
    },
    contractSummary: effectiveContractSummary || emptyContractSummary(),
    contractProcessing: effectiveContractProcessing || emptyContractProcessing("not_found", "尚未发现明确的合同来源"),
    acceptanceReference: acceptanceDocs[0] || null,
    evidencePool: inventories,
    debug: {
      snapshot: enrichedSnapshot,
      pageInvoiceContext,
      rootFacts,
      pageAttachmentAnalysis,
      domesticPrResult: domesticPrDocs,
      purchaseOrderResult,
      contractResult,
      attachmentOnlyContract,
      acceptanceResult: acceptanceDocs,
      timings: timings.snapshot()
    }
  };
  } finally {
    await timings.time("ocr-bridge-release", () => releaseOcrBridge(tabId).catch(() => false), {
      tabId: Number.isInteger(tabId) ? tabId : null
    });
  }
}

function mergePaymentTarget(primary, fallback, snapshot = null) {
  const snapshotFallback = buildPaymentTargetSnapshotFallback(snapshot);
  const flowType = firstNonEmpty(primary.flowType, primary.paymentFlowType);
  return {
    ...primary,
    flowType,
    paymentFlowType: flowType,
    processCode: firstNonEmpty(primary.processCode, fallback.processCode),
    processTitle: firstNonEmpty(primary.processTitle, fallback.processTitle),
    paymentAmount: firstNonEmpty(primary.paymentAmount, snapshotFallback.paymentAmount, fallback.paymentAmount, fallback.invoiceTotal),
    payeeCompany: firstNonEmpty(primary.payeeCompany, snapshotFallback.payeeCompany, fallback.supplier, fallback.invoiceSupplier),
    payeeAccount: firstLikelyBankAccount(
      primary.payeeAccount,
      snapshotFallback.payeeAccount,
      fallback.accountNo,
      fallback.invoiceAccountNo
    ),
    payeeBank: firstNonEmpty(primary.payeeBank, snapshotFallback.payeeBank, fallback.bankName),
    paymentDate: firstNonEmptyDate(primary.paymentDate, fallback.paymentDate)
  };
}

function buildPaymentTargetSnapshotFallback(snapshot) {
  const entries = collectSnapshotFieldEntries(snapshot);
  return {
    paymentAmount: findFieldValueFromPairs(
      entries,
      "打款金额确认",
      "人民币打款金额ABS",
      "人民币打款金额CBS",
      "人民币打款金额",
      "付款小写金额",
      "人民币金额",
      "本次付款金额",
      "实际付款金额",
      "付款金额"
    ),
    payeeCompany: findFieldValueFromPairs(
      entries,
      "收款公司",
      "收款单位",
      "供应商名称",
      "供应商",
      "合同相对方",
      "对方公司"
    ),
    payeeAccount: firstLikelyBankAccount(
      ...findFieldValuesFromPairs(
        entries,
        ...PAYEE_ACCOUNT_FIELD_LABELS
      )
    ),
    payeeBank: findFieldValueFromPairs(entries, "银行开户行", "开户行", "开户银行", "收款银行", "银行名称")
  };
}

function buildSourceInventories(snapshot) {
  const attachments = normalizeAttachmentCandidates(Array.isArray(snapshot?.attachments) ? snapshot.attachments : []);
  const relatedLinks = Array.isArray(snapshot?.relatedLinks) ? snapshot.relatedLinks : [];
  const structuredInvoices = Array.isArray(snapshot?.structuredInvoices) ? snapshot.structuredInvoices : [];
  const inventories = {
    invoiceAttachments: [],
    invoiceStructuredSources: structuredInvoices,
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
    if (role === "invoice") inventories.invoiceAttachments.push(attachment);
    else if (role === "contract") inventories.contractAttachments.push(attachment);
    else if (role === "bank_notice") inventories.bankChangeAttachments.push(attachment);
    else if (role === "acceptance") inventories.acceptanceAttachments.push(attachment);
    else inventories.otherAttachments.push(attachment);
  }

  for (const link of relatedLinks) {
    if (link.relation === "domestic_pr") inventories.domesticPrLinks.push(link);
    else if (link.relation === "purchase_order") inventories.purchaseOrderLinks.push(link);
    else if (link.relation === "contract") inventories.contractLinks.push(link);
    else if (link.relation === "acceptance") inventories.acceptanceLinks.push(link);
    else inventories.relatedLinks.push(link);
  }

  return inventories;
}

export function selectStructuredInvoiceAttachmentsForOcr(items, target, pageInvoiceContext = {}, structuredMatches = {}) {
  const sources = Array.isArray(items) ? items : [];
  const attachedSources = sources.filter((item) => item?.attachment);
  if (attachedSources.length === 0) {
    return [];
  }
  const matchedAmountEvidence = structuredMatches?.amount;
  const matchedSourceUrls = new Set(collectMatchedSourceUrls(matchedAmountEvidence));
  const matchedInvoiceNumbers = new Set(collectMatchedInvoiceNumbers(matchedAmountEvidence));

  // 发票类型放绿必须依赖附件 OCR，不能因为页面字段或结构化文本已经像专票就跳过 OCR。
  const matchedAttachments = attachedSources
    .filter((item) => {
      const attachmentUrl = cleanText(item?.attachment?.url || "");
      const sourceUrl = cleanText(item?.sourceUrl || "");
      if (matchedSourceUrls.size > 0 && (matchedSourceUrls.has(sourceUrl) || matchedSourceUrls.has(attachmentUrl))) {
        return true;
      }
      if (matchedInvoiceNumbers.size === 0) {
        return false;
      }
      return extractLongNumericTokens(
        item?.invoiceNo,
        item?.sourceName,
        item?.sourceText,
        item?.attachment?.name
      ).some((token) => matchedInvoiceNumbers.has(token));
    })
    .map((item) => item.attachment)
    .filter(Boolean);

  return (matchedAttachments.length > 0 ? matchedAttachments : attachedSources
    .map((item) => item.attachment)
    .filter(Boolean));
}

function normalizeAttachmentCandidates(items) {
  const realByUrl = new Map();
  const realNames = new Set();
  const placeholders = [];

  for (const item of items || []) {
    const name = cleanText(item?.name || "");
    const url = cleanText(item?.url || "");
    if (!name && !url) continue;
    if (isSyntheticAttachmentLink(url)) continue;

    const normalized = { ...item, name, url };
    if (looksLikeRealAttachment(name, url)) {
      const current = realByUrl.get(url);
      if (!current) {
        realByUrl.set(url, normalized);
      } else if (attachmentNameQuality(name) > attachmentNameQuality(current.name || "")) {
        const altNames = [...(current.altNames || []), current.name].filter(Boolean);
        realByUrl.set(url, { ...normalized, altNames });
      } else if (name && name.toLowerCase() !== String(current.name || "").toLowerCase()) {
        current.altNames = [...(current.altNames || []), name];
      }
      if (name) {
        realNames.add(name.toLowerCase());
      }
      continue;
    }

    if (name) {
      placeholders.push(normalized);
    }
  }

  const results = Array.from(realByUrl.values());
  const placeholderSeen = new Set();
  for (const item of placeholders) {
    const key = item.name.toLowerCase();
    const urlHint = cleanText(item.url || "");
    const dedupeKey = urlHint ? `${key}|${urlHint}` : key;
    if (realNames.has(key) || placeholderSeen.has(dedupeKey)) {
      continue;
    }
    placeholderSeen.add(dedupeKey);
    results.push(item);
  }
  return results;
}

function mergeAttachmentCandidates(primary, secondary) {
  return normalizeAttachmentCandidates([...(primary || []), ...(secondary || [])]);
}

function findFieldValueFromPairs(pairs, ...labels) {
  for (const label of labels) {
    const found = (pairs || []).find((item) => String(item?.label || "").includes(label));
    if (found?.value) {
      return found.value;
    }
  }
  return "";
}

function findFieldValuesFromPairs(pairs, ...labels) {
  const results = [];
  const seen = new Set();

  for (const label of labels) {
    for (const item of pairs || []) {
      if (!String(item?.label || "").includes(label)) {
        continue;
      }
      const value = cleanText(item?.value || "");
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      results.push(value);
    }
  }

  return results;
}

function collectBodyFieldCandidates(bodyText, patterns) {
  const source = cleanText(bodyText || "");
  const results = [];
  const seen = new Set();
  if (!source) {
    return results;
  }

  for (const pattern of patterns || []) {
    if (!(pattern instanceof RegExp)) {
      continue;
    }
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of source.matchAll(matcher)) {
      const value = cleanText(match?.[1] || match?.[0] || "");
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      results.push(value);
    }
  }

  return results;
}

function pickSingleFieldValue(values, predicate) {
  for (const value of values || []) {
    const text = cleanText(value || "");
    if (!text) {
      continue;
    }
    if (typeof predicate === "function" && !predicate(text)) {
      continue;
    }
    return text;
  }
  return "";
}

function buildPageInvoiceContext(snapshot) {
  const fieldPairs = snapshot?.fieldPairs || [];
  const invoiceTypeValues = findFieldValuesFromPairs(fieldPairs, "发票类型");
  const bodyPageInvoiceValues = collectBodyFieldCandidates(snapshot?.bodyText || "", [
    /(?:发票类型|票据类型)[：:\s]{0,8}(增值税发票|其他票据|暂未取得发票)/i
  ]);
  const bodyInvoiceSubtypeValues = collectBodyFieldCandidates(snapshot?.bodyText || "", [
    /(?:发票类型|票面类型)[：:\s]{0,8}(增值税专用发票|增值税普通发票|专票|普票)/i
  ]);

  const pageInvoice = pickFirstNormalizedValue(
    [...invoiceTypeValues, ...bodyPageInvoiceValues],
    normalizePageInvoiceLabel
  );
  const invoiceSubtype = pickFirstNormalizedValue(
    [...invoiceTypeValues, ...bodyInvoiceSubtypeValues],
    normalizeInvoiceSubtypeLabel
  );
  const linkedInvoiceCorrectness = pickSingleFieldValue(
    findFieldValuesFromPairs(fieldPairs, "关联发票是否正确"),
    (value) => /^(正确|不正确)$/.test(value)
  );
  const deductibleTaxAmount = pickSingleFieldValue(
    findFieldValuesFromPairs(fieldPairs, "有效抵扣税额"),
    (value) => /-?\d+(?:\.\d+)?/.test(value)
  );

  return {
    pageInvoiceLabel: pageInvoice.label || "",
    pageInvoiceRaw: pageInvoice.raw || "",
    invoiceSubtypeLabel: invoiceSubtype.label || "",
    invoiceSubtypeRaw: invoiceSubtype.raw || "",
    linkedInvoiceCorrectness,
    deductibleTaxAmount
  };
}

function extractLongNumericTokens(...values) {
  const tokens = [];
  const seen = new Set();
  for (const value of values) {
    const source = cleanText(value || "");
    if (!source) {
      continue;
    }
    for (const match of source.matchAll(/\b\d{8,20}\b/g)) {
      const token = cleanText(match?.[0] || "");
      if (!token || seen.has(token)) {
        continue;
      }
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function collectMatchedInvoiceNumbers(matched, candidates = []) {
  const numbers = new Set();
  const push = (...values) => {
    for (const token of extractLongNumericTokens(...values)) {
      numbers.add(token);
    }
  };

  if (matched?.multiInvoiceAggregate && Array.isArray(matched?.invoiceAmountItems)) {
    for (const item of matched.invoiceAmountItems) {
      push(item?.invoiceNo, item?.invoiceTypeRaw);
    }
  }

  push(matched?.sourceName, matched?.snippet, matched?.invoiceTypeRaw);

  for (const item of Array.isArray(candidates) ? candidates : []) {
    push(item?.invoiceNo, item?.sourceName, item?.snippet, item?.invoiceTypeRaw);
  }

  return [...numbers];
}

function collectMatchedSourceUrls(matched, candidates = []) {
  const urls = [];
  const seen = new Set();
  for (const value of [
    matched?.sourceUrl,
    ...(Array.isArray(candidates) ? candidates.map((item) => item?.sourceUrl) : [])
  ]) {
    const text = cleanText(value || "");
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    urls.push(text);
  }
  return urls;
}

function dedupeOcrInvoiceTypeEvidence(items) {
  const seen = new Set();
  const results = [];
  for (const item of items || []) {
    const key = `${cleanText(item?.sourceUrl || "")}|${cleanText(item?.sourceName || "")}|${cleanText(item?.raw || "")}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }
  return results;
}

function pickSingleOcrInvoiceTypeEvidence(entries = []) {
  const bucket = dedupeOcrInvoiceTypeEvidence(entries);
  if (bucket.length === 0) {
    return null;
  }
  return bucket.find((item) => item.label === "增值税专用发票") || bucket[0] || null;
}

function buildOcrInvoiceTypeEvidence(matched, candidates = [], referenceEntries = []) {
  const targetSourceUrls = collectMatchedSourceUrls(matched, candidates);
  const targetInvoiceNumbers = collectMatchedInvoiceNumbers(matched, candidates);
  const entries = (Array.isArray(referenceEntries) ? referenceEntries : [])
    .filter((item) => cleanText(item?.role || "") === "invoice")
    .map((item) => {
      const text = cleanText(item?.text || "");
      const label = normalizeInvoiceSubtypeLabel(text);
      return {
        label,
        raw: label,
        sourceName: cleanText(item?.sourceName || item?.attachmentName || ""),
        sourceUrl: cleanText(item?.sourceUrl || ""),
        invoiceNumbers: extractLongNumericTokens(item?.attachmentName, item?.sourceName, item?.text)
      };
    })
    .filter((item) => item.label);

  if (entries.length === 0) {
    return null;
  }

  const sourceMatchedEntries = targetSourceUrls.length > 0
    ? entries.filter((item) => item.sourceUrl && targetSourceUrls.includes(item.sourceUrl))
    : [];
  const invoiceMatchedEntries = targetInvoiceNumbers.length > 0
    ? entries.filter((item) => item.invoiceNumbers.some((token) => targetInvoiceNumbers.includes(token)))
    : [];

  if (matched?.multiInvoiceAggregate) {
    const relevantEntries = dedupeOcrInvoiceTypeEvidence(
      sourceMatchedEntries.length > 0 || invoiceMatchedEntries.length > 0
        ? [...sourceMatchedEntries, ...invoiceMatchedEntries]
        : entries
    );
    if (relevantEntries.length === 0) {
      return null;
    }
    if (
      targetInvoiceNumbers.length > 0 &&
      targetInvoiceNumbers.every((token) =>
        relevantEntries.some((item) => item.label === "增值税专用发票" && item.invoiceNumbers.includes(token))
      )
    ) {
      return {
        label: "增值税专用发票",
        raw: "OCR多张发票均识别为增值税专用发票",
        sourceName: "OCR发票附件",
        sourceUrl: "",
        invoiceNumbers: targetInvoiceNumbers
      };
    }
    return pickSingleOcrInvoiceTypeEvidence(relevantEntries);
  }

  return (
    pickSingleOcrInvoiceTypeEvidence(sourceMatchedEntries) ||
    pickSingleOcrInvoiceTypeEvidence(invoiceMatchedEntries) ||
    pickSingleOcrInvoiceTypeEvidence(entries)
  );
}

export function buildInvoiceTypeCheck(matched, pageInvoiceContext = {}, candidates = [], referenceEntries = []) {
  const isMultiInvoiceAggregate = !!matched?.multiInvoiceAggregate;
  const ocrInvoiceEvidence = buildOcrInvoiceTypeEvidence(matched, candidates, referenceEntries);
  const ocrInvoiceTypeLabel = firstNonEmpty(ocrInvoiceEvidence?.label);
  const inferredInvoiceTypeLabel = ocrInvoiceTypeLabel || isMultiInvoiceAggregate
    ? ""
    : inferInvoiceSubtypeFromPageContext(pageInvoiceContext);
  const invoiceTypeLabel = ocrInvoiceTypeLabel;
  const pageInvoiceLabel = firstNonEmpty(pageInvoiceContext?.pageInvoiceLabel);
  const status = matched && isInvoiceTypePass(invoiceTypeLabel, pageInvoiceLabel) ? "pass" : "warn";
  const detailParts = [
    `票面类型：${invoiceTypeLabel || "未识别"}`,
    `页面显示：${pageInvoiceLabel || "未识别"}`
  ];

  if (pageInvoiceContext?.linkedInvoiceCorrectness) {
    detailParts.push(`关联发票：${pageInvoiceContext.linkedInvoiceCorrectness}`);
  }
  if (pageInvoiceContext?.deductibleTaxAmount) {
    detailParts.push(`有效抵扣税额：${pageInvoiceContext.deductibleTaxAmount}`);
  }
  if (ocrInvoiceEvidence?.sourceName) {
    detailParts.push(`票面OCR来源：${ocrInvoiceEvidence.sourceName}`);
  }
  if (inferredInvoiceTypeLabel) {
    detailParts.push(`页面字段推断：${inferredInvoiceTypeLabel}（仅作提示，不作为通过依据）`);
  }
  if (isMultiInvoiceAggregate) {
    detailParts.push(`发票张数：${matched?.invoiceCount || 0}`);
    if (!invoiceTypeLabel) {
      detailParts.push("票种要求：每张参与核对的发票都需有OCR识别为增值税专用发票");
    }
  }
  if (matched?.snippet) {
    detailParts.push(`命中来源：${matched.snippet}`);
  }

  return {
    invoiceTypeLabel: invoiceTypeLabel || "未识别",
    invoiceTypeRaw: firstNonEmpty(ocrInvoiceEvidence?.raw),
    pageInvoiceLabel: pageInvoiceLabel || "未识别",
    pageInvoiceRaw: pageInvoiceContext?.pageInvoiceRaw || "",
    linkedInvoiceCorrectness: pageInvoiceContext?.linkedInvoiceCorrectness || "",
    deductibleTaxAmount: pageInvoiceContext?.deductibleTaxAmount || "",
    inferredInvoiceTypeLabel,
    status,
    sourceName: firstNonEmpty(ocrInvoiceEvidence?.sourceName, matched?.sourceName),
    sourceUrl: firstNonEmpty(ocrInvoiceEvidence?.sourceUrl, matched?.sourceUrl),
    snippet: detailParts.join("；")
  };
}

function buildRelatedLinkKey(link) {
  const relation = cleanText(link?.relation || "related");
  const ref = parseProcessRef(link?.url || "", relation);
  if (ref?.detailId) {
    return `${relation}|${ref.mode}|${ref.detailId}`;
  }
  return `${relation}|${cleanText(link?.url || "")}`;
}

function enrichRelatedLinks(existingLinks, refs) {
  const deduped = [];
  const seen = new Map();

  for (const item of existingLinks || []) {
    const key = buildRelatedLinkKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push(item);
  }

  for (const ref of refs || []) {
    const link = {
      relation: ref.relation,
      title: firstNonEmpty(ref.titleHint, ref.detailUrl),
      url: ref.detailUrl,
      hintTexts: Array.isArray(ref.rowHints) ? ref.rowHints.map((item) => cleanText(item?.value || "")).filter(Boolean) : []
    };
    const key = buildRelatedLinkKey(link);
    if (seen.has(key)) {
      const existingIndex = seen.get(key);
      const existing = deduped[existingIndex] || {};
      deduped[existingIndex] = {
        ...existing,
        title: isLikelyRawUrl(existing.title) ? link.title : firstNonEmpty(existing.title, link.title),
        hintTexts: [...new Set([...(existing.hintTexts || []), ...(link.hintTexts || [])].filter(Boolean))].slice(0, 8)
      };
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push(link);
  }

  return deduped;
}

function createRelatedDocumentBase(input) {
  return {
    kind: input.kind || "related",
    title: input.title || "",
    itemLabel: input.itemLabel || "",
    status: input.status || "warn",
    statusText: input.statusText || "",
    displayOnly: !!input.displayOnly,
    sourceMode: input.sourceMode || "",
    sourceName: input.sourceName || "",
    sourceUrl: input.sourceUrl || "",
    statement: input.statement || "",
    fields: input.fields || {},
    checks: Array.isArray(input.checks) ? input.checks : [],
    relationHints: Array.isArray(input.relationHints) ? input.relationHints : [],
    attachmentNames: Array.isArray(input.attachmentNames) ? input.attachmentNames : [],
    mailAttachmentNames: Array.isArray(input.mailAttachmentNames) ? input.mailAttachmentNames : [],
    previewItems: Array.isArray(input.previewItems) ? input.previewItems : [],
    hoverText: input.hoverText || "",
    notes: Array.isArray(input.notes) ? input.notes : [],
    errorText: input.errorText || ""
  };
}

function buildContractRelatedDocument(contractResult, processing) {
  const facts = contractResult?.facts || {};
  const summary = contractResult?.summary || {};
  const attachmentNames = Array.isArray(processing?.attachmentNames) ? processing.attachmentNames : [];
  const pageStatus = cleanText(processing?.pageStatus || "");
  const hasSource = !!(
    contractResult?.ref ||
    facts.sourceName ||
    facts.sourceUrl ||
    attachmentNames.length > 0 ||
    (processing?.pageStatus && processing.pageStatus !== "not_found")
  );
  const sourceName = firstNonEmpty(
    facts.sourceName,
    contractResult?.ref?.detailUrl,
    attachmentNames[0],
    processing?.pageStatusText
  );
  const sourceUrl = firstNonEmpty(facts.sourceUrl, contractResult?.ref?.detailUrl);
  const statusText = hasSource
    ? pageStatus === "not_provided"
      ? "未提供来源"
      : "仅展示"
    : "未找到";
  const statement = pageStatus === "not_provided"
    ? firstNonEmpty(processing?.pageStatusText, "当前付款单未提供合同来源")
    : hasSource
      ? "沿用现有合同逻辑，仅展示不自动判断"
      : "尚未发现明确的合同来源";
  return createRelatedDocumentBase({
    kind: "contract",
    title: "合同",
    status: hasSource ? "info" : "warn",
    statusText,
    displayOnly: true,
    sourceMode: contractResult?.ref ? "linked_detail" : "page_inline",
    sourceName,
    sourceUrl,
    statement,
    fields: {
      pageStatusText: processing?.pageStatusText || "",
      effectiveStart: facts.effectiveStart || "",
      effectiveEnd: facts.effectiveEnd || "",
      paymentTerms: summary.paymentTermsSummary || facts.paymentTerms || "",
      taxRate: summary.taxRate || "",
      capAmount: summary.capAmount || "",
      accountChangeRequirement: summary.accountChangeRequirement || ""
    },
    attachmentNames,
    notes: ["仅展示，不自动判断"]
  });
}

function pickRelatedLink(relatedLinks, relation) {
  return (relatedLinks || []).find((item) => item.relation === relation) || null;
}

function pickRelatedLinks(relatedLinks, relation) {
  return (relatedLinks || []).filter((item) => item.relation === relation);
}

async function loadRelatedProcessContext(ref, baseUrl, options = {}) {
  const { includePageSnapshot = false } = options || {};
  let detailResult = null;
  let pageResult = null;

  try {
    detailResult = ref.mode === "flowable" ? await fetchFlowableDetail(ref, baseUrl) : await fetchHistoryDetail(ref, baseUrl);
  } catch (error) {
    detailResult = { __error: normalizeError(error) };
  }

  if (includePageSnapshot) {
    try {
      pageResult = await collectPageSnapshotFromUrl(ref.detailUrl);
    } catch (error) {
      pageResult = { __error: normalizeError(error) };
    }
  }

  return {
    ref,
    baseUrl,
    detail: detailResult?.__error ? null : detailResult,
    detailError: detailResult?.__error || "",
    pageSnapshot: pageResult?.__error ? null : pageResult,
    pageError: pageResult?.__error || "",
    pageSnapshotLoaded: includePageSnapshot
  };
}

async function ensureRelatedProcessPageSnapshot(context) {
  if (!context || context.pageSnapshotLoaded) {
    return context;
  }

  context.pageSnapshotLoaded = true;
  try {
    context.pageSnapshot = await collectPageSnapshotFromUrl(context.ref?.detailUrl || "");
    context.pageError = "";
  } catch (error) {
    context.pageSnapshot = null;
    context.pageError = normalizeError(error);
  }

  return context;
}

function toScalarText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return cleanText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toScalarText(item)).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return firstNonEmpty(value.value, value.fieldValue, value.text, value.label, value.name);
  }
  return "";
}

function findValueInObjectByKeyHints(root, ...hints) {
  const normalizedHints = hints
    .map((hint) => normalizeCompareText(hint))
    .filter(Boolean);
  if (!root || normalizedHints.length === 0) {
    return "";
  }

  const queue = [{ node: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 500) {
    const { node, depth } = queue.shift();
    visited += 1;
    if (!node || typeof node !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = normalizeCompareText(key);
      if (normalizedKey && normalizedHints.some((hint) => normalizedKey.includes(hint))) {
        const text = toScalarText(value);
        if (text) {
          return text;
        }
      }

      if (depth < 3 && value && typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return "";
}

function extractProcessField(detail, pageSnapshot, labels, keyHints = labels) {
  return firstMeaningfulText(
    findFieldValueFromPairs(pageSnapshot?.fieldPairs, ...labels),
    findValueInObjectByKeyHints(detail?.flowFormData || detail?.formData || detail || {}, ...keyHints)
  );
}

function extractProcessFieldCandidates(detail, pageSnapshot, labels, keyHints = labels, limit = 8) {
  const results = [];
  const seen = new Set();
  const pushValue = (value) => {
    const text = cleanText(value || "");
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    results.push(text);
  };

  for (const item of findFieldValuesFromPairs(pageSnapshot?.fieldPairs, ...labels)) {
    pushValue(item);
    if (results.length >= limit) {
      return results;
    }
  }

  for (const item of collectValuesInObjectByKeyHints(detail?.flowFormData || detail?.formData || detail || {}, keyHints, limit)) {
    pushValue(item);
    if (results.length >= limit) {
      return results;
    }
  }

  return results;
}

async function extractProcessFieldWithFallback(context, labels, keyHints = labels) {
  const detailOnlyValue = extractProcessField(context?.detail, null, labels, keyHints);
  if (detailOnlyValue) {
    return detailOnlyValue;
  }

  await ensureRelatedProcessPageSnapshot(context);
  return extractProcessField(context?.detail, context?.pageSnapshot, labels, keyHints);
}

async function extractProcessFieldCandidatesWithFallback(context, labels, keyHints = labels, limit = 8) {
  const detailOnlyValues = extractProcessFieldCandidates(context?.detail, null, labels, keyHints, limit);
  if (detailOnlyValues.length > 0) {
    return detailOnlyValues;
  }

  await ensureRelatedProcessPageSnapshot(context);
  return extractProcessFieldCandidates(context?.detail, context?.pageSnapshot, labels, keyHints, limit);
}

function isPlaceholderProcessCodeText(value) {
  const text = cleanText(value || "");
  if (!text) {
    return true;
  }
  return /^(?:流程标题|PR选择|相关流程|请选择|选择|空|暂无|未选择|畅游OA管理系统)$/i.test(text);
}

function normalizeProcessCodeFromText(value, patterns = []) {
  const text = cleanText(value || "");
  if (!text || isPlaceholderProcessCodeText(text)) {
    return "";
  }
  for (const pattern of patterns) {
    if (!(pattern instanceof RegExp)) {
      continue;
    }
    const matched = text.match(pattern);
    if (matched?.[0]) {
      return cleanText(matched[0]).toUpperCase();
    }
  }
  return "";
}

async function extractRelatedProcessCodeWithFallback(context, labels, options = {}) {
  const { keyHints = labels, preferredPattern = null, fallbackPatterns = [], limit = 12 } = options;
  const patterns = [preferredPattern, ...fallbackPatterns, GENERIC_PROCESS_CODE_RE].filter(Boolean);
  const candidates = await extractProcessFieldCandidatesWithFallback(context, labels, keyHints, limit);
  for (const candidate of candidates) {
    const normalized = normalizeProcessCodeFromText(candidate, patterns);
    if (normalized) {
      return normalized;
    }
  }

  const rawValue = cleanText(await extractProcessFieldWithFallback(context, labels, keyHints));
  if (!rawValue || isPlaceholderProcessCodeText(rawValue)) {
    return "";
  }
  return normalizeProcessCodeFromText(rawValue, patterns);
}

function collectFieldValuesFromPairs(pairs, labels, limit = 8) {
  const results = [];
  const seen = new Set();
  for (const pair of pairs || []) {
    const label = cleanText(pair?.label || "");
    const value = cleanText(pair?.value || "");
    if (!label || !value) continue;
    if (!labels.some((item) => label.includes(item))) continue;
    const summary = `${label}：${value}`;
    if (seen.has(summary)) continue;
    seen.add(summary);
    results.push(summary);
    if (results.length >= limit) break;
  }
  return results;
}

function collectValuesInObjectByKeyHints(root, hints, limit = 8) {
  const normalizedHints = (hints || []).map((hint) => normalizeCompareText(hint)).filter(Boolean);
  if (!root || normalizedHints.length === 0) {
    return [];
  }

  const queue = [{ node: root, depth: 0 }];
  const results = [];
  const seen = new Set();
  let visited = 0;

  while (queue.length > 0 && visited < 800 && results.length < limit) {
    const { node, depth } = queue.shift();
    visited += 1;
    if (!node || typeof node !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = normalizeCompareText(key);
      if (normalizedKey && normalizedHints.some((hint) => normalizedKey.includes(hint))) {
        const text = toScalarText(value);
        if (text && !seen.has(text)) {
          seen.add(text);
          results.push(text);
          if (results.length >= limit) {
            break;
          }
        }
      }

      if (depth < 3 && value && typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return results;
}

function buildRequirementSummary(detail, pageSnapshot) {
  const pairs = pageSnapshot?.fieldPairs || [];
  const subformRows = Array.isArray(pageSnapshot?.subformRows) ? pageSnapshot.subformRows : [];
  const groups = [
    { labels: ["品牌"] },
    { labels: ["型号"] },
    { labels: ["规格"] },
    { labels: ["配置"] },
    { labels: ["技术要求", "技术参数"] },
    { labels: ["需求描述", "需求说明", "采购内容", "用途说明", "说明", "备注"] }
  ];

  const rowSummaries = [];
  const rowSeen = new Set();
  for (const row of subformRows) {
    const nameField = (row.fields || []).find((field) => cleanText(field.label || "").includes("名称"));
    const detailFields = [];
    const detailSeen = new Set();
    for (const field of row.fields || []) {
      const label = cleanText(field.label || "");
      const value = cleanText(field.value || "");
      if (!label || !value || label.includes("名称")) {
        continue;
      }
      const isRequirementLike = groups.some((group) => group.labels.some((item) => label.includes(item)));
      if (!isRequirementLike) {
        continue;
      }
      const key = `${label}|${value}`;
      if (detailSeen.has(key)) {
        continue;
      }
      detailSeen.add(key);
      detailFields.push(`${label}：${value}`);
    }
    const parts = [];
    if (nameField?.value) {
      parts.push(`名称：${cleanText(nameField.value)}`);
    }
    parts.push(...detailFields);
    const summary = parts.join("；");
    if (!summary || rowSeen.has(summary)) {
      continue;
    }
    rowSeen.add(summary);
    rowSummaries.push(summary);
  }

  if (rowSummaries.length > 0) {
    return rowSummaries.slice(0, 4).join("；");
  }

  const summaries = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of collectFieldValuesFromPairs(pairs, group.labels, 4)) {
      if (seen.has(item)) continue;
      seen.add(item);
      summaries.push(item);
    }
  }

  if (summaries.length === 0) {
    const detailRoot = detail?.flowFormData || detail?.formData || detail || {};
    for (const group of groups) {
      const values = collectValuesInObjectByKeyHints(detailRoot, group.labels, 2);
      for (const value of values) {
        const item = `${group.labels[0]}：${value}`;
        if (seen.has(item)) continue;
        seen.add(item);
        summaries.push(item);
      }
    }
  }

  return summaries.slice(0, 8).join("；");
}

async function buildRequirementSummaryWithFallback(context) {
  const detailOnlySummary = buildRequirementSummary(context?.detail, null);
  if (detailOnlySummary) {
    return detailOnlySummary;
  }

  await ensureRelatedProcessPageSnapshot(context);
  return buildRequirementSummary(context?.detail, context?.pageSnapshot);
}

function collectSnapshotFieldEntries(pageSnapshot) {
  const entries = [];

  for (const pair of pageSnapshot?.fieldPairs || []) {
    const label = cleanText(pair?.label || "");
    const value = cleanText(pair?.value || "");
    if (label && value) {
      entries.push({ label, value });
    }
  }

  for (const row of pageSnapshot?.subformRows || []) {
    for (const field of row?.fields || []) {
      const label = cleanText(field?.label || "");
      const value = cleanText(field?.value || "");
      if (label && value) {
        entries.push({ label, value });
      }
    }
  }

  return entries;
}

function buildGenericSubformSummary(pageSnapshot, rowLimit = 4, fieldLimit = 6) {
  const rows = Array.isArray(pageSnapshot?.subformRows) ? pageSnapshot.subformRows : [];
  const summaries = [];
  const seen = new Set();

  for (const row of rows) {
    const parts = [];
    for (const field of row?.fields || []) {
      const label = cleanText(field?.label || "");
      const value = cleanText(field?.value || "");
      if (!label || !value) continue;
      if (/^(?:id|index|row|序号)$/i.test(label)) continue;
      parts.push(`${label}:${value}`);
      if (parts.length >= fieldLimit) break;
    }
    const summary = cleanText(parts.join("；"));
    if (!summary || seen.has(summary)) continue;
    seen.add(summary);
    summaries.push(summary);
    if (summaries.length >= rowLimit) break;
  }

  return summaries.join("；");
}

function buildContractSnapshotFallback(pageSnapshot, sourceUrl, sourceLabelPrefix) {
  const pairs = Array.isArray(pageSnapshot?.fieldPairs) ? pageSnapshot.fieldPairs : [];
  const facts = {
    effectiveStart: firstNonEmptyDate(
      findFieldValueFromPairs(pairs, "合同开始日期", "合同开始日", "开始日", "生效日期", "生效日")
    ),
    effectiveEnd: firstNonEmptyDate(
      findFieldValueFromPairs(pairs, "合同结束日期", "合同结束日", "结束日期", "截止日期", "终止日期")
    ),
    paymentTerms: firstMeaningfulText(
      findFieldValueFromPairs(pairs, "付款条件", "付款方式", "结算方式", "付款条款", "付款周期", "付款时限"),
      findFieldValueFromPairs(pairs, "发票条件", "验收标准"),
      findFieldValueFromPairs(pairs, "费用归属说明"),
      findFieldValueFromPairs(pairs, "主要内容描述")
    ),
    sourceName: firstNonEmpty(findFieldValueFromPairs(pairs, "合同名称"), ""),
    sourceUrl
  };

  const labels = [
    "付款条件",
    "付款方式",
    "结算方式",
    "付款条款",
    "付款周期",
    "付款时限",
    "发票条件",
    "是否能提供增值税专用发票",
    "验收标准",
    "合同开始日期",
    "合同结束日期",
    "是否自动顺延",
    "是否需要续签",
    "费用归属说明",
    "主要内容描述",
    "财务评估概要",
    "法律评估概要"
  ];

  return {
    facts,
    referenceEntries: dedupeReferenceEntries([
      ...buildContractSnapshotEntriesFromPairs(pairs, labels, sourceUrl, sourceLabelPrefix),
      ...buildContractSnapshotEntriesFromBody(pageSnapshot?.bodyText || "", sourceUrl, sourceLabelPrefix)
    ])
  };
}

function buildContractSnapshotEntriesFromPairs(pairs, labels, sourceUrl, sourceLabelPrefix) {
  const entries = [];
  for (const pair of pairs || []) {
    const label = cleanText(pair?.label || "");
    const value = cleanText(pair?.value || "");
    if (!label || !value) continue;
    if (!labels.some((item) => label.includes(item))) continue;
    entries.push({
      sourceName: `${sourceLabelPrefix}字段：${label}`,
      sourceUrl,
      text: `${label}：${value}`
    });
  }
  return entries;
}

function buildContractSnapshotEntriesFromBody(bodyText, sourceUrl, sourceLabelPrefix) {
  const text = cleanText(bodyText || "");
  if (!text) {
    return [];
  }

  const entries = [];
  const seen = new Set();
  const keywords = ["付款", "支付", "结算", "发票", "验收", "工作日", "自动顺延", "续签", "合同开始日期", "合同结束日期"];

  for (const keyword of keywords) {
    if (!text.includes(keyword)) continue;
    const snippet = cleanText(snippetAround(text, keyword, 120));
    if (!snippet) continue;
    const key = snippet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      sourceName: `${sourceLabelPrefix}页面摘录`,
      sourceUrl,
      text: snippet
    });
  }

  return entries;
}

function dedupeReferenceEntries(entries) {
  const deduped = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const sourceName = cleanText(entry?.sourceName || "");
    const sourceUrl = cleanText(entry?.sourceUrl || "");
    const text = cleanText(entry?.text || "");
    if (!text) continue;
    const key = `${sourceName}|${sourceUrl}|${text}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ sourceName, sourceUrl, text });
  }
  return deduped;
}

function inferSupplierNameFromSnapshot(pageSnapshot, preferredCompany = "") {
  const entries = collectSnapshotFieldEntries(pageSnapshot);
  const normalizedPreferred = normalizeCompareText(preferredCompany);
  const companyRegex = /(有限公司|有限责任|公司|集团|科技|信息|传媒|网络|服务|商贸|供应商|vendor|supplier|co\\.|inc\\.|ltd\\.)/i;

  for (const entry of entries) {
    const normalizedValue = normalizeCompareText(entry.value);
    if (normalizedPreferred && normalizedValue && compareCompanyLoosely(entry.value, preferredCompany)) {
      return entry.value;
    }
  }

  for (const entry of entries) {
    if (companyRegex.test(entry.value)) {
      return entry.value;
    }
  }

  return "";
}

function inferAmountFromSnapshot(pageSnapshot, preferredAmount = "") {
  const entries = collectSnapshotFieldEntries(pageSnapshot);
  const preferred = parseAmount(preferredAmount);
  const numericEntries = entries
    .map((entry) => ({ ...entry, amount: parseAmount(entry.value) }))
    .filter((entry) => entry.amount > 0);

  if (numericEntries.length === 0) {
    return "";
  }

  if (preferred > 0) {
    const exact = numericEntries.find((entry) => Math.abs(entry.amount - preferred) <= 0.01);
    if (exact) return exact.value;

    const higher = numericEntries
      .filter((entry) => entry.amount >= preferred)
      .sort((left, right) => left.amount - right.amount)[0];
    if (higher) return higher.value;
  }

  const largest = numericEntries.sort((left, right) => right.amount - left.amount)[0];
  return largest?.value || "";
}

function buildAttachmentPreviewText(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) {
    return "";
  }
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}

function normalizeRelatedSourceName(pageSnapshot, fallbackTitle, ref, ...candidates) {
  return firstNonEmpty(
    ...candidates,
    pageSnapshot?.paymentTarget?.processTitle,
    pageSnapshot?.pageTitle,
    isLikelyRawUrl(fallbackTitle) ? "" : fallbackTitle,
    ref?.detailUrl
  );
}

function isLikelyRawUrl(value) {
  return /^https?:\/\//i.test(cleanText(value || ""));
}

function deriveAcceptanceMailSubjectHint(acceptanceLink) {
  const title = cleanText(acceptanceLink?.title || "");
  if (title && !isLikelyRawUrl(title)) {
    return title;
  }
  const hintTexts = Array.isArray(acceptanceLink?.hintTexts) ? acceptanceLink.hintTexts : [];
  const preferred = hintTexts.find((item) => /邮件|主题|标题|验收|结算|答复|审批/.test(item));
  return firstNonEmpty(preferred, ...hintTexts);
}

function buildRelatedReadStatement(label, context) {
  if (context.detail && context.pageSnapshot) {
    return `已读取${label}详情页，仅展示关键字段`;
  }
  if (context.detail) {
    return `已通过详情接口读取${label}，页面快照读取失败`;
  }
  if (context.pageSnapshot) {
    return `已通过页面快照读取${label}，详情接口读取失败`;
  }
  return `暂未读取到${label}详情`;
}

function normalizeDomesticPrYear(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }
  if (isLikelyDomesticPrPeriodNoiseText(text)) {
    return "";
  }
  const matched = text.match(/\b(20\d{2}|\d{2})\b/);
  if (!matched) {
    return "";
  }
  return matched[1].length === 2 ? `20${matched[1]}` : matched[1];
}

function mapDomesticPrQuarterToken(value) {
  switch (String(value || "").trim()) {
    case "1":
    case "一":
      return "1";
    case "2":
    case "二":
      return "2";
    case "3":
    case "三":
      return "3";
    case "4":
    case "四":
      return "4";
    default:
      return "";
  }
}

function buildPrPaymentMissingDocs(flowType, invoiceStatusSignal) {
  if (flowType !== "pr_payment") {
    return {
      missingDomesticPrDoc: null,
      missingPurchaseOrderDoc: null,
      missingAcceptanceDoc: null
    };
  }

  const relationHints = invoiceStatusSignal ? [`发票说明：${invoiceStatusSignal}`] : [];
  return {
    missingDomesticPrDoc: createMissingSourceDocument({
      kind: "domestic_pr",
      title: "国内PR",
      statement: "当前付款单未提供可直接打开的国内PR入口，且页内也未提取到PR子表",
      relationHints,
      notes: ["仅展示，不自动判断", "有PR付款优先读取真实PR详情，其次回退页内PR子表"]
    }),
    missingPurchaseOrderDoc: createMissingSourceDocument({
      kind: "purchase_order",
      title: "采购订单",
      statement: "当前付款单未提供采购订单入口，有PR付款通常以页内PR或附件作为主要来源",
      relationHints,
      notes: ["仅展示，不自动判断"]
    }),
    missingAcceptanceDoc: createMissingSourceDocument({
      kind: "acceptance",
      title: "验收单",
      statement: "当前付款单未提供验收入口，请结合付款页附件或关联流程人工判断",
      relationHints,
      notes: ["仅展示，不自动判断"]
    })
  };
}

function detectPaymentFlowType(snapshot, target) {
  const explicitType = cleanText(snapshot?.flowType || target?.flowType || target?.paymentFlowType || "");
  if (explicitType) {
    return explicitType;
  }

  const processCode = cleanText(
    snapshot?.paymentTarget?.processCode ||
    target?.processCode ||
    snapshot?.processCode ||
    ""
  ).toUpperCase();
  if (PR_PAYMENT_CODE_RE.test(processCode)) {
    return "pr_payment";
  }
  if (PURCHASE_PAYMENT_CODE_RE.test(processCode)) {
    return "purchase_payment";
  }
  return "payment";
}

function normalizeInlineDomesticPrItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const normalized = {
    processCode: cleanText(item.processCode || "").toUpperCase(),
    relatedTitle: cleanText(item.relatedTitle || item.relatedFlowTitle || item.requirementSummary || ""),
    prStatus: cleanText(item.prStatus || ""),
    prAmount: cleanText(item.prAmount || ""),
    prPendingAmount: cleanText(item.prPendingAmount || ""),
    prCurrentSubmitAmount: cleanText(item.prCurrentSubmitAmount || ""),
    costDept: cleanText(item.costDept || ""),
    costPurpose: cleanText(item.costPurpose || item.purposeText || ""),
    rowLabel: cleanText(item.rowLabel || "")
  };
  return normalized.processCode ||
    normalized.relatedTitle ||
    normalized.prStatus ||
    normalized.prAmount ||
    normalized.prPendingAmount ||
    normalized.prCurrentSubmitAmount ||
    normalized.costDept ||
    normalized.costPurpose
    ? normalized
    : null;
}

function getInlineDomesticPrItems(snapshot) {
  return (Array.isArray(snapshot?.inlineRelations?.domesticPr) ? snapshot.inlineRelations.domesticPr : [])
    .map((item) => normalizeInlineDomesticPrItem(item))
    .filter(Boolean);
}

function buildInlinePrRowHints(item) {
  const hints = [];
  const pushHint = (key, value) => {
    const text = cleanText(value || "");
    if (!text) {
      return;
    }
    hints.push({ key, value: text });
  };

  pushHint("PR单号", item?.processCode);
  pushHint("相关流程", item?.relatedTitle);
  pushHint("PR状态", item?.prStatus);
  pushHint("PR总额", item?.prAmount);
  pushHint("PR未提交付款金额", item?.prPendingAmount);
  pushHint("PR本次提交金额", item?.prCurrentSubmitAmount);
  pushHint("费用归属部门", item?.costDept);
  pushHint("费用归属说明", item?.costPurpose);
  return hints;
}

function extractContractProcessCode(value) {
  const matched = cleanText(value || "").match(CONTRACT_PROCESS_CODE_RE);
  return matched?.[0] ? matched[0].toUpperCase() : "";
}

function getInlineContractItems(snapshot) {
  const entries = collectSnapshotFieldEntries(snapshot);
  const hasContractFlag = findFieldValueFromPairs(entries, "是否有合同");
  const title = firstNonEmpty(
    findFieldValueFromPairs(entries, "合同用章申请", "合同名称", "合同标题", "合同流程标题", "合同申请"),
    findFieldValueFromPairs(entries, "相关合同", "采购合同", "框架协议")
  );
  const counterparty = findFieldValueFromPairs(entries, "合同相对方", "供应商名称", "乙方", "对方公司");
  const amount = findFieldValueFromPairs(entries, "合同总额", "合同总金额", "合同金额");
  const seen = new Set();
  const results = [];

  for (const entry of entries) {
    const label = cleanText(entry?.label || "");
    const value = cleanText(entry?.value || "");
    if (!value) {
      continue;
    }
    if (!/合同|协议/.test(label) && !CONTRACT_PROCESS_CODE_RE.test(value)) {
      continue;
    }

    const processCode = extractContractProcessCode(value);
    if (!processCode || seen.has(processCode)) {
      continue;
    }
    seen.add(processCode);
    results.push({
      processCode,
      title,
      counterparty,
      amount,
      hasContractFlag,
      sourceLabel: label
    });
  }

  return results;
}

function buildInlineContractRowHints(item) {
  const hints = [];
  const pushHint = (key, value) => {
    const text = cleanText(value || "");
    if (!text) {
      return;
    }
    hints.push({ key, value: text });
  };

  pushHint("合同流程编号", item?.processCode);
  pushHint("合同名称", item?.title);
  pushHint("合同相对方", item?.counterparty);
  pushHint("合同金额", item?.amount);
  pushHint("是否有合同", item?.hasContractFlag);
  return hints;
}

function withSourceInstId(ref, sourceInstId) {
  const source = cleanText(sourceInstId || "");
  if (!ref || ref.sourceInstId || !source || ref.detailId === source) {
    return ref;
  }

  try {
    const parsed = new URL(ref.detailUrl);
    parsed.searchParams.set("sourceInstId", source);
    return {
      ...ref,
      detailUrl: parsed.toString(),
      sourceInstId: source
    };
  } catch (_error) {
    return {
      ...ref,
      sourceInstId: source
    };
  }
}

async function resolveInlineDomesticPrRefs(snapshot, baseUrl, onProgress, sourceInstId = "") {
  const inlineItems = getInlineDomesticPrItems(snapshot);
  const refs = [];
  const seenCodes = new Set();

  for (const item of inlineItems) {
    if (!item.processCode || seenCodes.has(item.processCode)) {
      continue;
    }
    seenCodes.add(item.processCode);

    reportProgress(onProgress, "domestic-pr-resolve", "正在反查国内PR流程", item.processCode);
    try {
      const ref = withSourceInstId(await resolveProcessCodeRef(item.processCode, "domestic_pr", baseUrl), sourceInstId);
      if (!ref) {
        continue;
      }
      refs.push({
        ...ref,
        titleHint: firstNonEmpty(item.relatedTitle, ref.titleHint, item.processCode),
        rowHints: buildInlinePrRowHints(item)
      });
    } catch (_error) {
      // Keep the inline PR item as a fallback display source.
    }
  }

  return refs;
}

async function resolveInlineContractRefs(snapshot, baseUrl, onProgress, sourceInstId = "") {
  const inlineItems = getInlineContractItems(snapshot);
  const refs = [];
  const seenCodes = new Set();

  for (const item of inlineItems) {
    if (!item.processCode || seenCodes.has(item.processCode)) {
      continue;
    }
    seenCodes.add(item.processCode);

    reportProgress(onProgress, "contract-resolve", "正在反查合同流程", item.processCode);
    try {
      const ref = withSourceInstId(await resolveProcessCodeRef(item.processCode, "contract", baseUrl), sourceInstId);
      if (!ref) {
        continue;
      }
      refs.push({
        ...ref,
        titleHint: firstNonEmpty(item.title, ref.titleHint, item.processCode),
        rowHints: buildInlineContractRowHints(item)
      });
    } catch (_error) {
      // Keep any explicit link or attachment source as a fallback if reverse lookup fails.
    }
  }

  return refs;
}

function findMatchingInlineDomesticPrItem(inlineItems, ...candidates) {
  const items = Array.isArray(inlineItems) ? inlineItems : [];
  const normalizedCandidates = candidates.map((item) => cleanText(item || "").toUpperCase()).filter(Boolean);
  if (normalizedCandidates.length > 0) {
    const matchedByCode = items.find((item) => normalizedCandidates.includes(cleanText(item?.processCode || "").toUpperCase()));
    if (matchedByCode) {
      return matchedByCode;
    }
  }

  const titleCandidates = candidates.map((item) => cleanText(item || "")).filter(Boolean);
  return items.find((item) => {
    const relatedTitle = cleanText(item?.relatedTitle || "");
    return relatedTitle && titleCandidates.some((candidate) => candidate.includes(relatedTitle) || relatedTitle.includes(candidate));
  }) || null;
}

function mergeDomesticPrFields(baseFields, inlineItem) {
  if (!inlineItem) {
    return {
      ...baseFields,
      relatedTitle: cleanText(baseFields?.relatedTitle || ""),
      prStatus: cleanText(baseFields?.prStatus || ""),
      prPendingAmount: cleanText(baseFields?.prPendingAmount || ""),
      prCurrentSubmitAmount: cleanText(baseFields?.prCurrentSubmitAmount || ""),
      costPurpose: cleanText(baseFields?.costPurpose || baseFields?.purposeText || "")
    };
  }

  const merged = {
    ...baseFields,
    processCode: firstNonEmpty(baseFields?.processCode, inlineItem.processCode),
    relatedTitle: firstNonEmpty(baseFields?.relatedTitle, inlineItem.relatedTitle),
    prStatus: firstNonEmpty(baseFields?.prStatus, inlineItem.prStatus),
    prAmount: firstNonEmpty(baseFields?.prAmount, inlineItem.prAmount),
    prPendingAmount: firstNonEmpty(baseFields?.prPendingAmount, inlineItem.prPendingAmount),
    prCurrentSubmitAmount: firstNonEmpty(baseFields?.prCurrentSubmitAmount, inlineItem.prCurrentSubmitAmount),
    costDept: firstNonEmpty(baseFields?.costDept, inlineItem.costDept),
    costPurpose: firstNonEmpty(baseFields?.costPurpose, baseFields?.purposeText, inlineItem.costPurpose),
    requirementSummary: firstNonEmpty(
      baseFields?.requirementSummary,
      inlineItem.relatedTitle,
      inlineItem.costPurpose,
      baseFields?.purposeText
    )
  };
  merged.purposeText = firstNonEmpty(merged.purposeText, merged.costPurpose);
  return merged;
}

function hasStandaloneInlineDomesticPrSignal(fields) {
  const normalizedFields = fields || {};
  if (cleanText(normalizedFields.processCode || "") || cleanText(normalizedFields.relatedTitle || "")) {
    return true;
  }
  if (
    cleanText(normalizedFields.prAmount || "") ||
    cleanText(normalizedFields.prPendingAmount || "") ||
    cleanText(normalizedFields.prCurrentSubmitAmount || "") ||
    cleanText(normalizedFields.prStatus || "")
  ) {
    return true;
  }
  return false;
}

function shouldKeepInlineDomesticPrDoc(doc, hasLinkedDocs = false) {
  const fields = doc?.fields || {};
  if (hasStandaloneInlineDomesticPrSignal(fields)) {
    return true;
  }
  if (hasLinkedDocs) {
    return false;
  }
  return !!(cleanText(fields.costPurpose || fields.purposeText || "") && cleanText(fields.costDept || ""));
}

function buildInlineDomesticPrDoc(item, itemLabel = "") {
  const inlineItem = normalizeInlineDomesticPrItem(item);
  if (!inlineItem) {
    return null;
  }
  const fields = mergeDomesticPrFields({}, inlineItem);

  return createRelatedDocumentBase({
    kind: "domestic_pr",
    title: "国内PR",
    itemLabel,
    status: "info",
    statusText: "页内展示",
    displayOnly: true,
    sourceMode: "page_inline",
    sourceName: firstNonEmpty(inlineItem.relatedTitle, inlineItem.processCode, "当前付款单PR子表"),
    sourceUrl: "",
    statement: "当前付款单未提供可直接打开的国内PR入口，以下内容来自付款页PR子表",
    fields,
    relationHints: [
      inlineItem.prStatus ? `PR状态：${inlineItem.prStatus}` : "",
      inlineItem.prPendingAmount ? `PR未提交付款金额：${inlineItem.prPendingAmount}` : "",
      inlineItem.prCurrentSubmitAmount ? `PR本次提交金额：${inlineItem.prCurrentSubmitAmount}` : ""
    ].filter(Boolean),
    notes: ["仅展示，不自动判断", "来源：当前付款单页内PR子表"]
  });
}

function countDomesticPrHeaderLikeFields(fields) {
  const values = [
    fields?.relatedTitle,
    fields?.prStatus,
    fields?.prAmount,
    fields?.costDept,
    fields?.costProject
  ];
  return values.filter((value) =>
    /^(?:PR分类|PR状态|PR总额|PR金额|PR在途未付款金额|PR未提交付款金额|PR本次提交金额|相关流程|费用归属部门|费用归属项目|费用归属说明)$/.test(
      cleanText(value || "")
    )
  ).length;
}

function shouldKeepDomesticPrDoc(doc, hasLinkedDocs = false) {
  if (!doc) {
    return false;
  }
  if (doc.sourceMode === "page_inline") {
    return shouldKeepInlineDomesticPrDoc(doc, hasLinkedDocs);
  }
  if (doc.sourceMode === "linked_detail") {
    const processCode = cleanText(doc?.fields?.processCode || "").toUpperCase();
    if (processCode) {
      return true;
    }
    return countDomesticPrHeaderLikeFields(doc?.fields || {}) < 2;
  }
  return true;
}

function finalizeDomesticPrDocs(docs) {
  const deduped = [];
  const seenProcessCodes = new Set();

  for (const doc of docs || []) {
    const processCode = cleanText(doc?.fields?.processCode || "").toUpperCase();
    if (processCode) {
      if (seenProcessCodes.has(processCode)) {
        continue;
      }
      seenProcessCodes.add(processCode);
    }
    deduped.push(doc);
  }

  return deduped.map((doc, index) => ({
    ...doc,
    itemLabel: deduped.length > 1 ? `PR ${index + 1}` : ""
  }));
}

function createMissingSourceDocument(input) {
  return createRelatedDocumentBase({
    kind: input.kind,
    title: input.title,
    itemLabel: input.itemLabel || "",
    status: input.status || "info",
    statusText: input.statusText || "未提供来源",
    displayOnly: true,
    sourceMode: input.sourceMode || "page_inline",
    sourceName: input.sourceName || "",
    sourceUrl: input.sourceUrl || "",
    statement: input.statement || "",
    relationHints: Array.isArray(input.relationHints) ? input.relationHints : [],
    notes: Array.isArray(input.notes) ? input.notes : ["仅展示，不自动判断"]
  });
}

function findSnapshotSignal(snapshot, patterns, fallback = "") {
  const entries = [];
  for (const pair of snapshot?.fieldPairs || []) {
    entries.push(`${cleanText(pair?.label || "")}：${cleanText(pair?.value || "")}`);
  }
  if (snapshot?.bodyText) {
    entries.push(cleanText(snapshot.bodyText));
  }

  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    for (const pattern of patterns || []) {
      const matched = entry.match(pattern);
      if (matched?.[0]) {
        return snippetAround(entry, matched[0]) || entry;
      }
    }
  }

  return fallback;
}

function normalizeDomesticPrQuarter(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }
  if (isLikelyDomesticPrPeriodNoiseText(text)) {
    return "";
  }
  const upper = text.toUpperCase();
  const qMatch = upper.match(/^Q([1-4])$/) || upper.match(/\bQ\s*([1-4])\b/);
  if (qMatch) {
    return qMatch[1];
  }
  if (/^[1-4]$/.test(upper)) {
    return upper;
  }
  const cnMatch = upper.match(/第?\s*([一二三四1234])\s*季(?:度)?/);
  if (cnMatch) {
    return mapDomesticPrQuarterToken(cnMatch[1]);
  }
  if (/^[一二三四]$/.test(upper)) {
    return mapDomesticPrQuarterToken(upper);
  }
  return "";
}

function isLikelyDomesticPrPeriodNoiseText(value) {
  const text = cleanText(value || "");
  if (!text) {
    return false;
  }
  const compact = text.toUpperCase().replace(/\s+/g, "");
  const years = [...new Set(compact.match(/20\d{2}/g) || [])];
  const quarters = [...new Set(compact.match(/Q[1-4]/g) || [])];
  if (years.length > 1 || quarters.length > 1) {
    return true;
  }
  return /(?:20\d{2}){2,}/.test(compact) && /(?:Q[1-4]){2,}/.test(compact);
}

function buildDomesticPrPeriodMeta(yearValue, quarterValue, rawText = "") {
  const year = normalizeDomesticPrYear(yearValue);
  const quarter = normalizeDomesticPrQuarter(quarterValue);
  const raw = cleanText(rawText || "");
  return {
    costYear: year,
    costQuarter: quarter ? `Q${quarter}` : "",
    costPeriodText: year && quarter ? `${year} / Q${quarter}` : raw,
    costPeriodShort: year && quarter ? `${year.slice(-2)}Q${quarter}` : ""
  };
}

function parseDomesticPrPeriodMeta(value) {
  const text = cleanText(value || "");
  if (!text) {
    return buildDomesticPrPeriodMeta("", "", "");
  }
  if (isLikelyDomesticPrPeriodNoiseText(text)) {
    return buildDomesticPrPeriodMeta("", "", "");
  }

  const patterns = [
    /(20\d{2}|\d{2})\s*(?:年|[\/\-.])?\s*Q\s*([1-4])/i,
    /(20\d{2}|\d{2})Q([1-4])/i,
    /(20\d{2}|\d{2})\s*(?:年|[\/\-.])?\s*第?\s*([一二三四1234])\s*季(?:度)?/i,
    /(20\d{2}|\d{2})\s*(?:年|[\/\-.])?\s*([1-4])\s*季(?:度)?/i
  ];

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      return buildDomesticPrPeriodMeta(matched[1], matched[2], text);
    }
  }

  return buildDomesticPrPeriodMeta(text, text, text);
}

function pickDomesticPrPeriodCandidate(candidates = []) {
  for (const candidate of candidates || []) {
    const text = cleanText(candidate || "");
    if (!text || isLikelyDomesticPrPeriodNoiseText(text)) {
      continue;
    }
    const parsed = parseDomesticPrPeriodMeta(text);
    if (parsed.costPeriodShort) {
      return {
        raw: text,
        meta: parsed
      };
    }
  }
  return null;
}

function pickDomesticPrScalarCandidate(candidates = [], normalizer) {
  for (const candidate of candidates || []) {
    const text = cleanText(candidate || "");
    if (!text || isLikelyDomesticPrPeriodNoiseText(text)) {
      continue;
    }
    if (typeof normalizer === "function" && !normalizer(text)) {
      continue;
    }
    return text;
  }
  return "";
}

async function extractDomesticPrPeriodFields(context, prLink, fields = {}) {
  const combinedCandidates = await extractProcessFieldCandidatesWithFallback(
    context,
    ["费用发生年度", "费用发生期间", "费用期间", "发生期间"],
    ["费用发生年度", "费用发生期间", "费用期间", "发生期间", "expensePeriod", "costPeriod", "occurPeriod"],
    12
  );
  const yearCandidates = await extractProcessFieldCandidatesWithFallback(
    context,
    ["费用发生年度", "费用年度", "发生年度"],
    ["费用发生年度", "费用年度", "发生年度", "expenseYear", "costYear", "occurYear"],
    12
  );
  const quarterCandidates = await extractProcessFieldCandidatesWithFallback(
    context,
    ["费用发生季度", "费用季度", "发生季度", "季度"],
    ["费用发生季度", "费用季度", "发生季度", "季度", "expenseQuarter", "costQuarter", "occurQuarter"],
    12
  );
  const combinedMatch = pickDomesticPrPeriodCandidate(combinedCandidates);
  const combinedText = combinedMatch?.raw || "";
  const yearText = pickDomesticPrScalarCandidate(yearCandidates, normalizeDomesticPrYear);
  const quarterText = pickDomesticPrScalarCandidate(quarterCandidates, normalizeDomesticPrQuarter);

  let periodMeta = combinedMatch?.meta || buildDomesticPrPeriodMeta(yearText, quarterText, combinedText);
  if (!periodMeta.costPeriodShort) {
    const fallbackSources = [
      ...combinedCandidates,
      ...yearCandidates,
      ...quarterCandidates,
      combinedText,
      `${yearText} ${quarterText}`.trim(),
      fields?.purposeText,
      fields?.requirementSummary,
      prLink?.title,
      ...(Array.isArray(prLink?.hintTexts) ? prLink.hintTexts : [])
    ].filter(Boolean);

    for (const source of fallbackSources) {
      if (isLikelyDomesticPrPeriodNoiseText(source)) {
        continue;
      }
      const parsed = parseDomesticPrPeriodMeta(source);
      if (parsed.costPeriodShort) {
        periodMeta = parsed;
        break;
      }
    }
  }

  return periodMeta;
}

async function buildDomesticPrFields(context, prLink) {
  const fields = {
    processCode: await extractRelatedProcessCodeWithFallback(context, ["PR单号", "流程编号", "单号", "相关流程", "PR选择"], {
      keyHints: ["PR单号", "流程编号", "单号", "相关流程", "PR选择", "processCode", "prCode", "prNo", "prnumber"],
      preferredPattern: DOMESTIC_PR_CODE_RE
    }),
    relatedTitle: await extractProcessFieldWithFallback(context, ["相关流程", "PR标题", "PR名称", "流程标题", "标题"]),
    prStatus: await extractProcessFieldWithFallback(context, ["PR状态", "状态"]),
    costDept: await extractProcessFieldWithFallback(context, ["费用归属部门", "归属部门", "所属部门"]),
    costProject: await extractProcessFieldWithFallback(context, ["费用归属项目", "归属项目", "所属项目"]),
    purposeText: await extractProcessFieldWithFallback(context, ["订单用途说明", "用途说明", "费用用途说明", "申请事由", "采购用途"]),
    costPurpose: await extractProcessFieldWithFallback(context, ["费用归属说明", "费用用途说明", "用途说明", "申请事由"]),
    prAmount: await extractProcessFieldWithFallback(context, ["PR金额", "PR总额", "PR申请金额", "申请金额", "金额"]),
    prPendingAmount: await extractProcessFieldWithFallback(context, ["PR未提交付款金额", "待提单金额", "剩余可提金额"]),
    prCurrentSubmitAmount: await extractProcessFieldWithFallback(context, ["PR本次提交金额", "本次提交金额", "本次付款金额"]),
    requirementSummary: await buildRequirementSummaryWithFallback(context)
  };

  if (!fields.requirementSummary && context.pageSnapshot) {
    fields.requirementSummary = buildGenericSubformSummary(context.pageSnapshot);
  }
  if (!fields.purposeText && context.pageSnapshot) {
    fields.purposeText = buildGenericSubformSummary(context.pageSnapshot, 2, 4);
  }
  if (!fields.costPurpose) {
    fields.costPurpose = fields.purposeText;
  }
  if (!fields.requirementSummary) {
    fields.requirementSummary = firstNonEmpty(fields.relatedTitle, fields.costPurpose);
  }

  return {
    ...fields,
    ...(await extractDomesticPrPeriodFields(context, prLink, fields))
  };
}

async function analyzeDomesticPrLinks(relatedLinks, target, baseUrl, onProgress) {
  const prLink = pickRelatedLink(relatedLinks, "domestic_pr");
  if (!prLink) {
    return createRelatedDocumentBase({
      kind: "domestic_pr",
      title: "国内PR",
      status: "warn",
      statusText: "未找到",
      displayOnly: true,
      statement: "尚未发现明确的国内PR来源",
      notes: ["仅展示，不自动判断"]
    });
  }

  const ref = parseProcessRef(prLink.url, "domestic_pr");
  if (!ref) {
    return createRelatedDocumentBase({
      kind: "domestic_pr",
      title: "国内PR",
      status: "warn",
      statusText: "链接异常",
      displayOnly: true,
      sourceName: prLink.title || "",
      sourceUrl: prLink.url || "",
      statement: "国内PR链接格式暂未识别",
      notes: ["仅展示，不自动判断"]
    });
  }

  reportProgress(onProgress, "domestic-pr-open", "正在读取国内PR详情", prLink.title || ref.detailUrl || "国内PR入口");
  const context = await loadRelatedProcessContext(ref, baseUrl, { includePageSnapshot: false });
  if (!context.detail) {
    await ensureRelatedProcessPageSnapshot(context);
  }
  if (!context.detail && !context.pageSnapshot) {
    return createRelatedDocumentBase({
      kind: "domestic_pr",
      title: "国内PR",
      status: "warn",
      statusText: "读取失败",
      displayOnly: true,
      sourceName: prLink.title || "",
      sourceUrl: ref.detailUrl || "",
      statement: `国内PR读取失败：${context.detailError || context.pageError || "未知错误"}`,
      errorText: context.detailError || context.pageError || "",
      notes: ["仅展示，不自动判断"]
    });
  }

  const fields = await buildDomesticPrFields(context, prLink);

  return createRelatedDocumentBase({
    kind: "domestic_pr",
    title: "国内PR",
    status: "info",
    statusText: "仅展示",
    displayOnly: true,
    sourceName: normalizeRelatedSourceName(context.pageSnapshot, prLink.title, ref, fields.processCode),
    sourceUrl: ref.detailUrl,
    statement: buildRelatedReadStatement("国内PR", context),
    fields,
    notes: ["仅展示，不自动判断", "PR金额仅作系统默认展示，不参与规则计算"]
  });
}

async function analyzeDomesticPrLinksMulti(relatedLinks, target, baseUrl, onProgress, options = {}) {
  const inlineItems = getInlineDomesticPrItems(options?.snapshot);
  const inlineDocs = [];
  const consumedInlineCodes = new Set();
  const prLinks = pickRelatedLinks(relatedLinks, "domestic_pr");
  if (prLinks.length === 0) {
    if (inlineItems.length > 0) {
      const standaloneDocs = inlineItems
        .map((item, index) => buildInlineDomesticPrDoc(item, inlineItems.length > 1 ? `PR ${index + 1}` : ""))
        .filter((doc) => shouldKeepDomesticPrDoc(doc, false));
      if (standaloneDocs.length > 0) {
        return finalizeDomesticPrDocs(standaloneDocs);
      }
    }
    return [options?.missingDocument || createRelatedDocumentBase({
      kind: "domestic_pr",
      title: "国内PR",
      status: "warn",
      statusText: "未找到",
      displayOnly: true,
      statement: "尚未发现明确的国内PR来源",
      notes: ["仅展示，不自动判断"]
    })];
  }

  const docs = [];
  for (let index = 0; index < prLinks.length; index += 1) {
    const prLink = prLinks[index];
    const itemLabel = prLinks.length > 1 ? `PR ${index + 1}` : "";
    const ref = parseProcessRef(prLink.url, "domestic_pr");
    if (!ref) {
      docs.push(
        createRelatedDocumentBase({
          kind: "domestic_pr",
          title: "国内PR",
          itemLabel,
          status: "warn",
          statusText: "链接异常",
          displayOnly: true,
          sourceName: prLink.title || "",
          sourceUrl: prLink.url || "",
          statement: "国内PR链接格式暂未识别",
          notes: ["仅展示，不自动判断"]
        })
      );
      continue;
    }

    reportProgress(onProgress, "domestic-pr-open", "正在读取国内PR详情", prLink.title || ref.detailUrl || "国内PR入口");
    const context = await loadRelatedProcessContext(ref, baseUrl, { includePageSnapshot: false });
    if (!context.detail) {
      await ensureRelatedProcessPageSnapshot(context);
    }
    if (!context.detail && !context.pageSnapshot) {
      docs.push(
        createRelatedDocumentBase({
          kind: "domestic_pr",
          title: "国内PR",
          itemLabel,
          status: "warn",
          statusText: "读取失败",
          displayOnly: true,
          sourceName: prLink.title || "",
          sourceUrl: ref.detailUrl || "",
          statement: `国内PR读取失败：${context.detailError || context.pageError || "未知错误"}`,
          errorText: context.detailError || context.pageError || "",
          notes: ["仅展示，不自动判断"]
        })
      );
      continue;
    }

    const fields = await buildDomesticPrFields(context, prLink);
    const inlineItem = findMatchingInlineDomesticPrItem(
      inlineItems,
      fields.processCode,
      prLink.title,
      ...(Array.isArray(prLink?.hintTexts) ? prLink.hintTexts : [])
    );
    const mergedFields = mergeDomesticPrFields(fields, inlineItem);
    if (inlineItem?.processCode) {
      consumedInlineCodes.add(inlineItem.processCode);
    }

    docs.push(
      createRelatedDocumentBase({
        kind: "domestic_pr",
        title: "国内PR",
        itemLabel,
        status: "info",
        statusText: "仅展示",
        displayOnly: true,
        sourceMode: "linked_detail",
        sourceName: normalizeRelatedSourceName(context.pageSnapshot, prLink.title, ref, mergedFields.relatedTitle, mergedFields.processCode),
        sourceUrl: ref.detailUrl,
        statement: buildRelatedReadStatement("国内PR", context),
        fields: mergedFields,
        relationHints: [
          mergedFields.prStatus ? `PR状态：${mergedFields.prStatus}` : "",
          mergedFields.prPendingAmount ? `PR未提交付款金额：${mergedFields.prPendingAmount}` : "",
          mergedFields.prCurrentSubmitAmount ? `PR本次提交金额：${mergedFields.prCurrentSubmitAmount}` : ""
        ].filter(Boolean),
        notes: ["仅展示，不自动判断", "国内PR详情优先来自真实流程，页内PR子表只作为补充字段"]
      })
    );
  }

  for (const item of inlineItems) {
    if (item.processCode && consumedInlineCodes.has(item.processCode)) {
      continue;
    }
    const doc = buildInlineDomesticPrDoc(item, prLinks.length + inlineDocs.length + docs.length > 1 ? `PR ${docs.length + inlineDocs.length + 1}` : "");
    if (doc && shouldKeepDomesticPrDoc(doc, docs.length > 0)) {
      inlineDocs.push(doc);
    }
  }

  const allDocs = finalizeDomesticPrDocs(
    [...docs, ...inlineDocs].filter((doc) => shouldKeepDomesticPrDoc(doc, docs.length > 0))
  );

  if (allDocs.length === 0) {
    return [options?.missingDocument || createRelatedDocumentBase({
      kind: "domestic_pr",
      title: "国内PR",
      status: "warn",
      statusText: "未找到",
      displayOnly: true,
      statement: "尚未发现明确的国内PR来源",
      notes: ["仅展示，不自动判断"]
    })];
  }

  return allDocs;
}

function createOrderCheck(key, label, status, statement) {
  return { key, label, status, statement };
}

function compareCompanyLoosely(left, right) {
  const normalizedLeft = normalizeCompareText(left);
  const normalizedRight = normalizeCompareText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function pickPreferredCompanyCandidate(candidates, preferredCompany = "") {
  const cleanedCandidates = (candidates || []).map((item) => cleanText(item || "")).filter(Boolean);
  if (cleanedCandidates.length === 0) {
    return "";
  }

  if (preferredCompany) {
    const matched = cleanedCandidates.find((item) => compareCompanyLoosely(item, preferredCompany));
    if (matched) {
      return matched;
    }
  }

  return cleanedCandidates[0];
}

async function analyzePurchaseOrderLinks(relatedLinks, target, baseUrl, onProgress, options = {}) {
  const orderLink = pickRelatedLink(relatedLinks, "purchase_order");
  if (!orderLink) {
    return options?.missingDocument || createRelatedDocumentBase({
      kind: "purchase_order",
      title: "采购订单",
      status: "warn",
      statusText: "未找到",
      statement: "尚未发现明确的采购订单来源",
      notes: ["仅自动核对收款公司与订单金额两项"]
    });
  }

  const ref = parseProcessRef(orderLink.url, "purchase_order");
  if (!ref) {
    return createRelatedDocumentBase({
      kind: "purchase_order",
      title: "采购订单",
      status: "warn",
      statusText: "链接异常",
      sourceName: orderLink.title || "",
      sourceUrl: orderLink.url || "",
      statement: "采购订单链接格式暂未识别",
      notes: ["仅自动核对收款公司与订单金额两项"]
    });
  }

  reportProgress(onProgress, "purchase-order-open", "正在读取采购订单详情", orderLink.title || ref.detailUrl || "采购订单入口");
  const context = await loadRelatedProcessContext(ref, baseUrl, { includePageSnapshot: false });
  if (!context.detail) {
    await ensureRelatedProcessPageSnapshot(context);
  }
  if (!context.detail && !context.pageSnapshot) {
    return createRelatedDocumentBase({
      kind: "purchase_order",
      title: "采购订单",
      status: "warn",
      statusText: "读取失败",
      sourceName: orderLink.title || "",
      sourceUrl: ref.detailUrl || "",
      statement: `采购订单读取失败：${context.detailError || context.pageError || "未知错误"}`,
      errorText: context.detailError || context.pageError || "",
      notes: ["仅自动核对收款公司与订单金额两项"]
    });
  }

  const fields = {
    processCode: await extractRelatedProcessCodeWithFallback(context, ["订单编号", "流程编号", "单号", "编号"], {
      keyHints: ["订单编号", "采购订单编号", "流程编号", "单号", "编号", "processCode", "orderCode", "orderNo", "poNo"],
      preferredPattern: PURCHASE_ORDER_CODE_RE
    }),
    orderName: await extractProcessFieldWithFallback(context, ["订单名称", "采购订单名称", "名称"]),
    supplierName: "",
    orderAmount: await extractProcessFieldWithFallback(context, ["订单金额", "订单总金额", "含税总金额", "金额", "总价"]),
    description: await extractProcessFieldWithFallback(context, ["订单内容摘要", "订单内容", "物料明细", "说明", "采购内容"])
  };
  const supplierCandidates = await extractProcessFieldCandidatesWithFallback(
    context,
    ["订单供应商", "供应商名称", "供应商"],
    ["订单供应商", "供应商名称", "供应商"],
    6
  );
  fields.supplierName = pickPreferredCompanyCandidate(supplierCandidates, target.payeeCompany);
  if (!fields.supplierName && context.pageSnapshot) {
    fields.supplierName = inferSupplierNameFromSnapshot(context.pageSnapshot, target.payeeCompany);
  }
  if (!fields.orderAmount && context.pageSnapshot) {
    fields.orderAmount = inferAmountFromSnapshot(context.pageSnapshot, target.paymentAmount);
  }
  if (!fields.description && context.pageSnapshot) {
    fields.description = buildGenericSubformSummary(context.pageSnapshot, 6, 6);
  }

  const checks = [];
  if (!target.payeeCompany || !fields.supplierName) {
    checks.push(createOrderCheck("payee_matches_supplier", "收款公司与订单供应商", "warn", "付款单或采购订单缺少公司字段，暂不自动判断"));
  } else if (compareCompanyLoosely(target.payeeCompany, fields.supplierName)) {
    checks.push(createOrderCheck("payee_matches_supplier", "收款公司与订单供应商", "pass", "付款单收款公司与订单供应商一致"));
  } else {
    checks.push(createOrderCheck("payee_matches_supplier", "收款公司与订单供应商", "fail", "付款单收款公司与订单供应商不一致"));
  }

  const paymentAmount = parseAmount(target.paymentAmount);
  const orderAmount = parseAmount(fields.orderAmount);
  if (!(paymentAmount > 0) || !(orderAmount > 0)) {
    checks.push(createOrderCheck("payment_not_exceed_order_amount", "付款金额不超过订单金额", "warn", "付款金额或订单金额缺失，暂不自动判断"));
  } else if (paymentAmount <= orderAmount + 0.01) {
    checks.push(createOrderCheck("payment_not_exceed_order_amount", "付款金额不超过订单金额", "pass", "付款金额未超过订单金额"));
  } else {
    checks.push(createOrderCheck("payment_not_exceed_order_amount", "付款金额不超过订单金额", "fail", "付款金额超过订单金额"));
  }

  const hasFail = checks.some((item) => item.status === "fail");
  const hasWarn = checks.some((item) => item.status === "warn");

  return createRelatedDocumentBase({
    kind: "purchase_order",
    title: "采购订单",
    status: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    statusText: "有限自动核对",
    sourceName: normalizeRelatedSourceName(context.pageSnapshot, orderLink.title, ref, fields.orderName, fields.processCode),
    sourceUrl: ref.detailUrl,
    statement: "采购订单仅自动核对收款公司与订单金额两项，其他字段只展示不判断",
    fields,
    checks,
    notes: ["仅自动核对收款公司与订单金额两项"]
  });
}

function selectMailLikeAttachments(attachments) {
  return (attachments || []).filter((item) => {
    const text = cleanText(`${item?.name || ""} ${item?.url || ""}`);
    return /\.(?:eml|msg)(?:$|\?)/i.test(text) || /outlook|message|mail/i.test(text);
  });
}

function summarizeFreeText(value, maxLength = 120) {
  const text = cleanText(value || "");
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function buildAcceptanceRelationHints(target, mailSubject, mailSummary, mailAttachmentNames) {
  const combined = [mailSubject, mailSummary, ...(mailAttachmentNames || [])].filter(Boolean).join("\n");
  const hints = [];
  if (!combined) {
    return ["暂未提取到足够的邮件线索，请人工打开验收单进一步确认"];
  }

  if (target?.payeeCompany && compareCompanyLoosely(combined, target.payeeCompany)) {
    hints.push(`邮件线索包含供应商/收款公司：${target.payeeCompany}`);
  }
  if (target?.paymentAmount && amountMatchesPayment(combined, target.paymentAmount)) {
    hints.push(`邮件线索包含本次付款金额：${formatAmount(target.paymentAmount)}`);
  }

  const normalizedTitle = normalizeCompareText(target?.processTitle || "");
  if (normalizedTitle.length >= 6 && normalizeCompareText(combined).includes(normalizedTitle.slice(0, 10))) {
    hints.push("邮件线索与当前付款标题存在明显重合");
  }

  if ((mailAttachmentNames || []).length > 0) {
    hints.push(`邮件内附件：${mailAttachmentNames.slice(0, 3).join("、")}`);
  }

  return hints.length > 0 ? hints : ["已提取邮件内容，但是否对应本次付款仍需人工判断"];
}

async function analyzeAcceptanceMailLinks(relatedLinks, target, baseUrl, onProgress) {
  const acceptanceLink = pickRelatedLink(relatedLinks, "acceptance");
  if (!acceptanceLink) {
    return createRelatedDocumentBase({
      kind: "acceptance",
      title: "验收单",
      status: "warn",
      statusText: "未找到",
      sourceName: "",
      sourceUrl: "",
      statement: "尚未发现明确的验收来源",
      notes: ["只展示邮件附件与相关线索，不自动判断是否对应本次付款"]
    });
  }

  const ref = parseProcessRef(acceptanceLink.url, "acceptance");
  if (!ref) {
    return createRelatedDocumentBase({
      kind: "acceptance",
      title: "验收单",
      status: "warn",
      statusText: "链接异常",
      sourceName: acceptanceLink.title || "",
      sourceUrl: acceptanceLink.url || "",
      statement: "验收链接格式暂未识别",
      notes: ["只展示邮件附件与相关线索，不自动判断是否对应本次付款"]
    });
  }

  reportProgress(onProgress, "acceptance-open", "正在读取验收页", acceptanceLink.title || ref.detailUrl || "验收入口");
  const context = await loadRelatedProcessContext(ref, baseUrl);
  if (!context.detail) {
    await ensureRelatedProcessPageSnapshot(context);
  }
  if (!context.detail && !context.pageSnapshot) {
    return createRelatedDocumentBase({
      kind: "acceptance",
      title: "验收单",
      status: "warn",
      statusText: "读取失败",
      sourceName: acceptanceLink.title || "",
      sourceUrl: ref.detailUrl || "",
      statement: `验收页读取失败：${context.detailError || context.pageError || "未知错误"}`,
      errorText: context.detailError || context.pageError || "",
      notes: ["只展示邮件附件与相关线索，不自动判断是否对应本次付款"]
    });
  }

  const attachments = mergeAttachmentCandidates(
    context.detail
      ? ref.mode === "flowable"
        ? buildFlowableAttachmentList(context.detail)
        : buildHistoryAttachmentList(context.detail)
      : [],
    Array.isArray(context.pageSnapshot?.attachments) ? context.pageSnapshot.attachments : []
  );
  const mailAttachments = selectMailLikeAttachments(attachments).slice(0, 3);
  const mailEvidenceList = [];

  for (const attachment of mailAttachments) {
    try {
      const binary = await fetchBinary(attachment.url);
      const evidence = await extractMailEvidenceFromAttachment(attachment, binary.bytes, binary.contentType || "");
      if (evidence) {
        mailEvidenceList.push(evidence);
      }
    } catch (_error) {
      // Ignore single mail attachment parse failures and keep other clues.
    }
  }

  const pageMailSubject = extractProcessField(context.detail, context.pageSnapshot, ["邮件主题", "主题", "邮件标题"]);
  const pageMailTime = extractProcessField(context.detail, context.pageSnapshot, ["邮件时间", "发送时间", "发件时间", "日期"]);
  const pageMailBody = extractProcessField(context.detail, context.pageSnapshot, ["邮件正文", "邮件内容", "正文", "摘要", "说明"]);
  const firstMailEvidence = mailEvidenceList[0] || {};
  const mailAttachmentNames = Array.from(
    new Set(
      [
        ...(firstMailEvidence.attachmentNames || []),
        ...mailAttachments.map((item) => cleanText(item?.name || ""))
      ].filter(Boolean)
    )
  );
  const mailSubjectHint = deriveAcceptanceMailSubjectHint(acceptanceLink);
  const mailSubject = firstNonEmpty(pageMailSubject, firstMailEvidence.subject, mailSubjectHint);
  const mailSentAt = firstNonEmpty(pageMailTime, firstMailEvidence.sentAt);
  const mailSummary = firstNonEmpty(pageMailBody, firstMailEvidence.bodySummary, summarizeFreeText(firstMailEvidence.text));
  const relationHints = buildAcceptanceRelationHints(target, mailSubject, mailSummary, mailAttachmentNames);

  return createRelatedDocumentBase({
    kind: "acceptance",
    title: "验收单",
    status: "info",
    statusText: "人工判断",
    sourceName: normalizeRelatedSourceName(context.pageSnapshot, acceptanceLink.title, ref, mailSubject, mailSubjectHint),
    sourceUrl: ref.detailUrl,
    statement: mailSubject || mailSummary || mailAttachmentNames.length > 0
      ? "已提取验收单邮件线索，请人工判断是否对应本次付款"
      : "已进入验收页，但暂未提取到明确的邮件线索",
    fields: {
      mailSubject,
      mailSentAt,
      mailSummary
    },
    attachmentNames: attachments.map((item) => cleanText(item?.name || "")).filter(Boolean).slice(0, 6),
    mailAttachmentNames,
    relationHints,
    notes: ["只展示邮件附件与相关线索，不自动判断是否对应本次付款"]
  });
}

async function extractAcceptanceAttachmentPreviews(attachments) {
  const previews = [];
  const candidates = (attachments || [])
    .filter((item) => supportsAttachmentTextExtraction(item?.name, item?.url))
    .slice(0, 3);

  for (const attachment of candidates) {
    try {
      const binary = await fetchBinary(attachment.url);
      const entries = await extractReferenceTextsFromAttachment(attachment, binary.bytes, binary.contentType || "");
      const firstEntry = entries.find((item) => cleanText(item?.text || ""));
      if (!firstEntry) {
        continue;
      }
      previews.push({
        name: cleanText(attachment?.name || ""),
        snippet: buildAttachmentPreviewText(firstEntry.text)
      });
    } catch (_error) {
      // Ignore per-attachment preview errors.
    }
  }

  return previews;
}

async function analyzeAcceptanceMailLinksMulti(relatedLinks, target, baseUrl, onProgress, options = {}) {
  const acceptanceLinks = pickRelatedLinks(relatedLinks, "acceptance");
  if (acceptanceLinks.length === 0) {
    return [
      options?.missingDocument || createRelatedDocumentBase({
        kind: "acceptance",
        title: "验收单",
        status: "warn",
        statusText: "未找到",
        statement: "尚未发现明确的验收来源",
        notes: ["只展示验收附件与相关线索，不自动判断是否对应本次付款"]
      })
    ];
  }

  const docs = [];
  for (let index = 0; index < acceptanceLinks.length; index += 1) {
    const acceptanceLink = acceptanceLinks[index];
    const itemLabel = acceptanceLinks.length > 1 ? `验收 ${index + 1}` : "";
    const ref = parseProcessRef(acceptanceLink.url, "acceptance");
    if (!ref) {
      docs.push(
        createRelatedDocumentBase({
          kind: "acceptance",
          title: "验收单",
          itemLabel,
          status: "warn",
          statusText: "链接异常",
          sourceName: acceptanceLink.title || "",
          sourceUrl: acceptanceLink.url || "",
          statement: "验收链接格式暂未识别",
          notes: ["只展示验收附件与相关线索，不自动判断是否对应本次付款"]
        })
      );
      continue;
    }

    reportProgress(onProgress, "acceptance-open", "正在读取验收页", acceptanceLink.title || ref.detailUrl || "验收入口");
    const context = await loadRelatedProcessContext(ref, baseUrl);
    if (!context.detail) {
      await ensureRelatedProcessPageSnapshot(context);
    }
    if (!context.detail && !context.pageSnapshot) {
      docs.push(
        createRelatedDocumentBase({
          kind: "acceptance",
          title: "验收单",
          itemLabel,
          status: "warn",
          statusText: "读取失败",
          sourceName: acceptanceLink.title || "",
          sourceUrl: ref.detailUrl || "",
          statement: `验收页读取失败：${context.detailError || context.pageError || "未知错误"}`,
          errorText: context.detailError || context.pageError || "",
          notes: ["只展示验收附件与相关线索，不自动判断是否对应本次付款"]
        })
      );
      continue;
    }

    const attachments = mergeAttachmentCandidates(
      context.detail
        ? ref.mode === "flowable"
          ? buildFlowableAttachmentList(context.detail)
          : buildHistoryAttachmentList(context.detail)
        : [],
      Array.isArray(context.pageSnapshot?.attachments) ? context.pageSnapshot.attachments : []
    );
    const mailAttachments = selectMailLikeAttachments(attachments).slice(0, 3);
    const mailEvidenceList = [];

    for (const attachment of mailAttachments) {
      try {
        const binary = await fetchBinary(attachment.url);
        const evidence = await extractMailEvidenceFromAttachment(attachment, binary.bytes, binary.contentType || "");
        if (evidence) {
          mailEvidenceList.push(evidence);
        }
      } catch (_error) {
        // Ignore single mail attachment parse failures and keep other clues.
      }
    }

    const pageMailSubject = extractProcessField(context.detail, context.pageSnapshot, ["邮件主题", "主题", "邮件标题"]);
    const pageMailTime = extractProcessField(context.detail, context.pageSnapshot, ["邮件时间", "发送时间", "发件时间", "日期"]);
    const pageMailBody = extractProcessField(context.detail, context.pageSnapshot, ["邮件正文", "邮件内容", "正文", "摘要", "说明"]);
    const firstMailEvidence = mailEvidenceList[0] || {};
    const mailAttachmentNames = Array.from(
      new Set(
        [
          ...(firstMailEvidence.attachmentNames || []),
          ...mailAttachments.map((item) => cleanText(item?.name || ""))
        ].filter(Boolean)
      )
    );
    const attachmentNames = Array.from(
      new Set(attachments.map((item) => cleanText(item?.name || "")).filter(Boolean))
    ).slice(0, 6);
    const attachmentPreviews = await extractAcceptanceAttachmentPreviews(attachments);
    const mailSubjectHint = deriveAcceptanceMailSubjectHint(acceptanceLink);
    const mailSubject = firstNonEmpty(pageMailSubject, firstMailEvidence.subject, mailSubjectHint);
    const mailSentAt = firstNonEmpty(pageMailTime, firstMailEvidence.sentAt);
    const mailSummary = firstNonEmpty(pageMailBody, firstMailEvidence.bodySummary, summarizeFreeText(firstMailEvidence.text));
    const relationHints = buildAcceptanceRelationHints(target, mailSubject, mailSummary, mailAttachmentNames);

    docs.push(
      createRelatedDocumentBase({
        kind: "acceptance",
        title: "验收单",
        itemLabel,
        status: "info",
        statusText: "人工判断",
        sourceName: normalizeRelatedSourceName(context.pageSnapshot, acceptanceLink.title, ref, mailSubject, mailSubjectHint),
        sourceUrl: ref.detailUrl,
        statement:
          attachmentNames.length > 0
            ? "已进入验收页，展示验收附件并保留人工判断"
            : mailSubject || mailSummary || mailAttachmentNames.length > 0
              ? "已提取验收单邮件线索，请人工判断是否对应本次付款"
              : "已进入验收页，但暂未提取到明确的邮件线索",
        fields: {
          mailSubject,
          mailSentAt,
          mailSummary
        },
        attachmentNames,
        mailAttachmentNames,
        previewItems: attachmentPreviews,
        relationHints,
        notes: ["只展示验收附件与相关线索，不自动判断是否对应本次付款"]
      })
    );
  }

  return docs;
}

async function analyzeContractLinks(relatedLinks, target, baseUrl, onProgress, runtime = null) {
  const contractLink = (relatedLinks || []).find((item) => item.relation === "contract");
  if (!contractLink) {
    return {
      ref: null,
      facts: {},
      matches: { amount: null, company: null, account: null },
      summary: emptyContractSummary(),
      processing: emptyContractProcessing("not_found", "尚未发现明确的合同来源")
    };
  }

  const ref = parseProcessRef(contractLink.url, "contract");
  if (!ref) {
    return {
      ref: null,
      facts: {},
      matches: { amount: null, company: null, account: null },
      summary: emptyContractSummary(),
      processing: emptyContractProcessing("invalid_ref", "已发现合同链接，但链接格式暂未识别")
    };
  }

  reportProgress(onProgress, "contract-open", "正在读取合同页", contractLink.title || ref.detailUrl || "合同入口");

  try {
    if (ref.mode === "flowable") {
      const detail = runtime?.timings
        ? await runtime.timings.time("contract-flowable-api", () => fetchFlowableDetail(ref, baseUrl), {
            detailId: ref.detailId || ""
          })
        : await fetchFlowableDetail(ref, baseUrl);
      const apiAttachments = buildFlowableAttachmentList(detail);
      const apiBaseFacts = buildFlowableContractBaseFacts(detail, ref, contractLink);
      const apiSufficient = isFlowableContractApiSufficient(apiBaseFacts, apiAttachments, target);
      runtime?.timings?.mark("contract-flowable-api-sufficiency", {
        detailId: ref.detailId || "",
        apiSufficient,
        apiAttachmentCount: apiAttachments.length,
        hasCounterpartyCompany: !!apiBaseFacts.counterpartyCompany,
        hasContractAccountNo: !!apiBaseFacts.contractAccountNo,
        hasEffectiveStart: !!apiBaseFacts.effectiveStart,
        hasEffectiveEnd: !!apiBaseFacts.effectiveEnd,
        hasPaymentTerms: !!apiBaseFacts.paymentTerms
      });
      const flowablePageSnapshot = apiSufficient
        ? null
        : runtime?.timings
          ? await runtime.timings.time("contract-flowable-tab-snapshot", () => collectPageSnapshotFromUrl(ref.detailUrl).catch(() => null), {
              detailId: ref.detailId || "",
              sourceInstIdPreserved: !!ref.sourceInstId
            })
          : await collectPageSnapshotFromUrl(ref.detailUrl).catch(() => null);
      const baseFacts = flowablePageSnapshot
        ? buildFlowableContractBaseFacts(detail, ref, contractLink, flowablePageSnapshot)
        : apiBaseFacts;
      const flowableAttachments = mergeAttachmentCandidates(
        apiAttachments,
        Array.isArray(flowablePageSnapshot?.attachments) ? flowablePageSnapshot.attachments : []
      );
      return runtime?.timings
        ? await runtime.timings.time(
            "contract-detail-analysis",
            () => analyzeContractDetail(ref, flowableAttachments, baseFacts, target, "合同页", onProgress, flowablePageSnapshot, { runtime }),
            {
              detailId: ref.detailId || "",
              mode: "flowable",
              attachmentCount: flowableAttachments.length,
              pageSnapshotUsed: !!flowablePageSnapshot
            }
          )
        : analyzeContractDetail(ref, flowableAttachments, baseFacts, target, "合同页", onProgress, flowablePageSnapshot, { runtime });
    }

      let detail = null;
      let historyApiError = "";
      const loadHistoryDetail = async () => {
        try {
          return await fetchHistoryDetail(ref, baseUrl);
        } catch (error) {
          historyApiError = normalizeError(error);
          return null;
        }
      };
      detail = runtime?.timings
        ? await runtime.timings.time("contract-history-api", loadHistoryDetail, {
            detailId: ref.detailId || "",
            sourceInstIdPreserved: !!ref.sourceInstId
          })
        : await loadHistoryDetail();
      const historyPageSnapshot = runtime?.timings
        ? await runtime.timings.time("contract-history-tab-snapshot", () => collectPageSnapshotFromUrl(ref.detailUrl).catch(() => null), {
            detailId: ref.detailId || "",
            sourceInstIdPreserved: !!ref.sourceInstId
          })
        : await collectPageSnapshotFromUrl(ref.detailUrl).catch(() => null);
      if (!detail && !historyPageSnapshot) {
        throw new Error(historyApiError || "历史合同详情读取失败");
      }
      const mainForm = detail?.formData?.mainForm || {};
      const baseFacts = {
        processCode: firstNonEmpty(findHistoryField(mainForm, "合同编号", "采购合同编号")),
        processTitle: firstNonEmpty(
          findHistoryField(mainForm, "合同名称"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "合同名称"),
          contractLink.title
        ),
        counterpartyCompany: firstNonEmpty(
          findHistoryField(mainForm, "供应商名称", "乙方", "对方公司"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "供应商名称", "乙方", "对方公司")
        ),
        contractAccountNo: firstLikelyBankAccount(findHistoryField(mainForm, "收款账号", "银行账号", "开户账号")),
        effectiveStart: firstNonEmptyDate(
          findHistoryField(mainForm, "合同开始日", "开始日"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "合同开始日", "开始日")
        ),
        effectiveEnd: firstNonEmptyDate(
          findHistoryField(mainForm, "合同结束日期", "结束日期"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "合同结束日期", "结束日期")
        ),
        paymentTerms: firstMeaningfulText(
          findHistoryField(mainForm, "付款方式", "付款条件", "验收标准"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "付款方式", "付款条件", "验收标准")
        ),
        sourceName: firstNonEmpty(
          findHistoryField(mainForm, "合同名称"),
          findFieldValueFromPairs(historyPageSnapshot?.fieldPairs, "合同名称"),
          contractLink.title
        ),
        sourceUrl: ref.detailUrl
      };
      const historyAttachments = mergeAttachmentCandidates(
        detail ? buildHistoryAttachmentList(detail) : [],
        Array.isArray(historyPageSnapshot?.attachments) ? historyPageSnapshot.attachments : []
      );
      return runtime?.timings
        ? await runtime.timings.time(
            "contract-detail-analysis",
            () => analyzeContractDetail(ref, historyAttachments, baseFacts, target, "合同页", onProgress, historyPageSnapshot, { runtime }),
            {
              detailId: ref.detailId || "",
              mode: "history",
              attachmentCount: historyAttachments.length,
              pageSnapshotUsed: !!historyPageSnapshot
            }
          )
        : analyzeContractDetail(ref, historyAttachments, baseFacts, target, "合同页", onProgress, historyPageSnapshot, { runtime });
  } catch (error) {
    return {
      ref,
      facts: {
        sourceName: contractLink.title || "",
        sourceUrl: ref.detailUrl || "",
        paymentTerms: `合同页读取失败：${normalizeError(error)}`
      },
      matches: { amount: null, company: null, account: null },
      summary: {
        ...emptyContractSummary(),
        mode: "error",
        statusText: "读取失败",
        errorText: `合同页读取失败：${normalizeError(error)}`
      },
      processing: emptyContractProcessing("read_failed", `合同页读取失败：${normalizeError(error)}`)
    };
  }
}

function buildFlowableContractBaseFacts(detail, ref, contractLink, flowablePageSnapshot = null) {
  const pagePairs = Array.isArray(flowablePageSnapshot?.fieldPairs) ? flowablePageSnapshot.fieldPairs : [];
  return {
    processCode: firstNonEmpty(
      detail.processCode,
      detail.flowFormData?.EXTARGETNODEID,
      findFieldValueFromPairs(pagePairs, "合同流程编号", "合同编号", "流程编号")
    ),
    processTitle: firstNonEmpty(
      detail.flowFormData?.processTitleInput,
      detail.flowFormData?.NCBILLCODE,
      findFieldValueFromPairs(pagePairs, "合同用章申请", "合同名称", "合同标题", "流程标题")
    ),
    counterpartyCompany: firstNonEmpty(
      detail.flowFormData?.HT010,
      findFieldValueFromPairs(pagePairs, "合同相对方", "供应商名称", "乙方", "对方公司")
    ),
    contractAccountNo: firstLikelyBankAccount(
      detail.flowFormData?.HT013,
      detail.flowFormData?.HT014,
      detail.flowFormData?.ACCOUNT,
      detail.flowFormData?.bankAccount,
      findFieldValueFromPairs(pagePairs, "收款账号", "银行账号", "开户账号", "收款账户", "银行账户", "账户号")
    ),
    effectiveStart: firstNonEmptyDate(
      detail.flowFormData?.HT032,
      findFieldValueFromPairs(pagePairs, "合同开始日期", "合同开始日", "开始日", "生效日期", "生效日")
    ),
    effectiveEnd: firstNonEmptyDate(
      detail.flowFormData?.HT033,
      findFieldValueFromPairs(pagePairs, "合同结束日期", "合同结束日", "结束日期", "截止日期", "终止日期")
    ),
    paymentTerms: firstMeaningfulText(
      detail.flowFormData?.HT030,
      detail.flowFormData?.HT031,
      detail.flowFormData?.HT034,
      detail.flowFormData?.HT035,
      findFieldValueFromPairs(pagePairs, "付款条件", "付款方式", "结算方式", "付款条款", "验收标准")
    ),
    sourceName: normalizeRelatedSourceName(
      flowablePageSnapshot,
      contractLink.title,
      ref,
      detail.flowFormData?.processTitleInput,
      findFieldValueFromPairs(pagePairs, "合同用章申请", "合同名称", "合同标题", "流程标题"),
      detail.processCode
    ),
    sourceUrl: ref.detailUrl
  };
}

function isFlowableContractApiSufficient(baseFacts, attachments, target) {
  const needsCompany = !!cleanText(target?.payeeCompany || "");
  const needsAccount = !!cleanText(target?.payeeAccount || "");
  return !!(
    (!needsCompany || baseFacts?.counterpartyCompany) &&
    (!needsAccount || baseFacts?.contractAccountNo) &&
    (baseFacts?.effectiveStart || baseFacts?.effectiveEnd) &&
    baseFacts?.paymentTerms &&
    Array.isArray(attachments) &&
    attachments.length > 0
  );
}

async function analyzeContractDetail(ref, attachments, baseFacts, target, sourceLabelPrefix, onProgress, pageSnapshot = null, options = {}) {
  const normalizedContractAttachments = normalizeAttachmentCandidates(attachments || []);
  const contractAttachmentDisplay = summarizeAttachmentDisplay(normalizedContractAttachments);
  attachments = normalizedContractAttachments;
  const facts = { ...baseFacts };
  const pageSnapshotFallback = buildContractSnapshotFallback(pageSnapshot, ref?.detailUrl || "", sourceLabelPrefix);
  const matches = {
    amount: amountMatchesPayment(facts.paymentTerms || "", target.paymentAmount)
      ? makeEvidence(`${sourceLabelPrefix}表单`, ref.detailUrl, formatAmount(target.paymentAmount), facts.paymentTerms || "")
      : null,
    company:
      companyMatchesPayment(facts.counterpartyCompany || "", target.payeeCompany) ||
      companyMatchesPayment(facts.paymentTerms || "", target.payeeCompany)
        ? makeEvidence(`${sourceLabelPrefix}表单`, ref.detailUrl, target.payeeCompany || "", facts.counterpartyCompany || facts.paymentTerms || "")
        : null,
    account:
      accountMatchesPayment(facts.contractAccountNo || "", target.payeeAccount) ||
      accountMatchesPayment(facts.paymentTerms || "", target.payeeAccount)
        ? makeEvidence(`${sourceLabelPrefix}表单`, ref.detailUrl, target.payeeAccount || "", facts.contractAccountNo || facts.paymentTerms || "")
        : null
  };

  const attachmentAnalysis = await analyzeAttachmentList(attachments || [], target, `${sourceLabelPrefix}附件`, onProgress, "contract-attachments", { runtime: options?.runtime });

  if (!facts.effectiveStart) facts.effectiveStart = pageSnapshotFallback.facts.effectiveStart || "";
  if (!facts.effectiveEnd) facts.effectiveEnd = pageSnapshotFallback.facts.effectiveEnd || "";
  if (!facts.effectiveStart) facts.effectiveStart = attachmentAnalysis.contractFacts.effectiveStart || "";
  if (!facts.effectiveEnd) facts.effectiveEnd = attachmentAnalysis.contractFacts.effectiveEnd || "";
  if (!facts.paymentTerms) facts.paymentTerms = pageSnapshotFallback.facts.paymentTerms || "";
  if (!facts.paymentTerms) facts.paymentTerms = attachmentAnalysis.contractFacts.paymentTerms || "";
  if (!facts.paymentTerms) facts.paymentTerms = deriveFallbackContractTerms(attachmentAnalysis.referenceEntries || [], target);
  if (!facts.paymentTerms) facts.paymentTerms = "已进入合同页，但未提取到明确付款条件";
  if (!facts.sourceName) facts.sourceName = pageSnapshotFallback.facts.sourceName || "";
  if (!facts.sourceName) facts.sourceName = attachmentAnalysis.contractFacts.sourceName || ref.detailUrl;
  if (!facts.sourceUrl) facts.sourceUrl = pageSnapshotFallback.facts.sourceUrl || "";
  if (!facts.sourceUrl) facts.sourceUrl = attachmentAnalysis.contractFacts.sourceUrl || ref.detailUrl;

  const candidateSources = [];
  if (facts.paymentTerms) {
    candidateSources.push({
      sourceName: `${sourceLabelPrefix}表单`,
      sourceUrl: ref.detailUrl,
      text: facts.paymentTerms
    });
  }
  candidateSources.push(...(pageSnapshotFallback.referenceEntries || []));
  candidateSources.push(...(attachmentAnalysis.referenceEntries || []));

  const clauseCandidates = buildContractClauseCandidates(candidateSources);
  let summary = generateContractSummary(clauseCandidates, facts);
  summary = {
    ...summary,
    evidenceClauses: selectSummaryEvidenceClauses(summary.evidenceClauses, clauseCandidates),
    errorText: ""
  };

  return {
    ref,
    facts,
    summary,
    attachmentAnalysis,
    matches: {
      amount: matches.amount || attachmentAnalysis.matches.amount,
      company: matches.company || attachmentAnalysis.matches.company,
      account: matches.account || attachmentAnalysis.matches.account
    },
    processing: {
      pageStatus: "read_ok",
      pageStatusText: "已进入合同页",
      attachmentDiscoveredCount: contractAttachmentDisplay.count,
      attachmentSupportedCount: attachmentAnalysis.stats.supportedCount,
      attachmentScannedCount: attachmentAnalysis.stats.scannedCount,
      attachmentDownloadedCount: attachmentAnalysis.stats.downloadedCount,
      attachmentParsedCount: attachmentAnalysis.stats.parsedCount,
      attachmentErrorCount: attachmentAnalysis.stats.errorCount,
      attachmentNames: contractAttachmentDisplay.names,
      periodSource: summarizeContractFactSource(
        baseFacts.effectiveStart || baseFacts.effectiveEnd,
        attachmentAnalysis.contractFacts.effectiveStart || attachmentAnalysis.contractFacts.effectiveEnd,
        attachmentAnalysis.contractFacts.sourceName,
        "合同页表单"
      ),
      paymentTermsSource: summarizeContractFactSource(
        baseFacts.paymentTerms,
        attachmentAnalysis.contractFacts.paymentTerms,
        attachmentAnalysis.contractFacts.sourceName,
        "合同页表单"
      ),
      companySource: summarizeContractFactSource(
        baseFacts.counterpartyCompany,
        attachmentAnalysis.matches.company?.matchedValue,
        attachmentAnalysis.matches.company?.sourceName,
        "合同页表单"
      ),
      accountSource: summarizeContractFactSource(
        baseFacts.contractAccountNo,
        attachmentAnalysis.matches.account?.matchedValue,
        attachmentAnalysis.matches.account?.sourceName,
        "合同页表单"
      ),
      clauseCandidateCount: clauseCandidates.length,
      summaryStatusText: summary.statusText || "未生成",
      summaryErrorText: summary.errorText || ""
    }
  };
}

async function analyzeAcceptanceLinks(relatedLinks, target, baseUrl, onProgress) {
  const acceptanceLink = (relatedLinks || []).find((item) => item.relation === "acceptance");
  if (!acceptanceLink) {
    return { statement: "尚未发现明确的验收来源", sourceName: "", sourceUrl: "" };
  }

  const ref = parseProcessRef(acceptanceLink.url, "acceptance");
  if (!ref) {
    return { statement: "验收链接格式暂未识别", sourceName: acceptanceLink.title || "", sourceUrl: acceptanceLink.url || "" };
  }

  reportProgress(onProgress, "acceptance-open", "正在读取验收页", acceptanceLink.title || ref.detailUrl || "验收入口");

  try {
    const detail = ref.mode === "flowable" ? await fetchFlowableDetail(ref, baseUrl) : await fetchHistoryDetail(ref, baseUrl);
    const titles =
      ref.mode === "flowable"
        ? buildAttachmentTitles(detail)
        : buildHistoryAttachmentList(detail)
            .map((item) => item.name)
            .filter(Boolean);
    return {
      statement: acceptanceTitleMatch(target, titles),
      sourceName: acceptanceLink.title || "",
      sourceUrl: ref.detailUrl
    };
  } catch (error) {
    return {
      statement: `验收页读取失败：${normalizeError(error)}`,
      sourceName: acceptanceLink.title || "",
      sourceUrl: ref.detailUrl || ""
    };
  }
}

function acceptanceTitleMatch(target, titles) {
  if (!titles.length) {
    return "验收流程未提取到附件标题";
  }

  const paymentTitle = cleanText(target?.processTitle || "").replace(/\s+/g, "");
  const amountText = target?.paymentAmount ? String(Math.round(Number(String(target.paymentAmount).replace(/[^\d.]/g, "") || 0))) : "";
  const company = cleanText(target?.payeeCompany || "").replace(/\s+/g, "");
  const matched = titles.find((title) => {
    const normalized = cleanText(title).replace(/\s+/g, "");
    let score = 0;
    if (paymentTitle && normalized.includes(paymentTitle.slice(0, Math.min(paymentTitle.length, 8)))) score += 1;
    if (amountText && normalized.includes(amountText)) score += 1;
    if (company && normalized.includes(company.slice(0, Math.min(company.length, 6)))) score += 1;
    return score >= 2;
  });

  return matched ? `已发现验收标题与当前付款单相符：${matched}` : "验收标题暂未明显匹配当前付款单";
}

async function analyzeAttachmentList(attachments, target, sourceLabelPrefix, onProgress, progressPhase, options = {}) {
  const normalizedAttachments = normalizeAttachmentCandidates(attachments || []);
  const items = normalizedAttachments
    .filter((item) => supportsAttachmentTextExtraction(item?.name, item?.url))
    .sort((left, right) => {
      const priorityDiff = attachmentPreScanPriority(left) - attachmentPreScanPriority(right);
      if (priorityDiff !== 0) return priorityDiff;
      return attachmentSizeHint(left) - attachmentSizeHint(right);
    })
    .slice(0, 12);

  const contractFacts = {
    effectiveStart: "",
    effectiveEnd: "",
    paymentTerms: "",
    sourceName: "",
    sourceUrl: ""
  };
  const matches = { amount: null, company: null, account: null };
  const matchMeta = { amount: null, company: null, account: null };
  const referenceEntries = [];
  const errors = [];
  const stats = {
    discoveredCount: normalizedAttachments.length,
    supportedCount: items.length,
    scannedCount: 0,
    downloadedCount: 0,
    parsedCount: 0,
    extractedEntryCount: 0,
    cacheHitCount: 0,
    errorCount: 0
  };

  if (items.length === 0) {
    reportProgress(onProgress, progressPhase, `正在查看${sourceLabelPrefix}`, "当前阶段没有可展示的概览");
    return { matches, contractFacts, referenceEntries, errors, stats };
  }

  reportProgress(onProgress, progressPhase, `正在查看${sourceLabelPrefix}`, `准备扫描 ${items.length} 个附件`);

  const batchSize = Math.min(3, Math.max(1, Number(options?.batchSize) || 3));
  for (let index = 0; index < items.length;) {
    const batch = items.slice(index, index + batchSize);
    const runBatch = () => Promise.all(
      batch.map(async (attachment, offset) => {
        const displayIndex = index + offset + 1;
        stats.scannedCount += 1;
        reportProgress(
          onProgress,
          progressPhase,
          `正在查看${sourceLabelPrefix}`,
          `正在扫描 ${displayIndex}/${items.length}: ${attachment?.name || "未命名附件"}`
        );

        try {
          const extractionOptions = buildAttachmentExtractionOptions(attachment, matches, options?.knownMatches || {});
          const result = await getAttachmentReferenceEntries(attachment, options?.runtime, target, extractionOptions);
          if (result.downloaded) {
            stats.downloadedCount += 1;
          }
          if (result.fromCache) {
            stats.cacheHitCount += 1;
          }
          const entries = Array.isArray(result.entries) ? result.entries : [];
          if (entries.length > 0) {
            stats.parsedCount += 1;
            stats.extractedEntryCount += entries.length;
          }
          return { attachment, entries };
        } catch (error) {
          stats.errorCount += 1;
          errors.push({
            attachmentName: attachment?.name || "",
            attachmentUrl: attachment?.url || "",
            error: normalizeError(error)
          });
          return null;
        }
      })
    );
    const batchResults = options?.runtime?.timings
      ? await options.runtime.timings.time("attachment-batch", runBatch, {
          sourceLabelPrefix,
          batchStart: index + 1,
          batchSize: batch.length,
          totalCount: items.length
        })
      : await runBatch();

    for (const result of batchResults) {
      if (!result) {
        continue;
      }
      const { attachment, entries } = result;
      for (const entry of entries) {
        const text = cleanText(entry.text);
        if (!text) {
          continue;
        }
        const detectedRole = detectAttachmentRole(attachment, text);
        const looksLikeContractText = /合同|协议|甲方|乙方|签署日期|付款条件|付款方式|结算方式/i.test(text);
        const sourceName = `${sourceLabelPrefix}: ${attachment.name || "未命名附件"}`;
        referenceEntries.push({
          sourceName,
          sourceUrl: attachment.url || "",
          attachmentName: attachment.name || "",
          role: detectedRole?.role || "other",
          text
        });

        if (!contractFacts.sourceName && (/(?:合同|协议)/i.test(attachment.name || "") || looksLikeContractText)) {
          const period = extractContractPeriod(text);
          const terms = extractPaymentTerms(text);
          if (period.start || period.end || terms) {
            contractFacts.effectiveStart = period.start;
            contractFacts.effectiveEnd = period.end;
            contractFacts.paymentTerms = terms;
            contractFacts.sourceName = attachment.name || "";
            contractFacts.sourceUrl = attachment.url || "";
          }
        }

        if (amountMatchesPayment(text, target.paymentAmount)) {
          const invoiceTypeMatch = pickFirstNormalizedValue(
            [text, attachment?.name || "", attachment?.url || ""],
            normalizeInvoiceSubtypeLabel
          );
          considerEvidence(
            matches,
            matchMeta,
            "amount",
            makeEvidence(
              sourceName,
              attachment.url || "",
              formatAmount(target.paymentAmount),
              snippetAround(text, String(target.paymentAmount || "")),
              {
                invoiceTypeLabel: invoiceTypeMatch.label || "",
                invoiceTypeRaw: invoiceTypeMatch.raw || "",
                evidenceRole: detectedRole?.role || "other"
              }
            ),
            detectedRole,
            attachment
          );
        }

        if (companyMatchesPayment(text, target.payeeCompany)) {
          considerEvidence(
            matches,
            matchMeta,
            "company",
            makeEvidence(sourceName, attachment.url || "", target.payeeCompany || "", snippetAround(text, target.payeeCompany)),
            detectedRole,
            attachment
          );
        }

        if (accountMatchesPayment(text, target.payeeAccount)) {
          considerEvidence(
            matches,
            matchMeta,
            "account",
            makeEvidence(sourceName, attachment.url || "", target.payeeAccount || "", snippetAround(text, target.payeeAccount)),
            detectedRole,
            attachment
          );
        }
      }
    }
    index += batch.length;

    const hasAmountEvidence = matches.amount || options?.knownMatches?.amount;
    const hasCompanyEvidence = matches.company || options?.knownMatches?.company;
    const hasAccountEvidence = matches.account || options?.knownMatches?.account;
    const amountRoleIsStrong = matches.amount ? rolePriority(matchMeta.amount?.role) >= rolePriority("invoice") : !!options?.knownMatches?.amount;
    const companyRoleIsStrong = matches.company ? rolePriority(matchMeta.company?.role) >= rolePriority("invoice") : !!options?.knownMatches?.company;

    if (hasAmountEvidence && hasCompanyEvidence && hasAccountEvidence && contractFacts.sourceName && amountRoleIsStrong && companyRoleIsStrong) {
      break;
    }
  }

  return { matches, contractFacts, referenceEntries, errors, stats };
}

function emptyContractProcessing(pageStatus, pageStatusText) {
  return {
    pageStatus,
    pageStatusText,
    attachmentDiscoveredCount: 0,
    attachmentSupportedCount: 0,
    attachmentScannedCount: 0,
    attachmentDownloadedCount: 0,
    attachmentParsedCount: 0,
    attachmentErrorCount: 0,
    attachmentNames: [],
    periodSource: "",
    paymentTermsSource: "",
    companySource: "",
    accountSource: "",
    clauseCandidateCount: 0,
    summaryStatusText: "未生成",
    summaryErrorText: ""
  };
}

function buildAttachmentOnlyContractResult(pageAttachmentAnalysis, inventories, target) {
  const contractFacts = pageAttachmentAnalysis?.contractFacts || {};
  const contractAttachments = Array.isArray(inventories?.contractAttachments) ? inventories.contractAttachments : [];
  const referenceEntries = Array.isArray(pageAttachmentAnalysis?.referenceEntries) ? pageAttachmentAnalysis.referenceEntries : [];
  const contractEntries = referenceEntries.filter((item) => item.role === "contract");

  if (!contractFacts.sourceName && contractAttachments.length === 0) {
    return {
      facts: {},
      summary: emptyContractSummary(),
      processing: emptyContractProcessing("not_found", "尚未发现明确的合同来源")
    };
  }

  const attachmentNames = contractAttachments
    .map((item) => cleanText(item?.name || ""))
    .filter(Boolean)
    .slice(0, 6);

  const attachmentFacts = {
    effectiveStart: contractFacts.effectiveStart || "",
    effectiveEnd: contractFacts.effectiveEnd || "",
    paymentTerms: contractFacts.paymentTerms || deriveFallbackContractTerms(referenceEntries, target) || "",
    sourceName: contractFacts.sourceName || attachmentNames[0] || "",
    sourceUrl: contractFacts.sourceUrl || contractEntries[0]?.sourceUrl || contractAttachments[0]?.url || ""
  };
  const candidateSources = [];
  if (attachmentFacts.paymentTerms) {
    candidateSources.push({
      sourceName: attachmentFacts.sourceName || "付款页合同附件",
      sourceUrl: attachmentFacts.sourceUrl || "",
      text: attachmentFacts.paymentTerms
    });
  }
  candidateSources.push(...contractEntries);
  const clauseCandidates = buildContractClauseCandidates(candidateSources);
  const summary = deriveLocalContractSummary(clauseCandidates, attachmentFacts);

  return {
    facts: attachmentFacts,
    summary,
    processing: {
      pageStatus: "attachment_only",
      pageStatusText: "已在付款页附件中发现合同来源",
      attachmentDiscoveredCount: contractAttachments.length,
      attachmentSupportedCount: contractAttachments.length,
      attachmentScannedCount: contractAttachments.length,
      attachmentDownloadedCount: contractEntries.length,
      attachmentParsedCount: contractEntries.length,
      attachmentErrorCount: 0,
      attachmentNames,
      periodSource: attachmentFacts.effectiveStart || attachmentFacts.effectiveEnd ? attachmentFacts.sourceName || "合同附件" : "未提供",
      paymentTermsSource: attachmentFacts.paymentTerms ? attachmentFacts.sourceName || "合同附件" : "未提供",
      companySource: "",
      accountSource: "",
      clauseCandidateCount: clauseCandidates.length,
      summaryStatusText: summary.statusText || "未生成",
      summaryErrorText: summary.errorText || ""
    }
  };
}

function shouldPreferAttachmentOnlyContract(contractResult, attachmentOnlyContract) {
  if (!hasUsableAttachmentOnlyContract(attachmentOnlyContract)) {
    return false;
  }
  if (!contractResult?.ref) {
    return true;
  }
  if (!hasUsableContractResult(contractResult)) {
    return true;
  }
  return false;
}

function hasUsableAttachmentOnlyContract(result) {
  const paymentText = cleanText(result?.summary?.paymentTermsSummary || result?.facts?.paymentTerms || "");
  const clauseCount = Number(result?.processing?.clauseCandidateCount || 0);
  return !!paymentText && !isContractPlaceholderText(paymentText) && clauseCount > 0;
}

function hasUsableContractResult(result) {
  const paymentText = cleanText(result?.summary?.paymentTermsSummary || result?.facts?.paymentTerms || "");
  if (!paymentText || isContractPlaceholderText(paymentText)) {
    return false;
  }
  return true;
}

function isContractPlaceholderText(text) {
  const value = cleanText(text || "");
  if (!value) {
    return true;
  }
  return /未提取到明确付款条件|待进入合同页读取|尚未发现明确的合同来源|未从合同条款中提取到明确付款信息/.test(value);
}

function emptyContractSummary() {
  return {
    mode: "none",
    statusText: "未生成",
    paymentMode: "",
    paymentTermsSummary: "",
    acceptanceRequirement: "",
    invoiceRequirement: "",
    paymentDeadline: "",
    installments: "",
    accountChangeRequirement: "",
    taxRate: "",
    capAmount: "",
    evidenceClauseIds: [],
    evidenceClauses: [],
    paymentClauseEvidence: [],
    termClauseEvidence: [],
    restrictionHints: [],
    conflictHints: [],
    detectedContractTypes: [],
    provider: buildContractSummaryProviderMeta("idle", "默认仅使用本地规则整理合同摘要"),
    errorText: ""
  };
}

function selectSummaryEvidenceClauses(selectedIds, candidates) {
  const items = Array.isArray(candidates) ? candidates : [];
  if (!Array.isArray(selectedIds)) {
    return items.slice(0, 3);
  }
  const picked = selectedIds
    .map((clauseId) => items.find((item) => item.clauseId === clauseId))
    .filter(Boolean);
  return picked.length > 0 ? picked.slice(0, 3) : items.slice(0, 3);
}

function summarizeContractFactSource(formValue, attachmentValue, attachmentSourceName, fallbackFormLabel) {
  if (attachmentValue) {
    return attachmentSourceName || "合同附件";
  }
  if (formValue) {
    return fallbackFormLabel;
  }
  return "未提供";
}

function deriveFallbackContractTerms(referenceEntries, target) {
  const monthlyFeeSentence = findContractReferenceSentence(
    referenceEntries,
    (sentence) =>
      /monthly|rent|fee/i.test(sentence) &&
      (/费用|服务|报价/.test(sentence) || amountMatchesPayment(sentence, target?.paymentAmount))
  );
  const amountSentence =
    findContractReferenceSentence(
      referenceEntries,
      (sentence) => amountMatchesPayment(sentence, target?.paymentAmount) && /费用|月租|月费|报价|含税|服务/.test(sentence)
    );
  const termSentence = findContractReferenceSentence(
    referenceEntries,
    (sentence) => /auto|renew|continue|term/i.test(sentence)
  );
  const originalContractSentence =
    findContractReferenceSentence(referenceEntries, (sentence) => /original|contract|agreement/i.test(sentence)) ||
    findContractReferenceSentence(
      referenceEntries,
      (sentence) => /supplement|agreement|contract/i.test(sentence)
    );

  const parts = [];
  if (originalContractSentence) parts.push(originalContractSentence);
  if (amountSentence) parts.push(amountSentence);
  if (monthlyFeeSentence && !/monthly|rent|fee/i.test(amountSentence || "")) parts.push(monthlyFeeSentence);
  if (!amountSentence && termSentence) parts.push(termSentence);

  return dedupeTextParts(parts).join("；");
}

function findContractReferenceSentence(referenceEntries, matcher) {
  for (const entry of Array.isArray(referenceEntries) ? referenceEntries : []) {
    const text = cleanText(entry?.text || "");
    if (!text) {
      continue;
    }

    const sentences = text
      .split(/[銆傦紱;\n]/)
      .map((item) => cleanText(item))
      .filter((item) => item.length >= 6);

    const matchedSentence = sentences.find((sentence) => {
      try {
        return matcher(sentence);
      } catch {
        return false;
      }
    });
    if (matchedSentence) {
      return matchedSentence;
    }
  }
  return "";
}

function dedupeTextParts(parts) {
  const result = [];
  const seen = new Set();
  for (const part of Array.isArray(parts) ? parts : []) {
    const text = cleanText(part);
    if (!text) {
      continue;
    }
    const key = normalizeCompareText(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function considerEvidence(matches, matchMeta, key, evidence, detectedRole, attachment) {
  const nextPriority = rolePriority(detectedRole?.role);
  const nextScore = Number.isFinite(detectedRole?.score) ? detectedRole.score : nextPriority;
  const current = matchMeta[key];
  if (
    !current ||
    nextPriority > current.priority ||
    (nextPriority === current.priority && nextScore > current.score) ||
    (nextPriority === current.priority && nextScore === current.score && scoreAttachment(attachment) > current.attachmentScore)
  ) {
    matches[key] = evidence;
    matchMeta[key] = {
      role: detectedRole?.role || "other",
      priority: nextPriority,
      score: nextScore,
      attachmentScore: scoreAttachment(attachment)
    };
  }
}

function buildAmountVerification(target, inventories, matched, invoiceTypeCheck) {
  if (!target.paymentAmount) {
    return createVerificationItem(
      "amount",
      "金额一致",
      "warn",
      "未从付款单页识别到付款金额",
      "",
      "",
      "",
      "付款单金额缺失，无法用外部证据核对"
    );
  }

  if (matched) {
    const invoiceTypePass = invoiceTypeCheck?.status === "pass";
    const pageShowsVatInvoice = invoiceTypeCheck?.pageInvoiceLabel === "增值税发票";
    const ocrInvoiceTypeLabel = firstNonEmpty(invoiceTypeCheck?.invoiceTypeLabel);
    const statement = matched.multiInvoiceAggregate
      ? invoiceTypePass
        ? `已按${matched.sourceName}核对到相同金额，且每张发票均为增值税专用发票、页面显示为增值税发票`
        : pageShowsVatInvoice
          ? `已按${matched.sourceName}核对到相同金额，但只有页面显示为增值税发票还不够，需每张参与核对的发票都经OCR识别为增值税专用发票`
          : `已按${matched.sourceName}核对到相同金额，但请确认每张发票票种`
      : invoiceTypePass
        ? `已在${matched.sourceName}中找到相同金额，且票面为增值税专用发票、页面显示为增值税发票`
        : pageShowsVatInvoice
          ? ocrInvoiceTypeLabel && ocrInvoiceTypeLabel !== "未识别"
            ? `已在${matched.sourceName}中找到相同金额，但OCR识别票面为${ocrInvoiceTypeLabel}，未达到增值税专用发票通过条件`
            : `已在${matched.sourceName}中找到相同金额，但只有页面显示为增值税发票还不够，需OCR识别出增值税专用发票`
          : `已在${matched.sourceName}中找到相同金额，但请确认发票类型`;
    return createVerificationItem(
      "amount",
      "金额一致",
      invoiceTypePass ? "pass" : "warn",
      statement,
      matched.sourceName,
      matched.sourceUrl,
      matched.matchedValue,
      firstNonEmpty(invoiceTypeCheck?.snippet, matched.snippet)
    );
  }

  return createVerificationItem(
    "amount",
    "金额一致",
    "warn",
    hasInvoiceSource(inventories) ? "发票来源未命中金额，验收页及合同页附件作为补充来源" : "尚未发现可用于核实金额的外部来源",
    "",
    "",
    formatAmount(target.paymentAmount),
    `付款单金额：${formatAmount(target.paymentAmount)}`
  );
}

function buildCompanyVerification(target, inventories, matched) {
  if (!target.payeeCompany) {
    return createVerificationItem(
      "company",
      "收款公司名称一致",
      "warn",
      "未从付款单页识别收款公司名称",
      "",
      "",
      "",
      "付款单收款公司缺失，无法用外部证据核对"
    );
  }

  if (matched) {
    return createVerificationItem(
      "company",
      "收款公司名称一致",
      "pass",
      `已在${matched.sourceName}中找到相同收款公司`,
      matched.sourceName,
      matched.sourceUrl,
      matched.matchedValue,
      matched.snippet
    );
  }

  const hasExternal =
    hasInvoiceSource(inventories) ||
    inventories.contractAttachments.length > 0 ||
    inventories.bankChangeAttachments.length > 0 ||
    inventories.contractLinks.length > 0;

  return createVerificationItem(
    "company",
    "收款公司名称一致",
    "warn",
    hasExternal ? "已发现外部来源，但尚未命中一致的收款公司名称" : "尚未发现可用于核实收款公司的外部来源",
    "",
    "",
    target.payeeCompany,
    `付款单收款公司：${target.payeeCompany}`
  );
}

function buildAccountVerification(target, inventories, matched) {
  if (!target.payeeAccount) {
    return createVerificationItem(
      "account",
      "收款账号一致",
      "warn",
      "未从付款单页识别收款账号",
      "",
      "",
      "",
      "付款单收款账号缺失，无法用外部证据核对"
    );
  }

  if (matched) {
    return createVerificationItem(
      "account",
      "收款账号一致",
      "pass",
      `已在${matched.sourceName}中找到相同收款账号`,
      matched.sourceName,
      matched.sourceUrl,
      matched.matchedValue,
      matched.snippet
    );
  }

  const hasInvoice = hasInvoiceSource(inventories);
  const hasFallback =
    inventories.bankChangeAttachments.length > 0 ||
    inventories.contractAttachments.length > 0 ||
    inventories.contractLinks.length > 0;

  return createVerificationItem(
    "account",
    "收款账号一致",
    "warn",
    hasInvoice
      ? "付款页已识别收款账号，但发票/合同/附件未找到同账号，需人工确认"
      : hasFallback
        ? "付款页已识别收款账号，但合同/附件未找到同账号，需人工确认"
        : "付款页已识别收款账号，但尚未发现可用于核实账号的外部来源",
    "付款单页",
    "",
    target.payeeAccount,
    `付款单收款账号：${target.payeeAccount}`
  );
}

function hasInvoiceSource(inventories) {
  return (inventories?.invoiceAttachments?.length || 0) > 0 || (inventories?.invoiceStructuredSources?.length || 0) > 0;
}

function dedupeAttachments(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items || []) {
    if (!item?.url) {
      continue;
    }
    const key = `${item.url}|${item.name || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function looksLikeRealAttachment(name, url) {
  if (!url || /^javascript:/i.test(url)) {
    return false;
  }
  return supportsAttachmentTextExtraction(name, url);
}

function isSyntheticAttachmentLink(url) {
  return /#\/oa\/contract\/cost/i.test(String(url || ""));
}

function attachmentNameQuality(name) {
  const value = cleanText(name || "");
  if (!value) return 0;
  let score = 1;
  if (/[\u4e00-\u9fff]/.test(value)) score += 4;
  if (/\.(pdf|docx?|xlsx?|csv|ofd|png|jpe?g|msg|eml|zip)$/i.test(value)) score += 2;
  if (/\s/.test(value)) score += 1;
  if (/^[a-f0-9]{32}(?:\.[a-z0-9]+)?$/i.test(value)) score -= 5;
  return score;
}

function summarizeAttachmentDisplay(attachments) {
  const names = [];
  const seen = new Set();
  const fallback = [];
  for (const item of attachments || []) {
    const name = cleanText(item?.name || "");
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isOpaqueAttachmentName(name)) {
      fallback.push(name);
      continue;
    }
    names.push(name);
  }

  const displayNames = (names.length > 0 ? names : fallback).slice(0, 6);
  return {
    count: names.length > 0 ? names.length : fallback.length,
    names: displayNames
  };
}

function isOpaqueAttachmentName(name) {
  const value = cleanText(name || "");
  if (!value) return true;
  return /^[a-f0-9]{32}(?:\.[a-z0-9]+)?$/i.test(value);
}

function pickPreferredTaxRate(localValue, llmValue) {
  const localText = cleanText(localValue || "");
  const llmText = cleanText(llmValue || "");
  const localHasRate = /\d+(?:\.\d+)?%/.test(localText);
  const llmHasRate = /\d+(?:\.\d+)?%/.test(llmText);

  if (llmHasRate) return llmText;
  if (localHasRate) return localText;
  if (!llmText || /unknown|not found/i.test(llmText)) return localText || llmText;
  return localText || llmText;
}

function pickPreferredCapAmount(localValue, llmValue) {
  const localText = cleanText(localValue || "");
  const llmText = cleanText(llmValue || "");
  const capPattern = /无金额上限|不设上限|上限不限|无封顶|(?:(上限|封顶|最高|不超过|累计|总额).{0,24}(?:人民币|RMB|CNY|￥|¥)?\s*\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元)?)/i;
  const localIsCap = capPattern.test(localText);
  const llmIsCap = capPattern.test(llmText);

  if (llmIsCap) return llmText;
  if (localIsCap) return localText;
  if (!llmText || /unknown|not found/i.test(llmText)) return localText || llmText;
  return localText || llmText;
}


