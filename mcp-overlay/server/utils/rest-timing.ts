import type { TypeB24, TypeCallParams } from '@bitrix24/b24jssdk'
import { callV2 } from '~/server/utils/sdk-helpers'
import { useLogger } from '~/server/utils/logger'

/**
 * REST-тайминг для procurement-инструментов (#262).
 *
 * Жалоба «долго обрабатывает» не различала, где теряется время: в «думании»
 * модели, в OCR-извлечении или в REST-запросах к Bitrix24. `agentMs`/`extractMs`/
 * `agentTurns` уже меряются на стороне backend (#222); не хватало разбивки по
 * самим REST-вызовам портала (`b24_pst_crm_find_*` / `create_deal`) — а портал/
 * сеть и есть главный подозреваемый на «медленно».
 *
 * Этот хелпер оборачивает `callV2` (`mcp/server/utils/sdk-helpers.ts` —
 * вендоренный upstream, его не трогаем) и логирует на стороне MCP **wall-time**
 * каждого вызова: REST-метод + длительность (мс) + признак успеха. Строка
 * структурирована и легко грепается по префиксу `[rest-timing]` в логах MCP-
 * контейнера. Серверную `duration` самого Bitrix (поле `time` в ответе) `callV2`
 * отбрасывает на вендоренной границе — её видно в сыром REST-ответе при ручной
 * диагностике (см. docs/PARSING_PERFORMANCE.md).
 *
 * Уровень — `notice` («normal but significant»): виден при дефолтном уровне
 * (INFO и выше), но семантически это диагностика, а не основной поток INFO.
 *
 * Скоуп: обёрнут только одиночный `callV2` (все 4 текущих инструмента ходят
 * именно через него). Пакетные `batchV2`/`batchV3` (задел под батчинг поиска
 * товаров) ещё не используются и сознательно НЕ покрыты — когда появятся, к ним
 * добавится отдельная обёртка `timedBatchV2`.
 *
 * @see docs/PARSING_PERFORMANCE.md — раздел «REST-тайминги к Bitrix24 (#262)»
 */

/** Имя метода для лога: убираем неймспейс `shef:purchase.api.` ради читаемости. */
function shortMethod(method: string): string {
  return method.replace(/^shef:purchase\.api\./, '')
}

/**
 * Залогировать тайминг одного REST-вызова.
 *
 * В строку намеренно идут ТОЛЬКО имя метода, длительность и признак успеха —
 * НЕ `params` и НЕ тело запроса. Так в лог не утекают УНП поставщика, номера
 * договоров, артикулы и base64-содержимое файла из `create_deal`. По той же
 * причине прогон через `logger-redactor` здесь не нужен — секретов в строке нет.
 */
function logRestTiming(method: string, ms: number, ok: boolean): void {
  void useLogger().notice(`[rest-timing] method=${shortMethod(method)} ms=${ms} ok=${ok}`)
}

/**
 * `callV2` с замером wall-time и логированием (#262). Drop-in замена прямого
 * `callV2` в procurement-инструментах — та же сигнатура, тот же возвращаемый
 * payload. Длительность меряется вокруг сетевого round-trip (включая TLS-
 * прогрев на первом вызове), `errorContext` не меняется. Логирует и успех, и
 * ошибку (с `ok=false`), затем пробрасывает исключение дальше.
 */
export async function timedCallV2<T>(
  b24: TypeB24,
  method: string,
  params: TypeCallParams | unknown[],
  errorContext: string,
): Promise<T | undefined> {
  const start = Date.now()
  try {
    const result = await callV2<T>(b24, method, params, errorContext)
    logRestTiming(method, Date.now() - start, true)
    return result
  } catch (err) {
    logRestTiming(method, Date.now() - start, false)
    throw err
  }
}
