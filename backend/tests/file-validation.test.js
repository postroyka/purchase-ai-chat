import { describe, it, expect } from 'vitest';
import { validateSniffedMime, ALLOWED_MIME_TYPES, MIME_SNIFF_BYTES } from '../file-validation.js';

// Минимальные «магические байты» форматов (как в upload.test.js): достаточно для детекции file-type.
const PDF = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // сигнатура PNG
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // чанк IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]); // PK\x03\x04 → application/zip
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]); // OLE2 → application/x-cfb
const ZEROS = Buffer.alloc(64);

describe('validateSniffedMime', () => {
  it('валидный PDF → ok', async () => {
    expect(await validateSniffedMime(PDF, 'pdf')).toEqual({ ok: true, mime: 'application/pdf' });
  });

  it('валидный PNG/JPEG → ok', async () => {
    expect((await validateSniffedMime(PNG, 'png')).ok).toBe(true);
    expect((await validateSniffedMime(JPEG, 'jpg')).ok).toBe(true);
  });

  it('нераспознанное содержимое (нули) → не ok, mime null', async () => {
    expect(await validateSniffedMime(ZEROS, 'pdf')).toEqual({ ok: false, mime: null });
  });

  it('application/zip разрешён только для xlsx/docx', async () => {
    expect((await validateSniffedMime(ZIP, 'xlsx')).ok).toBe(true);
    expect((await validateSniffedMime(ZIP, 'docx')).ok).toBe(true);
    expect(await validateSniffedMime(ZIP, 'pdf')).toEqual({ ok: false, mime: 'application/zip' });
  });

  it('application/x-cfb (OLE2) разрешён только для xls', async () => {
    expect((await validateSniffedMime(CFB, 'xls')).ok).toBe(true);
    expect(await validateSniffedMime(CFB, 'pdf')).toEqual({ ok: false, mime: 'application/x-cfb' });
  });

  it('экспортирует общий набор типов и размер сэмпла', () => {
    expect(ALLOWED_MIME_TYPES.has('application/pdf')).toBe(true);
    expect(MIME_SNIFF_BYTES).toBeGreaterThanOrEqual(4096);
  });
});
