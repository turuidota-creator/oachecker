import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

const commonModuleUrl = pathToFileURL(path.join(extensionRoot, "bg", "common.js")).href;
const { parseAmount, normalizeAccount } = await import(commonModuleUrl);

assert.equal(parseAmount("980. 00"), 980, "should ignore embedded OCR spaces");
assert.equal(parseAmount("９８０．００"), 980, "should normalize full-width digits and punctuation");
assert.equal(parseAmount("9O0.OO"), 900, "should tolerate OCR O/0 confusion");
assert.equal(parseAmount("￥1,234.50元整"), 1234.5, "should strip currency/unit markers");
assert.equal(normalizeAccount("6217 OOOO 1234 l678"), "6217000012341678", "should tolerate OCR account glyph drift");

const extractSource = fs.readFileSync(path.join(extensionRoot, "bg", "extract.js"), "utf8");

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
assert.ok(extractSource.includes('pushCanvas("mid-right", canvas, "numeric");'), "mid-right crop should exist");
assert.ok(
  extractSource.includes('pushCanvas("bottom-full-threshold", canvas, "numeric");'),
  "bottom-full numeric crop should exist"
);
assert.ok(
  extractSource.includes('tessedit_char_whitelist: "0123456789.,-() "'),
  "numeric worker whitelist should be self-consistent"
);
assert.ok(extractSource.includes("const extractRecognizedText = (result) => {"), "OCR confidence filter should exist");

console.log("extract/common OCR guard checks passed");
