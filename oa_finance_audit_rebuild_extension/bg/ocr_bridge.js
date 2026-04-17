export const OCR_BRIDGE_KEY = "__oaFinanceOcrBridge";
const OCR_IDLE_MS = 60_000;
const bridgeRefCounts = new Map();

function buildOcrBridgeConfig() {
  return {
    tesseractModuleUrl: chrome.runtime.getURL("node_modules/tesseract.js/dist/tesseract.esm.min.js"),
    workerUrl: chrome.runtime.getURL("node_modules/tesseract.js/dist/worker.min.js"),
    coreUrl: chrome.runtime.getURL("node_modules/tesseract.js-core"),
    langPath: chrome.runtime.getURL("assets/tessdata")
  };
}

function executeInTab(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "ISOLATED",
        func,
        args
      },
      (results) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "OCR bridge executeScript failed"));
          return;
        }
        resolve(results?.[0]?.result);
      }
    );
  });
}

async function bootstrapOcrBridgeInPage(config, bridgeKey, idleMs) {
  const scope = globalThis;
  if (scope[bridgeKey]) {
    scope[bridgeKey].touch();
    return { ok: true, reused: true };
  }

  // `executeScript` only serializes the target function body, so helpers used by
  // the injected bridge must live inside this scope instead of the module scope.
  const extractRecognizedText = (result) => {
    const data = result?.data || {};
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const filteredLines = lines
      .filter((line) => Number(line?.confidence || 0) >= 30)
      .map((line) => String(line?.text || "").trim())
      .filter(Boolean);
    if (filteredLines.length > 0) {
      return filteredLines.join("\n");
    }

    const words = Array.isArray(data.words) ? data.words : [];
    const filteredWords = words
      .filter((word) => Number(word?.confidence || 0) >= 40)
      .map((word) => String(word?.text || "").trim())
      .filter(Boolean);
    if (filteredWords.length >= 3) {
      return filteredWords.join(" ");
    }

    const confidence = Number(data.confidence || 0);
    return confidence >= 25 ? String(data.text || "").trim() : "";
  };

  const loadTesseractApi = async () => {
    const moduleNs = await import(config.tesseractModuleUrl);
    const tesseractApi = moduleNs?.createWorker
      ? moduleNs
      : moduleNs?.default?.createWorker
        ? moduleNs.default
        : moduleNs?.default || moduleNs;
    const createWorker = tesseractApi?.createWorker;
    if (typeof createWorker !== "function") {
      throw new Error("Tesseract createWorker unavailable");
    }
    return createWorker;
  };

  const workerByMode = { general: null, numeric: null };
  const queueByMode = { general: Promise.resolve(), numeric: Promise.resolve() };

  const bridge = {
    activeCount: 0,
    idleTimer: null,
    closed: false,
    touch() {
      if (bridge.idleTimer) {
        clearTimeout(bridge.idleTimer);
        bridge.idleTimer = null;
      }
      if (bridge.closed) {
        return;
      }
      bridge.idleTimer = setTimeout(async () => {
        if (bridge.activeCount > 0 || bridge.closed) {
          bridge.touch();
          return;
        }
        try {
          await bridge.release();
        } catch (_error) {
          // Ignore idle cleanup failures in the injected page.
        }
      }, Math.max(5_000, Number(idleMs) || OCR_IDLE_MS));
    },
    async getWorker(mode) {
      if (bridge.closed) {
        throw new Error("OCR bridge already released");
      }
      if (workerByMode[mode]) {
        return workerByMode[mode];
      }

      const createWorker = await loadTesseractApi();
      if (mode === "numeric") {
        const numericWorker = await createWorker("eng", 1, {
          workerPath: config.workerUrl,
          corePath: config.coreUrl,
          langPath: config.langPath
        });
        await numericWorker.setParameters({
          preserve_interword_spaces: "1",
          tessedit_char_whitelist: "0123456789.,-() ",
          tessedit_pageseg_mode: "6"
        });
        workerByMode.numeric = numericWorker;
        return numericWorker;
      }

      const generalWorker = await createWorker("chi_sim+eng", 1, {
        workerPath: config.workerUrl,
        corePath: config.coreUrl,
        langPath: config.langPath
      });
      await generalWorker.setParameters({ preserve_interword_spaces: "1" });
      workerByMode.general = generalWorker;
      return generalWorker;
    },
    async recognize(dataUrl, mode = "general") {
      const normalizedMode = mode === "numeric" ? "numeric" : "general";
      const task = async () => {
        bridge.activeCount += 1;
        bridge.touch();
        try {
          const worker = await bridge.getWorker(normalizedMode);
          const result = await worker.recognize(dataUrl);
          return extractRecognizedText(result);
        } finally {
          bridge.activeCount = Math.max(0, bridge.activeCount - 1);
          bridge.touch();
        }
      };

      const nextTask = queueByMode[normalizedMode]
        .catch(() => {})
        .then(task);
      queueByMode[normalizedMode] = nextTask.catch(() => {});
      return nextTask;
    },
    async release() {
      if (bridge.closed) {
        return true;
      }
      bridge.closed = true;
      if (bridge.idleTimer) {
        clearTimeout(bridge.idleTimer);
        bridge.idleTimer = null;
      }
      for (const mode of ["general", "numeric"]) {
        const worker = workerByMode[mode];
        workerByMode[mode] = null;
        if (!worker) {
          continue;
        }
        try {
          await worker.terminate();
        } catch (_error) {
          // Ignore release failures in the injected page.
        }
      }
      if (scope[bridgeKey] === bridge) {
        delete scope[bridgeKey];
      }
      return true;
    }
  };

  scope[bridgeKey] = bridge;
  bridge.touch();
  return { ok: true, reused: false };
}

async function recognizeWithBridgeInPage(bridgeKey, dataUrl, mode) {
  const bridge = globalThis?.[bridgeKey];
  if (!bridge) {
    throw new Error("OCR bridge not initialized");
  }
  return bridge.recognize(dataUrl, mode);
}

async function releaseBridgeInPage(bridgeKey) {
  const bridge = globalThis?.[bridgeKey];
  if (!bridge) {
    return true;
  }
  return bridge.release();
}

export async function initOcrBridge(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }
  await executeInTab(tabId, bootstrapOcrBridgeInPage, [buildOcrBridgeConfig(), OCR_BRIDGE_KEY, OCR_IDLE_MS]);
  return true;
}

export async function acquireOcrBridge(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  const key = String(tabId);
  bridgeRefCounts.set(key, (bridgeRefCounts.get(key) || 0) + 1);
  try {
    await initOcrBridge(tabId);
    return true;
  } catch (error) {
    const nextCount = Math.max(0, (bridgeRefCounts.get(key) || 1) - 1);
    if (nextCount > 0) {
      bridgeRefCounts.set(key, nextCount);
    } else {
      bridgeRefCounts.delete(key);
    }
    throw error;
  }
}

export async function requestOcr(tabId, { dataUrl, mode = "general" } = {}) {
  if (!Number.isInteger(tabId)) {
    throw new Error("OCR bridge requires a valid tabId");
  }
  if (!dataUrl) {
    return "";
  }
  await initOcrBridge(tabId);
  const text = await executeInTab(tabId, recognizeWithBridgeInPage, [OCR_BRIDGE_KEY, dataUrl, mode]);
  return String(text || "").trim();
}

export async function releaseOcrBridge(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  const key = String(tabId);
  if (bridgeRefCounts.has(key)) {
    const nextCount = Math.max(0, (bridgeRefCounts.get(key) || 0) - 1);
    if (nextCount > 0) {
      bridgeRefCounts.set(key, nextCount);
      return true;
    }
    bridgeRefCounts.delete(key);
  }

  try {
    await executeInTab(tabId, releaseBridgeInPage, [OCR_BRIDGE_KEY]);
    return true;
  } catch (_error) {
    return false;
  }
}
