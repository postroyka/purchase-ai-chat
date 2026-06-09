import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Python helper that reads office formats with maintained libs (openpyxl/xlrd/python-docx),
// avoiding the unpatched-in-npm SheetJS CVEs on untrusted uploads.
const DOC_PY = join(__dirname, 'doc_to_text.py');

// Below this many non-whitespace chars we treat a PDF as having no real text
// layer (a scan) and fall back to OCR.
const MIN_TEXT_CHARS = 24;
// Bound scans: cap pages OCR'd and total characters fed to the agent.
const MAX_OCR_PAGES = 15;
const MAX_TEXT_CHARS = 100_000;
// tesseract language packs that must be installed in the image (Dockerfile.app).
const OCR_LANGS = process.env.OCR_LANGS || 'rus+eng+bel';
// Hard cap per external process so a stuck pdftotext/tesseract/python can't wedge a job.
const CMD_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const OFFICE_EXTS = new Set(['.xlsx', '.xls', '.docx']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

/** @param {string} s @returns {number} length ignoring whitespace */
function meaningfulLen(s) {
  return s.replace(/\s+/g, '').length;
}

/**
 * Spawn a process and collect stdout. Async — does NOT block the event loop, so the
 * backend keeps serving /health and status polls while extraction/OCR runs.
 * Rejects on non-zero exit, spawn error (binary missing), or timeout.
 *
 * @param {string} cmd @param {string[]} args
 * @returns {Promise<Buffer>}
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), CMD_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BUFFER) chunks.push(c);
    });
    proc.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/**
 * Extract document text server-side so the agent works on plain text regardless of
 * the model's PDF/vision support. Dispatch by extension:
 *   .pdf            → pdftotext, then OCR fallback for scans;
 *   .png/.jpg/.jpeg → tesseract OCR;
 *   .xlsx/.xls/.docx→ Python helper (openpyxl/xlrd/python-docx).
 * Returns null for anything else (the agent reads it via FILE_PATH) or on failure.
 *
 * @param {string} filePath
 * @returns {Promise<{ text: string, method: 'pdftotext'|'ocr'|'office' }|null>}
 */
export async function extractDocumentText(filePath) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') return extractPdf(filePath);

  if (IMAGE_EXTS.has(ext)) {
    const text = await ocrImage(filePath);
    return text ? { text: text.slice(0, MAX_TEXT_CHARS), method: 'ocr' } : null;
  }

  if (OFFICE_EXTS.has(ext)) {
    try {
      const out = await run('python3', [DOC_PY, filePath]);
      const text = out.toString('utf8');
      return meaningfulLen(text) > 0 ? { text: text.slice(0, MAX_TEXT_CHARS), method: 'office' } : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** PDF: embedded text layer, else OCR. @returns {Promise<{text,method}|null>} */
async function extractPdf(filePath) {
  try {
    const out = await run('pdftotext', ['-layout', '-q', filePath, '-']);
    const text = out.toString('utf8');
    if (meaningfulLen(text) >= MIN_TEXT_CHARS) {
      return { text: text.slice(0, MAX_TEXT_CHARS), method: 'pdftotext' };
    }
  } catch {
    // pdftotext missing or failed → try OCR.
  }
  const text = await ocrPdf(filePath);
  return text ? { text: text.slice(0, MAX_TEXT_CHARS), method: 'ocr' } : null;
}

/** OCR a single image with tesseract. @returns {Promise<string|null>} */
async function ocrImage(filePath) {
  try {
    const out = await run('tesseract', [filePath, 'stdout', '-l', OCR_LANGS]);
    const text = out.toString('utf8');
    return meaningfulLen(text) > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Rasterise up to MAX_OCR_PAGES pages to PNG and OCR each. @returns {Promise<string|null>} */
async function ocrPdf(filePath) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'procure-ocr-'));
  } catch {
    return null;
  }
  try {
    await run('pdftoppm', ['-png', '-r', '300', '-l', String(MAX_OCR_PAGES), filePath, join(dir, 'page')]);
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    let text = '';
    for (const png of pages) {
      try {
        const out = await run('tesseract', [join(dir, png), 'stdout', '-l', OCR_LANGS]);
        text += out.toString('utf8') + '\n';
      } catch {
        // Skip a page that fails to OCR rather than failing the whole document.
      }
      if (meaningfulLen(text) >= MAX_TEXT_CHARS) break;
    }
    return meaningfulLen(text) > 0 ? text : null;
  } catch {
    return null; // pdftoppm missing / failed
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
