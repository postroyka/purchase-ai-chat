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
// #267: гибридный PDF (таблица — текстовый слой, шапка/печать с УНП — картинка). Если в текстовом
// слое нет налогового номера, OCR'им страницы и подмешиваем реквизиты со скана, резервируя под них
// этот бюджет символов, чтобы УНП не срезался лимитом MAX_TEXT_CHARS.
const OCR_SUPPLEMENT_BUDGET = 8_000;
const OCR_SUPPLEMENT_HEADER = '=== OCR со скана (реквизиты поставщика/договора; НЕ источник товарных позиций) ===';
// OCR raster DPI — 150 is enough for invoice text and ~4× lighter on RAM than 300.
const OCR_DPI = process.env.OCR_DPI || '150';
// #267: гибридный-PDF OCR-фолбэк нацелен на МЕЛКИЙ УНП в шапке/печати, поэтому растеризуем плотнее
// (300 DPI) и только первые страницы (реквизиты в шапке) — это и улучшает распознавание печати, и
// держит стоимость/RAM в узде (1–2 стр. @300 дешевле 8 стр. @150 по худшему случаю).
const OCR_FALLBACK_DPI = process.env.OCR_FALLBACK_DPI || '300';
const OCR_FALLBACK_PAGES = parseInt(process.env.OCR_FALLBACK_PAGES || '2', 10);
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
// container (a DoS for every concurrent job).
//
// The cap MUST sit BELOW the container memory limit to be useful (otherwise cgroup-OOM fires
// first and kills everything): default 640 MB vs the prod 768 MB container, leaving headroom for
// the Node parent. Generous enough for normal single-page invoice OCR; tune via OCR_RLIMIT_AS_MB.
// Safe fallback: if prlimit is absent (non-Linux / not installed) we spawn directly — never break
// extraction (and warn once on Linux so a silently-unprotected prod is visible in logs).
const OCR_RLIMIT_AS_MB = parseInt(process.env.OCR_RLIMIT_AS_MB || '640', 10);
const PRLIMIT_PATH = ['/usr/bin/prlimit', '/bin/prlimit', '/usr/sbin/prlimit', '/sbin/prlimit']
  .find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
if (!PRLIMIT_PATH && process.platform === 'linux' && OCR_RLIMIT_AS_MB > 0) {
  console.warn('[extract-text] prlimit not found — OCR/PDF binaries run WITHOUT a memory cap (#57). Install util-linux.');
}

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

// #334: офисная книга (XLS/XLSX) может содержать НЕСКОЛЬКО листов — doc_to_text.py выводит их
// подряд, каждый с заголовком «# Лист: …». Слепой slice(0, MAX_TEXT_CHARS) может МОЛЧА отрезать
// поздние листы (напр. лист со спецификацией/позициями), и агент их просто не увидит. Делаем
// обрезку ВИДИМОЙ: ставим маркер в конце и пишем предупреждение в лог — потеря листов перестаёт
// быть тихой. Маркер укладываем В лимит (режем под него), чтобы итог не превышал MAX_TEXT_CHARS.
const OFFICE_TRUNC_NOTICE =
  '\n\n[⚠ Извлечённый текст обрезан по лимиту: часть листов/строк книги (см. «# Лист: …») могла не попасть. Нужные реквизиты или позиции могут быть на необрезанных листах исходного файла.]';

/**
 * Обрезать офисный текст до MAX_TEXT_CHARS с видимым маркером, если он не уместился.
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function capOfficeText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  const room = Math.max(0, MAX_TEXT_CHARS - OFFICE_TRUNC_NOTICE.length);
  return { text: text.slice(0, room) + OFFICE_TRUNC_NOTICE, truncated: true };
}

// #267: есть ли в тексте налоговый номер поставщика (РБ УНП = 9 цифр; РФ ИНН = 10/12 цифр).
// Используется, чтобы понять, попал ли в извлечённый текст ключевой реквизит — без него агент не
// найдёт поставщика и встанет на шаге 1. Детектор **только по ключевому слову** рядом с числом
// (надёжно для нормальных счётов: «УНП 123456789», «ИНН: 1234567890», с пробелами/дефисами).
// СОЗНАТЕЛЬНО НЕ ловим «голое» 9-значное число: счета пестрят 9-значными (номер счёта, телефон,
// код), и такое ложное «номер есть» ГЛУШИЛО БЫ OCR-фолбэк ровно на гибридных счетах, ради которых
// он и нужен. Лучше лишний (безопасный) OCR, чем тихо не добытый УНП.
const TAX_ID_KEYWORD_RE = /(УН[ПН]|ИНН|UNP|INN)\s*[:.№#-]*\s*\d[\d\s-]{7,13}\d/iu;
export function hasTaxId(text) {
  if (typeof text !== 'string' || !text) return false;
  return TAX_ID_KEYWORD_RE.test(text);
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
 * @returns {Promise<{ text: string, method: 'pdftotext'|'pdftotext_ocr'|'ocr'|'office' }|null>}
 */
export async function extractDocumentText(filePath) {
  const ext = extname(filePath).toLowerCase();
  let result = null;

  if (ext === '.pdf') {
    result = await extractPdf(filePath);
  } else if (IMAGE_EXTS.has(ext)) {
    const text = await ocrImage(filePath);
    result = text ? { text: text.slice(0, MAX_TEXT_CHARS), method: 'ocr' } : null;
  } else if (OFFICE_EXTS.has(ext)) {
    try {
      const out = await run('python3', [DOC_PY, filePath]);
      const raw = out.toString('utf8');
      if (meaningfulLen(raw) > 0) {
        const { text, truncated } = capOfficeText(raw);
        if (truncated) {
          // Видимый сигнал в логах: многостраничная книга не уместилась в лимит, поздние листы
          // (часто — лист с позициями) могли быть отрезаны. См. маркер в самом тексте (#334).
          console.warn(`[extract-text] office-текст обрезан до ${MAX_TEXT_CHARS} символов для ${filePath} — поздние листы книги (# Лист: …) могли не попасть (#334)`);
        }
        result = { text, method: 'office' };
      } else {
        result = null;
      }
    } catch {
      result = null;
    }
  }

  // #267 диагностика: явно сигналим, когда в извлечённом тексте НЕТ налогового номера — это
  // отличает «реквизита нет в документе» от «OCR/pdftotext его не добил». Без УНП агент встанет на
  // шаге 1 (поиск поставщика), поэтому такой случай стоит видеть в логах.
  if (result && !hasTaxId(result.text)) {
    console.warn(`[extract-text] налоговый номер (УНП/ИНН) НЕ найден в извлечённом тексте (способ=${result.method}) для ${filePath} — агент может не найти поставщика (#267)`);
  }

  return result;
}

/** PDF: embedded text layer, else OCR. @returns {Promise<{text,method}|null>} */
async function extractPdf(filePath) {
  let layerText = null;
  try {
    const out = await run('pdftotext', ['-layout', '-q', filePath, '-']);
    const text = out.toString('utf8');
    if (meaningfulLen(text) >= MIN_TEXT_CHARS) layerText = text;
  } catch {
    // pdftotext missing or failed → try OCR.
  }

  if (layerText) {
    // Есть текстовый слой с налоговым номером — это нормальный текстовый PDF, OCR не нужен.
    if (hasTaxId(layerText)) {
      return { text: layerText.slice(0, MAX_TEXT_CHARS), method: 'pdftotext' };
    }
    // #267: текст есть, но УНП/ИНН в нём НЕТ — частый случай гибридного счёта, где шапка/печать с
    // реквизитами вшита картинкой. OCR'им страницы и, если OCR добыл налоговый номер, подмешиваем
    // его как ОТДЕЛЬНУЮ секцию «реквизиты со скана», сохраняя чистую табличную часть из текстового
    // слоя (чтобы не зашуметь позиции и не задвоить их). OCR-секцию помечаем — промпт берёт из неё
    // только реквизиты, не товарные строки.
    const ocr = await ocrPdf(filePath, { dpi: OCR_FALLBACK_DPI, maxPages: OCR_FALLBACK_PAGES });
    if (ocr && hasTaxId(ocr)) {
      const head = layerText.slice(0, MAX_TEXT_CHARS - OCR_SUPPLEMENT_BUDGET - OCR_SUPPLEMENT_HEADER.length - 4);
      const merged = `${head}\n\n${OCR_SUPPLEMENT_HEADER}\n${ocr.slice(0, OCR_SUPPLEMENT_BUDGET)}`;
      return { text: merged.slice(0, MAX_TEXT_CHARS), method: 'pdftotext_ocr' };
    }
    // OCR не добавил налоговый номер (или недоступен) — отдаём текстовый слой как есть.
    return { text: layerText.slice(0, MAX_TEXT_CHARS), method: 'pdftotext' };
  }

  // Нет читаемого текстового слоя → скан → полностраничный OCR.
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

/**
 * Rasterise up to `maxPages` pages to PNG and OCR each.
 * @param {string} filePath
 * @param {{ dpi?: string, maxPages?: number }} [opts] — override raster DPI / page cap (#267 fallback
 *   uses higher DPI + fewer pages for small УНП in the header). Defaults: OCR_DPI / MAX_OCR_PAGES.
 * @returns {Promise<string|null>}
 */
async function ocrPdf(filePath, { dpi = OCR_DPI, maxPages = MAX_OCR_PAGES } = {}) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'procure-ocr-'));
  } catch {
    return null;
  }
  try {
    await run('pdftoppm', ['-png', '-r', String(dpi), '-l', String(maxPages), filePath, join(dir, 'page')]);
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
