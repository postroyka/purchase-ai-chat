// Само-диагностика скорости агента (#279): извлечение записей feedback[] с kind:'perf' из result —
// что замедлило разбор. Показывается оператору в свёрнутом блоке (см. index.vue; HIDE_PERF_NOTE прячет блок).
// `note` — НЕДОВЕРЕННЫЙ вывод модели (она читает недоверенный документ). Vue экранирует HTML ({{ }}),
// но bidi/zero-width/управляющие символы могут «перевернуть» текст (Trojan Source) — вырезаем их тем же
// классом, что и серверный путь отзывов (backend stripHostileChars). Затем cap длины/числа — защита DOM.
// eslint-disable-next-line no-control-regex
const PERF_HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g

/** Достать perf-заметки агента из `result` файла: санитизация + cap 2000 символов и не более 5 записей. */
export function perfDiagNotes(result: unknown): string[] {
  const r = result as { feedback?: unknown } | null | undefined
  if (!r || typeof r !== 'object' || !Array.isArray(r.feedback)) return []
  return r.feedback
    .filter((f): f is { kind?: unknown, note?: unknown } => !!f && typeof f === 'object')
    .filter(f => f.kind === 'perf' && typeof f.note === 'string' && f.note.trim() !== '')
    .map(f => (f.note as string).replace(PERF_HOSTILE_CHARS, '').trim().slice(0, 2000)) // sanitize + cap
    .filter(note => note !== '') // после вырезания мог остаться пустой
    .slice(0, 5) // не более 5 записей
}
