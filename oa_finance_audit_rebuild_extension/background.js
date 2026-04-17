import { BUILD_TAG, analyzePageSnapshot } from "./bg/analyzer.js";
import {
  buildFlowableInvoiceEvidenceList,
  fetchFlowableDetail,
  parseProcessRef,
  resolveProcessCodeRef
} from "./bg/detail.js";

const PROGRESS_MESSAGE_TYPE = "oa-finance-rebuild-progress";
const CACHE_KEY_PREFIX = "oa-finance-rebuild-cache:";
const CACHE_SCHEMA_VERSION = "detail-cache-multi-invoice-2026-04-17";
const DETAIL_CONTENT_SCRIPT_FILES = ["shared/models.js", "shared/evidence.js", "page/collector.js", "content.js"];
const RECENT_ANALYZE_RESPONSE_TTL_MS = 120000;
const activeAnalyzeRequests = new Map();
const recentAnalyzeResponses = new Map();

function cleanText(value) {
  return String(value || "").trim();
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

function normalizeProcessCode(value) {
  return cleanText(value).toUpperCase();
}

function extractInvoiceNoFromSourceName(sourceName) {
  const matched = cleanText(sourceName).match(/付款页发票明细[:：]\s*([A-Za-z0-9]+)/i);
  return matched?.[1] ? matched[1].trim() : "";
}

function normalizeComparableUrl(url) {
  const text = cleanText(url);
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return text.replace(/[?#].*$/, "");
  }
}

function shouldRefreshInvoiceSource(sourceName, sourceUrl) {
  const normalizedName = cleanText(sourceName);
  const normalizedUrl = cleanText(sourceUrl);
  return /付款页发票明细/.test(normalizedName) || /invoice-cyou-com-1251125656\.cos\.ap-beijing\.myqcloud\.com/i.test(normalizedUrl);
}

function pickFreshInvoiceSource(items, sourceName, sourceUrl) {
  const candidates = Array.isArray(items) ? items.filter((item) => cleanText(item?.sourceUrl)) : [];
  if (candidates.length === 0) {
    return "";
  }

  const invoiceNo = extractInvoiceNoFromSourceName(sourceName);
  if (invoiceNo) {
    const matchedByNo = candidates.find((item) => cleanText(item?.invoiceNo) === invoiceNo);
    if (matchedByNo?.sourceUrl) {
      return matchedByNo.sourceUrl;
    }
  }

  const comparableSourceUrl = normalizeComparableUrl(sourceUrl);
  if (comparableSourceUrl) {
    const matchedByUrl = candidates.find((item) => normalizeComparableUrl(item?.sourceUrl) === comparableSourceUrl);
    if (matchedByUrl?.sourceUrl) {
      return matchedByUrl.sourceUrl;
    }
  }

  if (candidates.length === 1) {
    return candidates[0].sourceUrl || "";
  }

  return "";
}

async function resolveFreshSourceUrl({ pageUrl = "", processCode = "", sourceName = "", sourceUrl = "" } = {}) {
  const normalizedSourceUrl = cleanText(sourceUrl);
  if (!shouldRefreshInvoiceSource(sourceName, normalizedSourceUrl)) {
    return normalizedSourceUrl;
  }

  const normalizedPageUrl = cleanText(pageUrl);
  const normalizedProcessCode = cleanText(processCode).toUpperCase();
  let ref = normalizedPageUrl ? parseProcessRef(normalizedPageUrl, "payment") : null;
  const baseUrl = (() => {
    if (normalizedPageUrl) {
      try {
        return new URL(normalizedPageUrl).origin;
      } catch (_error) {
        return "http://oa.cyou-inc.com";
      }
    }
    return "http://oa.cyou-inc.com";
  })();

  if ((!ref || !ref.detailId) && normalizedProcessCode) {
    ref = await resolveProcessCodeRef(normalizedProcessCode, "payment", baseUrl).catch(() => null);
  }
  if (!ref || ref.mode !== "flowable" || !ref.detailId) {
    return normalizedSourceUrl;
  }

  const detail = await fetchFlowableDetail(ref, baseUrl);
  const invoiceItems = await buildFlowableInvoiceEvidenceList(detail, baseUrl);
  return pickFreshInvoiceSource(invoiceItems, sourceName, normalizedSourceUrl) || normalizedSourceUrl;
}

function currentDayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDetailPageUrl(url) {
  return /https?:\/\/oa\.cyou-inc\.com\/workflow\/process\/detail\/\d+/i.test(cleanText(url));
}

async function ensureDetailContentScripts(tabId, frameId = 0, pageUrl = "") {
  if (!Number.isInteger(tabId) || !isDetailPageUrl(pageUrl)) {
    return false;
  }
  await chrome.scripting.executeScript({
    target: {
      tabId,
      frameIds: [frameId]
    },
    files: DETAIL_CONTENT_SCRIPT_FILES
  });
  return true;
}

function sendProgressToTab(tabId, payload) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  try {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: PROGRESS_MESSAGE_TYPE,
        payload
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // Ignore progress push failures when the content script is not ready.
  }
}

function buildCacheKey(processCode) {
  return `${CACHE_KEY_PREFIX}${normalizeProcessCode(processCode)}`;
}

function pickProcessCode(result, fallback = {}) {
  return normalizeProcessCode(result?.paymentTarget?.processCode || fallback?.processCode || "");
}

function isFreshCacheEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (entry.buildTag && entry.buildTag !== BUILD_TAG) {
    return false;
  }
  if (entry.cacheSchema !== CACHE_SCHEMA_VERSION) {
    return false;
  }
  const cachedAt = Number.parseInt(entry.cachedAt || "0", 10);
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) {
    return false;
  }
  return cleanText(entry.cachedDay) === currentDayKey();
}

async function storeAnalysisCache(result, meta = {}) {
  const processCode = pickProcessCode(result, meta.paymentTarget);
  if (!processCode) {
    return;
  }
  const entry = {
    processCode,
    detailUrl: cleanText(meta.detailUrl || meta.pageUrl || ""),
    buildTag: BUILD_TAG,
    cacheSchema: CACHE_SCHEMA_VERSION,
    cachedDay: currentDayKey(),
    cachedAt: Date.now(),
    result
  };
  await chrome.storage.local.set({ [buildCacheKey(processCode)]: entry });
}

async function getAnalysisCache(processCode) {
  const normalized = normalizeProcessCode(processCode);
  if (!normalized) {
    return null;
  }
  const key = buildCacheKey(normalized);
  const payload = await chrome.storage.local.get(key);
  const entry = payload?.[key] || null;
  if (!entry) {
    return null;
  }
  if (!isFreshCacheEntry(entry)) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

async function getAnalysisCaches(processCodes) {
  const normalizedCodes = Array.from(new Set((processCodes || []).map((item) => normalizeProcessCode(item)).filter(Boolean)));
  const entries = [];
  for (const processCode of normalizedCodes) {
    const entry = await getAnalysisCache(processCode);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function normalizeAnalyzeUrlProgress(payload) {
  if (payload?.phase !== "payment-root") {
    return payload;
  }
  return {
    ...payload,
    text: "正在读取",
    detail: "正在通过 OA 接口读取付款单详情"
  };
}

function buildAnalyzeRequestKey(input) {
  const requestId = cleanText(input?.requestId);
  return requestId ? `analyze:${requestId}` : "";
}

function sendAnalyzeResponse(job, payload) {
  const responses = Array.isArray(job?.responses) ? job.responses.splice(0) : [];
  for (const respond of responses) {
    try {
      respond(payload);
    } catch (_error) {
      // The sender may have navigated away or Chrome may have closed the old
      // message channel; later retry waiters for the same requestId can still
      // receive the shared result.
    }
  }
}

function rememberAnalyzeResponse(requestKey, payload) {
  if (!requestKey) {
    return;
  }
  const entry = { payload, expiresAt: Date.now() + RECENT_ANALYZE_RESPONSE_TTL_MS };
  recentAnalyzeResponses.set(requestKey, entry);
  setTimeout(() => {
    if (recentAnalyzeResponses.get(requestKey) === entry) {
      recentAnalyzeResponses.delete(requestKey);
    }
  }, RECENT_ANALYZE_RESPONSE_TTL_MS);
}

function getRecentAnalyzeResponse(requestKey) {
  const entry = requestKey ? recentAnalyzeResponses.get(requestKey) : null;
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    recentAnalyzeResponses.delete(requestKey);
    return null;
  }
  return entry.payload || null;
}

function handleAnalyzeRequest(input, sender, sendResponse) {
  const tabId = sender?.tab?.id ?? null;
  const requestId = cleanText(input.requestId);
  const pushProgress = (payload) =>
    sendProgressToTab(tabId, requestId ? { ...payload, requestId } : payload);
  const requestKey = buildAnalyzeRequestKey(input);
  const recentResponse = getRecentAnalyzeResponse(requestKey);
  if (recentResponse) {
    sendResponse(recentResponse);
    return false;
  }
  if (requestKey && activeAnalyzeRequests.has(requestKey)) {
    activeAnalyzeRequests.get(requestKey).responses.push(sendResponse);
    return true;
  }

  const job = { responses: [sendResponse] };
  if (requestKey) {
    activeAnalyzeRequests.set(requestKey, job);
  }
  analyzePageSnapshot(input.snapshot, tabId, (payload) => pushProgress(input.normalizeProgress ? input.normalizeProgress(payload) : payload))
    .then(async (result) => {
      await storeAnalysisCache(result, {
        pageUrl: input.snapshot?.pageUrl || "",
        detailUrl: input.snapshot?.pageUrl || input.snapshot?.detailUrl || "",
        paymentTarget: input.snapshot?.paymentTarget || {}
      });
      const payload = { ok: true, result };
      rememberAnalyzeResponse(requestKey, payload);
      sendAnalyzeResponse(job, payload);
    })
    .catch((error) => {
      const payload = { ok: false, error: translateTechnicalErrorMessage(error?.message || String(error)) };
      rememberAnalyzeResponse(requestKey, payload);
      sendAnalyzeResponse(job, payload);
    })
    .finally(() => {
      if (requestKey && activeAnalyzeRequests.get(requestKey) === job) {
        activeAnalyzeRequests.delete(requestKey);
      }
    });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "oa-finance-rebuild-ping") {
    sendResponse({
      ok: true,
      buildTag: BUILD_TAG,
      status: "ready",
      message: "插件已加载"
    });
    return false;
  }

  if (message?.type === "oa-finance-rebuild-analyze-page") {
    return handleAnalyzeRequest(
      {
        requestId: message.requestId || "",
        snapshot: message.snapshot || {}
      },
      sender,
      sendResponse
    );
  }

  if (message?.type === "oa-finance-rebuild-ensure-detail-content") {
    ensureDetailContentScripts(sender?.tab?.id, sender?.frameId || 0, message.url || sender?.tab?.url || "")
      .then((injected) => sendResponse({ ok: true, injected: !!injected }))
      .catch((error) => sendResponse({ ok: false, error: translateTechnicalErrorMessage(error?.message || String(error)) }));
    return true;
  }

  if (message?.type === "oa-finance-rebuild-analyze-url") {
    return handleAnalyzeRequest(
      {
        requestId: message.requestId || "",
        normalizeProgress: normalizeAnalyzeUrlProgress,
        snapshot: {
          pageUrl: message.url || "",
          paymentTarget: message.paymentTarget || {}
        }
      },
      sender,
      sendResponse
    );
  }

  if (message?.type === "oa-finance-rebuild-get-cache") {
    getAnalysisCache(message.processCode || "")
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((error) => sendResponse({ ok: false, error: translateTechnicalErrorMessage(error?.message || String(error)) }));
    return true;
  }

  if (message?.type === "oa-finance-rebuild-get-cache-bulk") {
    getAnalysisCaches(Array.isArray(message.processCodes) ? message.processCodes : [])
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({ ok: false, error: translateTechnicalErrorMessage(error?.message || String(error)) }));
    return true;
  }

  if (message?.type === "oa-finance-rebuild-resolve-source-url") {
    resolveFreshSourceUrl({
      pageUrl: message.pageUrl || sender?.tab?.url || "",
      processCode: message.processCode || "",
      sourceName: message.sourceName || "",
      sourceUrl: message.sourceUrl || ""
    })
      .then((sourceUrl) => sendResponse({ ok: true, sourceUrl }))
      .catch((error) => sendResponse({ ok: false, error: translateTechnicalErrorMessage(error?.message || String(error)) }));
    return true;
  }

  return undefined;
});
