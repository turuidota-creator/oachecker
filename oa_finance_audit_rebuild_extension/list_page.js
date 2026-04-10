(() => {
  const SCRIPT_FLAG = "__oaFinanceAutoReviewListMounted__";
  if (globalThis[SCRIPT_FLAG]) {
    return;
  }
  globalThis[SCRIPT_FLAG] = true;

  const PROGRESS_MESSAGE_TYPE = "oa-finance-rebuild-progress";
  const PAYMENT_CODE_RE = /^DDFK-\d{8,}$/i;
  const AUTO_REVIEW_COL_ATTR = "data-oa-finance-auto-review";
  const AUTO_REVIEW_WIDTH = "120px";

  const STATUS_META = {
    idle: { label: "待审核", tone: "idle" },
    reading: { label: "正在读取", tone: "running" },
    analyzing: { label: "正在分析", tone: "running" },
    pass: { label: "通过", tone: "pass" },
    warn: { label: "预警", tone: "warn" },
    fail: { label: "异常", tone: "fail" },
    error: { label: "失败", tone: "fail" },
    unsupported: { label: "不支持", tone: "idle" }
  };

  const state = {
    rowStates: new Map(),
    requestMap: new Map(),
    rowMetaCache: new Map(),
    batchRunning: false,
    refreshTimer: null,
    observer: null,
    cleanupFns: [],
    popover: null,
    popoverCode: "",
    activeTableEl: null
  };

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function debounceRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshListUi, 120);
  }

  function readCookie(name) {
    const needle = `${name}=`;
    const parts = String(document.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!part.startsWith(needle)) {
        continue;
      }
      return decodeURIComponent(part.slice(needle.length));
    }
    return "";
  }

  function buildAuthHeaders() {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "Content-Language": "zh_CN"
    };
    const adminToken = readCookie("Admin-Token");
    const oaAuthToken = readCookie("oauthtoken");
    if (adminToken) {
      headers.Authorization = `Bearer ${adminToken}`;
    }
    if (oaAuthToken) {
      headers.oauthtoken = oaAuthToken;
    }
    return headers;
  }

  async function fetchTodoRowByProcessCode(processCode) {
    if (state.rowMetaCache.has(processCode)) {
      return state.rowMetaCache.get(processCode) || null;
    }

    const url = new URL("/cyouNeiOaServer/flowable/process/todoList", window.location.origin);
    url.searchParams.set("pageNum", "1");
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("processCode", processCode);

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: buildAuthHeaders()
    });
    if (!response.ok) {
      throw new Error(`待办列表查询失败: ${response.status}`);
    }

    const payload = await response.json();
    if (payload?.code !== 200) {
      throw new Error(cleanText(payload?.msg) || "待办列表查询失败");
    }

    const row = Array.isArray(payload?.rows)
      ? payload.rows.find((item) => cleanText(item?.processCode) === processCode) || payload.rows[0] || null
      : null;
    state.rowMetaCache.set(processCode, row || null);
    return row || null;
  }

  function buildDetailUrl(row) {
    const procInsId = cleanText(row?.procInsId);
    if (!procInsId) {
      return "";
    }
    const url = new URL(`/workflow/process/detail/${procInsId}`, window.location.origin);
    const procDefId = cleanText(row?.procDefId).split(":")[0];
    const taskId = cleanText(row?.taskId);
    if (taskId) {
      url.searchParams.set("taskId", taskId);
      url.searchParams.set("processed", "true");
    } else {
      url.searchParams.set("processed", "false");
    }
    if (procDefId) {
      url.searchParams.set("procDefId", procDefId);
    }
    if (row?.processCode) {
      url.searchParams.set("processCode", row.processCode);
    }
    return url.toString();
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "扩展通信失败"));
          return;
        }
        resolve(response || null);
      });
    });
  }

  function ensureRowState(processCode) {
    if (!state.rowStates.has(processCode)) {
      state.rowStates.set(processCode, {
        status: "idle",
        result: null,
        errorText: "",
        detailUrl: "",
        rowMeta: null,
        requestId: "",
        progressText: "",
        updatedAt: ""
      });
    }
    return state.rowStates.get(processCode);
  }

  function patchRowState(processCode, patch) {
    const next = {
      ...ensureRowState(processCode),
      ...patch
    };
    state.rowStates.set(processCode, next);
    debounceRefresh();
    return next;
  }

  function createRequestId(processCode) {
    const suffix = Math.random().toString(16).slice(2, 8);
    return `${processCode}-${Date.now()}-${suffix}`;
  }

  function mapOverallStatus(overallStatus, errorText) {
    if (errorText) {
      return "error";
    }
    if (overallStatus === "pass") {
      return "pass";
    }
    if (overallStatus === "fail") {
      return "fail";
    }
    if (overallStatus === "warn") {
      return "warn";
    }
    return "warn";
  }

  function mapProgressPhaseToStatus(phase) {
    if (!phase) {
      return null;
    }
    if (phase === "open-detail" || phase === "collect-snapshot") {
      return "reading";
    }
    if (phase === "done") {
      return null;
    }
    return "analyzing";
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getMainHeaderTable(tableEl) {
    return tableEl?.querySelector(".el-table__header-wrapper table.el-table__header") || null;
  }

  function getMainBodyTable(tableEl) {
    return tableEl?.querySelector(".el-table__body-wrapper table.el-table__body") || null;
  }

  function getHeaderTexts(tableEl) {
    return Array.from(tableEl?.querySelectorAll(".el-table__header-wrapper thead th .cell") || [])
      .map((cell) => cleanText(cell.textContent))
      .filter(Boolean);
  }

  function readProcessCodeFromRow(rowEl) {
    const texts = Array.from(rowEl?.querySelectorAll("td .cell") || [])
      .map((cell) => cleanText(cell.textContent))
      .filter(Boolean);
    for (const text of texts) {
      const matched = text.match(/[A-Z]{2,8}-\d{8,}/i);
      if (matched) {
        return matched[0].toUpperCase();
      }
    }
    return "";
  }

  function locateTargetTableContext() {
    const tableCandidates = Array.from(document.querySelectorAll(".el-table")).filter(isVisible);
    for (const tableEl of tableCandidates) {
      const headerTexts = getHeaderTexts(tableEl);
      if (!headerTexts.includes("流程编号") || !headerTexts.includes("流程标题")) {
        continue;
      }
      const bodyRows = Array.from(tableEl.querySelectorAll(".el-table__body-wrapper tbody tr"));
      const rowInfos = bodyRows
        .map((rowEl) => ({
          rowEl,
          processCode: readProcessCodeFromRow(rowEl)
        }))
        .filter((item) => PAYMENT_CODE_RE.test(item.processCode));
      if (rowInfos.length === 0) {
        continue;
      }
      const headerTable = getMainHeaderTable(tableEl);
      const bodyTable = getMainBodyTable(tableEl);
      if (!headerTable || !bodyTable) {
        continue;
      }
      return {
        tableEl,
        wrapper: tableEl.closest(".app-container") || tableEl.parentElement || tableEl,
        headerTable,
        bodyTable,
        rowInfos
      };
    }
    return null;
  }

  function parsePixelWidth(value) {
    const parsed = Number.parseFloat(String(value || "").replace("px", "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function rebalanceColumnWidths(context) {
    const bodyWrapper = context.tableEl.querySelector(".el-table__body-wrapper");
    const headerRow = context.headerTable.querySelector("thead tr");
    if (!bodyWrapper || !headerRow) {
      return;
    }

    const headerCells = Array.from(headerRow.children).filter(
      (cell) => !cell.classList.contains("gutter") && !cell.hasAttribute(AUTO_REVIEW_COL_ATTR)
    );
    const headerCols = Array.from(context.headerTable.querySelectorAll("colgroup col")).filter(
      (col) => !col.hasAttribute(AUTO_REVIEW_COL_ATTR)
    );
    const bodyCols = Array.from(context.bodyTable.querySelectorAll("colgroup col")).filter(
      (col) => !col.hasAttribute(AUTO_REVIEW_COL_ATTR)
    );
    if (headerCells.length === 0) {
      return;
    }

    const auditWidth = parsePixelWidth(AUTO_REVIEW_WIDTH);
    const currentTotal = headerCells.reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0);
    let deficit = currentTotal + auditWidth - bodyWrapper.clientWidth;
    if (deficit <= 0) {
      return;
    }

    const candidates = [
      { label: "流程标题", min: 160 },
      { label: "任务节点", min: 180 },
      { label: "流程发起人", min: 130 },
      { label: "接收时间", min: 130 },
      { label: "流程编号", min: 180 }
    ];

    for (const candidate of candidates) {
      if (deficit <= 0) {
        break;
      }
      const index = headerCells.findIndex((cell) => cleanText(cell.innerText) === candidate.label);
      if (index < 0) {
        continue;
      }
      const cell = headerCells[index];
      const currentWidth = cell.getBoundingClientRect().width || parsePixelWidth(getComputedStyle(cell).width);
      const reducible = Math.max(0, currentWidth - candidate.min);
      if (reducible <= 0) {
        continue;
      }
      const nextWidth = currentWidth - Math.min(deficit, reducible);
      const widthText = `${Math.round(nextWidth)}px`;
      cell.style.width = widthText;
      cell.style.minWidth = widthText;
      if (headerCols[index]) {
        headerCols[index].style.width = widthText;
      }
      if (bodyCols[index]) {
        bodyCols[index].style.width = widthText;
      }
      deficit -= currentWidth - nextWidth;
    }
  }

  function ensureAuditColgroup(tableEl) {
    const colgroup = tableEl?.querySelector("colgroup");
    if (!colgroup) {
      return;
    }
    const existingCols = Array.from(colgroup.children);
    const gutterCol = existingCols.find((col) => Number.parseFloat(getComputedStyle(col).width || "0") === 0);
    let col = colgroup.querySelector(`col[${AUTO_REVIEW_COL_ATTR}]`);
    if (!col) {
      col = document.createElement("col");
      col.setAttribute(AUTO_REVIEW_COL_ATTR, "1");
      if (gutterCol) {
        colgroup.insertBefore(col, gutterCol);
      } else {
        colgroup.appendChild(col);
      }
    }
    col.style.width = AUTO_REVIEW_WIDTH;
  }

  function ensureHeaderCell(headerTable) {
    ensureAuditColgroup(headerTable);
    const headerRow = headerTable.querySelector("thead tr");
    if (!headerRow) {
      return;
    }
    const gutterTh = Array.from(headerRow.children).find((cell) => cell.classList.contains("gutter"));
    let headerCell = headerRow.querySelector(`th[${AUTO_REVIEW_COL_ATTR}]`);
    if (!headerCell) {
      headerCell = document.createElement("th");
      headerCell.setAttribute(AUTO_REVIEW_COL_ATTR, "1");
      headerCell.className = "oa-finance-auto-review-head";
      if (gutterTh) {
        headerRow.insertBefore(headerCell, gutterTh);
      } else {
        headerRow.appendChild(headerCell);
      }
    }
    headerCell.style.width = AUTO_REVIEW_WIDTH;
    headerCell.style.minWidth = AUTO_REVIEW_WIDTH;
    headerCell.innerHTML = '<div class="cell">自动审核</div>';
  }

  function statusMetaOf(processCode) {
    const rowState = ensureRowState(processCode);
    return STATUS_META[rowState.status] || STATUS_META.idle;
  }

  function renderStatusButton(processCode) {
    const rowState = ensureRowState(processCode);
    const meta = statusMetaOf(processCode);
    const canOpen = !!rowState.result || !!rowState.errorText;
    const titleText = rowState.errorText || rowState.progressText || meta.label;
    return `
      <button
        type="button"
        class="oa-finance-auto-review-trigger is-${meta.tone}"
        data-process-code="${escapeHtml(processCode)}"
        data-has-detail="${canOpen ? "1" : "0"}"
        title="${escapeHtml(titleText)}"
      >
        <span class="oa-finance-auto-review-dot"></span>
        <span class="oa-finance-auto-review-label">${escapeHtml(meta.label)}</span>
      </button>
    `;
  }

  function ensureBodyCell(rowEl, processCode, bodyTable) {
    ensureAuditColgroup(bodyTable);
    let cell = rowEl.querySelector(`td[${AUTO_REVIEW_COL_ATTR}]`);
    if (!cell) {
      cell = document.createElement("td");
      cell.setAttribute(AUTO_REVIEW_COL_ATTR, "1");
      cell.className = "oa-finance-auto-review-cell";
      rowEl.appendChild(cell);
    }
    cell.style.width = AUTO_REVIEW_WIDTH;
    cell.style.minWidth = AUTO_REVIEW_WIDTH;
    cell.innerHTML = `<div class="cell oa-finance-auto-review-cell-inner">${renderStatusButton(processCode)}</div>`;
  }

  function formatStatusText(status) {
    if (status === "pass") {
      return "通过";
    }
    if (status === "warn") {
      return "预警";
    }
    if (status === "fail") {
      return "异常";
    }
    if (status === "info") {
      return "仅展示";
    }
    return "预警";
  }

  function joinMeaningfulTexts(values, limit = 3) {
    return (values || [])
      .map((item) => cleanText(item))
      .filter(Boolean)
      .slice(0, limit)
      .join("；");
  }

  function renderVerificationSummary(result) {
    const items = Array.isArray(result?.verificationItems) ? result.verificationItems : [];
    if (items.length === 0) {
      return '<div class="oa-finance-auto-review-empty">还没有生成主核对结果。</div>';
    }
    return items
      .map(
        (item) => `
          <div class="oa-finance-auto-review-check">
            <div class="oa-finance-auto-review-check-head">
              <strong>${escapeHtml(item?.label || "核对项")}</strong>
              <span class="oa-finance-auto-review-mini-pill is-${escapeHtml(item?.status || "warn")}">${escapeHtml(
                formatStatusText(item?.status)
              )}</span>
            </div>
            <div class="oa-finance-auto-review-check-text">${escapeHtml(item?.statement || "暂无说明")}</div>
          </div>
        `
      )
      .join("");
  }

  function renderRelatedSummary(result) {
    const related = result?.relatedDocuments || {};
    const blocks = [];

    const domesticItems = Array.isArray(related.domesticPrItems)
      ? related.domesticPrItems
      : related.domesticPr
        ? [related.domesticPr]
        : [];
    const domesticText = domesticItems
      .map((item, index) => {
        const summary = cleanText(item?.fields?.requirementSummary || item?.summary);
        return summary ? `PR ${index + 1}: ${summary}` : "";
      })
      .filter(Boolean)
      .join("；");
    if (domesticText) {
      blocks.push(`
        <div class="oa-finance-auto-review-related-item">
          <strong>国内PR</strong>
          <div>${escapeHtml(domesticText)}</div>
        </div>
      `);
    }

    const purchaseOrder = related.purchaseOrder;
    if (purchaseOrder) {
      const checkText = (purchaseOrder.checks || [])
        .map((item) => `${cleanText(item?.label)}：${cleanText(item?.statement)}`)
        .filter(Boolean)
        .join("；");
      const description = cleanText(purchaseOrder.fields?.description);
      const combined = joinMeaningfulTexts([checkText, description], 2);
      blocks.push(`
        <div class="oa-finance-auto-review-related-item">
          <strong>采购订单</strong>
          <div>${escapeHtml(combined || cleanText(purchaseOrder.summary) || "已读取采购订单")}</div>
        </div>
      `);
    }

    const acceptanceItems = Array.isArray(related.acceptanceItems)
      ? related.acceptanceItems
      : related.acceptance
        ? [related.acceptance]
        : [];
    const acceptanceText = acceptanceItems
      .map((item) => joinMeaningfulTexts(item?.attachmentNames || item?.previewItems?.map((preview) => preview?.name), 4))
      .filter(Boolean)
      .join("；");
    if (acceptanceText) {
      blocks.push(`
        <div class="oa-finance-auto-review-related-item">
          <strong>验收单</strong>
          <div>${escapeHtml(acceptanceText)}</div>
        </div>
      `);
    }

    const contractSource = cleanText(result?.contractReference?.sourceName);
    const contractSummary = cleanText(
      result?.contractSummary?.paymentTermsSummary || result?.contractReference?.paymentTerms
    );
    if (contractSource || contractSummary) {
      blocks.push(`
        <div class="oa-finance-auto-review-related-item">
          <strong>合同摘要</strong>
          <div>${escapeHtml(joinMeaningfulTexts([contractSource, contractSummary], 2) || "已读取合同信息")}</div>
        </div>
      `);
    }

    if (blocks.length === 0) {
      return '<div class="oa-finance-auto-review-empty">还没有生成关联单据摘要。</div>';
    }
    return blocks.join("");
  }

  function renderPopoverBody(processCode) {
    const rowState = ensureRowState(processCode);
    const meta = statusMetaOf(processCode);
    const detailLink = rowState.detailUrl
      ? `<a class="oa-finance-auto-review-open" href="${escapeHtml(rowState.detailUrl)}" target="_blank" rel="noreferrer">打开详情页</a>`
      : "";

    if (rowState.errorText) {
      return `
        <div class="oa-finance-auto-review-popover-head">
          <div>
            <div class="oa-finance-auto-review-popover-code">${escapeHtml(processCode)}</div>
            <div class="oa-finance-auto-review-popover-status is-${meta.tone}">${escapeHtml(meta.label)}</div>
          </div>
          ${detailLink}
        </div>
        <section class="oa-finance-auto-review-popover-section">
          <h4>失败说明</h4>
          <div class="oa-finance-auto-review-empty">${escapeHtml(rowState.errorText)}</div>
        </section>
      `;
    }

    const result = rowState.result;
    if (!result) {
      return `
        <div class="oa-finance-auto-review-popover-head">
          <div>
            <div class="oa-finance-auto-review-popover-code">${escapeHtml(processCode)}</div>
            <div class="oa-finance-auto-review-popover-status is-${meta.tone}">${escapeHtml(meta.label)}</div>
          </div>
          ${detailLink}
        </div>
        <section class="oa-finance-auto-review-popover-section">
          <div class="oa-finance-auto-review-empty">还没有审核结果，点一下状态可以单独审核这张付款单。</div>
        </section>
      `;
    }

    return `
      <div class="oa-finance-auto-review-popover-head">
        <div>
          <div class="oa-finance-auto-review-popover-code">${escapeHtml(processCode)}</div>
          <div class="oa-finance-auto-review-popover-status is-${meta.tone}">${escapeHtml(meta.label)}</div>
        </div>
        ${detailLink}
      </div>
      <section class="oa-finance-auto-review-popover-section">
        <h4>主核对</h4>
        ${renderVerificationSummary(result)}
      </section>
      <section class="oa-finance-auto-review-popover-section">
        <h4>关联摘要</h4>
        ${renderRelatedSummary(result)}
      </section>
    `;
  }

  function ensurePopover() {
    if (state.popover) {
      return state.popover;
    }
    const popover = document.createElement("div");
    popover.className = "oa-finance-auto-review-popover";
    popover.hidden = true;
    document.body.appendChild(popover);
    state.popover = popover;
    return popover;
  }

  function hidePopover() {
    if (!state.popover) {
      return;
    }
    state.popover.hidden = true;
    state.popoverCode = "";
  }

  function showPopover(processCode, anchorEl) {
    const popover = ensurePopover();
    popover.innerHTML = renderPopoverBody(processCode);
    popover.hidden = false;
    state.popoverCode = processCode;

    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const preferredLeft = anchorRect.left - popoverRect.width - 14;
    const fallbackLeft = window.innerWidth - popoverRect.width - 24;
    const left = Math.max(16, Math.min(preferredLeft, fallbackLeft));
    const top = Math.min(
      Math.max(16, anchorRect.top),
      Math.max(16, window.innerHeight - popoverRect.height - 16)
    );

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function togglePopover(processCode, anchorEl) {
    if (state.popover && !state.popover.hidden && state.popoverCode === processCode) {
      hidePopover();
      return;
    }
    showPopover(processCode, anchorEl);
  }

  async function auditProcessCode(processCode) {
    const requestId = createRequestId(processCode);
    state.requestMap.set(requestId, processCode);
    patchRowState(processCode, {
      status: "reading",
      result: null,
      errorText: "",
      requestId,
      progressText: "正在读取付款单详情",
      updatedAt: new Date().toISOString()
    });

    try {
      const rowMeta = await fetchTodoRowByProcessCode(processCode);
      if (!rowMeta) {
        patchRowState(processCode, {
          status: "unsupported",
          errorText: "没有在待办列表里反查到这张付款单。",
          requestId: ""
        });
        return;
      }
      const detailUrl = buildDetailUrl(rowMeta);
      if (!detailUrl) {
        patchRowState(processCode, {
          status: "error",
          errorText: "无法拼出付款单详情链接。",
          rowMeta,
          requestId: ""
        });
        return;
      }

      patchRowState(processCode, {
        status: "reading",
        rowMeta,
        detailUrl
      });

      const response = await sendRuntimeMessage({
        type: "oa-finance-rebuild-analyze-url",
        requestId,
        url: detailUrl,
        paymentTarget: {
          processCode: rowMeta.processCode || processCode,
          processTitle: rowMeta.processTitle || ""
        }
      });
      if (!response?.ok) {
        throw new Error(cleanText(response?.error) || "自动审核失败");
      }

      patchRowState(processCode, {
        status: mapOverallStatus(response?.result?.overallStatus, ""),
        result: response.result || null,
        errorText: "",
        requestId: "",
        progressText: "",
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      patchRowState(processCode, {
        status: "error",
        errorText: cleanText(error?.message || String(error) || "自动审核失败"),
        requestId: "",
        progressText: ""
      });
    } finally {
      state.requestMap.delete(requestId);
    }
  }

  async function runWithConcurrency(processCodes, concurrency = 2) {
    const queue = [...processCodes];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const nextCode = queue.shift();
        if (!nextCode) {
          continue;
        }
        await auditProcessCode(nextCode);
      }
    });
    await Promise.all(workers);
  }

  async function handleBatchAudit(processCodes) {
    if (state.batchRunning || processCodes.length === 0) {
      return;
    }
    state.batchRunning = true;
    debounceRefresh();
    try {
      await runWithConcurrency(processCodes, 2);
    } finally {
      state.batchRunning = false;
      debounceRefresh();
    }
  }

  function ensureToolbar(context) {
    let toolbar = context.wrapper.querySelector(".oa-finance-auto-review-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "oa-finance-auto-review-toolbar";
      toolbar.innerHTML = `
        <div class="oa-finance-auto-review-toolbar-copy">
          <strong>自动审核</strong>
          <span class="oa-finance-auto-review-toolbar-note"></span>
        </div>
        <button type="button" class="oa-finance-auto-review-toolbar-btn"></button>
      `;
      context.tableEl.parentElement?.insertBefore(toolbar, context.tableEl);
    }

    const noteEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-note");
    const buttonEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-btn");
    const processCodes = context.rowInfos.map((item) => item.processCode);
    if (noteEl) {
      noteEl.textContent = `当前页 ${processCodes.length} 条付款单`;
    }
    if (buttonEl) {
      buttonEl.textContent = state.batchRunning ? "审核中..." : `自动审核本页（${processCodes.length}）`;
      buttonEl.disabled = state.batchRunning || processCodes.length === 0;
      buttonEl.onclick = () => {
        void handleBatchAudit(processCodes);
      };
    }
  }

  function cleanupDetachedToolbar(activeWrapper) {
    Array.from(document.querySelectorAll(".oa-finance-auto-review-toolbar")).forEach((toolbar) => {
      if (toolbar.closest(".app-container") !== activeWrapper) {
        toolbar.remove();
      }
    });
  }

  function refreshListUi() {
    const context = locateTargetTableContext();
    if (!context) {
      cleanupDetachedToolbar(null);
      hidePopover();
      state.activeTableEl = null;
      return;
    }

    state.activeTableEl = context.tableEl;
    cleanupDetachedToolbar(context.wrapper.closest(".app-container") || context.wrapper);
    rebalanceColumnWidths(context);
    ensureToolbar(context);
    ensureHeaderCell(context.headerTable);
    context.rowInfos.forEach((item) => ensureBodyCell(item.rowEl, item.processCode, context.bodyTable));
  }

  function findTriggerByProcessCode(processCode) {
    return document.querySelector(
      `.oa-finance-auto-review-trigger[data-process-code="${CSS.escape(processCode)}"]`
    );
  }

  function handleProgressMessage(message) {
    if (message?.type !== PROGRESS_MESSAGE_TYPE) {
      return;
    }
    const payload = message?.payload || {};
    const requestId = cleanText(payload.requestId);
    if (!requestId || !state.requestMap.has(requestId)) {
      return;
    }
    const processCode = state.requestMap.get(requestId);
    const nextStatus = mapProgressPhaseToStatus(cleanText(payload.phase));
    if (!processCode || !nextStatus) {
      return;
    }
    patchRowState(processCode, {
      status: nextStatus,
      progressText: cleanText(payload.text),
      updatedAt: new Date().toISOString()
    });
  }

  function handleDocumentClick(event) {
    const trigger = event.target.closest(".oa-finance-auto-review-trigger");
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      const processCode = cleanText(trigger.dataset.processCode).toUpperCase();
      const rowState = ensureRowState(processCode);
      if (rowState.status === "reading" || rowState.status === "analyzing") {
        return;
      }
      if (rowState.result || rowState.errorText) {
        togglePopover(processCode, trigger);
        return;
      }
      void auditProcessCode(processCode);
      return;
    }

    if (state.popover && !state.popover.hidden && !event.target.closest(".oa-finance-auto-review-popover")) {
      hidePopover();
    }
  }

  function mount() {
    debounceRefresh();
    state.observer = new MutationObserver(() => {
      debounceRefresh();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    chrome.runtime.onMessage.addListener(handleProgressMessage);
    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener("resize", debounceRefresh);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePopover();
      }
    });

    state.cleanupFns.push(() => chrome.runtime.onMessage.removeListener(handleProgressMessage));
    state.cleanupFns.push(() => document.removeEventListener("click", handleDocumentClick, true));
    state.cleanupFns.push(() => window.removeEventListener("resize", debounceRefresh));
  }

  mount();
})();
