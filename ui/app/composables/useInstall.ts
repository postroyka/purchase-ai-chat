/** Состояния экрана установки приложения. */
export type InstallState = 'installing' | 'done' | 'already' | 'standalone' | 'error'

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

  return { state, errorMsg }
}
