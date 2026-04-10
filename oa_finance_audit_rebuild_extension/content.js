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
    "待提取",
    "待核对",
    "待进入合同页读取",
    "暂无",
    "无",
    "未知"
  ]);

  const state = {
    buildTag: "",
    statusText: "待采集",
    analysis: null,
    errorText: "",
    isRunning: false,
    progressItems: [],
    progressCollapsed: false,
    debugCollapsed: true,
    llmPreviewCollapsed: true
  };

  const root = document.createElement("aside");
  root.id = "oa-finance-rebuild-root";
  document.body.appendChild(root);

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
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

  function summarizeDisplayText(value, maxLength = 140) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function usefulSourceName(value) {
    const text = String(value || "").trim();
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

  function getRelatedCardTitle(title, doc) {
    return doc?.itemLabel || title;
  }

  function buildRelatedHoverLines(doc) {
    if (!doc) {
      return [];
    }

    if (doc.kind === "domestic_pr") {
      const lines = [];
      if (hasMeaningfulText(doc.fields?.requirementSummary)) {
        lines.push(`需求描述：${doc.fields.requirementSummary}`);
      }
      if (hasMeaningfulText(doc.fields?.processCode)) {
        lines.push(`PR单号：${doc.fields.processCode}`);
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
    const rows = [];

    pushKvRow(rows, "合同来源", sourceName);
    pushKvRow(rows, "付款方式", summary.paymentMode);
    pushKvRow(rows, "付款条款摘要", summary.paymentTermsSummary || contractRef.paymentTerms);
    pushKvRow(rows, "验收条件", summary.acceptanceRequirement);
    pushKvRow(rows, "发票条件", summary.invoiceRequirement);
    pushKvRow(rows, "税率", summary.taxRate);
    pushKvRow(rows, "付款时限", summary.paymentDeadline);
    pushKvRow(rows, "分期安排", summary.installments);
    pushKvRow(rows, "金额上限", summary.capAmount);
    pushKvRow(rows, "账户变更要求", summary.accountChangeRequirement);
    pushKvRow(rows, "错误信息", summary.errorText);

    if (!rows.length && !sourceUrl) {
      return "";
    }

    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">合同摘要</div>
        ${rows.join("")}
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
      if (hasMeaningfulText(doc.fields?.requirementSummary)) {
        pushKvRow(rows, "需求描述", summarizeDisplayText(doc.fields?.requirementSummary, 180));
      } else {
        pushKvRow(rows, "需求描述", "已进入国内PR页，但暂未提取到品牌、型号、规格、配置、技术要求或说明");
      }
      pushKvRow(rows, "PR单号", usefulSourceName(doc.fields?.processCode));
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
      if (Array.isArray(doc.attachmentNames) && doc.attachmentNames.length > 0) {
        pushKvRow(rows, "附件", summarizeDisplayText(doc.attachmentNames.join("、"), 180));
      } else {
        pushKvRow(rows, "附件", "已进入验收页，但暂未提取到附件");
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
        ${rows.join("") || "<p class='oa-finance-rebuild-empty'>暂无可展示信息</p>"}
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
    return `
      <section class="oa-finance-rebuild-section">
        <div class="oa-finance-rebuild-section-title">页面采集结果</div>
        <div class="oa-finance-rebuild-grid">
          <div class="oa-finance-rebuild-mini">
            <span>附件</span>
            <strong>${summary.attachmentCount || 0}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>发票附件</span>
            <strong>${summary.invoiceAttachmentCount || 0}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>国内PR链接</span>
            <strong>${summary.domesticPrLinkCount || 0}</strong>
          </div>
        </div>
        <div class="oa-finance-rebuild-grid">
          <div class="oa-finance-rebuild-mini">
            <span>采购订单链接</span>
            <strong>${summary.purchaseOrderLinkCount || 0}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>合同来源</span>
            <strong>${(summary.contractAttachmentCount || 0) + (summary.contractLinkCount || 0)}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>账号附件</span>
            <strong>${summary.bankChangeAttachmentCount || 0}</strong>
          </div>
        </div>
        <div class="oa-finance-rebuild-grid">
          <div class="oa-finance-rebuild-mini">
            <span>验收来源</span>
            <strong>${(summary.acceptanceAttachmentCount || 0) + (summary.acceptanceLinkCount || 0)}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>其他链接</span>
            <strong>${summary.otherLinkCount || 0}</strong>
          </div>
          <div class="oa-finance-rebuild-mini">
            <span>结构化发票</span>
            <strong>${summary.invoiceStructuredCount || 0}</strong>
          </div>
        </div>
        <div class="oa-finance-rebuild-target">
          <div><span>付款单号</span><strong>${escapeHtml(target.processCode || "未识别")}</strong></div>
          <div><span>付款金额</span><strong>${escapeHtml(models.formatAmount(target.paymentAmount) || "未识别")}</strong></div>
          <div><span>收款公司</span><strong>${escapeHtml(target.payeeCompany || "未识别")}</strong></div>
          <div><span>收款账号</span><strong>${escapeHtml(target.payeeAccount || "未识别")}</strong></div>
        </div>
      </section>
    `;
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

    return `
      <section class="oa-finance-rebuild-section">
        <button class="oa-finance-rebuild-progress-toggle oa-finance-rebuild-debug-toggle" type="button" aria-expanded="${state.debugCollapsed ? "false" : "true"}">
          <span class="oa-finance-rebuild-section-title">调试信息</span>
          <span class="oa-finance-rebuild-progress-summary">${state.debugCollapsed ? "默认收起" : "已展开"}</span>
          <span class="oa-finance-rebuild-progress-arrow ${state.debugCollapsed ? "" : "is-open"}">▾</span>
        </button>
        ${state.debugCollapsed ? "" : `<div class="oa-finance-rebuild-debug-body">${evidenceHtml}${pageSummaryHtml}</div>`}
      </section>
    `;
  }

  function openSourceFromElement(element) {
    const sourceUrl = element.getAttribute("data-source-url");
    if (sourceUrl) {
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
    }
  }

  function bindInteractions() {
    root.querySelector(".oa-finance-rebuild-run")?.addEventListener("click", handleRun);

    root.querySelector(".oa-finance-rebuild-main-progress-toggle")?.addEventListener("click", () => {
      if (state.isRunning) {
        return;
      }
      state.progressCollapsed = !state.progressCollapsed;
      render();
    });

    root.querySelector(".oa-finance-rebuild-debug-toggle")?.addEventListener("click", () => {
      state.debugCollapsed = !state.debugCollapsed;
      render();
    });

    root.querySelector(".oa-finance-rebuild-llm-toggle")?.addEventListener("click", () => {
      state.llmPreviewCollapsed = !state.llmPreviewCollapsed;
      render();
    });

    root.querySelectorAll(".oa-finance-rebuild-result[data-source-url], .oa-finance-rebuild-clause[data-source-url]").forEach((element) => {
      element.addEventListener("click", () => openSourceFromElement(element));
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        openSourceFromElement(element);
      });
    });
  }

  function render() {
    const analysis = state.analysis;
    const verificationHtml = (analysis?.verificationItems || []).map((item) => renderVerificationItem(item)).join("");

    root.innerHTML = `
      <div class="oa-finance-rebuild-card">
        <div class="oa-finance-rebuild-head">
          <div>
            <div class="oa-finance-rebuild-eyebrow">OA 付款审核</div>
            <h1>重构版</h1>
          </div>
          <div class="oa-finance-rebuild-badge">${escapeHtml(state.statusText)}</div>
        </div>
        <div class="oa-finance-rebuild-toolbar">
          <button class="oa-finance-rebuild-run" type="button" ${state.isRunning ? "disabled" : ""}>
            ${state.isRunning ? "分析中..." : "开始采集"}
          </button>
          <span class="oa-finance-rebuild-build">${escapeHtml(state.buildTag || "未连接")}</span>
        </div>
        <div class="oa-finance-rebuild-body">
          ${renderProgressSection()}
          <section class="oa-finance-rebuild-section">
            <div class="oa-finance-rebuild-section-title">三项主核对</div>
            <div class="oa-finance-rebuild-results">
              ${verificationHtml || "<p class='oa-finance-rebuild-empty'>点击“开始采集”后，这里会显示金额、收款公司、收款账号三项主核对。</p>"}
            </div>
          </section>
          ${analysis ? renderRelatedDocumentsSection(analysis) : ""}
          ${renderErrorSection()}
          ${analysis ? renderContractSummarySection(analysis) : ""}
          ${analysis ? renderContractStatusSection(analysis) : ""}
          ${analysis ? renderDebugSection(analysis) : ""}
        </div>
      </div>
    `;

    bindInteractions();
  }

  function handleRun() {
    const snapshot = collector.collectPageSnapshot();
    state.isRunning = true;
    state.analysis = null;
    state.errorText = "";
    state.statusText = "准备开始";
    state.progressItems = [];
    state.progressCollapsed = false;
    state.debugCollapsed = true;
    state.llmPreviewCollapsed = true;
    rememberProgress({ text: "准备开始", detail: "正在采集当前页面基础信息" });
    render();

    chrome.runtime.sendMessage({ type: "oa-finance-rebuild-analyze-page", snapshot }, (response) => {
      state.isRunning = false;

      if (!chrome.runtime.lastError && response?.ok && response.result) {
        state.analysis = response.result;
        state.statusText = "已分析";
        state.errorText = "";
        rememberProgress({ text: "分析完成", detail: "已生成三项主核对、关联单据和合同参考信息" });
      } else {
        state.analysis = evidence.createPhaseOneAnalysis(snapshot, state.buildTag);
        state.statusText = "已采集";
        state.errorText =
          chrome.runtime.lastError?.message ||
          response?.error ||
          "后台分析失败，当前仅展示页面采集结果。";
        rememberProgress({ text: "分析失败", detail: state.errorText });
      }

      state.progressCollapsed = true;
      state.llmPreviewCollapsed = true;
      root.dataset.analysisJson = JSON.stringify(state.analysis);
      render();
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "oa-finance-rebuild-progress") {
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
})();
