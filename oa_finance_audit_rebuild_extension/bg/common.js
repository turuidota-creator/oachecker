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

export function normalizeCompareText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[()（）\[\]【】“”"'`、，。:：;；\-]/g, "")
    .replace(/\s+/g, "");
}

export function normalizeAccount(value) {
  return cleanText(value).replace(/[^\d]/g, "");
}

export function parseAmount(value) {
  const match = cleanText(value).replaceAll(",", "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : 0;
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
  return digits.length >= 8;
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

export function makeEvidence(sourceName, sourceUrl, matchedValue, snippet) {
  return {
    sourceName,
    sourceUrl,
    matchedValue,
    snippet: cleanText(snippet)
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

export function companyMatchesPayment(text, payeeCompany) {
  const target = normalizeCompareText(payeeCompany);
  return target && target.length >= 4 ? normalizeCompareText(text).includes(target) : false;
}

export function accountMatchesPayment(text, payeeAccount) {
  const target = normalizeAccount(payeeAccount);
  return target && target.length >= 6 ? normalizeAccount(text).includes(target) : false;
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
    if (group.every((keyword) => combined.includes(keyword))) {
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
    if (combined.includes(keyword)) {
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
    if (combined.includes(keyword)) {
      score -= 30;
    }
  }

  if (combined.includes("¥") && combined.includes("税额") && combined.includes("销售方")) {
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
  return cleanText(error?.message || error?.stack || String(error || "未知错误"));
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
