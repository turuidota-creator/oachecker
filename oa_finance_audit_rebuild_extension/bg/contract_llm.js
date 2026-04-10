import { cleanText } from "./common.js";

const CONTRACT_LLM_ENDPOINT = "https://api.siliconflow.cn/v1/chat/completions";
const CONTRACT_LLM_MODEL = "Qwen/Qwen2.5-32B-Instruct";
const CONTRACT_LLM_API_KEY = "sk-osbgxzgaztstxsctxwonjdjskogzqygxzgaezsbqepouilko";
const MAX_CLAUSE_TEXT_LENGTH = 240;
const STRIPPED_LINE_PATTERNS = [
  /^(?:甲方|乙方)\s*[：:]/,
  /^(?:地址|邮编|联系人|电话|邮箱|E-?Mail|邮件地址|签署日期|身份证号|固定网络IP)\s*[：:]/i,
  /^(?:双方项目负责人|甲方验收人|乙方负责人|商务负责人|项目负责人)\s*[：:]/,
  /^(?:账户名称|开户行|账\s*号|帐\s*号|账号|账户名)\s*[：:]/,
  /^(?:乙方账户信息|乙方关联公司.*账户信息)/,
  /^附件[一二三四五六七八九十0-9]/
];

export async function summarizeContractCandidatesWithLlm(payload) {
  const { prepared, body } = buildContractLlmRequest(payload);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("contract_llm_timeout"), 90000);

  try {
    const response = await fetch(CONTRACT_LLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONTRACT_LLM_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`合同摘要接口请求失败: ${response.status}`);
    }

    const data = await response.json();
    const content = cleanText(data?.choices?.[0]?.message?.content || "");
    if (!content) {
      throw new Error("合同摘要接口返回空内容");
    }

    const parsed = JSON.parse(extractJsonText(content));
    return restorePayload(parsed, prepared.redactionMap);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildContractLlmPreview(payload) {
  const { body } = buildContractLlmRequest(payload);
  return {
    endpoint: CONTRACT_LLM_ENDPOINT,
    model: CONTRACT_LLM_MODEL,
    body
  };
}

function buildContractLlmRequest(payload) {
  const prepared = redactPayloadStrict(payload);
  const body = {
    model: CONTRACT_LLM_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You extract payment-related contract summaries for display only. Do not decide whether payment should be approved. Return strict JSON only. Required keys: payment_mode, payment_terms_summary, acceptance_requirement, invoice_requirement, payment_deadline, installments, account_change_requirement, tax_rate, cap_amount, evidence_clause_ids. For tax_rate, only return an explicit percentage like 6% or 13%; if the clauses only mention invoice type such as 增值税专用发票 without a percentage, return 未提取. For cap_amount, only return an explicit cap statement like 不超过人民币100万元 or 无金额上限; otherwise return 未提取."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Summarize payment-related contract terms for display. Use only the provided clause candidates. Do not invent facts.",
            contract_context: {
              process_code: prepared.processCode,
              contract_title: prepared.contractTitle,
              effective_start: prepared.effectiveStart,
              effective_end: prepared.effectiveEnd
            },
            clause_candidates: prepared.candidates.map((item) => ({
              clause_id: item.clauseId,
              source_name: item.sourceName,
              topics: item.topics,
              text: item.text
            })),
            output_schema: {
              payment_mode: "string",
              payment_terms_summary: "string",
              acceptance_requirement: "string",
              invoice_requirement: "string",
              payment_deadline: "string",
              installments: "string",
              account_change_requirement: "string",
              tax_rate: "string",
              cap_amount: "string",
              evidence_clause_ids: ["string"]
            }
          },
          null,
          2
        )
      }
    ]
  };

  return { prepared, body };
}

function redactPayloadStrict(payload) {
  const redactionMap = [];
  const placeholders = new Map();
  const attachmentPrefixPattern = /^([^:：]+[:：]\s*)(.+)$/;

  const register = (raw, prefix) => {
    const text = cleanText(raw);
    if (!text) return "";
    if (placeholders.has(text)) return placeholders.get(text);
    const token = `<${prefix}_${String(placeholders.size + 1).padStart(2, "0")}>`;
    placeholders.set(text, token);
    redactionMap.push({ raw: text, token });
    return token;
  };

  const replaceTokens = (text) => {
    let output = stripSensitiveNoise(cleanText(text));
    if (!output) return "";

    const directReplacements = [
      [payload?.facts?.counterpartyCompany, "PARTY"],
      [payload?.target?.payeeCompany, "PAYEE"],
      [payload?.facts?.contractAccountNo, "BANK_ACC"],
      [payload?.target?.payeeAccount, "BANK_ACC"],
      [payload?.facts?.processCode, "CONTRACT_NO"],
      [payload?.target?.processCode, "PAYMENT_NO"],
      [payload?.facts?.processTitle, "CONTRACT_TITLE"],
      [payload?.contractTitle, "CONTRACT_TITLE"],
      [payload?.target?.processTitle, "PAYMENT_TITLE"],
      [payload?.target?.paymentAmount, "AMOUNT"]
    ];

    for (const [raw, prefix] of directReplacements) {
      const normalized = cleanText(raw);
      if (!normalized) continue;
      const token = register(normalized, prefix);
      output = output.split(normalized).join(token);
    }

    output = replaceLabeledFieldValues(output, register);
    output = replaceByPattern(output, /\b(?:[A-Z0-9._%+-]\s*){2,}@\s*(?:[A-Z0-9.-]\s*)+\.\s*(?:[A-Z]\s*){2,}\b/gi, "EMAIL", register);
    output = replaceByPattern(output, /(?<!\d)(?:1\s*[3-9](?:\s*\d){9})(?!\d)/g, "PHONE", register);
    output = replaceByPattern(output, /(?<![\dXx])(?:\d\s*){17}[\dXx](?![\dXx])/g, "ID_NO", register);
    output = replaceByPattern(output, /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, "IP_ADDR", register);
    output = replaceByPattern(output, /\b20\s*\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*(?:日)?(?:\s*[~到至-]\s*20\s*\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*(?:日)?)?/g, "DATE", register);
    output = replaceByPattern(output, /\b\d+(?:\s*\.\s*\d+)?\s*%/g, "RATE", register);
    output = replaceByPattern(output, /(?:人民币)?\s*\d(?:[\d,\s]{0,20}\d)?(?:\s*\.\s*\d{1,2})?\s*(?:元|万元|亿元)/g, "AMOUNT", register);
    output = replaceByPattern(output, /(?:￥|¥)\s*\d(?:[\d,\s]{0,20}\d)?(?:\s*\.\s*\d{1,2})?/g, "AMOUNT", register);
    output = replaceByPattern(output, /(?:中国(?:工商|农业|建设|银行|邮政储蓄银行|邮储银行)|工商银行|农业银行|建设银行|交通银行|招商银行|浦发银行|民生银行|兴业银行|中信银行|光大银行|平安银行|华夏银行|广发银行|北京银行|上海银行|农商银行|商业银行|信用社)[^\n，。；;:：]{0,24}(?:支行|分行|营业部|银行)?/g, "BANK_NAME", register);
    output = replaceByPattern(
      output,
      /(?:[A-Za-z0-9\u4e00-\u9fa5·()（）&\-\s]{3,60}\.(?:pdf|doc|docx|xls|xlsx|csv|ofd|png|jpg|jpeg|msg|eml|zip))/gi,
      "ATTACHMENT",
      register
    );
    output = replaceByPattern(output, /《[^》\n]{2,48}(?:验收单|采购订单|报价单|合同|协议)》/g, "DOC_TITLE", register);
    output = replaceLabeledNames(output, register);
    output = replaceByPattern(
      output,
      /(?:[\u4e00-\u9fa5A-Za-z0-9·()（）&\-]{4,60}(?:有限公司|集团有限公司|股份有限公司|有限责任公司|公司|中心|分行|支行|营业部))/g,
      "ORG",
      register
    );
    output = replaceByPattern(output, /\b(?:[A-Z]{1,8}-)?\d{6,}(?:-\d+)?\b/g, "DOC_NO", register);
    output = output.replace(/(?<!\d)(?:\d\s*){8,}(?!\d)/g, (match) => register(match, "BANK_ACC") || match);
    return trimClauseText(output);
  };

  const redactSourceName = (sourceName) => {
    const normalized = cleanText(sourceName);
    if (!normalized) return "";
    const prefixed = normalized.match(attachmentPrefixPattern);
    if (prefixed?.[1] && prefixed?.[2]) {
      return `${prefixed[1]}${register(prefixed[2], "ATTACHMENT")}`;
    }
    return register(normalized, "ATTACHMENT");
  };

  return {
    processCode: replaceTokens(payload?.facts?.processCode || ""),
    contractTitle: replaceTokens(payload?.facts?.processTitle || ""),
    effectiveStart: replaceTokens(payload?.facts?.effectiveStart || ""),
    effectiveEnd: replaceTokens(payload?.facts?.effectiveEnd || ""),
    candidates: (payload?.candidates || []).map((item) => ({
      ...item,
      sourceName: redactSourceName(item.sourceName),
      text: replaceTokens(item.text)
    })),
    redactionMap
  };
}

function restorePayload(parsed, redactionMap) {
  const restoreText = (value) => {
    if (typeof value !== "string") return value;
    let output = value;
    for (const item of redactionMap || []) {
      output = output.split(item.token).join(item.raw);
    }
    return output;
  };

  return {
    paymentMode: restoreText(parsed?.payment_mode || ""),
    paymentTermsSummary: restoreText(parsed?.payment_terms_summary || ""),
    acceptanceRequirement: restoreText(parsed?.acceptance_requirement || ""),
    invoiceRequirement: restoreText(parsed?.invoice_requirement || ""),
    paymentDeadline: restoreText(parsed?.payment_deadline || ""),
    installments: normalizeInstallments(restoreText(parsed?.installments || "")),
    accountChangeRequirement: restoreText(parsed?.account_change_requirement || ""),
    taxRate: normalizeTaxRate(restoreText(parsed?.tax_rate || "")),
    capAmount: normalizeCapAmount(restoreText(parsed?.cap_amount || "")),
    evidenceClauseIds: Array.isArray(parsed?.evidence_clause_ids) ? parsed.evidence_clause_ids.map((item) => restoreText(item)) : []
  };
}

function extractJsonText(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }
  return content;
}

function replaceByPattern(text, pattern, prefix, register) {
  return String(text || "").replace(pattern, (match) => register(match, prefix) || match);
}

function replaceLabeledFieldValues(text, register) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      const normalized = cleanText(line);
      if (!normalized) {
        return "";
      }

      const match = normalized.match(
        /^((?:甲方|乙方|地址|邮编|联系人|电话|邮箱|E-?Mail|邮件地址|签署日期|身份证号|固定网络IP|账户名称|账户名|开户行|账\s*号|帐\s*号|账号|工号|合同编号|流程编号|订单号|发票号码)\s*[：:]\s*)(.+)$/i
      );
      if (!match) {
        return normalized;
      }

      const label = match[1];
      const value = match[2];
      const prefix = inferFieldPrefix(label);
      return `${label}${register(value, prefix)}`;
    })
    .filter(Boolean)
    .join("\n");
}

function replaceLabeledNames(text, register) {
  return String(text || "").replace(
    /((?:联系人|验收人|负责人|商务负责人|项目负责人|甲方验收人|乙方负责人)\s*[：:]\s*[【\[]?)([\u4e00-\u9fa5·]{2,4})([】\]]?)/g,
    (_, start, name, end) => `${start}${register(name, "PERSON")}${end}`
  );
}

function trimClauseText(text) {
  const normalized = cleanText(text);
  if (normalized.length <= MAX_CLAUSE_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CLAUSE_TEXT_LENGTH)}……`;
}

function stripSensitiveNoise(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line && !STRIPPED_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n");
}

function inferFieldPrefix(label) {
  const normalized = cleanText(label);
  if (/甲方|乙方/.test(normalized)) return "PARTY";
  if (/地址/.test(normalized)) return "ADDRESS";
  if (/邮编/.test(normalized)) return "POSTCODE";
  if (/联系人/.test(normalized)) return "PERSON";
  if (/电话/.test(normalized)) return "PHONE";
  if (/邮箱|E-?Mail|邮件地址/i.test(normalized)) return "EMAIL";
  if (/签署日期/.test(normalized)) return "DATE";
  if (/身份证/.test(normalized)) return "ID_NO";
  if (/固定网络IP/.test(normalized)) return "IP_ADDR";
  if (/开户行/.test(normalized)) return "BANK_NAME";
  if (/账\s*号|帐\s*号|账号|账户名称|账户名/.test(normalized)) return "BANK_ACC";
  if (/合同编号|流程编号|订单号|发票号码|工号/.test(normalized)) return "DOC_NO";
  return "FIELD";
}

function normalizeInstallments(value) {
  const text = cleanText(value || "");
  if (!text) return "";
  if (/无分期|未提取|未明确/.test(text)) return "未提取";
  return text;
}

function normalizeTaxRate(value) {
  const text = cleanText(value || "");
  if (!text) return "";
  if (/\d+(?:\.\d+)?%/.test(text)) return text;
  if (/未提取|未明确|无/.test(text)) return "未提取";
  return "";
}

function normalizeCapAmount(value) {
  const text = cleanText(value || "");
  if (!text) return "";
  if (/未提取|未明确/.test(text)) return "未提取";
  if (/无金额上限|不设上限|上限不限|无封顶/.test(text)) return text;
  if (/(上限|封顶|最高|不超过|累计|总额)/.test(text) && /(?:人民币)?\s*\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元)/.test(text)) {
    return text;
  }
  return "";
}
