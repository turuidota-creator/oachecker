import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(projectRoot, "oa_finance_audit_rebuild_extension");
const outputRoot = path.join(projectRoot, "tmp_public_invoice_ocr");
const sourceDir = path.join(outputRoot, "sources");
const variantDir = path.join(outputRoot, "variants");
const reportPath = path.join(outputRoot, "report.json");

const tesseractModuleUrl = pathToFileURL(
  path.join(extensionRoot, "node_modules", "tesseract.js", "src", "index.js")
).href;
const commonModuleUrl = pathToFileURL(path.join(extensionRoot, "bg", "common.js")).href;

const { createWorker } = await import(tesseractModuleUrl);
const { cleanText, normalizeInvoiceSubtypeLabel } = await import(commonModuleUrl);

const PUBLIC_SAMPLES = [
  {
    id: "guangxi-vat-ordinary-roll",
    expectedSubtype: "增值税普通发票",
    url: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/W020210728626984935855.png",
    sourcePage: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/t20210728_342989.html",
    fileName: "guangxi-vat-ordinary-roll.png"
  },
  {
    id: "guangxi-vat-ordinary-paper",
    expectedSubtype: "增值税普通发票",
    url: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/W020210728626985090702.png",
    sourcePage: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/t20210728_342989.html",
    fileName: "guangxi-vat-ordinary-paper.png"
  },
  {
    id: "guangxi-e-vat-ordinary-platform",
    expectedSubtype: "增值税普通发票",
    url: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/W020210728626985090094.png",
    sourcePage: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/t20210728_342989.html",
    fileName: "guangxi-e-vat-ordinary-platform.png"
  },
  {
    id: "guangxi-e-vat-ordinary-size",
    expectedSubtype: "增值税普通发票",
    url: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/W020210728626985092063.png",
    sourcePage: "https://guangxi.chinatax.gov.cn/xwdt/ztzl/lszt/qsbsysjh/fp/202107/t20210728_342989.html",
    fileName: "guangxi-e-vat-ordinary-size.png"
  },
  {
    id: "maycur-e-vat-special",
    expectedSubtype: "增值税专用发票",
    url: "https://www.maycur.com/uploadfile/editors/image/20201225/1608889187806254.png",
    sourcePage: "https://www.maycur.com/news/311",
    fileName: "maycur-e-vat-special.png"
  }
];

function parseArgs(argv) {
  const args = {
    samples: PUBLIC_SAMPLES,
    limit: 0,
    keepVariants: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--limit") {
      args.limit = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }
    if (item === "--sample") {
      const requested = String(argv[index + 1] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      args.samples = PUBLIC_SAMPLES.filter((sample) => requested.includes(sample.id));
      index += 1;
      continue;
    }
    if (item === "--no-variants") {
      args.keepVariants = false;
    }
  }

  if (args.limit > 0) {
    args.samples = args.samples.slice(0, args.limit);
  }
  if (!args.samples.length) {
    throw new Error("没有匹配到要测试的公开样票");
  }
  return args;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function downloadSample(sample) {
  const targetPath = path.join(sourceDir, sample.fileName);
  try {
    const stat = await fs.stat(targetPath);
    if (stat.size > 0) {
      return targetPath;
    }
  } catch (_error) {}

  const response = await fetch(sample.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 OCR probe for OA finance audit extension"
    }
  });
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status} ${sample.url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

function pythonPreprocessSource() {
  return String.raw`
import json
import math
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except Exception as exc:
    print(json.dumps({"ok": False, "error": "Pillow unavailable: " + str(exc)}, ensure_ascii=False))
    sys.exit(0)

try:
    import fitz
except Exception:
    fitz = None

source_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
sample_id = sys.argv[3]
out_dir.mkdir(parents=True, exist_ok=True)

def clamp(value):
    return max(0, min(255, int(round(value))))

def load_source_image(path):
    if path.suffix.lower() == ".pdf":
        if fitz is None:
            raise RuntimeError("PyMuPDF unavailable for PDF rendering")
        doc = fitz.open(str(path))
        page = doc.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(2.6, 2.6), alpha=False)
        png_path = out_dir / f"{sample_id}__pdf-page-1.png"
        pix.save(str(png_path))
        return Image.open(png_path).convert("RGB")
    return Image.open(path).convert("RGB")

def to_gray(red, green, blue):
    return int(round(red * 0.299 + green * 0.587 + blue * 0.114))

def write_image(label, mode, image, variants):
    safe_label = label.replace("/", "-")
    target = out_dir / f"{sample_id}__{safe_label}.png"
    image.save(target)
    variants.append({"label": label, "mode": mode, "path": str(target)})

def resize_source(image, scale):
    width = max(1, int(math.floor(image.width * scale)))
    height = max(1, int(math.floor(image.height * scale)))
    return image.resize((width, height), Image.Resampling.LANCZOS)

def crop_source(image, left_ratio, top_ratio, width_ratio, height_ratio, scale):
    crop_x = max(0, int(math.floor(image.width * left_ratio)))
    crop_y = max(0, int(math.floor(image.height * top_ratio)))
    crop_width = max(1, min(image.width - crop_x, int(math.floor(image.width * width_ratio))))
    crop_height = max(1, min(image.height - crop_y, int(math.floor(image.height * height_ratio))))
    crop = image.crop((crop_x, crop_y, crop_x + crop_width, crop_y + crop_height))
    upscale = max(2.0, scale)
    width = max(1, int(math.floor(crop_width * upscale)))
    height = max(1, int(math.floor(crop_height * upscale)))
    return crop.resize((width, height), Image.Resampling.LANCZOS)

def grayscale_boost(image):
    src = image.convert("RGB")
    out = Image.new("RGB", src.size, "white")
    pixels = []
    for red, green, blue in src.getdata():
        gray = to_gray(red, green, blue)
        boosted = clamp((gray - 128) * 1.55 + 128)
        pixels.append((boosted, boosted, boosted))
    out.putdata(pixels)
    return out

def whiten_red_pixels(image, preserve_contrast=False):
    src = image.convert("RGB")
    out = Image.new("RGB", src.size, "white")
    pixels = []
    for red, green, blue in src.getdata():
        if red > 120 and red > green * 1.35 and red > blue * 1.35:
            pixels.append((255, 255, 255))
            continue
        gray = to_gray(red, green, blue)
        next_value = clamp((gray - 128) * 1.45 + 128) if preserve_contrast else gray
        pixels.append((next_value, next_value, next_value))
    out.putdata(pixels)
    return out

def threshold(image, threshold_value):
    src = image.convert("RGB")
    out = Image.new("RGB", src.size, "white")
    pixels = []
    for red, green, blue in src.getdata():
        gray = to_gray(red, green, blue)
        next_value = 255 if gray > threshold_value else 0
        pixels.append((next_value, next_value, next_value))
    out.putdata(pixels)
    return out

def emphasize_red_ink(image, threshold_value=218):
    src = image.convert("RGB")
    out = Image.new("RGB", src.size, "white")
    pixels = []
    for red, green, blue in src.getdata():
        gray = to_gray(red, green, blue)
        is_red_ink = red > 105 and red > green * 1.12 and red > blue * 1.12
        next_value = 0 if is_red_ink else (255 if gray > threshold_value else 0)
        pixels.append((next_value, next_value, next_value))
    out.putdata(pixels)
    return out

try:
    source = load_source_image(source_path)
    scale = min(2.2, max(1.6, 1800 / max(source.width, source.height)))
    full = resize_source(source, scale)
    variants = []

    write_image("original", "general", full, variants)
    write_image("grayscale-boost", "general", grayscale_boost(full), variants)
    write_image("red-removed", "general", whiten_red_pixels(full, True), variants)
    write_image("threshold", "general", threshold(full, 182), variants)

    top_title = crop_source(source, 0.18, 0.0, 0.64, 0.22, scale)
    write_image("top-title-red-removed", "general", whiten_red_pixels(top_title, True), variants)
    write_image("top-title-red-ink", "title", emphasize_red_ink(top_title, 220), variants)

    title_band = crop_source(source, 0.23, 0.0, 0.48, 0.15, scale)
    write_image("top-title-band-red-ink", "title", emphasize_red_ink(title_band, 224), variants)

    title_line = crop_source(source, 0.20, 0.02, 0.56, 0.12, scale)
    write_image("top-title-line-red-ink", "title", emphasize_red_ink(title_line, 228), variants)

    write_image("bottom-right", "numeric", crop_source(source, 0.46, 0.55, 0.52, 0.25, scale), variants)
    write_image("mid-right", "numeric", crop_source(source, 0.30, 0.40, 0.68, 0.35, scale), variants)

    bottom_right_threshold = crop_source(source, 0.40, 0.48, 0.58, 0.32, scale)
    write_image("bottom-right-threshold", "numeric", threshold(bottom_right_threshold, 176), variants)

    bottom_full_threshold = crop_source(source, 0.0, 0.50, 1.0, 0.30, scale)
    write_image("bottom-full-threshold", "numeric", threshold(bottom_full_threshold, 178), variants)

    print(json.dumps({
        "ok": True,
        "sourceWidth": source.width,
        "sourceHeight": source.height,
        "scale": scale,
        "variants": variants
    }, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;
}

async function buildVariants(sample, sourcePath) {
  const outDir = path.join(variantDir, sample.id);
  await ensureDir(outDir);
  const { stdout, stderr } = await execFile(
    "python",
    ["-c", pythonPreprocessSource(), sourcePath, outDir, sample.id],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
  );
  const payload = JSON.parse(String(stdout || "{}"));
  if (!payload.ok) {
    throw new Error(payload.error || stderr || "图片预处理失败");
  }
  return payload;
}

function extractRecognizedText(result) {
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
}

async function createOcrWorkers() {
  const langPath = path.join(extensionRoot, "assets", "tessdata");
  const cachePath = path.join(outputRoot, "tess-cache");
  await ensureDir(cachePath);
  const workerOptions = { langPath, cachePath };
  const general = await createWorker("chi_sim+eng", 1, workerOptions);
  await general.setParameters({ preserve_interword_spaces: "1" });

  const numeric = await createWorker("eng", 1, workerOptions);
  await numeric.setParameters({
    preserve_interword_spaces: "1",
    tessedit_char_whitelist: "0123456789.,-() ",
    tessedit_pageseg_mode: "6"
  });

  const title = await createWorker("chi_sim+eng", 1, workerOptions);
  await title.setParameters({
    preserve_interword_spaces: "0",
    tessedit_pageseg_mode: "7"
  });

  return {
    general,
    numeric,
    title,
    async terminate() {
      await Promise.allSettled([general.terminate(), numeric.terminate(), title.terminate()]);
    }
  };
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

function detectInvoiceSubtype(text) {
  const source = cleanText(text);
  const lines = source
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const candidates = [source];
  for (let index = 0; index < lines.length; index += 1) {
    candidates.push(lines[index]);
    if (lines[index + 1]) {
      candidates.push(`${lines[index]} ${lines[index + 1]}`);
    }
    if (lines[index + 2]) {
      candidates.push(`${lines[index]} ${lines[index + 1]} ${lines[index + 2]}`);
    }
  }

  for (const raw of candidates) {
    const label = normalizeInvoiceSubtypeLabel(raw);
    if (label) {
      return { label, raw };
    }
  }
  return { label: "", raw: "" };
}

async function recognizeSample(workers, sample, sourcePath) {
  const variantPayload = await buildVariants(sample, sourcePath);
  const variantResults = [];

  for (const variant of variantPayload.variants) {
    const worker = workers[variant.mode] || workers.general;
    const result = await worker.recognize(variant.path);
    const text = extractRecognizedText(result);
    const invoiceSubtype = detectInvoiceSubtype(text);
    variantResults.push({
      label: variant.label,
      mode: variant.mode,
      text,
      invoiceSubtype,
      path: variant.path
    });
  }

  const mergedText = mergeUniqueTexts(variantResults.map((item) => item.text));
  const detected = detectInvoiceSubtype(mergedText);
  return {
    id: sample.id,
    expectedSubtype: sample.expectedSubtype,
    detectedSubtype: detected.label || "未识别",
    matched: detected.label === sample.expectedSubtype,
    evidence: detected.raw,
    sourceUrl: sample.url,
    sourcePage: sample.sourcePage,
    sourcePath,
    image: {
      width: variantPayload.sourceWidth,
      height: variantPayload.sourceHeight,
      scale: variantPayload.scale
    },
    text: mergedText,
    variants: variantResults
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureDir(sourceDir);
  await ensureDir(variantDir);

  const workers = await createOcrWorkers();
  const startedAt = new Date().toISOString();
  const results = [];

  try {
    for (const sample of args.samples) {
      const sourcePath = await downloadSample(sample);
      console.log(`OCR ${sample.id} ...`);
      const result = await recognizeSample(workers, sample, sourcePath);
      results.push(result);
      console.log(
        `  ${result.matched ? "PASS" : "FAIL"} expected=${result.expectedSubtype} detected=${result.detectedSubtype}`
      );
    }
  } finally {
    await workers.terminate();
  }

  if (!args.keepVariants) {
    await fs.rm(variantDir, { recursive: true, force: true });
  }

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    sampleCount: results.length,
    passCount: results.filter((item) => item.matched).length,
    failCount: results.filter((item) => !item.matched).length,
    results
  };
  await fs.writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`report: ${reportPath}`);
}

await main();
