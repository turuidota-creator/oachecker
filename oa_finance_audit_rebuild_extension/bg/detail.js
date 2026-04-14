import {
  BASE_URL,
  cleanText,
  filenameFromUrl,
  firstNonEmpty,
  firstNonEmptyDate,
  normalizeUrl
} from "./common.js";
import { fetchJson } from "./io.js";

const FLOWABLE_LINK_RE = /\/workflow\/process\/detail\/(\d+)/i;
const HISTORY_LINK_RE = /\/workflow\/process\/history\/detail\/(\d+)\/monitor/i;
const HISTORY_LINK_SOURCE_RE = /\/workflow\/process\/history\/detail\/(\d+)\/link\/(\d+)/i;
const LEGACY_REQUEST_LINK_RE = /\/workflow\/request\/ViewRequest\.jsp\?(?:[^#]*?&)?requestid=(\d+)/i;
const ATTACHMENT_URL_RE =
  /((?:https?:\/\/|\/)[^\s"'<>]*(?:weaver\.file\.FileDownload\?fileid=\d+[^\s"'<>]*|\/group1\/[^\s"'<>]+|\/files\/[^\s"'<>]+|\/nchtmb\/downloadinstance[^\s"'<>]*|\/history\/flow\/downloadFile[^\s"'<>]*))/gi;
const GENERIC_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const ANCHOR_TAG_RE = /<a[^>]+href=["'](?<url>https?:\/\/[^"']+)["'][^>]*>(?<label>.*?)<\/a>/gi;
const PROCESS_LINK_RE =
  /(?:(?:https?:\/\/(?:oa|workflow)\.cyou-inc\.com)?\/workflow\/process\/(?:detail\/\d+(?:\?[^"'\\s<>]*)?|history\/detail\/\d+\/monitor(?:\?[^"'\\s<>]*)?|history\/detail\/\d+\/link\/\d+(?:\?[^"'\\s<>]*)?)|(?:https?:\/\/workflow\.cyou-inc\.com)?\/workflow\/request\/ViewRequest\.jsp\?[^"'\\s<>]*requestid=\d+[^"'\\s<>]*)/gi;

const INVOICE_TYPE_FIELD_RE =
  /(?:invoice.*type|invoiceType|bill.*type|tax.*invoice|fplx|fpzl|kplx|pjlx|pjzl|zslx|发票.*类|票据.*类|票种|票类|专票|普票)/i;

function decodeMaybeUriComponent(value) {
  const text = cleanText(value || "");
  if (!text || !/%[0-9a-f]{2}/i.test(text)) {
    return text;
  }
  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text;
  }
}

function collectInvoiceTypeCandidates(row) {
  const candidates = [];
  const push = (value) => {
    const text = cleanText(value || "");
    if (!text || text.length > 80 || candidates.includes(text)) {
      return;
    }
    candidates.push(text);
  };

  push(row?.invoiceTypeName);
  push(row?.invoiceType);
  push(row?.fplxmc);
  push(row?.fplx);
  push(row?.fpzl);
  push(row?.zslx);
  push(row?.kplx);
  push(row?.billType);
  push(row?.billTypeName);
  push(row?.invoiceKind);
  push(row?.invoiceKindName);

  if (!row || typeof row !== "object") {
    return candidates;
  }

  for (const [key, value] of Object.entries(row)) {
    if (!INVOICE_TYPE_FIELD_RE.test(String(key || ""))) {
      continue;
    }
    if (Array.isArray(value) || (value && typeof value === "object")) {
      continue;
    }
    push(value);
  }

  return candidates;
}

export function parseProcessRef(url, relation) {
  const normalized = normalizeUrl(url, BASE_URL);
  if (!normalized) return null;

  const flowableMatch = normalized.match(FLOWABLE_LINK_RE);
  if (flowableMatch) {
    const parsed = new URL(normalized);
    return {
      mode: "flowable",
      detailId: flowableMatch[1],
      detailUrl: normalized,
      relation,
      sourceInstId: parsed.searchParams.get("sourceInstId") || ""
    };
  }

  const historyMatch = normalized.match(HISTORY_LINK_RE);
  if (historyMatch) {
    return {
      mode: "history",
      detailId: historyMatch[1],
      detailUrl: normalized,
      relation,
      sourceInstId: ""
    };
  }

  const historySourceMatch = normalized.match(HISTORY_LINK_SOURCE_RE);
  if (historySourceMatch) {
    return {
      mode: "history",
      detailId: historySourceMatch[1],
      detailUrl: normalized,
      relation,
      sourceInstId: historySourceMatch[2] || ""
    };
  }

  const legacyMatch = normalized.match(LEGACY_REQUEST_LINK_RE);
  if (legacyMatch) {
    return {
      mode: "history",
      detailId: legacyMatch[1],
      detailUrl: normalized,
      relation,
      sourceInstId: ""
    };
  }

  return null;
}

export async function resolveProcessCodeRef(processCode, relation, baseUrl = BASE_URL) {
  const normalizedCode = cleanText(processCode || "").toUpperCase();
  if (!normalizedCode) {
    return null;
  }

  const payload = await fetchJson(
    `${baseUrl}/cyouNeiOaServer/flowable/instance/instanceIdByProcessCode?processCode=${encodeURIComponent(normalizedCode)}`
  );
  if (payload.code !== 200) {
    throw new Error(payload.msg || "流程编号反查失败");
  }

  const data = payload.data || {};
  const instanceId = firstNonEmpty(data.instanceId, data.procInsId, data.id);
  if (!instanceId) {
    return null;
  }

  const fromHistory = Boolean(data.fromHistory);
  const detailUrl = fromHistory
    ? `${baseUrl}/workflow/process/history/detail/${instanceId}/monitor?processCode=${encodeURIComponent(normalizedCode)}`
    : `${baseUrl}/workflow/process/detail/${instanceId}?processCode=${encodeURIComponent(normalizedCode)}`;
  const ref = parseProcessRef(detailUrl, relation);
  if (!ref) {
    return null;
  }

  return {
    ...ref,
    processCode: normalizedCode,
    fromHistory,
    titleHint: decodeMaybeUriComponent(firstNonEmpty(data.title, data.processTitle)),
    resolvedFromProcessCode: true
  };
}

export async function fetchFlowableDetail(ref, baseUrl) {
  const params = new URLSearchParams({ procInsId: ref.detailId });
  if (ref.sourceInstId) params.set("sourceInstId", ref.sourceInstId);
  const payload = await fetchJson(`${baseUrl}/cyouNeiOaServer/flowable/process/detail?${params.toString()}`);
  if (payload.code !== 200) throw new Error(payload.msg || "读取流程详情失败");
  return payload.data || {};
}

export async function buildFlowableInvoiceEvidenceList(detail, baseUrl) {
  const flow = detail?.flowFormData || {};
  const rows = Array.isArray(flow.fpSubform) ? flow.fpSubform : [];
  const results = [];

  for (const row of rows) {
    const invoiceId = Number(row?.invoiceId || 0);
    const invoiceNo = firstNonEmpty(row?.fphm, row?.fplink);
    const supplier = firstNonEmpty(row?.gysmc);
    const buyer = firstNonEmpty(row?.gfmc);
    const amount = firstNonEmpty(row?.hsje, row?.wtjhsje, row?.bcsyhsje, row?.fpmoney);
    const tax = firstNonEmpty(row?.se, row?.yxdkse);
    const accountNo = firstNonEmpty(row?.bankAccount, row?.accountNo);
    const invoiceTypeCandidates = collectInvoiceTypeCandidates(row);
    const invoiceTypeRaw = firstNonEmpty(...invoiceTypeCandidates);
    const sourceName = invoiceNo ? `付款页发票明细：${invoiceNo}` : "付款页发票明细";
    const sourceText = [
      invoiceNo ? `发票号码：${invoiceNo}` : "",
      invoiceTypeRaw ? `发票类型：${invoiceTypeRaw}` : "",
      supplier ? `销售方：${supplier}` : "",
      buyer ? `购买方：${buyer}` : "",
      amount ? `价税合计：${amount}` : "",
      tax ? `税额：${tax}` : "",
      accountNo ? `收款账号：${accountNo}` : ""
    ]
      .filter(Boolean)
      .join("；");

    let sourceUrl = "";
    if (invoiceId > 0) {
      sourceUrl = await fetchFlowableInvoiceUrl(invoiceId, baseUrl).catch(() => "");
    }

    results.push({
      invoiceId,
      invoiceNo,
      supplier,
      buyer,
      amount,
        tax,
        accountNo,
        invoiceTypeCandidates,
        invoiceTypeRaw,
        sourceName,
        sourceText,
      sourceUrl,
      attachment: sourceUrl
        ? {
            name: `付款页发票明细-${invoiceNo || invoiceId}.jpg`,
            url: normalizeUrl(sourceUrl, baseUrl),
            method: "GET"
          }
        : null
    });
  }

  return results;
}

export async function fetchHistoryDetail(ref, baseUrl) {
  const params = new URLSearchParams({ requestId: ref.detailId, source: "monitor" });
  const payload = await fetchJson(`${baseUrl}/cyouNeiOaServer/history/flow/detail?${params.toString()}`);
  if (payload.code !== 200) throw new Error(payload.msg || "读取历史流程详情失败");
  return payload.data || {};
}

export function buildFlowableAttachmentList(detail) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (key === "historyProcNodeList" || key === "processNodeHistory") continue;
    scrubbed[key] = value;
  }
  const attachments = [];
  collectAttachmentCandidates(scrubbed, attachments);
  return dedupeAttachments([...attachments, ...discoverExtraAttachments(detail)]);
}

export function buildHistoryAttachmentList(detail) {
  const attachments = [];
  collectAttachmentCandidates(detail?.formData || {}, attachments);
  return dedupeAttachments(attachments);
}

export function buildAttachmentTitles(detail) {
  return [...new Set(buildFlowableAttachmentList(detail).map((item) => item.name).filter(Boolean))];
}

export function extractFlowableFacts(detail) {
  const flow = detail.flowFormData || {};
  const invoiceRefs = Array.isArray(flow.fpSubform) ? flow.fpSubform : [];
  return {
    processCode: firstNonEmpty(detail.processCode, flow.EXTARGETNODEID),
    processTitle: firstNonEmpty(flow.processTitleInput, flow.NCBILLCODE),
    supplier: firstNonEmpty(flow.SUPPLIER, flow.NAMEOFSUPPLIER, flow.COLLECTIONSUPPLIERNAME),
    accountNo: firstNonEmpty(flow.ACCOUNT),
    bankName: firstNonEmpty(flow.BANK),
    paymentDate: firstNonEmptyDate(flow.PAYDATE, flow.PAYMENTDATE, flow.CREATEDATE, detail.processCode, flow.processTitleInput),
    paymentAmount: firstNonEmpty(flow.RMBAMOUNT, flow.PAYAMOUNTLOW, flow.cMoney),
    invoiceTotal: firstNonEmpty(flow.kaipiaojine, flow.hsje),
    invoiceSupplier: firstNonEmpty(invoiceRefs[0]?.gysmc, flow.NAMEOFSUPPLIER, flow.COLLECTIONSUPPLIERNAME),
    invoiceAccountNo: firstNonEmpty(invoiceRefs[0]?.bankAccount, invoiceRefs[0]?.accountNo, flow.bankNo),
    invoiceRefs: invoiceRefs.map((row) => {
      const invoiceTypeCandidates = collectInvoiceTypeCandidates(row);
      return {
        invoiceId: Number(row?.invoiceId || 0),
        invoiceNo: firstNonEmpty(row?.fphm, row?.fplink),
        invoiceTypeCandidates,
        invoiceTypeRaw: firstNonEmpty(...invoiceTypeCandidates),
        supplier: firstNonEmpty(row?.gysmc),
        buyer: firstNonEmpty(row?.gfmc),
        amount: firstNonEmpty(row?.hsje, row?.wtjhsje, row?.bcsyhsje, row?.fpmoney),
        tax: firstNonEmpty(row?.se, row?.yxdkse),
        accountNo: firstNonEmpty(row?.bankAccount, row?.accountNo)
      };
    })
  };
}

export function extractKnownRefs(detail, currentDetailId) {
  const flow = detail.flowFormData || {};
  const refs = [
    ...extractRefsFromRows(flow.formtable_main_154_dt1, "domestic_pr", currentDetailId),
    ...extractRefsFromRows(flow.formtable_main_154_dt4, "contract", currentDetailId),
    ...extractRefsFromRows(flow.formtable_main_154_dt5, "purchase_order", currentDetailId),
    ...extractRefsFromRows(flow.formtable_main_154_dt6, "acceptance", currentDetailId)
  ];
  return dedupeRefs(refs);
}

export function discoverProcessRefs(detail, currentDetailId) {
  const refs = [];
  walk(detail, (value) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(PROCESS_LINK_RE)) {
      const relation = relationFromContext(value);
      const ref = parseProcessRef(match[0], relation);
      if (ref && ref.detailId !== currentDetailId) refs.push(ref);
    }
  });
  return dedupeRefs(refs);
}

export function findHistoryField(mapping, ...candidates) {
  if (!mapping || typeof mapping !== "object") return "";
  for (const candidate of candidates) {
    if (candidate in mapping) {
      const text = historyFieldText(mapping[candidate]);
      if (text) return text;
    }
  }
  for (const [key, value] of Object.entries(mapping)) {
    for (const candidate of candidates) {
      if (String(key).includes(candidate)) {
        const text = historyFieldText(value);
        if (text) return text;
      }
    }
  }
  return "";
}

function historyFieldText(value) {
  if (value == null) return "";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map((item) => historyFieldText(item)).filter(Boolean).join(" ");
  if (typeof value === "object") return firstNonEmpty(value.value, value.fieldValue, value.text);
  return "";
}

function collectAttachmentCandidates(node, results) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectAttachmentCandidates(item, results));
    return;
  }
  if (node && typeof node === "object") {
    const fileName = firstNonEmpty(node.fileName, node.filename, node.name, node.docName);
    const fileUrl = firstNonEmpty(node.filePath, node.url, node.downloadUrl, node.downloadPath);
    if (fileUrl) {
      results.push({ name: firstNonEmpty(fileName, filenameFromUrl(fileUrl)), url: normalizeUrl(fileUrl), method: "GET" });
    }
    Object.values(node).forEach((value) => collectAttachmentCandidates(value, results));
    return;
  }
  if (typeof node === "string") {
    results.push(...extractAttachmentsFromText(node));
  }
}

function discoverExtraAttachments(detail) {
  const attachments = [];
  walk(detail, (value) => {
    if (typeof value !== "string") return;

    for (const match of value.matchAll(ANCHOR_TAG_RE)) {
      const url = normalizeUrl(match.groups?.url || "");
      if (looksLikeExtraAttachmentUrl(url)) {
        attachments.push({
          name: cleanText(match.groups?.label || "") || filenameFromUrl(url),
          url,
          method: "GET"
        });
      }
    }

    for (const match of value.matchAll(GENERIC_URL_RE)) {
      const url = normalizeUrl(match[0]);
      if (looksLikeExtraAttachmentUrl(url)) {
        attachments.push({ name: filenameFromUrl(url), url, method: "GET" });
      }
    }
  });

  return dedupeAttachments(attachments);
}

function extractAttachmentsFromText(text) {
  if (!text || !/FileDownload|\/group1\/|\/files\/|downloadInstance|downloadFile/i.test(text)) return [];
  const attachments = [];
  for (const match of text.matchAll(ATTACHMENT_URL_RE)) {
    attachments.push({ name: filenameFromUrl(match[0]), url: normalizeUrl(match[0]), method: "GET" });
  }
  return dedupeAttachments(attachments);
}

function dedupeAttachments(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items || []) {
    if (!item?.url) continue;
    const normalized = {
      name: cleanText(item.name || filenameFromUrl(item.url)),
      url: normalizeUrl(item.url),
      method: item.method || "GET"
    };
    const key = `${normalized.url}|${normalized.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function walk(node, visitor) {
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visitor));
    return;
  }
  if (node && typeof node === "object") {
    Object.values(node).forEach((value) => {
      visitor(value);
      walk(value, visitor);
    });
  }
}

function dedupeRefs(refs) {
  const deduped = [];
  const indexByKey = new Map();
  for (const ref of refs || []) {
    if (!ref) continue;
    const key = `${ref.mode}|${ref.detailId}|${ref.relation}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, deduped.length);
      deduped.push(ref);
      continue;
    }
    deduped[existingIndex] = mergeRefMeta(deduped[existingIndex], ref);
  }
  return deduped;
}

function extractRefsFromRows(rows, relation, currentDetailId) {
  const refs = [];
  for (const row of rows || []) {
    const rowHints = collectRowHints(row);
    const titleHint = pickRefTitleHint(rowHints, relation);
    for (const value of Object.values(row || {})) {
      if (typeof value !== "string") {
        continue;
      }
      for (const match of value.matchAll(PROCESS_LINK_RE)) {
        const ref = parseProcessRef(match[0], relation);
        if (ref && ref.detailId !== currentDetailId) {
          refs.push({
            ...ref,
            titleHint,
            rowHints
          });
        }
      }
    }
  }
  return refs;
}

function mergeRefMeta(left, right) {
  const leftHints = Array.isArray(left?.rowHints) ? left.rowHints : [];
  const rightHints = Array.isArray(right?.rowHints) ? right.rowHints : [];
  return {
    ...left,
    ...right,
    titleHint: firstNonEmpty(left?.titleHint, right?.titleHint),
    rowHints: [...new Set([...leftHints, ...rightHints].filter(Boolean))].slice(0, 8)
  };
}

function collectRowHints(row) {
  const results = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(row || {})) {
    if (typeof value !== "string") {
      continue;
    }
    const text = cleanText(value);
    if (!text || seen.has(text)) {
      continue;
    }
    if (/^https?:\/\//i.test(text) || PROCESS_LINK_RE.test(text)) {
      continue;
    }
    if (/^(?:GNPR|CYNCDD|CYNCHT|CYNCFK|DDFK)-\d+$/i.test(text)) {
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(text)) {
      continue;
    }
    const normalizedKey = cleanText(key);
    results.push({
      key: normalizedKey,
      value: text
    });
    seen.add(text);
  }
  return results.slice(0, 12);
}

function pickRefTitleHint(rowHints, relation) {
  const candidates = Array.isArray(rowHints) ? rowHints : [];
  if (candidates.length === 0) {
    return "";
  }

  const relationPatterns =
    relation === "acceptance"
      ? [/邮件/, /主题/, /标题/, /验收/, /结算/, /答复/, /请.*审批/]
      : relation === "contract"
        ? [/合同/, /协议/, /补充协议/]
        : relation === "purchase_order"
          ? [/订单/, /供应商/, /采购/]
          : relation === "domestic_pr"
            ? [/PR/, /需求/, /用途/, /说明/]
            : [];

  for (const pattern of relationPatterns) {
    const matched = candidates.find((item) => pattern.test(item.key) || pattern.test(item.value));
    if (matched?.value) {
      return matched.value;
    }
  }

  const descriptive = candidates.find((item) => /[\u4e00-\u9fa5]/.test(item.value) && item.value.length >= 6);
  return descriptive?.value || candidates[0]?.value || "";
}

function relationFromContext(context) {
  const rawText = String(context || "");
  const text = `${rawText} ${decodeMaybeUriComponent(rawText)}`;
  if (/合同|htlink|cght|采购合同/i.test(text)) return "contract";
  if (/验收|到货|ysdlink|zlys/i.test(text)) return "acceptance";
  if (/国内\s*PR|PR单号|GNPR|prlink/i.test(text)) return "domestic_pr";
  if (/采购订单|订单名称|订单金额|PRNUMBER|CYNCDD|ddlink|po(?:\b|_)/i.test(text)) return "purchase_order";
  return "related";
}

function looksLikeExtraAttachmentUrl(url) {
  return /(10\.1\.41\.11|10\.1\.9\.119|sea\.cyou-inc\.com|\/group1\/|\/files\/|downloadInstance|FileDownload\?fileid=)/i.test(String(url || ""));
}

async function fetchFlowableInvoiceUrl(invoiceId, baseUrl) {
  const payload = await fetchJson(`${baseUrl}/cyouNeiOaServer/flowable/process/detailInvoiceUrl?invoiceId=${invoiceId}`);
  if (payload.code !== 200) {
    throw new Error(payload.msg || "读取发票详情失败");
  }

  const url = firstNonEmpty(payload.data?.url, payload.data?.downloadUrl, payload.data, payload.msg);
  return /^https?:\/\//i.test(url) ? url : "";
}
