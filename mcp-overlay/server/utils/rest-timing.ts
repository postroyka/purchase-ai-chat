import type { AjaxResult, TypeB24, TypeCallParams } from '@bitrix24/b24jssdk'
import { Bitrix24ToolError, toToolError } from '~/server/utils/errors'
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
 * Хелпер `timedCallV2` инструментирует одиночный v2-вызов (через него ходят все
 * 4 инструмента) и логирует на стороне MCP две величины:
 *   - `ms`  — **wall-time** round-trip (включая сеть и TLS-прогрев на первом
 *             вызове) — то, что реально «видит» агент;
 *   - `srv` — **серверная** длительность Bitrix (`time.duration`, секунды → мс):
 *             сколько портал сам считал. Разница `ms − srv` ≈ сеть.
 * Это прямой ответ на исходную жалобу: видно, тормозит ли **портал** (большой
 * `srv`) или **сеть** (`srv` мал, `ms` велик). `srv` логируется, только когда
 * Bitrix вернул блок `time` (успех); при ошибке/без него поле опускается.
 *
 * Строка структурирована и легко грепается по префиксу `[rest-timing]` в логах
 * MCP-контейнера. Уровень — `notice` («normal but significant»): виден при
 * дефолтном уровне (INFO и выше), но семантически это диагностика.
 *
 * Почему прямой `b24.actions.v2.call.make`, а не вендоренный `callV2`
 * (`mcp/server/utils/sdk-helpers.ts`): `callV2` разворачивает ответ в `.result`
 * и **отбрасывает** конверт с `time`, поэтому серверную длительность из него не
 * достать. Обработка ошибок здесь — точная копия `callV2` (isSuccess →
 * `Bitrix24ToolError`, throw → `toToolError`); если на ре-вендоре семантика
 * `callV2` изменится, синхронизировать и тут. Сигнатуру `actions.v2.call.make`
 * сторожит overlay-typecheck (CI-джоб test-mcp-overlay, #154).
 *
 * Пакетные `batchV2`/`batchV3` ещё не используются и сознательно НЕ покрыты —
 * когда появятся (задел под батчинг поиска товаров), к ним добавится отдельная
 * обёртка `timedBatchV2`.
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
 * В строку намеренно идут ТОЛЬКО имя метода, длительности и признак успеха —
 * НЕ `params` и НЕ тело запроса. Так в лог не утекают УНП поставщика, номера
 * договоров, артикулы и base64-содержимое файла из `create_deal`. По той же
 * причине прогон через `logger-redactor` здесь не нужен — секретов в строке нет.
 *
 * @param srvMs серверная длительность Bitrix в мс (или `null`, если портал не
 *   вернул блок `time` — тогда поле `srv` в строку не попадает).
 */
function logRestTiming(method: string, ms: number, srvMs: number | null, ok: boolean): void {
  const srvPart = srvMs != null ? ` srv=${srvMs}` : ''
  void useLogger().notice(`[rest-timing] method=${shortMethod(method)} ms=${ms}${srvPart} ok=${ok}`)
}

/**
 * Вызвать v2-метод REST с замером wall-time и серверной длительности и
 * залогировать тайминг (#262). Drop-in замена прямого `callV2` в procurement-
 * инструментах: та же сигнатура и тот же возвращаемый payload (`result`), плюс
 * лог `[rest-timing]`. Логирует и успех, и ошибку (с `ok=false`), затем
 * пробрасывает исключение дальше.
 */
export async function timedCallV2<T>(
  b24: TypeB24,
  method: string,
  params: TypeCallParams | unknown[],
  errorContext: string,
): Promise<T | undefined> {
  const start = Date.now()
  let response: AjaxResult<T>
  try {
    // Mirror of callV2: the SDK types only object-shaped params, but the runtime
    // serialiser also honours positional arrays — single localised cast at the boundary.
    response = await b24.actions.v2.call.make<T>({
      method,
      params: Array.isArray(params) ? (params as unknown as TypeCallParams) : params,
    })
  } catch (err) {
    logRestTiming(method, Date.now() - start, null, false)
    throw toToolError(err, errorContext)
  }
  const wallMs = Date.now() - start
  if (!response.isSuccess) {
    logRestTiming(method, wallMs, null, false)
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  const data = response.getData()
  // time.duration — серверная длительность в СЕКУНДАХ (см. PayloadTime в SDK).
  const durationSec = data?.time?.duration
  const srvMs = typeof durationSec === 'number' ? Math.round(durationSec * 1000) : null
  logRestTiming(method, wallMs, srvMs, true)
  return data?.result
}
