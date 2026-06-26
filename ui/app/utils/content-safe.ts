// Санитизация недоверенного текста модели перед показом в UI (#320 follow-up). Агент формирует
// perf-заметки, `processingLog` и т.п., читая НЕДОВЕРЕННЫЙ документ поставщика. Vue экранирует HTML
// ({{ }}), но bidi/zero-width/управляющие символы могут «перевернуть» текст (Trojan Source) — например
// показать «Сделка создана» вместо «Ошибка». Вырезаем тот же класс символов, что и серверный путь
// отзывов (backend `stripHostileChars` в feedback.js: C0-контролы, bidi-оверрайды U+202A..U+202E /
// U+2066..U+2069, zero-width/BOM). Держим класс синхронным с backend и perf-diag.ts.
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g

/** Вырезать hostile-символы (Trojan Source) из недоверенной строки. Нестроку → пустая строка. */
export function stripHostileChars(input: unknown): string {
  return typeof input === 'string' ? input.replace(HOSTILE_CHARS, '') : ''
}
