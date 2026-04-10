import {
  accountMatchesPayment,
  attachmentPreScanPriority,
  amountMatchesPayment,
  classifyAttachmentRole,
  cleanText,
  companyMatchesPayment,
  createVerificationItem,
  detectAttachmentRole,
  deriveBaseUrl,
  attachmentSizeHint,
  extractContractPeriod,
  extractPaymentTerms,
  firstLikelyBankAccount,
  firstMeaningfulText,
  firstNonEmpty,
  firstNonEmptyDate,
  formatAmount,
  makeEvidence,
  normalizeCompareText,
  normalizeError,
  parseAmount,
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
  parseProcessRef
} from "./detail.js";
import { buildContractLlmPreview, summarizeContractCandidatesWithLlm } from "./contract_llm.js";
import { buildContractClauseCandidates, deriveLocalContractSummary } from "./contract_terms.js";
import { extractMailEvidenceFromAttachment, extractReferenceTextsFromAttachment } from "./extract.js";

export const BUILD_TAG = "rebuild-phase5-related-docs-2026-04-09";

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

export async function analyzePageSnapshot(snapshot, tabId, onProgress = null) {
  const baseUrl = deriveBaseUrl(snapshot?.pageUrl);
  setRuntimeContext(baseUrl, tabId);

  reportProgress(onProgress, "payment-root", "正在读取付款单", "准备读取当前付款单详情和结构化字段");

  const rootRef = parseProcessRef(snapshot?.pageUrl || "", "payment");
  const rootDetail = rootRef?.mode === "flowable" ? await fetchFlowableDetail(rootRef, baseUrl) : null;
  const rootFacts = rootDetail ? extractFlowableFacts(rootDetail) : {};
  const target = mergePaymentTarget(snapshot?.paymentTarget || {}, rootFacts);
  const structuredInvoiceSources = rootDetail
    ? await buildFlowableInvoiceEvidenceList(rootDetail, baseUrl).catch(() => [])
    : [];
  const enrichedSnapshot = rootDetail
    ? {
        ...snapshot,
        attachments: dedupeAttachments([...(snapshot?.attachments || []), ...buildFlowableAttachmentList(rootDetail)]),
        relatedLinks: enrichRelatedLinks(snapshot?.relatedLinks || [], [
          ...extractKnownRefs(rootDetail, rootRef?.detailId || ""),
          ...discoverProcessRefs(rootDetail, rootRef?.detailId || "")
        ])
      }
    : snapshot;
  const normalizedAttachments = normalizeAttachmentCandidates([
    ...structuredInvoiceSources.map((item) => item.attachment).filter(Boolean),
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
  const structuredInvoiceMatches = analyzeStructuredInvoiceSources(structuredInvoiceSources, target);
  const pageAttachmentAnalysis = await analyzeAttachmentList(
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
    "page-attachments"
  );

  reportProgress(
    onProgress,
    "contract-link",
    "正在进入合同",
    inventories.contractLinks.length > 0 ? `已发现 ${inventories.contractLinks.length} 个合同入口` : "暂未发现明确的合同入口"
  );
  const contractResult = await analyzeContractLinks(enrichedSnapshot?.relatedLinks || [], target, baseUrl, onProgress);

  reportProgress(
    onProgress,
    "acceptance-link",
    "正在核对附件",
    inventories.acceptanceLinks.length > 0 ? `已发现 ${inventories.acceptanceLinks.length} 个验收入口` : "尚未发现明确验收入口"
  );
  const acceptanceDocs = await analyzeAcceptanceMailLinksMulti(enrichedSnapshot?.relatedLinks || [], target, baseUrl, onProgress);

  reportProgress(
    onProgress,
    "domestic-pr-link",
    "正在读取国内PR",
    inventories.domesticPrLinks.length > 0 ? `已发现 ${inventories.domesticPrLinks.length} 个国内PR入口` : "暂未发现明确的国内PR入口"
  );
  const domesticPrDocs = await analyzeDomesticPrLinksMulti(enrichedSnapshot?.relatedLinks || [], target, baseUrl, onProgress);

  reportProgress(
    onProgress,
    "purchase-order-link",
    "正在读取采购订单",
    inventories.purchaseOrderLinks.length > 0 ? `已发现 ${inventories.purchaseOrderLinks.length} 个采购订单入口` : "暂未发现明确的采购订单入口"
  );
  const purchaseOrderResult = await analyzePurchaseOrderLinks(enrichedSnapshot?.relatedLinks || [], target, baseUrl, onProgress);

  const matches = {
    amount: structuredInvoiceMatches.amount || pageAttachmentAnalysis.matches.amount || contractResult.matches.amount || null,
    company: structuredInvoiceMatches.company || pageAttachmentAnalysis.matches.company || contractResult.matches.company || null,
    account: structuredInvoiceMatches.account || pageAttachmentAnalysis.matches.account || contractResult.matches.account || null
  };

  reportProgress(onProgress, "summary", "正在汇总核对结果", "验收入口、核对结果和合同参考信息");

  const verificationItems = [
    buildAmountVerification(target, inventories, matches.amount),
    buildCompanyVerification(target, inventories, matches.company),
    buildAccountVerification(target, inventories, matches.account)
  ];

  const effectiveContractProcessing = contractResult.ref
    ? contractResult.processing
    : buildAttachmentOnlyContractProcessing(pageAttachmentAnalysis, inventories);

  const relatedDocuments = {
    domesticPr: domesticPrDocs[0] || null,
    domesticPrItems: domesticPrDocs,
    purchaseOrder: purchaseOrderResult,
    acceptance: acceptanceDocs[0] || null,
    acceptanceItems: acceptanceDocs,
    contract: buildContractRelatedDocument(contractResult, effectiveContractProcessing)
  };

  const overallStatus = verificationItems.some((item) => item.status === "fail")
    ? "fail"
    : verificationItems.some((item) => item.status === "warn")
      ? "warn"
      : "pass";

  reportProgress(onProgress, "done", "分析完成", "已生成主核对、关联摘要和合同参考信息");

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
      domesticPrLinkCount: inventories.domesticPrLinks.length,
      purchaseOrderLinkCount: inventories.purchaseOrderLinks.length,
      contractLinkCount: inventories.contractLinks.length,
      acceptanceLinkCount: inventories.acceptanceLinks.length,
      otherLinkCount: inventories.relatedLinks.length
    },
    verificationItems,
    relatedDocuments,
    contractReference: {
      effectiveStart: contractResult.facts.effectiveStart || pageAttachmentAnalysis.contractFacts.effectiveStart || "",
      effectiveEnd: contractResult.facts.effectiveEnd || pageAttachmentAnalysis.contractFacts.effectiveEnd || "",
      paymentTerms:
        contractResult.summary?.paymentTermsSummary ||
        contractResult.facts.paymentTerms ||
        pageAttachmentAnalysis.contractFacts.paymentTerms ||
        (contractResult.ref ? `宸插彂鐜板悎鍚屾潵婧愶細${contractResult.ref.detailUrl}` : "尚未发现明确的合同来源"),
      sourceName:
        contractResult.facts.sourceName ||
        pageAttachmentAnalysis.contractFacts.sourceName ||
        (contractResult.ref ? contractResult.ref.detailUrl : ""),
      sourceUrl:
        contractResult.facts.sourceUrl ||
        pageAttachmentAnalysis.contractFacts.sourceUrl ||
        (contractResult.ref ? contractResult.ref.detailUrl : "")
    },
    contractSummary: contractResult.summary || emptyContractSummary(),
    contractProcessing: effectiveContractProcessing || emptyContractProcessing("not_found", "尚未发现明确的合同来源"),
    acceptanceReference: acceptanceDocs[0] || null,
    evidencePool: inventories,
    debug: {
      snapshot: enrichedSnapshot,
      rootFacts,
      pageAttachmentAnalysis,
      domesticPrResult: domesticPrDocs,
      purchaseOrderResult,
      contractResult,
      acceptanceResult: acceptanceDocs
    }
  };
}

function mergePaymentTarget(primary, fallback) {
  return {
    ...primary,
    processCode: firstNonEmpty(primary.processCode, fallback.processCode),
    processTitle: firstNonEmpty(primary.processTitle, fallback.processTitle),
    paymentAmount: firstNonEmpty(primary.paymentAmount, fallback.paymentAmount, fallback.invoiceTotal),
    payeeCompany: firstNonEmpty(primary.payeeCompany, fallback.supplier, fallback.invoiceSupplier),
    payeeAccount: firstNonEmpty(primary.payeeAccount, fallback.accountNo, fallback.invoiceAccountNo),
    payeeBank: firstNonEmpty(primary.payeeBank, fallback.bankName),
    paymentDate: firstNonEmptyDate(primary.paymentDate, fallback.paymentDate)
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

function analyzeStructuredInvoiceSources(items, target) {
  const matches = { amount: null, company: null, account: null };

  for (const item of items || []) {
    const sourceText = cleanText(item?.sourceText || "");
    const sourceName = item?.sourceName || "浠樻椤靛彂绁ㄦ槑缁?";
    const sourceUrl = item?.sourceUrl || "";

    if (!matches.amount && amountMatchesPayment(sourceText, target.paymentAmount)) {
      matches.amount = makeEvidence(
        sourceName,
        sourceUrl,
        formatAmount(target.paymentAmount),
        sourceText || `价税合计：${item?.amount || ""}`
      );
    }

    if (!matches.company && companyMatchesPayment(sourceText, target.payeeCompany)) {
      matches.company = makeEvidence(
        sourceName,
        sourceUrl,
        target.payeeCompany || "",
        sourceText || `销售方：${item?.supplier || ""}`
      );
    }

    if (!matches.account && accountMatchesPayment(sourceText, target.payeeAccount)) {
      matches.account = makeEvidence(
        sourceName,
        sourceUrl,
        target.payeeAccount || "",
        sourceText || `收款账号：${item?.accountNo || ""}`
      );
    }
  }

  return matches;
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
      if (!current || attachmentNameQuality(name) > attachmentNameQuality(current.name || "")) {
        realByUrl.set(url, normalized);
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
    if (realNames.has(key) || placeholderSeen.has(key)) {
      continue;
    }
    placeholderSeen.add(key);
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

function enrichRelatedLinks(existingLinks, refs) {
  const deduped = [];
  const seen = new Set();

  for (const item of existingLinks || []) {
    const key = `${item.relation}|${item.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  for (const ref of refs || []) {
    const link = {
      relation: ref.relation,
      title: ref.detailUrl,
      url: ref.detailUrl
    };
    const key = `${link.relation}|${link.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
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
  return createRelatedDocumentBase({
    kind: "contract",
    title: "合同",
    status: hasSource ? "info" : "warn",
    statusText: hasSource ? "仅展示" : "未找到",
    displayOnly: true,
    sourceName,
    sourceUrl,
    statement: hasSource ? "沿用现有合同逻辑，仅展示不自动判断" : "尚未发现明确的合同来源",
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
  const { includePageSnapshot = true } = options || {};
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
    fallbackTitle,
    ref?.detailUrl
  );
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

  const fields = {
    processCode: await extractProcessFieldWithFallback(context, ["PR单号", "流程编号", "单号"]),
    costDept: await extractProcessFieldWithFallback(context, ["费用归属部门", "归属部门", "所属部门"]),
    costProject: await extractProcessFieldWithFallback(context, ["费用归属项目", "归属项目", "所属项目"]),
    purposeText: await extractProcessFieldWithFallback(context, ["订单用途说明", "用途说明", "费用用途说明", "申请事由", "采购用途"]),
    prAmount: await extractProcessFieldWithFallback(context, ["PR金额", "PR总额", "PR申请金额", "申请金额", "金额"])
  };
  if (!fields.purposeText && context.pageSnapshot) {
    fields.purposeText = buildGenericSubformSummary(context.pageSnapshot, 2, 4);
  }

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

async function analyzeDomesticPrLinksMulti(relatedLinks, target, baseUrl, onProgress) {
  const prLinks = pickRelatedLinks(relatedLinks, "domestic_pr");
  if (prLinks.length === 0) {
    return [
      createRelatedDocumentBase({
        kind: "domestic_pr",
        title: "国内PR",
        status: "warn",
        statusText: "未找到",
        displayOnly: true,
        statement: "尚未发现明确的国内PR来源",
        notes: ["仅展示，不自动判断"]
      })
    ];
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

    const fields = {
      processCode: await extractProcessFieldWithFallback(context, ["PR单号", "流程编号", "单号"]),
      costDept: await extractProcessFieldWithFallback(context, ["费用归属部门", "归属部门", "所属部门"]),
      costProject: await extractProcessFieldWithFallback(context, ["费用归属项目", "归属项目", "所属项目"]),
      purposeText: await extractProcessFieldWithFallback(context, ["订单用途说明", "用途说明", "费用用途说明", "申请事由", "采购用途"]),
      prAmount: await extractProcessFieldWithFallback(context, ["PR金额", "PR总额", "PR申请金额", "申请金额", "金额"]),
      requirementSummary: await buildRequirementSummaryWithFallback(context)
    };
    if (!fields.requirementSummary && context.pageSnapshot) {
      fields.requirementSummary = buildGenericSubformSummary(context.pageSnapshot);
    }
    if (!fields.purposeText && context.pageSnapshot) {
      fields.purposeText = buildGenericSubformSummary(context.pageSnapshot, 2, 4);
    }

    docs.push(
      createRelatedDocumentBase({
        kind: "domestic_pr",
        title: "国内PR",
        itemLabel,
        status: "info",
        statusText: "仅展示",
        displayOnly: true,
        sourceName: normalizeRelatedSourceName(context.pageSnapshot, prLink.title, ref, fields.processCode),
        sourceUrl: ref.detailUrl,
        statement: buildRelatedReadStatement("国内PR", context),
        fields,
        notes: ["仅展示，不自动判断", "PR金额仅作系统默认展示，不参与规则计算"]
      })
    );
  }

  return docs;
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

async function analyzePurchaseOrderLinks(relatedLinks, target, baseUrl, onProgress) {
  const orderLink = pickRelatedLink(relatedLinks, "purchase_order");
  if (!orderLink) {
    return createRelatedDocumentBase({
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
    processCode: await extractProcessFieldWithFallback(context, ["订单编号", "流程编号", "单号", "编号"]),
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
    checks.push(createOrderCheck("payment_not_exceed_order_amount", "付款金额不超过订单金额", "fail", "浠樻閲戦瓒呰繃璁㈠崟閲戦"));
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
  if (!context.detail && !context.pageSnapshot) {
    return createRelatedDocumentBase({
      kind: "acceptance",
      title: "验收单",
      status: "warn",
      statusText: "读取失败",
      sourceName: acceptanceLink.title || "",
      sourceUrl: ref.detailUrl || "",
      statement: `验收页读取失败：${context.detailError || context.pageError || "鏈煡閿欒"}`,
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
  const mailSubject = firstNonEmpty(pageMailSubject, firstMailEvidence.subject);
  const mailSentAt = firstNonEmpty(pageMailTime, firstMailEvidence.sentAt);
  const mailSummary = firstNonEmpty(pageMailBody, firstMailEvidence.bodySummary, summarizeFreeText(firstMailEvidence.text));
  const relationHints = buildAcceptanceRelationHints(target, mailSubject, mailSummary, mailAttachmentNames);

  return createRelatedDocumentBase({
    kind: "acceptance",
    title: "验收单",
    status: "info",
    statusText: "人工判断",
    sourceName: normalizeRelatedSourceName(context.pageSnapshot, acceptanceLink.title, ref, mailSubject),
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

async function analyzeAcceptanceMailLinksMulti(relatedLinks, target, baseUrl, onProgress) {
  const acceptanceLinks = pickRelatedLinks(relatedLinks, "acceptance");
  if (acceptanceLinks.length === 0) {
    return [
      createRelatedDocumentBase({
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
          statement: `验收页读取失败：${context.detailError || context.pageError || "鏈煡閿欒"}`,
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
    const mailSubject = firstNonEmpty(pageMailSubject, firstMailEvidence.subject);
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
        sourceName: normalizeRelatedSourceName(context.pageSnapshot, acceptanceLink.title, ref, mailSubject),
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

async function analyzeContractLinks(relatedLinks, target, baseUrl, onProgress) {
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
      const detail = await fetchFlowableDetail(ref, baseUrl);
      const baseFacts = {
        processCode: firstNonEmpty(detail.processCode, detail.flowFormData?.EXTARGETNODEID),
        processTitle: firstNonEmpty(detail.flowFormData?.processTitleInput, detail.flowFormData?.NCBILLCODE),
        counterpartyCompany: firstNonEmpty(detail.flowFormData?.HT010),
        contractAccountNo: firstLikelyBankAccount(
          detail.flowFormData?.HT013,
          detail.flowFormData?.HT014,
          detail.flowFormData?.ACCOUNT,
          detail.flowFormData?.bankAccount
        ),
        effectiveStart: firstNonEmptyDate(detail.flowFormData?.HT032),
        effectiveEnd: firstNonEmptyDate(detail.flowFormData?.HT033),
        paymentTerms: firstMeaningfulText(
          detail.flowFormData?.HT030,
          detail.flowFormData?.HT031,
          detail.flowFormData?.HT034,
          detail.flowFormData?.HT035
        ),
        sourceName: firstNonEmpty(detail.flowFormData?.processTitleInput, detail.processCode, contractLink.title),
        sourceUrl: ref.detailUrl
      };
      return analyzeContractDetail(ref, buildFlowableAttachmentList(detail), baseFacts, target, "合同页", onProgress);
    }

      const detail = await fetchHistoryDetail(ref, baseUrl);
      const historyPageSnapshot = await collectPageSnapshotFromUrl(ref.detailUrl).catch(() => null);
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
        buildHistoryAttachmentList(detail),
        Array.isArray(historyPageSnapshot?.attachments) ? historyPageSnapshot.attachments : []
      );
      return analyzeContractDetail(ref, historyAttachments, baseFacts, target, "合同页", onProgress);
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

async function analyzeContractDetail(ref, attachments, baseFacts, target, sourceLabelPrefix, onProgress) {
  const normalizedContractAttachments = normalizeAttachmentCandidates(attachments || []);
  const contractAttachmentDisplay = summarizeAttachmentDisplay(normalizedContractAttachments);
  attachments = normalizedContractAttachments;
  const facts = { ...baseFacts };
  const matches = {
    amount: amountMatchesPayment(facts.paymentTerms || "", target.paymentAmount)
      ? makeEvidence(`${sourceLabelPrefix}琛ㄥ崟`, ref.detailUrl, formatAmount(target.paymentAmount), facts.paymentTerms || "")
      : null,
    company:
      companyMatchesPayment(facts.counterpartyCompany || "", target.payeeCompany) ||
      companyMatchesPayment(facts.paymentTerms || "", target.payeeCompany)
        ? makeEvidence(`${sourceLabelPrefix}琛ㄥ崟`, ref.detailUrl, target.payeeCompany || "", facts.counterpartyCompany || facts.paymentTerms || "")
        : null,
    account:
      accountMatchesPayment(facts.contractAccountNo || "", target.payeeAccount) ||
      accountMatchesPayment(facts.paymentTerms || "", target.payeeAccount)
        ? makeEvidence(`${sourceLabelPrefix}琛ㄥ崟`, ref.detailUrl, target.payeeAccount || "", facts.contractAccountNo || facts.paymentTerms || "")
        : null
  };

  const attachmentAnalysis = await analyzeAttachmentList(attachments || [], target, `${sourceLabelPrefix}闄勪欢`, onProgress, "contract-attachments");

  if (!facts.effectiveStart) facts.effectiveStart = attachmentAnalysis.contractFacts.effectiveStart || "";
  if (!facts.effectiveEnd) facts.effectiveEnd = attachmentAnalysis.contractFacts.effectiveEnd || "";
  if (!facts.paymentTerms) facts.paymentTerms = attachmentAnalysis.contractFacts.paymentTerms || "";
  if (!facts.paymentTerms) facts.paymentTerms = deriveFallbackContractTerms(attachmentAnalysis.referenceEntries || [], target);
  if (!facts.paymentTerms) facts.paymentTerms = "已进入合同页，但未提取到明确付款条件";
  if (!facts.sourceName) facts.sourceName = attachmentAnalysis.contractFacts.sourceName || ref.detailUrl;
  if (!facts.sourceUrl) facts.sourceUrl = attachmentAnalysis.contractFacts.sourceUrl || ref.detailUrl;

  const candidateSources = [];
  if (facts.paymentTerms) {
    candidateSources.push({
      sourceName: `${sourceLabelPrefix}琛ㄥ崟`,
      sourceUrl: ref.detailUrl,
      text: facts.paymentTerms
    });
  }
  candidateSources.push(...(attachmentAnalysis.referenceEntries || []));

  const clauseCandidates = buildContractClauseCandidates(candidateSources);
  let summary = deriveLocalContractSummary(clauseCandidates, facts);
  summary = {
    ...summary,
    evidenceClauses: selectSummaryEvidenceClauses(summary.evidenceClauses, clauseCandidates),
    llmDispatchStatus: clauseCandidates.length > 0 ? "已发送" : "未发送",
    llmDispatchReason: clauseCandidates.length > 0 ? "已将脱敏后的付款相关条款候选发送给大模型" : "未筛到付款相关条款候选，仅做本地处理",
    llmRequestPreview: clauseCandidates.length > 0
      ? buildContractLlmPreview({
          target,
          facts,
          candidates: clauseCandidates
        })
      : null,
    errorText: ""
  };

  if (clauseCandidates.length > 0) {
    try {
      const llmSummary = await summarizeContractCandidatesWithLlm({
        target,
        facts,
        candidates: clauseCandidates
      });
      summary = {
        mode: "llm",
        statusText: "AI摘要",
        paymentMode: llmSummary.paymentMode || summary.paymentMode,
        paymentTermsSummary: llmSummary.paymentTermsSummary || summary.paymentTermsSummary,
        acceptanceRequirement: llmSummary.acceptanceRequirement || summary.acceptanceRequirement,
        invoiceRequirement: llmSummary.invoiceRequirement || summary.invoiceRequirement,
        paymentDeadline: llmSummary.paymentDeadline || summary.paymentDeadline,
        installments: llmSummary.installments || summary.installments,
        accountChangeRequirement: llmSummary.accountChangeRequirement || summary.accountChangeRequirement,
        taxRate: pickPreferredTaxRate(summary.taxRate, llmSummary.taxRate),
        capAmount: pickPreferredCapAmount(summary.capAmount, llmSummary.capAmount),
        evidenceClauseIds: llmSummary.evidenceClauseIds || [],
        evidenceClauses: selectSummaryEvidenceClauses(llmSummary.evidenceClauseIds, clauseCandidates),
        llmDispatchStatus: "已发送",
        llmDispatchReason: "已将脱敏后的付款相关条款候选发送给大模型",
        llmRequestPreview: summary.llmRequestPreview,
        errorText: ""
      };
    } catch (error) {
      summary = {
        ...summary,
        mode: "local_fallback",
        statusText: "本地摘录",
        llmDispatchStatus: "发送失败",
        llmDispatchReason: "已尝试发送给大模型，但调用失败，已回退到本地展示",
        errorText: `AI摘要失败：${normalizeError(error)}`
      };
    }
  }

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

async function analyzeAttachmentList(attachments, target, sourceLabelPrefix, onProgress, progressPhase) {
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
    errorCount: 0
  };

  if (items.length === 0) {
    reportProgress(onProgress, progressPhase, `正在查看${sourceLabelPrefix}`, "当前阶段没有可展示的概览");
    return { matches, contractFacts, referenceEntries, errors, stats };
  }

  reportProgress(onProgress, progressPhase, `正在查看${sourceLabelPrefix}`, `准备扫描 ${items.length} 个附件`);

  for (let index = 0; index < items.length; index += 1) {
    const attachment = items[index];
    stats.scannedCount += 1;
    reportProgress(
      onProgress,
      progressPhase,
      `正在查看${sourceLabelPrefix}`,
      `正在扫描 ${index + 1}/${items.length}: ${attachment?.name || "未命名附件"}`
    );

    try {
      const binary = await fetchBinary(attachment.url);
      const bytes = binary?.bytes || null;
      if (!bytes || bytes.byteLength < 64) {
        continue;
      }
      stats.downloadedCount += 1;

      const entries = await extractReferenceTextsFromAttachment(attachment, bytes, binary.contentType || "");
      if (entries.length > 0) {
        stats.parsedCount += 1;
        stats.extractedEntryCount += entries.length;
      }
      for (const entry of entries) {
        const text = cleanText(entry.text);
        if (!text) {
          continue;
        }
        const detectedRole = detectAttachmentRole(attachment, text);
        const sourceName = `${sourceLabelPrefix}: ${attachment.name || "未命名附件"}`;
        referenceEntries.push({
          sourceName,
          sourceUrl: attachment.url || "",
          attachmentName: attachment.name || "",
          role: detectedRole?.role || "other",
          text
        });

        if (!contractFacts.sourceName && /鍚堝悓|鍗忚/i.test(attachment.name || "")) {
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
          considerEvidence(
            matches,
            matchMeta,
            "amount",
            makeEvidence(sourceName, attachment.url || "", formatAmount(target.paymentAmount), snippetAround(text, String(target.paymentAmount || ""))),
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
    } catch (error) {
      stats.errorCount += 1;
      errors.push({
        attachmentName: attachment?.name || "",
        attachmentUrl: attachment?.url || "",
        error: normalizeError(error)
      });
    }

    if (
      matches.amount &&
      matches.company &&
      matches.account &&
      contractFacts.sourceName &&
      rolePriority(matchMeta.amount?.role) >= rolePriority("invoice") &&
      rolePriority(matchMeta.company?.role) >= rolePriority("invoice")
    ) {
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

function buildAttachmentOnlyContractProcessing(pageAttachmentAnalysis, inventories) {
  const contractFacts = pageAttachmentAnalysis?.contractFacts || {};
  const contractAttachments = Array.isArray(inventories?.contractAttachments) ? inventories.contractAttachments : [];
  const referenceEntries = Array.isArray(pageAttachmentAnalysis?.referenceEntries) ? pageAttachmentAnalysis.referenceEntries : [];
  const contractEntries = referenceEntries.filter((item) => item.role === "contract");

  if (!contractFacts.sourceName && contractAttachments.length === 0) {
    return emptyContractProcessing("not_found", "尚未发现明确的合同来源");
  }

  const attachmentNames = contractAttachments
    .map((item) => cleanText(item?.name || ""))
    .filter(Boolean)
    .slice(0, 6);

  return {
    pageStatus: "attachment_only",
    pageStatusText: "已在付款页附件中发现合同来源",
    attachmentDiscoveredCount: contractAttachments.length,
    attachmentSupportedCount: contractAttachments.length,
    attachmentScannedCount: contractAttachments.length,
    attachmentDownloadedCount: contractEntries.length,
    attachmentParsedCount: contractEntries.length,
    attachmentErrorCount: 0,
    attachmentNames,
    periodSource: contractFacts.effectiveStart || contractFacts.effectiveEnd ? contractFacts.sourceName || "合同页表单" : "未提供",
    paymentTermsSource: contractFacts.paymentTerms ? contractFacts.sourceName || "合同页表单" : "未提供",
    companySource: "",
    accountSource: "",
    clauseCandidateCount: 0,
    summaryStatusText: "未生成",
    summaryErrorText: ""
  };
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
    llmDispatchStatus: "未发送",
    llmDispatchReason: "未筛到付款相关条款候选，仅做本地处理",
    llmRequestPreview: null,
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
      (/璐圭敤|鏈嶅姟|鎶ヤ环/.test(sentence) || amountMatchesPayment(sentence, target?.paymentAmount))
  );
  const amountSentence =
    findContractReferenceSentence(
      referenceEntries,
      (sentence) => amountMatchesPayment(sentence, target?.paymentAmount) && /璐圭敤|鏈堢|鏈堣垂|鎶ヤ环|鍚◣|鏈嶅姟/.test(sentence)
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

function buildAmountVerification(target, inventories, matched) {
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
    return createVerificationItem(
      "amount",
      "金额一致",
      "pass",
      `已在${matched.sourceName}中找到相同金额`,
      matched.sourceName,
      matched.sourceUrl,
      matched.matchedValue,
      matched.snippet
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
      ? "发票来源未命中收款账号，验收页及合同页附件作为补充来源"
      : hasFallback
        ? "已发现合同侧账号，但发票来源未命中收款账号"
        : "尚未发现可用于核实收款账号的外部来源",
    "",
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
  const capPattern = /鏃犻噾棰濅笂闄恷涓嶈涓婇檺|涓婇檺涓嶉檺|鏃犲皝椤秥(?:(涓婇檺|灏侀《|鏈€楂榺涓嶈秴杩噟绱|鎬婚).{0,24}(楼|锟浜烘皯甯亅\d[\d,]*(?:\.\d+)?\s*(?:鍏億涓囧厓|浜垮厓)))/;
  const localIsCap = capPattern.test(localText);
  const llmIsCap = capPattern.test(llmText);

  if (llmIsCap) return llmText;
  if (localIsCap) return localText;
  if (!llmText || /unknown|not found/i.test(llmText)) return localText || llmText;
  return localText || llmText;
}



