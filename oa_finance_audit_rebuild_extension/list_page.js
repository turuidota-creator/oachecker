(() => {
  const SCRIPT_FLAG = "__oaFinanceAutoReviewListMounted__";
  if (globalThis[SCRIPT_FLAG]) {
    return;
  }
  globalThis[SCRIPT_FLAG] = true;

  const PROGRESS_MESSAGE_TYPE = "oa-finance-rebuild-progress";
  const PAYMENT_CODE_RE = /^(?:DDFK|GNTYYFK)-\d{8,}$/i;
  const DETAIL_PAGE_RE = /\/workflow\/process\/detail\/\d+/i;
  const AUTO_REVIEW_COL_ATTR = "data-oa-finance-auto-review";
  const AUTO_REVIEW_WIDTH = "120px";
  const DETAIL_AUTO_REVIEW_ATTR = "data-oa-finance-detail-auto-review";
  const DETAIL_AUTO_REVIEW_LABELS = ["通过", "保存", "转办", "退回"];

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
    cacheHydratedCodes: new Set(),
    cacheLoadingCodes: new Set(),
    batchRunning: false,
    refreshTimer: null,
    observer: null,
    cleanupFns: [],
    popover: null,
    popoverCode: "",
    activeTableEl: null,
    lastKnownUrl: window.location.href,
    detailEntryTimer: null,
    detailEntryBusy: false
  };

  function isManagedUiNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return !!node.closest(`.oa-finance-auto-review-popover, .oa-finance-auto-review-toolbar, .oa-finance-auto-review-cell, [${AUTO_REVIEW_COL_ATTR}], [${DETAIL_AUTO_REVIEW_ATTR}]`);
  }

  function shouldIgnoreMutation(record) {
    const target = record?.target;
    if (isManagedUiNode(target)) {
      return true;
    }
    const added = Array.from(record?.addedNodes || []);
    const removed = Array.from(record?.removedNodes || []);
    const touchedNodes = [...added, ...removed].filter((node) => node?.nodeType === Node.ELEMENT_NODE);
    return touchedNodes.length > 0 && touchedNodes.every((node) => isManagedUiNode(node));
  }

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

  function firstNonEmpty(...values) {
    for (const value of values) {
      const normalized = cleanText(value);
      if (normalized) {
        return normalized;
      }
    }
    return "";
  }

  function debounceRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshListUi, 120);
  }

  function scheduleDetailEntryRefresh(delay = 120) {
    clearTimeout(state.detailEntryTimer);
    state.detailEntryTimer = setTimeout(refreshDetailAutoReviewEntry, delay);
  }

  function isDetailPageUrl(url = window.location.href) {
    return DETAIL_PAGE_RE.test(cleanText(url));
  }

  function dispatchDetailRootEvent(eventName, detail = {}) {
    const root = document.getElementById("oa-finance-rebuild-root");
    if (!root) {
      return false;
    }
    root.dispatchEvent(new CustomEvent(eventName, { detail }));
    return true;
  }

  async function syncDetailPageEnhancements(url = window.location.href) {
    const currentUrl = cleanText(url);
    if (!currentUrl) {
      return;
    }
    if (isDetailPageUrl(currentUrl)) {
      scheduleDetailEntryRefresh();
      if (
        dispatchDetailRootEvent("oa-finance-rebuild-route-change", {
          pageUrl: currentUrl,
          autoRun: false
        })
      ) {
        return;
      }
      try {
        await sendRuntimeMessage({
          type: "oa-finance-rebuild-ensure-detail-content",
          url: currentUrl
        });
      } catch (_error) {
        // Ignore dynamic injection failures and keep the page usable.
      }
      return;
    }
    cleanupDetailAutoReviewEntry();
    dispatchDetailRootEvent("oa-finance-rebuild-unmount", {
      pageUrl: currentUrl
    });
  }

  function handleUrlMaybeChanged(force = false) {
    const nextUrl = cleanText(window.location.href);
    if (!nextUrl) {
      return;
    }
    if (!force && nextUrl === cleanText(state.lastKnownUrl)) {
      return;
    }
    state.lastKnownUrl = nextUrl;
    void syncDetailPageEnhancements(nextUrl);
  }

  function detailEntryText() {
    return state.detailEntryBusy ? "打开中..." : "自动审核";
  }

  function updateDetailEntryButtons() {
    Array.from(document.querySelectorAll(`[${DETAIL_AUTO_REVIEW_ATTR}]`)).forEach((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      button.textContent = detailEntryText();
      button.disabled = state.detailEntryBusy;
      button.classList.toggle("is-loading", state.detailEntryBusy);
    });
  }

  function setDetailEntryBusy(isBusy) {
    state.detailEntryBusy = !!isBusy;
    updateDetailEntryButtons();
  }

  function createDetailAutoReviewButton(kind) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      kind === "fallback"
        ? "oa-finance-detail-auto-review-fallback"
        : "oa-finance-detail-auto-review-btn";
    button.setAttribute(DETAIL_AUTO_REVIEW_ATTR, kind);
    button.textContent = detailEntryText();
    button.disabled = state.detailEntryBusy;
    button.addEventListener("click", handleDetailAutoReviewClick);
    return button;
  }

  function removeDetailEntry(kind = "") {
    const selector = kind
      ? `[${DETAIL_AUTO_REVIEW_ATTR}="${CSS.escape(kind)}"]`
      : `[${DETAIL_AUTO_REVIEW_ATTR}]`;
    Array.from(document.querySelectorAll(selector)).forEach((node) => node.remove());
  }

  function cleanupDetailAutoReviewEntry() {
    clearTimeout(state.detailEntryTimer);
    state.detailEntryTimer = null;
    state.detailEntryBusy = false;
    removeDetailEntry();
  }

  function buttonLabelMatch(text) {
    const normalized = cleanText(text);
    return DETAIL_AUTO_REVIEW_LABELS.find((label) => normalized.includes(label) && normalized.length <= 12) || "";
  }

  function listButtonLikeDescendants(rootNode) {
    return Array.from(rootNode?.querySelectorAll?.("button, a, [role='button'], .el-button, .ant-btn") || [])
      .filter((node) => !node.hasAttribute?.(DETAIL_AUTO_REVIEW_ATTR) && isVisible(node));
  }

  function scoreDetailActionContainer(container) {
    const labels = new Set();
    const matchedButtons = [];
    for (const button of listButtonLikeDescendants(container)) {
      const label = buttonLabelMatch(button.textContent || "");
      if (!label) {
        continue;
      }
      labels.add(label);
      matchedButtons.push(button);
    }
    if (labels.size < 2 || matchedButtons.length < 2) {
      return null;
    }
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width > Math.max(760, window.innerWidth * 0.95)) {
      return null;
    }
    return {
      container,
      labels,
      matchedButtons,
      score: labels.size * 100 + matchedButtons.length * 10 - rect.height
    };
  }

  function locateDetailActionTarget() {
    const buttonLikes = listButtonLikeDescendants(document.body)
      .filter((node) => buttonLabelMatch(node.textContent || ""));
    const scored = [];
    const visited = new Set();
    for (const button of buttonLikes) {
      let current = button.parentElement;
      let depth = 0;
      while (current && current !== document.body && depth < 5) {
        if (!visited.has(current)) {
          visited.add(current);
          const candidate = scoreDetailActionContainer(current);
          if (candidate) {
            scored.push(candidate);
          }
        }
        current = current.parentElement;
        depth += 1;
      }
    }
    scored.sort((left, right) => right.score - left.score);
    const winner = scored[0];
    if (!winner) {
      return null;
    }
    const lastButton = winner.matchedButtons[winner.matchedButtons.length - 1] || null;
    return lastButton ? { container: winner.container, afterButton: lastButton } : null;
  }

  function refreshDetailAutoReviewEntry() {
    state.detailEntryTimer = null;
    if (!isDetailPageUrl()) {
      cleanupDetailAutoReviewEntry();
      return;
    }

    const target = locateDetailActionTarget();
    if (target?.afterButton?.parentElement) {
      removeDetailEntry("fallback");
      let inlineButton = document.querySelector(`[${DETAIL_AUTO_REVIEW_ATTR}="inline"]`);
      if (!inlineButton) {
        inlineButton = createDetailAutoReviewButton("inline");
      }
      if (inlineButton.previousElementSibling !== target.afterButton) {
        target.afterButton.insertAdjacentElement("afterend", inlineButton);
      }
      updateDetailEntryButtons();
      return;
    }

    removeDetailEntry("inline");
    let fallbackButton = document.querySelector(`[${DETAIL_AUTO_REVIEW_ATTR}="fallback"]`);
    if (!fallbackButton) {
      fallbackButton = createDetailAutoReviewButton("fallback");
      document.body.appendChild(fallbackButton);
    }
    updateDetailEntryButtons();
  }

  function waitForDetailRoot(timeoutMs = 2500) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const root = document.getElementById("oa-finance-rebuild-root");
        if (root) {
          resolve(root);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  async function openDetailAuditPanelFromPageButton() {
    await syncDetailPageEnhancements(window.location.href);
    const root = (await waitForDetailRoot()) || document.getElementById("oa-finance-rebuild-root");
    if (!root) {
      throw new Error("审核面板暂未加载，请刷新扩展后重试");
    }
    root.dispatchEvent(
      new CustomEvent("oa-finance-rebuild-open-panel", {
        detail: {
          preferCache: true,
          autoRunOnCacheMiss: true,
          source: "detail-action-button"
        }
      })
    );
  }

  async function handleDetailAutoReviewClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (state.detailEntryBusy) {
      return;
    }
    setDetailEntryBusy(true);
    try {
      await openDetailAuditPanelFromPageButton();
    } catch (error) {
      console.warn("[OA Finance Audit] 打开详情审核面板失败", error);
    } finally {
      setTimeout(() => setDetailEntryBusy(false), 1200);
    }
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

  function appendDetailCacheHint(rawUrl, processCode = "") {
    const text = cleanText(rawUrl);
    if (!text) {
      return "";
    }
    try {
      const url = new URL(text, window.location.origin);
      if (!/\/workflow\/process\/detail\//i.test(url.pathname)) {
        return text;
      }
      url.searchParams.set("oaAuditUseCache", "1");
      if (processCode && !cleanText(url.searchParams.get("processCode"))) {
        url.searchParams.set("processCode", processCode);
      }
      return url.toString();
    } catch (_error) {
      return text;
    }
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
    return appendDetailCacheHint(url.toString(), cleanText(row?.processCode));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function isClosedRuntimeMessageError(error) {
    const message = cleanText(error?.message || error);
    return /asynchronous response|message channel closed|receiving end does not exist/i.test(message);
  }

  function normalizeRuntimeMessageError(error) {
    if (isClosedRuntimeMessageError(error)) {
      return new Error("后台分析连接中断，已自动重试仍未恢复，请重新点击自动审核。");
    }
    return new Error(translateTechnicalErrorMessage(error?.message || error, "扩展通信失败"));
  }

  function sendRuntimeMessageOnce(message) {
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

  async function sendRuntimeMessage(message, options = {}) {
    const retries = Math.max(0, Number.parseInt(options.retries || "0", 10) || 0);
    const retryDelayMs = Math.max(0, Number.parseInt(options.retryDelayMs || "800", 10) || 0);
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await sendRuntimeMessageOnce(message);
      } catch (error) {
        lastError = error;
        if (!isClosedRuntimeMessageError(error) || attempt >= retries) {
          throw normalizeRuntimeMessageError(error);
        }
        await wait(retryDelayMs);
      }
    }

    throw normalizeRuntimeMessageError(lastError);
  }

  async function openResolvedSourceUrl(sourceName, sourceUrl, processCode = "") {
    const url = cleanText(sourceUrl);
    if (!url) {
      return;
    }

    let nextUrl = url;
    try {
      const response = await sendRuntimeMessage({
        type: "oa-finance-rebuild-resolve-source-url",
        pageUrl: window.location.href,
        processCode: cleanText(processCode),
        sourceName: cleanText(sourceName),
        sourceUrl: url
      });
      if (response?.ok && cleanText(response.sourceUrl)) {
        nextUrl = cleanText(response.sourceUrl);
      }
    } catch (_error) {
      // Fall back to the original URL when refresh fails.
    }

    window.open(nextUrl, "_blank", "noopener,noreferrer");
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
        progressPhase: "",
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
    refreshRowUi(processCode);
    return next;
  }

  function buildRowRenderKey(processCode) {
    const rowState = ensureRowState(processCode);
    return [
      processCode,
      rowState.status,
      rowState.progressPhase,
      rowState.progressText,
      rowState.result ? "1" : "0",
      rowState.errorText,
      rowState.detailUrl ? "1" : "0"
    ].join("|");
  }

  function renderAuditCellInnerHtml(processCode) {
    return `<div class="cell oa-finance-auto-review-cell-inner">${renderStatusButton(processCode)}</div>`;
  }

  function bindAuditCellTrigger(cell, processCode) {
    const triggerEl = cell?.querySelector(".oa-finance-auto-review-trigger");
    if (!triggerEl) {
      return;
    }
    triggerEl.onclick = (event) => {
      void handleTriggerActivate(processCode, triggerEl, event);
    };
  }

  function renderAuditCell(cell, processCode) {
    const renderKey = buildRowRenderKey(processCode);
    cell.setAttribute("data-process-code", processCode);
    if (cell.getAttribute("data-render-key") === renderKey) {
      return;
    }
    cell.setAttribute("data-render-key", renderKey);
    cell.innerHTML = renderAuditCellInnerHtml(processCode);
    bindAuditCellTrigger(cell, processCode);
  }

  function refreshRowUi(processCode) {
    const normalized = cleanText(processCode).toUpperCase();
    if (!normalized) {
      return;
    }
    const triggerEl = findTriggerByProcessCode(normalized);
    const cell =
      triggerEl?.closest?.(".oa-finance-auto-review-cell") ||
      document.querySelector(`td.oa-finance-auto-review-cell[data-process-code="${CSS.escape(normalized)}"]`);
    if (!cell) {
      debounceRefresh();
      return;
    }
    renderAuditCell(cell, normalized);
    if (state.popover && !state.popover.hidden && state.popoverCode === normalized) {
      const liveAnchor = findTriggerByProcessCode(normalized);
      if (liveAnchor) {
        showPopover(normalized, liveAnchor);
      }
    }
  }

  function createRequestId(processCode) {
    const suffix = Math.random().toString(16).slice(2, 8);
    return `${processCode}-${Date.now()}-${suffix}`;
  }

  function applyCachedEntryToRow(processCode, entry) {
    if (!entry?.result) {
      return;
    }
    const current = ensureRowState(processCode);
    if (current.requestId) {
      return;
    }
    patchRowState(processCode, {
      status: mapOverallStatus(entry.result?.overallStatus, ""),
      result: entry.result,
      errorText: "",
      detailUrl: cleanText(current.detailUrl || entry.detailUrl || ""),
      updatedAt: entry.cachedAt ? new Date(entry.cachedAt).toISOString() : current.updatedAt
    });
  }

  async function hydrateRowsFromCache(processCodes) {
    const pendingCodes = Array.from(new Set((processCodes || []).map((item) => cleanText(item)).filter(Boolean))).filter((code) => {
      if (state.cacheHydratedCodes.has(code) || state.cacheLoadingCodes.has(code)) {
        return false;
      }
      state.cacheLoadingCodes.add(code);
      return true;
    });
    if (pendingCodes.length === 0) {
      return;
    }

    try {
      const response = await sendRuntimeMessage({
        type: "oa-finance-rebuild-get-cache-bulk",
        processCodes: pendingCodes
      });
      if (response?.ok && Array.isArray(response.entries)) {
        for (const entry of response.entries) {
          applyCachedEntryToRow(cleanText(entry?.processCode), entry);
        }
      }
    } catch (_error) {
      // Ignore cache hydration failures and keep the table interactive.
    } finally {
      for (const code of pendingCodes) {
        state.cacheLoadingCodes.delete(code);
        state.cacheHydratedCodes.add(code);
      }
    }
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

  function formatRunningLabel(rowState) {
    const phase = cleanText(rowState?.progressPhase);
    if (phase === "payment-root" || phase === "open-detail" || phase === "collect-snapshot") {
      return "读取付款";
    }
    if (phase === "page-invoice") {
      return "查看发票";
    }
    if (phase === "page-attachments") {
      return "查看附件";
    }
    if (phase === "contract-link" || phase === "contract-open") {
      return "分析合同";
    }
    if (phase === "acceptance-link" || phase === "acceptance-open") {
      return "分析验收";
    }
    if (phase === "purchase-order-link" || phase === "purchase-order-open") {
      return "查看订单";
    }
    if (phase === "domestic-pr-link" || phase === "domestic-pr-open") {
      return "查看PR";
    }
    if (phase === "summary") {
      return "汇总结果";
    }

    const text = cleanText(rowState?.progressText);
    if (text.includes("发票")) return "查看发票";
    if (text.includes("附件")) return "查看附件";
    if (text.includes("合同")) return "分析合同";
    if (text.includes("验收")) return "分析验收";
    if (text.includes("订单")) return "查看订单";
    if (text.includes("PR")) return "查看PR";
    if (text.includes("汇总")) return "汇总结果";
    if (text.includes("付款")) return "读取付款";
    return rowState?.status === "reading" ? "读取付款" : "正在分析";
  }

  function renderStatusButton(processCode) {
    const rowState = ensureRowState(processCode);
    const meta = statusMetaOf(processCode);
    const canOpen = !!rowState.result || !!rowState.errorText || finishedStatus(rowState.status);
    const titleText = rowState.errorText || rowState.progressText || meta.label;
    const buttonLabel =
      rowState.status === "reading" || rowState.status === "analyzing" ? formatRunningLabel(rowState) : meta.label;
    return `
      <button
        type="button"
        class="oa-finance-auto-review-trigger is-${meta.tone}"
        data-process-code="${escapeHtml(processCode)}"
        data-has-detail="${canOpen ? "1" : "0"}"
        title="${escapeHtml(titleText)}"
      >
        <span class="oa-finance-auto-review-dot"></span>
        <span class="oa-finance-auto-review-label">${escapeHtml(buttonLabel)}</span>
      </button>
    `;
  }

  async function handleTriggerActivate(processCode, triggerEl, event = null) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const normalized = cleanText(processCode).toUpperCase();
    if (!normalized) {
      return;
    }
    const rowState = ensureRowState(normalized);
    if (rowState.status === "reading" || rowState.status === "analyzing") {
      return;
    }
    if (finishedStatus(rowState.status) || rowState.result || rowState.errorText) {
      await openPopoverWhenReady(normalized, triggerEl);
      return;
    }
    void auditProcessCode(normalized);
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
    renderAuditCell(cell, processCode);
  }

  function decorateNativeDetailLinks(rowEl, processCode) {
    Array.from(rowEl?.querySelectorAll('a[href*="/workflow/process/detail/"]') || []).forEach((linkEl) => {
      const href = cleanText(linkEl.getAttribute("href"));
      if (!href) {
        return;
      }
      const nextHref = appendDetailCacheHint(href, processCode);
      if (nextHref && nextHref !== href) {
        linkEl.setAttribute("href", nextHref);
      }
    });
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

  function isLikelyBrokenText(value) {
    const text = cleanText(value);
    if (!text) {
      return false;
    }
    if (/\?{3,}/.test(text)) {
      return true;
    }
    if (/[\uFFFD]/.test(text)) {
      return true;
    }
    const markers = text.match(/[\u93C0\u8235\uE0D9\u9359\u95AB\u8FAB\u93C8\u7459\u6FB6\u7490\u95B2\u93B5\u9365\u6960\u8930\u58A0\u6D60\u6E6D\u93BB\u7DF5]/g) || [];
    return markers.length >= 2;
  }

  function prettifySourceName(sourceName, sourceUrl) {
    const text = cleanText(sourceName);
    if (text && !/^https?:\/\//i.test(text) && !isLikelyBrokenText(text)) {
      return text;
    }
    const url = cleanText(sourceUrl || sourceName);
    if (!url) {
      return "";
    }
    if (/\/workflow\/process\/history\/detail\//i.test(url) || /\/workflow\/process\/detail\//i.test(url)) {
      return "来源流程";
    }
    const matched = url.match(/\/([^/?#]+\.(?:pdf|docx?|xlsx?|jpg|jpeg|png|msg|eml))(?:[?#]|$)/i);
    if (matched) {
      try {
        return decodeURIComponent(matched[1]);
      } catch (_error) {
        return matched[1];
      }
    }
    return "来源附件";
  }

  function formatVerificationLabel(item, index) {
    const key = cleanText(item?.key);
    if (key === "amount") return "金额一致";
    if (key === "company") return "收款公司名称一致";
    if (key === "account") return "收款账号一致";
    if (index === 0) return "金额一致";
    if (index === 1) return "收款公司名称一致";
    if (index === 2) return "收款账号一致";
    return cleanText(item?.label) || "核对项";
  }

  function formatVerificationStatement(item, label) {
    const matchedValue = cleanText(item?.matchedValue);
    const status = cleanText(item?.status);
    if (status === "pass") {
      if (label === "金额一致") {
        return matchedValue ? `已命中一致金额：${matchedValue}` : "已命中一致金额";
      }
      if (label === "收款公司名称一致") {
        return matchedValue ? `已命中一致收款公司：${matchedValue}` : "已命中一致收款公司";
      }
      if (label === "收款账号一致") {
        return matchedValue ? `已命中一致收款账号：${matchedValue}` : "已命中一致收款账号";
      }
    }
    if (status === "fail") {
      if (label === "金额一致") return "已发现不一致金额，请人工复核";
      if (label === "收款公司名称一致") return "已发现不一致收款公司，请人工复核";
      if (label === "收款账号一致") return "已发现不一致收款账号，请人工复核";
    }
    const statement = cleanText(item?.statement);
    if (statement && !isLikelyBrokenText(statement)) {
      return statement;
    }
    if (label === "金额一致") return "暂未拿到可确认的一致金额证据";
    if (label === "收款公司名称一致") return "暂未拿到可确认的一致收款公司证据";
    if (label === "收款账号一致") return "暂未拿到可确认的一致收款账号证据";
    return "暂未生成说明";
  }

  function renderSourceAction(sourceName, sourceUrl, label = "打开来源", processCode = "") {
    const url = cleanText(sourceUrl);
    if (!url) {
      return "";
    }
    const title = prettifySourceName(sourceName, url) || label;
    return `<a class="oa-finance-auto-review-inline-link oa-finance-auto-review-source-link" href="${escapeHtml(
      url
    )}" data-source-url="${escapeHtml(url)}" data-source-name="${escapeHtml(cleanText(sourceName))}" data-process-code="${escapeHtml(
      cleanText(processCode)
    )}" target="_blank" rel="noreferrer" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
  }

  function joinMeaningfulTexts(values, limit = 3, separator = "；") {
    return (values || [])
      .map((item) => cleanText(item))
      .filter(Boolean)
      .slice(0, limit)
      .join(separator);
  }

  function renderValueBlock(text, lines = 3) {
    const cleaned = cleanText(text);
    if (!cleaned) {
      return "";
    }
    if (cleaned.length <= 96) {
      return `<div class="oa-finance-auto-review-related-text">${escapeHtml(cleaned)}</div>`;
    }
    return renderExpandableText(cleaned, lines);
  }

  function renderRelatedCard(title, contentHtml, actionsHtml = "") {
    if (!contentHtml && !actionsHtml) {
      return "";
    }
    return `
      <div class="oa-finance-auto-review-related-card">
        <div class="oa-finance-auto-review-related-head">
          <strong>${escapeHtml(title)}</strong>
        </div>
        <div class="oa-finance-auto-review-related-body">${contentHtml || ""}</div>
        ${actionsHtml ? `<div class="oa-finance-auto-review-inline-actions">${actionsHtml}</div>` : ""}
      </div>
    `;
  }

  function renderExpandableText(text, lines = 4) {
    const cleaned = cleanText(text);
    if (!cleaned) {
      return "";
    }
    if (cleaned.length <= 120) {
      return `<div class="oa-finance-auto-review-related-text">${escapeHtml(cleaned)}</div>`;
    }
    return `
      <div class="oa-finance-auto-review-expandable-wrap">
        <div class="oa-finance-auto-review-related-text is-clamped" style="-webkit-line-clamp:${Number(lines) || 4};">${escapeHtml(cleaned)}</div>
        <details class="oa-finance-auto-review-expandable">
          <summary>
            <span class="oa-finance-auto-review-expand-closed">展开</span>
            <span class="oa-finance-auto-review-expand-open">收起</span>
          </summary>
          <div class="oa-finance-auto-review-related-text is-full">${escapeHtml(cleaned)}</div>
        </details>
      </div>
    `;
  }

  function renderVerificationSummary(result, processCode = "") {
    const items = Array.isArray(result?.verificationItems) ? result.verificationItems : [];
    if (items.length === 0) {
      return '<div class="oa-finance-auto-review-empty">还没有生成主核对结果。</div>';
    }
    return items
      .map(
        (item, index) => {
          const label = formatVerificationLabelMapped(item, index);
          const statement = formatVerificationStatementMapped(item, label);
          const sourceAction = renderSourceAction(item?.sourceName, item?.sourceUrl, "打开证据", processCode);
          return `
          <div class="oa-finance-auto-review-check">
            <div class="oa-finance-auto-review-check-head">
              <div class="oa-finance-auto-review-check-title">${escapeHtml(label)}</div>
              <div class="oa-finance-auto-review-check-actions">
                ${sourceAction || ""}
                <span class="oa-finance-auto-review-mini-pill is-${escapeHtml(item?.status || "warn")}">${escapeHtml(
                  formatStatusText(item?.status)
                )}</span>
              </div>
            </div>
            <div class="oa-finance-auto-review-check-text">${escapeHtml(statement)}</div>
          </div>
        `;
        }
      )
      .join("");
  }

  function renderRelatedSummary(result, processCode = "") {
    const related = result?.relatedDocuments || {};
    const blocks = [];

    const domesticItems = Array.isArray(related.domesticPrItems)
      ? related.domesticPrItems
      : related.domesticPr
        ? [related.domesticPr]
        : [];
    const domesticText = domesticItems
      .map((item, index) => {
        const summary = cleanText(
          item?.fields?.requirementSummary ||
          item?.fields?.relatedTitle ||
          item?.fields?.costPurpose ||
          item?.fields?.purposeText ||
          item?.summary
        );
        const meta = joinMeaningfulTexts(
          [
            cleanText(item?.fields?.processCode),
            cleanText(item?.fields?.prCurrentSubmitAmount) ? `本次提交：${cleanText(item?.fields?.prCurrentSubmitAmount)}` : "",
            cleanText(item?.fields?.prStatus) ? `状态：${cleanText(item?.fields?.prStatus)}` : ""
          ],
          3,
          " ｜ "
        );
        const title = cleanText(item?.fields?.processCode) || `PR ${index + 1}`;
        return summary
          ? `
            <div class="oa-finance-auto-review-pr-block">
              <div class="oa-finance-auto-review-pr-title">${escapeHtml(title)}</div>
              ${meta ? `<div class="oa-finance-auto-review-related-summary">${escapeHtml(meta)}</div>` : ""}
              ${renderExpandableText(summary, 4)}
            </div>
          `
          : "";
      })
      .filter(Boolean)
      .join("");
    if (domesticText) {
      blocks.push(renderRelatedCard("国内PR", domesticText));
    }

    const purchaseOrder = related.purchaseOrder;
    if (purchaseOrder) {
      const amountCheck = (purchaseOrder.checks || []).find((item) => cleanText(item?.key) === "payment_not_exceed_order_amount");
      const supplierCheck = (purchaseOrder.checks || []).find((item) => cleanText(item?.key) === "payee_matches_supplier");
      const compactText = joinMeaningfulTexts(
        [
          amountCheck ? `金额核对：${formatStatusText(amountCheck.status)}` : "",
          supplierCheck ? `供应商核对：${formatStatusText(supplierCheck.status)}` : ""
        ],
        2
      );
      const description = cleanText(purchaseOrder.fields?.description);
      blocks.push(
        renderRelatedCard(
          "采购订单",
          `<div class="oa-finance-auto-review-related-summary" title="${escapeHtml(
            description || "未提取到订单内容描述"
          )}">${escapeHtml(compactText || "已读取采购订单")}</div>`,
          purchaseOrder.sourceUrl ? renderSourceAction(purchaseOrder.sourceName, purchaseOrder.sourceUrl, "打开订单", processCode) : ""
        )
      );
    }

    const acceptanceItems = Array.isArray(related.acceptanceItems)
      ? related.acceptanceItems
      : related.acceptance
        ? [related.acceptance]
        : [];
    const acceptanceText = acceptanceItems
      .map((item) =>
        firstNonEmpty(
          item?.fields?.mailSubject,
          joinMeaningfulTexts(item?.attachmentNames, 4),
          joinMeaningfulTexts(item?.mailAttachmentNames, 4),
          joinMeaningfulTexts(item?.previewItems?.map((preview) => preview?.name), 4)
        )
      )
      .filter(Boolean)
      .join("；");
    if (acceptanceText) {
      blocks.push(renderRelatedCard("验收单", renderValueBlock(acceptanceText, 3)));
    }

    const contractSource = cleanText(result?.contractReference?.sourceName);
    const contractSourceUrl = cleanText(result?.contractReference?.sourceUrl || related?.contract?.sourceUrl);
    const contractSummary = cleanText(
      result?.contractSummary?.paymentTermsSummary || result?.contractReference?.paymentTerms
    );
    const contractPeriod = joinMeaningfulTexts(
      [
        cleanText(result?.contractReference?.effectiveStart),
        cleanText(result?.contractReference?.effectiveEnd)
      ],
      2,
      " ~ "
    );
    const contractText =
      contractSummary ||
      (contractPeriod ? `合同期间：${contractPeriod}` : "") ||
      (contractSource ? `合同来源：${contractSource}` : "") ||
      (contractSourceUrl ? "已读取合同信息" : "");
    if (contractSource || contractText || contractSourceUrl) {
      blocks.push(
        renderRelatedCard(
          "付款条件",
          renderValueBlock(contractText || "已读取合同信息", 3),
          contractSourceUrl ? renderSourceAction(contractSource, contractSourceUrl, "打开合同来源", processCode) : ""
        )
      );
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
          <div class="oa-finance-auto-review-popover-title-wrap">
            <div class="oa-finance-auto-review-popover-kicker">自动审核结果</div>
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
          <div class="oa-finance-auto-review-popover-title-wrap">
            <div class="oa-finance-auto-review-popover-kicker">自动审核结果</div>
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
        <div class="oa-finance-auto-review-popover-title-wrap">
          <div class="oa-finance-auto-review-popover-kicker">自动审核结果</div>
          <div class="oa-finance-auto-review-popover-code">${escapeHtml(processCode)}</div>
          <div class="oa-finance-auto-review-popover-status is-${meta.tone}">${escapeHtml(meta.label)}</div>
        </div>
        ${detailLink}
      </div>
      <section class="oa-finance-auto-review-popover-section">
        <h4>主核对</h4>
        ${renderVerificationSummary(result, processCode)}
      </section>
      <section class="oa-finance-auto-review-popover-section">
        <h4>关联摘要</h4>
        ${renderRelatedSummary(result, processCode)}
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

  function finishedStatus(status) {
    return status === "pass" || status === "warn" || status === "fail" || status === "error";
  }

  function showPopover(processCode, anchorEl) {
    const popover = ensurePopover();
    popover.innerHTML = renderPopoverBody(processCode);
    popover.hidden = false;
    state.popoverCode = processCode;

    const liveAnchor =
      anchorEl && anchorEl.isConnected ? anchorEl : findTriggerByProcessCode(processCode) || anchorEl || null;
    const anchorRect = liveAnchor
      ? liveAnchor.getBoundingClientRect()
      : { left: window.innerWidth - 180, top: 120 };
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

  function openPopover(processCode, anchorEl) {
    showPopover(processCode, anchorEl);
  }

  async function openPopoverWhenReady(processCode, anchorEl) {
    const current = ensureRowState(processCode);
    if (current.result || current.errorText) {
      openPopover(processCode, anchorEl);
      return;
    }

    await hydrateRowsFromCache([processCode]);
    const afterCache = ensureRowState(processCode);
    if (afterCache.result || afterCache.errorText) {
      openPopover(processCode, anchorEl);
      return;
    }

    if (finishedStatus(afterCache.status)) {
      patchRowState(processCode, {
        status: "error",
        errorText: "审核状态已完成，但未取到可展示的结果，请重试一次。"
      });
      openPopover(processCode, anchorEl);
    }
  }

  function resolveEventElement(target) {
    if (!target) {
      return null;
    }
    if (target.nodeType === Node.ELEMENT_NODE) {
      return target;
    }
    return target.parentElement || null;
  }

  async function auditProcessCode(processCode) {
    const requestId = createRequestId(processCode);
    state.requestMap.set(requestId, processCode);
    patchRowState(processCode, {
      status: "reading",
      result: null,
      errorText: "",
      requestId,
      progressPhase: "payment-root",
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
      }, {
        retries: 2,
        retryDelayMs: 1000
      });
      if (!response?.ok) {
        throw new Error(translateTechnicalErrorMessage(response?.error, "自动审核失败"));
      }

      patchRowState(processCode, {
        status: mapOverallStatus(response?.result?.overallStatus, ""),
        result: response.result || null,
        errorText: "",
        requestId: "",
        progressPhase: "",
        progressText: "",
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      patchRowState(processCode, {
        status: "error",
        errorText: translateTechnicalErrorMessage(error?.message || String(error), "自动审核失败"),
        requestId: "",
        progressPhase: "",
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
    const toolbarInnerHtml = `
      <div class="oa-finance-auto-review-toolbar-copy">
        <strong>自动审核</strong>
        <span class="oa-finance-auto-review-toolbar-note"></span>
      </div>
      <button type="button" class="oa-finance-auto-review-toolbar-btn"></button>
    `;
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "oa-finance-auto-review-toolbar";
      toolbar.innerHTML = toolbarInnerHtml;
      context.tableEl.parentElement?.insertBefore(toolbar, context.tableEl);
    }
    let noteEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-note");
    let buttonEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-btn");
    if (!noteEl || !buttonEl) {
      toolbar.innerHTML = toolbarInnerHtml;
      noteEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-note");
      buttonEl = toolbar.querySelector(".oa-finance-auto-review-toolbar-btn");
    }
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
    context.rowInfos.forEach((item) => {
      decorateNativeDetailLinks(item.rowEl, item.processCode);
      ensureBodyCell(item.rowEl, item.processCode, context.bodyTable);
    });
    void hydrateRowsFromCache(context.rowInfos.map((item) => item.processCode));
    if (state.popover && !state.popover.hidden && state.popoverCode) {
      const anchor = findTriggerByProcessCode(state.popoverCode);
      if (anchor) {
        showPopover(state.popoverCode, anchor);
      } else {
        hidePopover();
      }
    }
  }

  function findTriggerByProcessCode(processCode) {
    return document.querySelector(`.oa-finance-auto-review-trigger[data-process-code="${CSS.escape(processCode)}"]`);
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
      progressPhase: cleanText(payload.phase),
      progressText: cleanText(payload.text),
      updatedAt: new Date().toISOString()
    });
  }

  function handleDocumentClick(event) {
    const eventEl = resolveEventElement(event.target);
    const sourceLink = eventEl?.closest?.(".oa-finance-auto-review-source-link[data-source-url]");
    if (sourceLink) {
      event.preventDefault();
      void openResolvedSourceUrl(
        sourceLink.getAttribute("data-source-name") || "",
        sourceLink.getAttribute("data-source-url") || "",
        sourceLink.getAttribute("data-process-code") || ""
      );
      return;
    }
    if (state.popover && !state.popover.hidden && !eventEl?.closest?.(".oa-finance-auto-review-popover")) {
      hidePopover();
    }
  }

  function mount() {
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(() => handleUrlMaybeChanged(), 0);
      return result;
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(() => handleUrlMaybeChanged(), 0);
      return result;
    };

    debounceRefresh();
    handleUrlMaybeChanged(true);
    scheduleDetailEntryRefresh();
    state.observer = new MutationObserver((records) => {
      const meaningful = (records || []).some((record) => !shouldIgnoreMutation(record));
      if (!meaningful) {
        return;
      }
      handleUrlMaybeChanged();
      if (isDetailPageUrl()) {
        scheduleDetailEntryRefresh();
      }
      debounceRefresh();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    chrome.runtime.onMessage.addListener(handleProgressMessage);
    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener("resize", debounceRefresh);
    window.addEventListener("popstate", handleUrlMaybeChanged);
    window.addEventListener("hashchange", handleUrlMaybeChanged);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePopover();
      }
    });

    state.cleanupFns.push(() => chrome.runtime.onMessage.removeListener(handleProgressMessage));
    state.cleanupFns.push(() => document.removeEventListener("click", handleDocumentClick, true));
    state.cleanupFns.push(() => window.removeEventListener("resize", debounceRefresh));
    state.cleanupFns.push(() => window.removeEventListener("popstate", handleUrlMaybeChanged));
    state.cleanupFns.push(() => window.removeEventListener("hashchange", handleUrlMaybeChanged));
    state.cleanupFns.push(cleanupDetailAutoReviewEntry);
  }

  const VERIFICATION_LABEL_MAP_SAFE = {
    amount: "金额一致",
    company: "收款公司名称一致",
    account: "收款账号一致"
  };
  const VERIFICATION_STATEMENT_MAP_SAFE = {
    amount: {
      pass: (value) => value ? `已命中一致金额：${value}` : "已命中一致金额",
      fail: () => "已发现不一致金额，请人工复核",
      fallback: () => "暂未拿到可确认的一致金额证据"
    },
    company: {
      pass: (value) => value ? `已命中一致收款公司：${value}` : "已命中一致收款公司",
      fail: () => "已发现不一致收款公司，请人工复核",
      fallback: () => "暂未拿到可确认的一致收款公司证据"
    },
    account: {
      pass: (value) => value ? `已命中一致收款账号：${value}` : "已命中一致收款账号",
      fail: () => "已发现不一致收款账号，请人工复核",
      fallback: () => "暂未拿到可确认的一致收款账号证据"
    }
  };
  const INDEX_FALLBACK_KEY_SAFE = ["amount", "company", "account"];

  function formatVerificationLabelMapped(item, index) {
    const key = cleanText(item?.key);
    return (
      VERIFICATION_LABEL_MAP_SAFE[key] ||
      VERIFICATION_LABEL_MAP_SAFE[INDEX_FALLBACK_KEY_SAFE[index]] ||
      cleanText(item?.label) ||
      "核对项"
    );
  }

  function formatVerificationStatementMapped(item, label) {
    const matchedValue = cleanText(item?.matchedValue);
    const status = cleanText(item?.status);
    const key = cleanText(item?.key) || INDEX_FALLBACK_KEY_SAFE[Object.values(VERIFICATION_LABEL_MAP_SAFE).indexOf(label)] || "";
    const templates = VERIFICATION_STATEMENT_MAP_SAFE[key];
    if (templates) {
      if (status === "pass") return templates.pass(matchedValue);
      if (status === "fail") return templates.fail();
    }
    const statement = cleanText(item?.statement);
    if (statement && !isLikelyBrokenText(statement)) {
      return statement;
    }
    return templates?.fallback() || "暂未生成说明";
  }

  mount();
})();

