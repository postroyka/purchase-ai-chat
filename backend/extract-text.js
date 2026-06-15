import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
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
// Bound scans: cap pages OCR'd and total characters fed to the agent. Conservative
// defaults keep CPU/RAM sane in the 1-CPU/768M app container (pdftoppm RAM grows with
// DPI × pages). Tunable via env if more capacity is available.
const MAX_OCR_PAGES = parseInt(process.env.MAX_OCR_PAGES || '8', 10);
const MAX_TEXT_CHARS = 100_000;
// OCR raster DPI — 150 is enough for invoice text and ~4× lighter on RAM than 300.
const OCR_DPI = process.env.OCR_DPI || '150';
// tesseract language packs that must be installed in the image (Dockerfile.app).
const OCR_LANGS = process.env.OCR_LANGS || 'rus+eng+bel';
// Hard cap per external process so a stuck pdftotext/tesseract/python can't wedge a job.
const CMD_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const OFFICE_EXTS = new Set(['.xlsx', '.xls', '.docx']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

// Hard per-process address-space cap for the external OCR/PDF binaries (#57). The python
// office path already self-limits via RLIMIT_AS; the node-spawned pdftotext/pdftoppm/tesseract
// did not. We wrap them in `prlimit --as=<bytes>` so a decompression-bomb / giant-page PDF
// fails THAT process with ENOMEM instead of growing until the cgroup OOM-kills the whole
// container (a DoS for every concurrent job). The default is generous — it won't kill normal
// invoice OCR — and is meant to be tuned DOWN per box via OCR_RLIMIT_AS_MB. Safe fallback: if
// prlimit is absent (non-Linux / not installed) we spawn directly — never break extraction.
const OCR_RLIMIT_AS_MB = parseInt(process.env.OCR_RLIMIT_AS_MB || '1536', 10);
const PRLIMIT_PATH = ['/usr/bin/prlimit', '/bin/prlimit', '/usr/sbin/prlimit', '/sbin/prlimit']
  .find((p) => { try { return existsSync(p); } catch { return false; } }) || null;

/**
 * Wrap a command in `prlimit --as=<bytes>` when a limiter is available and a positive cap is
 * set; otherwise return the command unchanged. Pure + injectable so it can be unit-tested
 * without spawning. @returns {{ cmd: string, args: string[] }}
 */
export function rlimitWrap(cmd, args, { asMb = OCR_RLIMIT_AS_MB, prlimitPath = PRLIMIT_PATH } = {}) {
  if (!prlimitPath || !(asMb > 0)) return { cmd, args };
  return { cmd: prlimitPath, args: [`--as=${asMb * 1024 * 1024}`, '--', cmd, ...args] };
}

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
    // Spawn under prlimit when available (#57). Error/log messages keep using the logical
    // `cmd` (e.g. "pdftotext"), not the prlimit wrapper, so they stay readable.
    const spawnTarget = rlimitWrap(cmd, args);
    const proc = spawn(spawnTarget.cmd, spawnTarget.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, CMD_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BUFFER) chunks.push(c);
    });
    proc.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${CMD_TIMEOUT_MS}ms`));
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
      if (size > MAX_BUFFER) console.warn(`[extract-text] ${cmd} stdout truncated: ${size} > ${MAX_BUFFER} bytes`);
      return resolve(Buffer.concat(chunks));
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
    await run('pdftoppm', ['-png', '-r', OCR_DPI, '-l', String(MAX_OCR_PAGES), filePath, join(dir, 'page')]);
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
