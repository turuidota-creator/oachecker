import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

const backgroundSource = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
const analyzerSource = fs.readFileSync(path.join(extensionRoot, "bg", "analyzer.js"), "utf8");

assert.ok(
  backgroundSource.includes("if (entry.buildTag !== BUILD_TAG)"),
  "detail analysis cache must require an exact buildTag match"
);
assert.ok(
  !backgroundSource.includes("if (entry.buildTag && entry.buildTag !== BUILD_TAG)"),
  "missing buildTag cache entries must not be treated as fresh"
);
assert.ok(
  analyzerSource.includes('export const BUILD_TAG = "rebuild-phase5-flowable-payeecode-account-2026-04-22";'),
  "BUILD_TAG should be bumped when cache freshness semantics change"
);

console.log("cache guard checks passed");
