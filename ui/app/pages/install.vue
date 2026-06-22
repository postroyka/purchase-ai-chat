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
      <!-- Не-фатальная подсказка: установка прошла, но бот не зарегистрировался (#217). -->
      <p v-if="state === 'done' && botWarning" class="mt-3 text-xs text-amber-600">
        {{ botWarning }}
      </p>
      <!-- Итог автодонастройки полей сделки (#176): подтверждение успеха или причина сбоя. -->
      <p v-if="state === 'done' && schemaStatus === 'ok'" class="mt-3 text-xs text-emerald-600">
        Поля сделки настроены ✓
      </p>
      <p v-if="state === 'done' && (schemaStatus === 'failed' || schemaStatus === 'partial')" class="mt-3 text-xs text-amber-600">
        {{ schemaMsg }}
      </p>

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
        v-else-if="state === 'error'"
        color="air-primary-alert"
        title="Не удалось завершить установку"
        :description="errorMsg"
      />
    </B24Card>
  </div>
</template>

<script setup lang="ts">
/**
 * Страница установки приложения — обработчик «Путь для первоначальной установки» в настройках
 * локального приложения Битрикс24. Битрикс24 показывает её во фрейме при ПЕРВОМ открытии и
 * считает приложение «не установленным» (интерфейс заблокирован), пока не будет вызван
 * `installFinish()`.
 *
 * Вся логика (ожидание фрейма, вызов installFinish, состояния) — в композабле `useInstall`,
 * чтобы её можно было покрыть юнит-тестами (см. ui/tests/useInstall.test.ts).
 *
 * @see https://apidocs.bitrix24.ru/settings/app-installation/installation-finish.html
 */
definePageMeta({ layout: false })

const { state, errorMsg, botWarning, schemaStatus, schemaMsg } = useInstall()
</script>
