import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock spawn so we exercise the dispatch/branches without real poppler/tesseract/python.
// Tests set h.outputs[cmd] / h.codes[cmd] per external tool ('pdftotext'|'tesseract'|'python3'|'pdftoppm').
const h = vi.hoisted(() => ({ outputs: {}, codes: {} }));
vi.mock('node:child_process', () => ({
  spawn: (cmd) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setImmediate(() => {
      const out = h.outputs[cmd];
      if (out != null) proc.stdout.emit('data', Buffer.from(out));
      proc.emit('close', h.codes[cmd] ?? 0);
    });
    return proc;
  },
}));

const { extractDocumentText } = await import('../extract-text.js');

beforeEach(() => { h.outputs = {}; h.codes = {}; });

describe('extractDocumentText', () => {
  it('PDF with a text layer → method=pdftotext', async () => {
    h.outputs.pdftotext = 'СЧЁТ № 1\nПоставщик: ООО Тест, УНП 123456789\nИтого: 100';
    const r = await extractDocumentText('/x/invoice.pdf');
    expect(r).toMatchObject({ method: 'pdftotext' });
    expect(r.text).toContain('ООО Тест');
  });

  it('image → method=ocr (tesseract)', async () => {
    h.outputs.tesseract = 'OCR: счёт поставщик УНП 987654321';
    const r = await extractDocumentText('/x/scan.jpg');
    expect(r).toMatchObject({ method: 'ocr' });
    expect(r.text).toContain('987654321');
  });

  it('office (xlsx) → method=office (python helper)', async () => {
    h.outputs.python3 = '# Лист: 1\nПоставщик\tООО Тест\tУНП 123456789';
    const r = await extractDocumentText('/x/invoice.xlsx');
    expect(r).toMatchObject({ method: 'office' });
    expect(r.text).toContain('УНП 123456789');
  });

  it('truncates extracted text to MAX_TEXT_CHARS (100000)', async () => {
    h.outputs.pdftotext = 'A'.repeat(200_000);
    const r = await extractDocumentText('/x/big.pdf');
    expect(r.method).toBe('pdftotext');
    expect(r.text.length).toBe(100_000);
  });

  it('PDF: empty text layer → OCR fallback; no OCR output → null', async () => {
    h.outputs.pdftotext = '   ';      // < MIN_TEXT_CHARS → fallback to OCR
    // pdftoppm (mocked) produces no PNGs in the temp dir → ocrPdf yields null
    const r = await extractDocumentText('/x/blank-scan.pdf');
    expect(r).toBeNull();
  });

  it('PDF: pdftotext fails → OCR fallback → null when nothing OCR-able', async () => {
    h.codes.pdftotext = 1;            // pdftotext errors → caught → OCR path
    const r = await extractDocumentText('/x/broken.pdf');
    expect(r).toBeNull();
  });

  it('returns null for unsupported extensions', async () => {
    expect(await extractDocumentText('/x/note.txt')).toBeNull();
    expect(await extractDocumentText('/x/archive.zip')).toBeNull();
  });
});
