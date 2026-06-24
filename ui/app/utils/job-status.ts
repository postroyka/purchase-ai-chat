// #280: единая «терминализация» задания при неустранимой ошибке опроса статуса.
//
// Когда поллинг `/job/:id/status` устойчиво падает (несколько 5xx/таймаутов подряд), задание нельзя
// оставлять в «Обработка…»: per-file строки и таймер на странице берут статус ИЗ ФАЙЛОВ, поэтому
// мало пометить ошибкой само задание — нужно перевести в `error` и все ещё НЕ завершённые файлы
// (`processing`/`pending`). Завершённые (`done`/`error`/`cancelled`) не трогаем — их работа сделана.
//
// Чистая функция (без Vue/реактивности) → юнит-тестируемо; возвращает НОВЫЙ объект (иммутабельно).

export interface FailableFile {
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled'
  error?: string | null
  [k: string]: unknown
}
export interface FailableJob {
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled'
  files: FailableFile[]
  [k: string]: unknown
}

const ACTIVE = new Set(['pending', 'processing'])

/**
 * Перевести задание и его незавершённые файлы в `error` с понятной причиной.
 * @param job текущее задание (может быть null — тогда вернётся null)
 * @param message текст ошибки для файлов без собственной причины
 */
export function failActiveFiles<T extends FailableJob | null | undefined>(job: T, message: string): T {
  if (!job) return job
  return {
    ...job,
    status: 'error',
    files: job.files.map(f =>
      ACTIVE.has(f.status) ? { ...f, status: 'error', error: f.error ?? message } : f
    )
  }
}
