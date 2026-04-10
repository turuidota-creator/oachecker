(() => {
  const ATTACHMENT_EXT_RE =
    /\.(pdf|doc|docx|xls|xlsx|csv|msg|eml|zip|ofd|png|jpg|jpeg|txt|xml|rtf)(?:$|\?)/i;
  const EXTRA_ATTACHMENT_URL_RE =
    /(10\.1\.41\.11|10\.1\.9\.119|sea\.cyou-inc\.com|\/group1\/|\/files\/|downloadInstance|downloadFile|FileDownload\?fileid=)/i;
  const PROCESS_DETAIL_RE = /\/workflow\/process\/detail\/\d+/i;
  const HISTORY_DETAIL_RE = /\/workflow\/process\/history\/detail\/\d+\/monitor/i;
  const LEGACY_REQUEST_RE = /\/workflow\/request\/ViewRequest\.jsp\?.*requestid=\d+/i;

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeUrl(href) {
    try {
      return new URL(href, window.location.href).toString();
    } catch (_error) {
      return "";
    }
  }

  function filenameFromUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      return "";
    }
    const pathname = new URL(normalized).pathname || "";
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(lastSegment);
  }

  function looksLikeAttachment(url, text) {
    return ATTACHMENT_EXT_RE.test(url) || ATTACHMENT_EXT_RE.test(text) || EXTRA_ATTACHMENT_URL_RE.test(url);
  }

  function guessRelation(text, url) {
    const combined = `${cleanText(text)} ${cleanText(url)}`;
    if (/合同|框架协议|采购合同|补充协议/i.test(combined)) {
      return "contract";
    }
    if (/验收|结算单|验收单|验收邮件/i.test(combined)) {
      return "acceptance";
    }
    if (/国内\s*PR|PR单号|GNPR|prlink/i.test(combined)) {
      return "domestic_pr";
    }
    if (/采购订单|订单名称|订单金额|PRNUMBER|CYNCDD|ddlink|po(?:\b|_)/i.test(combined)) {
      return "purchase_order";
    }
    return "related";
  }

  function collectAnchors() {
    return Array.from(document.querySelectorAll("a[href]")).map((anchor) => {
      const url = normalizeUrl(anchor.getAttribute("href") || "");
      return {
        title: cleanText(anchor.textContent || ""),
        url
      };
    });
  }

  function collectAttachments(anchors) {
    const seen = new Set();
    const items = [];
    for (const anchor of anchors) {
      if (!anchor.url || !looksLikeAttachment(anchor.url, anchor.title)) {
        continue;
      }
      const key = `${anchor.url}|${anchor.title}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        name: anchor.title || filenameFromUrl(anchor.url) || "附件",
        url: anchor.url
      });
    }
    return items;
  }

  function collectRelatedLinks(anchors) {
    const seen = new Set();
    const items = [];
    for (const anchor of anchors) {
      if (!anchor.url) {
        continue;
      }
      if (!PROCESS_DETAIL_RE.test(anchor.url) && !HISTORY_DETAIL_RE.test(anchor.url) && !LEGACY_REQUEST_RE.test(anchor.url)) {
        continue;
      }
      const relation = guessRelation(anchor.title, anchor.url);
      const key = `${anchor.url}|${relation}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        relation,
        title: anchor.title || anchor.url,
        url: anchor.url
      });
    }
    return items;
  }

  function collectFieldPairsFromTables() {
    const pairs = [];
    const rows = Array.from(document.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td"))
        .map((cell) => cleanText(cell.textContent))
        .filter(Boolean);
      if (cells.length < 2) {
        continue;
      }
      for (let index = 0; index + 1 < cells.length; index += 2) {
        const label = cells[index];
        const value = cells[index + 1];
        if (label && value && label !== value) {
          pairs.push({ label, value });
        }
      }
    }
    return pairs;
  }

  function collectFieldPairsFromLabeledBlocks() {
    const selectors = [
      ".el-form-item",
      ".ant-form-item",
      ".form-item",
      ".info-item",
      "li"
    ];
    const pairs = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const labelNode = node.querySelector("label, .label, .el-form-item__label, .ant-form-item-label");
        const valueNode =
          node.querySelector(".value, .el-form-item__content, .ant-form-item-control-input, .content") || node;
        const label = cleanText(labelNode?.textContent);
        const value = cleanText(valueNode?.textContent);
        if (!label || !value || label === value) {
          continue;
        }
        const key = `${label}|${value}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({ label, value });
      }
    }

    return pairs;
  }

  function extractControlValues(root) {
    const seen = new Set();
    const values = [];
    const nodes = [
      root,
      ...Array.from(root?.querySelectorAll?.("input, textarea, select, .el-input__inner, .el-textarea__inner") || [])
    ];

    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const text = cleanText(
        node.value ||
        node.getAttribute?.("value") ||
        node.getAttribute?.("data-value") ||
        ""
      );
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      values.push(text);
    }

    return values;
  }

  function collectFieldPairsFromControlBlocks() {
    const selectors = [
      ".el-form-item",
      ".ant-form-item",
      ".form-item",
      ".info-item"
    ];
    const pairs = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const labelNode = node.querySelector("label, .label, .el-form-item__label, .ant-form-item-label");
        const label = cleanText(labelNode?.textContent);
        if (!label) {
          continue;
        }

        const values = extractControlValues(node);
        if (values.length === 0) {
          continue;
        }

        const value = values.join(" / ");
        if (!value || label === value) {
          continue;
        }

        const key = `${label}|${value}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({ label, value });
      }
    }

    return pairs;
  }

  function collectSubformRows() {
    return Array.from(document.querySelectorAll(".sub-form-row"))
      .map((row) => {
        const rowLabel = cleanText(row.querySelector(".row-number-span")?.textContent || "");
        const fields = Array.from(row.querySelectorAll(".sub-form-table-column"))
          .map((column) => {
            const label = cleanText(column.querySelector("label, .el-form-item__label, .label")?.textContent);
            if (!label) {
              return null;
            }
            const values = extractControlValues(column);
            const fallbackText = cleanText(column.textContent || "");
            const value = values.length > 0 ? values.join(" / ") : fallbackText;
            if (!value || value === label) {
              return null;
            }
            return { label, value };
          })
          .filter(Boolean);

        if (fields.length === 0) {
          return null;
        }

        return {
          rowLabel,
          fields
        };
      })
      .filter(Boolean);
  }

  function collectFieldPairsFromSubformRows(rows) {
    const pairs = [];
    const seen = new Set();
    for (const row of rows || []) {
      for (const field of row.fields || []) {
        const key = `${field.label}|${field.value}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({ label: field.label, value: field.value });
      }
    }
    return pairs;
  }

  function collectFieldPairs() {
    const subformRows = collectSubformRows();
    const seen = new Set();
    const pairs = [];
    for (const pair of [
      ...collectFieldPairsFromTables(),
      ...collectFieldPairsFromLabeledBlocks(),
      ...collectFieldPairsFromControlBlocks(),
      ...collectFieldPairsFromSubformRows(subformRows)
    ]) {
      const key = `${pair.label}|${pair.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push(pair);
    }
    return { pairs, subformRows };
  }

  function findFieldValue(pairs, labels) {
    for (const label of labels) {
      const found = pairs.find((pair) => pair.label.includes(label));
      if (found?.value) {
        return found.value;
      }
    }
    return "";
  }

  function extractDateFromProcessCode(processCode) {
    const match = String(processCode || "").match(/(\d{4})(\d{2})(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
  }

  function inferPaymentTarget(pairs) {
    const processCode = new URL(window.location.href).searchParams.get("processCode") || "";
    const processTitle =
      findFieldValue(pairs, ["付款单名称", "流程标题", "标题"]) ||
      cleanText(document.title) ||
      processCode;

    return {
      processCode,
      processTitle,
      paymentAmount: findFieldValue(pairs, ["付款金额", "申请金额", "本次付款金额", "支付金额"]),
      payeeCompany: findFieldValue(pairs, ["收款公司", "收款单位", "供应商名称", "供应商", "对方公司"]),
      payeeAccount: findFieldValue(pairs, ["收款账号", "银行账号", "开户账号", "银行账户", "账户号"]),
      payeeBank: findFieldValue(pairs, ["开户行", "银行名称"]),
      paymentDate:
        findFieldValue(pairs, ["付款日期", "申请日期", "创建日期", "日期"]) || extractDateFromProcessCode(processCode)
    };
  }

  function collectPageSnapshot() {
    const anchors = collectAnchors();
    const fieldPairResult = collectFieldPairs();
    const fieldPairs = fieldPairResult.pairs || [];

    return {
      pageUrl: window.location.href,
      pageTitle: cleanText(document.title),
      paymentTarget: inferPaymentTarget(fieldPairs),
      fieldPairs,
      subformRows: fieldPairResult.subformRows || [],
      attachments: collectAttachments(anchors),
      relatedLinks: collectRelatedLinks(anchors)
    };
  }

  globalThis.OAFinanceRebuildCollector = {
    collectPageSnapshot
  };
})();
