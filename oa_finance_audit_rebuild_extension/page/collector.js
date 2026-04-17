(() => {
  const ATTACHMENT_EXT_RE =
    /\.(pdf|doc|docx|xls|xlsx|csv|msg|eml|zip|ofd|png|jpg|jpeg|txt|xml|rtf)(?:$|\?)/i;
  const EXTRA_ATTACHMENT_URL_RE =
    /(10\.1\.41\.11|10\.1\.9\.119|sea\.cyou-inc\.com|\/group1\/|\/files\/|downloadInstance|downloadFile|FileDownload\?fileid=)/i;
  const PROCESS_DETAIL_RE = /\/workflow\/process\/detail\/\d+/i;
  const HISTORY_DETAIL_RE = /\/workflow\/process\/history\/detail\/\d+\/monitor/i;
  const LEGACY_REQUEST_RE = /\/workflow\/request\/ViewRequest\.jsp\?.*requestid=\d+/i;
  const GENERIC_PROCESS_CODE_RE = /\b[A-Z]{2,10}-\d{8,}\b/i;
  const DOMESTIC_PR_CODE_RE = /\bGNPR-\d{8,}\b/i;
  const PURCHASE_PAYMENT_CODE_RE = /^DDFK-\d{8,}$/i;
  const PR_PAYMENT_CODE_RE = /^GNTYYFK-\d{8,}$/i;

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

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
    const combined = `${cleanText(text)} ${cleanText(url)} ${decodeMaybeUriComponent(url)}`;
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

  function buildRelatedLinkKey(url, relation) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      return `${relation}|`;
    }
    const flowableMatch = normalized.match(/\/workflow\/process\/detail\/(\d+)/i);
    if (flowableMatch) {
      return `${relation}|flowable|${flowableMatch[1]}`;
    }
    const historyMatch = normalized.match(/\/workflow\/process\/history\/detail\/(\d+)\/monitor/i);
    if (historyMatch) {
      return `${relation}|history|${historyMatch[1]}`;
    }
    const legacyMatch = normalized.match(/requestid=(\d+)/i);
    if (legacyMatch) {
      return `${relation}|legacy|${legacyMatch[1]}`;
    }
    return `${relation}|${normalized}`;
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
      const key = buildRelatedLinkKey(anchor.url, relation);
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

  function pushUniqueText(values, seen, value) {
    const text = cleanText(value || "");
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    values.push(text);
  }

  function extractCheckedInputLabel(input, root) {
    if (!input) {
      return "";
    }

    const wrapper = input.closest("label, .el-radio, .el-checkbox, .ant-radio-wrapper, .ant-checkbox-wrapper");
    const wrapperText = cleanText(wrapper?.textContent || "");
    if (wrapperText) {
      return wrapperText;
    }

    const inputId = cleanText(input.getAttribute?.("id") || "");
    if (!inputId) {
      return "";
    }

    try {
      return cleanText(root?.querySelector?.(`label[for="${CSS.escape(inputId)}"]`)?.textContent || "");
    } catch (_error) {
      return "";
    }
  }

  function collectCheckedControlTexts(root, values, seen) {
    const selectors = [
      ".el-radio.is-checked .el-radio__label",
      ".el-radio-button.is-active .el-radio-button__inner",
      ".el-checkbox.is-checked .el-checkbox__label",
      ".ant-radio-wrapper-checked",
      ".ant-checkbox-wrapper-checked",
      ".ant-select-selection-item",
      ".el-select .el-tag__content",
      ".el-select__selected-item",
      ".el-cascader .el-cascader__label"
    ];

    for (const selector of selectors) {
      for (const node of root?.querySelectorAll?.(selector) || []) {
        pushUniqueText(values, seen, node?.textContent || "");
      }
    }

    for (const input of root?.querySelectorAll?.('input[type="radio"]:checked, input[type="checkbox"]:checked') || []) {
      pushUniqueText(values, seen, extractCheckedInputLabel(input, root));
    }

    for (const select of root?.querySelectorAll?.("select") || []) {
      const selected = Array.from(select.selectedOptions || [])
        .map((option) => cleanText(option?.textContent || option?.label || option?.value || ""))
        .filter(Boolean)
        .join(" / ");
      pushUniqueText(values, seen, selected);
    }
  }

  function collectFieldPairsFromTables() {
    const pairs = [];
    const rows = Array.from(document.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td"))
        .map((cell) => ({
          labelText: cleanText(cell.textContent),
          valueText: extractFieldDisplayValue(cell)
        }))
        .filter((cell) => cell.labelText);
      if (cells.length < 2) {
        continue;
      }
      for (let index = 0; index + 1 < cells.length; index += 2) {
        const label = cells[index]?.labelText || "";
        const value = normalizeCollectedFieldValue(label, cells[index + 1]?.valueText || cells[index + 1]?.labelText || "");
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
        const value = normalizeCollectedFieldValue(label, extractFieldDisplayValue(valueNode));
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
    collectCheckedControlTexts(root, values, seen);

    const nodes = Array.from(
      root?.querySelectorAll?.(
        "input, textarea, select, .el-input__inner, .el-textarea__inner, .el-date-editor input, .el-select input, .ant-select-selection-search-input"
      ) || []
    );

    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      if (/^(?:radio|checkbox)$/i.test(cleanText(node.type || ""))) {
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

  function extractFieldDisplayValue(node) {
    if (!node || typeof node !== "object") {
      return "";
    }
    const controlValues = extractControlValues(node);
    if (controlValues.length > 0) {
      return controlValues.join(" / ");
    }
    return cleanText(node.textContent || "");
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

        const value = normalizeCollectedFieldValue(label, values.join(" / "));
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
            const fallbackText = extractFieldDisplayValue(column);
            const value = normalizeCollectedFieldValue(label, values.length > 0 ? values.join(" / ") : fallbackText);
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
      ...collectFieldPairsFromControlBlocks(),
      ...collectFieldPairsFromSubformRows(subformRows),
      ...collectFieldPairsFromLabeledBlocks(),
      ...collectFieldPairsFromTables()
    ]) {
      const key = `${pair.label}|${pair.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push(pair);
    }
    return { pairs: pruneLowQualityFieldPairs(pairs), subformRows };
  }

  function compactChoiceFieldValue(value) {
    return cleanText(value || "").replace(/[\s/|,，、；;]+/g, "");
  }

  function isOptionOnlyFieldValue(label, value) {
    const normalizedLabel = cleanText(label || "");
    const compactValue = compactChoiceFieldValue(value);
    if (!normalizedLabel || !compactValue) {
      return false;
    }

    if (/发票类型/.test(normalizedLabel)) {
      if (/增值税发票.*其他票据.*暂未取得发票/.test(compactValue)) {
        return true;
      }
      if (/增值税专用发票.*增值税普通发票/i.test(compactValue)) {
        return true;
      }
    }

    if (/关联发票是否正确/.test(normalizedLabel) && /正确.*不正确/.test(compactValue)) {
      return true;
    }
    if (/是否取得全额发票/.test(normalizedLabel) && compactValue === "是否") {
      return true;
    }
    if (/是否最后一次验收/.test(normalizedLabel) && compactValue === "是否") {
      return true;
    }
    if (/是否为跨境支付/.test(normalizedLabel) && compactValue === "是否") {
      return true;
    }
    if (/是否为保证金/.test(normalizedLabel) && /非保证金.*全额保证金.*部分保证金/.test(compactValue)) {
      return true;
    }
    if (/税率/.test(normalizedLabel) && /1%3%6%9%13%/.test(compactValue)) {
      return true;
    }

    return false;
  }

  function normalizeCollectedFieldValue(label, value) {
    const text = cleanText(value || "");
    if (!text) {
      return "";
    }
    return isOptionOnlyFieldValue(label, text) ? "" : text;
  }

  function pruneLowQualityFieldPairs(pairs) {
    const groups = new Map();
    for (const pair of pairs || []) {
      const label = cleanText(pair?.label || "");
      if (!label) {
        continue;
      }
      if (!groups.has(label)) {
        groups.set(label, []);
      }
      groups.get(label).push(pair);
    }

    const results = [];
    for (const pair of pairs || []) {
      const label = cleanText(pair?.label || "");
      const group = groups.get(label) || [];
      const hasBetterValue = group.some((item) => !isOptionOnlyFieldValue(label, item?.value || ""));
      if (hasBetterValue && isOptionOnlyFieldValue(label, pair?.value || "")) {
        continue;
      }
      results.push(pair);
    }
    return results;
  }

  function findFieldValue(pairs, labels) {
    for (const label of labels) {
      const found = pairs.find((pair) => cleanText(pair?.label || "").includes(label));
      if (found?.value) {
        return cleanText(found.value);
      }
    }
    return "";
  }

  function findFieldEntries(pairs, includeLabels, excludeLabels = []) {
    return (pairs || []).filter((pair) => {
      const label = cleanText(pair?.label || "");
      if (!label) {
        return false;
      }
      if (!includeLabels.some((item) => label.includes(item))) {
        return false;
      }
      return !excludeLabels.some((item) => label.includes(item));
    });
  }

  function findPreferredFieldValue(pairs, priorityGroups, excludeLabels = []) {
    for (const group of priorityGroups || []) {
      const labels = Array.isArray(group) ? group : [group];
      const found = findFieldEntries(pairs, labels, excludeLabels)[0];
      if (found?.value) {
        return cleanText(found.value);
      }
    }
    return "";
  }

  function extractProcessCode(value) {
    const matched = cleanText(value || "").match(GENERIC_PROCESS_CODE_RE);
    return matched?.[0] ? matched[0].toUpperCase() : "";
  }

  function extractDomesticPrCode(value) {
    const processCode = extractProcessCode(value);
    return DOMESTIC_PR_CODE_RE.test(processCode) ? processCode : "";
  }

  function inferProcessCode(pairs) {
    const parsed = new URL(window.location.href);
    const queryCode = extractProcessCode(parsed.searchParams.get("processCode") || "");
    if (queryCode) {
      return queryCode;
    }

    const candidates = findFieldEntries(pairs, ["流程编号", "PR单号", "单号", "流程编码", "相关流程"]).map((item) => item.value);
    for (const candidate of candidates) {
      const processCode = extractProcessCode(candidate);
      if (processCode) {
        return processCode;
      }
    }

    return "";
  }

  function detectFlowType(processCode) {
    const normalized = cleanText(processCode || "").toUpperCase();
    if (DOMESTIC_PR_CODE_RE.test(normalized)) {
      return "domestic_pr";
    }
    if (PR_PAYMENT_CODE_RE.test(normalized)) {
      return "pr_payment";
    }
    if (PURCHASE_PAYMENT_CODE_RE.test(normalized)) {
      return "purchase_payment";
    }
    return "payment";
  }

  function extractDateFromProcessCode(processCode) {
    const match = String(processCode || "").match(/(\d{4})(\d{2})(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
  }

  function inferPaymentAmount(pairs, flowType) {
    const prAggregateLabels = [
      "PR未提交付款金额",
      "PR总额",
      "PR总金额",
      "PR金额",
      "PR本次提交金额",
      "PR已付款已归档金额",
      "PR在途未付款金额"
    ];

    if (flowType === "pr_payment") {
      return findPreferredFieldValue(
        pairs,
        [
          ["打款金额确认"],
          ["人民币打款金额ABS", "人民币打款金额CBS", "人民币打款金额"],
          ["付款小写金额"],
          ["人民币金额"],
          ["本次付款金额", "本次打款金额", "实际付款金额", "实际打款金额", "申请付款金额", "支付金额"],
          ["付款金额"]
        ],
        prAggregateLabels
      );
    }

    return findPreferredFieldValue(
      pairs,
      [
        ["本次付款金额", "实际付款金额", "付款金额"],
        ["申请金额"],
        ["支付金额"]
      ],
      prAggregateLabels
    );
  }

  function rowFieldValue(row, labels) {
    const fields = Array.isArray(row?.fields) ? row.fields : [];
    for (const label of labels) {
      const found = fields.find((field) => cleanText(field?.label || "").includes(label));
      if (found?.value) {
        return cleanText(found.value);
      }
    }
    return "";
  }

  function collectInlineDomesticPr(subformRows) {
    return (subformRows || [])
      .map((row) => {
        const processCode = extractDomesticPrCode(
          rowFieldValue(row, ["PR单号", "PR选择", "相关流程", "流程编号", "单号"])
        );
        const relatedTitle = rowFieldValue(row, ["相关流程", "PR标题", "PR名称", "流程标题"]);
        const prStatus = rowFieldValue(row, ["PR状态"]);
        const prAmount = rowFieldValue(row, ["PR总额", "PR金额", "PR申请金额"]);
        const prPendingAmount = rowFieldValue(row, ["PR未提交付款金额"]);
        const prCurrentSubmitAmount = rowFieldValue(row, ["PR本次提交金额"]);
        const costDept = rowFieldValue(row, ["费用归属部门（全路径）", "费用归属部门", "归属部门"]);
        const costPurpose = rowFieldValue(row, ["费用归属说明", "费用用途说明", "用途说明", "申请事由"]);
        const hasPrSignals = !!(
          processCode ||
          relatedTitle ||
          prStatus ||
          prAmount ||
          prPendingAmount ||
          prCurrentSubmitAmount ||
          costDept ||
          costPurpose
        );

        if (!hasPrSignals) {
          return null;
        }

        return {
          processCode,
          relatedTitle,
          prStatus,
          prAmount,
          prPendingAmount,
          prCurrentSubmitAmount,
          costDept,
          costPurpose,
          rowLabel: cleanText(row?.rowLabel || "")
        };
      })
      .filter(Boolean);
  }

  function collectCurrentDomesticPr(pairs, processCode, flowType) {
    if (flowType !== "domestic_pr") {
      return [];
    }

    const currentItem = {
      processCode: extractDomesticPrCode(processCode),
      relatedTitle:
        findPreferredFieldValue(pairs, [["PR标题", "PR名称"], ["流程标题"], ["标题"]]) ||
        cleanText(document.title) ||
        processCode,
      prStatus: findFieldValue(pairs, ["PR状态", "状态"]),
      prAmount: findFieldValue(pairs, ["PR总额", "PR金额", "PR申请金额", "金额"]),
      prPendingAmount: findFieldValue(pairs, ["PR未提交付款金额", "待提单金额", "剩余可提金额"]),
      prCurrentSubmitAmount: findFieldValue(pairs, ["PR本次提交金额", "本次提交金额", "本次付款金额"]),
      costDept: findFieldValue(pairs, ["费用归属部门", "业务归属部门", "归属部门", "所属部门"]),
      costPurpose: findFieldValue(pairs, ["费用归属说明", "订单用途说明", "费用用途说明", "用途说明", "申请事由"]),
      rowLabel: "当前流程",
      isCurrentPagePr: true,
      sourceUrl: window.location.href
    };

    return currentItem.processCode || currentItem.relatedTitle ? [currentItem] : [];
  }

  function inferPaymentTarget(pairs, flowType, processCode) {
    const processTitle =
      findFieldValue(pairs, ["付款单名称", "流程标题", "标题"]) ||
      cleanText(document.title) ||
      processCode;

    return {
      flowType,
      processCode,
      processTitle,
      paymentAmount: inferPaymentAmount(pairs, flowType),
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
    const processCode = inferProcessCode(fieldPairs);
    const flowType = detectFlowType(processCode);
    const inlineDomesticPr = [
      ...collectCurrentDomesticPr(fieldPairs, processCode, flowType),
      ...collectInlineDomesticPr(fieldPairResult.subformRows || [])
    ];

    return {
      pageUrl: window.location.href,
      pageTitle: cleanText(document.title),
      bodyText: cleanText(document.body?.innerText || ""),
      flowType,
      paymentTarget: inferPaymentTarget(fieldPairs, flowType, processCode),
      fieldPairs,
      subformRows: fieldPairResult.subformRows || [],
      inlineRelations: {
        domesticPr: inlineDomesticPr
      },
      attachments: collectAttachments(anchors),
      relatedLinks: collectRelatedLinks(anchors)
    };
  }

  globalThis.OAFinanceRebuildCollector = {
    collectPageSnapshot
  };
})();
