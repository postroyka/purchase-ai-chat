<script setup lang="ts">
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import UploadIcon from '@bitrix24/b24icons-vue/outline/UploadIcon'
import FileIcon from '@bitrix24/b24icons-vue/main/FileIcon'
import CheckIcon from '@bitrix24/b24icons-vue/main/CheckIcon'
import ClockIcon from '@bitrix24/b24icons-vue/common-service/ClockIcon'
import CreditDebitCardIcon from '@bitrix24/b24icons-vue/main/CreditDebitCardIcon'
import WalletIcon from '@bitrix24/b24icons-vue/outline/WalletIcon'
import MoneyIcon from '@bitrix24/b24icons-vue/outline/MoneyIcon'
import AlertIcon from '@bitrix24/b24icons-vue/outline/AlertIcon'
import WarningIcon from '@bitrix24/b24icons-vue/main/WarningIcon'

definePageMeta({ layout: 'default' })

const { data, error, pending, refresh } = useMetrics()

// ── Russian labels for the breakdown charts ──────────────────────────────────
const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Успешно',
  tool_unavailable: 'Инструмент Б24 недоступен',
  foreign_supplier: 'Иностранный поставщик',
  supplier_not_found: 'Поставщик не найден',
  contract_not_found: 'Договор не найден',
  unsupported_currency: 'Валюта не BYN',
  unreadable_document: 'Документ нечитаем',
  timeout: 'Таймаут агента',
  cli_missing: 'CLI не найден',
  agent_crash: 'Сбой агента',
  bad_output: 'Плохой ответ агента',
  other_error: 'Прочая ошибка',
  other: 'Прочее',
  unknown: 'Неизвестно'
}
const EXTRACT_LABELS: Record<string, string> = {
  pdftotext: 'PDF (текстовый слой)',
  ocr: 'OCR (скан/фото)',
  office: 'Office (xls/docx)',
  unknown: 'Неизвестно'
}
// Feedback (issue #182) — shared by the employee 👍/👎/💡 channel and the agent channel.
const FEEDBACK_KIND_LABELS: Record<string, string> = {
  positive: '👍 Хорошо',
  problem: '👎 Проблема',
  suggestion: '💡 Предложение',
  other: 'Прочее'
}
// Non-terminal agent quality signals (issue #182, channel «агент»).
const WARNING_LABELS: Record<string, string> = {
  no_items_matched: 'Сделка без позиций',
  articles_not_in_catalog: 'Артикулы не в каталоге',
  items_without_article: 'Позиции без артикула',
  product_rows_failed: 'Позиции не сохранились',
  file_attach_failed: 'Файл не прикреплён',
  invalid_base64_file: 'Файл не прикреплён (кодировка)',
  document_date_unparsed: 'Дата документа не распознана',
  timeline_comment_failed: 'Комментарий в таймлайн не добавлен',
  other: 'Прочее'
}

// Total feedback submissions across both channels — drives whether to show the empty-state hint.
const feedbackTotal = computed(() => {
  const f = data.value?.feedback
  if (!f) return 0
  const sum = (xs: { count: number }[]) => xs.reduce((n, x) => n + x.count, 0)
  return sum(f.user) + sum(f.agent)
})

// ── Formatters ───────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const fmtByn = (n: number) => `${nf.format(n)} BYN`
const fmtUsd = (n: number) => `$${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(n)}`
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.round(ms)} мс`)
const fmtDateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString('ru-RU') : '—')

const econ = computed(() => data.value?.economics ?? null)

const rateNote = computed(() => {
  const e = econ.value
  if (!e) return ''
  if (e.usdBynSource === 'nbrb') return `Курс НБРБ ${e.usdByn} BYN/USD на ${e.usdBynDate}`
  if (e.usdBynSource === 'nbrb-stale') return `Курс НБРБ ${e.usdByn} BYN/USD (последний доступный${e.usdBynDate ? `, ${e.usdBynDate}` : ''})`
  return `Курс ${e.usdByn} BYN/USD из .env (НБРБ недоступен)`
})

// Daily files → SVG polyline points (viewBox 0 0 100 100, y flipped).
const sparkPoints = computed(() => {
  const d = data.value?.daily ?? []
  if (!d.length) return ''
  const max = Math.max(1, ...d.map(x => x.files))
  const n = d.length
  if (n === 1) {
    // A single day would render as one invisible point — draw it as a flat line instead.
    const py = (100 - (d[0]!.files / max) * 100).toFixed(1)
    return `0,${py} 100,${py}`
  }
  return d
    .map((x, i) => {
      const px = (i / (n - 1)) * 100
      const py = 100 - (x.files / max) * 100
      return `${px.toFixed(1)},${py.toFixed(1)}`
    })
    .join(' ')
})
</script>

<template>
  <B24DashboardPanel id="metrics">
    <template #header>
      <B24DashboardNavbar title="Метрики">
        <template #leading>
          <B24DashboardSidebarCollapse />
        </template>
        <template #right>
          <span class="hidden sm:inline text-xs text-base-500">
            обновлено: {{ fmtDateTime(data?.generatedAt) }}
          </span>
          <B24Button
            :icon="RefreshIcon"
            color="air-tertiary"
            size="sm"
            :loading="pending"
            aria-label="Обновить"
            @click="refresh"
          />
          <ThemeToggle />
        </template>
      </B24DashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeleton (first load) -->
      <div v-if="!data && pending" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <B24Skeleton v-for="i in 8" :key="i" class="h-24 rounded-xl" />
      </div>

      <!-- Hard error, no data to show -->
      <B24Alert
        v-else-if="!data && error"
        color="air-primary-alert"
        title="Не удалось загрузить метрики"
        :description="error"
      />

      <div v-else-if="data" class="space-y-8">
        <!-- Soft error banner while showing stale data -->
        <B24Alert
          v-if="error"
          color="air-primary-warning"
          title="Данные могут быть устаревшими"
          :description="error"
        />

        <!-- KPI cards -->
        <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricsStatCard
            label="Загрузок"
            :value="data.totals.uploads"
            :icon="UploadIcon"
            :sub="`${data.totals.files} файлов`"
          />
          <MetricsStatCard
            label="Файлов обработано"
            :value="data.totals.filesDone + data.totals.filesError"
            :icon="FileIcon"
            :sub="`готово ${data.totals.filesDone} · ошибок ${data.totals.filesError}`"
          />
          <MetricsStatCard
            label="Успешных сделок"
            :value="data.totals.ok"
            :icon="CheckIcon"
            accent="success"
            :sub="`${data.totals.successRatePct}% от файлов`"
          />
          <MetricsStatCard
            label="Среднее время агента"
            :value="fmtMs(data.totals.avgAgentMs)"
            :icon="ClockIcon"
            :sub="`прогонов: ${data.totals.agentRuns}`"
          />
          <MetricsStatCard
            label="Стоимость модели"
            :value="fmtUsd(data.totals.costUsd)"
            :icon="CreditDebitCardIcon"
            :sub="`${data.totals.costRuns} прогонов с ценой`"
          />
        </section>

        <!-- Economics (#75) -->
        <section v-if="econ?.enabled" class="space-y-3">
          <h2 class="text-sm font-semibold text-base-700">
            Экономика (оценка)
          </h2>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricsStatCard
              label="Сэкономлено (нетто)"
              :value="fmtByn(econ.netSavedByn)"
              :icon="WalletIcon"
              accent="success"
              :sub="`${econ.positions} позиций`"
            />
            <MetricsStatCard
              label="Потеря на пустых артикулах"
              :value="fmtByn(econ.lostNoArticleByn)"
              :icon="AlertIcon"
              accent="warning"
              :sub="`${econ.positionsNoArticlePct}% позиций без артикула`"
            />
            <MetricsStatCard
              label="Стоимость модели"
              :value="fmtByn(econ.modelCostByn)"
              :icon="MoneyIcon"
              sub="за всё время"
            />
            <MetricsStatCard
              label="Позиций без артикула"
              :value="econ.positionsNoArticle"
              :icon="FileIcon"
              :sub="`из ${econ.positions}`"
            />
          </div>

          <B24Alert
            color="air-primary-warning"
            :icon="WarningIcon"
            :title="`Оценка — ставка ${econ.hourlyRateByn} BYN/ч не подтверждена заказчиком, ${econ.minutesPerPosition} мин/позицию`"
            :description="`${rateNote}.`"
          />
        </section>

        <!-- Breakdowns -->
        <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-semibold text-base-700">
                Успешность
              </h3>
            </div>
            <div class="flex items-center gap-5">
              <MetricsDonut :value="data.totals.successRatePct" label="успешно" />
              <div class="text-sm text-base-600 space-y-1">
                <p><span class="tabular-nums font-medium text-base-master">{{ data.totals.ok }}</span> успешных сделок</p>
                <p><span class="tabular-nums font-medium text-base-master">{{ data.totals.filesError }}</span> файлов с ошибкой</p>
                <p><span class="tabular-nums font-medium text-base-master">{{ data.totals.files }}</span> всего файлов</p>
              </div>
            </div>
          </B24Card>

          <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
            <h3 class="text-sm font-semibold text-base-700 mb-4">
              Исходы обработки
            </h3>
            <MetricsBarList :items="data.outcomes" :labels="OUTCOME_LABELS" />
          </B24Card>

          <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
            <h3 class="text-sm font-semibold text-base-700 mb-4">
              Форматы файлов
            </h3>
            <MetricsBarList :items="data.formats" />
          </B24Card>

          <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
            <h3 class="text-sm font-semibold text-base-700 mb-4">
              Способ извлечения текста
            </h3>
            <MetricsBarList :items="data.extract" :labels="EXTRACT_LABELS" />
          </B24Card>
        </section>

        <!-- Обратная связь и сигналы агента (issue #182) -->
        <section class="space-y-3">
          <h2 class="text-sm font-semibold text-base-700">
            Обратная связь и сигналы агента
          </h2>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
              <h3 class="text-sm font-semibold text-base-700 mb-4">
                Отзывы сотрудников
              </h3>
              <MetricsBarList v-if="data.feedback.user.length" :items="data.feedback.user" :labels="FEEDBACK_KIND_LABELS" />
              <p v-else class="text-sm text-base-500">
                Нет отзывов
              </p>
            </B24Card>

            <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
              <h3 class="text-sm font-semibold text-base-700 mb-4">
                Обратная связь агента
              </h3>
              <MetricsBarList v-if="data.feedback.agent.length" :items="data.feedback.agent" :labels="FEEDBACK_KIND_LABELS" />
              <p v-else class="text-sm text-base-500">
                Нет сигналов
              </p>
            </B24Card>

            <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
              <h3 class="text-sm font-semibold text-base-700 mb-4">
                Сигналы качества (агент)
              </h3>
              <MetricsBarList v-if="data.warnings.length" :items="data.warnings" :labels="WARNING_LABELS" />
              <p v-else class="text-sm text-base-500">
                Нет предупреждений
              </p>
            </B24Card>
          </div>

          <p v-if="feedbackTotal === 0" class="text-xs text-base-500">
            Обратная связь появится после первых отзывов сотрудников (виджет на странице результата) и сигналов агента.
          </p>
        </section>

        <!-- Daily files -->
        <section>
          <B24Card class="rounded-xl" :b24ui="{ body: 'p-5' }">
            <h3 class="text-sm font-semibold text-base-700 mb-4">
              Файлов по дням
            </h3>
            <div v-if="sparkPoints" class="h-24 w-full">
              <svg class="size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                <polyline
                  :points="sparkPoints"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                  class="text-blue-500"
                />
              </svg>
            </div>
            <p v-else class="text-sm text-base-500">
              Нет данных
            </p>
          </B24Card>
        </section>
      </div>
    </template>
  </B24DashboardPanel>
</template>
