// Общая проверка СОДЕРЖИМОГО файла по «магическим байтам». Используется обоими путями приёма
// файлов: веб-маршрутом /upload (backend/index.js) и границей скачивания чат-бота
// (b24-bot-api.js, issue #216) — чтобы оба применяли ОДИН и тот же контроль типа до того, как файл
// дойдёт до агента. Раньше /upload сверял magic-MIME, а бот — только расширение и размер.
import { fileTypeFromBuffer } from 'file-type';

// Обнаруженный MIME должен быть одним из этих. Неоднозначные контейнеры (zip / x-cfb) дополнительно
// сверяются с расширением ниже: application/zip → xlsx/docx, application/x-cfb (OLE2) → xls.
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'image/jpeg', // jpg/jpeg
  'image/png',  // png
  // Контейнеры ниже совпадают и с другими форматами — гейтятся проверкой расширения после detection.
  'application/zip',
  'application/x-cfb',
]);

// file-type нужно ≥4096 байт, чтобы надёжно определить OOXML (xlsx/docx). Сэмплируем только столько:
// /upload читает ровно столько с диска (fs.readSync), не загружая файл целиком — защита от zip-bomb DoS;
// бот сэмплирует первые байты уже скачанного (ограниченного maxBytes) буфера.
export const MIME_SNIFF_BYTES = 4100;

/**
 * Проверить СОДЕРЖИМОЕ файла (magic bytes) против разрешённых типов — те же правила, что в /upload.
 * Намеренно НЕ требует общего совпадения «расширение == MIME» (как и /upload): достаточно, чтобы
 * обнаруженный тип был разрешён; для контейнеров zip/x-cfb действует доп. сверка с расширением.
 * @param {Buffer|Uint8Array} buf  первые байты файла (желательно ≥ MIME_SNIFF_BYTES)
 * @param {string} ext  расширение в нижнем регистре без точки
 * @returns {Promise<{ ok: true, mime: string } | { ok: false, mime: string|null }>}
 */
export async function validateSniffedMime(buf, ext) {
  const e = String(ext).toLowerCase(); // защитно нормализуем расширение (gate-проверки fail-closed)
  const detected = await fileTypeFromBuffer(buf);
  const mime = detected?.mime ?? null;
  if (!mime || !ALLOWED_MIME_TYPES.has(mime)) return { ok: false, mime };
  // application/zip — структурный фолбэк для xlsx/docx: отклоняем, если расширение не из них.
  if (mime === 'application/zip' && !['xlsx', 'docx'].includes(e)) return { ok: false, mime };
  // application/x-cfb (OLE2 compound file) — подпись legacy .xls: отклоняем для остальных расширений.
  if (mime === 'application/x-cfb' && e !== 'xls') return { ok: false, mime };
  return { ok: true, mime };
}
