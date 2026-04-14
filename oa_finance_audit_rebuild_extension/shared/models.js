(() => {
  const STATUS_TEXT = {
    pass: "\u901a\u8fc7",
    warn: "\u9884\u8b66",
    fail: "\u5f02\u5e38"
  };

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
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

  function normalizeCompareText(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[()\uFF08\uFF09\[\]\u3010\u3011"'`.,，、:：;；-]/g, "")
      .replace(/\s+/g, "");
  }

  function normalizeAccount(value) {
    return cleanText(normalizeOcrAccountText(value)).replace(/[^\d]/g, "");
  }

  function parseAmount(value) {
    const text = normalizeOcrNumberishText(value)
      .replaceAll(",", "")
      .replace(/[¥￥]/g, "")
      .replace(/[元圆整]/g, "")
      .replace(/\s+/g, "");
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number.parseFloat(match[0]) : 0;
  }

  function formatAmount(value) {
    if (value === null || value === undefined || value === "") {
      return "";
    }
    const numeric = typeof value === "number" ? value : parseAmount(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return "";
    }
    return Number(numeric).toLocaleString("zh-CN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function createVerificationItem(input) {
    return {
      key: input.key,
      label: input.label,
      status: input.status || "warn",
      statement: input.statement || "",
      sourceName: input.sourceName || "",
      sourceUrl: input.sourceUrl || "",
      matchedValue: input.matchedValue || "",
      snippet: input.snippet || ""
    };
  }

  function createContractReferenceSummary(input = {}) {
    return {
      effectiveStart: input.effectiveStart || "",
      effectiveEnd: input.effectiveEnd || "",
      paymentTerms: input.paymentTerms || "",
      sourceName: input.sourceName || "",
      sourceUrl: input.sourceUrl || ""
    };
  }

  function createAcceptanceReferenceSummary(input = {}) {
    return {
      statement: input.statement || "",
      sourceName: input.sourceName || "",
      sourceUrl: input.sourceUrl || ""
    };
  }

  globalThis.OAFinanceRebuildModels = {
    STATUS_TEXT,
    cleanText,
    normalizeCompareText,
    normalizeAccount,
    parseAmount,
    formatAmount,
    createVerificationItem,
    createContractReferenceSummary,
    createAcceptanceReferenceSummary
  };
})();
