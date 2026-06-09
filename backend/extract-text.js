import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

// Below this many non-whitespace chars we treat the PDF as having no real text
// layer (i.e. a scan) and fall back to OCR.
const MIN_TEXT_CHARS = 24;
// Don't OCR unbounded scans — cap pages and total characters fed to the agent.
const MAX_OCR_PAGES = 15;
const MAX_TEXT_CHARS = 100_000;
// tesseract language packs that must be installed in the image (Dockerfile.app).
const OCR_LANGS = process.env.OCR_LANGS || 'rus+eng';
// Hard cap per external process so a stuck pdftotext/tesseract can't wedge a job.
const CMD_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** @param {string} s @returns {number} length ignoring whitespace */
function meaningfulLen(s) {
  return s.replace(/\s+/g, '').length;
}

/**
 * Spawn a process and collect stdout. Async (does NOT block the event loop —
 * the backend keeps serving /health and status polls while OCR runs).
 * Rejects on non-zero exit, spawn error (e.g. binary missing), or timeout.
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
 * Extract document text server-side so the agent works on plain text, regardless
 * of whether the model can read PDFs/images. Currently handles PDF:
 *   1) text layer via `pdftotext`;
 *   2) if absent (scanned image) → OCR via `pdftoppm` + `tesseract`.
 *
 * Returns null for formats not handled here (the agent reads them via FILE_PATH).
 *
 * @param {string} filePath
 * @returns {Promise<{ text: string, method: 'pdftotext'|'ocr' }|null>}
 */
export async function extractDocumentText(filePath) {
  if (extname(filePath).toLowerCase() !== '.pdf') return null;

  // 1) Embedded text layer.
  try {
    const out = await run('pdftotext', ['-layout', '-q', filePath, '-']);
    const text = out.toString('utf8');
    if (meaningfulLen(text) >= MIN_TEXT_CHARS) {
      return { text: text.slice(0, MAX_TEXT_CHARS), method: 'pdftotext' };
    }
  } catch {
    // pdftotext missing or failed → try OCR.
  }

  // 2) OCR fallback for scanned PDFs.
  const text = await ocrPdf(filePath);
  return text ? { text: text.slice(0, MAX_TEXT_CHARS), method: 'ocr' } : null;
}

/**
 * Rasterise up to MAX_OCR_PAGES pages to PNG and OCR each with tesseract.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
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
