// Относительный путь (не '~/utils/...'): vitest резолвит этот модуль как импортируемый из
// композабла, а алиас '~' в его конфиге не настроен — '~/utils/...' уронит тест на резолве.
import { registerInvoiceBot } from '../utils/register-bot'
import { ensureDealSchema } from '../utils/ensure-schema'

/** Состояния экрана установки приложения. */
export type InstallState = 'installing' | 'done' | 'already' | 'standalone' | 'error'

/** Итог донастройки полей сделки (issue #176): не запускалась / всё ок / часть полей / не удалось. */
export type SchemaStatus = 'pending' | 'ok' | 'partial' | 'failed'

/** Сколько ждём готовности фрейма B24, прежде чем счесть, что страницу открыли вне портала. */
export const STANDALONE_HINT_MS = 8000

/**
 * Логика страницы установки локального приложения Битрикс24.
 *
 * Дожидается готовности фрейма B24 (он поднимается глобально в `app.vue` через
 * `useB24().init()`) и подтверждает установку вызовом `installFinish()` строго в install-режиме
 * — иначе SDK его отклоняет. Никакой донастройки портала здесь нет (см. `install.vue` и
 * `docs/BITRIX24_APP_SETUP.md`).
 *
 * Вынесено из `install.vue` в композабл ради юнит-тестируемости: проект тестирует композаблы,
 * а не монтирует SFC (ср. `ui/tests/useInstall.test.ts` и `ui/tests/useMetrics.test.ts`).
 *
 * @see https://apidocs.bitrix24.ru/settings/app-installation/installation-finish.html
 */
export function useInstall() {
  const b24 = useB24()
  const state = ref<InstallState>('installing')
  const errorMsg = ref('')
  // Не-фатальная подсказка: установка прошла, но бот не зарегистрировался (обычно — не выдан scope
  // imbot). Показываем на экране «готово», чтобы это не терялось в одном лишь console.warn (#217).
  const botWarning = ref('')
  // Итог автодонастройки полей сделки (issue #176): отражаем на экране «готово» — успех или причину.
  const schemaStatus = ref<SchemaStatus>('pending')
  const schemaMsg = ref('')

  // installFinish() допустимо вызвать строго один раз; триггер готовности фрейма может
  // сработать повторно — защищаемся флагом. Ставим его ТОЛЬКО когда фрейм реально получен,
  // поэтому при гонке (isInit() уже true, но get() ещё null) следующий триггер отработает.
  let handled = false

  async function finishInstall() {
    if (handled || !b24.isInit()) return
    const frame = b24.get()
    if (!frame) return
    handled = true

    try {
      // installFinish() работает только в install-режиме; при обычном открытии SDK реджектит.
      if (frame.isInstallMode) {
        // Регистрируем чат-бота (issue #217) ДО installFinish, best-effort: сбой (например, не выдан
        // scope imbot) НЕ должен срывать установку приложения. webhookUrl — наш backend на этом же
        // домене (страница установки открыта во фрейме из нашего origin).
        try {
          const webhookUrl = `${window.location.origin}/b24/bot/event`
          await registerInvoiceBot(frame, webhookUrl)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn('[install] регистрация бота не удалась (best-effort):', msg)
          botWarning.value = 'Приложение установлено, но чат-бот не зарегистрирован. Проверьте право «imbot» и переустановите.'
        }

        // Донастройка кастом-полей сделки (issue #176) — ДО installFinish и best-effort, по той же
        // причине, что и регистрация бота: Битрикс24 сразу после installFinish перезагружает фрейм,
        // и REST-вызов, отправленный ПОСЛЕ, был бы оборван. Метод идемпотентен. Сбой (обычно — не
        // выдан scope crm) НЕ срывает установку — показываем итог на экране «готово».
        try {
          const report = await ensureDealSchema(frame)
          if (report.ok) {
            schemaStatus.value = 'ok'
          } else {
            // report.ok=false (есть failed[]) достижимо ТОЛЬКО когда scope crm выдан и вызов дошёл до
            // создания поля, но оно не создалось — поэтому подсказку про «crm» тут НЕ даём (она для
            // ветки 'failed' ниже, где scope действительно мог быть не выдан).
            schemaStatus.value = 'partial'
            schemaMsg.value = `Не удалось создать часть полей сделки: ${report.failed.join(', ')}. Создайте их вручную (ensureSchema) или переустановите приложение.`
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn('[install] донастройка полей сделки не удалась (best-effort):', msg)
          schemaStatus.value = 'failed'
          schemaMsg.value = 'Поля сделки не настроены автоматически (нужно право «crm»). Их можно создать позже вызовом ensureSchema.'
        }

        await frame.installFinish()
        state.value = 'done'
      } else {
        state.value = 'already'
      }
    } catch (e) {
      state.value = 'error'
      errorMsg.value = e instanceof Error ? e.message : 'Неизвестная ошибка'
    }
  }

  // Фрейм поднимается в app.vue асинхронно — подтверждаем установку, как только он готов.
  watch(() => b24.isInit(), finishInstall, { immediate: true })

  // Фолбэк для запуска вне портала: фрейм там не поднимется, поэтому через паузу показываем
  // подсказку, что страницу открывает сам Битрикс24. Условие `!handled` — чтобы не перебить
  // медленный installFinish, который ещё выполняется (state при этом всё ещё 'installing').
  let standaloneTimer: ReturnType<typeof setTimeout> | null = null
  onMounted(() => {
    standaloneTimer = setTimeout(() => {
      if (!handled && state.value === 'installing') {
        state.value = 'standalone'
      }
    }, STANDALONE_HINT_MS)
  })
  onUnmounted(() => {
    if (standaloneTimer) clearTimeout(standaloneTimer)
  })

  return { state, errorMsg, botWarning, schemaStatus, schemaMsg }
}
