import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

// Mock spawn so we exercise the dispatch/branches without real poppler/tesseract/python.
// Tests set h.outputs[cmd] / h.codes[cmd] per external tool ('pdftotext'|'tesseract'|'python3'|'pdftoppm').
const h = vi.hoisted(() => ({ outputs: {}, codes: {} }));
vi.mock('node:child_process', () => ({
  spawn: (cmd, args) => {
    // #57: prod wraps OCR binaries as `prlimit --as=… -- <cmd> …`. Unwrap so the mock keys on
    // the logical command (real binary is the token after '--'), independent of whether the
    // test runner actually has prlimit installed.
    if (typeof cmd === 'string' && cmd.endsWith('prlimit') && Array.isArray(args)) {
      const sep = args.indexOf('--');
      if (sep >= 0 && args[sep + 1]) cmd = args[sep + 1];
    }
    // ocrPdf разворачивает PNG-страницы во временную папку и читает их readdirSync. Реальный pdftoppm
    // тут замокан, поэтому, чтобы пройти OCR-ветку, создаём фиктивный page-1.png по тому же префиксу,
    // что передаёт ocrPdf (последний аргумент pdftoppm = join(dir,'page')). Иначе папка пуста → null.
    if (cmd === 'pdftoppm' && Array.isArray(args) && (h.codes.pdftoppm ?? 0) === 0) {
      const prefix = args[args.length - 1];
      try { writeFileSync(`${prefix}-1.png`, 'PNG'); } catch { /* best-effort */ }
    }
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

const { extractDocumentText, rlimitWrap, hasTaxId, OFFICE_TRUNC_NOTICE } = await import('../extract-text.js');

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

  it('#334 office: многостраничная книга — ВСЕ листы доходят до агента целиком', async () => {
    // doc_to_text.py выводит листы подряд: реквизиты на одном листе, позиции — на другом.
    h.outputs.python3 = [
      '# Лист: Реквизиты',
      'Поставщик\tООО Тест\tУНП 123456789',
      '# Лист: Спецификация',
      'Цемент М500\t10\t12.50',
    ].join('\n');
    const r = await extractDocumentText('/x/multi.xls');
    expect(r.method).toBe('office');
    expect(r.text).toContain('# Лист: Реквизиты');
    expect(r.text).toContain('УНП 123456789');     // первый лист не потерян
    expect(r.text).toContain('# Лист: Спецификация');
    expect(r.text).toContain('Цемент М500');        // второй лист тоже на месте
  });

  it('#334 office: текст больше лимита → обрезан РОВНО до MAX_TEXT_CHARS с маркером в конце', async () => {
    // Имитируем огромную книгу: первый лист заполняет весь бюджет, дальше — лист с позициями.
    h.outputs.python3 = '# Лист: Реквизиты\n' + 'A'.repeat(200_000) + '\n# Лист: Позиции\nЦемент';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await extractDocumentText('/x/huge.xlsx');
    expect(r.method).toBe('office');
    expect(r.text.length).toBe(100_000);                  // ровно лимит (маркер уложен В бюджет)
    expect(r.text.endsWith(OFFICE_TRUNC_NOTICE)).toBe(true); // маркер целиком в самом конце
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('#334')); // потеря видна в логах
    warnSpy.mockRestore();
  });

  it('#334 office: текст В пределах лимита → без маркера и без warn', async () => {
    h.outputs.python3 = '# Лист: 1\nПоставщик\tООО Тест\tУНП 123456789';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await extractDocumentText('/x/small.xlsx');
    expect(r.text.includes(OFFICE_TRUNC_NOTICE)).toBe(false);
    // единственный возможный warn здесь — про отсутствие УНП (#267); маркер обрезки (#334) НЕ зовётся
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('обрезан'));
    warnSpy.mockRestore();
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

  describe('#267 — гибридный PDF: УНП из шапки-картинки через OCR-фолбэк', () => {
    it('текстовый слой БЕЗ УНП + OCR С УНП → method=pdftotext_ocr, текст содержит и таблицу, и УНП', async () => {
      // таблица — текстовый слой (позиции/цены), но налогового номера в ней НЕТ
      h.outputs.pdftotext = 'Наименование Цена Кол-во\nЦемент М500 12.50 10\nИтого: 125.00 BYN';
      // шапка/печать распознана OCR — здесь УНП
      h.outputs.tesseract = 'ООО «Вершина-строй» УНП 191098607\nСчёт № 873';
      const r = await extractDocumentText('/x/hybrid.pdf');
      expect(r.method).toBe('pdftotext_ocr');
      expect(r.text).toContain('Цемент М500');         // табличная часть сохранена
      expect(r.text).toContain('191098607');            // УНП добыт из OCR-секции
      expect(r.text).toContain('OCR со скана');         // секция помечена
    });

    it('текстовый слой С УНП → OCR не запускается (method=pdftotext)', async () => {
      h.outputs.pdftotext = 'Поставщик ООО Тест, УНП 123456789\nЦемент 10 шт';
      h.outputs.tesseract = 'этот OCR не должен попасть в результат 999999999';
      const r = await extractDocumentText('/x/textlayer.pdf');
      expect(r.method).toBe('pdftotext');
      expect(r.text).not.toContain('не должен попасть');
    });

    it('текстовый слой без УНП и OCR тоже без УНП → отдаём текстовый слой (method=pdftotext)', async () => {
      h.outputs.pdftotext = 'Накладная без реквизитов\nТовар А 5 шт\nТовар Б 3 шт';
      h.outputs.tesseract = 'смазанный скан без распознанного номера';
      const r = await extractDocumentText('/x/noid.pdf');
      expect(r.method).toBe('pdftotext');
    });
  });

  describe('hasTaxId', () => {
    it('находит УНП/ИНН по ключевому слову (в т.ч. с пробелами/дефисами)', () => {
      expect(hasTaxId('УНП 191098607')).toBe(true);
      expect(hasTaxId('ИНН: 1234567890')).toBe(true);
      expect(hasTaxId('ИНН 123456789012')).toBe(true);
      expect(hasTaxId('УНП 191-098-607')).toBe(true);
      expect(hasTaxId('УНП 191 098 607')).toBe(true);
    });
    it('НЕ считает голое 9-значное число налоговым номером (иначе глушился бы OCR-фолбэк)', () => {
      expect(hasTaxId('реквизит 191098607 в тексте')).toBe(false); // нет ключевого слова
      expect(hasTaxId('Счёт № 191098607 от 22.06.2026')).toBe(false);
    });
    it('не срабатывает на тексте без номеров и на пустом вводе', () => {
      expect(hasTaxId('просто текст без номеров')).toBe(false);
      expect(hasTaxId('счёт № 873 от 22.06.2026, сумма 125.00')).toBe(false);
      expect(hasTaxId('')).toBe(false);
      expect(hasTaxId(null)).toBe(false);
    });
  });
});

describe('rlimitWrap (#57 — memory cap for OCR/PDF binaries)', () => {
  it('wraps in prlimit --as=<bytes> when a limiter path + positive cap are given', () => {
    const { cmd, args } = rlimitWrap('tesseract', ['scan.png', 'stdout'], { asMb: 1024, prlimitPath: '/usr/bin/prlimit' });
    expect(cmd).toBe('/usr/bin/prlimit');
    expect(args).toEqual(['--as=1073741824', '--', 'tesseract', 'scan.png', 'stdout']);
  });

  it('falls back to a direct spawn when prlimit is unavailable (never breaks extraction)', () => {
    expect(rlimitWrap('pdftotext', ['-layout', 'f.pdf'], { asMb: 1024, prlimitPath: null }))
      .toEqual({ cmd: 'pdftotext', args: ['-layout', 'f.pdf'] });
  });

  it('falls back when the cap is non-positive (disabled)', () => {
    expect(rlimitWrap('pdftoppm', ['-png'], { asMb: 0, prlimitPath: '/usr/bin/prlimit' }))
      .toEqual({ cmd: 'pdftoppm', args: ['-png'] });
  });
});
