(() => {
  const STATUS_TEXT = {
    pass: "通过",
    warn: "预警",
    fail: "异常"
  };

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeCompareText(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[()（）\[\]【】'`"“”‘’、，。:：;；\-]/g, "")
      .replace(/\s+/g, "");
  }

  function normalizeAccount(value) {
    return cleanText(value).replace(/[^\d]/g, "");
  }

  function parseAmount(value) {
    const text = cleanText(value).replaceAll(",", "");
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
