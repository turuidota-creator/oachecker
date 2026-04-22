import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const listPageSource = fs.readFileSync(
  path.join(projectRoot, "oa_finance_audit_rebuild_extension", "list_page.js"),
  "utf8"
);

assert.ok(
  listPageSource.includes("function findDetailUrlFromRow"),
  "batch list should extract the native detail URL from the visible row"
);
assert.ok(
  listPageSource.includes("function rememberRowInfo"),
  "batch list should remember visible row metadata before running analysis"
);
assert.ok(
  listPageSource.includes("state.rowMetaCache.set(processCode, rowMeta)"),
  "visible row metadata should override a failed todoList lookup cache"
);
assert.ok(
  listPageSource.includes("let lookupError = null"),
  "todoList lookup failures should not prevent using the visible detail URL"
);
assert.ok(
  listPageSource.includes("detailUrl = cleanText(ensureRowState(processCode).detailUrl || \"\")"),
  "batch analysis should fall back to the detail URL captured from the current list row"
);

console.log("list batch detail fallback checks passed");
