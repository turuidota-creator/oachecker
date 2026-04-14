import { BASE_URL, cleanText } from "./common.js";

let currentBaseUrl = BASE_URL;
let currentPageTabId = null;

export function setRuntimeContext(baseUrl, tabId) {
  currentBaseUrl = baseUrl || BASE_URL;
  currentPageTabId = Number.isInteger(tabId) ? tabId : null;
}

export function getCurrentPageTabId() {
  return currentPageTabId;
}

export function normalizeUrlForIo(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, currentBaseUrl || BASE_URL).toString();
}

export function isSameOaOrigin(url) {
  try {
    return new URL(url).origin === new URL(currentBaseUrl || BASE_URL).origin;
  } catch (_error) {
    return false;
  }
}

export async function fetchJson(url) {
  const textResponse = currentPageTabId
    ? await pageFetch(currentPageTabId, { url, responseType: "text" })
    : await directFetchText(url);
  if (!textResponse.ok) {
    throw new Error(`请求失败: ${textResponse.status} ${textResponse.statusText}`.trim());
  }
  if (!/json/i.test(textResponse.contentType || "")) {
    const text = textResponse.text || "";
    if (/oauth|login|登录/i.test(text)) throw new Error("请先在当前浏览器中登录 OA");
    throw new Error("OA 返回的不是 JSON");
  }
  return JSON.parse(textResponse.text || "{}");
}

export async function fetchBinary(url) {
  const attempts =
    currentPageTabId && isSameOaOrigin(url)
      ? [
          () => pageFetch(currentPageTabId, { url, responseType: "arrayBuffer" }),
          () => directFetchBinary(url)
        ]
      : [
          () => directFetchBinary(url),
          () => (currentPageTabId ? pageFetch(currentPageTabId, { url, responseType: "arrayBuffer" }) : null)
        ];

  let response = null;
  let lastError = null;
  for (const runAttempt of attempts) {
    if (typeof runAttempt !== "function") {
      continue;
    }
    try {
      const candidate = await runAttempt();
      if (isUsableBinaryResponse(candidate)) {
        response = candidate;
        break;
      }
      if (!response) {
        response = candidate;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!response && lastError) {
    throw lastError;
  }
  if (!response) {
    throw new Error("附件下载失败：未取得附件响应");
  }

  if (!response.ok) {
    throw new Error(`附件下载失败: ${response.status} ${response.statusText}`.trim());
  }
  if (/text\/html/i.test(response.contentType || "") && /oauth|login|登录/i.test(response.text || "")) {
    throw new Error("附件下载被登录态拦截");
  }
  if (!response.base64) {
    throw new Error("附件响应为空");
  }
  return { bytes: base64ToUint8Array(response.base64), contentType: response.contentType || "" };
}

function isUsableBinaryResponse(response) {
  if (!response || !response.ok) {
    return false;
  }
  if (/text\/html/i.test(response.contentType || "") && /oauth|login|登录/i.test(response.text || "")) {
    return false;
  }
  return !!response.base64;
}

export async function collectPageSnapshotFromUrl(url) {
  if (!url) {
    return null;
  }

  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) {
    throw new Error("无法打开合同页标签页");
  }

  try {
    await waitForTabLoad(tabId, 120000);
    await delay(1500);
    await executeScriptFile(tabId, "page/collector.js");
    let bestSnapshot = null;
    let bestScore = -1;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const snapshot = await executeScriptFunction(tabId, () => {
        return globalThis.OAFinanceRebuildCollector?.collectPageSnapshot?.() || null;
      });
      const score =
        (snapshot?.fieldPairs?.length || 0) +
        (snapshot?.subformRows?.length || 0) * 20 +
        (snapshot?.attachments?.length || 0) * 5 +
        (snapshot?.relatedLinks?.length || 0) * 2 +
        (snapshot?.paymentTarget?.processCode ? 10 : 0);

      if (score > bestScore) {
        bestSnapshot = snapshot;
        bestScore = score;
      }

      if ((snapshot?.subformRows?.length || 0) > 0 || (snapshot?.fieldPairs?.length || 0) >= 12) {
        return snapshot;
      }

      await delay(1000);
    }

    return bestSnapshot;
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Ignore tab cleanup errors.
    }
  }
}

async function directFetchText(url) {
  const headers = await getRuntimeAuthHeaders();
  const response = await fetch(url, { credentials: "include", cache: "no-store", headers });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") || "",
    text: await response.text()
  };
}

async function directFetchBinary(url) {
  const headers = await getRuntimeAuthHeaders();
  const response = await fetch(url, { credentials: "include", cache: "no-store", headers });
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType)) {
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      text: await response.text()
    };
  }
  const buffer = await response.arrayBuffer();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType,
    base64: uint8ArrayToBase64(new Uint8Array(buffer))
  };
}

async function getRuntimeAuthHeaders() {
  if (!Number.isInteger(currentPageTabId)) {
    return {};
  }
  try {
    const headers =
      (await executeScriptFunction(currentPageTabId, () => {
        const readCookie = (name) => {
          const entries = String(document.cookie || "")
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean);
          for (const entry of entries) {
            if (!entry.startsWith(`${name}=`)) continue;
            return decodeURIComponent(entry.slice(name.length + 1));
          }
          return "";
        };

        const walkValue = (value, results, depth = 0) => {
          if (depth > 3 || value == null) return;
          if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed) results.push(trimmed);
            if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 50000) {
              try {
                walkValue(JSON.parse(trimmed), results, depth + 1);
              } catch (_error) {}
            }
            return;
          }
          if (Array.isArray(value)) {
            value.slice(0, 30).forEach((item) => walkValue(item, results, depth + 1));
            return;
          }
          if (typeof value === "object") {
            Object.values(value)
              .slice(0, 50)
              .forEach((item) => walkValue(item, results, depth + 1));
          }
        };

        const findTokenInStorage = (storage) => {
          const directKeys = ["Admin-Token", "adminToken", "admin-token", "token", "access_token", "accessToken", "Authorization"];
          for (const key of directKeys) {
            const value = storage.getItem(key);
            if (value) return value.replace(/^Bearer\s+/i, "").trim();
          }
          const candidates = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            const raw = storage.getItem(key);
            if (!raw) continue;
            if (/token|auth|admin/i.test(key) || raw.length < 50000) candidates.push(raw);
          }
          const flattened = [];
          candidates.forEach((item) => walkValue(item, flattened));
          const tokenLike = flattened.find(
            (item) => /^Bearer\s+/i.test(item) || (/^[A-Za-z0-9._-]{16,}$/.test(item) && item.length >= 16)
          );
          return tokenLike ? tokenLike.replace(/^Bearer\s+/i, "").trim() : "";
        };

        const headers = {
          Accept: "application/json, text/plain, */*",
          "Content-Language": "zh_CN"
        };
        const adminToken =
          readCookie("Admin-Token") ||
          findTokenInStorage(window.localStorage) ||
          findTokenInStorage(window.sessionStorage);
        const oaAuthToken =
          readCookie("oauthtoken") ||
          window.localStorage.getItem("oauthtoken") ||
          window.sessionStorage.getItem("oauthtoken") ||
          "";
        if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
        if (oaAuthToken) headers.oauthtoken = oaAuthToken;
        return headers;
      })) || {};
    return headers && typeof headers === "object" ? headers : {};
  } catch {
    return {};
  }
}

function pageFetch(tabId, request) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        func: async (req) => {
          const readCookie = (name) => {
            const entries = String(document.cookie || "")
              .split(";")
              .map((item) => item.trim())
              .filter(Boolean);
            for (const entry of entries) {
              if (!entry.startsWith(`${name}=`)) continue;
              return decodeURIComponent(entry.slice(name.length + 1));
            }
            return "";
          };

          const walkValue = (value, results, depth = 0) => {
            if (depth > 3 || value == null) return;
            if (typeof value === "string") {
              const trimmed = value.trim();
              if (trimmed) results.push(trimmed);
              if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 50000) {
                try {
                  walkValue(JSON.parse(trimmed), results, depth + 1);
                } catch (_error) {}
              }
              return;
            }
            if (Array.isArray(value)) {
              value.slice(0, 30).forEach((item) => walkValue(item, results, depth + 1));
              return;
            }
            if (typeof value === "object") {
              Object.values(value).slice(0, 50).forEach((item) => walkValue(item, results, depth + 1));
            }
          };

          const findTokenInStorage = (storage) => {
            const directKeys = ["Admin-Token", "adminToken", "admin-token", "token", "access_token", "accessToken", "Authorization"];
            for (const key of directKeys) {
              const value = storage.getItem(key);
              if (value) return value.replace(/^Bearer\s+/i, "").trim();
            }
            const candidates = [];
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (!key) continue;
              const raw = storage.getItem(key);
              if (!raw) continue;
              if (/token|auth|admin/i.test(key) || raw.length < 50000) candidates.push(raw);
            }
            const flattened = [];
            candidates.forEach((item) => walkValue(item, flattened));
            const tokenLike = flattened.find(
              (item) => /^Bearer\s+/i.test(item) || (/^[A-Za-z0-9._-]{16,}$/.test(item) && item.length >= 16)
            );
            return tokenLike ? tokenLike.replace(/^Bearer\s+/i, "").trim() : "";
          };

          const headers = {
            Accept: "application/json, text/plain, */*",
            "Content-Language": "zh_CN"
          };
          const adminToken = readCookie("Admin-Token") || findTokenInStorage(window.localStorage) || findTokenInStorage(window.sessionStorage);
          const oaAuthToken = readCookie("oauthtoken") || window.localStorage.getItem("oauthtoken") || window.sessionStorage.getItem("oauthtoken") || "";
          if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
          if (oaAuthToken) headers.oauthtoken = oaAuthToken;

          try {
            const response = await fetch(req.url, {
              method: req.method || "GET",
              credentials: "include",
              cache: "no-store",
              headers
            });
            const result = {
              ok: response.ok,
              status: response.status,
              statusText: response.statusText,
              contentType: response.headers.get("content-type") || ""
            };
            if (req.responseType === "arrayBuffer" && !/text\/html/i.test(result.contentType)) {
              const buffer = await response.arrayBuffer();
              result.base64 = await new Promise((resolveBase64, rejectBase64) => {
                const reader = new FileReader();
                reader.onload = () => resolveBase64(String(reader.result || "").split(",")[1] || "");
                reader.onerror = () => rejectBase64(reader.error || new Error("FileReader failed"));
                reader.readAsDataURL(new Blob([buffer]));
              });
            } else {
              result.text = await response.text();
            }
            return result;
          } catch (error) {
            return { ok: false, status: 0, statusText: "", contentType: "", error: error?.message || String(error) };
          }
        },
        args: [request]
      },
      (results) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "页面桥接请求失败"));
          return;
        }
        const first = results?.[0]?.result;
        if (!first) {
          reject(new Error("页面执行请求没有返回结果"));
          return;
        }
        if (first.error) {
          reject(new Error(cleanText(first.error)));
          return;
        }
        resolve(first);
      }
    );
  });
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("打开合同页超时"));
    }, timeoutMs);

    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        cleanup();
        reject(new Error(runtimeError.message || "读取标签页状态失败"));
        return;
      }
      if (tab?.status === "complete") {
        cleanup();
        resolve();
      }
    });
  });
}

function executeScriptFile(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: [file]
      },
      () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "注入页面采集脚本失败"));
          return;
        }
        resolve();
      }
    );
  });
}

function executeScriptFunction(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func,
        args
      },
      (results) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "执行页面采集失败"));
          return;
        }
        resolve(results?.[0]?.result ?? null);
      }
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToUint8Array(base64) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export { uint8ArrayToBase64 };
