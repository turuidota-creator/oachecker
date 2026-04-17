import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");

globalThis.chrome ??= {
  runtime: {
    getURL(resource = "") {
      return `chrome-extension://test/${String(resource).replace(/^\/+/, "")}`;
    }
  }
};

const extractModuleUrl = pathToFileURL(path.join(extensionRoot, "bg", "extract.js")).href;
const fflateModuleUrl = pathToFileURL(path.join(extensionRoot, "node_modules", "fflate", "esm", "browser.js")).href;

const { extractDocxText } = await import(extractModuleUrl);
const { zipSync, strToU8 } = await import(fflateModuleUrl);

const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>付款条件</w:t></w:r></w:p>
    <w:p><w:r><w:t>甲方收到乙方发票后支付制作费</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>制作费</w:t></w:r>
      <w:r><w:t>（预估）</w:t></w:r>
      <w:del w:id="1"><w:r><w:delText>40000</w:delText></w:r></w:del>
      <w:r><w:t>76500</w:t></w:r>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>元</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:commentReference w:id="0"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>收款账号</w:t></w:r>
      <w:tab/>
      <w:r><w:t>6222000012345678</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>合同编号 TEST-001</w:t></w:r></w:p>
</w:hdr>`;

const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Crystal">
    <w:p><w:r><w:t>删除：40000</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

const docxBytes = zipSync({
  "word/document.xml": strToU8(docXml),
  "word/header1.xml": strToU8(headerXml),
  "word/comments.xml": strToU8(commentsXml)
});

const extractedText = extractDocxText(docxBytes);

assert.match(extractedText, /付款条件/, "should keep visible contract body text");
assert.match(extractedText, /76500/, "should keep visible revised amount");
assert.match(extractedText, /合同编号 TEST-001/, "should keep header text");
assert.match(extractedText, /6222000012345678/, "should keep visible account text");
assert.doesNotMatch(extractedText, /40000/, "should drop deleted revision text");
assert.doesNotMatch(extractedText, /删除：40000/, "should ignore comment body xml");

console.log("docx extraction guard checks passed");
