import { cleanText } from "./common.js";

const TOPIC_RULES = [
  { topic: "payment", keywords: ["付款", "支付", "结算", "价款", "款项", "费用"], weight: 15 },
  { topic: "acceptance", keywords: ["验收", "验收通过", "交付", "签收", "确认"], weight: 12 },
  { topic: "invoice", keywords: ["发票", "开票", "专票", "普票", "票据"], weight: 10 },
  { topic: "deadline", keywords: ["工作日", "自然日", "日内", "次月", "月结", "按月"], weight: 10 },
  { topic: "installment", keywords: ["分期", "首付款", "尾款", "第一期", "第二期", "比例"], weight: 12 },
  { topic: "account", keywords: ["收款账户", "银行账号", "开户行", "账户变更", "书面通知"], weight: 8 }
];

const NEGATIVE_KEYWORDS = ["保密", "知识产权", "争议解决", "不可抗力", "适用法律"];
const SENSITIVE_LINE_PATTERNS = [
  /^(?:甲方|乙方)\s*[：:]/,
  /^(?:地址|邮编|联系人|电话|邮箱|E-?Mail|邮件地址|签署日期|身份证号|固定网络IP)\s*[：:]/i,
  /^(?:双方项目负责人|甲方验收人|乙方负责人|商务负责人|项目负责人)\s*[：:]/,
  /^(?:账户名称|开户行|账\s*号|帐\s*号|账号|账户名)\s*[：:]/,
  /^(?:乙方账户信息|乙方关联公司.*账户信息)/
];
const APPENDIX_START_PATTERN = /^附件[一二三四五六七八九十0-9]/;
const FOCUSED_SENTENCE_PATTERN =
  /付款|支付|结算|价款|款项|费用|发票|开票|验收|交付|签收|工作日|自然日|日内|次月|月结|按月|分期|首付款|尾款|第一期|第二期|税率|增值税|上限|封顶|不超过|收款账户|开户行|账户变更|一次性|电汇|支票/;

export function buildContractClauseCandidates(sources = []) {
  const candidates = [];
  for (const source of sources) {
    const sourceText = sanitizeSourceTextForCandidates(source?.text || "");
    if (!sourceText) continue;
    const sections = buildCandidateSections(sourceText);
    sections.forEach((section, index) => {
      const scored = scoreSection(section, source, index);
      if (scored.score >= 18) {
        candidates.push(scored);
      }
    });
  }

  return dedupeCandidates(candidates)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item, index) => ({
      clauseId: `clause_${String(index + 1).padStart(2, "0")}`,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      title: item.title,
      score: item.score,
      topics: item.topics,
      text: item.text
    }));
}

export function deriveLocalContractSummary(candidates = [], baseFacts = {}) {
  const fallbackText = firstNonEmptyText(baseFacts.paymentTerms);
  const paymentMode = detectPaymentMode(candidates, fallbackText);
  const acceptanceRequirement = detectRequirement(candidates, /验收|交付|签收|确认/);
  const invoiceRequirement = detectRequirement(candidates, /发票|开票|票据/);
  const paymentDeadline = detectPaymentDeadline(candidates);
  const installments = detectInstallments(candidates);
  const accountChangeRequirement = detectAccountChangeRequirement(candidates);
  const taxRate = detectTaxRate(candidates);
  const capAmount = detectCapAmount(candidates);

  const summaryText = firstNonEmptyText(
    candidates.find((item) => item.topics.includes("payment"))?.text,
    baseFacts.paymentTerms,
    candidates[0]?.text
  );

  return {
    mode: candidates.length > 0 ? "local" : "none",
    statusText: candidates.length > 0 ? "本地摘录" : "未生成",
    paymentMode,
    paymentTermsSummary: summaryText || "未从合同条款中提取到明确付款信息",
    acceptanceRequirement,
    invoiceRequirement,
    paymentDeadline,
    installments,
    accountChangeRequirement,
    taxRate,
    capAmount,
    evidenceClauses: candidates.slice(0, 4)
  };
}

function buildCandidateSections(text) {
  const sections = splitIntoSections(text);
  return sections.flatMap((section) => focusSectionWindows(section));
}

function splitIntoSections(text) {
  const normalized = cleanText(text).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  if (!normalized) return [];

  const lines = normalized.split("\n").map((line) => cleanText(line)).filter(Boolean);
  const sections = [];
  let buffer = [];
  let currentTitle = "";

  for (const line of lines) {
    if (looksLikeHeading(line) && buffer.length > 0) {
      sections.push({ title: currentTitle, text: buffer.join("\n") });
      buffer = [line];
      currentTitle = line;
      continue;
    }
    if (looksLikeHeading(line)) {
      currentTitle = line;
    }
    buffer.push(line);
  }

  if (buffer.length > 0) {
    sections.push({ title: currentTitle, text: buffer.join("\n") });
  }

  if (sections.length === 1) {
    return normalized
      .split(/[。；;]/)
      .map((item) => cleanText(item))
      .filter((item) => item.length >= 12)
      .map((item) => ({ title: "", text: item }));
  }

  return sections;
}

function sanitizeSourceTextForCandidates(text) {
  const normalized = cleanText(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  if (!normalized) return "";

  const lines = normalized.split("\n").map((line) => cleanText(line)).filter(Boolean);
  const kept = [];

  for (const line of lines) {
    if (APPENDIX_START_PATTERN.test(line) && !FOCUSED_SENTENCE_PATTERN.test(line)) {
      break;
    }
    if (isSensitiveNoiseLine(line) || isLikelyTableNoiseLine(line)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}

function looksLikeHeading(text) {
  return /^(第[一二三四五六七八九十0-9]+条|[一二三四五六七八九十]+、|\d+[.、]|付款方式|支付方式|结算方式|验收|发票|账户变更|收款账户|开户行)/.test(
    text
  );
}

function focusSectionWindows(section) {
  const title = cleanText(section?.title || "");
  const text = cleanText(section?.text || "");
  if (!text) return [];

  const sentences = splitSentences(text).filter((item) => !isSensitiveNoiseLine(item) && !isLikelyTableNoiseLine(item));
  if (sentences.length <= 3) {
    return [{ title, text: sentences.join("；") || text }];
  }

  const windows = [];
  const seen = new Set();
  const focusIndexes = [];
  sentences.forEach((sentence, index) => {
    if (FOCUSED_SENTENCE_PATTERN.test(sentence)) {
      focusIndexes.push(index);
    }
  });

  if (focusIndexes.length === 0) {
    return [{ title, text: sentences.slice(0, 3).join("；") || text }];
  }

  for (const index of focusIndexes) {
    const start = Math.max(0, index - 1);
    const end = Math.min(sentences.length - 1, index + 1);
    const candidateText = sentences.slice(start, end + 1).join("；");
    const key = normalizeTextKey(candidateText).slice(0, 200);
    if (!candidateText || seen.has(key)) {
      continue;
    }
    seen.add(key);
    windows.push({ title, text: candidateText });
  }

  return windows.length > 0 ? windows : [{ title, text: sentences.slice(0, 3).join("；") || text }];
}

function scoreSection(section, source, index) {
  const text = cleanText(section?.text || "");
  const title = cleanText(section?.title || "");
  const topics = new Set();
  let score = 0;

  if (!text || isSensitiveNoiseLine(text)) {
    return {
      sourceName: source?.sourceName || source?.name || "",
      sourceUrl: source?.sourceUrl || source?.url || "",
      title: title || `条款片段 ${index + 1}`,
      text: "",
      score: 0,
      topics: []
    };
  }

  if (title && /付款方式|支付方式|结算方式/.test(title)) {
    score += 50;
    topics.add("payment");
  }

  for (const rule of TOPIC_RULES) {
    const hitCount = rule.keywords.filter((keyword) => text.includes(keyword) || title.includes(keyword)).length;
    if (hitCount > 0) {
      topics.add(rule.topic);
      score += hitCount * rule.weight;
    }
  }

  if (/(收到.*发票.*\d+个?(?:工作日|自然日|日内)|验收通过.*付款|支付合同总额的?\d+%|分[一二三四五六七八九十\d]+期)/.test(text)) {
    score += 20;
  }
  if (/\d+个?(?:工作日|自然日|日内)/.test(text)) {
    score += 12;
    topics.add("deadline");
  }
  if (/\d+(?:\.\d+)?%/.test(text)) {
    score += 10;
    topics.add("installment");
  }
  if (/(税率|增值税).{0,12}\d+(?:\.\d+)?%|\d+(?:\.\d+)?%\s*(?:税率|增值税)/.test(text)) {
    score += 10;
  }
  if (/(上限|封顶|不超过|累计|总额).{0,24}(?:¥|￥|人民币|\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元))/.test(text)) {
    score += 10;
  }

  if (NEGATIVE_KEYWORDS.some((keyword) => text.includes(keyword)) && !topics.has("payment")) {
    score -= 20;
  }

  return {
    sourceName: source?.sourceName || source?.name || "",
    sourceUrl: source?.sourceUrl || source?.url || "",
    title: title || `条款片段 ${index + 1}`,
    text,
    score,
    topics: Array.from(topics)
  };
}

function dedupeCandidates(candidates) {
  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.sourceName}|${normalizeTextKey(item.text).slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function detectPaymentMode(candidates, fallbackText = "") {
  const combined = [candidates.map((item) => item.text).join("\n"), cleanText(fallbackText)].filter(Boolean).join("\n");
  if (/分期|首付款|尾款|第一期|第二期|第三期|比例|阶段支付/.test(combined)) return "分期/按节点";
  if (/每月|月结|按月|月租|月费/.test(combined)) return "按月结算";
  if (/一次性|一次付清|一次支付|安装调试费/.test(combined)) return "一次性付款";
  return "未明确";
}

function detectRequirement(candidates, pattern) {
  const matched = candidates.find((item) => pattern.test(item.text));
  if (!matched) return "未明确";
  return snippetSentence(matched.text, pattern);
}

function detectPaymentDeadline(candidates) {
  for (const item of candidates) {
    const match =
      item.text.match(/(?:收到|验收通过后?|开票后?)?.{0,20}?(\d+个?(?:工作日|自然日|日内)[^。；;\n]*)/) ||
      item.text.match(/(次月\d{1,2}日前[^。；;\n]*)/);
    if (match) return cleanText(match[1]);
  }
  return "未明确";
}

function detectInstallments(candidates) {
  const matched = candidates
    .filter((item) => /分期|首付款|尾款|第一期|第二期|第三期|比例|\d+(?:\.\d+)?%/.test(item.text))
    .slice(0, 3)
    .map((item) => snippetSentence(item.text, /分期|首付款|尾款|第一期|第二期|第三期|比例|\d+(?:\.\d+)?%/))
    .filter(Boolean);
  return matched.length > 0 ? matched.join("；") : "未明确";
}

function detectAccountChangeRequirement(candidates) {
  const matched = candidates.find((item) => /账户变更|收款账户|开户行|书面通知/.test(item.text));
  return matched ? snippetSentence(matched.text, /账户变更|收款账户|开户行|书面通知/) : "未明确";
}

function detectTaxRate(candidates) {
  const ratePattern = /\d+(?:\.\d+)?%/;
  const taxKeywordPattern = /税|稅|税率|增值税|发票|专票|普票/i;
  const excludePattern = /违约|赔偿|返还|低于|高于|以上|以下|误差|样品/i;

  for (const item of candidates) {
    const matched = splitSentences(item.text).find((sentence) => ratePattern.test(sentence) && taxKeywordPattern.test(sentence));
    if (matched) return cleanText(matched);
  }

  for (const item of candidates) {
    const matched = splitSentences(item.text).find((sentence) => ratePattern.test(sentence) && !excludePattern.test(sentence));
    if (matched) return cleanText(matched);
  }

  return "未提取";
}

function detectCapAmount(candidates) {
  const capPattern = /(?:上限|封顶|最高|不超过|累计|总额).{0,24}(?:¥|￥|人民币|\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元))/i;
  const noCapPattern = /无金额上限|不设上限|上限不限|无封顶/i;

  for (const item of candidates) {
    const noCap = splitSentences(item.text).find((sentence) => noCapPattern.test(sentence));
    if (noCap) return cleanText(noCap);
    const capped = splitSentences(item.text).find((sentence) => capPattern.test(sentence));
    if (capped) return cleanText(capped);
  }

  return "未提取";
}

function snippetSentence(text, pattern) {
  const normalized = cleanText(text);
  const sentences = splitSentences(normalized);
  return sentences.find((item) => pattern.test(item)) || normalized.slice(0, 160);
}

function splitSentences(text) {
  return cleanText(text)
    .split(/[。；;\n]/)
    .map((item) => cleanText(item))
    .filter((item) => item && item.length >= 6);
}

function normalizeTextKey(text) {
  return cleanText(text).replace(/\s+/g, "").toLowerCase();
}

function isSensitiveNoiseLine(line) {
  const text = cleanText(line || "");
  if (!text) return true;
  return SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

function isLikelyTableNoiseLine(line) {
  const text = cleanText(line || "");
  if (!text) return false;
  if (FOCUSED_SENTENCE_PATTERN.test(text)) {
    return false;
  }
  const commaCount = (text.match(/[,，]/g) || []).length;
  const slashCount = (text.match(/[\\/]/g) || []).length;
  const quoteCount = (text.match(/["“”]/g) || []).length;
  return text.length > 120 && (commaCount >= 6 || slashCount >= 6 || quoteCount >= 4);
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}
