import type { B24Frame } from '@bitrix24/b24jssdk'

// Идемпотентная донастройка схемы сделки при установке приложения (issue #176).
//
// Вызывает наш REST-контроллер shef:purchase.api.procureinstall.ensureSchema через v2-экшен SDK
// (`frame.actions.v2.call.make` — актуальный API @bitrix24/b24jssdk; НЕ устаревший BX24.callMethod,
// ср. register-bot.ts). Контроллер ИДЕМПОТЕНТНО создаёт недостающие кастом-поля сделки
// (UF_CRM_DEAL_SH_PRCHS_AI_FILE — файл документа, UF_CRM_DEAL_DOGOVOR — договор) и возвращает отчёт.
//
// ⚠️ Требует scope `crm` (метод создаёт пользовательские поля). Без него REST вернёт ошибку — её
// разбирает вызывающий (best-effort, не срывает установку).
export const ENSURE_SCHEMA_METHOD = 'shef:purchase.api.procureinstall.ensureSchema'

/** Отчёт ensureSchema (поля checklist опускаем — для статуса установки нужен только итог по полям). */
export interface SchemaReport {
  ok: boolean // все нужные поля на месте и ничего не упало
  created: string[] // коды полей, созданных этим вызовом
  existing: string[] // коды полей, которые уже были
  failed: string[] // коды полей, которые создать не удалось
}

/**
 * Довести схему сделки до рабочего состояния. Бросает при ошибке REST/некорректном ответе —
 * вызывающий ловит (донастройка best-effort и не должна срывать installFinish).
 * @param frame активный B24Frame (внутри портала, в режиме установки)
 */
export async function ensureDealSchema(frame: B24Frame): Promise<SchemaReport> {
  const res = await frame.actions.v2.call.make<SchemaReport>({ method: ENSURE_SCHEMA_METHOD, params: {} })
  if (!res.isSuccess) {
    throw new Error(`${ENSURE_SCHEMA_METHOD}: ${res.getErrorMessages().join('; ')}`)
  }
  const report = res.getData()?.result
  // Контроллер отдаёт null при сбое загрузки модулей; ok/failed — обязательные поля отчёта.
  if (!report || typeof report.ok !== 'boolean' || !Array.isArray(report.failed)) {
    throw new Error(`${ENSURE_SCHEMA_METHOD}: некорректный ответ`)
  }
  return report
}
