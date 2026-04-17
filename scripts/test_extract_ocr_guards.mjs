import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

const commonModuleUrl = pathToFileURL(path.join(extensionRoot, "bg", "common.js")).href;
const { parseAmount, normalizeAccount, normalizeError } = await import(commonModuleUrl);

assert.equal(parseAmount("980. 00"), 980, "should ignore embedded OCR spaces");
assert.equal(parseAmount("９８０．００"), 980, "should normalize full-width digits and punctuation");
assert.equal(parseAmount("9O0.OO"), 900, "should tolerate OCR O/0 confusion");
assert.equal(parseAmount("￥1,234.50元整"), 1234.5, "should strip currency/unit markers");
assert.equal(normalizeAccount("6217 OOOO 1234 l678"), "6217000012341678", "should tolerate OCR account glyph drift");
assert.equal(normalizeError(new Error("Failed to fetch")), "网络请求失败，请确认 OA 登录状态和网络后重试");
assert.equal(normalizeError("请先在当前浏览器中登录 OA"), "请先在当前浏览器中登录 OA");

const extractSource = fs.readFileSync(path.join(extensionRoot, "bg", "extract.js"), "utf8");
const ocrBridgeSource = fs.readFileSync(path.join(extensionRoot, "bg", "ocr_bridge.js"), "utf8");
const analyzerSource = fs.readFileSync(path.join(extensionRoot, "bg", "analyzer.js"), "utf8");
const collectorSource = fs.readFileSync(path.join(extensionRoot, "page", "collector.js"), "utf8");
const listPageSource = fs.readFileSync(path.join(extensionRoot, "list_page.js"), "utf8");

assert.ok(extractSource.includes('let text = parts.join("\\n");'), "PDF text extraction should use real newline joins");
assert.ok(
  extractSource.includes('text = [text, ...ocrParts].filter(Boolean).join("\\n");'),
  "PDF OCR merge should use real newline joins"
);
assert.ok(!extractSource.includes('parts.join("\\\\n")'), "PDF text extraction should not use literal backslash-n");
assert.ok(
  !extractSource.includes('[text, ...ocrParts].filter(Boolean).join("\\\\n")'),
  "PDF OCR merge should not use literal backslash-n"
);
assert.ok(extractSource.includes('pushCanvas("red-removed", canvas);'), "red-stamp removal variant should exist");
assert.ok(extractSource.includes('pushCanvas("top-title-red-ink", canvas, "title");'), "title red-ink crop should exist");
assert.ok(extractSource.includes('pushCanvas("top-title-line-red-ink", canvas, "title");'), "title line crop should exist");
assert.ok(extractSource.includes('pushCanvas("mid-right", canvas, "numeric");'), "mid-right crop should exist");
assert.ok(
  extractSource.includes('pushCanvas("bottom-full-threshold", canvas, "numeric");'),
  "bottom-full numeric crop should exist"
);
assert.ok(
  !extractSource.includes("function extractPdfTextInTab"),
  "legacy in-tab PDF OCR path should stay removed"
);
assert.ok(
  !extractSource.includes("function extractImageTextSafe("),
  "legacy direct image OCR path should stay removed"
);
assert.ok(
  ocrBridgeSource.includes('tessedit_char_whitelist: "0123456789.,-() "'),
  "numeric worker whitelist should be self-consistent"
);
assert.ok(
  ocrBridgeSource.includes('tessedit_pageseg_mode: "7"'),
  "title OCR worker should use single-line page segmentation"
);
assert.ok(ocrBridgeSource.includes("const extractRecognizedText = (result) => {"), "OCR confidence filter should exist");
assert.ok(extractSource.includes('"标签页 PDF 解析失败"'), "PDF bridge failure message should be UTF-8 Chinese");
assert.ok(extractSource.includes('"标签页 OCR 解析失败"'), "OCR bridge failure message should be UTF-8 Chinese");
assert.ok(listPageSource.includes('"扩展通信失败"'), "extension communication fallback should be UTF-8 Chinese");
assert.ok(analyzerSource.includes("/费用|服务|报价/"), "contract fallback keyword regex should be UTF-8 Chinese");
assert.ok(analyzerSource.includes("/无金额上限|不设上限|上限不限|无封顶|"), "cap amount regex should be UTF-8 Chinese");
assert.ok(collectorSource.includes("function normalizeCollectedFieldValue"), "collector should normalize option-only field values");
assert.ok(
  collectorSource.includes("/关联发票是否正确/.test(normalizedLabel) && /正确.*不正确/.test(compactValue)"),
  "collector should guard against option-only linked-invoice values"
);

const mojibakeMarkers = [
  "\u93CD\u56E9",
  "\u7459\uFF46\u703D",
  "\u7490\u572D\u6564",
  "\u93C8\u5D85\u59DF",
  "\u93B5\u2541\u774D",
  "\u95AB\u6C2B\u4FCA",
  "\u6FB6\u8FAB\u89E6",
  "\u93C8\uE045\u58D8"
];
for (const [fileName, source] of [
  ["bg/extract.js", extractSource],
  ["bg/analyzer.js", analyzerSource],
  ["list_page.js", listPageSource]
]) {
  for (const marker of mojibakeMarkers) {
    assert.equal(source.includes(marker), false, `${fileName} should not contain mojibake marker ${JSON.stringify(marker)}`);
  }
}

console.log("extract/common OCR guard checks passed");
