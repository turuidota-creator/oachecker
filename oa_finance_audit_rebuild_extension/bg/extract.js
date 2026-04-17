import { strFromU8, unzipSync } from "../node_modules/fflate/esm/browser.js";
import * as XLSX from "../node_modules/xlsx/xlsx.mjs";
import { cleanText, supportsAttachmentTextExtraction } from "./common.js";
import { getCurrentPageTabId, uint8ArrayToBase64 } from "./io.js";
import { initOcrBridge, OCR_BRIDGE_KEY } from "./ocr_bridge.js";

const OCR_LANG_PATH = chrome.runtime.getURL("assets/tessdata");

export async function extractReferenceTextsFromAttachment(attachment, bytes, contentType = "") {
  const kind = detectAttachmentKind(attachment, bytes, contentType);
  if (!kind) return [];
  if (kind === "zip") return extractZipReferenceTexts(bytes);
  const text = await extractAttachmentReferenceText(attachment, bytes, kind);
  return text ? [{ name: attachment?.name || "attachment", text }] : [];
}

export async function extractMailEvidenceFromAttachment(attachment, bytes, contentType = "") {
  const kind = detectAttachmentKind(attachment, bytes, contentType);
  if (kind === "eml") {
    return extractEmlEvidence(bytes);
  }
  if (kind === "msg") {
    return extractMsgEvidenceHeuristically(bytes, attachment?.name || "mail.msg");
  }
  return null;
}

function detectAttachmentKind(attachment, bytes, contentType = "") {
  const type = String(contentType || "").toLowerCase();
  const marker = `${attachment?.name || ""} ${attachment?.url || ""}`;
  if (/\.pdf(?:$|\?)/i.test(marker) || type.includes("pdf") || hasBinaryPrefix(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (/\.docx(?:$|\?)/i.test(marker) || type.includes("wordprocessingml")) return "docx";
  if (/\.(xlsx?|csv)(?:$|\?)/i.test(marker) || type.includes("spreadsheetml") || type.includes("text/csv")) return "spreadsheet";
  if (/\.ofd(?:$|\?)/i.test(marker) || type.includes("ofd")) return "ofd";
  if (/\.(png|jpg|jpeg)(?:$|\?)/i.test(marker) || type.startsWith("image/")) return "image";
  if (/\.eml(?:$|\?)/i.test(marker) || type.includes("message/rfc822")) return "eml";
  if (/\.msg(?:$|\?)/i.test(marker) || type.includes("vnd.ms-outlook")) return "msg";
  if (/\.zip(?:$|\?)/i.test(marker) || type.includes("zip") || hasBinaryPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) return sniffZipContainerKind(bytes);
  if (/\.xml(?:$|\?)/i.test(marker) || type.includes("xml")) return "xml";
  if (/\.txt(?:$|\?)/i.test(marker) || type.startsWith("text/plain")) return "plain";
  if (/\.rtf(?:$|\?)/i.test(marker) || type.includes("rtf")) return "rtf";
  return "";
}

function executeInTab(tabId, func, args, errorMessage) {
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
          reject(new Error(runtimeError.message || errorMessage));
          return;
        }
        const payload = results?.[0]?.result;
        if (!payload?.ok) {
          reject(new Error(payload?.error || errorMessage));
          return;
        }
        resolve(payload);
      }
    );
  });
}

function mergeUniqueTexts(values) {
  const unique = [];
  for (const value of values || []) {
    const text = cleanText(value);
    if (!text || unique.includes(text)) {
      continue;
    }
    unique.push(text);
  }
  return unique.join("\n");
}

async function extractAttachmentReferenceText(attachment, bytes, kind) {
  if (kind === "pdf") return extractPdfText(bytes);
  if (kind === "docx") return extractDocxText(bytes);
  if (kind === "spreadsheet") return extractSpreadsheetText(bytes);
  if (kind === "ofd") return extractOfdText(bytes);
  if (kind === "plain") return decodeBytesSmart(bytes);
  if (kind === "xml") return extractXmlText(decodeBytesSmart(bytes));
  if (kind === "rtf") return extractRtfText(bytes);
  if (kind === "image") return extractImageTextSafeViaBridge(bytes, attachment?.name || "image");
  if (kind === "eml") return (await extractEmlEvidence(bytes))?.text || "";
  if (kind === "msg") return (await extractMsgEvidenceHeuristically(bytes, attachment?.name || "mail.msg"))?.text || "";
  return "";
}

async function extractPdfText(data) {
  const tabId = getCurrentPageTabId();
  if (!Number.isInteger(tabId)) {
    throw new Error("未找到当前标签页，无法解析 PDF 附件");
  }
  return extractPdfTextViaBridge(tabId, data);
}

async function extractPdfTextViaBridge(tabId, data) {
  await initOcrBridge(tabId);
  const base64 = uint8ArrayToBase64(data);
  const moduleUrl = chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = chrome.runtime.getURL("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
  const cMapUrl = chrome.runtime.getURL("node_modules/pdfjs-dist/cmaps/");
  const standardFontDataUrl = chrome.runtime.getURL("node_modules/pdfjs-dist/standard_fonts/");
  const payload = await executeInTab(
    tabId,
    async (
      inputBase64,
      pdfModuleUrl,
      pdfWorkerUrl,
      injectedCMapUrl,
      injectedStandardFontDataUrl,
      bridgeKey
    ) => {
      try {
        const flattenItems = (items) => {
          const parts = [];
          for (const item of items || []) {
            if (!item || typeof item.str !== "string") continue;
            parts.push(item.str);
            parts.push(item.hasEOL ? "\n" : " ");
          }
          return parts.join("");
        };
        const renderPageToCanvas = async (page, scale = 2.4) => {
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const context = canvas.getContext("2d", { alpha: false });
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
          return canvas;
        };
        const cropCanvas = (sourceCanvas, leftRatio, topRatio, widthRatio, heightRatio, upscale = 1.6) => {
          const cropX = Math.max(0, Math.floor(sourceCanvas.width * leftRatio));
          const cropY = Math.max(0, Math.floor(sourceCanvas.height * topRatio));
          const cropWidth = Math.max(1, Math.min(sourceCanvas.width - cropX, Math.floor(sourceCanvas.width * widthRatio)));
          const cropHeight = Math.max(1, Math.min(sourceCanvas.height - cropY, Math.floor(sourceCanvas.height * heightRatio)));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(cropWidth * upscale));
          canvas.height = Math.max(1, Math.floor(cropHeight * upscale));
          const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
          return { canvas, context };
        };
        const boostForAccountOcr = (context, width, height) => {
          const imageData = context.getImageData(0, 0, width, height);
          const pixels = imageData.data;
          for (let index = 0; index < pixels.length; index += 4) {
            const gray = Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114);
            const boosted = Math.max(0, Math.min(255, Math.round((gray - 150) * 1.9 + 150)));
            const normalized = boosted > 218 ? 255 : boosted < 94 ? 0 : boosted;
            pixels[index] = normalized;
            pixels[index + 1] = normalized;
            pixels[index + 2] = normalized;
          }
          context.putImageData(imageData, 0, 0);
        };
        const buildPdfOcrVariants = async (page) => {
          const fullCanvas = await renderPageToCanvas(page, 2.6);
          const variants = [{ label: "full-page", mode: "general", dataUrl: fullCanvas.toDataURL("image/png") }];
          const accountRegions = [
            [0.12, 0.30, 0.62, 0.22],
            [0.14, 0.36, 0.52, 0.14],
            [0.18, 0.39, 0.40, 0.10]
          ];
          accountRegions.forEach((region, index) => {
            const { canvas, context } = cropCanvas(fullCanvas, ...region, 2);
            variants.push({ label: `account-zone-${index + 1}`, mode: "general", dataUrl: canvas.toDataURL("image/png") });
            boostForAccountOcr(context, canvas.width, canvas.height);
            variants.push({ label: `account-zone-${index + 1}-numeric`, mode: "numeric", dataUrl: canvas.toDataURL("image/png") });
          });
          return variants;
        };
        const hasUsefulPdfText = (value) => {
          const raw = String(value || "");
          const stripped = raw.replace(/\s+/g, "");
          if (stripped.length < 80) {
            return false;
          }
          const usefulChars = stripped.match(/[\u4e00-\u9fa5A-Za-z0-9¥￥]/g) || [];
          const usefulRatio = usefulChars.length / Math.max(1, stripped.length);
          const lineCount = raw
            .split(/\n+/)
            .map((line) => String(line || "").trim())
            .filter(Boolean).length;
          const digitCount = (stripped.match(/\d/g) || []).length;
          const hasKeyword = /(合同|协议|发票|金额|税额|付款|验收|账号|银行|供应商|公司|invoice|amount|tax|bank|account)/i.test(raw);
          return usefulRatio >= 0.35 && (hasKeyword || lineCount >= 3 || digitCount >= 4);
        };
        const buildOcrPageNumbers = (numPages) => {
          if (!Number.isFinite(numPages) || numPages <= 0) return [];
          if (numPages <= 8) {
            return Array.from({ length: numPages }, (_, index) => index + 1);
          }
          const picks = new Set([1, 2, 3, numPages - 2, numPages - 1, numPages]);
          return Array.from(picks)
            .filter((pageNo) => pageNo >= 1 && pageNo <= numPages)
            .sort((left, right) => left - right);
        };
        const runOcr = async (dataUrl, mode = "general") => {
          const bridge = globalThis?.[bridgeKey];
          if (!bridge) {
            throw new Error("OCR bridge not initialized");
          }
          return bridge.recognize(dataUrl, mode);
        };
        const binary = atob(inputBase64 || "");
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const pdfjs = await import(pdfModuleUrl);
        if (pdfjs?.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        }
        if (typeof pdfjs?.setVerbosityLevel === "function" && pdfjs?.VerbosityLevel) {
          pdfjs.setVerbosityLevel(pdfjs.VerbosityLevel.ERRORS);
        }
        const loadingTask = pdfjs.getDocument({
          data: bytes,
          cMapUrl: injectedCMapUrl,
          cMapPacked: true,
          standardFontDataUrl: injectedStandardFontDataUrl,
          verbosity: pdfjs?.VerbosityLevel?.ERRORS ?? 0,
          useSystemFonts: true,
          isEvalSupported: false
        });
        const pdf = await loadingTask.promise;
        const parts = [];
        for (let page = 1; page <= Math.min(pdf.numPages, 4); page += 1) {
          const current = await pdf.getPage(page);
          const content = await current.getTextContent();
          parts.push(flattenItems(content.items || []));
        }
        let text = parts.join("\n");
        if (!hasUsefulPdfText(text)) {
          const ocrParts = [];
          for (const page of buildOcrPageNumbers(pdf.numPages)) {
            const current = await pdf.getPage(page);
            const variants = await buildPdfOcrVariants(current);
            for (const variant of variants) {
              const ocrText = await runOcr(variant.dataUrl, variant.mode);
              if (ocrText) {
                ocrParts.push(ocrText);
              }
            }
          }
          if (ocrParts.length) {
            text = [text, ...ocrParts].filter(Boolean).join("\n");
          }
        }
        return { ok: true, text };
      } catch (error) {
        return {
          ok: false,
          error: error?.stack || error?.message || String(error)
        };
      }
    },
    [base64, moduleUrl, workerUrl, cMapUrl, standardFontDataUrl, OCR_BRIDGE_KEY],
    "标签页 PDF 解析失败"
  );
  if (typeof payload.text !== "string") {
    throw new Error("标签页 PDF 解析没有返回文本");
  }
  return payload.text;
}

export function extractDocxText(data) {
  try {
    const files = unzipSync(data);
    return Object.entries(files || {})
      .filter(([name]) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name))
      .map(([, content]) => extractVisibleWordXmlText(strFromU8(content)))
      .filter(Boolean)
      .join("\n");
  } catch (_error) {
    return "";
  }
}

function extractVisibleWordXmlText(xmlText) {
  const source = stripHiddenWordXml(String(xmlText || "").replace(/\r/g, ""));
  if (!source) {
    return "";
  }

  const parts = [];
  const tokenPattern =
    /<(?:\w+:)?tab\b[^>]*\/>|<(?:\w+:)?(?:br|cr)\b[^>]*\/>|<\/(?:\w+:)?(?:p|tr|tbl)\b[^>]*>|<\/(?:\w+:)?tc\b[^>]*>|<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi;

  let match;
  while ((match = tokenPattern.exec(source))) {
    const [token, textValue] = match;
    if (typeof textValue === "string") {
      parts.push(decodeXmlEntities(textValue));
      continue;
    }

    if (/<(?:\w+:)?tab\b/i.test(token) || /<\/(?:\w+:)?tc\b/i.test(token)) {
      parts.push("\t");
      continue;
    }

    parts.push("\n");
  }

  return cleanText(parts.join(""));
}

function stripHiddenWordXml(xmlText) {
  return String(xmlText || "")
    .replace(/<(?:\w+:)?del\b[\s\S]*?<\/(?:\w+:)?del>/gi, " ")
    .replace(/<(?:\w+:)?moveFrom\b[\s\S]*?<\/(?:\w+:)?moveFrom>/gi, " ")
    .replace(/<(?:\w+:)?instrText\b[\s\S]*?<\/(?:\w+:)?instrText>/gi, " ")
    .replace(/<(?:\w+:)?(?:commentRangeStart|commentRangeEnd|commentReference|annotationRef)\b[^>]*\/>/gi, " ");
}

function decodeXmlEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    const normalized = String(entity || "").toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function extractSpreadsheetText(data) {
  try {
    const workbook = XLSX.read(data, { type: "array", dense: false });
    return (workbook.SheetNames || [])
      .slice(0, 4)
      .map((name) => {
        const sheet = workbook.Sheets?.[name];
        return sheet ? `${name}\n${cleanText(XLSX.utils.sheet_to_csv(sheet, { blankrows: false }))}` : "";
      })
      .filter(Boolean)
      .join("\n");
  } catch (_error) {
    return "";
  }
}

function extractOfdText(data) {
  try {
    const files = unzipSync(data);
    return Object.entries(files || {})
      .filter(([name]) => /\.xml$/i.test(name))
      .slice(0, 8)
      .map(([, content]) => extractXmlText(decodeBytesSmart(content)))
      .filter(Boolean)
      .join("\n");
  } catch (_error) {
    return "";
  }
}

async function extractZipReferenceTexts(data) {
  try {
    const files = unzipSync(data);
    const results = [];
    for (const [name, content] of Object.entries(files || {})) {
      if (!supportsAttachmentTextExtraction(name, name) || !content || content.byteLength < 128) continue;
      const child = await extractReferenceTextsFromAttachment({ name, url: name }, content);
      results.push(...child);
      if (results.length >= 8) break;
    }
    return results;
  } catch (_error) {
    return [];
  }
}

async function extractImageTextSafeViaBridge(data, name = "image") {
  if (!data || data.byteLength < 128) return "";
  const tabId = getCurrentPageTabId();
  if (!Number.isInteger(tabId)) {
    throw new Error("未找到当前标签页，无法执行图片 OCR");
  }
  await initOcrBridge(tabId);
  const mimeType = /\.png(?:$|\?)/i.test(String(name || "")) ? "image/png" : "image/jpeg";
  const base64 = uint8ArrayToBase64(data);
  const payload = await executeInTab(
    tabId,
    async (inputBase64, inputMimeType, bridgeKey) => {
      try {
        const loadImageFromBlob = (blob) =>
          new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
              URL.revokeObjectURL(objectUrl);
              resolve(image);
            };
            image.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              reject(new Error("Image decode failed"));
            };
            image.src = objectUrl;
          });
        const buildVariants = async (blob) => {
          const image = await loadImageFromBlob(blob);
          const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
          const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);
          const scale = Math.min(2.2, Math.max(1.6, 1800 / Math.max(sourceWidth, sourceHeight)));
          const width = Math.max(1, Math.floor(sourceWidth * scale));
          const height = Math.max(1, Math.floor(sourceHeight * scale));
          const variants = [];
          const bridge = globalThis?.[bridgeKey];
          if (!bridge) {
            throw new Error("OCR bridge not initialized");
          }
          const makeCanvas = () => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, 0, 0, width, height);
            return { canvas, context };
          };
          const pushCanvas = (label, canvas, mode = "general") => {
            variants.push({ label, mode, dataUrl: canvas.toDataURL("image/png") });
          };
          const makeCropCanvas = (leftRatio, topRatio, widthRatio, heightRatio) => {
            const canvas = document.createElement("canvas");
            const cropX = Math.max(0, Math.floor(sourceWidth * leftRatio));
            const cropY = Math.max(0, Math.floor(sourceHeight * topRatio));
            const cropWidth = Math.max(1, Math.floor(sourceWidth * widthRatio));
            const cropHeight = Math.max(1, Math.floor(sourceHeight * heightRatio));
            canvas.width = Math.max(1, Math.floor(cropWidth * Math.max(2, scale)));
            canvas.height = Math.max(1, Math.floor(cropHeight * Math.max(2, scale)));
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
            return { canvas, context };
          };
          const toGray = (red, green, blue) => Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
          const whitenRedPixels = (pixels, preserveContrast = false) => {
            for (let index = 0; index < pixels.length; index += 4) {
              const red = pixels[index];
              const green = pixels[index + 1];
              const blue = pixels[index + 2];
              if (red > 120 && red > green * 1.35 && red > blue * 1.35) {
                pixels[index] = 255;
                pixels[index + 1] = 255;
                pixels[index + 2] = 255;
                continue;
              }
              const gray = toGray(red, green, blue);
              const nextValue = preserveContrast
                ? Math.min(255, Math.max(0, Math.round((gray - 128) * 1.45 + 128)))
                : gray;
              pixels[index] = nextValue;
              pixels[index + 1] = nextValue;
              pixels[index + 2] = nextValue;
            }
          };
          const applyThreshold = (pixels, thresholdValue) => {
            for (let index = 0; index < pixels.length; index += 4) {
              const gray = toGray(pixels[index], pixels[index + 1], pixels[index + 2]);
              const threshold = gray > thresholdValue ? 255 : 0;
              pixels[index] = threshold;
              pixels[index + 1] = threshold;
              pixels[index + 2] = threshold;
            }
          };

          {
            const { canvas } = makeCanvas();
            pushCanvas("original", canvas);
          }

          {
            const { canvas, context } = makeCanvas();
            const imageData = context.getImageData(0, 0, width, height);
            const pixels = imageData.data;
            for (let index = 0; index < pixels.length; index += 4) {
              const gray = Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114);
              const boosted = Math.min(255, Math.max(0, Math.round((gray - 128) * 1.55 + 128)));
              pixels[index] = boosted;
              pixels[index + 1] = boosted;
              pixels[index + 2] = boosted;
            }
            context.putImageData(imageData, 0, 0);
            pushCanvas("grayscale-boost", canvas);
          }

          {
            const { canvas, context } = makeCanvas();
            const imageData = context.getImageData(0, 0, width, height);
            whitenRedPixels(imageData.data, true);
            context.putImageData(imageData, 0, 0);
            pushCanvas("red-removed", canvas);
          }

          {
            const { canvas, context } = makeCanvas();
            const imageData = context.getImageData(0, 0, width, height);
            applyThreshold(imageData.data, 182);
            context.putImageData(imageData, 0, 0);
            pushCanvas("threshold", canvas);
          }

          {
            const { canvas, context } = makeCropCanvas(0.18, 0.0, 0.64, 0.22);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            whitenRedPixels(imageData.data, true);
            context.putImageData(imageData, 0, 0);
            pushCanvas("top-title-red-removed", canvas);
          }

          {
            const { canvas } = makeCropCanvas(0.46, 0.55, 0.52, 0.25);
            pushCanvas("bottom-right", canvas, "numeric");
          }

          {
            const { canvas } = makeCropCanvas(0.30, 0.40, 0.68, 0.35);
            pushCanvas("mid-right", canvas, "numeric");
          }

          {
            const { canvas, context } = makeCropCanvas(0.40, 0.48, 0.58, 0.32);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            applyThreshold(imageData.data, 176);
            context.putImageData(imageData, 0, 0);
            pushCanvas("bottom-right-threshold", canvas, "numeric");
          }

          {
            const { canvas, context } = makeCropCanvas(0.0, 0.50, 1.0, 0.30);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            applyThreshold(imageData.data, 178);
            context.putImageData(imageData, 0, 0);
            pushCanvas("bottom-full-threshold", canvas, "numeric");
          }

          return variants;
        };
        const binary = atob(inputBase64 || "");
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const bridge = globalThis?.[bridgeKey];
        if (!bridge) {
          throw new Error("OCR bridge not initialized");
        }
        const variants = await buildVariants(new Blob([bytes], { type: inputMimeType }));
        const texts = [];
        for (const variant of variants) {
          const recognizedText = await bridge.recognize(variant.dataUrl, variant.mode);
          if (recognizedText) {
            texts.push(recognizedText);
          }
        }
        return { ok: true, text: texts.join("\n") };
      } catch (error) {
        return {
          ok: false,
          error: error?.stack || error?.message || String(error)
        };
      }
    },
    [base64, mimeType, OCR_BRIDGE_KEY],
    "标签页 OCR 解析失败"
  );
  return mergeUniqueTexts(String(payload.text || "").split(/\n+/));
}

function extractXmlText(xmlText) {
  return cleanText(String(xmlText || "").replace(/<[^>]+>/g, " "));
}

function extractRtfText(data) {
  return cleanText(
    String(decodeBytesSmart(data) || "")
      .replace(/\\par[d]?/gi, "\n")
      .replace(/\\tab/gi, "\t")
      .replace(/\\'[0-9a-fA-F]{2}/g, " ")
      .replace(/\\[a-z]+\d*\s?/gi, " ")
      .replace(/[{}]/g, " ")
  );
}

function decodeBytesSmart(bytes) {
  for (const encoding of ["utf-8", "gb18030", "utf-16le"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
      if (cleanText(text)) return text;
    } catch (_error) {}
  }
  return "";
}

async function extractEmlEvidence(bytes) {
  const raw = decodeBytesSmart(bytes);
  if (!raw) {
    return { subject: "", sentAt: "", bodySummary: "", attachmentNames: [], text: "" };
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const headerEnd = normalized.indexOf("\n\n");
  const headerText = headerEnd >= 0 ? normalized.slice(0, headerEnd) : normalized;
  const bodyText = headerEnd >= 0 ? normalized.slice(headerEnd + 2) : "";
  const unfoldedHeaders = headerText.replace(/\n[ \t]+/g, " ");
  const subject = decodeMimeHeader(findHeaderValue(unfoldedHeaders, "Subject"));
  const sentAt = decodeMimeHeader(findHeaderValue(unfoldedHeaders, "Date"));
  const attachmentNames = Array.from(
    new Set(
      Array.from(normalized.matchAll(/(?:filename|name)\*?=(?:"([^"]+)"|([^;\n]+))/gi))
        .map((match) => decodeMimeHeader(cleanText(match[1] || match[2] || "").replace(/;$/, "")))
        .filter(Boolean)
    )
  );
  const plainBody = summarizeMailBody(bodyText);
  const text = cleanText([subject, sentAt, plainBody, attachmentNames.join(" ")].filter(Boolean).join("\n"));

  return {
    subject,
    sentAt,
    bodySummary: summarizeText(plainBody, 180),
    attachmentNames,
    text
  };
}

async function extractMsgEvidenceHeuristically(bytes, fallbackName) {
  const decodedCandidates = [
    decodeBytesAs(bytes, "utf-16le"),
    decodeBytesAs(bytes, "utf-8"),
    decodeBytesAs(bytes, "gb18030")
  ];
  const extractedText = cleanText(
    decodedCandidates
      .map((item) => extractReadableText(item))
      .filter(Boolean)
      .join("\n")
  );

  const subject =
    findHeaderLike(extractedText, /(?:^|\n)Subject[:：]\s*(.+)/i) ||
    findHeaderLike(extractedText, /(?:^|\n)主题[:：]\s*(.+)/i) ||
    "";
  const sentAt =
    findHeaderLike(extractedText, /(?:^|\n)(?:Date|Sent)[:：]\s*(.+)/i) ||
    findHeaderLike(extractedText, /(?:^|\n)(?:日期|发送时间|发件时间)[:：]\s*(.+)/i) ||
    "";
  const attachmentNames = Array.from(
    new Set(
      (extractedText.match(/[\w\u4e00-\u9fa5][^\r\n]{0,80}\.(?:pdf|docx?|xlsx?|png|jpe?g|zip|eml|msg|txt)/gi) || [])
        .map((item) => cleanText(item))
        .filter(Boolean)
        .slice(0, 8)
    )
  );
  const bodySummary = summarizeText(extractLikelyMailBody(extractedText), 180);
  const text = cleanText([subject, sentAt, bodySummary, attachmentNames.join(" "), fallbackName].filter(Boolean).join("\n"));

  return {
    subject,
    sentAt,
    bodySummary,
    attachmentNames,
    text
  };
}

function decodeBytesAs(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch (_error) {
    return "";
  }
}

function findHeaderValue(headerText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = headerText.match(new RegExp(`(?:^|\\n)${escaped}:\\s*(.+)`, "i"));
  return cleanText(match?.[1] || "");
}

function decodeMimeHeader(value) {
  const raw = cleanText(value || "");
  if (!raw) return "";
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_whole, charset, mode, payload) => {
    try {
      if (/^b$/i.test(mode)) {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      }
      const quotedPrintable = payload
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      const bytes = Uint8Array.from(quotedPrintable, (char) => char.charCodeAt(0));
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch (_error) {
      return payload;
    }
  });
}

function summarizeMailBody(bodyText) {
  const normalized = cleanText(
    String(bodyText || "")
      .replace(/Content-[^\n]+/gi, " ")
      .replace(/--[^\n]+/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
  return summarizeText(normalized, 240);
}

function summarizeText(text, maxLength) {
  const normalized = cleanText(text || "");
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function extractReadableText(text) {
  return Array.from(
    new Set(
      String(text || "")
        .replace(/\u0000/g, "\n")
        .split(/\n+/)
        .map((line) => cleanText(line))
        .filter((line) => line.length >= 4)
        .filter((line) => /[A-Za-z\u4e00-\u9fa5]/.test(line))
        .slice(0, 160)
    )
  ).join("\n");
}

function findHeaderLike(text, regex) {
  const match = String(text || "").match(regex);
  return summarizeText(match?.[1] || "", 120);
}

function extractLikelyMailBody(text) {
  const normalized = String(text || "");
  const lines = normalized
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !/^(?:Subject|Date|From|To|Cc|Bcc|Sent)[:：]/i.test(line))
    .filter((line) => !/^(?:主题|日期|发件人|收件人|抄送|密送|发送时间)[:：]/.test(line));
  return lines.slice(0, 12).join(" ");
}

function hasBinaryPrefix(bytes, prefix) {
  return !!bytes && prefix.every((value, index) => bytes[index] === value);
}

function sniffZipContainerKind(bytes) {
  try {
    const files = Object.keys(unzipSync(bytes) || {});
    if (files.some((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name))) return "docx";
    if (files.some((name) => /^xl\/workbook\.xml$/i.test(name))) return "spreadsheet";
    if (files.some((name) => /(?:^|\/)OFD\.xml$/i.test(name) || /Doc_0\/Document\.xml$/i.test(name))) return "ofd";
    return "zip";
  } catch (_error) {
    return "zip";
  }
}
