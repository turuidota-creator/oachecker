export const BASE_URL = "http://oa.cyou-inc.com";

export function cleanText(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("\u00a0", " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeFullWidthNumericChars(value) {
  return String(value || "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[．。｡]/g, ".")
    .replace(/[，、]/g, ",")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[—–−]/g, "-");
}

function normalizeOcrNumericSource(value) {
  return String(value || "")
    .replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[\uFF0E\u3002\uFE52\uFF61]/g, ".")
    .replace(/[\uFF0C\u3001\uFE50]/g, ",")
    .replace(/\uFF08/g, "(")
    .replace(/\uFF09/g, ")")
    .replace(/[\uFF0D\u2013\u2014\u2015\u2212]/g, "-");
}

function normalizeOcrNumberishText(value) {
  let text = cleanText(normalizeOcrNumericSource(value));
  const replacements = [
    { pattern: /\b[Oo](?=\d)|(?<=\d)[Oo]\b|(?<=\d)[Oo](?=[\d.,-])/g, value: "0" },
    { pattern: /\b[Iil|](?=\d)|(?<=\d)[Iil|]\b|(?<=\d)[Iil|](?=[\d.,-])/g, value: "1" },
    { pattern: /\b[Ss](?=\d)|(?<=\d)[Ss]\b|(?<=\d)[Ss](?=[\d.,-])/g, value: "5" }
  ];
  for (const rule of replacements) {
    text = text.replace(rule.pattern, rule.value);
  }
  return text;
}

function normalizeOcrAccountText(value) {
  return normalizeOcrNumericSource(value).replace(/[Oo]/g, "0").replace(/[Iil|]/g, "1").replace(/[Ss]/g, "5");
}

export function normalizeCompareText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[()（）\[\]【】“”"'`、，。:：;；\-]/g, "")
    .replace(/\s+/g, "");
}

export function normalizeAccount(value) {
  return cleanText(normalizeOcrAccountText(value)).replace(/[^\d]/g, "");
}

function compactOcrKeywordText(value) {
  return cleanText(value || "").replace(/\s+/g, "");
}

export function parseAmount(value) {
  const normalized = normalizeOcrNumberishText(value)
    .replaceAll(",", "")
    .replace(/[¥￥]/g, "")
    .replace(/[元圆整]/g, "")
    .replace(/\s+/g, "");
  const normalizedMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  return normalizedMatch ? Number.parseFloat(normalizedMatch[0]) : 0;
/*
  const match = normalizeOcrNumberishText(value)
    .replaceAll(",", "")
    .replace(/[¥￥]/g, "")
    .replace(/\s+/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : 0;
*/
}

export function formatAmount(value) {
  const numeric = typeof value === "number" ? value : parseAmount(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Number(numeric).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "";
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

export function firstMeaningfulText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    if (/^(?:0|0\.0+|null|undefined|n\/a|na)$/i.test(text)) continue;
    if (/^(?:暂无|无|空)$/i.test(text)) continue;
    return text;
  }
  return "";
}

export function isLikelyBankAccount(value) {
  const text = cleanText(value);
  if (!text || text.includes("@")) return false;
  const digits = normalizeAccount(text);
  return digits.length >= 6;
}

export function firstLikelyBankAccount(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    if (isLikelyBankAccount(text)) return text;
  }
  return "";
}

export function firstNonEmptyDate(...values) {
  for (const value of values) {
    const text = cleanText(value);
    const match = text.match(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  }
  return "";
}

export function normalizeUrl(url, baseUrl = BASE_URL) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, baseUrl).toString();
}

export function filenameFromUrl(url, baseUrl = BASE_URL) {
  try {
    const parsed = new URL(normalizeUrl(url, baseUrl));
    const tail = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    if (tail && tail.includes(".")) return tail;
    const fileId = parsed.searchParams.get("fileid");
    return fileId ? `file_${fileId}` : tail || "attachment";
  } catch {
    return "attachment";
  }
}

export function deriveBaseUrl(pageUrl) {
  try {
    return new URL(pageUrl || BASE_URL).origin;
  } catch {
    return BASE_URL;
  }
}

export function snippetAround(text, needle) {
  const rawSource = String(text || "").replace(/\r/g, "");
  const source = cleanText(rawSource);
  const target = cleanText(needle);
  if (!source) return "";

  const numericSnippet = findNumericSnippet(rawSource, target);
  if (numericSnippet) {
    return numericSnippet;
  }

  const targetNormalized = normalizeCompareText(target);
  const lineCandidates = rawSource
    .split(/\n+/)
    .map((item) => cleanText(item))
    .filter(Boolean);

  const matchedLine = targetNormalized
    ? lineCandidates.find((item) => normalizeCompareText(item).includes(targetNormalized))
    : "";
  if (matchedLine) {
    return compactMatchedSnippet(matchedLine, target);
  }

  const index = target ? source.indexOf(target) : -1;
  if (index < 0) return source.slice(0, 120);
  return compactMatchedSnippet(
    source.slice(Math.max(0, index - 36), Math.min(source.length, index + target.length + 48)),
    target
  );
}

function compactMatchedSnippet(snippet, target) {
  const result = cleanText(snippet);
  if (!result) return "";

  const safeTarget = cleanText(target);
  const isCompany = /公司|集团|有限|股份/.test(safeTarget);
  if (isCompany && safeTarget) {
    return safeTarget;
  }

  return result.length > 120 ? result.slice(0, 120) : result;
}

function findNumericSnippet(text, target) {
  const normalizedAccount = normalizeAccount(target);
  if (normalizedAccount.length >= 6) {
    const accountMatch = cleanText(text)
      .match(/\d[\d\s-]{5,}\d/g)
      ?.find((item) => normalizeAccount(item).includes(normalizedAccount));
    if (accountMatch) return cleanText(accountMatch);
  }

  const targetAmount = parseAmount(target);
  if (targetAmount > 0) {
    const exactMatch = extractAmountTokens(text).find((item) => Math.abs(item.value - targetAmount) < 0.01);
    if (exactMatch) return cleanText(exactMatch.raw);

    const pairMatch = findAmountPairMatch(text, targetAmount);
    if (pairMatch) {
      return `${pairMatch.left.raw} + ${pairMatch.right.raw}`;
    }
  }

  return "";
}

export function makeEvidence(sourceName, sourceUrl, matchedValue, snippet, extra = {}) {
  return {
    sourceName,
    sourceUrl,
    matchedValue,
    snippet: cleanText(snippet),
    ...(extra && typeof extra === "object" ? extra : {})
  };
}

export function createVerificationItem(key, label, status, statement, sourceName, sourceUrl, matchedValue, snippet) {
  return { key, label, status, statement, sourceName, sourceUrl, matchedValue, snippet };
}

export function amountMatchesPayment(text, paymentAmount) {
  const target = parseAmount(paymentAmount);
  if (!target) return false;

  const tokens = extractAmountTokens(text);
  if (tokens.some((item) => Math.abs(item.value - target) < 0.01)) {
    return true;
  }

  return !!findAmountPairMatch(text, target);
}

function structuredInvoiceTypeMatch(item) {
  return pickFirstNormalizedValue(
    [
      item?.invoiceTypeRaw,
      ...(Array.isArray(item?.invoiceTypeCandidates) ? item.invoiceTypeCandidates : []),
      item?.sourceText,
      item?.sourceName
    ],
    normalizeInvoiceSubtypeLabel
  );
}

function structuredInvoiceAmountEntry(item) {
  const rawAmount = cleanText(item?.amount || "");
  const value = parseAmount(rawAmount);
  return {
    invoiceNo: cleanText(item?.invoiceNo || ""),
    rawAmount,
    value,
    valid: !!rawAmount && value > 0
  };
}

function buildStructuredInvoiceDetailText(items, amountEntries, typeEntries) {
  const parts = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const amount = amountEntries[index] || {};
    const type = typeEntries[index] || {};
    const invoiceName = cleanText(item.invoiceNo || item.sourceName || `第${index + 1}张`);
    const amountText = amount.valid ? formatAmount(amount.value) : "金额未识别";
    const typeText = type.label || "票种未识别";
    parts.push(`${invoiceName}：${amountText}，${typeText}`);
  }
  return parts.join("；");
}

function buildMultiStructuredInvoiceAmountEvidence(items, target) {
  const sources = Array.isArray(items) ? items : [];
  if (sources.length <= 1) {
    return null;
  }

  const targetAmount = parseAmount(target?.paymentAmount);
  if (!(targetAmount > 0)) {
    return null;
  }

  const amountEntries = sources.map((item) => structuredInvoiceAmountEntry(item));
  if (!amountEntries.every((item) => item.valid)) {
    return null;
  }

  const totalAmount = amountEntries.reduce((sum, item) => sum + item.value, 0);
  if (Math.abs(totalAmount - targetAmount) >= 0.01) {
    return null;
  }

  const typeEntries = sources.map((item) => structuredInvoiceTypeMatch(item));
  const allSpecialInvoices = typeEntries.every((item) => item.label === "增值税专用发票");
  const detailText = buildStructuredInvoiceDetailText(sources, amountEntries, typeEntries);

  return makeEvidence(
    `付款页发票明细合计（${sources.length}张）`,
    firstNonEmpty(...sources.map((item) => item?.sourceUrl)),
    formatAmount(totalAmount),
    `价税合计：${formatAmount(totalAmount)}；${detailText}`,
    {
      invoiceTypeLabel: allSpecialInvoices ? "增值税专用发票" : "",
      invoiceTypeRaw: allSpecialInvoices ? "多张发票均为增值税专用发票" : "",
      invoiceTypeCandidates: typeEntries.map((item) => item.raw || item.label).filter(Boolean),
      evidenceRole: "invoice",
      multiInvoiceAggregate: true,
      invoiceCount: sources.length,
      invoiceAmountTotal: totalAmount,
      invoiceTypeAllSpecial: allSpecialInvoices,
      invoiceAmountItems: amountEntries.map((item, index) => ({
        invoiceNo: item.invoiceNo || cleanText(sources[index]?.invoiceNo || ""),
        amount: item.rawAmount,
        parsedAmount: item.value,
        invoiceType: typeEntries[index]?.label || "",
        invoiceTypeRaw: typeEntries[index]?.raw || ""
      }))
    }
  );
}

export function analyzeStructuredInvoiceSources(items, target) {
  const sources = Array.isArray(items) ? items : [];
  const matches = { amount: null, company: null, account: null };
  const multiInvoiceMode = sources.length > 1;

  if (multiInvoiceMode) {
    matches.amount = buildMultiStructuredInvoiceAmountEvidence(sources, target);
  }

  for (const item of sources) {
    const sourceText = cleanText(item?.sourceText || "");
    const sourceName = item?.sourceName || "付款页发票明细";
    const sourceUrl = item?.sourceUrl || "";
    const invoiceTypeMatch = structuredInvoiceTypeMatch(item);

    if (!multiInvoiceMode && !matches.amount && amountMatchesPayment(sourceText, target?.paymentAmount)) {
      matches.amount = makeEvidence(
        sourceName,
        sourceUrl,
        formatAmount(target?.paymentAmount),
        sourceText || `价税合计：${item?.amount || ""}`,
        {
          invoiceTypeLabel: invoiceTypeMatch.label || "",
          invoiceTypeRaw: invoiceTypeMatch.raw || cleanText(item?.invoiceTypeRaw || ""),
          invoiceTypeCandidates: Array.isArray(item?.invoiceTypeCandidates) ? item.invoiceTypeCandidates : [],
          evidenceRole: "invoice"
        }
      );
    }

    if (!matches.company && companyMatchesPayment(sourceText, target?.payeeCompany)) {
      matches.company = makeEvidence(
        sourceName,
        sourceUrl,
        target?.payeeCompany || "",
        sourceText || `销售方：${item?.supplier || ""}`
      );
    }

    if (!matches.account && accountMatchesPayment(sourceText, target?.payeeAccount)) {
      matches.account = makeEvidence(
        sourceName,
        sourceUrl,
        target?.payeeAccount || "",
        sourceText || `收款账号：${item?.accountNo || ""}`
      );
    }
  }

  return matches;
}

export function companyMatchesPayment(text, payeeCompany) {
  const target = normalizeCompareText(payeeCompany);
  return target && target.length >= 4 ? normalizeCompareText(text).includes(target) : false;
}

export function accountMatchesPayment(text, payeeAccount) {
  const target = normalizeAccount(payeeAccount);
  return target && target.length >= 6 ? normalizeAccount(text).includes(target) : false;
}

export function normalizeInvoiceSubtypeLabel(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }
  const compactText = compactOcrKeywordText(text);

  const matched = [];
  if (
    /(?:电子发票\s*[（(]?\s*)?增值税专用发票/.test(text) ||
    /增值税\s*专用\s*发票/.test(text) ||
    /(?:电子发票[（(]?)?增值税专用发票/.test(compactText) ||
    /专票/.test(text)
  ) {
    matched.push("增值税专用发票");
  }
  if (
    /(?:电子发票\s*[（(]?\s*)?(?:增值税)?普通发票/.test(text) ||
    /增值税\s*普通\s*发票/.test(text) ||
    /(?:电子发票[（(]?)?(?:增值税)?普通发票/.test(compactText) ||
    /普票/.test(text)
  ) {
    matched.push("增值税普通发票");
  }

  const labels = [...new Set(matched)];
  return labels.length === 1 ? labels[0] : "";
}

export function normalizePageInvoiceLabel(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }
  const compactText = compactOcrKeywordText(text);

  const matched = [];
  if (/暂未取得发票|未取得发票/.test(text) || /暂未取得发票|未取得发票/.test(compactText)) {
    matched.push("暂未取得发票");
  }
  if (/其他票据|收据|非税票据|\binvoice\b/i.test(text) || /其他票据|收据|非税票据/.test(compactText)) {
    matched.push("其他票据");
  }
  if (/增值税发票/.test(text) || /增值税发票/.test(compactText)) {
    matched.push("增值税发票");
  }

  const labels = [...new Set(matched)];
  return labels.length === 1 ? labels[0] : "";
}

export function pickFirstNormalizedValue(values, normalizer) {
  for (const value of Array.isArray(values) ? values : []) {
    const raw = cleanText(value || "");
    if (!raw) {
      continue;
    }
    const label = typeof normalizer === "function" ? normalizer(raw) : "";
    if (label) {
      return { raw, label };
    }
  }
  return { raw: "", label: "" };
}

export function isInvoiceTypePass(invoiceSubtypeLabel, pageInvoiceLabel) {
  return invoiceSubtypeLabel === "增值税专用发票" && pageInvoiceLabel === "增值税发票";
}

export function inferInvoiceSubtypeFromPageContext(pageInvoiceContext = {}) {
  const pageInvoiceLabel = firstNonEmpty(pageInvoiceContext?.pageInvoiceLabel);
  const linkedInvoiceCorrectness = cleanText(pageInvoiceContext?.linkedInvoiceCorrectness || "");
  const deductibleTaxAmount = parseAmount(pageInvoiceContext?.deductibleTaxAmount);

  if (pageInvoiceLabel !== "增值税发票") {
    return "";
  }
  if (linkedInvoiceCorrectness !== "正确") {
    return "";
  }
  if (!(deductibleTaxAmount > 0)) {
    return "";
  }

  return "增值税专用发票";
}

const DETAIL_FIELD_OPTION_FALLBACKS = {
  fplx: {
    "1": "增值税发票",
    "2": "其他票据",
    "3": "暂未取得发票"
  },
  fpsfzq: {
    "1": "正确",
    "2": "不正确"
  }
};

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

function walkTaskFormWidgets(nodes, visitor) {
  const queue = Array.isArray(nodes) ? [...nodes] : [];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }

    if (typeof visitor === "function" && visitor(node) === true) {
      return true;
    }

    if (Array.isArray(node.widgetList)) {
      queue.push(...node.widgetList);
    }
    if (Array.isArray(node.cols)) {
      queue.push(...node.cols);
    }
  }

  return false;
}

function findTaskFormFieldOptionLabel(detail, fieldName, rawValue) {
  const normalizedFieldName = cleanText(fieldName || "");
  const normalizedRawValue = cleanText(rawValue || "");
  if (!normalizedFieldName || !normalizedRawValue) {
    return "";
  }

  let matchedLabel = "";
  walkTaskFormWidgets(detail?.taskFormData?.widgetList, (node) => {
    const options = node?.options || {};
    if (cleanText(options.name) !== normalizedFieldName || !Array.isArray(options.optionItems)) {
      return false;
    }

    const matched = options.optionItems.find(
      (item) => cleanText(item?.value) === normalizedRawValue || cleanText(item?.label) === normalizedRawValue
    );
    if (!matched?.label) {
      return false;
    }

    matchedLabel = cleanText(matched.label);
    return true;
  });

  if (matchedLabel) {
    return matchedLabel;
  }

  return DETAIL_FIELD_OPTION_FALLBACKS[normalizedFieldName]?.[normalizedRawValue] || "";
}

function collectStructuredInvoiceTypeCandidates(structuredInvoiceSources) {
  const results = [];
  const seen = new Set();
  const push = (value) => {
    const text = cleanText(value || "");
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    results.push(text);
  };

  for (const item of structuredInvoiceSources || []) {
    push(item?.invoiceTypeRaw);
    for (const candidate of item?.invoiceTypeCandidates || []) {
      push(candidate);
    }
  }

  return results;
}

function collectDetailInvoiceTypeCandidates(detail, structuredInvoiceSources) {
  const flow = detail?.flowFormData || detail?.formData || {};
  const rows = Array.isArray(flow?.fpSubform) ? flow.fpSubform : [];
  const results = [];
  const seen = new Set();
  const push = (value) => {
    const text = cleanText(value || "");
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    results.push(text);
  };

  push(findTaskFormFieldOptionLabel(detail, "fplx", firstNonEmpty(flow?.fplx, flow?.fplxbak)));
  push(flow?.fplx);
  push(flow?.fplxbak);

  for (const item of collectStructuredInvoiceTypeCandidates(structuredInvoiceSources)) {
    push(item);
  }

  for (const row of rows) {
    push(row?.invoiceTypeName);
    push(row?.invoiceType);
    push(row?.fplxmc);
    push(findTaskFormFieldOptionLabel(detail, "fplx", row?.fplx));
    push(row?.fplx);
    push(row?.fpzl);
    push(row?.zslx);
    push(row?.kplx);
    push(row?.billType);
    push(row?.billTypeName);
    push(row?.invoiceKind);
    push(row?.invoiceKindName);
  }

  return results;
}

function collectDeductibleTaxCandidates(detail) {
  const flow = detail?.flowFormData || detail?.formData || {};
  const rows = Array.isArray(flow?.fpSubform) ? flow.fpSubform : [];
  const rowValues = rows
    .map((row) => cleanText(firstNonEmpty(row?.yxdkse, row?.effectiveDeductibleTaxAmount)))
    .filter((value) => /-?\d+(?:\.\d+)?/.test(value));

  if (rowValues.length <= 1) {
    return [cleanText(flow?.yxdkse), ...rowValues].filter(Boolean);
  }

  const total = rowValues.reduce((sum, value) => sum + parseAmount(value), 0);
  const totalText = total > 0 ? total.toFixed(2).replace(/\.00$/, "") : "";
  return [cleanText(flow?.yxdkse), totalText, ...rowValues].filter(Boolean);
}

export function derivePageInvoiceContext(snapshot = {}, detail = null, structuredInvoiceSources = []) {
  const fieldPairs = Array.isArray(snapshot?.fieldPairs) ? snapshot.fieldPairs : [];
  const flow = detail?.flowFormData || detail?.formData || {};
  const pageInvoiceValues = [
    ...findFieldValuesFromPairs(fieldPairs, "发票类型"),
    ...collectBodyFieldCandidates(snapshot?.bodyText || "", [
      /(?:发票类型|票据类型)[：:\s]{0,8}(增值税发票|其他票据|暂未取得发票)/i
    ]),
    findTaskFormFieldOptionLabel(detail, "fplx", firstNonEmpty(flow?.fplx, flow?.fplxbak)),
    firstNonEmpty(flow?.fplx, flow?.fplxbak)
  ].filter(Boolean);
  const invoiceSubtypeValues = [
    ...findFieldValuesFromPairs(fieldPairs, "发票类型"),
    ...collectBodyFieldCandidates(snapshot?.bodyText || "", [
      /(?:发票类型|票面类型)[：:\s]{0,8}(增值税专用发票|增值税普通发票|专票|普票)/i
    ]),
    ...collectDetailInvoiceTypeCandidates(detail, structuredInvoiceSources)
  ];

  const pageInvoice = pickFirstNormalizedValue(pageInvoiceValues, normalizePageInvoiceLabel);
  const invoiceSubtype = pickFirstNormalizedValue(invoiceSubtypeValues, normalizeInvoiceSubtypeLabel);
  const linkedInvoiceCorrectness = pickSingleFieldValue(
    [
      ...findFieldValuesFromPairs(fieldPairs, "关联发票是否正确"),
      findTaskFormFieldOptionLabel(detail, "fpsfzq", flow?.fpsfzq),
      cleanText(flow?.fpsfzq)
    ],
    (value) => /^(正确|不正确)$/.test(value)
  );
  const deductibleTaxAmount = pickSingleFieldValue(
    [...findFieldValuesFromPairs(fieldPairs, "有效抵扣税额"), ...collectDeductibleTaxCandidates(detail)],
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

export function classifyAttachmentRole(item) {
  const text = cleanText(`${item?.name || ""} ${item?.url || ""}`);
  if (/发票|电子发票|专票|普票|invoice/i.test(text)) return "invoice";
  if (/合同|框架协议|采购合同|补充协议/i.test(text)) return "contract";
  if (/变更函|开户行|开户信息|银行信息|账户信息|收款账户|账户变更/i.test(text)) return "bank_notice";
  if (/验收|结算单|验收单|验收邮件/i.test(text)) return "acceptance";
  return "other";
}

export function detectInvoiceRole(item, text = "") {
  const nameText = cleanText(`${item?.name || ""} ${item?.url || ""}`);
  const bodyText = cleanText(text);
  const combined = `${nameText}\n${bodyText}`;
  const compactCombined = compactOcrKeywordText(combined);
  let score = 0;
  const reasons = [];

  const strongGroups = [
    ["电子发票"],
    ["增值税专用发票"],
    ["增值税普通发票"],
    ["发票号码", "开票日期"],
    ["价税合计", "小写"],
    ["购买方信息", "销售方信息"],
    ["税率", "税额"],
    ["统一社会信用代码", "发票号码"]
  ];
  for (const group of strongGroups) {
    if (group.every((keyword) => combined.includes(keyword) || compactCombined.includes(keyword))) {
      score += 100;
      reasons.push(group.join(" + "));
    }
  }

  const mediumKeywords = [
    "发票代码",
    "发票号码",
    "开票日期",
    "购买方",
    "销售方",
    "价税合计",
    "税额",
    "税率",
    "项目名称",
    "规格型号",
    "单位",
    "数量",
    "单价",
    "金额",
    "机器编号",
    "校验码",
    "电子发票服务平台"
  ];
  for (const keyword of mediumKeywords) {
    if (combined.includes(keyword) || compactCombined.includes(keyword)) {
      score += 15;
      reasons.push(keyword);
    }
  }

  const filenameKeywords = ["发票", "电子发票", "专票", "普票", "invoice", "票据", "开票"];
  for (const keyword of filenameKeywords) {
    if (nameText.toLowerCase().includes(keyword.toLowerCase())) {
      score += 20;
      reasons.push(`文件名:${keyword}`);
    }
  }

  const negativeKeywords = [
    "合同",
    "协议",
    "补充协议",
    "开户许可",
    "开户信息",
    "银行账户",
    "验收单",
    "结算单",
    "请款单",
    "付款申请",
    "营业执照",
    "身份证"
  ];
  for (const keyword of negativeKeywords) {
    if (combined.includes(keyword) || compactCombined.includes(keyword)) {
      score -= 30;
    }
  }

  if (combined.includes("¥") && compactCombined.includes("税额") && compactCombined.includes("销售方")) {
    score += 45;
    reasons.push("金额符号 + 税额 + 销售方");
  }

  const role = score >= 60 ? "invoice" : score >= 30 ? "possible_invoice" : "other";
  return { role, score, reasons: [...new Set(reasons)] };
}

export function detectAttachmentRole(item, text = "") {
  const namedRole = classifyAttachmentRole(item);
  if (namedRole !== "other") {
    return { role: namedRole, score: rolePriority(namedRole), reasons: [`filename:${namedRole}`] };
  }

  const invoice = detectInvoiceRole(item, text);
  if (invoice.role !== "other") {
    return invoice;
  }

  return { role: "other", score: rolePriority("other"), reasons: [] };
}

export function rolePriority(role) {
  if (role === "invoice") return 500;
  if (role === "bank_notice") return 400;
  if (role === "contract") return 300;
  if (role === "acceptance") return 200;
  if (role === "possible_invoice") return 150;
  return 100;
}

export function scoreAttachment(item) {
  const role = classifyAttachmentRole(item);
  const base = role === "invoice" ? 100 : role === "bank_notice" ? 90 : role === "contract" ? 80 : role === "acceptance" ? 70 : 50;
  return base + (/pdf|ofd/i.test(String(item?.name || "")) ? 12 : /\.(?:png|jpg|jpeg)$/i.test(String(item?.name || "")) ? 8 : 0);
}

export function attachmentSizeHint(item) {
  const direct = Number(item?.fileSize || item?.filesize || item?.size || item?.contentLength || 0);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const marker = String(item?.name || "");
  if (/\.(png|jpg|jpeg)$/i.test(marker)) return 1;
  if (/\.(pdf|ofd)$/i.test(marker)) return 2;
  if (/\.(docx?|xlsx?|csv|txt|xml|rtf)$/i.test(marker)) return 3;
  if (/\.zip$/i.test(marker)) return 5;
  return 4;
}

export function attachmentPreScanPriority(item) {
  const namedRole = classifyAttachmentRole(item);
  if (namedRole === "invoice") return 0;

  const marker = String(item?.name || "");
  const isPotentialInvoiceCarrier = /\.(png|jpg|jpeg|pdf|ofd)$/i.test(marker);
  if (isPotentialInvoiceCarrier && namedRole === "other") return 1;

  if (namedRole === "bank_notice") return 2;
  if (namedRole === "contract" && /\.(?:png|jpg|jpeg)$/i.test(marker)) return 3.5;
  if (namedRole === "contract") return 3;
  if (namedRole === "acceptance") return 4;
  if (/\.zip$/i.test(marker)) return 6;
  return 5;
}

export function supportsAttachmentTextExtraction(name, url) {
  return /\.(pdf|doc|docx|xlsx|xls|csv|png|jpg|jpeg|ofd|zip|txt|xml|rtf|msg|eml)(?:$|\?)/i.test(String(name || ""))
    || /\.(pdf|doc|docx|xlsx|xls|csv|png|jpg|jpeg|ofd|zip|txt|xml|rtf|msg|eml)(?:$|\?)/i.test(String(url || ""));
}

export function extractContractPeriod(text) {
  const matches = Array.from(cleanText(text).matchAll(/(20\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/g)).slice(0, 4);
  const dates = matches.map((m) => `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`);
  return { start: dates[0] || "", end: dates[1] || "" };
}

export function extractPaymentTerms(text) {
  return cleanText(text)
    .split(/[。；;]/)
    .map((item) => cleanText(item))
    .find((item) => /付款|支付|结算|验收/.test(item) && item.length >= 10) || "";
}

export function normalizeError(error) {
  return translateTechnicalErrorMessage(error?.message || error?.stack || String(error || "未知错误"));
}

function translateTechnicalErrorMessage(value, fallback = "扩展内部错误，请刷新页面后重试") {
  const message = cleanText(value);
  if (!message) {
    return fallback;
  }
  const mappings = [
    [/asynchronous response|message channel closed|message port closed/i, "后台分析连接中断，请重新点击自动审核"],
    [/receiving end does not exist|could not establish connection/i, "页面脚本尚未就绪，请刷新 OA 页面后重试"],
    [/extension context invalidated|context invalidated/i, "扩展已重新加载，请刷新 OA 页面后重试"],
    [/failed to fetch|networkerror|load failed/i, "网络请求失败，请确认 OA 登录状态和网络后重试"],
    [/timeout|timed out/i, "请求超时，请稍后重试"],
    [/tesseract.*unavailable|createworker unavailable/i, "OCR 组件初始化失败，请刷新页面后重试"],
    [/ocr bridge not initialized/i, "OCR 识别桥接尚未初始化，请重试"],
    [/image decode failed/i, "图片解码失败，可能是附件格式异常"],
    [/filereader failed/i, "附件读取失败，请重试"],
    [/cannot access contents of url|missing host permission/i, "扩展缺少当前页面访问权限，请检查插件权限"],
    [/no tab with id|tab.*closed/i, "目标标签页已关闭，请重新打开详情页"],
    [/invalid value for argument/i, "扩展调用参数异常，请刷新页面后重试"],
    [/script error|could not load file/i, "页面脚本执行失败，请刷新页面后重试"]
  ];
  for (const [pattern, text] of mappings) {
    if (pattern.test(message)) {
      return text;
    }
  }
  if (!/[\u4e00-\u9fff]/.test(message) && /[A-Za-z]/.test(message)) {
    return fallback;
  }
  return message;
}

function extractAmountTokens(text) {
  const matches = cleanText(text).match(/[¥￥]?\s*\d[\d,]*(?:\.\d+)?(?:元|圆|整)?/g) || [];
  return matches
    .map((raw) => ({ raw: cleanText(raw), value: parseAmount(raw) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.value < 1000000000);
}

function findAmountPairMatch(text, targetAmount) {
  const tokens = extractAmountTokens(text)
    .filter((item) => item.value > 0.01 && item.value < targetAmount)
    .filter((item) => item.value <= targetAmount * 1.05)
    .slice(0, 24);

  for (let index = 0; index < tokens.length; index += 1) {
    for (let inner = index + 1; inner < tokens.length; inner += 1) {
      const sum = tokens[index].value + tokens[inner].value;
      if (Math.abs(sum - targetAmount) < 0.02) {
        return { left: tokens[index], right: tokens[inner] };
      }
    }
  }

  return null;
}
