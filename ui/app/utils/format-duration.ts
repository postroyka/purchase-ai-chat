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

// Метки классификации total-времени файла (backend, пороги TIMING_FAST_MS/TIMING_SLOW_MS).
export const SPEED_LABELS: Record<string, string> = { fast: 'быстро', normal: 'норма', slow: 'медленно' }

// Строка замеров для лога результата: «⏱ всего 48.5 с — норма · агент 44.2 с · извлечение: ocr 2.3 с».
// `— <скорость>`/`агент`/`извлечение` — только если backend их вернул (на ошибке агента нет agentMs).
// Извлечение: показываем МЕТОД (ocr/pdftotext/office) + точное ВРЕМЯ (`extractMs`, мерится отдельно
// вокруг extractFn в agent-runner — #203.2; раньше показывали только метод, т.к. время не мерили).
// Время показываем ТОЛЬКО при наличии метода (время без метки бессмысленно; backend всегда шлёт оба).
export function timingLine(
  file: { durationMs?: number | null, agentMs?: number | null, extractMethod?: string | null, extractMs?: number | null, speed?: string | null }
): string {
  if (file.durationMs == null) return ''
  let s = `⏱ всего ${humanMs(file.durationMs)}`
  if (file.speed && SPEED_LABELS[file.speed]) s += ` — ${SPEED_LABELS[file.speed]}`
  if (file.agentMs != null) s += ` · агент ${humanMs(file.agentMs)}`
  if (file.extractMethod) s += ` · извлечение: ${file.extractMethod}${file.extractMs != null ? ` ${humanMs(file.extractMs)}` : ''}`
  return s
}
