(() => {
  if (document.getElementById("oa-finance-rebuild-root")) {
    return;
  }

  const models = globalThis.OAFinanceRebuildModels;
  const collector = globalThis.OAFinanceRebuildCollector;
  const evidence = globalThis.OAFinanceRebuildEvidence;
  if (!models || !collector || !evidence) {
    return;
  }

  const STATUS_TEXT = {
    pass: "通过",
    warn: "预警",
    fail: "异常"
  };

  const EMPTY_VALUE_TEXTS = new Set([
    "",
    "未生成",
    "未提取",
    "未明确",
    "未提供",
    "待提取",
    "待核对",
    "待进入合同页读取",
    "暂无",
    "无",
    "未知"
  ]);

  const PANEL_UI_STORAGE_KEY = "oa-finance-rebuild-detail-panel-ui-v1";
  const PANEL_SECTION_ORDER = ["overview", "related", "contract", "debug"];
  const DEFAULT_OPEN_SECTIONS = ["overview"];
  const ROOT_LEFT_PADDING = 24;
  const ROOT_RIGHT = 24;
  const ROOT_BOTTOM = 24;
  const ROOT_MIN_TOP = 16;
  const DEFAULT_PANEL_TOP = 72;
  const DEFAULT_PANEL_RIGHT = ROOT_RIGHT;
  const DEFAULT_PANEL_WIDTH = 500;
  const DEFAULT_PANEL_HEIGHT = 640;
  const MIN_PANEL_WIDTH = 380;
  const MAX_PANEL_WIDTH = 700;
  const MIN_PANEL_HEIGHT = 320;
  const PANEL_RAIL_WIDTH = 76;
  const PANEL_WORKSPACE_GAP = 0;

  const PANEL_SECTIONS = {
    overview: {
      label: "主核对",
      summaryWhenEmpty: "默认展开"
    },
    related: {
      label: "关联单据",
      summaryWhenEmpty: "采集后加载"
    },
    contract: {
      label: "合同",
      summaryWhenEmpty: "采集后加载"
    },
    debug: {
      label: "调试",
      summaryWhenEmpty: "采集后加载"
    }
  };

  const state = {
    buildTag: "",
    statusText: "待采集",
    analysis: null,
    errorText: "",
    isRunning: false,
    activeRequestId: "",
    progressItems: [],
    progressCollapsed: false,
    panelWidth: DEFAULT_PANEL_WIDTH,
    panelTop: DEFAULT_PANEL_TOP,
    panelRight: DEFAULT_PANEL_RIGHT,
    panelHeight: getDefaultPanelHeight(),
    openSections: new Set(DEFAULT_OPEN_SECTIONS),
    uiLoaded: false,
    isDragging: false,
    isResizing: false
  };

  const runtime = {
    saveTimer: null,
    rootEventsBound: false
  };

  const root = document.createElement("div");
  root.id = "oa-finance-rebuild-root";
  document.body.appendChild(root);

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

  function resolveEventElement(target) {
    if (target instanceof Element) {
      return target;
    }
    return target?.parentElement || null;
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

  function createRequestId(scope = "detail") {
    const prefix = cleanText(scope || "detail").replace(/[^a-z0-9_-]+/gi, "-") || "detail";
    const suffix = Math.random().toString(16).slice(2, 8);
    return `${prefix}-${Date.now()}-${suffix}`;
  }

  function extractProcessCodeFromUrl() {
    try {
      const url = new URL(window.location.href);
      const fromQuery = cleanText(url.searchParams.get("processCode"));
      if (fromQuery) {
        return fromQuery;
      }
      const matched = `${url.pathname} ${url.search}`.match(/[A-Z]{2,8}-\d{8,}/i);
      return matched ? matched[0].toUpperCase() : "";
    } catch (_error) {
      return "";
    }
  }

  function normalizeSectionKeys(values) {
    return (Array.isArray(values) ? values : [])
      .map((value) => cleanText(value))
      .filter((value, index, array) => PANEL_SECTION_ORDER.includes(value) && array.indexOf(value) === index);
  }

  function getPanelMaxWidth() {
    const availableWidth =
      window.innerWidth - ROOT_LEFT_PADDING - ROOT_RIGHT - PANEL_RAIL_WIDTH - PANEL_WORKSPACE_GAP;
    return Math.max(280, Math.min(MAX_PANEL_WIDTH, availableWidth));
  }

  function getPanelShellWidth(panelWidth = state.panelWidth, railOnly = isRailOnly()) {
    return railOnly ? PANEL_RAIL_WIDTH : PANEL_RAIL_WIDTH + PANEL_WORKSPACE_GAP + clampPanelWidth(panelWidth);
  }

  function clampPanelWidth(value) {
    const numeric = Number(value);
    const resolved = Number.isFinite(numeric) ? numeric : DEFAULT_PANEL_WIDTH;
    const maxWidth = getPanelMaxWidth();
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    return Math.max(minWidth, Math.min(maxWidth, resolved));
  }

  function getDefaultPanelHeight() {
    return Math.max(MIN_PANEL_HEIGHT, window.innerHeight - DEFAULT_PANEL_TOP - ROOT_BOTTOM);
  }

  function getPanelMaxRight(panelWidth = state.panelWidth, railOnly = isRailOnly()) {
    return Math.max(ROOT_RIGHT, window.innerWidth - ROOT_LEFT_PADDING - getPanelShellWidth(panelWidth, railOnly));
  }

  function clampPanelRight(value, panelWidth = state.panelWidth, railOnly = isRailOnly()) {
    const numeric = Number(value);
    const resolved = Number.isFinite(numeric) ? numeric : DEFAULT_PANEL_RIGHT;
    const maxRight = getPanelMaxRight(panelWidth, railOnly);
    return Math.max(ROOT_RIGHT, Math.min(maxRight, resolved));
  }

  function getPanelMaxHeight(panelTop = state.panelTop) {
    return Math.max(MIN_PANEL_HEIGHT, window.innerHeight - panelTop - ROOT_BOTTOM);
  }

  function clampPanelHeight(value, panelTop = state.panelTop) {
    const numeric = Number(value);
    const resolved = Number.isFinite(numeric) && numeric > 0 ? numeric : getDefaultPanelHeight();
    const maxHeight = getPanelMaxHeight(panelTop);
    return Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, resolved));
  }

  function getPanelMaxTop(panelHeight = state.panelHeight) {
    const effectiveHeight = isRailOnly()
      ? Math.max(96, Math.ceil(root.getBoundingClientRect().height || 0))
      : clampPanelHeight(panelHeight, ROOT_MIN_TOP);
    return Math.max(ROOT_MIN_TOP, window.innerHeight - ROOT_BOTTOM - effectiveHeight);
  }

  function clampPanelTop(value, panelHeight = state.panelHeight) {
    const numeric = Number(value);
    const resolved = Number.isFinite(numeric) ? numeric : DEFAULT_PANEL_TOP;
    return Math.max(ROOT_MIN_TOP, Math.min(getPanelMaxTop(panelHeight), resolved));
  }

  function clampPanelUiState() {
    const width = clampPanelWidth(state.panelWidth);
    const right = clampPanelRight(state.panelRight, width);
    const top = clampPanelTop(state.panelTop, state.panelHeight);
    const height = clampPanelHeight(state.panelHeight, top);
    state.panelWidth = width;
    state.panelRight = right;
    state.panelTop = clampPanelTop(top, height);
    state.panelHeight = clampPanelHeight(height, state.panelTop);
  }

  function scheduleUiStatePersist() {
    if (!state.uiLoaded) {
      return;
    }
    if (runtime.saveTimer) {
      clearTimeout(runtime.saveTimer);
    }
    runtime.saveTimer = setTimeout(() => {
      runtime.saveTimer = null;
      chrome.storage.local.set(
        {
          [PANEL_UI_STORAGE_KEY]: {
            version: 1,
            width: state.panelWidth,
            top: state.panelTop,
            right: state.panelRight,
            height: state.panelHeight,
            openSections: Array.from(state.openSections)
          }
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }, 120);
  }

  function loadUiState() {
    try {
      chrome.storage.local.get(PANEL_UI_STORAGE_KEY, (payload) => {
        const saved = payload?.[PANEL_UI_STORAGE_KEY];
        if (saved && typeof saved === "object") {
          if (Object.prototype.hasOwnProperty.call(saved, "width")) {
            state.panelWidth = saved.width;
          }
          if (Object.prototype.hasOwnProperty.call(saved, "top")) {
            state.panelTop = saved.top;
          }
          if (Object.prototype.hasOwnProperty.call(saved, "right")) {
            state.panelRight = saved.right;
          }
          if (Object.prototype.hasOwnProperty.call(saved, "height")) {
            state.panelHeight = saved.height;
          }
          if (Array.isArray(saved.openSections)) {
            state.openSections = new Set(normalizeSectionKeys(saved.openSections));
          }
        }
        clampPanelUiState();
        state.uiLoaded = true;
        render();
      });
    } catch (_error) {
      state.uiLoaded = true;
      render();
    }
  }

  function isRailOnly() {
    return state.openSections.size === 0;
  }

  function isOverviewSolo() {
    return state.openSections.size === 1 && state.openSections.has("overview");
  }

  function isSectionOpen(sectionKey) {
    return state.openSections.has(sectionKey);
  }

  function toggleSection(sectionKey) {
    if (!PANEL_SECTION_ORDER.includes(sectionKey)) {
      return;
    }
    if (state.openSections.has(sectionKey)) {
      state.openSections.delete(sectionKey);
    } else {
      state.openSections.add(sectionKey);
    }
    scheduleUiStatePersist();
    render();
  }

  function collapseAllSections() {
    if (state.openSections.size === 0) {
      return;
    }
    state.openSections = new Set();
    scheduleUiStatePersist();
    render();
  }

  function applyPanelLayout() {
    clampPanelUiState();
    root.style.top = `${state.panelTop}px`;
    root.style.right = `${state.panelRight}px`;
    root.style.bottom = "auto";
    root.style.height = isRailOnly() ? "auto" : `${state.panelHeight}px`;
    root.style.setProperty("--oa-finance-rebuild-panel-width", `${state.panelWidth}px`);
    root.classList.toggle("is-rail-only", isRailOnly());
    root.classList.toggle("is-overview-solo", isOverviewSolo() && !isRailOnly());
    root.classList.toggle("is-dragging", state.isDragging);
    root.classList.toggle("is-resizing", state.isResizing);
  }

  function setInteractionMode(isActive, cursor) {
    document.body.style.userSelect = isActive ? "none" : "";
    document.body.style.cursor = isActive ? cursor : "";
  }

  function startPanelDrag(event, handle) {
    if (state.isResizing) {
      return;
    }
    if (event.button !== 0 && event.pointerType !== "touch") {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const startRight = state.panelRight;
    const startTop = state.panelTop;
    const startHeight = state.panelHeight;
    state.isDragging = true;
    applyPanelLayout();
    setInteractionMode(true, "move");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const handleMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return;
      }
      state.panelTop = clampPanelTop(startTop + (moveEvent.clientY - startY), startHeight);
      state.panelRight = clampPanelRight(startRight - (moveEvent.clientX - startX), state.panelWidth);
      applyPanelLayout();
    };

    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) {
        return;
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      state.isDragging = false;
      applyPanelLayout();
      setInteractionMode(false, "");
      scheduleUiStatePersist();
    };

    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function startPanelResize(event, handle) {
    if (state.isDragging) {
      return;
    }
    if (event.button !== 0 && event.pointerType !== "touch") {
      return;
    }
    const startX = event.clientX;
    const startWidth = state.panelWidth;
    state.isResizing = true;
    applyPanelLayout();
    setInteractionMode(true, "ew-resize");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const handleMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return;
      }
      const nextWidth = clampPanelWidth(startWidth - (moveEvent.clientX - startX));
      state.panelWidth = nextWidth;
      state.panelRight = clampPanelRight(state.panelRight, nextWidth);
      applyPanelLayout();
    };

    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) {
        return;
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      state.isResizing = false;
      applyPanelLayout();
      setInteractionMode(false, "");
      scheduleUiStatePersist();
    };

    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function startPanelResizeY(event, handle) {
    if (state.isDragging) {
      return;
    }
    if (event.button !== 0 && event.pointerType !== "touch") {
      return;
    }
    const startY = event.clientY;
    const startHeight = state.panelHeight;
    const startTop = state.panelTop;
    state.isResizing = true;
    applyPanelLayout();
    setInteractionMode(true, "ns-resize");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const handleMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return;
      }
      state.panelHeight = clampPanelHeight(startHeight + (moveEvent.clientY - startY), startTop);
      applyPanelLayout();
    };

    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) {
        return;
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      state.isResizing = false;
      applyPanelLayout();
      setInteractionMode(false, "");
      scheduleUiStatePersist();
    };

    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function applyAnalysisResult(result, statusText) {
    state.analysis = result || null;
    state.errorText = "";
    state.isRunning = false;
    state.statusText = statusText;
    state.progressCollapsed = true;
    root.dataset.analysisJson = JSON.stringify(state.analysis);
    render();
  }

  async function tryLoadCachedAnalysis() {
    const processCode = extractProcessCodeFromUrl();
    if (!processCode || state.analysis) {
      return;
    }
    try {
      const response = await sendRuntimeMessage({
        type: "oa-finance-rebuild-get-cache",
        processCode
      });
      if (!response?.ok || !response.entry?.result) {
        return;
      }
      state.progressItems = [];
      rememberProgress({
        text: "读取缓存",
        detail: "已载入最近一次自动审核结果"
      });
      applyAnalysisResult(response.entry.result, "已载入缓存");
    } catch (_error) {
      // Ignore cache read failures and keep manual analysis available.
    }
  }

  function hasMeaningfulText(value) {
    const text = String(value || "").trim();
    return text && !EMPTY_VALUE_TEXTS.has(text);
  }

  function rememberProgress(payload) {
    if (!payload?.text) {
      return;
    }
    const last = state.progressItems[state.progressItems.length - 1];
    if (last && last.text === payload.text && last.detail === payload.detail) {
      return;
    }
    state.progressItems = [...state.progressItems.slice(-7), payload];
  }

  function latestProgressText() {
    const last = state.progressItems[state.progressItems.length - 1];
    if (!last) {
      return "暂无进度";
    }
    return last.detail ? `${last.text}：${last.detail}` : last.text;
  }

  function pushKvRow(rows, label, value) {
    if (!hasMeaningfulText(value)) {
      return;
    }
    rows.push(`
      <div class="oa-finance-rebuild-kv">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function renderHighlightedText(text, keywords) {
    const source = String(text || "");
    const terms = Array.from(new Set((keywords || []).map((item) => cleanText(item)).filter(Boolean)))
      .sort((left, right) => right.length - left.length)
      .slice(0, 8);
    if (!source) {
      return "";
    }
    if (terms.length === 0) {
      return escapeHtml(source);
    }

    const pattern = new RegExp(terms.map((item) => escapeRegExp(item)).join("|"), "gi");
    let cursor = 0;
    let html = "";

    for (const match of source.matchAll(pattern)) {
      const index = match.index || 0;
      html += escapeHtml(source.slice(cursor, index));
      html += `<mark class="oa-finance-rebuild-mark">${escapeHtml(match[0])}</mark>`;
      cursor = index + match[0].length;
    }

    html += escapeHtml(source.slice(cursor));
    return html;
  }

  function splitClauseContext(text) {
    const parts = String(text || "")
      .split(/[。；;\n]/)
      .map((item) => cleanText(item))
      .filter(Boolean);

    if (parts.length >= 3) {
      return [
        { label: "上一条", text: parts[0] },
        { label: "当前条", text: parts[1] },
        { label: "下一条", text: parts.slice(2).join("；") }
      ];
    }

    if (parts.length === 2) {
      return [
        { label: "相关前文", text: parts[0] },
        { label: "当前条", text: parts[1] }
      ];
    }

    if (parts.length === 1) {
      return [{ label: "当前条", text: parts[0] }];
    }

    return [];
  }

  function formatClauseScore(score) {
    const numeric = Number(score);
    return Number.isFinite(numeric) ? `得分 ${numeric}` : "";
  }

  function formatClausePage(pageLabel) {
    const text = cleanText(pageLabel);
    return text ? `页码 ${text}` : "";
  }

  function formatClauseRank(clauseId, index) {
    const matched = cleanText(clauseId).match(/(\d+)/);
    const order = matched ? Number(matched[1]) : index + 1;
    return `候选 ${order}`;
  }

  function renderClauseTagList(keywords, restrictionFlags) {
    const tags = [
      ...(Array.isArray(keywords) ? keywords.slice(0, 5) : []),
      ...(Array.isArray(restrictionFlags) ? restrictionFlags.map((item) => `提醒：${item}`) : [])
    ]
      .map((item) => cleanText(item))
      .filter(Boolean);

    if (tags.length === 0) {
      return "";
    }

    return `
      <div class="oa-finance-rebuild-clause-tags">
        ${tags.map((item) => `<span class="oa-finance-rebuild-clause-tag">${escapeHtml(item)}</span>`).join("")}
      </div>
    `;
  }

  function renderContractEvidenceCard(item, index) {
    if (!item) {
      return "";
    }

    const title = cleanText(item.title) || formatClauseRank(item.clauseId, index);
    const rank = formatClauseRank(item.clauseId, index);
    const meta = [formatClauseScore(item.score), formatClausePage(item.pageLabel)].filter(Boolean).join(" · ");
    const contextRows = splitClauseContext(item.text);
    const excerpt = contextRows.find((row) => row.label === "当前条")?.text || cleanText(item.text);
    const sourceName = usefulSourceName(item.sourceName);
    const clickableClass = item.sourceUrl ? "is-clickable" : "";
    const sourceAttrs = item.sourceUrl
      ? `data-source-url="${escapeHtml(item.sourceUrl)}" tabindex="0" role="button"`
      : "";

    return `
      <article class="oa-finance-rebuild-clause ${clickableClass}" ${sourceAttrs}>
        <div class="oa-finance-rebuild-clause-head">
          <div>
            <span class="oa-finance-rebuild-clause-rank">${escapeHtml(rank)}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <span>${escapeHtml(meta || "证据条款")}</span>
        </div>
        <p>${renderHighlightedText(excerpt, item.matchedKeywords)}</p>
        ${renderClauseTagList(item.matchedKeywords, item.restrictionFlags)}
        <details class="oa-finance-rebuild-clause-context">
          <summary>展开上下文</summary>
          <div class="oa-finance-rebuild-clause-context-body">
            ${
              contextRows.length > 0
                ? contextRows
                    .map(
                      (row) => `
                        <div class="oa-finance-rebuild-clause-context-row">
                          <span>${escapeHtml(row.label)}</span>
                          <strong>${renderHighlightedText(row.text, item.matchedKeywords)}</strong>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="oa-finance-rebuild-clause-context-row"><strong>${renderHighlightedText(item.text, item.matchedKeywords)}</strong></div>`
            }
          </div>
        </details>
        <div class="oa-finance-rebuild-clause-footer">
          ${sourceName ? `<span>${escapeHtml(sourceName)}</span>` : "<span>合同原文</span>"}
          ${
            item.sourceUrl
              ? `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">打开原文</a>`
              : ""
          }
        </div>
      </article>
    `;
  }

  function renderContractEvidenceTheme(title, items, emptyText) {
    const candidates = refineContractEvidenceItems(title, items);
    return `
      <div class="oa-finance-rebuild-contract-theme">
        <div class="oa-finance-rebuild-contract-theme-title">${escapeHtml(title)}</div>
        ${
          candidates.length > 0
            ? `<div class="oa-finance-rebuild-clause-list">${candidates.map((item, index) => renderContractEvidenceCard(item, index)).join("")}</div>`
            : `<p class="oa-finance-rebuild-empty">${escapeHtml(emptyText)}</p>`
        }
      </div>
    `;
  }

  function refineContractEvidenceItems(title, items) {
    const candidates = Array.isArray(items) ? items.filter(Boolean) : [];
    const isTermTheme = /合同期|期限/.test(title);
    const pattern = isTermTheme
      ? /期限|有效期|届满|到期|自动续展|自动延长|续签|顺延|一年一签|起|至|止/
      : /付款|支付|结算|发票|开票|验收|工作日|自然日|次月|月结|电汇|预付|尾款/;

    const filtered = candidates.filter((item) => {
      const haystack = [item.title, item.text, ...(Array.isArray(item.matchedKeywords) ? item.matchedKeywords : [])]
        .map((value) => cleanText(value))
        .join(" ");
      return pattern.test(haystack);
    });

    return (filtered.length > 0 ? filtered : candidates).slice(0, isTermTheme ? 4 : 5);
  }

  function buildKvRows(items) {
    const rows = [];
    for (const item of items || []) {
      if (!item || !item.label) {
        continue;
      }
      pushKvRow(rows, item.label, item.value);
    }
    return rows;
  }

  function renderContractOverviewTheme(title, items, emptyText) {
    const rows = buildKvRows(items);
    return `
      <div class="oa-finance-rebuild-contract-theme oa-finance-rebuild-contract-summary-theme">
        <div class="oa-finance-rebuild-contract-theme-title">${escapeHtml(title)}</div>
        ${rows.length > 0 ? rows.join("") : `<p class="oa-finance-rebuild-empty">${escapeHtml(emptyText)}</p>`}
      </div>
    `;
  }

  function formatContractPeriod(start, end) {
    const left = cleanText(start);
    const right = cleanText(end);
    if (left && right) {
      return `${left} ~ ${right}`;
    }
    return left || right || "";
  }

  function extractInvoiceGoodsType(summary) {
    const source = [summary?.taxRate, summary?.invoiceRequirement]
      .map((value) => cleanText(value))
      .filter(Boolean)
      .join("；");
    if (!source) {
      return "";
    }

    const pair = source.match(/\*([^*]+)\*\s*\*([^*]+)\*/);
    if (pair) {
      return cleanText(`${pair[1]} / ${pair[2]}`);
    }

    const direct =
      source.match(/开票内容[：:]\s*([^；;。]+)/)?.[1] ||
      source.match(/(?:发票|专票|普票)[^；;。]*?(现代服务|技术服务费|服务费|维护费|广告服务费|软件服务费|咨询服务费)/)?.[1] ||
      "";

    return cleanText(direct).replace(/\s*\*+\s*/g, " ").trim();
  }

  function summarizeDisplayText(value, maxLength = 140) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function usefulSourceName(value) {
    const text = String(value || "")
      .replaceAll("闄勪欢", "附件")
      .replaceAll("琛ㄥ崟", "表单")
      .replaceAll("鍚堝悓椤", "合同页")
      .trim();
    if (!text) {
      return "";
    }
    if (text === "流程标题" || text === "畅游OA管理系统") {
      return "";
    }
    return text;
  }

  function buildHoverBlock(lines) {
    const items = (lines || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (items.length === 0) {
      return "";
    }
    return `
      <div class="oa-finance-rebuild-hover">
        ${items.map((item) => `<div>${escapeHtml(item)}</div>`).join("")}
      </div>
    `;
  }

  function statusTextOf(check) {
    return STATUS_TEXT[check?.status] || check?.status || "预警";
  }

  function normalizeDomesticPrQuarterDisplay(value) {
    const text = cleanText(value).toUpperCase();
    if (!text) {
      return "";
    }
    if (/^Q[1-4]$/.test(text)) {
      return text;
    }
    if (/^[1-4]$/.test(text)) {
      return `Q${text}`;
    }
    return text;
  }

  function buildDomesticPrPeriodMeta(doc) {
    const fields = doc?.fields || {};
    const short = cleanText(fields.costPeriodShort);
    const text = cleanText(fields.costPeriodText);
    const year = cleanText(fields.costYear);
    const quarter = normalizeDomesticPrQuarterDisplay(fields.costQuarter);

    if (short) {
      return {
        short,
        text: text || short
      };
    }

    if (year && quarter) {
      return {
        short: `${year.slice(-2)}${quarter}`,
        text: text || `${year} / ${quarter}`
      };
    }

    return {
      short: "",
      text
    };
  }

  function getRelatedCardTitle(title, doc) {
    const baseTitle = cleanText(doc?.fields?.processCode) || doc?.itemLabel || title;
    if (doc?.kind !== "domestic_pr") {
      return baseTitle;
    }
    const periodMeta = buildDomesticPrPeriodMeta(doc);
    return periodMeta.short ? `${baseTitle} ${periodMeta.short}` : baseTitle;
  }

  function buildRelatedHoverLines(doc) {
    if (!doc) {
      return [];
    }

    if (doc.kind === "domestic_pr") {
      const lines = [];
      const periodMeta = buildDomesticPrPeriodMeta(doc);
      if (hasMeaningfulText(periodMeta.text || periodMeta.short)) {
        lines.push(`费用期间：${periodMeta.text || periodMeta.short}`);
      }
      if (hasMeaningfulText(doc.fields?.relatedTitle)) {
        lines.push(`相关流程：${doc.fields.relatedTitle}`);
      }
      if (hasMeaningfulText(doc.fields?.requirementSummary || doc.fields?.costPurpose || doc.fields?.purposeText)) {
        lines.push(`需求描述：${doc.fields.requirementSummary || doc.fields?.costPurpose || doc.fields?.purposeText}`);
      }
      if (hasMeaningfulText(doc.fields?.processCode)) {
        lines.push(`PR单号：${doc.fields.processCode}`);
      }
      if (hasMeaningfulText(doc.fields?.prStatus)) {
        lines.push(`PR状态：${doc.fields.prStatus}`);
      }
      if (hasMeaningfulText(doc.fields?.prCurrentSubmitAmount)) {
        lines.push(`PR本次提交金额：${doc.fields.prCurrentSubmitAmount}`);
      }
      if (hasMeaningfulText(doc.fields?.prPendingAmount)) {
        lines.push(`PR未提交付款金额：${doc.fields.prPendingAmount}`);
      }
      return lines;
    }

    if (doc.kind === "purchase_order") {
      const lines = [];
      if (hasMeaningfulText(doc.fields?.description)) {
        lines.push(`订单内容：${doc.fields.description}`);
      }
      if (hasMeaningfulText(doc.fields?.supplierName)) {
        lines.push(`订单供应商：${doc.fields.supplierName}`);
      }
      if (hasMeaningfulText(doc.fields?.orderAmount)) {
        lines.push(`订单金额：${doc.fields.orderAmount}`);
      }
      for (const check of doc.checks || []) {
        lines.push(`${check.label}（${statusTextOf(check)}）：${check.statement}`);
      }
      return lines;
    }

    if (doc.kind === "acceptance") {
      const lines = [];
      for (const item of doc.previewItems || []) {
        if (!hasMeaningfulText(item?.name) || !hasMeaningfulText(item?.snippet)) {
          continue;
        }
        lines.push(`${item.name}：${item.snippet}`);
      }
      if (lines.length === 0 && Array.isArray(doc.attachmentNames) && doc.attachmentNames.length > 0) {
        lines.push(`附件：${doc.attachmentNames.join("、")}`);
      }
      if (lines.length === 0) {
        for (const hint of doc.relationHints || []) {
          if (hasMeaningfulText(hint)) {
            lines.push(hint);
          }
        }
      }
      return lines;
    }

    return [];
  }

  function relatedBadgeClass(status) {
    if (status === "pass") {
      return "pass";
    }
    if (status === "fail") {
      return "fail";
    }
    if (status === "info") {
      return "info";
    }
    return "warn";
  }

  function renderProgressSection() {
    if (!state.isRunning && state.progressItems.length === 0) {
      return "";
    }

    const collapsed = !state.isRunning && state.progressCollapsed;
    const items = state.progressItems
      .map((item, index) => {
        const isLatest = index === state.progressItems.length - 1;
        return `
          <div class="oa-finance-rebuild-progress-item ${isLatest ? "is-current" : ""}">
            <span class="oa-finance-rebuild-progress-dot"></span>
            <div class="oa-finance-rebuild-progress-copy">
              <div class="oa-finance-rebuild-progress-text">${escapeHtml(item.text || "")}</div>
              ${item.detail ? `<div class="oa-finance-rebuild-progress-detail">${escapeHtml(item.detail)}</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    return `
      <section class="oa-finance-rebuild-section">
        <button class="oa-finance-rebuild-progress-toggle oa-finance-rebuild-main-progress-toggle" type="button" aria-expanded="${collapsed ? "false" : "true"}">
          <span class="oa-finance-rebuild-section-title">实时进度</span>
          <span class="oa-finance-rebuild-progress-summary">${escapeHtml(latestProgressText())}</span>
          <span class="oa-finance-rebuild-progress-arrow ${collapsed ? "" : "is-open"}">▾</span>
        </button>
        ${
          collapsed
            ? ""
            : `<div class="oa-finance-rebuild-progress-list">
                ${items || "<div class='oa-finance-rebuild-empty'>正在准备分析任务</div>"}
              </div>`
        }
      </section>
    `;
  }

  function renderVerificationItem(item) {
    const statusText = STATUS_TEXT[item.status] || "预警";
    const sourceLine = item.sourceName ? `来源：${item.sourceName}` : "来源：待补充";
    const snippetLine = item.snippet || "当前阶段尚未生成可展示的来源片段。";
    const matchedValue = item.matchedValue ? `匹配值：${item.matchedValue}` : "";
    const clickableClass = item.sourceUrl ? "is-clickable" : "";
    const sourceAttrs = item.sourceUrl
      ? `data-source-url="${escapeHtml(item.sourceUrl)}" tabindex="0" role="button"`
      : "";

    return `
      <article class="oa-finance-rebuild-result is-${escapeHtml(item.status)} ${clickableClass}" ${sourceAttrs}>
        <div class="oa-finance-rebuild-result-row">
          <h3 class="oa-finance-rebuild-result-title">${escapeHtml(item.label)}</h3>
          <span class="oa-finance-rebuild-result-pill is-${escapeHtml(item.status)}">${escapeHtml(statusText)}</span>
        </div>
        <div class="oa-finance-rebuild-hover">
          <div>${escapeHtml(item.statement || "当前阶段尚未生成可展示的核对说明。")}</div>
          <div>${escapeHtml(sourceLine)}</div>
          ${matchedValue ? `<div>${escapeHtml(matchedValue)}</div>` : ""}
          <div>${escapeHtml(snippetLine)}</div>
        </div>
      </article>
    `;
  }

  function renderContractSummarySection(analysis) {
    const summary = analysis.contractSummary || {};
    const contract = analysis.relatedDocuments?.contract || {};
    const contractRef = analysis.contractReference || {};
    const processing = analysis.contractProcessing || {};
    const hasContractPage = processing.pageStatus === "read_ok";
    const attachmentName = Array.isArray(processing.attachmentNames) ? processing.attachmentNames[0] : "";
    const sourceName = hasContractPage
      ? usefulSourceName(contract.sourceName) || usefulSourceName(contractRef.sourceName)
      : usefulSourceName(contractRef.sourceName) || usefulSourceName(contract.sourceName) || attachmentName;
    const sourceUrl = hasContractPage
      ? contract.sourceUrl || contractRef.sourceUrl || ""
      : contractRef.sourceUrl || contract.sourceUrl || "";
    const contractTypes = Array.isArray(summary.detectedContractTypes) ? summary.detectedContractTypes.filter(Boolean) : [];
    const contractHints = [
      ...(Array.isArray(summary.conflictHints) ? summary.conflictHints : []),
      ...(Array.isArray(summary.restrictionHints) ? summary.restrictionHints : [])
    ].filter(Boolean);
    const paymentEvidence = Array.isArray(summary.paymentClauseEvidence) ? summary.paymentClauseEvidence.filter(Boolean).slice(0, 5) : [];
    const termEvidence = Array.isArray(summary.termClauseEvidence) ? summary.termClauseEvidence.filter(Boolean).slice(0, 4) : [];
    const invoiceGoodsType = extractInvoiceGoodsType(summary);
    const paymentOverview = [
      { label: "付款方式", value: summary.paymentMode },
      { label: "付款条款摘要", value: summary.paymentTermsSummary || contractRef.paymentTerms },
      { label: "验收条件", value: summary.acceptanceRequirement },
      { label: "付款时限", value: summary.paymentDeadline },
      { label: "分期安排", value: summary.installments },
      { label: "金额上限", value: summary.capAmount },
      { label: "账户变更要求", value: summary.accountChangeRequirement }
    ];
    const termOverview = [
      { label: "合同期间", value: formatContractPeriod(contractRef.effectiveStart, contractRef.effectiveEnd) },
      { label: "识别类型", value: contractTypes.join("、") },
      { label: "条款提醒", value: contractHints.slice(0, 3).join("；") }
    ];
    const invoiceOverview = [
      { label: "发票条件", value: summary.invoiceRequirement },
      { label: "税率", value: summary.taxRate },
      { label: "发票货物类型", value: invoiceGoodsType }
    ];
    const metaRows = buildKvRows([
      { label: "合同来源", value: sourceName },
      { label: "错误信息", value: summary.errorText }
    ]);

    if (metaRows.length === 0 && !sourceUrl && paymentEvidence.length === 0 && termEvidence.length === 0) {
      return "";
    }

    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">合同摘要</div>
        <div class="oa-finance-rebuild-contract-overview">
          ${renderContractOverviewTheme("付款条件", paymentOverview, "暂未提取到明确付款条件。")}
          ${renderContractOverviewTheme("合同期间", termOverview, "暂未提取到明确合同期间。")}
          ${renderContractOverviewTheme("发票相关", invoiceOverview, "暂未提取到明确发票信息。")}
        </div>
        ${metaRows.length > 0 ? `<div class="oa-finance-rebuild-contract-meta">${metaRows.join("")}</div>` : ""}
        <div class="oa-finance-rebuild-contract-evidence">
          ${renderContractEvidenceTheme("付款条件", paymentEvidence, "暂未筛到高可信付款条款候选。")}
          ${renderContractEvidenceTheme("合同期间", termEvidence, "暂未筛到高可信期限条款候选。")}
        </div>
        ${
          sourceUrl
            ? `<div class="oa-finance-rebuild-link-row"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">打开合同来源</a></div>`
            : ""
        }
      </section>
    `;
  }

  function renderRelatedDocumentSection(title, doc) {
    if (!doc) {
      return "";
    }

    const rows = [];
    const hoverHtml = buildHoverBlock(buildRelatedHoverLines(doc));
    const cardTitle = getRelatedCardTitle(title, doc);

    if (doc.kind === "domestic_pr") {
      const periodMeta = buildDomesticPrPeriodMeta(doc);
      pushKvRow(rows, "费用期间", periodMeta.text || periodMeta.short);
      if (hasMeaningfulText(doc.fields?.requirementSummary || doc.fields?.relatedTitle || doc.fields?.costPurpose || doc.fields?.purposeText)) {
        pushKvRow(rows, "需求描述", summarizeDisplayText(doc.fields?.requirementSummary || doc.fields?.relatedTitle || doc.fields?.costPurpose || doc.fields?.purposeText, 180));
      } else {
        pushKvRow(rows, "需求描述", "已进入国内PR页，但暂未提取到品牌、型号、规格、配置、技术要求或说明");
      }
      pushKvRow(rows, "PR单号", usefulSourceName(doc.fields?.processCode));
      pushKvRow(rows, "PR状态", usefulSourceName(doc.fields?.prStatus));
      pushKvRow(rows, "本次提交", usefulSourceName(doc.fields?.prCurrentSubmitAmount));
      pushKvRow(rows, "费用归属部门", summarizeDisplayText(doc.fields?.costDept, 120));
    }

    if (doc.kind === "purchase_order") {
      const amountCheck = (doc.checks || []).find((item) => item.key === "payment_not_exceed_order_amount") || null;
      const amountStatusText = amountCheck ? statusTextOf(amountCheck) : "预警";
      pushKvRow(
        rows,
        `金额一致（${amountStatusText}）`,
        amountCheck?.statement || "暂未提取到付款金额或订单金额"
      );
    }

    if (doc.kind === "acceptance") {
      if (hasMeaningfulText(doc.fields?.mailSubject)) {
        pushKvRow(rows, "邮件标题", summarizeDisplayText(doc.fields?.mailSubject, 180));
      }
      if (Array.isArray(doc.attachmentNames) && doc.attachmentNames.length > 0) {
        pushKvRow(rows, "附件", summarizeDisplayText(doc.attachmentNames.join("、"), 180));
      } else if (!hasMeaningfulText(doc.fields?.mailSubject)) {
        pushKvRow(rows, "邮件标题", "已进入验收页，但暂未提取到邮件标题");
      }
    }

    if (doc.errorText) {
      pushKvRow(rows, "错误信息", doc.errorText);
    }

    return `
      <div class="oa-finance-rebuild-related-card">
        <div class="oa-finance-rebuild-related-head">
          <div class="oa-finance-rebuild-section-title">${escapeHtml(cardTitle)}</div>
          <span class="oa-finance-rebuild-result-pill is-${relatedBadgeClass(doc.status)}">${escapeHtml(doc.statusText || "待处理")}</span>
        </div>
        <div class="oa-finance-rebuild-related-body">
          ${rows.join("") || "<p class='oa-finance-rebuild-empty'>暂无可展示信息</p>"}
        </div>
        ${hoverHtml}
        ${
          doc.sourceUrl
            ? `<div class="oa-finance-rebuild-link-row"><a href="${escapeHtml(doc.sourceUrl)}" target="_blank" rel="noreferrer">打开来源页面</a></div>`
            : ""
        }
      </div>
    `;
  }

  function renderRelatedDocumentsSection(analysis) {
    const related = analysis.relatedDocuments || {};
    const sections = [
      ...(Array.isArray(related.domesticPrItems) && related.domesticPrItems.length > 0
        ? related.domesticPrItems.map((doc) => ({ title: "国内PR", doc }))
        : [{ title: "国内PR", doc: related.domesticPr }]),
      { title: "采购订单", doc: related.purchaseOrder },
      ...(Array.isArray(related.acceptanceItems) && related.acceptanceItems.length > 0
        ? related.acceptanceItems.map((doc) => ({ title: "验收单", doc }))
        : [{ title: "验收单", doc: related.acceptance }])
    ]
      .filter((item) => item.doc)
      .map((item) => renderRelatedDocumentSection(item.title, item.doc))
      .filter(Boolean)
      .join("");

    if (!sections) {
      return "";
    }

    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">关联单据核对</div>
        <div class="oa-finance-rebuild-related-list">${sections}</div>
      </section>
    `;
  }

  function renderContractStatusSection(analysis) {
    return "";
  }

  function renderPageSummary(analysis) {
    const summary = analysis.pageSummary || {};
    const target = analysis.paymentTarget || {};
    const summaryItems = [
      { label: "附件", value: summary.attachmentCount || 0 },
      { label: "发票附件", value: summary.invoiceAttachmentCount || 0 },
      { label: "国内PR链接", value: summary.domesticPrLinkCount || 0 },
      { label: "采购订单链接", value: summary.purchaseOrderLinkCount || 0 },
      { label: "合同来源", value: (summary.contractAttachmentCount || 0) + (summary.contractLinkCount || 0) },
      { label: "账号附件", value: summary.bankChangeAttachmentCount || 0 },
      { label: "验收来源", value: (summary.acceptanceAttachmentCount || 0) + (summary.acceptanceLinkCount || 0) },
      { label: "其他链接", value: summary.otherLinkCount || 0 },
      { label: "结构化发票", value: summary.invoiceStructuredCount || 0 }
    ];
    const targetItems = [
      { label: "付款单号", value: target.processCode || "未识别" },
      { label: "付款金额", value: models.formatAmount(target.paymentAmount) || "未识别" },
      { label: "收款公司", value: target.payeeCompany || "未识别", wide: true },
      { label: "收款账号", value: target.payeeAccount || "未识别", wide: true }
    ];
    return `
      <section class="oa-finance-rebuild-section oa-finance-rebuild-page-summary">
        <div class="oa-finance-rebuild-page-summary-head">
          <div class="oa-finance-rebuild-section-title">页面采集结果</div>
          <span class="oa-finance-rebuild-page-summary-note">采集概览</span>
        </div>
        <div class="oa-finance-rebuild-page-summary-stats">
          ${summaryItems
            .map(
              (item) => `
                <div class="oa-finance-rebuild-mini">
                  <span>${escapeHtml(item.label)}</span>
                  <strong>${escapeHtml(String(item.value))}</strong>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="oa-finance-rebuild-page-summary-target">
          <div class="oa-finance-rebuild-page-summary-subtitle">当前付款单</div>
          <div class="oa-finance-rebuild-page-summary-target-grid">
            ${targetItems
              .map((item) => {
                const value =
                  typeof item.value === "number" || hasMeaningfulText(item.value) ? String(item.value) : "未识别";
                return `
                  <div class="oa-finance-rebuild-target-item ${item.wide ? "is-wide" : ""}">
                    <span>${escapeHtml(item.label)}</span>
                    <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderOverviewSideSummary(analysis) {
    if (!analysis) {
      return `
        <div class="oa-finance-rebuild-panel-card oa-finance-rebuild-overview-side-empty">
          <div class="oa-finance-rebuild-section-title">采集概览</div>
          <p class="oa-finance-rebuild-empty">开始采集后，这里会展示页面采集结果和当前付款单关键信息。</p>
        </div>
      `;
    }

    return renderPageSummary(analysis);
  }

  function renderEvidencePoolSummary(analysis) {
    const pool = analysis.evidencePool || {};
    const sections = [
      { label: "发票附件", list: pool.invoiceAttachments },
      { label: "合同附件", list: pool.contractAttachments },
      { label: "账号附件", list: pool.bankChangeAttachments },
      { label: "验收附件", list: pool.acceptanceAttachments },
      { label: "国内PR链接", list: pool.domesticPrLinks },
      { label: "采购订单链接", list: pool.purchaseOrderLinks },
      { label: "合同链接", list: pool.contractLinks },
      { label: "验收链接", list: pool.acceptanceLinks }
    ].filter((item) => Array.isArray(item.list) && item.list.length > 0);

    if (sections.length === 0) {
      return "";
    }

    const itemsHtml = sections
      .map((item) => {
        const names = item.list
          .slice(0, 3)
          .map((entry) => escapeHtml(entry.name || entry.title || entry.url || "未命名来源"))
          .join("、");
        return `<div class="oa-finance-rebuild-kv"><span>${escapeHtml(item.label)}</span><strong>${names}</strong></div>`;
      })
      .join("");

    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">已发现外部来源</div>
        ${itemsHtml}
      </section>
    `;
  }

  function renderErrorSection() {
    if (!state.errorText) {
      return "";
    }
    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">诊断信息</div>
        <div class="oa-finance-rebuild-result is-fail">
          <p class="oa-finance-rebuild-empty">${escapeHtml(state.errorText)}</p>
        </div>
      </section>
    `;
  }

  function renderDebugSection(analysis) {
    const evidenceHtml = analysis ? renderEvidencePoolSummary(analysis) : "";
    const pageSummaryHtml = analysis ? renderPageSummary(analysis) : "";
    if (!evidenceHtml && !pageSummaryHtml) {
      return "";
    }
    return `<div class="oa-finance-rebuild-debug-body">${pageSummaryHtml}${evidenceHtml}</div>`;
  }

  function renderPlaceholderCard(text) {
    return `
      <div class="oa-finance-rebuild-panel-card">
        <p class="oa-finance-rebuild-empty">${escapeHtml(text)}</p>
      </div>
    `;
  }

  function countRelatedDocuments(analysis) {
    const related = analysis?.relatedDocuments || {};
    let count = 0;
    count += Array.isArray(related.domesticPrItems) ? related.domesticPrItems.length : related.domesticPr ? 1 : 0;
    count += related.purchaseOrder ? 1 : 0;
    count += Array.isArray(related.acceptanceItems) ? related.acceptanceItems.length : related.acceptance ? 1 : 0;
    return count;
  }

  function getSectionSummary(sectionKey, analysis) {
    if (sectionKey === "overview") {
      if (state.isRunning) {
        return "分析进行中";
      }
      if (state.analysis) {
        return "主核对与诊断";
      }
      return PANEL_SECTIONS.overview.summaryWhenEmpty;
    }

    if (!analysis) {
      return PANEL_SECTIONS[sectionKey]?.summaryWhenEmpty || "";
    }

    if (sectionKey === "related") {
      const count = countRelatedDocuments(analysis);
      return count > 0 ? `${count} 项关联单据` : "暂无关联单据";
    }

    if (sectionKey === "contract") {
      return analysis.contractSummary ? "摘要与条款证据" : "暂无合同摘要";
    }

    if (sectionKey === "debug") {
      return "页面来源与证据池";
    }

    return "";
  }

  function renderOverviewSolo(analysis, verificationHtml) {
    return `
      <div class="oa-finance-rebuild-overview-solo">
        <div class="oa-finance-rebuild-overview-solo-main">
          ${renderProgressSection()}
          <section class="oa-finance-rebuild-section">
            <div class="oa-finance-rebuild-section-title">三项主核对</div>
            <div class="oa-finance-rebuild-results">
              ${verificationHtml || "<p class='oa-finance-rebuild-empty'>点击“开始采集”后，这里会显示金额、收款公司、收款账号三项主核对。</p>"}
            </div>
          </section>
          ${renderErrorSection()}
        </div>
        <div class="oa-finance-rebuild-overview-solo-side" role="complementary" aria-label="主核对辅助信息">
          ${renderOverviewSideSummary(analysis)}
        </div>
      </div>
    `;
  }

  function renderSectionContent(sectionKey, analysis, verificationHtml) {
    if (sectionKey === "overview") {
      if (isOverviewSolo()) {
        return renderOverviewSolo(analysis, verificationHtml);
      }
      return `
        ${renderProgressSection()}
        <section class="oa-finance-rebuild-section">
          <div class="oa-finance-rebuild-section-title">三项主核对</div>
          <div class="oa-finance-rebuild-results">
            ${verificationHtml || "<p class='oa-finance-rebuild-empty'>点击“开始采集”后，这里会显示金额、收款公司、收款账号三项主核对。</p>"}
          </div>
        </section>
        ${renderErrorSection()}
      `;
    }

    if (sectionKey === "related") {
      return analysis
        ? renderRelatedDocumentsSection(analysis) || renderPlaceholderCard("暂未提取到可展示的关联单据。")
        : renderPlaceholderCard("采集后会显示国内 PR、采购订单和验收单摘要。");
    }

    if (sectionKey === "contract") {
      if (!analysis) {
        return renderPlaceholderCard("采集后会显示合同摘要、条款证据与来源链接。");
      }
      return renderContractSummarySection(analysis) || renderPlaceholderCard("暂未提取到可展示的合同摘要或条款证据。");
    }

    if (sectionKey === "debug") {
      if (!analysis) {
        return renderPlaceholderCard("采集后会显示页面来源与证据池。");
      }
      return renderDebugSection(analysis) || renderPlaceholderCard("暂无可展示的调试信息。");
    }

    return "";
  }

  function renderRailButton(sectionKey, analysis) {
    const section = PANEL_SECTIONS[sectionKey];
    const isOpen = isSectionOpen(sectionKey);
    const summary = getSectionSummary(sectionKey, analysis);
    return `
        <button
          class="oa-finance-rebuild-rail-btn ${isOpen ? "is-open" : ""}"
          type="button"
          data-section-toggle="${escapeHtml(sectionKey)}"
        aria-pressed="${isOpen ? "true" : "false"}"
        title="${escapeHtml(`${section.label}：${summary}`)}"
      >
        <span class="oa-finance-rebuild-rail-btn-label">${escapeHtml(section.label)}</span>
      </button>
    `;
  }

  function renderCollapseAllButton(openCount, extraClass = "") {
    const className = ["oa-finance-rebuild-collapse-all", extraClass].filter(Boolean).join(" ");
    return `
      <button
        class="${className}"
        type="button"
        ${openCount === 0 ? "disabled" : ""}
      >
        全部收起
      </button>
    `;
  }

  function renderPanelSection(sectionKey, analysis, verificationHtml) {
    const section = PANEL_SECTIONS[sectionKey];
    const isOpen = isSectionOpen(sectionKey);
    const overviewSolo = isOverviewSolo();
    const bodyId = `oa-finance-rebuild-section-${sectionKey}`;
    const summary = getSectionSummary(sectionKey, analysis);
    const soloClass =
      overviewSolo && sectionKey !== "overview" ? "is-overview-solo-secondary" : overviewSolo ? "is-overview-solo-primary" : "";
    return `
      <section class="oa-finance-rebuild-panel-section ${isOpen ? "" : "is-collapsed"} ${soloClass}" data-panel-section="${escapeHtml(sectionKey)}">
        <button
          class="oa-finance-rebuild-panel-section-toggle"
          type="button"
          data-section-toggle="${escapeHtml(sectionKey)}"
          aria-expanded="${isOpen ? "true" : "false"}"
          aria-controls="${escapeHtml(bodyId)}"
        >
          <span class="oa-finance-rebuild-panel-section-copy">
            <span class="oa-finance-rebuild-section-title">${escapeHtml(section.label)}</span>
          </span>
          <span class="oa-finance-rebuild-panel-section-summary">${escapeHtml(summary)}</span>
          <span class="oa-finance-rebuild-progress-arrow ${isOpen ? "is-open" : ""}">▾</span>
        </button>
        ${
          isOpen
            ? `<div class="oa-finance-rebuild-panel-section-body" id="${escapeHtml(bodyId)}">
                ${renderSectionContent(sectionKey, analysis, verificationHtml)}
              </div>`
            : ""
        }
      </section>
    `;
  }

  function openSourceFromElement(element) {
    const sourceUrl = element.getAttribute("data-source-url");
    if (sourceUrl) {
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
    }
  }

  function handleRootClick(event) {
    const eventEl = resolveEventElement(event.target);
    if (!eventEl || !root.contains(eventEl)) {
      return;
    }

    const runButton = eventEl.closest(".oa-finance-rebuild-run");
    if (runButton) {
      runAnalysisNow();
      return;
    }

    const collapseAllButton = eventEl.closest(".oa-finance-rebuild-collapse-all");
    if (collapseAllButton) {
      collapseAllSections();
      return;
    }

    const progressToggle = eventEl.closest(".oa-finance-rebuild-progress-toggle");
    if (progressToggle) {
      if (!state.isRunning) {
        state.progressCollapsed = !state.progressCollapsed;
        render();
      }
      return;
    }

    const sectionToggle = eventEl.closest("[data-section-toggle]");
    if (sectionToggle) {
      toggleSection(sectionToggle.getAttribute("data-section-toggle") || "");
      return;
    }

    const sourceEl = eventEl.closest(".oa-finance-rebuild-result[data-source-url], .oa-finance-rebuild-clause[data-source-url]");
    if (sourceEl && !eventEl.closest("a, button, summary")) {
      openSourceFromElement(sourceEl);
    }
  }

  function handleRootKeydown(event) {
    const eventEl = resolveEventElement(event.target);
    if (!eventEl || !root.contains(eventEl)) {
      return;
    }

    if (event.key === "Escape") {
      collapseAllSections();
      return;
    }

    const sourceEl = eventEl.closest(".oa-finance-rebuild-result[data-source-url], .oa-finance-rebuild-clause[data-source-url]");
    if (!sourceEl || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    if (eventEl.closest("a, button, summary")) {
      return;
    }
    event.preventDefault();
    openSourceFromElement(sourceEl);
  }

  function handleRootPointerDown(event) {
    const eventEl = resolveEventElement(event.target);
    if (!eventEl || !root.contains(eventEl)) {
      return;
    }

    const resizeHandleY = eventEl.closest(".oa-finance-rebuild-resize-handle-y");
    if (resizeHandleY) {
      startPanelResizeY(event, resizeHandleY);
      return;
    }

    const resizeHandle = eventEl.closest(".oa-finance-rebuild-resize-handle");
    if (resizeHandle) {
      startPanelResize(event, resizeHandle);
      return;
    }

    const dragHandle = eventEl.closest(".oa-finance-rebuild-drag-handle");
    if (dragHandle) {
      startPanelDrag(event, dragHandle);
    }
  }

  function handleViewportResize() {
    const previousWidth = state.panelWidth;
    const previousTop = state.panelTop;
    const previousRight = state.panelRight;
    const previousHeight = state.panelHeight;
    clampPanelUiState();
    applyPanelLayout();
    if (
      previousWidth !== state.panelWidth ||
      previousTop !== state.panelTop ||
      previousRight !== state.panelRight ||
      previousHeight !== state.panelHeight
    ) {
      scheduleUiStatePersist();
    }
  }

  function bindRootEvents() {
    if (runtime.rootEventsBound) {
      return;
    }
    root.addEventListener("click", handleRootClick);
    root.addEventListener("keydown", handleRootKeydown);
    root.addEventListener("pointerdown", handleRootPointerDown);
    window.addEventListener("resize", handleViewportResize);
    runtime.rootEventsBound = true;
  }

  function render() {
    const analysis = state.analysis;
    const verificationHtml = (analysis?.verificationItems || []).map((item) => renderVerificationItem(item)).join("");
    const openCount = state.openSections.size;
    const railButtonsHtml = PANEL_SECTION_ORDER.map((sectionKey) => renderRailButton(sectionKey, analysis)).join("");
    const railCollapseButtonHtml = renderCollapseAllButton(openCount, "oa-finance-rebuild-rail-collapse");

    if (isRailOnly()) {
      root.innerHTML = `
        <div class="oa-finance-rebuild-workspace oa-finance-rebuild-workspace-compact">
          <div class="oa-finance-rebuild-rail-dock">
            <button class="oa-finance-rebuild-rail-dock-grip oa-finance-rebuild-drag-handle" type="button" title="拖动面板位置" aria-label="拖动面板位置">
              <span class="oa-finance-rebuild-drag-pill" aria-hidden="true"></span>
            </button>
            <div class="oa-finance-rebuild-compact-nav" aria-label="详情区块快捷入口">
              ${railButtonsHtml}
            </div>
          </div>
        </div>
      `;

      applyPanelLayout();
      return;
    }

    root.innerHTML = `
      <div class="oa-finance-rebuild-workspace">
        <div class="oa-finance-rebuild-workbench">
          <div class="oa-finance-rebuild-resize-handle" aria-hidden="true"></div>
          <div class="oa-finance-rebuild-resize-handle-y" aria-hidden="true"></div>
          <div class="oa-finance-rebuild-rail" aria-label="详情区块快捷入口">
            <div class="oa-finance-rebuild-rail-nav">
              ${railButtonsHtml}
            </div>
            ${railCollapseButtonHtml}
          </div>
          <div class="oa-finance-rebuild-panel-shell" aria-hidden="${isRailOnly() ? "true" : "false"}">
            <div class="oa-finance-rebuild-card">
              <button class="oa-finance-rebuild-top-drag-handle oa-finance-rebuild-drag-handle" type="button" title="拖动面板位置" aria-label="拖动面板位置">
                <span class="oa-finance-rebuild-drag-pill" aria-hidden="true"></span>
              </button>
              <div class="oa-finance-rebuild-head">
                <div class="oa-finance-rebuild-head-main">
                  <div class="oa-finance-rebuild-head-copy">
                    <h1>OA 付款审核</h1>
                  </div>
                </div>
                <div class="oa-finance-rebuild-head-side">
                  <button class="oa-finance-rebuild-run" type="button" ${state.isRunning ? "disabled" : ""}>
                    ${state.isRunning ? "分析中..." : "开始采集"}
                  </button>
                  <div class="oa-finance-rebuild-badge">${escapeHtml(state.statusText)}</div>
                </div>
              </div>
              <div class="oa-finance-rebuild-body">
                ${PANEL_SECTION_ORDER.map((sectionKey) => renderPanelSection(sectionKey, analysis, verificationHtml)).join("")}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    applyPanelLayout();
  }

  function runAnalysisNow() {
    const snapshot = collector.collectPageSnapshot();
    const requestId = createRequestId(extractProcessCodeFromUrl() || "detail");
    state.isRunning = true;
    state.activeRequestId = requestId;
    state.analysis = null;
    state.errorText = "";
    state.statusText = "准备开始";
    state.progressItems = [];
    state.progressCollapsed = false;
    delete root.dataset.analysisJson;
    rememberProgress({ text: "准备开始", detail: "正在采集当前页面基础信息" });
    render();

    chrome.runtime.sendMessage({ type: "oa-finance-rebuild-analyze-page", snapshot, requestId }, (response) => {
      if (state.activeRequestId !== requestId) {
        return;
      }
      state.isRunning = false;
      state.activeRequestId = "";

      if (!chrome.runtime.lastError && response?.ok && response.result) {
        rememberProgress({ text: "分析完成", detail: "已生成主核对、关联摘要和合同参考信息" });
        applyAnalysisResult(response.result, "已分析");
        return;
      }

      state.analysis = evidence.createPhaseOneAnalysis(snapshot, state.buildTag);
      state.statusText = "已采集";
      state.errorText =
        chrome.runtime.lastError?.message ||
        response?.error ||
        "后台分析失败，当前仅展示页面采集结果。";
      rememberProgress({ text: "分析失败", detail: state.errorText });
      state.progressCollapsed = true;
      root.dataset.analysisJson = JSON.stringify(state.analysis);
      render();
    });
  }

  bindRootEvents();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "oa-finance-rebuild-progress") {
      return;
    }
    const requestId = cleanText(message.payload?.requestId || "");
    if (!state.activeRequestId || requestId !== state.activeRequestId) {
      return;
    }
    state.isRunning = true;
    state.progressCollapsed = false;
    state.statusText = message.payload?.text || "分析中...";
    rememberProgress(message.payload || {});
    render();
  });

  chrome.runtime.sendMessage({ type: "oa-finance-rebuild-ping" }, (response) => {
    if (!chrome.runtime.lastError && response?.ok) {
      state.buildTag = response.buildTag || "";
      state.statusText = response.message || "已加载";
    }
    render();
  });
  render();
  loadUiState();
  setTimeout(() => {
    void tryLoadCachedAnalysis();
  }, 0);
})();
