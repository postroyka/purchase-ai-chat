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

// Русское склонение по числу: forms = [одна, две‑четыре, пять+]. plural(1,…)→[0]; 2→[1]; 5→[2]; 11→[2].
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

// Строка замеров для лога результата:
//   «⏱ всего 48.5 с · агент 44.2 с (12 ходов) · извлечение: ocr 2.3 с».
// Метка скорости добавляется ТОЛЬКО для «быстро» (см. ниже); `агент`/`извлечение` — только если
// backend их вернул (на ошибке агента нет agentMs).
// Агент: время + число ходов (#222 «думает vs ищет»): много ходов = агент много раз ходил в
//   инструменты (поиск/итерации); мало ходов при большом времени = модель дольше «думала» на ход.
// Извлечение: МЕТОД (ocr/pdftotext/office) + точное ВРЕМЯ (`extractMs`, мерится вокруг extractFn —
//   #203.2). Время показываем ТОЛЬКО при наличии метода (время без метки бессмысленно; backend шлёт оба).
export function timingLine(
  file: { durationMs?: number | null, agentMs?: number | null, agentTurns?: number | null, toolMs?: number | null, extractMethod?: string | null, extractMs?: number | null, speed?: string | null }
): string {
  if (file.durationMs == null) return ''
  let s = `⏱ всего ${humanMs(file.durationMs)}`
  // Метку скорости показываем ТОЛЬКО для «быстро» (позитив). «медленно»/«норма» убраны из ТЕКСТА,
  // чтобы заранее не настраивать пользователя на негатив; цвет (амбер для slow) задаётся в шаблоне
  // по file.speed и сохраняется. /metrics-дашборд использует свой словарь меток, не этот.
  if (file.speed === 'fast') s += ` — ${SPEED_LABELS.fast}`
  if (file.agentMs != null) {
    s += ` · агент ${humanMs(file.agentMs)}`
    if (file.agentTurns != null) s += ` (${file.agentTurns} ${plural(file.agentTurns, ['ход', 'хода', 'ходов'])})`
    // toolMs (#262 Шаг 2): сколько из времени агента ушло на инструменты (≈ ожидание REST к Bitrix24),
    // остальное — «думание» модели. Показываем только когда заметно (≥100 мс), чтобы не шуметь.
    if (file.toolMs != null && file.toolMs >= 100) s += ` (из них инструменты ${humanMs(file.toolMs)})`
  }
  if (file.extractMethod) s += ` · извлечение: ${file.extractMethod}${file.extractMs != null ? ` ${humanMs(file.extractMs)}` : ''}`
  return s
}
