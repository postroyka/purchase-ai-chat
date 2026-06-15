<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <B24Card class="w-full max-w-md rounded-xl" :b24ui="{ body: 'p-8 text-center' }">
      <!-- Штатный сценарий: пользователь видит только индикатор и «Идёт установка…». -->
      <template v-if="state === 'installing'">
        <B24Progress
          :model-value="null"
          animation="carousel"
          color="air-primary"
          size="xs"
        />
        <h1 class="mt-6 text-lg font-semibold text-base-master">
          Идёт установка…
        </h1>
        <p class="mt-2 text-sm text-base-500">
          Настраиваем приложение в вашем Битрикс24.
        </p>
      </template>

      <!-- Установка подтверждена. Обычно Битрикс24 сразу перезагружает фрейм на основной
           интерфейс, поэтому этот экран пользователь чаще всего не успевает увидеть. -->
      <B24Alert
        v-else-if="state === 'done'"
        color="air-primary-success"
        title="Готово"
        description="Приложение установлено. Открываем…"
      />

      <!-- Приложение открыли не в режиме установки (уже установлено) — installFinish не зовём. -->
      <B24Alert
        v-else-if="state === 'already'"
        color="air-primary-success"
        title="Приложение уже установлено"
        description="Откройте его в левом меню Битрикс24."
      />

      <!-- Страницу открыли вне портала (напрямую в браузере): фрейм Битрикс24 не поднимется. -->
      <B24Alert
        v-else-if="state === 'standalone'"
        color="air-primary-warning"
        title="Откройте внутри Битрикс24"
        description="Это установщик приложения — его показывает сам Битрикс24 при первом открытии. Отдельно открывать страницу не нужно."
      />

      <!-- Непредвиденная ошибка завершения установки. -->
      <B24Alert
        v-else
        color="air-primary-alert"
        title="Не удалось завершить установку"
        :description="errorMsg"
      />
    </B24Card>
  </div>
</template>

<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

/**
 * Страница установки приложения — обработчик «Путь для первоначальной установки» в
 * настройках локального приложения Битрикс24.
 *
 * Битрикс24 показывает её во фрейме при ПЕРВОМ открытии приложения и считает приложение
 * «не установленным» (интерфейс заблокирован), пока со страницы не будет вызван
 * `installFinish()`. Поэтому единственная задача страницы — дождаться готовности фрейма
 * Битрикс24 и подтвердить установку.
 *
 * Донастройки (поля сделки, события, виджеты) здесь намеренно нет — её добавим позже,
 * когда будем расширять приложение. Сам фрейм инициализируется глобально в `app.vue`
 * (`useB24().init()`), поэтому здесь мы только реагируем на его готовность.
 *
 * @see https://apidocs.bitrix24.ru/settings/app-installation/installation-finish.html
 */
definePageMeta({ layout: false })

type InstallState = 'installing' | 'done' | 'already' | 'standalone' | 'error'

const b24 = useB24()
const state = ref<InstallState>('installing')
const errorMsg = ref('')

// installFinish() допустимо вызвать строго один раз, а реактивный триггер готовности
// может сработать повторно — поэтому защищаемся флагом.
let handled = false

async function finishInstall() {
  if (handled || !b24.isInit()) return
  handled = true

  const frame = b24.get() as B24Frame | undefined
  if (!frame) {
    handled = false // фрейм ещё не присвоен — пусть следующий триггер попробует снова
    return
  }

  try {
    // installFinish() работает только в режиме установки; при обычном открытии SDK его
    // отклоняет с ошибкой. Поэтому проверяем режим и зря метод не дёргаем.
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

// Фолбэк для запуска вне портала: там фрейм не поднимется никогда, поэтому через паузу
// показываем подсказку, что страницу открывает сам Битрикс24.
const STANDALONE_HINT_MS = 8000
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
</script>
