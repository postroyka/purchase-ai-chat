// Pure, framework-free result-status presentation logic for the upload page (issues #192 / follow-up).
// Extracted so the "успех = создана сделка" rules — which carry the user-visible half of #192 — are
// unit-testable without a component-render harness.

export type BadgeColor
  = | 'air-primary'
    | 'air-primary-success'
    | 'air-primary-alert'
    | 'air-primary-warning'
    | 'air-secondary'
    | 'air-tertiary'

export type StatusKey = 'pending' | 'processing' | 'done' | 'error' | 'cancelled'

export interface ResultFile {
  status: StatusKey
  result?: unknown
}

export interface Badge { label: string, color: BadgeColor }

const STATUS_LABELS: Record<StatusKey, string> = {
  pending: 'Ожидание',
  processing: 'Обработка…',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено'
}
const STATUS_COLORS: Record<StatusKey, BadgeColor> = {
  pending: 'air-secondary',
  processing: 'air-primary',
  done: 'air-primary-success',
  error: 'air-primary-alert',
  cancelled: 'air-secondary'
}

// A created deal id is the ONLY success signal (prompts/main.md). Mirrors the backend's deal detection
// in processJob so the badge and the backend metrics/`problem` agree about whether a deal exists.
export function dealIdOf(file: ResultFile): string | null {
  const id = (file.result as { deal?: { dealId?: string | number | null } } | undefined)?.deal?.dealId
  if (id == null || String(id).trim() === '') return null
  return String(id)
}

export function fileSucceeded(file: ResultFile): boolean {
  return file.status === 'done' && dealIdOf(file) !== null
}

// Машинный код исхода агента (result.error: 'articles_not_in_catalog', 'tool_unavailable', …) — для
// разбора рядом с причиной (#221). Отдельно от человекочитаемого `problem` (#192) и транспортной
// ошибки задания. Не-строка/отсутствует → ''. Длину режем (защита вёрстки от мусора).
export function outcomeCodeOf(file: ResultFile): string {
  const err = (file.result as { error?: unknown } | undefined)?.error
  return typeof err === 'string' ? err.trim().slice(0, 64) : ''
}

// #329 (вариант A): сделка создаётся, но позиции БЕЗ артикула или с артикулом не из каталога в неё
// НЕ попадают (#258 не создаёт «свободные строки»). Чтобы «пустоватая» сделка не читалась как баг,
// оператору показывают заметный итог «N не внесено». Число берём из СТРУКТУРНОЙ телеметрии агента
// (matching.itemsWithoutArticle + длина matching.unmatchedArticles), а не из текста лога — без догадок.
// Невалидные/отрицательные/отсутствующие поля → 0.
export function notEnteredCount(file: ResultFile): number {
  const m = (file.result as { matching?: unknown } | undefined)?.matching
  if (!m || typeof m !== 'object') return 0
  const noArticleRaw = Number((m as { itemsWithoutArticle?: unknown }).itemsWithoutArticle)
  const noArticle = Number.isFinite(noArticleRaw) && noArticleRaw > 0 ? Math.trunc(noArticleRaw) : 0
  const unmatchedList = (m as { unmatchedArticles?: unknown }).unmatchedArticles
  const unmatched = Array.isArray(unmatchedList) ? unmatchedList.length : 0
  return noArticle + unmatched
}

// 'done' + deal → green "Готово"; 'done' WITHOUT a deal → amber "Без сделки"; otherwise the status default.
export function fileBadge(file: ResultFile): Badge {
  if (file.status === 'done' && dealIdOf(file) === null) {
    return { label: 'Без сделки', color: 'air-primary-warning' }
  }
  return { label: STATUS_LABELS[file.status] ?? file.status, color: STATUS_COLORS[file.status] ?? 'air-secondary' }
}

// Job badge: green "Готово" only when every file produced a deal; amber "Без сделок" (none) / "Частично"
// (some) so a batch where nothing — or only part — was created doesn't read as a clean success.
export function jobBadge(status: StatusKey, files: ResultFile[]): Badge {
  if (status === 'done') {
    const withDeal = files.filter(f => dealIdOf(f) !== null).length
    if (withDeal === 0) return { label: 'Без сделок', color: 'air-primary-warning' }
    if (withDeal < files.length) return { label: 'Частично', color: 'air-primary-warning' }
  }
  return { label: STATUS_LABELS[status] ?? status, color: STATUS_COLORS[status] ?? 'air-secondary' }
}
