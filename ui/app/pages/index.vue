<template>
  <B24DashboardPanel id="home">
    <template #header>
      <B24DashboardNavbar title="Загрузка счетов">
        <template #leading>
          <B24DashboardSidebarCollapse />
        </template>
        <template #right>
          <ThemeToggle />
        </template>
      </B24DashboardNavbar>
    </template>

    <template #body>
      <div class="w-full max-w-2xl mx-auto py-6 sm:py-10">
        <!-- Шапка-герой. Скрываем, пока есть задание (идёт обработка/показан результат) — как и зону
             загрузки: на экране статуса второй заголовок не нужен, меньше «лишних» заголовков (#ux). -->
        <header v-if="!job" class="text-center">
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight text-base-master">
            Прайс-листы → готовые сделки 🚀
          </h1>
          <p class="mt-3 text-base text-base-600 max-w-md mx-auto">
            Загрузите PDF, фото (JPG/PNG), Excel (XLSX/XLS) или Word — сделки в Bitrix24 соберём сами.
          </p>
        </header>

        <!-- Зона загрузки. Скрываем, пока есть задание (идёт обработка или показан результат) — виден
             только «Статус обработки»; назад её возвращает «Загрузить ещё» (resetState → job=null). -->
        <B24Card v-if="!job" class="mt-10 rounded-xl" :b24ui="{ body: 'p-6 sm:p-8' }">
          <B24FileUpload
            v-model="selectedFiles"
            :multiple="true"
            accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx"
            variant="area"
            layout="list"
            class="w-full min-h-[220px]"
            label="Перетащите файлы сюда"
            description="или нажмите, чтобы выбрать · до 10 файлов, по 20 МБ · затем нажмите «Загрузить»"
            :file-delete="!uploading && !polling"
            :disabled="uploading || polling"
          />

          <!-- Явная загрузка (#238): выбор файлов НЕ стартует загрузку сразу — сначала можно убрать
               лишний файл (крестик у файла выше), потом нажать «Загрузить». -->
          <div v-if="selectedFiles?.length && !uploading && !polling" class="mt-5 flex justify-end">
            <B24Button color="air-primary" @click="doUpload">
              Загрузить {{ selectedFiles.length }} {{ plural(selectedFiles.length, ['файл', 'файла', 'файлов']) }}
            </B24Button>
          </div>

          <div v-if="uploading || polling" class="mt-5">
            <B24Progress
              :model-value="null"
              animation="carousel"
              color="air-primary"
              size="xs"
            />
            <p class="mt-2 text-sm text-base-500 text-center">
              {{ uploading ? 'Загружаем файлы…' : 'Обрабатываем…' }}
            </p>
          </div>
        </B24Card>

        <!-- Ошибка -->
        <B24Alert
          v-if="uploadError"
          class="mt-6"
          color="air-primary-alert"
          title="Не получилось"
          :description="uploadError"
          :close="true"
          @update:open="uploadError = null"
        />

        <!-- Статус обработки -->
        <section v-if="job" class="mt-6 space-y-3">
          <div class="flex items-center justify-between gap-3 px-1">
            <h2 class="text-sm font-medium text-base-700">
              Статус обработки
            </h2>
            <!-- Общее время импорта (#timing): тикает с начала обработки, фиксируется по готовности. -->
            <span
              v-if="jobElapsedMs > 0"
              class="shrink-0 text-xs tabular-nums text-base-500"
              title="Общее время импорта"
            >
              ⏱ всего {{ mmss(jobElapsedMs) }}
            </span>
          </div>

          <B24Card
            v-for="file in job.files"
            :key="file.name"
            class="rounded-xl"
            :b24ui="{ body: 'p-4' }"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm text-base-master truncate min-w-0">
                {{ file.name }}
              </span>
              <B24Badge
                :label="fileBadge(file).label"
                :color="fileBadge(file).color"
                size="sm"
                class="shrink-0"
              />
            </div>

            <!-- Прогресс-бар + таймер — только у реально обрабатываемого файла. Файл в очереди
                 (`pending`) показывает лишь бейдж «Ожидание», без анимации (#ux: «зачем прогресс, если
                 загрузки ещё нет»). Бэкенд обрабатывает файлы последовательно. -->
            <div
              v-if="file.status === 'processing'"
              class="mt-3 flex items-center gap-2"
            >
              <B24Progress
                class="flex-1"
                :model-value="null"
                animation="carousel"
                color="air-primary"
                size="xs"
              />
              <!-- Живой таймер обработки (#203): всегда вкл, успокаивает на медленных файлах. -->
              <span
                v-if="elapsedMs(file) > 0"
                class="shrink-0 text-xs tabular-nums text-base-500"
                title="Время обработки"
              >
                ⏱ {{ mmss(elapsedMs(file)) }}
              </span>
            </div>

            <p
              v-if="file.error"
              class="mt-2 text-xs text-red-500"
              :title="file.error"
            >
              {{ file.error }}
            </p>

            <!-- issue #192: причина, почему сделка не создана (бизнес-ошибка / нераспознанный документ) -->
            <p
              v-else-if="file.status === 'done' && !dealOf(file) && file.problem"
              class="mt-2 text-xs text-amber-600"
              :title="file.problem"
            >
              {{ file.problem }}
            </p>

            <!-- Код исхода (#221): компактный машинный код для разбора (рядом с причиной/ошибкой). -->
            <p
              v-if="(file.status === 'done' || file.status === 'error') && outcomeCodeOf(file)"
              class="mt-1 font-mono text-[11px] text-base-400"
              title="Код исхода (для разбора)"
            >
              код: {{ outcomeCodeOf(file) }}
            </p>

            <!-- Созданная сделка: внутри B24 открываем слайдером, иначе ссылкой -->
            <div
              v-if="file.status === 'done' && dealOf(file)"
              class="mt-3 flex items-center justify-between gap-3"
            >
              <span class="text-xs text-base-500">
                Сделка #{{ dealOf(file)!.dealId }}
              </span>
              <B24Button
                v-if="canOpenDeal(dealOf(file)!)"
                color="air-primary"
                size="xs"
                class="shrink-0"
                @click="openDeal(dealOf(file)!)"
              >
                Открыть сделку
              </B24Button>
            </div>

            <!-- Замеры времени (#замеры, только при SHOW_TIMINGS) — в лог на странице, не в метрики.
                 «медленно» подсвечиваем янтарным (пороги TIMING_FAST_MS/TIMING_SLOW_MS). -->
            <p
              v-if="job?.showTimings && file.durationMs != null"
              class="mt-2 text-xs tabular-nums"
              :class="file.speed === 'slow' ? 'text-amber-600' : 'text-base-400'"
            >
              {{ timingLine(file) }}
            </p>

            <!-- Само-диагностика скорости агента (#279): что замедлило разбор. Показываем ВСЕГДА, когда
                 агент её прислал (не привязано к SHOW_TIMINGS): данные всё равно в result.feedback, note
                 санитизирован и без ПДн, блок свёрнут. На GitHub-issue не идёт (#294). -->
            <details
              v-if="perfDiagOf(file).length"
              class="mt-1 text-xs"
            >
              <summary class="cursor-pointer select-none text-base-500">
                ⏱ Диагностика скорости агента
              </summary>
              <ul class="mt-1 list-disc pl-5 text-base-600">
                <li
                  v-for="(note, i) in perfDiagOf(file)"
                  :key="i"
                  class="whitespace-pre-wrap break-words"
                >
                  {{ note }}
                </li>
              </ul>
            </details>

            <!-- Лог обработки по файлу (#218). Если есть замечания (нет сделки / ошибка) — лог сразу
                 развёрнут и подсвечен в B24Alert (#251), чтобы было видно, почему так. Чистый успех
                 (создана сделка) — лог свёрнут под «details», как было: при штатном результате он не нужен. -->
            <template v-if="processingLogOf(file)">
              <B24Alert
                v-if="!fileSucceeded(file)"
                class="mt-2"
                :color="file.status === 'error' ? 'air-primary-alert' : 'air-primary-warning'"
                title="Лог обработки"
              >
                <template #description>
                  <pre class="whitespace-pre-wrap break-words text-xs">{{ processingLogOf(file) }}</pre>
                </template>
              </B24Alert>
              <details v-else class="mt-2 text-xs">
                <summary class="cursor-pointer select-none text-base-500">
                  Лог обработки
                </summary>
                <pre class="mt-1 whitespace-pre-wrap break-words text-base-600">{{ processingLogOf(file) }}</pre>
              </details>
            </template>

            <!-- Обратная связь по ЭТОМУ файлу (#182, #218): 👍/👎 + опц. комментарий → GitHub issue.
                 Под каждым файлом свой отзыв; комментарий НЕ обязателен. -->
            <div
              v-if="feedbackEnabled && (file.status === 'done' || file.status === 'error')"
              class="mt-3 border-t border-base-200 pt-3"
            >
              <template v-if="!fbFor(file.name).sent">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs text-base-500">Как результат?</span>
                  <B24Button
                    v-for="opt in FEEDBACK_OPTIONS"
                    :key="opt.kind"
                    :color="fbFor(file.name).kind === opt.kind ? 'air-primary' : 'air-tertiary'"
                    size="xs"
                    @click="fbFor(file.name).kind = opt.kind"
                  >
                    {{ opt.label }}
                  </B24Button>
                </div>
                <!-- Поле комментария и кнопка раскрываются ТОЛЬКО после выбора оценки (#221):
                     карточка по умолчанию компактна (для пачки из 10 файлов — 10 свёрнутых форм). -->
                <template v-if="fbFor(file.name).kind">
                  <B24Textarea
                    v-model="fbFor(file.name).comment"
                    class="mt-2 w-full"
                    :rows="2"
                    :maxrows="6"
                    :maxlength="5000"
                    autoresize
                    :disabled="fbFor(file.name).submitting"
                    placeholder="Комментарий (необязательно): что не так / что понравилось, можно позицию."
                  />
                  <div class="mt-2 flex justify-end">
                    <B24Button
                      color="air-primary"
                      size="xs"
                      :disabled="fbFor(file.name).submitting"
                      @click="submitFileFeedback(file)"
                    >
                      {{ fbFor(file.name).submitting ? 'Отправляем…' : 'Отправить отзыв' }}
                    </B24Button>
                  </div>
                </template>
              </template>
              <p v-else class="text-xs text-base-600">
                Спасибо! Отзыв по файлу отправлен.
              </p>
            </div>
          </B24Card>

          <!-- Пока идёт импорт — можно остановить (текущий файл долетит, очередь отменится). -->
          <div v-if="job.status === 'processing' || job.status === 'pending'" class="flex justify-center pt-2">
            <B24Button
              color="air-secondary"
              size="sm"
              :disabled="cancelling"
              @click="cancelJob"
            >
              {{ cancelling ? 'Останавливаем…' : 'Остановить импорт' }}
            </B24Button>
          </div>
          <div v-else-if="job.status === 'done' || job.status === 'error' || job.status === 'cancelled'" class="flex justify-center pt-2">
            <B24Button color="air-primary" size="xl" @click="resetState">
              Загрузить ещё
            </B24Button>
          </div>
        </section>
      </div>

      <!-- Подтверждение ухода со страницы при активной загрузке/обработке -->
      <ClientOnly>
        <B24Modal
          v-model:open="leaveModalOpen"
          title="Уйти со страницы?"
          description="Идёт загрузка или обработка файлов. Если уйти, страница перестанет показывать их прогресс."
        >
          <template #footer>
            <B24Button color="air-secondary" label="Остаться" @click="decideLeave(false)" />
            <B24Button color="air-primary-alert" label="Всё равно уйти" @click="decideLeave(true)" />
          </template>
        </B24Modal>
      </ClientOnly>
    </template>
  </B24DashboardPanel>
</template>

<script setup lang="ts">
import { fileBadge, fileSucceeded, outcomeCodeOf } from '~/utils/result-badges'
import { mmss, timingLine, plural } from '~/utils/format-duration'
import { failActiveFiles } from '~/utils/job-status'

// Под общим dashboard-каркасом (сайдбар с навигацией) из layouts/default.vue.
definePageMeta({ layout: 'default' })

const toast = useToast()

// ── Типы ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled'
  result?: unknown
  error?: string | null
  // issue #192: human-readable reason set by the backend when a 'done' file produced NO deal
  // (business error / unrecognised document) — surfaced so it isn't a bare green "Готово".
  problem?: string | null
  // Тайминги (#замеры): приходят только при SHOW_TIMINGS на бэкенде. startedAt — предпочтительный
  // (точный) источник для живого mm:ss; без флага таймер идёт от клиентского procSince (#203).
  // agentMs/durationMs — для детальных замеров в логе по готовности (остаются за флагом).
  startedAt?: number | null
  agentMs?: number | null
  agentTurns?: number | null
  toolMs?: number | null
  durationMs?: number | null
  extractMethod?: string | null
  extractMs?: number | null
  speed?: 'fast' | 'normal' | 'slow' | null
}

interface JobStatus {
  jobId: string
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled'
  files: FileEntry[]
  showTimings?: boolean
}

// ── Состояние ────────────────────────────────────────────────────────────────

const selectedFiles = ref<File[] | null>(null)
const uploading = ref(false)
const polling = ref(false)
const cancelling = ref(false) // нажали «Остановить»: ждём, пока бэкенд доведёт задание до 'cancelled'
const uploadError = ref<string | null>(null)
const job = ref<JobStatus | null>(null)

let pollTimer: ReturnType<typeof setTimeout> | null = null

// Живой таймер обработки (#203): ВСЕГДА вкл (не за SHOW_TIMINGS). «Обрабатывается N сек» —
// безобидная подсказка-успокоитель именно для медленных файлов, без ops-чувствительных деталей
// (детальный timingLine агент/извлечение остаётся за флагом). Тикаем `nowTs` раз в секунду, пока
// есть файлы в обработке. useIntervalFn сам останавливается при unmount.
const nowTs = ref(Date.now())
const clock = useIntervalFn(() => {
  nowTs.value = Date.now()
}, 1000, { immediate: false })
const liveTiming = computed(() =>
  job.value?.files.some(f => f.status === 'processing' || f.status === 'pending') ?? false)
watch(liveTiming, (on) => {
  if (on) {
    nowTs.value = Date.now()
    clock.resume()
  } else {
    clock.pause()
  }
}, { immediate: true })
// Бэкенд шлёт `startedAt` только при SHOW_TIMINGS, поэтому ведём и КЛИЕНТСКИЙ «processing since»
// (момент, когда впервые увидели файл не завершённым) — чтобы таймер шёл и без флага. Заполняется в
// watch ниже; сбрасывается в resetState. Предпочитаем серверный startedAt (точнее), иначе — клиентский.
const procSince = ref<Record<string, number>>({})
function elapsedMs(file: FileEntry): number {
  const start = file.startedAt ?? procSince.value[file.name]
  return start ? Math.max(0, nowTs.value - start) : 0
}
// Общее время импорта (#timing): от старта обработки ПЕРВОГО файла до завершения задания. Файлы
// обрабатываются последовательно, поэтому это реальная длительность партии. Тикает, пока идёт
// обработка, и фиксируется по готовности (jobEndTs). Клиентская оценка — без зависимости от
// SHOW_TIMINGS; заполняется в watch ниже, сбрасывается в resetState.
const jobStartTs = ref<number | null>(null)
const jobEndTs = ref<number | null>(null)
const jobElapsedMs = computed(() => {
  if (jobStartTs.value == null) return 0
  return Math.max(0, (jobEndTs.value ?? nowTs.value) - jobStartTs.value)
})
let pollController: AbortController | null = null
let pollErrors = 0
let pollDelay = 2000
let lastPollSuccessTs = 0
const POLL_MIN_MS = 2000
const POLL_MAX_MS = 30000
const MAX_POLL_ERRORS = 5
// #280: счётчик ПОДРЯД идущих ошибок ловит «бэкенд лёг наглухо», но НЕ ловит интермиттентные сбои
// (редкий успех сбрасывает счётчик в 0) при залипшем задании. Второй, устойчивый к чередованию
// сигнал — «давно НЕ было успешного опроса»: здоровое задание опрашивается не реже POLL_MAX_MS (30 с),
// поэтому порог 60 с (2 пропущенных окна) не убивает живое задание, но ловит реальную потерю связи.
const POLL_NO_SUCCESS_CEILING_MS = 60000

// ── Созданная сделка ───────────────────────────────────────────────────────────
// Достаём ссылку на сделку из результата файла и открываем её. Внутри Bitrix24 —
// нативным слайдером (не уводит из приложения); вне портала — ссылкой в новой вкладке
// (если бэкенд отдал абсолютный deal.url). Бейдж-логику (успех = есть сделка) держим
// в app/utils/result-badges.ts — она чистая и покрыта юнит-тестами (issue #192).
const b24 = useB24()

interface CreatedDeal { dealId: string, url: string | null }

function dealOf(file: FileEntry): CreatedDeal | null {
  const deal = (file.result as { deal?: { dealId?: string | number | null, url?: string | null } } | undefined)?.deal
  const id = deal?.dealId
  if (id == null || String(id).trim() === '') return null
  return { dealId: String(id), url: deal?.url ?? null }
}

// Кнопку показываем только когда сделку реально есть чем открыть: внутри B24 (слайдер)
// или когда есть абсолютная ссылка от бэкенда (standalone).
function canOpenDeal(deal: CreatedDeal): boolean {
  return b24.isInit() || Boolean(deal.url)
}

async function openDeal(deal: CreatedDeal): Promise<void> {
  const path = `/crm/deal/details/${deal.dealId}/`
  const frame = b24.get()
  if (frame) {
    try {
      await frame.slider.openPath(frame.slider.getUrl(path))
      return
    } catch {
      // Слайдер не открылся — пробуем ту же ссылку в новой вкладке.
      try {
        window.open(frame.slider.getUrl(path).toString(), '_blank', 'noopener')
        return
      } catch { /* падаем во фолбэк ниже */ }
    }
  }
  if (deal.url) window.open(deal.url, '_blank', 'noopener')
}

// Подгонка высоты iframe под контент внутри Битрикс24 (#fitwindow): убирает внутренний скролл/проблему
// высоты. ResizeObserver внутри сам перефитит на изменения контента; вне портала — no-op. Панель — id="home".
useFitFrame('home')

// ── API ───────────────────────────────────────────────────────────────────────
// Backend calls go through useApi (#41/#105 P1): no token in the bundle. In prod the app-session
// cookie (set via /login or, inside Bitrix24, /session/b24) authenticates, and useApi adds the
// X-PAI-Auth CSRF header + credentials:'include' so the cookie rides the cross-site B24 iframe.
// In dev the nitro devProxy injects the Bearer server-side.
const { apiFetch } = useApi()

// #238: выбор файлов НЕ запускает загрузку сразу — сначала пользователь может убрать лишний файл
// (крестик у файла в B24FileUpload, :file-delete) и только потом нажать «Загрузить» (см. шаблон).
// Раньше здесь был watch(selectedFiles → doUpload), из-за которого окно для удаления было нулевым.

// ── Загрузка ──────────────────────────────────────────────────────────────────

// Текущий пользователь B24 для назначения ответственного за сделку (#251). Профиль уже загружен
// при init (LoadDataType.Profile), поэтому при наличии хелпера id доступен синхронно. Вне фрейма
// (standalone) хелпера нет → null, и поле responsibleUserId не отправляется (бэкенд ставит дефолт).
// try/catch — на случай, если геттер профиля бросит до полной инициализации: загрузка важнее.
function currentB24UserId(): number | null {
  try {
    const id = b24.getHelper()?.profileInfo?.data?.id
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

async function doUpload() {
  const files = selectedFiles.value
  if (!files?.length) return

  uploading.value = true
  uploadError.value = null
  job.value = null
  cancelling.value = false
  // Сбросить транзитивное состояние прошлой партии: иначе при повторной загрузке БЕЗ «Загрузить ещё»
  // у файла с тем же именем останется старый procSince (#203 — таймер показал бы чужое время) и отзыв.
  procSince.value = {}
  jobStartTs.value = null
  jobEndTs.value = null
  feedbackByFile.value = {}

  const form = new FormData()
  for (const f of files) form.append('files[]', f)
  // #251: ответственным за сделку назначаем ТЕКУЩЕГО пользователя B24 (тот, кто загрузил файл).
  // Без этого поля бэкенд берёт фолбэк PUBLIC_PAGE_RESPONSIBLE_USER_ID = владелец вебхука — и все
  // сделки висят на нём, а не на загрузившем. Вне фрейма (standalone) id нет → поле не шлём, бэкенд
  // ставит дефолт. Бэкенд дополнительно валидирует формат (целое > 0) и сам подставит дефолт при пустом.
  const uid = currentB24UserId()
  if (uid != null) form.append('responsibleUserId', String(uid))
  // #238: отдали файлы в загрузку — очищаем выбор. Локальная `files` держит ссылку для POST, а
  // кнопка «Загрузить» больше не «всплывёт» после завершения задания (её v-if смотрит на selectedFiles).
  selectedFiles.value = null

  try {
    const res = await apiFetch<{ jobId: string, files: Array<{ name: string, status: string }> }>(
      '/upload',
      { method: 'POST', body: form }
    )

    job.value = {
      jobId: res.jobId,
      status: 'pending',
      files: res.files.map(f => ({ name: f.name, status: 'pending' }))
    }

    startPolling(res.jobId)
  } catch (e: unknown) {
    const msg = extractErrorMessage(e)
    uploadError.value = msg
    toast.add({
      title: 'Ошибка загрузки',
      description: msg,
      color: 'air-primary-alert',
      duration: 6000
    })
  } finally {
    uploading.value = false
  }
}

// ── Опрос статуса ─────────────────────────────────────────────────────────────

function startPolling(jobId: string) {
  stopPolling()
  polling.value = true
  pollErrors = 0
  pollDelay = POLL_MIN_MS
  lastPollSuccessTs = Date.now()
  scheduleNextPoll(jobId)
}

function scheduleNextPoll(jobId: string) {
  pollTimer = setTimeout(() => pollOnce(jobId), pollDelay)
}

async function pollOnce(jobId: string) {
  const controller = new AbortController()
  pollController = controller
  try {
    const data = await apiFetch<JobStatus>(`/job/${jobId}/status`, {
      signal: controller.signal
    })
    pollErrors = 0
    lastPollSuccessTs = Date.now()
    job.value = data

    if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
      stopPolling()

      if (data.status === 'cancelled') {
        const processed = data.files.filter(f => f.status === 'done' || f.status === 'error').length
        toast.add({
          title: 'Импорт остановлен',
          description: `Обработано до остановки: ${processed}. Остальные файлы отменены.`,
          color: 'air-primary-warning',
          duration: 6000
        })
      } else if (data.status === 'done') {
        // issue #192: «успешно» = создана сделка, а не просто «done». Если часть файлов без сделки —
        // не выдаём чистый успех, а зовём проверить причину у файла.
        const ok = data.files.filter(f => fileSucceeded(f)).length
        const total = data.files.length
        const allOk = ok === total
        toast.add({
          title: allOk ? 'Обработка завершена' : 'Завершено с замечаниями',
          description: allOk
            ? `Сделки созданы: ${ok} из ${total}`
            : `Сделок создано: ${ok} из ${total}. Остальные — с проблемой, причина указана у файла.`,
          color: allOk ? 'air-primary-success' : 'air-primary-warning',
          duration: allOk ? 5000 : 7000
        })
      } else {
        toast.add({
          title: 'Обработка завершена с ошибками',
          description: 'Некоторые файлы не удалось обработать — проверьте статус',
          color: 'air-primary-warning',
          duration: 6000
        })
      }
      return
    }

    // Постепенный backoff: длинные задания не опрашиваем каждые 2 с (до 30 с).
    pollDelay = Math.min(pollDelay * 1.5, POLL_MAX_MS)
    scheduleNextPoll(jobId)
  } catch {
    // Запрос отменён (stopPolling / уход со страницы) — выходим без перезапуска.
    if (controller.signal.aborted) return
    pollErrors++
    const lostContact = pollErrors >= MAX_POLL_ERRORS
      || (Date.now() - lastPollSuccessTs) >= POLL_NO_SUCCESS_CEILING_MS
    if (lostContact) {
      stopPolling()
      // #280: бэкенд недостижим. Помечаем ошибкой не только само задание, но и ВСЕ ещё не
      // завершённые файлы — иначе per-file строки залипнут на «Обработка…», а liveTiming/таймер
      // не остановятся (источник истины для них — статусы файлов, не job.status). hasActiveWork
      // при этом тоже спадёт, и guard перестанет зря удерживать пользователя на странице.
      const msg = 'Не удалось получить статус обработки: сервер недоступен. Обновите страницу или попробуйте позже.'
      if (job.value) job.value = failActiveFiles(job.value, msg)
      uploadError.value = msg
      toast.add({
        title: 'Потеряна связь с сервером',
        description: 'Статус обработки недоступен. Файлы помечены ошибкой — обновите страницу или попробуйте позже.',
        color: 'air-primary-alert',
        duration: 7000
      })
      return
    }
    pollDelay = Math.min(pollDelay * 1.5, POLL_MAX_MS)
    scheduleNextPoll(jobId)
  }
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (pollController) {
    pollController.abort()
    pollController = null
  }
  polling.value = false
  // #280: гигиена — обнуляем счётчики опроса, чтобы следующий запуск стартовал «с чистого листа»
  // (startPolling их и так переинициализирует, но явный сброс убирает зависимость от порядка).
  pollErrors = 0
  lastPollSuccessTs = 0
}

// ── Остановка импорта (#cancel) ───────────────────────────────────────────────
// Помечаем задание отменённым на бэкенде. Опрос НЕ останавливаем: бэкенд доведёт уже идущий файл
// и выставит статус 'cancelled' — опрос подхватит финал, кнопка станет «Загрузить ещё».
async function cancelJob() {
  if (!job.value || cancelling.value) return
  cancelling.value = true
  try {
    await apiFetch(`/job/${job.value.jobId}/cancel`, { method: 'POST' })
  } catch (e: unknown) {
    cancelling.value = false
    toast.add({
      title: 'Не удалось остановить',
      description: extractErrorMessage(e),
      color: 'air-primary-alert',
      duration: 5000
    })
  }
}

// ── Сброс ────────────────────────────────────────────────────────────────────

function resetState() {
  stopPolling()
  job.value = null
  uploadError.value = null
  selectedFiles.value = null
  cancelling.value = false
  // Сбросить отзывы по файлам, чтобы для нового задания форма была чистой.
  feedbackByFile.value = {}
  procSince.value = {} // клиентские отметки времени обработки (#203)
  jobStartTs.value = null
  jobEndTs.value = null
}

// ── Обратная связь сотрудника (issue #182) ─────────────────────────────────────
// Оценка результата (👍/👎/💡) + комментарий уходит на бэкенд (POST /feedback), который заводит
// GitHub issue. Виджет показываем только если канал настроен на сервере (GET /feedback/config).
const { isEnabled: feedbackIsEnabled, submit: submitFeedbackApi } = useFeedback()

type FeedbackKind = 'positive' | 'problem' | 'suggestion'
// «Предложение» убрано по обратной связи заказчика (#218): оставляем 👍/👎.
const FEEDBACK_OPTIONS: { kind: FeedbackKind, label: string }[] = [
  { kind: 'positive', label: '👍 Хорошо' },
  { kind: 'problem', label: '👎 Проблема' }
]

const feedbackEnabled = ref(false)

// Отзыв теперь ПО КАЖДОМУ файлу (#218): состояние в карте по имени файла. Пред-инициализируем в watch,
// чтобы шаблон только читал (без мутаций в рендере). Комментарий — НЕ обязателен.
type FbState = { kind: FeedbackKind | null, comment: string, sent: boolean, submitting: boolean }
const feedbackByFile = ref<Record<string, FbState>>({})
function fbFor(name: string): FbState {
  return feedbackByFile.value[name] ?? (feedbackByFile.value[name] = { kind: null, comment: '', sent: false, submitting: false })
}
// Сигнатура включает status задания и файлов, чтобы реагировать на смену статусов: пред-инициализируем
// отзыв по файлу и фиксируем клиентский «processing since» при старте ОБРАБОТКИ файла (#203/#timing).
watch(() => [job.value?.status, ...(job.value?.files ?? []).map(f => `${f.name}:${f.status}`)].join('\n'), () => {
  const now = Date.now()
  for (const f of job.value?.files ?? []) {
    fbFor(f.name)
    // Таймер стартует по факту ОБРАБОТКИ, а не ожидания: пока файл в очереди (`pending`) счётчик не
    // тикает (#timing — раньше тикал у всех сразу). Бэкенд обрабатывает файлы последовательно и
    // переводит в `processing` по очереди, поэтому время идёт только у реально обрабатываемого файла.
    if (f.status === 'processing' && procSince.value[f.name] == null) {
      procSince.value[f.name] = now
      if (jobStartTs.value == null) jobStartTs.value = now // первый реально начатый файл = старт партии
    }
  }
  // Завершение задания фиксирует общее время один раз (если обработка вообще стартовала).
  const st = job.value?.status
  if ((st === 'done' || st === 'error' || st === 'cancelled') && jobStartTs.value != null && jobEndTs.value == null) {
    jobEndTs.value = now
  }
}, { immediate: true })

// Лог обработки агента по файлу (#218): что распознал / почему без сделки. Лежит в result.processingLog.
function processingLogOf(file: FileEntry): string {
  const r = file.result as { processingLog?: unknown } | null | undefined
  if (!r || typeof r !== 'object' || typeof r.processingLog !== 'string') return ''
  return r.processingLog.trim().slice(0, 10000) // cap: защита DOM от гигантского лога
}

// Само-диагностика скорости агента (#279): записи feedback[] с kind:'perf' — что замедлило разбор.
// Показываем ВСЕГДА, когда агент прислал (не привязано к SHOW_TIMINGS — свёрнутый блок). На GitHub-issue
// perf не идёт (#294), поэтому это единственное место, где оператор его видит.
// `note` — НЕДОВЕРЕННЫЙ вывод модели (она читает недоверенный документ). Vue экранирует HTML ({{ }}),
// но bidi/zero-width/управляющие символы могут «перевернуть» текст (Trojan Source) — вырезаем их тем же
// классом, что и серверный путь отзывов (backend stripHostileChars). Затем cap длины/числа — защита DOM.
// eslint-disable-next-line no-control-regex
const PERF_HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g
function perfDiagOf(file: FileEntry): string[] {
  const r = file.result as { feedback?: unknown } | null | undefined
  if (!r || typeof r !== 'object' || !Array.isArray(r.feedback)) return []
  return r.feedback
    .filter((f): f is { kind?: unknown, note?: unknown } => !!f && typeof f === 'object')
    .filter(f => f.kind === 'perf' && typeof f.note === 'string' && f.note.trim() !== '')
    .map(f => (f.note as string).replace(PERF_HOSTILE_CHARS, '').trim().slice(0, 2000)) // sanitize + cap
    .filter(note => note !== '') // после вырезания мог остаться пустой
    .slice(0, 5) // не более 5 записей
}

async function submitFileFeedback(file: FileEntry) {
  const s = fbFor(file.name)
  if (!s.kind || s.submitting || !job.value) return // комментарий НЕ обязателен (#218)
  s.submitting = true
  try {
    const res = await submitFeedbackApi(s.kind, s.comment.trim(), {
      jobId: job.value.jobId,
      fileName: file.name,
      dealId: dealOf(file)?.dealId
    })
    s.sent = true
    // queued (#190): GitHub был недоступен, отзыв сохранён на сервере и будет отправлен позже —
    // показываем это честно, но всё равно как успех (повторять не нужно).
    toast.add(res?.queued
      ? { title: 'Отзыв сохранён — отправим, как только GitHub станет доступен', color: 'air-primary-success', duration: 5000 }
      : { title: 'Спасибо за отзыв!', color: 'air-primary-success', duration: 4000 })
  } catch (e: unknown) {
    toast.add({ title: 'Не удалось отправить отзыв', description: extractErrorMessage(e), color: 'air-primary-alert', duration: 6000 })
  } finally {
    s.submitting = false
  }
}

// Узнаём один раз при монтировании, настроен ли канал — иначе виджет не рисуем.
onMounted(async () => {
  feedbackEnabled.value = await feedbackIsEnabled()
})

// ── Утилиты ──────────────────────────────────────────────────────────────────

function extractErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  if (e instanceof Error) return e.message
  return 'Неизвестная ошибка'
}

// ── Защита от потери прогресса при уходе со страницы ───────────────────────────

// Есть незавершённая работа: идёт загрузка/обработка или задание ещё не финализировано.
const hasActiveWork = computed(() =>
  uploading.value || polling.value
  || (!!job.value && job.value.status !== 'done' && job.value.status !== 'error' && job.value.status !== 'cancelled')
)

const leaveModalOpen = ref(false)
let leaveResolver: ((leave: boolean) => void) | null = null

// Завершает ожидание решения: резолвит висящий промис (если есть) и закрывает модалку.
// Resolver обнуляется ДО изменения leaveModalOpen, чтобы реакция watch на закрытие не
// вызвала повторный резолв.
function decideLeave(leave: boolean) {
  const resolve = leaveResolver
  leaveResolver = null
  leaveModalOpen.value = false
  resolve?.(leave)
}

// Закрыли модалку мимо кнопок (Esc / клик вне) — трактуем как «остаться».
watch(leaveModalOpen, (open) => {
  if (!open) decideLeave(false)
})

// Перехватываем клиентскую навигацию (клик «Метрики» в сайдбаре и т.п.): при активной
// работе показываем подтверждение и уходим только если пользователь выбрал «Уйти».
onBeforeRouteLeave(() => {
  if (!hasActiveWork.value) return true
  decideLeave(false) // снять предыдущий висящий промис, если переход сработал повторно
  return new Promise<boolean>((resolve) => {
    leaveResolver = resolve
    leaveModalOpen.value = true
  })
})

// onBeforeRouteLeave не ловит закрытие/перезагрузку вкладки (F5, Ctrl+W) — для этого
// нативное предупреждение браузера при активной работе.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (hasActiveWork.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

// ── Очистка ───────────────────────────────────────────────────────────────────

onUnmounted(() => {
  stopPolling()
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (leaveResolver) decideLeave(true) // не оставлять навигацию заблокированной висящим промисом
})
</script>
