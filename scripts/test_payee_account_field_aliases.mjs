import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

const collectorSource = fs.readFileSync(path.join(extensionRoot, "page", "collector.js"), "utf8");
const analyzerSource = fs.readFileSync(path.join(extensionRoot, "bg", "analyzer.js"), "utf8");

const requiredAliases = ["收款账户", "收款银行帐号", "收款方账号", "银行帐号", "开户帐号", "对方账号", "供应商账号"];

for (const alias of requiredAliases) {
  assert.ok(collectorSource.includes(`"${alias}"`), `page collector should recognize payee account alias: ${alias}`);
  assert.ok(analyzerSource.includes(`"${alias}"`), `analyzer fallback should recognize payee account alias: ${alias}`);
}

assert.ok(
  collectorSource.includes("function findAccountFieldValue"),
  "page collector should filter payee-account candidates before returning a target account"
);
assert.ok(
  collectorSource.includes("PAYEE_ACCOUNT_EXCLUDE_LABELS"),
  "page collector should avoid payer/user account labels when scanning generic account aliases"
);

console.log("payee account field alias checks passed");
