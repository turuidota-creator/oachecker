import { BUILD_TAG, analyzePageSnapshot } from "./bg/analyzer.js";

const PROGRESS_MESSAGE_TYPE = "oa-finance-rebuild-progress";

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "oa-finance-rebuild-ping") {
    sendResponse({
      ok: true,
      buildTag: BUILD_TAG,
      status: "ready",
      message: "重构版已加载"
    });
    return false;
  }

  if (message?.type === "oa-finance-rebuild-analyze-page") {
    const tabId = sender?.tab?.id ?? null;
    const pushProgress = (payload) => sendProgressToTab(tabId, payload);

    analyzePageSnapshot(message.snapshot || {}, tabId, pushProgress)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "oa-finance-rebuild-analyze-url") {
    const tabId = sender?.tab?.id ?? null;
    const requestId = String(message.requestId || "").trim();
    const pushProgress = (payload) =>
      sendProgressToTab(tabId, requestId ? { ...payload, requestId } : payload);

    analyzePageSnapshot(
      {
        pageUrl: message.url || "",
        paymentTarget: message.paymentTarget || {}
      },
      tabId,
      (payload) => {
        if (payload?.phase === "payment-root") {
          pushProgress({
            ...payload,
            text: "正在读取",
            detail: "正在通过 OA 接口读取付款单详情"
          });
          return;
        }
        pushProgress(payload);
      }
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return undefined;
});
