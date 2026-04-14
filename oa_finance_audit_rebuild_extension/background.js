import { BUILD_TAG, analyzePageSnapshot } from "./bg/analyzer.js";

const PROGRESS_MESSAGE_TYPE = "oa-finance-rebuild-progress";
const CACHE_KEY_PREFIX = "oa-finance-rebuild-cache:";

function cleanText(value) {
  return String(value || "").trim();
}

function currentDayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  return `${CACHE_KEY_PREFIX}${processCode}`;
}

function pickProcessCode(result, fallback = {}) {
  return cleanText(result?.paymentTarget?.processCode || fallback?.processCode || "");
}

function isFreshCacheEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (entry.buildTag && entry.buildTag !== BUILD_TAG) {
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
    cachedDay: currentDayKey(),
    cachedAt: Date.now(),
    result
  };
  await chrome.storage.local.set({ [buildCacheKey(processCode)]: entry });
}

async function getAnalysisCache(processCode) {
  const normalized = cleanText(processCode);
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
  const normalizedCodes = Array.from(new Set((processCodes || []).map((item) => cleanText(item)).filter(Boolean)));
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

function handleAnalyzeRequest(input, sender, sendResponse) {
  const tabId = sender?.tab?.id ?? null;
  const requestId = cleanText(input.requestId);
  const pushProgress = (payload) =>
    sendProgressToTab(tabId, requestId ? { ...payload, requestId } : payload);

  analyzePageSnapshot(input.snapshot, tabId, (payload) => pushProgress(input.normalizeProgress ? input.normalizeProgress(payload) : payload))
    .then(async (result) => {
      await storeAnalysisCache(result, {
        pageUrl: input.snapshot?.pageUrl || "",
        detailUrl: input.snapshot?.pageUrl || input.snapshot?.detailUrl || "",
        paymentTarget: input.snapshot?.paymentTarget || {}
      });
      sendResponse({ ok: true, result });
    })
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "oa-finance-rebuild-get-cache-bulk") {
    getAnalysisCaches(Array.isArray(message.processCodes) ? message.processCodes : [])
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return undefined;
});
