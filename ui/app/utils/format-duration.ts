// Форматирование длительностей для страницы результата (#замеры, env SHOW_TIMINGS).
// Чистые функции — вынесены для юнит-тестов (как result-badges/matching-reasons/money).

// Живой таймер обработки: миллисекунды → «mm:ss» (с паддингом). 90_000 → "01:30".
// Отрицательное (рассинхрон часов) → "00:00". Минуты не обрезаем (>59 мин → "61:01").
export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Человекочитаемая длительность для лога: 740 → "740 мс", 45_300 → "45.3 с", 74_800 → "1 мин 15 с".
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} мс`
  const sec = ms / 1000
  // ≥59.95 c округлилось бы в "60.0 с" в секундной ветке → показываем минуты вместо вводящего в
  // заблуждение "60.0 с".
  if (sec < 59.95) return `${sec.toFixed(1)} с`
  const totalSec = Math.round(sec)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s ? `${m} мин ${s} с` : `${m} мин`
}

// Строка замеров для лога результата: «⏱ всего 48.5 с · агент 44.2 с · извлечение: ocr».
// `агент`/`извлечение` — только если backend их вернул (на ошибке агента agentMs/extractMethod нет).
// Точное время извлечения отдельно не меряется (остаток «всего−агент» включал бы ретрай-бэкофф),
// поэтому показываем МЕТОД извлечения (ocr/pdftotext/office) — частый ответ на «где медленно».
export function timingLine(file: { durationMs?: number | null, agentMs?: number | null, extractMethod?: string | null }): string {
  if (file.durationMs == null) return ''
  let s = `⏱ всего ${humanMs(file.durationMs)}`
  if (file.agentMs != null) s += ` · агент ${humanMs(file.agentMs)}`
  if (file.extractMethod) s += ` · извлечение: ${file.extractMethod}`
  return s
}
