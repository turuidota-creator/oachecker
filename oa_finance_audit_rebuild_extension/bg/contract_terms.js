import { cleanText } from "./common.js";

const TOPIC_RULES = [
  { topic: "payment", keywords: ["付款", "支付", "结算", "价款", "款项", "费用", "服务费", "合同款", "应付"], weight: 15 },
  { topic: "acceptance", keywords: ["验收", "验收通过", "验收合格", "交付", "签收", "确认", "交付件", "成片", "源文件"], weight: 12 },
  { topic: "invoice", keywords: ["发票", "开票", "专票", "普票", "票据", "增值税", "税票"], weight: 10 },
  { topic: "deadline", keywords: ["工作日", "自然日", "日内", "次月", "月结", "按月", "月底", "月度终了", "季度"], weight: 10 },
  { topic: "installment", keywords: ["分期", "首付款", "尾款", "第一期", "第二期", "第三期", "比例", "阶段支付", "节点支付"], weight: 12 },
  { topic: "account", keywords: ["收款账户", "银行账号", "开户行", "账户变更", "书面通知", "指定账户"], weight: 8 },
  {
    topic: "performance",
    keywords: [
      "KPI",
      "考核",
      "评分",
      "达标",
      "未达标",
      "效果",
      "投放",
      "曝光",
      "点击",
      "转化",
      "激活",
      "留存",
      "ROI",
      "CPA",
      "CPS",
      "CPM",
      "CPC",
      "播放量",
      "下载量",
      "注册量",
      "结算依据",
      "对账",
      "审核确认",
      "扣减",
      "扣费",
      "补量",
      "退款",
      "后台实际消耗",
      "账号消耗",
      "充值",
      "垫款"
    ],
    weight: 13
  },
  {
    topic: "term",
    keywords: [
      "期限",
      "期间",
      "有效期",
      "服务期",
      "租赁期",
      "租期",
      "起至",
      "届满",
      "到期",
      "终止",
      "续签",
      "自动续展",
      "自动延长",
      "一年一签",
      "以订单为准",
      "持续有效"
    ],
    weight: 12
  }
];

const CONTRACT_TYPE_RULES = [
  {
    type: "property",
    label: "物业租赁/水电",
    keywords: ["租赁", "租金", "物业费", "物业管理费", "水电", "电费", "押金", "保证金", "月租", "办公区域"]
  },
  {
    type: "performance_marketing",
    label: "买量投放/广告",
    keywords: [
      "投放",
      "买量",
      "广告",
      "广点通",
      "信息流",
      "曝光",
      "点击",
      "转化",
      "激活",
      "留存",
      "ROI",
      "CPA",
      "CPS",
      "CPM",
      "CPC",
      "消耗",
      "充值",
      "垫款",
      "对账",
      "结算单",
      "推广服务费",
      "广告代理费",
      "广告发布费"
    ]
  },
  {
    type: "creative_outsourcing",
    label: "美术视频外包",
    keywords: ["美术", "视频", "动画", "脚本", "分镜", "成片", "渲染", "配音", "字幕", "设计稿", "源文件", "修改次数"]
  },
  {
    type: "software_service",
    label: "软件授权/订阅",
    keywords: ["软件", "授权", "许可", "license", "许可证", "订阅", "续费", "激活码", "账号开通", "技术支持", "维护服务", "维保"]
  },
  {
    type: "copyright_service",
    label: "软著/版权代理",
    keywords: ["软著", "软件著作权", "版权登记", "著作权", "登记证书", "受理通知书", "代理费", "代理服务"]
  },
  {
    type: "survey_research",
    label: "问卷调查/研究",
    keywords: ["问卷", "调查", "样本量", "回收量", "有效样本", "答卷", "研究报告", "数据清洗", "质检", "交叉分析", "访问员"]
  }
];

const NEGATIVE_KEYWORDS = ["保密", "知识产权", "争议解决", "不可抗力", "适用法律", "违约责任"];

const LIMITATION_RULES = [
  { label: "有例外", pattern: /但|但是|除非|另有约定除外|另行约定|另行签署/i },
  { label: "有前提", pattern: /前提是|待.+后|经.+后|收到.+后|验收(?:通过|合格)?后|审核确认后|对账确认后|开具发票后|达成.+后/i },
  { label: "有扣减", pattern: /未达标|不达标|扣减|扣费|扣款|核减|折扣|折让|补量|退款/i },
  { label: "可暂缓", pattern: /有权暂缓|暂停支付|延期支付|暂不支付|不予结算/i },
  { label: "自动续展", pattern: /自动续展|自动延长|续签|顺延/i },
  { label: "订单覆盖", pattern: /以订单为准|以采购订单为准|以订单约定为准|以补充协议为准/i }
];

const SENSITIVE_LINE_PATTERNS = [
  /^(?:甲方|乙方|丙方)\s*[：:]/,
  /^(?:地址|邮编|联系人|联系电话|邮箱|E-?mail|邮件地址|签署日期|身份证号|固定网络IP)\s*[：:]/i,
  /^(?:双方项目负责人|甲方验收人|乙方负责人|商务负责人|项目负责人)\s*[：:]/,
  /^(?:账户名称|开户行|开户银行|银行账号|账号)\s*[：:]/,
  /^(?:乙方账户信息|关联公司账户信息)/,
  /^(?:签字页|盖章页|签署页)/,
  /^(?:法定代表人|授权代表)\s*[：:]/
];

const APPENDIX_START_PATTERN = /^附件[一二三四五六七八九十0-9]/;

const HEADING_PATTERN =
  /^(第[一二三四五六七八九十0-9]+条|[一二三四五六七八九十]+、|\d+[.、]|付款方式|支付方式|结算方式|付款条件|结算依据|验收|发票|账户变更|收款账户|开户行|合同期限|服务期限|租赁期限|有效期|考核|对账|费用结算)/;

const STRONG_PAYMENT_PATTERNS = [
  /(?:收到|开具).{0,20}发票.{0,20}(?:支付|付款|结算)/,
  /(?:验收|交付|签收|审核确认|对账确认|考核(?:合格)?|达标).{0,20}(?:后|完成后).{0,20}(?:支付|付款|结算)/,
  /(?:按月|月结|次月|工作日内|自然日内).{0,20}(?:支付|付款|结算)/,
  /(?:预付款|首付款|尾款|分期|阶段支付|节点支付)/,
  /(?:据实结算|按实际消耗结算|按投放效果结算|按完成率结算|按考核结果结算)/,
  /(?:充值|垫款|推广服务费|广告代理费|广告发布费|账号消耗|后台实际消耗).{0,20}(?:结算|支付|确认)/
];

const STRONG_TERM_PATTERNS = [
  /(?:有效期|服务期|租赁期|租期|合同期限).{0,24}(?:自|起).{0,40}(?:至|止)/,
  /(?:一年一签|自动续展|自动延长|续签|顺延)/,
  /(?:以订单为准|以采购订单为准|以补充协议为准|持续有效)/
];

const ALL_FOCUS_KEYWORDS = Array.from(
  new Set([
    ...TOPIC_RULES.flatMap((rule) => rule.keywords),
    ...CONTRACT_TYPE_RULES.flatMap((rule) => rule.keywords),
    "据实结算",
    "审核确认",
    "结算表",
    "考核后支付",
    "服务质量考评",
    "满意度",
    "一年一签",
    "书面通知",
    "终止"
  ])
);

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
    .slice(0, 10)
    .map((item, index) => ({
      clauseId: `clause_${String(index + 1).padStart(2, "0")}`,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      title: item.title,
      score: item.score,
      topics: item.topics,
      text: item.text,
      pageLabel: item.pageLabel,
      matchedKeywords: item.matchedKeywords,
      restrictionFlags: item.restrictionFlags,
      contractTypes: item.contractTypes
    }));
}

export function deriveLocalContractSummary(candidates = [], baseFacts = {}) {
  const fallbackText = firstNonEmptyText(baseFacts.paymentTerms);
  const paymentMode = detectPaymentMode(candidates, fallbackText);
  const paymentTermsSummary = detectPaymentTermsSummary(candidates, fallbackText);
  const acceptanceRequirement = detectAcceptanceRequirement(candidates);
  const invoiceRequirement = detectInvoiceRequirement(candidates, fallbackText);
  const paymentDeadline = detectPaymentDeadline(candidates, fallbackText, paymentTermsSummary);
  const installments = detectInstallments(candidates);
  const accountChangeRequirement = detectAccountChangeRequirement(candidates);
  const taxRate = detectTaxRate(candidates);
  const capAmount = detectCapAmount(candidates);
  const paymentClauseEvidence = pickTopicEvidence(candidates, ["payment", "performance", "invoice", "acceptance", "deadline"], 5);
  const termClauseEvidence = pickTopicEvidence(candidates, ["term"], 4);
  const restrictionHints = collectRestrictionHints(candidates);
  const conflictHints = detectConflictHints(candidates, fallbackText);
  const detectedContractTypes = detectContractTypes(candidates, fallbackText);

  return {
    mode: candidates.length > 0 ? "local" : "none",
    statusText: candidates.length > 0 ? "本地摘录" : "未生成",
    paymentMode,
    paymentTermsSummary: paymentTermsSummary || "未从合同条款中提取到明确付款信息",
    acceptanceRequirement,
    invoiceRequirement,
    paymentDeadline,
    installments,
    accountChangeRequirement,
    taxRate,
    capAmount,
    evidenceClauses: candidates.slice(0, 4),
    paymentClauseEvidence,
    termClauseEvidence,
    restrictionHints,
    conflictHints,
    detectedContractTypes
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
    if (APPENDIX_START_PATTERN.test(line) && !hasFocusSignal(line)) {
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
  return HEADING_PATTERN.test(cleanText(text));
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
    if (hasFocusSignal(sentence, title)) {
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
    const key = normalizeTextKey(candidateText).slice(0, 240);
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
  const matchedKeywords = new Set();
  const restrictionFlags = new Set();
  const contractTypes = new Set();
  let score = 0;

  if (!text || isSensitiveNoiseLine(text)) {
    return createScoredSection(source, title || `条款片段 ${index + 1}`, "", 0, topics, matchedKeywords, restrictionFlags, contractTypes);
  }

  if (title && /付款方式|支付方式|结算方式|付款条件|结算依据/.test(title)) {
    score += 50;
    topics.add("payment");
  }
  if (title && /合同期限|服务期限|租赁期限|有效期|期限/.test(title)) {
    score += 40;
    topics.add("term");
  }
  if (title && /考核|对账|结算依据/.test(title)) {
    score += 28;
    topics.add("performance");
  }

  for (const rule of TOPIC_RULES) {
    const hits = rule.keywords.filter((keyword) => text.includes(keyword) || title.includes(keyword));
    if (hits.length > 0) {
      topics.add(rule.topic);
      hits.forEach((keyword) => matchedKeywords.add(keyword));
      score += hits.length * rule.weight;
    }
  }

  for (const rule of CONTRACT_TYPE_RULES) {
    const hits = rule.keywords.filter((keyword) => text.includes(keyword) || title.includes(keyword));
    if (hits.length > 0) {
      contractTypes.add(rule.label);
      hits.forEach((keyword) => matchedKeywords.add(keyword));
      score += Math.min(hits.length, 3) * 6;
    }
  }

  for (const pattern of STRONG_PAYMENT_PATTERNS) {
    if (pattern.test(text)) {
      score += 18;
      topics.add("payment");
    }
  }

  for (const pattern of STRONG_TERM_PATTERNS) {
    if (pattern.test(text)) {
      score += 18;
      topics.add("term");
    }
  }

  for (const rule of LIMITATION_RULES) {
    if (rule.pattern.test(text)) {
      restrictionFlags.add(rule.label);
      score += 8;
    }
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
  if (/(上限|封顶|不超过|累计|总额).{0,24}(?:人民币)?\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元)/.test(text)) {
    score += 10;
  }

  if (NEGATIVE_KEYWORDS.some((keyword) => text.includes(keyword)) && !topics.has("payment") && !topics.has("term") && !topics.has("performance")) {
    score -= 20;
  }

  return createScoredSection(
    source,
    title || `条款片段 ${index + 1}`,
    text,
    score,
    topics,
    matchedKeywords,
    restrictionFlags,
    contractTypes
  );
}

function createScoredSection(source, title, text, score, topics, matchedKeywords, restrictionFlags, contractTypes) {
  return {
    sourceName: source?.sourceName || source?.name || "",
    sourceUrl: source?.sourceUrl || source?.url || "",
    title,
    text,
    score,
    topics: Array.from(topics),
    matchedKeywords: Array.from(matchedKeywords),
    restrictionFlags: Array.from(restrictionFlags),
    contractTypes: Array.from(contractTypes),
    pageLabel: cleanText(source?.pageLabel || source?.page || "")
  };
}

function dedupeCandidates(candidates) {
  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.sourceName}|${normalizeTextKey(item.text).slice(0, 180)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function detectPaymentMode(candidates, fallbackText = "") {
  const combined = [candidates.map((item) => item.text).join("\n"), cleanText(fallbackText)].filter(Boolean).join("\n");
  if (/分期|首付款|尾款|第一期|第二期|第三期|阶段支付|节点支付|支付合同总额.{0,8}%/.test(combined)) return "分期/按节点";
  if (/每月|月结|按月|月租|月费|次月/.test(combined)) return "按月结算";
  if (/充值|垫款|预付|预充值/.test(combined)) return "预付/充值";
  if (/据实结算|按实际消耗结算|按投放效果结算|按完成率结算|按考核结果结算/.test(combined)) return "按结果/据实结算";
  if (/一次性|一次付清|一次支付/.test(combined)) return "一次性付款";
  return "未明确";
}

function detectRequirement(candidates, pattern) {
  const matched = findBestSentence(candidates, (sentence) => {
    if (!pattern.test(sentence)) return -1;
    let score = 40;
    if (/后|完成后|通过后|合格后|提交后|确认后/.test(sentence)) score += 10;
    if (sentence.length <= 80) score += 8;
    return score;
  });
  return matched || "未明确";
}

function detectAcceptanceRequirement(candidates) {
  return detectRequirement(candidates, /验收(?:通过|合格)?|交付(?:件)?|签收|成果(?:文件)?|成片|源文件|测试报告|结项确认/);
}

function detectInvoiceRequirement(candidates, fallbackText = "") {
  const candidateSentence = findBestSentence(candidates, scoreInvoiceSentence);
  const fallbackSentence = pickBestFallbackSentence(fallbackText, scoreInvoiceSentence);
  const chosen = pickBestScoredText(candidateSentence, fallbackSentence, scoreInvoiceSentence);
  return chosen ? extractInvoiceSnippet(chosen) : "未明确";
}

function detectPaymentTermsSummary(candidates, fallbackText = "") {
  const candidateSentence = findBestSentence(candidates, scorePaymentSummarySentence);
  const fallbackSentence = pickBestFallbackSentence(fallbackText, scorePaymentSummarySentence);
  return pickBestScoredText(candidateSentence, fallbackSentence, scorePaymentSummarySentence) || "";
}

function detectPaymentDeadline(candidates, fallbackText = "", paymentSummary = "") {
  const patterns = [
    /((?:收到|验收(?:通过|合格)?|审核确认|对账确认|开票后|开具发票后|达标后)[^。；;\n]{0,30}?\d+\s*个?\s*(?:(?:工作日|自然日)(?:内)?|日内)[^。；;\n]*)/,
    /(\d+\s*个?\s*(?:(?:工作日|自然日)(?:内)?|日内)(?:完成付款|完成支付|支付|付款|结算)?)/,
    /(次月\d{1,2}日前[^。；;\n]*)/,
    /((?:每月|按月|月结|季度)\S{0,20}(?:结算|支付)[^。；;\n]*)/
  ];

  const texts = [
    ...candidates.map((item) => normalizeClauseText(item.text)),
    normalizeClauseText(paymentSummary),
    normalizeClauseText(fallbackText)
  ].filter(Boolean);

  for (const text of texts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return cleanClauseDisplayText(match[1]);
      }
    }
  }

  return "未明确";
}

function detectInstallments(candidates) {
  const matched = candidates
    .filter((item) => /分期|首付款|尾款|第一期|第二期|第三期|阶段支付|节点支付|支付合同总额.{0,8}%|\d+(?:\.\d+)?%\s*(?:作为|支付|付款)/.test(item.text))
    .slice(0, 3)
    .map((item) => snippetSentence(item.text, /分期|首付款|尾款|第一期|第二期|第三期|阶段支付|节点支付|支付合同总额.{0,8}%|\d+(?:\.\d+)?%\s*(?:作为|支付|付款)/))
    .filter(Boolean);

  return matched.length > 0 ? matched.join("；") : "未明确";
}

function detectAccountChangeRequirement(candidates) {
  const matched = findBestSentence(candidates, scoreAccountSentence);
  return matched || "未明确";
}

function detectTaxRate(candidates) {
  const ratePattern = /\d+(?:\.\d+)?%/;
  const taxKeywordPattern = /税|税率|增值税|发票|专票|普票/i;
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
  const capPattern = /(?:上限|封顶|最高|不超过|累计|总额).{0,24}(?:人民币)?\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元)/i;
  const noCapPattern = /无金额上限|不设上限|上限不限|无封顶/i;

  for (const item of candidates) {
    const noCap = splitSentences(item.text).find((sentence) => noCapPattern.test(sentence));
    if (noCap) return cleanText(noCap);
    const capped = splitSentences(item.text).find((sentence) => capPattern.test(sentence));
    if (capped) return cleanText(capped);
  }

  return "未提取";
}

function collectRestrictionHints(candidates) {
  const labels = new Set();
  for (const item of candidates) {
    for (const flag of Array.isArray(item?.restrictionFlags) ? item.restrictionFlags : []) {
      labels.add(flag);
    }
  }

  const hints = [];
  if (labels.has("有例外")) hints.push("发现例外条款表达，请人工确认是否存在附加限制");
  if (labels.has("有前提")) hints.push("发现付款或生效前提，请重点查看触发条件");
  if (labels.has("有扣减")) hints.push("发现扣减/补量/退款表达，请确认未达标后的处理方式");
  if (labels.has("可暂缓")) hints.push("发现暂缓或不予结算表达，请确认付款是否可能被延后");
  if (labels.has("自动续展")) hints.push("发现自动续展表达，请确认合同期限是否会自动延长");
  if (labels.has("订单覆盖")) hints.push("发现订单或补充协议覆盖表达，请确认最终以哪份文件为准");
  return hints;
}

function detectConflictHints(candidates, fallbackText = "") {
  const combined = [candidates.map((item) => item.text).join("\n"), cleanText(fallbackText)].filter(Boolean).join("\n");
  const hints = [];

  const hasTermBase = /(?:有效期|服务期|租赁期|租期|合同期限).{0,24}(?:自|起).{0,40}(?:至|止)|一年一签/.test(combined);
  const hasTermRenewal = /自动续展|自动延长|续签|顺延/.test(combined);
  const hasOrderOverride = /以订单为准|以采购订单为准|以补充协议为准/.test(combined);
  if (hasTermBase && hasTermRenewal) {
    hints.push("发现固定期限与续展条款并存，请人工确认最终期限");
  }
  if ((hasTermBase || hasTermRenewal) && hasOrderOverride) {
    hints.push("发现合同期限存在订单或补充协议覆盖条款，请人工确认");
  }

  const hasTimeTrigger = /工作日|自然日|日内|次月|月结|按月|季度/.test(combined);
  const hasPerformanceTrigger = /KPI|考核|达标|效果|投放|曝光|点击|转化|激活|留存|ROI|CPA|CPS|CPM|CPC|对账确认|审核确认|后台实际消耗|账号消耗|据实结算/.test(combined);
  if (hasTimeTrigger && hasPerformanceTrigger) {
    hints.push("发现时间型付款条款与 KPI/结果型付款条款并存，请人工确认真实付款前提");
  }

  const hasInvoiceTrigger = /收到.*发票|开具.*发票|开票后/.test(combined);
  const hasAcceptanceTrigger = /验收(?:通过|合格)?后|交付后|签收后/.test(combined);
  if (hasInvoiceTrigger && hasAcceptanceTrigger) {
    hints.push("发现发票条件与验收条件并存，请人工确认付款触发顺序");
  }

  const hasDeduction = /未达标|不达标|扣减|扣费|扣款|核减|补量|退款/.test(combined);
  const hasSuspend = /有权暂缓|暂停支付|延期支付|暂不支付|不予结算/.test(combined);
  if ((hasPerformanceTrigger || hasTimeTrigger) && (hasDeduction || hasSuspend)) {
    hints.push("发现付款条款附带扣减或暂缓条件，请人工确认是否影响本次付款");
  }

  return hints;
}

function detectContractTypes(candidates, fallbackText = "") {
  const combined = [candidates.map((item) => item.text).join("\n"), cleanText(fallbackText)].filter(Boolean).join("\n");
  if (!combined) return [];

  const scoredTypes = CONTRACT_TYPE_RULES.map((rule) => {
    const hitCount = rule.keywords.filter((keyword) => combined.includes(keyword)).length;
    return { label: rule.label, score: hitCount };
  })
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score);

  if (scoredTypes.length === 0) {
    return [];
  }

  const topScore = scoredTypes[0].score;
  return scoredTypes.filter((item) => item.score >= Math.max(2, topScore - 1)).slice(0, 2).map((item) => item.label);
}

function pickTopicEvidence(candidates, topics, limit) {
  const topicSet = new Set(topics);
  return candidates.filter((item) => item.topics.some((topic) => topicSet.has(topic))).slice(0, limit);
}

function snippetSentence(text, pattern) {
  const normalized = normalizeClauseText(text);
  const sentences = splitSentences(normalized);
  return cleanClauseDisplayText(sentences.find((item) => pattern.test(item)) || normalized.slice(0, 160));
}

function splitSentences(text) {
  return normalizeClauseText(text)
    .split(/[。；;\n]/)
    .map((item) => cleanText(item))
    .filter((item) => item && item.length >= 6);
}

function normalizeClauseText(text) {
  return cleanText(text)
    .replace(/(\d+)\s*个?\s*[；;，,、_]+\s*(工作日|自然日|日内)/g, "$1个$2")
    .replace(/(工作日|自然日)\s*[；;，,、_]+\s*(内)/g, "$1$2")
    .replace(/(增值)\s*[；;，,、_]+\s*(税)/g, "$1$2")
    .replace(/(专用)\s*[；;，,、_]+\s*(发票)/g, "$1$2")
    .replace(/(受理通知书)\s*[；;，,、_]+\s*(电子版)/g, "$1$2")
    .replace(/(结算单)\s*[；;，,、_]+\s*(及)/g, "$1$2")
    .replace(/(发票)\s*[；;，,、_]+\s*(经)/g, "$1经");
}

function cleanClauseDisplayText(text) {
  return cleanText(text).replace(/^\s*(?:第[一二三四五六七八九十0-9]+条|[一二三四五六七八九十0-9]+\s*[、.．])\s*/, "");
}

function findBestSentence(candidates, scorer) {
  let bestText = "";
  let bestScore = -1;

  for (const item of candidates) {
    for (const sentence of splitSentences(item.text)) {
      const score = scorer(sentence);
      if (score > bestScore) {
        bestScore = score;
        bestText = sentence;
      }
    }
  }

  return bestScore >= 0 ? cleanClauseDisplayText(bestText) : "";
}

function pickBestFallbackSentence(text, scorer) {
  let bestText = "";
  let bestScore = -1;

  for (const sentence of splitSentences(text)) {
    const score = scorer(sentence);
    if (score > bestScore) {
      bestScore = score;
      bestText = sentence;
    }
  }

  return bestScore >= 0 ? cleanClauseDisplayText(bestText) : "";
}

function pickBestScoredText(primary, fallback, scorer) {
  const primaryScore = scorer(primary);
  const fallbackScore = scorer(fallback);
  if (!primary) return fallback;
  if (!fallback) return primary;
  return fallbackScore > primaryScore ? fallback : primary;
}

function scorePaymentSummarySentence(sentence) {
  const text = cleanText(sentence);
  if (!text) return -1;
  if (!/支付|付款|结算/.test(text)) return -1;

  let score = 50;
  if (/收到|发票|开票|受理通知书|验收|签收|对账|确认|审核/.test(text)) score += 15;
  if (/工作日|自然日|次月|月结|按月|后付月结|预付|据实/.test(text)) score += 15;
  if (/税率|开票内容/.test(text)) score -= 12;
  if (/自动续展|自动延长|续签|有效期|合同期限/.test(text)) score -= 20;
  if (text.length <= 90) score += 10;
  if (text.length > 140) score -= 8;
  return score;
}

function scoreInvoiceSentence(sentence) {
  const text = cleanText(sentence);
  if (!text) return -1;
  if (!/发票|开票|专票|普票|增值税/.test(text)) return -1;

  let score = 35;
  if (/收到|开具|提交|提供|电子版|受理通知书/.test(text)) score += 12;
  if (/支付|付款|结算/.test(text)) score += 8;
  if (/税率|开票内容/.test(text) && !/收到|开具|提交|提供/.test(text)) score -= 12;
  if (text.length <= 90) score += 6;
  return score;
}

function extractInvoiceSnippet(sentence) {
  const text = cleanClauseDisplayText(sentence);
  const snippet =
    text.match(/(?:收到|开具|提交|提供)[^。；;\n]{0,60}?(?:发票|专票|普票|增值税专用发票)(?:后)?/)?.[0] ||
    text.match(/[^。；;\n]{0,40}(?:发票|专票|普票|增值税专用发票)(?:后)?/)?.[0] ||
    text;
  return cleanText(snippet);
}

function scoreAccountSentence(sentence) {
  const text = cleanText(sentence);
  if (!text) return -1;

  const directPattern = /账户变更|收款账户|收款信息|账户信息|银行账号|开户行|开户银行|指定账户|指定收款账户|付款至.*账户/;
  const notificationPattern = /书面通知/;
  const accountContextPattern = /账户|收款|开户|银行|账号/;

  if (!directPattern.test(text) && !(notificationPattern.test(text) && accountContextPattern.test(text))) {
    return -1;
  }

  let score = 40;
  if (/变更|通知|重新提供|以.*账户为准/.test(text)) score += 10;
  if (/自动续展|自动延长|续签|有效期|合同期限/.test(text)) score -= 30;
  return score;
}

function normalizeTextKey(text) {
  return cleanText(text).replace(/\s+/g, "").toLowerCase();
}

function hasFocusSignal(text, title = "") {
  const combined = `${cleanText(title)}\n${cleanText(text)}`;
  if (!combined.trim()) {
    return false;
  }
  if (STRONG_PAYMENT_PATTERNS.some((pattern) => pattern.test(combined))) {
    return true;
  }
  if (STRONG_TERM_PATTERNS.some((pattern) => pattern.test(combined))) {
    return true;
  }
  if (LIMITATION_RULES.some((rule) => rule.pattern.test(combined))) {
    return true;
  }
  return ALL_FOCUS_KEYWORDS.some((keyword) => combined.includes(keyword));
}

function isSensitiveNoiseLine(line) {
  const text = cleanText(line || "");
  if (!text) return true;
  if (hasFocusSignal(text)) {
    return false;
  }
  return SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

function isLikelyTableNoiseLine(line) {
  const text = cleanText(line || "");
  if (!text) return false;
  if (hasFocusSignal(text)) {
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
